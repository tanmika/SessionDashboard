**语言：** [English](README.md) | 简体中文

---

# Session Dashboard

多 Claude Code 会话的实时观察看板。每个 session 独占一列，以倒序展示当前状态与 Insight，本地事件持久化保证页面刷新和运行时重启后数据不丢失。

![Session Dashboard](https://img.shields.io/badge/stack-Vue%203%20%2B%20Node.js-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)

## 功能特性

- **多列看板视图** — 每个 Claude Code session 独占一列
- **5 种会话状态** — Active、Waiting Permission、Waiting User、Idle、Ended
- **实时更新** — WebSocket 推送，自动重连
- **双 Insight 来源** — Claude Code hooks 事件 + 增量 transcript 解析
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
- 支持 hooks 的 Claude Code
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
Claude Code session
      │
      │  hooks（SessionStart、PreToolUse 等）
      ▼
hook 脚本（hooks/session-hook.sh）
      │  POST /api/events
      ▼
Express 运行时（server/）
      ├── SQLite  ─────────────────── 持久化事件与 Insight
      ├── TranscriptWatcher ───────── 监听 ~/.claude/projects/**/*.jsonl
      │       └── 提取 ★ Insight 块（或回退到长段落）
      └── WebSocket 广播
              │
              ▼
        Vue 3 看板（浏览器）
```

**Insight 提取**采用两级策略：
1. 正则匹配 `` `★ Insight ───` `` 块（Claude Code 解释性模式）
2. 回退：提取长度超过 150 字符的文本段落

使用 MD5 哈希去重，避免增量读取时产生重复 Insight。

## 会话状态

| 状态 | 触发条件 |
|---|---|
| `Active` | 工具执行中、子代理运行中，或有近期进展 |
| `Waiting Permission` | `PermissionRequest` / `Notification(permission_prompt)` |
| `Waiting User` | `Notification(elicitation_dialog \| idle_prompt)` |
| `Idle` | 超过 3 分钟无实质进展（可通过 `IDLE_THRESHOLD_MS` 配置）|
| `Ended` | `SessionEnd` — 终态，不可逆 |

列排序优先级：**Waiting Permission → Waiting User → Active → Idle → Ended**

## 项目结构

```
session-dashboard/
├── hooks/
│   └── session-hook.sh       # Claude Code hook 脚本
├── scripts/
│   ├── setup-hooks.ts        # Hook 安装器（npm run setup:hooks）
│   └── dev-simulate.sh       # 开发用模拟脚本
├── server/
│   ├── db.ts                 # SQLite 初始化
│   ├── index.ts              # Express + HTTP + WebSocket 入口
│   ├── routes/
│   │   ├── events.ts         # POST /api/events, GET /api/sessions
│   │   └── hooks.ts          # GET /api/hooks/status
│   ├── services/
│   │   ├── session-manager.ts   # 状态机 + Insight 管理
│   │   └── transcript-watcher.ts # 增量 JSONL 解析
│   └── ws.ts                 # WebSocket 服务器
├── shared/
│   └── types.ts              # 共享 TypeScript 类型
└── src/                      # Vue 3 前端
    ├── components/
    │   ├── TopBar.vue
    │   ├── StatsBar.vue
    │   ├── SessionBoard.vue
    │   ├── SessionColumn.vue
    │   ├── DetailPanel.vue
    │   └── HooksStatus.vue
    ├── stores/
    │   └── session.ts        # Pinia store + WebSocket 客户端
    └── utils/
        └── time.ts           # 相对时间格式化
```

## 许可证

MIT
