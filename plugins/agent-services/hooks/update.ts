// agent-services self-update: keeps this plugin current with Claude Code's own CLI, the path that works where the
// desktop app's Update button and the off-by-default background auto-update do not. START_DELAY_MS after
// session.start and every CHECK_EVERY_MS after, never awaited by a hook: at most every UPDATE_EVERY_MS, and by one session on this computer
// at a time (a lease in the shared state file), it runs `claude plugin marketplace update <marketplace>` and
// `claude plugin update <our id> --json`. A session that then runs an older copy than the one installed reloads its
// plugins once from that copy (terminal), or says once that a new session uses the update (desktop app). Skipped while
// the gate is closed (signed out; a gate closed for an upgrade still updates), with
// CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC set, and in -p runs. Every failure is swallowed: only lastUpdateError keeps it.
import type { EngineInterface } from 'claude-code'
import { dataDir } from './core'

export const START_DELAY_MS = 30_000 // the first check waits this long: nothing is spawned while a session starts
export const CHECK_EVERY_MS = 600_000 // how often a session reads the shared state (one file read)
export const UPDATE_EVERY_MS = 6 * 3_600_000 // how often the CLI update runs, across all sessions
export const LEASE_MS = 300_000 // a session updating holds the others off this long
export const LEASE_SETTLE_MS = 2_000 // a lease written is read back after this, so one of two writers wins
export const RELOAD_SETTLE_MS = 10_000 // a reload right after `plugin update` would load the copy before it
const RUN_TIMEOUT_MS = 120_000
const UPGRADE_HINT = 'no longer accepted' // host/services.py GATE_NOTICES["upgrade"]
const STATE_NAME = 'plugin-update.json'

type Row = Record<string, unknown>
type Lease = { owner: string; at: number }
type Shared = { checkedAt?: number; updatedAt?: number; version?: string; lease?: Lease | null }
export type UpdateRun = { kind: 'updated'; to: string } | { kind: 'current' } | { kind: 'failed'; reason: string }

const parse = (text: unknown): unknown => {
  try {
    return JSON.parse(String(text))
  } catch {
    return null
  }
}
const rowsOf = (listJson: string): Row[] => {
  const rows = parse(listJson)
  return Array.isArray(rows) ? rows.filter((r): r is Row => typeof r === 'object' && r !== null) : []
}
const nameOf = (id: string) => id.slice(0, id.lastIndexOf('@'))
// Our `<name>@<marketplace>` id as `claude plugin list --json` lists it; null when not installed from a marketplace.
export const idOf = (listJson: string, plugin: string): string | null =>
  rowsOf(listJson).map(r => r.id).find((id): id is string => typeof id === 'string' && id.includes('@') && nameOf(id) === plugin) ?? null
const folderOf = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
const parentOf = (p: string) => folderOf(p).replace(/\/[^/]*$/, '')
// Whether the copy loaded from `root` is an installed version beside the one now listed (a --plugin-dir copy never is).
export function runsOlderCopy(listJson: string, id: string, root: string): boolean {
  const at = rowsOf(listJson).find(r => r.id === id)?.installPath
  return typeof at === 'string' && folderOf(at) !== folderOf(root) && parentOf(at) === parentOf(root)
}
const versionIn = (listJson: string, id: string) => String(rowsOf(listJson).find(r => r.id === id)?.version ?? '').slice(0, 12)
// `claude plugin update --json`: its result line, or the message an older Claude Code prints.
export function readUpdate(exitCode: number, stdout: string, stderr: string): UpdateRun {
  const r = parse(stdout.trim().split('\n').pop() ?? '') as { updateOutcome?: unknown; newVersion?: unknown; message?: unknown } | null
  if (r?.updateOutcome === 'updated') return { kind: 'updated', to: String(r.newVersion ?? '') }
  if (r?.updateOutcome === 'up_to_date') return { kind: 'current' }
  const moved = /updated from (\S+) to (\S+)/.exec(`${stdout}\n${stderr}`)
  if (moved) return { kind: 'updated', to: moved[2] ?? '' }
  if (exitCode === 0) return { kind: 'current' }
  const reason = typeof r?.message === 'string' ? r.message : `${stdout}\n${stderr}`.trim().split('\n').pop()
  return { kind: 'failed', reason: reason || `exit ${exitCode}` }
}

let gate: 'open' | 'closed' | 'upgrade' = 'open'
let loadedAt: number | null = null
let seenUpdate = 0 // the shared updatedAt this session has acted on
let running: Promise<void> | null = null
let started = false
let retry = false // a reload was refused: the next check lists again
let told: string | null = null // the copy this session has logged the update line from
export let lastUpdateError: string | null = null

// Every core answer passes here: 'inactive' closes the gate (its notice, given once, tells an upgrade apart).
export function noteGate(a: { fallback: string | null; notice: string | null }): void {
  if (a.fallback !== 'inactive') gate = 'open'
  else if (typeof a.notice === 'string' && a.notice.includes(UPGRADE_HINT)) gate = 'upgrade'
  else if (a.notice || gate === 'open') gate = 'closed'
}

// an engine call that may throw or reject: `d` then
const safe = <T>(f: () => Promise<T> | T, d: T): Promise<T> => Promise.resolve().then(f).catch(() => d)
const text = async (read: () => Promise<unknown>) => String((await safe(read, '')) ?? '').trim()
const sleep = ($: EngineInterface, ms: number) => new Promise<void>(done => void $.clock.after(ms, () => done()))
async function statePath($: EngineInterface): Promise<string> {
  const own = (await text(() => $.env.get('CLAUDE_PLUGIN_DATA'))).replace(/[\\/]+$/, '')
  return own ? `${own}/${STATE_NAME}` : `${await dataDir($)}/services/${STATE_NAME}`
}
const readShared = async ($: EngineInterface, path: string): Promise<Shared> => {
  const s = parse(await safe(() => $.fs.read(path), null))
  return s && typeof s === 'object' && !Array.isArray(s) ? (s as Shared) : {}
}
const writeShared = ($: EngineInterface, path: string, s: Shared) => $.fs.write(path, JSON.stringify(s))

// The lease: free or stale -> written, read back after LEASE_SETTLE_MS; ours only if our write is still there.
async function takeLease($: EngineInterface, path: string, now: number): Promise<Lease | null> {
  const held = (await readShared($, path)).lease
  if (held && now - held.at < LEASE_MS) return null
  const mine = { owner: Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join(''), at: now }
  await writeShared($, path, { ...(await readShared($, path)), lease: mine })
  await sleep($, LEASE_SETTLE_MS)
  return (await readShared($, path)).lease?.owner === mine.owner ? mine : null
}

async function run($: EngineInterface, interactive: boolean): Promise<void> {
  if (gate === 'closed' || (await text(() => $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')))) return
  if (!interactive && ((await safe(() => $.session.surfaces(), [])) ?? []).length === 0) return // a -p run
  const now = await $.clock.now()
  loadedAt ??= now
  const path = await statePath($)
  const shared = await readShared($, path)
  const due = now - (shared.checkedAt ?? 0) >= UPDATE_EVERY_MS
  if (!due && !retry && !((shared.updatedAt ?? 0) > Math.max(loadedAt, seenUpdate))) return // nothing new since loaded
  retry = false
  seenUpdate = Math.max(seenUpdate, shared.updatedAt ?? 0)
  const exe = (await text(() => $.env.get('CLAUDE_CODE_EXECPATH'))) || 'claude'
  const list = async () => (await $.process.run([exe, 'plugin', 'list', '--json'], { timeoutMs: 60_000 })).stdout
  let listed = await list()
  const id = idOf(listed, $.plugin.name)
  if (id === null) return
  let updated: string | null = null
  const lease = due ? await takeLease($, path, now) : null
  if (lease) {
    try {
      await $.process.run([exe, 'plugin', 'marketplace', 'update', id.slice(id.lastIndexOf('@') + 1)], { timeoutMs: RUN_TIMEOUT_MS })
      const r = await $.process.run([exe, 'plugin', 'update', id, '--json'], { timeoutMs: RUN_TIMEOUT_MS })
      const out = readUpdate(r.exitCode, String(r.stdout ?? ''), String(r.stderr ?? ''))
      lastUpdateError = out.kind === 'failed' ? out.reason.slice(0, 200) : null
      if (out.kind === 'updated') updated = out.to.slice(0, 12)
    } finally {
      const s = await readShared($, path)
      const stamp = updated !== null ? { updatedAt: (seenUpdate = await $.clock.now()), version: updated } : {}
      await writeShared($, path, { ...s, checkedAt: now, ...stamp, lease: s.lease?.owner === lease.owner ? null : s.lease })
    }
    if (updated === null) return
    await sleep($, RELOAD_SETTLE_MS)
    listed = await list()
  }
  if (!runsOlderCopy(listed, id, $.plugin.root)) return
  const version = updated || versionIn(listed, id) || 'a new version'
  const key = interactive ? 'reloadedFrom' : 'restartNotedFrom'
  if ((await $.store.get(key)) === $.plugin.root) return // once from each copy
  await $.store.set(key, $.plugin.root)
  if (told !== $.plugin.root) $.ui.log(`agent-services: updated to ${version}; ${interactive ? 'reloading' : 'a new session will use it'}`)
  told = $.plugin.root
  if (interactive && !(await safe(() => $.command.run({ command: 'reload-plugins' }).then(() => true), false))) {
    await safe(() => $.store.delete(key), undefined) // refused (say a turn waits on a call): again at the next check
    retry = true
  }
}

// One check at a time in this session.
function check($: EngineInterface, interactive: boolean): Promise<void> {
  running ??= run($, interactive)
    .catch(err => void (lastUpdateError = String(err instanceof Error ? err.message : err).slice(0, 200)))
    .finally(() => void (running = null))
  return running
}

// From session.start: schedules the checks once per loaded copy. Never throws, never waits.
export function selfUpdate($: EngineInterface, interactive: boolean): void {
  if (started) return
  started = true
  try {
    $.clock.after(START_DELAY_MS, () => void check($, interactive))
    $.clock.every(CHECK_EVERY_MS, () => void check($, interactive))
  } catch {}
}
