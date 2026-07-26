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

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const REQUEST_TIMEOUT_MS = 240_000;
const TRANSIENT_RETRY_DELAYS_MS = [5_000, 20_000];

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
 * If the model returns no text (e.g. it burned the whole budget on a `thinking`
 * block, which is exactly how the simcha run died), retry with a doubled budget
 * instead of failing the run. */
export async function callClaudeText(
  apiKey: string,
  model: string,
  prompt: string,
  system: string | undefined,
  maxTokens = 5000,
): Promise<string> {
  let budget = maxTokens;
  let lastPayload: any = null;
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
    if (text) return text;

    console.warn(
      `callClaudeText: no text in response (stop_reason=${payload.stop_reason}, budget=${budget}); ` +
      `retrying with a larger budget…`,
    );
    budget = Math.min(budget * 2, 32000);
  }
  throw new Error(`No text block in response after 3 attempts: ${JSON.stringify(lastPayload)}`);
}
