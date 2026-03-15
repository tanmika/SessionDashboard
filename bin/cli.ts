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
  const { setupHooks } = await import('../scripts/setup-hooks.js')
  const packageRoot = resolve(import.meta.dirname, '..')
  setupHooks({ packageRoot })

  // 3. Setup codex insight instructions (non-fatal if ~/.codex doesn't exist)
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
## Session Insight Recovery

上下文压缩后，可通过 Session Dashboard CLI 恢复之前的 insights。你的 session_id 在 session 开始时已通过 hook 注入到上下文中（格式: "Your current session_id is: xxx"）。

**使用方式**：启动 Explore subagent 运行 CLI，让 subagent 阅读整理后返回精炼摘要，避免原始 insights 消耗主上下文 token。

\`\`\`bash
# 读取当前 session 最近 30 条 insights
session-dashboard insights --session <your-session-id> --limit 30

# 含 predecessor 链的 insights（上下文 clear 后恢复前序工作）
session-dashboard insights --session <your-session-id> --chain --limit 50

# 按关键词过滤
session-dashboard insights --session <your-session-id> --grep "关键词"

# 翻页
session-dashboard insights --session <your-session-id> --limit 30 --offset 30
\`\`\`

完整参数: \`session-dashboard insights --help\`。工具直接读 SQLite DB，不依赖 server。
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

function cmdStart() {
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
  // Rewrite argv so read-insights sees the right args
  // Original: session-dashboard insights --session abc --limit 30
  // Need:     read-insights --session abc --limit 30
  process.argv = [process.argv[0], 'insights', ...process.argv.slice(3)]
  const { main } = await import('../scripts/read-insights.js')
  main()
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
    cmdStart()
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
