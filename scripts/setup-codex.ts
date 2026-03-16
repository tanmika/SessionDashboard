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
import { INSIGHT_USAGE_MANUAL } from '../shared/insight-usage.js'

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

const USAGE_MARKER_START = '<---session-dashboard-usage--->'
const USAGE_MARKER_END = '<---/session-dashboard-usage--->'

const USAGE_BLOCK = `${USAGE_MARKER_START}
${INSIGHT_USAGE_MANUAL}
${USAGE_MARKER_END}`

/** Upsert a marker-delimited block into content. Returns { content, changed }. */
function upsertBlock(
  content: string,
  markerStart: string,
  markerEnd: string,
  block: string,
  label: string
): { content: string; changed: boolean } {
  if (content.includes(markerStart)) {
    const startIdx = content.indexOf(markerStart)
    const endIdx = content.indexOf(markerEnd)

    if (endIdx === -1) {
      console.log(`  ⚠ ${label}: found start marker without end, replacing...`)
      return { content: content.slice(0, startIdx) + block + '\n', changed: true }
    }

    const oldBlock = content.slice(startIdx, endIdx + markerEnd.length)
    if (oldBlock === block) {
      console.log(`  ✓ ${label}: already up to date.`)
      return { content, changed: false }
    }

    console.log(`  ↻ ${label}: updated.`)
    return {
      content: content.slice(0, startIdx) + block + content.slice(endIdx + markerEnd.length),
      changed: true,
    }
  }

  // Append
  const separator = content.length > 0 && !content.endsWith('\n\n') ? '\n\n' : content.endsWith('\n') ? '\n' : '\n\n'
  console.log(`  ✓ ${label}: added.`)
  return { content: content + separator + block + '\n', changed: true }
}

export function setupCodex() {
  console.log('\n  Session Dashboard — Codex Insight Setup\n  ' + '─'.repeat(42))

  if (!fs.existsSync(CODEX_DIR)) {
    console.log('\n  ✗ ~/.codex/ directory not found.')
    console.log('    Install Codex CLI first, then re-run this script.\n')
    return
  }

  let content = ''
  let existed = false

  if (fs.existsSync(AGENTS_PATH)) {
    existed = true
    content = fs.readFileSync(AGENTS_PATH, 'utf-8')
  }

  // Upsert both blocks
  const r1 = upsertBlock(content, MARKER_START, MARKER_END, INJECTION_BLOCK, 'Insight output format')
  const r2 = upsertBlock(r1.content, USAGE_MARKER_START, USAGE_MARKER_END, USAGE_BLOCK, 'Insight recovery usage')

  if (!r1.changed && !r2.changed) {
    console.log(`\n  File: ${AGENTS_PATH}\n`)
    return
  }

  if (existed) {
    fs.copyFileSync(AGENTS_PATH, AGENTS_PATH + '.bak')
    console.log(`  Backup → ${AGENTS_PATH}.bak`)
  }

  fs.writeFileSync(AGENTS_PATH, r2.content)
  console.log(`\n  File: ${AGENTS_PATH}`)
  console.log('  ⚡ Restart Codex CLI for changes to take effect.\n')
}

// Direct execution support
const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('setup-codex.ts') ||
  process.argv[1].endsWith('setup-codex.js')
)
if (isDirectRun) setupCodex()
