# Session Dashboard - Claude Code Hooks 配置说明

## 概述

Session Dashboard 通过 Claude Code 的 hooks 机制接收会话事件。每次 Claude Code 触发 hook 时，hook 脚本会将事件 POST 到本地 dashboard runtime。

## 前置条件

1. **启动 dashboard runtime**（页面关闭时 runtime 仍需持续运行，否则事件会丢失）：
   ```bash
   cd /Users/tanmika/WebProject/session-dashboard
   npm run build
   node lib/cli.js init
   ```
   Runtime 默认监听 `http://localhost:38473`，并通过 macOS 后台服务自动启动。

2. **打开 dashboard 页面**（可选，runtime 启动后随时打开）：
   打开浏览器访问 `http://localhost:38473`

## 配置 hooks

在你的 Claude Code 全局配置中（`~/.claude/settings.json`）添加 hooks：

```json
{
  "hooks": {
    "SessionStart": [
      {
        "type": "command",
        "command": "bash /Users/tanmika/WebProject/session-dashboard/hooks/session-hook.sh"
      }
    ],
    "SessionEnd": [
      {
        "type": "command",
        "command": "bash /Users/tanmika/WebProject/session-dashboard/hooks/session-hook.sh"
      }
    ],
    "Stop": [
      {
        "type": "command",
        "command": "bash /Users/tanmika/WebProject/session-dashboard/hooks/session-hook.sh"
      }
    ],
    "PreToolUse": [
      {
        "type": "command",
        "command": "bash /Users/tanmika/WebProject/session-dashboard/hooks/session-hook.sh"
      }
    ],
    "PostToolUse": [
      {
        "type": "command",
        "command": "bash /Users/tanmika/WebProject/session-dashboard/hooks/session-hook.sh"
      }
    ],
    "PostToolUseFailure": [
      {
        "type": "command",
        "command": "bash /Users/tanmika/WebProject/session-dashboard/hooks/session-hook.sh"
      }
    ],
    "Notification": [
      {
        "type": "command",
        "command": "bash /Users/tanmika/WebProject/session-dashboard/hooks/session-hook.sh"
      }
    ],
    "SubagentStart": [
      {
        "type": "command",
        "command": "bash /Users/tanmika/WebProject/session-dashboard/hooks/session-hook.sh"
      }
    ],
    "SubagentStop": [
      {
        "type": "command",
        "command": "bash /Users/tanmika/WebProject/session-dashboard/hooks/session-hook.sh"
      }
    ]
  }
}
```

> **注意**：`PermissionRequest` 不是标准 hook 事件名，权限请求通过 `Notification(notification_type: "permission_prompt")` 形式到达。

## Hook 脚本说明

`hooks/session-hook.sh` 从 stdin 读取 JSON payload（Claude Code 自动注入），后台发送到 runtime，**不阻塞 Claude Code 本体**：

```bash
#!/bin/bash
PAYLOAD=$(cat)
curl -s -X POST "http://localhost:38473/api/events" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" > /dev/null 2>&1 &
exit 0
```

## 自定义 runtime 端口

如需修改端口，为服务设置 `SESSION_DASHBOARD_PORT`，并为 hook 设置 `SESSION_DASHBOARD_URL`：

```bash
SESSION_DASHBOARD_PORT=4000 SESSION_DASHBOARD_URL=http://localhost:4000 npx tsx server/index.ts
```

## 验证配置

1. 启动 runtime
2. 在任意目录启动 Claude Code 会话
3. 会话开始后，dashboard 页面应出现对应 session 列
4. 执行任意工具调用后，session 状态应变为 Active

## 开发/测试

不接 Claude Code 时，使用模拟脚本测试 dashboard：

```bash
# 先启动 runtime
npx tsx server/index.ts &

# 模拟 5 种状态的 session
bash scripts/dev-simulate.sh
```
