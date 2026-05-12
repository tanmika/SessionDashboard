import { existsSync, openSync, readSync, closeSync, statSync } from 'fs'
import { watch } from 'fs'
import { extractInsightBlocks, contentHash, sanitizeUserInput } from '../utils/insight-extractor.js'

type InsightCallback = (sessionId: string, content: string, timestamp: string) => void
type UserInputCallback = (sessionId: string, content: string, timestamp: string) => void

interface WatchState {
  sessionId: string
  path: string
  offset: number // bytes read so far
  seenHashes: Set<string>
  watcher: ReturnType<typeof watch> | null
}

// User input filtering is in ../utils/insight-extractor.ts (sanitizeUserInput)

export class TranscriptWatcher {
  private watchers = new Map<string, WatchState>()
  private pendingRebinds = new Map<string, ReturnType<typeof setTimeout>>()
  private onInsight: InsightCallback
  private onUserInput: UserInputCallback

  constructor(onInsight: InsightCallback, onUserInput: UserInputCallback) {
    this.onInsight = onInsight
    this.onUserInput = onUserInput
  }

  // Register a transcript file to watch for a session.
  // If the file doesn't exist yet, retries a few times (Claude may create it after hook fires).
  watch(sessionId: string, transcriptPath: string, retries = 3) {
    if (!transcriptPath || this.watchers.has(sessionId)) return

    if (!existsSync(transcriptPath)) {
      if (retries > 0) {
        setTimeout(() => this.watch(sessionId, transcriptPath, retries - 1), 1000)
      }
      return
    }

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
    if (existing?.path === transcriptPath) {
      this.clearPendingRebind(sessionId)
      return
    }

    if (existing && !existsSync(transcriptPath)) {
      this.scheduleRebind(sessionId, transcriptPath)
      return
    }

    this.clearPendingRebind(sessionId)
    if (existing) {
      existing.watcher?.close()
      this.watchers.delete(sessionId)
    }
    this.watch(sessionId, transcriptPath)
  }

  unwatch(sessionId: string) {
    this.clearPendingRebind(sessionId)
    const state = this.watchers.get(sessionId)
    if (state) {
      state.watcher?.close()
      this.watchers.delete(sessionId)
    }
  }

  unwatchAll() {
    for (const timer of this.pendingRebinds.values()) {
      clearTimeout(timer)
    }
    this.pendingRebinds.clear()
    for (const state of this.watchers.values()) {
      state.watcher?.close()
    }
    this.watchers.clear()
  }

  private clearPendingRebind(sessionId: string) {
    const timer = this.pendingRebinds.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.pendingRebinds.delete(sessionId)
    }
  }

  private scheduleRebind(sessionId: string, transcriptPath: string) {
    this.clearPendingRebind(sessionId)
    const timer = setTimeout(() => {
      this.pendingRebinds.delete(sessionId)
      this.updatePath(sessionId, transcriptPath)
    }, 1000)
    this.pendingRebinds.set(sessionId, timer)
  }

  private parseIncremental(state: WatchState) {
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
    const timestamp: string = obj.timestamp || new Date().toISOString()

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
      const sanitized = sanitizeUserInput(text, 'claude')
      if (!sanitized) return
      const hash = contentHash(sanitized)
      if (!state.seenHashes.has(hash)) {
        state.seenHashes.add(hash)
        if (state.seenHashes.size > 5000) {
          state.seenHashes.clear()
        }
        this.onUserInput(state.sessionId, sanitized, timestamp)
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

      this.extractAndEmit(state, text, timestamp)
    }
  }

  private extractAndEmit(state: WatchState, text: string, timestamp: string) {
    const insightBlocks = extractInsightBlocks(text)
    for (const block of insightBlocks) {
      const hash = contentHash(block)
      if (state.seenHashes.has(hash)) continue
      state.seenHashes.add(hash)
      if (state.seenHashes.size > 5000) {
        state.seenHashes.clear()
      }
      this.onInsight(state.sessionId, block, timestamp)
    }
  }
}
