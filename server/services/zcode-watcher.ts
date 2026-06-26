import { existsSync, readFileSync, openSync, readSync, closeSync, statSync, readdirSync } from 'fs'
import { watch, type FSWatcher } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'
import Database from 'better-sqlite3'
import { extractInsightBlocks, contentHash, sanitizeUserInput } from '../utils/insight-extractor.js'

export const ZCODE_ROLLOUT_DIR = join(homedir(), '.zcode', 'cli', 'rollout')
const ZCODE_DB_PATH = join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite')

// How many recent rollout files to scan on startup (by mtime)
const SCAN_FILE_LIMIT = 50

// Max bytes of system prompt to scan when extracting cwd as a fallback.
// Records can be large; we only need the head of the system block.
const CWD_SCAN_LIMIT = 8192

export interface ZcodeSessionCallbacks {
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

// Metadata enriched from zcode's own SQLite (the authoritative source for
// cwd / parent / title). Loaded once at startup; rollout content stays the
// source of live events & insights.
interface ZcodeSessionMeta {
  cwd: string
  title: string
  isSubagent: boolean
  parentSessionId?: string
}

/**
 * Read subagent / parent / cwd metadata from a zcode rollout's first record,
 * mirroring readCodexSessionMetadata's shape. Parent resolution here is a
 * best-effort heuristic from the file name + first record; the authoritative
 * parent link comes from loadZcodeSessionIndex() (zcode's SQLite).
 */
export function readZcodeSessionMetadata(
  rolloutPath: string
): { isSubagent: boolean, parentSessionId?: string, cwd?: string } {
  const fileName = basename(rolloutPath)
  const isSubagent = fileName.includes('subagent')

  if (!existsSync(rolloutPath)) return { isSubagent }

  try {
    const firstLine = readFileSync(rolloutPath, 'utf-8').split('\n', 1)[0]?.trim()
    if (!firstLine) return { isSubagent }
    const record = JSON.parse(firstLine)
    const cwd = extractCwd(record)
    return { isSubagent, cwd }
  } catch {
    return { isSubagent }
  }
}

// Pull the cwd out of a zcode request record. zcode embeds it in the system
// prompt ("Primary working directory: <path>") rather than as a dedicated
// field, so we scan the head of the system block.
function extractCwd(record: any): string | undefined {
  const system = record?.request?.body?.system ?? record?.request?.system
  if (!Array.isArray(system)) return undefined
  let text = ''
  for (const block of system) {
    if (typeof block?.text === 'string') {
      text += block.text + '\n'
      if (text.length >= CWD_SCAN_LIMIT) break
    }
  }
  const m = text.match(/Primary working directory:\s*(\S+)/)
  return m ? m[1] : undefined
}

interface RolloutState {
  sessionId: string
  path: string
  offset: number
  seenHashes: Set<string>
  watcher: FSWatcher | null
  isSubagent: boolean
  parentSessionId?: string
  cwd?: string
  discovered: boolean
}

export class ZcodeWatcher {
  private callbacks: ZcodeSessionCallbacks
  private metaIndex = new Map<string, ZcodeSessionMeta>()
  private rollouts = new Map<string, RolloutState>()
  private dirWatcher: FSWatcher | null = null

  constructor(callbacks: ZcodeSessionCallbacks) {
    this.callbacks = callbacks
  }

  start() {
    // 1. Load authoritative metadata from zcode's own SQLite (cwd / parent / title)
    this.loadSessionIndex()

    // 2. Scan recent rollout files
    this.scanRecentFiles()

    // 3. Watch for new / changed files
    this.watchDirectory()

    console.log(`[zcode-watcher] started, tracking ${this.rollouts.size} rollout files`)
  }

  stop() {
    this.dirWatcher?.close()
    this.dirWatcher = null
    for (const state of this.rollouts.values()) {
      state.watcher?.close()
    }
    this.rollouts.clear()
  }

  // ─── zcode SQLite metadata index ───
  //
  // zcode stores authoritative session metadata in ~/.zcode/cli/db/db.sqlite
  // (WAL mode). We open it readonly so we never contend with the running zcode
  // process. This gives us cwd (session.directory), parent link
  // (session.parent_id) and a display title (session.title) that rollout files
  // alone can't provide.

  private loadSessionIndex() {
    if (!existsSync(ZCODE_DB_PATH)) return

    let db: Database.Database | undefined
    try {
      // Open readonly so we never contend with the running zcode process.
      db = new Database(ZCODE_DB_PATH, { readonly: true, fileMustExist: true })
      const rows = db.prepare(
        'SELECT id, parent_id, directory, title, task_type FROM session'
      ).all() as Array<{ id: string, parent_id: string | null, directory: string, title: string, task_type: string }>

      for (const row of rows) {
        this.metaIndex.set(row.id, {
          cwd: row.directory || '',
          title: row.title || '',
          isSubagent: row.task_type === 'subagent_child',
          parentSessionId: row.parent_id || undefined,
        })
      }
      console.log(`[zcode-watcher] loaded ${this.metaIndex.size} session metadata rows from zcode DB`)
    } catch (e) {
      // WAL files may be mid-checkpoint or zcode may hold a write lock; the
      // watcher degrades gracefully — cwd falls back to system-prompt parsing,
      // parent links simply stay unknown.
      console.warn(`[zcode-watcher] could not read zcode DB metadata, degrading: ${(e as Error).message}`)
    } finally {
      db?.close()
    }
  }

  // ─── Scan recent rollout files ───

  private scanRecentFiles() {
    if (!existsSync(ZCODE_ROLLOUT_DIR)) return

    let files: string[] = []
    try {
      files = readdirSync(ZCODE_ROLLOUT_DIR)
    } catch { return }

    const rollouts = files
      .filter((f) => f.startsWith('model-io-sess_') && f.endsWith('.jsonl'))
      .map((f) => {
        const fullPath = join(ZCODE_ROLLOUT_DIR, f)
        let mtime = 0
        try { mtime = statSync(fullPath).mtimeMs } catch { /* ignore */ }
        return { f: fullPath, mtime }
      })
      .sort((a, b) => b.mtime - a.mtime)

    for (const { f } of rollouts.slice(0, SCAN_FILE_LIMIT)) {
      this.registerRollout(f)
    }
  }

  // ─── Directory watcher ───

  private watchDirectory() {
    if (!existsSync(ZCODE_ROLLOUT_DIR)) return

    try {
      this.dirWatcher = watch(ZCODE_ROLLOUT_DIR, (_event, filename) => {
        if (!filename) return
        const name = basename(filename)
        if (!name.startsWith('model-io-sess_') || !name.endsWith('.jsonl')) return

        const fullPath = join(ZCODE_ROLLOUT_DIR, filename)
        if (!existsSync(fullPath)) return

        const existingId = this.findSessionByPath(fullPath)
        if (existingId) {
          const state = this.rollouts.get(existingId)
          if (state) this.parseIncremental(state)
        } else {
          this.registerRollout(fullPath)
        }
      })
    } catch {
      console.warn('[zcode-watcher] failed to watch directory, new sessions will not be auto-discovered')
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
      sessionId: '', // determined from first record
      path,
      offset: 0,
      seenHashes: new Set(),
      watcher: null,
      isSubagent: basename(path).includes('subagent'),
      discovered: false,
    }

    this.parseIncremental(state)

    if (!state.sessionId) return
    if (this.rollouts.has(state.sessionId)) return

    this.rollouts.set(state.sessionId, state)

    try {
      state.watcher = watch(path, () => {
        this.parseIncremental(state)
      })
    } catch { /* file watching might fail */ }
  }

  // ─── Incremental JSONL parser ───
  //
  // Byte-for-byte identical strategy to codex-watcher: read from the last
  // offset up to the last complete newline, defer any trailing partial line.
  // zcode rollout records can be several MB each (they carry the full message
  // history), so we bound a single read to avoid huge allocations.

  private static readonly MAX_READ_BYTES = 64 * 1024 * 1024

  private parseIncremental(state: RolloutState) {
    try {
      const stat = statSync(state.path)
      if (stat.size <= state.offset) return

      const bytesToRead = Math.min(stat.size - state.offset, ZcodeWatcher.MAX_READ_BYTES)
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
    const sessionId: string | undefined = obj.sessionId
    const startedAt: string | undefined = obj.startedAt
    const completedAt: string | undefined = obj.completedAt
    const timestamp: string = startedAt || completedAt || new Date().toISOString()

    // First record with an id establishes the session
    if (sessionId && !state.sessionId) {
      state.sessionId = sessionId
    }

    if (!state.sessionId) return

    // Enrich from the authoritative metadata index on first sight
    const meta = sessionId ? this.metaIndex.get(sessionId) : undefined
    if (meta) {
      state.isSubagent = meta.isSubagent
      if (meta.parentSessionId) state.parentSessionId = meta.parentSessionId
      if (meta.cwd) state.cwd = meta.cwd
    } else if (!state.cwd) {
      const cwd = extractCwd(obj)
      if (cwd) state.cwd = cwd
    }

    // One-shot discovery callback (emit once we know the session)
    if (!state.discovered && state.sessionId) {
      state.discovered = true
      const meta = this.metaIndex.get(state.sessionId)
      const cwd = state.cwd || meta?.cwd || ''
      const displayName = meta?.title || ''
      this.callbacks.onSessionDiscovered(
        state.sessionId,
        cwd,
        displayName,
        state.path,
        timestamp,
        { isSubagent: state.isSubagent, parentSessionId: state.parentSessionId }
      )
    }

    // ─── State transition (inferred from request lifecycle) ───
    // zcode has no explicit task_started/task_complete events. A request with
    // startedAt but no completedAt is in flight → active. A completed request
    // → inactive. This mirrors Codex's passive model.
    if (startedAt) {
      this.callbacks.onStateChange(state.sessionId, 'active', startedAt)
    }
    if (completedAt) {
      this.callbacks.onStateChange(state.sessionId, 'inactive', completedAt)
    }

    // ─── User input (request.messages role=user) ───
    const messages: any[] = obj.request?.messages ?? obj.request?.body?.messages ?? []
    for (const msg of messages) {
      if (msg.role !== 'user') continue
      const text = messageToText(msg.content)
      if (!text) continue
      const sanitized = sanitizeUserInput(text, 'zcode')
      if (!sanitized) continue
      const hash = contentHash(sanitized)
      if (state.seenHashes.has(hash)) continue
      state.seenHashes.add(hash)
      if (state.seenHashes.size > 5000) state.seenHashes.clear()
      this.callbacks.onUserInput(state.sessionId, sanitized, startedAt || timestamp)
    }

    // ─── Insights (response.text) ───
    const responseText: string = obj.response?.text ?? ''
    if (responseText.length >= 20) {
      this.extractAndEmitInsights(state, responseText, completedAt || startedAt || timestamp)
    }

    // ─── Events (raw, for the timeline) ───
    // Each rollout record is one complete request/response cycle. Emit a
    // task_started (at startedAt) and task_complete (at completedAt) pair so
    // the timeline mirrors Codex's event sequence instead of a single point.
    // A record still in flight (no completedAt yet) emits only task_started.
    const rawPayload = JSON.stringify(obj)
    if (startedAt) {
      this.callbacks.onEvent(state.sessionId, 'task_started', startedAt, rawPayload)
    }
    if (completedAt) {
      this.callbacks.onEvent(state.sessionId, 'task_complete', completedAt, rawPayload)
    }
  }

  private extractAndEmitInsights(state: RolloutState, text: string, timestamp: string) {
    const blocks = extractInsightBlocks(text)
    for (const block of blocks) {
      const hash = contentHash(block)
      if (state.seenHashes.has(hash)) continue
      state.seenHashes.add(hash)
      if (state.seenHashes.size > 5000) state.seenHashes.clear()
      this.callbacks.onInsight(state.sessionId, block, timestamp)
    }
  }
}

// zcode message content mirrors the Anthropic format: either a plain string
// or an array of content blocks ({type:'text', text}).
function messageToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('\n')
  }
  return ''
}
