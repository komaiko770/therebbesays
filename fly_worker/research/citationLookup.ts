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
//
// WHOLE-DAF LOOKUP ("Chullin 88" postmortem, 27 Jul). A bare daf reference with no
// side — "Chullin 88", the way people normally speak — used to be silently narrowed
// to amud A: verse_or_amud defaulted to "a" and the index was queried for
// `bavli:chullin:88:a` alone. For that exact question the index held ZERO entries for
// 88a and TWO for 88b, so the run found nothing in the index, fell through to a
// semantic guess at the sugya's themes, had all 120 semantic candidates rejected by
// adversarial review, and published a confident "no passage survived verification"
// answer while real citations sat one amud away, never looked at. An honest negative
// that isn't true is the worst failure this system can produce.
//
// Now: when the asker does NOT name an amud, BOTH sides of the daf are looked up and
// the key records that truthfully as `bavli:<tractate>:<daf>:a+b`. That key is what
// index.ts writes into research_funnel/research_progress, so the site's Research
// trail shows what was actually searched instead of overstating precision. An
// explicitly requested side (e.g. "Sanhedrin 90b") is still honoured exactly.

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

// Marker for "the asker named a daf but not a side, so search the whole daf".
const BOTH_AMUDIM = "a+b";

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
        description: "Required if is_citation_lookup is true. For tanach: the verse number as a string (e.g. '4'). For bavli: 'a' or 'b' (amud/side of the daf) if — and ONLY if — the asker actually named a side. If the asker gave only a daf number with no side, leave this empty and set amud_specified to false. Never guess a side.",
      },
      amud_specified: {
        type: "boolean",
        description: "Bavli only. True if the asker explicitly named an amud/side (e.g. 'Brachos 2a', 'daf beis amud beis', '90b'). False if they gave only a daf number (e.g. 'Chullin 88', 'Sanhedrin daf 90') — in that case BOTH sides of the daf will be searched. Default to false when unsure.",
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
      /** For bavli with no side named, this is "a+b" — both amudim were searched. */
      verse_or_amud: string;
      normalized_key: string;
    };

function buildPrompt(question: string): string {
  return `Determine whether this question is asking about a SPECIFIC Torah verse or a SPECIFIC Talmud Bavli daf/page, as opposed to a general topic.

Question: "${question}"

Examples of a TRUE citation lookup: "What does the Rebbe say about Bereishis 6:4?", "What's the Rebbe's explanation of Brachos daf beis amud alef?", "Genesis chapter 1 verse 1", "Sanhedrin 90a", "Chullin 88".

Examples of FALSE (general topic, not a citation lookup, even if a book/tractate is mentioned): "What does the Rebbe say about evolution?", "What does the Talmud's view of charity mean to the Rebbe?", "What does the Rebbe say about the story of Noah?" (a topic/story, not a specific chapter:verse).

If it IS a citation lookup, map whatever spelling/transliteration/phrasing the user used to the canonical book or tractate name from the enum, and extract the exact chapter/verse or daf/amud.

For a Talmud daf, report amud_specified honestly: "Sanhedrin 90a" and "daf beis amud beis" name a side (true); "Chullin 88" and "Sanhedrin daf 90" do not (false). Do NOT invent a side the asker did not give — both sides get searched in that case.

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

  if (citationType === "bavli") {
    // Whole-daf lookup ("Chullin 88" postmortem): only pin a single side when the
    // asker actually named one. Anything else — no side given, an unparseable side,
    // or the model omitting the flag — searches BOTH amudim rather than silently
    // discarding half the daf.
    const sideNamed = result.amud_specified === true && (verseOrAmud === "a" || verseOrAmud === "b");
    verseOrAmud = sideNamed ? verseOrAmud : BOTH_AMUDIM;
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
  // Footnote labels in this chunk whose definitions cite the looked-up verse/daf
  // (returned by lookup_citation_chunks since the 26 Jul footnote-locator migration).
  footnotes: string[] | null;
};

/** Expands a normalized key into the concrete index keys to query. A whole-daf key
 * ("bavli:chullin:88:a+b") becomes both amudim; every other key stands alone. */
export function expandCitationKeys(normalizedKey: string): string[] {
  if (!normalizedKey.endsWith(`:${BOTH_AMUDIM}`)) return [normalizedKey];
  const stem = normalizedKey.slice(0, -(BOTH_AMUDIM.length));
  return [`${stem}a`, `${stem}b`];
}

async function fetchCitationRows(
  supabaseUrl: string,
  adminHeaders: Record<string, string>,
  citationKey: string,
  matchCount: number,
): Promise<RpcRow[]> {
  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/lookup_citation_chunks`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ citation_key: citationKey, match_count: matchCount }),
  });
  if (!res.ok) {
    throw new Error(`RPC lookup_citation_chunks failed: ${res.status} ${await res.text()}`);
  }
  return await res.json();
}

/** Looks up every chunk that cites this exact verse/daf, via the lookup_citation_chunks
 * RPC (a straight join from corpus_citations to corpus_chunks). Returns the same
 * Candidate shape retrieve.ts produces, so verify.ts and synthesize.ts need no
 * special-casing for citation-sourced candidates.
 *
 * A whole-daf key queries both amudim and merges the results: the same chunk can cite
 * both sides, so hits are de-duplicated on (collection, source_id, chunk_index) and
 * their footnote locators are unioned, keeping the "Cited in footnote N" detail
 * complete rather than letting one side's row overwrite the other's. */
export async function lookupCitationChunks(
  supabaseUrl: string,
  adminHeaders: Record<string, string>,
  normalizedKey: string,
  matchCount = 20,
): Promise<Candidate[]> {
  const keys = expandCitationKeys(normalizedKey);
  const rowSets = await Promise.all(
    keys.map((key) => fetchCitationRows(supabaseUrl, adminHeaders, key, matchCount)),
  );

  const byChunk = new Map<string, Candidate>();
  for (const rows of rowSets) {
    for (const r of rows) {
      const id = `${r.collection}:${r.source_id}:${r.chunk_index}`;
      const footnotes = Array.isArray(r.footnotes) ? r.footnotes.filter(Boolean) : [];
      const existing = byChunk.get(id);
      if (existing) {
        if (footnotes.length) {
          existing.footnotes = [...new Set([...(existing.footnotes ?? []), ...footnotes])];
        }
        continue;
      }
      byChunk.set(id, {
        collection: r.collection,
        source_id: r.source_id,
        volume_heading: r.volume_heading,
        item_heading: r.item_heading,
        chunk_index: r.chunk_index,
        lang: r.lang,
        text: r.chunk_text,
        signals: ["citation"],
        footnotes: footnotes.length ? footnotes : undefined,
      });
    }
  }

  // Both amudim can each return up to matchCount rows; keep the combined pool bounded
  // by the same ceiling the caller asked for.
  return [...byChunk.values()].slice(0, matchCount);
}
