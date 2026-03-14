<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { useSessionStore } from '../stores/session'
import type { SessionEvent } from '../../shared/types'
import { formatRelativeTime } from '../utils/time'
import { renderMarkdown } from '../utils/markdown'

const store = useSessionStore()

// Alias inline edit
const isEditingAlias = ref(false)
const aliasEditValue = ref('')

function startAliasEdit() {
  aliasEditValue.value = store.selectedSession?.alias || ''
  isEditingAlias.value = true
}

function confirmAliasEdit() {
  isEditingAlias.value = false
  if (store.selectedSession) {
    store.setAlias(store.selectedSession.session_id, aliasEditValue.value)
  }
}

function cancelAliasEdit() {
  isEditingAlias.value = false
}

watch(() => store.selectedSessionId, () => {
  isEditingAlias.value = false
})
const events = ref<SessionEvent[]>([])
const loading = ref(false)
const loadError = ref(false)

const insightsExpanded = ref(true)
const eventsExpanded = ref(true)

// Reverse chronological (newest first)
const reversedEvents = computed(() => [...events.value].reverse())

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
          <div class="info-item alias-item">
            <span class="info-label">Alias</span>
            <div class="alias-row">
              <input
                v-if="isEditingAlias"
                class="alias-input"
                v-model="aliasEditValue"
                @keydown.enter="confirmAliasEdit"
                @keydown.escape="cancelAliasEdit"
                @blur="confirmAliasEdit"
                autofocus
                placeholder="输入别名，回车保存…"
              />
              <template v-else>
                <span class="info-value alias-value" :class="{ placeholder: !store.selectedSession.alias }">
                  {{ store.selectedSession.alias || '未设置' }}
                </span>
                <button class="alias-edit-btn" @click="startAliasEdit">编辑</button>
              </template>
            </div>
          </div>
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
        <h3 class="section-header" @click="insightsExpanded = !insightsExpanded">
          <span>Insights ({{ store.selectedSession.insights.length }})</span>
          <span class="toggle-icon">{{ insightsExpanded ? '▾' : '▸' }}</span>
        </h3>
        <div v-if="insightsExpanded" class="timeline">
          <div
            v-for="insight in store.selectedSession.insights"
            :key="insight.id"
            class="timeline-item insight-item"
          >
            <span class="timeline-time">{{ formatRelativeTime(insight.timestamp) }}</span>
            <div class="md-content" v-html="renderMarkdown(insight.content)" />
          </div>
          <div v-if="store.selectedSession.insights.length === 0" class="empty-hint">
            No insights yet
          </div>
        </div>
      </section>

      <!-- Event timeline -->
      <section class="info-section">
        <h3 class="section-header" @click="eventsExpanded = !eventsExpanded">
          <span>Event Timeline ({{ events.length }})</span>
          <span class="toggle-icon">{{ eventsExpanded ? '▾' : '▸' }}</span>
        </h3>
        <template v-if="eventsExpanded">
          <div v-if="loading" class="empty-hint">Loading...</div>
          <div v-else-if="loadError" class="empty-hint error-hint">
            Failed to load events
          </div>
          <div v-else class="timeline">
            <div
              v-for="event in reversedEvents"
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
        </template>
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

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: pointer;
  user-select: none;
  border-radius: 8px;
  padding: 4px 6px;
  margin-left: -6px;
  margin-right: -6px;
  transition: background 0.1s;
}

.section-header:hover {
  background: rgba(255, 255, 255, 0.04);
}

.toggle-icon {
  font-size: 12px;
  opacity: 0.5;
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


:deep(.md-content) {
  margin-top: 8px;
  font-size: 13px;
  line-height: 1.6;
  color: #e7ecfa;
}

:deep(.md-content > *:first-child) { margin-top: 0; }
:deep(.md-content > *:last-child) { margin-bottom: 0; }

:deep(.md-content p) { margin: 0 0 6px; }

:deep(.md-content h1),
:deep(.md-content h2),
:deep(.md-content h3) {
  margin: 8px 0 4px;
  font-size: 13px;
  font-weight: 700;
  color: #fff;
}

:deep(.md-content ul),
:deep(.md-content ol) {
  margin: 4px 0 6px;
  padding-left: 18px;
}

:deep(.md-content li) { margin-bottom: 2px; }

:deep(.md-content code) {
  font-family: monospace;
  font-size: 11px;
  background: rgba(124, 156, 255, 0.12);
  border: 1px solid rgba(124, 156, 255, 0.18);
  border-radius: 4px;
  padding: 1px 5px;
  color: #c8d5ff;
}

:deep(.md-content pre) {
  margin: 6px 0;
  padding: 10px 12px;
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 8px;
  overflow-x: auto;
}

:deep(.md-content pre code) {
  background: none;
  border: none;
  padding: 0;
  font-size: 11px;
  color: #c8d5ff;
}

:deep(.md-content blockquote) {
  margin: 4px 0;
  padding: 3px 10px;
  border-left: 3px solid rgba(124, 156, 255, 0.4);
  color: var(--muted);
  font-style: italic;
}

:deep(.md-content strong) { color: #fff; }

:deep(.md-content hr) {
  border: none;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  margin: 6px 0;
}

:deep(.md-content .md-table-wrap) {
  overflow-x: auto;
  max-width: 100%;
  margin: 6px 0;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.08);
}

:deep(.md-content table) {
  border-collapse: collapse;
  font-size: 12px;
  min-width: 100%;
  margin: 0;
}

:deep(.md-content th),
:deep(.md-content td) {
  padding: 4px 10px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  text-align: left;
  white-space: nowrap;
}

:deep(.md-content th) {
  background: rgba(255, 255, 255, 0.05);
  color: var(--muted);
  font-weight: 600;
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

.alias-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.alias-value {
  flex: 1;
}

.alias-value.placeholder {
  color: var(--muted);
  font-style: italic;
}

.alias-edit-btn {
  flex-shrink: 0;
  padding: 3px 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.04);
  color: var(--muted);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s;
}

.alias-edit-btn:hover {
  background: rgba(124, 156, 255, 0.1);
  border-color: rgba(124, 156, 255, 0.3);
  color: var(--accent);
}

.alias-input {
  flex: 1;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--accent);
  border-radius: 8px;
  color: var(--text);
  font-size: 13px;
  padding: 4px 8px;
  outline: none;
}

.empty-hint {
  color: var(--muted);
  font-size: 13px;
  padding: 12px;
  text-align: center;
}
</style>
