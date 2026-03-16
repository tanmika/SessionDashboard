import { existsSync, openSync, readSync, closeSync, statSync } from 'fs'
import { watch } from 'fs'
import { extractInsightBlocks, contentHash } from '../utils/insight-extractor.js'

type InsightCallback = (sessionId: string, content: string) => void
type UserInputCallback = (sessionId: string, content: string) => void

interface WatchState {
  sessionId: string
  path: string
  offset: number // bytes read so far
  seenHashes: Set<string>
  watcher: ReturnType<typeof watch> | null
}

const MIN_USER_INPUT_LENGTH = 5
const MAX_USER_INPUT_LENGTH = 2000

/** Patterns that indicate system-generated content, not real user input */
const USER_INPUT_NOISE_PATTERNS = [
  /^\[Request interrupted/,                      // Claude Code interrupt marker
  /^<command-name>/,                             // Slash command XML
  /^<local-command-/,                            // Local command output/caveat
  /╭───.*Claude Code/,                           // TUI welcome screen
  /^Implement the following plan:/,              // Hook-injected plan text
]

/** Patterns for sensitive credentials that should be redacted */
const CREDENTIAL_PATTERNS = [
  /(github_pat_|ghp_|gho_|ghs_)[A-Za-z0-9_]+/g,
  /sk-[a-f0-9]{20,}/g,
]

function isUserInputNoise(text: string): boolean {
  return USER_INPUT_NOISE_PATTERNS.some(p => p.test(text))
}

function redactCredentials(text: string): string {
  let result = text
  for (const pattern of CREDENTIAL_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]')
  }
  return result
}

export class TranscriptWatcher {
  private watchers = new Map<string, WatchState>()
  private onInsight: InsightCallback
  private onUserInput: UserInputCallback

  constructor(onInsight: InsightCallback, onUserInput: UserInputCallback) {
    this.onInsight = onInsight
    this.onUserInput = onUserInput
  }

  // Register a transcript file to watch for a session
  watch(sessionId: string, transcriptPath: string) {
    if (!transcriptPath || this.watchers.has(sessionId)) return
    if (!existsSync(transcriptPath)) return

    const state: WatchState = {
      sessionId,
      path: transcriptPath,
      offset: 0,
      seenHashes: new Set(),
      watcher: null,
    }

    this.watchers.set(sessionId, state)

    // Initial parse of existing content
    this.parseIncremental(state)

    // Watch for new writes
    try {
      state.watcher = watch(transcriptPath, () => {
        this.parseIncremental(state)
      })
    } catch {
      // File watching might fail on some systems; fall back to no watching
    }
  }

  // Update transcript path (called when a hook event provides a new path)
  updatePath(sessionId: string, transcriptPath: string) {
    const existing = this.watchers.get(sessionId)
    if (existing) {
      if (existing.path === transcriptPath) return
      existing.watcher?.close()
      this.watchers.delete(sessionId)
    }
    this.watch(sessionId, transcriptPath)
  }

  unwatch(sessionId: string) {
    const state = this.watchers.get(sessionId)
    if (state) {
      state.watcher?.close()
      this.watchers.delete(sessionId)
    }
  }

  unwatchAll() {
    for (const state of this.watchers.values()) {
      state.watcher?.close()
    }
    this.watchers.clear()
  }

  private parseIncremental(state: WatchState) {
    try {
      const stat = statSync(state.path)
      if (stat.size <= state.offset) return

      const bytesToRead = stat.size - state.offset
      const buf = Buffer.alloc(bytesToRead)
      const fd = openSync(state.path, 'r')
      const bytesRead = readSync(fd, buf, 0, bytesToRead, state.offset)
      closeSync(fd)

      state.offset += bytesRead
      const newContent = buf.subarray(0, bytesRead).toString('utf-8')

      // Process line by line (handle partial last line)
      const lines = newContent.split('\n')

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        try {
          const obj = JSON.parse(trimmed)
          this.processRecord(state, obj)
        } catch {
          // Not valid JSON (partial line at end), skip
        }
      }
    } catch {
      // File may have been deleted or is inaccessible
    }
  }

  private processRecord(state: WatchState, obj: any) {
    const recordType = obj.type

    // Capture user input
    if (recordType === 'user') {
      const message = obj.message
      if (!message) return
      // user message content can be a string or array of content blocks
      let text = ''
      if (typeof message.content === 'string') {
        text = message.content
      } else if (Array.isArray(message.content)) {
        text = message.content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n')
      }
      text = text.trim()
      if (text.length < MIN_USER_INPUT_LENGTH) return
      if (isUserInputNoise(text)) return
      text = redactCredentials(text)
      if (text.length > MAX_USER_INPUT_LENGTH) {
        text = text.substring(0, MAX_USER_INPUT_LENGTH) + ' [truncated]'
      }
      const hash = contentHash(text)
      if (!state.seenHashes.has(hash)) {
        state.seenHashes.add(hash)
        this.onUserInput(state.sessionId, text)
      }
      return
    }

    // Extract insights from assistant messages
    if (recordType !== 'assistant') return

    const message = obj.message
    if (!message) return

    const content: any[] = message.content ?? []

    for (const block of content) {
      if (block.type !== 'text') continue
      const text: string = block.text ?? ''
      if (!text || text.length < 20) continue

      this.extractAndEmit(state, text)
    }
  }

  private extractAndEmit(state: WatchState, text: string) {
    const insightBlocks = extractInsightBlocks(text)
    for (const block of insightBlocks) {
      const hash = contentHash(block)
      if (state.seenHashes.has(hash)) continue
      state.seenHashes.add(hash)
      this.onInsight(state.sessionId, block)
    }
  }
}
