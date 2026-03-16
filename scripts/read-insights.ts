/**
 * Session Dashboard — Insight Recovery CLI
 *
 * Reads insights directly from the SQLite database (offline, no server needed).
 * Designed for AI consumption: after context compression, a subagent runs this
 * tool to recover prior session insights.
 *
 * Usage: npx tsx scripts/read-insights.ts [options]
 * Run with --help for full option list.
 */

import Database from 'better-sqlite3'
import { getDbPath } from '../shared/config.js'

const DB_PATH = getDbPath()

// ─── Types ───

interface Args {
  help: boolean
  session?: string
  limit: number
  offset: number
  grep?: string
  chain: boolean
  list: boolean
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

type InsightRow = { content: string; timestamp: string; source?: string }

// ─── Help ───

const HELP = `
Session Dashboard — Insight Recovery CLI

Usage: npx tsx scripts/read-insights.ts --session <id> [options]

Required:
  --session <id>     Session ID (supports prefix match, e.g. "a1b2")

Options:
  --limit <n>        Max insights to return (default: 50)
  --offset <n>       Skip first n results, for pagination (default: 0)
  --grep <pattern>   Filter insights by regex pattern (case-insensitive)
  --chain            Include predecessor sessions' insights (merged, newest first)
  --list             List matching sessions instead of showing insights
  --json             Output as JSON
  --help             Show this help

Examples:
  # List sessions matching a prefix
  npx tsx scripts/read-insights.ts --session a1b2 --list

  # Read latest 30 insights
  npx tsx scripts/read-insights.ts --session a1b2c3d4 --limit 30

  # Search for keyword
  npx tsx scripts/read-insights.ts --session a1b2 --grep "pagination"

  # Read with predecessor chain
  npx tsx scripts/read-insights.ts --session a1b2 --chain --limit 50

  # Paginate: get next page
  npx tsx scripts/read-insights.ts --session a1b2 --limit 30 --offset 30
`.trim()

// ─── Arg parsing ───

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  const args: Args = {
    help: false,
    limit: 50,
    offset: 0,
    chain: false,
    list: false,
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
      case '--limit':
        args.limit = parseInt(argv[++i], 10)
        break
      case '--offset':
        args.offset = parseInt(argv[++i], 10)
        break
      case '--grep':
        args.grep = argv[++i]
        break
      case '--chain':
        args.chain = true
        break
      case '--list':
        args.list = true
        break
      case '--json':
        args.json = true
        break
    }
  }

  return args
}

// ─── Helpers ───

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
  return db.prepare(
    `SELECT session_id, cwd, state, alias, source, last_activity, created_at, predecessor_id
     FROM sessions
     WHERE session_id = ? OR session_id LIKE ?
     ORDER BY last_activity DESC`
  ).all(sessionPrefix, `${sessionPrefix}%`) as SessionRow[]
}

/** Walk the predecessor chain starting from a session, return all session_ids in order. */
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

// ─── Commands ───

function cmdList(db: Database.Database, sessions: SessionRow[], args: Args) {
  const stmtCount = db.prepare('SELECT COUNT(*) as count FROM insights WHERE session_id = ?')

  if (args.json) {
    const data = sessions.map(s => ({
      ...s,
      insights_count: (stmtCount.get(s.session_id) as { count: number }).count,
    }))
    console.log(JSON.stringify(data, null, 2))
    return
  }

  console.log(
    'SESSION_ID'.padEnd(12) +
    'STATE'.padEnd(12) +
    'SOURCE'.padEnd(8) +
    'INSIGHTS'.padEnd(10) +
    'LAST_ACTIVE'.padEnd(13) +
    'ALIAS / CWD'
  )
  console.log('─'.repeat(80))

  for (const s of sessions) {
    const count = (stmtCount.get(s.session_id) as { count: number }).count
    const label = s.alias || s.cwd
    console.log(
      s.session_id.slice(0, 10).padEnd(12) +
      s.state.padEnd(12) +
      s.source.padEnd(8) +
      String(count).padEnd(10) +
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

  // Count totals
  const stmtCount = db.prepare('SELECT COUNT(*) as count FROM insights WHERE session_id = ?')
  const totalAvailable = sessionIds.reduce(
    (sum, id) => sum + (stmtCount.get(id) as { count: number }).count, 0
  )

  let insights: (InsightRow & { source_session?: string })[]

  if (args.grep) {
    // Grep mode: fetch all, filter in JS, then apply limit+offset
    let re: RegExp
    try {
      re = new RegExp(args.grep, 'i')
    } catch {
      console.error(`Error: invalid regex pattern "${args.grep}"`)
      process.exit(1)
    }

    const placeholders = sessionIds.map(() => '?').join(',')
    const allInsights = db.prepare(
      `SELECT content, timestamp, source, session_id as source_session FROM insights
       WHERE session_id IN (${placeholders})
       ORDER BY timestamp DESC`
    ).all(...sessionIds) as (InsightRow & { source_session: string })[]

    const matched = allInsights.filter(ins => re.test(ins.content))
    const totalMatched = matched.length
    insights = matched.slice(args.offset, args.offset + args.limit)

    outputInsights(targetSession, insights, args, {
      showing: insights.length,
      totalAvailable,
      totalMatched,
      isChain: args.chain,
      sessionCount: sessionIds.length,
    })
  } else {
    // Normal mode: SQL limit+offset
    if (sessionIds.length === 1) {
      insights = db.prepare(
        `SELECT content, timestamp, source FROM insights
         WHERE session_id = ?
         ORDER BY timestamp DESC
         LIMIT ? OFFSET ?`
      ).all(targetSession.session_id, args.limit, args.offset) as InsightRow[]
    } else {
      const placeholders = sessionIds.map(() => '?').join(',')
      insights = db.prepare(
        `SELECT content, timestamp, source, session_id as source_session FROM insights
         WHERE session_id IN (${placeholders})
         ORDER BY timestamp DESC
         LIMIT ? OFFSET ?`
      ).all(...sessionIds, args.limit, args.offset) as (InsightRow & { source_session: string })[]
    }

    outputInsights(targetSession, insights, args, {
      showing: insights.length,
      totalAvailable,
      isChain: args.chain,
      sessionCount: sessionIds.length,
    })
  }
}

interface OutputMeta {
  showing: number
  totalAvailable: number
  totalMatched?: number
  isChain: boolean
  sessionCount: number
}

function outputInsights(
  session: SessionRow,
  insights: (InsightRow & { source_session?: string })[],
  args: Args,
  meta: OutputMeta
) {
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
      showing: meta.showing,
      total_available: meta.totalAvailable,
      ...(meta.totalMatched != null ? { total_matched: meta.totalMatched } : {}),
      offset: args.offset,
      limit: args.limit,
      ...(args.grep ? { grep: args.grep } : {}),
      ...(meta.isChain ? { chain_sessions: meta.sessionCount } : {}),
      insights: insights.map(ins => ({
        content: ins.content,
        ...(ins.source ? { source: ins.source } : {}),
        ...(ins.source_session ? { session: ins.source_session.slice(0, 8) } : {}),
      })),
    }, null, 2))
    return
  }

  // Header
  const alias = session.alias ? ` (${session.alias})` : ''
  console.log(`[session: ${session.session_id.slice(0, 8)}${alias} | state: ${session.state}]`)

  if (meta.isChain) {
    console.log(`[chain: ${meta.sessionCount} sessions]`)
  }
  console.log()

  if (insights.length === 0) {
    console.log('No insights found.')
  } else {
    for (const ins of insights) {
      // Build separator with metadata tags
      const tags: string[] = []
      if (ins.source === 'user') tags.push('user')
      if (ins.source_session && ins.source_session !== session.session_id) {
        tags.push(ins.source_session.slice(0, 8))
      }
      console.log(tags.length > 0 ? `--- [${tags.join(' | ')}] ---` : '---')
      console.log(ins.content)
      console.log()
    }
  }

  // Footer stats
  const parts: string[] = []
  parts.push(`${meta.showing} / ${meta.totalAvailable} insights shown`)
  if (meta.totalMatched != null) {
    parts.push(`${meta.totalMatched} matched grep`)
  }
  if (args.grep) {
    parts.push(`grep: "${args.grep}"`)
  }
  if (args.offset > 0) {
    parts.push(`offset: ${args.offset}`)
  }
  console.log(`[${parts.join(' | ')}]`)
}

// ─── Main ───

export function main() {
  const args = parseArgs()

  if (args.help) {
    console.log(HELP)
    process.exit(0)
  }

  if (!args.session) {
    console.error('Error: --session <id> is required. Use --help for usage.')
    process.exit(1)
  }

  const db = openDb()
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
    cmdList(db, sessions, args)
  } else {
    cmdInsights(db, sessions[0], args)
  }

  db.close()
}

// Direct execution support
const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('read-insights.ts') ||
  process.argv[1].endsWith('read-insights.js')
)
if (isDirectRun) main()
