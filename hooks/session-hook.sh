#!/bin/bash
# Claude Code Hook → Session Dashboard
# This script sends hook events to the local dashboard runtime.
# Add this to your Claude Code hooks configuration.

DASHBOARD_URL="${SESSION_DASHBOARD_URL:-http://localhost:3210}"

# Read JSON payload from stdin
PAYLOAD=$(cat)

# Strip large fields (tool_input, tool_response, etc.) — only keep fields we use.
# This prevents PayloadTooLargeError when PostToolUse carries full tool output.
if command -v jq &>/dev/null; then
  COMPACT=$(echo "$PAYLOAD" | jq -c '{
    session_id,
    hook_event_name,
    transcript_path,
    cwd,
    tool_name,
    subagent_id,
    notification_type,
    timestamp
  } | with_entries(select(.value != null and .value != ""))' 2>/dev/null)
  [ $? -eq 0 ] && [ -n "$COMPACT" ] && PAYLOAD="$COMPACT"
fi

# POST to dashboard
curl -s -X POST "${DASHBOARD_URL}/api/events" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  > /dev/null 2>&1 &

# Don't block Claude Code - exit immediately
exit 0
