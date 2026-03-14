<script setup lang="ts">
import { ref, watch } from 'vue'
import { useSessionStore } from '../stores/session'
import type { SessionEvent } from '../../shared/types'
import { formatRelativeTime } from '../utils/time'

const store = useSessionStore()
const events = ref<SessionEvent[]>([])
const loading = ref(false)
const loadError = ref(false)

watch(
  () => store.selectedSessionId,
  async (id) => {
    if (!id) {
      events.value = []
      loadError.value = false
      return
    }
    loading.value = true
    loadError.value = false
    try {
      const res = await fetch(`/api/sessions/${id}/events`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      events.value = json.data || []
    } catch {
      events.value = []
      loadError.value = true
    }
    loading.value = false
  },
  { immediate: true }
)
</script>

<template>
  <aside class="detail-panel" v-if="store.selectedSession">
    <div class="panel-header">
      <h2>Session Detail</h2>
      <button class="close-btn" @click="store.selectSession(null)">Close</button>
    </div>

    <div class="panel-body">
      <!-- Basic info -->
      <section class="info-section">
        <h3>Info</h3>
        <div class="info-grid">
          <div class="info-item">
            <span class="info-label">Session ID</span>
            <span class="info-value mono">{{ store.selectedSession.session_id }}</span>
          </div>
          <div class="info-item">
            <span class="info-label">CWD</span>
            <span class="info-value">{{ store.selectedSession.cwd }}</span>
          </div>
          <div class="info-item" v-if="store.selectedSession.transcript_path">
            <span class="info-label">Transcript</span>
            <span class="info-value mono small">{{ store.selectedSession.transcript_path }}</span>
          </div>
          <div class="info-item">
            <span class="info-label">State</span>
            <span class="info-value">{{ store.selectedSession.state }}</span>
          </div>
          <div class="info-item">
            <span class="info-label">Last Activity</span>
            <span class="info-value">{{ formatRelativeTime(store.selectedSession.last_activity) }}</span>
          </div>
        </div>
      </section>

      <!-- Insights -->
      <section class="info-section">
        <h3>Insights ({{ store.selectedSession.insights.length }})</h3>
        <div class="timeline">
          <div
            v-for="insight in store.selectedSession.insights"
            :key="insight.id"
            class="timeline-item insight-item"
          >
            <div class="insight-meta">
              <span class="timeline-time">{{ formatRelativeTime(insight.timestamp) }}</span>
              <span class="source-badge" :class="insight.source">{{ insight.source }}</span>
            </div>
            <p>{{ insight.content }}</p>
          </div>
          <div v-if="store.selectedSession.insights.length === 0" class="empty-hint">
            No insights yet
          </div>
        </div>
      </section>

      <!-- Event timeline -->
      <section class="info-section">
        <h3>Event Timeline ({{ events.length }})</h3>
        <div v-if="loading" class="empty-hint">Loading...</div>
        <div v-else-if="loadError" class="empty-hint error-hint">
          Failed to load events
        </div>
        <div v-else class="timeline">
          <div
            v-for="event in events"
            :key="event.id"
            class="timeline-item event-item"
          >
            <span class="timeline-time">{{ formatRelativeTime(event.timestamp) }}</span>
            <span class="event-name">{{ event.event_name }}</span>
            <span v-if="event.tool_name" class="event-detail">tool: {{ event.tool_name }}</span>
            <span v-if="event.notification_type" class="event-detail">{{ event.notification_type }}</span>
          </div>
          <div v-if="events.length === 0 && !loading" class="empty-hint">
            No events recorded
          </div>
        </div>
      </section>
    </div>
  </aside>
</template>

<style scoped>
.detail-panel {
  position: fixed;
  top: 0;
  right: 0;
  width: 420px;
  height: 100vh;
  background: var(--panel-2);
  border-left: 1px solid var(--border);
  box-shadow: -10px 0 40px rgba(0, 0, 0, 0.3);
  display: flex;
  flex-direction: column;
  z-index: 100;
  overflow: hidden;
}

.panel-header {
  padding: 20px 24px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid var(--border);
}

.panel-header h2 {
  margin: 0;
  font-size: 18px;
}

.close-btn {
  padding: 6px 14px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.06);
  color: var(--muted);
  cursor: pointer;
  font-size: 13px;
}

.close-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text);
}

.panel-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.info-section h3 {
  margin: 0 0 12px;
  font-size: 14px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.info-grid {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.info-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.05);
}

.info-label {
  font-size: 11px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.info-value {
  font-size: 13px;
  word-break: break-all;
}

.info-value.mono {
  font-family: monospace;
}

.info-value.small {
  font-size: 11px;
}

/* Timeline */
.timeline {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.timeline-item {
  padding: 10px 12px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.05);
}

.timeline-time {
  font-size: 11px;
  color: var(--muted);
}

.insight-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

.source-badge {
  font-size: 10px;
  padding: 2px 7px;
  border-radius: 999px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.source-badge.transcript {
  background: rgba(94, 234, 212, 0.12);
  color: #7fffed;
  border: 1px solid rgba(94, 234, 212, 0.2);
}

.source-badge.hook {
  background: rgba(124, 156, 255, 0.12);
  color: #a5bdff;
  border: 1px solid rgba(124, 156, 255, 0.2);
}

.insight-item p {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.6;
  color: #e7ecfa;
}

.error-hint {
  color: var(--danger) !important;
}

.event-item {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.event-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--accent);
}

.event-detail {
  font-size: 12px;
  color: var(--muted);
  padding: 2px 8px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.05);
}

.empty-hint {
  color: var(--muted);
  font-size: 13px;
  padding: 12px;
  text-align: center;
}
</style>
