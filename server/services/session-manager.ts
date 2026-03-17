import type Database from 'better-sqlite3'
import { basename } from 'path'
import { existsSync } from 'fs'
import type {
  HookEventPayload,
  Session,
  SessionState,
  SessionEvent,
  Insight,
  WsMessage,
} from '../../shared/types.js'
import { IDLE_THRESHOLD_MS, CODEX_ENDED_THRESHOLD_MS, STATE_PRIORITY } from '../../shared/types.js'
import { TranscriptWatcher } from './transcript-watcher.js'
import { CodexWatcher, CODEX_SESSIONS_DIR } from './codex-watcher.js'

// Events that signal real progress (can clear waiting state)
const PROGRESS_EVENTS = new Set([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
  'SessionEnd',
])

type BroadcastFn = (msg: WsMessage) => void

export class SessionManager {
  private sessions = new Map<string, Session>()
  private broadcast: BroadcastFn = () => {}
  private idleTimer: ReturnType<typeof setInterval> | null = null
  private transcriptWatcher: TranscriptWatcher
  private codexWatcher: CodexWatcher | null = null

  // Prepared statements
  private stmtInsertSession: Database.Statement
  private stmtUpdateSession: Database.Statement
  private stmtSetPinned: Database.Statement
  private stmtSetAlias: Database.Statement
  private stmtSetPredecessor: Database.Statement
  private stmtInsertEvent: Database.Statement
  private stmtInsertInsight: Database.Statement
  private stmtGetSessions: Database.Statement
  private stmtGetEvents: Database.Statement
  private stmtGetInsights: Database.Statement
  private stmtGetInsightsPaged: Database.Statement
  private stmtGetInsightsCount: Database.Statement
  private stmtGetEventsPaged: Database.Statement
  private stmtGetEventsCount: Database.Statement
  private stmtCheckInsightExists: Database.Statement

  constructor(private db: Database.Database) {
    this.transcriptWatcher = new TranscriptWatcher(
      (sessionId, content) => this.addInsight(sessionId, content, 'transcript'),
      (sessionId, content) => this.addInsight(sessionId, content, 'user'),
    )

    // Prepare statements
    this.stmtInsertSession = db.prepare(`
      INSERT OR IGNORE INTO sessions (session_id, cwd, transcript_path, state, last_activity, created_at, source)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    this.stmtUpdateSession = db.prepare(`
      UPDATE sessions SET state = ?, last_activity = ?, cwd = ?, transcript_path = ?
      WHERE session_id = ?
    `)
    this.stmtSetPinned = db.prepare(`UPDATE sessions SET pinned = ? WHERE session_id = ?`)
    this.stmtSetAlias = db.prepare(`UPDATE sessions SET alias = ? WHERE session_id = ?`)
    this.stmtSetPredecessor = db.prepare(`UPDATE sessions SET predecessor_id = ? WHERE session_id = ?`)
    this.stmtInsertEvent = db.prepare(`
      INSERT INTO events (session_id, event_name, notification_type, tool_name, subagent_id, timestamp, raw_payload)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    this.stmtInsertInsight = db.prepare(`
      INSERT INTO insights (session_id, content, timestamp, source)
      VALUES (?, ?, ?, ?)
    `)
    this.stmtGetSessions = db.prepare('SELECT * FROM sessions')
    this.stmtGetEvents = db.prepare(
      'SELECT * FROM events WHERE session_id = ? ORDER BY timestamp ASC'
    )
    this.stmtGetInsights = db.prepare(
      'SELECT * FROM insights WHERE session_id = ? ORDER BY timestamp DESC'
    )
    this.stmtGetInsightsPaged = db.prepare(
      'SELECT * FROM insights WHERE session_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?'
    )
    this.stmtGetInsightsCount = db.prepare(
      'SELECT COUNT(*) as count FROM insights WHERE session_id = ?'
    )
    this.stmtGetEventsPaged = db.prepare(
      'SELECT * FROM events WHERE session_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?'
    )
    this.stmtGetEventsCount = db.prepare(
      'SELECT COUNT(*) as count FROM events WHERE session_id = ?'
    )
    this.stmtCheckInsightExists = db.prepare(
      'SELECT 1 FROM insights WHERE session_id = ? AND content = ? AND source = ? LIMIT 1'
    )

    this.restoreFromDb()
    this.startIdleChecker()
    this.initCodexWatcher()
  }

  private static readonly INSIGHT_PAGE_SIZE = 100

  setBroadcast(fn: BroadcastFn) {
    this.broadcast = fn
  }

  /** Return a copy of the session with insights truncated to the newest page. */
  private slimSession(session: Session): Session {
    return {
      ...session,
      insights: session.insights.slice(0, SessionManager.INSIGHT_PAGE_SIZE),
      total_insights: session.total_insights,
    }
  }

  // ─── Restore sessions from SQLite on startup ───

  private restoreFromDb() {
    const rows = this.stmtGetSessions.all() as any[]
    for (const row of rows) {
      const insights = this.stmtGetInsightsPaged.all(
        row.session_id,
        SessionManager.INSIGHT_PAGE_SIZE,
        0
      ) as Insight[]
      const countRow = this.stmtGetInsightsCount.get(row.session_id) as { count: number }
      const session: Session = {
        session_id: row.session_id,
        display_name: this.makeDisplayName(row.cwd, row.session_id, row.alias),
        cwd: row.cwd,
        transcript_path: row.transcript_path,
        state: row.state as SessionState,
        last_activity: row.last_activity,
        created_at: row.created_at,
        alias: row.alias || '',
        pinned: row.pinned === 1,
        source: (row.source as 'claude' | 'codex') ?? 'claude',
        predecessor_id: row.predecessor_id || undefined,
        insights,
        total_insights: countRow.count,
        active_tools: 0,
        active_subagents: 0,
      }
      this.sessions.set(row.session_id, session)

      // Resume transcript watching for Claude sessions with a transcript path.
      // Even ended sessions may have their transcript continued (e.g. context-summary resumptions).
      if (session.source === 'claude' && row.transcript_path) {
        this.transcriptWatcher.watch(row.session_id, row.transcript_path)
      }
    }
  }

  // ─── Codex Watcher initialization ───

  private initCodexWatcher() {
    if (!existsSync(CODEX_SESSIONS_DIR)) {
      console.log('[session-manager] ~/.codex/sessions/ not found, Codex monitoring disabled')
      return
    }

    this.codexWatcher = new CodexWatcher({
      onSessionDiscovered: (sessionId, cwd, displayName, rolloutPath, timestamp) => {
        this.handleCodexSessionDiscovered(sessionId, cwd, displayName, rolloutPath, timestamp)
      },
      onStateChange: (sessionId, newState, timestamp) => {
        this.handleCodexStateChange(sessionId, newState, timestamp)
      },
      onInsight: (sessionId, content) => {
        this.addInsight(sessionId, content, 'transcript')
      },
      onUserInput: (sessionId, content) => {
        this.addInsight(sessionId, content, 'user')
      },
      onEvent: (sessionId, eventName, timestamp, rawPayload) => {
        this.handleCodexEvent(sessionId, eventName, timestamp, rawPayload)
      },
    })

    this.codexWatcher.start()
  }

  // ─── Codex callback handlers ───

  private handleCodexSessionDiscovered(
    sessionId: string, cwd: string, displayName: string, rolloutPath: string, timestamp: string
  ) {
    if (this.sessions.has(sessionId)) return // Already known

    const session = this.createSession(sessionId, cwd, rolloutPath, timestamp, 'codex')

    // Use thread_name as alias if available
    if (displayName) {
      session.alias = displayName
      session.display_name = this.makeDisplayName(cwd, sessionId, displayName)
      this.stmtSetAlias.run(displayName, sessionId)
    }
  }

  private handleCodexStateChange(sessionId: string, newState: 'active' | 'inactive', timestamp: string) {
    const session = this.sessions.get(sessionId)
    if (!session) return

    session.state = newState
    session.last_activity = timestamp
    this.persistAndBroadcast(session)
  }

  private handleCodexEvent(sessionId: string, eventName: string, timestamp: string, rawPayload: string) {
    const session = this.sessions.get(sessionId)
    if (!session) return

    this.stmtInsertEvent.run(
      sessionId,
      eventName,
      null, // notification_type
      null, // tool_name
      null, // subagent_id
      timestamp,
      rawPayload
    )

    // User/agent messages are concrete Codex activity signals and should refresh session liveness.
    if (eventName === 'user_message' || eventName === 'agent_message') {
      session.state = 'active'
      session.last_activity = timestamp
      this.persistAndBroadcast(session)
    }
  }

  handleCodexHookEvent(payload: HookEventPayload): Session {
    const now = payload.timestamp || new Date().toISOString()
    const sid = payload.session_id

    let session = this.sessions.get(sid)
    const isNew = !session
    if (!session) {
      session = this.createSession(sid, payload.cwd || '', payload.transcript_path, now, 'codex')
    }

    if (payload.cwd) session.cwd = payload.cwd
    if (!isNew && payload.transcript_path && session.transcript_path !== payload.transcript_path) {
      session.transcript_path = payload.transcript_path
    }
    session.display_name = this.makeDisplayName(session.cwd, sid, session.alias)

    this.stmtInsertEvent.run(
      sid,
      payload.hook_event_name,
      payload.notification_type || null,
      payload.tool_name || null,
      payload.subagent_id || null,
      now,
      JSON.stringify(payload)
    )

    if (payload.hook_event_name === 'SessionStart') {
      session.state = 'active'
      session.last_activity = now
    } else if (payload.hook_event_name === 'Stop') {
      session.state = 'inactive'
      session.last_activity = now
    }

    this.persistAndBroadcast(session)
    return session
  }

  // ─── Handle incoming hook event (Claude Code) ───

  handleEvent(payload: HookEventPayload): Session {
    const now = payload.timestamp || new Date().toISOString()
    const sid = payload.session_id

    // Ensure session exists
    let session = this.sessions.get(sid)
    let isNew = false
    if (!session) {
      session = this.createSession(sid, payload.cwd || '', payload.transcript_path, now, 'claude')
      isNew = true
    }

    // Auto-inherit pin & alias from predecessor on context-clear handoff
    if (isNew && payload.hook_event_name === 'SessionStart') {
      this.tryInheritFromPredecessor(session, now)
    }

    // Update cwd/transcript if provided
    if (payload.cwd) session.cwd = payload.cwd
    if (payload.transcript_path) {
      const prevPath = session.transcript_path
      session.transcript_path = payload.transcript_path
      // Start transcript watching for new sessions, or update if path changed
      if (isNew || prevPath !== payload.transcript_path) {
        this.transcriptWatcher.updatePath(sid, payload.transcript_path)
      }
    }
    session.display_name = this.makeDisplayName(session.cwd, sid, session.alias)

    // Persist event
    this.stmtInsertEvent.run(
      sid,
      payload.hook_event_name,
      payload.notification_type || null,
      payload.tool_name || null,
      payload.subagent_id || null,
      now,
      JSON.stringify(payload)
    )

    // Update runtime state
    const prevState = session.state
    this.applyEvent(session, payload, now)

    // Persist session state
    this.persistAndBroadcast(session)

    return session
  }

  // ─── State machine (Claude Code events) ───

  private applyEvent(session: Session, payload: HookEventPayload, timestamp: string) {
    const event = payload.hook_event_name

    // Ended is terminal — except SessionStart(resume|compact) can resurrect a session.
    // This happens when: /resume, --continue, or auto context-compaction restarts the same session_id.
    if (session.state === 'ended') {
      if (event === 'SessionStart' && payload.matcher !== 'startup') {
        // 'resume', 'compact', 'clear' — same session continuing
        session.state = 'active'
        session.last_activity = timestamp
        session.active_tools = 0
        session.active_subagents = 0
        // Ensure transcript watcher is running for the resumed session
        if (session.transcript_path) {
          this.transcriptWatcher.updatePath(session.session_id, session.transcript_path)
        }
      }
      return
    }

    // Track activity time for progress events
    if (PROGRESS_EVENTS.has(event) || event === 'SessionStart') {
      session.last_activity = timestamp
    }

    switch (event) {
      case 'SessionEnd':
        session.state = 'ended'
        session.last_activity = timestamp
        session.active_tools = 0
        session.active_subagents = 0
        break

      case 'PermissionRequest':
        session.state = 'waiting_permission'
        session.last_activity = timestamp
        break

      case 'Notification':
        if (
          payload.notification_type === 'elicitation_dialog' ||
          payload.notification_type === 'idle_prompt'
        ) {
          session.state = 'waiting_user'
        } else if (payload.notification_type === 'permission_prompt') {
          session.state = 'waiting_permission'
        }
        session.last_activity = timestamp
        break

      case 'PreToolUse':
        session.active_tools++
        session.state = 'active'
        session.last_activity = timestamp
        break

      case 'PostToolUse':
      case 'PostToolUseFailure':
        session.active_tools = Math.max(0, session.active_tools - 1)
        session.state = 'active'
        session.last_activity = timestamp
        break

      case 'SubagentStart':
        session.active_subagents++
        session.state = 'active'
        session.last_activity = timestamp
        break

      case 'SubagentStop':
        session.active_subagents = Math.max(0, session.active_subagents - 1)
        session.state = 'active'
        session.last_activity = timestamp
        break

      case 'SessionStart':
        session.state = 'active'
        session.last_activity = timestamp
        break

      case 'Stop':
        // Stop is a weak signal, update activity time but don't change state on its own
        session.last_activity = timestamp
        break
    }
  }

  // ─── Idle check (runs periodically) ───

  private startIdleChecker() {
    this.idleTimer = setInterval(() => {
      const now = Date.now()
      for (const session of this.sessions.values()) {
        if (session.state === 'ended') continue
        if (session.state === 'waiting_permission' || session.state === 'waiting_user') continue
        if (session.active_tools > 0 || session.active_subagents > 0) continue

        const elapsed = now - new Date(session.last_activity).getTime()

        // active/inactive → idle (after IDLE_THRESHOLD_MS)
        if (elapsed >= IDLE_THRESHOLD_MS && session.state !== 'idle') {
          session.state = 'idle'
          this.persistAndBroadcast(session)
          continue
        }

        // idle → ended (after CODEX_ENDED_THRESHOLD_MS, Codex only)
        if (session.state === 'idle' && session.source === 'codex' && elapsed >= CODEX_ENDED_THRESHOLD_MS) {
          session.state = 'ended'
          this.persistAndBroadcast(session)
        }
      }
    }, 10_000) // Check every 10s
  }

  // ─── Insight management ───

  addInsight(sessionId: string, content: string, source: 'transcript' | 'hook' | 'user' = 'transcript'): Insight | null {
    const session = this.sessions.get(sessionId)
    if (!session) return null

    // DB-level dedup: skip if identical content already exists for this session+source
    if (this.stmtCheckInsightExists.get(sessionId, content, source)) return null

    const now = new Date().toISOString()
    const result = this.stmtInsertInsight.run(sessionId, content, now, source)

    const insight: Insight = {
      id: Number(result.lastInsertRowid),
      session_id: sessionId,
      content,
      timestamp: now,
      source,
    }

    // Prepend (newest first)
    session.insights.unshift(insight)
    session.total_insights += 1
    if (session.insights.length > 200) {
      session.insights.length = 200
    }

    // PRD §10.6: a new transcript insight is a real progress signal — resolve waiting
    if (source === 'transcript' && (session.state === 'waiting_user' || session.state === 'waiting_permission')) {
      session.state = 'active'
      session.last_activity = now
      this.persistAndBroadcast(session)
    }

    this.broadcast({ type: 'new_insight', session_id: sessionId, insight })
    return insight
  }

  // ─── Queries ───

  getAllSessions(): Session[] {
    return Array.from(this.sessions.values()).map(s => this.slimSession(s))
  }

  getSession(sessionId: string): Session | undefined {
    const session = this.sessions.get(sessionId)
    return session ? this.slimSession(session) : undefined
  }

  getSessionEvents(sessionId: string, limit?: number, offset?: number): SessionEvent[] {
    if (limit != null) {
      return this.stmtGetEventsPaged.all(sessionId, limit, offset ?? 0) as SessionEvent[]
    }
    return this.stmtGetEvents.all(sessionId) as SessionEvent[]
  }

  getSessionEventsCount(sessionId: string): number {
    const row = this.stmtGetEventsCount.get(sessionId) as { count: number }
    return row.count
  }

  getSessionInsights(sessionId: string, limit: number, offset: number, excludeSource?: string): Insight[] {
    if (excludeSource) {
      return this.db.prepare(
        `SELECT * FROM insights WHERE session_id = ? AND source != ? ORDER BY timestamp DESC LIMIT ? OFFSET ?`
      ).all(sessionId, excludeSource, limit, offset) as Insight[]
    }
    return this.stmtGetInsightsPaged.all(sessionId, limit, offset) as Insight[]
  }

  getSessionInsightsTotal(sessionId: string, excludeSource?: string): number {
    if (excludeSource) {
      const row = this.db.prepare(
        'SELECT COUNT(*) as count FROM insights WHERE session_id = ? AND source != ?'
      ).get(sessionId, excludeSource) as { count: number }
      return row.count
    }
    const session = this.sessions.get(sessionId)
    return session ? session.total_insights : 0
  }

  getSessionCount(): number {
    return this.sessions.size
  }

  setSessionAlias(sessionId: string, alias: string): Session | null {
    const session = this.sessions.get(sessionId)
    if (!session) return null

    session.alias = alias.trim()
    session.display_name = this.makeDisplayName(session.cwd, sessionId, session.alias)
    this.stmtSetAlias.run(session.alias, sessionId)
    this.broadcast({ type: 'session_update', data: this.slimSession(session) })

    return this.slimSession(session)
  }

  setSessionPinned(sessionId: string, pinned: boolean): Session | null {
    const session = this.sessions.get(sessionId)
    if (!session) return null

    session.pinned = pinned
    this.stmtSetPinned.run(pinned ? 1 : 0, sessionId)
    this.broadcast({ type: 'session_pin_update', session_id: sessionId, pinned })

    return session
  }

  // ─── Helpers ───

  private createSession(
    sessionId: string,
    cwd: string,
    transcriptPath: string | undefined,
    timestamp: string,
    source: 'claude' | 'codex' = 'claude'
  ): Session {
    const session: Session = {
      session_id: sessionId,
      display_name: this.makeDisplayName(cwd, sessionId),
      cwd,
      transcript_path: transcriptPath,
      state: 'active',
      last_activity: timestamp,
      created_at: timestamp,
      alias: '',
      pinned: false,
      source,
      insights: [],
      total_insights: 0,
      active_tools: 0,
      active_subagents: 0,
    }

    this.stmtInsertSession.run(
      sessionId,
      cwd,
      transcriptPath || '',
      'active',
      timestamp,
      timestamp,
      source
    )

    this.sessions.set(sessionId, session)

    // Start transcript watcher immediately for new Claude sessions
    if (source === 'claude' && transcriptPath) {
      this.transcriptWatcher.watch(sessionId, transcriptPath)
    }

    return session
  }

  private persistAndBroadcast(session: Session) {
    this.stmtUpdateSession.run(
      session.state,
      session.last_activity,
      session.cwd,
      session.transcript_path || '',
      session.session_id
    )
    this.broadcast({ type: 'session_update', data: this.slimSession(session) })
  }

  // ─── Session handoff (context-clear auto-inheritance) ───

  private findPredecessor(cwd: string, timestamp: string, source: 'claude' | 'codex'): Session | null {
    const MAX_GAP_MS = 1_000 // Context-clear handoff is near-instant (< 200ms in practice)
    const now = new Date(timestamp).getTime()
    let best: Session | null = null
    let bestTime = 0

    for (const s of this.sessions.values()) {
      if (s.state !== 'ended') continue
      if (s.source !== source) continue
      if (s.cwd !== cwd) continue
      if (!s.pinned && !s.alias) continue

      const endedAt = new Date(s.last_activity).getTime()
      const gap = now - endedAt
      if (gap < 0 || gap > MAX_GAP_MS) continue

      if (endedAt > bestTime) {
        best = s
        bestTime = endedAt
      }
    }
    return best
  }

  private tryInheritFromPredecessor(session: Session, timestamp: string) {
    const predecessor = this.findPredecessor(session.cwd, timestamp, session.source)
    if (!predecessor) return

    // Inherit pin
    if (predecessor.pinned) {
      session.pinned = true
      this.stmtSetPinned.run(1, session.session_id)
    }

    // Inherit alias
    if (predecessor.alias) {
      session.alias = predecessor.alias
      session.display_name = this.makeDisplayName(session.cwd, session.session_id, session.alias)
      this.stmtSetAlias.run(session.alias, session.session_id)
    }

    // Record predecessor link
    session.predecessor_id = predecessor.session_id
    this.stmtSetPredecessor.run(predecessor.session_id, session.session_id)

    // Unpin predecessor to avoid duplicate columns on the board
    if (predecessor.pinned) {
      predecessor.pinned = false
      this.stmtSetPinned.run(0, predecessor.session_id)
      this.broadcast({ type: 'session_pin_update', session_id: predecessor.session_id, pinned: false })
    }

    console.log(
      `[session-manager] Handoff: ${predecessor.session_id.slice(0, 8)} → ${session.session_id.slice(0, 8)}` +
      ` (pinned=${session.pinned}, alias="${session.alias}")`
    )
  }

  private makeDisplayName(cwd: string, sessionId: string, alias?: string): string {
    if (alias) return alias
    const base = cwd ? basename(cwd) : 'unknown'
    const short = sessionId.slice(0, 4)
    return `${base} · ${short}`
  }

  destroy() {
    if (this.idleTimer) clearInterval(this.idleTimer)
    this.transcriptWatcher.unwatchAll()
    this.codexWatcher?.stop()
  }
}
