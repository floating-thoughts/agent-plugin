// Daily metrics, harness-neutral: transcript parsing, the POST /metrics/daily body and its upload plan.
//
// A port of host/metrics.py (the body builder and the day selection of Metrics.tick), of the parts of
// the usage module parser it uses (collect, price_of, cost_of, usage_of, parse_iso) and of tools/diagnostic/facts.py
// scan(). Nothing here touches the engine: transcript files, the savings events, the salt, the prices and the
// clock are passed in, and nothing is sent or stored. Phase 2 wiring (P4, P2) reads the inputs and sends the text.
//
// Inputs of each entry point:
//   scan(files, prices)            files: TranscriptFile[] in walk order (walkOrder sorts), each { rel, size, text };
//                                  text null when the file is over READ_LIMIT (4 MiB) or unreadable: such a file is
//                                  left out of the facts and listed in facts.unread (estimate.ts scales it).
//                                  prices: the parsed modules/usage/prices.json.
//   readEvents(events)             the savings events (objects or JSON lines), as the Python event log holds them.
//   dailyBody(day, input)          { facts, events, salt (bytes), prices, kinds?, clientVersion? }; throws BodyTooLarge.
//   dailyRequest(day, input)       -> { method, route, body_text } or { error }: the exact text a send carries, so
//                                  a preview and the upload are the same string.
//   uploadDays(state, today, active)  the days Metrics.tick would build, in order (dueDays: with active()).
//   optIn(state, today)            the opt-in rule: only after a preview (consent comes from the user's command).
//
// Python parity limits (stated, tested where it matters): JSON numbers lose the int/float distinction, so a
// value Python keeps as 5.0 prints as 5 here (bodies are compared as parsed JSON); the 64 KiB size check counts
// this module's JSON text. Day boundaries use the process's local time zone, as the Python does.
import { sha256 } from './noble.js'
import { concat, hex, utf8 } from './e2e'

export const CLIENT_VERSION = '0.1.0'
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
export const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'] as const
export const DISPATCH_TOOLS = ['Agent', 'Task']
export const SUBAGENT_TYPES = ['general-purpose', 'Explore', 'Plan', 'claude', 'fork', 'statusline-setup', 'claude-code-guide']
export const MODEL_WORDS = ['haiku', 'sonnet', 'opus', 'fable', 'inherit']
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
// tools/diagnostic/facts.py TYPE_WORDS, in order; the escaped words are the Chinese type words the user's
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
const REF_RX = /^[0-9a-f]{16}\n?$/
const DAY_RX = /^\d{4}-\d{2}-\d{2}$/

type Obj = Record<string, any>
export type Prices = Obj
export type Counts = { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }
export type TranscriptFile = { rel: string; size?: number; text: string | null }
export type Entry = { model: string; moment: number; isFast: boolean; counts: Counts; file: string }

export class BodyTooLarge extends Error {}

// ------------------------------------------------------------------ Python-compatible helpers

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const cmp = (a: string | number, b: string | number): number => (a < b ? -1 : a > b ? 1 : 0)
export const cmpTuple = (a: (string | number | boolean)[], b: (string | number | boolean)[]): number => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = typeof a[i] === 'boolean' ? Number(a[i]) : (a[i] as string | number)
    const y = typeof b[i] === 'boolean' ? Number(b[i]) : (b[i] as string | number)
    const c = cmp(x, y)
    if (c) return c
  }
  return a.length - b.length
}

/** format(x, f".{n}f"): the exact binary value rounded half to even, as CPython does. */
export function pyFixed(x: number, n: number): string {
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : x < 0 ? '-inf' : 'nan'
  const neg = x < 0 || Object.is(x, -0)
  const ax = Math.abs(x)
  if (ax >= 1e21) return (neg ? '-' : '') + ax.toFixed(n)
  const full = ax.toFixed(100) // exact for every double of this size that matters here
  const dot = full.indexOf('.')
  const whole = full.slice(0, dot)
  const frac = full.slice(dot + 1)
  let digits = whole + frac.slice(0, n)
  const next = frac.charCodeAt(n) - 48
  const rest = frac.slice(n + 1)
  const last = digits.charCodeAt(digits.length - 1) - 48
  const up = next > 5 || (next === 5 && (/[1-9]/.test(rest) || last % 2 === 1))
  if (up) {
    const arr = digits.split('')
    let i = arr.length - 1
    while (i >= 0) {
      if (arr[i] === '9') {
        arr[i] = '0'
        i--
      } else {
        arr[i] = String.fromCharCode(arr[i].charCodeAt(0) + 1)
        break
      }
    }
    digits = (i < 0 ? '1' : '') + arr.join('')
  }
  const w = digits.slice(0, digits.length - n) || '0'
  const f = digits.slice(digits.length - n)
  return (neg ? '-' : '') + w + (n > 0 ? '.' + f : '')
}

/** sum() of floats as CPython 3.12+ adds them (Neumaier compensated summation). */
export function pySum(xs: Iterable<number>): number {
  let f = 0
  let c = 0
  for (const x of xs) {
    const t = f + x
    if (Math.abs(f) >= Math.abs(x)) c += f - t + x
    else c += x - t + f
    f = t
  }
  if (c && Number.isFinite(c)) f += c
  return f
}

/** round(x, n) for a float. */
export const pyRound = (x: number, n: number): number => (Number.isFinite(x) ? Number(pyFixed(x, n)) : x)

const pad = (v: number, w = 2): string => String(v).padStart(w, '0')
const ISO_RX =
  /^(\d{4})-?(\d{2})-?(\d{2})(?:.(\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d+))?)?)?(?:([+-])(\d{2})(?::?(\d{2})(?::?(\d{2})(?:\.(\d{1,6}))?)?)?)?)?$/s

/**
 * datetime.fromisoformat(text.replace("Z", "+00:00")) as epoch microseconds, or null when Python raises ValueError.
 * A naive time is taken as local (modules/usage parse_iso) or as UTC (host/dashboard.py _local_day).
 */
export function parseIso(text: unknown, naive: 'local' | 'utc' = 'local'): number | null {
  if (typeof text !== 'string') return null
  const m = ISO_RX.exec(text.replace(/Z/g, '+00:00'))
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const [h, mi, s] = [Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)]
  const micro = Number((m[7] ?? '').slice(0, 6).padEnd(6, '0'))
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return null
  const probe = new Date(Date.UTC(2000, mo - 1, d))
  probe.setUTCFullYear(y)
  if (probe.getUTCDate() !== d) return null
  let ms: number
  if (m[8]) {
    const oh = Number(m[9])
    const om = Number(m[10] ?? 0)
    const os = Number(m[11] ?? 0)
    if (oh > 23 || om > 59 || os > 59) return null
    const off = (m[8] === '-' ? -1 : 1) * ((oh * 3600 + om * 60 + os) * 1000)
    const t = new Date(Date.UTC(2000, mo - 1, d, h, mi, s))
    t.setUTCFullYear(y)
    ms = t.getTime() - off
    return ms * 1000 + micro - (m[8] === '-' ? -1 : 1) * Number((m[12] ?? '').padEnd(6, '0'))
  }
  if (naive === 'utc') {
    const t = new Date(Date.UTC(2000, mo - 1, d, h, mi, s))
    t.setUTCFullYear(y)
    ms = t.getTime()
  } else {
    const t = new Date(2000, mo - 1, d, h, mi, s)
    t.setFullYear(y)
    ms = t.getTime()
  }
  return ms * 1000 + micro
}

/** The local calendar day (YYYY-MM-DD) of epoch microseconds. */
export const localDay = (micro: number): string => {
  const t = new Date(Math.floor(micro / 1000))
  return `${pad(t.getFullYear(), 4)}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`
}
const localMonth = (micro: number): string => localDay(micro).slice(0, 7)

/** date.fromisoformat(day) + n days. */
export const plusDays = (day: string, n: number): string => {
  const t = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)) + n))
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}

/** HMAC-SHA256 (RFC 2104) on the vendored sha256. */
export function hmacSha256(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const k = key.length > 64 ? sha256(key) : key
  const block = new Uint8Array(64)
  block.set(k)
  const ipad = block.map((b) => b ^ 0x36)
  const opad = block.map((b) => b ^ 0x5c)
  return sha256(concat(opad, sha256(concat(ipad, msg))))
}

/** tools/diagnostic/payload.py ref(): a salted 16-hex reference. */
export const ref = (salt: Uint8Array, kind: string, value: string): string =>
  hex(hmacSha256(salt, utf8(`${kind}:${value}`))).slice(0, 16)

/** Python's len() of a string: code points. */
const pyLen = (s: string): number => [...s].length

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
const parseLine = (raw: string): unknown => {
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
  for (const file of files) {
    if (typeof file.text !== 'string') continue
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
  return seen
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

/** tools/diagnostic/facts.py scan() for the parts the daily and estimate bodies use. */
export function scan(files: TranscriptFile[], prices: Prices): Facts {
  const readable = files.filter((f) => typeof f.text === 'string')
  const unread: UnreadFile[] = files
    .filter((f) => typeof f.text !== 'string')
    .map((f) => ({ rel: f.rel, size: sizeOf(f), subagent: place(f.rel)[2] }))
  const seen = collect(readable)
  const byDay: Record<string, DayFacts> = {}
  const dayOf = (day: string) => (byDay[day] ??= newDay())
  const unpriced = new Set<string>()
  const days: string[] = []
  const mainResponses = new Map<string, number>()
  const mainDays: Record<string, Set<string>> = {}
  for (const entry of seen.values()) {
    const model = normModel(entry.model)
    const c = entry.counts
    const tokens = c.input + c.cacheWrite5m + c.cacheWrite1h + c.output
    const cost = costOf(entry, prices)
    if (cost === null) unpriced.add(model)
    const usd = cost === null ? 0 : cost
    const [project, session, isSub] = place(entry.file)
    const day = localDay(entry.moment)
    days.push(day)
    const daily = (dayOf(day).by_model[model] ??= {
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

  const compactions = { total: 0, manual: 0, auto: 0 }
  const sessionRows = new Map<string, SessionRow>()
  const raw: { moment: number; rel: string; order: number; project: string; session: string; block: Obj }[] = []
  const seenBlocks = new Set<string>()
  let readBytes = 0
  let mainBytes = 0
  let subBytes = 0
  for (const file of readable) {
    const [project, session, isSub] = place(file.rel)
    const key = JSON.stringify([project, session])
    const size = sizeOf(file)
    readBytes += size
    if (isSub) subBytes += size
    else mainBytes += size
    const moments: number[] = []
    const comps: [number | null, unknown][] = []
    const disp: [number | null, number, Obj][] = []
    lines(file.text as string).forEach((line, order) => {
      if (isSub && !line.includes('compact_boundary') && !line.includes('tool_use')) return
      const row = parseLine(line)
      if (!isObj(row)) return
      const moment = typeof row.timestamp === 'string' && row.timestamp ? parseIso(row.timestamp, 'local') : null
      if (moment !== null && !isSub) moments.push(moment)
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
    if (!isSub) {
      let first: number | null = null
      let last: number | null = null
      for (const m of moments) {
        if (first === null || m < first) first = m
        if (last === null || m > last) last = m
      }
      let minutes = 0
      if (moments.length >= 2) minutes = pyRound(((last as number) - (first as number)) / 1e6 / 60, 1)
      sessionRows.set(key, {
        session_id: session,
        project,
        month: first !== null ? localMonth(first) : null,
        minutes,
        responses: mainResponses.get(key) ?? 0,
      })
    }
    for (const [moment, trigger] of comps) {
      compactions.total += 1
      const kind = trigger === 'manual' || trigger === 'auto' ? trigger : null
      if (kind) compactions[kind] += 1
      if (moment !== null) {
        const daily = dayOf(localDay(moment))
        daily.compactions += 1
        if (kind === 'manual') daily.compactions_manual += 1
        if (kind === 'auto') daily.compactions_auto += 1
      }
    }
    for (const [moment, order, block] of disp) {
      if (block.id !== undefined && block.id !== null) {
        const id = JSON.stringify(block.id)
        if (seenBlocks.has(id)) continue
        seenBlocks.add(id)
      }
      if (moment === null) continue
      raw.push({ moment, rel: file.rel, order, project, session, block })
    }
  }

  const rows = [...sessionRows.values()].sort((a, b) =>
    cmpTuple([a.month ?? '', a.project, a.session_id], [b.month ?? '', b.project, b.session_id]),
  )
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
    const daily = dayOf(row.day)
    daily.dispatches_by_type[row.type_word] = (daily.dispatches_by_type[row.type_word] ?? 0) + 1
    daily.dispatches_by_model[row.requested_model] = (daily.dispatches_by_model[row.requested_model] ?? 0) + 1
  }

  const sortedDays: Record<string, DayFacts> = {}
  for (const day of Object.keys(byDay).sort()) sortedDays[day] = byDay[day]
  const md: Record<string, string[]> = {}
  for (const day of Object.keys(mainDays).sort()) md[day] = [...mainDays[day]].sort()
  const sortedList = [...days].sort()
  return {
    transcripts: files.length,
    first_day: sortedList.length ? sortedList[0] : null,
    last_day: sortedList.length ? sortedList[sortedList.length - 1] : null,
    by_day: sortedDays,
    compactions,
    sessions: { count: rows.length, rows },
    dispatches,
    main_days: md,
    unpriced: [...unpriced].sort(),
    read: { files: readable.length, bytes: readBytes, main_bytes: mainBytes, subagent_bytes: subBytes },
    unread,
  }
}

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

/** host/metrics.py read_events: the valid events with their local day, in order; bad ones skipped. */
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

/** host/metrics.py _long: whether a route turn of this (normalized) model and prompt size is a long-prompt one. */
export const isLong = (model: string, prompt: number, prices: Prices): boolean =>
  (prices.long_prompt ?? []).some((t: Obj) => matches(bare(model), t.prefix) && prompt > t.over)

/** host/metrics.py _counters: the raw savings counters of one day. */
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

/** The POST /metrics/daily body for one local day (host/metrics.py _Sources.body); throws BodyTooLarge. */
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
    client_version: input.clientVersion ?? CLIENT_VERSION,
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
