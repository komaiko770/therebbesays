"""
Standalone query-embedding service, now also fronting the co-located research worker.

Embedding: loads intfloat/multilingual-e5-base in-process (it failed in every serverless
runtime tried — Supabase Edge/Deno hit WORKER_RESOURCE_LIMIT, Netlify/Node hit the
function package size limit — so it lives here on a always-on Fly machine instead). This
runs the literal same sentence-transformers/PyTorch model and code that embedded the
corpus, so there's no ONNX/WASM parity question to verify.

Research: the /research route is a thin proxy to the Deno research worker running on
127.0.0.1:8081 in this same container (see research/index.ts + start.sh). The worker
returns 202 immediately and runs the multi-minute pipeline in the background — which is
exactly why research moved off the Supabase Edge Function, whose execution window killed
the background task before it finished.

Endpoints:
  POST /embed    {"text": "..."}        -> {"embedding": [768 floats]}   (X-API-Key)
  POST /research {"question_id": "..."} -> {"accepted": true, ...} (202)  (X-API-Key)
  GET  /health                          -> {"status": "ok", ...}
The "query: " prefix (part of e5's training convention, not optional formatting) is
applied server-side in /embed, so callers just send plain text.
"""
import os

import httpx
from fastapi import FastAPI, Header, HTTPException, Request, Response
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

MODEL_NAME = "intfloat/multilingual-e5-base"
API_KEY = os.environ.get("EMBEDDING_SERVICE_API_KEY")  # shared secret; required in production
RESEARCH_WORKER_URL = os.environ.get("RESEARCH_WORKER_URL", "http://127.0.0.1:8081")

app = FastAPI()
model = SentenceTransformer(MODEL_NAME)


class EmbedRequest(BaseModel):
    text: str


class EmbedResponse(BaseModel):
    embedding: list[float]


def check_auth(x_api_key: str | None):
    if API_KEY and x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing X-API-Key")


@app.post("/embed", response_model=EmbedResponse)
def embed(req: EmbedRequest, x_api_key: str | None = Header(default=None)):
    check_auth(x_api_key)
    if not req.text or not req.text.strip():
        raise HTTPException(status_code=400, detail="text must be non-empty")
    vec = model.encode(["query: " + req.text], show_progress_bar=False)[0]
    return {"embedding": vec.tolist()}


@app.post("/research")
async def research(req: Request, x_api_key: str | None = Header(default=None)):
    # Thin proxy to the co-located Deno research worker. The worker returns 202 fast and
    # runs the pipeline in the background, so this call does not hold the request open.
    check_auth(x_api_key)
    body = await req.body()
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(
                f"{RESEARCH_WORKER_URL}/research",
                content=body,
                headers={"content-type": "application/json"},
            )
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail=f"research worker unreachable: {e}")
    return Response(content=r.content, status_code=r.status_code, media_type="application/json")


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_NAME, "dim": model.get_sentence_embedding_dimension()}
