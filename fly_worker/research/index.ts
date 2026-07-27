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
//  10. FOOTNOTE LOCATOR (26 Jul): citation-route candidates now carry the footnote
//      labels (corpus_citations.footnotes, via the updated lookup_citation_chunks
//      RPC) whose definitions cite the asked-about verse/daf. replaceSources writes
//      them into sources.original_source_detail ("Cited in footnote 25 of this
//      passage"), which the site already renders in the citation tooltip and the
//      Notes & sources list — no frontend change needed.
//  11. CLEAN SHORT ANSWER (26 Jul, owner share-card report): short_answer used to be
//      a raw slice of the answer markdown, so share previews and cards led with
//      "## Synthesis across the sources". It is now a plain-text excerpt with heading
//      lines, [^N] markers, and markdown syntax stripped.
//  12. ANSWER-READY EMAIL (26 Jul, owner report): questions.asked_by_email was being
//      recorded on submit, but NOTHING ever sent the notification — no edge function,
//      no worker code. On publish, the worker now emails the asker via the Resend API
//      (same verified noreply@therebbesays.com domain the auth emails use) and stamps
//      questions.answer_email_sent_at so re-runs never double-send. Best-effort:
//      requires the RESEND_API_KEY Fly secret; a send failure never fails the publish.
//  13. REJECTION AUDIT TRAIL (27 Jul, owner request): the funnel counts what was
//      rejected; `research_audit` (new jsonb column) records WHAT and WHY, per
//      candidate — pass-1 verdict + justification, adversarial vote tally, final
//      disposition. near_misses additionally carry display-ready detail (Hebrew
//      excerpt, pass-1 reasoning, the refuting reviewers' reasons) that the site's
//      Research trail tab shows publicly, so readers see what was reviewed and
//      turned away — not just how much.
//  14. SYNTHESIS SOURCE CAP (27 Jul, "talmidei chachamim" postmortem): a pg_cron
//      watchdog (`recover-stale-rebbe-research`) resets any question stuck in
//      `researching` for more than 15 minutes back to `queued` with
//      "Research worker exceeded its processing window". A broad classic topic
//      verified far more genuine sources than the synthesis budget could ever write
//      about in one call — the required Source-by-source section grows linearly with
//      source count, so an unbounded count has no token budget that both fits a
//      single Anthropic call and finishes inside that 15-minute window. Genuine
//      sources fed to synthesis are now capped at MAX_SYNTHESIS_SOURCES; anything
//      genuine beyond the cap is recorded in the audit trail as
//      `genuine_excluded_for_space` (verified real evidence, just not written up, as
//      opposed to `tangential`/`false_positive` which were never genuine at all) so
//      the honest coverage count isn't silently lost, only the write-up length is
//      bounded. This is a real editorial choice (pick the strongest N), not a
//      workaround — no reader benefits from a 40-subsection answer either.
//
// The topical pipeline (analyzeQuestion -> hybridSearchPerCollection ->
// reflectOnCandidates -> verify -> synthesize) is unchanged.

import { analyzeQuestion, reflectOnCandidates } from "./analyzeQuestion.ts";
import { hybridSearchPerCollection } from "./retrieve.ts";
import { parseCitationQuestion, lookupCitationChunks } from "./citationLookup.ts";
import { verify } from "./verify.ts";
import { synthesize, collectionLabel } from "./synthesize.ts";
import type { Candidate } from "./types.ts";

type Question = {
  id: string;
  question: string;
  status: string;
  research_attempts: number;
  slug: string | null;
  asked_by_email: string | null;
  answer_email_sent_at: string | null;
};
type SourceRow = {
  question_id: string;
  ordinal: number;
  title: string;
  url: string;
  publisher: string;
  host_publisher: string;
  original_source_title: null;
  original_source_detail: string | null;
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
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SITE_ORIGIN = Deno.env.get("SITE_ORIGIN") || "https://therebbesays.com";
const adminHeaders = { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}`, "content-type": "application/json" };

// Retrieval/verification tuning. TOP_K_PER_COLLECTION history: 15 (full_pipeline_test.py
// default) -> 30 ("France" postmortem: one embedding query fills every slot with a
// single theme) -> 60 ("Morocco" postmortem: 55 literal-mention Igrot Kodesh chunks
// existed but only 30 could ever be considered; the cap itself was the coverage floor).
const TOP_K_PER_COLLECTION = 60;
const N_ADVERSARIAL_VOTERS = 3;

// Hard cap on how many verified-GENUINE sources synthesis is asked to write about in a
// single call ("talmidei chachamim" postmortem, 27 Jul, change 14). Paired with
// synthesize.ts's 24000-token ceiling (4000 + 20*800 = 20000, comfortably under that),
// so a maximally broad topic converges in ONE synthesis call instead of retrying its way
// through the 15-minute processing-window watchdog. Sources beyond the cap are still
// real, verified evidence — they're recorded in the audit trail as
// genuine_excluded_for_space, not discarded from the record, just not written up.
const MAX_SYNTHESIS_SOURCES = 20;

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

// Hebrew excerpt length for near-miss display on the site (rejection audit, 27 Jul).
const AUDIT_EXCERPT_CHARS = 400;

// Plain-text excerpt for cards and share previews: heading lines, [^N] citation
// markers, and markdown syntax stripped, whitespace collapsed (change 11).
function plainExcerpt(markdown: string, maxChars = 280): string | null {
  const text = String(markdown || "")
    .replace(/(^|\n)#{1,6}[^\n]*/g, " ")
    .replace(/\[\^\d+\]/g, " ")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/[>_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, maxChars) : null;
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

async function getQuestion(id: string): Promise<Question | null> {
  const params = new URLSearchParams({ select: "id,question,status,research_attempts,slug,asked_by_email,answer_email_sent_at", id: `eq.${id}`, limit: "1" });
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

const escapeHtml = (value = "") => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

// Answer-ready notification (change 12). Best-effort: logs and returns false on any
// failure; NEVER throws — the publish must survive a broken email path.
async function sendAnswerReadyEmail(question: Question): Promise<boolean> {
  if (!RESEND_API_KEY) { console.error("answer email skipped: RESEND_API_KEY not set"); return false; }
  const to = (question.asked_by_email || "").trim();
  if (!to || !question.slug) return false;
  const answerUrl = `${SITE_ORIGIN}/answer/${encodeURIComponent(question.slug)}`;
  const q = escapeHtml(question.question.trim());
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: "The Rebbe Says <noreply@therebbesays.com>",
        to: [to],
        subject: `Your answer is ready — ${question.question.trim()}`,
        html:
          `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:24px;color:#1a1a1a;">` +
          `<p style="font-size:15px;">The research you requested has finished compiling:</p>` +
          `<p style="font-size:19px;font-weight:bold;margin:16px 0;">“${q}”</p>` +
          `<p><a href="${answerUrl}" style="display:inline-block;background:#1a1a1a;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:6px;font-size:15px;">Read the answer</a></p>` +
          `<p style="font-size:13px;color:#666;">Or open this link: <a href="${answerUrl}">${answerUrl}</a></p>` +
          `<p style="font-size:12px;color:#999;margin-top:28px;">Every answer is compiled only from the Rebbe’s own published talks and letters (Toras Menachem and Igros Kodesh), with each claim tied to its source.</p>` +
          `</div>`,
      }),
    });
    if (!res.ok) { console.error(`answer email failed: ${res.status} ${await res.text()}`); return false; }
    return true;
  } catch (error) {
    console.error("answer email failed:", error);
    return false;
  }
}

function sourceType(_url: string) {
  // Every source here comes directly from chabadlibrary.org primary text.
  return "primary";
}

// Human-readable footnote locator (26 Jul): where in this passage the asked-about
// verse/daf is cited. Rendered by the site wherever original_source_detail shows.
function footnoteDetail(footnotes?: string[]): string | null {
  const notes = (footnotes ?? []).map((n) => String(n).trim()).filter(Boolean);
  if (!notes.length) return null;
  return notes.length === 1
    ? `Cited in footnote ${notes[0]} of this passage`
    : `Cited in footnotes ${notes.join(", ")} of this passage`;
}

async function replaceSources(
  questionId: string,
  citations: { url: string; title: string; cited_text: string; footnotes?: string[] }[],
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
      original_source_detail: footnoteDetail(citation.footnotes),
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

    // All verdicts that survived pass 1 + the adversarial vote — genuinely verified,
    // real evidence. This can be an unbounded count for a broad topic.
    const survivingGenuineVerdicts = verified.verdicts.filter((v) => v.verdict === "GENUINE");

    // Cap what synthesis is actually asked to write about (change 14, "talmidei
    // chachamim" postmortem) — an unbounded source count has no token budget that both
    // fits one Anthropic call and finishes inside the 15-minute processing window.
    // Sources beyond the cap are still genuinely verified; they're recorded in the
    // audit trail as genuine_excluded_for_space rather than silently dropped.
    const includedGenuineVerdicts = survivingGenuineVerdicts.slice(0, MAX_SYNTHESIS_SOURCES);
    const includedIndices = new Set(includedGenuineVerdicts.map((v) => v.index));
    const genuineCandidates = includedGenuineVerdicts.map((v) => v.candidate!).filter(Boolean);

    // Step 5: write the final public answer from ONLY the verified genuine candidates
    // that made the space cap.
    await setStage(question.id, "synthesizing");
    const synthesis = await synthesize(ANTHROPIC_API_KEY, ANTHROPIC_MODEL, question.question, genuineCandidates);

    // Funnel accounting — what was found vs. what survived vs. what got cited. Stored on
    // the question row so coverage problems are diagnosable instead of silent.
    const refutedVerdicts = verified.verdicts.filter((v) => v.adversarial_check?.verdict === "REFUTED");
    const refutedByVote = refutedVerdicts.length;
    const genuineExcludedForSpace = survivingGenuineVerdicts.length - includedGenuineVerdicts.length;
    const funnel = {
      route: citationParsed.is_citation_lookup ? "citation" : "topical",
      top_k_per_collection: TOP_K_PER_COLLECTION,
      max_synthesis_sources: MAX_SYNTHESIS_SOURCES,
      queries: funnelQueries,
      retrieved: {
        toras_menachem: retrievedByCollection.toras_menachem,
        igrot_kodesh: retrievedByCollection.igrot_kodesh,
        total: candidates.length,
      },
      pass1_verdicts: {
        genuine: survivingGenuineVerdicts.length + refutedByVote,
        tangential: verified.verdicts.filter((v) => v.verdict === "TANGENTIAL" && !v.adversarial_check).length,
        false_positive: verified.verdicts.filter((v) => v.verdict === "FALSE_POSITIVE").length,
        no_verdict: Math.max(0, candidates.length - verified.verdicts.length),
      },
      genuine_pass1: survivingGenuineVerdicts.length + refutedByVote,
      refuted_by_adversarial_vote: refutedByVote,
      refuted_sources: refutedVerdicts.map((v) => v.source ?? "unknown"),
      // Total genuine sources that survived verification, before the space cap.
      genuine_verified_total: survivingGenuineVerdicts.length,
      // Genuine sources actually fed to synthesis (after the space cap) — matches
      // source_count / citations on the published answer.
      genuine_final: genuineCandidates.length,
      genuine_excluded_for_space: genuineExcludedForSpace,
      cited: synthesis.citations.length,
    };
    console.log(`funnel ${question.id}:`, JSON.stringify(funnel));

    // REJECTION AUDIT TRAIL (change 13): per-candidate record of every verdict and
    // vote, plus display-ready near-miss detail for the site's Research trail tab.
    // (change 14): a GENUINE verdict that was cut for space, not rejected, gets its
    // own "genuine_excluded_for_space" disposition — distinct from tangential/
    // false_positive (never genuine) and from near_miss (genuine but adversarially
    // refuted) — so the audit stays honest about what was actually wrong with each
    // passage vs. what simply didn't fit in this answer.
    const verdictByIndex = new Map(verified.verdicts.map((v) => [v.index, v]));
    const auditEntries = candidates.map((c, i) => {
      const v = verdictByIndex.get(i);
      const refuted = v?.adversarial_check?.verdict === "REFUTED";
      const final = !v
        ? "no_verdict"
        : refuted
        ? "near_miss"
        : v.verdict === "GENUINE"
        ? (includedIndices.has(i) ? "cited" : "genuine_excluded_for_space")
        : v.verdict === "TANGENTIAL"
        ? "tangential"
        : "false_positive";
      return {
        index: i,
        title: `${collectionLabel(c.collection)}, ${c.volume_heading} / ${c.item_heading}`,
        collection: c.collection,
        chunk_index: c.chunk_index,
        url: `https://chabadlibrary.org/books/${c.source_id}`,
        final,
        pass1_verdict: v ? (refuted ? "GENUINE" : v.verdict) : null,
        justification: v?.justification ?? null,
        adversarial_vote: v?.adversarial_check
          ? { verdict: v.adversarial_check.verdict, survives: v.adversarial_check.survives_count, refuted: v.adversarial_check.refuted_count }
          : null,
      };
    });
    const nearMisses = auditEntries
      .filter((entry) => entry.final === "near_miss")
      .map((entry) => {
        const v = verdictByIndex.get(entry.index)!;
        const c = candidates[entry.index];
        return {
          title: entry.title,
          url: entry.url,
          excerpt: c.text.slice(0, AUDIT_EXCERPT_CHARS),
          looked_genuine_because: v.pass1_justification ?? null,
          rejected_because: (v.adversarial_check?.votes ?? [])
            .filter((vote) => vote.verdict === "REFUTED")
            .map((vote) => vote.justification)
            .filter(Boolean),
          vote: `${v.adversarial_check?.refuted_count ?? 0} of ${N_ADVERSARIAL_VOTERS} independent reviewers rejected it`,
        };
      });
    const researchAudit = {
      version: 1,
      generated_at: new Date().toISOString(),
      summary: {
        retrieved: candidates.length,
        cited: synthesis.citations.length,
        genuine: genuineCandidates.length,
        genuine_excluded_for_space: genuineExcludedForSpace,
        near_misses: nearMisses.length,
        tangential: funnel.pass1_verdicts.tangential,
        false_positive: funnel.pass1_verdicts.false_positive,
        no_verdict: funnel.pass1_verdicts.no_verdict,
      },
      near_misses: nearMisses,
      entries: auditEntries,
    };

    await replaceSources(question.id, synthesis.citations);
    await patchQuestion(question.id, {
      status: "published",
      answer_markdown: synthesis.answerMarkdown || null,
      // Plain-text excerpt, not a raw markdown slice — share cards and feed cards
      // read this directly (change 11).
      short_answer: plainExcerpt(synthesis.answerMarkdown),
      keywords: synthesis.topics,
      // NULL (not "none") for zero citations — the questions_confidence_check
      // constraint only allows high/medium/low/NULL ("simcha" postmortem, 26 Jul).
      confidence: synthesis.citations.length >= 2 ? "medium" : synthesis.citations.length === 1 ? "low" : null,
      source_count: synthesis.citations.length,
      completed_at: new Date().toISOString(),
      research_error: null,
      research_stage: null,
      research_funnel: funnel,
      research_audit: researchAudit,
    });
    await queueQuestionImage(question.id);

    // Answer-ready email (change 12) — after the publish is safely saved, only if the
    // asker left an email and this question has never been emailed about before.
    if (question.asked_by_email && !question.answer_email_sent_at) {
      const fresh = await getQuestion(question.id);
      if (fresh && (await sendAnswerReadyEmail(fresh))) {
        await setStage(question.id, null); // no-op keep-alive ordering guard
        try {
          await patchQuestion(question.id, { answer_email_sent_at: new Date().toISOString() });
        } catch (error) {
          console.error("answer_email_sent_at stamp failed:", error);
        }
      }
    }
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
    return response({ accepted, status: accepted ? "image_queued" : "image_not_queued" }, accepted ? 202 : 409);
  }
  if (!ANTHROPIC_API_KEY) { await patchQuestion(question.id, { research_error: "Awaiting ANTHROPIC_API_KEY" }); return response({ accepted: false, status: "awaiting_api_key" }, 503); }
  if (!["queued", "failed"].includes(question.status) || question.research_attempts >= 2) return response({ accepted: false, status: question.status }, 409);
  researchQuestion(question).catch((err) => console.error("Research task crashed:", err));
  return response({ accepted: true, status: "researching" }, 202);
});

console.log(`research worker listening on http://127.0.0.1:${RESEARCH_PORT}`);
