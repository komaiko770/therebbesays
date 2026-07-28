// Deno/TypeScript port of verify.py — the verification gate. Two passes, not one:
//   Pass 1 (classify): broad GENUINE/TANGENTIAL/FALSE_POSITIVE classification across
//     the full candidate pool.
//   Pass 2 (adversarial vote): every GENUINE verdict from pass 1 gets N independent
//     adversarial review calls (majority decides), because a single pass can be talked
//     into a plausible-sounding but wrong conclusion by its own reasoning — e.g. pass 1
//     once classified a letter about Soviet Jews under Communist persecution as "genuine
//     evidence" for a Modern Orthodoxy question, because both involve "secular
//     activities + occasional Torah study" on the surface, even though one is a chosen
//     ideology and the other is coerced circumstance.
//
// This does NOT retrieve (retrieve.ts) and does NOT write the final answer
// (synthesize.ts) — its only job is deciding what's allowed to reach synthesis at all.
// Since the target is fully automated operation (no human reviewing output before it's
// used), both passes are the default, not optional.
//
// MOROCCO POSTMORTEM (26 Jul): for a question naming a place/community, pass 1 accepted
// only 11 of 60 candidates and the adversarial vote refuted 5 of those 11 — because the
// rubric demanded passages that "assert something about the topic itself," which
// wrongly rejects the Rebbe's actual place-related material: concrete letters directing
// that place's schools, emissaries, and communal life. Both prompts now state explicitly
// that for place/community/institution questions, concrete operational letters ARE the
// genuine evidence.
//
// SIMCHA POSTMORTEM (26 Jul): pass 1 used to send ALL candidates (120 after the
// Morocco TOP_K raise) in ONE classification call. On that oversized prompt the model
// returned an EMPTY verdicts array — not truncation (callClaudeTool fails loudly on
// max_tokens), just silent wholesale non-compliance — so every candidate fell through
// as "no verdict" and a question with 120 retrieved passages published with zero
// sources. Pass 1 now classifies in batches of PASS1_BATCH_SIZE candidates per call
// (indices remapped to the global candidate list), and any batch that comes back with
// zero verdicts is retried once before being given up on.
//
// SIMCHA POSTMORTEM #2 (26 Jul, evening): a batch came back with `verdicts` as a
// STRING containing malformed JSON — an unescaped quote inside one justification
// broke JSON.parse, and the old code threw, failing the entire run. But the
// justification text is only commentary; the pipeline decisions ride solely on
// (index, verdict). So an unparseable string is now salvaged with a tolerant regex
// that extracts every (index, verdict) pair it can find; if salvage yields nothing,
// the batch reports zero verdicts and flows into the existing retry-once path
// instead of killing the whole question.
//
// REJECTION AUDIT TRAIL (27 Jul): the original pass-1 justification is now preserved
// on the verdict (pass1_justification) BEFORE the refuted-rewrite mangles it, so the
// per-question audit trail (index.ts -> questions.research_audit) can show "why this
// passage was considered" alongside "why it was rejected".
//
// COMPUTERS POSTMORTEM (27 Jul): a "computers" question was rejected down to zero
// genuine sources across two separate runs, even though real adjacent material
// (radio broadcast technology, automated shipboard machinery on Shabbos) was
// retrieved both times — it kept getting marked TANGENTIAL because the rubric was
// scoped to literal "computer"/"electronic brain" language only. Both prompts now
// carry a NAMED TECHNOLOGY paragraph, parallel to the existing PLACE and IDEOLOGY
// paragraphs, so genuinely related technology from the same technological family is
// credited as on-topic instead of being rejected on a technicality of naming.
//
// CHULLIN 88 POSTMORTEM (27 Jul, owner decision): a citation-route question ("Chullin
// 88") retrieved its two real index-confirmed citations — passages whose own footnotes
// cite that exact daf — and then discarded both as TANGENTIAL, publishing "no sources".
// The rubric above is written for TOPICAL questions, where a passing mention is noise.
// It is the wrong test for a citation lookup, where the question literally means "where
// does the Rebbe reference this daf?" — there, a footnote citation is not noise, it IS
// the answer, and the citation index has already PROVEN the reference exists.
//
// So a candidate carrying the `citation` signal (put there by citationLookup.ts, meaning
// the index confirmed this passage's footnote cites the asked-about verse/daf) is now
// always admitted, and the classifier's job for it changes from "does this count?" to
// "how deeply does it engage?":
//   - pass 1 GENUINE  -> tagged `direct_citation`    (substantive discussion of it)
//   - anything else   -> tagged `passing_reference`  (real citation, cited in passing)
// Both reach synthesize.ts, which renders the distinction honestly rather than
// presenting a footnote aside as an exposition of the sugya. Adversarial refutation can
// still DEMOTE such a passage to `passing_reference`, but it can no longer delete a
// citation the index has verified. Semantic-fallback candidates are untouched by any of
// this — the two Igros Kodesh letters that cited Chullin 27b instead of 88 were caught
// by the adversarial vote in that same run, and must stay caught.

import { callClaudeTool } from "./anthropicClient.ts";
import type { Candidate, RefutationResult, AdversarialVoteResult, Verdict, VerificationResult } from "./types.ts";

// Max candidates per pass-1 classification call. 25 keeps each prompt far below the
// size where the model started returning empty verdict arrays (observed at 120), and
// keeps each call's output comfortably under the max_tokens ceiling.
const PASS1_BATCH_SIZE = 25;

/** Set by citationLookup.ts on chunks the citation index proves cite the asked-about
 * verse/daf. Ground truth, not a model judgment. */
export const CITATION_SIGNAL = "citation";
/** Index-confirmed AND substantively engaged with by the passage. */
export const DIRECT_CITATION_SIGNAL = "direct_citation";
/** Index-confirmed, but cited in passing — real, and labelled as such downstream. */
export const PASSING_REFERENCE_SIGNAL = "passing_reference";

function isCitationConfirmed(candidate: Candidate | undefined): boolean {
  return !!candidate?.signals?.includes(CITATION_SIGNAL);
}

function tagTier(candidate: Candidate, tier: string): void {
  if (!candidate.signals) candidate.signals = [];
  // The two tiers are mutually exclusive; a demotion must not leave both attached.
  candidate.signals = candidate.signals.filter(
    (s) => s !== DIRECT_CITATION_SIGNAL && s !== PASSING_REFERENCE_SIGNAL,
  );
  candidate.signals.push(tier);
}

const VERDICT_TOOL = {
  name: "report_verification",
  description: "Report the verification verdict for every candidate passage.",
  input_schema: {
    type: "object",
    properties: {
      verdicts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "integer", description: "0-based index of the candidate in the input list" },
            verdict: { type: "string", enum: ["GENUINE", "TANGENTIAL", "FALSE_POSITIVE"] },
            justification: { type: "string", description: "One sentence, specific to this passage's actual content" },
          },
          required: ["index", "verdict", "justification"],
        },
      },
      citation_recommendation: {
        type: "string",
        description: "If writing the actual answer, which specific candidates (by index) would you cite and why. " +
          "Explicitly note what should be excluded even if topically adjacent.",
      },
    },
    required: ["verdicts", "citation_recommendation"],
  },
};

const REFUTE_TOOL = {
  name: "report_refutation",
  description: "Report whether the GENUINE classification survives adversarial scrutiny.",
  input_schema: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["SURVIVES", "REFUTED"] },
      justification: { type: "string", description: "One or two sentences explaining the refutation verdict, specific to this passage" },
    },
    required: ["verdict", "justification"],
  },
};

// Tolerant recovery for the "verdicts came back as malformed JSON text" glitch
// (simcha postmortem #2): pull out every (index, verdict[, justification]) trio the
// regex can find. Justification capture is best-effort — it may be cut short by the
// very quoting error that broke JSON.parse — but index + verdict are what the
// pipeline actually runs on.
function salvageVerdictsFromString(raw: string): { index: number; verdict: string; justification: string }[] {
  const out: { index: number; verdict: string; justification: string }[] = [];
  const re = /"index"\s*:\s*(\d+)\s*,\s*"verdict"\s*:\s*"(GENUINE|TANGENTIAL|FALSE_POSITIVE)"(?:\s*,\s*"justification"\s*:\s*"((?:[^"\\]|\\.)*)")?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    out.push({
      index: Number(m[1]),
      verdict: m[2],
      justification: m[3] ?? "(justification lost to malformed model output)",
    });
  }
  return out;
}

function buildPrompt(question: string, candidates: Candidate[], topicGuidance: string): string {
  const candidateBlocks = candidates.map((c, i) =>
    `--- Candidate ${i} ---\n` +
    `Collection: ${c.collection}\n` +
    `Source: ${c.volume_heading} / ${c.item_heading} (chunk ${c.chunk_index})\n` +
    `Found by: ${(c.signals && c.signals.length ? c.signals : ["unknown"]).join("+")}\n` +
    `Text:\n${c.text}\n`
  );
  const candidatesText = candidateBlocks.join("\n");

  return `You are a source-verification editor for a research tool that answers \"What does the Rebbe say about X?\" using only primary sources (the Rebbe's own talks and letters, in Hebrew) — never secondary summaries or paraphrases by others.

The question being researched is: \"${question}\"
${topicGuidance}

A retrieval system (a mix of semantic embedding search and keyword search) returned the ${candidates.length} candidate passages below. Retrieval is known to be imperfect — some candidates are genuine matches, some only tangentially related, and some are false positives from surface keyword/semantic overlap (e.g. a word that has an unrelated homograph, or a classical phrase used in an unrelated sense).

For EACH candidate, read its full text carefully (not just skim) and classify it using this test — it is about SUBSTANCE, not LENGTH. A single sentence can be GENUINE; a long passage can be TANGENTIAL:
- GENUINE: the passage makes an actual assertion, position, or teaching ABOUT the topic itself — something you could quote as evidence of what the Rebbe thinks about it — even if it's brief, or embedded in a longer passage about something else. The test: does the sentence tell you something the Rebbe believes/holds/rules about the topic, standing on its own?
- TANGENTIAL: the topic is named or referenced, but only as a rhetorical device, comparison, or passing illustration used to make a DIFFERENT point — the passage isn't actually asserting anything about the topic itself, it's just borrowing it. (Test: if you swapped in a different, unrelated example, would the passage's actual point survive unchanged? If yes, it's TANGENTIAL.)
- FALSE_POSITIVE: not about this topic at all — matched only on incidental word/semantic overlap (e.g. a homograph, or a classical phrase used in an unrelated sense).

IMPORTANT — candidates whose \"Found by\" line includes \"citation\": these did not come from semantic guessing. A citation index built from the sources' own footnotes has already PROVEN that this passage cites the exact verse/daf named in the question. That fact is settled and is not yours to re-litigate. The question \"Chullin 88\" means \"where does the Rebbe reference this daf, and what does he say there?\", so such a passage will be shown to the reader either way. Your verdict for it decides only HOW it is presented:
- GENUINE — the passage substantively engages the cited verse/daf: explaining it, ruling from it, building an argument on its content.
- TANGENTIAL — the citation is real but incidental: a supporting footnote, a borrowed phrase, a halachic aside, while the passage's own subject is something else. This is NOT a rejection; it labels the passage as a passing reference so the answer can say exactly that.
Judge depth honestly in both directions — do not inflate a footnote aside into substantive engagement, and do not dismiss real analysis of the sugya as incidental just because the passage is short.

If the question names an ideology, movement, or named concept (e.g. \"Modern Orthodoxy,\" \"Zionism\"): real correspondence with real people almost never names the abstract movement — it addresses concrete individual situations that instantiate the same underlying question. A passage that substantively engages the SAME underlying tension/question — even without using the movement's name — should be treated as GENUINE evidence of the Rebbe's view on it, not excluded on a technicality of naming. Don't require the passage to discuss the ideology in the abstract if it's already showing the Rebbe's actual position through a concrete case.

If the question names a PLACE, COUNTRY, COMMUNITY, or INSTITUTION (e.g. \"Morocco\"): the Rebbe's engagement with a place lives almost entirely in concrete letters — direction to its rabbis and emissaries, instructions about its schools and institutions, responses to its communal events and struggles, encouragement and concern for its Jews. A passage giving real guidance about, or expressing a real position on, Jewish life IN that place is GENUINE evidence, even if it reads as operational or administrative rather than philosophical. Do not demand an abstract essay about the place — in real correspondence such essays essentially don't exist; the concrete letters ARE what the Rebbe \"says about\" that place. Only mark such a passage TANGENTIAL if the place is truly incidental to it (e.g. merely part of an address or an itinerary mention with no substance about the place's Jewish life).

If the question names a specific modern TECHNOLOGY, DEVICE, or INVENTION (e.g. \"computers\"): real primary sources from this era essentially never discuss the modern device by its modern name — they engage with the underlying technological family in period vocabulary (electronic devices, automated machinery, calculating machines, broadcasting/communication technology). A passage giving the Rebbe's real position on, or guidance about, a closely related technology from the same technological family — automation replacing human decision/labor, electronic/mechanical devices used in halachically sensitive contexts, broadcast or calculating technology of the era — is GENUINE evidence of the Rebbe's engagement with the underlying question, not a different topic to be excluded. Only mark such a passage TANGENTIAL if the technology mentioned is truly unrelated in kind (e.g. a passing mention of an unrelated household object) rather than part of the same automation/electronic/mechanical family the question is really asking about.

Be rigorous and skeptical — err toward TANGENTIAL or FALSE_POSITIVE unless the passage really does make its own assertion about the specific question asked. This step exists to catch retrieval mistakes before they reach a published answer, so don't be lenient.

Candidates:

${candidatesText}

Call report_verification with a verdict + one-sentence justification for every candidate (by index), plus an overall citation recommendation.`;
}

async function classifyBatch(
  apiKey: string,
  model: string,
  question: string,
  slice: Candidate[],
  topicGuidance: string,
  offset: number,
  allCandidates: Candidate[],
): Promise<{ verdicts: Verdict[]; recommendation: string }> {
  const prompt = buildPrompt(question, slice, topicGuidance);
  const result = await callClaudeTool(apiKey, model, prompt, VERDICT_TOOL, 16000);

  let verdictsRaw = result.verdicts as unknown;
  if (typeof verdictsRaw === "string") {
    // Occasional tool-calling glitch: the model emits the array as a JSON-encoded
    // string instead of an actual array. Parse it; if the string itself is malformed
    // JSON (unescaped quote inside a justification — simcha postmortem #2), salvage
    // the (index, verdict) pairs with a tolerant regex instead of failing the run.
    try {
      verdictsRaw = JSON.parse(verdictsRaw);
    } catch (e) {
      const salvaged = salvageVerdictsFromString(String(verdictsRaw));
      console.warn(
        `WARNING: 'verdicts' string was unparseable JSON (${e}); ` +
        `salvaged ${salvaged.length}/${slice.length} verdicts via tolerant extraction`,
      );
      verdictsRaw = salvaged; // if empty, the zero-verdict retry path below handles it
    }
  }

  const cleanVerdicts: Verdict[] = [];
  for (const v of (verdictsRaw as any[]) ?? []) {
    if (!v || typeof v !== "object" || !("index" in v) || !("verdict" in v)) {
      console.warn(`WARNING: skipping malformed verdict entry: ${JSON.stringify(v)}`);
      continue;
    }
    const localIdx = v.index;
    if (localIdx < 0 || localIdx >= slice.length) {
      console.warn(`WARNING: verdict index ${localIdx} out of range for batch of ${slice.length}; skipping`);
      continue;
    }
    // Remap the batch-local index onto the global candidate list.
    const globalIdx = offset + localIdx;
    v.index = globalIdx;
    v.source = `${allCandidates[globalIdx].volume_heading} / ${allCandidates[globalIdx].item_heading} (chunk ${allCandidates[globalIdx].chunk_index})`;
    v.collection = allCandidates[globalIdx].collection;
    v.candidate = allCandidates[globalIdx];
    cleanVerdicts.push(v as Verdict);
  }

  return { verdicts: cleanVerdicts, recommendation: String(result.citation_recommendation ?? "") };
}

export async function classifyCandidates(
  apiKey: string,
  model: string,
  question: string,
  candidates: Candidate[],
  topicGuidance: string,
): Promise<VerificationResult> {
  // Batched pass 1 (simcha postmortem, 26 Jul): one giant call over the whole pool
  // made the model return an empty verdicts array — every candidate silently dropped.
  const batches: { offset: number; slice: Candidate[] }[] = [];
  for (let offset = 0; offset < candidates.length; offset += PASS1_BATCH_SIZE) {
    batches.push({ offset, slice: candidates.slice(offset, offset + PASS1_BATCH_SIZE) });
  }

  const batchResults = await Promise.all(batches.map(async ({ offset, slice }) => {
    let result = await classifyBatch(apiKey, model, question, slice, topicGuidance, offset, candidates);
    if (!result.verdicts.length && slice.length) {
      console.warn(`WARNING: pass-1 batch at offset ${offset} (${slice.length} candidates) returned zero verdicts; retrying once`);
      result = await classifyBatch(apiKey, model, question, slice, topicGuidance, offset, candidates);
      if (!result.verdicts.length) {
        console.warn(`WARNING: pass-1 batch at offset ${offset} returned zero verdicts again after retry`);
      }
    }
    return result;
  }));

  const verdicts = batchResults.flatMap((r) => r.verdicts);
  const recommendation = batchResults
    .map((r, i) => (r.recommendation ? `[Batch ${i + 1}] ${r.recommendation}` : ""))
    .filter(Boolean)
    .join("\n");

  const verdictedIndices = new Set(verdicts.map((v) => v.index));
  const missing = candidates.map((_, i) => i).filter((i) => !verdictedIndices.has(i));
  if (missing.length) {
    console.warn(`WARNING: ${missing.length} candidates got no verdict at all: indices ${missing}`);
  }

  return {
    verdicts,
    citation_recommendation: recommendation,
  };
}

function buildRefutePrompt(
  question: string,
  candidate: Candidate,
  originalJustification: string,
  topicGuidance: string,
): string {
  return `You are a second, independent editor giving a fair second opinion on another editor's classification before it reaches a published answer. You are not hunting for any flaw you can find — a real, well-supported classification should survive your review. Your job is to catch a SPECIFIC, real failure mode, not to manufacture doubt for its own sake.

The question being researched is: \"${question}\"
${topicGuidance}

A prior reviewer classified the passage below as GENUINE — direct, substantive evidence for answering this question — with this justification:
\"${originalJustification}\"

The ONE specific failure mode to check for: does the passage only SUPERFICIALLY resemble the question's topic, while actually arising from a completely different underlying cause or context? For example: coercion/persecution dressed up as if it were a chosen ideology or stance, a different historical era whose surface details happen to match, or a different sense of a similar-sounding word or concept. That is a real error a first-pass reviewer can make while sounding entirely plausible.

This is NOT the same as: a genuine, direct historical account of the actual topic (even a specific instance or anecdote), a real quotable assertion the Rebbe makes about it, or a passage that is merely brief rather than exhaustive. None of those are reasons to refute — a source doesn't need to be long, airtight, or discuss the topic \"in the abstract\" to be genuine evidence; a concrete real example of the Rebbe's own view, stated plainly, is exactly what good evidence looks like. For instance, if a letter directly quotes the Rebbe describing how the actual founding community of a named approach concluded, in practice, that the approach didn't work — that is strong, direct evidence *for* the classification, not a \"narrow anecdote\" to be dismissed. Likewise, for a question naming a PLACE or COMMUNITY: a concrete, even administrative-sounding letter giving real direction about Jewish life there (its schools, emissaries, institutions, communal affairs) is genuine evidence of the Rebbe's engagement and position on that place — being \"operational,\" \"narrow,\" or \"administrative\" is NOT a reason to refute it. Likewise, for a question naming a specific TECHNOLOGY or DEVICE: a passage engaging a closely related technology from the same technological family (automation, electronic or mechanical devices, calculating or broadcast technology of the era) is genuine evidence of the Rebbe's engagement with the underlying question — being about a related device rather than the exact modern name is NOT a reason to refute it, since real sources from this era essentially never use the modern loanword.

If this passage was found via the CITATION INDEX (its footnotes provably cite the exact verse/daf asked about), note that REFUTED does not discard it — the citation is a verified fact and the passage will still be shown. Refuting only downgrades how it is presented, from substantive engagement to a passing reference. Choose REFUTED only if the passage genuinely does not analyse the cited source, not as a way to remove it.

Also check: is the original justification actually supported by what the text says, or does it describe content that simply isn't in this passage (e.g. content that actually belongs to a different chunk)? That is a real error worth catching. But if the justification accurately describes what's in the passage, and the passage is really about the topic rather than a different underlying cause, the classification should survive — say so plainly.

Passage (source: ${candidate.volume_heading} / ${candidate.item_heading}):
${candidate.text}

Call report_refutation with SURVIVES or REFUTED and your justification. Only choose REFUTED if you can point to the specific failure mode above actually occurring here — not because the evidence could theoretically be stronger.`;
}

async function adversarialRefute(
  apiKey: string,
  model: string,
  question: string,
  candidate: Candidate,
  originalJustification: string,
  topicGuidance: string,
): Promise<RefutationResult> {
  const prompt = buildRefutePrompt(question, candidate, originalJustification, topicGuidance);
  try {
    const result = await callClaudeTool(apiKey, model, prompt, REFUTE_TOOL, 1024);
    if (!result || typeof result !== "object" || !("verdict" in result)) {
      console.warn(`WARNING: malformed refutation result, this vote defaults to REFUTED: ${JSON.stringify(result)}`);
      return { verdict: "REFUTED", justification: "Malformed adversarial-check response; defaulted to REFUTED out of caution." };
    }
    return result as unknown as RefutationResult;
  } catch (e) {
    console.warn(`WARNING: adversarial reviewer call failed (${e}); this vote defaults to REFUTED out of caution`);
    return { verdict: "REFUTED", justification: `Reviewer call failed: ${e}` };
  }
}

/** N independent adversarial reviewers, majority decides — not any single one. A single
 * skeptic pushed hard enough to catch subtle false positives is also prone to
 * over-correcting and rejecting genuinely strong sources through excessive literalism.
 * Voting means one hallucinated or overzealous refutation can't unilaterally kill a good
 * source, the same way one overly-generous pass-1 read shouldn't unilaterally save a
 * bad one. */
export async function adversarialVote(
  apiKey: string,
  model: string,
  question: string,
  candidate: Candidate,
  originalJustification: string,
  topicGuidance: string,
  nVoters = 3,
): Promise<AdversarialVoteResult> {
  const votes = await Promise.all(
    Array.from({ length: nVoters }, () =>
      adversarialRefute(apiKey, model, question, candidate, originalJustification, topicGuidance)
    ),
  );
  const survivesCount = votes.filter((v) => v.verdict === "SURVIVES").length;
  const refutedCount = nVoters - survivesCount;
  return {
    verdict: survivesCount > refutedCount ? "SURVIVES" : "REFUTED",
    votes,
    survives_count: survivesCount,
    refuted_count: refutedCount,
  };
}

/** Admits every index-confirmed citation as a real source and tags how deeply the
 * passage engages what it cites (Chullin 88 postmortem). Runs AFTER the adversarial
 * pass so a refutation demotes the tier instead of deleting a verified citation.
 *
 * Also rescues any index-confirmed candidate that pass 1 skipped entirely: the whole
 * point of the citation index is that these must never vanish silently, and the
 * "no verdict at all" path is exactly how the simcha run lost its sources. */
function admitCitationConfirmed(candidates: Candidate[], result: VerificationResult): void {
  const verdictByIndex = new Map(result.verdicts.map((v) => [v.index, v]));

  candidates.forEach((candidate, index) => {
    if (!isCitationConfirmed(candidate)) return;

    const existing = verdictByIndex.get(index);
    if (!existing) {
      tagTier(candidate, PASSING_REFERENCE_SIGNAL);
      result.verdicts.push({
        index,
        verdict: "GENUINE",
        justification:
          "[PASSING REFERENCE] The citation index confirms this passage cites the verse/daf asked about; " +
          "it received no classifier verdict, so it is admitted as a citation without a claim about its depth.",
        source: `${candidate.volume_heading} / ${candidate.item_heading} (chunk ${candidate.chunk_index})`,
        collection: candidate.collection,
        candidate,
      } as Verdict);
      return;
    }

    if (existing.verdict === "GENUINE") {
      tagTier(candidate, DIRECT_CITATION_SIGNAL);
      return;
    }

    // TANGENTIAL / FALSE_POSITIVE / adversarially refuted: the citation itself is a
    // verified fact, so the passage stays — labelled as the passing reference it is.
    tagTier(candidate, PASSING_REFERENCE_SIGNAL);
    existing.pass1_justification = existing.pass1_justification ?? existing.justification;
    existing.justification = `[PASSING REFERENCE — cited in a footnote, not substantively discussed] ${existing.justification}`;
    existing.verdict = "GENUINE";
  });
}

/** Full two-pass verification: classify, then put every GENUINE verdict to an
 * adversarial vote among nVoters independent reviewers. This is the actual entry point —
 * both passes are the default, not optional, since the goal is unsupervised operation
 * with no human reviewing the output before it's used. */
export async function verify(
  apiKey: string,
  model: string,
  question: string,
  candidates: Candidate[],
  topicGuidance: string,
  nVoters = 3,
): Promise<VerificationResult> {
  const result = await classifyCandidates(apiKey, model, question, candidates, topicGuidance);

  const genuineVerdicts = result.verdicts.filter((v) => v.verdict === "GENUINE");

  const voteResults = await Promise.all(
    genuineVerdicts.map(async (v) => {
      const candidate = candidates[v.index];
      const vote = await adversarialVote(apiKey, model, question, candidate, v.justification, topicGuidance, nVoters);
      return [v.index, vote] as const;
    }),
  );
  const voteByIndex = new Map(voteResults);

  for (const v of result.verdicts) {
    if (v.verdict !== "GENUINE") continue;
    const vote = voteByIndex.get(v.index)!;
    v.adversarial_check = vote;
    // Preserve the clean pass-1 reasoning BEFORE any rewrite below — the audit trail
    // (questions.research_audit) shows it as "why this passage was considered".
    v.pass1_justification = v.justification;
    if (vote.verdict === "REFUTED") {
      v.verdict = "TANGENTIAL";
      v.justification = `[Pass 1: ${v.justification}] [REFUTED by ${vote.refuted_count}/${nVoters} adversarial reviewers]`;
    } else {
      v.justification = `${v.justification} [confirmed by ${vote.survives_count}/${nVoters} adversarial reviewers]`;
    }
  }

  // Last, so that a refutation above demotes an index-confirmed citation rather than
  // erasing it (Chullin 88 postmortem).
  admitCitationConfirmed(candidates, result);

  return result;
}
