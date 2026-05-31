#!/usr/bin/env bash
# Claude Code PreCompact hook — emergency save before context compression
#
# Always blocks. When context is about to be compressed, this hook instructs
# Claude to save ALL important context using memory_store before it's lost.
#
# Unlike the stop hook, this has no throttling — compaction always warrants a save.

set -euo pipefail

# Read event JSON from stdin
input=$(cat)

# Parse stop_hook_active to avoid infinite loop
stop_hook_active=$(echo "$input" | python3 -c "import sys,json; d=json.load(sys.stdin); print(str(d.get('stop_hook_active',False)).lower())" 2>/dev/null \
  || echo "$input" | python -c "import sys,json; d=json.load(sys.stdin); print(str(d.get('stop_hook_active',False)).lower())" 2>/dev/null \
  || echo "false")

if [ "$stop_hook_active" = "true" ]; then
  echo '{}'
  exit 0
fi

# Always block — context compression means data will be lost if not saved now
cat <<'EOF'
{"decision":"block","reason":"COMPACTION IMMINENT. Context window is about to be compressed. Use memory_store to save ALL important conversation context NOW: (1) every topic discussed, (2) all decisions and their rationale, (3) code changes made, (4) key quotes or insights, (5) unresolved questions and next steps. Use tags #context-save #precompact #hook, category 'observation', importance 'high'. This is critical — unsaved context will be lost."}
EOF
