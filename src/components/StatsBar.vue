<script setup lang="ts">
import { useSessionStore } from '../stores/session'

const store = useSessionStore()
</script>

<template>
  <section class="stats">
    <article class="stat">
      <span class="label">Sessions</span>
      <span class="value">{{ store.stateCounts.total }}</span>
    </article>
    <article class="stat">
      <span class="label">Waiting Permission</span>
      <span class="value warn">{{ store.stateCounts.waiting_permission }}</span>
    </article>
    <article class="stat">
      <span class="label">Waiting User</span>
      <span class="value accent">{{ store.stateCounts.waiting_user }}</span>
    </article>
    <article class="stat">
      <span class="label">Active</span>
      <span class="value accent2">{{ store.stateCounts.active }}</span>
    </article>
    <article class="stat">
      <span class="label">Idle / Ended</span>
      <span class="value muted">{{ store.stateCounts.idle }} / {{ store.stateCounts.ended }}</span>
    </article>
  </section>
</template>

<style scoped>
.stats {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 12px;
}

.stat {
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.04);
}

.stat .label {
  color: var(--muted);
  font-size: 12px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.stat .value {
  font-size: 28px;
  font-weight: 700;
}

.stat .value.warn { color: var(--warn); }
.stat .value.accent { color: var(--accent); }
.stat .value.accent2 { color: var(--accent-2); }
.stat .value.muted { color: var(--muted); }

@media (max-width: 1200px) {
  .stats { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}

@media (max-width: 900px) {
  .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
