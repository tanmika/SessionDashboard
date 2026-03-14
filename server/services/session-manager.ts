import type Database from 'better-sqlite3'
import { basename } from 'path'
import type {
  HookEventPayload,
  Session,
  SessionState,
  SessionEvent,
  Insight,
  WsMessage,
} from '../../shared/types.js'
import { IDLE_THRESHOLD_MS, STATE_PRIORITY } from '../../shared/types.js'
import { TranscriptWatcher } from './transcript-watcher.js'

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

  // Prepared statements
  private stmtInsertSession: Database.Statement
  private stmtUpdateSession: Database.Statement
  private stmtSetPinned: Database.Statement
  private stmtInsertEvent: Database.Statement
  private stmtInsertInsight: Database.Statement
  private stmtGetSessions: Database.Statement
  private stmtGetEvents: Database.Statement
  private stmtGetInsights: Database.Statement

  constructor(private db: Database.Database) {
    this.transcriptWatcher = new TranscriptWatcher((sessionId, content) => {
      this.addInsight(sessionId, content, 'transcript')
    })

    // Prepare statements
    this.stmtInsertSession = db.prepare(`
      INSERT OR IGNORE INTO sessions (session_id, cwd, transcript_path, state, last_activity, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    this.stmtUpdateSession = db.prepare(`
      UPDATE sessions SET state = ?, last_activity = ?, cwd = ?, transcript_path = ?
      WHERE session_id = ?
    `)
    this.stmtSetPinned = db.prepare(`UPDATE sessions SET pinned = ? WHERE session_id = ?`)
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

    this.restoreFromDb()
    this.startIdleChecker()
  }

  setBroadcast(fn: BroadcastFn) {
    this.broadcast = fn
  }

  // ─── Restore sessions from SQLite on startup ───

  private restoreFromDb() {
    const rows = this.stmtGetSessions.all() as any[]
    for (const row of rows) {
      const insights = this.stmtGetInsights.all(row.session_id) as Insight[]
      const session: Session = {
        session_id: row.session_id,
        display_name: this.makeDisplayName(row.cwd, row.session_id),
        cwd: row.cwd,
        transcript_path: row.transcript_path,
        state: row.state as SessionState,
        last_activity: row.last_activity,
        created_at: row.created_at,
        pinned: row.pinned === 1,
        insights,
        active_tools: 0,
        active_subagents: 0,
      }
      this.sessions.set(row.session_id, session)

      // Resume transcript watching for all sessions with a transcript path.
      // Even ended sessions may have their transcript continued (e.g. context-summary resumptions).
      if (row.transcript_path) {
        this.transcriptWatcher.watch(row.session_id, row.transcript_path)
      }
    }
  }

  // ─── Handle incoming hook event ───

  handleEvent(payload: HookEventPayload): Session {
    const now = payload.timestamp || new Date().toISOString()
    const sid = payload.session_id

    // Ensure session exists
    let session = this.sessions.get(sid)
    if (!session) {
      session = this.createSession(sid, payload.cwd || '', payload.transcript_path, now)
    }

    // Update cwd/transcript if provided
    if (payload.cwd) session.cwd = payload.cwd
    if (payload.transcript_path) {
      const prevPath = session.transcript_path
      session.transcript_path = payload.transcript_path
      // Start/update transcript watching when path changes
      if (prevPath !== payload.transcript_path) {
        this.transcriptWatcher.updatePath(sid, payload.transcript_path)
      }
    }
    session.display_name = this.makeDisplayName(session.cwd, sid)

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
    this.stmtUpdateSession.run(
      session.state,
      session.last_activity,
      session.cwd,
      session.transcript_path || '',
      sid
    )

    // Broadcast if state changed or activity updated
    this.broadcast({ type: 'session_update', data: session })

    return session
  }

  // ─── State machine ───

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
        if (elapsed >= IDLE_THRESHOLD_MS && session.state !== 'idle') {
          session.state = 'idle'
          this.stmtUpdateSession.run(
            session.state,
            session.last_activity,
            session.cwd,
            session.transcript_path || '',
            session.session_id
          )
          this.broadcast({ type: 'session_update', data: session })
        }
      }
    }, 10_000) // Check every 10s
  }

  // ─── Insight management ───

  addInsight(sessionId: string, content: string, source: 'transcript' | 'hook' = 'transcript'): Insight | null {
    const session = this.sessions.get(sessionId)
    if (!session) return null

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

    // PRD §10.6: a new transcript insight is a real progress signal — resolve waiting
    if (source === 'transcript' && (session.state === 'waiting_user' || session.state === 'waiting_permission')) {
      session.state = 'active'
      session.last_activity = now
      this.stmtUpdateSession.run(session.state, session.last_activity, session.cwd, session.transcript_path || '', sessionId)
    }

    this.broadcast({ type: 'new_insight', session_id: sessionId, insight })
    return insight
  }

  // ─── Queries ───

  getAllSessions(): Session[] {
    return Array.from(this.sessions.values())
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId)
  }

  getSessionEvents(sessionId: string): SessionEvent[] {
    return this.stmtGetEvents.all(sessionId) as SessionEvent[]
  }

  getSessionCount(): number {
    return this.sessions.size
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
    timestamp: string
  ): Session {
    const session: Session = {
      session_id: sessionId,
      display_name: this.makeDisplayName(cwd, sessionId),
      cwd,
      transcript_path: transcriptPath,
      state: 'active',
      last_activity: timestamp,
      created_at: timestamp,
      pinned: false,
      insights: [],
      active_tools: 0,
      active_subagents: 0,
    }

    this.stmtInsertSession.run(
      sessionId,
      cwd,
      transcriptPath || '',
      'active',
      timestamp,
      timestamp
    )

    this.sessions.set(sessionId, session)

    // Start transcript watcher immediately for new sessions
    if (transcriptPath) {
      this.transcriptWatcher.watch(sessionId, transcriptPath)
    }

    return session
  }

  private makeDisplayName(cwd: string, sessionId: string): string {
    const base = cwd ? basename(cwd) : 'unknown'
    const short = sessionId.slice(0, 4)
    return `${base} · ${short}`
  }

  destroy() {
    if (this.idleTimer) clearInterval(this.idleTimer)
    this.transcriptWatcher.unwatchAll()
  }
}
