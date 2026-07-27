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

import { callClaudeText } from "./anthropicClient.ts";
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

function buildSynthesisPrompt(question: string, numberedSources: { n: number; c: Candidate }[]): string {
  const sourceBlocks = numberedSources.map(
    ({ n, c }) =>
      `--- Source ${n} (${collectionLabel(c.collection)}) ---\n` +
      `${c.volume_heading} / ${c.item_heading}\nHebrew text:\n${c.text}\n`,
  );
  const sourcesText = sourceBlocks.join("\n");

  return `You are a careful direct-source research editor writing the public answer for "What does the Rebbe say about X?" — a tool that answers only from Rabbi Menachem M. Schneerson's (the Lubavitcher Rebbe's) own talks and letters. The Hebrew sources below have ALREADY been verified as genuine, on-topic primary-source evidence for this exact question by an independent verification pass — you do not need to re-judge their relevance, only synthesize and translate them faithfully.

The question being researched: "${JSON.stringify(question)}"

Verified primary sources (in Hebrew):

${sourcesText}

Requirements:
1. Ground every claim in the source text given above. Do not use outside knowledge, memory, or anything not shown here. Never invent names, dates, quotations, or context beyond what's in these sources.
2. Translate short quotations into clear English; keep quotations brief and mark them as quotes. Note where you are paraphrasing vs. quoting directly.
3. Cite using bracketed footnote markers like [^1], [^2] that refer to the Source numbers above (Source 1 -> [^1], Source 2 -> [^2], etc.) — attach the marker directly after the sentence or bullet it supports. Do not renumber the sources.
4. Write G-d rather than God.
5. If the sources address the topic only briefly, narrowly, or indirectly, say so plainly rather than stretching thin material into a confident-sounding answer. It's fine for the synthesis to be short if that's what the material actually supports.

Required structure:
## Synthesis across the sources
A concise synthesis of the Rebbe's position across these verified sources — recurring principles, meaningful differences in emphasis, practical direction. Synthesize; don't describe the research process.

## Source-by-source
One subsection per source. Each subsection title MUST begin with the source's collection name in English exactly as given in its header above ("Toras Menachem" or "Igros Kodesh"), then a comma, then its volume/item heading — e.g. "### Toras Menachem, תשלא חלק שני — ...". Under each, exactly these bullets:
- **What the Rebbe says about this topic:** the specific point, instruction, or framing in this source.
- **What this source is generally about:** the broader talk/letter, occasion, or subject.
- **How prominent the topic is:** Central, Substantial, Brief, or Incidental, with one short reason.
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
 */
export async function synthesize(
  apiKey: string,
  model: string,
  question: string,
  verifiedCandidates: Candidate[],
): Promise<SynthesisResult> {
  if (verifiedCandidates.length === 0) {
    return {
      answerMarkdown:
        "## Synthesis across the sources\n\n" +
        "After searching the scraped Toras Menachem and Igrot Kodesh corpus with both semantic and keyword retrieval, " +
        "no passage survived independent verification as genuine, substantive evidence on this specific question. " +
        "This may mean the Rebbe did not address this topic directly in the material currently indexed, or that it " +
        "appears in a way this retrieval pass did not surface. Treat this as an honest negative result rather than a confident answer.",
      citations: [],
      topics: [],
    };
  }

  const numberedSources = verifiedCandidates.map((c, i) => ({ n: i + 1, c }));
  const prompt = buildSynthesisPrompt(question, numberedSources);
  const system = "You are a careful direct-source research editor. The Rebbe's own words, as given to you, are the evidence; you add no outside claims.";
  const text = await callClaudeText(apiKey, model, prompt, system, 5000);

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
