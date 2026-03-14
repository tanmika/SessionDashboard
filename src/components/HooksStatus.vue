<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'

interface HookEvent {
  event: string
  installed: boolean
}

interface StatusData {
  configured: boolean
  settingsFound: boolean
  settingsPath: string
  events: HookEvent[]
  installedCount: number
  totalRequired: number
  setupCommand: string
}

const status = ref<StatusData | null>(null)
const showPanel = ref(false)
const badgeRef = ref<HTMLElement | null>(null)
const panelRef = ref<HTMLElement | null>(null)
const panelStyle = ref<Record<string, string>>({})

const badgeClass = computed(() => {
  if (!status.value) return ''
  if (status.value.configured) return 'good'
  if (status.value.installedCount > 0) return 'partial'
  return 'bad'
})

async function fetchStatus() {
  try {
    const res = await fetch('/api/hooks/status')
    const json = await res.json()
    if (json.ok) status.value = json.data
  } catch {
    // ignore — server may not be ready yet
  }
}

function togglePanel() {
  if (!showPanel.value && badgeRef.value) {
    const rect = badgeRef.value.getBoundingClientRect()
    // Align panel right edge with badge right edge, but ensure it doesn't go off-screen left
    const panelWidth = 280
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
  const inBadge = badgeRef.value?.contains(e.target as Node)
  const inPanel = panelRef.value?.contains(e.target as Node)
  if (!inBadge && !inPanel) showPanel.value = false
}

let timer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  fetchStatus()
  timer = setInterval(fetchStatus, 30_000)
  document.addEventListener('click', onDocClick)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
  document.removeEventListener('click', onDocClick)
})
</script>

<template>
  <div v-if="status">
    <button
      ref="badgeRef"
      class="hooks-badge"
      :class="badgeClass"
      @click.stop="togglePanel"
    >
      <span class="hooks-dot" />
      Hooks {{ status.installedCount }}/{{ status.totalRequired }}
    </button>

    <Teleport to="body">
      <Transition name="panel-fade">
        <div v-if="showPanel" ref="panelRef" class="hooks-panel" :style="panelStyle">
          <div class="hooks-panel-header">
            <span>Hook 配置状态</span>
            <button class="hooks-panel-close" @click="showPanel = false">✕</button>
          </div>

          <div class="hooks-settings-path">{{ status.settingsPath }}</div>

          <div class="hooks-event-list">
            <div
              v-for="ev in status.events"
              :key="ev.event"
              class="hooks-event-row"
              :class="{ ok: ev.installed }"
            >
              <span class="hooks-event-icon">{{ ev.installed ? '✓' : '✗' }}</span>
              <span class="hooks-event-name">{{ ev.event }}</span>
            </div>
          </div>

          <div v-if="!status.settingsFound" class="hooks-warn">
            settings.json 不存在
          </div>

          <div v-if="!status.configured" class="hooks-setup-hint">
            <div class="hooks-hint-label">安装缺失的 hooks：</div>
            <code class="hooks-cmd">{{ status.setupCommand }}</code>
          </div>

          <div v-else class="hooks-all-ok">
            ✓ 所有 hooks 已就绪
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
/* ─── Badge ─── */
.hooks-badge {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.04);
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.hooks-badge:hover {
  background: rgba(255, 255, 255, 0.08);
}

.hooks-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--muted);
  flex-shrink: 0;
}

.hooks-badge.good {
  color: var(--accent-2);
  border-color: rgba(74, 222, 128, 0.3);
}
.hooks-badge.good .hooks-dot {
  background: var(--accent-2);
  box-shadow: 0 0 6px var(--accent-2);
}

.hooks-badge.partial {
  color: #f5c842;
  border-color: rgba(245, 200, 66, 0.3);
}
.hooks-badge.partial .hooks-dot {
  background: #f5c842;
}

.hooks-badge.bad {
  color: var(--danger);
  border-color: rgba(248, 113, 113, 0.3);
}
.hooks-badge.bad .hooks-dot {
  background: var(--danger);
}

/* ─── Panel (teleported to body, position:fixed set inline) ─── */
.hooks-panel {
  width: 280px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(18px);
  z-index: 200;
  overflow: hidden;
}

.hooks-panel-header {
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
}

.hooks-panel-close {
  background: none;
  border: none;
  color: var(--muted);
  cursor: pointer;
  font-size: 12px;
  padding: 2px 4px;
  border-radius: 4px;
}

.hooks-panel-close:hover {
  color: var(--text);
  background: rgba(255, 255, 255, 0.06);
}

.hooks-settings-path {
  padding: 8px 14px;
  font-size: 10px;
  color: var(--muted);
  font-family: monospace;
  word-break: break-all;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.hooks-event-list {
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.hooks-event-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--danger);
}

.hooks-event-row.ok {
  color: var(--accent-2);
}

.hooks-event-icon {
  width: 14px;
  text-align: center;
  flex-shrink: 0;
  font-size: 11px;
}

.hooks-event-name {
  font-family: monospace;
}

.hooks-warn {
  margin: 4px 14px 0;
  padding: 6px 10px;
  border-radius: 8px;
  background: rgba(248, 113, 113, 0.1);
  border: 1px solid rgba(248, 113, 113, 0.2);
  color: var(--danger);
  font-size: 11px;
}

.hooks-setup-hint {
  margin: 8px 10px 12px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.hooks-hint-label {
  font-size: 11px;
  color: var(--muted);
  margin-bottom: 6px;
}

.hooks-cmd {
  display: block;
  font-size: 12px;
  color: #a5bdff;
  font-family: monospace;
  user-select: all;
}

.hooks-all-ok {
  padding: 10px 14px 12px;
  font-size: 12px;
  color: var(--accent-2);
  text-align: center;
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
