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
//
// The pipeline (analyzeQuestion -> hybridSearchPerCollection -> reflectOnCandidates ->
// verify -> synthesize) is unchanged.

import { analyzeQuestion, reflectOnCandidates } from "./analyzeQuestion.ts";
import { hybridSearchPerCollection } from "./retrieve.ts";
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

// Retrieval/verification tuning — same defaults as full_pipeline_test.py, the harness
// this pipeline was validated with across the 5 benchmarked test topics.
const TOP_K_PER_COLLECTION = 15;
const N_ADVERSARIAL_VOTERS = 3;

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
    // Step 1: turn the raw question into a Hebrew query + keyword terms + scope guidance.
    const analysis = await analyzeQuestion(ANTHROPIC_API_KEY, ANTHROPIC_MODEL, question.question);

    // Step 2: hybrid retrieval (semantic + keyword), pulled separately per collection.
    await setStage(question.id, "retrieving");
    const byCollection = await hybridSearchPerCollection(
      SUPABASE_URL,
      adminHeaders,
      analysis.hebrew_query,
      analysis.keyword_terms,
      TOP_K_PER_COLLECTION,
    );
    const candidates: Candidate[] = Object.values(byCollection).flat();

    // Step 3: reflect on the REAL retrieved candidates and refine the topic guidance.
    await setStage(question.id, "reflecting");
    const reflection = await reflectOnCandidates(
      ANTHROPIC_API_KEY,
      ANTHROPIC_MODEL,
      question.question,
      analysis.topic_guidance,
      candidates,
    );

    // Step 4: two-pass verification (classify, then adversarial vote on every GENUINE verdict).
    await setStage(question.id, "verifying");
    const verified = await verify(
      ANTHROPIC_API_KEY,
      ANTHROPIC_MODEL,
      question.question,
      candidates,
      reflection.updated_guidance,
      N_ADVERSARIAL_VOTERS,
    );

    const genuineCandidates = verified.verdicts
      .filter((v) => v.verdict === "GENUINE")
      .map((v) => v.candidate!)
      .filter(Boolean);

    // Step 5: write the final public answer from ONLY the verified genuine candidates.
    await setStage(question.id, "synthesizing");
    const synthesis = await synthesize(ANTHROPIC_API_KEY, ANTHROPIC_MODEL, question.question, genuineCandidates);

    await replaceSources(question.id, synthesis.citations);
    await patchQuestion(question.id, {
      status: "published",
      answer_markdown: synthesis.answerMarkdown || null,
      short_answer: synthesis.answerMarkdown ? synthesis.answerMarkdown.slice(0, 280) : null,
      keywords: synthesis.topics,
      confidence: synthesis.citations.length >= 2 ? "medium" : synthesis.citations.length === 1 ? "low" : "none",
      source_count: synthesis.citations.length,
      completed_at: new Date().toISOString(),
      research_error: null,
      research_stage: null,
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
    return response({ accepted, status: accepted ? "image_queued" : "image_not_queued" }, accepted ? 202 : 409);
  }
  if (!ANTHROPIC_API_KEY) { await patchQuestion(question.id, { research_error: "Awaiting ANTHROPIC_API_KEY" }); return response({ accepted: false, status: "awaiting_api_key" }, 503); }
  if (!["queued", "failed"].includes(question.status) || question.research_attempts >= 2) return response({ accepted: false, status: question.status }, 409);
  researchQuestion(question).catch((err) => console.error("Research task crashed:", err));
  return response({ accepted: true, status: "researching" }, 202);
});

console.log(`research worker listening on http://127.0.0.1:${RESEARCH_PORT}`);
