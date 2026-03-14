/**
 * Session Dashboard — Hook Setup Script
 * Usage: npm run setup:hooks
 *
 * Installs the required Claude Code hooks into ~/.claude/settings.json.
 * Safe to run multiple times (idempotent).
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json')
const HOOK_SCRIPT = path.resolve(__dirname, '..', 'hooks', 'session-hook.sh')

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

/** Check both hook-group format and direct format for session-hook.sh */
function hasSessionHook(eventHooks: unknown[]): boolean {
  return eventHooks.some((item: any) => {
    // Direct format: { type, command }
    if (typeof item?.command === 'string' && item.command.includes('session-hook.sh')) return true
    // Hook-group format: { hooks: [{ type, command }] }
    if (Array.isArray(item?.hooks)) {
      return item.hooks.some(
        (h: any) => typeof h?.command === 'string' && h.command.includes('session-hook.sh')
      )
    }
    return false
  })
}

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
  if (hasSessionHook(existing)) {
    skipped.push(event)
  } else {
    settings.hooks[event] = [...existing, newEntry]
    added.push(event)
  }
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
