<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useSessionStore } from './stores/session'
import { usePreferencesStore } from './stores/preferences'
import SessionSidebar from './components/SessionSidebar.vue'
import TopBar from './components/TopBar.vue'
import StatsBar from './components/StatsBar.vue'
import SessionBoard from './components/SessionBoard.vue'
import DetailPanel from './components/DetailPanel.vue'

const store = useSessionStore()
const prefs = usePreferencesStore()

onMounted(() => {
  store.connect()
})

onUnmounted(() => {
  store.disconnect()
})
</script>

<template>
  <div class="app-layout">
    <SessionSidebar />
    <div class="main-area" :class="{ 'sidebar-collapsed': prefs.sidebarCollapsed }">
      <TopBar />
      <StatsBar />
      <SessionBoard />
      <DetailPanel v-if="store.selectedSessionId" />
    </div>
  </div>
</template>

<style scoped>
.app-layout {
  display: flex;
  min-height: 100vh;
}

.main-area {
  flex: 1;
  margin-left: var(--sidebar-width, 280px);
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 24px;
  min-width: 0;
  transition: margin-left 0.2s ease;
}

.main-area.sidebar-collapsed {
  margin-left: 40px;
}
</style>
