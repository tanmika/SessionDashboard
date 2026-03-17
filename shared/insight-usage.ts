/**
 * Shared insight recovery usage manual — Chinese.
 * Used by both CLAUDE.md injection and AGENTS.md injection.
 * Maintain once, deploy to both platforms.
 */

export const INSIGHT_USAGE_MANUAL = `## Session Insight Recovery（强制执行）

⚠️ **这是强制规则，不是建议。违反此规则等同于丢失用户的工作上下文。**

### 触发条件

当你检测到以下任何一种情况时，**必须在回复用户之前**先执行 insight recovery：
1. 上下文中出现 "Another language model started to solve this problem" 等压缩摘要
2. 你发现自己对当前任务的细节记忆模糊或不完整
3. 用户提到"继续"、"接着做"但你不确定之前做到了哪里
4. 会话刚从 resume 恢复

### 为什么不能跳过

压缩摘要是有损的，它会丢失：具体的文件修改细节、未完成的 TODO、调试过程中的关键发现、用户的偏好和纠正。只有 insights 保留了完整的工作轨迹。**不要自以为摘要够用就跳过这一步。**

### 你的 session_id

通过 SessionStart hook 自动注入（格式: "Your current session_id is: xxx"）。如果上下文中找不到，运行 \`session-dashboard insights --list\` 查看最近活跃 session。

### 执行步骤

**第一步**：读取最近的 insights，评估总量：
\`\`\`bash
session-dashboard insights --session <your-session-id> --limit 30
\`\`\`

**第二步**：根据尾部统计（如 "[30 / 1121 insights shown]"）决定是否翻页加载更多：
\`\`\`bash
session-dashboard insights --session <your-session-id> --limit 30 --offset 30
\`\`\`

**第三步**（可选）：如果是从 /new 创建的新 session，用 --chain 追溯前序：
\`\`\`bash
session-dashboard insights --session <your-session-id> --chain --limit 50
\`\`\`

其他：\`--grep "关键词"\` 过滤、\`--list\` 查看 session 链。更多参数: \`session-dashboard insights --help\``

/** Claude Code specific additions (subagent pattern, output-style) */
export const CLAUDE_SPECIFIC_NOTES = `
**注意**：insight 输出需要 Explanatory 语言风格处于激活状态。如果当前不处于该风格，insight 不会被产生，可提示用户使用 \`/output-style\` 切换。

**建议**：使用 Explore subagent 执行 CLI 命令，由 subagent 阅读原始 insights 并整理为精炼摘要返回，避免大量原始内容消耗主上下文 token。在 subagent prompt 中要求提取：当前任务、已完成步骤、当前状态、遗留问题。`
