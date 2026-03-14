import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { Session, WsMessage, SessionState } from '../../shared/types'
import { SORT_PRIORITY } from '../../shared/types'

export const useSessionStore = defineStore('session', () => {
  const sessions = ref<Map<string, Session>>(new Map())
  const selectedSessionId = ref<string | null>(null)
  const filterState = ref<SessionState | 'all' | 'needs_attention'>('all')
  const searchQuery = ref('')
  const wsConnected = ref(false)

  let ws: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let visibilityListenerAdded = false

  // ─── Computed ───

  // Tracks the stable column order when a session is selected (to freeze re-sort)
  const frozenOrder = ref<string[] | null>(null)

  const sortedSessions = computed(() => {
    // Only show pinned sessions on the board
    let list = Array.from(sessions.value.values()).filter((s) => s.pinned === true)

    // Filter by state
    if (filterState.value === 'needs_attention') {
      list = list.filter((s) => s.state === 'waiting_permission' || s.state === 'waiting_user')
    } else if (filterState.value !== 'all') {
      list = list.filter((s) => s.state === filterState.value)
    }

    // Filter by search
    if (searchQuery.value) {
      const q = searchQuery.value.toLowerCase()
      list = list.filter(
        (s) =>
          s.display_name.toLowerCase().includes(q) ||
          s.cwd.toLowerCase().includes(q) ||
          s.session_id.toLowerCase().includes(q)
      )
    }

    // If a session is selected, maintain the frozen column order to prevent
    // visual re-sorting while user is reading the detail panel (PRD §10.9)
    if (frozenOrder.value) {
      const orderMap = new Map(frozenOrder.value.map((id, i) => [id, i]))
      list.sort((a, b) => {
        const oa = orderMap.get(a.session_id) ?? 9999
        const ob = orderMap.get(b.session_id) ?? 9999
        return oa - ob
      })
      return list
    }

    // Default: sort by state priority first, then last_activity desc
    list.sort((a, b) => {
      const pa = SORT_PRIORITY[a.state]
      const pb = SORT_PRIORITY[b.state]
      if (pa !== pb) return pa - pb
      return new Date(b.last_activity).getTime() - new Date(a.last_activity).getTime()
    })

    return list
  })

  // All sessions sorted for SessionPicker (no pinned filter)
  const allSortedSessions = computed(() => {
    const list = Array.from(sessions.value.values())
    list.sort((a, b) => {
      const pa = SORT_PRIORITY[a.state]
      const pb = SORT_PRIORITY[b.state]
      if (pa !== pb) return pa - pb
      return new Date(b.last_activity).getTime() - new Date(a.last_activity).getTime()
    })
    return list
  })

  const stateCounts = computed(() => {
    const counts: Record<string, number> = {
      total: 0,
      waiting_permission: 0,
      waiting_user: 0,
      active: 0,
      inactive: 0,
      idle: 0,
      ended: 0,
    }
    for (const s of sessions.value.values()) {
      counts.total++
      counts[s.state]++
    }
    return counts
  })

  const selectedSession = computed(() => {
    if (!selectedSessionId.value) return null
    return sessions.value.get(selectedSessionId.value) || null
  })

  // ─── WebSocket ───

  function connect() {
    // On first connect, register a visibility listener so tab-unfreeze triggers immediate reconnect
    if (!visibilityListenerAdded) {
      visibilityListenerAdded = true
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          if (!ws || ws.readyState !== WebSocket.OPEN) {
            if (reconnectTimer) {
              clearTimeout(reconnectTimer)
              reconnectTimer = null
            }
            connect()
          }
        }
      })
    }

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    ws = new WebSocket(`${protocol}//${location.host}/ws`)

    ws.onopen = () => {
      wsConnected.value = true
    }

    ws.onmessage = (event) => {
      const msg: WsMessage = JSON.parse(event.data)
      handleMessage(msg)
    }

    ws.onclose = () => {
      wsConnected.value = false
      // Auto-reconnect after 2s
      reconnectTimer = setTimeout(connect, 2000)
    }

    ws.onerror = () => {
      ws?.close()
    }
  }

  function disconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer)
    ws?.close()
    ws = null
  }

  function handleMessage(msg: WsMessage) {
    switch (msg.type) {
      case 'sessions':
        sessions.value.clear()
        for (const s of msg.data) {
          sessions.value.set(s.session_id, s)
        }
        break

      case 'session_update':
        sessions.value.set(msg.data.session_id, msg.data)
        break

      case 'session_removed':
        sessions.value.delete(msg.session_id)
        if (selectedSessionId.value === msg.session_id) {
          selectedSessionId.value = null
        }
        break

      case 'new_insight': {
        const session = sessions.value.get(msg.session_id)
        if (session) {
          session.insights.unshift(msg.insight)
          session.total_insights++
          // Cap in-memory array to prevent unbounded growth
          if (session.insights.length > 200) {
            session.insights.length = 200
          }
        }
        break
      }

      case 'session_pin_update': {
        const session = sessions.value.get(msg.session_id)
        if (session) {
          session.pinned = msg.pinned
        }
        break
      }
    }
  }

  // ─── Actions ───

  function selectSession(id: string | null) {
    selectedSessionId.value = id
    if (id) {
      // Freeze current order when a session is selected
      frozenOrder.value = sortedSessions.value.map((s) => s.session_id)
    } else {
      // Release freeze when deselected
      frozenOrder.value = null
    }
  }

  function setFilter(state: SessionState | 'all' | 'needs_attention') {
    filterState.value = state
  }

  function setSearch(query: string) {
    searchQuery.value = query
  }

  async function setAlias(sessionId: string, alias: string) {
    // Optimistic update
    const s = sessions.value.get(sessionId)
    if (s) {
      s.alias = alias.trim()
      s.display_name = alias.trim() || s.display_name
    }

    await fetch(`/api/sessions/${sessionId}/alias`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alias }),
    })
    // WS session_update will sync back the canonical display_name
  }

  async function setPinned(sessionId: string, pinned: boolean) {
    // Optimistic update
    const s = sessions.value.get(sessionId)
    if (s) s.pinned = pinned

    await fetch(`/api/sessions/${sessionId}/pin`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned }),
    })
    // WS broadcast will also sync across tabs
  }

  return {
    sessions,
    selectedSessionId,
    filterState,
    searchQuery,
    wsConnected,
    frozenOrder,
    sortedSessions,
    allSortedSessions,
    stateCounts,
    selectedSession,
    connect,
    disconnect,
    selectSession,
    setFilter,
    setSearch,
    setAlias,
    setPinned,
  }
})
