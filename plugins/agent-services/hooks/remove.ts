// /agent-services remove: undo what this plugin set up on this computer, then print the one
// uninstall command. Only the slash command runs it (the setup tool cannot): the user must type it.
//
// Order: sign out (the server ends the sign-in), take the CLAUDE.md section out (the same checks as trust off),
// stop this session's request log, empty every file under the plugin's folders, then delete every value in the
// plugin's store (the sign-in credential included). Claude Code gives plugins no way to delete a file ($.fs has no
// delete), so files are overwritten with nothing and the answer says so. After it ran, this session's hooks do
// nothing more (isRemoved), so nothing is written again before the plugin is uninstalled. Other open sessions see the
// marker file it leaves (removedMarker: <data dir>/REMOVED, checked by the outbox at every flush tick and by the update
// check) and stop too; a sign-in clears the marker.
// Harness-neutral: everything comes in through RemoveDeps.
import type { KV } from './store'

export const UNINSTALL_COMMAND = 'claude plugin uninstall agent-services@agent-plugin'
export const REMOVE_MAX_FILES = 5000 // files emptied at most in one run
export const REMOVE_MAX_DEPTH = 6 // folder levels walked at most

export type RemoveFs = {
  list(path: string): Promise<readonly { name: string; kind?: string }[]>
  write(path: string, text: string): Promise<void>
}

export type RemoveDeps = {
  logout: () => Promise<string> // the sign-out answer
  trustOff: () => Promise<string> // the CLAUDE.md answer (trust off)
  store: KV
  fs: RemoveFs | null
  dirs: () => Promise<string[]> // the folders this plugin owns: its data folder, the plugin data folder
  stopLog?: () => void // this session's request log writes nothing more
}

let removed = false

/** True once /agent-services remove ran in this session: the hooks then pass every event through untouched. */
export function isRemoved(): boolean {
  return removed
}

/** For the tests, and after a sign-in: a new start. */
export function resetRemoved(): void {
  removed = false
}

/** Another session ran /agent-services remove (its marker file is there): this session does nothing more either. */
export function markRemoved(): void {
  removed = true
}

/** The marker file /agent-services remove leaves in the data folder; while it holds text, every session stops. */
export function removedMarker(dataDir: string): string {
  return `${dataDir.replace(/[\\/]+$/, '')}/REMOVED`
}

// The files found: the first REMOVE_MAX_FILES are emptied; past that they are only counted (up to as many again).
type Found = { files: string[]; seen: Set<string>; over: number }

async function walk(fs: RemoveFs, dir: string, depth: number, out: Found, newestFirst = false): Promise<void> {
  if (depth > REMOVE_MAX_DEPTH || out.over >= REMOVE_MAX_FILES) return
  let entries: readonly { name: string; kind?: string }[]
  try {
    entries = await fs.list(dir)
  } catch {
    return // not there
  }
  // the request log's files are named by day: the newest sort last by name
  if (newestFirst) entries = [...entries].sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
  for (const e of entries) {
    if (out.over >= REMOVE_MAX_FILES) return
    const p = `${dir}/${e.name}`
    if (e.kind === 'dir' || e.kind === 'directory') await walk(fs, p, depth + 1, out, newestFirst)
    else if (!out.seen.has(p)) {
      out.seen.add(p)
      if (out.files.length < REMOVE_MAX_FILES) out.files.push(p)
      else out.over++
    }
  }
}

/** Runs the removal; always answers a text (each step says how it went). */
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
    // the files are emptied below anyway
  }
  const dirs = (await d.dirs().catch(() => [] as string[])).filter((x, i, a) => x && a.indexOf(x) === i)
  if (!d.fs) lines.push('Local files: this session cannot reach them; delete these folders yourself: ' + dirs.join(', '))
  else {
    const found: Found = { files: [], seen: new Set(), over: 0 }
    // the request log first (newest first), so a full folder never keeps the latest requests
    for (const dir of dirs) await walk(d.fs, `${dir}/services/outbox`, 1, found, true)
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
          `${found.over >= REMOVE_MAX_FILES ? ' or more' : ''} were left as they were; delete the folders yourself.` : ''),
    )
    if (dirs[0]) {
      try {
        await d.fs.write(removedMarker(dirs[0]), 'agent-services was removed here (/agent-services remove). While this ' +
          'file holds text, the plugin does nothing in any session; signing in again clears it.\n')
      } catch {
        // the other sessions stop at their next start without the plugin
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
      // counted below
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
