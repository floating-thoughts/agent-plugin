// The status line under the prompt, harness-neutral: its text, today's counts and the refresh rules.
//
// A port of host/status_line.py (render, today_text, the counts and the fetch interval) plus the plan 3.8 and 3.9
// rules: while signed out or auth-failed only the sign-in line is shown; when the plugin cannot update itself
// (no $.process) the update command is shown once per 7 days. Nothing here touches the engine; the wiring
// (phase 2) calls $.ui.status with statusText(...) after session.start and turn.complete.
//
// statusText(input) takes:
//   auth       'ok' | 'signed_out' | 'auth_failed' | 'locked' (the 3.9 state from $.store)
//   metricsOn  the daily-metrics opt-in;  saved  the last good GET /metrics/savings body ({ usd, pct, first_day })
//              or null (refresh it when savingsDue says so, keep the old one when a fetch fails)
//   counts     today's counts { route, compact_start, index } (todayCounts builds them from savings events)
//   update     optional: the update command line (updateCommand) when updateHintDue says it is time
import { pyFixed } from './metrics'

export const NAME = 'agent-services'
export const SEP = ' \u00b7 '
export const MAX_LEN = 110
export const SAVINGS_TTL_MS = 600_000 // plan 3.8: the $ figure is cached 10 minutes
// The command $.command.register declares (command.ts COMMAND): the plugin's old markdown command was
// /agent-services:agent-services; the registered one answers only to /agent-services (smoke test 2026-10-31).
export const COMMAND = '/agent-services'
export const UPDATE_HINT_MS = 7 * 86_400_000 // plan 3.8: the update line at most once per 7 days
export const HINT_OFF = `run ${COMMAND} savings on to see dollars saved`
export const HINT_OFF_SHORT = `dollars saved: ${COMMAND} savings on`
export const HINT_WAIT = 'savings show after the first daily upload'
export const HINT_WAIT_SHORT = 'savings after the first upload'
// The status line while signed out or after an auth fail (plan 3.9).
export const SIGN_IN_LINE = `${NAME}${SEP}signed out: ${COMMAND} login <email>`
export const LOCKED_LINE = `${NAME}${SEP}paused: this account is locked; contact support, then ${COMMAND} login <email>`
export const COUNTED: [string, string][] = [
  ['route', 'routed'],
  ['compact_start', 'compacted'],
  ['index', 'indexed reads'],
]
const DAY_RX = /^\p{Nd}{4}-(\p{Nd}{2}-\p{Nd}{2})\n?$/u

export type Counts = Record<string, number>
export type Auth = 'ok' | 'signed_out' | 'auth_failed' | 'locked'
export type StatusInput = { auth: Auth; metricsOn: boolean; saved: unknown; counts: Counts; update?: string | null }

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const cut = (s: string, n: number): string => [...s].slice(0, n).join('')

/** format(x, f".{n}f"), with thousands commas for f",.{n}f". */
export function fixed(x: number, n: number, commas = false): string {
  const text = pyFixed(x, n)
  if (!commas) return text
  const [whole, frac] = text.split('.')
  return whole.replace(/\B(?=(\d{3})+$)/g, ',') + (frac !== undefined ? '.' + frac : '')
}

export function todayText(counts: Counts): string | null {
  const parts = COUNTED.filter(([k]) => counts[k]).map(([k, label]) => `${counts[k]} ${label}`)
  return parts.length ? 'today: ' + parts.join(', ') : null
}

/** status_line.py render(): the line for the opt-in, the last server figure (or null) and today's counts. */
export function render(metricsOn: boolean, saved: unknown, counts: Counts): string {
  const today = todayText(counts)
  const head = [NAME]
  let tail: string | null = null
  const usd = isObj(saved) ? saved.usd : undefined
  if (!metricsOn) {
    head.push('on')
    tail = HINT_OFF
  } else if (num(usd) && usd > 0) {
    let s = `saved $${fixed(usd, 2, true)}`
    const pct = (saved as Record<string, unknown>).pct
    if (num(pct) && pct >= 0) s += ` (${fixed(pct * 100, 1)}%)`
    const first = (saved as Record<string, unknown>).first_day
    const m = typeof first === 'string' ? DAY_RX.exec(first) : null
    if (m) s += ` since ${m[1]}`
    head.push(s)
  } else {
    head.push('on')
    tail = HINT_WAIT
  }
  const short = tail === HINT_OFF ? HINT_OFF_SHORT : tail === HINT_WAIT ? HINT_WAIT_SHORT : null
  const leanCounts: Counts = {}
  for (const [k, v] of Object.entries(counts)) if (k !== 'index') leanCounts[k] = v
  const lean = todayText(leanCounts)
  let text = ''
  for (const [t, end] of [
    [today, tail],
    [today, short],
    [lean, short],
    [null, short],
    [null, tail],
  ] as (string | null)[][]) {
    text = [...head, ...[t, end].filter((x): x is string => !!x)].join(SEP)
    if ([...text].length <= MAX_LEN) return text
  }
  return cut(text, MAX_LEN)
}

/** The whole line: the sign-in line unless signed in (3.9), the update command when due, else render(). */
export function statusText(input: StatusInput): string {
  if (input.auth === 'locked') return LOCKED_LINE
  if (input.auth !== 'ok') return SIGN_IN_LINE
  if (typeof input.update === 'string' && input.update) return input.update
  return render(input.metricsOn === true, input.saved, input.counts ?? {})
}

/** StatusLine.counts(): today's (UTC day of nowSec) route, compaction and index events. */
export function todayCounts(events: unknown[], nowSec: number): Counts {
  const t = new Date(Math.floor(nowSec * 1000))
  const day = t.toISOString().slice(0, 10)
  const out: Counts = {}
  for (const item of events ?? []) {
    let e: unknown = item
    if (typeof item === 'string') {
      try {
        e = JSON.parse(item)
      } catch {
        continue
      }
    }
    if (isObj(e) && typeof e.ts === 'string' && e.ts.slice(0, 10) === day) {
      const k = e.kind
      if (COUNTED.some(([c]) => c === k)) out[k] = (out[k] ?? 0) + 1
    }
  }
  return out
}

/** Whether a savings fetch is due (ms clock): never while one runs, then once per SAVINGS_TTL_MS. */
export const savingsDue = (triedAt: number | null, now: number, fetching = false): boolean =>
  !fetching && (triedAt === null || now - triedAt >= SAVINGS_TTL_MS)

/** Whether the update command line is due again (ms clock). */
export const updateHintDue = (lastShown: number | null, now: number): boolean =>
  lastShown === null || now - lastShown >= UPDATE_HINT_MS

/** The one terminal line that updates the plugin, with the installed marketplace name filled in (plan 3.8). */
export const updateCommand = (marketplace: string): string =>
  `claude plugin marketplace update ${marketplace} && claude plugin update agent-services@${marketplace}`
