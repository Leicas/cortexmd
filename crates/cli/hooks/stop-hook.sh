#!/usr/bin/env bash
# Claude Code Stop hook — periodic conversation save
#
# When Claude tries to stop, this hook counts human messages in the transcript.
# Every Nth turn (default: 15), it BLOCKS the stop and instructs Claude to
# save key context using the memory_store MCP tool before proceeding.
#
# This follows the mempalace pattern: the AI decides what's important to save,
# not the hook. The hook only controls *when* to save.
#
# Environment:
#   SAVE_HOOK_EVERY — Save interval in human turns (default: 15)

set -eo pipefail

SAVE_INTERVAL="${SAVE_HOOK_EVERY:-15}"
STATE_DIR="${HOME}/.cortexmd/hook_state"
mkdir -p "$STATE_DIR" 2>/dev/null || true

# Read event JSON from stdin
input=$(cat)

# Parse JSON fields — try python3, python, then jq
_parse() {
  local field="$1" default="$2"
  result=$(echo "$input" | python3 -c "import sys,json; d=json.load(sys.stdin); v=d.get('$field','$default'); print(str(v).lower() if isinstance(v,bool) else v)" 2>/dev/null) \
    || result=$(echo "$input" | python -c "import sys,json; d=json.load(sys.stdin); v=d.get('$field','$default'); print(str(v).lower() if isinstance(v,bool) else v)" 2>/dev/null) \
    || result="$default"
  # Strip carriage returns and whitespace
  printf '%s' "$result" | tr -d '\r\n'
}

session_id=$(_parse "session_id" "")
stop_hook_active=$(_parse "stop_hook_active" "false")
transcript_path=$(_parse "transcript_path" "")

# If already in a save cycle, pass through to avoid infinite loop
if [ "$stop_hook_active" = "true" ]; then
  echo '{}'
  exit 0
fi

# Sanitize session ID for safe file paths
safe_session=$(echo "$session_id" | tr -cd 'a-zA-Z0-9_-')
if [ -z "$safe_session" ]; then
  safe_session="default"
fi

last_count_file="${STATE_DIR}/${safe_session}.last_count"

# Count human messages in transcript — strip to digits only
human_count=0
if [ -n "$transcript_path" ] && [ -f "$transcript_path" ]; then
  raw=$(grep -c '"role"' "$transcript_path" 2>/dev/null || true)
  human_count=$(printf '%s' "$raw" | tr -cd '0-9')
  human_count=${human_count:-0}
fi

# If we can't read the transcript, pass through
if [ "$human_count" -eq 0 ] 2>/dev/null; then
  echo '{}'
  exit 0
fi

# Get last save count — strip to digits only
last_count=0
if [ -f "$last_count_file" ]; then
  raw=$(cat "$last_count_file" 2>/dev/null || true)
  last_count=$(printf '%s' "$raw" | tr -cd '0-9')
  last_count=${last_count:-0}
fi

# Check if enough new messages have accumulated since last save
messages_since_save=$((human_count - last_count))

if [ "$messages_since_save" -lt "$SAVE_INTERVAL" ]; then
  echo '{}'
  exit 0
fi

# Record this save point
echo "$human_count" > "$last_count_file"

# Block and instruct the AI to save conversation context
cat <<'EOF'
{"decision":"block","reason":"AUTO-SAVE checkpoint (periodic). Before stopping, use memory_store to save the KEY topics from this conversation: (1) important facts learned, (2) decisions made and rationale, (3) significant code changes or architecture choices, (4) unresolved questions or next steps. Use tags #auto-save #hook and category 'observation'. After saving, you may stop."}
EOF
