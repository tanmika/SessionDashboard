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

通过 SessionStart hook 自动注入（格式: "Your current session_id is: xxx"）。如果上下文中找不到，先运行 \`session-dashboard insights --list --chain\` 查看当前目录最近的 chain；需要跨目录查找时使用 \`session-dashboard insights --list --chain --all\`。

### 执行步骤

**第一步**：按当前 session 所属 chain 读取最近 insights。chain 读取默认从新到旧，优先恢复最近决策和状态：
\`\`\`bash
session-dashboard insights --session <your-session-id> --chain --limit 50
\`\`\`

**第二步**：根据尾部统计（如 "[50 / 180 primary insights shown]"）决定是否分页加载更多：
\`\`\`bash
session-dashboard insights --session <your-session-id> --chain --limit 50 --offset 50
\`\`\`

**第三步**：如果上下文中找不到当前 session_id，先列出当前目录最近的 chain：
\`\`\`bash
session-dashboard insights --list --chain --limit 20
\`\`\`

如果当前目录查不到，再按需跨目录查看：
\`\`\`bash
session-dashboard insights --list --chain --all --limit 50
\`\`\`

### 恢复范围

默认只读取 main 区会话。只有当前任务明确依赖 subagent 调研、并行执行结果，或 main 区 insight 明确缺少 subagent 细节时，才追加 \`--include-subagents\`：
\`\`\`bash
session-dashboard insights --session <your-session-id> --chain --include-subagents --limit 80
\`\`\`

恢复目标是拿到可继续工作的最小信息：
1. 当前任务
2. 用户已经确认的规则和否定过的方案
3. 已完成动作
4. 已修改文件
5. 已运行验证
6. 未完成事项
7. 下一步动作

### 禁止默认读取原文

上下文压缩恢复时，不读取完整 conversation，不使用 \`export --mode conversation\`，也不把原始对话展开到当前会话。

如 insight 不足，只继续读取更多 insight 页。只有用户明确要求核对原始措辞、截取原始记录、复原某段对话时，才使用 \`records cut\` 或 \`export\`，并且输出到文件，不直接打印完整正文。

其他：\`--grep "关键词"\` 过滤、\`--list --chain\` 查看当前目录相关 chain、\`--all\` 跨目录查看。更多参数: \`session-dashboard insights --help\``

/** Claude Code specific additions (subagent pattern, output-style) */
export const CLAUDE_SPECIFIC_NOTES = `
**注意**：insight 输出需要 Explanatory 语言风格处于激活状态。如果当前不处于该风格，insight 不会被产生，可提示用户使用 \`/output-style\` 切换。

**建议**：使用 Explore subagent 执行 CLI 命令，由 subagent 阅读原始 insights 并整理为精炼摘要返回，避免大量原始内容消耗主上下文 token。在 subagent prompt 中要求提取：当前任务、已完成步骤、当前状态、遗留问题。`
