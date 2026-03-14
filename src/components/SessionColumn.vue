<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Session } from '../../shared/types'
import { formatRelativeTime } from '../utils/time'
import { renderMarkdown } from '../utils/markdown'
import { useSessionStore } from '../stores/session'

const props = defineProps<{
  session: Session
  selected: boolean
}>()

const emit = defineEmits<{
  select: []
}>()

const store = useSessionStore()
const isEditingAlias = ref(false)
const editValue = ref('')

function startEdit(e: MouseEvent) {
  e.stopPropagation()
  editValue.value = props.session.alias || ''
  isEditingAlias.value = true
}

function confirmEdit() {
  isEditingAlias.value = false
  store.setAlias(props.session.session_id, editValue.value)
}

function cancelEdit() {
  isEditingAlias.value = false
}

function onEditKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') confirmEdit()
  else if (e.key === 'Escape') cancelEdit()
  e.stopPropagation()
}

const stateLabel = computed(() => {
  const labels: Record<string, string> = {
    active: 'Active',
    waiting_permission: 'Waiting Permission',
    waiting_user: 'Waiting User',
    inactive: 'Inactive',
    idle: 'Idle',
    ended: 'Ended',
  }
  return labels[props.session.state] || props.session.state
})

const stateClass = computed(() => {
  return props.session.state.replace('_', '-')
})

const relativeTime = computed(() => {
  return formatRelativeTime(props.session.last_activity)
})
</script>

<template>
  <article
    class="column"
    :class="{ selected }"
    @click="emit('select')"
  >
    <header class="column-header">
      <div class="column-topline">
        <div class="column-title">
          <div class="column-name-row">
            <input
              v-if="isEditingAlias"
              class="alias-input"
              v-model="editValue"
              @keydown="onEditKeydown"
              @blur="confirmEdit"
              @click.stop
              autofocus
              placeholder="输入别名…"
            />
            <h2 v-else>{{ session.display_name }}</h2>
            <button v-if="!isEditingAlias" class="alias-edit-btn" @click="startEdit" title="设置别名">✎</button>
          </div>
          <div class="column-subtitle">{{ session.session_id.slice(0, 8) }}</div>
        </div>
        <div class="badges">
          <span class="source-badge" :class="session.source">{{ session.source === 'codex' ? 'Codex' : 'Claude' }}</span>
          <span class="status" :class="stateClass">{{ stateLabel }}</span>
        </div>
      </div>
      <div class="meta-grid">
        <div class="meta-card">
          <span class="meta-label">Recently Active</span>
          <span class="meta-value">{{ relativeTime }}</span>
        </div>
        <div class="meta-card">
          <span class="meta-label">Context</span>
          <span class="meta-value">{{ session.cwd || 'N/A' }}</span>
        </div>
      </div>
    </header>

    <div class="insights">
      <template v-if="session.insights.length > 0">
        <article
          v-for="(insight, index) in session.insights"
          :key="insight.id"
          class="insight"
        >
          <div class="insight-head">
            <span class="insight-tag">{{ index === 0 ? 'Latest Insight' : 'Insight' }}</span>
            <span class="insight-time">{{ formatRelativeTime(insight.timestamp) }}</span>
          </div>
          <div class="insight-body md-content" v-html="renderMarkdown(insight.content)" />
        </article>
      </template>
      <div v-else class="empty-state">
        Waiting for first insight
      </div>
    </div>
  </article>
</template>

<style scoped>
.column {
  width: var(--column-width);
  min-width: var(--column-width);
  height: var(--column-height);
  background: linear-gradient(180deg, rgba(16, 22, 45, 0.98), rgba(12, 17, 34, 0.94));
  border: 1px solid var(--border);
  border-radius: 20px;
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  scroll-snap-align: start;
  cursor: pointer;
  transition: border-color 0.2s;
}

.column:hover {
  border-color: rgba(255, 255, 255, 0.15);
}

.column.selected {
  border-color: var(--accent);
}

.column-header {
  padding: 18px 18px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.02), rgba(255, 255, 255, 0));
}

.column-topline {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 12px;
}

.column-title {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  flex: 1;
}

.column-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.column-name-row h2 {
  margin: 0;
  font-size: 17px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.alias-edit-btn {
  flex-shrink: 0;
  opacity: 0;
  background: none;
  border: none;
  color: var(--muted);
  cursor: pointer;
  font-size: 14px;
  padding: 2px 5px;
  border-radius: 6px;
  line-height: 1;
  transition: opacity 0.15s, background 0.15s;
}

.column-header:hover .alias-edit-btn {
  opacity: 1;
}

.alias-edit-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text);
}

.alias-input {
  flex: 1;
  min-width: 0;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--accent);
  border-radius: 8px;
  color: var(--text);
  font-size: 15px;
  font-weight: 600;
  padding: 3px 8px;
  outline: none;
}

.column-title h2 {
  margin: 0;
  font-size: 17px;
}

.column-subtitle {
  color: var(--muted);
  font-size: 13px;
  font-family: monospace;
}

.badges {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  flex-shrink: 0;
}

.source-badge {
  font-size: 10px;
  padding: 3px 8px;
  border-radius: 999px;
  font-weight: 600;
  letter-spacing: 0.03em;
}

.source-badge.claude {
  background: rgba(96, 165, 250, 0.14);
  color: #93c5fd;
  border: 1px solid rgba(96, 165, 250, 0.25);
}

.source-badge.codex {
  background: rgba(74, 222, 128, 0.14);
  color: #86efac;
  border: 1px solid rgba(74, 222, 128, 0.25);
}

/* Status badges */
.status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  border: 1px solid transparent;
  white-space: nowrap;
}

.status.waiting-permission {
  background: rgba(245, 158, 11, 0.14);
  color: #ffd38a;
  border-color: rgba(245, 158, 11, 0.32);
}

.status.waiting-user {
  background: rgba(124, 156, 255, 0.16);
  color: #c8d5ff;
  border-color: rgba(124, 156, 255, 0.34);
}

.status.active {
  background: rgba(94, 234, 212, 0.14);
  color: #b8fff4;
  border-color: rgba(94, 234, 212, 0.26);
}

.status.inactive {
  background: rgba(148, 163, 184, 0.14);
  color: #cbd5e1;
  border-color: rgba(148, 163, 184, 0.24);
}

.status.idle {
  background: rgba(100, 116, 139, 0.18);
  color: #d6deed;
  border-color: rgba(148, 163, 184, 0.22);
}

.status.ended {
  background: rgba(148, 163, 184, 0.16);
  color: #dbe5f3;
  border-color: rgba(148, 163, 184, 0.24);
}

/* Meta cards */
.meta-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 10px;
}

.meta-card {
  display: grid;
  gap: 4px;
  padding: 12px 13px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.05);
}

.meta-label {
  font-size: 11px;
  letter-spacing: 0.05em;
  color: var(--muted);
  text-transform: uppercase;
}

.meta-value {
  font-size: 13px;
  line-height: 1.45;
  word-break: break-all;
}

/* Insights */
.insights {
  flex: 1;
  overflow-y: auto;
  padding: 16px 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.insight {
  display: grid;
  gap: 10px;
  padding: 14px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.insight-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.insight-time {
  font-size: 12px;
  color: var(--muted);
}

.insight-tag {
  font-size: 11px;
  padding: 5px 8px;
  border-radius: 999px;
  background: rgba(124, 156, 255, 0.14);
  color: #cad7ff;
  border: 1px solid rgba(124, 156, 255, 0.24);
}

.insight-body {
  margin-top: 6px;
  min-width: 0; /* prevent grid item from expanding beyond cell width */
}

:deep(.md-content) {
  font-size: 14px;
  line-height: 1.65;
  color: #e7ecfa;
}

:deep(.md-content > *:first-child) { margin-top: 0; }
:deep(.md-content > *:last-child) { margin-bottom: 0; }

:deep(.md-content p) {
  margin: 0 0 8px;
}

:deep(.md-content h1),
:deep(.md-content h2),
:deep(.md-content h3) {
  margin: 10px 0 6px;
  font-size: 14px;
  font-weight: 700;
  color: #fff;
}

:deep(.md-content ul),
:deep(.md-content ol) {
  margin: 4px 0 8px;
  padding-left: 18px;
}

:deep(.md-content li) {
  margin-bottom: 3px;
}

:deep(.md-content code) {
  font-family: monospace;
  font-size: 12px;
  background: rgba(124, 156, 255, 0.12);
  border: 1px solid rgba(124, 156, 255, 0.18);
  border-radius: 4px;
  padding: 1px 5px;
  color: #c8d5ff;
}

:deep(.md-content pre) {
  margin: 8px 0;
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
  font-size: 12px;
  color: #c8d5ff;
}

:deep(.md-content blockquote) {
  margin: 6px 0;
  padding: 4px 12px;
  border-left: 3px solid rgba(124, 156, 255, 0.4);
  color: var(--muted);
  font-style: italic;
}

:deep(.md-content strong) { color: #fff; }

:deep(.md-content hr) {
  border: none;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  margin: 8px 0;
}

:deep(.md-content .md-table-wrap) {
  overflow-x: auto;
  max-width: 100%;
  margin: 8px 0;
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
  padding: 5px 10px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  text-align: left;
  white-space: nowrap;
}

:deep(.md-content th) {
  background: rgba(255, 255, 255, 0.05);
  color: var(--muted);
  font-weight: 600;
}

.empty-state {
  margin-top: auto;
  min-height: 180px;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: var(--muted);
  border: 1px dashed rgba(255, 255, 255, 0.08);
  border-radius: 16px;
  padding: 18px;
  background: rgba(255, 255, 255, 0.02);
}
</style>
