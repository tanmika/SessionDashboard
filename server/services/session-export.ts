import { existsSync, readFileSync } from 'fs'
import type Database from 'better-sqlite3'
import type {
  SessionExportData,
  SessionExportDepth,
  SessionExportFailure,
  SessionExportMessage,
  SessionExportMissingSession,
  SessionExportMode,
} from '../../shared/types.js'
import { isUserInputNoise } from '../utils/insight-extractor.js'

interface SessionRow {
  session_id: string
  cwd: string
  transcript_path: string
  state: string
  last_activity: string
  created_at: string
  alias: string
  pinned: number
  source: 'claude' | 'codex'
  predecessor_id: string
}

interface ExportSession {
  session_id: string
  display_name: string
  cwd: string
  transcript_path: string
  source: 'claude' | 'codex'
  predecessor_id?: string
}

type ExportResult =
  | { ok: true; data: SessionExportData }
  | { ok: false; error: SessionExportFailure }

export interface ExportOptions {
  sessionId: string
  mode?: SessionExportMode
  depth?: SessionExportDepth
}

const stmtFindSessionsSql = `
  SELECT session_id, cwd, transcript_path, state, last_activity, created_at, alias, pinned, source, predecessor_id
  FROM sessions
  WHERE session_id = ? OR session_id LIKE ?
  ORDER BY last_activity DESC
`

function makeDisplayName(row: SessionRow): string {
  if (row.alias) return row.alias
  const parts = row.cwd.split('/').filter(Boolean)
  const base = parts[parts.length - 1] || 'unknown'
  return `${base} · ${row.session_id.slice(0, 4)}`
}

function normalizeSession(row: SessionRow): ExportSession {
  return {
    session_id: row.session_id,
    display_name: makeDisplayName(row),
    cwd: row.cwd,
    transcript_path: row.transcript_path,
    source: row.source,
    predecessor_id: row.predecessor_id || undefined,
  }
}

function normalizeDepth(depth: SessionExportDepth | undefined): SessionExportDepth {
  if (depth === 'all') return depth
  if (typeof depth !== 'number' || Number.isNaN(depth)) return 1
  return Math.max(0, Math.floor(depth))
}

function resolveSession(db: Database.Database, sessionId: string): ExportSession | SessionExportFailure {
  const matches = db.prepare(stmtFindSessionsSql).all(sessionId, `${sessionId}%`) as SessionRow[]
  if (matches.length === 0) {
    return {
      error: 'session_not_found',
      message: `Session "${sessionId}" not found.`,
    }
  }
  if (matches.length > 1 && matches[0].session_id !== sessionId) {
    return {
      error: 'ambiguous_session',
      message: `Session prefix "${sessionId}" matched multiple sessions.`,
      matching_sessions: matches.slice(0, 10).map((row) => ({
        session_id: row.session_id,
        display_name: makeDisplayName(row),
        source: row.source,
      })),
    }
  }
  return normalizeSession(matches[0])
}

function resolveSessionChain(
  db: Database.Database,
  start: ExportSession,
  depth: SessionExportDepth
): ExportSession[] {
  const chain = [start]
  let current = start
  let remaining = depth === 'all' ? Number.POSITIVE_INFINITY : depth

  while (remaining > 0 && current.predecessor_id) {
    const row = db.prepare(
      `SELECT session_id, cwd, transcript_path, state, last_activity, created_at, alias, pinned, source, predecessor_id
       FROM sessions WHERE session_id = ?`
    ).get(current.predecessor_id) as SessionRow | undefined
    if (!row) break
    current = normalizeSession(row)
    chain.push(current)
    if (depth !== 'all') remaining -= 1
  }

  return chain.reverse()
}

function extractClaudeText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const text = content
    .filter((block): block is { type?: string; text?: string } => typeof block === 'object' && block !== null)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text!.trim())
    .filter(Boolean)
    .join('\n\n')
  return text.trim()
}

function parseClaudeConversation(session: ExportSession): SessionExportMessage[] {
  const raw = readFileSync(session.transcript_path, 'utf-8')
  const messages: SessionExportMessage[] = []

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    let record: any
    try {
      record = JSON.parse(trimmed)
    } catch {
      continue
    }

    if (record.type === 'user') {
      if (record.isMeta) continue
      const text = extractClaudeText(record.message?.content)
      if (!text || isUserInputNoise(text)) continue
      messages.push({
        session_id: session.session_id,
        timestamp: record.timestamp || session.created_at,
        role: 'user',
        text,
      })
      continue
    }

    if (record.type === 'assistant') {
      const text = extractClaudeText(record.message?.content)
      if (!text) continue
      messages.push({
        session_id: session.session_id,
        timestamp: record.timestamp || session.created_at,
        role: 'agent',
        text,
      })
    }
  }

  return messages.sort((a, b) => (
    a.timestamp.localeCompare(b.timestamp) ||
    (a.role === b.role ? 0 : a.role === 'user' ? -1 : 1)
  ))
}

function parseCodexConversation(session: ExportSession): SessionExportMessage[] {
  const raw = readFileSync(session.transcript_path, 'utf-8')
  const messages: SessionExportMessage[] = []
  const pushAgentMessage = (timestamp: string, text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    const previous = messages[messages.length - 1]
    if (
      previous &&
      previous.role === 'agent' &&
      previous.timestamp === timestamp &&
      previous.text === trimmed
    ) {
      return
    }
    messages.push({
      session_id: session.session_id,
      timestamp,
      role: 'agent',
      text: trimmed,
    })
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    let record: any
    try {
      record = JSON.parse(trimmed)
    } catch {
      continue
    }

    if (record.type !== 'event_msg' || !record.payload) continue

    if (record.payload.type === 'user_message') {
      const text = String(record.payload.message || '').trim()
      if (!text || isUserInputNoise(text)) continue
      messages.push({
        session_id: session.session_id,
        timestamp: record.timestamp || session.created_at,
        role: 'user',
        text,
      })
      continue
    }

    if (record.payload.type === 'agent_message') {
      pushAgentMessage(
        record.timestamp || session.created_at,
        String(record.payload.message || record.payload.last_agent_message || '')
      )
      continue
    }

    if (record.payload.type === 'task_complete' && record.payload.last_agent_message) {
      pushAgentMessage(
        record.timestamp || session.created_at,
        String(record.payload.last_agent_message)
      )
    }
  }

  return messages.sort((a, b) => (
    a.timestamp.localeCompare(b.timestamp) ||
    (a.role === b.role ? 0 : a.role === 'user' ? -1 : 1)
  ))
}

function collectMissingSessions(sessions: ExportSession[]): SessionExportMissingSession[] {
  return sessions.flatMap((session) => {
    if (!session.transcript_path) {
      return [{
        session_id: session.session_id,
        display_name: session.display_name,
        source: session.source,
        transcript_path: session.transcript_path,
        reason: 'No transcript path recorded.',
      }]
    }
    if (!existsSync(session.transcript_path)) {
      return [{
        session_id: session.session_id,
        display_name: session.display_name,
        source: session.source,
        transcript_path: session.transcript_path,
        reason: 'Transcript file does not exist.',
      }]
    }
    return []
  })
}

function formatConversationExport(sessions: ExportSession[], messages: SessionExportMessage[]): string {
  const messagesBySession = new Map<string, SessionExportMessage[]>()
  for (const message of messages) {
    const bucket = messagesBySession.get(message.session_id) ?? []
    bucket.push(message)
    messagesBySession.set(message.session_id, bucket)
  }

  const sections: string[] = []
  for (const session of sessions) {
    sections.push(
      `===== Session ${session.display_name} (${session.session_id}) =====`,
      `Source: ${session.source}`,
      `CWD: ${session.cwd}`,
      `Transcript: ${session.transcript_path || '(missing)'}`,
      ''
    )

    const sessionMessages = messagesBySession.get(session.session_id) ?? []
    if (sessionMessages.length === 0) {
      sections.push('[No exportable conversation messages found]', '')
      continue
    }

    for (const message of sessionMessages) {
      sections.push(
        `[${message.timestamp}] ${message.role === 'user' ? 'User' : 'Agent'}`,
        message.text,
        ''
      )
    }
  }

  return sections.join('\n').trimEnd() + '\n'
}

function formatInsightExport(db: Database.Database, sessions: ExportSession[]): string {
  const ids = sessions.map((session) => session.session_id)
  const placeholders = ids.map(() => '?').join(',')
  const rows = db.prepare(
    `SELECT id, content, timestamp, source, session_id
     FROM insights
     WHERE session_id IN (${placeholders})
     ORDER BY timestamp ASC, id ASC`
  ).all(...ids) as Array<{
    id: number
    content: string
    timestamp: string
    source: 'transcript' | 'hook' | 'user'
    session_id: string
  }>

  const sessionsById = new Map(sessions.map((session) => [session.session_id, session]))
  const sections: string[] = []
  let currentSessionId: string | null = null

  for (const row of rows) {
    if (row.session_id !== currentSessionId) {
      const session = sessionsById.get(row.session_id)
      if (session) {
        if (sections.length > 0) sections.push('')
        sections.push(
          `===== Session ${session.display_name} (${session.session_id}) =====`,
          `Source: ${session.source}`,
          `CWD: ${session.cwd}`,
          ''
        )
      }
      currentSessionId = row.session_id
    }

    sections.push(
      `[${row.timestamp}] ${row.source === 'user' ? 'User Prompt' : 'Insight'}`,
      row.content,
      ''
    )
  }

  if (sections.length === 0) {
    sections.push('[No insights found]', '')
  }

  return sections.join('\n').trimEnd() + '\n'
}

function makeFilename(session: ExportSession, mode: SessionExportMode): string {
  const safeId = session.session_id.slice(0, 12)
  return `${session.display_name.replace(/[^\w.-]+/g, '_') || safeId}-${mode}.txt`
}

export function exportSessionText(db: Database.Database, options: ExportOptions): ExportResult {
  const mode = options.mode ?? 'conversation'
  const depth = normalizeDepth(options.depth)
  const resolved = resolveSession(db, options.sessionId)
  if ('error' in resolved) {
    return { ok: false, error: resolved }
  }

  const chain = resolveSessionChain(db, resolved, depth)

  if (mode === 'conversation') {
    const missing = collectMissingSessions(chain)
    if (missing.length > 0) {
      return {
        ok: false,
        error: {
          error: 'missing_transcript',
          message: 'One or more sessions in the selected chain do not have readable transcript files.',
          missing_sessions: missing,
        },
      }
    }

    const messages = chain.flatMap((session) => (
      session.source === 'claude'
        ? parseClaudeConversation(session)
        : parseCodexConversation(session)
    ))

    return {
      ok: true,
      data: {
        mode,
        depth,
        content: formatConversationExport(chain, messages),
        filename: makeFilename(resolved, mode),
        session_count: chain.length,
      },
    }
  }

  return {
    ok: true,
    data: {
      mode,
      depth,
      content: formatInsightExport(db, chain),
      filename: makeFilename(resolved, mode),
      session_count: chain.length,
    },
  }
}
