// Transcript facts (moved from metrics.ts unchanged): the usage module's prices and usage
// counts, the transcript walk order and entry collection, the dispatch type words and scan(), the facts the
// daily body and the estimate are built from. Nothing here touches the engine: files and prices are passed in.
import { utf8 } from './e2e'
import { cmp, cmpTuple, isObj, localDay, localMonth, parseIso, pyLen, pyRound, pySum } from './pyfmt'

export const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'] as const
export const DISPATCH_TOOLS = ['Agent', 'Task']
export const SUBAGENT_TYPES = ['general-purpose', 'Explore', 'Plan', 'claude', 'fork', 'statusline-setup', 'claude-code-guide']
export const MODEL_WORDS = ['haiku', 'sonnet', 'opus', 'fable', 'inherit']
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
// the diagnostic tool's TYPE_WORDS, in order; the escaped words are the Chinese type words the user's
// dispatches use (review x4, replan, plan x2, acceptance, default, implement, fix, test, research, search, lookup,
// write, refactor, debug, docs, build, deploy, check, analyze).
export const TYPE_WORDS = [
  '\u5ba1\u67e5', '\u8bc4\u5ba1', '\u590d\u5ba1', '\u5ba1\u9605', '\u91cd\u65b0\u89c4\u5212', '\u89c4\u5212',
  '\u8ba1\u5212', '\u9a8c\u6536', '\u9ed8\u8ba4', '\u5b9e\u73b0', '\u4fee\u590d', '\u6d4b\u8bd5',
  '\u8c03\u7814', '\u641c\u7d22', '\u67e5', '\u5199', '\u91cd\u6784', '\u8c03\u8bd5',
  '\u6587\u6863', '\u6784\u5efa', '\u90e8\u7f72', '\u68c0\u67e5', '\u5206\u6790',
  're-review', 'lookup',
  'review', 'code-review', 'plan', 'replan', 'acceptance', 'default', 'implement', 'fix', 'test', 'research',
  'search', 'explore', 'write', 'refactor', 'debug', 'docs', 'build', 'deploy', 'check', 'analyze', 'investigate',
  'find', 'verify',
]
const BY_LENGTH = [...TYPE_WORDS].sort((a, b) => b.length - a.length) // stable, like Python's sorted
const MODEL_ID = /^claude-[a-z0-9.-]{1,60}\n?$/ // re.match with $ also takes a trailing newline

type Obj = Record<string, any>
export type Prices = Obj
export type Counts = { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }
export type TranscriptFile = { rel: string; size?: number; text: string | null }
export type Entry = { model: string; moment: number; isFast: boolean; counts: Counts; file: string }

// ------------------------------------------------------------------ prices (the usage module)

export const bare = (model: string): string => {
  const at = model.indexOf('claude-')
  const name = at >= 0 ? model.slice(at) : model
  const cut = name.indexOf('[')
  return cut >= 0 ? name.slice(0, cut) : name
}

export const matches = (name: string, prefix: string): boolean => {
  if (name === prefix) return true
  if (!name.startsWith(prefix)) return false
  const rest = name.slice(prefix.length)
  return !/^\p{Nd}/u.test(rest) && !/^-\p{Nd}{1,2}(?!\p{Nd})/u.test(rest)
}

export function priceOf(model: string, prompt: number, prices: Prices): Counts | null {
  const name = bare(model || '')
  for (const row of prices.models ?? []) {
    if (matches(name, row.prefix)) {
      let [inp, out, read] = [row.input, row.output, row.cache_read]
      for (const tier of prices.long_prompt ?? []) {
        if (matches(name, tier.prefix) && prompt > tier.over) {
          ;[inp, out, read] = [tier.input, tier.output, tier.cache_read]
        }
      }
      return {
        input: inp,
        output: out,
        cacheRead: read,
        cacheWrite5m: inp * (prices.cache_write_5m ?? 1.25),
        cacheWrite1h: inp * (prices.cache_write_1h ?? 2.0),
      }
    }
  }
  return null
}

export const promptOf = (c: Counts): number => c.input + c.cacheRead + c.cacheWrite5m + c.cacheWrite1h

/** The dollars of one response (the sum over the five fields), or null when the model has no price. */
export function costOf(entry: { model: string; isFast?: boolean; counts: Counts }, prices: Prices): number | null {
  const price = priceOf(entry.model, promptOf(entry.counts), prices)
  if (price === null) return null
  const rate = entry.isFast ? (prices.fast?.multiplier ?? 2.0) : 1.0
  return pySum(FIELDS.map((f) => ((entry.counts[f] * price[f]) / 1e6) * rate))
}

export function usageOf(u: Obj): Counts {
  const created = u.cache_creation || {}
  const total = u.cache_creation_input_tokens || 0
  const w1h = created.ephemeral_1h_input_tokens || 0
  let w5m = created.ephemeral_5m_input_tokens
  if (w5m === undefined || w5m === null) w5m = Math.max(0, total - w1h)
  return {
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheWrite5m: w5m,
    cacheWrite1h: w1h,
  }
}

// ------------------------------------------------------------------ transcripts

const lines = (text: string): string[] => text.split('\n')
export const parseLine = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** The order os.walk gives on a sorted listing: a folder's files first, then its subfolders, each by name. */
export function walkOrder<T extends { rel: string }>(files: T[]): T[] {
  const key = (rel: string) => rel.split(/[\\/]/)
  return [...files].sort((a, b) => {
    const x = key(a.rel)
    const y = key(b.rel)
    for (let i = 0; ; i++) {
      const xf = i === x.length - 1
      const yf = i === y.length - 1
      if (x[i] === y[i] && !xf && !yf) continue
      if (xf !== yf) return xf ? -1 : 1
      return cmp(x[i], y[i])
    }
  })
}

/** facts.py _place: (project, session id, is subagent) of one transcript path relative to the projects root. */
export function place(rel: string): [string, string, boolean] {
  const parts = rel.split(/[\\/]/)
  const project = parts.length > 1 ? parts[0] : ''
  const at = parts.slice(0, -1).indexOf('subagents')
  if (at >= 0) return [project, at >= 1 ? parts[at - 1] : '', true]
  return [project, parts[parts.length - 1].slice(0, -'.jsonl'.length), false]
}

/** modules/usage collect(): one entry per (message.id, requestId), each token field the maximum over its rows. */
export function collect(files: TranscriptFile[]): Map<string, Entry> {
  const seen = new Map<string, Entry>()
  for (const file of files) collectInto(seen, file)
  return seen
}

/** collect() of one more file into `seen` (the files in order give collect()'s map). */
function collectInto(seen: Map<string, Entry>, file: TranscriptFile): void {
  if (typeof file.text !== 'string') return
  for (const raw of lines(file.text)) {
    if (!raw.includes('"usage"') || !raw.includes('"assistant"')) continue
    const row = parseLine(raw)
    if (!isObj(row) || row.type !== 'assistant') continue
    const message = isObj(row.message) ? row.message : {}
    const usage = message.usage
    const model = typeof message.model === 'string' ? message.model : ''
    const stamp = row.timestamp
    if (!isObj(usage) || !stamp || model.startsWith('<')) continue
    const moment = parseIso(stamp, 'local')
    if (moment === null) continue
    const key = JSON.stringify([message.id ?? null, row.requestId ?? null])
    const counts = usageOf(usage)
    const held = seen.get(key)
    if (!held) {
      seen.set(key, { model, moment, isFast: usage.speed === 'fast', counts, file: file.rel })
    } else {
      for (const f of FIELDS) held.counts[f] = Math.max(held.counts[f], counts[f])
    }
  }
}

export const normModel = (model: unknown): string => {
  const name = typeof model === 'string' ? bare(model) : ''
  return MODEL_ID.test(name) ? name : 'other'
}

export function typeWord(description: unknown): string {
  const text = typeof description === 'string' ? description.trim().toLowerCase() : ''
  for (const word of BY_LENGTH) {
    if (!text.startsWith(word)) continue
    if (/^[\x00-\x7f]*$/.test(word)) {
      const rest = text.slice(word.length)
      if (rest && (/^[\p{L}\p{N}]/u.test(rest) || rest[0] === '-' || rest[0] === '_')) continue
    }
    return word
  }
  return 'other'
}

const subagentType = (v: unknown): string =>
  v === undefined || v === null || v === '' ? 'general-purpose' : SUBAGENT_TYPES.includes(v as string) ? (v as string) : 'custom'

const requestedModel = (v: unknown): string => {
  if (v === undefined || v === null || v === '') return 'none'
  if (MODEL_WORDS.includes(v as string)) return v as string
  if (typeof v === 'string' && v.startsWith('claude-')) {
    const name = normModel(v)
    if (name !== 'other') return name
  }
  return 'other'
}

const effortOf = (v: unknown): string =>
  v === undefined || v === null || v === '' ? 'none' : EFFORTS.includes(v as string) ? (v as string) : 'other'

export type ModelBucket = {
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  tokens: number
  api_usd: number
  responses: number
  main_responses: number
  subagent_responses: number
}
export type DayFacts = {
  by_model: Record<string, ModelBucket>
  dispatches_by_type: Record<string, number>
  dispatches_by_model: Record<string, number>
  compactions: number
  compactions_manual: number
  compactions_auto: number
}
export type Dispatch = {
  session_id: string
  project: string
  day: string
  type_word: string
  subagent_type: string
  requested_model: string
  requested_effort: string
  desc_len: number
  dispatch_no: number
}
export type SessionRow = { session_id: string; project: string; month: string | null; minutes: number; responses: number }
export type UnreadFile = { rel: string; size: number; subagent: boolean }
export type Facts = {
  transcripts: number
  first_day: string | null
  last_day: string | null
  by_day: Record<string, DayFacts>
  compactions: { total: number; manual: number; auto: number }
  sessions: { count: number; rows: SessionRow[] }
  dispatches: Dispatch[]
  main_days: Record<string, string[]> // local day -> main session ids with a response that day
  unpriced: string[]
  read: { files: number; bytes: number; main_bytes: number; subagent_bytes: number }
  unread: UnreadFile[]
  time_by_day: Record<string, TimeDay> // local day -> typed bytes, turns, agent clock time and summed agent time
  full_days?: Record<string, Record<string, number>> // the owner tool's complete per-day figures (wiring.ts facts)
}
// agent_seconds: clock time with at least one agent active (the union of every transcript's active intervals);
// agent_sum_seconds: every transcript's active time added up (sessions and subagents each counted)
export type TimeDay = { typed_bytes: number; agent_seconds: number; agent_sum_seconds: number; turns: number }
export type Interval = [number, number] // ms

// ------------------------------------------------------------------ time: typed bytes and agent time

// Two events of one transcript at most this far apart belong to one active interval; a longer gap is idle.
export const IDLE_GAP_MS = 10 * 60 * 1000

/** A user row's text: the string content, or its text blocks joined; null for a tool result. */
function contentText(row: Obj): string | null {
  const c = isObj(row.message) ? row.message.content : null
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  if (c.some((b) => isObj(b) && b.type === 'tool_result')) return null
  return c.filter((b) => isObj(b) && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
}

/** Text the system wrote into a user row (command output, an interrupt, a compaction summary, a notification). */
const systemText = (s: string): boolean =>
  /^(<local-command-|<bash-stdout>|<bash-stderr>|<task-notification>|\[Request interrupted|This session is being continued)/.test(s)

/**
 * The UTF-8 bytes a person typed in a prompt's text: a slash command counts as its name and arguments; system
 * reminders and pasted blocks are left out. Null when nothing of it was typed.
 */
export function typedBytes(text: string | null): number | null {
  if (text === null) return null
  let s = text.trim()
  if (!s || systemText(s)) return null
  const cmd = /<command-name>([\s\S]*?)<\/command-name>/.exec(s)
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(s)
    s = `${cmd[1].trim()} ${args ? args[1].trim() : ''}`
  } else {
    s = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content>/g, '')
  }
  s = s.trim()
  return s ? utf8(s).length : null
}

const plainUser = (row: Obj): boolean =>
  row.type === 'user' && row.isSidechain !== true && row.isMeta !== true && row.isCompactSummary !== true &&
  row.isVisibleInTranscriptOnly !== true

/**
 * A row that starts a turn: the bytes the person typed (0 when nobody typed it: a notification, a plugin's or a
 * peer's prompt), or null for any other row. `marked`: the file is in the current format, where the engine marks a
 * turn's first row (turnPosition) and says who wrote it (origin kind human, prompt source typed); in older files a
 * plain user row with typed text, or a task notification, starts a turn.
 */
export function turnStart(row: Obj, marked: boolean): number | null {
  if (!plainUser(row)) return null
  if (marked) {
    if (!isObj(row.turnPosition)) return null
    const human = (isObj(row.origin) && row.origin.kind === 'human') || row.promptSource === 'typed'
    return human ? typedBytes(contentText(row)) ?? 0 : 0
  }
  const text = contentText(row)
  if (text !== null && text.trim().startsWith('<task-notification>')) return 0
  return typedBytes(text)
}

/** A row that counts as activity: every timestamped row of a transcript but a sidechain copy, a queue record and the
 * summary written when the person comes back (written after an idle spell, it would join it to the last turn). */
function turnEvent(row: Obj): boolean {
  return row.isSidechain !== true && row.type !== 'queue-operation' && !(row.type === 'system' && row.subtype === 'away_summary')
}

/** One transcript's event times (ms) as active intervals: consecutive events at most IDLE_GAP_MS apart. */
export function intervalsOf(times: number[]): Interval[] {
  const at = [...times].sort((a, b) => a - b)
  const out: Interval[] = []
  for (const v of at) {
    const last = out[out.length - 1]
    if (last && v - last[1] <= IDLE_GAP_MS) last[1] = v
    else out.push([v, v])
  }
  return out.filter(([s, e]) => e > s)
}

/** Intervals cut at local midnights, grouped by local day (ms). */
function byLocalDay(intervals: Interval[]): Record<string, Interval[]> {
  const out: Record<string, Interval[]> = {}
  for (const [s0, e] of intervals) {
    let s = s0
    while (s < e) {
      const d = new Date(s)
      const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
      const end = Math.min(e, midnight)
      ;(out[localDay(s * 1000)] ??= []).push([s, end])
      s = end
    }
  }
  return out
}

/** The union length (ms) of intervals: overlapping time counts once. */
export function unionMs(intervals: Interval[]): number {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0])
  let total = 0
  let start = -Infinity
  let end = -Infinity
  for (const [s, e] of sorted) {
    if (s > end) {
      if (end > start) total += end - start
      start = s
      end = e
    } else if (e > end) end = e
  }
  if (end > start) total += end - start
  return total
}

/**
 * The time figures per local day from the typed bytes and turns per day and every transcript's active intervals:
 * agent_seconds the union (clock time with at least one agent active), agent_sum_seconds the plain sum.
 */
export function timeDays(typed: Record<string, { bytes: number; turns: number }>, intervals: Interval[]): Record<string, TimeDay> {
  const days = byLocalDay(intervals)
  const out: Record<string, TimeDay> = {}
  for (const day of [...new Set([...Object.keys(typed), ...Object.keys(days)])].sort()) {
    const list = days[day] ?? []
    out[day] = {
      typed_bytes: typed[day]?.bytes ?? 0,
      agent_seconds: Math.round(unionMs(list) / 1000),
      agent_sum_seconds: Math.round(list.reduce((n, [s, e]) => n + (e - s), 0) / 1000),
      turns: typed[day]?.turns ?? 0,
    }
  }
  return out
}

const newDay = (): DayFacts => ({
  by_model: {},
  dispatches_by_type: {},
  dispatches_by_model: {},
  compactions: 0,
  compactions_manual: 0,
  compactions_auto: 0,
})

const sizeOf = (f: TranscriptFile): number =>
  typeof f.size === 'number' && f.size >= 0 ? f.size : typeof f.text === 'string' ? utf8(f.text).length : 0

/** the diagnostic tool's scan() for the parts the daily and estimate bodies use. */
export function scan(files: TranscriptFile[], prices: Prices): Facts {
  const s = new Scanner(prices)
  for (const f of files) s.add(f)
  return s.finish()
}

type RawDispatch = { moment: number; rel: string; order: number; project: string; session: string; block: Obj }

/**
 * scan() one file at a time, so a caller under a hook's time budget can spread it over several runs and drop each
 * text once it is added: add() the files in the order scan() would get them, then finish(). The facts are those of
 * scan() over the same files (the same entry and dispatch de-duplication, in the same order).
 */
export class Scanner {
  private readonly prices: Prices
  private files = 0
  private readonly unread: UnreadFile[] = []
  private readonly seen = new Map<string, Entry>()
  private readonly byDay: Record<string, DayFacts> = {}
  private readonly compactions = { total: 0, manual: 0, auto: 0 }
  private readonly sessionRows = new Map<string, SessionRow>()
  private readonly raw: RawDispatch[] = []
  private readonly seenBlocks = new Set<string>()
  private readonly read = { files: 0, bytes: 0, main_bytes: 0, subagent_bytes: 0 }
  private readonly turnsSeen = new Set<string>()
  private readonly time: Record<string, { bytes: number; turns: number }> = {}
  private readonly intervals: Interval[] = [] // every transcript's active intervals (ms)

  constructor(prices: Prices) {
    this.prices = prices
  }

  private dayOf(day: string): DayFacts {
    return (this.byDay[day] ??= newDay())
  }

  /** One more transcript file; its text is not kept. */
  add(file: TranscriptFile): void {
    this.files += 1
    if (typeof file.text !== 'string') {
      this.unread.push({ rel: file.rel, size: sizeOf(file), subagent: place(file.rel)[2] })
      return
    }
    collectInto(this.seen, file)
    const [project, session, isSub] = place(file.rel)
    const key = JSON.stringify([project, session])
    const size = sizeOf(file)
    this.read.files += 1
    this.read.bytes += size
    if (isSub) this.read.subagent_bytes += size
    else this.read.main_bytes += size
    const moments: number[] = []
    const comps: [number | null, unknown][] = []
    const disp: [number | null, number, Obj][] = []
    if (isSub) this.subIntervals(file.text)
    const marked = !isSub && file.text.includes('"turnPosition"')
    let turn: { skip: boolean } | null = null
    const active: number[] = [] // this main transcript's event times (ms)
    lines(file.text).forEach((line, order) => {
      if (isSub && !line.includes('compact_boundary') && !line.includes('tool_use')) return
      const row = parseLine(line)
      if (!isObj(row)) return
      const moment = typeof row.timestamp === 'string' && row.timestamp ? parseIso(row.timestamp, 'local') : null
      if (moment !== null && !isSub) {
        moments.push(moment)
        const typed = turnStart(row, marked)
        if (typed !== null) {
          const tp = isObj(row.turnPosition) ? row.turnPosition.turnIndex : undefined
          const key = marked && tp !== undefined ? `${row.sessionId}:${tp}` : typeof row.uuid === 'string' ? row.uuid : `${file.rel}:${order}`
          if (this.turnsSeen.has(key)) {
            if (!turn || turn.skip) turn = { skip: true } // a copied turn (a resumed session): counted once
          } else {
            this.turnsSeen.add(key)
            turn = { skip: false }
            const d = (this.time[localDay(moment)] ??= { bytes: 0, turns: 0 })
            d.bytes += typed
            d.turns += 1
            active.push(moment / 1000)
          }
        } else if (!turn?.skip && turnEvent(row)) active.push(moment / 1000)
      }
      if (row.type === 'system' && row.subtype === 'compact_boundary') {
        const meta = row.compactMetadata
        comps.push([moment, isObj(meta) ? meta.trigger : null])
      }
      if (row.type === 'assistant') {
        const content = isObj(row.message) ? row.message.content : null
        if (Array.isArray(content)) {
          for (const block of content) {
            if (isObj(block) && block.type === 'tool_use' && DISPATCH_TOOLS.includes(block.name)) disp.push([moment, order, block])
          }
        }
      }
    })
    if (active.length) this.intervals.push(...intervalsOf(active))
    if (!isSub) {
      let first: number | null = null
      let last: number | null = null
      for (const m of moments) {
        if (first === null || m < first) first = m
        if (last === null || m > last) last = m
      }
      let minutes = 0
      if (moments.length >= 2) minutes = pyRound(((last as number) - (first as number)) / 1e6 / 60, 1)
      // responses are counted in finish(), once every file's entries are in
      this.sessionRows.set(key, { session_id: session, project, month: first !== null ? localMonth(first) : null, minutes, responses: 0 })
    }
    for (const [moment, trigger] of comps) {
      this.compactions.total += 1
      const kind = trigger === 'manual' || trigger === 'auto' ? trigger : null
      if (kind) this.compactions[kind] += 1
      if (moment !== null) {
        const daily = this.dayOf(localDay(moment))
        daily.compactions += 1
        if (kind === 'manual') daily.compactions_manual += 1
        if (kind === 'auto') daily.compactions_auto += 1
      }
    }
    for (const [moment, order, block] of disp) {
      if (block.id !== undefined && block.id !== null) {
        const id = JSON.stringify(block.id)
        if (this.seenBlocks.has(id)) continue
        this.seenBlocks.add(id)
      }
      if (moment === null) continue
      this.raw.push({ moment, rel: file.rel, order, project, session, block })
    }
  }

  /** A subagent transcript's active intervals: all its timestamps (IDLE_GAP_MS rule). */
  private subIntervals(text: string): void {
    const at: number[] = []
    for (const m of text.matchAll(/"timestamp":\s*"([^"]+)"/g)) {
      const v = parseIso(m[1], 'local')
      if (v !== null) at.push(v / 1000)
    }
    this.intervals.push(...intervalsOf(at))
  }

  /** Figures of transcripts read elsewhere (the over-4-MiB scan): typed bytes and turns per day, and intervals (ms). */
  addTime(days: Record<string, { typed_bytes?: number; turns?: number }>, intervals: Interval[]): void {
    for (const [day, d] of Object.entries(days)) {
      const held = (this.time[day] ??= { bytes: 0, turns: 0 })
      held.bytes += d.typed_bytes ?? 0
      held.turns += d.turns ?? 0
    }
    for (const iv of intervals) if (Array.isArray(iv) && iv[1] > iv[0]) this.intervals.push([iv[0], iv[1]])
  }

  /** The facts of every file added (call it once). */
  finish(): Facts {
    const unpriced = new Set<string>()
    const days: string[] = []
    const mainResponses = new Map<string, number>()
    const mainDays: Record<string, Set<string>> = {}
    for (const entry of this.seen.values()) {
      const model = normModel(entry.model)
      const c = entry.counts
      const tokens = c.input + c.cacheWrite5m + c.cacheWrite1h + c.output
      const cost = costOf(entry, this.prices)
      if (cost === null) unpriced.add(model)
      const usd = cost === null ? 0 : cost
      const [project, session, isSub] = place(entry.file)
      const day = localDay(entry.moment)
      days.push(day)
      const daily = (this.dayOf(day).by_model[model] ??= {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        tokens: 0,
        api_usd: 0,
        responses: 0,
        main_responses: 0,
        subagent_responses: 0,
      })
      daily.input_tokens += c.input
      daily.output_tokens += c.output
      daily.cache_read_tokens += c.cacheRead
      daily.cache_write_tokens += c.cacheWrite5m + c.cacheWrite1h
      daily.tokens += tokens
      daily.api_usd += usd
      daily.responses += 1
      if (isSub) {
        daily.subagent_responses += 1
      } else {
        daily.main_responses += 1
        const k = JSON.stringify([project, session])
        mainResponses.set(k, (mainResponses.get(k) ?? 0) + 1)
        ;(mainDays[day] ??= new Set()).add(session)
      }
    }
    for (const [k, row] of this.sessionRows) row.responses = mainResponses.get(k) ?? 0

    const rows = [...this.sessionRows.values()].sort((a, b) =>
      cmpTuple([a.month ?? '', a.project, a.session_id], [b.month ?? '', b.project, b.session_id]),
    )
    const raw = this.raw
    raw.sort((a, b) => cmpTuple([a.moment, a.rel, a.order], [b.moment, b.rel, b.order]))
    const dispatches: Dispatch[] = []
    const numbers = new Map<string, number>()
    for (const d of raw) {
      const data = isObj(d.block.input) ? d.block.input : {}
      const desc = data.description
      const k = JSON.stringify([d.project, d.session])
      numbers.set(k, (numbers.get(k) ?? 0) + 1)
      const row: Dispatch = {
        session_id: d.session,
        project: d.project,
        day: localDay(d.moment),
        type_word: typeWord(desc),
        subagent_type: subagentType(data.subagent_type),
        requested_model: requestedModel(data.model),
        requested_effort: effortOf(data.effort),
        desc_len: typeof desc === 'string' ? pyLen(desc) : 0,
        dispatch_no: numbers.get(k) as number,
      }
      dispatches.push(row)
      const daily = this.dayOf(row.day)
      daily.dispatches_by_type[row.type_word] = (daily.dispatches_by_type[row.type_word] ?? 0) + 1
      daily.dispatches_by_model[row.requested_model] = (daily.dispatches_by_model[row.requested_model] ?? 0) + 1
    }

    const sortedDays: Record<string, DayFacts> = {}
    for (const day of Object.keys(this.byDay).sort()) sortedDays[day] = this.byDay[day]
    const md: Record<string, string[]> = {}
    for (const day of Object.keys(mainDays).sort()) md[day] = [...mainDays[day]].sort()
    const sortedList = [...days].sort()
    return {
      transcripts: this.files,
      first_day: sortedList.length ? sortedList[0] : null,
      last_day: sortedList.length ? sortedList[sortedList.length - 1] : null,
      by_day: sortedDays,
      compactions: { ...this.compactions },
      sessions: { count: rows.length, rows },
      dispatches,
      main_days: md,
      unpriced: [...unpriced].sort(),
      read: { ...this.read },
      unread: [...this.unread],
      time_by_day: timeDays(this.time, this.intervals),
    }
  }
}
