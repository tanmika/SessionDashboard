# Session Dashboard PRD v0.1

## 1. 产品名称
**Session Dashboard**

## 2. 背景与问题

在使用 Claude Code 进行多终端、多会话并行工作时，用户会遇到以下问题：

- 多个终端窗口分散，无法集中掌握整体进度
- 虽然 insight 能帮助理解单个会话的当前状态，但在多会话同时运行时难以统一查看
- 用户难以及时发现某个会话是否处于等待权限、等待输入、长时间无进展等状态
- 缺少一个统一界面来观察 session 的运行态、近期行为与阻塞情况

因此，需要一个面向 Claude Code 会话的观察台，用于集中展示多个 session 的当前状态与近期行为。

## 3. 产品目标

Session Dashboard 的目标是：

1. **按 session 聚合展示会话**
2. **实时显示 session 的近期行为**
3. **展示 session 当前状态**
4. **发现并标记阻塞/等待状态**
5. **帮助用户快速掌握多会话整体进度**

## 4. 非目标（第一版明确不做）

为避免范围膨胀，第一版不包含以下能力：

- 不做 Claude Code 本体功能修改
- 不做远程多机器同步
- 不做团队协作/多用户管理
- 不做复杂权限审批操作（如在 dashboard 中直接点允许）
- 不做完整 transcript 浏览器
- 不做智能总结、自动优先级排序、自动告警策略配置
- 不做历史分析报表

第一版重点是：**单机、多 session、实时观察**。

## 5. 目标用户

### 核心用户
- 同时打开多个 Claude Code 会话的开发者
- 使用 agent / subagent 并行执行任务的用户
- 希望快速了解当前整体进展、阻塞状态、近期行为的用户

### 典型场景
- 同时在多个终端跑不同任务
- 一个终端主会话 + 多个子会话
- 想快速判断哪个 session 正在推进、哪个在等待、哪个已经结束

## 6. 核心概念

### 6.1 Session
Claude Code 的一个独立会话，用 `session_id` 标识。第一版将 `session_id` 视为单次自然生命周期内的稳定主键；会话自然结束后，不复用同一个 `session_id`。

### 6.2 Insight
会话中对当前进展/关键决策的解释性内容，是“近期行为”的一种重要表现形式。第一版中，insight 的展示内容主要来自 transcript 的增量解析；hooks 负责提供事件与状态信号，并触发对应 session 的刷新。

### 6.3 Session State
用于描述会话当前所处状态的展示层状态。第一版需要区分“用户侧阻塞”“系统仍在推进”“长时间无进展”“生命周期结束”这四类不同含义，不将它们混为一谈。

第一版建议状态包括：

#### 强语义状态
- **Ended**：会话已自然结束。`Ended` 是终态；一旦进入，不再回到其他状态
- **Waiting Permission**：会话当前继续不下去，正在等待用户批准权限
- **Waiting User**：会话当前继续不下去，正在等待用户回答、补充信息或做选择

#### 观察层状态
- **Active**：当前不在等待用户，且系统仍在推进任务，例如正在执行 tool、运行子 agent，或刚产生新的 insight / 进展信号
- **Idle / No Recent Activity**：当前不在等待用户、也没有执行中的工作，并且超过阈值没有新的真实进展

> 注：第一版不把“正常工作”作为强语义状态，也不把“卡死”作为系统可直接确认的状态。

### 6.4 Recent Activity
会话的近期行为轨迹，包括但不限于：

- insight
- tool use 相关事件
- 子 agent 启停
- 权限请求
- 会话开始/结束

其中，并非所有 recent activity 都等价于“真实推进”；例如等待权限或等待输入类通知本身不应被当作新的进展。

## 7. 核心能力

### 7.1 Session 列式看板视图
Dashboard 主视图不是表格、单行列表或瀑布流卡片墙，而是按 session 展示的**多列 session 列式看板**。

每个 session 独占一列，所有 session 列高度统一。每列顶部用于展示该会话的当前状态与基础上下文，列体用于按时间倒序展示该 session 的 insight 内容。

第一版主视图聚焦“当前状态 + insight 演进”，不在列体中混排完整事件流。

### 7.2 Session 侧边详情面板
点击某个 session 列后，在侧边详情面板中查看其详细时间线，包括：

- session 生命周期事件
- 近期 insight 列表
- 权限请求事件
- 等待输入事件
- 子 agent 相关事件（如存在）

### 7.3 实时更新
当新的 session 事件到来时，页面应自动更新对应 session 的状态和内容。

### 7.4 阻塞识别
系统应能识别并展示以下状态：

- 等待权限
- 等待用户输入
- 长时间无活动（疑似阻塞）

### 7.5 结束态展示
会话结束后，页面应明确标记为已结束，而不是继续作为活动会话展示。

### 7.6 Session 列结构
第一版建议每个 session 列从上到下包含以下信息层：

1. **顶部状态区**
   - session 名称（使用 `cwd basename + short session id` 生成）
   - 主状态 badge
   - 最近活动时间
   - short session id
   - cwd

2. **Insight 内容区**
   - 仅展示该 session 的 insight 内容
   - 按时间倒序排列，最新 insight 固定在最上方
   - 旧 insight 依次向下排列
   - Insight 内容区占据列体主体空间

3. **列内交互**
   - 允许查看详情
   - 允许打开侧边详情面板查看更完整的 session 时间线

## 8. 第一版最小闭环

第一版最小可用产品（MVP）需支持：

1. 接收来自 Claude Code hooks 的 session 相关事件
2. 将接收到的事件持久化到本地，作为可恢复的数据来源
3. 基于持久化事件流和 `session_id` 聚合同一会话事件
4. 在 runtime 重启后，能从本地持久化事件中恢复已有 session 状态
5. 以多列 session 列式看板形式展示多个 session
6. 每个 session 独占一列，列高统一
7. 每个 session 列顶部展示：
   - 当前主状态
   - 最近活动时间
   - session 基本标识
   - cwd
8. 每个 session 列主体按倒序展示 insight 内容
9. 支持查看某个 session 的完整时间线详情
10. 支持页面关闭/刷新后重新打开 dashboard 时恢复已有 session 视图
11. 在 dashboard 页面关闭期间，只要本地 runtime 仍在运行，新到达事件仍会被记录并在页面重新打开后展示
12. 能标记：
   - waiting permission
   - waiting user input
   - ended
   - no recent activity

## 9. 数据来源与事件信号

第一版采用“两层数据来源”：

1. **Claude Code hooks 事件流**：提供 session 生命周期、等待权限、等待用户输入、tool use、subagent 启停等事件信号，并先持久化到本地
2. **transcript 增量解析**：从 `transcript_path` 中提取 insight 内容，用于驱动主列正文与详情中的 insight 展示

本地 runtime 采用 web 进程形态，但页面本身不是唯一存储位置。dashboard 页面关闭期间，只要本地 runtime 仍在运行，新到达事件仍应被记录；runtime 重启后，也应能从本地持久化数据中恢复当前 session 视图。

### 可明确使用的事件
- `SessionStart`
- `SessionEnd`
- `Stop`
- `SubagentStart`
- `SubagentStop`
- `PermissionRequest`
- `Notification`
- `PreToolUse`
- `PostToolUse`
- `PostToolUseFailure`

### 可直接获取的信息
- `session_id`
- `transcript_path`
- `cwd`
- `permission_mode`
- `hook_event_name`

### 可明确知道的状态信号
- 会话开始 / 恢复
- 会话结束
- 触发权限申请
- 进入等待用户回答 / 输入状态

### 部分可推断的信息
- 当前是否仍活跃
- 是否近期仍在推进任务
- 是否长时间无活动
- 是否疑似卡住

## 10. 状态模型（初版）

### 10.1 状态判断原则
第一版将状态分为两层：

1. **主状态显示规则**：某个 session 列顶部当前显示什么状态
2. **列表排序规则**：多个 session 列在主页面如何排序

两者不是同一件事，不能使用同一套优先级。

### 10.2 Waiting 的含义
`Waiting Permission` 和 `Waiting User` 都属于**用户侧阻塞态**。

也就是说，session 当前继续不下去，原因在用户动作：
- `Waiting Permission`：等用户批准权限
- `Waiting User`：等用户回复、补充信息或做选择

正在执行 tool、运行 subagent、或系统仍在自行推进任务时，不应标记为 waiting。

### 10.3 Ended 的含义
- `SessionEnd` → `Ended`
- `Ended` 是终态
- 会话一旦自然结束，列顶部主状态必须显示为 `Ended`
- 第一版中，结束后的 session 不再回到 `Active`、`Waiting Permission` 或 `Waiting User`

### 10.4 Active 的含义
满足以下任一条件时，可展示为 `Active`：
- 当前存在执行中的 tool
- 当前存在运行中的 subagent
- 最近出现新的真实推进信号，例如新的 insight、tool 执行推进、subagent 状态推进

### 10.5 Idle / No Recent Activity 的含义
`Idle / No Recent Activity` 仅在以下条件同时满足时触发：

1. session 尚未结束
2. 当前不处于 `Waiting Permission` 或 `Waiting User`
3. 当前没有执行中的 tool 或运行中的 subagent
4. 超过空闲阈值后，仍没有新的真实推进

因此，Idle 不是“没有任何事件”，而是“没有新的真实进展”。

### 10.6 Waiting 的进入与解除
#### 进入条件
- `PermissionRequest` / `Notification(permission_prompt)` → `Waiting Permission`
- `Notification(elicitation_dialog)` / `Notification(idle_prompt)` → `Waiting User`

#### 解除条件
当出现新的真实推进信号时，应解除 waiting，例如：
- `PreToolUse`
- `PostToolUse`
- `PostToolUseFailure`
- `SubagentStart`
- `SubagentStop`
- transcript 中解析出新的 insight
- `SessionEnd`

> `Stop` 可以作为活动线索参考，但第一版不将其单独作为 waiting 解除的充分条件。

### 10.7 主状态显示优先级
当同一个 session 同时满足多个状态条件时，列顶部按以下顺序选择一个主状态：

1. `Ended`
2. `Waiting Permission`
3. `Waiting User`
4. `Active`
5. `Idle / No Recent Activity`

详情面板可以展示完整事件与辅助线索，但主列顶部应保持单一主状态，避免信息冲突。

### 10.8 列排序优先级
主页面的 session 列排序采用独立规则：

1. `Waiting Permission`
2. `Waiting User`
3. `Active`
4. `Idle / No Recent Activity`
5. `Ended`

在同一主状态内，再按最近活动时间倒序排序。

### 10.9 状态刷新与重排策略
- 当 session 主状态发生变化时，对应列应立即按最新排序规则重排
- 第一版默认启用“状态变化即重排”
- 若某列当前处于选中态并打开侧边详情面板，第一版允许暂不自动跳位，以减少阅读打断
- 需要预留策略接口，便于后续按状态类型、事件类型或用户偏好调整“哪些情况下不重排”

### 10.10 空状态与首条 Insight
- 若某个 session 已建立但尚未产生 insight，则该列主体显示 `Waiting for first insight`
- 一旦收到首条 insight，占位内容立即被首条 insight 替换

### 10.11 空闲阈值
- 第一版将 `Idle / No Recent Activity` 的默认判定阈值设为 **3 分钟**
- 该阈值为展示层默认规则，后续应允许调整

> 注：第一版产品文案应尽量避免把推断状态说成系统已确定事实。

## 11. 页面结构（初稿）

### 11.1 Dashboard 主页面
包含：

- 顶部概览区
  - 总 session 数
  - active 数
  - waiting permission 数
  - waiting user input 数
  - ended 数

- 顶部筛选区
  - 状态筛选
  - cwd 筛选
  - 仅看需要关注的 session
  - 搜索 session

- 主内容区：多列 session 列式看板
  - 每个 session 独占一列
  - 所有列高度统一
  - 采用固定列宽策略
  - session 数量超出可视范围时，主内容区横向滚动
  - 每列顶部显示当前状态与上下文
  - 每列主体按倒序展示 insight 内容
  - 各列按“列表排序优先级 + 最近活动时间”排序

- 页面恢复策略
  - 页面关闭或刷新后重新打开时，应从本地 runtime 获取当前最新 session 视图
  - 本地 runtime 为 web 进程；页面本身不作为唯一数据存储位置
  - dashboard 是否打开不应影响事件记录

#### 主列默认排序策略
第一版默认采用“**列表排序优先级 + 最近活动时间**”的复合排序：

1. 先按列表排序优先级排序：`Waiting Permission` > `Waiting User` > `Active` > `Idle / No Recent Activity` > `Ended`
2. 在同一主状态内，再按最近活动时间倒序排序

该策略的目标是优先把“需要用户介入”的 session 顶到前面，同时保留对近期动态的敏感性。

### 11.2 Session 列结构
每个 session 列采用统一高度、统一纵向信息结构。

#### 顶部固定区
- session 名称（使用 `cwd basename + short session id` 生成）
- 主状态
- 最近活动时间
- short session id
- cwd
- 第一版先不显示 transcript_path、permission mode、agent/subagent 等额外字段

#### 主体滚动区
- 仅展示 insight 内容
- 按倒序排列，最新 insight 在最上方
- 每条 insight 保留独立块级展示
- insight 采用**完整展示**，第一版不做截断
- 旧 insight 随时间向下堆叠
- 若尚无 insight，则显示 `Waiting for first insight`

#### 交互原则
- 主列默认用于“观察当前状态 + 浏览 insight 演进”
- 更完整的事件时间线放在侧边详情面板中，不直接占据主列主体空间
- 鼠标滚轮默认控制列内纵向滚动
- 横向移动优先通过键盘 `q/e` 或方向键 `←/→` 控制
- 该交互方案先作为第一版默认设计，后续可根据使用反馈再调整

### 11.3 Session 侧边详情面板
展示：

- 基本信息
  - session id
  - cwd
  - transcript_path（可选展示）
  - 最近活动时间
- 当前状态
- Insight 流
- 事件时间线
- 子 agent 事件（如有）

## 12. 关键用户价值

用户打开 dashboard 后，应能在几秒内回答这些问题：

1. 现在一共有多少个 Claude Code session 在跑？
2. 哪些 session 最近有新进展？
3. 哪些 session 在等我处理权限或输入？
4. 哪个 session 当前状态是什么？
5. 某个 session 最近的 insight 演进是什么？

## 13. 验收标准（初版）

| WHEN (Condition) | THEN (Result) |
|------------------|---------------|
| 存在多个 Claude Code session 同时运行 | Dashboard 能按 `session_id` 正确区分并展示多个 session 列 |
| 主页面展示多个 session | 每个 session 独占一列，且各列高度统一 |
| 某个 session 收到新的 insight | 对应 session 列顶部状态与 insight 列内容自动更新，最新 insight 出现在最上方 |
| 某个 session 触发 `PermissionRequest` 或权限相关通知 | 该 session 列顶部显示等待权限状态 |
| 某个 session 收到 `Notification(elicitation_dialog)` 或 `idle_prompt` 类通知 | 该 session 列顶部显示等待用户回答/输入状态 |
| 某个 session 原本处于 waiting，随后出现新的真实推进信号 | 该 session 列退出 waiting，并按最新状态重新显示 |
| 某个 session 存在执行中的 tool 或运行中的 subagent | 该 session 不应被显示为 `Idle / No Recent Activity` |
| 某个 session 长时间无真实进展、未结束、且当前不在 waiting | 该 session 列顶部显示长时间无活动状态 |
| 某个 session 收到 `SessionEnd` | 该 session 列顶部显示已结束状态，且不再回到其他主状态 |
| 用户进入某个 session 侧边详情面板 | 能查看该 session 的完整 insight 与关键事件时间线 |
| 某个 session 从一种主状态切换到另一种主状态 | 对应列立即按最新排序规则重排 |
| 某个 session 尚未产生任何 insight | 列主体显示 `Waiting for first insight` 占位内容 |
| 用户使用鼠标滚轮浏览某个 session 列 | 默认滚动该列内部的 insight 内容 |
| 用户使用 `q/e` 或方向键 `←/→` | 主内容区按列进行横向移动 |
| 用户刷新 dashboard 页面 | 已记录的 session 列、状态与 insight 内容能够恢复显示 |
| 用户关闭 dashboard 页面后重新打开 | 本地 runtime 运行期间记录的内容仍可见，不因页面关闭而丢失 |
| 本地 runtime 重启后重新打开 dashboard | 系统能从本地持久化事件中恢复已有 session 状态与 insight 内容 |
| dashboard 页面未打开，但新的 hook 事件持续到达 | 事件仍被记录，并在页面重新打开后展示到对应 session 列 |

## 14. 风险与边界说明

### 14.1 强语义 vs 推断语义
不是所有状态都由 Claude Code 直接提供，部分状态依赖事件推断，因此产品文案需准确。

### 14.2 在线状态不是严格 presence
没有真正 heartbeat，因此“在线/离线”不应作为第一版强承诺。

### 14.3 卡住状态需要阈值定义
“长时间无活动”与“疑似阻塞”依赖时间阈值，需要后续明确。第一版中，`Idle / No Recent Activity` 仅表示“超过阈值没有新的真实进展”，不直接等价于系统已确认卡住。

### 14.4 主列聚焦 insight，不等于丢弃事件
第一版主列主体只展示 insight，但完整事件流仍需保留在侧边详情面板中，以便在观察与排查之间切换。

### 14.5 第一版持久化边界
第一版需要本地持久化事件，以支持页面刷新、页面关闭后重开以及 runtime 重启后的恢复；但第一版不要求提供完整历史回放、复杂归档策略或长期报表能力。

### 14.6 数据职责边界
第一版中，hooks 负责产生日志化事件并写入本地持久化；runtime 负责读取、聚合、推导状态并向 dashboard 提供当前视图；transcript 负责提供 insight 展示内容。

## 15. 后续扩展方向（暂不纳入第一版）
- 多机器聚合
- 历史回放与搜索
- Dashboard 中直接处理权限
- 自动摘要和优先级排序
- 异常/阻塞告警
- 任务级视图 / agent 级视图
- 统计报表

## 16. 一句话定义
**Session Dashboard 是一个面向 Claude Code 多会话的列式观察台：每个 session 独占一列，顶部展示当前状态，主体按倒序展示 insight 内容，并通过本地事件持久化保证页面关闭、刷新与 runtime 重启后仍可恢复观察上下文。**