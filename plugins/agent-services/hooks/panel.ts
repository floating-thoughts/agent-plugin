// The usage panel: the same three columns the band, the status command and the board show.
//
//   Token (excl. cache reads)   This week / This month / All time: tokens and dollars at API prices, from this
//                               computer's transcripts (usageDaysOf over the scan, kept per day under USAGE_DAYS_KEY)
//   Quota . context N% (Nk)     Week % and 5-hour % of the plan with the time to their reset, and the context, from
//                               the engine's session usage (planOf); then "Saved $X", the service's savings figure
//   Time                        Spent by you: the person's typing time; Saved for you: clock time with at least one agent
//                               active; Concurrent: the agents' summed run time less that
//                               clock time. The service's figures when it has them, else this computer's.
//
// Unknown figures show "--". METHOD_LINE is the disclosure shown wherever the time figures appear; the service
// sends the same sentence with its figures.
//
//   usageDaysOf(facts, fromDay)                       -> { day: UsageDay } (days >= fromDay)
//   refreshUsage(kv, scan, nowMs)                     -> the stored days, refreshed when due (never throws)
//   planOf(usage)                                     -> Plan ($.session.usage() answer; null -> unknown)
//   notePlan(usage) / heldPlan()                      -> the latest plan seen in this process
//   panelOf(days, plan, savings, today, nowMs)        -> { columns, method }
//   panelLines(panel) / boardLines(panel)             -> the plain lines (band and status / the board)
import type { KV } from './engine_types'
import { localDay } from './pyfmt'
import { safeGet, safeSet } from './store'
import type { Facts } from './transcripts'

export const METHOD_LINE =
  'Saved for you is clock time when at least one agent was working (gaps over 10 minutes count as idle; time ' +
  "with several agents running counts once). It is the agents' own run time, not an estimate of how long a person " +
  'would take. Spent by you is your own time at the keyboard, estimated as typed bytes / 200 bytes per minute. ' +
  "Concurrency save = the agents' combined run time minus clock time, i.e. what running them side by side saved " +
  'compared with one at a time.'
export const USAGE_DAYS_KEY = 'usage_days' // { through, at, lock?, days: { day: UsageDay } }: this computer's figures
export const TYPING_BYTES_PER_MINUTE = 200

type Obj = Record<string, any>
export type UsageDay = {
  tokens: number
  usd: number
  typed_bytes: number
  agent_seconds: number
  agent_sum_seconds: number
  turns: number
}
export type Limit = { pct: number; resets_at: string | null }
export type Plan = { week: Limit | null; five_hour: Limit | null; context: { tokens: number; window: number } | null }
// align: per cell position, how the band lines a sub-column up (default: the first left, the others right)
export type Column = { title: string; rows: string[][]; align?: ('left' | 'center' | 'right')[] }
export type Panel = { columns: Column[]; method: string }

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const DOT = ' \u00b7 '

/** The per-day usage of a scan, for the days on or after `fromDay`. */
export function usageDaysOf(facts: Facts, fromDay: string): Record<string, UsageDay> {
  const out: Record<string, UsageDay> = {}
  const day = (d: string): UsageDay =>
    (out[d] ??= { tokens: 0, usd: 0, typed_bytes: 0, agent_seconds: 0, agent_sum_seconds: 0, turns: 0 })
  for (const [d, f] of Object.entries(facts.by_day ?? {})) {
    if (d < fromDay) continue
    for (const b of Object.values(f.by_model)) {
      day(d).tokens += b.tokens
      day(d).usd += b.api_usd
    }
  }
  for (const [d, t] of Object.entries(facts.time_by_day ?? {})) {
    if (d < fromDay) continue
    Object.assign(day(d), {
      typed_bytes: t.typed_bytes,
      agent_seconds: t.agent_seconds,
      agent_sum_seconds: t.agent_sum_seconds,
      turns: t.turns,
    })
  }
  // the owner tool's figures (every transcript, over-4-MiB ones included) take the place of the scan's
  for (const [d, x] of Object.entries(facts.full_days ?? {})) {
    if (d < fromDay || !isObj(x)) continue
    const t = day(d)
    for (const k of ['tokens', 'usd', 'typed_bytes', 'agent_seconds', 'agent_sum_seconds', 'turns'] as const) {
      if (num(x[k]) !== null) t[k] = x[k]
    }
  }
  return out
}

/**
 * The stored per-day figures, refreshed when the last refresh is older than `everyMs`: the days from the last
 * refreshed day on are scanned again (a transcript with an entry on or after a day was written on or after it), the
 * earlier days are kept. One session refreshes at a time (a lock in the record). Never throws.
 */
export async function refreshUsage(
  kv: KV,
  scan: (sinceMs: number | null) => Promise<Facts | null>,
  nowMs: number,
  everyMs = 10 * 60 * 1000,
): Promise<Record<string, UsageDay> | null> {
  const raw = await safeGet(kv, USAGE_DAYS_KEY)
  const held: Obj = isObj(raw) ? raw : {}
  const days: Record<string, UsageDay> = isObj(held.days) ? held.days : {}
  if ((num(held.at) !== null && nowMs - held.at < everyMs) || (num(held.lock) ?? 0) > nowMs) return isObj(held.days) ? days : null
  try {
    await safeSet(kv, USAGE_DAYS_KEY, { ...held, lock: nowMs + 30 * 60 * 1000 })
    const from = typeof held.through === 'string' ? held.through : null
    const facts = await scan(from ? new Date(`${from}T00:00:00`).getTime() : null)
    if (!facts) {
      await safeSet(kv, USAGE_DAYS_KEY, { ...held, lock: undefined })
      return isObj(held.days) ? days : null
    }
    const kept: Record<string, UsageDay> = {}
    for (const d of Object.keys(days).sort()) if (from === null || d < from) kept[d] = days[d]
    const all = { ...kept, ...usageDaysOf(facts, from ?? '0000-00-00') }
    // the owner tool's days replace earlier days too
    for (const [d, x] of Object.entries(usageDaysOf({ by_day: {}, time_by_day: {}, full_days: facts.full_days } as unknown as Facts, '0000-00-00'))) {
      all[d] = { ...(all[d] ?? x), ...Object.fromEntries(Object.entries(facts.full_days?.[d] ?? {}).filter(([k, v]) => k in x && typeof v === 'number')) }
    }
    const names = Object.keys(all).sort().slice(-800)
    const next: Record<string, UsageDay> = {}
    for (const d of names) next[d] = all[d]
    await safeSet(kv, USAGE_DAYS_KEY, { through: localDay(nowMs * 1000), at: nowMs, days: next })
    return next
  } catch {
    await safeSet(kv, USAGE_DAYS_KEY, { ...held, lock: undefined })
    return isObj(held.days) ? days : null
  }
}

const limitOf = (all: unknown, kind: string): Limit | null => {
  const found = Array.isArray(all) ? all.find((l) => isObj(l) && l.kind === kind) : null
  if (!isObj(found) || num(found.percentUsed) === null) return null
  return { pct: found.percentUsed, resets_at: typeof found.resetsAt === 'string' ? found.resetsAt : null }
}

/** The plan windows and the context from the engine's `$.session.usage()` answer. */
export function planOf(usage: unknown): Plan {
  const u = isObj(usage) ? usage : {}
  const c = isObj(u.context) ? u.context : null
  const tokens = c ? num(c.tokens) : null
  const window = c ? num(c.window) : null
  return {
    week: limitOf(u.rateLimits, 'seven_day'),
    five_hour: limitOf(u.rateLimits, 'five_hour'),
    context: tokens !== null && window !== null && window > 0 ? { tokens, window } : null,
  }
}

let plan: Plan = { week: null, five_hour: null, context: null }

/** Keeps the latest plan seen in this process (register.ts turn.complete); a window it lacks keeps the last one. */
export function notePlan(usage: unknown): void {
  try {
    const p = planOf(usage)
    plan = { week: p.week ?? plan.week, five_hour: p.five_hour ?? plan.five_hour, context: p.context ?? plan.context }
  } catch {
    // the panel never breaks a hook
  }
}

export const heldPlan = (): Plan => plan

/** Tokens as 950, 90k, 2.0M, 1.2B. */
export function tokensText(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(Math.round(n))
}

/** Dollars as $5.40, or whole dollars with commas from $1,000. */
export function moneyText(v: number): string {
  const a = Math.abs(v)
  const s = a >= 1000 ? String(Math.round(a)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : a.toFixed(2)
  return `${v < 0 ? '-' : ''}$${s}`
}

/** `35m` under an hour, `2.5h` under ten hours, then whole hours. */
export function durationText(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = seconds / 3600
  return hours < 10 ? `${Math.round(hours * 10) / 10}h` : `${Math.round(hours)}h`
}

/** The time to a reset: `2d 4h 10m` (withDays) or `1h 5m`; empty when unknown. */
export function resetText(resetsAt: string | null, nowMs: number, withDays: boolean): string {
  const at = resetsAt ? Date.parse(resetsAt) : NaN
  if (Number.isNaN(at)) return ''
  const minutes = Math.ceil((at - nowMs) / 60_000)
  if (minutes <= 0) return 'resetting'
  const rest = minutes % 60
  return withDays
    ? `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h` // the week: to the hour
    : `${Math.floor(minutes / 60)}h ${rest}m`
}

const plusDays = (day: string, n: number): string => {
  const d = new Date(`${day}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** The three columns, from the stored days, the plan, the GET /metrics/savings body (or null) and today. */
export function panelOf(days: unknown, p: Plan | null, savings: unknown, today: string, nowMs: number): Panel {
  const all: Record<string, UsageDay> = isObj(days) ? (days as Record<string, UsageDay>) : {}
  const pick = (keep: (d: string) => boolean): string[] => {
    const list = Object.keys(all).filter(keep)
    if (!list.length) return ['--', '']
    const t = list.reduce((n, d) => n + (num(all[d].tokens) ?? 0), 0)
    const u = list.reduce((n, d) => n + (num(all[d].usd) ?? 0), 0)
    return [tokensText(t), moneyText(u)]
  }
  const weekFrom = plusDays(today, -6)
  const token: Column = {
    title: 'Token (excl. cache reads)',
    rows: [
      ['This week', ...pick((d) => d >= weekFrom && d <= today)],
      ['This month', ...pick((d) => d.slice(0, 7) === today.slice(0, 7) && d <= today)],
      ['All time', ...pick(() => true)],
    ],
  }
  const pl = p ?? { week: null, five_hour: null, context: null }
  // [percent, "(time to reset)"]: two cells, so the band centres the percent and right-aligns the reset
  const limit = (l: Limit | null, withDays: boolean): string[] => {
    if (!l) return ['--', '']
    const left = resetText(l.resets_at, nowMs, withDays)
    return [`${Math.round(l.pct)}%`, left ? `(${left})` : '']
  }
  const ctx = pl.context
  const s = isObj(savings) && !('error' in savings) ? savings : null
  const usd = s ? num(s.usd) : null
  const quota: Column = {
    title: ctx ? `Quota${DOT}context ${Math.round((ctx.tokens / ctx.window) * 100)}% (${tokensText(ctx.tokens)})` : `Quota${DOT}context --`,
    rows: [
      ['Week', ...limit(pl.week, true)],
      ['5-hour', ...limit(pl.five_hour, false)],
      ['Saved', '', usd === null ? '--' : moneyText(usd)],
    ],
    align: ['left', 'center', 'right'],
  }
  // the service's time figures when it has them, else this computer's (all its stored days)
  const t = s && isObj(s.time) && num(s.time.agent_seconds) !== null ? s.time : null
  const sum = (k: keyof UsageDay) => Object.values(all).reduce((n, d) => n + (num(d[k]) ?? 0), 0)
  const you = t ? t.agent_seconds : sum('agent_seconds')
  const typing = t ? (num(t.typing_seconds) ?? 0) : (sum('typed_bytes') * 60) / TYPING_BYTES_PER_MINUTE
  const concurrent = t ? (num(t.concurrent_seconds) ?? 0) : Math.max(0, sum('agent_sum_seconds') - you)
  const time: Column = {
    title: 'Time',
    rows: [
      ['Spent by you', you > 0 || typing > 0 ? durationText(typing) : '--'],
      ['Saved for you', you > 0 ? durationText(you) : '--'],
      ['Concurrency save', you > 0 ? durationText(concurrent) : '--'],
    ],
  }
  return { columns: [token, quota, time], method: METHOD_LINE }
}

const rowText = (r: string[]): string => r.filter((x) => x !== '').join(' ')

/** The panel as plain lines: one per column, then the disclosure. */
export function panelLines(panel: Panel): string[] {
  return [...panel.columns.map((c) => `${c.title}: ${c.rows.map(rowText).join(DOT)}`), panel.method]
}

/** The board's lines: the token and quota columns, then the two time figures under their full labels. */
export function boardLines(panel: Panel): string[] {
  const [typing, you, concurrent] = panel.columns[2].rows
  return [
    ...panelLines(panel).slice(0, 2),
    `Spent by you: ${typing[1]}`,
    `Saved for you: ${you[1]}`,
    `Concurrency save: ${concurrent[1]}`,
    panel.method,
  ]
}

