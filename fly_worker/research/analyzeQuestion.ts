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
