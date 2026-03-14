<script setup lang="ts">
import { computed } from 'vue'
import type { Session } from '../../shared/types'
import { formatRelativeTime } from '../utils/time'

const props = defineProps<{
  session: Session
  selected: boolean
}>()

const emit = defineEmits<{
  select: []
}>()

const stateLabel = computed(() => {
  const labels: Record<string, string> = {
    active: 'Active',
    waiting_permission: 'Waiting Permission',
    waiting_user: 'Waiting User',
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
          <h2>{{ session.display_name }}</h2>
          <div class="column-subtitle">{{ session.session_id.slice(0, 8) }}</div>
        </div>
        <span class="status" :class="stateClass">{{ stateLabel }}</span>
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
          <p>{{ insight.content }}</p>
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

.insight p {
  margin: 0;
  line-height: 1.65;
  color: #e7ecfa;
  font-size: 14px;
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
