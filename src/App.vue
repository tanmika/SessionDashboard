<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useSessionStore } from './stores/session'
import TopBar from './components/TopBar.vue'
import StatsBar from './components/StatsBar.vue'
import SessionBoard from './components/SessionBoard.vue'
import DetailPanel from './components/DetailPanel.vue'

const store = useSessionStore()

onMounted(() => {
  store.connect()
})

onUnmounted(() => {
  store.disconnect()
})
</script>

<template>
  <div class="shell">
    <TopBar />
    <StatsBar />
    <SessionBoard />
    <DetailPanel v-if="store.selectedSessionId" />
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
</style>
