// Daily metrics, harness-neutral: transcript parsing, the POST /metrics/daily body and its upload plan.
//
// A port of the Python client (the body builder and the day selection of Metrics.tick), of the parts of
// the usage module parser it uses (collect, price_of, cost_of, usage_of, parse_iso) and of the diagnostic tool
// scan(). Nothing here touches the engine: transcript files, the savings events, the salt, the prices and the
// clock are passed in, and nothing is sent or stored. The wiring reads the inputs and sends the text.
//
// Inputs of each entry point:
//   scan(files, prices)            files: TranscriptFile[] in walk order (walkOrder sorts), each { rel, size, text };
//                                  text null when the file is over READ_LIMIT (4 MiB) or unreadable: such a file is
//                                  left out of the facts and listed in facts.unread (estimate.ts scales it).
//                                  prices: the parsed price table.
//   readEvents(events)             the savings events (objects or JSON lines), as the Python event log holds them.
//   dailyBody(day, input)          { facts, events, salt (bytes), prices, kinds?, clientVersion? }; throws BodyTooLarge.
//   dailyRequest(day, input)       -> { method, route, body_text } or { error }: the exact text a send carries, so
//                                  a preview and the upload are the same string.
//   uploadDays(state, today, active)  the days Metrics.tick would build, in order (dueDays: with active()).
//   optIn(state, today)            turning the upload back on: only after a preview (the user's own command).
//
// Python parity limits (stated, tested where it matters): JSON numbers lose the int/float distinction, so a
// value Python keeps as 5.0 prints as 5 here (bodies are compared as parsed JSON); the 64 KiB size check counts
// this module's JSON text. Day boundaries use the process's local time zone, as the Python does.
//
// The transcript facts (scan and the prices) live in transcripts.ts and the Python-compatible
// helpers in pyfmt.ts; this module re-exports them, so importers of metrics.ts keep working.
import { utf8 } from './e2e'
import { cmpTuple, isObj, localDay, parseIso, plusDays, pyRound, ref } from './pyfmt'
import { bare, matches, normModel, parseLine } from './transcripts'
import type { Facts, Prices } from './transcripts'

export { cmpTuple, hmacSha256, localDay, parseIso, plusDays, pyFixed, pyRound, pySum, ref } from './pyfmt'
export {
  bare,
  collect,
  costOf,
  DISPATCH_TOOLS,
  EFFORTS,
  FIELDS,
  matches,
  MODEL_WORDS,
  normModel,
  place,
  priceOf,
  promptOf,
  scan,
  SUBAGENT_TYPES,
  TYPE_WORDS,
  typeWord,
  usageOf,
  walkOrder,
} from './transcripts'
export type {
  Counts,
  DayFacts,
  Dispatch,
  Entry,
  Facts,
  ModelBucket,
  Prices,
  SessionRow,
  TranscriptFile,
  UnreadFile,
} from './transcripts'

export const CLIENT_VERSION = '0.1.0'

/** The client_version a body carries: the plugin's release version (the export's shell stamp) when it is one, else
 * CLIENT_VERSION (a development copy has no stamp and reports 'dev', which the schema's Version refuses). */
export function releaseVersion(v: string | null | undefined): string {
  return typeof v === 'string' && /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(v) && v.length <= 40 ? v : CLIENT_VERSION
}
export const BACKFILL_DAYS = 30
export const HARNESS = 'claude-code'
export const BODY_BYTES = 65536
export const MAX_TASK_ROWS = 500
export const MAX_ROUTE_ROWS = 100
export const MAX_INDEX_ROWS = 500
export const MAX_COMPACT_ROWS = 50
export const MAX_STEPS = 4000
export const MAX_STEP_MODELS = 10
export const READ_LIMIT = 4 * 1024 * 1024 // transcripts over this are not read; estimate.ts scales them by size
export const DAILY_ROUTE = '/metrics/daily'
export const KINDS: Record<string, string> = { auto: 'auto', orchestrator: 'auto', direct: 'direct' }
const REF_RX = /^[0-9a-f]{16}\n?$/
const DAY_RX = /^\d{4}-\d{2}-\d{2}$/

type Obj = Record<string, any>

export class BodyTooLarge extends Error {}

// ------------------------------------------------------------------ savings events

const isCount = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 0
const optCount = (v: unknown): boolean => v === null || isCount(v)
const optAmount = (v: unknown): boolean => v === null || (typeof v === 'number' && v >= 0)
const isStr = (v: unknown): boolean => typeof v === 'string'
const isRef = (v: unknown): boolean => typeof v === 'string' && REF_RX.test(v)
const EVENT_FIELDS: Record<string, Record<string, (v: unknown) => boolean>> = {
  route: { model: isStr, input: isCount, output: isCount, cache_read: isCount, cache_write: isCount },
  index: { model: isStr, file_tokens: isCount },
  compact_start: {
    ref: isRef,
    model: isStr,
    before: isCount,
    after: optCount,
    window: isCount,
    threshold: optCount,
    compact_usd: optAmount,
  },
  compact_step: { ref: isRef, model: isStr, context: isCount },
}

export type SavingsEvent = { day: string; moment: number; e: Obj }

/** the Python client's read_events: the valid events with their local day, in order; bad ones skipped. */
export function readEvents(events: unknown[]): SavingsEvent[] {
  const out: SavingsEvent[] = []
  for (const item of events ?? []) {
    const e = typeof item === 'string' ? parseLine(item) : item
    if (!isObj(e)) continue
    const fields = EVENT_FIELDS[e.kind as string]
    if (!fields || !Object.hasOwn(EVENT_FIELDS, e.kind) || typeof e.ts !== 'string') continue
    const moment = parseIso(e.ts, 'local')
    if (moment === null) continue
    let ok = true
    for (const [name, check] of Object.entries(fields)) {
      if (!(name in e) || !check(e[name])) {
        ok = false
        break
      }
    }
    if (!ok) continue
    const kept: Obj = {}
    for (const name of Object.keys(fields)) kept[name] = e[name]
    kept.kind = e.kind
    kept.model = normModel(e.model)
    out.push({ day: localDay(moment), moment, e: kept })
  }
  return out
}

/** the Python client's _long: whether a route turn of this (normalized) model and prompt size is a long-prompt one. */
export const isLong = (model: string, prompt: number, prices: Prices): boolean =>
  (prices.long_prompt ?? []).some((t: Obj) => matches(bare(model), t.prefix) && prompt > t.over)

/** the Python client's _counters: the raw savings counters of one day. */
export function counters(events: SavingsEvent[], day: string, prices: Prices): Obj {
  const route = new Map<string, Obj>()
  const index = new Map<string, { model: string; tokens: number; n: number }>()
  const compact = new Map<string, { start: Obj | null; steps: [number, string][] }>()
  const todays = events.map((x, i) => ({ ...x, i })).filter((x) => x.day === day)
  for (const { e } of todays) {
    if (e.kind === 'route') {
      const prompt = e.input + e.cache_read + e.cache_write
      const long = isLong(e.model, prompt, prices)
      const k = JSON.stringify([e.model, long])
      let r = route.get(k)
      if (!r) {
        r = { model: e.model, long, turns: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }
        route.set(k, r)
      }
      r.turns += 1
      r.input_tokens += e.input
      r.output_tokens += e.output
      r.cache_read_tokens += e.cache_read
      r.cache_write_tokens += e.cache_write
    } else if (e.kind === 'index') {
      const k = JSON.stringify([e.model, e.file_tokens])
      const got = index.get(k) ?? { model: e.model, tokens: e.file_tokens, n: 0 }
      got.n += 1
      index.set(k, got)
    } else if (e.kind === 'compact_start') {
      const c = compact.get(e.ref) ?? { start: null, steps: [] }
      compact.set(e.ref, c)
      if (c.start === null) {
        c.start = {
          model: e.model,
          before_tokens: e.before,
          after_tokens: e.after,
          window_tokens: e.window,
          threshold_tokens: e.threshold,
          compact_usd: e.compact_usd,
        }
      }
    } else if (!compact.has(e.ref)) {
      compact.set(e.ref, { start: null, steps: [] })
    }
  }
  const steps = todays.filter((x) => x.e.kind === 'compact_step').sort((a, b) => cmpTuple([a.moment, a.i], [b.moment, b.i]))
  for (const { e } of steps) compact.get(e.ref)!.steps.push([e.context, e.model])
  const rows: Obj[] = []
  for (const r of [...compact.keys()].sort()) {
    const c = compact.get(r)!
    const models: string[] = []
    const pairs: [number, number][] = []
    for (const [context, model] of c.steps) {
      if (pairs.length >= MAX_STEPS) break
      if (!models.includes(model)) {
        if (models.length >= MAX_STEP_MODELS) continue
        models.push(model)
      }
      pairs.push([context, models.indexOf(model)])
    }
    rows.push({ ref: r, start: c.start, models, steps: pairs })
  }
  const routeRows = [...route.values()].sort((a, b) => cmpTuple([a.model, a.long], [b.model, b.long]))
  const indexRows = [...index.values()].sort((a, b) => cmpTuple([a.model, a.tokens], [b.model, b.tokens]))
  return {
    route: routeRows.slice(0, MAX_ROUTE_ROWS),
    index: indexRows.map((x) => ({ model: x.model, file_tokens: x.tokens, reads: x.n })).slice(0, MAX_INDEX_ROWS),
    compact: rows.slice(0, MAX_COMPACT_ROWS),
  }
}

// ------------------------------------------------------------------ the daily body

export type DailyInput = {
  facts: Facts
  events?: SavingsEvent[] // the Python event log's events; unused when `savings` is given
  savings?: Obj | null // the day's counters already folded (counters.ts readDay, wiring.ts daySavings)
  salt: Uint8Array
  prices: Prices
  kinds?: Record<string, string> | null // main session id -> its kind (auto, orchestrator, direct)
  clientVersion?: string
}

/** The UTF-8 size of a body as this module sends it. */
export const bodySize = (body: unknown): number => utf8(JSON.stringify(body)).length

/** _Sources.active: whether a day has anything to upload. */
export function active(day: string, facts: Facts, events: SavingsEvent[]): boolean {
  const d = facts.by_day[day]
  if (d && Object.keys(d.by_model).length) return true
  if (facts.dispatches.some((x) => x.day === day)) return true
  return events.some((e) => e.day === day)
}

/** The POST /metrics/daily body for one local day (the Python client's _Sources.body); throws BodyTooLarge. */
export function dailyBody(day: string, input: DailyInput): Obj {
  const { facts, salt, prices } = input
  const events = input.events ?? []
  const byModel: Obj[] = []
  const models = facts.by_day[day]?.by_model ?? {}
  for (const model of Object.keys(models).sort()) {
    const b = models[model]
    byModel.push({
      model,
      input_tokens: b.input_tokens,
      output_tokens: b.output_tokens,
      cache_read_tokens: b.cache_read_tokens,
      cache_write_tokens: b.cache_write_tokens,
      api_usd: pyRound(b.api_usd, 6),
    })
  }
  const groups = new Map<string, { key: [string, string, string]; n: number }>()
  for (const d of facts.dispatches) {
    if (d.day !== day) continue
    const key: [string, string, string] = [d.type_word, d.requested_model, ref(salt, 'project', d.project)]
    const k = JSON.stringify(key)
    const g = groups.get(k) ?? { key, n: 0 }
    g.n += 1
    groups.set(k, g)
  }
  const byTask = [...groups.values()]
    .sort((a, b) => b.n - a.n || cmpTuple(a.key, b.key))
    .map(({ key: [t, m, h], n }) => ({
      task_type: t,
      model: m,
      project_hash: h,
      count: n,
      success: null,
      fail: null,
      retry: null,
      median_seconds: null,
    }))
    .slice(0, MAX_TASK_ROWS)
  const perKind: Record<string, number> = {}
  for (const session of facts.main_days[day] ?? []) {
    const kind = KINDS[(input.kinds ?? {})[session] as string] ?? 'direct'
    perKind[kind] = (perKind[kind] ?? 0) + 1
  }
  const sessions = Object.keys(perKind)
    .sort()
    .map((kind) => ({ kind, harness: HARNESS, count: perKind[kind] }))
  const body: Obj = {
    day,
    client_version: releaseVersion(input.clientVersion),
    by_model: byModel,
    by_task: byTask,
    sessions,
    savings: input.savings ?? counters(events, day, prices),
  }
  while (bodySize(body) > BODY_BYTES) {
    if (!body.by_task.length) throw new BodyTooLarge(`metrics body for ${day} is over ${BODY_BYTES} bytes`)
    body.by_task.pop()
  }
  return body
}

export type Request = { method: 'POST'; route: string; body_text: string }

/** The exact request one upload of `day` carries; the preview shows this same text. */
export function dailyRequest(day: string, input: DailyInput): Request | { error: 'too_large' } {
  try {
    return { method: 'POST', route: DAILY_ROUTE, body_text: JSON.stringify(dailyBody(day, input)) }
  } catch (e) {
    if (e instanceof BodyTooLarge) return { error: 'too_large' }
    throw e
  }
}

// ------------------------------------------------------------------ the upload plan (Metrics.tick)

export type MetricsState = { previewed_day: string | null; enabled_day: string | null; last_uploaded_day: string | null }

/** The days one tick builds and sends, in order (only active days); empty when nothing is due. */
export function uploadDays(state: MetricsState, today: string, isActive: (day: string) => boolean): string[] {
  const yesterday = plusDays(today, -1)
  let day = state.last_uploaded_day
    ? plusDays(state.last_uploaded_day, 1)
    : plusDays(state.enabled_day || today, -BACKFILL_DAYS)
  const out: string[] = []
  while (day <= yesterday) {
    if (isActive(day)) out.push(day)
    day = plusDays(day, 1)
  }
  return out
}

/** uploadDays with the activity test of the same facts and events. */
export const dueDays = (state: MetricsState, today: string, facts: Facts, events: SavingsEvent[]): string[] =>
  uploadDays(state, today, (day) => active(day, facts, events))

/** Metrics.opt_in: the upload may be switched on only after the user has seen a preview. */
export function optIn(state: MetricsState, today: string): { ok: true; state: MetricsState } | { ok: false; error: 'preview_first' } {
  if (!state.previewed_day) return { ok: false, error: 'preview_first' }
  return { ok: true, state: { ...state, enabled_day: today } }
}

export const isDay = (v: unknown): v is string => typeof v === 'string' && DAY_RX.test(v)
