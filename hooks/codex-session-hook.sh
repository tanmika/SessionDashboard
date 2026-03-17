#!/bin/bash
# Codex CLI Hook → Session Dashboard
#
# Registered on: SessionStart, Stop
# Purpose:
# 1. On SessionStart, inject the current session_id into Codex context.
# 2. Forward Codex hook events to the local dashboard runtime.

DASHBOARD_URL="${SESSION_DASHBOARD_URL:-http://localhost:3210}"

PAYLOAD=$(cat)

if command -v jq >/dev/null 2>&1; then
  COMPACT=$(echo "$PAYLOAD" | jq -c '{
    session_id,
    hook_event_name,
    transcript_path,
    cwd,
    timestamp,
    model,
    permission_mode,
    stop_hook_active,
    last_assistant_message,
    codex_hook_source: .source,
    dashboard_source: "codex"
  } | with_entries(select(.value != null and .value != ""))' 2>/dev/null)
  [ $? -eq 0 ] && [ -n "$COMPACT" ] && PAYLOAD="$COMPACT"
elif printf '%s' "$PAYLOAD" | grep -q '"dashboard_source"'; then
  :
else
  PAYLOAD=$(printf '%s' "$PAYLOAD" | sed 's/}[[:space:]]*$/,\"dashboard_source\":\"codex\"}/')
fi

curl -s -X POST "${DASHBOARD_URL}/api/events" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  > /dev/null 2>&1 &

if command -v jq >/dev/null 2>&1; then
  HOOK_EVENT_NAME=$(echo "$PAYLOAD" | jq -r '.hook_event_name // empty')
  SESSION_ID=$(echo "$PAYLOAD" | jq -r '.session_id // empty')
else
  HOOK_EVENT_NAME=$(echo "$PAYLOAD" | grep -o '"hook_event_name":"[^"]*"' | head -1 | cut -d'"' -f4)
  SESSION_ID=$(echo "$PAYLOAD" | grep -o '"session_id":"[^"]*"' | head -1 | cut -d'"' -f4)
fi

if [ "$HOOK_EVENT_NAME" = "SessionStart" ] && [ -n "$SESSION_ID" ]; then
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Your current session_id is: %s"}}\n' "$SESSION_ID"
fi

exit 0
