#!/bin/bash
# Simulate multiple sessions for development/testing
# Usage: ./scripts/dev-simulate.sh

API="http://localhost:3210/api"

echo "Creating simulated sessions..."

# Session 1: Active session in session-dashboard
S1="sim-$(date +%s)-001"
curl -s -X POST "$API/events" -H "Content-Type: application/json" \
  -d "{\"session_id\":\"$S1\",\"hook_event_name\":\"SessionStart\",\"cwd\":\"/Users/tanmika/WebProject/session-dashboard\"}"
curl -s -X POST "$API/sessions/$S1/insights" -H "Content-Type: application/json" \
  -d '{"content":"正在实现多列看板布局，已完成顶部状态区的固定列宽策略。下一步将验证横向滚动在超过 6 列时的表现。"}'
curl -s -X POST "$API/sessions/$S1/insights" -H "Content-Type: application/json" \
  -d '{"content":"列体只展示 insight 而非完整事件流，可以显著降低主视图噪音。等待权限、等待用户等状态集中在顶部固定区表达。"}'

# Session 2: Waiting permission
S2="sim-$(date +%s)-002"
curl -s -X POST "$API/events" -H "Content-Type: application/json" \
  -d "{\"session_id\":\"$S2\",\"hook_event_name\":\"SessionStart\",\"cwd\":\"/Users/tanmika/PixCake/tsinpaint\"}"
curl -s -X POST "$API/events" -H "Content-Type: application/json" \
  -d "{\"session_id\":\"$S2\",\"hook_event_name\":\"PermissionRequest\"}"
curl -s -X POST "$API/sessions/$S2/insights" -H "Content-Type: application/json" \
  -d '{"content":"需要权限批准后才能继续推进 LensBlur wasm 编译。当前已完成 embind 绑定层，待编译验证。"}'

# Session 3: Waiting user
S3="sim-$(date +%s)-003"
curl -s -X POST "$API/events" -H "Content-Type: application/json" \
  -d "{\"session_id\":\"$S3\",\"hook_event_name\":\"SessionStart\",\"cwd\":\"/Users/tanmika/WebProject/TanmiWorkspace\"}"
curl -s -X POST "$API/events" -H "Content-Type: application/json" \
  -d "{\"session_id\":\"$S3\",\"hook_event_name\":\"Notification\",\"notification_type\":\"elicitation_dialog\"}"
curl -s -X POST "$API/sessions/$S3/insights" -H "Content-Type: application/json" \
  -d '{"content":"等待用户确认工作区同步策略：是否启用增量同步还是全量同步？"}'

# Session 4: Ended session
S4="sim-$(date +%s)-004"
curl -s -X POST "$API/events" -H "Content-Type: application/json" \
  -d "{\"session_id\":\"$S4\",\"hook_event_name\":\"SessionStart\",\"cwd\":\"/Users/tanmika/WebProject/archive-cleanup\"}"
curl -s -X POST "$API/sessions/$S4/insights" -H "Content-Type: application/json" \
  -d '{"content":"已完成归档清理，删除了 47 个过期文件，释放 230MB 空间。"}'
curl -s -X POST "$API/events" -H "Content-Type: application/json" \
  -d "{\"session_id\":\"$S4\",\"hook_event_name\":\"SessionEnd\"}"

# Session 5: Active with subagent
S5="sim-$(date +%s)-005"
curl -s -X POST "$API/events" -H "Content-Type: application/json" \
  -d "{\"session_id\":\"$S5\",\"hook_event_name\":\"SessionStart\",\"cwd\":\"/Users/tanmika/WebProject/photo-export\"}"
curl -s -X POST "$API/events" -H "Content-Type: application/json" \
  -d "{\"session_id\":\"$S5\",\"hook_event_name\":\"SubagentStart\",\"subagent_id\":\"sub-001\"}"

echo ""
echo "Done! Created 5 simulated sessions."
echo "  $S1 → Active (session-dashboard)"
echo "  $S2 → Waiting Permission (tsinpaint)"
echo "  $S3 → Waiting User (TanmiWorkspace)"
echo "  $S4 → Ended (archive-cleanup)"
echo "  $S5 → Active with subagent (photo-export)"
echo ""
echo "Open http://localhost:3210 or http://localhost:5173 to view."
