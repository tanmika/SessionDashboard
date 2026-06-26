import { createHash } from 'crypto'

// Extracts the content between ★ Insight markers.
// Only explicit insight blocks are persisted as transcript insights.
const INLINE_INSIGHT_START_RE = /^`★ Insight\s*[─\-]+`$/
const INLINE_INSIGHT_END_RE = /^`[─\-]{10,}`$/
const FENCE_START_RE = /^```[\w-]*\s*$/
const FENCE_END_RE = /^```\s*$/
const FENCED_INSIGHT_START_RE = /^★ Insight\s*[─\-]+$/
const FENCED_INSIGHT_END_RE = /^[─\-]{10,}$/

export function extractInsightBlocks(text: string): string[] {
  const lines = text.split('\n')
  const results: string[] = []
  let i = 0

  while (i < lines.length) {
    const trimmed = lines[i].trim()

    if (INLINE_INSIGHT_START_RE.test(trimmed)) {
      const buffer: string[] = []
      i += 1
      while (i < lines.length) {
        const current = lines[i].trim()
        if (INLINE_INSIGHT_END_RE.test(current)) break
        buffer.push(lines[i])
        i += 1
      }
      const content = buffer.join('\n').trim()
      if (content) results.push(content)
      i += 1
      continue
    }

    if (FENCE_START_RE.test(trimmed)) {
      let startIndex = i + 1
      while (startIndex < lines.length && !lines[startIndex].trim()) {
        startIndex += 1
      }

      if (startIndex < lines.length && FENCED_INSIGHT_START_RE.test(lines[startIndex].trim())) {
        const buffer: string[] = []
        i = startIndex + 1
        while (i < lines.length) {
          const current = lines[i].trim()
          if (FENCED_INSIGHT_END_RE.test(current) || FENCE_END_RE.test(current)) break
          buffer.push(lines[i])
          i += 1
        }
        const content = buffer.join('\n').trim()
        if (content) results.push(content)
        while (i < lines.length && !FENCE_END_RE.test(lines[i].trim())) {
          i += 1
        }
        if (i < lines.length) i += 1
        continue
      }
    }

    i += 1
  }

  return results
}

export function contentHash(content: string): string {
  return createHash('md5').update(content).digest('hex').slice(0, 12)
}

// ─── User input filtering (shared by transcript-watcher and codex-watcher) ───

export const MAX_USER_INPUT_LENGTH = 2000
export type UserInputSource = 'claude' | 'codex' | 'zcode' | 'unknown'

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

const STRONG_SYSTEM_BLOCK_PATTERNS = [
  /^<subagent_notification>[\s\S]*<\/subagent_notification>$/i,
  /^✻ Conversation compacted\b/m,
  /^Another language model started to solve this problem\b/m,
  /^Compact summary\b/m,
]

const SYSTEM_PHRASE_PATTERNS = [
  /<subagent_notification>/i,
  /<\/subagent_notification>/i,
  /Conversation compacted/i,
  /Compact summary/i,
  /This session is being continued from a previous conversation/i,
  /Another language model started to solve this problem/i,
  /Claude Code v\d/i,
  /Welcome to Opus/i,
  /Welcome back!/i,
  /Tips for getting started/i,
  /API Usage Billing/i,
  /\/model to try Opus/i,
  /Compacted Tip:/i,
  /SessionStart hook \(completed\)/i,
  /hook context:/i,
  /Your current session_id is:/i,
  /• Running SessionStart hook/i,
  /▐▛███/i,
]

const USER_WRAPPER_PREFIX_PATTERNS = [
  /^这是我与另一个ai的聊天内容[:：]?/i,
  /^了解一下这个对话的内容[:：]?/i,
  /^恢复一下[0-9a-f-]{8,}的insight[:：]?/i,
]

/** Patterns for sensitive credentials that should be redacted */
const CREDENTIAL_PATTERNS = [
  /(github_pat_|ghp_|gho_|ghs_)[A-Za-z0-9_]+/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,          // OpenAI-style secret keys
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,      // Anthropic API keys
  /\b(?:proj|sess)-[A-Za-z0-9]{24,}\b/g, // OpenAI project/session-like IDs
  /\bBearer\s+[A-Za-z0-9._-]{24,}\b/gi,  // Bearer tokens (safely length-gated)
]

function countSystemPhraseMatches(text: string): number {
  let count = 0
  for (const pattern of SYSTEM_PHRASE_PATTERNS) {
    if (pattern.test(text)) count += 1
  }
  return count
}

function findWrapperPrefix(text: string): string | null {
  for (const pattern of USER_WRAPPER_PREFIX_PATTERNS) {
    const match = text.match(pattern)
    if (match) return match[0]
  }
  return null
}

function hasSystemBlockStructure(text: string): boolean {
  const nonEmptyLines = text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)

  if (nonEmptyLines.length < 2) return false

  const lineSignals = nonEmptyLines.filter(line => (
    line.startsWith('✻ Conversation compacted') ||
    line.startsWith('Another language model started to solve this problem') ||
    line.startsWith('Compact summary') ||
    line.startsWith('Claude Code v') ||
    line.includes('Claude Code v') ||
    line.startsWith('Welcome to Opus') ||
    line.includes('Welcome to Opus') ||
    line.startsWith('Welcome back!') ||
    line.startsWith('Tips for getting started') ||
    line.includes('API Usage Billing') ||
    line.includes('/model to try Opus') ||
    line.startsWith('SessionStart hook (completed)') ||
    line.startsWith('hook context:') ||
    line.startsWith('Your current session_id is:') ||
    line.includes('<subagent_notification>') ||
    line.startsWith('• Running SessionStart hook') ||
    line.includes('▐▛███')
  )).length

  return lineSignals >= 2
}

export function isUserInputNoise(text: string, source: UserInputSource = 'unknown'): boolean {
  if (USER_INPUT_NOISE_PATTERNS.some(p => p.test(text))) return true
  if (STRONG_SYSTEM_BLOCK_PATTERNS.some(p => p.test(text))) return true

  const phraseMatches = countSystemPhraseMatches(text)
  const lineCount = text.split('\n').filter(line => line.trim()).length
  if (phraseMatches >= 3 && lineCount >= 3) return true
  if ((source === 'claude' || source === 'codex' || source === 'zcode') && phraseMatches >= 2 && hasSystemBlockStructure(text)) {
    return true
  }

  const wrapper = findWrapperPrefix(text)
  if (!wrapper) return false
  const remainder = text.slice(wrapper.length).trim()
  if (!remainder) return false
  return countSystemPhraseMatches(remainder) >= 2 && hasSystemBlockStructure(remainder)
}

export function sanitizeUserInput(text: string, source: UserInputSource = 'unknown'): string | null {
  text = text.trim()
  if (text.length < 5) return null
  if (isUserInputNoise(text, source)) return null
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
