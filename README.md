# Session Dashboard

A real-time observation dashboard for multiple Claude Code sessions. Each session occupies a dedicated column displaying its current state and insights in reverse chronological order, with local event persistence so the view survives page refreshes and runtime restarts.

![Session Dashboard](https://img.shields.io/badge/stack-Vue%203%20%2B%20Node.js-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)

## Features

- **Multi-column kanban view** — each Claude Code session gets its own column
- **5 session states** — Active, Waiting Permission, Waiting User, Idle, Ended
- **Real-time updates** — WebSocket push; reconnects automatically
- **Dual insight sources** — Claude Code hooks events + incremental transcript parsing
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
- Claude Code with hooks support
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
npx tsx server/index.ts
```

The server starts on port **3210** by default. Open `http://localhost:3210` in your browser.

### 4. Wire up Claude Code hooks

```bash
npm run setup:hooks
```

This installs the required hooks into `~/.claude/settings.json`. The script is **idempotent** — safe to run multiple times. Existing hooks are preserved; a `.bak` backup is created before any changes.

**Restart Claude Code** after running `setup:hooks` for the changes to take effect.

> The dashboard will show a `Hooks 8/8` badge in the top-right corner once all hooks are detected.

## Development

Start the backend and frontend in watch mode simultaneously:

```bash
npm run dev
```

- Frontend dev server: `http://localhost:5173` (Vite HMR)
- Backend: `http://localhost:3210` (tsx watch)

Simulate sessions without a real Claude Code instance:

```bash
npx tsx server/index.ts &   # start runtime first
bash scripts/dev-simulate.sh  # create 5 sessions in various states
```

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `SESSION_DASHBOARD_URL` | `http://localhost:3210` | Override the URL the hook script posts to |

To change the default port, edit `SERVER_PORT` in `shared/types.ts`.

## How It Works

```
Claude Code session
      │
      │  hooks (SessionStart, PreToolUse, etc.)
      ▼
hook script (hooks/session-hook.sh)
      │  POST /api/events
      ▼
Express runtime (server/)
      ├── SQLite  ─────────────────── persist events & insights
      ├── TranscriptWatcher ───────── watch ~/.claude/projects/**/*.jsonl
      │       └── extract ★ Insight blocks (or fallback paragraphs)
      └── WebSocket broadcast
              │
              ▼
        Vue 3 dashboard (browser)
```

**Insight extraction** uses a two-tier strategy:
1. Regex match for `` `★ Insight ───` `` blocks (Claude Code explanatory mode)
2. Fallback to text paragraphs longer than 150 characters

MD5 hashing prevents duplicate insights across incremental file reads.

## Session States

| State | Trigger |
|---|---|
| `Active` | Tool executing, subagent running, or recent progress |
| `Waiting Permission` | `PermissionRequest` / `Notification(permission_prompt)` |
| `Waiting User` | `Notification(elicitation_dialog \| idle_prompt)` |
| `Idle` | No real progress for 3 minutes (configurable via `IDLE_THRESHOLD_MS`) |
| `Ended` | `SessionEnd` — terminal, never transitions back |

Column sort order: **Waiting Permission → Waiting User → Active → Idle → Ended**

## Project Structure

```
session-dashboard/
├── hooks/
│   └── session-hook.sh       # Claude Code hook script
├── scripts/
│   ├── setup-hooks.ts        # Hook installer (npm run setup:hooks)
│   └── dev-simulate.sh       # Simulation script for development
├── server/
│   ├── db.ts                 # SQLite init
│   ├── index.ts              # Express + HTTP + WebSocket entry
│   ├── routes/
│   │   ├── events.ts         # POST /api/events, GET /api/sessions
│   │   └── hooks.ts          # GET /api/hooks/status
│   ├── services/
│   │   ├── session-manager.ts   # State machine + insight management
│   │   └── transcript-watcher.ts # Incremental JSONL parsing
│   └── ws.ts                 # WebSocket server
├── shared/
│   └── types.ts              # Shared TypeScript types
└── src/                      # Vue 3 frontend
    ├── components/
    │   ├── TopBar.vue
    │   ├── StatsBar.vue
    │   ├── SessionBoard.vue
    │   ├── SessionColumn.vue
    │   ├── DetailPanel.vue
    │   └── HooksStatus.vue
    ├── stores/
    │   └── session.ts        # Pinia store + WebSocket client
    └── utils/
        └── time.ts           # Relative time formatting
```

## License

MIT
