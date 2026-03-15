/**
 * Session Dashboard — Codex Insight Injection Setup
 * Usage: npm run setup:codex  (or called by CLI `session-dashboard init`)
 *
 * Injects ★ Insight output-style instructions into ~/.codex/AGENTS.md
 * so Codex CLI produces structured insight blocks that the dashboard can parse.
 *
 * Safe to run multiple times (idempotent) — uses marker tags for dedup.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'

const AGENTS_PATH = path.join(os.homedir(), '.codex', 'AGENTS.md')
const CODEX_DIR = path.join(os.homedir(), '.codex')

const MARKER_START = '<---session-dashboard-insight--->'
const MARKER_END = '<---/session-dashboard-insight--->'

const INJECTION_BLOCK = `${MARKER_START}
## Insight Output Style

You are being monitored by a session dashboard that extracts structured insight blocks
from your responses. To provide high-quality, parseable insights, follow these rules.

### When to produce an Insight block

- **Before** starting a non-trivial implementation: summarize the approach, key design
  decisions, and any trade-offs you considered.
- **After** completing a code change: highlight what changed, why it matters, and any
  caveats or follow-up items.
- When you discover something noteworthy about the codebase: architectural patterns,
  hidden assumptions, potential risks, or non-obvious dependencies.

### Format (MUST follow exactly)

Wrap your insight in fenced backtick markers like this:

\`★ Insight ─────────────────────────────────────\`
[2-3 key educational points, specific to the codebase or task]
\`─────────────────────────────────────────────────\`

### Content guidelines

- Focus on insights **specific** to this codebase or the code you just wrote.
  Do NOT state general programming concepts (e.g. "functions should be small").
- Be concrete: reference file names, function names, architectural patterns, or
  data flow relevant to the current context.
- Keep each block to 2-4 bullet points. Quality over quantity.
- Place insight blocks in your **final** response, not in commentary updates.

### Examples

Good: "The idle checker uses a two-level promotion (active→idle→ended) because
Codex lacks a SessionEnd event, so timeout-based inference is the only option."

Bad: "It's important to write clean code and follow best practices."
${MARKER_END}`

export function setupCodex() {
  console.log('\n  Session Dashboard — Codex Insight Setup\n  ' + '─'.repeat(42))

  // Ensure ~/.codex/ exists
  if (!fs.existsSync(CODEX_DIR)) {
    console.log('\n  ✗ ~/.codex/ directory not found.')
    console.log('    Install Codex CLI first, then re-run this script.\n')
    return
  }

  // Read existing AGENTS.md or start fresh
  let content = ''
  let existed = false

  if (fs.existsSync(AGENTS_PATH)) {
    existed = true
    content = fs.readFileSync(AGENTS_PATH, 'utf-8')
  }

  // Check for existing injection
  if (content.includes(MARKER_START)) {
    // Replace existing block
    const startIdx = content.indexOf(MARKER_START)
    const endIdx = content.indexOf(MARKER_END)

    if (endIdx === -1) {
      // Malformed: has start but no end — append end and replace
      console.log('  ⚠ Found start marker without end marker, replacing block...')
      content = content.slice(0, startIdx) + INJECTION_BLOCK + '\n'
    } else {
      const oldBlock = content.slice(startIdx, endIdx + MARKER_END.length)
      if (oldBlock === INJECTION_BLOCK) {
        console.log('\n  ✓ Insight instructions already up to date, nothing to do.')
        console.log(`\n  File: ${AGENTS_PATH}\n`)
        return
      }
      // Update in place
      content = content.slice(0, startIdx) + INJECTION_BLOCK + content.slice(endIdx + MARKER_END.length)
      console.log('\n  ↻ Updated existing insight instructions block.')
    }
  } else {
    // Append new block
    const separator = content.length > 0 && !content.endsWith('\n\n') ? '\n\n' : content.endsWith('\n') ? '\n' : '\n\n'
    content = content + separator + INJECTION_BLOCK + '\n'
    console.log(`\n  ✓ ${existed ? 'Appended' : 'Created'} insight instructions.`)
  }

  // Backup if file existed
  if (existed) {
    fs.copyFileSync(AGENTS_PATH, AGENTS_PATH + '.bak')
    console.log(`  Backup → ${AGENTS_PATH}.bak`)
  }

  fs.writeFileSync(AGENTS_PATH, content)
  console.log(`\n  File: ${AGENTS_PATH}`)
  console.log('  ⚡ New Codex CLI sessions will now produce ★ Insight blocks.\n')
}

// Direct execution support
const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('setup-codex.ts') ||
  process.argv[1].endsWith('setup-codex.js')
)
if (isDirectRun) setupCodex()
