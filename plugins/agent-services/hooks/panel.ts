// The usage panel: the same three columns the band, the status command and the board show.
//
//   Token (incl. cache reads)   This week / This month / All time: tokens and dollars at API prices. "all devices" when
//                               the service sent the account's days (GET /metrics/savings usage_by_day), merged with
//                               this computer's: one figure per day (mergedDays). Otherwise "this computer", from this
//                               computer's transcripts (usageDaysOf over the scan, kept per day under USAGE_DAYS_KEY)
//   Quota . context N% (Nk)     Week % and 5-hour % of the plan with the time to their reset, and the context, from
//                               the engine's session usage (planOf); then "Saved (est.) $X", the service's savings figure
//                               ("off" while the savings record is off)
//   Time . total so far         Spent by you: the person's typing time; Agent time: clock time with at least one agent
//                               active; Concurrent: the agents' summed run time less that
//                               clock time. Totals over this computer's stored days (the account's days carry no time).
//
// Unknown figures show "--". methodLine() is the disclosure shown wherever the time figures appear (METHOD_LINE is
// its built-in form); the service sends the same sentence with its figures. The idle gap, the typing speed and the
// sentence come from the served time model (rules timemodel.json) when the tables are held.
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
import { servedNumber, servedValue } from './rules'
import { IDLE_GAP_MS, idleGapMs } from './transcripts'
import type { Facts } from './transcripts'

export const PANEL_EVERY_MS = 60_000 // the band and panel redraw (register.ts): reset countdowns move each minute
export const USAGE_DAYS_KEY = 'usage_days' // { through, at, lock?, days: { day: UsageDay } }: this computer's figures
export const TYPING_BYTES_PER_MINUTE = 200 // built-in; the served time model (timemodel.json) sets it
export const METHOD_LINE = methodText(methodTemplate(), IDLE_GAP_MS / 60_000, TYPING_BYTES_PER_MINUTE)

/** The disclosure's built-in wording; {idle_gap_minutes} and {typing_bytes_per_minute} take the values in use. */
function methodTemplate(): string {
  return 'Agent time is clock time when at least one agent was working (gaps over {idle_gap_minutes} minutes ' +
    "count as idle; time with several agents running counts once). It is the agents' own run time, not an estimate " +
    'of how long a person would take. Spent by you is your own time at the keyboard, estimated as typed bytes / ' +
    "{typing_bytes_per_minute} bytes per minute. Concurrency save (est.) = the agents' combined run time minus clock time, " +
    'i.e. what running them side by side saved compared with one at a time. All three time figures are totals so far.'
}

function methodText(template: string, gapMinutes: number, bytesPerMinute: number): string {
  return template.split('{idle_gap_minutes}').join(String(gapMinutes)).split('{typing_bytes_per_minute}').join(String(bytesPerMinute))
}

/** Typed bytes per minute: the served typing_bytes_per_minute, else TYPING_BYTES_PER_MINUTE. */
export function typingBytesPerMinute(): number {
  return servedNumber('timemodel', 'typing_bytes_per_minute', TYPING_BYTES_PER_MINUTE, 10, 10_000)
}

/** The disclosure with the values in use: the served method sentence when there is one, else the built-in one. */
export function methodLine(): string {
  const t = servedValue('timemodel', 'method')
  return methodText(typeof t === 'string' && t ? t : methodTemplate(), idleGapMs() / 60_000, typingBytesPerMinute())
}

/** The dollar figure's disclosure, shown with the time method wherever the panel's disclosure appears. */
export function savedNote(): string {
  return 'Saved (est.) is an estimate against API list prices for the same work with every subagent on a top-tier model (Opus); ' +
    'it is not a bill or a refund.'
}

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
  const cacheRead: Record<string, number> = {} // the scan's cache reads per day: the panel counts every token
  for (const [d, f] of Object.entries(facts.by_day ?? {})) {
    if (d < fromDay) continue
    for (const b of Object.values(f.by_model)) {
      const r = num(b.cache_read_tokens) ?? 0
      day(d).tokens += b.tokens + r
      day(d).usd += b.api_usd
      cacheRead[d] = (cacheRead[d] ?? 0) + r
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
    // the days file's tokens leave cache reads out: add its own count, or else the scan's
    if (num(x.tokens) !== null) t.tokens += num(x.cache_read_tokens) ?? cacheRead[d] ?? 0
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
      // x already holds the tool's figures with its cache reads added to tokens: take them from x, not the raw file
      // (the raw `tokens` leaves cache reads out, which made the panel show about a third of the tokens)
      const full = facts.full_days?.[d] ?? {}
      all[d] = { ...(all[d] ?? x), ...Object.fromEntries(Object.entries(x).filter(([k]) => typeof (full as Obj)[k] === 'number')) }
    }
    // a stored day never shrinks: a rescan can be partial (the plugin's scan leaves over-4-MiB transcripts out when the
    // days file does not cover the day; a transcript deleted since leaves a smaller days-file row), and the panel's
    // figures are totals so far, so each field keeps the larger of the stored and the new value
    for (const [d, old] of Object.entries(days)) {
      if (!isObj(old) || !all[d]) continue
      const t = { ...all[d] }
      for (const k of ['tokens', 'usd', 'typed_bytes', 'agent_seconds', 'agent_sum_seconds', 'turns'] as const) {
        const was = num(old[k])
        if (was !== null && !(num(t[k]) !== null && t[k] >= was)) t[k] = was
      }
      all[d] = t
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

/** True once a window's reset time has passed: its reading belongs to the window before and is not shown or used. */
export function expired(l: Limit, nowMs: number): boolean {
  const t = l.resets_at ? Date.parse(l.resets_at) : NaN
  return Number.isFinite(t) && t <= nowMs
}

export type TimeFigures = { agent_seconds: number; typing_seconds: number; concurrent_seconds: number }

/** The time figures over the stored days (USAGE_DAYS_KEY): the one computation the panel and the status command read. */
export function timeOf(days: unknown): TimeFigures {
  const all: Record<string, UsageDay> = isObj(days) ? (days as Record<string, UsageDay>) : {}
  const sum = (k: keyof UsageDay) => Object.values(all).reduce((n, d) => n + (isObj(d) ? num(d[k]) ?? 0 : 0), 0)
  const you = sum('agent_seconds')
  return { agent_seconds: you, typing_seconds: (sum('typed_bytes') * 60) / typingBytesPerMinute(), concurrent_seconds: Math.max(0, sum('agent_sum_seconds') - you) }
}

/** At most three significant digits with a k, M or B suffix: 9.41k, 94.1k, 132M, 1.20B. Below 1000: whole numbers,
 *  or with `cents` two decimals below 10 and one below 100 (5.40, 40.7, 940). */
export function compactText(n: number, cents = false): string {
  const a = Math.abs(n)
  const sig = (x: number): string => (x < 9.995 ? x.toFixed(2) : x < 99.95 ? x.toFixed(1) : String(Math.round(x)))
  let s: string | null = null
  for (const [unit, sfx] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']] as const) {
    if (a >= unit * 0.9995) {
      s = sig(a / unit) + sfx
      break
    }
  }
  if (s === null) s = cents ? sig(a) : String(Math.round(a))
  return `${n < 0 ? '-' : ''}${s}`
}

/** Tokens as 950, 90.0k, 2.00M, 132M, 1.20B. */
export const tokensText = (n: number): string => compactText(n)

/** Dollars as $5.40, $40.7, $940, $9.41k, $94.1k. */
export const moneyText = (v: number): string => (v < 0 ? '-$' : '$') + compactText(Math.abs(v), true)

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

/** The account's days from GET /metrics/savings (usage_by_day, summed over its computers), or null when the service sent
 *  none: an older service, the savings record off (`error`) or the account's figures hidden. mine_* is what this
 *  computer itself stored for the day (0 when it stored nothing). */
type AccountDay = { tokens: number; usd: number; mine: boolean; mine_tokens: number; mine_usd: number; legacy_tokens: number; legacy_usd: number }
function accountDaysOf(savings: unknown): Record<string, AccountDay> | null {
  if (!isObj(savings) || 'error' in savings || !Array.isArray(savings.usage_by_day)) return null
  const out: Record<string, AccountDay> = {}
  for (const r of savings.usage_by_day) {
    if (isObj(r) && typeof r.day === 'string' && num(r.tokens) !== null && num(r.api_usd) !== null) {
      out[r.day] = { tokens: r.tokens, usd: r.api_usd, mine: r.mine === true, mine_tokens: num(r.mine_tokens) ?? 0,
        mine_usd: num(r.mine_api_usd) ?? 0, legacy_tokens: num(r.legacy_tokens) ?? 0, legacy_usd: num(r.legacy_api_usd) ?? 0 }
    }
  }
  return out
}

/** One figure per day: the account's sum over all its rows of the day, less this computer's own stored row and less a
 *  legacy row (from before computers were kept apart) that this computer may own, plus this computer's own figure. A
 *  legacy row on a day this computer stored itself is another computer's: the plugin uploads each day once. The own
 *  figure is the largest of the local figure, its stored row and that legacy row: the stored row is built from the
 *  transcripts without the ones over 4 MiB (the panel counts them) and can lag the local refresh by up to ten minutes. */
function mergedDays(local: Record<string, UsageDay>, account: Record<string, AccountDay>): Record<string, UsageDay> {
  const out: Record<string, UsageDay> = {}
  for (const d of Array.from(new Set([...Object.keys(account), ...Object.keys(local)]))) {
    const a = account[d]
    const x = local[d]
    const mineTokens = a ? a.mine_tokens : 0
    const mineUsd = a ? a.mine_usd : 0
    const localTokens = isObj(x) ? (num(x.tokens) ?? 0) : 0
    const localUsd = isObj(x) ? (num(x.usd) ?? 0) : 0
    const legacyOwnTokens = a && !a.mine ? a.legacy_tokens : 0
    const legacyOwnUsd = a && !a.mine ? a.legacy_usd : 0
    const candidates = [{ tokens: localTokens, usd: localUsd }, { tokens: mineTokens, usd: mineUsd },
      { tokens: legacyOwnTokens, usd: legacyOwnUsd }]
    const own = candidates.reduce((best, c) => (c.tokens > best.tokens ? c : best))
    const others = a ? { tokens: Math.max(0, a.tokens - mineTokens - legacyOwnTokens),
      usd: Math.max(0, a.usd - mineUsd - legacyOwnUsd) } : { tokens: 0, usd: 0 }
    out[d] = { tokens: others.tokens + own.tokens, usd: others.usd + own.usd, typed_bytes: 0, agent_seconds: 0,
      agent_sum_seconds: 0, turns: 0 }
  }
  return out
}

/** The three columns, from the stored days, the plan, the GET /metrics/savings body (or null) and today. */
export function panelOf(days: unknown, p: Plan | null, savings: unknown, today: string, nowMs: number, week: unknown = null): Panel {
  const local: Record<string, UsageDay> = isObj(days) ? (days as Record<string, UsageDay>) : {}
  const account = accountDaysOf(savings)
  const all = account ? mergedDays(local, account) : local
  const pick = (keep: (d: string) => boolean): string[] => {
    const list = Object.keys(all).filter(keep)
    if (!list.length) return ['--', '']
    const t = list.reduce((n, d) => n + (num(all[d].tokens) ?? 0), 0)
    const u = list.reduce((n, d) => n + (num(all[d].usd) ?? 0), 0)
    return [tokensText(t), moneyText(u)]
  }
  const weekFrom = plusDays(today, -6)
  const token: Column = {
    title: account && Object.keys(account).length ? 'Token (all devices)' : 'Token (this computer)',
    rows: [
      ['Week', ...pick((d) => d >= weekFrom && d <= today)],
      ['Month', ...pick((d) => d.slice(0, 7) === today.slice(0, 7) && d <= today)],
      ['All time', ...pick(() => true)],
    ],
  }
  const pl = p ?? { week: null, five_hour: null, context: null }
  // [percent, "(time to reset)"]: two cells, so the band centres the percent and right-aligns the reset
  const limit = (l: Limit | null, withDays: boolean): string[] => {
    if (!l || expired(l, nowMs)) return ['--', '']
    const left = resetText(l.resets_at, nowMs, withDays)
    return [`${Math.round(l.pct)}%`, left ? `(${left})` : '']
  }
  const ctx = pl.context
  const s = isObj(savings) && !('error' in savings) ? savings : null
  const off = isObj(savings) && savings.error === 'service_off' // the savings record is off: say so, not "--"
  const usd = s ? num(s.usd) : null
  const quota: Column = {
    title: ctx ? `Quota${DOT}context ${Math.round((ctx.tokens / ctx.window) * 100)}%` : `Quota${DOT}context --`,
    rows: [
      ['Week', ...limit(pl.week, true)],
      ['5-hour', ...limit(pl.five_hour, false)],
      ['Saved (est.)', '', off ? 'off' : usd === null ? '--' : moneyText(usd)],
    ],
    align: ['left', 'center', 'right'],
  }
  // this computer's stored days (refreshed every 10 minutes), never the service's figures: those come from the daily
  // upload, so today never showed and the two columns disagreed; the account's days carry no time figures
  const { agent_seconds: you, typing_seconds: typing, concurrent_seconds: concurrent } = timeOf(local)
  const time: Column = {
    title: `Time${DOT}total so far`, // cumulative: every stored day, not this week
    rows: [
      ['Spent', you > 0 || typing > 0 ? durationText(typing) : '--'],
      ['Agent time', you > 0 ? durationText(you) : '--'],
      ['Concurrent', you > 0 ? durationText(concurrent) : '--'],
    ],
  }
  // the last 7 days' counts from the store counters (day_counts.ts countsOf, summed): route turns, compactions, index reads
  const w = isObj(week) ? week : null
  const count = (k: string): string => (w ? compactText(num(w[k]) ?? 0) : '--')
  const stats: Column = {
    title: 'Weekly Stats',
    rows: [
      ['Cheaper jobs', count('route')],
      ['Cleanups', count('compact_start')],
      ['Index reads', count('index')],
    ],
  }
  return { columns: [token, quota, time, stats], method: `${savedNote()} ${methodLine()}` }
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
    `Spent: ${typing[1]}`,
    `Agent time: ${you[1]}`,
    `Concurrent: ${concurrent[1]}`,
    panel.method,
  ]
}

