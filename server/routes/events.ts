import { Router } from 'express'
import type { HookEventPayload } from '../../shared/types.js'
import type { SessionManager } from '../services/session-manager.js'

export function createEventRoutes(sessionManager: SessionManager): Router {
  const router = Router()

  // Receive hook events from Claude Code
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

    const session = sessionManager.handleEvent(payload)
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

  // Get session event timeline
  router.get('/sessions/:id/events', (req, res) => {
    const events = sessionManager.getSessionEvents(req.params.id)
    res.json({ ok: true, data: events })
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

  // Add insight (for testing / transcript parser)
  router.post('/sessions/:id/insights', (req, res) => {
    const { content, source } = req.body
    if (!content) {
      res.status(400).json({ ok: false, error: 'Missing content' })
      return
    }
    const insight = sessionManager.addInsight(req.params.id, content, source || 'transcript')
    if (!insight) {
      res.status(404).json({ ok: false, error: 'Session not found' })
      return
    }
    res.json({ ok: true, data: insight })
  })

  return router
}
