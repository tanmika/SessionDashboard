import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'http'
import type { WsMessage } from '../shared/types.js'
import type { SessionManager } from './services/session-manager.js'

export function createWsServer(server: Server, sessionManager: SessionManager) {
  const wss = new WebSocketServer({ server, path: '/ws' })

  wss.on('connection', (ws) => {
    // Send full session list on connect
    const sessions = sessionManager.getAllSessions()
    send(ws, { type: 'sessions', data: sessions })
  })

  function broadcast(msg: WsMessage) {
    const payload = JSON.stringify(msg)
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload)
      }
    }
  }

  function send(ws: WebSocket, msg: WsMessage) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }

  return { wss, broadcast }
}
