**语言：** [English](README.md) | 简体中文

---

# Session Dashboard

**Claude Code** 与 **Codex CLI** 多会话实时观察看板。每个 session 独占一列，以倒序展示当前状态与 Insight，本地事件持久化保证页面刷新和运行时重启后数据不丢失。

![Session Dashboard](https://img.shields.io/badge/stack-Vue%203%20%2B%20Node.js-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)

## 功能特性

- **多工具支持** — 统一看板同时监控 Claude Code（HTTP hooks 主动推送）和 Codex CLI（文件系统被动发现）
- **会话看板（Watchlist）** — 手动将感兴趣的 session 加入看板，只有已 pin 的 session 才显示为列；持久化到 SQLite，重启不丢，多 tab 实时同步
- **会话别名（Alias）** — 为任意 session 设置自定义名称，方便长期识别；在列头悬浮铅笔图标或详情面板中行内编辑；别名优先于自动生成的 `basename · id` 名称
- **多列看板视图** — 每个已 pin 的 session 独占一列
- **6 种会话状态** — Active、Waiting Permission、Waiting User、Inactive、Idle、Ended
- **来源标记** — 每列显示 Claude（蓝色）或 Codex（绿色）来源徽章
- **实时更新** — WebSocket 推送，自动重连
- **双 Insight 来源** — Claude Code hooks 事件 + 增量 transcript / rollout 解析
- **持久化存储** — SQLite（WAL 模式），页面关闭、刷新、运行时重启后数据均保留
- **智能列排序** — 阻塞中的 session（等待状态）自动浮到最前
- **选中列冻结** — 打开详情面板时列顺序锁定，不会突然重排
- **Hook 配置与状态** — 一键安装脚本 + 实时徽章显示 hook 是否全部接入

## 技术栈

| 层级 | 技术 |
|---|---|
| 前端 | Vue 3、Pinia、TypeScript、Vite |
| 后端 | Node.js、Express 5、ws |
| 数据库 | SQLite（via better-sqlite3，WAL 模式）|

## 环境要求

- Node.js ≥ 18
- 支持 hooks 的 Claude Code（用于 Claude Code 监控）
- Codex CLI（用于 Codex 监控；可选 — 没有也不影响其他功能）
- `jq`（可选，但推荐 — hook 脚本用它裁剪大体积 payload）

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 构建前端

```bash
npm run build
```

### 3. 启动运行时

```bash
npx tsx server/index.ts
```

服务默认监听 **3210** 端口。在浏览器中打开 `http://localhost:3210`。

### 4. 配置 Claude Code Hooks

```bash
npm run setup:hooks
```

该命令会将所需 hooks 写入 `~/.claude/settings.json`。脚本**幂等**，可重复执行。已有 hook 不会被覆盖；写入前会自动备份原文件（`.bak`）。

运行 `setup:hooks` 后，**重启 Claude Code** 使配置生效。

> 所有 hook 接入后，看板右上角将显示 `Hooks 8/8` 徽章。

### 5. 配置 Codex CLI Insight 注入（可选）

```bash
npm run setup:codex
```

该命令将 `★ Insight` 输出格式指令注入到 `~/.codex/AGENTS.md`，使 Codex CLI 会话产出可被看板解析的结构化 Insight 块。脚本**幂等** — 使用 `<---session-dashboard-insight--->` 标记实现去重和原地更新。

> 如果 `~/.codex/sessions/` 目录不存在，看板会静默跳过 Codex 监控，不会报错。

## 开发

同时以监听模式启动后端与前端：

```bash
npm run dev
```

- 前端开发服务器：`http://localhost:5173`（Vite HMR）
- 后端：`http://localhost:3210`（tsx watch）

无需真实 Claude Code 实例，可通过模拟脚本生成测试数据：

```bash
npx tsx server/index.ts &   # 先启动运行时
bash scripts/dev-simulate.sh  # 创建 5 个不同状态的会话
```

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `SESSION_DASHBOARD_URL` | `http://localhost:3210` | 覆盖 hook 脚本 POST 的目标地址 |

如需修改默认端口，编辑 `shared/types.ts` 中的 `SERVER_PORT`。

## 工作原理

```
Claude Code 会话                    Codex CLI 会话
      │                                   │
      │  hooks（HTTP POST 主动推送）        │  fs.watch（rollout JSONL 被动监控）
      ▼                                   ▼
hook 脚本                            CodexWatcher
(hooks/session-hook.sh)             (server/services/codex-watcher.ts)
      │  POST /api/events                 │  callbacks
      ▼                                   ▼
              SessionManager (server/services/session-manager.ts)
                ├── SQLite  ─────────────────── 持久化事件与 Insight
                ├── TranscriptWatcher ───────── 监听 Claude transcript JSONL
                ├── CodexWatcher ────────────── 监听 ~/.codex/sessions/ rollout
                │       └── 共享 insight-extractor（仅 ★ Insight 块）
                └── WebSocket 广播
                        │
                        ▼
                  Vue 3 看板（浏览器）
```

**架构差异：**
- **Claude Code** = 主动推送（hooks → HTTP POST → server）
- **Codex CLI** = 被动发现（fs.watch rollout 目录 → 增量 JSONL 解析）

**Insight 提取**仅持久化显式 `★ Insight` 块（双来源共享）：
1. 正则匹配 `` `★ Insight ───` `` 块（解释性模式）

使用 MD5 哈希去重，避免增量读取时产生重复 Insight。

## 会话状态

| 状态 | 触发条件 | 来源 |
|---|---|---|
| `Active` | 工具执行中、子代理运行中，或有近期进展 | 两者 |
| `Waiting Permission` | `PermissionRequest` / `Notification(permission_prompt)` | 仅 Claude |
| `Waiting User` | `Notification(elicitation_dialog \| idle_prompt)` | 仅 Claude |
| `Inactive` | `task_complete` — turn 完成，等待下一轮用户输入 | 仅 Codex |
| `Idle` | 超过 3 分钟无实质进展（`IDLE_THRESHOLD_MS`）| 两者 |
| `Ended` | `SessionEnd`（Claude）或空闲 30 分钟（`CODEX_ENDED_THRESHOLD_MS`，Codex）| 两者 |

列排序优先级：**Waiting Permission → Waiting User → Active → Inactive → Idle → Ended**

## 项目结构

```
session-dashboard/
├── hooks/
│   └── session-hook.sh       # Claude Code hook 脚本
├── scripts/
│   ├── setup-hooks.ts        # Hook 安装器（npm run setup:hooks）
│   ├── setup-codex.ts        # Codex Insight 注入（npm run setup:codex）
│   └── dev-simulate.sh       # 开发用模拟脚本
├── server/
│   ├── db.ts                 # SQLite 初始化 + 安全列迁移
│   ├── index.ts              # Express + HTTP + WebSocket 入口
│   ├── routes/
│   │   ├── events.ts         # POST /api/events, GET/PATCH /api/sessions
│   │   └── hooks.ts          # GET /api/hooks/status
│   ├── services/
│   │   ├── session-manager.ts    # 状态机 + Insight / pin / alias 管理
│   │   ├── transcript-watcher.ts # Claude transcript 增量 JSONL 解析
│   │   └── codex-watcher.ts      # Codex rollout 目录监控 + JSONL 解析
│   ├── utils/
│   │   └── insight-extractor.ts  # 共享 Insight 提取（仅 ★ 块）
│   └── ws.ts                 # WebSocket 服务器
├── shared/
│   └── types.ts              # 共享 TypeScript 类型
└── src/                      # Vue 3 前端
    ├── components/
    │   ├── TopBar.vue
    │   ├── StatsBar.vue
    │   ├── SessionBoard.vue
    │   ├── SessionColumn.vue      # 行内别名编辑 + 来源徽章
    │   ├── SessionPicker.vue      # 看板管理面板（pin/unpin）
    │   ├── DetailPanel.vue        # 详情 + 别名编辑 + 可折叠时间线
    │   └── HooksStatus.vue
    ├── stores/
    │   └── session.ts        # Pinia store + WebSocket 客户端
    └── utils/
        ├── time.ts           # 相对时间格式化
        └── markdown.ts       # Markdown 渲染（marked + DOMPurify）
```

## API 参考

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/events` | 接收 Claude Code hook 事件 |
| `GET` | `/api/sessions` | 获取所有 session |
| `GET` | `/api/sessions/:id` | 获取单个 session |
| `GET` | `/api/sessions/:id/events` | 获取事件时间线 |
| `PATCH` | `/api/sessions/:id/pin` | `{ pinned: boolean }` — 加入/移出看板 |
| `PATCH` | `/api/sessions/:id/alias` | `{ alias: string }` — 设置或清除自定义别名 |

## 许可证

MIT
