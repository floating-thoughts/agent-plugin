import type { KV } from './store'

export const UNINSTALL_COMMAND = 'claude plugin uninstall agent-services@agent-plugin'
export const REMOVE_MAX_FILES = 5000
export const REMOVE_MAX_DEPTH = 6

export type RemoveFs = {
  list(path: string): Promise<readonly { name: string; kind?: string }[]>
  write(path: string, text: string): Promise<void>
}

export type RemoveDeps = {
  logout: () => Promise<string>
  trustOff: () => Promise<string>
  store: KV
  fs: RemoveFs | null
  dirs: () => Promise<string[]>
  stopLog?: () => void
  allowed?: (dir: string) => Promise<boolean>
}

export function dataDirAllowed(dir: string, configDir: string): boolean {
  const n = (p: string) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const d = n(dir)
  if (!d || d.split('/').some((s) => s === '..' || s === '.')) return false
  if (/(?:^|\/)\.agent-services$/.test(d)) return true
  const data = `${n(configDir)}/plugins/data/`
  return n(configDir) !== '' && d.startsWith(data) && /^agent-services[^/]*$/.test(d.slice(data.length))
}

let removed = false

export function isRemoved(): boolean {
  return removed
}

export function resetRemoved(): void {
  removed = false
}

export function markRemoved(): void {
  removed = true
}

export function removedMarker(dataDir: string): string {
  return `${dataDir.replace(/[\\/]+$/, '')}/REMOVED`
}

type Found = { files: string[]; seen: Set<string>; over: number; deep: Set<string> }

async function walk(fs: RemoveFs, dir: string, depth: number, out: Found, newestFirst = false): Promise<void> {
  if (out.over >= REMOVE_MAX_FILES) return
  if (depth > REMOVE_MAX_DEPTH) {
    out.deep.add(dir)
    return
  }
  let entries: readonly { name: string; kind?: string }[]
  try {
    entries = await fs.list(dir)
  } catch {
    return
  }
  if (newestFirst) entries = [...entries].sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
  for (const e of entries) {
    if (out.over >= REMOVE_MAX_FILES) return
    const p = `${dir}/${e.name}`
    if (e.kind === 'dir') await walk(fs, p, depth + 1, out, newestFirst)
    else if (!out.seen.has(p)) {
      out.seen.add(p)
      if (out.files.length < REMOVE_MAX_FILES) out.files.push(p)
      else out.over++
    }
  }
}

export async function removeAll(d: RemoveDeps): Promise<string> {
  const lines: string[] = []
  const step = async (f: () => Promise<string>, failed: string): Promise<void> => {
    try {
      lines.push(await f())
    } catch {
      lines.push(failed)
    }
  }
  await step(d.logout, 'Sign-out: it did not finish; the stored sign-in is deleted below anyway.')
  await step(d.trustOff, 'CLAUDE.md: the agent-services section could not be checked; look for it by hand.')
  removed = true
  try {
    d.stopLog?.()
  } catch {
  }
  const asked = (await d.dirs().catch(() => [] as string[])).filter((x, i, a) => x && a.indexOf(x) === i)
  const dirs: string[] = []
  const refused: string[] = []
  for (const x of asked) ((!d.allowed || (await d.allowed(x).catch(() => false))) ? dirs : refused).push(x)
  if (refused.length) {
    lines.push(`Not emptied: ${refused.join(', ')} (not a folder named .agent-services or the plugin data folder ` +
      'Claude Code gives agent-services, so nothing in it was changed); if it holds agent-services data, delete it yourself.')
  }
  if (!d.fs) lines.push('Local files: this session cannot reach them; delete these folders yourself: ' + dirs.join(', '))
  else {
    const found: Found = { files: [], seen: new Set(), over: 0, deep: new Set() }
    for (const dir of dirs) await walk(d.fs, `${dir}/services/outbox`, 2, found, true)
    for (const dir of dirs) await walk(d.fs, dir, 0, found)
    const files = found.files
    let emptied = 0
    const left: string[] = []
    for (const p of files) {
      try {
        await d.fs.write(p, '')
        emptied++
      } catch {
        left.push(p)
      }
    }
    lines.push(
      `Local files: emptied ${emptied} file${emptied === 1 ? '' : 's'} (overwritten with nothing: Claude Code gives ` +
        'plugins no way to delete a file) in ' + (dirs.length ? dirs.join(' and ') : 'no folder') + '. ' +
        'You can delete these folders yourself.' +
        (left.length ? ` ${left.length} could not be emptied, for example ${left[0]}.` : '') +
        (found.over ? ` Only ${REMOVE_MAX_FILES} files are emptied in one run (the request log first): ${found.over}` +
          `${found.over >= REMOVE_MAX_FILES ? ' or more' : ''} were left as they were; delete the folders yourself.` : '') +
        (found.deep.size ? ` ${found.deep.size} folder${found.deep.size === 1 ? '' : 's'} nested more than ` +
          `${REMOVE_MAX_DEPTH} levels deep ${found.deep.size === 1 ? 'was' : 'were'} not opened, so the files in ` +
          `${found.deep.size === 1 ? 'it were' : 'them were'} left as they were; delete the folders yourself.` : ''),
    )
    if (dirs[0]) {
      try {
        await d.fs.write(removedMarker(dirs[0]), 'agent-services was removed here (/agent-services remove). While this ' +
          'file holds text, the plugin does nothing in any session; signing in again clears it.\n')
      } catch {
      }
    }
  }
  let keys: string[] = []
  try {
    keys = await d.store.keys()
  } catch {
    keys = []
  }
  let gone = 0
  for (const k of keys) {
    try {
      await d.store.delete(k)
      gone++
    } catch {
    }
  }
  lines.push(
    `Plugin store: deleted ${gone} of ${keys.length} stored values, the sign-in credential included.` +
      (gone < keys.length ? ' Some could not be deleted; uninstalling the plugin removes its store.' : ''),
  )
  lines.push(
    'Not changed by this: your private savings page this plugin published to your claude.ai account (delete it ' +
      'there), and what the service keeps for your account (see DATA.md in the plugin, or /agent-services info data).',
  )
  lines.push('This session\'s agent-services hooks now do nothing more; other open Claude Code sessions stop within ' +
    'a few seconds (they see the REMOVED file this left in the data folder). Close them, then, as the last step, in a ' +
    'terminal:')
  lines.push(UNINSTALL_COMMAND)
  return lines.join('\n')
}
