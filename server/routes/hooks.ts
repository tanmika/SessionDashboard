import { Router } from 'express'
import fs from 'fs'
import path from 'path'
import os from 'os'

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json')

const HOOK_SCRIPT_PATH = path.resolve(
  import.meta.dirname,
  '../../hooks/session-hook.sh'
)

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

function hasSessionHook(eventHooks: unknown[]): boolean {
  return eventHooks.some((item: any) => {
    if (typeof item?.command === 'string' && item.command.includes('session-hook.sh')) return true
    if (Array.isArray(item?.hooks)) {
      return item.hooks.some(
        (h: any) => typeof h?.command === 'string' && h.command.includes('session-hook.sh')
      )
    }
    return false
  })
}

export function createHookRoutes(): Router {
  const router = Router()

  router.get('/hooks/status', (_req, res) => {
    let settings: any = {}
    let settingsFound = true

    try {
      settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'))
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        settingsFound = false
      } else {
        res.status(500).json({ ok: false, error: String(err) })
        return
      }
    }

    const hooks = settings.hooks || {}
    const events = REQUIRED_EVENTS.map((event) => {
      const eventHooks: unknown[] = Array.isArray(hooks[event]) ? hooks[event] : []
      return { event, installed: hasSessionHook(eventHooks) }
    })

    const installedCount = events.filter((e) => e.installed).length

    res.json({
      ok: true,
      data: {
        configured: installedCount === REQUIRED_EVENTS.length,
        settingsFound,
        settingsPath: SETTINGS_PATH,
        hookScriptPath: HOOK_SCRIPT_PATH,
        events,
        installedCount,
        totalRequired: REQUIRED_EVENTS.length,
        setupCommand: 'npm run setup:hooks',
      },
    })
  })

  return router
}
