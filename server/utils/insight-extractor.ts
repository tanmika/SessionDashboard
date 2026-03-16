import { createHash } from 'crypto'

// Extracts the content between ★ Insight markers.
// Only explicit insight blocks are persisted as transcript insights.
const INSIGHT_START_RE = /`★ Insight\s*[─\-]+`/
const INSIGHT_END_RE = /`[─\-]{10,}`/

export function extractInsightBlocks(text: string): string[] {
  const lines = text.split('\n')
  const results: string[] = []
  let inBlock = false
  let buffer: string[] = []

  for (const line of lines) {
    if (!inBlock && INSIGHT_START_RE.test(line)) {
      inBlock = true
      buffer = []
    } else if (inBlock && INSIGHT_END_RE.test(line)) {
      const content = buffer.join('\n').trim()
      if (content) results.push(content)
      inBlock = false
      buffer = []
    } else if (inBlock) {
      buffer.push(line)
    }
  }

  return results
}

export function contentHash(content: string): string {
  return createHash('md5').update(content).digest('hex').slice(0, 12)
}

// ─── User input filtering (shared by transcript-watcher and codex-watcher) ───

export const MAX_USER_INPUT_LENGTH = 2000

/** Patterns that indicate system-generated content, not real user input */
const USER_INPUT_NOISE_PATTERNS = [
  /^\[Request interrupted/,                      // Claude Code interrupt marker
  /^<command-name>/,                             // Slash command XML
  /^<local-command-/,                            // Local command output/caveat
  /╭───.*Claude Code/,                           // TUI welcome screen
  /^Implement the following plan:/,              // Hook-injected plan text
  /Tip: Start a fresh idea with \/new/,          // Codex terminal tip
  /^⚠ Under-development features enabled:/,     // Codex feature warning
  /^✻ Conversation compacted/,                   // Compaction marker
]

/** Patterns for sensitive credentials that should be redacted */
const CREDENTIAL_PATTERNS = [
  /(github_pat_|ghp_|gho_|ghs_)[A-Za-z0-9_]+/g,
  /sk-[a-f0-9]{20,}/g,
]

export function isUserInputNoise(text: string): boolean {
  return USER_INPUT_NOISE_PATTERNS.some(p => p.test(text))
}

export function sanitizeUserInput(text: string): string | null {
  text = text.trim()
  if (text.length < 5) return null
  if (isUserInputNoise(text)) return null
  // Redact credentials
  for (const pattern of CREDENTIAL_PATTERNS) {
    text = text.replace(pattern, '[REDACTED]')
  }
  // Truncate
  if (text.length > MAX_USER_INPUT_LENGTH) {
    text = text.substring(0, MAX_USER_INPUT_LENGTH) + ' [truncated]'
  }
  return text
}
