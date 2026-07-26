# Small, CPU-only inference service — no GPU needed for a single 768-dim embedding per
# request. Pins the CPU-only torch wheel (see requirements.txt) specifically to avoid
# pulling in unnecessary CUDA dependencies, which would otherwise bloat the image by
# several GB for no benefit on Fly.io/Render/Cloud Run's CPU-only tiers.
FROM python:3.11-slim

WORKDIR /app

# Deno runtime for the co-located research worker (research/). A single static binary
# copied from the official image — no apt/network install step needed. Pinned to a Deno
# version close to the Supabase Edge runtime the pipeline was validated on.
COPY --from=denoland/deno:bin-1.46.3 /deno /usr/local/bin/deno

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY start.sh .
COPY research/ ./research/
RUN chmod +x start.sh

# Download the model at build time (not first request) so cold starts don't pay a
# network + download cost on top of the model already being large.
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('intfloat/multilingual-e5-base')"

ENV PORT=8080
EXPOSE 8080
CMD ["./start.sh"]
