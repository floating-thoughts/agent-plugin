// agent-services update check (owner 2026-11-01): the plugin never updates itself; it only checks whether a newer
// version is listed, and the user decides. START_DELAY_MS after session.start and every CHECK_EVERY_MS after, never
// awaited by a hook: at most every UPDATE_EVERY_MS (a failed check counts too), and by one session on this computer at
// a time (a lease in the shared state file), it runs `claude plugin marketplace update <marketplace>` (which refreshes the marketplace's
// listing only) and `claude plugin list --json`, then compares the version installed with the version the marketplace
// lists. A newer one than this session's own version (and than the one installed) is told to the model once per
// version, at its next prompt (takeUpdateNote; review.ts updateNoteText),
// which asks the user; only the user's answer applies it (`/agent-services update` or the setup
// tool's "update", applyUpdate). Skipped while the gate is closed (signed out; a gate closed for an upgrade still
// checks), with CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC set, and in -p runs. Every failure is swallowed.
// Where the engine has no $.process (a surface without it), nothing is scheduled or run at all: the status line then
// shows the one terminal command at most every 7 days instead (wiring.ts, status.ts updateCommand).
import type { EngineInterface } from 'claude-code'
import { dataDir, engineDirs } from './engine_env'
import { updateCommand } from './status'
import { isRemoved, markRemoved, removedMarker } from './remove'

export const START_DELAY_MS = 30_000 // the first check waits this long: nothing is spawned while a session starts
export const CHECK_EVERY_MS = 600_000 // how often a session reads the shared state (one file read)
export const UPDATE_EVERY_MS = 3_600_000 // how often the listing is refreshed, across all sessions
export const LEASE_MS = 300_000 // a session checking holds the others off this long
export const LEASE_SETTLE_MS = 2_000 // a lease written is read back after this, so one of two writers wins
const RUN_TIMEOUT_MS = 120_000
const UPGRADE_HINT = 'no longer accepted' // the service gate's upgrade notice
const STATE_NAME = 'plugin-update.json'

type Row = Record<string, unknown>
type Lease = { owner: string; at: number }
// installed and latest: what the last check saw; noted: the newest version a session has told its model about
type Shared = { checkedAt?: number; installed?: string; latest?: string; noted?: string; lease?: Lease | null }
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
export const versionIn = (listJson: string, id: string): string =>
  String(rowsOf(listJson).find(r => r.id === id)?.version ?? '').slice(0, 40)

/** The version a marketplace manifest (.claude-plugin/marketplace.json) lists for `plugin`; '' when none. Pure. */
export function listedVersion(manifest: string, plugin: string): string {
  const m = parse(manifest) as { plugins?: unknown } | null
  const rows = m && Array.isArray(m.plugins) ? m.plugins : []
  const row = rows.find((r: any) => r && typeof r === 'object' && r.name === plugin) as Row | undefined
  return typeof row?.version === 'string' ? row.version.slice(0, 40) : ''
}

/** Whether `latest` is newer than `installed`: dotted numbers compare by number, anything else when it differs. */
export function isNewer(latest: string, installed: string): boolean {
  if (!latest || !installed || latest === installed) return false
  const dotted = /^\d+(\.\d+)*$/
  if (!dotted.test(latest) || !dotted.test(installed)) return true
  const a = latest.split('.').map(Number)
  const b = installed.split('.').map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return false
}

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

export type Gate = 'open' | 'closed' | 'upgrade'
let gate: Gate = 'open'
let gateOf: (() => Promise<Gate>) | null = null
let running: Promise<void> | null = null
let started = false
let processMissing = false
let lastCheck: { at: number; what: string } | null = null // what this session's last check did, for the status
let seen: { installed: string; latest: string } | null = null // the last versions this session read
let toTell: { installed: string; latest: string } | null = null // a newer version not told to the model yet
let own: string | null = null // the version this session runs (the export's stamp); '' when unknown (a dev copy)
let applied: string | null = null // the last answer of applyUpdate in this session
let missingHook: (() => void) | null = null

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16)

/** The "Updates:" line of `/agent-services status`: the last check, the newest version seen, how to update; null
 * where this session runs no check (no $.process: status shows the terminal command on its own line then). */
export function updatesLine(): string | null {
  if (processMissing || !started) return null
  const last = lastCheck ? `last check ${hhmm(lastCheck.at)} UTC: ${lastCheck.what}`
    : 'the first check runs about 30 seconds after the session starts'
  const v = seen ? `; installed ${seen.installed || 'unknown'}, latest seen ${seen.latest || 'unknown'}` : ''
  const done = applied ? ` Last update here: ${applied}` : ''
  return `Updates: ${last}${v}; to update: /agent-services update. The plugin never updates itself.${done}`
}
async function noted($: EngineInterface, what: string): Promise<void> {
  lastCheck = { at: await safe(() => $.clock.now(), Date.now()), what }
}

// Every core answer passes here: 'inactive' closes the gate (its notice, given once, tells an upgrade apart).
export function noteGate(a: { fallback: string | null; notice: string | null }): void {
  if (a.fallback !== 'inactive') gate = 'open'
  else if (typeof a.notice === 'string' && a.notice.includes(UPGRADE_HINT)) gate = 'upgrade'
  else if (a.notice || gate === 'open') gate = 'closed'
}

// an engine call that may throw or reject: `d` then
const safe = <T>(f: () => Promise<T> | T, d: T): Promise<T> => Promise.resolve().then(f).catch(() => d)
const text = async (read: () => Promise<unknown>) => String((await safe(read, '')) ?? '').trim()
function sleep($: EngineInterface, ms: number): Promise<void> {
  return new Promise<void>(done => void $.clock.after(ms, () => done()))
}
async function statePath($: EngineInterface): Promise<string> {
  const own = (await text(() => $.env.get('CLAUDE_PLUGIN_DATA'))).replace(/[\\/]+$/, '')
  return own ? `${own}/${STATE_NAME}` : `${await dataDir($)}/services/${STATE_NAME}`
}
async function readShared($: EngineInterface, path: string): Promise<Shared> {
  const s = parse(await safe(() => $.fs.read(path), null))
  return s && typeof s === 'object' && !Array.isArray(s) ? (s as Shared) : {}
}
function writeShared($: EngineInterface, path: string, s: Shared) {
  return $.fs.write(path, JSON.stringify(s))
}

// The lease: free or stale -> written, read back after LEASE_SETTLE_MS; ours only if our write is still there.
async function takeLease($: EngineInterface, path: string, now: number): Promise<Lease | null> {
  const held = (await readShared($, path)).lease
  if (held && now - held.at < LEASE_MS) return null
  const mine = { owner: Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join(''), at: now }
  await writeShared($, path, { ...(await readShared($, path)), lease: mine })
  await sleep($, LEASE_SETTLE_MS)
  return (await readShared($, path)).lease?.owner === mine.owner ? mine : null
}

// The binary Claude Code runs on, else `claude` on PATH, else where its installers put it; '' when none runs.
async function findExe($: EngineInterface): Promise<{ exe: string; listed: string }> {
  const home = (await text(() => $.env.get('HOME'))) || (await text(() => $.env.get('USERPROFILE')))
  const tried = [await text(() => $.env.get('CLAUDE_CODE_EXECPATH')), 'claude', `${home}/.local/bin/claude`,
    `${home}/.local/bin/claude.exe`, `${home}/.claude/local/claude`, '/opt/homebrew/bin/claude', '/usr/local/bin/claude']
  for (const at of tried.filter((p, i, all) => p && !p.startsWith('/.') && all.indexOf(p) === i)) {
    try {
      const listed = String((await $.process.run([at, 'plugin', 'list', '--json'], { timeoutMs: 60_000 })).stdout ?? '')
      return { exe: at, listed }
    } catch {}
  }
  return { exe: '', listed: '' }
}

// The marketplace's manifest as Claude Code keeps it (known_marketplaces.json installLocation, else the usual folder).
async function manifestOf($: EngineInterface, marketplace: string): Promise<string> {
  const cfg = (await engineDirs($)).configDir
  const known = parse(await safe(() => $.fs.read(`${cfg}/plugins/known_marketplaces.json`), null)) as Row | null
  const entry = known && typeof known[marketplace] === 'object' ? (known[marketplace] as Row) : null
  const loc = typeof entry?.installLocation === 'string' ? entry.installLocation : `${cfg}/plugins/marketplaces/${marketplace}`
  return String((await safe(() => $.fs.read(`${loc.replace(/\\/g, '/')}/.claude-plugin/marketplace.json`), '')) ?? '')
}

// The version this session runs: the export's stamp (core/host/shell_stamp.json, the release version); '' for a dev copy.
async function ownVersion($: EngineInterface): Promise<string> {
  if (own === null) {
    const stamp = parse(await safe(() => $.fs.read(`${$.plugin.root}/core/host/shell_stamp.json`), null)) as Row | null
    own = typeof stamp?.shell === 'string' ? stamp.shell.slice(0, 40) : ''
  }
  return own
}

// `installed` is what a check listed (maybe by another session, maybe older than this session's own copy): the newer
// of it and this session's own version counts, so a session already on the newest version is told nothing.
function remember(installed: string, latest: string, noted: string | undefined, mine: string): void {
  const have = isNewer(mine, installed) ? mine : installed
  seen = { installed: have, latest }
  toTell = isNewer(latest, have) && noted !== latest ? { installed: have, latest } : null
}

async function run($: EngineInterface, interactive: boolean): Promise<void> {
  if (processMissing) return
  if (gateOf) gate = await gateOf().catch((): Gate => 'closed')
  if (gate === 'closed') {
    toTell = null // signed out: the model gets no note
    return noted($, 'skipped while signed out')
  }
  if (await text(() => $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'))) {
    return noted($, 'skipped (CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set)')
  }
  if (!interactive && ((await safe(() => $.session.surfaces(), [])) ?? []).length === 0) return // a -p run
  // another session ran /agent-services remove: nothing more here (its marker file)
  const marker = removedMarker(await dataDir($))
  if (String((await safe(() => $.fs.read(marker), '')) ?? '').trim()) return markRemoved()
  const now = await $.clock.now()
  const path = await statePath($)
  const shared = await readShared($, path)
  if (now - (shared.checkedAt ?? 0) < UPDATE_EVERY_MS) {
    // another session (or this one) checked lately: its answer stands
    if (shared.latest !== undefined) remember(shared.installed ?? '', shared.latest, shared.noted, await ownVersion($))
    return noted($, `not due (the check runs at most every ${UPDATE_EVERY_MS / 60_000} minutes; next after ` +
      `${hhmm((shared.checkedAt ?? 0) + UPDATE_EVERY_MS)} UTC)`)
  }
  const lease = await takeLease($, path, now)
  if (!lease) return noted($, 'another session is checking')
  let surfaceless = false // no $.process here: other sessions (another surface) may still check
  try {
    const { exe, listed } = await findExe($)
    if (!exe) {
      if (await probeProcess($)) return noted($, 'no claude command found to check with; trying again in an hour')
      // no $.process on this surface: run nothing from now on; the status line shows the terminal command instead
      surfaceless = true
      try {
        missingHook?.()
      } catch {}
      return noted($, 'this surface cannot run commands')
    }
    const id = idOf(listed, $.plugin.name)
    if (id === null) return noted($, `${exe} plugin list --json does not list ${$.plugin.name} from a marketplace`)
    const market = id.slice(id.lastIndexOf('@') + 1)
    // the listing only: this never installs or changes the plugin
    await $.process.run([exe, 'plugin', 'marketplace', 'update', market], { timeoutMs: RUN_TIMEOUT_MS })
    const installed = versionIn(listed, id)
    const latest = listedVersion(await manifestOf($, market), $.plugin.name)
    if (isRemoved()) return // /agent-services remove ran meanwhile: nothing is written again
    const s = await readShared($, path)
    await writeShared($, path, { ...s, checkedAt: now, installed, latest, lease: null })
    remember(installed, latest, s.noted, await ownVersion($))
    await noted($, !latest ? 'the marketplace lists no version' : isNewer(latest, installed)
      ? `version ${latest} is available (installed ${installed})` : 'the installed version is the latest')
  } finally {
    // a failed check counts as a check too (not listed from a marketplace, offline, a timeout): no session retries
    // before UPDATE_EVERY_MS has passed
    const s = isRemoved() ? {} : await readShared($, path)
    if (s.lease?.owner === lease.owner) {
      await writeShared($, path, surfaceless ? { ...s, lease: null } : { ...s, checkedAt: Math.max(s.checkedAt ?? 0, now), lease: null })
    }
  }
}

// One check at a time in this session.
function check($: EngineInterface, interactive: boolean): Promise<void> {
  if (isRemoved()) return Promise.resolve() // /agent-services remove ran: nothing more in this session
  running ??= run($, interactive)
    .catch(err => noted($, `the check failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`))
    .finally(() => void (running = null))
  return running
}

/** A newer version this session's model has not been told about yet, once per version on this computer (the shared
 * state keeps the version told); null when there is none. The caller takes it only when the note goes out at this
 * prompt (signed in, Claude Code's own auto-update off: command.ts onboardingNote). Only the noted field changes, read
 * just before the write. Never throws. */
export async function takeUpdateNote($: EngineInterface): Promise<{ installed: string; latest: string } | null> {
  try {
    if (!toTell) return null
    const t = toTell
    toTell = null
    const mine = await ownVersion($)
    if (mine && !isNewer(t.latest, mine)) return null // this session already runs it
    const path = await statePath($)
    const s = await readShared($, path)
    if (s.noted === t.latest) return null // another session told it
    await writeShared($, path, { ...s, noted: t.latest })
    return t
  } catch {
    return null
  }
}

/** Updates the plugin now, on the user's answer only (`/agent-services update`, the setup tool's "update"). Where
 * nothing can be run, the exact terminal command. Never throws. */
export async function applyUpdate($: EngineInterface, marketplace = 'agent-plugin'): Promise<string> {
  const by = `run this in a terminal: ${updateCommand(marketplace)}`
  let answer: string
  try {
    const { exe, listed } = processMissing ? { exe: '', listed: '' } : await findExe($)
    if (!exe) {
      if (!processMissing && !(await probeProcess($))) missingHook?.()
      answer = processMissing
        ? `Claude Code cannot run commands here, so the plugin was not updated. To update it, ${by}; then start a new session.`
        : `No claude command was found to update with. To update the plugin, ${by}; then start a new session.`
      return (applied = answer)
    }
    const id = idOf(listed, $.plugin.name) ?? `${$.plugin.name}@${marketplace}`
    await $.process.run([exe, 'plugin', 'marketplace', 'update', id.slice(id.lastIndexOf('@') + 1)], { timeoutMs: RUN_TIMEOUT_MS })
    const r = await $.process.run([exe, 'plugin', 'update', id, '--json'], { timeoutMs: RUN_TIMEOUT_MS })
    const out = readUpdate(r.exitCode, String(r.stdout ?? ''), String(r.stderr ?? ''))
    if (out.kind === 'updated') {
      const path = await statePath($)
      const s = await readShared($, path)
      await safe(() => writeShared($, path, { ...s, installed: out.to, noted: s.latest ?? out.to }), undefined)
      seen = { installed: out.to, latest: seen?.latest ?? out.to }
      toTell = null
      answer = `Updated agent-services to ${out.to}. Run /reload-plugins to use it in this session (in the desktop ` +
        'app, start a new session).'
    } else if (out.kind === 'current') answer = 'agent-services is already the latest version; nothing was changed.'
    else answer = `The update failed: ${out.reason.slice(0, 200)}. To update by hand, ${by}.`
  } catch (err) {
    answer = `The update could not run (${String(err instanceof Error ? err.message : err).slice(0, 120)}). To update ` +
      `by hand, ${by}.`
  }
  return (applied = answer)
}

/** False once a `$.process` call could not run here (a surface without it); true until then. */
export const canRunCommands = (): boolean => !processMissing

// The engine's own refusal of an empty argv (measured 2026-10-31, CLI 2.1.316): `$.process` is there.
const ARGV_REFUSAL = /non-empty list|argv/i

/** Whether this surface has `$.process`, found without running anything: an empty argv is refused by the engine's
 * own check where `$.process` exists, and the call fails otherwise. Once false, nothing is ever run here. */
export async function probeProcess($: EngineInterface): Promise<boolean> {
  let present: boolean
  try {
    await $.process.run([], { timeoutMs: 1000 })
    present = true
  } catch (err) {
    present = ARGV_REFUSAL.test(String((err as { message?: unknown })?.message ?? err))
  }
  if (!present) processMissing = true
  return present
}

// From session.start: schedules the checks once per loaded copy. Never throws, never waits. `gateFrom` (optional)
// tells the gate at each check (signed out: closed; a shell-gate upgrade answer: upgrade); without it noteGate does.
// `onMissing` is told once when `$.process` turns out to be missing: from then on nothing is run.
export function updateCheck($: EngineInterface, interactive: boolean, gateFrom?: () => Promise<Gate>, onMissing?: () => void): void {
  if (started || processMissing) return
  started = true
  if (gateFrom) gateOf = gateFrom
  if (onMissing) missingHook = onMissing
  try {
    $.clock.after(START_DELAY_MS, () => void check($, interactive))
    $.clock.every(CHECK_EVERY_MS, () => void check($, interactive))
  } catch {}
}
