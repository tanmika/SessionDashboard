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
import { extractInsightBlocks, sanitizeUserInput } from '../server/utils/insight-extractor.js'

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

  const stdout = runCommand('node', ['scripts/repair-dashboard.js', '--days', '30'], {
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

async function main() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'session-dashboard-smoke-'))
  try {
    verifyPackageManifest(tempRoot)
    verifyBuiltCli()
    verifyCodexHook()
    verifySessionRestore(tempRoot)
    verifySessionExport(tempRoot)
    verifyEventDedup(tempRoot)
    verifyInsightExtractionCompatibility()
    verifyUserInputNoiseFiltering()
    verifyInsightTimestampActivity(tempRoot)
    verifyRepairScript(tempRoot)
    await verifyTranscriptRebind(tempRoot)
    console.log('verify: smoke checks passed')
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

await main()
