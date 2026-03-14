import express from 'express'
import { createServer } from 'http'
import { resolve } from 'path'
import { existsSync } from 'fs'
import { SERVER_PORT } from '../shared/types.js'
import { initDb } from './db.js'
import { createWsServer } from './ws.js'
import { createEventRoutes } from './routes/events.js'
import { SessionManager } from './services/session-manager.js'

const app = express()
const httpServer = createServer(app)

app.use(express.json())

// Initialize database
const db = initDb()

// Initialize session manager
const sessionManager = new SessionManager(db)

// Initialize WebSocket server
const wss = createWsServer(httpServer, sessionManager)

// Bind WS broadcast to session manager
sessionManager.setBroadcast(wss.broadcast)

// Mount API routes
app.use('/api', createEventRoutes(sessionManager))

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, sessions: sessionManager.getSessionCount() })
})

// Serve built frontend in production
const distDir = resolve(import.meta.dirname, '..', 'dist')
if (existsSync(distDir)) {
  app.use(express.static(distDir))
  // SPA fallback
  app.use((_req, res) => {
    res.sendFile(resolve(distDir, 'index.html'))
  })
}

httpServer.listen(SERVER_PORT, () => {
  console.log(`[session-dashboard] server running on http://localhost:${SERVER_PORT}`)
  console.log(`[session-dashboard] ${sessionManager.getSessionCount()} sessions restored from db`)
})
