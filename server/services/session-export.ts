import { existsSync, readFileSync } from 'fs'
import type Database from 'better-sqlite3'
import type {
  SessionExportData,
  SessionExportDepth,
  SessionExportFailure,
  SessionExportMessage,
  SessionExportMissingSession,
  SessionExportMode,
  SessionTranscriptRecord,
} from '../../shared/types.js'
import { isInTimeRange, type TimeRange } from '../../shared/time-range.js'

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

export interface ExportSession {
  session_id: string
  display_name: string
  cwd: string
  transcript_path: string
  created_at: string
  source: 'claude' | 'codex'
  predecessor_id?: string
}

type ExportResult =
  | { ok: true; data: SessionExportData }
  | { ok: false; error: SessionExportFailure }

type ReadableTranscriptResult =
  | { ok: true; content: string }
  | { ok: false; missing: SessionExportMissingSession }

type ClaudeContentBlock = { role: 'agent' | 'tool'; text: string }

export interface ExportOptions {
  sessionId: string
  mode?: SessionExportMode
  depth?: SessionExportDepth
  range?: TimeRange
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
    created_at: row.created_at,
    source: row.source,
    predecessor_id: row.predecessor_id || undefined,
  }
}

function normalizeDepth(depth: SessionExportDepth | undefined): SessionExportDepth {
  if (depth === 'all') return depth
  if (typeof depth !== 'number' || Number.isNaN(depth)) return 1
  return Math.max(0, Math.floor(depth))
}

export function resolveSession(db: Database.Database, sessionId: string): ExportSession | SessionExportFailure {
  const exact = resolveExactSession(db, sessionId)
  if (!('error' in exact)) {
    return exact
  }

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

export function resolveExactSession(db: Database.Database, sessionId: string): ExportSession | SessionExportFailure {
  const row = db.prepare(
    `SELECT session_id, cwd, transcript_path, state, last_activity, created_at, alias, pinned, source, predecessor_id
     FROM sessions
     WHERE session_id = ?`
  ).get(sessionId) as SessionRow | undefined
  if (!row) {
    return {
      error: 'session_not_found',
      message: `Session "${sessionId}" not found.`,
    }
  }
  return normalizeSession(row)
}

function resolveSessionChain(
  db: Database.Database,
  start: ExportSession,
  depth: SessionExportDepth
): ExportSession[] | SessionExportFailure {
  const chain = [start]
  let current = start
  let remaining = depth === 'all' ? Number.POSITIVE_INFINITY : depth
  const visited = new Set([start.session_id])

  while (remaining > 0 && current.predecessor_id) {
    if (visited.has(current.predecessor_id)) {
      return {
        error: 'invalid_chain',
        message: `Detected a predecessor cycle while exporting session "${start.session_id}".`,
      }
    }
    const row = db.prepare(
      `SELECT session_id, cwd, transcript_path, state, last_activity, created_at, alias, pinned, source, predecessor_id
       FROM sessions WHERE session_id = ?`
    ).get(current.predecessor_id) as SessionRow | undefined
    if (!row) break
    current = normalizeSession(row)
    visited.add(current.session_id)
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

function isConversationControlText(text: string): boolean {
  const trimmed = text.trim()
  return (
    trimmed === '[Request interrupted by user]' ||
    trimmed.startsWith('<command-name>') ||
    trimmed.startsWith('<local-command-caveat>')
  )
}

function readTranscript(session: ExportSession): ReadableTranscriptResult {
  if (!session.transcript_path) {
    return {
      ok: false,
      missing: {
        session_id: session.session_id,
        display_name: session.display_name,
        source: session.source,
        transcript_path: session.transcript_path,
        reason: 'No transcript path recorded.',
      },
    }
  }
  if (!existsSync(session.transcript_path)) {
    return {
      ok: false,
      missing: {
        session_id: session.session_id,
        display_name: session.display_name,
        source: session.source,
        transcript_path: session.transcript_path,
        reason: 'Transcript file does not exist.',
      },
    }
  }
  try {
    return {
      ok: true,
      content: readFileSync(session.transcript_path, 'utf-8'),
    }
  } catch {
    return {
      ok: false,
      missing: {
        session_id: session.session_id,
        display_name: session.display_name,
        source: session.source,
        transcript_path: session.transcript_path,
        reason: 'Transcript file could not be read.',
      },
    }
  }
}

function parseClaudeConversation(session: ExportSession, raw: string): SessionExportMessage[] {
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
      if (!text || isConversationControlText(text)) continue
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

function parseCodexConversation(session: ExportSession, raw: string): SessionExportMessage[] {
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
      if (!text || isConversationControlText(text)) continue
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

function pushTranscriptRecord(records: SessionTranscriptRecord[], record: SessionTranscriptRecord) {
  const text = record.text.trim()
  if (!text) return
  records.push({ ...record, text })
}

function extractClaudeToolText(content: unknown): string {
  return extractClaudeContentBlocks(content)
    .filter((block) => block.role === 'tool')
    .map((block) => block.text)
    .join('\n\n')
    .trim()
}

function extractClaudeContentBlocks(content: unknown): ClaudeContentBlock[] {
  if (typeof content === 'string') {
    const text = content.trim()
    return text ? [{ role: 'agent', text }] : []
  }
  if (!Array.isArray(content)) return []
  const result: ClaudeContentBlock[] = []
  for (const block of content
    .filter((block): block is Record<string, unknown> => typeof block === 'object' && block !== null)
  ) {
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = block.text.trim()
      if (text) result.push({ role: 'agent', text })
      continue
    }
    if (block.type === 'tool_use') {
      const name = typeof block.name === 'string' ? block.name : 'tool'
      const input = 'input' in block ? JSON.stringify(block.input, null, 2) : ''
      result.push({ role: 'tool', text: `tool_use: ${name}${input ? `\n${input}` : ''}` })
      continue
    }
    if (block.type === 'tool_result') {
      const toolResult = typeof block.content === 'string'
        ? block.content
        : JSON.stringify(block.content, null, 2)
      result.push({ role: 'tool', text: `tool_result:\n${toolResult}` })
    }
  }
  return result
}

function parseClaudeTranscriptRecords(session: ExportSession, raw: string): SessionTranscriptRecord[] {
  const records: SessionTranscriptRecord[] = []

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
      const blocks = extractClaudeContentBlocks(record.message?.content)
      for (const block of blocks) {
        if (block.role === 'agent' && isConversationControlText(block.text)) continue
        pushTranscriptRecord(records, {
          session_id: session.session_id,
          timestamp: record.timestamp || session.created_at,
          role: block.role === 'tool' ? 'tool' : 'user',
          text: block.text,
        })
      }
      continue
    }

    if (record.type === 'assistant') {
      const blocks = extractClaudeContentBlocks(record.message?.content)
      for (const block of blocks) {
        pushTranscriptRecord(records, {
          session_id: session.session_id,
          timestamp: record.timestamp || session.created_at,
          role: block.role,
          text: block.text,
        })
      }
    }
  }

  return records
}

function formatCodexToolRecord(payload: Record<string, unknown>, label = 'tool'): string {
  const parts: string[] = []
  const toolName = typeof payload.tool_name === 'string'
    ? payload.tool_name
    : typeof payload.name === 'string'
      ? payload.name
      : ''
  parts.push(toolName ? `${label}: ${toolName}` : label)
  if (typeof payload.call_id === 'string') parts.push(`call_id: ${payload.call_id}`)
  if (typeof payload.arguments === 'string') {
    parts.push(`arguments:\n${payload.arguments}`)
  } else if ('arguments' in payload) {
    parts.push(`arguments:\n${JSON.stringify(payload.arguments, null, 2)}`)
  }
  if ('input' in payload) parts.push(`input:\n${JSON.stringify(payload.input, null, 2)}`)
  if ('output' in payload) {
    parts.push(typeof payload.output === 'string'
      ? `output:\n${payload.output}`
      : `output:\n${JSON.stringify(payload.output, null, 2)}`)
  }
  if ('result' in payload) {
    parts.push(typeof payload.result === 'string'
      ? `result:\n${payload.result}`
      : `result:\n${JSON.stringify(payload.result, null, 2)}`)
  }
  return parts.join('\n\n').trim()
}

function extractCodexResponseMessageText(payload: Record<string, unknown>): string {
  const content = payload.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is Record<string, unknown> => typeof block === 'object' && block !== null)
    .map((block) => {
      if (typeof block.text === 'string') return block.text
      if (typeof block.input_text === 'string') return block.input_text
      if (typeof block.output_text === 'string') return block.output_text
      return ''
    })
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

function parseCodexTranscriptRecords(session: ExportSession, raw: string): SessionTranscriptRecord[] {
  const records: SessionTranscriptRecord[] = []

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    let record: any
    try {
      record = JSON.parse(trimmed)
    } catch {
      continue
    }

    const timestamp = record.timestamp || session.created_at
    const payload = record.payload as Record<string, unknown>

    if (record.type === 'response_item' && payload) {
      if (payload.type === 'message') {
        const role = payload.role === 'user' ? 'user' : payload.role === 'assistant' ? 'agent' : undefined
        const text = extractCodexResponseMessageText(payload)
        if (role && text && !isConversationControlText(text)) {
          pushTranscriptRecord(records, {
            session_id: session.session_id,
            timestamp,
            role,
            text,
          })
        }
        continue
      }

      if (payload.type === 'function_call') {
        pushTranscriptRecord(records, {
          session_id: session.session_id,
          timestamp,
          role: 'tool',
          text: formatCodexToolRecord(payload, 'function_call'),
        })
        continue
      }

      if (payload.type === 'function_call_output') {
        pushTranscriptRecord(records, {
          session_id: session.session_id,
          timestamp,
          role: 'tool',
          text: formatCodexToolRecord(payload, 'function_call_output'),
        })
        continue
      }
    }

    if (record.type !== 'event_msg' || !payload) continue

    if (payload.type === 'user_message') {
      const text = String(payload.message || '').trim()
      if (text && !isConversationControlText(text)) {
        pushTranscriptRecord(records, {
          session_id: session.session_id,
          timestamp,
          role: 'user',
          text,
        })
      }
      continue
    }

    if (payload.type === 'agent_message') {
      pushTranscriptRecord(records, {
        session_id: session.session_id,
        timestamp,
        role: 'agent',
        text: String(payload.message || payload.last_agent_message || ''),
      })
      continue
    }

    if (payload.type === 'task_complete' && payload.last_agent_message) {
      pushTranscriptRecord(records, {
        session_id: session.session_id,
        timestamp,
        role: 'agent',
        text: String(payload.last_agent_message),
      })
      continue
    }

    const payloadType = typeof payload.type === 'string' ? payload.type : ''
    if (payloadType.includes('tool')) {
      const toolText = formatCodexToolRecord(payload)
      if (toolText) {
        pushTranscriptRecord(records, {
          session_id: session.session_id,
          timestamp,
          role: 'tool',
          text: toolText,
        })
      }
    }
  }

  return records
}

export function readSessionTranscriptRecords(session: ExportSession): {
  ok: true
  records: SessionTranscriptRecord[]
} | {
  ok: false
  error: SessionExportFailure
} {
  const transcript = readTranscript(session)
  if (!transcript.ok) {
    return {
      ok: false,
      error: {
        error: 'missing_transcript',
        message: `Session "${session.session_id}" does not have a readable transcript file.`,
        missing_sessions: [transcript.missing],
      },
    }
  }

  return {
    ok: true,
    records: session.source === 'claude'
      ? parseClaudeTranscriptRecords(session, transcript.content)
      : parseCodexTranscriptRecords(session, transcript.content),
  }
}

function formatRangeLine(range: TimeRange | undefined): string | undefined {
  if (!range) return undefined
  return `Range: ${range.since || '(beginning)'} to ${range.until || '(open)'}`
}

function formatConversationExport(sessions: ExportSession[], messages: SessionExportMessage[], range?: TimeRange): string {
  const messagesBySession = new Map<string, SessionExportMessage[]>()
  for (const message of messages) {
    const bucket = messagesBySession.get(message.session_id) ?? []
    bucket.push(message)
    messagesBySession.set(message.session_id, bucket)
  }

  const sections: string[] = []
  const rangeLine = formatRangeLine(range)
  for (const session of sessions) {
    sections.push(
      `===== Session ${session.display_name} (${session.session_id}) =====`,
      `Source: ${session.source}`,
      `CWD: ${session.cwd}`,
      `Transcript: ${session.transcript_path || '(missing)'}`,
      ...(rangeLine ? [rangeLine] : []),
      ''
    )

    const sessionMessages = messagesBySession.get(session.session_id) ?? []
    if (sessionMessages.length === 0) {
      sections.push(range ? '[No exportable conversation messages found in selected range]' : '[No exportable conversation messages found]', '')
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

function formatInsightExport(db: Database.Database, sessions: ExportSession[], range?: TimeRange): { content: string; itemCount: number } {
  const ids = sessions.map((session) => session.session_id)
  const placeholders = ids.map(() => '?').join(',')
  const rangeClauses: string[] = []
  const rangeParams: string[] = []
  if (range?.since) {
    rangeClauses.push('timestamp >= ?')
    rangeParams.push(range.since)
  }
  if (range?.until) {
    rangeClauses.push('timestamp < ?')
    rangeParams.push(range.until)
  }
  const rows = db.prepare(
    `SELECT id, content, timestamp, source, session_id
     FROM insights
     WHERE session_id IN (${placeholders})
     ${rangeClauses.length > 0 ? `AND ${rangeClauses.join(' AND ')}` : ''}
     ORDER BY timestamp ASC, id ASC`
  ).all(...ids, ...rangeParams) as Array<{
    id: number
    content: string
    timestamp: string
    source: 'transcript' | 'hook' | 'user'
    session_id: string
  }>

  const sessionsById = new Map(sessions.map((session) => [session.session_id, session]))
  const sections: string[] = []
  let currentSessionId: string | null = null
  const rangeLine = formatRangeLine(range)

  for (const row of rows) {
    if (row.session_id !== currentSessionId) {
      const session = sessionsById.get(row.session_id)
      if (session) {
        if (sections.length > 0) sections.push('')
        sections.push(
          `===== Session ${session.display_name} (${session.session_id}) =====`,
          `Source: ${session.source}`,
          `CWD: ${session.cwd}`,
          ...(rangeLine ? [rangeLine] : []),
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
    sections.push(range ? '[No insights found in selected range]' : '[No insights found]', '')
  }

  return {
    content: sections.join('\n').trimEnd() + '\n',
    itemCount: rows.length,
  }
}

function makeFilename(session: ExportSession, mode: SessionExportMode): string {
  const safeId = session.session_id.slice(0, 12)
  return `${session.display_name.replace(/[^\w.-]+/g, '_') || safeId}-${mode}.txt`
}

export function exportSessionText(db: Database.Database, options: ExportOptions): ExportResult {
  const mode = options.mode ?? 'conversation'
  const depth = normalizeDepth(options.depth)
  const range = options.range
  const resolved = resolveSession(db, options.sessionId)
  if ('error' in resolved) {
    return { ok: false, error: resolved }
  }

  const chain = resolveSessionChain(db, resolved, depth)
  if ('error' in chain) {
    return { ok: false, error: chain }
  }

  if (mode === 'conversation') {
    const messages: SessionExportMessage[] = []
    for (const session of chain) {
      const transcript = readTranscript(session)
      if (!transcript.ok) {
        return {
          ok: false,
          error: {
            error: 'missing_transcript',
            message: 'One or more sessions in the selected chain do not have readable transcript files.',
            missing_sessions: [transcript.missing],
          },
        }
      }
      const parsed = (
        session.source === 'claude'
          ? parseClaudeConversation(session, transcript.content)
          : parseCodexConversation(session, transcript.content)
      )
      messages.push(...parsed.filter((message) => isInTimeRange(message.timestamp, range)))
    }

    return {
      ok: true,
      data: {
        mode,
        depth,
        content: formatConversationExport(chain, messages, range),
        filename: makeFilename(resolved, mode),
        session_count: chain.length,
        item_count: messages.length,
        ...(range ? { range } : {}),
      },
    }
  }

  const insightExport = formatInsightExport(db, chain, range)

  return {
    ok: true,
    data: {
      mode,
      depth,
      content: insightExport.content,
      filename: makeFilename(resolved, mode),
      session_count: chain.length,
      item_count: insightExport.itemCount,
      ...(range ? { range } : {}),
    },
  }
}
