// The Claude Code environment over `$` (cleanup route R6, moved from command.ts unchanged): environment variables
// by literal name, the home and config folders, the agent-services data folder, file reads and the Claude account
// hash. Used by command.ts, register.ts, dashboard.ts and update.ts (through command.ts).
import type { EngineInterface } from 'claude-code'
import { sha256Hex, utf8 } from './e2e'

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)

// ------------------------------------------------------------------ the Claude account hash (plan 3.4 item 2)

/** sha256 hex of oauthAccount.accountUuid from .claude.json (under CLAUDE_CONFIG_DIR first, then the home folder);
 * "" when there is none. The raw id never leaves this function. */
export async function claudeHashOf(readText: (path: string) => Promise<string | null>, dirs: readonly string[]): Promise<string> {
  for (const d of dirs) {
    if (!d) continue
    let data: unknown
    try {
      const t = await readText(`${d.replace(/[\\/]+$/, '')}/.claude.json`)
      if (t === null) continue
      data = JSON.parse(t)
    } catch {
      continue
    }
    const uid = isObj(data) && isObj(data.oauthAccount) ? data.oauthAccount.accountUuid : null
    return typeof uid === 'string' && uid ? sha256Hex(utf8(uid)) : ''
  }
  return ''
}

// ------------------------------------------------------------------ the engine environment

export async function envOf($: EngineInterface, name: string): Promise<string | undefined> {
  // $.env.get takes literal names only (the engine reads them off the source)
  switch (name) {
    case 'HOME':
      return $.env.get('HOME')
    case 'USERPROFILE':
      return $.env.get('USERPROFILE')
    case 'CLAUDE_CONFIG_DIR':
      return $.env.get('CLAUDE_CONFIG_DIR')
    case 'DISABLE_UPDATES':
      return $.env.get('DISABLE_UPDATES')
    case 'DISABLE_AUTOUPDATER':
      return $.env.get('DISABLE_AUTOUPDATER')
    case 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC':
      return $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')
    case 'FORCE_AUTOUPDATE_PLUGINS':
      return $.env.get('FORCE_AUTOUPDATE_PLUGINS')
    default:
      return undefined
  }
}

/** <home> and <config dir> as plan 0.2 builds them (HOME, else USERPROFILE; CLAUDE_CONFIG_DIR, else <home>/.claude). */
export async function engineDirs($: EngineInterface): Promise<{ home: string; configDir: string; configSet: boolean }> {
  const get = async (n: string) => {
    try {
      return (await envOf($, n)) || ''
    } catch {
      return ''
    }
  }
  const home = ((await get('HOME')) || (await get('USERPROFILE'))).replace(/[\\/]+$/, '')
  const cfg = (await get('CLAUDE_CONFIG_DIR')).replace(/[\\/]+$/, '')
  return { home, configDir: cfg || `${home}/.claude`, configSet: Boolean(cfg) }
}

/** The data dir, as Python's default_data_dir(): AGENT_SVC_DATA_DIR, else <home>/.agent-services (home is
 * USERPROFILE on Windows). The outbox, the dashboard page and the migration's MIGRATED file live there. */
export async function dataDir($: EngineInterface): Promise<string> {
  const text = async (read: () => Promise<unknown>): Promise<string> => {
    try {
      return String((await read()) ?? '').trim()
    } catch {
      return ''
    }
  }
  const own = await text(() => $.env.get('AGENT_SVC_DATA_DIR'))
  if (own) return own.replace(/[\\/]+$/, '')
  const home = await text(() => $.env.get('HOME'))
  const profile = await text(() => $.env.get('USERPROFILE'))
  const windows = (await text(() => $.env.get('OS'))) === 'Windows_NT'
  return `${(windows ? profile || home : home || profile).replace(/[\\/]+$/, '')}/.agent-services`
}

export function readTextOf($: EngineInterface): (path: string) => Promise<string | null> {
  return async (path) => {
    try {
      return String(await $.fs.read(path))
    } catch {
      return null
    }
  }
}

/** The Claude account hash for Svc's claudeHash dependency (plan 3.4 item 2). */
export function engineClaudeHash($: EngineInterface): () => Promise<string> {
  return async () => {
    const d = await engineDirs($)
    return claudeHashOf(readTextOf($), d.configSet ? [d.configDir, d.home] : [d.home])
  }
}
