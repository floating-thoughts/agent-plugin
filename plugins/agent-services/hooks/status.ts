import { count, groupFixed, pyFixed } from './pyfmt'

export const NAME = 'agent-services'
export const SEP = ' \u00b7 '
export const MAX_LEN = 110
export const SAVINGS_TTL_MS = 600_000
export const COMMAND = '/agent-services'
export const UPDATE_HINT_MS = 7 * 86_400_000
export const HINT_OFF = `to see how much it saves you, run ${COMMAND} sharing on`
export const HINT_OFF_SHORT = `see savings: ${COMMAND} sharing on`
export const HINT_WAIT = 'savings from tomorrow'
export const HINT_WAIT_SHORT = 'savings from tomorrow'
export const SIGN_IN_LINE = `signed out: ${COMMAND} login <email>; guard and masking off`
export const LOCKED_LINE = `paused: this account is locked; contact support, then ${COMMAND} login <email>`
export const ORG_PAUSED_STATUS = `paused by your company; ask your admin`
export const GATE_STATUS: Readonly<Record<string, string>> = {
  offline: `offline mode is on`,
  unavailable: `can't reach its server`,
  unverified: `can't reach its server`,
  upgrade: `update needed`,
  clock: `computer clock is off`,
}
export const COUNTED: [string, string, string][] = [
  ['route', 'subagent on a cheaper model', 'subagents on cheaper models'],
  ['compact_start', 'memory cleanup', 'memory cleanups'],
]
const DAY_RX = /^[0-9]{4}-([0-9]{2})-([0-9]{2})\n?$/

export type Counts = Record<string, number>
export type Auth = 'ok' | 'signed_out' | 'auth_failed' | 'locked' | 'paused'
export type StatusInput = { auth: Auth; metricsOn: boolean; saved: unknown; counts: Counts; update?: string | null; gate?: string | null
  sharingAsk?: boolean; pausedLine?: string | null }

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const cut = (s: string, n: number): string => [...s].slice(0, n).join('')

export function fixed(x: number, n: number, commas = false): string {
  return commas ? groupFixed(x, n) : pyFixed(x, n)
}

export function todayText(counts: Counts): string | null {
  const parts = COUNTED.filter(([k]) => num(counts[k]) && counts[k]! > 0).map(([k, one, many]) => `${count(counts[k])} ${counts[k] === 1 ? one : many}`)
  return parts.length ? 'today: ' + parts.join(', ') : null
}

export function shortDay(first: unknown): string | null {
  const m = typeof first === 'string' ? DAY_RX.exec(first) : null
  if (!m) return null
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[1]) - 1]
  const day = Number(m[2])
  return month && day >= 1 && day <= 31 ? `${month} ${day}` : null
}

export function render(metricsOn: boolean, saved: unknown, counts: Counts, ask = true): string {
  const today = todayText(counts)
  const head: string[] = []
  let tail: string | null = null
  let short: string | null = null
  const usd = isObj(saved) ? saved.usd : undefined
  if (!metricsOn) {
    tail = ask ? HINT_OFF : null
    short = ask ? HINT_OFF_SHORT : null
  } else {
    return ''
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

export function statusText(input: StatusInput): string {
  if (input.auth === 'locked') return LOCKED_LINE
  const paused = typeof input.pausedLine === 'string' && input.pausedLine ? input.pausedLine : ORG_PAUSED_STATUS
  if (input.auth === 'paused') return paused
  if (input.auth !== 'ok') return SIGN_IN_LINE
  if (typeof input.update === 'string' && input.update) return input.update
  const gate = typeof input.gate === 'string' ? input.gate : ''
  if (gate === 'login' || gate === 'locked' || gate === 'paused') return gate === 'login' ? SIGN_IN_LINE : gate === 'locked' ? LOCKED_LINE : paused
  if (Object.hasOwn(GATE_STATUS, gate)) return GATE_STATUS[gate]!
  return render(input.metricsOn === true, input.saved, input.counts ?? {}, input.sharingAsk !== false)
}

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
      if (k === 'route' || k === 'compact_start' || k === 'index') out[k] = (out[k] ?? 0) + 1
    }
  }
  return out
}

export const savingsDue = (triedAt: number | null, now: number, fetching = false): boolean =>
  !fetching && (triedAt === null || now - triedAt >= SAVINGS_TTL_MS)

export const updateHintDue = (lastShown: number | null, now: number): boolean =>
  lastShown === null || now - lastShown >= UPDATE_HINT_MS

export const updateCommand = (marketplace: string): string =>
  `claude plugin marketplace update ${marketplace} && claude plugin update agent-services@${marketplace}`

