// Computes a query embedding by calling the standalone embedding_service (see
// ../embedding_service/) over HTTP, rather than loading the model in-process.
//
// This replaced an earlier in-Edge-Function approach (loading intfloat/multilingual-e5-base
// directly via transformers.js/ONNX inside the Deno runtime) after that failed in
// practice, confirmed empirically during deployment:
//   - Supabase Edge Function (Deno): the deploy bundler could not build
//     npm:@huggingface/transformers at all (native/wasm dependency tree) — only a CDN
//     import bundled, and that build loaded but hit WORKER_RESOURCE_LIMIT (the model
//     exceeds the Edge Function's memory/compute cap).
//   - Netlify Function (Node), considered as an alternative runtime: onnxruntime-node's
//     native binary is too large for the function package limit. The remaining
//     onnxruntime-web (WASM) variant was not pursued — it solves the bundling problem
//     but not the underlying model-size problem, so it risked hitting the same resource
//     ceiling a third time, in a third runtime, for the same reason.
//
// The embedding_service runs the literal same sentence-transformers/PyTorch model and
// code that embedded the corpus (see embed_chunks.py in the original project) — not an
// ONNX/WASM-converted approximation — so there is no parity question to verify, unlike
// a third-party hosted-inference-API alternative would require.
//
// Required environment variables on the Supabase Edge Function:
//   EMBEDDING_SERVICE_URL      — e.g. https://your-service.fly.dev
//   EMBEDDING_SERVICE_API_KEY  — the shared secret set on the embedding_service host

const EMBEDDING_SERVICE_URL = Deno.env.get("EMBEDDING_SERVICE_URL")!;
const EMBEDDING_SERVICE_API_KEY = Deno.env.get("EMBEDDING_SERVICE_API_KEY")!;

/**
 * Embeds a query string. The "query: " prefix e5 models require (vs. "passage: " for
 * indexed text, already applied when the corpus was embedded) is applied server-side by
 * embedding_service/app.py — callers here just send plain text.
 */
export async function embedQuery(queryText: string): Promise<number[]> {
  const res = await fetch(`${EMBEDDING_SERVICE_URL}/embed`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": EMBEDDING_SERVICE_API_KEY,
    },
    body: JSON.stringify({ text: queryText }),
  });
  if (!res.ok) {
    throw new Error(`embedding_service /embed failed: ${res.status} ${await res.text()}`);
  }
  const payload = await res.json();
  if (!Array.isArray(payload.embedding) || payload.embedding.length !== 768) {
    throw new Error(
      `embedding_service returned an unexpected shape (expected a 768-length array): ${JSON.stringify(payload).slice(0, 200)}`,
    );
  }
  return payload.embedding as number[];
}

/** Formats an embedding vector as pgvector's bracketed-text input format for RPC calls.
 * Normalization is not required here — pgvector's `<=>` cosine-distance operator is
 * scale-invariant on both inputs, so an unnormalized vector produces identical
 * similarity rankings to a normalized one. */
export function embeddingToVectorLiteral(vec: number[]): string {
  return "[" + vec.map((v) => v.toFixed(6)).join(",") + "]";
}
