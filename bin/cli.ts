/**
 * Session Dashboard CLI
 *
 * Usage: session-dashboard <command> [options]
 */

import { resolve } from 'path'
import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync, mkdirSync, copyFileSync } from 'fs'
import { homedir } from 'os'
import { spawn, execSync } from 'child_process'
import http from 'http'
import { getHomeDir, getPidPath, getLogPath, getPort, DEFAULT_PORT } from '../shared/config.js'
import { INSIGHT_USAGE_MANUAL, CLAUDE_SPECIFIC_NOTES } from '../shared/insight-usage.js'

const STARTUP_GRACE_MS = 800
const LAUNCH_AGENT_LABEL = 'com.tanmika.session-dashboard'

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
  install-service
              Install and start the macOS background service
  uninstall-service
              Stop and remove the macOS background service
  service-status
              Show macOS background service status
  insights    Read/search insight history. Try: session-dashboard insights --help
              Key filters: --list, --cwd, --all, --grep, --range, --since, --until, --chain, --include-subagents
  records     Cut a raw conversation range to a file. Try: session-dashboard records cut --help
              Key filters: --session, --chain
  export      Export conversation or insights. Try: session-dashboard export --help
              Key filters: --mode, --depth, --chain, --include-subagents, --range, --since, --until
  open        Open the web UI in your default browser
  serve       Run the server in the foreground (for debugging)

Options:
  --help, -h     Show help
  --version, -v  Show version

Environment:
  SESSION_DASHBOARD_HOME   Data directory (default: ~/.session-dashboard)
  SESSION_DASHBOARD_PORT   Server port (default: ${DEFAULT_PORT})
  SESSION_DASHBOARD_URL    Hook target URL (default: http://localhost:${DEFAULT_PORT})
`.trim()

// ─── PID helpers ───

function readPid(): number | null {
  const pidPath = getPidPath()
  if (!existsSync(pidPath)) return null
  const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10)
  if (isNaN(pid)) return null
  return pid
}

function removePidFile(): boolean {
  try {
    unlinkSync(getPidPath())
    return true
  } catch {
    return false
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function getLaunchAgentPath(): string {
  return resolve(homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`)
}

function getGuiDomain(): string {
  const uid = process.getuid?.()
  if (uid == null) {
    throw new Error('launchd service commands require a POSIX user id')
  }
  return `gui/${uid}`
}

function launchctl(args: string[], stdio: 'ignore' | 'inherit' | 'pipe' = 'ignore'): string {
  return execSync(['launchctl', ...args].map((part) => JSON.stringify(part)).join(' '), {
    encoding: 'utf-8',
    stdio,
  }) as string
}

function getServiceInfo(): { installed: boolean; loaded: boolean; pid?: string; state?: string } {
  if (!isMacOS()) return { installed: false, loaded: false }

  const installed = existsSync(getLaunchAgentPath())
  try {
    const output = launchctl(['print', `${getGuiDomain()}/${LAUNCH_AGENT_LABEL}`], 'pipe')
    return {
      installed,
      loaded: true,
      pid: output.match(/\bpid = (\d+)/)?.[1],
      state: output.match(/\bstate = ([^\n]+)/)?.[1]?.trim(),
    }
  } catch {
    return { installed, loaded: false }
  }
}

async function checkHealth(port = getPort()): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolveHealth) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/health',
      method: 'GET',
      timeout: 800,
    }, (res) => {
      res.resume()
      resolveHealth({
        ok: res.statusCode === 200,
        detail: res.statusCode ? `HTTP ${res.statusCode}` : 'no status',
      })
    })

    req.on('timeout', () => {
      req.destroy()
      resolveHealth({ ok: false, detail: 'timeout' })
    })
    req.on('error', (error: NodeJS.ErrnoException) => {
      resolveHealth({ ok: false, detail: error.code || error.message })
    })
    req.end()
  })
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

  // 5. Install login-time service on macOS
  cmdInstallService()

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

async function cmdStop() {
  const service = getServiceInfo()
  if (service.installed) {
    cmdUninstallService()
    return
  }

  const pid = readPid()
  if (!pid) {
    console.log('[session-dashboard] not running (no PID file)')
    return
  }

  if (!isProcessAlive(pid)) {
    console.log(`[session-dashboard] process ${pid} not found, cleaning up PID file`)
    if (!removePidFile()) {
      console.log(`  PID file could not be removed: ${getPidPath()}`)
    }
    return
  }

  process.kill(pid, 'SIGTERM')
  if (!removePidFile()) {
    console.log(`  PID file could not be removed: ${getPidPath()}`)
  }
  console.log(`[session-dashboard] stopped (PID: ${pid})`)
}

async function cmdStatus() {
  const pid = readPid()
  const port = getPort()
  const service = getServiceInfo()
  const health = await checkHealth(port)

  if (service.loaded) {
    console.log(health.ok
      ? '[session-dashboard] running via macOS service'
      : '[session-dashboard] macOS service loaded, HTTP unavailable'
    )
    if (service.pid) console.log(`  PID:  ${service.pid}`)
    if (service.state) console.log(`  State: ${service.state}`)
    console.log(`  Port: ${port}`)
    console.log(`  URL:  http://localhost:${port}`)
    console.log(`  HTTP: ${health.ok ? 'ok' : health.detail}`)
    console.log(`  Log:  ${getLogPath()}`)
    console.log(`  Data: ${getHomeDir()}`)
    if (pid && !isProcessAlive(pid)) {
      console.log(`  Stale PID: ${pid}`)
    }
    return
  }

  if (!pid) {
    console.log(health.ok ? '[session-dashboard] running' : '[session-dashboard] not running')
    if (service.installed) {
      console.log(`  Service: installed but not loaded (${LAUNCH_AGENT_LABEL})`)
    }
    if (health.ok) {
      console.log(`  Port: ${port}`)
      console.log(`  URL:  http://localhost:${port}`)
      console.log('  HTTP: ok')
    }
    return
  }

  if (isProcessAlive(pid)) {
    console.log(`[session-dashboard] running`)
    console.log(`  PID:  ${pid}`)
    console.log(`  Port: ${port}`)
    console.log(`  URL:  http://localhost:${port}`)
    console.log(`  HTTP: ${health.ok ? 'ok' : health.detail}`)
    console.log(`  Log:  ${getLogPath()}`)
    console.log(`  Data: ${getHomeDir()}`)
  } else {
    console.log(`[session-dashboard] not running (stale PID: ${pid})`)
    if (!removePidFile()) {
      console.log(`  Stale PID file could not be removed: ${getPidPath()}`)
    }
    if (service.loaded) {
      console.log(`  Service: running${service.pid ? ` (PID: ${service.pid})` : ''}`)
    }
  }
}

// ─── macOS launchd service helpers ───

function isMacOS(): boolean {
  return process.platform === 'darwin'
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function getServiceProgramArguments(): string[] {
  const serverScript = resolve(import.meta.dirname, '..', 'lib', 'server.js')
  return [process.execPath, serverScript]
}

function getLaunchAgentPlist(): string {
  const args = getServiceProgramArguments()
  const home = getHomeDir()
  const logPath = getLogPath()
  const port = String(getPort())

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SESSION_DASHBOARD_HOME</key>
    <string>${xmlEscape(home)}</string>
    <key>SESSION_DASHBOARD_PORT</key>
    <string>${xmlEscape(port)}</string>
    <key>SESSION_DASHBOARD_URL</key>
    <string>http://localhost:${xmlEscape(port)}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(resolve(import.meta.dirname, '..'))}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`
}

function bootstrapService(plistPath: string) {
  try {
    launchctl(['bootout', getGuiDomain(), plistPath])
  } catch {
    // Service may not be loaded yet.
  }
  launchctl(['bootstrap', getGuiDomain(), plistPath])
  launchctl(['enable', `${getGuiDomain()}/${LAUNCH_AGENT_LABEL}`])
  launchctl(['kickstart', '-k', `${getGuiDomain()}/${LAUNCH_AGENT_LABEL}`])
}

function cmdInstallService() {
  if (process.argv.includes('--print-plist')) {
    console.log(getLaunchAgentPlist())
    return
  }

  if (!isMacOS()) {
    console.log('[session-dashboard] launchd service is only available on macOS')
    return
  }

  const serverScript = resolve(import.meta.dirname, '..', 'lib', 'server.js')
  if (!existsSync(serverScript)) {
    console.error(`Error: server bundle not found at ${serverScript}`)
    console.error('Run "npm run build" first, then run "session-dashboard install-service".')
    process.exit(1)
  }

  mkdirSync(resolve(getHomeDir(), 'data'), { recursive: true })
  mkdirSync(resolve(homedir(), 'Library', 'LaunchAgents'), { recursive: true })

  const plistPath = getLaunchAgentPath()
  const nextPlist = getLaunchAgentPlist()
  const currentPlist = existsSync(plistPath) ? readFileSync(plistPath, 'utf-8') : ''
  if (currentPlist !== nextPlist) {
    writeFileSync(plistPath, nextPlist)
  }

  bootstrapService(plistPath)
  console.log(`[session-dashboard] service installed: ${LAUNCH_AGENT_LABEL}`)
  console.log(`[session-dashboard] URL: http://localhost:${getPort()}`)
  console.log(`[session-dashboard] log: ${getLogPath()}`)
}

function cmdUninstallService() {
  if (!isMacOS()) {
    console.log('[session-dashboard] launchd service is only available on macOS')
    return
  }

  const plistPath = getLaunchAgentPath()
  if (existsSync(plistPath)) {
    try {
      launchctl(['bootout', getGuiDomain(), plistPath])
    } catch {
      // Service may already be stopped.
    }
    unlinkSync(plistPath)
    console.log(`[session-dashboard] service removed: ${LAUNCH_AGENT_LABEL}`)
    return
  }

  console.log('[session-dashboard] service not installed')
}

async function cmdServiceStatus() {
  if (!isMacOS()) {
    console.log('[session-dashboard] launchd service is only available on macOS')
    return
  }

  const service = getServiceInfo()
  const health = await checkHealth()
  if (service.loaded) {
    console.log(health.ok
      ? '[session-dashboard] service installed and reachable'
      : '[session-dashboard] service installed, HTTP unavailable'
    )
    console.log(`  Label: ${LAUNCH_AGENT_LABEL}`)
    console.log(`  State: ${service.state || 'unknown'}`)
    if (service.pid) console.log(`  PID:   ${service.pid}`)
    console.log(`  URL:   http://localhost:${getPort()}`)
    console.log(`  HTTP:  ${health.ok ? 'ok' : health.detail}`)
    console.log(`  Log:   ${getLogPath()}`)
    return
  }

  console.log(service.installed
    ? '[session-dashboard] service installed but not loaded'
    : '[session-dashboard] service not installed'
  )
}

async function cmdInsights() {
  const { main } = await import('../scripts/read-insights.js')
  main(process.argv.slice(3))
}

async function cmdExport() {
  const { main } = await import('../scripts/export-session.js')
  main(process.argv.slice(3))
}

async function cmdRecords() {
  const subcommand = process.argv[3]
  if (subcommand === 'cut') {
    const { main } = await import('../scripts/cut-records.js')
    main(process.argv.slice(4))
    return
  }

  console.log(`
Session Dashboard — Records CLI

Usage:
  session-dashboard records cut --from <text> --to <text> [options]

Commands:
  cut        Save a raw conversation range to a Markdown file

Options:
  --help    Show this help
`.trim())
  if (subcommand && subcommand !== '--help' && subcommand !== '-h') {
    process.exit(1)
  }
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
    await cmdStop()
    break
  case 'status':
    await cmdStatus()
    break
  case 'install-service':
    cmdInstallService()
    break
  case 'uninstall-service':
    cmdUninstallService()
    break
  case 'service-status':
    await cmdServiceStatus()
    break
  case 'insights':
    await cmdInsights()
    break
  case 'export':
    await cmdExport()
    break
  case 'records':
    await cmdRecords()
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
