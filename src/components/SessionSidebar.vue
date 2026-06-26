<script setup lang="ts">
import { ref, computed } from 'vue'
import type { Session } from '../../shared/types'
import { useSessionStore } from '../stores/session'
import { usePreferencesStore } from '../stores/preferences'
import { stateColor } from '../utils/stateColor'
import { formatRelativeTime } from '../utils/time'
import { renderMarkdown } from '../utils/markdown'

const store = useSessionStore()
const prefs = usePreferencesStore()

const searchInput = ref('')

const stateFilters: { label: string; value: string }[] = [
  { label: '活跃', value: 'active' },
  { label: '等待权限', value: 'waiting_permission' },
  { label: '等待用户', value: 'waiting_user' },
  { label: '非活跃', value: 'inactive' },
  { label: '空闲', value: 'idle' },
  { label: '已结束', value: 'ended' },
]

function onSearch() {
  store.setSidebarSearch(searchInput.value)
}

// ─── Tree data ───

type TreeNode = NonNullable<typeof store.filteredSessionTree>

const tree = computed(() => store.filteredSessionTree ?? { label: '', fullPath: '', children: [], sessions: [], totalCount: 0 })

function isCollapsed(fullPath: string): boolean {
  return prefs.collapsedFolders.has(fullPath)
}

// ─── Hover preview ───

const hoverSession = ref<Session | null>(null)
const hoverPos = ref({ top: 0, left: 0 })
let hoverTimer: ReturnType<typeof setTimeout> | null = null

function startHover(session: Session, event: MouseEvent) {
  cancelHover()
  const target = event.currentTarget as HTMLElement
  hoverTimer = setTimeout(() => {
    const rect = target.getBoundingClientRect()
    const sidebarEl = document.querySelector('.sidebar') as HTMLElement
    const sidebarRight = sidebarEl ? sidebarEl.getBoundingClientRect().right : 280
    const previewHeight = 520
    let top = rect.top - 30
    if (top + previewHeight > window.innerHeight - 8) top = window.innerHeight - previewHeight - 8
    if (top < 8) top = 8
    hoverPos.value = { top, left: sidebarRight + 8 }
    hoverSession.value = session
  }, 300)
}

function cancelHover() {
  if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null }
  hoverSession.value = null
}

// ─── State label ───

function stateLabel(state: string): string {
  const labels: Record<string, string> = {
    active: 'Active',
    waiting_permission: 'Waiting',
    waiting_user: 'Waiting',
    inactive: 'Inactive',
    idle: 'Idle',
    ended: 'Ended',
  }
  return labels[state] || state
}

// ─── Flatten tree for v-for rendering ───
// Vue 3 supports recursive components, but a flat list is simpler and more performant

interface FlatItem {
  type: 'folder' | 'session'
  depth: number
  // folder fields
  label?: string
  fullPath?: string
  totalCount?: number
  collapsed?: boolean
  // session fields
  session?: Session
}

const flatItems = computed<FlatItem[]>(() => {
  const items: FlatItem[] = []

  function walk(node: TreeNode, depth: number) {
    // Render folder children
    for (const child of node.children) {
      const collapsed = isCollapsed(child.fullPath)
      items.push({
        type: 'folder',
        depth,
        label: child.label,
        fullPath: child.fullPath,
        totalCount: child.totalCount,
        collapsed,
      })
      if (!collapsed) {
        walk(child, depth + 1)
      }
    }
    // Render sessions at this level
    for (const s of node.sessions) {
      items.push({ type: 'session', depth, session: s })
    }
  }

  walk(tree.value, 0)
  return items
})
</script>

<template>
  <aside class="sidebar" :class="{ collapsed: prefs.sidebarCollapsed }">
    <!-- Collapsed strip -->
    <div v-if="prefs.sidebarCollapsed" class="sb-collapsed-strip" @click="prefs.toggleSidebar()">
      <span class="sb-expand-icon">▶</span>
      <span class="sb-collapsed-label">S</span>
      <span class="sb-collapsed-count">{{ store.sessions.size }}</span>
    </div>

    <!-- Header (expanded) -->
    <template v-if="!prefs.sidebarCollapsed">
    <div class="sb-header">
      <span class="sb-title">Sessions</span>
      <div class="sb-header-right">
        <span class="sb-count">{{ store.sessions.size }}</span>
        <button class="sb-collapse-btn" @click="prefs.toggleSidebar()" title="收起侧栏">◀</button>
      </div>
    </div>

    <!-- Search -->
    <div class="sb-search-wrap">
      <input
        class="sb-search"
        placeholder="搜索 session / 项目…"
        v-model="searchInput"
        @input="onSearch"
      />
      <label v-if="searchInput" class="sb-search-filter">
        <input type="checkbox" v-model="prefs.searchIncludeArchived" />
        <span>含归档</span>
      </label>
    </div>

    <!-- Filters -->
    <div class="sb-filters">
      <div class="sb-chips">
        <span
          v-for="f in stateFilters"
          :key="f.value"
          class="sb-chip"
          :class="{ active: prefs.sidebarFilters.includes(f.value) }"
          @click="prefs.toggleSidebarFilter(f.value as any)"
        >{{ f.label }}</span>
        <span
          v-if="prefs.sidebarFilters.length > 0"
          class="sb-chip sb-chip-clear"
          @click="prefs.clearSidebarFilters()"
        >清除</span>
      </div>
      <label class="sb-filter-toggle">
        <input type="checkbox" v-model="prefs.hideShortSessions" />
        <span>隐藏极短会话</span>
      </label>
    </div>

    <!-- Tree -->
    <div class="sb-tree">
      <template v-for="(item, idx) in flatItems" :key="idx">

        <!-- Folder -->
        <div
          v-if="item.type === 'folder'"
          class="tree-folder"
          :style="{ paddingLeft: item.depth * 16 + 8 + 'px' }"
          @click="prefs.toggleFolder(item.fullPath!)"
        >
          <span class="tree-arrow" :class="{ open: !item.collapsed }">▶</span>
          <span class="tree-folder-icon">{{ item.collapsed ? '📁' : '📂' }}</span>
          <span class="tree-folder-name">{{ item.label }}</span>
          <span class="tree-folder-count">{{ item.totalCount }}</span>
        </div>

        <!-- Session -->
        <div
          v-else
          class="tree-session"
          :class="{ selected: store.selectedSessionId === item.session!.session_id }"
          :style="{ paddingLeft: item.depth * 16 + 22 + 'px' }"
          @click="store.selectSession(item.session!.session_id)"
          @mouseenter="startHover(item.session!, $event)"
          @mouseleave="cancelHover"
        >
          <span class="tree-dot" :style="{ background: stateColor(item.session!.state) }"></span>
          <span class="src-badge" :class="item.session!.source">{{ item.session!.source === 'codex' ? 'Codex' : item.session!.source === 'zcode' ? 'ZCode' : 'Claude' }}</span>
          <span v-if="item.session!.is_subagent" class="kind-badge">子代理</span>
          <div class="tree-session-info">
            <span class="tree-session-name">{{ item.session!.alias || item.session!.session_id.slice(0, 8) }}</span>
            <span class="tree-session-meta">{{ formatRelativeTime(item.session!.last_activity) }} · {{ item.session!.total_insights }}✦</span>
          </div>
          <button
            class="pin-btn"
            :class="{ pinned: item.session!.pinned }"
            @click.stop="store.setPinned(item.session!.session_id, !item.session!.pinned)"
            :title="item.session!.pinned ? '从看板移除' : '加入看板'"
          >★</button>
        </div>

      </template>

      <div v-if="flatItems.length === 0" class="sb-empty">
        {{ store.sidebarSearch ? '无匹配 session' : '暂无 session' }}
      </div>
    </div>
    </template>
  </aside>

  <!-- Hover Preview -->
  <Teleport to="body">
    <Transition name="preview-fade">
      <div
        v-if="hoverSession"
        class="hover-preview"
        :style="{ top: hoverPos.top + 'px', left: hoverPos.left + 'px' }"
      >
        <div class="hp-header">
          <div class="hp-title">
            <span>{{ hoverSession.display_name }}</span>
            <span class="src-badge" :class="hoverSession.source">{{ hoverSession.source === 'codex' ? 'Codex' : hoverSession.source === 'zcode' ? 'ZCode' : 'Claude' }}</span>
            <span v-if="hoverSession.is_subagent" class="kind-badge">子代理</span>
          </div>
          <div class="hp-id">{{ hoverSession.session_id.slice(0, 12) }}</div>
          <div class="hp-meta-row">
            <span class="hp-state" :class="hoverSession.state">
              <span class="tree-dot" :style="{ background: stateColor(hoverSession.state) }"></span>
              {{ stateLabel(hoverSession.state) }}
            </span>
            <span>{{ formatRelativeTime(hoverSession.last_activity) }}</span>
            <span>{{ hoverSession.total_insights }} insights</span>
          </div>
        </div>
        <div class="hp-insights">
          <div class="hp-label">Recent</div>
          <template v-if="hoverSession.insights.length > 0">
            <div
              v-for="ins in hoverSession.insights.slice(0, 5)"
              :key="ins.id"
              class="hp-item"
              :class="{ 'hp-user': ins.source === 'user' }"
            >
              <div v-if="ins.source === 'user'" class="hp-item-text">💬 {{ ins.content.slice(0, 120) }}</div>
              <template v-else>
                <div class="hp-item-time">{{ formatRelativeTime(ins.timestamp) }}</div>
                <div class="hp-item-text" v-html="renderMarkdown(ins.content.slice(0, 200))" />
              </template>
            </div>
          </template>
          <div v-else class="hp-empty">暂无 insight</div>
        </div>
        <div class="hp-cwd">{{ hoverSession.cwd }}</div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.sidebar {
  position: fixed;
  top: 0;
  left: 0;
  width: var(--sidebar-width, 280px);
  height: 100vh;
  background: rgba(10, 14, 28, 0.98);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  z-index: 50;
  user-select: none;
  transition: width 0.2s ease;
}

/* Header */
/* Collapsed state */
.sidebar.collapsed {
  width: 40px !important;
}

.sb-collapsed-strip {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 14px 0;
  cursor: pointer;
  height: 100%;
}
.sb-collapsed-strip:hover { background: rgba(255,255,255,0.03); }
.sb-expand-icon {
  font-size: 10px;
  color: var(--muted);
  opacity: 0.5;
  transition: transform 0.15s;
}
.sb-collapsed-strip:hover .sb-expand-icon { opacity: 1; color: var(--accent); }
.sb-collapsed-label {
  font-size: 12px;
  font-weight: 700;
  color: var(--muted);
  writing-mode: vertical-rl;
  letter-spacing: 0.1em;
}
.sb-collapsed-count {
  font-size: 10px;
  color: var(--muted);
  opacity: 0.5;
}

/* Header */
.sb-header {
  padding: 14px 14px 10px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.sb-title { font-size: 13px; font-weight: 700; }
.sb-header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sb-count { font-size: 11px; color: var(--muted); opacity: 0.6; }
.sb-collapse-btn {
  width: 22px; height: 22px;
  border: none; border-radius: 4px;
  background: none; color: var(--muted);
  font-size: 10px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  opacity: 0.4;
  transition: all 0.15s;
}
.sb-collapse-btn:hover {
  opacity: 1;
  background: rgba(255,255,255,0.06);
  color: var(--text);
}

/* Search */
.sb-search-wrap {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.sb-search {
  width: 100%;
  padding: 6px 10px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: rgba(255,255,255,0.03);
  color: var(--text);
  font-size: 12px;
  outline: none;
}
.sb-search::placeholder { color: rgba(155,167,198,0.4); }
.sb-search:focus { border-color: rgba(124,156,255,0.3); }
.sb-search-filter {
  display: flex; align-items: center; gap: 5px;
  margin-top: 5px; font-size: 11px; color: var(--muted);
  cursor: pointer; user-select: none;
}
.sb-search-filter input { accent-color: var(--accent); }

/* Filters */
.sb-filters {
  padding: 6px 10px 8px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.sb-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 6px;
}
.sb-chip {
  padding: 3px 8px;
  font-size: 11px;
  color: var(--muted);
  border: 1px solid var(--border);
  border-radius: 99px;
  background: rgba(255,255,255,0.03);
  cursor: pointer;
  transition: all 0.15s;
  user-select: none;
}
.sb-chip:hover { background: rgba(255,255,255,0.06); }
.sb-chip.active {
  color: var(--text);
  background: rgba(124,156,255,0.14);
  border-color: rgba(124,156,255,0.38);
}
.sb-chip-clear {
  color: var(--muted);
  opacity: 0.6;
  font-style: italic;
}
.sb-chip-clear:hover { opacity: 1; color: var(--danger); }
.sb-filter-toggle {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--muted);
  cursor: pointer;
  user-select: none;
}
.sb-filter-toggle input { accent-color: var(--accent); }

/* Tree */
.sb-tree {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.sb-empty {
  padding: 20px 14px;
  text-align: center;
  color: var(--muted);
  font-size: 12px;
  opacity: 0.6;
}

/* Folder */
.tree-folder {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  cursor: pointer;
  font-size: 12px;
  color: var(--muted);
  transition: background 0.1s;
}
.tree-folder:hover { background: rgba(255,255,255,0.04); }

.tree-arrow {
  font-size: 9px;
  opacity: 0.4;
  transition: transform 0.15s;
  flex-shrink: 0;
  width: 12px;
  text-align: center;
}
.tree-arrow.open { transform: rotate(90deg); }
.tree-folder-icon { font-size: 12px; flex-shrink: 0; opacity: 0.5; }
.tree-folder-name {
  flex: 1; min-width: 0;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  font-weight: 600;
}
.tree-folder-count {
  font-size: 10px; color: var(--muted); opacity: 0.4; flex-shrink: 0;
}

/* Session */
.tree-session {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  cursor: pointer;
  transition: background 0.1s;
  border-left: 2px solid transparent;
}
.tree-session:hover { background: rgba(255,255,255,0.04); }
.tree-session.selected {
  background: rgba(124,156,255,0.1);
  border-left-color: var(--accent);
}

.tree-dot {
  width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
  display: inline-block;
}

.src-badge {
  font-size: 9px; padding: 1px 5px; border-radius: 99px; font-weight: 700;
  letter-spacing: 0.02em; flex-shrink: 0;
}
.src-badge.claude { background: rgba(96,165,250,0.15); color: #93c5fd; }
.src-badge.codex { background: rgba(74,222,128,0.15); color: #86efac; }
.src-badge.zcode { background: rgba(192,132,252,0.15); color: #d8b4fe; }

.kind-badge {
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 99px;
  font-weight: 700;
  letter-spacing: 0.02em;
  flex-shrink: 0;
  background: rgba(255, 196, 87, 0.14);
  color: #ffd36d;
  border: 1px solid rgba(255, 196, 87, 0.24);
}

.tree-session-info {
  flex: 1; min-width: 0;
  display: flex; flex-direction: column; gap: 1px;
}
.tree-session-name {
  font-size: 12px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.tree-session-meta {
  font-size: 10px; color: var(--muted); opacity: 0.6;
}

.pin-btn {
  width: 20px; height: 20px; border-radius: 4px;
  border: none; background: none; color: var(--muted);
  font-size: 12px; cursor: pointer; opacity: 0;
  transition: all 0.1s;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
  line-height: 1;
}
.tree-session:hover .pin-btn { opacity: 0.4; }
.pin-btn:hover { opacity: 1 !important; background: rgba(124,156,255,0.15); color: var(--accent); }
.pin-btn.pinned { opacity: 0.7; color: var(--accent); }
.tree-session:hover .pin-btn.pinned { opacity: 1; }

/* ─── Hover Preview ─── */
.hover-preview {
  position: fixed;
  width: 400px;
  max-height: 520px;
  background: rgba(16, 22, 50, 0.98);
  border: 1px solid rgba(124,156,255,0.2);
  border-radius: 14px;
  box-shadow: 0 12px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(124,156,255,0.08);
  backdrop-filter: blur(20px);
  overflow: hidden;
  pointer-events: none;
  z-index: 9999;
}

.hp-header {
  padding: 12px 14px 10px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  background: rgba(255,255,255,0.02);
}
.hp-title {
  font-size: 13px; font-weight: 700; margin-bottom: 4px;
  display: flex; align-items: center; gap: 8px;
}
.hp-id {
  font-size: 10px; font-family: monospace; color: var(--muted); opacity: 0.5;
}
.hp-meta-row {
  display: flex; gap: 10px; align-items: center;
  font-size: 11px; color: var(--muted); margin-top: 5px;
}
.hp-state {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 7px; border-radius: 99px; font-size: 10px; font-weight: 600;
}
.hp-state.active { background: rgba(94,234,212,0.12); color: #b8fff4; }
.hp-state.idle { background: rgba(100,116,139,0.18); color: #d6deed; }
.hp-state.ended { background: rgba(148,163,184,0.14); color: #dbe5f3; }
.hp-state.waiting_permission,
.hp-state.waiting_user { background: rgba(245,158,11,0.14); color: #ffd38a; }
.hp-state.inactive { background: rgba(148,163,184,0.1); color: #cbd5e1; }

.hp-insights {
  padding: 10px 14px; overflow-y: auto; max-height: 380px;
}
.hp-label {
  font-size: 10px; font-weight: 600; color: var(--muted);
  text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; opacity: 0.5;
}
.hp-item {
  font-size: 12px; line-height: 1.5; color: #c8d5ff;
  padding: 7px 9px; background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.05); border-radius: 8px; margin-bottom: 5px;
}
.hp-item.hp-user {
  background: rgba(255,180,50,0.05); border-color: rgba(255,180,50,0.1);
  color: var(--muted); font-style: italic;
}
.hp-item-time { font-size: 10px; color: var(--muted); opacity: 0.5; margin-bottom: 3px; }
.hp-item-text { overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
.hp-empty {
  padding: 16px; text-align: center; color: var(--muted); opacity: 0.4; font-size: 12px;
}
.hp-cwd {
  padding: 6px 14px 8px; font-size: 10px; color: var(--muted); opacity: 0.4;
  border-top: 1px solid rgba(255,255,255,0.04); font-family: monospace;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* Transition */
.preview-fade-enter-active,
.preview-fade-leave-active {
  transition: opacity 0.15s, transform 0.15s;
}
.preview-fade-enter-from,
.preview-fade-leave-to {
  opacity: 0;
  transform: translateX(-4px);
}

/* Markdown in preview */
:deep(.hp-item-text p) { margin: 0; }
:deep(.hp-item-text ul),
:deep(.hp-item-text ol) { margin: 2px 0; padding-left: 14px; }
:deep(.hp-item-text code) {
  font-size: 11px; background: rgba(124,156,255,0.12);
  border-radius: 3px; padding: 0 3px;
}
</style>
