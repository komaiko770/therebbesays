// Deno/TypeScript port of parse_citation_question.py + the citation_index.json lookup
// (link_citations_to_chunks.py's output, now loaded into Supabase's corpus_citations
// table). Lets a question like "what does the Rebbe say about Bereishis 6:4" or
// "Brachos 2a" be answered by a direct, precise database lookup instead of semantic/
// keyword guessing.
//
// Uses an LLM call (same pattern as analyzeQuestion.ts), not hand-rolled regex,
// specifically to handle transliteration variance (Brachos/Berachos/Brochos,
// Bereishis/Genesis/Beresheet, "second chapter" vs "6:4", etc.) — the same reasoning
// that led analyze_question.py to use an LLM for query generation rather than a fixed
// pattern list.

import { callClaudeTool } from "./anthropicClient.ts";
import type { Candidate, Collection } from "./types.ts";

const TANACH_BOOK_ENUM = [
  "Amos", "Bamidbar", "Bereishis", "Chagai", "Chavakuk", "Daniel", "Devarim",
  "DivreiHayamim", "DivreiHayamim1", "DivreiHayamim2", "Eichah", "Esther", "Ezra",
  "Hoshea", "Iyov", "Koheles", "Malachi", "Melachim1", "Melachim2", "Michah", "Mishlei",
  "Nachum", "Nechemiah", "Ovadiah", "Rus", "Shemos", "ShirHaShirim", "Shmuel1",
  "Shmuel2", "Shoftim", "Tehillim", "Tzefaniah", "Vayikra", "Yechezkel", "Yehoshua",
  "Yeshaya", "Yirmiyahu", "Yoel", "Yonah", "Zechariah",
];
const BAVLI_TRACTATE_ENUM = [
  "AvodahZarah", "BavaBasra", "BavaKamma", "BavaMetzia", "Bechoros", "Beitzah",
  "Berachos", "Chagigah", "Chullin", "Erchin", "Eruvin", "Gittin", "Horayos",
  "Kerisos", "Kesubos", "Kiddushin", "Makkos", "Megillah", "Meilah", "Menachos",
  "MoedKatan", "Nazir", "Nedarim", "Niddah", "Pesachim", "RoshHashanah", "Sanhedrin",
  "Shabbos", "Shevuos", "Sotah", "Sukkah", "Taanis", "Tamid", "Temurah", "Yevamos",
  "Yoma", "Zevachim",
];

const CITATION_TOOL = {
  name: "report_citation_lookup",
  description: "Report whether this question asks about a SPECIFIC Torah verse or Talmud Bavli daf, as opposed to a general topic.",
  input_schema: {
    type: "object",
    properties: {
      is_citation_lookup: {
        type: "boolean",
        description: "True ONLY if the question names a specific verse (e.g. 'Bereishis 6:4', 'Genesis chapter 1 verse 1') or a specific Talmud Bavli daf (e.g. 'Brachos 2a', 'Sanhedrin daf 90'). False for any general/topical question, even one that happens to mention a book or tractate name in passing (e.g. 'what does the Rebbe say about the Talmudic view of charity' is NOT a citation lookup).",
      },
      citation_type: {
        type: "string",
        enum: ["tanach", "bavli"],
        description: "Required if is_citation_lookup is true. 'tanach' for a Torah/Tanach verse, 'bavli' for a Talmud Bavli daf.",
      },
      book_or_tractate: {
        type: "string",
        enum: [...TANACH_BOOK_ENUM, ...BAVLI_TRACTATE_ENUM],
        description: "Required if is_citation_lookup is true. The canonical book (if tanach) or tractate (if bavli) name from this exact enum, mapped from however the user phrased/spelled/transliterated it.",
      },
      chapter_or_daf: {
        type: "integer",
        description: "Required if is_citation_lookup is true. The chapter number (tanach) or daf/page number (bavli).",
      },
      verse_or_amud: {
        type: "string",
        description: "Required if is_citation_lookup is true. For tanach: the verse number as a string (e.g. '4'). For bavli: 'a' or 'b' (amud/side of the daf) — infer 'a' if the user didn't specify a side.",
      },
    },
    required: ["is_citation_lookup"],
  },
};

export type CitationParseResult =
  | { is_citation_lookup: false }
  | {
      is_citation_lookup: true;
      citation_type: "tanach" | "bavli";
      book_or_tractate: string;
      chapter_or_daf: number;
      verse_or_amud: string;
      normalized_key: string;
    };

function buildPrompt(question: string): string {
  return `Determine whether this question is asking about a SPECIFIC Torah verse or a SPECIFIC Talmud Bavli daf/page, as opposed to a general topic.

Question: "${question}"

Examples of a TRUE citation lookup: "What does the Rebbe say about Bereishis 6:4?", "What's the Rebbe's explanation of Brachos daf beis amud alef?", "Genesis chapter 1 verse 1", "Sanhedrin 90a".

Examples of FALSE (general topic, not a citation lookup, even if a book/tractate is mentioned): "What does the Rebbe say about evolution?", "What does the Talmud's view of charity mean to the Rebbe?", "What does the Rebbe say about the story of Noah?" (a topic/story, not a specific chapter:verse).

If it IS a citation lookup, map whatever spelling/transliteration/phrasing the user used to the canonical book or tractate name from the enum, and extract the exact chapter/verse or daf/amud.

Call report_citation_lookup.`;
}

export async function parseCitationQuestion(
  apiKey: string,
  model: string,
  question: string,
): Promise<CitationParseResult> {
  const prompt = buildPrompt(question);
  const result = await callClaudeTool(apiKey, model, prompt, CITATION_TOOL, 512);

  if (!result.is_citation_lookup) {
    return { is_citation_lookup: false };
  }

  const citationType = result.citation_type as "tanach" | "bavli";
  const bookOrTractate = String(result.book_or_tractate);
  const chapterOrDaf = Number(result.chapter_or_daf);
  let verseOrAmud = String(result.verse_or_amud ?? "").trim().toLowerCase();
  if (citationType === "bavli" && verseOrAmud !== "a" && verseOrAmud !== "b") {
    verseOrAmud = "a";
  }

  return {
    is_citation_lookup: true,
    citation_type: citationType,
    book_or_tractate: bookOrTractate,
    chapter_or_daf: chapterOrDaf,
    verse_or_amud: verseOrAmud,
    normalized_key: `${citationType}:${bookOrTractate.toLowerCase()}:${chapterOrDaf}:${verseOrAmud}`,
  };
}

type RpcRow = {
  id: number; collection: Collection; source_id: number; volume_heading: string;
  item_heading: string; chunk_index: number; lang: string; chunk_text: string;
};

/** Looks up every chunk that cites this exact verse/daf, via the lookup_citation_chunks
 * RPC (a straight join from corpus_citations to corpus_chunks). Returns the same
 * Candidate shape retrieve.ts produces, so verify.ts and synthesize.ts need no
 * special-casing for citation-sourced candidates. */
export async function lookupCitationChunks(
  supabaseUrl: string,
  adminHeaders: Record<string, string>,
  normalizedKey: string,
  matchCount = 20,
): Promise<Candidate[]> {
  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/lookup_citation_chunks`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ citation_key: normalizedKey, match_count: matchCount }),
  });
  if (!res.ok) {
    throw new Error(`RPC lookup_citation_chunks failed: ${res.status} ${await res.text()}`);
  }
  const rows: RpcRow[] = await res.json();
  return rows.map((r) => ({
    collection: r.collection,
    source_id: r.source_id,
    volume_heading: r.volume_heading,
    item_heading: r.item_heading,
    chunk_index: r.chunk_index,
    lang: r.lang,
    text: r.chunk_text,
    signals: ["citation"],
  }));
}
