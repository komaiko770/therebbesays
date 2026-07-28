// Shared Anthropic API calling helper — Deno port of verify.py's call_claude().
// Every pipeline stage (analyzeQuestion, verify, synthesize) goes through this.
//
// SIMCHA POSTMORTEM (26 Jul, attempt 2): callClaudeText got back a response whose
// content was ONLY a `thinking` block (empty text) and no `text` block — the model
// spent its whole output budget "thinking" — and the old code threw immediately,
// failing the entire run. Both helpers now:
//   1. cap every request at 4 minutes (no more indefinite hangs),
//   2. retry transient failures (429/5xx/timeouts) with backoff,
//   3. (text only) retry no-text/thinking-only responses with a doubled token
//      budget, and join ALL text blocks instead of only taking the first.
//
// DEVARIM 6:5 POSTMORTEM (27 Jul): a truncated-but-NON-EMPTY text response slipped
// straight through — the model burned most of the 5000-token budget reasoning, the
// text block was cut off at max_tokens after 261 characters, and because `text` was
// truthy the old code returned the fragment, which got PUBLISHED mid-sentence.
// callClaudeText now treats stop_reason === "max_tokens" the same as no-text:
// retry with a doubled budget. Only if every attempt is still truncated does it
// return the longest fragment (with a loud error) rather than fail the whole run.

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const REQUEST_TIMEOUT_MS = 240_000;
const TRANSIENT_RETRY_DELAYS_MS = [5_000, 20_000];

// ── Usage + cost logging (added 28 Jul) ──────────────────────────────────────
// Every Anthropic call in the worker funnels through postAnthropic(), retries
// included, so logging here is the only place that captures true spend. The
// previous logging lived in the retired research-question edge function and
// covered the abandoned web-search pipeline, so corpus research was unmeasured.
const USAGE_SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const USAGE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

let usageQuestionId: string | null = null;

/** Set once per research run so every logged call is attributable. */
export function setUsageContext(questionId: string | null): void {
  usageQuestionId = questionId;
}

// USD per million tokens, matched by substring against the model name.
const PRICING_PER_MTOK: Array<[string, number, number]> = [
  ["opus", 15, 75],
  ["sonnet", 3, 15],
  ["haiku", 0.8, 4],
];

function priceFor(model: string): { inRate: number; outRate: number } {
  const m = (model || "").toLowerCase();
  for (const [needle, inRate, outRate] of PRICING_PER_MTOK) {
    if (m.includes(needle)) return { inRate, outRate };
  }
  return { inRate: 3, outRate: 15 };
}

/** Stage label inferred from the request: forced-tool calls carry the tool
 * name (parse_citation, analyze_question, record_verdicts…); a call with no
 * tool is the final synthesis. */
function kindFromBody(body: any): string {
  const toolName = body?.tools?.[0]?.name;
  return toolName ? String(toolName) : "synthesis";
}

async function logUsage(body: any, payload: any): Promise<void> {
  try {
    if (!USAGE_SUPABASE_URL || !USAGE_SERVICE_KEY) return;
    const u = payload?.usage || {};
    const inTok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) +
      (u.cache_read_input_tokens || 0);
    const outTok = u.output_tokens || 0;
    const model = String(body?.model || "");
    const { inRate, outRate } = priceFor(model);
    const cost = (inTok / 1_000_000) * inRate + (outTok / 1_000_000) * outRate;
    const res = await fetch(`${USAGE_SUPABASE_URL}/rest/v1/usage_events`, {
      method: "POST",
      headers: {
        apikey: USAGE_SERVICE_KEY,
        Authorization: `Bearer ${USAGE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        question_id: usageQuestionId,
        kind: kindFromBody(body),
        provider: "anthropic",
        model,
        input_tokens: inTok,
        output_tokens: outTok,
        web_search_count: 0,
        cost_usd: Number(cost.toFixed(6)),
      }),
    });
    if (!res.ok) {
      console.error(`logUsage: insert failed ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    // Never let logging break a research run, but never fail silently either.
    console.error(`logUsage: ${err}`);
  }
}


export type ToolSchema = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

/** POSTs to the Messages API with a timeout, retrying transient failures
 * (429, 5xx, network errors, timeouts). Returns the parsed payload. */
async function postAnthropic(apiKey: string, body: Record<string, unknown>): Promise<any> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= TRANSIENT_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const delay = TRANSIENT_RETRY_DELAYS_MS[attempt - 1];
      console.warn(`anthropicClient: transient failure (${lastError}); retrying in ${delay / 1000}s…`);
      await new Promise((r) => setTimeout(r, delay));
    }
    try {
      const res = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const payload = await res.json();
      if (!res.ok) {
        if (res.status === 429 || res.status >= 500) {
          lastError = new Error(`Anthropic API error ${res.status}: ${payload?.error?.message || "request failed"}`);
          continue;
        }
        throw new Error(`Anthropic API error ${res.status}: ${payload?.error?.message || "request failed"}`);
      }
      await logUsage(body, payload);
      return payload;
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError" || err.message.includes("error trying to connect") || err.message.includes("connection"))) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Anthropic API failed after ${TRANSIENT_RETRY_DELAYS_MS.length + 1} attempts: ${lastError}`);
}

/**
 * Calls Claude with a forced tool call and returns the tool's input object.
 * Mirrors verify.py's call_claude(): raises if the response was truncated at
 * max_tokens (a truncated tool call is silently malformed JSON, not a clean error,
 * so this check exists specifically to fail loudly instead of passing garbage
 * downstream).
 */
export async function callClaudeTool(
  apiKey: string,
  model: string,
  prompt: string,
  tool: ToolSchema,
  maxTokens = 16000,
): Promise<Record<string, unknown>> {
  const payload = await postAnthropic(apiKey, {
    model,
    max_tokens: maxTokens,
    tools: [tool],
    tool_choice: { type: "tool", name: tool.name },
    messages: [{ role: "user", content: prompt }],
  });

  if (payload.stop_reason === "max_tokens") {
    throw new Error(
      "Response was truncated at max_tokens before finishing (partial tool input may be malformed). " +
      "Re-run with a smaller batch, or raise max_tokens further.",
    );
  }

  const toolUse = (payload.content || []).find((b: any) => b.type === "tool_use");
  if (!toolUse) {
    throw new Error(`No tool_use block in response: ${JSON.stringify(payload)}`);
  }
  return toolUse.input;
}

/** Plain text completion, no tool — used only by synthesize.ts for the final answer.
 * Retries with a doubled budget when the model returns no text (thinking-only — the
 * simcha failure) OR truncated text (stop_reason max_tokens — the Devarim 6:5
 * failure, where a 261-char mid-sentence fragment got published). Only returns a
 * truncated fragment as a last resort, after every retry stayed truncated. */
export async function callClaudeText(
  apiKey: string,
  model: string,
  prompt: string,
  system: string | undefined,
  maxTokens = 5000,
): Promise<string> {
  let budget = maxTokens;
  let lastPayload: any = null;
  let bestTruncated = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const payload = await postAnthropic(apiKey, {
      model,
      max_tokens: budget,
      ...(system ? { system } : {}),
      messages: [{ role: "user", content: prompt }],
    });
    lastPayload = payload;

    const text = (payload.content || [])
      .filter((b: any) => b.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n")
      .trim();

    if (text && payload.stop_reason !== "max_tokens") return text;

    if (text) {
      if (text.length > bestTruncated.length) bestTruncated = text;
      console.warn(
        `callClaudeText: response truncated at max_tokens (budget=${budget}, text=${text.length} chars); ` +
        `retrying with a larger budget…`,
      );
    } else {
      console.warn(
        `callClaudeText: no text in response (stop_reason=${payload.stop_reason}, budget=${budget}); ` +
        `retrying with a larger budget…`,
      );
    }
    budget = Math.min(budget * 2, 32000);
  }
  if (bestTruncated) {
    console.error(
      `callClaudeText: still truncated after 3 attempts; returning the longest fragment (${bestTruncated.length} chars) rather than failing the run`,
    );
    return bestTruncated;
  }
  throw new Error(`No text block in response after 3 attempts: ${JSON.stringify(lastPayload)}`);
}
