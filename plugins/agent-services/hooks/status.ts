// The status line under the prompt, harness-neutral: its text, today's counts and the refresh rules.
//
// A port of the Python client (render, today_text, the counts and the fetch interval) plus the
// rules: while signed out or auth-failed only the sign-in line is shown; when the plugin cannot run commands
// (no $.process) the update command is shown once per 7 days. Nothing here touches the engine; the wiring
// (phase 2) calls $.ui.status with statusText(...) after session.start and turn.complete.
//
// statusText(input) takes:
//   auth       'ok' | 'signed_out' | 'auth_failed' | 'locked' | 'paused' (the auth state from $.store; paused: the company paused it)
//   metricsOn  the daily metrics upload (on unless the user turned it off);  saved  the last good GET /metrics/savings body ({ usd, pct, first_day })
//              or null (refresh it when savingsDue says so, keep the old one when a fetch fails)
//   counts     today's counts { route, compact_start, index } (todayCounts builds them from savings events)
//   update     optional: the update command line (updateCommand) when updateHintDue says it is time
//   gate       optional: the reason the service gate is closed (svc.ts GateState.reason), or null while open
// Decision: the line always says something, in the same words as the band above the prompt
// (band.ts BAND_TEXT says each state in full).
// Decision: the engine already shows the plugin's name before the status line, so the line
// does not start with it.
// The readers are not technical: the line says what was saved in dollars and what was done today in plain words.
import { pyFixed } from './pyfmt'

export const NAME = 'agent-services'
export const SEP = ' \u00b7 '
export const MAX_LEN = 110
export const SAVINGS_TTL_MS = 600_000 // the $ figure is cached 10 minutes
// The command $.command.register declares (command.ts COMMAND): the plugin's old markdown command was
// /agent-services:agent-services; the registered one answers only to /agent-services (smoke test 2026-10-31).
export const COMMAND = '/agent-services'
export const UPDATE_HINT_MS = 7 * 86_400_000 // the update line at most once per 7 days
export const HINT_OFF = `to see how much it saves you, run ${COMMAND} sharing on`
export const HINT_OFF_SHORT = `see savings: ${COMMAND} sharing on`
export const HINT_WAIT = 'savings from tomorrow' // after "on": signed in, no figure yet (band.ts BAND_TEXT.wait)
export const HINT_WAIT_SHORT = 'savings from tomorrow'
// The status line while signed out or after an auth fail.
export const SIGN_IN_LINE = `signed out: ${COMMAND} login <email>; guard and masking off`
export const LOCKED_LINE = `paused: this account is locked; contact support, then ${COMMAND} login <email>`
export const ORG_PAUSED_STATUS = `paused by your company; ask your admin` // the company paused it
// The status line while the service gate is closed for a reason other than sign-in (band.ts BAND_TEXT in full).
export const GATE_STATUS: Readonly<Record<string, string>> = {
  offline: `offline mode is on`,
  unavailable: `can't reach its server`,
  unverified: `can't reach its server`,
  upgrade: `update needed`,
}
// today's counts: [event kind, one, many]
export const COUNTED: [string, string, string][] = [
  ['route', 'job on a cheaper model', 'jobs on a cheaper model'],
  ['compact_start', 'memory cleanup', 'memory cleanups'],
]
const DAY_RX = /^[0-9]{4}-([0-9]{2})-([0-9]{2})\n?$/

export type Counts = Record<string, number>
export type Auth = 'ok' | 'signed_out' | 'auth_failed' | 'locked' | 'paused'
export type StatusInput = { auth: Auth; metricsOn: boolean; saved: unknown; counts: Counts; update?: string | null; gate?: string | null }

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
  const parts = COUNTED.filter(([k]) => num(counts[k]) && counts[k]! > 0).map(([k, one, many]) => `${counts[k]} ${counts[k] === 1 ? one : many}`)
  return parts.length ? 'today: ' + parts.join(', ') : null
}

/** "2026-10-01" as "Oct 1"; null for anything else. */
export function shortDay(first: unknown): string | null {
  const m = typeof first === 'string' ? DAY_RX.exec(first) : null
  if (!m) return null
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[1]) - 1]
  const day = Number(m[2])
  return month && day >= 1 && day <= 31 ? `${month} ${day}` : null
}

/** The line for the upload switch, the last server figure (or null) and today's counts, at most MAX_LEN. */
export function render(metricsOn: boolean, saved: unknown, counts: Counts): string {
  const today = todayText(counts)
  const head: string[] = [] // the engine prints the plugin's name before the line (CLI and desktop), so the line leaves it out
  let tail: string | null = null
  let short: string | null = null
  const usd = isObj(saved) ? saved.usd : undefined
  if (!metricsOn) {
    tail = HINT_OFF
    short = HINT_OFF_SHORT
  } else {
    return '' // signed in and on: no status line; the band's panel shows the figures and the open decisions
  }
  let text = ''
  for (const [t, end] of [
    [today, tail],
    [today, short],
    [null, short],
    [null, tail],
  ] as (string | null)[][]) {
    text = [...head, ...[t, end].filter((x): x is string => !!x)].join(SEP)
    if ([...text].length <= MAX_LEN) return text
  }
  return cut(text, MAX_LEN)
}

/** The whole line: the sign-in line unless signed in, the update command when due, else render(). */
export function statusText(input: StatusInput): string {
  if (input.auth === 'locked') return LOCKED_LINE
  if (input.auth === 'paused') return ORG_PAUSED_STATUS
  if (input.auth !== 'ok') return SIGN_IN_LINE
  if (typeof input.update === 'string' && input.update) return input.update
  const gate = typeof input.gate === 'string' ? input.gate : ''
  if (gate === 'login' || gate === 'locked' || gate === 'paused') return gate === 'login' ? SIGN_IN_LINE : gate === 'locked' ? LOCKED_LINE : ORG_PAUSED_STATUS
  if (GATE_STATUS[gate]) return GATE_STATUS[gate]
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
      if (k === 'route' || k === 'compact_start' || k === 'index') out[k] = (out[k] ?? 0) + 1 // index: kept, not shown
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

/** The one terminal line that updates the plugin, with the installed marketplace name filled in. */
export const updateCommand = (marketplace: string): string =>
  `claude plugin marketplace update ${marketplace} && claude plugin update agent-services@${marketplace}`

