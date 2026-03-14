<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useSessionStore } from '../stores/session'
import SessionColumn from './SessionColumn.vue'

const store = useSessionStore()
const boardRef = ref<HTMLElement | null>(null)

function handleKeyboard(e: KeyboardEvent) {
  if (!boardRef.value) return
  const target = e.target as HTMLElement
  // Don't intercept if user is typing in an input
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return

  const scrollAmount = 380 // column-width + gap
  if (e.key === 'q' || e.key === 'ArrowLeft') {
    boardRef.value.scrollBy({ left: -scrollAmount, behavior: 'smooth' })
  } else if (e.key === 'e' || e.key === 'ArrowRight') {
    boardRef.value.scrollBy({ left: scrollAmount, behavior: 'smooth' })
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeyboard)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeyboard)
})
</script>

<template>
  <section ref="boardRef" class="board">
    <SessionColumn
      v-for="session in store.sortedSessions"
      :key="session.session_id"
      :session="session"
      :selected="store.selectedSessionId === session.session_id"
      @select="store.selectSession(session.session_id)"
    />
    <div v-if="store.sortedSessions.length === 0" class="empty-board">
      <p>No sessions yet</p>
      <p class="hint">Sessions will appear here when Claude Code hooks start sending events.</p>
    </div>
  </section>
</template>

<style scoped>
.board {
  display: flex;
  gap: 16px;
  overflow-x: auto;
  padding-bottom: 8px;
  scroll-snap-type: x proximity;
}

.empty-board {
  width: 100%;
  min-height: var(--column-height);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  background: var(--panel);
  border: 1px dashed var(--border);
  border-radius: var(--radius);
}

.empty-board p {
  margin: 4px 0;
}

.empty-board .hint {
  font-size: 13px;
  opacity: 0.6;
}
</style>
