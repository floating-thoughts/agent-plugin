import { localDay } from './counters'
import { DATA_FIELDS, activityOf, localDayOf, peer, savingsPart, weeks } from './render'
import { ORG_ADMIN_TOTALS } from './org'
import { cheaper } from './summary'
import { COMMAND, COUNTED, shortDay } from './status'
import { count, money, plusDays, pyRound, pySum } from './pyfmt'
import { servedNumber, servedValue } from './rules'

export const BOARD_FIELDS = [...DATA_FIELDS, 'timeline', 'weekly'] as const
export const TIMELINE_MAX = 12
export const OUTBOX_FILES_MAX = 60
export const WEEK_DAYS = 7
export const ADMIN_LINE = 'Your company admin can see your email address, how many devices you use, and your savings figures.'
export const OFF_LINE = `Turn on the savings record to see a weekly summary: ${COMMAND} sharing on`
export const WAIT_LINE = 'Your weekly summary appears after your first full day of measured savings.'

export function minUsd(): number {
  return servedNumber('board', 'min_usd', 0.005, 0.0001, 1)
}

export function leverWords(): Record<string, string> {
  const v = servedValue('board', 'lever_words')
  const out: Record<string, string> = {}
  if (isObj(v)) for (const [k, w] of Object.entries(v)) if (typeof w === 'string' && w) out[k] = w
  return out
}

function phrasePair(kind: string): [string, string] | undefined {
  const v = servedValue('board', 'phrases')
  const p = isObj(v) ? v[kind] : undefined
  return Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === 'string') ? [p[0], p[1]] : undefined
}

type Obj = Record<string, any>
export type TimelineItem = { at: string; kind: string; count: number; text: string }
export type Timeline = { items: TimelineItem[]; counts: Record<string, number>; summary: string | null }
export type OutboxReadFs = {
  read(path: string): Promise<string>
  list?(path: string): Promise<readonly { name: string; size?: number; dir?: boolean }[]>
}

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
export { money }
const parse = (text: unknown): Obj | null => {
  if (typeof text !== 'string' || !text) return null
  try {
    const o = JSON.parse(text)
    return isObj(o) ? o : null
  } catch {
    return null
  }
}

export function lineDay(line: unknown): string | null {
  if (!isObj(line) || typeof line.ts !== 'string') return null
  return localDayOf(line.ts)
}

export function kindOf(line: unknown): string | null {
  if (!isObj(line)) return null
  if (line.kind === 'artifact_publish') return line.outcome === 'published' ? 'board' : null
  if (line.kind !== undefined || line.preview === true || line.status !== 200) return null
  const route = typeof line.route === 'string' ? line.route : ''
  const ans = parse(line.response_text)
  if (route === '/router/decide' && ans && ans.decision === 'route') {
    return cheaper(ans.model) ? 'cheaper' : 'model'
  }
  if (route === '/checkpoint/timing') return ans && ans.now === true ? 'cleanup' : null
  if (route === '/served/fetch') return 'tips'
  if (route === '/metrics/daily' && line.method === 'POST') return 'upload'
  return null
}

const phrase = (kind: string, n: number): string | null => {
  const p = phrasePair(kind)
  return p ? (n === 1 ? p[0] : p[1].replace('{n}', String(n))) : null
}

export function todaySummary(counts: unknown): string | null {
  const c = isObj(counts) ? counts : {}
  const parts = COUNTED.filter(([k]) => (num(c[k]) ?? 0) > 0).map(([k, one, many]) => `${count(c[k])} ${c[k] === 1 ? one : many}`)
  return parts.length ? `So far today: ${parts.join(', ')}.` : null
}

export function timelineOf(lines: unknown[] | null | undefined, counts: unknown, today: string): Timeline {
  const groups = new Map<string, TimelineItem>()
  for (const line of lines ?? []) {
    const kind = kindOf(line)
    if (kind === null || lineDay(line) !== today) continue
    const at = new Date(Date.parse((line as Obj).ts)).toISOString()
    const hour = new Date(Date.parse(at))
    const key = `${kind}\n${hour.getFullYear()}-${hour.getMonth()}-${hour.getDate()}-${hour.getHours()}`
    const have = groups.get(key)
    if (!have) groups.set(key, { at, kind, count: 1, text: '' })
    else {
      have.count++
      if (at > have.at) have.at = at
    }
  }
  const items = [...groups.values()]
    .filter((it) => phrasePair(it.kind) !== undefined)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.kind < b.kind ? -1 : 1))
    .slice(0, TIMELINE_MAX)
    .map((it) => ({ ...it, text: phrase(it.kind, it.count)! }))
  const c: Record<string, number> = {}
  if (isObj(counts)) for (const [k] of COUNTED) if ((num(counts[k]) ?? 0) > 0) c[k] = counts[k]
  return { items, counts: c, summary: todaySummary(c) }
}

function peerPct(report: unknown): number | null {
  return peer(report)[0]
}

export type WeeklyOpts = { metricsOn?: boolean | null; inOrg?: boolean | null; adminLine?: string | null }

export function weeklyOf(savings: unknown, report: unknown, today: string, opts: WeeklyOpts = {}): Obj {
  const adminText = typeof opts.adminLine === 'string' && opts.adminLine ? opts.adminLine : opts.inOrg === true ? ADMIN_LINE : null
  const out: Obj = {
    days: WEEK_DAYS,
    this_week_usd: null,
    last_week_usd: null,
    change_usd: null,
    days_saved: null,
    best_day: null,
    top_lever: null,
    total_usd: null,
    since: null,
    your_pct: null,
    activity: null,
    peer_pct: peerPct(report),
    admin_sees: adminText ? true : null,
    lines: [] as string[],
  }
  const sav = savingsPart(savings)
  const cut1 = plusDays(today, -(WEEK_DAYS - 1))
  const week = sav ? sav.by_day.filter((r: Obj) => cut1 <= r.day && r.day <= today) : []
  if (sav) {
    out.total_usd = sav.usd
    out.since = sav.first_day
    out.your_pct = sav.pct
  }
  const w = weeks(sav, today)
  out.this_week_usd = w.this ? w.this.usd : null
  out.last_week_usd = w.last ? w.last.usd : null
  out.activity = activityOf(w)
  const min = minUsd()
  if (week.length) {
    out.days_saved = week.filter((r: Obj) => (num(r.usd) ?? 0) >= min).length
    const best = week.reduce((a: Obj | null, r: Obj) => ((num(r.usd) ?? 0) > (a ? num(a.usd) ?? 0 : 0) ? r : a), null)
    if (best && (num(best.usd) ?? 0) >= min) out.best_day = { day: best.day, usd: num(best.usd) }
    let top: [string, number] | null = null
    for (const name of Object.keys(leverWords())) {
      const v = pySum(week.map((r: Obj) => num(r[`${name}_usd`]) ?? 0))
      if (v >= min && (top === null || v > top[1])) top = [name, v]
    }
    out.top_lever = top ? top[0] : null
  }
  if (out.this_week_usd !== null && out.last_week_usd !== null) out.change_usd = pyRound(out.this_week_usd - out.last_week_usd, 6)
  out.lines = weeklyLines(out, opts.metricsOn, adminText ?? ADMIN_LINE)
  return out
}

export function weeklyLines(w: Obj, metricsOn?: boolean | null, adminText: string = ADMIN_LINE): string[] {
  const lines: string[] = []
  const usd = num(w.this_week_usd)
  const min = minUsd()
  const levers = leverWords()
  if (metricsOn === false && (usd === null || num(w.days_saved) === null)) lines.push(OFF_LINE)
  else if (usd === null) lines.push(WAIT_LINE)
  else {
    if (usd >= min) lines.push(`In the last ${WEEK_DAYS} days agent-services saved you ${money(usd)}.`)
    else if (usd <= -min) lines.push(`In the last ${WEEK_DAYS} days memory cleanups cost ${money(-usd)} more than they saved.`)
    else lines.push(`Nothing was saved in the last ${WEEK_DAYS} days.`)
    const ch = num(w.change_usd)
    if (ch !== null && Math.abs(ch) >= min) lines.push(`That is ${money(Math.abs(ch))} ${ch > 0 ? 'more' : 'less'} than the ${WEEK_DAYS} days before.`)
    const best = isObj(w.best_day) ? w.best_day : null
    const bestDay = best ? shortDay(best.day) : null
    if (best && bestDay && (num(w.days_saved) ?? 0) > 1) lines.push(`Your best day was ${bestDay}: ${money(best.usd)}.`)
    if (typeof w.top_lever === 'string' && levers[w.top_lever]) lines.push(`Most of it came from ${levers[w.top_lever]}.`)
    lines.push(...activityLines(w.activity))
  }
  const peer = num(w.peer_pct)
  const yours = num(w.your_pct)
  if (peer !== null && yours !== null) {
    lines.push(`You save ${Math.round(yours * 100)}% of your usage cost; similar users save about ${Math.round(peer)}%.`)
  }
  if (w.admin_sees === true) lines.push(adminText)
  return lines
}

export function activityLines(a: unknown): string[] {
  const out: string[] = []
  if (!isObj(a)) return out
  const rows: [string, string, (n: number) => string][] = [
    ['sessions', 'Claude Code sessions', count],
    ['subagent_runs', 'Helper agent runs', count],
    ['api_usd', 'AI usage at list prices', money],
  ]
  for (const [key, label, fmt] of rows) {
    const pair: Obj = isObj(a[key]) ? a[key] : {}
    const t = num(pair.this_week)
    const l = num(pair.last_week)
    if ((t ?? 0) === 0 && (l ?? 0) === 0) continue
    if (t === null) {
      out.push(`${label}: nothing measured in the last ${WEEK_DAYS} days.`)
      continue
    }
    const head = `${label}: ${fmt(t)} in the last ${WEEK_DAYS} days`
    if (l === null) {
      out.push(`${head}; nothing measured in the ${WEEK_DAYS} days before.`)
      continue
    }
    const diff = (t ?? 0) - l
    out.push(
      Math.round(diff * 100) === 0
        ? `${head}, the same as the ${WEEK_DAYS} days before.`
        : `${head}, ${fmt(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'} than the ${WEEK_DAYS} days before.`,
    )
  }
  return out
}

export function inOrg(status: unknown): boolean | null {
  if (!isObj(status)) return null
  if (status.org === true || isObj(status.org)) return true
  if (typeof status.org_id === 'string' && status.org_id) return true
  return null
}

export async function readOutboxDay(fs: OutboxReadFs, dir: string, nowMs: number): Promise<Obj[]> {
  const out: Obj[] = []
  if (typeof fs.list !== 'function') return out
  const base = dir.replace(/[\\/]+$/, '')
  const today = localDay(nowMs)
  const utc = (d: number) => new Date(nowMs + d * 86_400_000).toISOString().slice(0, 10)
  const days = new Set([utc(-1), utc(0), utc(1)])
  let names: string[] = []
  try {
    names = (await fs.list(base)).map((e) => e.name).filter((n) => /^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.jsonl$/.test(n) && days.has(n.slice(0, 10)))
  } catch {
    return out
  }
  for (const name of names.sort().reverse().slice(0, OUTBOX_FILES_MAX)) {
    let text = ''
    try {
      text = String(await fs.read(`${base}/${name}`))
    } catch {
      continue
    }
    for (const raw of text.split('\n')) {
      const line = parse(raw)
      if (line && lineDay(line) === today) out.push(line)
    }
  }
  return out
}

export type BoardInput = {
  outboxLines?: unknown[] | null
  todayCounts?: Record<string, number> | null
  savings?: unknown
  report?: unknown
  status?: unknown
  panel?: string[] | null
}

const safe = <T>(f: () => T): T | null => {
  try {
    return f()
  } catch {
    return null
  }
}

export function adminLine(status: unknown): string | null {
  if (inOrg(status) !== true) return null
  const org = isObj(status) && isObj(status.org) ? status.org : null
  if (org && org.has_admin === false) return null
  return org && org.view === 'totals' ? ORG_ADMIN_TOTALS : ADMIN_LINE
}

export function boardData(collected: Obj, input: BoardInput): Obj {
  const today = typeof collected?.today === 'string' ? collected.today : localDay(Date.now())
  const metricsOn = typeof collected?.metrics_on === 'boolean' ? collected.metrics_on : null
  return {
    ...collected,
    timeline: safe(() => timelineOf(input.outboxLines, input.todayCounts, today)),
    weekly: safe(() => {
      const w = weeklyOf(input.savings, input.report, today, { metricsOn, adminLine: adminLine(input.status) })
      return Array.isArray(input.panel) && input.panel.length ? { ...w, usage_lines: input.panel } : w
    }),
  }
}
