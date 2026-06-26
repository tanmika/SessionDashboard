/**
 * Session Dashboard — ZCode Insight Injection Setup
 * Usage: npm run setup:zcode  (or called by CLI `session-dashboard init`)
 *
 * Injects ★ Insight output-style instructions into the project-level AGENTS.md
 * so ZCode sessions produce structured insight blocks the dashboard can parse.
 *
 * ZCode reads AGENTS.md as its project-instruction file (same convention as
 * Codex). Per ZCode docs there are two sources — the global ~/.zcode/AGENTS.md
 * and the workspace AGENTS.md (current working directory). We inject into the
 * workspace <cwd>/AGENTS.md because the insight format is a per-project
 * convention tied to the cwd the dashboard watches, and the global file is
 * better left for cross-project personal preferences.
 *
 * CLAUDE.md is NOT used — ZCode only reads it once during onboarding (copying
 * its content into AGENTS.md); AGENTS.md is the authoritative source at runtime.
 *
 * Safe to run multiple times (idempotent) — uses marker tags for dedup.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { INSIGHT_USAGE_MANUAL } from '../shared/insight-usage.js'

const ZCODE_DIR = path.join(os.homedir(), '.zcode', 'cli')
// Inject into the current project's AGENTS.md (ZCode's project-instruction file).
const AGENTS_MD_PATH = path.resolve(process.cwd(), 'AGENTS.md')

const MARKER_START = '<---session-dashboard-zcode-insight--->'
const MARKER_END = '<---/session-dashboard-zcode-insight--->'

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
- Place insight blocks in your **final** response, not in intermediate tool output.
${MARKER_END}`

const USAGE_MARKER_START = '<---session-dashboard-zcode-usage--->'
const USAGE_MARKER_END = '<---/session-dashboard-zcode-usage--->'

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

export function setupZcode() {
  console.log('\n  Session Dashboard — ZCode Insight Setup\n  ' + '─'.repeat(40))

  if (!fs.existsSync(ZCODE_DIR)) {
    console.log('\n  ✗ ~/.zcode/cli/ directory not found.')
    console.log('    Install ZCode first, then re-run this script.\n')
    return
  }

  let content = ''
  let existed = false

  if (fs.existsSync(AGENTS_MD_PATH)) {
    existed = true
    content = fs.readFileSync(AGENTS_MD_PATH, 'utf-8')
  }

  // Upsert both blocks
  const r1 = upsertBlock(content, MARKER_START, MARKER_END, INJECTION_BLOCK, 'Insight output format')
  const r2 = upsertBlock(r1.content, USAGE_MARKER_START, USAGE_MARKER_END, USAGE_BLOCK, 'Insight recovery usage')

  if (!r1.changed && !r2.changed) {
    console.log(`\n  File: ${AGENTS_MD_PATH}\n`)
    return
  }

  if (existed) {
    fs.copyFileSync(AGENTS_MD_PATH, AGENTS_MD_PATH + '.bak')
    console.log(`  Backup → ${AGENTS_MD_PATH}.bak`)
  }

  fs.writeFileSync(AGENTS_MD_PATH, r2.content)
  console.log(`\n  File: ${AGENTS_MD_PATH}`)
  console.log('  ⚡ Restart ZCode sessions in this project for changes to take effect.\n')
}

// Direct execution support
const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('setup-zcode.ts') ||
  process.argv[1].endsWith('setup-zcode.js')
)
if (isDirectRun) setupZcode()
