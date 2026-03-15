#!/bin/bash
# Claude Code Hook — Session ID Injection
#
# Registered on: SessionStart
# Purpose: Output the current session_id to stdout so Claude Code
#          automatically injects it into the AI's context.
#
# The AI can then use this session_id with read-insights.ts to
# recover prior insights after context compression.

# Read JSON payload from stdin
PAYLOAD=$(cat)

# Extract session_id
if command -v jq &>/dev/null; then
  SESSION_ID=$(echo "$PAYLOAD" | jq -r '.session_id // empty')
else
  # Fallback: basic extraction without jq
  SESSION_ID=$(echo "$PAYLOAD" | grep -o '"session_id":"[^"]*"' | head -1 | cut -d'"' -f4)
fi

if [ -n "$SESSION_ID" ]; then
  echo "Your current session_id is: $SESSION_ID"
fi
