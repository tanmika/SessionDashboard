<script setup lang="ts">
import { ref } from 'vue'
import { useSessionStore } from '../stores/session'
import { usePreferencesStore } from '../stores/preferences'
import type { SessionState } from '../../shared/types'
import HooksStatus from './HooksStatus.vue'
import SessionPicker from './SessionPicker.vue'

const store = useSessionStore()
const prefs = usePreferencesStore()
const showSettings = ref(false)

const filters: { label: string; value: SessionState | 'all' | 'needs_attention'; attention?: boolean }[] = [
  { label: 'All', value: 'all' },
  { label: 'Needs Attention', value: 'needs_attention', attention: true },
  { label: 'Waiting Permission', value: 'waiting_permission' },
  { label: 'Waiting User', value: 'waiting_user' },
  { label: 'Active', value: 'active' },
  { label: 'Inactive', value: 'inactive' },
  { label: 'Idle', value: 'idle' },
  { label: 'Ended', value: 'ended' },
]
</script>

<template>
  <section class="topbar">
    <div class="hero">
      <div>
        <h1>Session Dashboard</h1>
        <p>
          每个 session 独占一列：顶部固定展示当前状态和上下文，列体按倒序完整展示 insight，帮助你在多会话并行时掌握整体进度。
        </p>
      </div>
      <div class="hero-meta">
        <div class="kbd-hint">
          <strong>交互提示</strong><br />
          鼠标滚轮：控制列内纵向滚动<br />
          键盘：<code>Q / E</code> 或 <code>← / →</code> 横向移动列
        </div>
        <div class="status-row">
          <SessionPicker />
          <HooksStatus />
          <div class="settings-wrap">
            <button class="settings-btn" @click="showSettings = !showSettings">Settings</button>
            <div v-if="showSettings" class="settings-panel">
              <label class="setting-item">
                <input type="checkbox" v-model="prefs.showUserPrompts" />
                <span>Show user prompts in insights</span>
              </label>
            </div>
          </div>
          <div class="connection-status" :class="{ connected: store.wsConnected }">
            {{ store.wsConnected ? 'Connected' : 'Reconnecting...' }}
          </div>
        </div>
      </div>
    </div>

    <aside class="toolbar">
      <div class="toolbar-row">
        <span
          v-for="f in filters"
          :key="f.value"
          class="chip"
          :class="{ active: store.filterState === f.value, attention: f.attention }"
          @click="store.setFilter(f.value)"
        >
          {{ f.label }}
        </span>
      </div>
      <input
        class="search"
        placeholder="搜索 session / cwd / session id"
        :value="store.searchQuery"
        @input="store.setSearch(($event.target as HTMLInputElement).value)"
      />
    </aside>
  </section>
</template>

<style scoped>
.topbar {
  display: flex;
  flex-wrap: wrap;
  align-items: stretch;
  gap: 16px;
}

.hero, .toolbar {
  background: var(--panel);
  border: 1px solid var(--border);
  box-shadow: var(--shadow);
  border-radius: var(--radius);
  backdrop-filter: blur(18px);
}

.hero {
  flex: 1 1 520px;
  padding: 20px 24px;
  display: flex;
  justify-content: space-between;
  gap: 24px;
}

.hero h1 {
  margin: 0 0 8px;
  font-size: 28px;
  line-height: 1.1;
}

.hero p {
  margin: 0;
  max-width: 760px;
  color: var(--muted);
  line-height: 1.6;
}

.hero-meta {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 10px;
  min-width: 200px;
}

.kbd-hint {
  padding: 10px 12px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.06);
  color: var(--muted);
  font-size: 13px;
  line-height: 1.6;
}

.status-row {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
}

.settings-wrap {
  position: relative;
}

.settings-btn {
  padding: 6px 14px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.06);
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.settings-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text);
}

.settings-panel {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 8px;
  padding: 12px 16px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.4);
  z-index: 50;
  min-width: 220px;
}

.setting-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text);
  cursor: pointer;
  user-select: none;
}

.setting-item input {
  accent-color: var(--accent);
}

.connection-status {
  font-size: 12px;
  color: var(--danger);
  text-align: right;
}

.connection-status.connected {
  color: var(--accent-2);
}

.toolbar {
  flex: 0 1 360px;
  padding: 18px;
  display: grid;
  gap: 14px;
}

.toolbar-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.chip {
  padding: 8px 12px;
  font-size: 13px;
  color: var(--muted);
  border: 1px solid var(--border);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.04);
  cursor: pointer;
  user-select: none;
  transition: all 0.15s;
}

.chip:hover {
  background: rgba(255, 255, 255, 0.08);
}

.chip.active {
  color: var(--text);
  background: rgba(124, 156, 255, 0.14);
  border-color: rgba(124, 156, 255, 0.38);
}

.chip.attention {
  color: #ffd38a;
  border-color: rgba(245, 158, 11, 0.28);
}

.chip.attention.active {
  background: rgba(245, 158, 11, 0.14);
  border-color: rgba(245, 158, 11, 0.42);
}

.search {
  width: 100%;
  padding: 12px 14px;
  border-radius: 14px;
  border: 1px solid var(--border);
  background: rgba(5, 9, 20, 0.55);
  color: var(--text);
  outline: none;
  font-size: 14px;
}

.search::placeholder {
  color: #6f7b9a;
}

.search:focus {
  border-color: rgba(124, 156, 255, 0.3);
}
</style>
