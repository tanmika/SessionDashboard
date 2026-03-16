import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

const STORAGE_KEY = 'session-dashboard-preferences'

export const usePreferencesStore = defineStore('preferences', () => {
  const showUserPrompts = ref(true)
  const collapsedFolders = ref(new Set<string>())
  const sidebarCollapsed = ref(false)

  // Load from localStorage
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const saved = JSON.parse(raw)
        if (typeof saved.showUserPrompts === 'boolean') showUserPrompts.value = saved.showUserPrompts
        if (Array.isArray(saved.collapsedFolders)) collapsedFolders.value = new Set(saved.collapsedFolders)
        if (typeof saved.sidebarCollapsed === 'boolean') sidebarCollapsed.value = saved.sidebarCollapsed
      }
    } catch { /* ignore corrupt data */ }
  }

  // Persist on change
  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      showUserPrompts: showUserPrompts.value,
      collapsedFolders: [...collapsedFolders.value],
      sidebarCollapsed: sidebarCollapsed.value,
    }))
  }

  function toggleFolder(fullPath: string) {
    const next = new Set(collapsedFolders.value)
    if (next.has(fullPath)) next.delete(fullPath)
    else next.add(fullPath)
    collapsedFolders.value = next
  }

  load()
  function toggleSidebar() {
    sidebarCollapsed.value = !sidebarCollapsed.value
  }

  watch(showUserPrompts, save)
  watch(collapsedFolders, save)
  watch(sidebarCollapsed, save)

  return { showUserPrompts, collapsedFolders, toggleFolder, sidebarCollapsed, toggleSidebar }
})
