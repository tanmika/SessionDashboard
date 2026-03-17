import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { applySchema } from '../server/db.js'
import { SessionManager } from '../server/services/session-manager.js'
import { exportSessionText } from '../server/services/session-export.js'
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
    'scripts/export-session.js',
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

function insertSession(
  db: Database.Database,
  sessionId: string,
  options: {
    cwd: string
    transcriptPath: string
    source: 'claude' | 'codex'
    predecessorId?: string
  }
) {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO sessions (
      session_id, cwd, transcript_path, state, last_activity, created_at, pinned, alias, source, predecessor_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    options.predecessorId || ''
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
    verifySessionExport(tempRoot)
    await verifyTranscriptRebind(tempRoot)
    console.log('verify: smoke checks passed')
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

await main()
