import Database from 'better-sqlite3'
import { existsSync, readFileSync } from 'fs'
import { extractInsightBlocks, sanitizeUserInput } from '../server/utils/insight-extractor.js'
import { generateChainId } from '../shared/chain-id.js'
import { getDbPath } from '../shared/config.js'

type Source = 'claude' | 'codex'
type InsightSource = 'transcript' | 'user'

type CandidateInsight = {
  content: string
  source: InsightSource
  timestamp: string
}

type SessionRow = {
  session_id: string
  source: Source
  transcript_path: string
  created_at: string
  last_activity: string
}

type SessionAnalysis = {
  session: SessionRow
  canonicalLatest: string
  noiseInsightIds: number[]
  timestampFixes: Array<{ id: number; timestamp: string }>
  missingCandidates: CandidateInsight[]
}

function parseArgs() {
  const args = process.argv.slice(2)
  let days = 7
  let dryRun = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--days' && args[i + 1]) {
      days = Number.parseInt(args[i + 1], 10)
      i += 1
    } else if (arg === '--dry-run') {
      dryRun = true
    } else if (arg === '--help') {
      console.log('Usage: tsx scripts/repair-dashboard.ts [--days N] [--dry-run]')
      process.exit(0)
    }
  }

  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`Invalid --days value: ${days}`)
  }

  return { days, dryRun }
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

function maxTimestamp(a: string | null | undefined, b: string | null | undefined): string | null {
  const aMs = parseTimestamp(a)
  const bMs = parseTimestamp(b)
  if (aMs == null) return b ?? null
  if (bMs == null) return a ?? null
  return bMs > aMs ? b! : a!
}

function collectCodexInsights(path: string): CandidateInsight[] {
  const results: CandidateInsight[] = []
  const lines = readFileSync(path, 'utf8').split('\n')

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    try {
      const obj = JSON.parse(trimmed)
      if (obj.type !== 'event_msg') continue

      const payload = obj.payload ?? {}
      const timestamp = obj.timestamp || new Date().toISOString()

      if (payload.type === 'user_message') {
        const sanitized = sanitizeUserInput(payload.message || '', 'codex')
        if (sanitized) {
          results.push({
            content: sanitized,
            source: 'user',
            timestamp,
          })
        }
      }

      if (payload.type === 'agent_message' && payload.phase !== 'commentary') {
        const text = payload.message || payload.last_agent_message || ''
        if (typeof text === 'string' && text.length >= 20) {
          for (const block of extractInsightBlocks(text)) {
            results.push({
              content: block,
              source: 'transcript',
              timestamp,
            })
          }
        }
      }

      if (payload.type === 'task_complete' && typeof payload.last_agent_message === 'string') {
        for (const block of extractInsightBlocks(payload.last_agent_message)) {
          results.push({
            content: block,
            source: 'transcript',
            timestamp,
          })
        }
      }
    } catch {
      // Ignore malformed or partial lines.
    }
  }

  return results
}

function collectClaudeInsights(path: string): CandidateInsight[] {
  const results: CandidateInsight[] = []
  const lines = readFileSync(path, 'utf8').split('\n')

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    try {
      const obj = JSON.parse(trimmed)
      const timestamp = obj.timestamp || new Date().toISOString()

      if (obj.type === 'user') {
        const message = obj.message
        if (!message) continue

        let text = ''
        if (typeof message.content === 'string') {
          text = message.content
        } else if (Array.isArray(message.content)) {
          text = message.content
            .filter((block: any) => block.type === 'text')
            .map((block: any) => block.text)
            .join('\n')
        }

        const sanitized = sanitizeUserInput(text, 'claude')
        if (sanitized) {
          results.push({
            content: sanitized,
            source: 'user',
            timestamp,
          })
        }
        continue
      }

      if (obj.type !== 'assistant') continue
      const content = obj.message?.content ?? []
      for (const block of content) {
        if (block.type !== 'text') continue
        const text = block.text ?? ''
        if (!text || text.length < 20) continue

        for (const insight of extractInsightBlocks(text)) {
          results.push({
            content: insight,
            source: 'transcript',
            timestamp,
          })
        }
      }
    } catch {
      // Ignore malformed or partial lines.
    }
  }

  return results
}

function collectCandidates(session: SessionRow): CandidateInsight[] {
  if (!session.transcript_path || !existsSync(session.transcript_path)) return []
  return session.source === 'codex'
    ? collectCodexInsights(session.transcript_path)
    : collectClaudeInsights(session.transcript_path)
}

type ChainSessionRow = {
  session_id: string
  predecessor_id: string
  is_subagent: number
  parent_session_id: string
  chain_id: string
  created_at: string
}

function backfillChainIds(db: Database.Database, dryRun: boolean): { assigned: number } {
  const sessions = db.prepare(`
    SELECT session_id, predecessor_id, is_subagent, parent_session_id, chain_id, created_at
    FROM sessions
    ORDER BY created_at ASC
  `).all() as ChainSessionRow[]

  const byId = new Map(sessions.map((s) => [s.session_id, s]))
  const update = db.prepare('UPDATE sessions SET chain_id = ? WHERE session_id = ?')

  function resolve(sessionId: string, depth = 0): string {
    if (depth > 100) return generateChainId() // cycle guard
    const row = byId.get(sessionId)
    if (!row) return generateChainId()
    if (row.chain_id) return row.chain_id

    let chainId: string | null = null
    if (row.is_subagent === 1 && row.parent_session_id && byId.has(row.parent_session_id)) {
      chainId = resolve(row.parent_session_id, depth + 1)
    } else if (row.predecessor_id && byId.has(row.predecessor_id)) {
      chainId = resolve(row.predecessor_id, depth + 1)
    }
    if (!chainId) chainId = generateChainId()

    row.chain_id = chainId
    if (!dryRun) update.run(chainId, sessionId)
    return chainId
  }

  let assigned = 0
  for (const session of sessions) {
    if (!session.chain_id) {
      resolve(session.session_id)
      assigned += 1
    }
  }
  return { assigned }
}

function main() {
  const { days, dryRun } = parseArgs()
  const db = new Database(getDbPath())
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000

  const sessions = db.prepare(`
    SELECT session_id, source, transcript_path, created_at, last_activity
    FROM sessions
    ORDER BY created_at DESC
  `).all() as SessionRow[]

  const getLatestEventStmt = db.prepare('SELECT max(timestamp) AS timestamp FROM events WHERE session_id = ?')
  const getLatestStoredInsightStmt = db.prepare('SELECT max(timestamp) AS timestamp FROM insights WHERE session_id = ?')
  const existingInsightsStmt = db.prepare('SELECT id, source, content, timestamp FROM insights WHERE session_id = ?')
  const analyses: SessionAnalysis[] = []

  for (const session of sessions) {
    const candidates = collectCandidates(session)
    let canonicalLatest = session.created_at
    canonicalLatest = maxTimestamp(canonicalLatest, (getLatestEventStmt.get(session.session_id) as { timestamp: string | null }).timestamp) ?? canonicalLatest

    for (const candidate of candidates) {
      canonicalLatest = maxTimestamp(canonicalLatest, candidate.timestamp) ?? canonicalLatest
    }

    const createdAtMs = parseTimestamp(session.created_at) ?? 0
    const canonicalMs = parseTimestamp(canonicalLatest) ?? 0
    const latestStoredInsightMs = parseTimestamp((getLatestStoredInsightStmt.get(session.session_id) as { timestamp: string | null }).timestamp) ?? 0
    if (createdAtMs < cutoffMs && canonicalMs < cutoffMs && latestStoredInsightMs < cutoffMs) continue

    const existing = new Set(
      [] as string[]
    )
    const existingRows = existingInsightsStmt.all(session.session_id) as Array<{
      id: number
      source: string
      content: string
      timestamp: string
    }>
    const noiseInsightIds: number[] = []
    const canonicalInsightTimestamps = new Map<string, string>()
    for (const candidate of candidates) {
      const key = `${candidate.source}\u0000${candidate.content}`
      if (!canonicalInsightTimestamps.has(key)) {
        canonicalInsightTimestamps.set(key, candidate.timestamp)
      }
    }

    const timestampFixes: Array<{ id: number; timestamp: string }> = []
    for (const row of existingRows) {
      if (row.source === 'user' && sanitizeUserInput(row.content, session.source) === null) {
        noiseInsightIds.push(row.id)
        continue
      }
      const key = `${row.source}\u0000${row.content}`
      existing.add(key)
      const canonicalTimestamp = canonicalInsightTimestamps.get(key)
      if (canonicalTimestamp && canonicalTimestamp !== row.timestamp) {
        timestampFixes.push({ id: row.id, timestamp: canonicalTimestamp })
      }
    }

    const missingCandidates: CandidateInsight[] = []
    for (const candidate of candidates) {
      const key = `${candidate.source}\u0000${candidate.content}`
      if (existing.has(key)) continue
      missingCandidates.push(candidate)
      existing.add(key)
    }

    analyses.push({
      session,
      canonicalLatest,
      noiseInsightIds,
      timestampFixes,
      missingCandidates,
    })
  }

  const repair = db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS repair_recent_sessions')
    db.exec('CREATE TEMP TABLE repair_recent_sessions (session_id TEXT PRIMARY KEY)')
    const insertRecentSession = db.prepare('INSERT INTO repair_recent_sessions (session_id) VALUES (?)')
    for (const { session } of analyses) {
      insertRecentSession.run(session.session_id)
    }

    const duplicateCountRow = db.prepare(`
      SELECT COUNT(*) AS count
      FROM (
        SELECT e.id
        FROM events e
        JOIN (
          SELECT MIN(id) AS keep_id, session_id, event_name, timestamp, raw_payload
          FROM events
          WHERE session_id IN (SELECT session_id FROM repair_recent_sessions)
          GROUP BY session_id, event_name, timestamp, raw_payload
        ) keep
          ON keep.session_id = e.session_id
         AND keep.event_name = e.event_name
         AND keep.timestamp = e.timestamp
         AND keep.raw_payload = e.raw_payload
        WHERE e.id != keep.keep_id
      )
    `).get() as { count: number }

    const insertInsightStmt = db.prepare(`
      INSERT INTO insights (session_id, content, timestamp, source)
      VALUES (?, ?, ?, ?)
    `)
    const deleteInsightStmt = db.prepare('DELETE FROM insights WHERE id = ?')
    const updateInsightTimestampStmt = db.prepare('UPDATE insights SET timestamp = ? WHERE id = ?')
    const updateLastActivityStmt = db.prepare('UPDATE sessions SET last_activity = ? WHERE session_id = ?')

    const dedupeResult = dryRun ? { changes: duplicateCountRow.count } : db.prepare(`
      DELETE FROM events
      WHERE id IN (
        SELECT e.id
        FROM events e
        JOIN (
          SELECT MIN(id) AS keep_id, session_id, event_name, timestamp, raw_payload
          FROM events
          WHERE session_id IN (SELECT session_id FROM repair_recent_sessions)
          GROUP BY session_id, event_name, timestamp, raw_payload
        ) keep
          ON keep.session_id = e.session_id
         AND keep.event_name = e.event_name
         AND keep.timestamp = e.timestamp
         AND keep.raw_payload = e.raw_payload
        WHERE e.id != keep.keep_id
      )
    `).run()

    let insertedInsights = 0
    let deletedNoiseInsights = 0
    let updatedSessions = 0
    let updatedInsightTimestamps = 0
    let affectedInsightSessions = 0

    for (const { session, canonicalLatest, noiseInsightIds, timestampFixes, missingCandidates } of analyses) {
      if (missingCandidates.length > 0) affectedInsightSessions += 1

      for (const insightId of noiseInsightIds) {
        if (!dryRun) {
          deleteInsightStmt.run(insightId)
        }
        deletedNoiseInsights += 1
      }

      for (const fix of timestampFixes) {
        if (!dryRun) {
          updateInsightTimestampStmt.run(fix.timestamp, fix.id)
        }
        updatedInsightTimestamps += 1
      }

      for (const candidate of missingCandidates) {
        if (!dryRun) {
          insertInsightStmt.run(session.session_id, candidate.content, candidate.timestamp, candidate.source)
        }
        insertedInsights += 1
      }

      if (canonicalLatest !== session.last_activity) {
        if (!dryRun) {
          updateLastActivityStmt.run(canonicalLatest, session.session_id)
        }
        updatedSessions += 1
      }
    }

    return {
      recentSessions: analyses.length,
      deletedDuplicateEvents: dedupeResult.changes,
      insertedInsights,
      deletedNoiseInsights,
      affectedInsightSessions,
      updatedInsightTimestamps,
      updatedSessions,
    }
  })

  const summary = repair()
  const chainResult = backfillChainIds(db, dryRun)
  console.log(JSON.stringify({ days, dryRun, ...summary, chainIdsAssigned: chainResult.assigned }, null, 2))
  db.close()
}

main()
