# Chain ID Modeling Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.
> Tests use the project's smoke harness (`scripts/verify-smoke.ts`). For each task, follow the TDD-shaped flow described in **Testing model** below.

**Goal:** Promote `chain = 一次真实主会话` to a first-class concept by adding a persisted `chain_id` column, wiring it through write paths, repair, and all CLI commands (`insights`, `export`, `records cut`), so that a真实主会话 (and its subagents) can be queried as one unit instead of reconstructed from `predecessor_id` at runtime.

**Architecture:**
- Add `sessions.chain_id` column (`TEXT NOT NULL DEFAULT ''`).
- Write rule: new session → if `predecessor_id` set, inherit; if `is_subagent`, inherit from parent's `chain_id`; otherwise generate fresh `chain_xxxxxxxx`.
- Read rule: chain queries are SQL aggregations on `WHERE chain_id = ?`. Subagents live under the same `chain_id` but are surfaced in a separate "subagent 区" of the chain view.
- All new CLI surface uses `--chain` (no参 → group sessions by chain in `--list`; with参 → read/export/cut by chain id).

**Tech Stack:**
- SQLite (better-sqlite3 11.x)
- TypeScript, tsx (dev), esbuild bundle for `lib/`
- Single-file smoke test harness at `scripts/verify-smoke.ts`

---

## Testing model (read once before starting)

The project does NOT use vitest / jest. It has one smoke harness:

```
npm run verify:smoke
```

That command runs `npm run build` then `node scripts/verify-smoke.js`. Each behaviour is verified by a `verifyXxx(tempRoot)` function in `scripts/verify-smoke.ts` that:

1. Creates a temp `dashboard.db`, calls `applySchema(db)`.
2. Inserts fixture rows directly with the local `insertSession()` / `insertInsight()` helpers.
3. Either invokes a service (`SessionManager`, `exportSessionText`) in-process, OR spawns the built CLI via `runCommand('node', ['lib/cli.js', ...])`.
4. Asserts with `node:assert/strict`.

**TDD flow used in every task below:**

1. Add a new `verifyChainXxx(tempRoot)` function to `scripts/verify-smoke.ts` and call it from `main()`. Write the assertions FIRST.
2. Run `npm run verify:smoke` → expect a failure that names the new assertion.
3. Implement the smallest code change that makes the new assertion pass.
4. Run `npm run verify:smoke` again → expect all asserts (old + new) to pass.
5. Commit.

When a task only changes types / docs (no behaviour change), the TDD step is skipped and the task notes it explicitly.

**Skills referenced:** @superpowers:test-driven-development, @superpowers:verification-before-completion.

---

## Conventions used in this plan

- "main 区" = sessions in a chain with `is_subagent = 0`.
- "subagent 区" = sessions in a chain with `is_subagent = 1`.
- Chain query commands默认 only operate on main 区 unless `--include-subagents` is passed.
- Chain id format: `chain_` + 8 chars from Crockford Base32 (`abcdefghjkmnpqrstvwxyz0123456789` — 32 symbols, no `i / l / o / u`). Total length = 14. Lower case in storage. Example: `chain_a3k7m2pq`.
- "Existing line X" references are valid as of branch `develop` at commit `e7dc4b7`. Re-check with `grep` if the file has drifted.

---

## Stage 0 — Worktree setup

### Task 0.1: Create the worktree

**Files:** none (env only)

**Step 1:** From the repo root, create an isolated worktree.

```bash
git worktree add ../session-dashboard-chain develop
cd ../session-dashboard-chain
git switch -c feature/chain-id-modeling
```

**Step 2:** Confirm the working tree is clean.

```bash
git status
```

Expected: `nothing to commit, working tree clean`.

**Step 3:** Confirm smoke still green on the new branch (catches "broken before we started" cases).

```bash
npm install
npm run verify:smoke
```

Expected: trailing line `verify: smoke checks passed`.

**No commit** — environment setup.

---

## Stage 1 — Schema, types, id generator

### Task 1.1: Add `chain_id` column to schema

**Files:**
- Modify: `server/db.ts:46-51` (the ALTER TABLE block)

**Step 1: Write the failing test**

Add this function to `scripts/verify-smoke.ts` (above `function main()`), and call it from `main()` right after `verifyPackageManifest(tempRoot)`:

```ts
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
```

**Step 2: Run smoke to verify it fails**

```bash
npm run verify:smoke
```

Expected: AssertionError mentioning `sessions.chain_id column missing`.

**Step 3: Implement minimal change**

Append at the end of `applySchema()` in `server/db.ts` (after the `predecessor_id` ALTER):

```ts
  try { db.exec(`ALTER TABLE sessions ADD COLUMN chain_id TEXT NOT NULL DEFAULT ''`) } catch { /* already exists */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_chain ON sessions(chain_id)`) } catch { /* already exists */ }
```

**Step 4: Run smoke to verify it passes**

```bash
npm run verify:smoke
```

Expected: `verify: chain column` line printed, smoke passes.

**Step 5: Commit**

```bash
git add server/db.ts scripts/verify-smoke.ts
git commit -m "feat(chain): add chain_id column to sessions table"
```

---

### Task 1.2: Add `chain_id` to the `Session` type

**Files:**
- Modify: `shared/types.ts:131` (insert immediately after `predecessor_id?: string`)

**Step 1: No new test** — pure type addition. Existing TypeScript build (`vue-tsc -b`) is the test.

**Step 2: Edit**

In `shared/types.ts`, add inside the `Session` interface right after the `predecessor_id?` line:

```ts
  // Chain id assigned at insert time; immutable thereafter.
  // Sessions sharing a chain_id are one real main session (+ its subagents).
  chain_id?: string
```

**Step 3: Verify build passes**

```bash
npm run build
```

Expected: no TS errors.

**Step 4: Commit**

```bash
git add shared/types.ts
git commit -m "feat(chain): add chain_id field to Session type"
```

---

### Task 1.3: Implement `generateChainId()`

**Files:**
- Create: `shared/chain-id.ts`
- Modify: `scripts/verify-smoke.ts` (add a verify function)

**Step 1: Write the failing test**

Add to `scripts/verify-smoke.ts` above `main()`:

```ts
function verifyChainIdGenerator() {
  const { generateChainId, isChainId } = require('../shared/chain-id.js') as typeof import('../shared/chain-id.js')
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
```

Call it from `main()` after `verifyChainColumn(tempRoot)`. Convert the `require` to a static `import` at the top of the file if you prefer; both work because of `"type": "module"` + tsx — but `require` of an `.js` extension works because the smoke is bundled through tsx. If TS complains, use the import form:

```ts
import { generateChainId, isChainId } from '../shared/chain-id.js'
```

**Step 2: Run smoke to verify it fails**

```bash
npm run verify:smoke
```

Expected: failure resolving `shared/chain-id.js` (module not found).

**Step 3: Implement**

Create `shared/chain-id.ts`:

```ts
import { randomBytes } from 'node:crypto'

// Crockford Base32 alphabet (no i / l / o / u).
const ALPHABET = 'abcdefghjkmnpqrstvwxyz0123456789'
const ID_LENGTH = 8
const PREFIX = 'chain_'

export function generateChainId(): string {
  // 8 chars × 5 bits = 40 bits. randomBytes(5) gives exactly 40 bits.
  const bytes = randomBytes(ID_LENGTH)
  let out = ''
  for (let i = 0; i < ID_LENGTH; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length]
  }
  return PREFIX + out
}

const CHAIN_ID_RE = new RegExp(`^${PREFIX}[${ALPHABET}]{${ID_LENGTH}}$`)

export function isChainId(value: string | undefined | null): value is string {
  return typeof value === 'string' && CHAIN_ID_RE.test(value)
}
```

**Step 4: Run smoke**

```bash
npm run verify:smoke
```

Expected: `verify: chain id generator` printed, smoke passes.

**Step 5: Commit**

```bash
git add shared/chain-id.ts scripts/verify-smoke.ts
git commit -m "feat(chain): add chain id generator and validator"
```

---

### Task 1.4: Update smoke `insertSession` helper to accept `chainId`

**Files:**
- Modify: `scripts/verify-smoke.ts:150-177` (the `insertSession` helper)

**Step 1: No new test for helpers themselves** — they are test fixtures. The next task uses them.

**Step 2: Edit `insertSession`** to add an optional `chainId` parameter and a new INSERT column:

```ts
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
```

**Step 3: Run smoke**

```bash
npm run verify:smoke
```

Expected: all existing tests still pass (new column gets empty default, behaves like before).

**Step 4: Commit**

```bash
git add scripts/verify-smoke.ts
git commit -m "test(chain): extend insertSession fixture helper for chain fields"
```

---

## Stage 2 — Write path: assign `chain_id` on session insert

### Task 2.1: Assign fresh `chain_id` to new main sessions

**Files:**
- Modify: `server/services/session-manager.ts:63-77` (prepared statements area)
- Modify: `server/services/session-manager.ts:650-680` (the `INSERT INTO sessions` path inside `createSession()` — read the surrounding context first; the exact line range may have shifted, anchor on the `INSERT INTO sessions ... VALUES ...` SQL string)
- Modify: `scripts/verify-smoke.ts`

**Step 1: Write the failing test**

Add to `scripts/verify-smoke.ts`:

```ts
function verifyChainIdAssignedOnInsert(tempRoot: string) {
  const dbPath = join(tempRoot, 'chain-assign.db')
  const db = new Database(dbPath)
  applySchema(db)
  const manager = new SessionManager(db)
  try {
    // Simulate a new claude session arriving via the manager's public surface.
    // Easiest: call addInsight on an unknown session_id with a cwd; the manager
    // creates the session row implicitly. Check the source if this isn't true.
    // (If addInsight doesn't auto-create, switch to manager.ensureSession or
    //  equivalent — check session-manager.ts for the right entry point.)
    manager.addInsight('fresh-session', '- hello', 'transcript', new Date().toISOString())
    const row = db.prepare('SELECT chain_id, predecessor_id FROM sessions WHERE session_id = ?')
      .get('fresh-session') as { chain_id: string; predecessor_id: string }
    assert(row, 'session was not created')
    assert.equal(row.predecessor_id, '')
    assert.match(row.chain_id, /^chain_[abcdefghjkmnpqrstvwxyz0-9]{8}$/, `bad chain_id ${row.chain_id}`)
  } finally {
    manager.destroy()
    db.close()
  }
  console.log('verify: chain id assigned on insert')
}
```

Call it from `main()` after the previous verify functions.

> Note for the executor: before adding the test, open `server/services/session-manager.ts` and confirm the correct method (`addInsight` may or may not create a session — the project's tests at line 1444 show `manager.addInsight` working on a pre-inserted session). If `addInsight` does not auto-create, locate the actual session-creation entry point (search for `INSERT INTO sessions`) and write the test against that — but always exercise it via the `SessionManager` public API, not raw SQL.

**Step 2: Run smoke**

```bash
npm run verify:smoke
```

Expected: assertion failure on `row.chain_id` (still `''`).

**Step 3: Implement**

In `server/services/session-manager.ts`:

3a. Import the generator near the top:

```ts
import { generateChainId } from '../../shared/chain-id.js'
```

3b. In the `prepare` block (around line 63-77), add `chain_id` to the INSERT column list and update the bind list:

```ts
this.stmtInsertSession = db.prepare(`
  INSERT INTO sessions (
    session_id, cwd, transcript_path, state, last_activity, created_at, source,
    is_subagent, parent_session_id, chain_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
```

(Keep other prepared statements untouched.)

3c. In `createSession()` (search the file for the line that runs `stmtInsertSession.run(...)`) add `chain_id` to the bound values. If you haven't computed it yet, generate it inline:

```ts
const chainId = metadata?.parentSessionId
  ? (this.sessions.get(metadata.parentSessionId)?.chain_id || generateChainId())
  : generateChainId()
session.chain_id = chainId
```

Then append `chainId` to the `.run(...)` argument list.

3d. Add `chain_id` to the in-memory `Session` mapping (search for the place that constructs the in-memory `Session` object, normally `{ session_id, cwd, ..., predecessor_id: ..., is_subagent: ... }`) — set `chain_id: chainId`.

3e. Also handle the restore path (`session-manager.ts:135-180` area): when rehydrating from DB, copy `row.chain_id` into the in-memory Session. If `row.chain_id === ''`, leave undefined — Stage 3's repair will backfill on demand.

**Step 4: Run smoke**

```bash
npm run verify:smoke
```

Expected: new test passes, all others still pass.

**Step 5: Commit**

```bash
git add server/services/session-manager.ts shared/chain-id.ts scripts/verify-smoke.ts
git commit -m "feat(chain): assign chain_id on session insert"
```

---

### Task 2.2: Inherit `chain_id` from predecessor

**Files:**
- Modify: `server/services/session-manager.ts:761-793` (the `tryInheritFromPredecessor` function)
- Modify: `scripts/verify-smoke.ts`

**Step 1: Write the failing test**

Add to `scripts/verify-smoke.ts`:

```ts
function verifyChainInheritedFromPredecessor(tempRoot: string) {
  const dbPath = join(tempRoot, 'chain-inherit.db')
  const db = new Database(dbPath)
  applySchema(db)

  // Predecessor candidate: must be pinned/aliased for the existing handoff
  // logic to trigger. Match the cwd and source the new session will use.
  insertSession(db, 'predecessor-session', {
    cwd: '/tmp/inherit',
    transcriptPath: '',
    source: 'claude',
    chainId: 'chain_pre00000',
  })
  db.prepare('UPDATE sessions SET pinned = 1, state = ?, last_activity = ? WHERE session_id = ?')
    .run('ended', new Date(Date.now() - 60_000).toISOString(), 'predecessor-session')

  const manager = new SessionManager(db)
  try {
    manager.addInsight('successor-session', '- hi', 'transcript', new Date().toISOString())
    // Manually mark its cwd / source via the manager's public surface, or
    // adjust the test to whichever entrypoint sets cwd. Easiest workaround:
    // update the row directly to align cwd, then trigger handoff.
    db.prepare('UPDATE sessions SET cwd = ?, source = ? WHERE session_id = ?')
      .run('/tmp/inherit', 'claude', 'successor-session')
    // Force the manager to re-evaluate handoff. The simplest way is to
    // re-create the SessionManager (already does restore + handoff on init);
    // but we need a manager API that re-runs tryInheritFromPredecessor on
    // an existing session. If none exists, add one as part of this task:
    // manager.refreshSession('successor-session').
    manager.refreshSession?.('successor-session')

    const row = db.prepare('SELECT chain_id, predecessor_id FROM sessions WHERE session_id = ?')
      .get('successor-session') as { chain_id: string; predecessor_id: string }
    assert.equal(row.predecessor_id, 'predecessor-session')
    assert.equal(row.chain_id, 'chain_pre00000', 'successor should inherit predecessor chain_id')
  } finally {
    manager.destroy()
    db.close()
  }
  console.log('verify: chain inherited from predecessor')
}
```

> Executor note: the exact way to trigger handoff in a unit-style test may differ. If `refreshSession` doesn't exist, look at how `tryInheritFromPredecessor` is currently invoked (search the file). Two acceptable approaches:
> - (preferred) Extract `tryInheritFromPredecessor` into a small public method `applyHandoff(sessionId)` that the test can call.
> - (fallback) Have the test simulate the call site directly: post the same event that originally triggered handoff.

**Step 2: Run smoke**

```bash
npm run verify:smoke
```

Expected: assertion failure — `successor-session.chain_id` is the freshly generated one from Task 2.1, not `chain_pre00000`.

**Step 3: Implement**

In `tryInheritFromPredecessor` (`server/services/session-manager.ts:761-793`), after the existing `this.stmtSetPredecessor.run(...)` line (around line 780), add:

```ts
// Inherit chain_id from predecessor
if (predecessor.chain_id && predecessor.chain_id !== session.chain_id) {
  session.chain_id = predecessor.chain_id
  this.stmtSetChainId ??= this.db.prepare(`UPDATE sessions SET chain_id = ? WHERE session_id = ?`)
  this.stmtSetChainId.run(predecessor.chain_id, session.session_id)
}
```

Add the new prepared-statement field near the other ones (look at the class field declarations around lines 60-80):

```ts
private stmtSetChainId?: Database.Statement
```

(Or eagerly initialize it alongside the others — pick the style already used.)

**Step 4: Run smoke**

```bash
npm run verify:smoke
```

Expected: all green.

**Step 5: Commit**

```bash
git add server/services/session-manager.ts scripts/verify-smoke.ts
git commit -m "feat(chain): inherit chain_id from predecessor on handoff"
```

---

### Task 2.3: Subagent inherits `chain_id` from its parent

**Files:**
- Modify: `server/services/session-manager.ts` — the path that creates / updates `is_subagent = 1` rows (search `is_subagent` to find both creation at line ~658-675 and metadata update at line ~236-241).
- Modify: `scripts/verify-smoke.ts`

**Step 1: Write the failing test**

```ts
function verifySubagentInheritsChainFromParent(tempRoot: string) {
  const dbPath = join(tempRoot, 'subagent-chain.db')
  const db = new Database(dbPath)
  applySchema(db)

  insertSession(db, 'parent-main', {
    cwd: '/tmp/subagent',
    transcriptPath: '',
    source: 'codex',
    chainId: 'chain_par00000',
  })

  const manager = new SessionManager(db)
  try {
    // Subagent is created with parentSessionId metadata. The exact API is
    // SessionManager-internal; the smoke test for restore (line 702) shows
    // the manager auto-creating on first insight if needed. Cleanest path:
    // call the same internal entry the codex watcher uses.
    // Adjust this call to match the actual API surface.
    manager.upsertSession?.('child-sub', {
      cwd: '/tmp/subagent',
      source: 'codex',
      isSubagent: true,
      parentSessionId: 'parent-main',
    })

    const row = db.prepare(
      'SELECT chain_id, is_subagent, parent_session_id FROM sessions WHERE session_id = ?'
    ).get('child-sub') as { chain_id: string; is_subagent: number; parent_session_id: string }
    assert.equal(row.is_subagent, 1)
    assert.equal(row.parent_session_id, 'parent-main')
    assert.equal(row.chain_id, 'chain_par00000', 'subagent must inherit parent chain_id')
  } finally {
    manager.destroy()
    db.close()
  }
  console.log('verify: subagent inherits chain from parent')
}
```

> Executor note: there's already partial logic at lines 234-242 that promotes existing sessions to subagent when `metadata.isSubagent && metadata.parentSessionId` arrive. Mirror the chain_id update at that location too — when the manager learns "this session is actually a subagent of X", and the session currently has a chain_id different from X's chain_id, overwrite with X's chain_id (preserving the rule that chain_id can be assigned exactly once per session — here we're correcting an early-assigned guess).

**Step 2: Run smoke** → fail.

**Step 3: Implement**

At each location that handles subagent metadata, after setting `parent_session_id`, also set the chain_id. Two cases:

3a. Initial insert path (`createSession()` around line 650-680): in the chain_id computation introduced in Task 2.1, the `metadata?.parentSessionId` branch already takes the parent's `chain_id`. Confirm `this.sessions.get(metadata.parentSessionId)?.chain_id` is the source. If the parent isn't in the in-memory map, fall back to a DB query:

```ts
function lookupParentChainId(parentId: string): string | undefined {
  const cached = this.sessions.get(parentId)
  if (cached?.chain_id) return cached.chain_id
  const row = this.db.prepare('SELECT chain_id FROM sessions WHERE session_id = ?').get(parentId) as { chain_id?: string } | undefined
  return row?.chain_id || undefined
}
```

3b. Late-promotion path (around line 234-242): when `metadata.parentSessionId` arrives on an existing session, also update chain_id:

```ts
if (metadata.parentSessionId && existing.parent_session_id !== metadata.parentSessionId) {
  existing.parent_session_id = metadata.parentSessionId
  this.stmtUpdateThread.run(existing.is_subagent ? 1 : 0, existing.parent_session_id, existing.session_id)

  const parentChain = this.lookupParentChainId(metadata.parentSessionId)
  if (parentChain && parentChain !== existing.chain_id) {
    existing.chain_id = parentChain
    this.stmtSetChainId.run(parentChain, existing.session_id)
  }
}
```

**Step 4: Run smoke** → green.

**Step 5: Commit**

```bash
git add server/services/session-manager.ts scripts/verify-smoke.ts
git commit -m "feat(chain): subagents inherit chain_id from parent"
```

---

## Stage 3 — Repair backfill

### Task 3.1: Backfill missing `chain_id` for existing rows

**Files:**
- Modify: `scripts/repair-dashboard.ts` (add a new repair pass)
- Modify: `scripts/verify-smoke.ts`

**Step 1: Write the failing test**

```ts
function verifyRepairBackfillsChainIds(tempRoot: string) {
  const tempHome = join(tempRoot, 'chain-repair-home')
  const dataDir = join(tempHome, 'data')
  mkdirSync(dataDir, { recursive: true })
  const dbPath = join(dataDir, 'dashboard.db')
  const db = new Database(dbPath)
  applySchema(db)

  // Three-session chain: A → B → C (B.predecessor_id = A, C.predecessor_id = B)
  insertSession(db, 'chain-a', { cwd: '/tmp/r', transcriptPath: '', source: 'claude' })
  insertSession(db, 'chain-b', { cwd: '/tmp/r', transcriptPath: '', source: 'claude', predecessorId: 'chain-a' })
  insertSession(db, 'chain-c', { cwd: '/tmp/r', transcriptPath: '', source: 'claude', predecessorId: 'chain-b' })
  // Subagent of chain-b
  insertSession(db, 'chain-sub', {
    cwd: '/tmp/r', transcriptPath: '', source: 'codex',
    isSubagent: true, parentSessionId: 'chain-b',
  })
  // Standalone session
  insertSession(db, 'standalone', { cwd: '/tmp/r2', transcriptPath: '', source: 'claude' })
  db.close()

  runCommand('node', ['scripts/repair-dashboard.js', '--days', '3650'], {
    env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome },
  })

  const repaired = new Database(dbPath, { readonly: true })
  try {
    const rows = repaired.prepare('SELECT session_id, chain_id FROM sessions ORDER BY session_id').all() as Array<{ session_id: string; chain_id: string }>
    const map = Object.fromEntries(rows.map((r) => [r.session_id, r.chain_id]))
    assert.match(map['chain-a'], /^chain_[a-z0-9]{8}$/, 'chain-a should get a chain_id')
    assert.equal(map['chain-b'], map['chain-a'], 'chain-b must share chain-a chain_id')
    assert.equal(map['chain-c'], map['chain-a'], 'chain-c must share chain-a chain_id')
    assert.equal(map['chain-sub'], map['chain-b'], 'subagent must share parent chain_id')
    assert.notEqual(map['standalone'], map['chain-a'], 'standalone gets its own chain_id')
    assert.match(map['standalone'], /^chain_[a-z0-9]{8}$/)
  } finally {
    repaired.close()
  }
  console.log('verify: repair backfills chain ids')
}
```

**Step 2: Run smoke** → assertion failure (all chain_id are empty).

**Step 3: Implement**

Add a new pass to `scripts/repair-dashboard.ts`. Near the end of `main()` (after existing repairs), invoke a new function:

```ts
function backfillChainIds(db: Database.Database, dryRun: boolean): { assigned: number } {
  // 1. Find all sessions ordered by created_at ASC — earlier ones become chain roots.
  const sessions = db.prepare(`
    SELECT session_id, predecessor_id, is_subagent, parent_session_id, chain_id, created_at
    FROM sessions
    ORDER BY created_at ASC
  `).all() as Array<{
    session_id: string
    predecessor_id: string
    is_subagent: number
    parent_session_id: string
    chain_id: string
    created_at: string
  }>

  const byId = new Map(sessions.map((s) => [s.session_id, s]))
  const update = db.prepare('UPDATE sessions SET chain_id = ? WHERE session_id = ?')

  function resolve(sessionId: string, depth = 0): string {
    if (depth > 100) return generateChainId() // cycle guard
    const row = byId.get(sessionId)
    if (!row) return generateChainId()
    if (row.chain_id) return row.chain_id

    // Priority: subagent → parent, else predecessor → predecessor, else fresh.
    let chainId: string | null = null
    if (row.is_subagent === 1 && row.parent_session_id && byId.has(row.parent_session_id)) {
      chainId = resolve(row.parent_session_id, depth + 1)
    } else if (row.predecessor_id && byId.has(row.predecessor_id)) {
      chainId = resolve(row.predecessor_id, depth + 1)
    }
    if (!chainId) chainId = generateChainId()
    row.chain_id = chainId
    if (!dryRun) update.run(chainId, sessionId)
    return chainId
  }

  let assigned = 0
  for (const session of sessions) {
    if (!session.chain_id) {
      resolve(session.session_id)
      assigned += 1
    }
  }
  return { assigned }
}
```

Wire it into `main()` and include `chainIdsAssigned: <n>` in the JSON summary (the smoke test in `verifyRepairScript` parses this JSON — see the structure at line 1554). Add the new field to the typed summary or use a discriminated union; the simplest path is to widen the existing summary type.

Don't forget the import:

```ts
import { generateChainId } from '../shared/chain-id.js'
```

**Step 4: Run smoke** → green.

**Step 5: Commit**

```bash
git add scripts/repair-dashboard.ts scripts/verify-smoke.ts
git commit -m "feat(chain): repair script backfills chain_id for legacy rows"
```

---

### Task 3.2: `repair --rebuild-chains` clears and recomputes

**Files:**
- Modify: `scripts/repair-dashboard.ts` (parse new flag, gate the clear)
- Modify: `scripts/verify-smoke.ts`

**Step 1: Write the failing test**

Extend `verifyRepairBackfillsChainIds` (or add a sibling `verifyRepairRebuildsChainIds`) that:

1. Pre-fills `chain-a/b/c` with **wrong** chain_ids (different ids per row).
2. Runs `repair --rebuild-chains --days 3650`.
3. Asserts that after the run, a/b/c again share one chain_id (the wrong values were thrown away).

```ts
function verifyRepairRebuildsChainIds(tempRoot: string) {
  // ... same fixture setup as 3.1 ...
  db.prepare('UPDATE sessions SET chain_id = ? WHERE session_id = ?').run('chain_wrongA1', 'chain-a')
  db.prepare('UPDATE sessions SET chain_id = ? WHERE session_id = ?').run('chain_wrongB1', 'chain-b')
  db.prepare('UPDATE sessions SET chain_id = ? WHERE session_id = ?').run('chain_wrongC1', 'chain-c')
  db.close()

  runCommand('node', ['scripts/repair-dashboard.js', '--rebuild-chains', '--days', '3650'], {
    env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome },
  })

  const repaired = new Database(dbPath, { readonly: true })
  const rows = repaired.prepare('SELECT chain_id FROM sessions WHERE session_id IN (?, ?, ?)')
    .all('chain-a', 'chain-b', 'chain-c') as Array<{ chain_id: string }>
  repaired.close()
  const unique = new Set(rows.map((r) => r.chain_id))
  assert.equal(unique.size, 1, `rebuild should collapse to one chain_id, got: ${[...unique].join(',')}`)
  assert(!unique.has('chain_wrongA1') && !unique.has('chain_wrongB1') && !unique.has('chain_wrongC1'))
  console.log('verify: repair rebuilds chain ids')
}
```

**Step 2: Run smoke** → fail (rebuild has no effect, the wrong ids stay).

**Step 3: Implement**

In `parseArgs` of `repair-dashboard.ts`, add `rebuildChains: boolean` (default false). Then in `main()`, before calling `backfillChainIds`:

```ts
if (parsed.rebuildChains && !parsed.dryRun) {
  db.prepare('UPDATE sessions SET chain_id = \'\'').run()
}
```

**Step 4: Run smoke** → green.

**Step 5: Commit**

```bash
git add scripts/repair-dashboard.ts scripts/verify-smoke.ts
git commit -m "feat(chain): repair --rebuild-chains forces full chain id recompute"
```

---

## Stage 4 — `insights --list --chain` (chain-grouped list)

### Task 4.1: Parse `--chain` as a list-mode flag

**Files:**
- Modify: `scripts/read-insights.ts:19-33` (Args type) and the parsing switch (around line 176)

**Step 1: No new test yet** — parsing alone is unobservable; the next task adds a behaviour test.

**Step 2: Edit Args**

In the `Args` interface, the existing `chain` field is currently a boolean. Promote it to support both list-mode (no value) and read-mode (a chain id) by splitting into two fields:

```ts
interface Args {
  // ...
  chain: boolean        // --chain in list mode = group by chain
  chainId?: string      // --chain <chain_xxx> in read mode = read one chain
  includeSubagents: boolean
  // ...
}
```

In the parse switch (around line 176), replace the `case '--chain'` with:

```ts
case '--chain': {
  const next = process.argv[i + 1]
  if (next && !next.startsWith('--')) {
    if (!isChainId(next)) {
      console.error(`Error: --chain expects a chain id of the form chain_xxxxxxxx, got "${next}"`)
      process.exit(1)
    }
    args.chainId = next
    i += 1
  } else {
    args.chain = true
  }
  break
}
case '--include-subagents':
  args.includeSubagents = true
  break
```

Import:

```ts
import { isChainId } from '../shared/chain-id.js'
```

**Step 3: Build**

```bash
npm run build
```

Expected: no TS errors.

**Step 4: Commit**

```bash
git add scripts/read-insights.ts
git commit -m "feat(chain): parse --chain as list flag or chain id in insights CLI"
```

---

### Task 4.2: `insights --list --chain` returns chain-aggregated rows

**Files:**
- Modify: `scripts/read-insights.ts` — the list-printing path
- Modify: `scripts/verify-smoke.ts`

**Step 1: Write the failing test**

```ts
function verifyInsightsListChain(tempRoot: string) {
  const tempHome = join(tempRoot, 'list-chain-home')
  const dataDir = join(tempHome, 'data')
  mkdirSync(dataDir, { recursive: true })
  const dbPath = join(dataDir, 'dashboard.db')
  const db = new Database(dbPath)
  applySchema(db)

  insertSession(db, 'chain-a-1', { cwd: '/tmp/list-chain', transcriptPath: '', source: 'claude', chainId: 'chain_aaaaaa11' })
  insertSession(db, 'chain-a-2', { cwd: '/tmp/list-chain', transcriptPath: '', source: 'claude', chainId: 'chain_aaaaaa11', predecessorId: 'chain-a-1' })
  insertSession(db, 'chain-a-sub', { cwd: '/tmp/list-chain', transcriptPath: '', source: 'codex', chainId: 'chain_aaaaaa11', isSubagent: true, parentSessionId: 'chain-a-1' })
  insertSession(db, 'chain-b-1', { cwd: '/tmp/list-chain', transcriptPath: '', source: 'claude', chainId: 'chain_bbbbbb22' })
  insertInsight(db, 'chain-a-1', 'a1 insight', 'transcript', '2026-05-10T09:00:00.000Z')
  insertInsight(db, 'chain-a-2', 'a2 insight', 'transcript', '2026-05-11T09:00:00.000Z')
  insertInsight(db, 'chain-a-sub', 'subagent insight', 'transcript', '2026-05-11T09:30:00.000Z')
  insertInsight(db, 'chain-b-1', 'b1 insight', 'transcript', '2026-05-09T09:00:00.000Z')
  db.close()

  const stdout = runCommand('node', ['lib/cli.js', 'insights', '--list', '--chain', '--all', '--json'], {
    env: { ...process.env, SESSION_DASHBOARD_HOME: tempHome },
  })
  const parsed = JSON.parse(stdout) as Array<{
    chain_id: string
    main_session_ids: string[]
    subagent_session_ids: string[]
    sessions_count: number
    representative_session_id: string
    insights_count: number
  }>
  const a = parsed.find((c) => c.chain_id === 'chain_aaaaaa11')
  const b = parsed.find((c) => c.chain_id === 'chain_bbbbbb22')
  assert(a && b, 'both chains should appear')
  assert.deepEqual(a!.main_session_ids.sort(), ['chain-a-1', 'chain-a-2'])
  assert.deepEqual(a!.subagent_session_ids, ['chain-a-sub'])
  assert.equal(a!.representative_session_id, 'chain-a-2', 'representative = latest main session')
  // chain a is newer (last activity 2026-05-11) and should come first
  assert.equal(parsed[0].chain_id, 'chain_aaaaaa11')
  // insights_count counts main区 only by default
  assert.equal(a!.insights_count, 2)
  console.log('verify: insights --list --chain')
}
```

**Step 2: Run smoke** → fail (chain mode not implemented yet; current `--list` returns sessions, not chains).

**Step 3: Implement**

In `scripts/read-insights.ts`, route into a new code path when `args.list && args.chain && !args.chainId`. The existing list path branches on session-level filters; add a sibling that aggregates by `chain_id`:

```ts
function listChains(db: Database.Database, args: Args): ChainSummary[] {
  // Build WHERE clause for the session-level filters (same cwd/range/grep logic).
  // Then GROUP BY chain_id, aggregating:
  //   - main_session_ids = JSON list of session_id where is_subagent = 0
  //   - subagent_session_ids = JSON list where is_subagent = 1
  //   - representative_session_id = main session with MAX(last_activity)
  //   - sessions_count = main only (subagents excluded unless --include-subagents)
  //   - insights_count = sum of insights linked to main sessions
  // ORDER BY MAX(last_activity) DESC.
}
```

A workable SQL skeleton (read inline carefully — adjust to the project's existing range/cwd/grep builders for consistency):

```sql
SELECT
  chain_id,
  MAX(last_activity) AS chain_last_activity,
  MIN(created_at)    AS chain_started_at,
  json_group_array(CASE WHEN is_subagent = 0 THEN session_id END) AS main_session_ids_raw,
  json_group_array(CASE WHEN is_subagent = 1 THEN session_id END) AS subagent_session_ids_raw,
  SUM(CASE WHEN is_subagent = 0 THEN 1 ELSE 0 END) AS main_count,
  SUM(CASE WHEN is_subagent = 1 THEN 1 ELSE 0 END) AS subagent_count
FROM sessions
WHERE chain_id != ''
  AND (?cwd? OR ?all?)
  AND (?range?)
GROUP BY chain_id
ORDER BY chain_last_activity DESC
LIMIT ?
```

After GROUP BY, drop the null entries from the `json_group_array` results (SQLite outputs `[null,"id",...]`). In TypeScript:

```ts
const mainIds = (JSON.parse(row.main_session_ids_raw) as Array<string | null>).filter(Boolean) as string[]
```

For `insights_count` per chain, prefer a second query rather than joining (joining inflates the GROUP BY):

```ts
SELECT s.chain_id, COUNT(i.id) AS cnt
FROM sessions s
LEFT JOIN insights i ON i.session_id = s.session_id
WHERE s.is_subagent = 0 AND s.chain_id IN (?, ?, ...)
GROUP BY s.chain_id
```

JSON output shape (matches the test assertion):

```ts
interface ChainSummary {
  chain_id: string
  main_session_ids: string[]
  subagent_session_ids: string[]
  sessions_count: number           // main count (default; widen if --include-subagents)
  representative_session_id: string
  insights_count: number
  user_prompts_count?: number
  matched_insights_count?: number  // only when --grep is active
  chain_started_at: string
  chain_last_activity: string
  cwd: string                      // any main session's cwd (they all share it)
}
```

**Step 4: Run smoke** → green.

**Step 5: Commit**

```bash
git add scripts/read-insights.ts scripts/verify-smoke.ts
git commit -m "feat(chain): insights --list --chain returns chain-aggregated rows"
```

---

### Task 4.3: `--list --chain --grep` filters by chain content

**Files:**
- Modify: `scripts/read-insights.ts` (extend `listChains` to apply `--grep`)
- Modify: `scripts/verify-smoke.ts`

**Step 1: Write the failing test**

```ts
function verifyInsightsListChainGrep(tempRoot: string) {
  // Fixture: chain X has insights "foo bar" in main session, chain Y doesn't.
  // Run: insights --list --chain --grep "foo bar" --all
  // Expect: only chain X returned, matched_insights_count = 1.
  // ... follow the pattern of verifyInsightsGrepList ...
}
```

**Step 2: Run smoke** → fail.

**Step 3: Implement**

A chain matches if **any main-zone insight** matches the grep. Two-step query:

1. Find chain_ids whose main-zone insights match: `SELECT DISTINCT s.chain_id FROM sessions s JOIN insights i ON i.session_id = s.session_id WHERE s.is_subagent = 0 AND i.content REGEXP ?`. (better-sqlite3 doesn't have REGEXP by default — register a function via `db.function('regexp', ...)` once, as the existing grep path likely already does. If not, fall back to `i.content LIKE ?` with simple search; check what `read-insights.ts` currently uses around line 100.)
2. Filter the chain list to that set, and compute `matched_insights_count` per chain.

**Step 4: Run smoke** → green.

**Step 5: Commit**

```bash
git add scripts/read-insights.ts scripts/verify-smoke.ts
git commit -m "feat(chain): --list --chain honors --grep over main-zone insights"
```

---

### Task 4.4: `--list --chain` honors `--cwd`, `--range`, `--since/--until`, `--limit`

**Files:**
- Modify: `scripts/read-insights.ts`
- Modify: `scripts/verify-smoke.ts`

**Step 1: Test**

Add `verifyInsightsListChainScopes(tempRoot)` covering: default = current cwd; `--all`; `--range week`; `--limit 1` returns 1 chain.

**Step 2-5: Implement / run / commit**

Re-use existing helper functions `buildSessionActivityRangePredicate`, `buildSessionRangeChangedAtExpression`, `normalizeCwdArg` (see `read-insights.ts:253-360`). Inject them into the chain query's WHERE clause.

Commit message:

```
feat(chain): --list --chain honors cwd, range, limit filters
```

---

## Stage 5 — `insights --chain <id>` (read one chain)

### Task 5.1: Read insights for a single chain

**Files:**
- Modify: `scripts/read-insights.ts`
- Modify: `scripts/verify-smoke.ts`

**Step 1: Write the failing test**

```ts
function verifyInsightsReadChain(tempRoot: string) {
  // Fixture: chain_test01 with three main sessions and one subagent.
  // Insights span 2026-05-09 to 2026-05-11.
  // Run: insights --chain chain_test01 --json
  // Expect:
  //   - JSON envelope { chain: { chain_id, main_session_ids, ... }, insights: [...] }
  //   - insights array contains all main-zone insights, sorted by timestamp DESC
  //   - subagent insights NOT included (default)
  //   - With --include-subagents, subagent insights appear, tagged source_session_id
}
```

**Step 2: Run smoke** → fail.

**Step 3: Implement**

When `args.chainId` is set:

1. `SELECT * FROM sessions WHERE chain_id = ? ORDER BY created_at ASC` → split into main / subagent arrays.
2. Compute `representative_session_id = last main session`.
3. Fetch insights from main sessions (or main + subagent if `--include-subagents`), apply `--limit`, `--offset`, `--grep`, `--range` exactly like the current single-session path.
4. Output the existing per-insight shape (id, content, timestamp, source, source_session) wrapped in a chain envelope:

```ts
{
  chain: {
    chain_id,
    main_session_ids,
    subagent_session_ids,
    representative_session_id,
    sessions_count: main count,
    chain_started_at,
    chain_last_activity,
  },
  insights: [...],
  user_prompts: [...],
}
```

Reuse the existing `printInsights` text output, just with a different header showing `Chain: chain_xxxxxxxx` and `Sessions: N (+M subagents)`.

**Step 4: Run smoke** → green.

**Step 5: Commit**

```bash
git add scripts/read-insights.ts scripts/verify-smoke.ts
git commit -m "feat(chain): insights --chain <id> reads aggregated chain content"
```

---

### Task 5.2: `--session <id> --chain` shortcut

**Files:**
- Modify: `scripts/read-insights.ts`
- Modify: `scripts/verify-smoke.ts`

**Step 1: Test**

Verify that `insights --session <session-prefix> --chain --json` looks up the session's `chain_id` and returns the same envelope as `insights --chain <id>`.

**Step 2-5: Implement / commit**

Resolve session → chain_id with `SELECT chain_id FROM sessions WHERE session_id = ? OR session_id LIKE ?`, then dispatch to the chain read path from Task 5.1. Error if `chain_id == ''` (legacy row not yet repaired) and tell the user to run `repair --rebuild-chains`.

Commit message:

```
feat(chain): --session ... --chain resolves to chain id and reads chain
```

---

## Stage 6 — `export --chain`

### Task 6.1: Export by chain id (mode = conversation / insights)

**Files:**
- Modify: `server/services/session-export.ts` — add `resolveSessionsByChain()`
- Modify: `scripts/export-session.ts` — accept `--chain <id>`
- Modify: `scripts/verify-smoke.ts`

**Step 1: Test**

```ts
function verifyExportChain(tempRoot: string) {
  // Build a 2-session chain with real transcript files (mirror verifySessionExport
  // at line 735). Run:
  //   export --chain chain_xxxx --mode conversation
  //   export --chain chain_xxxx --mode insights
  // Expect:
  //   - Output header includes Chain ID and session count
  //   - Conversation mode concatenates both sessions in chronological order
  //   - Insights mode aggregates main-zone insights
}
```

**Step 2: Run smoke** → fail.

**Step 3: Implement**

3a. In `server/services/session-export.ts`, add:

```ts
export function resolveSessionsByChain(
  db: Database.Database,
  chainId: string,
  options: { includeSubagents?: boolean } = {}
): ExportSession[] | SessionExportFailure {
  const rows = db.prepare(`
    SELECT session_id, cwd, transcript_path, state, last_activity, created_at,
           alias, pinned, source, predecessor_id, is_subagent
    FROM sessions
    WHERE chain_id = ? AND (? OR is_subagent = 0)
    ORDER BY created_at ASC
  `).all(chainId, options.includeSubagents ? 1 : 0) as Array<SessionRow & { is_subagent: number }>

  if (rows.length === 0) {
    return { error: 'session_not_found', message: `Chain "${chainId}" has no sessions.` }
  }
  return rows.map(normalizeSession)
}
```

3b. In `exportSessionText()`, accept either `{ sessionId, depth }` (legacy) or `{ chainId, includeSubagents }`. Re-use the existing formatting once you have the `ExportSession[]` list — `resolveSessionChain` was already returning one.

3c. In `scripts/export-session.ts` parse `--chain <chain_id>` and `--include-subagents`. Validate with `isChainId`. Mutually exclusive with `--session`.

3d. Update the export header to include `Chain ID: chain_xxxxxxxx` and `Sessions: N main + M subagents`.

**Step 4: Run smoke** → green.

**Step 5: Commit**

```bash
git add server/services/session-export.ts scripts/export-session.ts scripts/verify-smoke.ts
git commit -m "feat(chain): export --chain <id> exports the full chain"
```

---

### Task 6.2: `export --chain` honors `--range / --since / --until`

**Files:** same as 6.1.

**Step 1: Test** — add a range-filtered fixture; assert only records within the range are exported.

**Step 2-5:** Re-use `range` argument already supported by `exportSessionText()`. No new logic; just pass through.

Commit:

```
feat(chain): export --chain honors range filters
```

---

## Stage 7 — `records cut --chain`

### Task 7.1: Cut a range that spans main-zone sessions in a chain

**Files:**
- Modify: `scripts/cut-records.ts`
- Possibly: `server/services/session-export.ts` (helper to read transcripts for a chain)
- Modify: `scripts/verify-smoke.ts`

**Step 1: Test**

```ts
function verifyRecordsCutChain(tempRoot: string) {
  // Two main sessions A, B in the same chain.
  // A's transcript has user "cut start anchor" early.
  // B's transcript has user "cut end anchor" late.
  // Run:
  //   records cut --chain chain_xxxx --from "cut start anchor" --to "cut end anchor"
  // Expect:
  //   - Output file contains both A's tail (from anchor) and B's head (to anchor)
  //   - Records appear in chronological order by timestamp
  //   - Subagent transcripts NOT included
}
```

**Step 2: Run smoke** → fail.

**Step 3: Implement**

3a. In `cut-records.ts`, accept `--chain <id>` (mutually exclusive with `--session`).

3b. Replace single-session loading with chain loading:

```ts
const sessions = resolveSessionsByChain(db, chainId, { includeSubagents: false })
if ('error' in sessions) { printFailure(sessions); process.exit(1) }

// Read each transcript, concatenate while preserving session boundaries.
const allRecords: Array<SessionTranscriptRecord & { session_id: string }> = []
for (const s of sessions) {
  const t = readSessionTranscriptRecords(s)
  if (!t.ok) { printFailure(t.error); process.exit(1) }
  for (const r of t.records) allRecords.push({ ...r, session_id: s.session_id })
}
allRecords.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
```

3c. Run `findUniqueRange()` on `allRecords`. The existing function works unchanged because it only cares about `text` and `index`.

3d. Update `formatSegment` for chain mode: replace `session: ...` with `chain: chain_xxxxxxxx`, list the spanning sessions in a single header line.

3e. Default output path becomes `.session-dashboard/records/<timestamp>-<chain-prefix>.md`.

**Step 4: Run smoke** → green.

**Step 5: Commit**

```bash
git add scripts/cut-records.ts server/services/session-export.ts scripts/verify-smoke.ts
git commit -m "feat(chain): records cut --chain cuts across main-zone sessions"
```

---

## Stage 8 — CLI help and docs

### Task 8.1: Update help strings

**Files:**
- Modify: `scripts/read-insights.ts:61-130` (HELP const)
- Modify: `scripts/export-session.ts` (HELP)
- Modify: `scripts/cut-records.ts:21-41` (HELP)
- Modify: `bin/cli.ts:31-63` (top-level HELP)
- Modify: `shared/insight-usage.ts` (manual injected into CLAUDE.md by `init`)

**Step 1: No test** — help text is reviewed visually. But touch it because Stage 9's smoke test asserts on substrings in help.

**Step 2: Edit each HELP block** to mention:

- `--chain` (list mode) — Group sessions into chain rows
- `--chain <id>` — Read / export / cut a specific chain
- `--include-subagents` — Include subagent区 in chain operations
- `chain_xxxxxxxx` format note

**Step 3: Build**

```bash
npm run build
```

**Step 4: Commit**

```bash
git add scripts/read-insights.ts scripts/export-session.ts scripts/cut-records.ts bin/cli.ts shared/insight-usage.ts
git commit -m "docs(chain): update CLI help with --chain options"
```

---

### Task 8.2: Smoke assertions on help output

**Files:**
- Modify: `scripts/verify-smoke.ts` — extend `verifyRuntimeDefaults` or add a sibling

**Step 1: Test**

Assert that `node lib/cli.js insights --help` mentions both `--chain` and `--include-subagents`, and that `node lib/cli.js export --help` and `records cut --help` likewise.

**Step 2-5:** trivial.

Commit:

```
test(chain): smoke asserts --chain option appears in help
```

---

## Stage 9 — Final integration check

### Task 9.1: Full smoke run on a freshly built lib

**Files:** none.

**Step 1: Clean build**

```bash
rm -rf lib dist
npm run build
```

Expected: success.

**Step 2: Full smoke**

```bash
npm run verify:smoke
```

Expected:
- All `verify: ...` lines including every new `verify: chain ...` and `verify: insights --list --chain` etc. lines.
- Final line `verify: smoke checks passed`.

**Step 3:** If anything fails, fix in the affected stage's commit (use `git commit --amend` only if the failing commit is the most recent local commit and has NOT been pushed; otherwise create a NEW commit per the user's git rules).

**No commit** unless fixes were needed.

---

### Task 9.2: Dogfood — exercise the new commands against the live db

**Files:** none.

**Step 1:** Make sure the dashboard server is running (or start it briefly):

```bash
session-dashboard status
```

If not running:

```bash
session-dashboard start
```

**Step 2:** Backfill chain ids on the real DB:

```bash
node scripts/repair-dashboard.js --days 90
```

Expected JSON summary line includes `chainIdsAssigned: <n>` with n > 0.

**Step 3:** Verify the new list mode:

```bash
node lib/cli.js insights --list --chain --limit 5
```

Expected: table or JSON with chain rows, each showing chain_id, main_session_count, last_activity.

**Step 4:** Pick one chain id from step 3, read it:

```bash
node lib/cli.js insights --chain chain_xxxxxxxx --limit 10
```

Expected: insights from all main-zone sessions in that chain, sorted newest first.

**Step 5:** Sanity-check subagent exclusion:

```bash
node lib/cli.js insights --chain chain_xxxxxxxx --include-subagents --limit 10
```

Expected: more insights than step 4 if the chain has subagents; otherwise identical output.

**No commit** — dogfood is read-only verification.

---

## Stage 10 — Optional: PR

Use @superpowers:finishing-a-development-branch when ready to merge.

---

## Critical reminders for the executor

1. **Never** put a `Co-Authored-By` line in commit messages (project rule, breaks CI).
2. **Never** force-push. **Never** `git push` automatically — leave that to the user.
3. The chain_id field is **immutable** by design. Write paths only assign once. Updates are reserved for `repair --rebuild-chains`.
4. Every new query that operates on chains MUST default to `is_subagent = 0` (main 区). Subagent inclusion is opt-in.
5. When `chain_id == ''` is encountered at read time (legacy data), treat it as "no chain known, fall back to single-session behavior" and surface a one-line hint pointing to `repair --rebuild-chains`. Do NOT silently invent a chain id at read time.
6. The smoke test order matters when fixtures share temp paths. New `verifyChainXxx(tempRoot)` functions must use unique subdirectories under `tempRoot` (see how `verifyInsightsCwdList` does `join(tempRoot, 'cwd-list-home')`).
7. Re-verify the line-number anchors in this plan with `grep -n` before editing — branch drift can shift them.
8. If TypeScript errors after `import { isChainId } from '../shared/chain-id.js'`, run `npm run build` standalone first and read the message — most likely an ESM extension issue (the project uses `.js` extensions in imports for tsx + bundle compatibility).
