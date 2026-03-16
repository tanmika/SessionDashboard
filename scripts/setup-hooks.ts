/**
 * Session Dashboard — Hook Setup Script
 * Usage: npm run setup:hooks  (or called by CLI `session-dashboard init`)
 *
 * Installs the required Claude Code hooks into ~/.claude/settings.json.
 * Safe to run multiple times (idempotent).
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'

const REQUIRED_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'Stop',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'SubagentStart',
  'SubagentStop',
] as const

/** Check if a specific hook script is already registered in an event's hook list */
function hasHookScript(eventHooks: unknown[], scriptName: string): boolean {
  return eventHooks.some((item: any) => {
    // Direct format: { type, command }
    if (typeof item?.command === 'string' && item.command.includes(scriptName)) return true
    // Hook-group format: { hooks: [{ type, command }] }
    if (Array.isArray(item?.hooks)) {
      return item.hooks.some(
        (h: any) => typeof h?.command === 'string' && h.command.includes(scriptName)
      )
    }
    return false
  })
}

export function setupHooks(options?: { packageRoot?: string }) {
  const packageRoot = options?.packageRoot || path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), '..'
  )
  const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json')
  const HOOK_SCRIPT = path.resolve(packageRoot, 'hooks', 'session-hook.sh')
  const SESSION_ID_HOOK_SCRIPT = path.resolve(packageRoot, 'hooks', 'session-id-hook.sh')

  // ─── Read settings ───

  let settings: any = {}
  let existed = true

  if (!fs.existsSync(SETTINGS_PATH)) {
    existed = false
    console.log(`\n  Creating new settings file at:\n  ${SETTINGS_PATH}\n`)
  } else {
    try {
      settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'))
    } catch (e) {
      console.error(`\n  ✗ Failed to parse ${SETTINGS_PATH}:`, e)
      process.exit(1)
    }
  }

  if (!settings.hooks) settings.hooks = {}

  // New hook group entry to append (matches existing settings.json format)
  const newEntry = {
    hooks: [{ type: 'command', command: `bash ${HOOK_SCRIPT}` }],
  }

  // ─── Check & add ───

  const added: string[] = []
  const skipped: string[] = []

  for (const event of REQUIRED_EVENTS) {
    const existing: unknown[] = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : []
    if (hasHookScript(existing, 'session-hook.sh')) {
      skipped.push(event)
    } else {
      settings.hooks[event] = [...existing, newEntry]
      added.push(event)
    }
  }

  // ─── Session ID injection hook (SessionStart only) ───

  const sessionIdEntry = {
    hooks: [{ type: 'command', command: `bash ${SESSION_ID_HOOK_SCRIPT}` }],
  }

  const sessionStartHooks: unknown[] = Array.isArray(settings.hooks.SessionStart) ? settings.hooks.SessionStart : []
  const hasSessionIdHook = hasHookScript(sessionStartHooks, 'session-id-hook.sh')

  if (!hasSessionIdHook) {
    settings.hooks.SessionStart = [...sessionStartHooks, sessionIdEntry]
    added.push('SessionStart(session-id)')
  } else {
    skipped.push('SessionStart(session-id)')
  }

  // ─── Report ───

  console.log('\n  Session Dashboard — Hook Setup\n  ' + '─'.repeat(38))

  if (added.length === 0) {
    console.log('\n  ✓ All hooks already installed, nothing to do.\n')
  } else {
    if (existed) {
      fs.copyFileSync(SETTINGS_PATH, SETTINGS_PATH + '.bak')
      console.log(`\n  Backup → ${SETTINGS_PATH}.bak`)
    }
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n')
    console.log(`  ✓ Added   : ${added.join(', ')}`)
  }

  if (skipped.length > 0) {
    console.log(`  ✓ Present : ${skipped.join(', ')}`)
  }

  console.log(`\n  Settings : ${SETTINGS_PATH}`)
  console.log('  ⚡ Restart Claude Code for hooks to take effect.\n')
}

// ─── Codex hooks setup ───

export function setupCodexHooks(options?: { packageRoot?: string }) {
  const packageRoot = options?.packageRoot || path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), '..'
  )
  const CODEX_DIR = path.join(os.homedir(), '.codex')
  const HOOKS_JSON_PATH = path.join(CODEX_DIR, 'hooks.json')
  const CONFIG_TOML_PATH = path.join(CODEX_DIR, 'config.toml')
  const SESSION_ID_HOOK_SCRIPT = path.resolve(packageRoot, 'hooks', 'session-id-hook.sh')

  console.log('\n  Session Dashboard — Codex Hook Setup\n  ' + '─'.repeat(38))

  if (!fs.existsSync(CODEX_DIR)) {
    console.log('  ✗ ~/.codex/ not found. Skipping Codex hook setup.')
    return
  }

  // 1. Ensure [features] codex_hooks = true in config.toml
  let configUpdated = false
  if (fs.existsSync(CONFIG_TOML_PATH)) {
    let toml = fs.readFileSync(CONFIG_TOML_PATH, 'utf-8')
    if (!toml.includes('codex_hooks')) {
      // Find [features] section or create it
      if (toml.includes('[features]')) {
        toml = toml.replace('[features]', '[features]\ncodex_hooks = true')
      } else {
        // Insert before the first [table] section (TOML requires root keys before tables)
        const firstTable = toml.search(/^\[(?!features)/m)
        if (firstTable > 0) {
          toml = toml.slice(0, firstTable) + '[features]\ncodex_hooks = true\n\n' + toml.slice(firstTable)
        } else {
          toml += '\n[features]\ncodex_hooks = true\n'
        }
      }
      fs.copyFileSync(CONFIG_TOML_PATH, CONFIG_TOML_PATH + '.bak')
      fs.writeFileSync(CONFIG_TOML_PATH, toml)
      console.log('  ✓ Enabled codex_hooks feature flag in config.toml')
      configUpdated = true
    } else {
      console.log('  ✓ codex_hooks feature flag already enabled')
    }
  } else {
    console.log('  ✗ config.toml not found. Skipping feature flag.')
  }

  // 2. Write/update hooks.json with session-id hook
  let hooksConfig: any = { hooks: {} }
  let hooksExisted = false

  if (fs.existsSync(HOOKS_JSON_PATH)) {
    hooksExisted = true
    try {
      hooksConfig = JSON.parse(fs.readFileSync(HOOKS_JSON_PATH, 'utf-8'))
      if (!hooksConfig.hooks) hooksConfig.hooks = {}
    } catch {
      console.log('  ⚠ Failed to parse hooks.json, recreating...')
      hooksConfig = { hooks: {} }
    }
  }

  // Check if session-id hook already registered
  const sessionStartHooks: unknown[] = Array.isArray(hooksConfig.hooks.SessionStart)
    ? hooksConfig.hooks.SessionStart
    : []

  if (hasHookScript(sessionStartHooks, 'session-id-hook.sh')) {
    console.log('  ✓ Session ID hook already installed in hooks.json')
  } else {
    const entry = {
      hooks: [{ type: 'command', command: `bash ${SESSION_ID_HOOK_SCRIPT}`, timeout: 5 }],
    }
    hooksConfig.hooks.SessionStart = [...sessionStartHooks, entry]

    if (hooksExisted) {
      fs.copyFileSync(HOOKS_JSON_PATH, HOOKS_JSON_PATH + '.bak')
    }
    fs.writeFileSync(HOOKS_JSON_PATH, JSON.stringify(hooksConfig, null, 2) + '\n')
    console.log('  ✓ Added session-id hook to hooks.json')
  }

  if (configUpdated) {
    console.log('  ⚡ Restart Codex CLI for hooks to take effect.\n')
  } else {
    console.log()
  }
}

// Direct execution support
const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('setup-hooks.ts') ||
  process.argv[1].endsWith('setup-hooks.js')
)
if (isDirectRun) setupHooks()
