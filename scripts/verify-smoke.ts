import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { applySchema } from '../server/db.js'
import { SessionManager } from '../server/services/session-manager.js'
import { TranscriptWatcher } from '../server/services/transcript-watcher.js'

const repoRoot = resolve(import.meta.dirname, '..')

function runCommand(command: string, args: string[], options?: {
  cwd?: string
  env?: NodeJS.ProcessEnv
  input?: string
}) {
  const result = spawnSync(command, args, {
    cwd: options?.cwd ?? repoRoot,
    env: options?.env,
    input: options?.input,
    encoding: 'utf8',
  })
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  )
  return result.stdout
}

function makeInsightBlock(label: string): string {
  return [
    '`★ Insight ─────────────────────────────────────`',
    `- ${label}`,
    '`─────────────────────────────────────────────────`',
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
    appendFileSync(nextPath, makeAssistantRecord('new-bound'))
    await waitFor(() => insights.some((content) => content.includes('new-bound')), 2000, 'rebind to new transcript path')
  } finally {
    watcher.unwatchAll()
  }
  console.log('verify: transcript watcher rebind')
}

async function main() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'session-dashboard-smoke-'))
  try {
    verifyPackageManifest(tempRoot)
    verifyBuiltCli()
    verifyCodexHook()
    verifySessionRestore(tempRoot)
    await verifyTranscriptRebind(tempRoot)
    console.log('verify: smoke checks passed')
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

await main()
