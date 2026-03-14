<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useSessionStore } from '../stores/session'

const store = useSessionStore()
const showPanel = ref(false)
const btnRef = ref<HTMLElement | null>(null)
const panelRef = ref<HTMLElement | null>(null)
const panelStyle = ref<Record<string, string>>({})

// Sessions split into pinned (top) and unpinned (bottom)
const pinnedSessions = computed(() => store.allSortedSessions.filter((s) => s.pinned))
const unpinnedSessions = computed(() => store.allSortedSessions.filter((s) => !s.pinned))

// Count of unpinned active/waiting sessions for the badge
const unpinnedAttentionCount = computed(() =>
  store.allSortedSessions.filter(
    (s) => !s.pinned && (s.state === 'active' || s.state === 'waiting_permission' || s.state === 'waiting_user')
  ).length
)

function stateColor(state: string): string {
  switch (state) {
    case 'active': return 'var(--accent)'
    case 'waiting_permission': return 'var(--danger)'
    case 'waiting_user': return '#f5c842'
    case 'idle': return 'var(--muted)'
    case 'ended': return 'rgba(255,255,255,0.15)'
    default: return 'var(--muted)'
  }
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function togglePanel() {
  if (!showPanel.value && btnRef.value) {
    const rect = btnRef.value.getBoundingClientRect()
    const panelWidth = 320
    const rightOffset = window.innerWidth - rect.right
    const leftEdge = rect.right - panelWidth
    const clampedRight = leftEdge < 8 ? window.innerWidth - panelWidth - 8 : rightOffset
    panelStyle.value = {
      position: 'fixed',
      top: `${rect.bottom + 8}px`,
      right: `${clampedRight}px`,
      zIndex: '9999',
    }
  }
  showPanel.value = !showPanel.value
}

function onDocClick(e: MouseEvent) {
  const inBtn = btnRef.value?.contains(e.target as Node)
  const inPanel = panelRef.value?.contains(e.target as Node)
  if (!inBtn && !inPanel) showPanel.value = false
}

onMounted(() => document.addEventListener('click', onDocClick))
onUnmounted(() => document.removeEventListener('click', onDocClick))
</script>

<template>
  <div class="picker-wrap">
    <button ref="btnRef" class="picker-btn" @click.stop="togglePanel">
      管理
      <span v-if="unpinnedAttentionCount > 0" class="picker-badge">{{ unpinnedAttentionCount }}</span>
    </button>

    <Teleport to="body">
      <Transition name="panel-fade">
        <div v-if="showPanel" ref="panelRef" class="picker-panel" :style="panelStyle">
          <div class="picker-header">
            <span>会话管理</span>
            <button class="picker-close" @click="showPanel = false">✕</button>
          </div>

          <!-- Pinned sessions -->
          <div v-if="pinnedSessions.length > 0" class="picker-section-label">已关注</div>
          <div class="picker-list">
            <div
              v-for="s in pinnedSessions"
              :key="s.session_id"
              class="picker-row"
            >
              <span class="picker-dot" :style="{ background: stateColor(s.state) }" />
              <div class="picker-info">
                <span class="picker-name">{{ s.display_name }}</span>
                <span class="picker-time">{{ relativeTime(s.last_activity) }}</span>
              </div>
              <button class="picker-toggle pinned" @click="store.setPinned(s.session_id, false)" title="移出看板">
                已关注
              </button>
            </div>
          </div>

          <!-- Divider when both sections have content -->
          <div v-if="pinnedSessions.length > 0 && unpinnedSessions.length > 0" class="picker-divider" />

          <!-- Unpinned sessions -->
          <div v-if="unpinnedSessions.length > 0" class="picker-section-label">未关注</div>
          <div class="picker-list">
            <div
              v-for="s in unpinnedSessions"
              :key="s.session_id"
              class="picker-row"
            >
              <span class="picker-dot" :style="{ background: stateColor(s.state) }" />
              <div class="picker-info">
                <span class="picker-name">{{ s.display_name }}</span>
                <span class="picker-time">{{ relativeTime(s.last_activity) }}</span>
              </div>
              <span
                v-if="s.state === 'active' || s.state === 'waiting_permission' || s.state === 'waiting_user'"
                class="picker-new-dot"
              />
              <button class="picker-toggle" @click="store.setPinned(s.session_id, true)" title="加入看板">
                关注
              </button>
            </div>
          </div>

          <div v-if="store.allSortedSessions.length === 0" class="picker-empty">
            暂无 session
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.picker-wrap {
  position: relative;
}

.picker-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.04);
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
  position: relative;
}

.picker-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text);
}

.picker-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--danger);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
}

/* ─── Panel ─── */
.picker-panel {
  width: 320px;
  max-height: 480px;
  overflow-y: auto;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(18px);
}

.picker-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 14px 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  position: sticky;
  top: 0;
  background: var(--panel-2);
  z-index: 1;
}

.picker-close {
  background: none;
  border: none;
  color: var(--muted);
  cursor: pointer;
  font-size: 12px;
  padding: 2px 4px;
  border-radius: 4px;
}

.picker-close:hover {
  color: var(--text);
  background: rgba(255, 255, 255, 0.06);
}

.picker-section-label {
  padding: 8px 14px 4px;
  font-size: 10px;
  font-weight: 600;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  opacity: 0.6;
}

.picker-list {
  padding: 2px 8px;
}

.picker-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 6px;
  border-radius: 8px;
  transition: background 0.1s;
}

.picker-row:hover {
  background: rgba(255, 255, 255, 0.04);
}

.picker-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.picker-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.picker-name {
  font-size: 13px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.picker-time {
  font-size: 11px;
  color: var(--muted);
}

.picker-new-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--danger);
  flex-shrink: 0;
}

.picker-toggle {
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.04);
  color: var(--muted);
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  transition: all 0.15s;
}

.picker-toggle:hover {
  background: rgba(124, 156, 255, 0.12);
  border-color: rgba(124, 156, 255, 0.3);
  color: var(--accent);
}

.picker-toggle.pinned {
  color: var(--accent);
  border-color: rgba(124, 156, 255, 0.35);
  background: rgba(124, 156, 255, 0.1);
}

.picker-toggle.pinned:hover {
  background: rgba(248, 113, 113, 0.1);
  border-color: rgba(248, 113, 113, 0.3);
  color: var(--danger);
}

.picker-divider {
  margin: 6px 14px;
  border: none;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.picker-empty {
  padding: 20px 14px;
  text-align: center;
  color: var(--muted);
  font-size: 13px;
}

/* ─── Transition ─── */
.panel-fade-enter-active,
.panel-fade-leave-active {
  transition: opacity 0.15s, transform 0.15s;
}
.panel-fade-enter-from,
.panel-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
