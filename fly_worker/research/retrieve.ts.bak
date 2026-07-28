// Deno/TypeScript port of retrieve.py's hybrid_search — same merge-by-dedup logic,
// same rationale (semantic and keyword scores are on incomparable scales, so results
// are merged and signal-tagged rather than combined into one fake unified score; the
// United Nations test case showed a keyword-only hit the embedding alone ranked ~29,125th
// out of 33,559 — dropping either signal would have missed real evidence). The only
// structural difference from retrieve.py: this queries Supabase's match_corpus_chunks /
// search_corpus_chunks_text RPCs over the network instead of a local numpy array, and
// computes the query embedding via embedQuery.ts instead of local sentence-transformers.

import { embedQuery, embeddingToVectorLiteral } from "./embedQuery.ts";
import type { Candidate, Collection } from "./types.ts";

const COLLECTIONS: Collection[] = ["toras_menachem", "igrot_kodesh"];

type RpcRow = {
  id: number;
  collection: Collection;
  source_id: number;
  volume_heading: string;
  item_heading: string;
  chunk_index: number;
  lang: string;
  chunk_text: string;
  similarity?: number;
  rank?: number;
};

async function callRpc(
  supabaseUrl: string,
  adminHeaders: Record<string, string>,
  fn: string,
  args: Record<string, unknown>,
): Promise<RpcRow[]> {
  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    throw new Error(`RPC ${fn} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function semanticSearch(
  supabaseUrl: string,
  adminHeaders: Record<string, string>,
  queryText: string,
  topK: number,
  collectionFilter: Collection | null,
): Promise<Candidate[]> {
  const embedding = await embedQuery(queryText);
  const rows = await callRpc(supabaseUrl, adminHeaders, "match_corpus_chunks", {
    query_embedding: embeddingToVectorLiteral(embedding),
    match_count: topK,
    filter_collection: collectionFilter,
  });
  return rows.map((r) => ({
    collection: r.collection,
    source_id: r.source_id,
    volume_heading: r.volume_heading,
    item_heading: r.item_heading,
    chunk_index: r.chunk_index,
    lang: r.lang,
    text: r.chunk_text,
    signals: ["semantic"],
    semantic_score: r.similarity,
  }));
}

async function keywordSearch(
  supabaseUrl: string,
  adminHeaders: Record<string, string>,
  keywordTerms: string[],
  topK: number,
  collectionFilter: Collection | null,
): Promise<Candidate[]> {
  if (!keywordTerms.length) return [];
  // search_corpus_chunks_text takes one search_terms string; trigram similarity already
  // handles multi-word phrases well, so terms are joined with a space rather than run
  // once per term — matches the intent of retrieve.py's per-term substring counting
  // closely enough for trigram-based ranking, which operates on the whole string anyway.
  //
  // SIMCHA POSTMORTEM (26 Jul): a keyword-search failure (e.g. a database statement
  // timeout) used to propagate up and kill the ENTIRE research attempt, even though
  // semantic retrieval was healthy. Keyword search is one of two redundant signals, so
  // it now degrades gracefully: log loudly, return no keyword hits, and let the run
  // proceed semantic-only rather than failing the question.
  let rows: RpcRow[] = [];
  try {
    rows = await callRpc(supabaseUrl, adminHeaders, "search_corpus_chunks_text", {
      search_terms: keywordTerms.join(" "),
      match_count: topK,
      filter_collection: collectionFilter,
    });
  } catch (e) {
    console.error(`WARNING: keyword search failed; continuing with semantic-only retrieval: ${e}`);
    return [];
  }
  return rows.map((r) => ({
    collection: r.collection,
    source_id: r.source_id,
    volume_heading: r.volume_heading,
    item_heading: r.item_heading,
    chunk_index: r.chunk_index,
    lang: r.lang,
    text: r.chunk_text,
    signals: ["keyword"],
    keyword_hits: r.rank,
  }));
}

export async function hybridSearch(
  supabaseUrl: string,
  adminHeaders: Record<string, string>,
  queryTexts: string[],
  keywordTerms: string[],
  topKSemantic: number,
  topKKeyword: number,
  collectionFilter: Collection | null,
  maxResults?: number,
): Promise<Candidate[]> {
  // Multi-query fan-out: each query sentence targets a different semantic neighborhood
  // (the "France" case showed one embedding query fills every slot with a single theme —
  // Paris-community letters — while ~250 other on-topic documents never surface).
  const [semanticResultSets, keywordResults] = await Promise.all([
    Promise.all(queryTexts.map((q) => semanticSearch(supabaseUrl, adminHeaders, q, topKSemantic, collectionFilter))),
    keywordSearch(supabaseUrl, adminHeaders, keywordTerms, topKKeyword, collectionFilter),
  ]);

  type Scored = Candidate & { hits: number };
  const merged = new Map<string, Scored>();
  for (const set of semanticResultSets) {
    for (const r of set) {
      const key = `${r.source_id}:${r.chunk_index}`;
      const existing = merged.get(key);
      if (existing) {
        // Found by more than one sub-query — stronger evidence of centrality.
        existing.hits += 1;
        if ((r.semantic_score ?? 0) > (existing.semantic_score ?? 0)) existing.semantic_score = r.semantic_score;
      } else {
        merged.set(key, { ...r, hits: 1 });
      }
    }
  }
  for (const r of keywordResults) {
    const key = `${r.source_id}:${r.chunk_index}`;
    const existing = merged.get(key);
    if (existing) {
      if (!existing.signals.includes("keyword")) existing.signals.push("keyword");
      existing.keyword_hits = r.keyword_hits;
      existing.hits += 1;
    } else {
      merged.set(key, { ...r, hits: 1 });
    }
  }

  const results = Array.from(merged.values());
  results.sort((a, b) => {
    // Multi-signal (semantic+keyword) first, then by how many independent searches
    // surfaced the chunk — same spirit as the original two-signal ordering.
    const scoreA = a.signals.length * 10 + a.hits;
    const scoreB = b.signals.length * 10 + b.hits;
    return scoreB - scoreA;
  });
  const capped = typeof maxResults === "number" ? results.slice(0, maxResults) : results;
  return capped.map(({ hits: _hits, ...c }) => c as Candidate);
}

/** Pulls topKPerCollection results from EACH collection separately, rather than pooling
 * globally — otherwise a collection whose chunks score a few hundredths lower on average
 * (even if genuinely relevant) gets structurally crowded out entirely. */
export async function hybridSearchPerCollection(
  supabaseUrl: string,
  adminHeaders: Record<string, string>,
  queryTexts: string[],
  keywordTerms: string[],
  topKPerCollection: number,
): Promise<Record<Collection, Candidate[]>> {
  const entries = await Promise.all(
    COLLECTIONS.map(async (c) => [
      c,
      await hybridSearch(supabaseUrl, adminHeaders, queryTexts, keywordTerms, topKPerCollection, topKPerCollection, c, topKPerCollection),
    ] as const),
  );
  return Object.fromEntries(entries) as Record<Collection, Candidate[]>;
}
