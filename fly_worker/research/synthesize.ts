// NEW stage — has no Python prototype counterpart, because the local testing never went
// past verification (see ../README.md). This is what actually writes the public-facing
// English answer from the verified Hebrew source candidates, in the SAME structural
// format the existing production code (netlify functions + the `questions`/`sources`
// tables) already expects, so nothing downstream of researchQuestion() needs to change:
//   - "## Synthesis across the sources" / "## Source-by-source" headings
//   - a trailing "TOPICS: a, b, c" line (parsed by the existing regex in index.ts)
//
// Citations are built directly from the verified candidate list, NOT extracted from a
// Claude response — the original code's citation extraction (extractCitations/
// buildAnnotatedAnswer in index.ts) only works because Claude's web_search tool attaches
// citation blocks automatically. Since this pipeline no longer uses web_search at all
// (retrieval+verification already grounds every claim in real corpus text), Claude is
// instead asked to cite using explicit [^N] markers keyed to a numbered source list we
// hand it, and we build the citations[] array ourselves, deterministically, from that
// same numbering. This is more reliable than depending on the model to self-report
// citations correctly, which matters given the "no human review" bar this pipeline is
// held to.
//
// COLLECTION LABELS (26 Jul, owner report): the answer page groups sources into
// Toras Menachem / Igros Kodesh tabs by matching the ENGLISH collection name in the
// source title and the "### " subsection headings. The first Fly-worker answers wrote
// Hebrew-only headings, so every source fell into the "More sources" tab. Both the
// stored source titles and the prompt's required subsection titles now lead with the
// English collection name (the site's nav labels strip that prefix for compactness —
// briefNavLabel in app.js — so the menus stay clean).
//
// TOKEN BUDGET SCALES WITH SOURCES (27 Jul, "Devarim 6:5" postmortem): that answer
// verified 12 genuine sources, but synthesis ran with a flat 5000-token budget — the
// required Source-by-source section alone (12 subsections × 3 cited bullets) plus
// model reasoning blew straight through it, and a 261-character mid-sentence fragment
// got published. The budget now scales with the number of verified sources (and
// anthropicClient additionally retries any truncated response with a doubled budget
// instead of returning the fragment).
//
// TALMIDEI CHACHAMIM POSTMORTEM (27 Jul): a broad classic topic verified far more than
// 20 genuine sources. Under the OLD flat 16000-token ceiling, the required Source-by-
// source section for that many sources couldn't fit even after doubling the budget
// through every retry in anthropicClient — synthesis kept truncating, kept retrying,
// and burned the whole 15-minute pipeline window (see index.ts's MAX_SYNTHESIS_SOURCES)
// before the sweeper reset the question back to queued. The real fix is capping HOW
// MANY verified sources synthesis is asked to write about at all (index.ts), not just
// raising the budget further — an unbounded source count has no token budget that both
// fits a single call and finishes inside the processing window. This file's budget
// ceiling is raised only enough to comfortably cover that fixed source cap in one
// attempt (4000 + 20 sources × 800 = 20000), not to chase an unbounded source count.
//
// CHULLIN 88 POSTMORTEM (27 Jul, owner decision): on the citation route, verify.ts now
// admits every index-confirmed citation as a real source — including passages that only
// cite the daf in a footnote while discussing something else — tagged on the candidate
// as `direct_citation` or `passing_reference`. Those two tiers are NOT interchangeable,
// and this file is where the difference becomes visible to the reader. The prompt used
// to tell the model that every source handed to it was already verified as "genuine,
// on-topic primary-source evidence"; saying that about a footnote aside would launder a
// passing mention into an exposition of the sugya, which is precisely the kind of
// overstatement this whole pipeline exists to prevent. Each source block now carries its
// tier, the synthesis is instructed to carry the weight accordingly, and a run whose
// sources are ALL passing references has to say so in its opening line.

import { callClaudeText } from "./anthropicClient.ts";
import { DIRECT_CITATION_SIGNAL, PASSING_REFERENCE_SIGNAL } from "./verify.ts";
import type { Candidate } from "./types.ts";

export type SynthesisCitation = {
  url: string;
  title: string;
  cited_text: string;
  // Footnote labels in this passage whose definitions cite the asked-about verse/daf
  // (citation-route candidates only — see citationLookup.ts, 26 Jul footnote locator).
  footnotes?: string[];
};

export type SynthesisResult = {
  answerMarkdown: string;
  citations: SynthesisCitation[];
  topics: string[];
};

function chabadLibraryUrl(sourceId: number): string {
  return `https://chabadlibrary.org/books/${sourceId}`;
}

export function collectionLabel(collection: Candidate["collection"]): string {
  return collection === "toras_menachem" ? "Toras Menachem" : "Igros Kodesh";
}

function isPassingReference(c: Candidate): boolean {
  return !!c.signals?.includes(PASSING_REFERENCE_SIGNAL);
}

function isDirectCitation(c: Candidate): boolean {
  return !!c.signals?.includes(DIRECT_CITATION_SIGNAL);
}

/** The tier line shown to the model inside each source block header. */
function tierLabel(c: Candidate): string {
  if (isPassingReference(c)) return " — PASSING REFERENCE";
  if (isDirectCitation(c)) return " — DIRECT DISCUSSION of the cited source";
  return "";
}

function buildSynthesisPrompt(question: string, numberedSources: { n: number; c: Candidate }[]): string {
  const sourceBlocks = numberedSources.map(({ n, c }) => {
    const footnoteLine = c.footnotes?.length
      ? `Cites the asked-about source in footnote(s): ${c.footnotes.join(", ")}\n`
      : "";
    const tierNote = isPassingReference(c)
      ? "NOTE: the citation index proves this passage cites the verse/daf asked about, but the passage " +
        "itself is about a different subject and only invokes the citation in passing. Real citation, " +
        "not a substantive discussion of it — present it as such.\n"
      : "";
    return (
      `--- Source ${n} (${collectionLabel(c.collection)}${tierLabel(c)}) ---\n` +
      `${c.volume_heading} / ${c.item_heading}\n` +
      footnoteLine +
      tierNote +
      `Hebrew text:\n${c.text}\n`
    );
  });
  const sourcesText = sourceBlocks.join("\n");

  const passingCount = numberedSources.filter(({ c }) => isPassingReference(c)).length;
  const allPassing = passingCount > 0 && passingCount === numberedSources.length;

  const tierRules = passingCount
    ? `\nSOURCE WEIGHTING — read carefully. These sources are NOT equal, and the answer must not flatten them:
- Sources marked DIRECT DISCUSSION substantively engage what they cite. Build the synthesis on these.
- Sources marked PASSING REFERENCE genuinely cite the source asked about, but in passing, while making a different point. They are included because a citation lookup asks "where does the Rebbe reference this?", and the answer to that is a real, verifiable fact worth showing. They are NOT evidence of a position on it. Never write "the Rebbe teaches/holds/explains" about the cited source on the strength of a passing reference. Say what is actually true: that he cites it, where, in which footnote, and what the passage is really discussing.
- Do not pad. A short, exact answer beats an inflated one.${
        allPassing
          ? `\n- EVERY source here is a passing reference. Your opening sentence must say so plainly — that the Rebbe does cite this source in the material indexed, but does not discuss it substantively in what was found — before going on to describe where and in what context he cites it. Do not open with a sentence that implies a teaching or position on it.`
          : ""
      }\n`
    : "";

  return `You are a careful direct-source research editor writing the public answer for "What does the Rebbe say about X?" — a tool that answers only from Rabbi Menachem M. Schneerson's (the Lubavitcher Rebbe's) own talks and letters. The Hebrew sources below have ALREADY been checked by an independent verification pass — you do not need to re-judge whether they belong, only synthesize and translate them faithfully, at the weight each one actually carries.

The question being researched: "${JSON.stringify(question)}"

Verified primary sources (in Hebrew):

${sourcesText}
${tierRules}
Requirements:
1. Ground every claim in the source text given above. Do not use outside knowledge, memory, or anything not shown here. Never invent names, dates, quotations, or context beyond what's in these sources.
2. Translate short quotations into clear English; keep quotations brief and mark them as quotes. Note where you are paraphrasing vs. quoting directly.
3. Cite using bracketed footnote markers like [^1], [^2] that refer to the Source numbers above (Source 1 -> [^1], Source 2 -> [^2], etc.) — attach the marker directly after the sentence or bullet it supports. Do not renumber the sources.
4. Write G-d rather than God.
5. If the sources address the topic only briefly, narrowly, or indirectly, say so plainly rather than stretching thin material into a confident-sounding answer. It's fine for the synthesis to be short if that's what the material actually supports.
6. Write for a reader who wants the Rebbe's Torah, not a description of how the search ran. Never mention retrieval, indexing, scraping, embeddings, verification passes, or "the corpus" in the answer itself.

Required structure:
## Synthesis across the sources
A concise synthesis of the Rebbe's position across these verified sources — recurring principles, meaningful differences in emphasis, practical direction. Synthesize; don't describe the research process.

## Source-by-source
One subsection per source. Each subsection title MUST begin with the source's collection name in English exactly as given in its header above ("Toras Menachem" or "Igros Kodesh"), then a comma, then its volume/item heading — e.g. "### Toras Menachem, תשלא חלק שני — ...". Under each, exactly these bullets:
- **What the Rebbe says about this topic:** the specific point, instruction, or framing in this source. For a PASSING REFERENCE, state instead exactly how the citation is used here (e.g. "cited in a footnote supporting a halachic aside about X").
- **What this source is generally about:** the broader talk/letter, occasion, or subject.
- **How prominent the topic is:** Central, Substantial, Brief, or Incidental, with one short reason. A PASSING REFERENCE is Brief or Incidental — never Central or Substantial.
Each bullet must carry its [^N] citation.

Aim for roughly 400-800 words (shorter is fine if the verified material is thin — do not pad). End with one line formatted exactly: TOPICS: topic one, topic two, topic three, topic four — derive 3-4 concise discovery phrases specifically from this answer.`;
}

/**
 * Writes the final public answer from a list of verified GENUINE candidates. Returns a
 * short, honest "not found" result WITHOUT calling the API at all if the list is empty —
 * this is a deliberate design choice, not a corner cut: when verification confirms zero
 * genuine sources, there is nothing to synthesize, and skipping the LLM call removes any
 * chance of it inventing content to fill the gap (exactly the failure mode the whole
 * verification stage exists to prevent).
 *
 * Callers (index.ts) are responsible for capping `verifiedCandidates` to a sane count
 * before calling this — see MAX_SYNTHESIS_SOURCES there. This function scales its
 * budget to whatever count it's actually given, but does not itself bound that count.
 */
export async function synthesize(
  apiKey: string,
  model: string,
  question: string,
  verifiedCandidates: Candidate[],
): Promise<SynthesisResult> {
  if (verifiedCandidates.length === 0) {
    // Reader-facing copy: no pipeline vocabulary. This is the one paragraph a visitor
    // sees when nothing was found, and it used to describe scraping, retrieval passes
    // and "the corpus" — engineering language on a page about the Rebbe's Torah.
    return {
      answerMarkdown:
        "## Synthesis across the sources\n\n" +
        "No passage in Toras Menachem or Igros Kodesh was found that addresses this question directly. " +
        "That may mean the Rebbe did not take it up in the volumes indexed here, or that he addresses it " +
        "in language this search did not match. Either way, nothing is being offered as an answer that the " +
        "sources do not actually support — please treat this as an honest negative rather than a conclusion.",
      citations: [],
      topics: [],
    };
  }

  const numberedSources = verifiedCandidates.map((c, i) => ({ n: i + 1, c }));
  const prompt = buildSynthesisPrompt(question, numberedSources);
  const system = "You are a careful direct-source research editor. The Rebbe's own words, as given to you, are the evidence; you add no outside claims.";
  // Budget scales with the verified source count ("Devarim 6:5" postmortem, 27 Jul).
  // Ceiling raised from 16000 -> 24000 ("talmidei chachamim" postmortem, 27 Jul) so a
  // full MAX_SYNTHESIS_SOURCES-sized answer (index.ts caps at 20: 4000 + 20*800 =
  // 20000) fits in ONE call instead of relying on anthropicClient's truncation-retry
  // loop to get there — that loop exists as a safety net for genuine surprises, not as
  // the normal path for a predictably-sized request.
  const synthesisBudget = Math.min(24000, 4000 + numberedSources.length * 800);
  const text = await callClaudeText(apiKey, model, prompt, system, synthesisBudget);

  const topicMatch = text.match(/TOPICS:\s*([^\n]+)/i);
  const topics = [
    ...new Set(
      (topicMatch?.[1] ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length >= 2 && t.length <= 40),
    ),
  ].slice(0, 4);

  const answerMarkdown = text.replace(/TOPICS:\s*[^\n]+/i, "").trim();

  const citations: SynthesisCitation[] = numberedSources.map(({ c }) => ({
    url: chabadLibraryUrl(c.source_id),
    // Lead with the English collection name — the site's collection tabs (and the
    // "More sources" fallback) group by matching this exact prefix.
    title: `${collectionLabel(c.collection)}, ${c.volume_heading} / ${c.item_heading}`,
    cited_text: c.text.slice(0, 500),
    footnotes: c.footnotes,
  }));

  return { answerMarkdown, citations, topics };
}
