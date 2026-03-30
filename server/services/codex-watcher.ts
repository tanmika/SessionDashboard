import { existsSync, readFileSync, openSync, readSync, closeSync, statSync, readdirSync } from 'fs'
import { watch, type FSWatcher } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'
import { extractInsightBlocks, contentHash, sanitizeUserInput } from '../utils/insight-extractor.js'

export const CODEX_SESSIONS_DIR = join(homedir(), '.codex', 'sessions')
const CODEX_INDEX_PATH = join(homedir(), '.codex', 'session_index.jsonl')

// How many days back to scan on startup
const SCAN_DAYS = 7

export interface CodexSessionCallbacks {
  onSessionDiscovered: (
    sessionId: string,
    cwd: string,
    displayName: string,
    rolloutPath: string,
    timestamp: string,
    metadata: { isSubagent: boolean, parentSessionId?: string }
  ) => void
  onStateChange: (sessionId: string, newState: 'active' | 'inactive', timestamp: string) => void
  onInsight: (sessionId: string, content: string, timestamp: string) => void
  onUserInput: (sessionId: string, content: string, timestamp: string) => void
  onEvent: (sessionId: string, eventName: string, timestamp: string, rawPayload: string) => void
}

export function readCodexSessionMetadata(
  rolloutPath: string
): { isSubagent: boolean, parentSessionId?: string } {
  if (!existsSync(rolloutPath)) return { isSubagent: false }

  try {
    const firstLine = readFileSync(rolloutPath, 'utf-8').split('\n', 1)[0]?.trim()
    if (!firstLine) return { isSubagent: false }

    const record = JSON.parse(firstLine)
    const threadSpawn = record?.payload?.source?.subagent?.thread_spawn
    return {
      isSubagent: Boolean(threadSpawn),
      parentSessionId: threadSpawn?.parent_thread_id || undefined,
    }
  } catch {
    return { isSubagent: false }
  }
}

interface RolloutState {
  sessionId: string
  path: string
  offset: number
  seenHashes: Set<string>
  watcher: FSWatcher | null
  isSubagent: boolean
  parentSessionId?: string
}

export class CodexWatcher {
  private callbacks: CodexSessionCallbacks
  private threadNames = new Map<string, string>() // session_id → thread_name
  private rollouts = new Map<string, RolloutState>() // session_id → state
  private dirWatcher: FSWatcher | null = null

  constructor(callbacks: CodexSessionCallbacks) {
    this.callbacks = callbacks
  }

  start() {
    // 1. Load thread_name index
    this.loadSessionIndex()

    // 2. Scan recent rollout files
    this.scanRecentDays()

    // 3. Watch for new files
    this.watchDirectory()

    console.log(`[codex-watcher] started, tracking ${this.rollouts.size} rollout files`)
  }

  stop() {
    this.dirWatcher?.close()
    this.dirWatcher = null
    for (const state of this.rollouts.values()) {
      state.watcher?.close()
    }
    this.rollouts.clear()
  }

  // ─── Session Index ───

  private loadSessionIndex() {
    if (!existsSync(CODEX_INDEX_PATH)) return

    try {
      const content = readFileSync(CODEX_INDEX_PATH, 'utf-8')
      for (const line of content.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const entry = JSON.parse(trimmed)
          if (entry.id && entry.thread_name) {
            this.threadNames.set(entry.id, entry.thread_name)
          }
        } catch { /* skip malformed lines */ }
      }
    } catch { /* index file inaccessible */ }
  }

  // ─── Scan recent days ───

  private scanRecentDays() {
    const now = new Date()
    for (let i = 0; i < SCAN_DAYS; i++) {
      const d = new Date(now)
      d.setDate(d.getDate() - i)
      const year = String(d.getFullYear())
      const month = String(d.getMonth() + 1).padStart(2, '0')
      const day = String(d.getDate()).padStart(2, '0')
      const dayDir = join(CODEX_SESSIONS_DIR, year, month, day)

      if (!existsSync(dayDir)) continue

      try {
        const files = readdirSync(dayDir)
        for (const file of files) {
          if (file.startsWith('rollout-') && file.endsWith('.jsonl')) {
            this.registerRollout(join(dayDir, file))
          }
        }
      } catch { /* directory read failure */ }
    }
  }

  // ─── Directory watcher ───

  private watchDirectory() {
    try {
      this.dirWatcher = watch(CODEX_SESSIONS_DIR, { recursive: true }, (_event, filename) => {
        if (!filename) return
        const name = basename(filename)
        if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) return

        const fullPath = join(CODEX_SESSIONS_DIR, filename)
        // New file or existing file changed
        if (existsSync(fullPath)) {
          // Check if already registered
          const existingId = this.findSessionByPath(fullPath)
          if (existingId) {
            // Existing file changed → parse incremental
            const state = this.rollouts.get(existingId)
            if (state) this.parseIncremental(state)
          } else {
            // New file discovered
            this.registerRollout(fullPath)
          }
        }
      })
    } catch {
      console.warn('[codex-watcher] failed to watch directory, new sessions will not be auto-discovered')
    }
  }

  private findSessionByPath(path: string): string | undefined {
    for (const [id, state] of this.rollouts) {
      if (state.path === path) return id
    }
    return undefined
  }

  // ─── Register a rollout file ───

  private registerRollout(path: string) {
    const state: RolloutState = {
      sessionId: '', // determined from first line
      path,
      offset: 0,
      seenHashes: new Set(),
      watcher: null,
      isSubagent: false,
    }

    // Parse to discover session and process events
    this.parseIncremental(state)

    if (!state.sessionId) return // No valid session_meta found

    // Avoid duplicate registration
    if (this.rollouts.has(state.sessionId)) return

    this.rollouts.set(state.sessionId, state)

    // Watch for further changes
    try {
      state.watcher = watch(path, () => {
        this.parseIncremental(state)
      })
    } catch { /* file watching might fail */ }
  }

  // ─── Incremental JSONL parser ───

  private parseIncremental(state: RolloutState) {
    try {
      const stat = statSync(state.path)
      if (stat.size <= state.offset) return

      const bytesToRead = stat.size - state.offset
      const buf = Buffer.alloc(bytesToRead)
      const fd = openSync(state.path, 'r')
      let bytesRead = 0
      try {
        bytesRead = readSync(fd, buf, 0, bytesToRead, state.offset)
      } finally {
        closeSync(fd)
      }

      if (bytesRead <= 0) return

      const chunk = buf.subarray(0, bytesRead)
      const lastNewline = chunk.lastIndexOf(0x0a) // '\n'
      if (lastNewline === -1) return

      state.offset += lastNewline + 1
      const newContent = chunk.subarray(0, lastNewline + 1).toString('utf-8')
      const lines = newContent.split('\n')

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        try {
          const obj = JSON.parse(trimmed)
          this.processRecord(state, obj)
        } catch { /* partial line or malformed JSON */ }
      }
    } catch { /* file may have been deleted */ }
  }

  private processRecord(state: RolloutState, obj: any) {
    const recordType: string = obj.type
    const timestamp: string = obj.timestamp || new Date().toISOString()
    const payload = obj.payload

    if (!payload) return

    switch (recordType) {
      case 'session_meta': {
        const id = payload.id
        if (!id) return
        state.sessionId = id
        const cwd = payload.cwd || ''
        const threadName = this.threadNames.get(id) || ''
        const threadSpawn = payload.source?.subagent?.thread_spawn
        state.isSubagent = Boolean(threadSpawn)
        state.parentSessionId = typeof threadSpawn?.parent_thread_id === 'string'
          ? threadSpawn.parent_thread_id
          : undefined
        this.callbacks.onSessionDiscovered(
          id,
          cwd,
          threadName,
          state.path,
          payload.timestamp || timestamp,
          {
            isSubagent: state.isSubagent,
            parentSessionId: state.parentSessionId,
          }
        )
        break
      }

      case 'event_msg': {
        if (!state.sessionId) return
        const eventType: string = payload.type
        if (!eventType) return

        // State transitions
        if (eventType === 'task_started') {
          this.callbacks.onStateChange(state.sessionId, 'active', timestamp)
        } else if (eventType === 'task_complete') {
          this.callbacks.onStateChange(state.sessionId, 'inactive', timestamp)
        }

        // Capture user input
        if (eventType === 'user_message') {
          const raw: string = payload.message || ''
          const sanitized = sanitizeUserInput(raw, 'codex')
          if (sanitized) {
            const hash = contentHash(sanitized)
            if (!state.seenHashes.has(hash)) {
              state.seenHashes.add(hash)
              if (state.seenHashes.size > 5000) {
              state.seenHashes.clear()
            }
              this.callbacks.onUserInput(state.sessionId, sanitized, timestamp)
            }
          }
        }

        // Insight extraction from agent_message (non-commentary)
        if (eventType === 'agent_message' && payload.phase !== 'commentary') {
          const message: string = payload.message || payload.last_agent_message || ''
          if (message.length >= 20) {
            this.extractAndEmitInsights(state, message, timestamp)
          }
        }

        // Also extract from task_complete's last_agent_message
        if (eventType === 'task_complete' && payload.last_agent_message) {
          const msg: string = payload.last_agent_message
          if (msg.length >= 20) {
            this.extractAndEmitInsights(state, msg, timestamp)
          }
        }

        // Emit event
        this.callbacks.onEvent(state.sessionId, eventType, timestamp, JSON.stringify(obj))
        break
      }
      // response_item records are skipped (internal prompts, not user-facing events)
    }
  }

  private extractAndEmitInsights(state: RolloutState, text: string, timestamp: string) {
    const blocks = extractInsightBlocks(text)
    for (const block of blocks) {
      const hash = contentHash(block)
      if (state.seenHashes.has(hash)) continue
      state.seenHashes.add(hash)
      if (state.seenHashes.size > 5000) {
        state.seenHashes.clear()
      }
      this.callbacks.onInsight(state.sessionId, block, timestamp)
    }
  }
}
