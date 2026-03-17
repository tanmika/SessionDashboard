/**
 * Session Dashboard CLI
 *
 * Usage: session-dashboard <command> [options]
 */

import { resolve } from 'path'
import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync, mkdirSync, copyFileSync } from 'fs'
import { homedir } from 'os'
import { spawn, execSync } from 'child_process'
import { getHomeDir, getPidPath, getLogPath, getPort } from '../shared/config.js'
import { INSIGHT_USAGE_MANUAL, CLAUDE_SPECIFIC_NOTES } from '../shared/insight-usage.js'

const STARTUP_GRACE_MS = 800

// ─── Version ───

function getVersion(): string {
  try {
    const pkgPath = resolve(import.meta.dirname, '..', 'package.json')
    return JSON.parse(readFileSync(pkgPath, 'utf-8')).version
  } catch {
    return '0.0.0'
  }
}

// ─── Help ───

const HELP = `
session-dashboard v${getVersion()}

Usage: session-dashboard <command> [options]

Commands:
  init        Install hooks, inject prompts, create data directory
  start       Start the dashboard server in the background
  stop        Stop the running server
  status      Show server running status
  insights    Read insights from the database (offline CLI)
  export      Export session conversation or insight history to txt
  open        Open the web UI in your default browser
  serve       Run the server in the foreground (for debugging)

Options:
  --help, -h     Show help
  --version, -v  Show version

Environment:
  SESSION_DASHBOARD_HOME   Data directory (default: ~/.session-dashboard)
  SESSION_DASHBOARD_PORT   Server port (default: 3210)
  SESSION_DASHBOARD_URL    Hook target URL (default: http://localhost:3210)
`.trim()

// ─── PID helpers ───

function readPid(): number | null {
  const pidPath = getPidPath()
  if (!existsSync(pidPath)) return null
  const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10)
  if (isNaN(pid)) return null
  return pid
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ─── Commands ───

async function cmdInit() {
  console.log('\n  Session Dashboard — Init\n  ' + '─'.repeat(30))

  // 1. Create data directory
  const home = getHomeDir()
  mkdirSync(resolve(home, 'data'), { recursive: true })
  console.log(`\n  ✓ Data directory: ${home}`)

  // 2. Setup hooks (Claude Code)
  const { setupHooks, setupCodexHooks } = await import('../scripts/setup-hooks.js')
  const packageRoot = resolve(import.meta.dirname, '..')
  setupHooks({ packageRoot })

  // 3. Setup hooks (Codex CLI)
  setupCodexHooks({ packageRoot })

  // 4. Setup codex insight instructions (non-fatal if ~/.codex doesn't exist)
  const { setupCodex } = await import('../scripts/setup-codex.js')
  setupCodex()

  // 4. Inject insight recovery instructions into ~/.claude/CLAUDE.md
  setupClaudeMd()

  console.log('  ✓ Init complete.\n')
}

// ─── CLAUDE.md insight recovery injection ───

const CLAUDE_MD_MARKER_START = '<!-- SESSION-INSIGHT-RECOVERY -->'
const CLAUDE_MD_MARKER_END = '<!-- /SESSION-INSIGHT-RECOVERY -->'

function getClaudeMdBlock(): string {
  return `${CLAUDE_MD_MARKER_START}
${INSIGHT_USAGE_MANUAL}
${CLAUDE_SPECIFIC_NOTES}
${CLAUDE_MD_MARKER_END}`
}

function setupClaudeMd() {
  const claudeMdPath = resolve(homedir(), '.claude', 'CLAUDE.md')

  console.log('\n  Session Dashboard — CLAUDE.md Setup\n  ' + '─'.repeat(38))

  if (!existsSync(resolve(homedir(), '.claude'))) {
    console.log('  ✗ ~/.claude/ directory not found. Skipping.')
    return
  }

  let content = ''
  let existed = false

  if (existsSync(claudeMdPath)) {
    existed = true
    content = readFileSync(claudeMdPath, 'utf-8')
  }

  const block = getClaudeMdBlock()

  if (content.includes(CLAUDE_MD_MARKER_START)) {
    const startIdx = content.indexOf(CLAUDE_MD_MARKER_START)
    const endIdx = content.indexOf(CLAUDE_MD_MARKER_END)

    if (endIdx === -1) {
      content = content.slice(0, startIdx) + block + '\n'
      console.log('  ⚠ Found start marker without end, replacing block...')
    } else {
      const oldBlock = content.slice(startIdx, endIdx + CLAUDE_MD_MARKER_END.length)
      if (oldBlock === block) {
        console.log('  ✓ Insight recovery instructions already up to date.')
        return
      }
      content = content.slice(0, startIdx) + block + content.slice(endIdx + CLAUDE_MD_MARKER_END.length)
      console.log('  ↻ Updated insight recovery instructions.')
    }
  } else {
    const separator = content.length > 0 && !content.endsWith('\n\n') ? '\n\n' : content.endsWith('\n') ? '\n' : '\n\n'
    content = content + separator + block + '\n'
    console.log(`  ✓ ${existed ? 'Appended' : 'Created'} insight recovery instructions.`)
  }

  if (existed) {
    copyFileSync(claudeMdPath, claudeMdPath + '.bak')
    console.log(`  Backup → ${claudeMdPath}.bak`)
  }

  writeFileSync(claudeMdPath, content)
  console.log(`  File: ${claudeMdPath}`)
}

async function cmdStart() {
  const pid = readPid()
  if (pid && isProcessAlive(pid)) {
    console.log(`[session-dashboard] already running (PID: ${pid})`)
    return
  }

  // Ensure home dir exists
  mkdirSync(resolve(getHomeDir(), 'data'), { recursive: true })

  // Resolve server script (lib/server.js in production, or relative to bin/)
  const serverScript = resolve(import.meta.dirname, '..', 'lib', 'server.js')
  if (!existsSync(serverScript)) {
    console.error(`Error: server bundle not found at ${serverScript}`)
    console.error('Run "npm run build" first, or use "session-dashboard serve" for dev mode.')
    process.exit(1)
  }

  const logPath = getLogPath()
  const logFd = openSync(logPath, 'a')

  const child = spawn('node', [serverScript], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
  })

  const startupResult = await Promise.race([
    new Promise<'exited'>((resolve) => child.once('exit', () => resolve('exited'))),
    new Promise<'running'>((resolve) => setTimeout(() => resolve('running'), STARTUP_GRACE_MS)),
  ])

  if (startupResult === 'exited') {
    console.error(`[session-dashboard] failed to start; check log: ${logPath}`)
    process.exit(1)
  }

  child.unref()
  writeFileSync(getPidPath(), String(child.pid))

  const port = getPort()
  console.log(`[session-dashboard] started on http://localhost:${port} (PID: ${child.pid})`)
  console.log(`[session-dashboard] log: ${logPath}`)
}

function cmdStop() {
  const pid = readPid()
  if (!pid) {
    console.log('[session-dashboard] not running (no PID file)')
    return
  }

  if (!isProcessAlive(pid)) {
    console.log(`[session-dashboard] process ${pid} not found, cleaning up PID file`)
    unlinkSync(getPidPath())
    return
  }

  process.kill(pid, 'SIGTERM')
  unlinkSync(getPidPath())
  console.log(`[session-dashboard] stopped (PID: ${pid})`)
}

function cmdStatus() {
  const pid = readPid()
  const port = getPort()

  if (!pid) {
    console.log('[session-dashboard] not running')
    return
  }

  if (isProcessAlive(pid)) {
    console.log(`[session-dashboard] running`)
    console.log(`  PID:  ${pid}`)
    console.log(`  Port: ${port}`)
    console.log(`  URL:  http://localhost:${port}`)
    console.log(`  Log:  ${getLogPath()}`)
    console.log(`  Data: ${getHomeDir()}`)
  } else {
    console.log(`[session-dashboard] not running (stale PID: ${pid})`)
    unlinkSync(getPidPath())
  }
}

async function cmdInsights() {
  const { main } = await import('../scripts/read-insights.js')
  main(process.argv.slice(3))
}

async function cmdExport() {
  const { main } = await import('../scripts/export-session.js')
  main(process.argv.slice(3))
}

function cmdOpen() {
  const port = getPort()
  const url = `http://localhost:${port}`
  try {
    // macOS
    execSync(`open ${url}`, { stdio: 'ignore' })
  } catch {
    try {
      // Linux
      execSync(`xdg-open ${url}`, { stdio: 'ignore' })
    } catch {
      console.log(`Open in your browser: ${url}`)
    }
  }
}

async function cmdServe() {
  // Run server in foreground — try lib/server.js first, fall back to tsx for dev
  const serverScript = resolve(import.meta.dirname, '..', 'lib', 'server.js')
  if (existsSync(serverScript)) {
    await import(serverScript)
  } else {
    // Dev mode: import TypeScript source directly (requires tsx runtime)
    await import('../server/index.js')
  }
}

// ─── Main routing ───

const command = process.argv[2]

switch (command) {
  case 'init':
    await cmdInit()
    break
  case 'start':
    await cmdStart()
    break
  case 'stop':
    cmdStop()
    break
  case 'status':
    cmdStatus()
    break
  case 'insights':
    await cmdInsights()
    break
  case 'export':
    await cmdExport()
    break
  case 'open':
    cmdOpen()
    break
  case 'serve':
    await cmdServe()
    break
  case '--version':
  case '-v':
    console.log(getVersion())
    break
  case '--help':
  case '-h':
  case undefined:
    console.log(HELP)
    break
  default:
    console.error(`Unknown command: ${command}`)
    console.log(`\nRun "session-dashboard --help" for usage.`)
    process.exit(1)
}
