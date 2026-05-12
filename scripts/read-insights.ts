/**
 * Session Dashboard — Insight Recovery CLI
 *
 * Reads insights directly from the SQLite database (offline, no server needed).
 * Designed for AI consumption: after context compression, a subagent runs this
 * tool to recover prior session insights.
 *
 * Usage: session-dashboard insights [options]
 * Run with --help for full option list.
 */

import Database from 'better-sqlite3'
import { resolve } from 'node:path'
import { isChainId } from '../shared/chain-id.js'
import { getDbPath } from '../shared/config.js'
import { resolveTimeRange, type TimeRange } from '../shared/time-range.js'

const DB_PATH = getDbPath()

interface Args {
  help: boolean
  session?: string
  cwd?: string
  range?: string
  since?: string
  until?: string
  limit: number
  offset: number
  grep?: string
  chain: boolean         // --list --chain (bare flag, no value) → list mode groups by chain
  chainId?: string       // --chain <chain_xxxxxxxx> → read a specific chain
  includeSubagents: boolean
  list: boolean
  all: boolean
  json: boolean
}

type SessionRow = {
  session_id: string
  cwd: string
  state: string
  alias: string
  source: string
  last_activity: string
  created_at: string
  predecessor_id: string
}

type ListedSession = SessionRow & {
  matched_insights_count?: number
  latest_matched_insight_at?: string
}

interface ChainSummary {
  chain_id: string
  main_session_ids: string[]
  subagent_session_ids: string[]
  sessions_count: number              // main区 count (default; widens if --include-subagents)
  representative_session_id: string   // main session with MAX(last_activity)
  insights_count: number              // main区 insights only by default
  chain_started_at: string            // MIN(created_at) across main区
  chain_last_activity: string         // MAX(last_activity) across main区
  cwd: string                         // any main session's cwd (they all share it)
}

type InsightSource = 'transcript' | 'hook' | 'user'

type InsightRow = {
  id: number
  content: string
  timestamp: string
  source: InsightSource
  source_session: string
}

const HELP = `
Session Dashboard — Insight Recovery CLI

Usage:
  session-dashboard insights --list [filters]
  session-dashboard insights --session <id> [filters]

Session selection:
  --session <id>     Exact session id or unique prefix
  --list             List sessions instead of printing insight content.
                     Defaults to the current directory and subdirectories.
  --cwd <path>       With --list, include sessions in this directory and subdirectories.
                     Aliases: --dir, --directory
  --all              With --list, search sessions across all directories

Search and time filters:
  --grep <regex>     Search primary insights, case-insensitive.
                     With --list, searches across matching sessions.
                     User prompts are not counted as grep matches.
  --range <name>     today | yesterday | week | this-week | last-week
  --since <time>     Include records at or after this time (ISO or YYYY-MM-DD)
  --until <time>     Exclude records at or after this time (ISO or YYYY-MM-DD)
                     Time ranges use [since, until). YYYY-MM-DD means local midnight.

Output:
  --limit <n>        Max sessions for --list, or max primary insights for content view (default: 50)
  --offset <n>       Skip first n primary insights in content view (newest first)
  --chain [id]       Without value: in --list mode, group sessions by chain.
                     With chain_xxxxxxxx value: read insights for a specific chain.
                     Use space-separated form: --chain chain_xxxxxxxx (not --chain=...).
  --include-subagents With chain queries, include subagent sessions (default: main only).
  --json             Output as JSON
  --help             Show this help

Examples:
  # List recent sessions in the current directory
  session-dashboard insights --list

  # List recent sessions across all directories
  session-dashboard insights --list --all

  # List sessions matching a prefix
  session-dashboard insights --session a1b2 --list

  # List sessions under a workspace/project directory
  session-dashboard insights --cwd /path/to/project --list

  # List sessions changed this week
  session-dashboard insights --list --range week

  # List sessions changed in a custom time range
  session-dashboard insights --list --since 2026-05-04 --until 2026-05-11

  # List sessions whose primary insights mention a keyword
  session-dashboard insights --list --grep "outer glow"

  # Search all directories by keyword
  session-dashboard insights --list --all --grep "outer glow"

  # Search by keyword inside a directory and time range
  session-dashboard insights --cwd /path/to/project --list --grep "outer glow" --range week

  # Read latest 30 primary insights (+ attached user prompts)
  session-dashboard insights --session a1b2c3d4 --limit 30

  # Search within one session's primary insights
  session-dashboard insights --session a1b2 --grep "pagination"

  # List sessions grouped by chain
  session-dashboard insights --list --chain --all

  # Read all insights for a specific chain
  session-dashboard insights --chain chain_a3k7m2pq

  # Paginate: get next page
  session-dashboard insights --session a1b2 --limit 30 --offset 30
`.trim()

function parseArgs(argvInput?: string[]): Args {
  const argv = argvInput ?? process.argv.slice(2)
  const args: Args = {
    help: false,
    limit: 50,
    offset: 0,
    chain: false,
    includeSubagents: false,
    list: false,
    all: false,
    json: false,
  }

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--help': case '-h':
        args.help = true
        break
      case '--session':
        args.session = argv[++i]
        break
      case '--cwd':
      case '--dir':
      case '--directory':
        args.cwd = argv[++i]
        break
      case '--range':
        args.range = argv[++i]
        break
      case '--since':
        args.since = argv[++i]
        break
      case '--until':
        args.until = argv[++i]
        break
      case '--limit':
        args.limit = parseInt(argv[++i], 10)
        break
      case '--offset':
        args.offset = parseInt(argv[++i], 10)
        break
      case '--grep':
        args.grep = argv[++i]
        break
      case '--chain': {
        const next = argv[i + 1]
        if (next && !next.startsWith('--')) {
          // Read-mode: value supplied. Validate format strictly.
          if (!isChainId(next)) {
            console.error(`Error: --chain expects a chain id of the form chain_xxxxxxxx (8 chars from the Crockford alphabet), got "${next}"`)
            process.exit(1)
          }
          args.chainId = next
          i += 1
        } else {
          // List-mode bare flag.
          args.chain = true
        }
        break
      }
      case '--include-subagents':
        args.includeSubagents = true
        break
      case '--list':
        args.list = true
        break
      case '--all':
        args.all = true
        break
      case '--json':
        args.json = true
        break
    }
  }

  return args
}

function formatRelative(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function formatAbsolute(isoStr: string): string {
  const date = new Date(isoStr)
  const yyyy = String(date.getFullYear())
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const min = String(date.getMinutes()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`
}

function formatBoundaryTime(isoStr: string): string {
  return `${formatAbsolute(isoStr)} (${formatRelative(isoStr)})`
}

function openDb(): Database.Database {
  try {
    return new Database(DB_PATH, { readonly: true })
  } catch {
    console.error(`Error: cannot open database at ${DB_PATH}`)
    console.error('Make sure session-dashboard has been started at least once.')
    process.exit(1)
  }
}

function findSessions(db: Database.Database, sessionPrefix: string): SessionRow[] {
  const exact = db.prepare(
    `SELECT session_id, cwd, state, alias, source, last_activity, created_at, predecessor_id
     FROM sessions
     WHERE session_id = ?`
  ).get(sessionPrefix) as SessionRow | undefined
  if (exact) return [exact]

  return db.prepare(
    `SELECT session_id, cwd, state, alias, source, last_activity, created_at, predecessor_id
     FROM sessions
     WHERE session_id LIKE ?
     ORDER BY last_activity DESC`
  ).all(`${sessionPrefix}%`) as SessionRow[]
}

function findAllSessions(db: Database.Database): SessionRow[] {
  return db.prepare(
    `SELECT session_id, cwd, state, alias, source, last_activity, created_at, predecessor_id
     FROM sessions
     ORDER BY last_activity DESC`
  ).all() as SessionRow[]
}

function normalizeCwdArg(cwd: string): string {
  return resolve(cwd)
}

function findAllSessionsByCwd(db: Database.Database, cwd: string): SessionRow[] {
  const normalized = normalizeCwdArg(cwd)
  const nestedPrefix = `${normalized}/`
  return db.prepare(
    `SELECT session_id, cwd, state, alias, source, last_activity, created_at, predecessor_id
     FROM sessions
     WHERE cwd = ? OR substr(cwd, 1, ?) = ?
     ORDER BY last_activity DESC`
  ).all(normalized, nestedPrefix.length, nestedPrefix) as SessionRow[]
}

function findSessionsByCwd(db: Database.Database, cwd: string, limit: number): SessionRow[] {
  const normalized = normalizeCwdArg(cwd)
  const nestedPrefix = `${normalized}/`
  return db.prepare(
    `SELECT session_id, cwd, state, alias, source, last_activity, created_at, predecessor_id
     FROM sessions
     WHERE cwd = ? OR substr(cwd, 1, ?) = ?
     ORDER BY last_activity DESC
     LIMIT ?`
  ).all(normalized, nestedPrefix.length, nestedPrefix, limit) as SessionRow[]
}

function buildRangePredicate(range: TimeRange, alias: string): { sql: string; params: string[] } {
  const clauses: string[] = []
  const params: string[] = []
  if (range.since) {
    clauses.push(`${alias}.timestamp >= ?`)
    params.push(range.since)
  }
  if (range.until) {
    clauses.push(`${alias}.timestamp < ?`)
    params.push(range.until)
  }
  return { sql: clauses.join(' AND '), params }
}

function buildSessionActivityRangePredicate(range: TimeRange): { sql: string; params: string[] } {
  const lastActivityClauses: string[] = []
  const params: string[] = []
  if (range.since) {
    lastActivityClauses.push('last_activity >= ?')
    params.push(range.since)
  }
  if (range.until) {
    lastActivityClauses.push('last_activity < ?')
    params.push(range.until)
  }

  const insightRange = buildRangePredicate(range, 'i')
  const eventRange = buildRangePredicate(range, 'e')
  return {
    sql: `(
       (${lastActivityClauses.join(' AND ')})
       OR EXISTS (
         SELECT 1 FROM insights i
         WHERE i.session_id = sessions.session_id AND ${insightRange.sql}
       )
       OR EXISTS (
         SELECT 1 FROM events e
         WHERE e.session_id = sessions.session_id AND ${eventRange.sql}
       )
     )`,
    params: [
      ...params,
      ...insightRange.params,
      ...eventRange.params,
    ],
  }
}

function buildSessionRangeChangedAtExpression(range: TimeRange): { sql: string; params: string[] } {
  const sessionCaseClauses: string[] = []
  const sessionParams: string[] = []
  if (range.since) {
    sessionCaseClauses.push('last_activity >= ?')
    sessionParams.push(range.since)
  }
  if (range.until) {
    sessionCaseClauses.push('last_activity < ?')
    sessionParams.push(range.until)
  }

  const insightRange = buildRangePredicate(range, 'i2')
  const eventRange = buildRangePredicate(range, 'e2')
  return {
    sql: `max(
       CASE WHEN ${sessionCaseClauses.join(' AND ')} THEN last_activity ELSE '' END,
       COALESCE((
         SELECT max(i2.timestamp) FROM insights i2
         WHERE i2.session_id = sessions.session_id AND ${insightRange.sql}
       ), ''),
       COALESCE((
         SELECT max(e2.timestamp) FROM events e2
         WHERE e2.session_id = sessions.session_id AND ${eventRange.sql}
       ), '')
     )`,
    params: [
      ...sessionParams,
      ...insightRange.params,
      ...eventRange.params,
    ],
  }
}

function findSessionsByCwdAndRange(db: Database.Database, cwd: string, range: TimeRange, limit: number): SessionRow[] {
  const normalized = normalizeCwdArg(cwd)
  const nestedPrefix = `${normalized}/`
  const activity = buildSessionActivityRangePredicate(range)
  const changedAt = buildSessionRangeChangedAtExpression(range)
  return db.prepare(
    `SELECT session_id, cwd, state, alias, source, last_activity, created_at, predecessor_id
     FROM sessions
     WHERE (cwd = ? OR substr(cwd, 1, ?) = ?) AND ${activity.sql}
     ORDER BY ${changedAt.sql} DESC, last_activity DESC
     LIMIT ?`
  ).all(
    normalized,
    nestedPrefix.length,
    nestedPrefix,
    ...activity.params,
    ...changedAt.params,
    limit
  ) as SessionRow[]
}

function listRecentSessions(db: Database.Database, limit: number): SessionRow[] {
  return db.prepare(
    `SELECT session_id, cwd, state, alias, source, last_activity, created_at, predecessor_id
     FROM sessions
     ORDER BY last_activity DESC
     LIMIT ?`
  ).all(limit) as SessionRow[]
}

function listSessionsByRange(db: Database.Database, range: TimeRange, limit: number): SessionRow[] {
  const activity = buildSessionActivityRangePredicate(range)
  const changedAt = buildSessionRangeChangedAtExpression(range)
  return db.prepare(
    `SELECT session_id, cwd, state, alias, source, last_activity, created_at, predecessor_id
     FROM sessions
     WHERE ${activity.sql}
     ORDER BY ${changedAt.sql} DESC, last_activity DESC
     LIMIT ?`
  ).all(...activity.params, ...changedAt.params, limit) as SessionRow[]
}

function filterSessionsByRange(db: Database.Database, sessions: SessionRow[], range: TimeRange): SessionRow[] {
  return sessions
    .filter((session) => hasChangedInRange(db, session, range))
    .sort((a, b) => (
      getChangedAtInRange(db, b, range).localeCompare(getChangedAtInRange(db, a, range)) ||
      b.last_activity.localeCompare(a.last_activity)
    ))
}

function getChain(db: Database.Database, startSessionId: string): string[] {
  const chain = [startSessionId]
  const stmtPredecessor = db.prepare(
    'SELECT predecessor_id FROM sessions WHERE session_id = ?'
  )
  let current = startSessionId
  const maxDepth = 5

  for (let i = 0; i < maxDepth; i++) {
    const row = stmtPredecessor.get(current) as { predecessor_id: string } | undefined
    if (!row?.predecessor_id) break
    chain.push(row.predecessor_id)
    current = row.predecessor_id
  }

  return chain
}

function countBySource(db: Database.Database, sessionId: string, sourcePredicate: string, range?: TimeRange): number {
  const clauses = [`session_id = ?`, sourcePredicate]
  const params: Array<string> = [sessionId]
  if (range?.since) {
    clauses.push('timestamp >= ?')
    params.push(range.since)
  }
  if (range?.until) {
    clauses.push('timestamp < ?')
    params.push(range.until)
  }
  return (db.prepare(
    `SELECT COUNT(*) as count FROM insights WHERE ${clauses.join(' AND ')}`
  ).get(...params) as { count: number }).count
}

function hasChangedInRange(db: Database.Database, session: SessionRow, range?: TimeRange): boolean {
  if (!range) return false
  if ((!range.since || session.last_activity >= range.since) && (!range.until || session.last_activity < range.until)) {
    return true
  }

  const insightRange = buildRangePredicate(range, 'insights')
  const eventRange = buildRangePredicate(range, 'events')
  const insightChanged = (db.prepare(
    `SELECT 1 FROM insights WHERE session_id = ? AND ${insightRange.sql} LIMIT 1`
  ).get(session.session_id, ...insightRange.params) as unknown) != null
  if (insightChanged) return true

  return (db.prepare(
    `SELECT 1 FROM events WHERE session_id = ? AND ${eventRange.sql} LIMIT 1`
  ).get(session.session_id, ...eventRange.params) as unknown) != null
}

function getChangedAtInRange(db: Database.Database, session: SessionRow, range: TimeRange): string {
  let changedAt = ''
  if ((!range.since || session.last_activity >= range.since) && (!range.until || session.last_activity < range.until)) {
    changedAt = session.last_activity
  }

  const insightRange = buildRangePredicate(range, 'insights')
  const latestInsight = (db.prepare(
    `SELECT max(timestamp) as timestamp FROM insights WHERE session_id = ? AND ${insightRange.sql}`
  ).get(session.session_id, ...insightRange.params) as { timestamp: string | null }).timestamp
  if (latestInsight && latestInsight > changedAt) changedAt = latestInsight

  const eventRange = buildRangePredicate(range, 'events')
  const latestEvent = (db.prepare(
    `SELECT max(timestamp) as timestamp FROM events WHERE session_id = ? AND ${eventRange.sql}`
  ).get(session.session_id, ...eventRange.params) as { timestamp: string | null }).timestamp
  if (latestEvent && latestEvent > changedAt) changedAt = latestEvent

  return changedAt
}

function compileGrep(pattern: string): RegExp {
  if (pattern.length === 0) {
    console.error('Error: --grep requires a non-empty pattern.')
    process.exit(1)
  }
  try {
    return new RegExp(pattern, 'i')
  } catch {
    console.error(`Error: invalid regex pattern "${pattern}"`)
    process.exit(1)
  }
}

function primaryInsightRowsForSession(db: Database.Database, sessionId: string, range?: TimeRange): Array<{ content: string; timestamp: string }> {
  const clauses = [`session_id = ?`, `source != 'user'`]
  const params: string[] = [sessionId]
  if (range?.since) {
    clauses.push('timestamp >= ?')
    params.push(range.since)
  }
  if (range?.until) {
    clauses.push('timestamp < ?')
    params.push(range.until)
  }
  return db.prepare(
    `SELECT content, timestamp FROM insights
     WHERE ${clauses.join(' AND ')}
     ORDER BY timestamp DESC, id DESC`
  ).all(...params) as Array<{ content: string; timestamp: string }>
}

function filterSessionsByGrep(db: Database.Database, sessions: SessionRow[], pattern: string, range?: TimeRange): ListedSession[] {
  const re = compileGrep(pattern)
  const matched: ListedSession[] = []

  for (const session of sessions) {
    const hits = primaryInsightRowsForSession(db, session.session_id, range)
      .filter((insight) => re.test(insight.content))
    if (hits.length === 0) continue
    matched.push({
      ...session,
      matched_insights_count: hits.length,
      latest_matched_insight_at: hits[0].timestamp,
    })
  }

  return matched.sort((a, b) => (
    (b.latest_matched_insight_at || '').localeCompare(a.latest_matched_insight_at || '') ||
    (b.matched_insights_count || 0) - (a.matched_insights_count || 0) ||
    b.last_activity.localeCompare(a.last_activity)
  ))
}

function listChains(db: Database.Database, _args: Args): ChainSummary[] {
  // Step 1: aggregate session metadata by chain_id.
  // We only consider main区 (is_subagent = 0) for the headline fields:
  // sessions_count, representative_session_id, chain_started_at, chain_last_activity, cwd.
  // Subagent ids are listed in a separate array but excluded from the count.
  const mainRows = db.prepare(`
    SELECT
      chain_id,
      session_id,
      cwd,
      last_activity,
      created_at
    FROM sessions
    WHERE chain_id != '' AND is_subagent = 0
  `).all() as Array<{ chain_id: string; session_id: string; cwd: string; last_activity: string; created_at: string }>

  const subagentRows = db.prepare(`
    SELECT chain_id, session_id
    FROM sessions
    WHERE chain_id != '' AND is_subagent = 1
  `).all() as Array<{ chain_id: string; session_id: string }>

  // Group main rows by chain_id.
  const chainsMap = new Map<string, ChainSummary>()
  for (const row of mainRows) {
    let chain = chainsMap.get(row.chain_id)
    if (!chain) {
      chain = {
        chain_id: row.chain_id,
        main_session_ids: [],
        subagent_session_ids: [],
        sessions_count: 0,
        representative_session_id: '',
        insights_count: 0,
        chain_started_at: row.created_at,
        chain_last_activity: row.last_activity,
        cwd: row.cwd,
      }
      chainsMap.set(row.chain_id, chain)
    }
    chain.main_session_ids.push(row.session_id)
    chain.sessions_count += 1
    if (row.created_at < chain.chain_started_at) chain.chain_started_at = row.created_at
    if (row.last_activity >= chain.chain_last_activity) {
      chain.chain_last_activity = row.last_activity
      chain.representative_session_id = row.session_id
    }
    // cwd: all main sessions in a chain should share cwd; keep the first.
  }

  // Initialize representative_session_id for chains with only one main session.
  for (const chain of chainsMap.values()) {
    if (!chain.representative_session_id && chain.main_session_ids.length > 0) {
      chain.representative_session_id = chain.main_session_ids[0]
    }
  }

  // Attach subagent ids.
  for (const row of subagentRows) {
    const chain = chainsMap.get(row.chain_id)
    if (chain) chain.subagent_session_ids.push(row.session_id)
  }

  // Step 2: count main区 insights per chain.
  if (chainsMap.size > 0) {
    const chainIds = [...chainsMap.keys()]
    const placeholders = chainIds.map(() => '?').join(',')
    const insightCounts = db.prepare(`
      SELECT s.chain_id, COUNT(i.id) AS cnt
      FROM sessions s
      LEFT JOIN insights i ON i.session_id = s.session_id
      WHERE s.is_subagent = 0 AND s.chain_id IN (${placeholders})
      GROUP BY s.chain_id
    `).all(...chainIds) as Array<{ chain_id: string; cnt: number }>
    for (const row of insightCounts) {
      const chain = chainsMap.get(row.chain_id)
      if (chain) chain.insights_count = row.cnt
    }
  }

  // Sort by chain_last_activity DESC.
  return [...chainsMap.values()].sort((a, b) => b.chain_last_activity.localeCompare(a.chain_last_activity))
}

function printChainList(chains: ChainSummary[]) {
  console.log(
    'CHAIN_ID'.padEnd(16) +
    'SESSIONS'.padEnd(10) +
    'INSIGHTS'.padEnd(10) +
    'LAST_ACTIVE'.padEnd(13) +
    'CWD'
  )
  console.log('─'.repeat(80))

  for (const chain of chains) {
    const sessionsLabel = chain.subagent_session_ids.length > 0
      ? `${chain.sessions_count}+${chain.subagent_session_ids.length}`
      : String(chain.sessions_count)
    console.log(
      chain.chain_id.padEnd(16) +
      sessionsLabel.padEnd(10) +
      String(chain.insights_count).padEnd(10) +
      formatRelative(chain.chain_last_activity).padEnd(13) +
      chain.cwd
    )
    if (chain.representative_session_id) {
      console.log(`  ↳ representative: ${chain.representative_session_id.slice(0, 10)}`)
    }
  }
}

function cmdList(db: Database.Database, sessions: ListedSession[], args: Args, range?: TimeRange) {
  const stmtPrimaryCount = db.prepare(
    `SELECT COUNT(*) as count FROM insights
     WHERE session_id = ? AND source != 'user'`
  )
  const stmtUserCount = db.prepare(
    `SELECT COUNT(*) as count FROM insights
     WHERE session_id = ? AND source = 'user'`
  )

  if (args.json) {
    const data = sessions.map(s => ({
      ...s,
      insights_count: (stmtPrimaryCount.get(s.session_id) as { count: number }).count,
      user_prompts_count: (stmtUserCount.get(s.session_id) as { count: number }).count,
      ...(range ? {
        changed_in_range: hasChangedInRange(db, s, range),
        new_insights_in_range: countBySource(db, s.session_id, `source != 'user'`, range),
        new_user_prompts_in_range: countBySource(db, s.session_id, `source = 'user'`, range),
      } : {}),
      ...(args.grep ? {
        matched_insights_count: s.matched_insights_count || 0,
        latest_matched_insight_at: s.latest_matched_insight_at,
      } : {}),
    }))
    console.log(JSON.stringify(range || args.grep ? {
      ...(range ? { range } : {}),
      ...(args.grep ? { grep: args.grep } : {}),
      sessions: data,
    } : data, null, 2))
    return
  }

  console.log(
    'SESSION_ID'.padEnd(12) +
    'STATE'.padEnd(12) +
    'SOURCE'.padEnd(8) +
    (args.grep ? 'HITS'.padEnd(8) : '') +
    'INSIGHTS'.padEnd(10) +
    'USER'.padEnd(8) +
    'LAST_ACTIVE'.padEnd(13) +
    'ALIAS / CWD'
  )
  if (range) {
    console.log(`[range: ${range.since || '(beginning)'} to ${range.until || '(open)'}]`)
  }
  if (args.grep) {
    console.log(`[grep: "${args.grep}"]`)
  }
  console.log('─'.repeat(80))

  for (const s of sessions) {
    const insightCount = range
      ? countBySource(db, s.session_id, `source != 'user'`, range)
      : (stmtPrimaryCount.get(s.session_id) as { count: number }).count
    const userCount = range
      ? countBySource(db, s.session_id, `source = 'user'`, range)
      : (stmtUserCount.get(s.session_id) as { count: number }).count
    const label = s.alias || s.cwd
    console.log(
      s.session_id.slice(0, 10).padEnd(12) +
      s.state.padEnd(12) +
      s.source.padEnd(8) +
      (args.grep ? String(s.matched_insights_count || 0).padEnd(8) : '') +
      String(insightCount).padEnd(10) +
      String(userCount).padEnd(8) +
      formatRelative(s.last_activity).padEnd(13) +
      label
    )
    if (s.predecessor_id) {
      console.log(`  ↳ predecessor: ${s.predecessor_id.slice(0, 10)}`)
    }
  }
}

function cmdInsights(db: Database.Database, targetSession: SessionRow, args: Args) {
  const sessionIds = args.chain
    ? getChain(db, targetSession.session_id)
    : [targetSession.session_id]

  const placeholders = sessionIds.map(() => '?').join(',')
  const range = resolveTimeRange({ range: args.range, since: args.since, until: args.until })
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
  const allInsights = db.prepare(
    `SELECT id, content, timestamp, source, session_id as source_session FROM insights
     WHERE session_id IN (${placeholders})
     ${rangeClauses.length > 0 ? `AND ${rangeClauses.join(' AND ')}` : ''}
     ORDER BY timestamp DESC, id DESC`
  ).all(...sessionIds, ...rangeParams) as InsightRow[]

  const allPrimaryInsights = allInsights.filter(ins => ins.source !== 'user')
  const totalPrimaryAvailable = allPrimaryInsights.length
  const totalUserPrompts = allInsights.length - totalPrimaryAvailable

  let displayedPrimaryInsights = allPrimaryInsights
  let totalMatched: number | undefined

  if (args.grep) {
    let re: RegExp
    try {
      re = new RegExp(args.grep, 'i')
    } catch {
      console.error(`Error: invalid regex pattern "${args.grep}"`)
      process.exit(1)
    }

    displayedPrimaryInsights = allPrimaryInsights.filter(ins => re.test(ins.content))
    totalMatched = displayedPrimaryInsights.length
  }

  const primaryPage = displayedPrimaryInsights.slice(args.offset, args.offset + args.limit)
  const primaryIds = new Set(primaryPage.map(ins => ins.id))
  const attachedUserIds = new Set<number>()

  let currentPrimaryId: number | null = null
  const pendingLeadingUserIds: number[] = []
  for (const ins of allInsights) {
    if (ins.source === 'user') {
      if (currentPrimaryId == null) {
        pendingLeadingUserIds.push(ins.id)
      } else if (primaryIds.has(currentPrimaryId)) {
        attachedUserIds.add(ins.id)
      }
      continue
    }

    currentPrimaryId = ins.id
    if (pendingLeadingUserIds.length > 0) {
      if (primaryIds.has(currentPrimaryId)) {
        for (const userId of pendingLeadingUserIds) {
          attachedUserIds.add(userId)
        }
      }
      pendingLeadingUserIds.length = 0
    }
  }

  const renderedInsights = allInsights.filter(ins => (
    primaryIds.has(ins.id) || attachedUserIds.has(ins.id)
  ))

  outputInsights(targetSession, renderedInsights, args, {
    showing: primaryPage.length,
    totalPrimaryAvailable,
    totalMatched,
    attachedUserPrompts: attachedUserIds.size,
    totalUserPrompts,
    isChain: args.chain,
    sessionCount: sessionIds.length,
    range,
  })
}

interface OutputMeta {
  showing: number
  totalPrimaryAvailable: number
  totalMatched?: number
  attachedUserPrompts: number
  totalUserPrompts: number
  isChain: boolean
  sessionCount: number
  range?: TimeRange
}

function outputInsights(
  session: SessionRow,
  insights: InsightRow[],
  args: Args,
  meta: OutputMeta
) {
  const newestTimestamp = insights[0]?.timestamp
  const oldestTimestamp = insights[insights.length - 1]?.timestamp

  if (args.json) {
    console.log(JSON.stringify({
      session: {
        session_id: session.session_id,
        cwd: session.cwd,
        state: session.state,
        alias: session.alias,
        source: session.source,
        predecessor_id: session.predecessor_id || undefined,
      },
      order: 'newest_first',
      showing: meta.showing,
      total_primary_available: meta.totalPrimaryAvailable,
      ...(meta.totalMatched != null ? { total_matched_primary: meta.totalMatched } : {}),
      attached_user_prompts: meta.attachedUserPrompts,
      total_user_prompts: meta.totalUserPrompts,
      offset: args.offset,
      limit: args.limit,
      ...(args.grep ? { grep: args.grep } : {}),
      ...(meta.range ? { range: meta.range } : {}),
      ...(meta.isChain ? { chain_sessions: meta.sessionCount } : {}),
      ...(newestTimestamp ? { newest_timestamp: newestTimestamp } : {}),
      ...(oldestTimestamp ? { oldest_timestamp: oldestTimestamp } : {}),
      insights: insights.map(ins => ({
        content: ins.content,
        source: ins.source,
        ...(ins.source_session !== session.session_id
          ? { session: ins.source_session.slice(0, 8) }
          : {}),
      })),
    }, null, 2))
    return
  }

  const alias = session.alias ? ` (${session.alias})` : ''
  const headerParts = [
    `session: ${session.session_id.slice(0, 8)}${alias}`,
    `state: ${session.state}`,
    'order: newest first',
  ]
  if (newestTimestamp) {
    headerParts.push(`newest: ${formatBoundaryTime(newestTimestamp)}`)
  }
  console.log(`[${headerParts.join(' | ')}]`)

  if (meta.isChain) {
    console.log(`[chain: ${meta.sessionCount} sessions]`)
  }
  if (meta.range) {
    console.log(`[range: ${meta.range.since || '(beginning)'} to ${meta.range.until || '(open)'}]`)
  }
  console.log()

  if (insights.length === 0) {
    if (meta.totalPrimaryAvailable === 0 && meta.totalUserPrompts > 0) {
      console.log(`No primary insights found. This session has ${meta.totalUserPrompts} user prompts recorded.`)
    } else if (args.grep && meta.totalMatched === 0) {
      console.log(`No primary insights matched grep "${args.grep}".`)
    } else {
      console.log('No primary insights found.')
    }
  } else {
    for (const ins of insights) {
      const tags: string[] = []
      if (ins.source === 'user') tags.push('user')
      if (ins.source_session !== session.session_id) {
        tags.push(ins.source_session.slice(0, 8))
      }
      console.log(tags.length > 0 ? `--- [${tags.join(' | ')}] ---` : '---')
      console.log(ins.content)
      console.log()
    }
  }

  const parts: string[] = []
  if (meta.totalMatched != null) {
    parts.push(`${meta.showing} / ${meta.totalMatched} matched primary insights shown`)
    parts.push(`${meta.totalPrimaryAvailable} total primary insights`)
  } else {
    parts.push(`${meta.showing} / ${meta.totalPrimaryAvailable} primary insights shown`)
  }
  if (meta.attachedUserPrompts > 0) {
    parts.push(`+${meta.attachedUserPrompts} user prompts attached`)
  }
  if (args.grep) {
    parts.push(`grep: "${args.grep}"`)
  }
  if (args.offset > 0) {
    parts.push(`offset: ${args.offset}`)
  }
  if (oldestTimestamp && oldestTimestamp !== newestTimestamp) {
    parts.push(`oldest: ${formatBoundaryTime(oldestTimestamp)}`)
  }
  console.log(`[${parts.join(' | ')}]`)
}

export function main(argvInput?: string[]) {
  const args = parseArgs(argvInput)

  if (args.help) {
    console.log(HELP)
    process.exit(0)
  }

  let range: TimeRange | undefined
  try {
    range = resolveTimeRange({ range: args.range, since: args.since, until: args.until })
  } catch (error) {
    console.error(error instanceof Error ? `Error: ${error.message}` : 'Error: invalid time range.')
    process.exit(1)
  }

  if (args.all && !args.list) {
    console.error('Error: --all is supported with --list. Use --help for usage.')
    process.exit(1)
  }

  if (args.all && args.cwd) {
    console.error('Error: --all cannot be combined with --cwd/--dir/--directory.')
    process.exit(1)
  }

  if (args.all && args.session) {
    console.error('Error: --all cannot be combined with --session. --session is already an explicit selection.')
    process.exit(1)
  }

  if (args.chain && !args.list) {
    console.error('Error: --chain (bare flag) is only valid with --list. Use --chain <id> to read a specific chain.')
    process.exit(1)
  }

  if (args.chainId && args.list) {
    console.error('Error: --chain <id> cannot be combined with --list. Use --chain alone for list mode or --chain <id> for read mode.')
    process.exit(1)
  }

  if (args.chainId && args.session) {
    console.error('Error: --chain <id> cannot be combined with --session. Use --chain <id> for chain read mode or --session <id> for session read mode.')
    process.exit(1)
  }

  if (args.chainId) {
    console.error('Error: reading insights by chain id is not yet implemented (coming in Stage 5).')
    process.exit(2)
  }

  const db = openDb()

  if (args.cwd) {
    if (!args.list) {
      console.error('Error: --cwd is supported with --list. Use --help for usage.')
      db.close()
      process.exit(1)
    }
    const candidates = args.grep
      ? findAllSessionsByCwd(db, args.cwd)
      : range
        ? findSessionsByCwdAndRange(db, args.cwd, range, args.limit)
        : findSessionsByCwd(db, args.cwd, args.limit)
    const listed = args.grep
      ? filterSessionsByGrep(
        db,
        range ? filterSessionsByRange(db, candidates, range) : candidates,
        args.grep,
        range
      ).slice(0, args.limit)
      : candidates
    cmdList(
      db,
      listed,
      args,
      range
    )
    db.close()
    return
  }

  if (args.list && args.chain) {
    const chains = listChains(db, args)
    if (args.json) {
      console.log(JSON.stringify(chains, null, 2))
    } else {
      printChainList(chains)
    }
    db.close()
    return
  }

  if (!args.session && args.list) {
    const defaultCwd = args.all ? undefined : process.cwd()
    const candidates = args.grep
      ? defaultCwd
        ? findAllSessionsByCwd(db, defaultCwd)
        : findAllSessions(db)
      : range
        ? defaultCwd
          ? findSessionsByCwdAndRange(db, defaultCwd, range, args.limit)
          : listSessionsByRange(db, range, args.limit)
        : defaultCwd
          ? findSessionsByCwd(db, defaultCwd, args.limit)
          : listRecentSessions(db, args.limit)
    const listed = args.grep
      ? filterSessionsByGrep(
        db,
        range ? filterSessionsByRange(db, candidates, range) : candidates,
        args.grep,
        range
      ).slice(0, args.limit)
      : candidates
    cmdList(db, listed, args, range)
    db.close()
    return
  }

  if (!args.session) {
    console.error('Error: --session <id> is required unless --list is used. Use --help for usage.')
    db.close()
    process.exit(1)
  }

  const sessions = findSessions(db, args.session)

  if (sessions.length === 0) {
    if (args.json) {
      console.log(JSON.stringify({ error: 'No matching sessions', sessions: [] }))
    } else {
      console.log(`No sessions matching "${args.session}".`)
    }
    db.close()
    process.exit(0)
  }

  if (args.list) {
    const candidates = range ? filterSessionsByRange(db, sessions, range) : sessions
    const listed = args.grep
      ? filterSessionsByGrep(db, candidates, args.grep, range).slice(0, args.limit)
      : candidates
    cmdList(db, listed, args, range)
  } else {
    cmdInsights(db, sessions[0], args)
  }

  db.close()
}

const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('read-insights.ts') ||
  process.argv[1].endsWith('read-insights.js')
)

if (isDirectRun) main()
