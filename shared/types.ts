// ─── Hook Event Names (from Claude Code) ───

export type HookEventName =
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PermissionRequest'
  | 'Notification'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'

// ─── Codex Event Names ───

export type CodexEventName =
  | 'task_started'
  | 'task_complete'
  | 'user_message'
  | 'agent_message'
  | 'agent_reasoning'
  | 'token_count'

export type AnyEventName = HookEventName | CodexEventName

// ─── Session State ───

export type SessionState =
  | 'active'
  | 'waiting_permission'
  | 'waiting_user'
  | 'inactive'          // Codex: turn complete, awaiting next user input
  | 'idle'
  | 'ended'

// State display priority (lower = higher priority)
export const STATE_PRIORITY: Record<SessionState, number> = {
  ended: 0,
  waiting_permission: 1,
  waiting_user: 2,
  active: 3,
  inactive: 4,
  idle: 5,
}

// Sort priority for column ordering (lower = shown first)
export const SORT_PRIORITY: Record<SessionState, number> = {
  waiting_permission: 0,
  waiting_user: 1,
  active: 2,
  inactive: 3,
  idle: 4,
  ended: 5,
}

// ─── Incoming Hook Event (what Claude Code sends) ───

// SessionStart matcher values (from Claude Code docs)
export type SessionStartMatcher = 'startup' | 'resume' | 'clear' | 'compact'

export interface HookEventPayload {
  session_id: string
  transcript_path?: string
  cwd?: string
  hook_event_name: HookEventName
  dashboard_source?: 'claude' | 'codex'
  // SessionStart: how the session was initiated
  matcher?: SessionStartMatcher
  // Notification sub-type
  notification_type?: string
  // Tool info for PreToolUse/PostToolUse
  tool_name?: string
  // Subagent info
  subagent_id?: string
  // Timestamp (ISO string, set by receiver if absent)
  timestamp?: string
  // Codex-specific metadata
  model?: string
  permission_mode?: string
  stop_hook_active?: boolean
  last_assistant_message?: string
  codex_hook_source?: string
}

// ─── Persisted Event ───

export interface SessionEvent {
  id: number
  session_id: string
  event_name: AnyEventName
  notification_type?: string
  tool_name?: string
  subagent_id?: string
  timestamp: string
  raw_payload: string
}

// ─── Insight ───

export interface Insight {
  id: number
  session_id: string
  content: string
  timestamp: string
  source: 'transcript' | 'hook' | 'user'
}

// ─── Session (aggregated view) ───

export interface Session {
  session_id: string
  display_name: string // cwd_basename + short_session_id
  cwd: string
  transcript_path?: string
  state: SessionState
  last_activity: string // ISO timestamp
  created_at: string
  insights: Insight[]
  total_insights: number  // Real insight count (insights array may be truncated)
  // Custom alias (persisted in DB, overrides generated display_name when set)
  alias: string
  // Watchlist pin (persisted in DB)
  pinned: boolean
  // Session source
  source: 'claude' | 'codex'
  // Predecessor session id (set during auto-handoff on context clear)
  predecessor_id?: string
  // Runtime tracking (not persisted)
  active_tools: number
  active_subagents: number
}

// ─── WebSocket Messages ───

export type WsMessage =
  | { type: 'sessions'; data: Session[] }
  | { type: 'session_update'; data: Session }
  | { type: 'session_removed'; session_id: string }
  | { type: 'new_insight'; session_id: string; insight: Insight }
  | { type: 'session_pin_update'; session_id: string; pinned: boolean }

// ─── API Response ───

export interface ApiResponse<T> {
  ok: boolean
  data?: T
  error?: string
}

// ─── Constants ───

export const IDLE_THRESHOLD_MS = 3 * 60 * 1000 // 3 minutes
export const CODEX_ENDED_THRESHOLD_MS = 30 * 60 * 1000 // 30 min idle → ended (Codex only)
export const SERVER_PORT = 3210
