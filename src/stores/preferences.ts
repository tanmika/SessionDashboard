import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

const STORAGE_KEY = 'session-dashboard-preferences'

export const usePreferencesStore = defineStore('preferences', () => {
  const showUserPrompts = ref(true)
  const collapsedFolders = ref(new Set<string>())
  const sidebarCollapsed = ref(false)
  const archiveDays = ref(3)
  const searchIncludeArchived = ref(false)
  const sidebarFilters = ref<string[]>([])   // multi-select state filters
  const hideShortSessions = ref(false)

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const saved = JSON.parse(raw)
        if (typeof saved.showUserPrompts === 'boolean') showUserPrompts.value = saved.showUserPrompts
        if (Array.isArray(saved.collapsedFolders)) collapsedFolders.value = new Set(saved.collapsedFolders)
        if (typeof saved.sidebarCollapsed === 'boolean') sidebarCollapsed.value = saved.sidebarCollapsed
        if (typeof saved.archiveDays === 'number') archiveDays.value = saved.archiveDays
        if (typeof saved.searchIncludeArchived === 'boolean') searchIncludeArchived.value = saved.searchIncludeArchived
        if (Array.isArray(saved.sidebarFilters)) sidebarFilters.value = saved.sidebarFilters
        if (typeof saved.hideShortSessions === 'boolean') hideShortSessions.value = saved.hideShortSessions
      }
    } catch { /* ignore corrupt data */ }
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      showUserPrompts: showUserPrompts.value,
      collapsedFolders: [...collapsedFolders.value],
      sidebarCollapsed: sidebarCollapsed.value,
      archiveDays: archiveDays.value,
      searchIncludeArchived: searchIncludeArchived.value,
      sidebarFilters: sidebarFilters.value,
      hideShortSessions: hideShortSessions.value,
    }))
  }

  function toggleFolder(fullPath: string) {
    const next = new Set(collapsedFolders.value)
    if (next.has(fullPath)) next.delete(fullPath)
    else next.add(fullPath)
    collapsedFolders.value = next
  }

  function toggleSidebar() {
    sidebarCollapsed.value = !sidebarCollapsed.value
  }

  function toggleSidebarFilter(state: string) {
    const idx = sidebarFilters.value.indexOf(state)
    if (idx >= 0) sidebarFilters.value.splice(idx, 1)
    else sidebarFilters.value.push(state)
  }

  function clearSidebarFilters() {
    sidebarFilters.value = []
  }

  load()
  watch(showUserPrompts, save)
  watch(collapsedFolders, save)
  watch(sidebarCollapsed, save)
  watch(archiveDays, save)
  watch(searchIncludeArchived, save)
  watch(sidebarFilters, save)
  watch(hideShortSessions, save)

  return {
    showUserPrompts,
    collapsedFolders, toggleFolder,
    sidebarCollapsed, toggleSidebar,
    archiveDays,
    searchIncludeArchived,
    sidebarFilters, toggleSidebarFilter, clearSidebarFilters,
    hideShortSessions,
  }
})
