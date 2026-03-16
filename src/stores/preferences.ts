import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

const STORAGE_KEY = 'session-dashboard-preferences'

export const usePreferencesStore = defineStore('preferences', () => {
  const showUserPrompts = ref(true)

  // Load from localStorage
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const saved = JSON.parse(raw)
        if (typeof saved.showUserPrompts === 'boolean') showUserPrompts.value = saved.showUserPrompts
      }
    } catch { /* ignore corrupt data */ }
  }

  // Persist on change
  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      showUserPrompts: showUserPrompts.value,
    }))
  }

  load()
  watch(showUserPrompts, save)

  return { showUserPrompts }
})
