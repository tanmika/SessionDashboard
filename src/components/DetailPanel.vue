<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { useSessionStore } from '../stores/session'
import { usePreferencesStore } from '../stores/preferences'
import type {
  SessionEvent,
  Insight,
  SessionExportData,
  SessionExportMissingSession,
} from '../../shared/types'
import { formatRelativeTime } from '../utils/time'
import { renderMarkdown } from '../utils/markdown'

const store = useSessionStore()
const prefs = usePreferencesStore()
const PAGE_SIZE = 100
let eventsRequestToken = 0
let insightsRequestToken = 0

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

function openExportModal() {
  exportModalOpen.value = true
  exportBusy.value = false
  exportAllDepth.value = false
  exportDepth.value = 1
  exportError.value = ''
  exportMissingSessions.value = []
}

function closeExportModal() {
  exportModalOpen.value = false
  exportBusy.value = false
  exportError.value = ''
  exportMissingSessions.value = []
}

function getExportDepth(): number | 'all' {
  return exportAllDepth.value ? 'all' : Math.max(0, Math.floor(exportDepth.value || 0))
}

async function requestExport(mode: 'conversation' | 'insights'): Promise<SessionExportData | null> {
  const id = store.selectedSessionId
  if (!id) return null

  const depth = getExportDepth()
  const params = new URLSearchParams({
    mode,
    depth: depth === 'all' ? 'all' : String(depth),
  })

  exportBusy.value = true
  exportError.value = ''
  exportMissingSessions.value = []
  try {
    const res = await fetch(`/api/sessions/${id}/export?${params.toString()}`)
    const json = await res.json()
    if (!res.ok) {
      exportError.value = json.error || 'Export failed.'
      exportMissingSessions.value = json.detail?.missing_sessions || []
      return null
    }
    return json.data as SessionExportData
  } catch {
    exportError.value = 'Export request failed.'
    return null
  } finally {
    exportBusy.value = false
  }
}

function downloadTextFile(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

async function downloadExport(mode: 'conversation' | 'insights') {
  const data = await requestExport(mode)
  if (!data) return
  downloadTextFile(data.filename, data.content)
  closeExportModal()
}

async function copyExport(mode: 'conversation' | 'insights') {
  const data = await requestExport(mode)
  if (!data) return
  try {
    await navigator.clipboard.writeText(data.content)
    closeExportModal()
  } catch {
    exportError.value = 'Copy to clipboard failed.'
  }
}

// ─── Events pagination ───

const events = ref<SessionEvent[]>([])
const loading = ref(false)
const loadError = ref(false)
const totalEvents = ref(0)
const loadingMoreEvents = ref(false)
const allEventsLoaded = ref(false)

const insightsExpanded = ref(true)
const eventsExpanded = ref(true)
const exportModalOpen = ref(false)
const exportBusy = ref(false)
const exportAllDepth = ref(false)
const exportDepth = ref(1)
const exportError = ref('')
const exportMissingSessions = ref<SessionExportMissingSession[]>([])

const hasMoreEvents = computed(() =>
  !allEventsLoaded.value && events.value.length < totalEvents.value
)

async function loadMoreEvents() {
  const id = store.selectedSessionId
  if (!id || loadingMoreEvents.value) return
  const requestToken = eventsRequestToken
  const offset = events.value.length
  loadingMoreEvents.value = true
  try {
    const res = await fetch(`/api/sessions/${id}/events?limit=${PAGE_SIZE}&offset=${offset}`)
    const json = await res.json()
    if (requestToken !== eventsRequestToken || store.selectedSessionId !== id) return
    const newEvents = json.data || []
    events.value.push(...newEvents)
    if (newEvents.length < PAGE_SIZE) allEventsLoaded.value = true
  } catch { /* ignore */ }
  finally {
    if (requestToken === eventsRequestToken) {
      loadingMoreEvents.value = false
    }
  }
}

// ─── Insights pagination ───

const extraInsights = ref<Insight[]>([])
const loadingMoreInsights = ref(false)
const allInsightsLoaded = ref(false)
const totalInsights = ref(0)

const allInsights = computed(() => {
  if (!store.selectedSession) return []
  return [...store.selectedSession.insights, ...extraInsights.value]
})

const displayedInsights = computed(() => {
  if (prefs.showUserPrompts) return allInsights.value
  return allInsights.value.filter(ins => ins.source !== 'user')
})

const hasMoreInsights = computed(() =>
  !allInsightsLoaded.value &&
  store.selectedSession != null &&
  totalInsights.value > displayedInsights.value.length
)

async function loadMoreInsights() {
  const id = store.selectedSessionId
  if (!id || loadingMoreInsights.value) return
  const requestToken = insightsRequestToken
  const showUserPrompts = prefs.showUserPrompts
  const offset = showUserPrompts ? allInsights.value.length : displayedInsights.value.length
  loadingMoreInsights.value = true
  try {
    let url = `/api/sessions/${id}/insights?limit=${PAGE_SIZE}&offset=${offset}`
    if (!showUserPrompts) url += '&exclude_source=user'
    const res = await fetch(url)
    const json = await res.json()
    if (
      requestToken !== insightsRequestToken ||
      store.selectedSessionId !== id ||
      prefs.showUserPrompts !== showUserPrompts
    ) {
      return
    }
    const newInsights = json.data || []
    totalInsights.value = json.total ?? totalInsights.value
    extraInsights.value.push(...newInsights)
    if (displayedInsights.value.length >= totalInsights.value) {
      allInsightsLoaded.value = true
    } else if (newInsights.length < PAGE_SIZE) {
      allInsightsLoaded.value = true
    }
  } catch { /* ignore */ }
  finally {
    if (requestToken === insightsRequestToken) {
      loadingMoreInsights.value = false
    }
  }
}

// ─── Session change: reset pagination & load events ───

watch(
  () => store.selectedSessionId,
  async (id) => {
    const requestToken = ++eventsRequestToken

    // Reset alias edit
    isEditingAlias.value = false

    // Reset insights pagination
    extraInsights.value = []
    allInsightsLoaded.value = false
    loadingMoreInsights.value = false
    totalInsights.value = store.selectedSession?.total_insights ?? 0

    // Reset events pagination & load first page
    events.value = []
    totalEvents.value = 0
    allEventsLoaded.value = false
    loadingMoreEvents.value = false
    loadError.value = false

    if (!id) {
      loading.value = false
      return
    }

    loading.value = true
    try {
      const res = await fetch(`/api/sessions/${id}/events?limit=${PAGE_SIZE}&offset=0`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      if (requestToken !== eventsRequestToken || store.selectedSessionId !== id) return
      events.value = json.data || []
      totalEvents.value = json.total ?? 0
      allEventsLoaded.value = events.value.length >= totalEvents.value
    } catch {
      if (requestToken !== eventsRequestToken || store.selectedSessionId !== id) return
      events.value = []
      loadError.value = true
    }
    finally {
      if (requestToken === eventsRequestToken) {
        loading.value = false
      }
    }
  },
  { immediate: true }
)

watch(
  () => [store.selectedSessionId, prefs.showUserPrompts] as const,
  async ([id]) => {
    const requestToken = ++insightsRequestToken

    totalInsights.value = prefs.showUserPrompts
      ? (store.selectedSession?.total_insights ?? 0)
      : displayedInsights.value.length

    if (!id || prefs.showUserPrompts) return

    try {
      const res = await fetch(`/api/sessions/${id}/insights?limit=0&offset=0&exclude_source=user`)
      const json = await res.json()
      if (
        requestToken !== insightsRequestToken ||
        store.selectedSessionId !== id ||
        prefs.showUserPrompts
      ) {
        return
      }
      totalInsights.value = json.total ?? totalInsights.value
      allInsightsLoaded.value = displayedInsights.value.length >= totalInsights.value
    } catch { /* ignore */ }
  },
  { immediate: true }
)
</script>

<template>
  <aside class="detail-panel" v-if="store.selectedSession">
    <div class="panel-header">
      <h2>Session Detail</h2>
      <div class="panel-actions">
        <button class="export-btn" @click="openExportModal">Export</button>
        <button class="close-btn" @click="store.selectSession(null)">Close</button>
      </div>
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
            <span class="info-label">Source</span>
            <span class="info-value">{{ store.selectedSession.source === 'codex' ? 'Codex CLI' : 'Claude Code' }}</span>
          </div>
          <div class="info-item">
            <span class="info-label">Kind</span>
            <span class="info-value">{{ store.selectedSession.is_subagent ? '子代理' : '主会话' }}</span>
          </div>
          <div class="info-item" v-if="store.selectedSession.parent_session_id">
            <span class="info-label">Parent Session</span>
            <span
              class="info-value mono predecessor-link"
              @click="store.selectSession(store.selectedSession!.parent_session_id!)"
            >{{ store.selectedSession.parent_session_id.slice(0, 8) }}… ↗</span>
          </div>
          <div class="info-item">
            <span class="info-label">State</span>
            <span class="info-value">{{ store.selectedSession.state }}</span>
          </div>
          <div class="info-item">
            <span class="info-label">Last Activity</span>
            <span class="info-value">{{ formatRelativeTime(store.selectedSession.last_activity) }}</span>
          </div>
          <div class="info-item" v-if="store.selectedSession.predecessor_id">
            <span class="info-label">Predecessor</span>
            <span
              class="info-value mono predecessor-link"
              @click="store.selectSession(store.selectedSession!.predecessor_id!)"
            >{{ store.selectedSession.predecessor_id.slice(0, 8) }}… ↗</span>
          </div>
        </div>
      </section>

      <!-- Insights -->
      <section class="info-section">
        <h3 class="section-header" @click="insightsExpanded = !insightsExpanded">
          <span>Insights ({{ displayedInsights.length }}{{ store.selectedSession.total_insights > displayedInsights.length ? ` / ${store.selectedSession.total_insights}` : '' }})</span>
          <span class="toggle-icon">{{ insightsExpanded ? '▾' : '▸' }}</span>
        </h3>
        <div v-if="insightsExpanded">
          <div class="timeline">
          <div
            v-for="insight in displayedInsights"
            :key="insight.id"
            class="timeline-item insight-item"
            :class="{ 'user-prompt-item': insight.source === 'user' }"
          >
            <div class="insight-header">
              <span class="timeline-time">{{ formatRelativeTime(insight.timestamp) }}</span>
              <span v-if="insight.source === 'user'" class="source-tag user-tag">user</span>
            </div>
            <div class="md-content" v-html="renderMarkdown(insight.content)" />
          </div>
          <div v-if="displayedInsights.length === 0" class="empty-hint">
            No insights yet
          </div>
          <button v-if="hasMoreInsights" class="load-more-btn" @click="loadMoreInsights" :disabled="loadingMoreInsights">
            {{ loadingMoreInsights ? '加载中...' : '加载更多' }}
          </button>
          </div>
        </div>
      </section>

      <!-- Event timeline -->
      <section class="info-section">
        <h3 class="section-header" @click="eventsExpanded = !eventsExpanded">
          <span>Event Timeline ({{ events.length }}{{ totalEvents > events.length ? ` / ${totalEvents}` : '' }})</span>
          <span class="toggle-icon">{{ eventsExpanded ? '▾' : '▸' }}</span>
        </h3>
        <template v-if="eventsExpanded">
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
            <button v-if="hasMoreEvents" class="load-more-btn" @click="loadMoreEvents" :disabled="loadingMoreEvents">
              {{ loadingMoreEvents ? '加载中...' : '加载更多' }}
            </button>
          </div>
        </template>
      </section>
    </div>
  </aside>

  <Teleport to="body">
    <div v-if="exportModalOpen" class="export-overlay" @click.self="closeExportModal">
      <div class="export-modal">
        <div class="export-modal-header">
          <h3>Export Session</h3>
          <button class="close-btn" @click="closeExportModal">Close</button>
        </div>

        <div class="export-body">
          <label class="export-option">
            <span class="info-label">Predecessor Depth</span>
            <div class="export-depth-row">
              <input
                type="number"
                min="0"
                class="export-depth-input"
                v-model.number="exportDepth"
                :disabled="exportAllDepth"
              />
              <label class="export-all-toggle">
                <input type="checkbox" v-model="exportAllDepth" />
                <span>All</span>
              </label>
            </div>
            <span class="export-hint">`0` = current only, `1` = current + 1 predecessor</span>
          </label>

          <div class="export-actions">
            <button class="export-action primary" :disabled="exportBusy" @click="downloadExport('conversation')">
              {{ exportBusy ? '处理中...' : 'Download Conversation' }}
            </button>
            <button class="export-action" :disabled="exportBusy" @click="copyExport('conversation')">
              Copy Conversation
            </button>
          </div>

          <div v-if="exportError" class="export-warning">
            <div class="warning-title">Conversation export unavailable</div>
            <div class="warning-text">{{ exportError }}</div>
            <div v-if="exportMissingSessions.length > 0" class="warning-list">
              <div
                v-for="missing in exportMissingSessions"
                :key="missing.session_id"
                class="warning-item"
              >
                <div class="mono">{{ missing.session_id.slice(0, 12) }} · {{ missing.display_name }}</div>
                <div>{{ missing.reason }}</div>
              </div>
            </div>
            <div class="export-actions">
              <button class="export-action primary" :disabled="exportBusy" @click="downloadExport('insights')">
                Download Insight Fallback
              </button>
              <button class="export-action" :disabled="exportBusy" @click="copyExport('insights')">
                Copy Insight Fallback
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
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

.panel-actions {
  display: flex;
  gap: 8px;
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

.export-btn {
  padding: 6px 14px;
  border-radius: 8px;
  border: 1px solid rgba(124, 156, 255, 0.28);
  background: rgba(124, 156, 255, 0.14);
  color: #eef3ff;
  cursor: pointer;
  font-size: 13px;
}

.export-btn:hover {
  background: rgba(124, 156, 255, 0.2);
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

.predecessor-link {
  color: var(--accent);
  cursor: pointer;
  transition: opacity 0.15s;
}

.predecessor-link:hover {
  opacity: 0.75;
}

.info-value.mono {
  font-family: monospace;
}

.info-value.small {
  font-size: 11px;
}

.export-overlay {
  position: fixed;
  inset: 0;
  background: rgba(6, 10, 18, 0.68);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 150;
  padding: 20px;
}

.export-modal {
  width: min(520px, 100%);
  border-radius: 18px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
}

.export-modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 18px 20px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.export-modal-header h3 {
  margin: 0;
  font-size: 16px;
  color: var(--text);
}

.export-body {
  padding: 18px 20px 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.export-option {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.export-depth-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.export-depth-input {
  width: 96px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.04);
  color: var(--text);
}

.export-all-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text);
  font-size: 13px;
}

.export-hint {
  color: var(--muted);
  font-size: 12px;
}

.export-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.export-action {
  padding: 10px 14px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.06);
  color: var(--text);
  cursor: pointer;
}

.export-action.primary {
  background: linear-gradient(135deg, rgba(124, 156, 255, 0.28), rgba(84, 211, 194, 0.18));
  border-color: rgba(124, 156, 255, 0.3);
}

.export-action:disabled {
  opacity: 0.55;
  cursor: default;
}

.export-warning {
  border-radius: 14px;
  padding: 14px;
  background: rgba(255, 184, 77, 0.08);
  border: 1px solid rgba(255, 184, 77, 0.22);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.warning-title {
  font-weight: 600;
  color: #ffd89b;
}

.warning-text {
  color: var(--text);
  font-size: 13px;
}

.warning-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.warning-item {
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.14);
  font-size: 12px;
  color: var(--muted);
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

.user-prompt-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--muted);
  cursor: pointer;
  margin-bottom: 8px;
  user-select: none;
}

.user-prompt-toggle input {
  accent-color: var(--accent);
}

.user-prompt-item {
  background: rgba(255, 180, 50, 0.06) !important;
  border-color: rgba(255, 180, 50, 0.15) !important;
}

.insight-header {
  display: flex;
  align-items: center;
  gap: 6px;
}

.source-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.user-tag {
  background: rgba(255, 180, 50, 0.15);
  color: #f0b040;
}

.load-more-btn {
  width: 100%;
  padding: 8px 0;
  border-radius: 10px;
  border: 1px dashed rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.03);
  color: var(--accent);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
}

.load-more-btn:hover:not(:disabled) {
  background: rgba(124, 156, 255, 0.08);
  border-color: rgba(124, 156, 255, 0.3);
}

.load-more-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.empty-hint {
  color: var(--muted);
  font-size: 13px;
  padding: 12px;
  text-align: center;
}
</style>
