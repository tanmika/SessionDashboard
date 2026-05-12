import { Router } from 'express'
import type Database from 'better-sqlite3'
import type { HookEventPayload } from '../../shared/types.js'
import type { SessionManager } from '../services/session-manager.js'
import { exportSessionText } from '../services/session-export.js'
import { resolveTimeRange } from '../../shared/time-range.js'

function parseBoundedInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = Array.isArray(value) ? value[0] : value
  if (raw == null) return fallback
  const parsed = Number.parseInt(String(raw), 10)
  if (Number.isNaN(parsed)) return fallback
  return Math.min(Math.max(parsed, min), max)
}

function parseExportDepth(value: unknown): number | 'all' {
  const raw = Array.isArray(value) ? value[0] : value
  if (raw == null || raw === '') return 1
  if (raw === 'all') return 'all'
  const parsed = Number.parseInt(String(raw), 10)
  if (Number.isNaN(parsed)) return 1
  return Math.max(0, parsed)
}

export function createEventRoutes(sessionManager: SessionManager, db: Database.Database): Router {
  const router = Router()

  // Receive hook events from Claude Code / Codex CLI
  router.post('/events', (req, res) => {
    const payload = req.body as HookEventPayload

    if (!payload.session_id || !payload.hook_event_name) {
      res.status(400).json({ ok: false, error: 'Missing session_id or hook_event_name' })
      return
    }

    // Ensure timestamp
    if (!payload.timestamp) {
      payload.timestamp = new Date().toISOString()
    }

    const session = payload.dashboard_source === 'codex'
      ? sessionManager.handleCodexHookEvent(payload)
      : sessionManager.handleEvent(payload)
    res.json({ ok: true, session_id: session.session_id, state: session.state })
  })

  // Get all sessions
  router.get('/sessions', (_req, res) => {
    const sessions = sessionManager.getAllSessions()
    res.json({ ok: true, data: sessions })
  })

  // Get single session detail
  router.get('/sessions/:id', (req, res) => {
    const session = sessionManager.getSession(req.params.id)
    if (!session) {
      res.status(404).json({ ok: false, error: 'Session not found' })
      return
    }
    res.json({ ok: true, data: session })
  })

  // Get session event timeline (supports pagination via ?limit=N&offset=N)
  router.get('/sessions/:id/events', (req, res) => {
    const limit = parseBoundedInt(req.query.limit, 100, 1, 500)
    const offset = parseBoundedInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER)
    const events = sessionManager.getSessionEvents(req.params.id, limit, offset)
    const total = sessionManager.getSessionEventsCount(req.params.id)
    res.json({ ok: true, data: events, total })
  })

  // Get session insights (paginated, optional source filter)
  router.get('/sessions/:id/insights', (req, res) => {
    const limit = parseBoundedInt(req.query.limit, 100, 0, 500)
    const offset = parseBoundedInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER)
    const excludeSource = (req.query.exclude_source as string) || undefined
    const data = sessionManager.getSessionInsights(req.params.id, limit, offset, excludeSource)
    const total = sessionManager.getSessionInsightsTotal(req.params.id, excludeSource)
    res.json({ ok: true, data, total })
  })

  router.get('/sessions/:id/export', (req, res) => {
    const mode = req.query.mode === 'insights' ? 'insights' : 'conversation'
    const depth = parseExportDepth(req.query.depth)
    let range
    try {
      range = resolveTimeRange({
        range: typeof req.query.range === 'string' ? req.query.range : undefined,
        since: typeof req.query.since === 'string' ? req.query.since : undefined,
        until: typeof req.query.until === 'string' ? req.query.until : undefined,
      })
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Invalid time range.',
      })
      return
    }
    const result = exportSessionText(db, {
      sessionId: req.params.id,
      mode,
      depth,
      range,
    })

    if (!result.ok) {
      const status =
        result.error.error === 'session_not_found'
          ? 404
          : result.error.error === 'ambiguous_session'
            ? 409
            : 409
      res.status(status).json({ ok: false, error: result.error.message, detail: result.error })
      return
    }

    res.json({ ok: true, data: result.data })
  })

  // Set or clear session alias
  router.patch('/sessions/:id/alias', (req, res) => {
    const { alias } = req.body
    if (typeof alias !== 'string') {
      res.status(400).json({ ok: false, error: 'Missing or invalid alias field (string required)' })
      return
    }
    const session = sessionManager.setSessionAlias(req.params.id, alias)
    if (!session) {
      res.status(404).json({ ok: false, error: 'Session not found' })
      return
    }
    res.json({ ok: true, data: session })
  })

  // Pin / unpin a session
  router.patch('/sessions/:id/pin', (req, res) => {
    const { pinned } = req.body
    if (typeof pinned !== 'boolean') {
      res.status(400).json({ ok: false, error: 'Missing or invalid pinned field (boolean required)' })
      return
    }
    const session = sessionManager.setSessionPinned(req.params.id, pinned)
    if (!session) {
      res.status(404).json({ ok: false, error: 'Session not found' })
      return
    }
    res.json({ ok: true, data: session })
  })

  return router
}
