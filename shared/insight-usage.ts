/**
 * Shared insight recovery usage manual — Chinese.
 * Used by both CLAUDE.md injection and AGENTS.md injection.
 * Maintain once, deploy to both platforms.
 */

export const INSIGHT_USAGE_MANUAL = `## Session Insight Recovery

**当上下文被压缩（compact）或恢复（resume）后，你必须立即使用以下工具恢复之前的工作上下文。** 不要凭压缩摘要猜测之前的工作细节，直接读取 insights 获取准确信息。

你的 session_id 在每次会话开始时通过 SessionStart hook 自动注入到上下文中（格式: "Your current session_id is: xxx"）。

先从少量开始读取，根据尾部统计（如 "[30 / 1121 primary insights shown]"）决定是否加载更多。
\`--limit\` / \`--offset\` 只计算主 insight；同一区间内的 user prompt 会自动附带，不占分页条数。

\`\`\`bash
# 读取 insights（先少量，按需增加）
session-dashboard insights --session <your-session-id> --limit 30

# 翻页加载更多
session-dashboard insights --session <your-session-id> --limit 30 --offset 30

# 含 predecessor 链（上下文 clear 后恢复前序工作）
session-dashboard insights --session <your-session-id> --chain --limit 50

# 按关键词过滤
session-dashboard insights --session <your-session-id> --grep "关键词"

# 列出当前 session 及其 predecessor 链
session-dashboard insights --session <your-session-id> --list
\`\`\`

更多参数: \`session-dashboard insights --help\``

/** Claude Code specific additions (subagent pattern, output-style) */
export const CLAUDE_SPECIFIC_NOTES = `
**注意**：insight 输出需要 Explanatory 语言风格处于激活状态。如果当前不处于该风格，insight 不会被产生，可提示用户使用 \`/output-style\` 切换。

**建议**：使用 Explore subagent 执行 CLI 命令，由 subagent 阅读原始 insights 并整理为精炼摘要返回，避免大量原始内容消耗主上下文 token。在 subagent prompt 中要求提取：当前任务、已完成步骤、当前状态、遗留问题。`
