// Deno/TypeScript port of analyze_question.py — takes ONLY the raw user question
// (English or Hebrew) and produces everything retrieve.ts and verify.ts need, without a
// human hand-crafting it per topic. See analyze_question.py in the original Python
// prototype for the full design rationale; this is a faithful line-for-line port of its
// prompts, not a re-derivation, since those prompts were iterated on against real test
// questions and changing wording here would forfeit that validation.
//
// COMPUTERS POSTMORTEM (27 Jul): a narrow technology question ("computers") produced
// wildly unstable retrieval across two runs on the identical corpus — one run's
// alt_queries found a single genuine passage via "electronic brain for halachic
// calculation" phrasing, a second run's alt_queries (different phrasing, same topic)
// missed that exact passage entirely and found zero. A single named technology/device
// is too narrow a target for embedding search alone: real primary sources almost never
// use the modern named term, and the Rebbe's actual engagement with "computers" lives
// inside the broader universe of automation, electronic devices, calculating machines,
// and radio/broadcast technology of his era — not literal keystrokes about "מחשב".
// Both the query-generation guidance below and the topic_guidance instructions now
// explicitly require covering that broader technological neighborhood, not just the
// literal named device, so retrieval and verification stop depending on which random
// phrasing the model happens to pick that run.

import { callClaudeTool } from "./anthropicClient.ts";
import type { QuestionAnalysis } from "./types.ts";

const ANALYZE_TOOL = {
  name: "report_analysis",
  description: "Report the Hebrew search query, keyword terms, and scope guidance for researching this question.",
  input_schema: {
    type: "object",
    properties: {
      hebrew_query: {
        type: "string",
        description: "A natural, coherent Hebrew sentence capturing the question's semantic intent, for embedding-based similarity search.",
      },
      alt_hebrew_queries: {
        type: "string",
        description: "1-3 ADDITIONAL Hebrew query sentences, joined with a pipe character, each approaching the question from a genuinely DIFFERENT angle or facet than the main hebrew_query (e.g. for a place: the Jewish community there, the Rebbe's guidance to its institutions and emissaries, historical events involving it; for a named technology: the era's closest analogous/predecessor technology, and the Rebbe's broader approach to science and technological progress). Each one is used for its own embedding search, so semantic diversity matters more than polish. Leave empty only if the question is so narrow that no genuinely different angle exists — this should be rare; almost every topic has multiple real angles.",
      },
      keyword_terms: {
        type: "string",
        description: "3-6 specific Hebrew terms/phrases likely to appear verbatim in a genuine primary source, joined with a pipe character, e.g. 'תורה עם דרך ארץ|אורתודוקסיה מודרנית|תורה ומדע'. Prefer specific multi-word phrases over generic single words — a generic single word (e.g. a common root that also means something unrelated) causes massive false-positive noise. For a named technology/invention, include BOTH the literal modern term AND at least 2-3 terms for the era's closest analogous or predecessor technology (e.g. for computers: electronic brain / calculating machine / automated device terminology) — the Rebbe's actual sources overwhelmingly use period-appropriate technical vocabulary, not the modern loanword.",
      },
      topic_guidance: {
        type: "string",
        description: "Scope clarification for a verification panel reviewing candidate passages: what exactly counts as genuinely on-topic vs. merely superficially similar for THIS specific question. Explicitly name any classical/ancient concepts that use similar terminology but mean something different (false-friend risk), and any historical predecessor movements/concepts/technologies that should count as the SAME underlying topic even if not identically named. For a named technology or invention specifically, explicitly state which adjacent/related technologies from the same technological family or era (e.g. automation, broadcasting, calculating machines, electronic devices generally) should count as genuinely on-topic rather than being rejected as merely 'similar but different tech' — narrow literalism here throws away the Rebbe's actual engagement with the underlying question. Be concrete and specific to this question, not generic.",
      },
    },
    required: ["hebrew_query", "keyword_terms", "topic_guidance"],
  },
};

function buildAnalysisPrompt(question: string): string {
  return `You are preparing a research question for a retrieval system that searches a corpus of the Lubavitcher Rebbe's Hebrew talks (Toras Menachem, 1950-1973) and letters (Igrot Kodesh) for primary-source evidence.

The raw question is: "${question}"

Before any retrieval happens, think carefully about how this question could go wrong once real candidate passages come back:
- What Hebrew terminology would a genuine source actually use? Rabbinic/Chassidic Hebrew often uses old, specific vocabulary that doesn't map onto a literal translation of the English question.
- Does this question's topic have a name, term, or phrase that is ALSO used in a completely different, unrelated sense elsewhere in Rabbinic literature (a "false friend")? If so, name it explicitly so a reviewer doesn't get fooled by surface overlap.
- Does this question name something (an ideology, institution, technology, event) that has historical predecessors, earlier names, or a closely related phenomenon that SHOULD count as the same underlying question even though it isn't identically named? If so, say so explicitly, so genuine evidence doesn't get wrongly excluded on a technicality of naming.
- If the question names an abstract movement/ideology: real primary sources (personal letters especially) almost never discuss abstract ideologies by name — they address concrete individual situations. Genuine evidence often looks like a specific real-world case that instantiates the same underlying tension, not a philosophical discussion of the movement itself.
- If the question names a specific modern TECHNOLOGY or INVENTION (e.g. "computers", "television"): a single literal search for the modern device name is dangerously narrow and produces unstable results run to run. Real sources from this era discuss the underlying technological family in period vocabulary — electronic devices, automation, calculating machines, broadcasting — often without ever naming the specific modern device. At least one alt_hebrew_query and several keyword_terms MUST target this broader technological neighborhood, not just the literal device name, and topic_guidance must explicitly authorize crediting that adjacent material as genuine engagement with the question.
- Broad or multi-faceted topics (a country, a community, a practice, a person, a technology) are discussed from MANY different angles across thousands of letters and talks. A single embedding query only finds one semantic neighborhood. Write 1-3 alternate Hebrew queries that each target a genuinely different facet of the topic, so retrieval covers more of what actually exists.

Call report_analysis with your Hebrew query, alternate queries, keyword terms, and topic guidance.`;
}

export async function analyzeQuestion(
  apiKey: string,
  model: string,
  question: string,
): Promise<QuestionAnalysis> {
  const prompt = buildAnalysisPrompt(question);
  const result = await callClaudeTool(apiKey, model, prompt, ANALYZE_TOOL, 2048);

  let rawTerms = result.keyword_terms as unknown;
  if (Array.isArray(rawTerms)) {
    // Occasionally comes back as an actual array despite the string-typed schema —
    // fine either way, just normalize to the same split form as the pipe-joined case.
    rawTerms = rawTerms.join("|");
  }
  const keywordTerms = String(rawTerms ?? "")
    .split("|")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  let rawAlt = result.alt_hebrew_queries as unknown;
  if (Array.isArray(rawAlt)) rawAlt = rawAlt.join("|");
  const altQueries = String(rawAlt ?? "")
    .split("|")
    .map((q) => q.trim())
    .filter((q) => q.length > 0)
    .slice(0, 3);

  return {
    hebrew_query: String(result.hebrew_query ?? ""),
    alt_queries: altQueries,
    keyword_terms: keywordTerms,
    topic_guidance: String(result.topic_guidance ?? ""),
  };
}

// ── ANCHORED TOPICAL RETRIEVAL (28 Jul) ──────────────────────────────────────
// COLLEGE CAMPUS POSTMORTEM: asking the model for "a natural, coherent Hebrew
// sentence capturing the question's semantic intent" produced a 15-word sentence
// whose embedding is a CENTROID of four concepts (prepare / new school year /
// university / Jewish students). Nothing in the corpus is equally about all four,
// so the vector landed between them and matched passages weakly related to each
// and strongly related to none: 120 retrieved, 1 survived verification. The
// alt_queries made it worse by guessing at the ANSWER (Chabad campus outreach,
// a letter to a student leaving home) and retrieving toward the guess.
//
// The citation route does not have this problem, because it establishes an
// objective anchor first (the footnote index) and applies judgment second. This
// gives the topical route the same shape: find every passage that provably
// mentions the governing noun, THEN judge relevance. Anchor decides inclusion;
// qualifiers decide order; the adversarial panel decides truth.
const ANCHOR_TOOL = {
  name: "report_anchors",
  description:
    "Report the governing noun phrase of the question, its Hebrew surface variants, the qualifier concepts, and scope guidance.",
  input_schema: {
    type: "object",
    properties: {
      anchor_phrase: {
        type: "string",
        description:
          "The single governing NOUN PHRASE the question is fundamentally about, in English (e.g. for 'how to prepare for a new school year on a college campus' the anchor is 'college campus', NOT 'preparation' and NOT 'new school year'). Pick the concrete entity/place/institution/object the answer must be about, not the action or circumstance surrounding it.",
      },
      anchor_variants: {
        type: "string",
        description:
          "4-10 Hebrew search STEMS for the anchor phrase, joined with a pipe character. CRITICAL: these are matched as LITERAL SUBSTRINGS (SQL ILIKE) against the corpus text - no stemming, no lemmatization, no fuzzy matching. A SHORTER string therefore matches strictly MORE passages. Rules: (a) give the shortest distinctive STEM, not the dictionary form - truncate the inflectional ending so one entry covers every prefix, suffix, construct and plural at once; the bare stem for university also matches its definite, prepositional, construct and plural forms, whereas the full definite form matches only itself. (b) NEVER include a form that merely adds a prefix or suffix to another entry in your list - it is dead weight matching a strict subset. (c) The corpus is 1950-1973, and Toras Menachem is spoken YIDDISH transcribed in Hebrew letters - include Yiddish transcription spellings alongside modern Israeli Hebrew, or you will retrieve from the letters only and miss the talks entirely. (d) Include the era own vocabulary and predecessor terminology, not just the modern loanword. (e) Minimum 3 characters, prefer 4+ so the stem stays distinctive - a stem that is also a common unrelated word floods results with noise. (f) If the anchor is a modern English compound, do NOT assume it exists in the corpus at all: supply stems for the underlying concept AND for the people involved in it (for a college campus, the university stem and the student stem), because the corpus may never use the compound itself.",
      },
      qualifier_terms: {
        type: "string",
        description:
          "3-8 Hebrew terms/phrases, joined with a pipe character, covering the REMAINING concepts in the question apart from the anchor (e.g. for the campus question: beginning of the school year, preparation, strengthening before departure). These do NOT filter anything — they only rank passages that already mention the anchor, so err toward covering more phrasings rather than being precise.",
      },
      topic_guidance: {
        type: "string",
        description:
          "Scope clarification for a verification panel reviewing candidate passages that all provably mention the anchor: what counts as genuinely answering THIS question vs. merely mentioning the anchor in passing. Name any false-friend uses of the anchor terminology, and any adjacent/predecessor concepts that should count as the same underlying topic. Be concrete and specific to this question.",
      },
    },
    required: ["anchor_phrase", "anchor_variants", "qualifier_terms", "topic_guidance"],
  },
};

function buildAnchorPrompt(question: string): string {
  return `You are preparing a research question for a retrieval system that searches a corpus of the Lubavitcher Rebbe's Hebrew talks (Toras Menachem, 1950-1973) and letters (Igrot Kodesh).

The raw question is: "${question}"

This system does NOT work by translating your question into a Hebrew sentence and searching for similar-sounding passages. That approach fails, because a sentence combining several concepts matches passages that are weakly related to all of them and strongly related to none.

Instead it works in two stages, and your job is stage one:
1. An ANCHOR: the governing noun phrase the answer must be about. Every passage that literally contains one of your Hebrew anchor variants is retrieved — all of them, exhaustively, from the entire corpus. Nothing else is retrieved at all.
2. QUALIFIERS: the rest of the question's meaning. These only ORDER the anchor matches; they never exclude anything.

So choose the anchor as the thing whose ABSENCE would make a passage irrelevant no matter what else it says. For "how to prepare for a new school year on a college campus," a passage that never touches university/college life is useless however much it discusses preparation — so the anchor is the campus, and preparation is a qualifier.

Remember the matching is literal substring matching over Hebrew text. Give the SHORTEST DISTINCTIVE STEM for each variant rather than the full dictionary word, because a stem also matches every prefixed, suffixed, construct and plural form built on it, while a full form matches only itself. Include Yiddish transcription spellings - the talks are transcribed spoken Yiddish in Hebrew letters - and the words a source from 1950-1973 would actually have used. If the question phrasing is modern, anchor on the underlying concept the corpus would actually name.

Call report_anchors.`;
}

function splitPipes(raw: unknown): string[] {
  let v = raw as unknown;
  if (Array.isArray(v)) v = v.join("|");
  return String(v ?? "")
    .split("|")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

export async function extractAnchors(
  apiKey: string,
  model: string,
  question: string,
): Promise<{
  anchor_phrase: string;
  anchor_variants: string[];
  qualifier_terms: string[];
  topic_guidance: string;
}> {
  const result = await callClaudeTool(apiKey, model, buildAnchorPrompt(question), ANCHOR_TOOL, 2048);
  return {
    anchor_phrase: String(result.anchor_phrase ?? ""),
    // >= 3 chars mirrors the SQL's own length(t) >= 3 filter; shorter variants
    // would be silently dropped by the RPC and look like a corpus gap.
    anchor_variants: splitPipes(result.anchor_variants).filter((v) => v.length >= 3),
    qualifier_terms: splitPipes(result.qualifier_terms),
    topic_guidance: String(result.topic_guidance ?? ""),
  };
}

// -- CORPUS-GROUNDED WIDENING (28 Jul, "college campus" postmortem #2) --------
// The first anchored run on the campus question retrieved 10 chunks, only 2 from
// Toras Menachem. Cause: the model supplied full dictionary forms instead of the
// bare stem, plus three variants from the campus family that appear ZERO times in
// the entire corpus. Under literal substring matching a zero-hit variant silently
// caps the whole answer, and the model cannot know corpus frequencies by
// introspection. The database can. This shows the model the real match counts for
// its own variants and lets it revise ONCE, grounded in fact rather than guessing
// a second time.
const WIDEN_TOOL = {
  name: "report_widened_anchors",
  description: "Report additional Hebrew anchor stems after seeing real corpus match counts.",
  input_schema: {
    type: "object",
    properties: {
      anchor_variants: {
        type: "string",
        description:
          "Additional Hebrew STEMS to add, joined with a pipe character. Do not repeat variants that already scored above zero. Replace every zero-scoring variant with a shorter stem of the same word, a Yiddish transcription spelling, or a different word the corpus would actually use. Shorter is better: matching is literal substring.",
      },
      qualifier_terms: {
        type: "string",
        description: "Optional additional Hebrew ranking terms, joined with a pipe character. May be empty.",
      },
    },
    required: ["anchor_variants"],
  },
};

function buildWidenPrompt(question: string, anchorPhrase: string, counts: Record<string, number>): string {
  const lines = Object.entries(counts)
    .sort((x, y) => y[1] - x[1])
    .map(([t, n]) => `  ${t} -> ${n} passage${n === 1 ? "" : "s"}${n === 0 ? "   <-- MATCHES NOTHING" : ""}`)
    .join("\n");
  const total = Object.values(counts).reduce((x, y) => x + y, 0);
  return `You proposed Hebrew anchor variants for a research question, and we measured them against the actual corpus (the Rebbe's talks 1950-1973 and letters). Here is how many passages each one literally matches:

Question: "${question}"
Anchor concept: "${anchorPhrase}"

${lines}

Total: ${total} passage matches across all variants.

This recall is thin, or some variants match nothing at all. Matching is literal substring matching, so a variant scoring 0 is NOT evidence the corpus is silent on the topic. It almost always means the wording is wrong: too long (a full inflected form where a stem was needed), too modern (a loanword the corpus never used), or the wrong register (Israeli Hebrew where the talks use transcribed Yiddish).

CRITICAL - DO NOT MAXIMIZE MATCHES. Your goal is variants that are SPECIFIC to this anchor topic, not variants that match a lot. A stem matching thousands of passages - generic words like student, boy, studies, school, learning - has stopped discriminating. It floods retrieval with passages that have nothing to do with the question, the verification panel rejects all of them, and the answer ends up citing NOTHING. A previous run of this exact system proposed such generic stems, retrieved 120 passages, and cited zero. Broad variants are far worse than useless.

TARGET BAND: each new variant should match roughly 5-300 passages. Anything matching more than 300 is REJECTED automatically by the code before retrieval, so proposing it simply wastes your slot. Aim for a TOTAL in the 30-300 range across all variants.

Propose ADDITIONAL variants that will actually hit while staying distinctive. Prefer short stems. Consider what a Yiddish-speaking Torah scholar in 1950-1973 would have called this, including transcribed Yiddish spellings, and consider the PEOPLE involved in it, not only the place or object - but only where that wording is distinctive to THIS topic.

If you genuinely cannot find more distinctive wording, return FEWER variants, or none. A thin, precise result is a correct outcome; a flooded one is a failure.

Call report_widened_anchors.`;
}

export async function widenAnchors(
  apiKey: string,
  model: string,
  question: string,
  anchorPhrase: string,
  counts: Record<string, number>,
): Promise<{ anchor_variants: string[]; qualifier_terms: string[] }> {
  const result = await callClaudeTool(apiKey, model, buildWidenPrompt(question, anchorPhrase, counts), WIDEN_TOOL, 1024);
  return {
    anchor_variants: splitPipes(result.anchor_variants).filter((v) => v.length >= 3),
    qualifier_terms: splitPipes(result.qualifier_terms),
  };
}

const REFLECT_TOOL = {
  name: "report_reflection",
  description: "Report the updated topic guidance after reviewing the actual retrieved candidates.",
  input_schema: {
    type: "object",
    properties: {
      updated_guidance: {
        type: "string",
        description: "The full, updated topic guidance — keep everything useful from the original, and add any new distinction the real candidates revealed. If nothing new was found, return the original guidance unchanged.",
      },
      new_pattern_found: {
        type: "boolean",
        description: "Whether you found a genuinely new ambiguity/false-friend pattern that the original guidance had not already covered.",
      },
    },
    required: ["updated_guidance", "new_pattern_found"],
  },
};

// Reflection reads the WHOLE candidate pool in a single prompt — the only pipeline
// call that does — so it gets its own tighter per-passage cap on top of the worker's
// global MAX_CANDIDATE_CHARS guard ("Los Angeles" postmortem, 26 Jul: an uncapped
// pool with monster chunks produced a 1.55M-token prompt, over the API's 1M limit).
// Reflection looks for cross-candidate terminology patterns, not exhaustive readings,
// so a generous prefix of each passage is enough. Worst case: 120 candidates × 3.5K
// chars ≈ 420K chars — comfortably inside the limit.
const REFLECT_SNIPPET_CHARS = 3500;

function buildReflectPrompt(
  question: string,
  originalGuidance: string,
  candidates: { collection: string; volume_heading: string; item_heading: string; text: string }[],
): string {
  const candidateBlocks = candidates.map(
    (c, i) => {
      const text = c.text.length > REFLECT_SNIPPET_CHARS
        ? c.text.slice(0, REFLECT_SNIPPET_CHARS) + "\n…[truncated for reflection — the verification pass sees more of this passage]"
        : c.text;
      return `--- Candidate ${i} (${c.collection}, ${c.volume_heading} / ${c.item_heading}) ---\n${text}\n`;
    },
  );
  const candidatesText = candidateBlocks.join("\n");

  return `You are refining research guidance based on what a retrieval system actually found — not guessing in the abstract anymore, but learning from real examples, the way a researcher sharpens their own understanding of a question only after actually reading some sources.

The question being researched: "${question}"

Original guidance (written blind, before seeing any of these candidates):
"${originalGuidance}"

Actual candidate passages retrieved:

${candidatesText}

Look across these REAL candidates for a pattern the original guidance did NOT anticipate. Specifically watch for:
- Multiple candidates using the same surface phrase/terminology, where closer reading shows they actually represent genuinely DIFFERENT underlying concepts (e.g. the same two words meaning something narrow/classical in one passage and something broader/ideological in another).
- A passage whose situation superficially resembles the question's topic but arises from a clearly different underlying cause once you actually read it.
- Any other concrete distinction visible in these real passages that the original guidance's abstract reasoning missed.

If you find such a pattern, write an UPDATED guidance that keeps what's useful from the original and adds the new distinction. Critical: state it as a GENERAL, TRANSFERABLE RULE that a reviewer can apply to ANY passage exhibiting that pattern — not as an observation tied to one specific candidate number. A verification panel will apply your guidance to these passages ONE AT A TIME, in a separate pass that will not see which candidate number prompted the insight — if your rule only makes sense by pointing at "Candidate 14," it will fail to transfer to a different passage (or even a re-ranked/re-numbered version of the same passage) that exhibits the identical underlying pattern. Phrase it as: "Any passage where [concrete, recognizable textual pattern — e.g. specific phrase + specific context] appears is [the classical/narrow sense], not [the topic's ideological/modern sense], regardless of which passage it is." You may cite a candidate's content as illustrative evidence for why the rule is real, but the rule itself must stand on its own without needing to know a candidate number.

If the original guidance already covers everything you see here, return it unchanged and say so.

Call report_reflection with the updated guidance and whether you found something new.`;
}

export async function reflectOnCandidates(
  apiKey: string,
  model: string,
  question: string,
  originalGuidance: string,
  candidates: { collection: string; volume_heading: string; item_heading: string; text: string }[],
): Promise<{ updated_guidance: string; new_pattern_found: boolean }> {
  const prompt = buildReflectPrompt(question, originalGuidance, candidates);
  const result = await callClaudeTool(apiKey, model, prompt, REFLECT_TOOL, 4096);
  return {
    updated_guidance: String(result.updated_guidance ?? originalGuidance),
    new_pattern_found: Boolean(result.new_pattern_found),
  };
}
