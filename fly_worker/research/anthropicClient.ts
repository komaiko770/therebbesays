// Shared Anthropic API calling helper — Deno port of verify.py's call_claude().
// Every pipeline stage (analyzeQuestion, verify, synthesize) goes through this.

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

export type ToolSchema = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

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
  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      tools: [tool],
      tool_choice: { type: "tool", name: tool.name },
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const payload = await res.json();
  if (!res.ok) {
    throw new Error(`Anthropic API error ${res.status}: ${payload?.error?.message || "request failed"}`);
  }
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

/** Plain text completion, no tool — used only by synthesize.ts for the final answer. */
export async function callClaudeText(
  apiKey: string,
  model: string,
  prompt: string,
  system: string | undefined,
  maxTokens = 5000,
): Promise<string> {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const payload = await res.json();
  if (!res.ok) {
    throw new Error(`Anthropic API error ${res.status}: ${payload?.error?.message || "request failed"}`);
  }
  const textBlock = (payload.content || []).find((b: any) => b.type === "text");
  if (!textBlock) {
    throw new Error(`No text block in response: ${JSON.stringify(payload)}`);
  }
  return textBlock.text;
}
