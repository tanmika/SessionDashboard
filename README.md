**Languages:** English | [简体中文](README.zh-CN.md)

---

# Session Dashboard

A real-time observation dashboard for **Claude Code** and **Codex CLI** sessions. Each session occupies a dedicated column displaying its current state and insights in reverse chronological order, with local event persistence so the view survives page refreshes and runtime restarts.

![Session Dashboard](https://img.shields.io/badge/stack-Vue%203%20%2B%20Node.js-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)

## Features

- **Multi-tool support** — monitors both Claude Code (via HTTP hooks) and Codex CLI (via filesystem watching) on a unified board
- **Session Watchlist** — manually pin sessions to the board; only pinned sessions appear as columns (persisted across restarts, synced in real-time across browser tabs)
- **Session Alias** — give any session a custom name for persistent identification; inline edit on the column header or in the detail panel; alias overrides the auto-generated `basename · id` name
- **Multi-column kanban view** — each pinned session gets its own column
- **6 session states** — Active, Waiting Permission, Waiting User, Inactive, Idle, Ended
- **Source badge** — each column displays a Claude (blue) or Codex (green) badge
- **Real-time updates** — WebSocket push; reconnects automatically
- **Dual insight sources** — Claude Code hooks events + incremental transcript / rollout parsing
- **Persistent storage** — SQLite (WAL mode); survives page close, refresh, and runtime restart
- **Smart column sorting** — blocking sessions (waiting) float to the front automatically
- **Selected-column freeze** — column order locks while a detail panel is open
- **Hook setup & status** — one-command installer + live badge showing whether all hooks are wired

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vue 3, Pinia, TypeScript, Vite |
| Backend | Node.js, Express 5, ws |
| Database | SQLite via better-sqlite3 (WAL mode) |

## Prerequisites

- Node.js ≥ 18
- Claude Code with hooks support (for Claude Code monitoring)
- Codex CLI (for Codex monitoring; optional — dashboard works without it)
- `jq` (optional, but recommended — used by the hook script to strip large payloads)

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Build the frontend

```bash
npm run build
```

### 3. Start the runtime

```bash
npm run build
node lib/cli.js init
```

The init command installs hooks and registers a macOS background service. The server starts on port **38473** by default. Open `http://localhost:38473` in your browser.

### 4. Wire up Claude Code hooks

```bash
npm run setup:hooks
```

This installs the required hooks into `~/.claude/settings.json`. The script is **idempotent** — safe to run multiple times. Existing hooks are preserved; a `.bak` backup is created before any changes.

**Restart Claude Code** after running `setup:hooks` for the changes to take effect.

> The dashboard will show a `Hooks 8/8` badge in the top-right corner once all hooks are detected.

### 5. Set up Codex CLI insight injection (optional)

```bash
npm run setup:codex
```

This injects `★ Insight` output-style instructions into `~/.codex/AGENTS.md` so that Codex CLI sessions produce structured insight blocks the dashboard can parse. The script is **idempotent** — uses `<---session-dashboard-insight--->` marker tags for dedup and in-place update.

> If `~/.codex/sessions/` does not exist, the dashboard silently skips Codex monitoring — no errors.

## Development

Start the backend and frontend in watch mode simultaneously:

```bash
npm run dev
```

- Frontend dev server: `http://localhost:5173` (Vite HMR)
- Backend: `http://localhost:38473` (tsx watch)

Simulate sessions without a real Claude Code instance:

```bash
npx tsx server/index.ts &   # start runtime first
bash scripts/dev-simulate.sh  # create 5 sessions in various states
```

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `SESSION_DASHBOARD_PORT` | `38473` | Server port |
| `SESSION_DASHBOARD_URL` | `http://localhost:38473` | Override the URL the hook script posts to |

To change the default port, set `SESSION_DASHBOARD_PORT` for the server and `SESSION_DASHBOARD_URL` for hooks.

```bash
SESSION_DASHBOARD_PORT=4000 SESSION_DASHBOARD_URL=http://localhost:4000 node lib/cli.js install-service
```

## How It Works

```
Claude Code session                Codex CLI session
      │                                   │
      │  hooks (HTTP POST)                │  fs.watch (rollout JSONL)
      ▼                                   ▼
hook script                         CodexWatcher
(hooks/session-hook.sh)             (server/services/codex-watcher.ts)
      │  POST /api/events                 │  callbacks
      ▼                                   ▼
              SessionManager (server/services/session-manager.ts)
                ├── SQLite  ─────────────────── persist events & insights
                ├── TranscriptWatcher ───────── watch Claude transcript JSONL
                ├── CodexWatcher ────────────── watch ~/.codex/sessions/ rollouts
                │       └── shared insight-extractor (★ Insight blocks only)
                └── WebSocket broadcast
                        │
                        ▼
                  Vue 3 dashboard (browser)
```

**Architecture difference:**
- **Claude Code** = active push (hooks → HTTP POST → server)
- **Codex CLI** = passive discovery (fs.watch rollout directory → incremental JSONL parsing)

**Insight extraction** only persists explicit `★ Insight` blocks (shared by both sources).
1. Regex match for `` `★ Insight ───` `` blocks (explanatory mode)

MD5 hashing prevents duplicate insights across incremental file reads.

## Session States

| State | Trigger | Source |
|---|---|---|
| `Active` | Tool executing, subagent running, or recent progress | Both |
| `Waiting Permission` | `PermissionRequest` / `Notification(permission_prompt)` | Claude only |
| `Waiting User` | `Notification(elicitation_dialog \| idle_prompt)` | Claude only |
| `Inactive` | `task_complete` — turn finished, awaiting next user input | Codex only |
| `Idle` | No progress for 3 min (`IDLE_THRESHOLD_MS`) | Both |
| `Ended` | `SessionEnd` (Claude) or idle 30 min (`CODEX_ENDED_THRESHOLD_MS`, Codex) | Both |

Column sort order: **Waiting Permission → Waiting User → Active → Inactive → Idle → Ended**

## Project Structure

```
session-dashboard/
├── hooks/
│   └── session-hook.sh       # Claude Code hook script
├── scripts/
│   ├── setup-hooks.ts        # Hook installer (npm run setup:hooks)
│   ├── setup-codex.ts        # Codex insight injection (npm run setup:codex)
│   └── dev-simulate.sh       # Simulation script for development
├── server/
│   ├── db.ts                 # SQLite init + safe column migrations
│   ├── index.ts              # Express + HTTP + WebSocket entry
│   ├── routes/
│   │   ├── events.ts         # POST /api/events, GET/PATCH /api/sessions
│   │   └── hooks.ts          # GET /api/hooks/status
│   ├── services/
│   │   ├── session-manager.ts    # State machine + insight + pin/alias management
│   │   ├── transcript-watcher.ts # Claude transcript incremental JSONL parsing
│   │   └── codex-watcher.ts      # Codex rollout directory monitoring + JSONL parsing
│   ├── utils/
│   │   └── insight-extractor.ts  # Shared insight extraction (★ blocks only)
│   └── ws.ts                 # WebSocket server
├── shared/
│   └── types.ts              # Shared TypeScript types
└── src/                      # Vue 3 frontend
    ├── components/
    │   ├── TopBar.vue
    │   ├── StatsBar.vue
    │   ├── SessionBoard.vue
    │   ├── SessionColumn.vue      # Inline alias editing + source badge
    │   ├── SessionPicker.vue      # Watchlist management panel (pin/unpin)
    │   ├── DetailPanel.vue        # Session detail + alias edit + collapsible timelines
    │   └── HooksStatus.vue
    ├── stores/
    │   └── session.ts        # Pinia store + WebSocket client
    └── utils/
        ├── time.ts           # Relative time formatting
        └── markdown.ts       # Markdown rendering (marked + DOMPurify)
```

## API Reference

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/events` | Receive hook events from Claude Code |
| `GET` | `/api/sessions` | List all sessions |
| `GET` | `/api/sessions/:id` | Get single session |
| `GET` | `/api/sessions/:id/events` | Get event timeline |
| `PATCH` | `/api/sessions/:id/pin` | `{ pinned: boolean }` — pin/unpin to watchlist |
| `PATCH` | `/api/sessions/:id/alias` | `{ alias: string }` — set or clear custom name |

## License

MIT
