#!/usr/bin/env bash
# Runs both processes in one container (single Fly machine):
#   - Deno research worker on 127.0.0.1:8081 (not publicly exposed)
#   - Python FastAPI (embedding + /research proxy) on 0.0.0.0:$PORT (public)
# If either process exits, we bring the whole machine down so Fly restarts it clean —
# a half-alive container (embedding up but research dead, or vice versa) is worse than
# a fast restart.
set -euo pipefail

deno run --allow-net --allow-env /app/research/index.ts &
DENO_PID=$!

uvicorn app:app --host 0.0.0.0 --port "${PORT:-8080}" &
UVICORN_PID=$!

# Wait for whichever process exits first.
wait -n
echo "A service process exited; shutting the machine down for a clean restart."
kill "$DENO_PID" "$UVICORN_PID" 2>/dev/null || true
exit 1
