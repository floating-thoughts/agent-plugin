import type { EngineInterface } from 'claude-code'
import { dataDir, engineDirs } from './engine_env'
import { updateCommand } from './status'
import type { ProcessRun } from './usage_tool'
import { isRemoved, markRemoved, removedMarker } from './remove'
import { attended } from './choice'
import { queueNotice } from './methods'

export const START_DELAY_MS = 30_000
export const CHECK_EVERY_MS = 600_000
export const UPDATE_EVERY_MS = 3_600_000
export const LEASE_MS = 300_000
export const LEASE_SETTLE_MS = 2_000
const RUN_TIMEOUT_MS = 120_000
const STATE_NAME = 'plugin-update.json'
export const AUTO_UPDATE_KEY = 'auto_update'
export const AUTO_UPDATE_EVERY_MS = 86_400_000
export const AUTO_FAIL_LIMIT = 3

type Row = Record<string, unknown>
type Lease = { owner: string; at: number }
type AutoFailed = { version: string; count: number; at: number; reason: string }
type Shared = { checkedAt?: number; installed?: string; latest?: string; noted?: string; lease?: Lease | null
  autoAt?: number; autoFailed?: AutoFailed | null }
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
export const idOf = (listJson: string, plugin: string): string | null =>
  rowsOf(listJson).map(r => r.id).find((id): id is string => typeof id === 'string' && id.includes('@') && nameOf(id) === plugin) ?? null
export const versionIn = (listJson: string, id: string): string =>
  String(rowsOf(listJson).find(r => r.id === id)?.version ?? '').slice(0, 40)

export function listedVersion(manifest: string, plugin: string): string {
  const m = parse(manifest) as { plugins?: unknown } | null
  const rows = m && Array.isArray(m.plugins) ? m.plugins : []
  const row = rows.find((r: any) => r && typeof r === 'object' && r.name === plugin) as Row | undefined
  return typeof row?.version === 'string' ? row.version.slice(0, 40) : ''
}

export function isNewer(latest: string, installed: string): boolean {
  if (!latest || !installed || latest === installed) return false
  const pa = /^\d+(?:\.\d+)*/.exec(latest)?.[0]
  const pb = /^\d+(?:\.\d+)*/.exec(installed)?.[0]
  if (!pa || !pb) return false
  const a = pa.split('.').map(Number)
  const b = pb.split('.').map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return latest === pa && installed !== pb
}

export function sameChannel(a: string, b: string): boolean {
  const pre = (v: string) => /^\d+(?:\.\d+)*-/.test(v)
  return !!a && !!b && pre(a) === pre(b)
}

export const autoSwitchOn = (v: unknown): boolean =>
  !!v && typeof v === 'object' && !Array.isArray(v) && (v as Row).on === true

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

export type Gate = 'open' | 'closed' | 'upgrade' | 'offline'
let gate: Gate = 'open'
let gateOf: (() => Promise<Gate>) | null = null
let running: Promise<void> | null = null
let started = false
let processMissing = false
let lastCheck: { at: number; what: string } | null = null
let seen: { installed: string; latest: string } | null = null
let toTell: { installed: string; latest: string } | null = null
let own: string | null = null
let applied: string | null = null
let missingHook: (() => void) | null = null
let lastAuto: string | null = null

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16)

export function updatesLine(auto = false): string | null {
  if (processMissing || !started) return null
  const last = lastCheck ? `last check ${hhmm(lastCheck.at)} UTC: ${lastCheck.what}`
    : 'the first check runs about 30 seconds after the session starts'
  const v = seen ? `; installed ${seen.installed || 'unknown'}, latest seen ${seen.latest || 'unknown'}` : ''
  const done = applied ? ` Last update here: ${applied}` : ''
  const self = auto
    ? `Automatic updates: on, at most once a day${lastAuto ? ` (last result: ${lastAuto})` : ''}; ` +
      '/agent-services update auto off turns them off.'
    : 'Automatic updates: off; the plugin updates itself only if you type /agent-services update auto on.'
  return `Updates: ${last}${v}; to update: /agent-services update. ${self}${done}`
}
async function noted($: EngineInterface, what: string): Promise<void> {
  lastCheck = { at: await safe(() => $.clock.now(), Date.now()), what }
}

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

async function takeLease($: EngineInterface, path: string, now: number): Promise<Lease | null> {
  const held = (await readShared($, path)).lease
  if (held && now - held.at < LEASE_MS) return null
  const mine = { owner: Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join(''), at: now }
  await writeShared($, path, { ...(await readShared($, path)), lease: mine })
  await sleep($, LEASE_SETTLE_MS)
  return (await readShared($, path)).lease?.owner === mine.owner ? mine : null
}

async function findExe($: EngineInterface): Promise<{ exe: string; listed: string }> {
  const home = (await text(() => $.env.get('HOME'))) || (await text(() => $.env.get('USERPROFILE')))
  const tried = [await text(() => $.env.get('CLAUDE_CODE_EXECPATH')), 'claude', `${home}/.local/bin/claude`,
    `${home}/.local/bin/claude.exe`, `${home}/.claude/local/claude`, '/opt/homebrew/bin/claude', '/usr/local/bin/claude']
  for (const at of tried.filter((p, i, all) => p && !p.startsWith('/.') && all.indexOf(p) === i)) {
    try {
      const r = await $.process.run([at, 'plugin', 'list', '--json'], { timeoutMs: 60_000, cwd: $.plugin.root })
      const listed = String(r.stdout ?? '')
      if (r.exitCode === 0 && Array.isArray(parse(listed))) return { exe: at, listed }
    } catch {}
  }
  return { exe: '', listed: '' }
}

async function manifestOf($: EngineInterface, marketplace: string): Promise<string> {
  const cfg = (await engineDirs($)).configDir
  const known = parse(await safe(() => $.fs.read(`${cfg}/plugins/known_marketplaces.json`), null)) as Row | null
  const entry = known && typeof known[marketplace] === 'object' ? (known[marketplace] as Row) : null
  const loc = typeof entry?.installLocation === 'string' ? entry.installLocation : `${cfg}/plugins/marketplaces/${marketplace}`
  return String((await safe(() => $.fs.read(`${loc.replace(/\\/g, '/')}/.claude-plugin/marketplace.json`), '')) ?? '')
}

async function ownVersion($: EngineInterface): Promise<string> {
  if (own === null) {
    const stamp = parse(await safe(() => $.fs.read(`${$.plugin.root}/core/host/shell_stamp.json`), null)) as Row | null
    own = typeof stamp?.shell === 'string' ? stamp.shell.slice(0, 40) : ''
  }
  return own
}

function remember(installed: string, latest: string, noted: string | undefined, mine: string): void {
  const have = isNewer(mine, installed) ? mine : installed
  seen = { installed: have, latest }
  toTell = isNewer(latest, have) && noted !== latest ? { installed: have, latest } : null
}

async function run($: EngineInterface, interactive: boolean): Promise<void> {
  if (processMissing) return
  if (gateOf) gate = await gateOf().catch((): Gate => 'closed')
  if (gate === 'closed') {
    toTell = null
    return noted($, 'skipped while signed out')
  }
  if (gate === 'offline') return noted($, 'skipped while offline mode is on')
  if (await text(() => $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'))) {
    return noted($, 'skipped (CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set)')
  }
  if (!interactive && !(await attended($))) return noted($, 'skipped (nobody to tell here: a -p run)')
  const marker = removedMarker(await dataDir($))
  if (String((await safe(() => $.fs.read(marker), '')) ?? '').trim()) return markRemoved()
  const now = await $.clock.now()
  const path = await statePath($)
  const shared = await readShared($, path)
  if (typeof shared.checkedAt !== 'number' || !Number.isFinite(shared.checkedAt) || shared.checkedAt > now) shared.checkedAt = 0
  if (now - (shared.checkedAt ?? 0) < UPDATE_EVERY_MS) {
    if (shared.latest !== undefined) remember(shared.installed ?? '', shared.latest, shared.noted, await ownVersion($))
    return noted($, `not due (the check runs at most every ${UPDATE_EVERY_MS / 60_000} minutes; next after ` +
      `${hhmm((shared.checkedAt ?? 0) + UPDATE_EVERY_MS)} UTC)`)
  }
  const lease = await takeLease($, path, now)
  if (!lease) return noted($, 'another session is checking')
  let surfaceless = false
  try {
    const { exe, listed } = await findExe($)
    if (!exe) {
      if (await probeProcess($)) return noted($, 'no claude command found to check with; trying again in an hour')
      surfaceless = true
      try {
        missingHook?.()
      } catch {}
      return noted($, 'this surface cannot run commands')
    }
    const id = idOf(listed, $.plugin.name)
    if (id === null) return noted($, `${exe} plugin list --json does not list ${$.plugin.name} from a marketplace`)
    const market = id.slice(id.lastIndexOf('@') + 1)
    await $.process.run([exe, 'plugin', 'marketplace', 'update', market], { timeoutMs: RUN_TIMEOUT_MS, cwd: $.plugin.root })
    const installed = versionIn(listed, id)
    const latest = listedVersion(await manifestOf($, market), $.plugin.name)
    if (isRemoved()) return
    const s = await readShared($, path)
    await writeShared($, path, { ...s, checkedAt: now, installed, latest, lease: null })
    remember(installed, latest, s.noted, await ownVersion($))
    await noted($, !latest ? 'the marketplace lists no version' : isNewer(latest, installed)
      ? `version ${latest} is available (installed ${installed})` : 'the installed version is the latest')
    const have = seen?.installed || installed
    if (latest && isNewer(latest, have) && (await autoUpdateOn($))) await autoApply($, path, exe, id, have, latest, now)
  } finally {
    const s = isRemoved() ? {} : await readShared($, path)
    if (s.lease?.owner === lease.owner) {
      await writeShared($, path, surfaceless ? { ...s, lease: null } : { ...s, checkedAt: Math.max(s.checkedAt ?? 0, now), lease: null })
    }
  }
}

async function autoUpdateOn($: EngineInterface): Promise<boolean> {
  try {
    return autoSwitchOn(await $.store.get(AUTO_UPDATE_KEY))
  } catch {
    return false
  }
}

const autoHandles = (s: Shared, installed: string, latest: string): boolean =>
  sameChannel(installed, latest) && !(s.autoFailed?.version === latest && s.autoFailed.count >= AUTO_FAIL_LIMIT)

async function autoApply($: EngineInterface, path: string, exe: string, id: string, installed: string, latest: string,
  now: number): Promise<void> {
  if (!sameChannel(installed, latest)) {
    lastAuto = `${latest} is on another channel than ${installed}, so it was not installed automatically`
    return
  }
  const s = await readShared($, path)
  const failed = s.autoFailed?.version === latest ? s.autoFailed : null
  if (failed && failed.count >= AUTO_FAIL_LIMIT) {
    lastAuto = `stopped trying ${latest} after ${failed.count} failures (${failed.reason})`
    return
  }
  const at = typeof s.autoAt === 'number' && Number.isFinite(s.autoAt) && s.autoAt <= now ? s.autoAt : 0
  if (now - at < AUTO_UPDATE_EVERY_MS) {
    lastAuto = `waiting: the last automatic run was at ${hhmm(at)} UTC, and it runs at most once a day`
    return
  }
  await writeShared($, path, { ...s, autoAt: now })
  let out: UpdateRun
  try {
    const r = await $.process.run([exe, 'plugin', 'update', id, '--json'], { timeoutMs: RUN_TIMEOUT_MS, cwd: $.plugin.root })
    out = readUpdate(r.exitCode, String(r.stdout ?? ''), String(r.stderr ?? ''))
  } catch (err) {
    out = { kind: 'failed', reason: String(err instanceof Error ? err.message : err) }
  }
  const s2 = await readShared($, path)
  if (out.kind === 'updated') {
    const to = out.to || latest
    await writeShared($, path, { ...s2, installed: to, noted: latest, autoFailed: null })
    seen = { installed: to, latest }
    toTell = null
    lastAuto = `updated to ${to} at ${hhmm(now)} UTC`
    applied = `Updated agent-services to ${to} automatically.`
    queueNotice(`agent-services updated itself to ${to} (automatic updates are on). New sessions use it; ` +
      '/reload-plugins uses it now. /agent-services update auto off turns this off.')
  } else if (out.kind === 'current') {
    lastAuto = `nothing to install at ${hhmm(now)} UTC`
  } else {
    const reason = out.reason.slice(0, 200)
    const count = (failed?.count ?? 0) + 1
    await writeShared($, path, { ...s2, autoFailed: { version: latest, count, at: now, reason } })
    lastAuto = `the update to ${latest} failed (${count} of ${AUTO_FAIL_LIMIT}): ${reason}`
    if (count >= AUTO_FAIL_LIMIT) {
      queueNotice(`agent-services could not update itself to ${latest} (${reason}); after ${count} tries it stops ` +
        'trying this version. /agent-services update tries again now.')
    }
  }
}

function check($: EngineInterface, interactive: boolean): Promise<void> {
  if (isRemoved()) return Promise.resolve()
  running ??= run($, interactive)
    .catch(err => noted($, `the check failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`))
    .finally(() => void (running = null))
  return running
}

export async function takeUpdateNote($: EngineInterface): Promise<{ installed: string; latest: string } | null> {
  try {
    if (!toTell) return null
    const t = toTell
    toTell = null
    const mine = await ownVersion($)
    if (mine && !isNewer(t.latest, mine)) return null
    const path = await statePath($)
    const s = await readShared($, path)
    if (s.noted === t.latest) return null
    if ((await autoUpdateOn($)) && autoHandles(s, t.installed, t.latest)) return null
    await writeShared($, path, { ...s, noted: t.latest })
    return t
  } catch {
    return null
  }
}

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
    await $.process.run([exe, 'plugin', 'marketplace', 'update', id.slice(id.lastIndexOf('@') + 1)], { timeoutMs: RUN_TIMEOUT_MS, cwd: $.plugin.root })
    const r = await $.process.run([exe, 'plugin', 'update', id, '--json'], { timeoutMs: RUN_TIMEOUT_MS, cwd: $.plugin.root })
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

const ARGV_REFUSAL = /non-empty list|argv/i

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

export function processRunner($: EngineInterface, present: boolean): ProcessRun | null {
  if (!present || processMissing) return null
  return async (argv, opts) => {
    const r: any = await $.process.run(argv, { timeoutMs: opts.timeoutMs, stdin: opts.stdin, cwd: $.plugin.root })
    return { exitCode: typeof r?.exitCode === 'number' ? r.exitCode : null, stdout: String(r?.stdout ?? ''), stderr: String(r?.stderr ?? '') }
  }
}

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
