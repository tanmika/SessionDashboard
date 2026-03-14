#!/bin/bash
# Claude Code Hook → Session Dashboard
# This script sends hook events to the local dashboard runtime.
# Add this to your Claude Code hooks configuration.

DASHBOARD_URL="${SESSION_DASHBOARD_URL:-http://localhost:3210}"

# Read JSON payload from stdin
PAYLOAD=$(cat)

# POST to dashboard
curl -s -X POST "${DASHBOARD_URL}/api/events" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  > /dev/null 2>&1 &

# Don't block Claude Code - exit immediately
exit 0
