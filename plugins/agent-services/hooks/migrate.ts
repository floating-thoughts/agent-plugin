// The one-time move from the Python core (plan section 5, item 3), run in the background by the first session.start
// of this release, after the tools are registered. Harness-neutral: the file access, the loopback fetch, the store,
// the clock and the log line are passed in; nothing here touches `$`.
//
// In order, each step logged in <data dir>/MIGRATED (written last, so a session cut off half way runs it again):
// 1. The old daemon. If <data dir>/services/connector.json names one and it answers with its daemon proof (an
//    HMAC under the local token: an answer without it is never the daemon), it is asked to sign out
//    (POST /local/logout: it revokes its own server session and clears its OS key store entries) and then to stop
//    (POST /local/stop). Only the daemon's own routes are used: no process is ever looked up or killed. No daemon
//    answering means nothing is started and nothing else is tried; the store then remembers that an older sign-in
//    may stay valid on the server, and the status line says so once after the new sign-in.
// 2. The savings counters. <data dir>/services/savings-events.jsonl (when it is under the 4 MiB read limit) is
//    folded into the store's day counters once, under one fixed counter key, so a second import (two sessions
//    starting together) writes the same records again instead of adding to them.
// 3. <data dir>/MIGRATED gets the log. The old files stay: they are the customer's data.
import { sha256 } from './noble.js'
import { COUNTER_PREFIX, MAX_COMPACT_ROWS, MAX_INDEX_ROWS, MAX_ROUTE_ROWS, MAX_STEP_MODELS, MAX_STEPS, sessionKey } from './counters'
import type { DayRecord } from './counters'
import type { KV } from './engine_types'
import { localDay, normModel, parseIso } from './metrics'

export const MIGRATED_FILE = 'MIGRATED'
export const MIGRATED_KEY = 'migrated' // { at, daemon, counters }: the same record in the store
export const OLD_SIGNIN_KEY = 'old_signin_note' // true: say once, after the new sign-in, that an older one may stay valid
export const OLD_SIGNIN_LINE =
  'agent-services: an older sign-in on this machine (the Python version) may stay valid on the server until it ' +
  'expires after 30 days unused; the new sign-in does not need it.'
export const IMPORT_SESSION = 'python-core-import' // the fixed counter key of the imported events
export const LOGOUT_DEADLINE_MS = 10000 // the daemon's sign-out reaches the server (background work, no hook waits)
export const STOP_DEADLINE_MS = 3000
export const EVENTS_LIMIT = 4 * 1024 * 1024 // $.fs.read refuses files over 4 MiB
export const NONCE_HEADER = 'X-Connector-Nonce'
export const PROOF_HEADER = 'x-connector-proof'
export const REF_RX = /^[0-9a-f]{16}$/

type Obj = Record<string, any>
export type LoopbackAnswer = { status: number; headers?: Record<string, string>; text: string }
export type MigrateDeps = {
  dataDir: string
  fs: { read(path: string): Promise<string>; write(path: string, text: string): Promise<void> }
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<LoopbackAnswer>
  store: KV
  now: () => number // ms since the epoch
  sleep: (ms: number) => Promise<unknown>
  random?: (n: number) => Uint8Array
  isLong?: (model: string, prompt: number) => boolean // the prices' long-prompt rule, as counters.ts takes it
  log?: (line: string) => unknown
}
export type DaemonStep = 'none' | 'not_daemon' | 'stopped' | 'logout_failed' | 'stop_failed' | 'unreachable'
export type CounterStep = { days: number; events: number } | 'none' | 'too_large' | 'failed'
export type Migration = { at: string; daemon: DaemonStep; logout: string | null; counters: CounterStep; old_signin: boolean }

const enc = new TextEncoder()
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
const optCount = (v: unknown): boolean => v === null || isCount(v)
const optAmount = (v: unknown): boolean => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0)
const isStr = (v: unknown): v is string => typeof v === 'string'

// ------------------------------------------------------------------ the daemon proof (host/httpbase.daemon_proof)

function hmac(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const k = key.length > 64 ? sha256(key) : key
  const pad = (c: number): Uint8Array => Uint8Array.from({ length: 64 }, (_, i) => (k[i] ?? 0) ^ c)
  const inner = sha256(new Uint8Array([...pad(0x36), ...msg]))
  return sha256(new Uint8Array([...pad(0x5c), ...inner]))
}

/** hex HMAC-SHA256 under the local token of nonce, status, method and path (each ending in a newline) + body. */
export function daemonProof(token: string, nonce: string, status: number, method: string, path: string, body: string): string {
  return hex(hmac(enc.encode(token), new Uint8Array([...enc.encode(`${nonce}\n${status}\n${method}\n${path}\n`), ...enc.encode(body)])))
}

function sameText(a: string, b: unknown): boolean {
  if (typeof b !== 'string' || b.length !== a.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

const header = (h: Record<string, string> | undefined, name: string): string | undefined => {
  if (!h) return undefined
  const want = name.toLowerCase()
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === want) return v
  return undefined
}

// ------------------------------------------------------------------ the counters import (host/metrics.py _event)

const FIELDS: Record<string, Record<string, (v: unknown) => boolean>> = {
  route: { model: isStr, input: isCount, output: isCount, cache_read: isCount, cache_write: isCount },
  index: { model: isStr, file_tokens: isCount },
  compact_start: { ref: (v) => isStr(v) && REF_RX.test(v), model: isStr, before: isCount, after: optCount, window: isCount,
    threshold: optCount, compact_usd: optAmount },
  compact_step: { ref: (v) => isStr(v) && REF_RX.test(v), model: isStr, context: isCount },
}

type Ev = { day: string; moment: number; order: number; e: Obj }

/** The events of the old savings log, as host/metrics.py read_events keeps them (bad lines skipped). */
export function readEvents(text: string): Ev[] {
  const out: Ev[] = []
  let order = 0
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue
    let e: unknown
    try {
      e = JSON.parse(raw)
    } catch {
      continue
    }
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue
    const o = e as Obj
    const fields = FIELDS[o.kind]
    if (!fields || typeof o.ts !== 'string') continue
    const moment = parseIso(o.ts, 'local')
    if (moment === null) continue
    if (!Object.entries(fields).every(([k, ok]) => k in o && ok(o[k]))) continue
    const ev: Obj = { kind: o.kind }
    for (const k of Object.keys(fields)) ev[k] = o[k]
    ev.model = normModel(o.model)
    out.push({ day: localDay(moment), moment, order: order++, e: ev })
  }
  return out
}

/** The day records (counters.ts DayRecord) of the old events, folded as host/metrics.py _counters folds them. */
export function foldEvents(events: Ev[], isLong: (model: string, prompt: number) => boolean = () => false): Map<string, DayRecord> {
  const days = new Map<string, DayRecord>()
  const rec = (day: string): DayRecord => {
    let r = days.get(day)
    if (!r) days.set(day, (r = { v: 1, day, route: {}, index: {}, compact: {} }))
    return r
  }
  const steps: Ev[] = []
  for (const ev of events) {
    const r = rec(ev.day)
    const e = ev.e
    if (e.kind === 'route') {
      const k = e.model + '\t' + (isLong(e.model, e.input + e.cache_read + e.cache_write) ? '1' : '0')
      let row = r.route[k]
      if (!row) {
        if (Object.keys(r.route).length >= MAX_ROUTE_ROWS) continue
        r.route[k] = row = [0, 0, 0, 0, 0]
      }
      row[0] += 1
      row[1] += e.input
      row[2] += e.output
      row[3] += e.cache_read
      row[4] += e.cache_write
    } else if (e.kind === 'index') {
      const k = e.model + '\t' + e.file_tokens
      if (r.index[k] === undefined) {
        if (Object.keys(r.index).length >= MAX_INDEX_ROWS) continue
        r.index[k] = 0
      }
      r.index[k] += 1
    } else {
      if (!r.compact[e.ref]) {
        if (Object.keys(r.compact).length >= MAX_COMPACT_ROWS) continue
        r.compact[e.ref] = { start: null, models: [], steps: [] }
      }
      const row = r.compact[e.ref]!
      if (e.kind === 'compact_start' && row.start === null) {
        row.start = { model: e.model, before_tokens: e.before, after_tokens: e.after, window_tokens: e.window,
          threshold_tokens: e.threshold, compact_usd: e.compact_usd }
      }
      if (e.kind === 'compact_step') steps.push(ev)
    }
  }
  steps.sort((a, b) => a.moment - b.moment || a.order - b.order)
  for (const ev of steps) {
    const row = days.get(ev.day)?.compact[ev.e.ref]
    if (!row || row.steps.length >= MAX_STEPS) continue
    let i = row.models.indexOf(ev.e.model)
    if (i < 0) {
      if (row.models.length >= MAX_STEP_MODELS) continue
      i = row.models.push(ev.e.model) - 1
    }
    row.steps.push([ev.e.context, i])
  }
  return days
}

// ------------------------------------------------------------------ the move

async function readOr(fs: MigrateDeps['fs'], path: string): Promise<string | null> {
  try {
    return String(await fs.read(path))
  } catch {
    return null
  }
}

/** One loopback call to the old daemon: its parsed answer, 'not_daemon' (no valid proof) or 'unreachable'. */
async function local(d: MigrateDeps, port: number, token: string, path: string, ms: number): Promise<Obj | 'not_daemon' | 'unreachable'> {
  const random = d.random ?? ((n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n)))
  const nonce = hex(random(16))
  const body = '{}'
  const call = Promise.resolve()
    .then(() => d.fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Connector-Token': token, [NONCE_HEADER]: nonce },
      body,
    }))
    .then((r) => r, () => null)
  const late = Promise.resolve(d.sleep(ms)).then(() => null, () => null)
  const r = await Promise.race([call, late])
  if (!r) return 'unreachable'
  const text = String(r.text ?? '')
  if (!sameText(daemonProof(token, nonce, Number(r.status), 'POST', path, text), header(r.headers, PROOF_HEADER))) return 'not_daemon'
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { status: r.status, ...parsed } : { status: r.status }
  } catch {
    return { status: r.status }
  }
}

async function stopDaemon(d: MigrateDeps, dir: string): Promise<{ daemon: DaemonStep; logout: string | null }> {
  const raw = await readOr(d.fs, `${dir}/services/connector.json`)
  if (raw === null) return { daemon: 'none', logout: null }
  let info: Obj
  try {
    info = JSON.parse(raw)
  } catch {
    return { daemon: 'unreachable', logout: null }
  }
  const port = Number(info?.port)
  const token = info?.token
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || typeof token !== 'string' || !token) {
    return { daemon: 'unreachable', logout: null }
  }
  const out = await local(d, port, token, '/local/logout', LOGOUT_DEADLINE_MS)
  if (out === 'not_daemon' || out === 'unreachable') return { daemon: out, logout: null }
  const logout = out.status === 200 && out.ok !== false && !out.error ? 'signed_out' : String(out.error ?? `status ${out.status}`).slice(0, 60)
  const stop = await local(d, port, token, '/local/stop', STOP_DEADLINE_MS)
  if (stop === 'not_daemon' || stop === 'unreachable' || stop.status !== 200) return { daemon: 'stop_failed', logout }
  return { daemon: logout === 'signed_out' || logout === 'not_logged_in' ? 'stopped' : 'logout_failed', logout }
}

async function importCounters(d: MigrateDeps, dir: string): Promise<CounterStep> {
  const text = await readOr(d.fs, `${dir}/services/savings-events.jsonl`)
  if (text === null) return 'none' // missing, or over the 4 MiB the engine reads
  if (enc.encode(text).length > EVENTS_LIMIT) return 'too_large'
  try {
    const events = readEvents(text)
    if (!events.length) return 'none'
    const days = foldEvents(events, d.isLong)
    const key = sessionKey(IMPORT_SESSION)
    for (const [day, rec] of days) await d.store.set(COUNTER_PREFIX + day + ':' + key, rec)
    return { days: days.size, events: events.length }
  } catch {
    return 'failed'
  }
}

/** Run the move once (a no-op once <data dir>/MIGRATED exists). Never throws. */
export async function migrate(d: MigrateDeps): Promise<Migration | null> {
  try {
    const dir = d.dataDir.replace(/[\\/]+$/, '')
    if ((await readOr(d.fs, `${dir}/${MIGRATED_FILE}`)) !== null) return null
    const { daemon, logout } = await stopDaemon(d, dir)
    const counters = await importCounters(d, dir)
    // No daemon answered although the old plugin ran here: its server session may stay valid (max_devices above 1).
    const oldSignin = daemon === 'unreachable' || daemon === 'not_daemon' ||
      (logout !== null && logout !== 'signed_out' && logout !== 'not_logged_in')
    if (oldSignin) {
      try {
        await d.store.set(OLD_SIGNIN_KEY, true)
      } catch {
        // the note is a courtesy
      }
    }
    const m: Migration = { at: new Date(d.now()).toISOString(), daemon, logout, counters, old_signin: oldSignin }
    try {
      await d.store.set(MIGRATED_KEY, m)
    } catch {
      // MIGRATED below is what counts
    }
    await d.fs.write(`${dir}/${MIGRATED_FILE}`, JSON.stringify({ v: 1, ...m }, null, 2) + '\n')
    if (daemon !== 'none' || counters !== 'none') {
      const parts = [
        daemon === 'stopped' ? 'the old local service was signed out and stopped' :
          daemon === 'none' ? null : `the old local service: ${daemon.replace('_', ' ')}`,
        typeof counters === 'object' ? `${counters.days} days of savings counters imported` :
          counters === 'none' ? null : `savings counters not imported (${counters.replace('_', ' ')})`,
      ].filter(Boolean)
      d.log?.(`agent-services: moved to this version (no Python needed): ${parts.join('; ')}. Sign in again with /agent-services login.`)
    }
    return m
  } catch {
    return null
  }
}
