// Long-lived Deno research worker for Fly.io — moved here from the Supabase Edge
// Function `research-question` because the Edge runtime's execution window killed the
// background task (EdgeRuntime.waitUntil) before the multi-minute pipeline finished.
//
// WHAT CHANGED vs. the Edge Function index.ts:
//   1. Removed `import "jsr:@supabase/functions-js/edge-runtime.d.ts";` (Edge-only).
//   2. `Deno.serve(handler)` -> `Deno.serve({ port, hostname: "127.0.0.1" }, handler)`
//      so it binds a local port the Python front (app.py /research) proxies to. It is
//      NOT publicly exposed; auth is enforced at the Python proxy layer.
//   3. `EdgeRuntime.waitUntil(...)` -> plain fire-and-forget; the long-lived process
//      lets the background task run to completion.
//   4. LIVE STAGE REPORTING (26 Jul): the worker now writes `research_stage` to the
//      questions row at every pipeline step (analyzing -> retrieving -> reflecting ->
//      verifying -> synthesizing). The site preloader reads this column, so what users
//      see is the pipeline's true state — never simulated. Stage writes are
//      best-effort: a failed stage write never kills the research task itself.
//   5. RETRIEVAL COVERAGE (26 Jul, "France" postmortem): TOP_K_PER_COLLECTION raised
//      15 -> 30, retrieval now fans out over MULTIPLE Hebrew sub-queries (main query +
//      up to 3 alternates from analyzeQuestion) instead of one, and every run records a
//      `research_funnel` JSON on the questions row (retrieved -> genuine -> cited, plus
//      the exact queries used) so coverage gaps are visible instead of silent.
//   6. RETRIEVAL DEPTH + FUNNEL DETAIL (26 Jul, "Morocco" postmortem): the corpus held
//      64 chunks literally mentioning Morocco (55 in Igrot Kodesh alone), but the
//      per-collection cap of 30 structurally excluded at least 25 of them before any
//      reviewer ever saw them. TOP_K_PER_COLLECTION raised 30 -> 60. The funnel now
//      also records the pass-1 verdict breakdown and exactly which sources the
//      adversarial vote refuted, so the next coverage complaint can be diagnosed from
//      the database alone.
//   7. VERSE/DAF CITATION ROUTE (26 Jul): one cheap up-front classification call
//      (parseCitationQuestion, see citationLookup.ts) decides whether the question
//      names a SPECIFIC Torah verse or Talmud Bavli daf. If yes, candidates come from
//      a direct corpus_citations lookup (lookupCitationChunks) instead of semantic/
//      keyword search; if no (the vast majority), execution proceeds through the exact
//      same topical path as before. Both routes converge on the same verify() and
//      synthesize() calls, and the funnel records which route ran.
//   8. ZERO-CITATION PUBLISH FIX (26 Jul, "simcha" postmortem): a 0-citation honest
//      answer used to write confidence "none", which violates the questions table's
//      check constraint (high/medium/low/NULL only) — the final save failed with 23514
//      AFTER a full successful research run, and the question was marked failed.
//      Zero citations now save confidence NULL.
//   9. MONSTER-CHUNK GUARD (26 Jul, "Los Angeles" postmortem): the corpus contains
//      155 pathologically large chunks (up to ~93K chars vs. a ~1.4K average — bad
//      splits in the original scrape). "Los Angeles" keyword retrieval pulled several
//      into the pool and the run died twice with `prompt is too long: 1552223 tokens
//      > 1000000 maximum`. Every candidate's text is now capped at
//      MAX_CANDIDATE_CHARS before it can enter ANY prompt (reflection additionally
//      caps per-passage length on its own — see analyzeQuestion.ts). Truncation is
//      marked in the text so reviewers know they saw a prefix.
//
// The topical pipeline (analyzeQuestion -> hybridSearchPerCollection ->
// reflectOnCandidates -> verify -> synthesize) is unchanged.

import { analyzeQuestion, reflectOnCandidates } from "./analyzeQuestion.ts";
import { hybridSearchPerCollection } from "./retrieve.ts";
import { parseCitationQuestion, lookupCitationChunks } from "./citationLookup.ts";
import { verify } from "./verify.ts";
import { synthesize } from "./synthesize.ts";
import type { Candidate } from "./types.ts";

type Question = { id: string; question: string; status: string; research_attempts: number };
type SourceRow = {
  question_id: string;
  ordinal: number;
  title: string;
  url: string;
  publisher: string;
  host_publisher: string;
  original_source_title: null;
  original_source_detail: null;
  citation_label: string;
  supporting_excerpt: string;
  source_type: string;
  verified_at: string;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const ANTHROPIC_MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-5";
const RESEARCH_PORT = Number(Deno.env.get("RESEARCH_PORT") ?? "8081");
const adminHeaders = { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}`, "content-type": "application/json" };

// Retrieval/verification tuning. TOP_K_PER_COLLECTION history: 15 (full_pipeline_test.py
// default) -> 30 ("France" postmortem: one embedding query fills every slot with a
// single theme) -> 60 ("Morocco" postmortem: 55 literal-mention Igrot Kodesh chunks
// existed but only 30 could ever be considered; the cap itself was the coverage floor).
const TOP_K_PER_COLLECTION = 60;
const N_ADVERSARIAL_VOTERS = 3;

// Monster-chunk guard ("Los Angeles" postmortem, 26 Jul): hard per-candidate text cap
// applied before candidates reach any LLM prompt. 12K chars keeps ~99.5% of chunks
// fully intact (avg is ~1.4K) while making the worst case bounded: even a full pool of
// 120 candidates at the cap is ~1.4M chars ≈ well under the API's 1M-token ceiling for
// any single verify batch (25 candidates) or synthesis call.
const MAX_CANDIDATE_CHARS = 12000;
function capCandidateTexts(list: Candidate[]): Candidate[] {
  return list.map((c) =>
    c.text.length > MAX_CANDIDATE_CHARS
      ? { ...c, text: c.text.slice(0, MAX_CANDIDATE_CHARS) + "\n…[passage truncated for prompt-size safety — abnormally large source chunk]" }
      : c
  );
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

async function getQuestion(id: string): Promise<Question | null> {
  const params = new URLSearchParams({ select: "id,question,status,research_attempts", id: `eq.${id}`, limit: "1" });
  const result = await fetch(`${SUPABASE_URL}/rest/v1/questions?${params}`, { headers: adminHeaders });
  if (!result.ok) throw new Error(`Question lookup failed: ${result.status}`);
  const rows = await result.json();
  return rows[0] || null;
}

async function patchQuestion(id: string, values: Record<string, unknown>) {
  const result = await fetch(`${SUPABASE_URL}/rest/v1/questions?id=eq.${id}`, {
    method: "PATCH",
    headers: { ...adminHeaders, prefer: "return=minimal" },
    body: JSON.stringify(values),
  });
  if (!result.ok) throw new Error(`Question update failed: ${result.status} ${await result.text()}`);
}

// Best-effort live stage reporting for the site's research preloader. Never throws:
// losing a stage update must not kill the research task itself.
async function setStage(id: string, stage: string | null) {
  try {
    await patchQuestion(id, { research_stage: stage });
  } catch (error) {
    console.error(`stage update failed (${stage}):`, error);
  }
}

async function queueQuestionImage(id: string) {
  const result = await fetch(`${SUPABASE_URL}/functions/v1/generate-question-image`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ question_id: id }),
  });
  if (!result.ok && result.status !== 409) console.error(`Image queue failed: ${result.status} ${await result.text()}`);
  return result.ok;
}

function sourceType(_url: string) {
  // Every source here comes directly from chabadlibrary.org primary text.
  return "primary";
}

async function replaceSources(
  questionId: string,
  citations: { url: string; title: string; cited_text: string }[],
) {
  const clear = await fetch(`${SUPABASE_URL}/rest/v1/sources?question_id=eq.${questionId}`, { method: "DELETE", headers: adminHeaders });
  if (!clear.ok) throw new Error(`Source reset failed: ${clear.status}`);
  if (!citations.length) return;
  const rows: SourceRow[] = citations.map((citation, index) => {
    const host = new URL(citation.url).hostname.replace(/^www\./, "");
    return {
      question_id: questionId,
      ordinal: index + 1,
      title: citation.title,
      url: citation.url,
      publisher: host,
      host_publisher: host,
      original_source_title: null,
      original_source_detail: null,
      citation_label: `Source ${index + 1}`,
      supporting_excerpt: citation.cited_text.slice(0, 500),
      source_type: sourceType(citation.url),
      verified_at: new Date().toISOString(),
    };
  });
  const save = await fetch(`${SUPABASE_URL}/rest/v1/sources`, { method: "POST", headers: adminHeaders, body: JSON.stringify(rows) });
  if (!save.ok) throw new Error(`Source save failed: ${save.status} ${await save.text()}`);
}

async function researchQuestion(question: Question) {
  if (!ANTHROPIC_API_KEY) { await patchQuestion(question.id, { research_error: "Awaiting ANTHROPIC_API_KEY" }); return; }
  const attempt = (question.research_attempts || 0) + 1;
  await patchQuestion(question.id, { status: "researching", research_attempts: attempt, research_started_at: new Date().toISOString(), research_model: ANTHROPIC_MODEL, research_error: null, research_stage: "analyzing" });
  try {
    // Step 0: decide citation vs. topical BEFORE doing anything else — one small,
    // cheap classification call. A genuinely topical question (the vast majority)
    // only pays the cost of this one extra call before proceeding exactly as before.
    const citationParsed = await parseCitationQuestion(ANTHROPIC_API_KEY, ANTHROPIC_MODEL, question.question);

    let candidates: Candidate[];
    let topicGuidance: string;
    let funnelQueries: Record<string, unknown>;
    let retrievedByCollection: { toras_menachem: number; igrot_kodesh: number };

    if (citationParsed.is_citation_lookup) {
      // Citation route: direct, precise lookup first.
      await setStage(question.id, "retrieving");
      candidates = await lookupCitationChunks(SUPABASE_URL, adminHeaders, citationParsed.normalized_key, TOP_K_PER_COLLECTION);
      topicGuidance =
        `This is a direct citation lookup for ${citationParsed.book_or_tractate} ` +
        `${citationParsed.chapter_or_daf}:${citationParsed.verse_or_amud} — every candidate was retrieved because ` +
        `it cites this exact source in a footnote, not via semantic/keyword search. Classify GENUINE only if ` +
        `the passage actually engages with or explains this source (not just a passing citation with no ` +
        `substantive discussion).`;
      funnelQueries = { citation_key: citationParsed.normalized_key };

      // SEMANTIC FALLBACK (26 Jul, "Brachos daf 2" postmortem): the citation index
      // only captures explicit numeric footnotes (e.g. "ברכות ב, א"). But famous
      // passages are usually referenced by NAME — ריש ברכות, the opening mishnah
      // "מאימתי", quoting the passage's first words — which the index never sees.
      // Brachos 2a had just 2 index entries while daf 3a had 17; the corpus is NOT
      // silent about the opening of Brachos. So when the index returns fewer than
      // MIN_INDEX_HITS candidates, supplement with the normal semantic/keyword
      // retrieval. Adversarial verification still gates every candidate, so this
      // adds recall without weakening the citation standard.
      const MIN_INDEX_HITS = 8;
      if (candidates.length < MIN_INDEX_HITS) {
        const analysis = await analyzeQuestion(ANTHROPIC_API_KEY, ANTHROPIC_MODEL, question.question);
        const queryTexts = [analysis.hebrew_query, ...(analysis.alt_queries ?? [])].filter((q) => q && q.trim().length > 0);
        const byCollection = await hybridSearchPerCollection(
          SUPABASE_URL,
          adminHeaders,
          queryTexts,
          analysis.keyword_terms,
          TOP_K_PER_COLLECTION,
        );
        const seen = new Set(candidates.map((c) => `${c.collection}:${c.source_id}:${c.chunk_index}`));
        const extra = Object.values(byCollection).flat()
          .filter((c) => !seen.has(`${c.collection}:${c.source_id}:${c.chunk_index}`));
        candidates = [...candidates, ...extra];
        topicGuidance +=
          ` NOTE: the citation index had very few entries for this exact reference, so additional` +
          ` candidates were retrieved semantically. Such passages may engage this exact verse/daf by NAME` +
          ` or by quoting its words (e.g. "ריש ברכות", the opening mishnah "מאימתי") without a numeric` +
          ` citation — treat those as engaging this source. The same standard applies: GENUINE only if` +
          ` the passage substantively discusses THIS specific verse/daf.`;
        funnelQueries = {
          citation_key: citationParsed.normalized_key,
          citation_index_hits: seen.size,
          fallback_hebrew_query: analysis.hebrew_query,
          fallback_alt_queries: analysis.alt_queries ?? [],
        };
      }

      // Monster-chunk guard — cap BEFORE any prompt sees these.
      candidates = capCandidateTexts(candidates);

      retrievedByCollection = {
        toras_menachem: candidates.filter((c) => c.collection === "toras_menachem").length,
        igrot_kodesh: candidates.filter((c) => c.collection === "igrot_kodesh").length,
      };
    } else {
      // Topical route — unchanged.
      // Step 1: turn the raw question into Hebrew queries + keyword terms + scope guidance.
      const analysis = await analyzeQuestion(ANTHROPIC_API_KEY, ANTHROPIC_MODEL, question.question);
      const queryTexts = [analysis.hebrew_query, ...(analysis.alt_queries ?? [])].filter((q) => q && q.trim().length > 0);

      // Step 2: hybrid retrieval (multi-query semantic + keyword), per collection.
      await setStage(question.id, "retrieving");
      const byCollection = await hybridSearchPerCollection(
        SUPABASE_URL,
        adminHeaders,
        queryTexts,
        analysis.keyword_terms,
        TOP_K_PER_COLLECTION,
      );
      candidates = Object.values(byCollection).flat();

      // Monster-chunk guard — cap BEFORE reflection/verification/synthesis prompts
      // ("Los Angeles" postmortem: uncapped keyword hits blew the 1M-token API limit).
      candidates = capCandidateTexts(candidates);

      // Step 3: reflect on the REAL retrieved candidates and refine the topic guidance.
      await setStage(question.id, "reflecting");
      const reflection = await reflectOnCandidates(
        ANTHROPIC_API_KEY,
        ANTHROPIC_MODEL,
        question.question,
        analysis.topic_guidance,
        candidates,
      );
      topicGuidance = reflection.updated_guidance;
      funnelQueries = {
        hebrew_query: analysis.hebrew_query,
        alt_queries: analysis.alt_queries ?? [],
        keyword_terms: analysis.keyword_terms,
      };
      retrievedByCollection = {
        toras_menachem: byCollection.toras_menachem?.length ?? 0,
        igrot_kodesh: byCollection.igrot_kodesh?.length ?? 0,
      };
    }

    // Step 4: two-pass verification (classify, then adversarial vote on every GENUINE
    // verdict) — same call, same guidance shape, regardless of which route produced
    // the candidates.
    await setStage(question.id, "verifying");
    const verified = await verify(
      ANTHROPIC_API_KEY,
      ANTHROPIC_MODEL,
      question.question,
      candidates,
      topicGuidance,
      N_ADVERSARIAL_VOTERS,
    );

    const genuineCandidates = verified.verdicts
      .filter((v) => v.verdict === "GENUINE")
      .map((v) => v.candidate!)
      .filter(Boolean);

    // Step 5: write the final public answer from ONLY the verified genuine candidates.
    await setStage(question.id, "synthesizing");
    const synthesis = await synthesize(ANTHROPIC_API_KEY, ANTHROPIC_MODEL, question.question, genuineCandidates);

    // Funnel accounting — what was found vs. what survived vs. what got cited. Stored on
    // the question row so coverage problems are diagnosable instead of silent.
    const refutedVerdicts = verified.verdicts.filter((v) => v.adversarial_check?.verdict === "REFUTED");
    const refutedByVote = refutedVerdicts.length;
    const funnel = {
      route: citationParsed.is_citation_lookup ? "citation" : "topical",
      top_k_per_collection: TOP_K_PER_COLLECTION,
      queries: funnelQueries,
      retrieved: {
        toras_menachem: retrievedByCollection.toras_menachem,
        igrot_kodesh: retrievedByCollection.igrot_kodesh,
        total: candidates.length,
      },
      pass1_verdicts: {
        genuine: genuineCandidates.length + refutedByVote,
        tangential: verified.verdicts.filter((v) => v.verdict === "TANGENTIAL" && !v.adversarial_check).length,
        false_positive: verified.verdicts.filter((v) => v.verdict === "FALSE_POSITIVE").length,
        no_verdict: Math.max(0, candidates.length - verified.verdicts.length),
      },
      genuine_pass1: genuineCandidates.length + refutedByVote,
      refuted_by_adversarial_vote: refutedByVote,
      refuted_sources: refutedVerdicts.map((v) => v.source ?? "unknown"),
      genuine_final: genuineCandidates.length,
      cited: synthesis.citations.length,
    };
    console.log(`funnel ${question.id}:`, JSON.stringify(funnel));

    await replaceSources(question.id, synthesis.citations);
    await patchQuestion(question.id, {
      status: "published",
      answer_markdown: synthesis.answerMarkdown || null,
      short_answer: synthesis.answerMarkdown ? synthesis.answerMarkdown.slice(0, 280) : null,
      keywords: synthesis.topics,
      // NULL (not "none") for zero citations — the questions_confidence_check
      // constraint only allows high/medium/low/NULL ("simcha" postmortem, 26 Jul).
      confidence: synthesis.citations.length >= 2 ? "medium" : synthesis.citations.length === 1 ? "low" : null,
      source_count: synthesis.citations.length,
      completed_at: new Date().toISOString(),
      research_error: null,
      research_stage: null,
      research_funnel: funnel,
    });
    await queueQuestionImage(question.id);
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message.slice(0, 500) : "Research failed";
    await patchQuestion(question.id, { status: attempt >= 2 ? "failed" : "queued", research_stage: null, research_error: message.toLowerCase().includes("abort") ? "Research provider timeout" : message });
  }
}

Deno.serve({ port: RESEARCH_PORT, hostname: "127.0.0.1" }, async (req: Request) => {
  if (req.method !== "POST") return response({ error: "Method not allowed" }, 405);
  const body = await req.json().catch(() => null);
  const questionId = typeof body?.question_id === "string" ? body.question_id : "";
  if (!/^[0-9a-f-]{36}$/i.test(questionId)) return response({ error: "A valid question_id is required" }, 400);
  const question = await getQuestion(questionId);
  if (!question) return response({ error: "Question not found" }, 404);
  if (question.status === "published") {
    const accepted = await queueQuestionImage(question.id);
    return response({ accepted, status: accepted ? "image_queued" : "image_not_queued" }, accepted ? 409 : 409);
  }
  if (!ANTHROPIC_API_KEY) { await patchQuestion(question.id, { research_error: "Awaiting ANTHROPIC_API_KEY" }); return response({ accepted: false, status: "awaiting_api_key" }, 503); }
  if (!["queued", "failed"].includes(question.status) || question.research_attempts >= 2) return response({ accepted: false, status: question.status }, 409);
  researchQuestion(question).catch((err) => console.error("Research task crashed:", err));
  return response({ accepted: true, status: "researching" }, 202);
});

console.log(`research worker listening on http://127.0.0.1:${RESEARCH_PORT}`);
