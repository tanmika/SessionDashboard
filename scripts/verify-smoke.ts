import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { applySchema } from '../server/db.js'
import { SessionManager } from '../server/services/session-manager.js'
import { exportSessionText } from '../server/services/session-export.js'
import { TranscriptWatcher } from '../server/services/transcript-watcher.js'
import { extractInsightBlocks, sanitizeUserInput } from '../server/utils/insight-extractor.js'
import { generateChainId, isChainId } from '../shared/chain-id.js'

const repoRoot = resolve(import.meta.dirname, '..')
const nodeBin = process.execPath

function runCommand(command: string, args: string[], options?: {
  cwd?: string
  env?: NodeJS.ProcessEnv
  input?: string
}) {
  const resolvedCommand = command === 'node' ? nodeBin : command
  const result = spawnSync(resolvedCommand, args, {
    cwd: options?.cwd ?? repoRoot,
    env: options?.env,
    input: options?.input,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  })
  assert.equal(
    result.status,
    0,
    `${resolvedCommand} ${args.join(' ')} failed\nerror:\n${result.error?.message || ''}\nsignal:\n${result.signal || ''}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  )
  return result.stdout
}

function spawnNode(args: string[], options?: Parameters<typeof spawnSync>[2]) {
  return spawnSync(nodeBin, args, options)
}

function makeInsightBlock(label: string): string {
  return [
    '`★ Insight ─────────────────────────────────────`',
    `- ${label}`,
    '`─────────────────────────────────────────────────`',
  ].join('\n')
}

function makeFencedInsightBlock(label: string): string {
  return [
    '```text',
    '★ Insight ─────────────────────────────────────',
    `- ${label}`,
    '─────────────────────────────────────────────────',
    '```',
  ].join('\n')
}

function makeAssistantRecord(label: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: makeInsightBlock(label) }],
    },
  }) + '\n'
}

function wait(ms: number) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await wait(50)
  }
  assert.fail(`Timed out waiting for ${label}`)
}

function verifyPackageManifest(tempRoot: string) {
  const npmCache = join(tempRoot, 'npm-cache')
  mkdirSync(npmCache, { recursive: true })
  const stdout = runCommand('npm', ['pack', '--json', '--dry-run'], {
    env: { ...process.env, npm_config_cache: npmCache },
  })
  const packs = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>
  const packedPaths = new Set(packs[0]?.files.map((file) => file.path))
  const requiredPaths = [
    'lib/cli.js',
    'lib/server.js',
    'dist/index.html',
    'hooks/session-hook.sh',
    'hooks/codex-session-hook.sh',
    'scripts/read-insights.js',
    'scripts/setup-hooks.js',
    'scripts/setup-codex.js',
    'scripts/export-session.js',
    'scripts/repair-dashboard.js',
  ]
  for (const file of requiredPaths) {
    assert(packedPaths.has(file), `npm pack manifest is missing ${file}`)
  }
  console.log('verify: package manifest')
}

function verifyBuiltCli() {
  const stdout = runCommand('node', ['lib/cli.js', 'insights', '--list'])
  assert(stdout.includes('SESSION_ID'), 'built CLI insights --list output is missing table header')
  console.log('verify: built CLI')
}

function verifyRuntimeDefaults() {
  const help = runCommand('node', ['lib/cli.js', '--help'])
  assert(help.includes('SESSION_DASHBOARD_PORT   Server port (default: 38473)'), 'CLI help should show the dashboard default port')
  assert(help.includes('SESSION_DASHBOARD_URL    Hook target URL (default: http://localhost:38473)'), 'CLI help should show the hook default URL')
  assert(help.includes('install-service'), 'CLI help should include service installation command')
  assert(help.includes('service-status'), 'CLI help should include service status command')

  const claudeHook = readFileSync(join(repoRoot, 'hooks', 'session-hook.sh'), 'utf-8')
  const codexHook = readFileSync(join(repoRoot, 'hooks', 'codex-session-hook.sh'), 'utf-8')
  const devSimulate = readFileSync(join(repoRoot, 'scripts', 'dev-simulate.sh'), 'utf-8')
  const hookSetup = readFileSync(join(repoRoot, 'HOOKS_SETUP.md'), 'utf-8')
  assert(claudeHook.includes('http://localhost:38473'), 'Claude hook should default to the dashboard port')
  assert(codexHook.includes('http://localhost:38473'), 'Codex hook should default to the dashboard port')
  assert(devSimulate.includes('SESSION_DASHBOARD_PORT:-38473'), 'dev simulation should use the dashboard default port')
  assert(hookSetup.includes('SESSION_DASHBOARD_PORT=4000 SESSION_DASHBOARD_URL=http://localhost:4000'), 'custom port docs should configure server and hook URL together')
  console.log('verify: runtime defaults')
}

function verifyServicePlist(tempRoot: string) {
  const stdout = runCommand('node', ['lib/cli.js', 'install-service', '--print-plist'], {
    env: {
      ...process.env,
      SESSION_DASHBOARD_HOME: join(tempRoot, 'service-home'),
      SESSION_DASHBOARD_PORT: '45678',
    },
  })

  assert(stdout.includes('<string>com.tanmika.session-dashboard</string>'), 'service plist should include launchd label')
  assert(stdout.includes('<key>SESSION_DASHBOARD_PORT</key>'), 'service plist should include port env key')
  assert(stdout.includes('<string>45678</string>'), 'service plist should include configured port')
  assert(stdout.includes('<key>SESSION_DASHBOARD_URL</key>'), 'service plist should include hook URL env key')
  assert(stdout.includes('<string>http://localhost:45678</string>'), 'service plist should keep service and hook URL aligned')
  assert(stdout.includes('<key>KeepAlive</key>'), 'service plist should enable launchd restart')
  assert(stdout.includes('lib/server.js'), 'service plist should run the server directly')
  console.log('verify: service plist')
}

function insertSession(
  db: Database.Database,
  sessionId: string,
  options: {
    cwd: string
    transcriptPath: string
    source: 'claude' | 'codex'
    predecessorId?: string
    chainId?: string
    isSubagent?: boolean
    parentSessionId?: string
  }
) {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO sessions (
      session_id, cwd, transcript_path, state, last_activity, created_at, pinned, alias, source,
      predecessor_id, chain_id, is_subagent, parent_session_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    options.cwd,
    options.transcriptPath,
    'active',
    now,
    now,
    0,
    '',
    options.source,
    options.predecessorId || '',
    options.chainId || '',
    options.isSubagent ? 1 : 0,
    options.parentSessionId || ''
  )
}

function insertInsight(
  db: Database.Database,
  sessionId: string,
  content: string,
  source: 'transcript' | 'hook' | 'user',
  timestamp: string
) {
  db.prepare(
    'INSERT INTO insights (session_id, content, timestamp, source) VALUES (?, ?, ?, ?)'
  ).run(sessionId, content, timestamp, source)
}

function verifyInsightsCwdList(tempRoot: string) {
  const tempHome = join(tempRoot, 'cwd-list-home')
  const dataDir = join(tempHome, 'data')
  mkdirSync(dataDir, { recursive: true })

  const dbPath = join(dataDir, 'dashboard.db')
  const db = new Database(dbPath)
  applySchema(db)

  try {
    insertSession(db, 'project-root-session', {
      cwd: '/tmp/workspace/project',
      transcriptPath: '',
      source: 'claude',
    })
    insertSession(db, 'project-child-session', {
      cwd: '/tmp/workspace/project/package',
      transcriptPath: '',
      source: 'codex',
    })
    insertSession(db, 'project-prefix-session', {
      cwd: '/tmp/workspace/project-extra',
      transcriptPath: '',
      source: 'claude',
    })
    insertSession(db, 'repo-root-session', {
      cwd: repoRoot,
      transcriptPath: '',
      source: 'codex',
    })
    insertSession(db, 'repo-child-session', {
      cwd: join(repoRoot, 'nested-package'),
      transcriptPath: '',
      source: 'claude',
    })
    insertSession(db, 'repo-prefix-session', {
      cwd: `${repoRoot}-extra`,
      transcriptPath: '',
      source: 'codex',
    })

    const defaultStdout = runCommand('node', ['lib/cli.js', 'insights', '--list', '--json'], {
      cwd: repoRoot,
      env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome },
    })
    const defaultIds = (JSON.parse(defaultStdout) as Array<{ session_id: string }>)
      .map((session) => session.session_id)
    assert(defaultIds.includes('repo-root-session'), 'default list should include current directory session')
    assert(defaultIds.includes('repo-child-session'), 'default list should include child directory session')
    assert(!defaultIds.includes('repo-prefix-session'), 'default list should respect directory boundaries')
    assert(!defaultIds.includes('project-root-session'), 'default list should not include unrelated directories')

    const stdout = runCommand('node', ['lib/cli.js', 'insights', '--cwd', '/tmp/workspace/project', '--list', '--json'], {
      env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome },
    })
    const sessions = JSON.parse(stdout) as Array<{ session_id: string; cwd: string; source: string }>
    const ids = sessions.map((session) => session.session_id)
    const sortedIds = [...ids].sort()
    assert(ids.includes('project-root-session'), 'cwd list should include the exact directory session')
    assert(ids.includes('project-child-session'), 'cwd list should include nested directory sessions')
    assert(!ids.includes('project-prefix-session'), 'cwd list should respect directory boundaries')
    assert(sessions.some((session) => session.source === 'codex'), 'cwd list should include Codex sessions')
    assert(sessions.some((session) => session.source === 'claude'), 'cwd list should include Claude sessions')

    const trailingSlashStdout = runCommand('node', ['lib/cli.js', 'insights', '--cwd', '/tmp/workspace/project/', '--list', '--json'], {
      env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome },
    })
    const trailingSlashSessions = JSON.parse(trailingSlashStdout) as Array<{ session_id: string }>
    assert.deepEqual(
      trailingSlashSessions.map((session) => session.session_id).sort(),
      sortedIds,
      'cwd list should normalize trailing slashes'
    )

    const dirAliasStdout = runCommand('node', ['lib/cli.js', 'insights', '--dir', '/tmp/workspace/project', '--list', '--json'], {
      env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome },
    })
    const directoryAliasStdout = runCommand('node', ['lib/cli.js', 'insights', '--directory', '/tmp/workspace/project', '--list', '--json'], {
      env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome },
    })
    assert.deepEqual(
      (JSON.parse(dirAliasStdout) as Array<{ session_id: string }>).map((session) => session.session_id).sort(),
      sortedIds,
      '--dir should behave like --cwd'
    )
    assert.deepEqual(
      (JSON.parse(directoryAliasStdout) as Array<{ session_id: string }>).map((session) => session.session_id).sort(),
      sortedIds,
      '--directory should behave like --cwd'
    )

    const allStdout = runCommand('node', ['lib/cli.js', 'insights', '--list', '--all', '--json'], {
      cwd: repoRoot,
      env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome },
    })
    const allIds = (JSON.parse(allStdout) as Array<{ session_id: string }>)
      .map((session) => session.session_id)
    assert(allIds.includes('project-root-session'), '--all list should include unrelated directories')
    assert(allIds.includes('repo-root-session'), '--all list should include current directory sessions')
  } finally {
    db.close()
  }
  console.log('verify: insights cwd list')
}

function verifyTimeRangeList(tempRoot: string) {
  const tempHome = join(tempRoot, 'time-range-list-home')
  const dataDir = join(tempHome, 'data')
  mkdirSync(dataDir, { recursive: true })

  const dbPath = join(dataDir, 'dashboard.db')
  const db = new Database(dbPath)
  applySchema(db)

  try {
    insertSession(db, 'range-project-session', {
      cwd: '/tmp/range/project',
      transcriptPath: '',
      source: 'claude',
    })
    insertSession(db, 'range-child-session', {
      cwd: '/tmp/range/project/package',
      transcriptPath: '',
      source: 'codex',
    })
    insertSession(db, 'range-prefix-session', {
      cwd: '/tmp/range/project-extra',
      transcriptPath: '',
      source: 'claude',
    })
    insertSession(db, 'range-old-session', {
      cwd: '/tmp/range/project',
      transcriptPath: '',
      source: 'claude',
    })

    db.prepare('UPDATE sessions SET created_at = ?, last_activity = ? WHERE session_id = ?')
      .run('2026-04-30T10:00:00.000Z', '2026-04-30T10:00:00.000Z', 'range-project-session')
    db.prepare('UPDATE sessions SET created_at = ?, last_activity = ? WHERE session_id = ?')
      .run('2026-04-30T10:00:00.000Z', '2026-05-05T12:00:00.000Z', 'range-child-session')
    db.prepare('UPDATE sessions SET created_at = ?, last_activity = ? WHERE session_id = ?')
      .run('2026-04-30T10:00:00.000Z', '2026-05-05T12:00:00.000Z', 'range-prefix-session')
    db.prepare('UPDATE sessions SET created_at = ?, last_activity = ? WHERE session_id = ?')
      .run('2026-04-30T10:00:00.000Z', '2026-04-30T10:00:00.000Z', 'range-old-session')

    insertInsight(db, 'range-project-session', 'range prompt', 'user', '2026-05-05T09:00:00.000Z')
    insertInsight(db, 'range-project-session', 'range insight', 'transcript', '2026-05-05T09:01:00.000Z')
    insertInsight(db, 'range-old-session', 'old insight', 'transcript', '2026-04-30T09:01:00.000Z')

    const stdout = runCommand('node', [
      'lib/cli.js',
      'insights',
      '--cwd',
      '/tmp/range/project',
      '--list',
      '--json',
      '--since',
      '2026-05-04',
      '--until',
      '2026-05-11',
    ], {
      env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome },
    })
    const parsed = JSON.parse(stdout) as {
      range: { since?: string; until?: string }
      sessions: Array<{
        session_id: string
        changed_in_range: boolean
        new_insights_in_range: number
        new_user_prompts_in_range: number
      }>
    }
    const ids = parsed.sessions.map((session) => session.session_id)
    assert.equal(parsed.range.since, new Date('2026-05-04T00:00:00').toISOString())
    assert.equal(parsed.range.until, new Date('2026-05-11T00:00:00').toISOString())
    assert(ids.includes('range-project-session'), 'range list should include sessions with new insights')
    assert(ids.includes('range-child-session'), 'range list should include sessions with last_activity in range')
    assert(!ids.includes('range-prefix-session'), 'range cwd list should respect directory boundaries')
    assert(!ids.includes('range-old-session'), 'range list should exclude sessions without changes in range')

    const project = parsed.sessions.find((session) => session.session_id === 'range-project-session')
    assert.equal(project?.changed_in_range, true)
    assert.equal(project?.new_insights_in_range, 1)
    assert.equal(project?.new_user_prompts_in_range, 1)

    const sessionListStdout = runCommand('node', [
      'lib/cli.js',
      'insights',
      '--session',
      'range-',
      '--list',
      '--json',
      '--since',
      '2026-05-04',
      '--until',
      '2026-05-11',
    ], {
      env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome },
    })
    const sessionListParsed = JSON.parse(sessionListStdout) as {
      sessions: Array<{ session_id: string }>
    }
    const sessionListIds = sessionListParsed.sessions.map((session) => session.session_id)
    assert(sessionListIds.includes('range-project-session'), 'session prefix list should honor time range')
    assert(!sessionListIds.includes('range-old-session'), 'session prefix list should filter unchanged sessions')
  } finally {
    db.close()
  }
  console.log('verify: insights time range list')
}

function verifyInsightsGrepList(tempRoot: string) {
  const tempHome = join(tempRoot, 'grep-list-home')
  const dataDir = join(tempHome, 'data')
  mkdirSync(dataDir, { recursive: true })

  const dbPath = join(dataDir, 'dashboard.db')
  const db = new Database(dbPath)
  applySchema(db)
  const grepProjectPath = join(tempRoot, 'grep', 'project')
  mkdirSync(grepProjectPath, { recursive: true })
  const grepProject = realpathSync(grepProjectPath)
  const grepChild = join(grepProject, 'pkg')
  const grepPrefix = `${grepProject}-extra`

  try {
    insertSession(db, 'grep-root-session', {
      cwd: grepProject,
      transcriptPath: '',
      source: 'claude',
    })
    insertSession(db, 'grep-child-session', {
      cwd: grepChild,
      transcriptPath: '',
      source: 'codex',
    })
    insertSession(db, 'grep-prefix-session', {
      cwd: grepPrefix,
      transcriptPath: '',
      source: 'codex',
    })
    insertSession(db, 'grep-user-only-session', {
      cwd: grepProject,
      transcriptPath: '',
      source: 'claude',
    })
    insertSession(db, 'grep-old-session', {
      cwd: grepProject,
      transcriptPath: '',
      source: 'claude',
    })
    insertSession(db, 'grep-recent-miss-session', {
      cwd: grepProject,
      transcriptPath: '',
      source: 'codex',
    })

    db.prepare('UPDATE sessions SET created_at = ?, last_activity = ? WHERE session_id = ?')
      .run('2026-05-01T08:00:00.000Z', '2026-05-05T12:00:00.000Z', 'grep-root-session')
    db.prepare('UPDATE sessions SET created_at = ?, last_activity = ? WHERE session_id = ?')
      .run('2026-05-01T08:00:00.000Z', '2026-05-06T12:00:00.000Z', 'grep-child-session')
    db.prepare('UPDATE sessions SET created_at = ?, last_activity = ? WHERE session_id = ?')
      .run('2026-05-01T08:00:00.000Z', '2026-05-06T12:00:00.000Z', 'grep-prefix-session')
    db.prepare('UPDATE sessions SET created_at = ?, last_activity = ? WHERE session_id = ?')
      .run('2026-05-01T08:00:00.000Z', '2026-05-07T12:00:00.000Z', 'grep-user-only-session')
    db.prepare('UPDATE sessions SET created_at = ?, last_activity = ? WHERE session_id = ?')
      .run('2026-05-01T08:00:00.000Z', '2026-04-30T12:00:00.000Z', 'grep-old-session')
    db.prepare('UPDATE sessions SET created_at = ?, last_activity = ? WHERE session_id = ?')
      .run('2026-05-01T08:00:00.000Z', '2026-05-08T12:00:00.000Z', 'grep-recent-miss-session')

    insertInsight(db, 'grep-root-session', '外发光 alpha 修复', 'transcript', '2026-05-05T09:00:00.000Z')
    insertInsight(db, 'grep-root-session', '外发光 premultiply 对齐', 'hook', '2026-05-05T10:00:00.000Z')
    insertInsight(db, 'grep-child-session', '外发光 子目录命中', 'transcript', '2026-05-06T09:00:00.000Z')
    insertInsight(db, 'grep-prefix-session', '外发光 前缀目录不应命中', 'transcript', '2026-05-06T10:00:00.000Z')
    insertInsight(db, 'grep-user-only-session', '外发光 只在用户输入中出现', 'user', '2026-05-07T09:00:00.000Z')
    insertInsight(db, 'grep-old-session', '外发光 旧范围命中', 'transcript', '2026-04-30T09:00:00.000Z')
    insertInsight(db, 'grep-recent-miss-session', '没有关键词', 'transcript', '2026-05-08T09:00:00.000Z')

    const defaultStdout = runCommand('node', [join(repoRoot, 'lib/cli.js'), 'insights', '--list', '--grep', '外发光', '--json'], {
      cwd: grepProject,
      env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome },
    })
    const defaultParsed = JSON.parse(defaultStdout) as {
      grep: string
      sessions: Array<{ session_id: string; matched_insights_count: number; latest_matched_insight_at: string }>
    }
    const defaultIds = defaultParsed.sessions.map((session) => session.session_id)
    assert.equal(defaultParsed.grep, '外发光')
    assert(defaultIds.includes('grep-root-session'), 'default grep list should include current directory matches')
    assert(defaultIds.includes('grep-child-session'), 'default grep list should include child directory matches')
    assert(!defaultIds.includes('grep-prefix-session'), 'default grep list should respect directory boundaries')
    assert(!defaultIds.includes('grep-user-only-session'), 'default grep list should not match user-only prompts')
    assert(!defaultIds.includes('grep-recent-miss-session'), 'default grep list should exclude non-matching sessions')
    const defaultRoot = defaultParsed.sessions.find((session) => session.session_id === 'grep-root-session')
    assert.equal(defaultRoot?.matched_insights_count, 2)
    assert.equal(defaultRoot?.latest_matched_insight_at, '2026-05-05T10:00:00.000Z')

    const allStdout = runCommand('node', [join(repoRoot, 'lib/cli.js'), 'insights', '--list', '--all', '--grep', '外发光', '--json'], {
      cwd: grepProject,
      env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome },
    })
    const allParsed = JSON.parse(allStdout) as {
      grep: string
      sessions: Array<{ session_id: string; matched_insights_count: number; latest_matched_insight_at: string }>
    }
    const allIds = allParsed.sessions.map((session) => session.session_id)
    assert.equal(allParsed.grep, '外发光')
    assert(allIds.includes('grep-root-session'), 'grep list should include matching primary insights')
    assert(allIds.includes('grep-child-session'), '--all grep list should include child directory sessions')
    assert(allIds.includes('grep-prefix-session'), '--all grep list can include prefix directory sessions')
    assert(!allIds.includes('grep-user-only-session'), 'grep list should not match user-only prompts')
    assert(!allIds.includes('grep-recent-miss-session'), 'grep list should exclude non-matching sessions')
    const root = allParsed.sessions.find((session) => session.session_id === 'grep-root-session')
    assert.equal(root?.matched_insights_count, 2)
    assert.equal(root?.latest_matched_insight_at, '2026-05-05T10:00:00.000Z')

    const cwdStdout = runCommand('node', [
      join(repoRoot, 'lib/cli.js'),
      'insights',
      '--cwd',
      grepProject,
      '--list',
      '--grep',
      '外发光',
      '--json',
    ], {
      env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome },
    })
    const cwdIds = (JSON.parse(cwdStdout) as { sessions: Array<{ session_id: string }> })
      .sessions.map((session) => session.session_id)
    assert(cwdIds.includes('grep-root-session'), 'cwd grep should include exact directory')
    assert(cwdIds.includes('grep-child-session'), 'cwd grep should include child directory')
    assert(!cwdIds.includes('grep-prefix-session'), 'cwd grep should respect directory boundaries')

    const rangeStdout = runCommand('node', [
      join(repoRoot, 'lib/cli.js'),
      'insights',
      '--list',
      '--all',
      '--grep',
      '外发光',
      '--since',
      '2026-05-04',
      '--until',
      '2026-05-07',
      '--json',
    ], {
      env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome },
    })
    const rangeIds = (JSON.parse(rangeStdout) as { sessions: Array<{ session_id: string }> })
      .sessions.map((session) => session.session_id)
    assert(rangeIds.includes('grep-root-session'), 'range grep should include range matches')
    assert(rangeIds.includes('grep-child-session'), 'range grep should include later range matches')
    assert(!rangeIds.includes('grep-old-session'), 'range grep should exclude old keyword matches')

    const limitedStdout = runCommand('node', [
      join(repoRoot, 'lib/cli.js'),
      'insights',
      '--cwd',
      grepProject,
      '--list',
      '--grep',
      '外发光',
      '--limit',
      '1',
      '--json',
    ], {
      env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome },
    })
    const limited = JSON.parse(limitedStdout) as { sessions: Array<{ session_id: string }> }
    assert.equal(limited.sessions.length, 1)
    assert.equal(limited.sessions[0]?.session_id, 'grep-child-session')

    const sessionPrefixStdout = runCommand('node', [
      join(repoRoot, 'lib/cli.js'),
      'insights',
      '--session',
      'grep-',
      '--list',
      '--grep',
      '外发光',
      '--json',
    ], {
      env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome },
    })
    const sessionPrefixIds = (JSON.parse(sessionPrefixStdout) as { sessions: Array<{ session_id: string }> })
      .sessions.map((session) => session.session_id)
    assert(sessionPrefixIds.includes('grep-root-session'), 'session prefix grep should include matching sessions')
    assert(!sessionPrefixIds.includes('grep-user-only-session'), 'session prefix grep should not match user prompts')

    const textStdout = runCommand('node', [
      join(repoRoot, 'lib/cli.js'),
      'insights',
      '--cwd',
      grepProject,
      '--list',
      '--grep',
      '外发光',
      '--limit',
      '1',
    ], {
      env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome },
    })
    assert(textStdout.includes('HITS'), 'grep list text output should show HITS column')
    assert(textStdout.includes('[grep: "外发光"]'), 'grep list text output should show grep marker')

    const invalid = spawnNode([join(repoRoot, 'lib/cli.js'), 'insights', '--list', '--grep', '['], {
      cwd: repoRoot,
      env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome },
      encoding: 'utf8',
    })
    assert.notEqual(invalid.status, 0)
    assert(invalid.stderr.includes('invalid regex pattern "["'))

    const conflictingScope = spawnNode([
      join(repoRoot, 'lib/cli.js'),
      'insights',
      '--list',
      '--all',
      '--cwd',
      grepProject,
    ], {
      cwd: repoRoot,
      env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome },
      encoding: 'utf8',
    })
    assert.notEqual(conflictingScope.status, 0)
    assert(conflictingScope.stderr.includes('--all cannot be combined with --cwd/--dir/--directory'))

    const sessionAll = spawnNode([
      join(repoRoot, 'lib/cli.js'),
      'insights',
      '--session',
      'grep-root-session',
      '--all',
      '--list',
    ], {
      cwd: repoRoot,
      env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome },
      encoding: 'utf8',
    })
    assert.notEqual(sessionAll.status, 0)
    assert(sessionAll.stderr.includes('--all cannot be combined with --session'))
  } finally {
    db.close()
  }
  console.log('verify: insights grep list')
}

function verifyInsightsSessionExactPriority(tempRoot: string) {
  const tempHome = join(tempRoot, 'session-exact-home')
  const dataDir = join(tempHome, 'data')
  mkdirSync(dataDir, { recursive: true })

  const dbPath = join(dataDir, 'dashboard.db')
  const db = new Database(dbPath)
  applySchema(db)

  try {
    insertSession(db, 'exact-session', {
      cwd: repoRoot,
      transcriptPath: '',
      source: 'codex',
    })
    insertSession(db, 'exact-session-newer', {
      cwd: repoRoot,
      transcriptPath: '',
      source: 'codex',
    })
    db.prepare('UPDATE sessions SET created_at = ?, last_activity = ? WHERE session_id = ?')
      .run('2026-05-01T08:00:00.000Z', '2026-05-01T08:00:00.000Z', 'exact-session')
    db.prepare('UPDATE sessions SET created_at = ?, last_activity = ? WHERE session_id = ?')
      .run('2026-05-01T08:00:00.000Z', '2026-05-02T08:00:00.000Z', 'exact-session-newer')
    insertInsight(db, 'exact-session', 'exact session selected', 'transcript', '2026-05-01T08:01:00.000Z')
    insertInsight(db, 'exact-session-newer', 'newer prefix session selected', 'transcript', '2026-05-02T08:01:00.000Z')

    const exactStdout = runCommand('node', [
      'lib/cli.js',
      'insights',
      '--session',
      'exact-session',
      '--json',
    ], {
      env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome },
    })
    const exactParsed = JSON.parse(exactStdout) as {
      session: { session_id: string }
      insights: Array<{ content: string }>
    }
    assert.equal(exactParsed.session.session_id, 'exact-session')
    assert(exactParsed.insights.some((insight) => insight.content.includes('exact session selected')))
    assert(!exactParsed.insights.some((insight) => insight.content.includes('newer prefix session selected')))
  } finally {
    db.close()
  }
  console.log('verify: insights session exact priority')
}

function verifyInsightsChainFlagParsing(tempRoot: string) {
  // Build a minimal DB so the CLI doesn't error out before reaching the parser.
  const tempHome = join(tempRoot, 'chain-flag-parse-home')
  const dataDir = join(tempHome, 'data')
  mkdirSync(dataDir, { recursive: true })
  const dbPath = join(dataDir, 'dashboard.db')
  const db = new Database(dbPath)
  applySchema(db)
  db.close()

  // Case A: `--chain <valid id>` parses cleanly AND routes to the chainId
  // read-mode branch. Until Task 5.1 wires the consumer, the CLI emits the
  // temporary "not yet implemented" guard. This assertion proves both that
  // the validator did NOT trip (chain_a3k7m2pq is a well-formed id) AND
  // that args.chainId was actually set (otherwise the legacy "--session
  // required" path would fire instead).
  const readModeResult = spawnNode(
    [join(repoRoot, 'lib/cli.js'), 'insights', '--chain', 'chain_a3k7m2pq', '--json'],
    { env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome }, encoding: 'utf8' }
  )
  assert(
    !readModeResult.stderr.includes('--chain expects a chain id'),
    `valid --chain id must not trip the format-error branch, got stderr: ${readModeResult.stderr.slice(0, 200)}`
  )
  // And: it should hit the not-yet-implemented guard, not the legacy "--session required" message.
  // (Once Task 5.1 lands, this assertion will need to change to "exits 0 with JSON output".)
  assert(
    readModeResult.stderr.includes('not yet implemented'),
    `--chain <id> should hit the not-yet-implemented guard, got stderr: ${readModeResult.stderr.slice(0, 200)}`
  )

  // Case B: `--chain` followed by an INVALID-format value must reject with
  // the validator's exact error string.
  const invalidIdResult = spawnNode(
    [join(repoRoot, 'lib/cli.js'), 'insights', '--chain', 'not-a-chain-id', '--json'],
    { env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome }, encoding: 'utf8' }
  )
  assert.notEqual(invalidIdResult.status, 0, 'invalid chain id should fail')
  assert(
    invalidIdResult.stderr.includes('--chain expects a chain id'),
    `error should be the validator's exact message, got: ${invalidIdResult.stderr.slice(0, 200)}`
  )

  // Case C: `--chain` as a BARE flag with --list (no value) means list mode.
  // On an empty DB, the existing --list pipeline emits '[]' and exits 0.
  // Once Task 4.2 lands, this output shape may change ('{ chains: [] }' etc.)
  // and the assertion will need updating — that's intentional, it forces
  // Task 4.2 to acknowledge the schema change.
  const listModeResult = spawnNode(
    [join(repoRoot, 'lib/cli.js'), 'insights', '--list', '--chain', '--all', '--json'],
    { env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome }, encoding: 'utf8' }
  )
  assert.equal(
    listModeResult.status,
    0,
    `--list --chain --all should exit 0, got ${listModeResult.status}, stderr: ${listModeResult.stderr.slice(0, 200)}`
  )
  assert.equal(
    listModeResult.stdout.trim(),
    '[]',
    `--list --chain --all on empty DB should emit '[]', got: ${listModeResult.stdout.slice(0, 200)}`
  )

  // Case D: `--chain` followed by another flag (e.g., `--json`) means bare
  // flag — the next token is NOT a value. The strongest test is that
  // --json was processed independently and produced JSON output.
  const flagThenFlag = spawnNode(
    [join(repoRoot, 'lib/cli.js'), 'insights', '--list', '--chain', '--json'],
    { env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome }, encoding: 'utf8' }
  )
  assert.equal(
    flagThenFlag.status,
    0,
    `--list --chain --json should exit 0, got stderr: ${flagThenFlag.stderr.slice(0, 200)}`
  )
  assert(
    flagThenFlag.stdout.trim().startsWith('['),
    `--json must still produce JSON output: '--chain' must not have consumed it, got stdout: ${flagThenFlag.stdout.slice(0, 200)}`
  )

  // Case E: --list --chain --cwd is now honored (Task 4.4 integrated it).
  // Assert (a) exit 0, (b) no rejection stderr, (c) stdout parses as JSON array.
  // The --json flag is required so a regression to text output is caught by
  // JSON.parse rather than producing a vacuous "no rejection" pass.
  const cwdNow = spawnNode(
    [join(repoRoot, 'lib/cli.js'), 'insights', '--list', '--chain', '--cwd', '/tmp/x', '--json'],
    { env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome }, encoding: 'utf8' }
  )
  assert.equal(cwdNow.status, 0,
    `--list --chain --cwd should exit 0, got status ${cwdNow.status}, stderr: ${cwdNow.stderr.slice(0, 200)}`)
  assert(
    !cwdNow.stderr.includes('not yet supported'),
    `--list --chain --cwd should no longer be rejected, got stderr: ${cwdNow.stderr.slice(0, 200)}`
  )
  try {
    const parsed = JSON.parse(cwdNow.stdout)
    assert(Array.isArray(parsed), `--list --chain --cwd should emit JSON array, got: ${cwdNow.stdout.slice(0, 200)}`)
  } catch {
    assert.fail(`--list --chain --cwd stdout should be valid JSON, got: ${cwdNow.stdout.slice(0, 200)}`)
  }

  // Case F: --list --chain --range is now honored.
  const rangeNow = spawnNode(
    [join(repoRoot, 'lib/cli.js'), 'insights', '--list', '--chain', '--range', 'week', '--json'],
    { env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome }, encoding: 'utf8' }
  )
  assert.equal(rangeNow.status, 0,
    `--list --chain --range should exit 0, got status ${rangeNow.status}, stderr: ${rangeNow.stderr.slice(0, 200)}`)
  assert(
    !rangeNow.stderr.includes('not yet supported'),
    `--list --chain --range should no longer be rejected, got stderr: ${rangeNow.stderr.slice(0, 200)}`
  )
  try {
    const parsed = JSON.parse(rangeNow.stdout)
    assert(Array.isArray(parsed), `--list --chain --range should emit JSON array, got: ${rangeNow.stdout.slice(0, 200)}`)
  } catch {
    assert.fail(`--list --chain --range stdout should be valid JSON, got: ${rangeNow.stdout.slice(0, 200)}`)
  }

  console.log('verify: insights chain flag parsing')
}

function verifyInsightsListChain(tempRoot: string) {
  const tempHome = join(tempRoot, 'list-chain-home')
  const dataDir = join(tempHome, 'data')
  mkdirSync(dataDir, { recursive: true })
  const dbPath = join(dataDir, 'dashboard.db')
  const db = new Database(dbPath)
  applySchema(db)

  // Chain A: two main sessions + one subagent (all share chain_aaaaaa11).
  insertSession(db, 'chain-a-1', {
    cwd: '/tmp/list-chain', transcriptPath: '', source: 'claude',
    chainId: 'chain_aaaaaa11',
  })
  insertSession(db, 'chain-a-2', {
    cwd: '/tmp/list-chain', transcriptPath: '', source: 'claude',
    chainId: 'chain_aaaaaa11', predecessorId: 'chain-a-1',
  })
  insertSession(db, 'chain-a-sub', {
    cwd: '/tmp/list-chain', transcriptPath: '', source: 'codex',
    chainId: 'chain_aaaaaa11', isSubagent: true, parentSessionId: 'chain-a-1',
  })
  // Chain B: one main session, older (different chain).
  insertSession(db, 'chain-b-1', {
    cwd: '/tmp/list-chain', transcriptPath: '', source: 'claude',
    chainId: 'chain_bbbbbb22',
  })

  // Fix timestamps so we have deterministic ordering.
  db.prepare('UPDATE sessions SET created_at = ?, last_activity = ? WHERE session_id = ?')
    .run('2026-05-09T08:00:00.000Z', '2026-05-09T09:00:00.000Z', 'chain-b-1')
  db.prepare('UPDATE sessions SET created_at = ?, last_activity = ? WHERE session_id = ?')
    .run('2026-05-10T08:00:00.000Z', '2026-05-10T09:00:00.000Z', 'chain-a-1')
  db.prepare('UPDATE sessions SET created_at = ?, last_activity = ? WHERE session_id = ?')
    .run('2026-05-11T08:00:00.000Z', '2026-05-11T09:00:00.000Z', 'chain-a-2')
  db.prepare('UPDATE sessions SET created_at = ?, last_activity = ? WHERE session_id = ?')
    .run('2026-05-11T09:30:00.000Z', '2026-05-11T10:00:00.000Z', 'chain-a-sub')

  // Insights: 2 on main sessions of chain A, 1 on subagent of A, 1 on chain B.
  insertInsight(db, 'chain-a-1', 'a1 insight', 'transcript', '2026-05-10T09:00:00.000Z')
  insertInsight(db, 'chain-a-2', 'a2 insight', 'transcript', '2026-05-11T09:00:00.000Z')
  insertInsight(db, 'chain-a-sub', 'subagent insight', 'transcript', '2026-05-11T09:30:00.000Z')
  insertInsight(db, 'chain-b-1', 'b1 insight', 'transcript', '2026-05-09T09:00:00.000Z')
  db.close()

  const stdout = runCommand('node', [
    'lib/cli.js', 'insights', '--list', '--chain', '--all', '--json',
  ], { env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome } })

  const parsed = JSON.parse(stdout) as Array<{
    chain_id: string
    main_session_ids: string[]
    subagent_session_ids: string[]
    sessions_count: number
    representative_session_id: string
    insights_count: number
    chain_started_at: string
    chain_last_activity: string
    cwd: string
  }>

  // Two chains in the result.
  assert.equal(parsed.length, 2, `expected 2 chains, got ${parsed.length}`)

  const chainA = parsed.find((c) => c.chain_id === 'chain_aaaaaa11')
  const chainB = parsed.find((c) => c.chain_id === 'chain_bbbbbb22')
  assert(chainA, 'chain_aaaaaa11 missing')
  assert(chainB, 'chain_bbbbbb22 missing')

  // Chain A: main区 = 2 sessions, subagent区 = 1 session.
  assert.deepEqual(chainA!.main_session_ids.sort(), ['chain-a-1', 'chain-a-2'],
    `chain A main sessions wrong: ${JSON.stringify(chainA!.main_session_ids)}`)
  assert.deepEqual(chainA!.subagent_session_ids, ['chain-a-sub'],
    `chain A subagent sessions wrong: ${JSON.stringify(chainA!.subagent_session_ids)}`)
  // sessions_count = main区 only (subagents excluded by default per plan).
  assert.equal(chainA!.sessions_count, 2,
    `chain A sessions_count should be 2 (main only), got ${chainA!.sessions_count}`)
  // Representative = latest main session by last_activity (chain-a-2 at 2026-05-11T09:00).
  assert.equal(chainA!.representative_session_id, 'chain-a-2',
    `chain A representative should be chain-a-2, got ${chainA!.representative_session_id}`)
  // insights_count counts main区 only by default → 2 (a1 + a2, NOT subagent's).
  assert.equal(chainA!.insights_count, 2,
    `chain A insights_count should be 2 (main only), got ${chainA!.insights_count}`)
  // Timestamps from main区 only.
  assert.equal(chainA!.chain_started_at, '2026-05-10T08:00:00.000Z',
    `chain A started_at should be earliest main session, got ${chainA!.chain_started_at}`)
  assert.equal(chainA!.chain_last_activity, '2026-05-11T09:00:00.000Z',
    `chain A last_activity should be latest main session, got ${chainA!.chain_last_activity}`)
  assert.equal(chainA!.cwd, '/tmp/list-chain',
    `chain A cwd should match main session cwd, got ${chainA!.cwd}`)

  // Order: chain A is newer (2026-05-11) so it appears first.
  assert.equal(parsed[0].chain_id, 'chain_aaaaaa11',
    'order should be MAX(last_activity) DESC; chain A first')

  // Chain B: only one main session, no subagents.
  assert.equal(chainB!.main_session_ids.length, 1)
  assert.equal(chainB!.subagent_session_ids.length, 0)
  assert.equal(chainB!.insights_count, 1)
  console.log('verify: insights list chain')
}

function verifyInsightsListChainGrep(tempRoot: string) {
  const tempHome = join(tempRoot, 'list-chain-grep-home')
  const dataDir = join(tempHome, 'data')
  mkdirSync(dataDir, { recursive: true })
  const dbPath = join(dataDir, 'dashboard.db')
  const db = new Database(dbPath)
  applySchema(db)

  // Chain X: main session has a matching insight + a non-matching insight.
  insertSession(db, 'chain-x-main', {
    cwd: '/tmp/grep-chain', transcriptPath: '', source: 'claude',
    chainId: 'chain_xxxxxx11',
  })
  // Chain X: subagent with a matching insight (must NOT count toward chain match).
  insertSession(db, 'chain-x-sub', {
    cwd: '/tmp/grep-chain', transcriptPath: '', source: 'codex',
    chainId: 'chain_xxxxxx11', isSubagent: true, parentSessionId: 'chain-x-main',
  })
  // Chain Y: main session, NO matching insights.
  insertSession(db, 'chain-y-main', {
    cwd: '/tmp/grep-chain', transcriptPath: '', source: 'claude',
    chainId: 'chain_yyyyyy22',
  })
  // Chain Z: two main sessions, one with one match, one with two matches (test count aggregation).
  insertSession(db, 'chain-z-main1', {
    cwd: '/tmp/grep-chain', transcriptPath: '', source: 'claude',
    chainId: 'chain_zzzzzz33',
  })
  insertSession(db, 'chain-z-main2', {
    cwd: '/tmp/grep-chain', transcriptPath: '', source: 'claude',
    chainId: 'chain_zzzzzz33', predecessorId: 'chain-z-main1',
  })

  // Insights
  insertInsight(db, 'chain-x-main', 'pagination logic fix', 'transcript', '2026-05-10T09:00:00.000Z')
  insertInsight(db, 'chain-x-main', 'unrelated change', 'transcript', '2026-05-10T09:30:00.000Z')
  // User prompt containing the grep keyword on the same main session — MUST be
  // excluded from BOTH insights_count (Step 2 filter) AND matched_insights_count
  // (Step 3 filter), matching session-list semantics and the help text contract.
  insertInsight(db, 'chain-x-main', 'pagination user prompt', 'user', '2026-05-10T08:30:00.000Z')
  insertInsight(db, 'chain-x-sub', 'pagination in subagent', 'transcript', '2026-05-10T10:00:00.000Z')
  insertInsight(db, 'chain-y-main', 'no keyword here', 'transcript', '2026-05-09T09:00:00.000Z')
  insertInsight(db, 'chain-z-main1', 'pagination edge case', 'transcript', '2026-05-11T09:00:00.000Z')
  insertInsight(db, 'chain-z-main2', 'pagination polish', 'transcript', '2026-05-12T09:00:00.000Z')
  insertInsight(db, 'chain-z-main2', 'pagination second hit', 'transcript', '2026-05-12T09:30:00.000Z')

  // Fix last_activity to control order
  db.prepare('UPDATE sessions SET last_activity = ? WHERE session_id = ?')
    .run('2026-05-10T09:30:00.000Z', 'chain-x-main')
  db.prepare('UPDATE sessions SET last_activity = ? WHERE session_id = ?')
    .run('2026-05-09T09:00:00.000Z', 'chain-y-main')
  db.prepare('UPDATE sessions SET last_activity = ? WHERE session_id = ?')
    .run('2026-05-12T09:30:00.000Z', 'chain-z-main2')

  db.close()

  // Uppercase 'PAGINATION' against lowercase fixture content exercises the
  // case-insensitive 'i' flag in compileGrep — a regression that drops the flag
  // would make this test fail.
  const stdout = runCommand('node', [
    'lib/cli.js', 'insights', '--list', '--chain', '--all', '--grep', 'PAGINATION', '--json',
  ], { env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome } })

  const parsed = JSON.parse(stdout) as Array<{
    chain_id: string
    main_session_ids: string[]
    subagent_session_ids: string[]
    sessions_count: number
    representative_session_id: string
    insights_count: number
    matched_insights_count?: number
    chain_started_at: string
    chain_last_activity: string
    cwd: string
  }>

  // Only chains with a MAIN insight matching 'pagination' should appear.
  // Chain Y has no matches anywhere → excluded.
  const ids = parsed.map((c) => c.chain_id)
  assert.deepEqual(ids.sort(), ['chain_xxxxxx11', 'chain_zzzzzz33'].sort(),
    `expected chains [X, Z], got: ${JSON.stringify(ids)}`)

  const chainX = parsed.find((c) => c.chain_id === 'chain_xxxxxx11')!
  const chainZ = parsed.find((c) => c.chain_id === 'chain_zzzzzz33')!

  // Chain X: 1 main-zone match ('pagination logic fix'). The subagent's
  // 'pagination in subagent' must NOT contribute to matched_insights_count.
  assert.equal(chainX.matched_insights_count, 1,
    `chain X matched_insights_count should be 1 (main only), got ${chainX.matched_insights_count}`)

  // Chain Z: 3 main-zone matches (1 in main1 + 2 in main2).
  assert.equal(chainZ.matched_insights_count, 3,
    `chain Z matched_insights_count should be 3, got ${chainZ.matched_insights_count}`)

  // Order: chain Z is newer (2026-05-12) so it appears first.
  assert.equal(parsed[0].chain_id, 'chain_zzzzzz33',
    'order should be MAX(last_activity) DESC')

  // insights_count (unfiltered count) is still populated and reflects ALL main-zone insights.
  // Chain X main has 2 total insights (pagination + unrelated); insights_count = 2.
  // Chain Z main has 3 total insights; insights_count = 3.
  assert.equal(chainX.insights_count, 2,
    `chain X insights_count should be 2 (unfiltered), got ${chainX.insights_count}`)
  assert.equal(chainZ.insights_count, 3,
    `chain Z insights_count should be 3 (unfiltered), got ${chainZ.insights_count}`)

  console.log('verify: insights list chain grep')
}

function verifyInsightsListChainScopes(tempRoot: string) {
  const tempHome = join(tempRoot, 'list-chain-scopes-home')
  const dataDir = join(tempHome, 'data')
  mkdirSync(dataDir, { recursive: true })
  // /tmp/scope-a must exist as a real directory so the Test 5 spawn can use it
  // as process.cwd(). Node's child process canonicalizes the spawn cwd via
  // realpath, so on macOS '/tmp/scope-a' becomes '/private/tmp/scope-a' inside
  // the child. The DB seed for chain A must therefore use the same canonical
  // form so the default-cwd WHERE clause matches. Production semantics are
  // unchanged: normalizeCwdArg uses path.resolve (does not follow symlinks);
  // hooks and the user-facing CLI both record whatever the OS returned.
  mkdirSync('/tmp/scope-a', { recursive: true })
  const scopeARealPath = realpathSync('/tmp/scope-a')
  const dbPath = join(dataDir, 'dashboard.db')
  const db = new Database(dbPath)
  applySchema(db)

  // Chain A: main session in /tmp/scope-a, recent activity.
  insertSession(db, 'a-main', {
    cwd: scopeARealPath, transcriptPath: '', source: 'claude',
    chainId: 'chain_aaaaaa55',
  })
  // Chain B: main session in /tmp/scope-b/nested, recent activity.
  insertSession(db, 'b-main', {
    cwd: '/tmp/scope-b/nested', transcriptPath: '', source: 'claude',
    chainId: 'chain_bbbbbb66',
  })
  // Chain C: main session in /tmp/scope-c, OLD activity (outside week range).
  insertSession(db, 'c-main', {
    cwd: '/tmp/scope-c', transcriptPath: '', source: 'claude',
    chainId: 'chain_cccccc77',
  })

  const today = '2026-05-12T09:00:00.000Z'
  const yesterday = '2026-05-11T09:00:00.000Z'
  const longAgo = '2026-01-01T09:00:00.000Z'
  db.prepare('UPDATE sessions SET created_at = ?, last_activity = ? WHERE session_id = ?')
    .run(today, today, 'a-main')
  db.prepare('UPDATE sessions SET created_at = ?, last_activity = ? WHERE session_id = ?')
    .run(yesterday, yesterday, 'b-main')
  db.prepare('UPDATE sessions SET created_at = ?, last_activity = ? WHERE session_id = ?')
    .run(longAgo, longAgo, 'c-main')

  db.close()

  // --- Test 1: --cwd filters to nested directory ---
  const cwdResult = runCommand('node', [
    'lib/cli.js', 'insights', '--list', '--chain', '--cwd', '/tmp/scope-b', '--json',
  ], { env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome } })
  const cwdParsed = JSON.parse(cwdResult) as Array<{ chain_id: string }>
  const cwdIds = cwdParsed.map((c) => c.chain_id)
  assert.deepEqual(cwdIds, ['chain_bbbbbb66'],
    `--cwd /tmp/scope-b should return only chain B (nested), got: ${JSON.stringify(cwdIds)}`)

  // --- Test 2: --all returns all chains regardless of cwd ---
  const allResult = runCommand('node', [
    'lib/cli.js', 'insights', '--list', '--chain', '--all', '--json',
  ], { env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome } })
  const allIds = (JSON.parse(allResult) as Array<{ chain_id: string }>).map((c) => c.chain_id)
  assert.deepEqual(allIds.sort(), ['chain_aaaaaa55', 'chain_bbbbbb66', 'chain_cccccc77'].sort(),
    `--all should return all 3 chains, got: ${JSON.stringify(allIds)}`)

  // --- Test 3: --since/--until time range filtering ---
  // Filter to recent activity only (excludes 'c-main' from 2026-01-01).
  const rangeResult = runCommand('node', [
    'lib/cli.js', 'insights', '--list', '--chain', '--all',
    '--since', '2026-05-10', '--until', '2026-05-13', '--json',
  ], { env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome } })
  const rangeIds = (JSON.parse(rangeResult) as Array<{ chain_id: string }>).map((c) => c.chain_id)
  assert.deepEqual(rangeIds.sort(), ['chain_aaaaaa55', 'chain_bbbbbb66'].sort(),
    `--since 2026-05-10 should exclude chain C, got: ${JSON.stringify(rangeIds)}`)

  // --- Test 4: --limit caps the number of chains ---
  const limitResult = runCommand('node', [
    'lib/cli.js', 'insights', '--list', '--chain', '--all', '--limit', '1', '--json',
  ], { env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome } })
  const limitParsed = JSON.parse(limitResult) as Array<{ chain_id: string }>
  assert.equal(limitParsed.length, 1, `--limit 1 should return 1 chain, got ${limitParsed.length}`)
  // Newest chain first (sort by last_activity DESC): chain A is newest.
  assert.equal(limitParsed[0].chain_id, 'chain_aaaaaa55',
    `--limit 1 should return newest chain (A), got ${limitParsed[0].chain_id}`)

  // --- Test 5: default scope (no --cwd, no --all) uses process.cwd() ---
  // Spawn CLI from /tmp/scope-a so process.cwd() inside the spawned process
  // matches chain A's session cwd. Default scope should return only chain A.
  const defaultScopeResult = runCommand('node', [
    join(repoRoot, 'lib/cli.js'), 'insights', '--list', '--chain', '--json',
  ], {
    cwd: '/tmp/scope-a',
    env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome },
  })
  const defaultIds = (JSON.parse(defaultScopeResult) as Array<{ chain_id: string }>)
    .map((c) => c.chain_id)
  assert.deepEqual(defaultIds, ['chain_aaaaaa55'],
    `default scope (cwd=/tmp/scope-a) should return only chain A, got: ${JSON.stringify(defaultIds)}`)

  console.log('verify: insights list chain scopes')
}

function verifyCodexHook() {
  const stdout = runCommand('bash', ['hooks/codex-session-hook.sh'], {
    env: { ...process.env, SESSION_DASHBOARD_URL: 'http://127.0.0.1:9' },
    input: '{"session_id":"verify-session","hook_event_name":"SessionStart"}\n',
  })
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput?: { hookEventName?: string; additionalContext?: string }
  }
  assert.equal(parsed.hookSpecificOutput?.hookEventName, 'SessionStart')
  assert(parsed.hookSpecificOutput?.additionalContext?.includes('verify-session'))
  console.log('verify: Codex hook SessionStart output')
}

function verifySessionRestore(tempRoot: string) {
  const dbPath = join(tempRoot, 'restore.db')
  const db = new Database(dbPath)
  applySchema(db)

  const sessionId = 'restore-session'
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO sessions (
      session_id, cwd, transcript_path, state, last_activity, created_at, pinned, alias, source, predecessor_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, repoRoot, '', 'active', now, now, 0, '', 'claude', '')

  const insertInsight = db.prepare(
    'INSERT INTO insights (session_id, content, timestamp, source) VALUES (?, ?, ?, ?)'
  )
  for (let i = 0; i < 250; i++) {
    insertInsight.run(sessionId, `insight-${i}`, new Date(Date.now() - i * 1000).toISOString(), 'transcript')
  }

  const manager = new SessionManager(db)
  try {
    const session = manager.getSession(sessionId)
    assert(session, 'restored session not found')
    assert.equal(session.total_insights, 250)
    assert.equal(session.insights.length, 100)
  } finally {
    manager.destroy()
    db.close()
  }
  console.log('verify: SessionManager restore cap')
}

function verifySessionExport(tempRoot: string) {
  const tempHome = join(tempRoot, 'export-home')
  const dataDir = join(tempHome, 'data')
  const transcriptDir = join(tempRoot, 'export-transcripts')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(transcriptDir, { recursive: true })

  const dbPath = join(dataDir, 'dashboard.db')
  const db = new Database(dbPath)
  applySchema(db)

  const parentTranscript = join(transcriptDir, 'parent.jsonl')
  const childTranscript = join(transcriptDir, 'child.jsonl')
  writeFileSync(parentTranscript, [
    JSON.stringify({ type: 'user', timestamp: '2026-03-17T10:00:00.000Z', message: { content: 'parent user' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-03-17T10:00:01.000Z', message: { content: [{ type: 'text', text: 'parent agent' }] } }),
    '',
  ].join('\n'))
  writeFileSync(childTranscript, [
    JSON.stringify({
      timestamp: '2026-03-17T10:10:00.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'child user' },
    }),
    JSON.stringify({
      timestamp: '2026-03-17T10:10:01.000Z',
      type: 'event_msg',
      payload: { type: 'task_complete', last_agent_message: 'child agent' },
    }),
    '',
  ].join('\n'))

  insertSession(db, 'parent-session', {
    cwd: '/tmp/parent',
    transcriptPath: parentTranscript,
    source: 'claude',
  })
  insertSession(db, 'child-session', {
    cwd: '/tmp/child',
    transcriptPath: childTranscript,
    source: 'codex',
    predecessorId: 'parent-session',
  })
  insertInsight(db, 'parent-session', 'parent insight', 'transcript', '2026-03-17T10:00:02.000Z')
  insertInsight(db, 'child-session', 'child prompt', 'user', '2026-03-17T10:10:00.000Z')
  insertInsight(db, 'child-session', 'child insight', 'transcript', '2026-03-17T10:10:02.000Z')

  try {
    const conversation = exportSessionText(db, {
      sessionId: 'child-session',
      mode: 'conversation',
      depth: 1,
    })
    assert(conversation.ok)
    assert.equal(conversation.data.session_count, 2)
    assert(conversation.data.content.includes('parent user'))
    assert(conversation.data.content.includes('parent agent'))
    assert(conversation.data.content.includes('child user'))
    assert(conversation.data.content.includes('child agent'))

    const noisyTranscript = join(transcriptDir, 'noisy.jsonl')
    writeFileSync(noisyTranscript, [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-03-17T10:20:00.000Z',
        message: { content: 'Implement the following plan:\n1. keep this' },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-03-17T10:20:01.000Z',
        message: { content: [{ type: 'text', text: 'plan acknowledged' }] },
      }),
      '',
    ].join('\n'))
    insertSession(db, 'noisy-session', {
      cwd: '/tmp/noisy',
      transcriptPath: noisyTranscript,
      source: 'claude',
    })
    const noisyConversation = exportSessionText(db, {
      sessionId: 'noisy-session',
      mode: 'conversation',
      depth: 0,
    })
    assert(noisyConversation.ok)
    assert(noisyConversation.data.content.includes('Implement the following plan:'))

    const insightFallback = exportSessionText(db, {
      sessionId: 'child-session',
      mode: 'insights',
      depth: 'all',
    })
    assert(insightFallback.ok)
    assert(insightFallback.data.content.includes('parent insight'))
    assert(insightFallback.data.content.includes('child insight'))

    const rangedInsights = exportSessionText(db, {
      sessionId: 'child-session',
      mode: 'insights',
      depth: 'all',
      range: {
        since: '2026-03-17T10:10:00.000Z',
        until: '2026-03-17T10:10:02.000Z',
      },
    })
    assert(rangedInsights.ok)
    assert.equal(rangedInsights.data.item_count, 1)
    assert(rangedInsights.data.content.includes('child prompt'))
    assert(!rangedInsights.data.content.includes('child insight'))
    assert(!rangedInsights.data.content.includes('parent insight'))
    assert(rangedInsights.data.content.includes('Range: 2026-03-17T10:10:00.000Z to 2026-03-17T10:10:02.000Z'))

    const rangedConversation = exportSessionText(db, {
      sessionId: 'child-session',
      mode: 'conversation',
      depth: 1,
      range: {
        since: '2026-03-17T10:10:00.000Z',
        until: '2026-03-17T10:10:01.000Z',
      },
    })
    assert(rangedConversation.ok)
    assert.equal(rangedConversation.data.item_count, 1)
    assert(rangedConversation.data.content.includes('child user'))
    assert(!rangedConversation.data.content.includes('child agent'))
    assert(!rangedConversation.data.content.includes('parent user'))

    const rangedCliOutput = runCommand('node', [
      'lib/cli.js',
      'export',
      '--session',
      'child-session',
      '--mode',
      'conversation',
      '--depth',
      '1',
      '--since',
      '2026-03-17T10:10:00.000Z',
      '--until',
      '2026-03-17T10:10:01.000Z',
    ], {
      env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome },
    })
    assert(rangedCliOutput.includes('child user'))
    assert(!rangedCliOutput.includes('child agent'))

    const cliOutput = runCommand('node', ['lib/cli.js', 'export', '--session', 'child-session', '--depth', '1'], {
      env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome },
    })
    assert(cliOutput.includes('parent user'))
    assert(cliOutput.includes('child agent'))

    rmSync(parentTranscript, { force: true })
    const missingConversation = exportSessionText(db, {
      sessionId: 'child-session',
      mode: 'conversation',
      depth: 1,
    })
    assert(!missingConversation.ok)
    assert.equal(missingConversation.error.error, 'missing_transcript')
    assert.equal(missingConversation.error.missing_sessions?.length, 1)

    const unreadableTranscript = join(transcriptDir, 'unreadable')
    mkdirSync(unreadableTranscript, { recursive: true })
    insertSession(db, 'unreadable-session', {
      cwd: '/tmp/unreadable',
      transcriptPath: unreadableTranscript,
      source: 'claude',
    })
    const unreadableConversation = exportSessionText(db, {
      sessionId: 'unreadable-session',
      mode: 'conversation',
      depth: 0,
    })
    assert(!unreadableConversation.ok)
    assert.equal(unreadableConversation.error.error, 'missing_transcript')
    assert.equal(unreadableConversation.error.missing_sessions?.[0]?.reason, 'Transcript file could not be read.')

    insertSession(db, 'loop-a', {
      cwd: '/tmp/loop-a',
      transcriptPath: childTranscript,
      source: 'claude',
    })
    insertSession(db, 'loop-b', {
      cwd: '/tmp/loop-b',
      transcriptPath: childTranscript,
      source: 'claude',
      predecessorId: 'loop-a',
    })
    db.prepare('UPDATE sessions SET predecessor_id = ? WHERE session_id = ?').run('loop-b', 'loop-a')
    const loopConversation = exportSessionText(db, {
      sessionId: 'loop-a',
      mode: 'conversation',
      depth: 'all',
    })
    assert(!loopConversation.ok)
    assert.equal(loopConversation.error.error, 'invalid_chain')
  } finally {
    db.close()
  }
  console.log('verify: session export conversation and fallback')
}

function verifyRecordsCut(tempRoot: string) {
  const tempHome = join(tempRoot, 'records-cut-home')
  const dataDir = join(tempHome, 'data')
  const transcriptDir = join(tempRoot, 'records-cut-transcripts')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(transcriptDir, { recursive: true })

  const dbPath = join(dataDir, 'dashboard.db')
  const db = new Database(dbPath)
  applySchema(db)

  const transcriptPath = join(transcriptDir, 'records.jsonl')
  const codexTranscriptPath = join(transcriptDir, 'records-codex.jsonl')
  const duplicateTranscriptPath = join(transcriptDir, 'records-duplicate.jsonl')
  writeFileSync(transcriptPath, [
    JSON.stringify({
      type: 'user',
      timestamp: '2026-03-18T10:00:00.000Z',
      message: { content: 'cut start anchor unique' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-03-18T10:00:00.000Z',
      message: { content: [{ type: 'text', text: 'repeat boundary before end' }] },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-03-18T10:00:00.000Z',
      message: { content: [{ type: 'text', text: 'private middle answer' }] },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-03-18T10:00:00.000Z',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Read',
            input: { file_path: '/tmp/example.txt' },
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-03-18T10:00:00.000Z',
      message: {
        content: [
          {
            type: 'tool_result',
            content: 'tool result content',
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-03-18T10:00:04.000Z',
      message: { content: 'cut end anchor' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-03-18T10:00:05.000Z',
      message: { content: [{ type: 'text', text: 'repeat boundary after end' }] },
    }),
    '',
  ].join('\n'))
  const interleavedTranscriptPath = join(transcriptDir, 'records-interleaved.jsonl')
  writeFileSync(interleavedTranscriptPath, [
    JSON.stringify({
      type: 'user',
      timestamp: '2026-03-18T12:00:00.000Z',
      message: { content: 'interleaved start' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-03-18T12:00:01.000Z',
      message: {
        content: [
          { type: 'text', text: 'first text block' },
          { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/interleaved.txt' } },
          { type: 'text', text: 'second text block' },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-03-18T12:00:02.000Z',
      message: { content: 'interleaved end' },
    }),
    '',
  ].join('\n'))
  writeFileSync(codexTranscriptPath, [
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-03-18T11:00:00.000Z',
      payload: { type: 'user_message', message: 'codex start anchor' },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-03-18T11:00:00.000Z',
      payload: {
        type: 'function_call',
        name: 'shell',
        call_id: 'call-1',
        arguments: '{"cmd":"echo secret"}',
      },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-03-18T11:00:00.000Z',
      payload: {
        type: 'function_call_output',
        call_id: 'call-1',
        output: 'codex tool output',
      },
    }),
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-03-18T11:00:01.000Z',
      payload: { type: 'agent_message', message: 'codex end anchor' },
    }),
    '',
  ].join('\n'))
  writeFileSync(duplicateTranscriptPath, [
    JSON.stringify({
      type: 'user',
      timestamp: '2026-03-18T13:00:00.000Z',
      message: { content: 'duplicate boundary' },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-03-18T13:00:00.000Z',
      message: { content: 'duplicate boundary' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-03-18T13:00:01.000Z',
      message: { content: [{ type: 'text', text: 'duplicate end' }] },
    }),
    '',
  ].join('\n'))

  insertSession(db, 'records-cut-session', {
    cwd: '/tmp/records-cut',
    transcriptPath,
    source: 'claude',
  })
  insertSession(db, 'records-cut-session-extra', {
    cwd: '/tmp/records-cut-extra',
    transcriptPath,
    source: 'claude',
  })
  db.prepare('UPDATE sessions SET last_activity = ? WHERE session_id = ?')
    .run('2026-03-18T14:00:00.000Z', 'records-cut-session-extra')
  insertSession(db, 'records-codex-session', {
    cwd: '/tmp/records-codex',
    transcriptPath: codexTranscriptPath,
    source: 'codex',
  })
  insertSession(db, 'records-interleaved-session', {
    cwd: '/tmp/records-interleaved',
    transcriptPath: interleavedTranscriptPath,
    source: 'claude',
  })
  insertSession(db, 'records-duplicate-session', {
    cwd: '/tmp/records-duplicate',
    transcriptPath: duplicateTranscriptPath,
    source: 'claude',
  })
  db.close()

  const outputPath = join(tempRoot, 'records-cut-output.md')
  const stdout = runCommand('node', [
    'lib/cli.js',
    'records',
    'cut',
    '--from',
    'cut start anchor unique',
    '--to',
    'cut end anchor',
    '--output',
    outputPath,
  ], {
    env: {
      ...process.env,
      SESSION_DASHBOARD_HOME: tempHome,
      SESSION_DASHBOARD_SESSION_ID: 'records-cut-session',
    },
  })

  assert(stdout.includes(`saved: ${outputPath}`), 'records cut should print saved file path')
  assert(stdout.includes('records: 6'), 'records cut should print record count')
  assert(!stdout.includes('private middle answer'), 'records cut must not print selected transcript content')
  assert(existsSync(outputPath), 'records cut should create the output file')

  const saved = readFileSync(outputPath, 'utf8')
  assert(saved.includes('cut start anchor unique'), 'saved segment should include the from boundary')
  assert(saved.includes('private middle answer'), 'saved segment should include middle agent content')
  assert(saved.includes('tool_use: Read'), 'saved segment should include available tool calls')
  assert(saved.includes('tool_result:'), 'saved segment should include available tool output')
  assert(saved.includes('cut end anchor'), 'saved segment should include the to boundary')
  assert(
    saved.indexOf('cut start anchor unique') < saved.indexOf('private middle answer') &&
      saved.indexOf('private middle answer') < saved.indexOf('tool_use: Read') &&
      saved.indexOf('tool_use: Read') < saved.indexOf('tool_result:') &&
      saved.indexOf('tool_result:') < saved.indexOf('cut end anchor'),
    'saved segment should preserve transcript order for equal timestamps'
  )

  const invalidUniqueBoundary = spawnNode( [
    'lib/cli.js',
    'records',
    'cut',
    '--session',
    'records-cut-session',
    '--from',
    'repeat boundary',
    '--to',
    'cut end anchor',
  ], {
    cwd: repoRoot,
    env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome },
    encoding: 'utf8',
  })
  assert.notEqual(invalidUniqueBoundary.status, 0, 'records cut should fail when a boundary text matches multiple records even if only one range is valid')
  assert(!invalidUniqueBoundary.stderr.includes('repeat boundary'), 'repeated-boundary failure should not print candidate record text')

  const interleavedOutputPath = join(tempRoot, 'records-interleaved-output.md')
  runCommand('node', [
    'lib/cli.js',
    'records',
    'cut',
    '--session',
    'records-interleaved-session',
    '--from',
    'interleaved start',
    '--to',
    'interleaved end',
    '--output',
    interleavedOutputPath,
  ], {
    env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome },
  })
  const interleavedSaved = readFileSync(interleavedOutputPath, 'utf8')
  assert(
    interleavedSaved.indexOf('first text block') < interleavedSaved.indexOf('tool_use: Read') &&
      interleavedSaved.indexOf('tool_use: Read') < interleavedSaved.indexOf('second text block'),
    'saved segment should preserve Claude content block order inside one transcript record'
  )

  const defaultOutputStdout = runCommand('node', [
    join(repoRoot, 'lib/cli.js'),
    'records',
    'cut',
    '--session',
    'records-cut-session',
    '--from',
    'cut start anchor unique',
    '--to',
    'cut end anchor',
  ], {
    cwd: tempRoot,
    env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome },
  })
  const defaultOutputLine = defaultOutputStdout.split('\n').find((line) => line.startsWith('saved: '))
  const defaultOutputPath = defaultOutputLine?.replace('saved: ', '')
  assert(defaultOutputPath?.includes('/.session-dashboard/records/'), 'records cut should default to the current workspace .session-dashboard/records directory')
  assert(defaultOutputPath && existsSync(defaultOutputPath), 'records cut should create the default output file')

  const exactSessionOutputPath = join(tempRoot, 'records-cut-exact-session-output.md')
  const exactSessionStdout = runCommand('node', [
    'lib/cli.js',
    'records',
    'cut',
    '--session',
    'records-cut-session',
    '--from',
    'cut start anchor unique',
    '--to',
    'cut end anchor',
    '--output',
    exactSessionOutputPath,
  ], {
    env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome },
  })
  assert(exactSessionStdout.includes(`saved: ${exactSessionOutputPath}`), 'records cut should prefer an exact session id over newer prefixed sessions')

  const missingEnv = spawnNode( [
    'lib/cli.js',
    'records',
    'cut',
    '--from',
    'cut start anchor unique',
    '--to',
    'cut end anchor',
  ], {
    cwd: repoRoot,
    env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome, SESSION_DASHBOARD_SESSION_ID: '' },
    encoding: 'utf8',
  })
  assert.notEqual(missingEnv.status, 0, 'records cut should fail without --session or SESSION_DASHBOARD_SESSION_ID')
  assert(missingEnv.stderr.includes('--session <id> is required'), 'records cut should explain missing session')

  const prefixEnv = spawnNode( [
    'lib/cli.js',
    'records',
    'cut',
    '--from',
    'cut start anchor unique',
    '--to',
    'cut end anchor',
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SESSION_DASHBOARD_HOME: tempHome,
      SESSION_DASHBOARD_SESSION_ID: 'records-cut',
    },
    encoding: 'utf8',
  })
  assert.notEqual(prefixEnv.status, 0, 'SESSION_DASHBOARD_SESSION_ID should require an exact session id')

  const codexOutputPath = join(tempRoot, 'records-codex-output.md')
  const codexStdout = runCommand('node', [
    'lib/cli.js',
    'records',
    'cut',
    '--session',
    'records-codex-session',
    '--from',
    'codex start anchor',
    '--to',
    'codex end anchor',
    '--output',
    codexOutputPath,
  ], {
    env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome },
  })
  assert(!codexStdout.includes('codex tool output'), 'records cut should not print Codex tool output to stdout')
  const codexSaved = readFileSync(codexOutputPath, 'utf8')
  assert(codexSaved.includes('function_call: shell'), 'saved Codex segment should include response_item function_call')
  assert(codexSaved.includes('function_call_output'), 'saved Codex segment should include response_item function_call_output')
  assert(codexSaved.includes('codex tool output'), 'saved Codex segment should include function call output')
  assert(
    codexSaved.indexOf('codex start anchor') < codexSaved.indexOf('function_call: shell') &&
      codexSaved.indexOf('function_call: shell') < codexSaved.indexOf('function_call_output') &&
      codexSaved.indexOf('function_call_output') < codexSaved.indexOf('codex end anchor'),
    'saved Codex segment should preserve transcript order for response_item records'
  )

  const noMatch = spawnNode( [
    'lib/cli.js',
    'records',
    'cut',
    '--session',
    'records-cut-session',
    '--from',
    'missing start',
    '--to',
    'cut end anchor',
  ], {
    cwd: repoRoot,
    env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome },
    encoding: 'utf8',
  })
  assert.notEqual(noMatch.status, 0, 'records cut should fail when a boundary does not match')
  assert(noMatch.stderr.includes('from: no matches'), 'records cut should report no-match boundary')
  assert(!noMatch.stderr.includes('private middle answer'), 'no-match failure should not print transcript content')

  const duplicateBoundary = spawnNode( [
    'lib/cli.js',
    'records',
    'cut',
    '--session',
    'records-duplicate-session',
    '--from',
    'duplicate boundary',
    '--to',
    'duplicate end',
  ], {
    cwd: repoRoot,
    env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome },
    encoding: 'utf8',
  })
  assert.notEqual(duplicateBoundary.status, 0, 'records cut should preserve adjacent duplicate records and fail duplicate boundary matching')
  assert(!duplicateBoundary.stderr.includes('duplicate boundary'), 'duplicate-boundary failure should not print candidate record text')

  const ambiguous = spawnNode( [
    'lib/cli.js',
    'records',
    'cut',
    '--session',
    'records-cut-session',
    '--from',
    'cut',
    '--to',
    'cut',
  ], {
    cwd: repoRoot,
    env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome },
    encoding: 'utf8',
  })
  assert.notEqual(ambiguous.status, 0, 'ambiguous records cut should fail')
  assert(ambiguous.stderr.includes('Candidate ranges'), 'ambiguous records cut should print a short candidate summary')
  assert(!ambiguous.stderr.includes('private middle answer'), 'ambiguous failure should not print unrelated full content')
  assert(!ambiguous.stderr.includes('cut start anchor'), 'ambiguous failure should not print candidate record text')

  console.log('verify: records cut')
}

function verifyEventDedup(tempRoot: string) {
  const dbPath = join(tempRoot, 'event-dedup.db')
  const db = new Database(dbPath)
  applySchema(db)

  insertSession(db, 'dedup-session', {
    cwd: '/tmp/dedup',
    transcriptPath: '',
    source: 'codex',
  })

  const manager = new SessionManager(db)
  try {
    const payload = JSON.stringify({
      timestamp: '2026-03-20T10:00:00.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'repeat me' },
    })
    const codexManager = manager as unknown as {
      handleCodexEvent: (sessionId: string, eventName: string, timestamp: string, rawPayload: string) => void
    }
    codexManager.handleCodexEvent('dedup-session', 'user_message', '2026-03-20T10:00:00.000Z', payload)
    codexManager.handleCodexEvent('dedup-session', 'user_message', '2026-03-20T10:00:00.000Z', payload)

    const row = db.prepare('SELECT COUNT(*) as count FROM events WHERE session_id = ?').get('dedup-session') as { count: number }
    assert.equal(row.count, 1)
  } finally {
    manager.destroy()
    db.close()
  }
  console.log('verify: event dedup')
}

function verifyInsightExtractionCompatibility() {
  const inlineBlocks = extractInsightBlocks(makeInsightBlock('inline-compatible'))
  assert.deepEqual(inlineBlocks, ['- inline-compatible'])

  const fencedBlocks = extractInsightBlocks(makeFencedInsightBlock('fenced-compatible'))
  assert.deepEqual(fencedBlocks, ['- fenced-compatible'])

  const mixedBlocks = extractInsightBlocks([
    makeInsightBlock('first'),
    '',
    makeFencedInsightBlock('second'),
  ].join('\n'))
  assert.deepEqual(mixedBlocks, ['- first', '- second'])

  const codeThenInlineBlocks = extractInsightBlocks([
    '```js',
    'console.log(1)',
    '```',
    makeInsightBlock('after-code-fence'),
  ].join('\n'))
  assert.deepEqual(codeThenInlineBlocks, ['- after-code-fence'])

  console.log('verify: insight extraction compatibility')
}

function verifyUserInputNoiseFiltering() {
  assert.equal(
    sanitizeUserInput('✻ Conversation compacted (ctrl+o for history)\nCompact summary\nThis session is being continued from a previous conversation', 'claude'),
    null
  )
  assert.equal(
    sanitizeUserInput('这是我与另一个ai的聊天内容：\n✻ Conversation compacted (ctrl+o for history)\nCompact summary\nThis session is being continued from a previous conversation', 'claude'),
    null
  )
  assert.equal(
    sanitizeUserInput('Claude Code v2.1.63\nWelcome back!\nTips for getting started', 'claude'),
    null
  )
  assert.equal(
    sanitizeUserInput('<subagent_notification>\n{\"agent_id\":\"a\",\"status\":{\"completed\":\"x\"}}\n</subagent_notification>', 'codex'),
    null
  )
  assert.equal(
    sanitizeUserInput('请处理 <subagent_notification> 这类内容，另外看看 Conversation compacted 为什么会被算作用户输入', 'codex'),
    '请处理 <subagent_notification> 这类内容，另外看看 Conversation compacted 为什么会被算作用户输入'
  )
  console.log('verify: user input noise filtering')
}

function verifyInsightTimestampActivity(tempRoot: string) {
  const dbPath = join(tempRoot, 'insight-timestamp.db')
  const db = new Database(dbPath)
  applySchema(db)

  insertSession(db, 'claude-insight-session', {
    cwd: '/tmp/claude-insight',
    transcriptPath: '',
    source: 'claude',
  })
  db.prepare('UPDATE sessions SET state = ?, last_activity = ? WHERE session_id = ?')
    .run('idle', '2026-03-20T09:00:00.000Z', 'claude-insight-session')

  const manager = new SessionManager(db)
  try {
    const inserted = manager.addInsight(
      'claude-insight-session',
      '- recovered insight',
      'transcript',
      '2026-03-20T10:00:00.000Z'
    )
    assert(inserted, 'expected transcript insight to be inserted')

    const session = manager.getSession('claude-insight-session')
    assert(session, 'session not found after insight insert')
    assert.equal(session.last_activity, '2026-03-20T10:00:00.000Z')
    assert.equal(session.state, 'active')
    assert.equal(session.insights[0]?.timestamp, '2026-03-20T10:00:00.000Z')

    manager.addInsight(
      'claude-insight-session',
      '- older insight',
      'transcript',
      '2026-03-20T08:30:00.000Z'
    )
    const unchanged = manager.getSession('claude-insight-session')
    assert(unchanged, 'session missing after older insight insert')
    assert.equal(unchanged.last_activity, '2026-03-20T10:00:00.000Z')
  } finally {
    manager.destroy()
    db.close()
  }
  console.log('verify: insight timestamp activity')
}

function verifyRepairScript(tempRoot: string) {
  const tempHome = join(tempRoot, 'repair-home')
  const dataDir = join(tempHome, 'data')
  const rolloutDir = join(tempRoot, 'repair-rollouts')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(rolloutDir, { recursive: true })

  const dbPath = join(dataDir, 'dashboard.db')
  const db = new Database(dbPath)
  applySchema(db)

  const duplicatePayload = JSON.stringify({
    timestamp: '2026-03-20T10:00:00.000Z',
    type: 'event_msg',
    payload: { type: 'user_message', message: 'dedupe user' },
  })

  const missingInsightRollout = join(rolloutDir, 'missing-insight.jsonl')
  writeFileSync(missingInsightRollout, [
    JSON.stringify({
      timestamp: '2026-03-20T09:55:00.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'repair me' },
    }),
    JSON.stringify({
      timestamp: '2026-03-20T10:00:00.000Z',
      type: 'event_msg',
      payload: { type: 'task_complete', last_agent_message: makeFencedInsightBlock('repair-backfill') },
    }),
    '',
  ].join('\n'))

  const pollutedRollout = join(rolloutDir, 'polluted-last-activity.jsonl')
  writeFileSync(pollutedRollout, [
    JSON.stringify({
      timestamp: '2026-03-20T11:00:00.000Z',
      type: 'event_msg',
      payload: { type: 'task_complete', last_agent_message: makeFencedInsightBlock('repair-existing') },
    }),
    '',
  ].join('\n'))

  insertSession(db, 'repair-missing', {
    cwd: '/tmp/repair-missing',
    transcriptPath: missingInsightRollout,
    source: 'codex',
  })
  insertSession(db, 'repair-polluted', {
    cwd: '/tmp/repair-polluted',
    transcriptPath: pollutedRollout,
    source: 'codex',
  })

  db.prepare('UPDATE sessions SET created_at = ?, last_activity = ?, state = ? WHERE session_id = ?')
    .run('2026-03-20T09:50:00.000Z', '2026-03-20T09:50:00.000Z', 'ended', 'repair-missing')
  db.prepare('UPDATE sessions SET created_at = ?, last_activity = ?, state = ? WHERE session_id = ?')
    .run('2026-03-20T10:30:00.000Z', '2026-03-21T10:30:00.000Z', 'ended', 'repair-polluted')

  const insertEvent = db.prepare(`
    INSERT INTO events (session_id, event_name, notification_type, tool_name, subagent_id, timestamp, raw_payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  insertEvent.run('repair-missing', 'user_message', null, null, null, '2026-03-20T10:00:00.000Z', duplicatePayload)
  insertEvent.run('repair-missing', 'user_message', null, null, null, '2026-03-20T10:00:00.000Z', duplicatePayload)

  insertInsight(db, 'repair-polluted', '- repair-existing', 'transcript', '2026-03-21T10:30:00.000Z')
  insertInsight(
    db,
    'repair-missing',
    '✻ Conversation compacted (ctrl+o for history)\nCompact summary\nThis session is being continued from a previous conversation',
    'user',
    '2026-03-21T10:05:00.000Z'
  )
  db.close()

  const stdout = runCommand('node', ['scripts/repair-dashboard.js', '--days', '3650'], {
    env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome },
  })
  const summary = JSON.parse(stdout) as {
    deletedDuplicateEvents: number
    insertedInsights: number
    deletedNoiseInsights: number
    affectedInsightSessions: number
    updatedInsightTimestamps: number
    updatedSessions: number
  }
  assert(summary.deletedDuplicateEvents >= 1, 'repair script did not remove duplicate events')
  assert(summary.insertedInsights >= 1, 'repair script did not backfill transcript insights')
  assert(summary.deletedNoiseInsights >= 1, 'repair script did not remove polluted user insights')
  assert(summary.affectedInsightSessions >= 1, 'repair script did not report affected insight sessions')
  assert(summary.updatedInsightTimestamps >= 1, 'repair script did not fix polluted insight timestamps')
  assert(summary.updatedSessions >= 2, 'repair script did not update polluted activity times')

  const repairedDb = new Database(dbPath, { readonly: true })
  try {
    const dedupedEvents = repairedDb.prepare('SELECT COUNT(*) as count FROM events WHERE session_id = ?').get('repair-missing') as { count: number }
    assert.equal(dedupedEvents.count, 1)

    const backfilledInsights = repairedDb.prepare(
      'SELECT COUNT(*) as count FROM insights WHERE session_id = ? AND source = ? AND content = ?'
    ).get('repair-missing', 'transcript', '- repair-backfill') as { count: number }
    assert.equal(backfilledInsights.count, 1)

    const deletedNoise = repairedDb.prepare(
      'SELECT COUNT(*) as count FROM insights WHERE session_id = ? AND source = ? AND content LIKE ?'
    ).get('repair-missing', 'user', '%Conversation compacted%') as { count: number }
    assert.equal(deletedNoise.count, 0)

    const repairedMissing = repairedDb.prepare('SELECT last_activity FROM sessions WHERE session_id = ?').get('repair-missing') as { last_activity: string }
    assert.equal(repairedMissing.last_activity, '2026-03-20T10:00:00.000Z')

    const repairedPolluted = repairedDb.prepare('SELECT last_activity FROM sessions WHERE session_id = ?').get('repair-polluted') as { last_activity: string }
    assert.equal(repairedPolluted.last_activity, '2026-03-20T11:00:00.000Z')

    const repairedPollutedInsight = repairedDb.prepare(
      'SELECT timestamp FROM insights WHERE session_id = ? AND source = ? AND content = ?'
    ).get('repair-polluted', 'transcript', '- repair-existing') as { timestamp: string }
    assert.equal(repairedPollutedInsight.timestamp, '2026-03-20T11:00:00.000Z')
  } finally {
    repairedDb.close()
  }
  console.log('verify: repair script')
}

function verifyRepairBackfillsChainIds(tempRoot: string) {
  const tempHome = join(tempRoot, 'chain-repair-home')
  const dataDir = join(tempHome, 'data')
  mkdirSync(dataDir, { recursive: true })
  const dbPath = join(dataDir, 'dashboard.db')
  const db = new Database(dbPath)
  applySchema(db)

  // Three-session chain: A → B → C (no chain_id supplied so fixture defaults to '')
  insertSession(db, 'chain-a', { cwd: '/tmp/r', transcriptPath: '', source: 'claude' })
  insertSession(db, 'chain-b', { cwd: '/tmp/r', transcriptPath: '', source: 'claude', predecessorId: 'chain-a' })
  insertSession(db, 'chain-c', { cwd: '/tmp/r', transcriptPath: '', source: 'claude', predecessorId: 'chain-b' })

  // Subagent of chain-b
  insertSession(db, 'chain-sub', {
    cwd: '/tmp/r',
    transcriptPath: '',
    source: 'codex',
    isSubagent: true,
    parentSessionId: 'chain-b',
  })

  // Standalone session in a different cwd
  insertSession(db, 'standalone', { cwd: '/tmp/r2', transcriptPath: '', source: 'claude' })
  db.close()

  runCommand('node', ['scripts/repair-dashboard.js', '--days', '3650'], {
    env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome },
  })

  const repaired = new Database(dbPath, { readonly: true })
  try {
    const rows = repaired.prepare(
      'SELECT session_id, chain_id FROM sessions ORDER BY session_id'
    ).all() as Array<{ session_id: string; chain_id: string }>
    const map = Object.fromEntries(rows.map((r) => [r.session_id, r.chain_id]))

    // Use the actual alphabet, NOT the plan's loose [a-z0-9] which would
    // accept invalid letters like i/l/o/u.
    const chainRe = /^chain_[abcdefghjkmnpqrstvwxyz0-9]{8}$/

    assert.match(map['chain-a'], chainRe, `chain-a chain_id invalid: "${map['chain-a']}"`)
    assert.equal(map['chain-b'], map['chain-a'], 'chain-b must share chain-a chain_id')
    assert.equal(map['chain-c'], map['chain-a'], 'chain-c must share chain-a chain_id')
    assert.equal(map['chain-sub'], map['chain-b'], 'subagent must share parent chain_id')
    assert.notEqual(map['standalone'], map['chain-a'], 'standalone gets its own chain_id')
    assert.match(map['standalone'], chainRe, `standalone chain_id invalid: "${map['standalone']}"`)
  } finally {
    repaired.close()
  }
  console.log('verify: repair backfills chain ids')
}

function verifyRepairRebuildsChainIds(tempRoot: string) {
  const tempHome = join(tempRoot, 'chain-rebuild-home')
  const dataDir = join(tempHome, 'data')
  mkdirSync(dataDir, { recursive: true })
  const dbPath = join(dataDir, 'dashboard.db')
  const db = new Database(dbPath)
  applySchema(db)

  // Same A→B→C chain as the backfill test.
  insertSession(db, 'chain-a', { cwd: '/tmp/r', transcriptPath: '', source: 'claude' })
  insertSession(db, 'chain-b', { cwd: '/tmp/r', transcriptPath: '', source: 'claude', predecessorId: 'chain-a' })
  insertSession(db, 'chain-c', { cwd: '/tmp/r', transcriptPath: '', source: 'claude', predecessorId: 'chain-b' })

  // Poison the chain_ids: assign DIFFERENT (and alphabet-valid) chain_ids to
  // each row, simulating a corrupted state. The point is they all DIFFER from
  // each other AND from what a correct backfill would produce.
  //
  // IMPORTANT: every fixture chain_id MUST satisfy the Crockford alphabet
  // /^chain_[abcdefghjkmnpqrstvwxyz0-9]{8}$/ — NO i/l/o/u. The plan document
  // has a stale example using "chain_wrongA1" which contains forbidden
  // characters 'o' and 'A'. Use alphabet-valid placeholders instead, e.g.:
  //   chain_zzzaaaa1, chain_zzzbbbb2, chain_zzzcccc3
  // Verify with: new RegExp('^chain_[abcdefghjkmnpqrstvwxyz0-9]{8}$').test(...)
  db.prepare('UPDATE sessions SET chain_id = ? WHERE session_id = ?').run('chain_zzzaaaa1', 'chain-a')
  db.prepare('UPDATE sessions SET chain_id = ? WHERE session_id = ?').run('chain_zzzbbbb2', 'chain-b')
  db.prepare('UPDATE sessions SET chain_id = ? WHERE session_id = ?').run('chain_zzzcccc3', 'chain-c')
  db.close()

  runCommand('node', ['scripts/repair-dashboard.js', '--rebuild-chains', '--days', '3650'], {
    env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome },
  })

  const repaired = new Database(dbPath, { readonly: true })
  try {
    const rows = repaired.prepare(
      'SELECT chain_id FROM sessions WHERE session_id IN (?, ?, ?)'
    ).all('chain-a', 'chain-b', 'chain-c') as Array<{ chain_id: string }>
    const unique = new Set(rows.map((r) => r.chain_id))
    assert.equal(unique.size, 1, `rebuild should collapse chain to one chain_id, got: ${[...unique].join(',')}`)

    const collapsed = [...unique][0]
    assert(!['chain_zzzaaaa1', 'chain_zzzbbbb2', 'chain_zzzcccc3'].includes(collapsed),
      `rebuild should discard poisoned chain_ids, got: ${collapsed}`)
    assert.match(collapsed, /^chain_[abcdefghjkmnpqrstvwxyz0-9]{8}$/,
      `rebuild result should match Crockford alphabet, got: ${collapsed}`)
  } finally {
    repaired.close()
  }
  console.log('verify: repair rebuilds chain ids')
}

function verifyRepairRebuildsChainIdsDryRun(tempRoot: string) {
  const tempHome = join(tempRoot, 'chain-rebuild-dryrun-home')
  const dataDir = join(tempHome, 'data')
  mkdirSync(dataDir, { recursive: true })
  const dbPath = join(dataDir, 'dashboard.db')
  const db = new Database(dbPath)
  applySchema(db)

  insertSession(db, 'chain-a', { cwd: '/tmp/r', transcriptPath: '', source: 'claude' })
  insertSession(db, 'chain-b', { cwd: '/tmp/r', transcriptPath: '', source: 'claude', predecessorId: 'chain-a' })
  insertSession(db, 'chain-c', { cwd: '/tmp/r', transcriptPath: '', source: 'claude', predecessorId: 'chain-b' })
  db.prepare('UPDATE sessions SET chain_id = ? WHERE session_id = ?').run('chain_zzzaaaa1', 'chain-a')
  db.prepare('UPDATE sessions SET chain_id = ? WHERE session_id = ?').run('chain_zzzbbbb2', 'chain-b')
  db.prepare('UPDATE sessions SET chain_id = ? WHERE session_id = ?').run('chain_zzzcccc3', 'chain-c')
  db.close()

  const stdout = runCommand('node', [
    'scripts/repair-dashboard.js', '--rebuild-chains', '--dry-run', '--days', '3650',
  ], { env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome } })

  const summary = JSON.parse(stdout) as { rebuildChains: boolean; dryRun: boolean; chainIdsAssigned: number }
  assert.equal(summary.dryRun, true)
  assert.equal(summary.rebuildChains, true)
  assert.equal(summary.chainIdsAssigned, 3, `dry-run should preview full rebuild count, got ${summary.chainIdsAssigned}`)

  const repaired = new Database(dbPath, { readonly: true })
  try {
    const rows = repaired.prepare(
      'SELECT session_id, chain_id FROM sessions WHERE session_id IN (?, ?, ?)'
    ).all('chain-a', 'chain-b', 'chain-c') as Array<{ session_id: string; chain_id: string }>
    const map = Object.fromEntries(rows.map((r) => [r.session_id, r.chain_id]))
    assert.equal(map['chain-a'], 'chain_zzzaaaa1', 'dry-run must not modify chain-a')
    assert.equal(map['chain-b'], 'chain_zzzbbbb2', 'dry-run must not modify chain-b')
    assert.equal(map['chain-c'], 'chain_zzzcccc3', 'dry-run must not modify chain-c')
  } finally {
    repaired.close()
  }
  console.log('verify: repair rebuilds chain ids dry-run')
}

async function verifyTranscriptRebind(tempRoot: string) {
  const transcriptDir = join(tempRoot, 'transcripts')
  mkdirSync(transcriptDir, { recursive: true })
  const oldPath = join(transcriptDir, 'old.jsonl')
  const nextPath = join(transcriptDir, 'next.jsonl')

  writeFileSync(oldPath, makeAssistantRecord('old-initial'))
  const insights: string[] = []
  const watcher = new TranscriptWatcher(
    (_sessionId, content) => insights.push(content),
    () => {}
  )

  try {
    watcher.watch('watch-session', oldPath)
    await waitFor(() => insights.some((content) => content.includes('old-initial')), 2000, 'initial old transcript parse')

    watcher.updatePath('watch-session', nextPath)
    const watcherState = (watcher as unknown as {
      watchers: Map<string, { path: string }>
      pendingRebinds: Map<string, ReturnType<typeof setTimeout>>
    })
    assert.equal(watcherState.watchers.get('watch-session')?.path, oldPath)
    assert(watcherState.pendingRebinds.has('watch-session'))

    writeFileSync(nextPath, '')
    await wait(1200)
    assert.equal(watcherState.watchers.get('watch-session')?.path, nextPath)
    appendFileSync(nextPath, JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: makeFencedInsightBlock('new-bound') }],
      },
    }) + '\n')
    await waitFor(() => insights.some((content) => content.includes('new-bound')), 2000, 'rebind to new transcript path')
  } finally {
    watcher.unwatchAll()
  }
  console.log('verify: transcript watcher rebind')
}

function verifyChainColumn(tempRoot: string) {
  const dbPath = join(tempRoot, 'chain-column.db')
  const db = new Database(dbPath)
  applySchema(db)
  try {
    const cols = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>
    assert(cols.some((c) => c.name === 'chain_id'), 'sessions.chain_id column missing after applySchema')
  } finally {
    db.close()
  }
  console.log('verify: chain column')
}

function verifyChainIdGenerator() {
  const ids = new Set<string>()
  for (let i = 0; i < 1000; i++) {
    const id = generateChainId()
    assert.match(id, /^chain_[abcdefghjkmnpqrstvwxyz0-9]{8}$/, `bad chain id: ${id}`)
    assert(!ids.has(id), `chain id collision: ${id}`)
    ids.add(id)
  }
  assert.equal(isChainId('chain_a3k7m2pq'), true)
  assert.equal(isChainId('a3k7m2pq'), false)
  assert.equal(isChainId('chain_a3k7m2p'), false)
  assert.equal(isChainId('chain_a3k7m2pqz'), false)
  assert.equal(isChainId('CHAIN_a3k7m2pq'), false)
  console.log('verify: chain id generator')
}

function verifyChainIdAssignedOnInsert(tempRoot: string) {
  const dbPath = join(tempRoot, 'chain-assign.db')
  const db = new Database(dbPath)
  applySchema(db)
  const manager = new SessionManager(db)
  try {
    // Fresh main session via the real Claude hook event path — this exercises
    // SessionManager.handleEvent → createSession → stmtInsertSession.
    manager.handleEvent({
      session_id: 'fresh-session',
      hook_event_name: 'SessionStart',
      cwd: '/tmp/chain-assign-fresh',
      transcript_path: '',
      timestamp: '2026-05-12T10:00:00.000Z',
    } as any)

    const row = db.prepare('SELECT chain_id, predecessor_id FROM sessions WHERE session_id = ?')
      .get('fresh-session') as { chain_id: string; predecessor_id: string } | undefined
    assert(row, 'session was not created')
    assert.equal(row.predecessor_id, '', 'main session should have no predecessor')
    assert.match(row.chain_id, /^chain_[abcdefghjkmnpqrstvwxyz0-9]{8}$/, `bad chain_id "${row.chain_id}"`)

    const freshSession = manager.getSession('fresh-session')
    assert(freshSession, 'in-memory session missing after handleEvent')
    assert.equal(freshSession.chain_id, row.chain_id, 'in-memory chain_id should match DB')

    // Subagent created via the Codex discovery path — parent already exists in
    // memory, so its chain_id must be propagated to the child at insert time.
    manager.handleEvent({
      session_id: 'parent-main',
      hook_event_name: 'SessionStart',
      cwd: '/tmp/chain-assign-parent',
      transcript_path: '',
      timestamp: '2026-05-12T10:05:00.000Z',
    } as any)
    const parent = manager.getSession('parent-main')
    assert(parent?.chain_id, 'parent should have chain_id')
    const parentChainId = parent.chain_id

    ;(manager as any).handleCodexSessionDiscovered(
      'subagent-child',
      '/tmp/chain-assign-sub',
      '',
      '/tmp/chain-assign-sub.jsonl',
      '2026-05-12T10:06:00.000Z',
      { isSubagent: true, parentSessionId: 'parent-main' },
    )
    const childRow = db.prepare('SELECT chain_id, parent_session_id, is_subagent FROM sessions WHERE session_id = ?')
      .get('subagent-child') as { chain_id: string; parent_session_id: string; is_subagent: number } | undefined
    assert(childRow, 'subagent session was not created')
    assert.equal(childRow.parent_session_id, 'parent-main')
    assert.equal(childRow.is_subagent, 1)
    assert.equal(childRow.chain_id, parentChainId, 'subagent should inherit parent chain_id at insert time')
  } finally {
    manager.destroy()
    db.close()
  }
  console.log('verify: chain id assigned on insert')
}

function verifySubagentInheritsChainOnLatePromotion(tempRoot: string) {
  const dbPath = join(tempRoot, 'subagent-late-promote.db')
  const db = new Database(dbPath)
  applySchema(db)

  // Fixture: parent main session with a known chain_id, inserted directly so
  // SessionManager loads it from DB at construction time.
  insertSession(db, 'parent-main', {
    cwd: '/tmp/late-promote',
    transcriptPath: '',
    source: 'codex',
    chainId: 'chain_parmnntx',
  })

  // The would-be-subagent session is ALSO inserted directly, without subagent
  // metadata — simulating "we created it as a main session first, didn't know
  // it was a subagent yet". Give it some chain_id that differs from the parent.
  insertSession(db, 'late-sub', {
    cwd: '/tmp/late-promote',
    transcriptPath: '',
    source: 'codex',
    chainId: 'chain_qdchcppd',
  })

  const manager = new SessionManager(db)
  try {
    // Trigger the late-promotion path: 'late-sub' already exists (loaded from
    // DB into the in-memory map by restoreFromDb), and now we deliver subagent
    // metadata for it. The handler should hit the metadata-update branch in
    // handleCodexSessionDiscovered, not createSession.
    ;(manager as any).handleCodexSessionDiscovered(
      'late-sub',
      '/tmp/late-promote',
      '',
      '/tmp/late-promote-transcript.jsonl',
      '2026-05-12T12:00:00.000Z',
      { isSubagent: true, parentSessionId: 'parent-main' },
    )

    const row = db.prepare(
      'SELECT chain_id, is_subagent, parent_session_id FROM sessions WHERE session_id = ?'
    ).get('late-sub') as { chain_id: string; is_subagent: number; parent_session_id: string } | undefined
    assert(row, 'late-sub row missing')
    assert.equal(row.is_subagent, 1, 'late-sub should now be flagged as subagent')
    assert.equal(row.parent_session_id, 'parent-main', 'late-sub should record its parent')
    assert.equal(
      row.chain_id,
      'chain_parmnntx',
      `late-sub chain_id should be overwritten with parent's, got "${row.chain_id}"`
    )

    // In-memory consistency
    const inMemory = manager.getSession('late-sub')
    assert(inMemory, 'late-sub missing from in-memory map')
    assert.equal(inMemory.chain_id, 'chain_parmnntx', 'in-memory chain_id should match parent')
    assert.equal(inMemory.is_subagent, true, 'in-memory is_subagent should be true')
  } finally {
    manager.destroy()
    db.close()
  }
  console.log('verify: subagent inherits chain on late promotion')
}

function verifyChainInheritedFromPredecessor(tempRoot: string) {
  const dbPath = join(tempRoot, 'chain-inherit.db')
  const db = new Database(dbPath)
  applySchema(db)

  // Predecessor candidate: must be pinned (or aliased), in 'ended' state, same
  // cwd/source, and last_activity within MAX_GAP_MS (1s) of the successor's
  // SessionStart timestamp for findPredecessor() to treat it as viable.
  insertSession(db, 'predecessor-session', {
    cwd: '/tmp/inherit',
    transcriptPath: '',
    source: 'claude',
    chainId: 'chain_pre00000',
  })
  // Successor's SessionStart will be at this timestamp; predecessor must have
  // ended within 1 second of it.
  const successorStartTs = '2026-05-12T11:00:00.000Z'
  const predecessorEndedTs = '2026-05-12T10:59:59.500Z'
  db.prepare('UPDATE sessions SET pinned = 1, state = ?, last_activity = ? WHERE session_id = ?')
    .run('ended', predecessorEndedTs, 'predecessor-session')

  // Construct manager AFTER fixture insert so restoreFromDb loads the
  // predecessor into the in-memory map (which findPredecessor scans).
  const manager = new SessionManager(db)
  try {
    // Trigger creation of the successor via the same public API Task 2.1's
    // test uses; handleEvent with SessionStart on a previously-unknown
    // session id invokes createSession then tryInheritFromPredecessor.
    manager.handleEvent({
      session_id: 'successor-session',
      hook_event_name: 'SessionStart',
      cwd: '/tmp/inherit',
      transcript_path: '',
      timestamp: successorStartTs,
    } as any)

    const row = db.prepare(
      'SELECT chain_id, predecessor_id FROM sessions WHERE session_id = ?'
    ).get('successor-session') as { chain_id: string; predecessor_id: string } | undefined
    assert(row, 'successor-session was not created')
    assert.equal(row.predecessor_id, 'predecessor-session', 'successor should link to predecessor')
    assert.equal(
      row.chain_id,
      'chain_pre00000',
      `successor should inherit predecessor chain_id, got "${row.chain_id}"`
    )

    const inMemory = manager.getSession('successor-session')
    assert(inMemory, 'in-memory successor session missing')
    assert.equal(
      inMemory.chain_id,
      'chain_pre00000',
      'in-memory chain_id should match DB after inheritance'
    )
  } finally {
    manager.destroy()
    db.close()
  }
  console.log('verify: chain inherited from predecessor')
}

async function main() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'session-dashboard-smoke-'))
  try {
    verifyPackageManifest(tempRoot)
    verifyChainColumn(tempRoot)
    verifyChainIdGenerator()
    verifyChainIdAssignedOnInsert(tempRoot)
    verifyChainInheritedFromPredecessor(tempRoot)
    verifySubagentInheritsChainOnLatePromotion(tempRoot)
    verifyBuiltCli()
    verifyRuntimeDefaults()
    verifyServicePlist(tempRoot)
    verifyInsightsCwdList(tempRoot)
    verifyTimeRangeList(tempRoot)
    verifyInsightsGrepList(tempRoot)
    verifyInsightsSessionExactPriority(tempRoot)
    verifyInsightsChainFlagParsing(tempRoot)
    verifyInsightsListChain(tempRoot)
    verifyInsightsListChainGrep(tempRoot)
    verifyInsightsListChainScopes(tempRoot)
    verifyCodexHook()
    verifySessionRestore(tempRoot)
    verifySessionExport(tempRoot)
    verifyRecordsCut(tempRoot)
    verifyEventDedup(tempRoot)
    verifyInsightExtractionCompatibility()
    verifyUserInputNoiseFiltering()
    verifyInsightTimestampActivity(tempRoot)
    verifyRepairScript(tempRoot)
    verifyRepairBackfillsChainIds(tempRoot)
    verifyRepairRebuildsChainIds(tempRoot)
    verifyRepairRebuildsChainIdsDryRun(tempRoot)
    await verifyTranscriptRebind(tempRoot)
    console.log('verify: smoke checks passed')
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

await main()
