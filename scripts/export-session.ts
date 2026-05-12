import { writeFileSync } from 'fs'
import Database from 'better-sqlite3'
import { getDbPath } from '../shared/config.js'
import type { SessionExportDepth, SessionExportMode } from '../shared/types.js'
import { exportSessionText } from '../server/services/session-export.js'
import { resolveTimeRange } from '../shared/time-range.js'

interface Args {
  help: boolean
  session?: string
  output?: string
  range?: string
  since?: string
  until?: string
  mode: SessionExportMode
  depth: SessionExportDepth
}

const HELP = `
Session Dashboard — Export CLI

Usage: session-dashboard export --session <id> [options]

Required:
  --session <id>      Session ID (exact or unique prefix)

Export target:
  --mode <kind>       conversation | insights (default: conversation)
  --depth <n|all>     Include predecessor sessions by depth.
                      0=current only, 1=current+1 predecessor (default: 1)

Time filter:
  --range <name>      today | yesterday | week | this-week | last-week
  --since <time>      Include records at or after this time (ISO or YYYY-MM-DD)
  --until <time>      Exclude records at or after this time (ISO or YYYY-MM-DD)
                      Time ranges use [since, until). YYYY-MM-DD means local midnight.
                      Filters apply to both conversation and insights exports.

Output:
  --output <path>     Write txt output to file instead of stdout
  --help              Show this help

Examples:
  session-dashboard export --session 019cfbcb
  session-dashboard export --session 019cfbcb --depth all --output chat.txt
  session-dashboard export --session 019cfbcb --mode insights --depth 2
  session-dashboard export --session 019cfbcb --mode insights --range week
  session-dashboard export --session 019cfbcb --mode conversation --since 2026-05-04 --until 2026-05-11
`.trim()

function parseDepth(value: string | undefined): SessionExportDepth {
  if (!value) return 1
  if (value === 'all') return 'all'
  const parsed = Number.parseInt(value, 10)
  if (Number.isNaN(parsed)) {
    console.error(`Error: invalid depth "${value}". Use a non-negative integer or "all".`)
    process.exit(1)
  }
  return Math.max(0, parsed)
}

function parseArgs(argvInput?: string[]): Args {
  const argv = argvInput ?? process.argv.slice(2)
  const args: Args = {
    help: false,
    mode: 'conversation',
    depth: 1,
  }

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--help':
      case '-h':
        args.help = true
        break
      case '--session':
        args.session = argv[++i]
        break
      case '--output':
        args.output = argv[++i]
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
      case '--mode': {
        const mode = argv[++i]
        if (mode !== 'conversation' && mode !== 'insights') {
          console.error(`Error: invalid mode "${mode}".`)
          process.exit(1)
        }
        args.mode = mode
        break
      }
      case '--depth':
        args.depth = parseDepth(argv[++i])
        break
    }
  }

  return args
}

export function main(argvInput?: string[]) {
  const args = parseArgs(argvInput)

  if (args.help) {
    console.log(HELP)
    process.exit(0)
  }

  if (!args.session) {
    console.error('Error: --session <id> is required. Use --help for usage.')
    process.exit(1)
  }

  const db = new Database(getDbPath(), { readonly: true })
  try {
    let range
    try {
      range = resolveTimeRange({ range: args.range, since: args.since, until: args.until })
    } catch (error) {
      console.error(error instanceof Error ? `Error: ${error.message}` : 'Error: invalid time range.')
      process.exit(1)
    }

    const result = exportSessionText(db, {
      sessionId: args.session,
      mode: args.mode,
      depth: args.depth,
      range,
    })

    if (!result.ok) {
      console.error(result.error.message)
      if (result.error.matching_sessions?.length) {
        for (const session of result.error.matching_sessions) {
          console.error(`- ${session.session_id} ${session.display_name} (${session.source})`)
        }
      }
      if (result.error.missing_sessions?.length) {
        for (const session of result.error.missing_sessions) {
          console.error(`- ${session.session_id} ${session.display_name}: ${session.reason}`)
        }
        console.error('\nTip: retry with `--mode insights` to export the recoverable insight history.')
      }
      process.exit(1)
    }

    if (args.output) {
      writeFileSync(args.output, result.data.content, 'utf8')
      console.log(`Exported ${result.data.mode} to ${args.output}`)
    } else {
      process.stdout.write(result.data.content)
    }
  } finally {
    db.close()
  }
}

const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('export-session.ts') ||
  process.argv[1].endsWith('export-session.js')
)

if (isDirectRun) main()
