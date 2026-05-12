/**
 * Runtime configuration — centralized path and port resolution.
 * Used by server, CLI, and read-insights tool.
 *
 * NOTE: This file uses Node-only APIs (fs/path/os).
 * It must NOT be imported by frontend code.
 */

import { join } from 'path'
import { homedir } from 'os'
import { existsSync, mkdirSync } from 'fs'

export const DEFAULT_PORT = 38473

export function getHomeDir(): string {
  return process.env.SESSION_DASHBOARD_HOME || join(homedir(), '.session-dashboard')
}

export function getDbPath(): string {
  const dataDir = join(getHomeDir(), 'data')
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  return join(dataDir, 'dashboard.db')
}

export function getPidPath(): string {
  return join(getHomeDir(), 'server.pid')
}

export function getLogPath(): string {
  return join(getHomeDir(), 'server.log')
}

export function getPort(): number {
  const env = process.env.SESSION_DASHBOARD_PORT
  return env ? parseInt(env, 10) : DEFAULT_PORT
}
