#!/usr/bin/env bash
#
# Spin up a self-contained cortexmd demo server with fixed, known credentials,
# then seed it with realistic data. This is the "shared memory" deployment mode:
# the HTTP server is the single source of truth that every AI tool connects to.
#
#   ./demo/run.sh          # build (if needed), start, and seed
#   ./demo/run.sh --no-seed # just start the server
#
# Dashboard:  http://localhost:7777/dashboard   (password: demo)
# MCP:        http://localhost:7777/mcp          (Authorization: Bearer demo-key)
#
# All runtime state lives under demo/.runtime/ (gitignored) — delete it for a
# clean slate. Stop the server with Ctrl-C.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="$REPO_ROOT/packages/server"
RUNTIME="$REPO_ROOT/demo/.runtime"

# ── Fixed demo credentials (NEVER use these outside a local demo) ─────────────
export API_PORT="${API_PORT:-7777}"
export API_KEY="${API_KEY:-demo-key}"
export DASHBOARD_PASSWORD="${DASHBOARD_PASSWORD:-demo}"
export BRAIN_VAULT="$RUNTIME/brain"
export DATA_DIR="$RUNTIME/data"
export SOURCE_VAULTS="helios=$REPO_ROOT/demo/sources"
# Lexical-only by default so the demo boots instantly with no model download.
# Set ENABLE_EMBEDDINGS=true to also exercise semantic search.
export ENABLE_EMBEDDINGS="${ENABLE_EMBEDDINGS:-false}"
export LOG_LEVEL="${LOG_LEVEL:-info}"

mkdir -p "$BRAIN_VAULT" "$DATA_DIR"

# Seed static brain-vault definitions (agents / teams / skills) so the Agents
# tab is populated. These are indexed on startup; everything else is written
# live by demo/seed.mjs over MCP.
cp -r "$REPO_ROOT/demo/brain-seed/." "$BRAIN_VAULT/"

# ── Build the server if needed ────────────────────────────────────────────────
if [ ! -f "$SERVER/dist/index.js" ]; then
  echo "Building server…"
  ( cd "$SERVER" && npm ci && npm run build )
fi

# ── Start the server ──────────────────────────────────────────────────────────
echo "Starting cortexmd on http://localhost:$API_PORT (dashboard password: $DASHBOARD_PASSWORD)…"
node "$SERVER/dist/index.js" &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

# Wait for /health to come up.
for i in $(seq 1 60); do
  if curl -fsS "http://localhost:$API_PORT/health" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
echo "Server is up."

# ── Seed (unless --no-seed) ────────────────────────────────────────────────────
if [ "${1:-}" != "--no-seed" ]; then
  MCP_URL="http://localhost:$API_PORT/mcp" API_KEY="$API_KEY" REPO_PATH="$REPO_ROOT" \
    node "$REPO_ROOT/demo/seed.mjs"
fi

echo ""
echo "  Dashboard → http://localhost:$API_PORT/dashboard   (password: $DASHBOARD_PASSWORD)"
echo "  MCP       → http://localhost:$API_PORT/mcp          (Bearer $API_KEY)"
echo ""
echo "Press Ctrl-C to stop."
wait $SERVER_PID
