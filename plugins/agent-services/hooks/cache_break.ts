import type { EngineInterface } from 'claude-code'
import { PRICES } from './prices'
import { relNum, relText } from './reliability'
import { priceOf } from './transcripts'

type Obj = Record<string, any>
type Ready = Promise<unknown> | undefined

const N = (k: string): number | undefined => relNum(`recover.${k}`)
const T = (k: string, vars?: Record<string, string | number>): string | undefined => relText(`recover.text.${k}`, vars)

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const word = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase().slice(0, 40) : '')
const mins = (ms: number): number => Math.max(0, Math.round(ms / 60_000))


export type StepUsage = { at: number; model: string; input: number; read: number; write: number; write1h?: number }
export type CacheBreak = { rebilled: number; expected: number; read: number; usd: number | null; causes: string[] }

const totalOf = (u: StepUsage): number => num(u.input) + num(u.read) + num(u.write)

export function cacheBreak(i: { prev: StepUsage | null; cur: StepUsage | null; longCache?: boolean; toolsChangedAt?: number | null; prices?: Obj }): CacheBreak | null {
  try {
    const { prev, cur } = i ?? ({} as any)
    const minTokens = N('CACHE_BREAK_MIN_TOKENS')
    const shrink = N('CACHE_BREAK_SHRINK')
    const share = N('CACHE_BREAK_READ_SHARE')
    if (!prev || !cur || minTokens === undefined || shrink === undefined || share === undefined) return null
    const before = totalOf(prev)
    const now = totalOf(cur)
    if (before < minTokens) return null
    if (now < before * shrink) return null
    const read = num(cur.read)
    if (read >= before * share) return null
    const expected = Math.min(before, now)
    const rebilled = Math.max(0, expected - read)
    if (rebilled < minTokens) return null
    let usd: number | null = null
    const price = priceOf(String(cur.model ?? ''), now, i.prices ?? PRICES)
    if (price) {
      const written = Math.min(rebilled, num(cur.write))
      const w1h = Math.min(written, num(cur.write1h))
      const paid = (written - w1h) * price.cacheWrite5m + w1h * price.cacheWrite1h + (rebilled - written) * price.input
      usd = Math.max(0, (paid - rebilled * price.cacheRead) / 1e6)
    }
    const causes: string[] = []
    const push = (s: string | undefined): void => {
      if (s !== undefined) causes.push(s)
    }
    if (word(prev.model) && word(cur.model) && word(prev.model) !== word(cur.model)) push(T('cache_cause_model', { from: word(prev.model), to: word(cur.model) }))
    const ttl = relNum(i.longCache ? 'resume.RESUME_LONG_CACHE_MS' : 'resume.RESUME_CACHE_MS')
    const gap = num(cur.at) - num(prev.at)
    if (ttl !== undefined && gap >= ttl) push(T('cache_cause_idle', { mins: mins(gap), ttl: mins(ttl) }))
    const t = i.toolsChangedAt
    if (typeof t === 'number' && t >= num(prev.at) && t <= num(cur.at)) push(T('cache_cause_tools'))
    return { rebilled, expected, read, usd, causes }
  } catch {
    return null
  }
}

export function cacheBreakText(b: CacheBreak): string | null {
  const k = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
  const cost = b.usd === null ? T('cache_cost_unknown') : T('cache_cost', { usd: b.usd < 0.01 ? b.usd.toFixed(3) : b.usd.toFixed(2) })
  const cause = b.causes.length ? b.causes.join('; ') : T('cache_cause_unknown')
  if (cost === undefined || cause === undefined) return null
  const body = T('cache_break', { read: k(b.read), expected: k(b.expected), rebilled: k(b.rebilled), cost, cause })
  return body === undefined ? null : `agent-services: ${body}`
}


type TurnRec = { first: StepUsage | null; last: StepUsage | null }
type CacheCounts = { cacheBreaks: number; rebilled: number; usd: number }

const zeroCounts = (): CacheCounts => ({ cacheBreaks: 0, rebilled: 0, usd: 0 })
let starts: Record<string, number> = {}
let turns: Record<string, TurnRec> = {}
let lastMain: StepUsage | null = null
let longCache = false
let toolNames: string[] = []
let toolsBaseline = false
let toolsChangedAt: number | null = null
let counts: CacheCounts = zeroCounts()

async function nowOf($: EngineInterface): Promise<number> {
  try {
    const n = Number(await $.clock.now())
    return Number.isFinite(n) ? n : Date.now()
  } catch {
    return Date.now()
  }
}

async function active(rt: Ready): Promise<boolean> {
  if (rt === undefined) return true
  try {
    const r = (await rt) as { svc?: { authState?: () => Promise<string> } } | null
    if (!r) return false
    return typeof r.svc?.authState === 'function' ? (await r.svc.authState()) === 'ok' : true
  } catch {
    return false
  }
}

function usageOf(u: unknown, at: number, model: string): StepUsage | null {
  if (!isObj(u)) return null
  const c = isObj(u.cache_creation) ? u.cache_creation : {}
  return {
    at, model: typeof u.model === 'string' && u.model ? u.model : model,
    input: num(u.input_tokens), read: num(u.cache_read_input_tokens), write: num(u.cache_creation_input_tokens),
    write1h: num(c.ephemeral_1h_input_tokens),
  }
}

function prune(): void {
  const keys = Object.keys(turns)
  for (const k of keys.slice(0, Math.max(0, keys.length - 5))) delete turns[k]
  const s = Object.keys(starts)
  for (const k of s.slice(0, Math.max(0, s.length - 50))) delete starts[k]
}

export function cacheStepStart(e: Obj, at?: number): void {
  try {
    if (!isObj(e) || typeof e.turnId !== 'string' || e.agentId) return
    starts[`${e.turnId}:${num(e.index)}`] = typeof at === 'number' ? at : Date.now()
    toolsBaseline = true
    prune()
  } catch {}
}

export function cacheStep(e: Obj, step: Obj, at?: number): void {
  try {
    if (!isObj(e) || typeof e.turnId !== 'string' || e.agentId) return
    const r = isObj(step) ? step : {}
    const rec = turns[e.turnId] ?? (turns[e.turnId] = { first: null, last: null })
    const started = starts[`${e.turnId}:${num(e.index)}`] ?? (typeof at === 'number' ? at : Date.now())
    const u = usageOf(r.usage, started, typeof e.model === 'string' ? e.model : '')
    if (u) {
      if (num(u.write1h) > 0) longCache = true
      if (num(e.index) === 0 && !rec.first) rec.first = u
      rec.last = u
    }
    prune()
  } catch {}
}

export function cacheToolDescribed(e: Obj, at?: number): void {
  try {
    if (!isObj(e) || typeof e.tool !== 'string' || e.isDeferred === true) return
    if (toolNames.includes(e.tool)) return
    toolNames = [...toolNames, e.tool].slice(-500)
    if (toolsBaseline) toolsChangedAt = typeof at === 'number' ? at : Date.now()
  } catch {}
}

export async function cacheTurnEnd($: EngineInterface, e: Obj, rt?: Ready): Promise<void> {
  try {
    if (!isObj(e) || (typeof e.agentId === 'string' && e.agentId) || !(await active(rt))) return
    const rec = typeof e.turnId === 'string' ? turns[e.turnId] : undefined
    if (!rec) return
    const b = cacheBreak({ prev: lastMain, cur: rec.first, longCache, toolsChangedAt })
    if (rec.last) lastMain = rec.last
    if (!b) return
    counts = { cacheBreaks: counts.cacheBreaks + 1, rebilled: counts.rebilled + b.rebilled, usd: counts.usd + (b.usd ?? 0) }
    const line = cacheBreakText(b)
    if (line) {
      try {
        void Promise.resolve($.ui.log(line)).catch(() => undefined)
      } catch {}
    }
  } catch {}
}

export function installCacheBreak(on: any): void {
  on('tool.describe', { tool: /^mcp__/ }, async ($: EngineInterface, e: Obj, next: any) => {
    const r = await next(e)
    cacheToolDescribed(e)
    return r
  }).catch(($: EngineInterface, e: Obj, next: any) => next(e))
}

export function cacheResetForTest(): void {
  starts = {}
  turns = {}
  lastMain = null
  longCache = false
  toolNames = []
  toolsBaseline = false
  toolsChangedAt = null
  counts = zeroCounts()
}

export function cacheStateForTest(): Obj {
  return { lastMain, longCache, toolsChangedAt, counts }
}
