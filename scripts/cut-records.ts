import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { getDbPath } from '../shared/config.js'
import type { SessionExportFailure, SessionTranscriptRecord } from '../shared/types.js'
import { readSessionTranscriptRecords, resolveExactSession, resolveSession, type ExportSession } from '../server/services/session-export.js'

interface Args {
  help: boolean
  from?: string
  to?: string
  session?: string
  output?: string
}

interface MatchCandidate {
  index: number
  record: SessionTranscriptRecord
}

const HELP = `
Session Dashboard — Records Cut

Usage:
  session-dashboard records cut --from <text> --to <text> [options]

Required:
  --from <text>       Text that identifies the first included record
  --to <text>         Text that identifies the last included record

Options:
  --session <id>      Session ID or unique prefix.
                      Defaults to exact SESSION_DASHBOARD_SESSION_ID when set.
  --output <path>     Markdown file path.
                      Defaults to .session-dashboard/records/<timestamp>-<session>.md
  --help              Show this help

Behavior:
  Saves the selected record range to a Markdown file and prints only a short summary.
  The from/to records are included. Full transcript output is not supported.
`.trim()

function parseArgs(argvInput?: string[]): Args {
  const argv = argvInput ?? process.argv.slice(2)
  const args: Args = { help: false }

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--help':
      case '-h':
        args.help = true
        break
      case '--from':
        args.from = argv[++i]
        break
      case '--to':
        args.to = argv[++i]
        break
      case '--session':
        args.session = argv[++i]
        break
      case '--output':
        args.output = argv[++i]
        break
      default:
        console.error(`Error: unknown option "${argv[i]}". Use --help for usage.`)
        process.exit(1)
    }
  }

  return args
}

function currentSessionId(): string | undefined {
  return process.env.SESSION_DASHBOARD_SESSION_ID
}

function roleLabel(role: SessionTranscriptRecord['role']): string {
  if (role === 'agent') return 'assistant'
  return role
}

function findMatches(records: SessionTranscriptRecord[], needle: string): MatchCandidate[] {
  return records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => record.text.includes(needle))
}

function findUniqueRange(
  records: SessionTranscriptRecord[],
  fromText: string,
  toText: string
): {
  ok: true
  from: MatchCandidate
  to: MatchCandidate
} | {
  ok: false
  fromMatches: MatchCandidate[]
  toMatches: MatchCandidate[]
  rangeCount: number
} {
  const fromMatches = findMatches(records, fromText)
  const toMatches = findMatches(records, toText)
  const rangeCount = fromMatches.flatMap((from) => (
    toMatches.filter((to) => to.index >= from.index)
  )).length

  if (fromMatches.length === 1 && toMatches.length === 1 && toMatches[0].index >= fromMatches[0].index) {
    return { ok: true, from: fromMatches[0], to: toMatches[0] }
  }

  return { ok: false, fromMatches, toMatches, rangeCount }
}

function printCandidates(label: string, matches: MatchCandidate[]) {
  if (matches.length === 0) {
    console.error(`${label}: no matches`)
    return
  }
  console.error(`${label}: ${matches.length} matches`)
  for (const match of matches.slice(0, 8)) {
    console.error(
      `${match.index + 1}  ${roleLabel(match.record.role)}  ${match.record.timestamp}`
    )
  }
  if (matches.length > 8) {
    console.error(`... ${matches.length - 8} more`)
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function safeTimestamp(value: string): string {
  return value.replace(/[:.]/g, '-')
}

function defaultOutputPath(session: ExportSession, firstRecord: SessionTranscriptRecord): string {
  const dir = join(process.cwd(), '.session-dashboard', 'records')
  mkdirSync(dir, { recursive: true })
  const timestamp = safeTimestamp(firstRecord.timestamp || new Date().toISOString())
  return join(dir, `${timestamp}-${session.session_id.slice(0, 8)}.md`)
}

function markdownEscapeFence(text: string): string {
  return text.replace(/```/g, '``\\`')
}

function formatRecord(record: SessionTranscriptRecord): string {
  return [
    `## ${roleLabel(record.role)} | ${record.timestamp}`,
    '',
    markdownEscapeFence(record.text),
    '',
  ].join('\n')
}

function formatSegment(session: ExportSession, selected: SessionTranscriptRecord[]): string {
  const first = selected[0]
  const last = selected[selected.length - 1]
  return [
    '# Session Record Segment',
    '',
    `session: ${session.session_id}`,
    `source: ${session.source}`,
    `cwd: ${session.cwd}`,
    `transcript: ${session.transcript_path || '(missing)'}`,
    `from: ${roleLabel(first.role)} ${first.timestamp}`,
    `to: ${roleLabel(last.role)} ${last.timestamp}`,
    `records: ${selected.length}`,
    '',
    '# Conversation',
    '',
    ...selected.map(formatRecord),
  ].join('\n').trimEnd() + '\n'
}

function printFailure(error: SessionExportFailure) {
  console.error(error.message)
  if (error.matching_sessions?.length) {
    for (const session of error.matching_sessions) {
      console.error(`- ${session.session_id} ${session.display_name} (${session.source})`)
    }
  }
  if (error.missing_sessions?.length) {
    for (const session of error.missing_sessions) {
      console.error(`- ${session.session_id} ${session.display_name}: ${session.reason}`)
    }
  }
}

export function main(argvInput?: string[]) {
  const args = parseArgs(argvInput)

  if (args.help) {
    console.log(HELP)
    process.exit(0)
  }

  if (!args.from || !args.to) {
    console.error('Error: --from and --to are required. Use --help for usage.')
    process.exit(1)
  }

  const envSessionId = currentSessionId()
  const sessionId = args.session || envSessionId
  if (!sessionId) {
    console.error('Error: --session <id> is required when SESSION_DASHBOARD_SESSION_ID is not set.')
    process.exit(1)
  }

  const db = new Database(getDbPath(), { readonly: true })
  try {
    const session = args.session ? resolveSession(db, sessionId) : resolveExactSession(db, sessionId)
    if ('error' in session) {
      printFailure(session)
      process.exit(1)
    }

    const transcript = readSessionTranscriptRecords(session)
    if (!transcript.ok) {
      printFailure(transcript.error)
      process.exit(1)
    }

    const range = findUniqueRange(transcript.records, args.from, args.to)
    if (!range.ok) {
      console.error(`Error: from/to text did not identify exactly one record range. Candidate ranges: ${range.rangeCount}`)
      printCandidates('from', range.fromMatches)
      printCandidates('to', range.toMatches)
      process.exit(1)
    }

    const selected = transcript.records.slice(range.from.index, range.to.index + 1)
    const content = formatSegment(session, selected)
    const outputPath = resolve(args.output || defaultOutputPath(session, selected[0]))
    const outputDir = dirname(outputPath)
    if (outputDir && !existsSync(outputDir)) mkdirSync(outputDir, { recursive: true })
    writeFileSync(outputPath, content, 'utf8')

    console.log(`saved: ${outputPath}`)
    console.log(`records: ${selected.length}`)
    console.log(`chars: ${content.length}`)
    console.log(`estimated_tokens: ${estimateTokens(content)}`)
    console.log(`from: ${roleLabel(selected[0].role)} ${selected[0].timestamp}`)
    console.log(`to: ${roleLabel(selected[selected.length - 1].role)} ${selected[selected.length - 1].timestamp}`)
  } finally {
    db.close()
  }
}

const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('cut-records.ts') ||
  process.argv[1].endsWith('cut-records.js')
)

if (isDirectRun) main()
