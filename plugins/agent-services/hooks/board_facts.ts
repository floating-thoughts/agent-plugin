// What agent-services did for this customer, in plain words: the board's `timeline` (today) and `weekly` parts
// built so the band above the prompt can call the same functions and say the same thing.
//
// Harness-neutral and pure except readOutboxDay, which takes the file access. The facts are the ones the status
// line uses (status.ts COUNTED wording, day_counts.ts countsOf over the store counters, the cached GET
// /metrics/savings body, money as "$12.40") plus the local request log (outbox.ts lines: router answers,
// checkpoint answers, served fetches, the daily upload and board publishes). Only fixed phrases and numbers leave
// this module: no session text, path, id or host name.
//
//   timelineOf(lines, counts, today)          -> { items: [{ at, kind, count, text }], counts, summary }
//   weeklyOf(savings, report, today, opts)    -> { this_week_usd, last_week_usd, ..., lines: [text] }
//   readOutboxDay(fs, dir, nowMs)             -> today's outbox lines of every session (objects)
//   inOrg(status)                             -> true for a person in an org (status.org: readOrg), else null
//   boardData(collected, input)               -> render.ts collect()'s answer plus timeline and weekly (BOARD_FIELDS)
//
// collect() stays the port of the Python client (its parity tests); the page's data slot is BOARD_FIELDS.
import { localDay } from './counters'
import { DATA_FIELDS } from './render'
import { COMMAND, COUNTED, fixed, shortDay } from './status'
import { plusDays, pyRound, pySum } from './pyfmt'

export const BOARD_FIELDS = [...DATA_FIELDS, 'timeline', 'weekly'] as const // the page's data slot
export const TIMELINE_MAX = 12 // items shown, newest first
export const OUTBOX_FILES_MAX = 60 // outbox files read per render (one per session and UTC day)
export const WEEK_DAYS = 7
// kind -> [one, many]: what the item says; a count above one uses the second form, {n} the count
export const PHRASES: Record<string, [string, string]> = {
  cheaper: ['Sent a job to a cheaper model', 'Sent {n} jobs to a cheaper model'],
  model: ['Picked the right model for a job', 'Picked the right model for {n} jobs'],
  cleanup: ['Suggested a memory cleanup at a good moment', 'Suggested {n} memory cleanups at good moments'],
  tips: ['Loaded up-to-date working tips', 'Loaded up-to-date working tips {n} times'],
  upload: ["Sent the day's usage numbers (counts only, never your work)", "Sent the day's usage numbers {n} times (counts only, never your work)"],
  board: ['Updated this board', 'Updated this board {n} times'],
}
// where most of a week's savings came from (savings by_day `<lever>_usd`)
export const LEVER_WORDS: Record<string, string> = {
  route: 'sending jobs to cheaper models',
  compact: 'memory cleanups',
  index: 'looking up files instead of reading them whole',
}
export const ADMIN_LINE = 'Your company admin can see your savings figure.'
export const OFF_LINE = `Turn on the savings record to see a weekly summary: ${COMMAND} sharing on`
export const WAIT_LINE = 'Your weekly summary appears after your first full day of measured savings.'

type Obj = Record<string, any>
export type TimelineItem = { at: string; kind: string; count: number; text: string }
export type Timeline = { items: TimelineItem[]; counts: Record<string, number>; summary: string | null }
export type OutboxReadFs = {
  read(path: string): Promise<string>
  list?(path: string): Promise<readonly { name: string; size?: number; dir?: boolean }[]>
}

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
export const money = (v: number): string => `$${fixed(Math.abs(v), 2, true)}`
const parse = (text: unknown): Obj | null => {
  if (typeof text !== 'string' || !text) return null
  try {
    const o = JSON.parse(text)
    return isObj(o) ? o : null
  } catch {
    return null
  }
}

/** The local day of an outbox line's ts (ISO with Z), as counters.ts localDay files the day counters. */
export function lineDay(line: unknown): string | null {
  if (!isObj(line) || typeof line.ts !== 'string') return null
  const ms = Date.parse(line.ts)
  return Number.isFinite(ms) ? localDay(ms) : null
}

/** What one outbox line did for the customer (a PHRASES kind), or null for lines that are not worth a line. */
export function kindOf(line: unknown): string | null {
  if (!isObj(line)) return null
  if (line.kind === 'artifact_publish') return line.outcome === 'published' ? 'board' : null
  if (line.kind !== undefined || line.preview === true || line.status !== 200) return null
  const route = typeof line.route === 'string' ? line.route : ''
  const ans = parse(line.response_text)
  if (route === '/router/decide' && ans && ans.decision === 'route') {
    return ans.model === 'haiku' || ans.model === 'sonnet' ? 'cheaper' : 'model'
  }
  if (route === '/checkpoint/timing') return ans && ans.now === true ? 'cleanup' : null
  if (route === '/served/fetch') return 'tips'
  if (route === '/metrics/daily' && line.method === 'POST') return 'upload'
  return null
}

const phrase = (kind: string, n: number): string => {
  const [one, many] = PHRASES[kind]
  return n === 1 ? one : many.replace('{n}', String(n))
}

/** "So far today: 3 jobs on a cheaper model, 1 memory cleanup." in the status line's words, or null. */
export function todaySummary(counts: unknown): string | null {
  const c = isObj(counts) ? counts : {}
  const parts = COUNTED.filter(([k]) => (num(c[k]) ?? 0) > 0).map(([k, one, many]) => `${c[k]} ${c[k] === 1 ? one : many}`)
  return parts.length ? `So far today: ${parts.join(', ')}.` : null
}

/**
 * Today's timeline: the outbox lines of `today` (local day) folded into one item per kind and clock hour (the
 * newest time of the group), newest first, at most TIMELINE_MAX; counts are the status line's (countsOf).
 */
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
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.kind < b.kind ? -1 : 1))
    .slice(0, TIMELINE_MAX)
    .map((it) => ({ ...it, text: phrase(it.kind, it.count) }))
  const c: Record<string, number> = {}
  if (isObj(counts)) for (const [k] of COUNTED) if ((num(counts[k]) ?? 0) > 0) c[k] = counts[k]
  return { items, counts: c, summary: todaySummary(c) }
}

function peerPct(report: unknown): number | null {
  if (!isObj(report) || !Array.isArray(report.lines)) return null
  for (const line of report.lines) {
    if (isObj(line) && line.id === 'peer_saved' && isObj(line.values)) return num(line.values.peer_pct)
  }
  return null
}

export type WeeklyOpts = { metricsOn?: boolean | null; inOrg?: boolean | null }

/**
 * The last WEEK_DAYS days (today included) against the WEEK_DAYS before, from the savings body's by_day rows (the
 * board's comparison uses the same window), the share saved, the best day, the lever most of it came from, the
 * peer figure of GET /report, and the plain lines that say it. inOrg true adds ADMIN_LINE.
 */
export function weeklyOf(savings: unknown, report: unknown, today: string, opts: WeeklyOpts = {}): Obj {
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
    peer_pct: peerPct(report),
    admin_sees: opts.inOrg === true ? true : null,
    lines: [] as string[],
  }
  const s = isObj(savings) && !('error' in savings) ? savings : null
  const rows = s && Array.isArray(s.by_day) ? s.by_day.filter((r: unknown) => isObj(r) && typeof r.day === 'string') : []
  const cut1 = plusDays(today, -(WEEK_DAYS - 1))
  const cut2 = plusDays(today, -(2 * WEEK_DAYS - 1))
  const week = rows.filter((r: Obj) => cut1 <= r.day && r.day <= today)
  const before = rows.filter((r: Obj) => cut2 <= r.day && r.day < cut1)
  if (s && num(s.usd) !== null) {
    out.total_usd = num(s.usd)
    out.since = typeof s.first_day === 'string' ? s.first_day : null
    out.your_pct = num(s.pct)
  }
  if (week.length) {
    out.this_week_usd = pyRound(pySum(week.map((r: Obj) => num(r.usd) ?? 0)), 6)
    out.days_saved = week.filter((r: Obj) => (num(r.usd) ?? 0) >= 0.005).length
    const best = week.reduce((a: Obj | null, r: Obj) => ((num(r.usd) ?? 0) > (a ? num(a.usd) ?? 0 : 0) ? r : a), null)
    if (best && (num(best.usd) ?? 0) >= 0.005) out.best_day = { day: best.day, usd: num(best.usd) }
    let top: [string, number] | null = null
    for (const name of Object.keys(LEVER_WORDS)) {
      const v = pySum(week.map((r: Obj) => num(r[`${name}_usd`]) ?? 0))
      if (v >= 0.005 && (top === null || v > top[1])) top = [name, v]
    }
    out.top_lever = top ? top[0] : null
  }
  if (before.length) out.last_week_usd = pyRound(pySum(before.map((r: Obj) => num(r.usd) ?? 0)), 6)
  if (out.this_week_usd !== null && out.last_week_usd !== null) out.change_usd = pyRound(out.this_week_usd - out.last_week_usd, 6)
  out.lines = weeklyLines(out, opts.metricsOn)
  return out
}

/** The plain lines of a weekly part (the board shows them; the band can take the first). */
export function weeklyLines(w: Obj, metricsOn?: boolean | null): string[] {
  const lines: string[] = []
  const usd = num(w.this_week_usd)
  if (metricsOn === false && usd === null) lines.push(OFF_LINE)
  else if (usd === null) lines.push(WAIT_LINE)
  else {
    if (usd >= 0.005) lines.push(`In the last ${WEEK_DAYS} days agent-services saved you ${money(usd)}.`)
    else if (usd <= -0.005) lines.push(`In the last ${WEEK_DAYS} days memory cleanups cost ${money(usd)} more than they saved.`)
    else lines.push(`Nothing was saved in the last ${WEEK_DAYS} days.`)
    const ch = num(w.change_usd)
    if (ch !== null && Math.abs(ch) >= 0.005) lines.push(`That is ${money(ch)} ${ch > 0 ? 'more' : 'less'} than the ${WEEK_DAYS} days before.`)
    const best = isObj(w.best_day) ? w.best_day : null
    const bestDay = best ? shortDay(best.day) : null
    if (best && bestDay && (num(w.days_saved) ?? 0) > 1) lines.push(`Your best day was ${bestDay}: ${money(best.usd)}.`)
    if (typeof w.top_lever === 'string' && LEVER_WORDS[w.top_lever]) lines.push(`Most of it came from ${LEVER_WORDS[w.top_lever]}.`)
  }
  const peer = num(w.peer_pct)
  const yours = num(w.your_pct)
  if (peer !== null && yours !== null) {
    lines.push(`You save ${Math.round(yours * 100)}% of your usage cost; similar users save about ${Math.round(peer)}%.`)
  }
  if (w.admin_sees === true) lines.push(ADMIN_LINE)
  return lines
}

/**
 * Hook point for org membership (an employee's own board says that the company admin
 * sees their savings figure). wiring.ts dashboardData passes `org` = org.ts readOrg (the hello answer's org, kept
 * under KEYS.org): an object for any savings choice ("each" included) answers true; null (no org) answers
 * null and the line stays off. A non-empty `org_id` also answers true.
 */
export function inOrg(status: unknown): boolean | null {
  if (!isObj(status)) return null
  if (status.org === true || isObj(status.org)) return true
  if (typeof status.org_id === 'string' && status.org_id) return true
  return null
}

/**
 * Today's outbox lines (objects) of every session: the files of the UTC days around the local day (an outbox file
 * is named by UTC day), the newest OUTBOX_FILES_MAX of them, filtered to lines of the local day. Never throws.
 */
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
  outboxLines?: unknown[] | null // today's outbox lines (readOutboxDay)
  todayCounts?: Record<string, number> | null // the status line's counts (day_counts.ts countsOf of today)
  savings?: unknown // the GET /metrics/savings body collect() took
  report?: unknown // the GET /report body collect() took
  status?: unknown // the account facts collect() took (inOrg reads them)
}

const safe = <T>(f: () => T): T | null => {
  try {
    return f()
  } catch {
    return null
  }
}

/** collect()'s answer with timeline and weekly added (exactly BOARD_FIELDS); a part that fails is null. */
export function boardData(collected: Obj, input: BoardInput): Obj {
  const today = typeof collected?.today === 'string' ? collected.today : localDay(Date.now())
  const metricsOn = typeof collected?.metrics_on === 'boolean' ? collected.metrics_on : null
  return {
    ...collected,
    timeline: safe(() => timelineOf(input.outboxLines, input.todayCounts, today)),
    weekly: safe(() => weeklyOf(input.savings, input.report, today, { metricsOn, inOrg: inOrg(input.status) })),
  }
}
