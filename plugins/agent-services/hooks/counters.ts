// The savings day counters, the port of host/savings_events.py onto `$.store` (plan 1.1, 3.8 "Savings counters").
//
// `$.store` has no atomic read-modify-write and is shared by every session, so no key is ever written by two
// sessions: each session keeps its own record per local day under COUNTER_PREFIX + '<day>:<key>' (key = the first
// 32 hex of sha256(session id), as savings_events._key) and rewrites it whole; readers merge every record of a day
// (readDay). A record holds what the events log held for that session and day, already folded the way
// host/metrics.py _counters folds the log: route rows per (model, long prompt), index rows per (model, file
// tokens), and compaction rows per ref with their start and steps. The open compaction of a session (savings
// sessions state) sits under OPEN_PREFIX + key. Only counts, model names and random refs are stored: never event
// text, paths or session ids (the store is readable by other plugins). Records older than KEEP_DAYS are swept.

import { sha256 } from './noble.js'
import type { Clock, KV, Random } from './engine_types'

export const COUNTER_PREFIX = 'cnt:'
export const OPEN_PREFIX = 'cnt_open:'
export const KEEP_DAYS = 90
// the contract's array caps (host/metrics.py): rows past them are left out rather than failing the day
export const MAX_ROUTE_ROWS = 100
export const MAX_INDEX_ROWS = 500
export const MAX_COMPACT_ROWS = 50
export const MAX_STEPS = 4000
export const MAX_STEP_MODELS = 10

const DAY_MS = 86400000
const enc = new TextEncoder()
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

export type CompactStart = {
  model: string
  before_tokens: number
  after_tokens: number | null
  window_tokens: number
  threshold_tokens: number | null
  compact_usd: number | null
}
type CompactRow = { start: CompactStart | null; models: string[]; steps: [number, number][] }
type RouteRow = [number, number, number, number, number] // turns, input, output, cache_read, cache_write
export type DayRecord = {
  v: 1
  day: string
  route: Record<string, RouteRow> // model + '\t' + (long ? '1' : '0')
  index: Record<string, number> // model + '\t' + file_tokens -> reads
  compact: Record<string, CompactRow> // ref -> row
}
export type DayCounters = {
  route: { model: string; long: boolean; turns: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number }[]
  index: { model: string; file_tokens: number; reads: number }[]
  compact: { ref: string; start: CompactStart | null; models: string[]; steps: [number, number][] }[]
}

// Token estimate: CJK characters count one each, the rest a quarter (length in UTF-16 code units).
export function estimateTokens(text: string): number {
  if (typeof text !== 'string') throw new Error('text')
  let cjk = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xff00 && c <= 0xffef)) cjk++
  }
  return Math.floor(cjk + (text.length - cjk) / 4 + 0.5)
}

export const sessionKey = (session: string): string => hex(sha256(enc.encode(session))).slice(0, 32)

export function localDay(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
const needCount = (v: unknown, name: string): void => {
  if (!isCount(v)) throw new Error(name)
}
const needOptCount = (v: unknown, name: string): void => {
  if (v !== null && v !== undefined && !isCount(v)) throw new Error(name)
}
const needStr = (v: unknown, name: string): void => {
  if (typeof v !== 'string' || !v) throw new Error(name)
}

const emptyRecord = (day: string): DayRecord => ({ v: 1, day, route: {}, index: {}, compact: {} })

function asRecord(v: unknown, day: string): DayRecord {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return emptyRecord(day)
  const r = v as Partial<DayRecord>
  const obj = (x: unknown): boolean => !!x && typeof x === 'object' && !Array.isArray(x)
  if (r.v !== 1 || !obj(r.route) || !obj(r.index) || !obj(r.compact)) return emptyRecord(day)
  return { v: 1, day, route: r.route as DayRecord['route'], index: r.index as DayRecord['index'], compact: r.compact as DayRecord['compact'] }
}

function addStep(row: CompactRow, context: number, model: string): void {
  if (row.steps.length >= MAX_STEPS) return
  let i = row.models.indexOf(model)
  if (i < 0) {
    if (row.models.length >= MAX_STEP_MODELS) return
    i = row.models.push(model) - 1
  }
  row.steps.push([context, i])
}

export type CountersOptions = {
  clock: Clock
  random: Random
  dayOf?: (ms: number) => string // local day by default, as host/metrics.py read_events
  isLong?: (model: string, prompt: number) => boolean // the prices' long_prompt rule (P7 passes it); none by default
}

// One per core (one per process); every method writes only this session's own keys.
export class Counters {
  private readonly store: KV
  private readonly clock: Clock
  private readonly random: Random
  private readonly dayOf: (ms: number) => string
  private readonly isLong: (model: string, prompt: number) => boolean
  private readonly records = new Map<string, Promise<DayRecord>>()
  private readonly opens = new Map<string, Promise<string | null>>()
  private readonly writes = new Map<string, Promise<void>>()

  constructor(store: KV, opts: CountersOptions) {
    this.store = store
    this.clock = opts.clock
    this.random = opts.random
    this.dayOf = opts.dayOf ?? localDay
    this.isLong = opts.isLong ?? (() => false)
  }

  private record(session: string, now: number): { key: string; rec: Promise<DayRecord> } {
    const day = this.dayOf(now)
    const key = COUNTER_PREFIX + day + ':' + sessionKey(session)
    let rec = this.records.get(key)
    if (!rec) {
      rec = this.store.get(key).then((v) => asRecord(v, day), () => emptyRecord(day)) // a resumed session goes on
      this.records.set(key, rec)
    }
    return { key, rec }
  }

  // Whole-record writes of one key never overlap; the last one carries every change before it.
  private write(key: string, value: unknown): Promise<void> {
    const prev = this.writes.get(key) ?? Promise.resolve()
    const next = prev.then(() => (value === undefined ? this.store.delete(key) : this.store.set(key, value)))
    const settled = next.catch(() => undefined)
    this.writes.set(key, settled)
    return next
  }

  private async change(session: string, fn: (r: DayRecord) => void): Promise<void> {
    const { key, rec } = this.record(session, this.clock())
    const r = await rec
    fn(r)
    await this.write(key, r)
  }

  private open(session: string): Promise<string | null> {
    const k = sessionKey(session)
    let p = this.opens.get(k)
    if (!p) {
      p = this.store.get(OPEN_PREFIX + k).then(
        (v) => (v && typeof v === 'object' && typeof (v as { ref?: unknown }).ref === 'string' ? (v as { ref: string }).ref : null),
        () => null,
      )
      this.opens.set(k, p)
    }
    return p
  }

  private async setOpen(session: string, ref: string | null): Promise<void> {
    const k = sessionKey(session)
    this.opens.set(k, Promise.resolve(ref))
    await this.write(OPEN_PREFIX + k, ref === null ? undefined : { ref, ts: this.clock() })
  }

  // ---------------------------------------------------------------- events (savings_events.SavingsEvents)
  async route(session: string, model: string, u: { input: number; output: number; cache_read: number; cache_write: number }): Promise<void> {
    needStr(session, 'session')
    needStr(model, 'model')
    for (const n of ['input', 'output', 'cache_read', 'cache_write'] as const) needCount(u[n], n)
    const long = this.isLong(model, u.input + u.cache_read + u.cache_write)
    await this.change(session, (r) => {
      const k = model + '\t' + (long ? '1' : '0')
      let row = r.route[k]
      if (!row) {
        if (Object.keys(r.route).length >= MAX_ROUTE_ROWS) return
        r.route[k] = row = [0, 0, 0, 0, 0]
      }
      row[0] += 1
      row[1] += u.input
      row[2] += u.output
      row[3] += u.cache_read
      row[4] += u.cache_write
    })
  }

  async index(session: string, model: string, a: { fileTokens?: number; text?: string }): Promise<void> {
    needStr(session, 'session')
    needStr(model, 'model')
    if ((a.fileTokens === undefined) === (a.text === undefined)) throw new Error('file_tokens or text')
    let tokens = a.fileTokens
    if (a.text !== undefined) {
      if (typeof a.text !== 'string') throw new Error('text')
      tokens = estimateTokens(a.text)
    }
    needCount(tokens, 'file_tokens')
    await this.change(session, (r) => {
      const k = model + '\t' + tokens
      if (r.index[k] === undefined) {
        if (Object.keys(r.index).length >= MAX_INDEX_ROWS) return
        r.index[k] = 0
      }
      r.index[k] += 1
    })
  }

  // A compaction at a checkpoint: opens a new count (returned ref) that the next main-agent requests add to.
  async compaction(session: string, c: { model: string; before: number | null; after: number | null; window: number;
    threshold?: number | null; compact_usd?: number | null }): Promise<string | null> {
    needStr(session, 'session')
    needStr(c.model, 'model')
    needOptCount(c.before, 'before')
    needOptCount(c.after, 'after')
    needCount(c.window, 'window')
    needOptCount(c.threshold, 'threshold')
    const usd = c.compact_usd
    if (usd !== null && usd !== undefined && !(typeof usd === 'number' && Number.isFinite(usd) && usd >= 0)) {
      throw new Error('compact_usd')
    }
    if (c.before === null || c.before === undefined) {
      await this.stop(session)
      return null
    }
    const ref = hex(this.random(8))
    const before = c.before
    await this.setOpen(session, ref)
    await this.change(session, (r) => {
      const row = r.compact[ref] ?? (r.compact[ref] = { start: null, models: [], steps: [] })
      row.start = {
        model: c.model, before_tokens: before,
        after_tokens: c.after !== null && c.after !== undefined && c.after < before ? c.after : null,
        window_tokens: c.window, threshold_tokens: c.threshold ?? null,
        compact_usd: usd !== null && usd !== undefined && usd > 0 ? usd : null,
      }
    })
    return ref
  }

  async stop(session: string): Promise<void> {
    needStr(session, 'session')
    await this.setOpen(session, null)
  }

  // A main-agent request while a compaction count is open adds one step; false when none is open.
  async request(session: string, model: string, u: { input: number; cache_read: number; cache_write: number }): Promise<boolean> {
    needStr(session, 'session')
    needStr(model, 'model')
    for (const n of ['input', 'cache_read', 'cache_write'] as const) needCount(u[n], n)
    const ref = await this.open(session)
    if (ref === null) return false
    await this.change(session, (r) => {
      const row = r.compact[ref] ?? (r.compact[ref] = { start: null, models: [], steps: [] })
      addStep(row, u.input + u.cache_read + u.cache_write, model)
    })
    return true
  }

  // Every pending write of this process done.
  async flush(): Promise<void> {
    await Promise.all([...this.writes.values()])
  }
}

// ---------------------------------------------------------------- reading (any session, any process)

// Every session's record of `day`, merged, in host/metrics.py _counters shape and order.
export async function readDay(store: KV, day: string): Promise<DayCounters> {
  const prefix = COUNTER_PREFIX + day + ':'
  const route = new Map<string, RouteRow>()
  const index = new Map<string, number>()
  const compact = new Map<string, CompactRow>()
  for (const key of await store.keys()) {
    if (!key.startsWith(prefix)) continue
    let v: unknown
    try {
      v = await store.get(key)
    } catch {
      continue
    }
    const r = asRecord(v, day)
    for (const [k, row] of Object.entries(r.route)) {
      if (!Array.isArray(row) || row.length !== 5 || !row.every(isCount)) continue
      const have = route.get(k) ?? [0, 0, 0, 0, 0]
      route.set(k, have.map((x, i) => x + row[i]!) as RouteRow)
    }
    for (const [k, n] of Object.entries(r.index)) if (isCount(n)) index.set(k, (index.get(k) ?? 0) + n)
    for (const [ref, row] of Object.entries(r.compact)) {
      if (!row || typeof row !== 'object' || !Array.isArray(row.models) || !Array.isArray(row.steps)) continue
      const have = compact.get(ref) ?? { start: null, models: [], steps: [] }
      if (have.start === null && row.start) have.start = row.start
      for (const s of row.steps) {
        const m = Array.isArray(s) ? row.models[s[1] as number] : undefined
        if (typeof m === 'string' && isCount(s[0])) addStep(have, s[0], m)
      }
      compact.set(ref, have)
    }
  }
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  const routeRows = [...route.entries()]
    .map(([k, row]) => {
      const t = k.lastIndexOf('\t')
      return { model: k.slice(0, t), long: k.slice(t + 1) === '1', row }
    })
    .sort((a, b) => cmp(a.model, b.model) || Number(a.long) - Number(b.long))
    .slice(0, MAX_ROUTE_ROWS)
    .map(({ model, long, row }) => ({
      model, long, turns: row[0], input_tokens: row[1], output_tokens: row[2], cache_read_tokens: row[3], cache_write_tokens: row[4],
    }))
  const indexRows = [...index.entries()]
    .map(([k, reads]) => {
      const t = k.lastIndexOf('\t')
      return { model: k.slice(0, t), file_tokens: Number(k.slice(t + 1)), reads }
    })
    .sort((a, b) => cmp(a.model, b.model) || a.file_tokens - b.file_tokens)
    .slice(0, MAX_INDEX_ROWS)
  const compactRows = [...compact.keys()].sort(cmp).slice(0, MAX_COMPACT_ROWS).map((ref) => ({ ref, ...compact.get(ref)! }))
  return { route: routeRows, index: indexRows, compact: compactRows }
}

// Delete day records older than KEEP_DAYS and open counts started before then. Best effort, never throws.
export async function sweep(store: KV, nowMs: number, dayOf: (ms: number) => string = localDay): Promise<number> {
  const cutoffDay = dayOf(nowMs - KEEP_DAYS * DAY_MS)
  let n = 0
  try {
    for (const key of await store.keys()) {
      let old = false
      if (key.startsWith(COUNTER_PREFIX)) {
        const day = key.slice(COUNTER_PREFIX.length, COUNTER_PREFIX.length + 10)
        old = /^\d{4}-\d{2}-\d{2}$/.test(day) && day < cutoffDay
      } else if (key.startsWith(OPEN_PREFIX)) {
        const v = await store.get(key)
        const ts = v && typeof v === 'object' ? (v as { ts?: unknown }).ts : undefined
        old = typeof ts !== 'number' || ts < nowMs - KEEP_DAYS * DAY_MS
      }
      if (old) {
        await store.delete(key)
        n++
      }
    }
  } catch {
    // swept again at the next session start
  }
  return n
}
