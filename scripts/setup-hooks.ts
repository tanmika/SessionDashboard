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

function removeHookScript(eventHooks: unknown[], scriptName: string): unknown[] {
  return eventHooks.flatMap((item: any) => {
    if (typeof item?.command === 'string') {
      return item.command.includes(scriptName) ? [] : [item]
    }

    if (Array.isArray(item?.hooks)) {
      const hooks = item.hooks.filter(
        (hook: any) => !(typeof hook?.command === 'string' && hook.command.includes(scriptName))
      )
      if (hooks.length === 0) return []
      return [{ ...item, hooks }]
    }

    return [item]
  })
}

function ensureCodexHooksEnabled(configPath: string): { created: boolean; updated: boolean } {
  const existed = fs.existsSync(configPath)
  let toml = existed ? fs.readFileSync(configPath, 'utf-8') : ''
  const original = toml

  const codexHooksLineRe = /^(\s*codex_hooks\s*=\s*)(true|false)(\s*)$/m
  if (codexHooksLineRe.test(toml)) {
    toml = toml.replace(codexHooksLineRe, '$1true$3')
  } else if (toml.includes('[features]')) {
    toml = toml.replace('[features]', '[features]\ncodex_hooks = true')
  } else if (toml.trim().length === 0) {
    toml = '[features]\ncodex_hooks = true\n'
  } else {
    toml = '[features]\ncodex_hooks = true\n\n' + toml
  }

  if (toml === original) {
    return { created: false, updated: false }
  }

  if (existed) {
    fs.copyFileSync(configPath, configPath + '.bak')
  }
  fs.writeFileSync(configPath, toml)

  return { created: !existed, updated: true }
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
  const CODEX_HOOK_SCRIPT = path.resolve(packageRoot, 'hooks', 'codex-session-hook.sh')

  console.log('\n  Session Dashboard — Codex Hook Setup\n  ' + '─'.repeat(38))

  if (!fs.existsSync(CODEX_DIR)) {
    console.log('  ✗ ~/.codex/ not found. Skipping Codex hook setup.')
    return
  }

  // 1. Ensure [features] codex_hooks = true in config.toml
  const configResult = ensureCodexHooksEnabled(CONFIG_TOML_PATH)
  if (configResult.updated) {
    console.log(`  ✓ ${configResult.created ? 'Created' : 'Updated'} config.toml with codex_hooks = true`)
  } else {
    console.log('  ✓ codex_hooks feature flag already enabled')
  }

  // 2. Write/update hooks.json with Codex SessionStart/Stop hooks
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

  const sessionStartHooksRaw: unknown[] = Array.isArray(hooksConfig.hooks.SessionStart)
    ? hooksConfig.hooks.SessionStart
    : []
  const stopHooksRawUnfiltered: unknown[] = Array.isArray(hooksConfig.hooks.Stop)
    ? hooksConfig.hooks.Stop
    : []

  const sessionStartHooks = removeHookScript(sessionStartHooksRaw, 'session-id-hook.sh')
  const stopHooksRaw = removeHookScript(stopHooksRawUnfiltered, 'stop-hook.sh')
  const hasStartHook = hasHookScript(sessionStartHooks, 'codex-session-hook.sh')
  const hasStopHook = hasHookScript(stopHooksRaw, 'codex-session-hook.sh')

  if (!hasStartHook) {
    sessionStartHooks.push({
      hooks: [{ type: 'command', command: `bash ${CODEX_HOOK_SCRIPT}`, timeout: 5 }],
    })
  }
  if (!hasStopHook) {
    stopHooksRaw.push({
      hooks: [{ type: 'command', command: `bash ${CODEX_HOOK_SCRIPT}`, timeout: 5 }],
    })
  }

  hooksConfig.hooks.SessionStart = sessionStartHooks
  hooksConfig.hooks.Stop = stopHooksRaw

  const hooksChanged =
    !hasStartHook ||
    !hasStopHook ||
    sessionStartHooks.length !== sessionStartHooksRaw.length ||
    stopHooksRaw.length !== stopHooksRawUnfiltered.length

  if (hooksChanged) {
    if (hooksExisted) {
      fs.copyFileSync(HOOKS_JSON_PATH, HOOKS_JSON_PATH + '.bak')
    }
    fs.writeFileSync(HOOKS_JSON_PATH, JSON.stringify(hooksConfig, null, 2) + '\n')
    console.log('  ✓ Installed Codex SessionStart/Stop hooks in hooks.json')
  } else {
    console.log('  ✓ Codex SessionStart/Stop hooks already installed in hooks.json')
  }

  console.log('  ⚡ Restart Codex CLI for hooks to take effect.\n')
}

// Direct execution support
const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('setup-hooks.ts') ||
  process.argv[1].endsWith('setup-hooks.js')
)
if (isDirectRun) setupHooks()
