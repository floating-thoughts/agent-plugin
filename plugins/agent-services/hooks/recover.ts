import type { EngineInterface } from 'claude-code'
import { getJob } from './jobs'
import { PRICES } from './prices'
import { relNum, relText } from './reliability'
import { NOTE_PREFIX } from './review'
import { ROUTER_MODELS, routingLevel, routingModels } from './routing_level'
import { rulesLive, rulesTable } from './rules'
import { REACH_ALWAYS, reachNotify } from './reach'
import { continueVia } from './stall'
import { engineStore } from './store'
import { priceOf } from './transcripts'

type Obj = Record<string, any>
type Ready = Promise<unknown> | undefined


export type ErrorClass = 'rate_limit' | 'transient' | 'account' | 'request' | 'unknown'
const CLASSES: readonly ErrorClass[] = ['rate_limit', 'transient', 'account', 'request', 'unknown']

const N = (k: string): number | undefined => relNum(`recover.${k}`)
const T = (k: string, vars?: Record<string, string | number>): string | undefined => relText(`recover.text.${k}`, vars)

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const word = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase().slice(0, 40) : '')
const secs = (ms: number): number => Math.max(0, Math.round(ms / 1000))
const mins = (ms: number): number => Math.max(0, Math.round(ms / 60_000))


export function errorClassOf(error: unknown): ErrorClass {
  const w = word(error)
  const c = w ? relText(`recover.RECOVER_ERROR_CLASSES.${w}`) : undefined
  return CLASSES.includes(c as ErrorClass) ? (c as ErrorClass) : 'unknown'
}

export function retryDelay(made: number): number | null {
  const base = N('RECOVER_RETRY_BASE_MS')
  const max = N('RECOVER_RETRY_MAX_DELAY_MS')
  if (base === undefined || max === undefined) return null
  const n = Math.max(0, Math.min(30, Math.floor(num(made))))
  return Math.min(base * 2 ** n, max)
}

export type ResumeAction = 'wait' | 'retry' | 'stop'
export type ResumeDecision = { action: ResumeAction; cls: ErrorClass; delayMs: number | null; retry: number; max: number; tell: boolean; why: string }

export function resumeDecision(i: { error: unknown; made: number; aborted?: boolean }): ResumeDecision {
  const cls = errorClassOf(i?.error)
  const made = Math.max(0, Math.floor(num(i?.made)))
  const served = cls === 'transient' ? N('RECOVER_RETRY_MAX') : cls === 'unknown' ? N('RECOVER_UNKNOWN_RETRIES') : 0
  const max = served ?? 0
  const out = (action: ResumeAction, tell: boolean, why: string, delayMs: number | null = null): ResumeDecision =>
    ({ action, cls, delayMs, retry: action === 'retry' ? made + 1 : made, max, tell, why })
  const why = (k: string, vars?: Record<string, string | number>): string => T(k, vars) ?? ''
  if (i?.aborted === true) return out('stop', false, why('why_aborted'))
  if (cls === 'rate_limit') return out('wait', false, why('why_rate_limit'))
  if (cls === 'account') return out('stop', true, why('why_account'))
  if (cls === 'request') return out('stop', true, why('why_request'))
  if (served === undefined) return out('stop', false, '')
  if (made >= max) return out('stop', true, why(made === 1 ? 'why_retried_one' : 'why_retried', { n: made }))
  const delay = retryDelay(made)
  if (delay === null) return out('stop', false, '')
  return out('retry', false, why(cls === 'transient' ? 'why_transient' : 'why_unknown'), delay)
}

export function stopText(error: unknown, d: ResumeDecision): string | null {
  const w = word(error) || 'unknown'
  const what = T(d.cls === 'account' ? 'stop_account' : d.cls === 'request' ? 'stop_request' : 'stop_other')
  if (what === undefined) return null
  const body = T('stop', { error: w, why: d.why, what })
  return body === undefined ? null : `agent-services: ${body}`
}

export function retryText(error: unknown, d: ResumeDecision): string | null {
  const body = T('retry', { error: word(error) || 'unknown', retry: d.retry, max: d.max })
  return body === undefined ? null : `${NOTE_PREFIX}: ${body}`
}


export type CircuitState = 'closed' | 'open' | 'half_open'
export type Circuit = { fails: number[]; open: boolean; openedAt: number | null }
export type Circuits = Record<string, Circuit>
export type CircuitAdvice = { model: string; state: 'open' | 'half_open'; to: string | null; probeIn: number; fails: number }

export function circuitTierOf(model: unknown): string | null {
  const m = word(model)
  return m ? ROUTER_MODELS.find((x) => m.includes(x)) ?? null : null
}

function circuitOf(c: unknown): Circuit {
  const x = isObj(c) ? c : {}
  return {
    fails: Array.isArray(x.fails) ? x.fails.filter((t: unknown) => typeof t === 'number' && Number.isFinite(t)).slice(-10) : [],
    open: x.open === true,
    openedAt: typeof x.openedAt === 'number' && Number.isFinite(x.openedAt) ? x.openedAt : null,
  }
}

export function circuitStateAt(c: unknown, at: number): CircuitState {
  const x = circuitOf(c)
  const probe = N('CIRCUIT_PROBE_MS')
  if (!x.open || probe === undefined) return 'closed'
  return x.openedAt !== null && at - x.openedAt >= probe ? 'half_open' : 'open'
}

export function circuitFail(circuits: unknown, model: unknown, cls: ErrorClass, at: number): { circuits: Circuits; opened: boolean; tier: string | null } {
  const all: Circuits = {}
  if (isObj(circuits)) for (const [k, v] of Object.entries(circuits)) all[k] = circuitOf(v)
  const tier = circuitTierOf(model)
  const windowMs = N('CIRCUIT_WINDOW_MS')
  const limit = N('CIRCUIT_FAILS')
  if (!tier || N(`CIRCUIT_CLASSES.${cls}`) !== 1 || windowMs === undefined || limit === undefined || typeof at !== 'number' || !Number.isFinite(at)) {
    return { circuits: all, opened: false, tier }
  }
  const c = all[tier] ?? circuitOf(null)
  const fails = [...c.fails.filter((t) => t <= at && at - t <= windowMs), at].slice(-10)
  if (c.open) {
    all[tier] = { fails, open: true, openedAt: at }
    return { circuits: all, opened: false, tier }
  }
  const opened = fails.length >= limit
  all[tier] = { fails, open: opened, openedAt: opened ? at : null }
  return { circuits: all, opened, tier }
}

export function circuitSuccess(circuits: unknown, model: unknown, at: number): { circuits: Circuits; closed: boolean; tier: string | null } {
  const all: Circuits = {}
  if (isObj(circuits)) for (const [k, v] of Object.entries(circuits)) all[k] = circuitOf(v)
  const tier = circuitTierOf(model)
  if (!tier || !all[tier] || circuitStateAt(all[tier], at) !== 'half_open') return { circuits: all, closed: false, tier }
  all[tier] = { fails: [], open: false, openedAt: null }
  return { circuits: all, closed: true, tier }
}

export function circuitAlternative(tier: string, allowed: readonly string[] | null | undefined, blocked: readonly string[]): string | null {
  const i = ROUTER_MODELS.indexOf(tier)
  if (i < 0) return null
  const ok = (t: string): boolean => !blocked.includes(t) && (!Array.isArray(allowed) || !allowed.length || allowed.includes(t))
  for (let j = i + 1; j < ROUTER_MODELS.length; j++) if (ok(ROUTER_MODELS[j]!)) return ROUTER_MODELS[j]!
  for (let j = i - 1; j >= 0; j--) if (ok(ROUTER_MODELS[j]!)) return ROUTER_MODELS[j]!
  return null
}

export function circuitAdvice(circuits: unknown, at: number, allowed?: readonly string[] | null): CircuitAdvice[] {
  const all: Circuits = {}
  if (isObj(circuits)) for (const [k, v] of Object.entries(circuits)) all[k] = circuitOf(v)
  const notClosed = ROUTER_MODELS.filter((t) => all[t] && circuitStateAt(all[t], at) !== 'closed')
  return notClosed.map((t) => {
    const c = all[t]!
    return {
      model: t,
      state: circuitStateAt(c, at) as 'open' | 'half_open',
      to: circuitAlternative(t, allowed, notClosed),
      probeIn: Math.max(0, (c.openedAt ?? at) + (N('CIRCUIT_PROBE_MS') ?? 0) - at),
      fails: c.fails.length,
    }
  })
}

export function circuitNote(advice: readonly CircuitAdvice[]): string | null {
  const windowMs = N('CIRCUIT_WINDOW_MS')
  if (!advice.length || windowMs === undefined) return null
  const parts: string[] = []
  for (const a of advice) {
    const instead = a.to ? T('circuit_use', { to: a.to }) : T('circuit_none')
    if (instead === undefined) return null
    const part = a.state === 'open'
      ? T('circuit_open', { model: a.model, fails: a.fails, mins: mins(windowMs), instead, secs: secs(a.probeIn) })
      : T('circuit_half', { model: a.model, instead })
    if (part === undefined) return null
    parts.push(part)
  }
  const body = T('circuit', { parts: parts.join('; ') })
  return body === undefined ? null : `${NOTE_PREFIX}: ${body}`
}


export type EmptyTurnInput = { steps: number; text: boolean; tools: number; lastStop: string | null; lastMessage?: string | null; aborted: boolean; sentBack: number }

export function emptyTurnDecision(i: EmptyTurnInput): { send: boolean; why: string } {
  if (!i || typeof i !== 'object') return { send: false, why: 'no turn' }
  const max = N('EMPTY_TURN_MAX')
  if (i.aborted === true) return { send: false, why: 'the user interrupted a turn' }
  if (max === undefined) return { send: false, why: 'not served' }
  if (num(i.sentBack) >= max) return { send: false, why: 'sent back the most times already' }
  if (num(i.steps) <= 0) return { send: false, why: 'no request of the turn was seen' }
  if (i.text === true || num(i.tools) > 0 || (typeof i.lastMessage === 'string' && i.lastMessage.trim() !== '')) return { send: false, why: 'not empty' }
  const stop = String(i.lastStop ?? '')
  if (!stop || N(`EMPTY_TURN_STOPS.${stop}`) !== 1) return { send: false, why: `the last request ended as ${String(i.lastStop ?? 'none')}` }
  return { send: true, why: 'no text and no tool call' }
}

export function emptyTurnText(n: number): string | null {
  const max = N('EMPTY_TURN_MAX')
  const body = max === undefined ? undefined : T('empty_turn', { n, max })
  return body === undefined ? null : `${NOTE_PREFIX}: ${body}`
}


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


type TurnRec = { steps: number; text: boolean; tools: number; lastStop: string | null; first: StepUsage | null; last: StepUsage | null; aborted: boolean }
export type RecoverCounts = { retries: number; held: number; stops: number; circuitOpens: number; emptySendBacks: number; cacheBreaks: number; rebilled: number; usd: number }

const zeroCounts = (): RecoverCounts => ({ retries: 0, held: 0, stops: 0, circuitOpens: 0, emptySendBacks: 0, cacheBreaks: 0, rebilled: 0, usd: 0 })
let made = 0
let sentBack = 0
let aborted = false
let pending: { token: number; text: string } | null = null
let token = 0
let circuits: Circuits = {}
let agentModel: Record<string, string> = {}
let starts: Record<string, number> = {}
let turns: Record<string, TurnRec> = {}
let mainTurn: string | null = null
let lastMain: StepUsage | null = null
let longCache = false
let toolNames: string[] = []
let toolsBaseline = false
let toolsChangedAt: number | null = null
let counts: RecoverCounts = zeroCounts()

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

function log($: EngineInterface, text: string): void {
  try {
    void Promise.resolve($.ui.log(text)).catch(() => undefined)
  } catch {}
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
  const a = Object.keys(agentModel)
  for (const k of a.slice(0, Math.max(0, a.length - 100))) delete agentModel[k]
}

export function recoverStepStart(e: Obj, at?: number): void {
  try {
    if (!isObj(e) || typeof e.turnId !== 'string') return
    starts[`${e.turnId}:${num(e.index)}`] = typeof at === 'number' ? at : Date.now()
    if (typeof e.agentId === 'string' && e.agentId && typeof e.model === 'string' && e.model) agentModel[e.agentId] = e.model
    if (!e.agentId) {
      mainTurn = e.turnId
      toolsBaseline = true
    }
    prune()
  } catch {}
}

export function recoverStep(e: Obj, step: Obj, at?: number): void {
  try {
    if (!isObj(e) || typeof e.turnId !== 'string' || e.agentId) return
    const r = isObj(step) ? step : {}
    const rec = turns[e.turnId] ?? (turns[e.turnId] = { steps: 0, text: false, tools: 0, lastStop: null, first: null, last: null, aborted: false })
    rec.steps += 1
    if (typeof r.answer === 'string' && r.answer.trim() !== '') rec.text = true
    rec.tools += (Array.isArray(r.toolUses) ? r.toolUses.length : 0) + (Array.isArray(r.serverToolUses) ? r.serverToolUses.length : 0)
    rec.lastStop = typeof r.stopReason === 'string' ? r.stopReason : null
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

export function recoverToolDescribed(e: Obj, at?: number): void {
  try {
    if (!isObj(e) || typeof e.tool !== 'string' || e.isDeferred === true) return
    if (toolNames.includes(e.tool)) return
    toolNames = [...toolNames, e.tool].slice(-500)
    if (toolsBaseline) toolsChangedAt = typeof at === 'number' ? at : Date.now()
  } catch {}
}

export async function recoverTurnEnd($: EngineInterface, e: Obj, rt?: Ready): Promise<void> {
  try {
    if (!isObj(e) || !(await active(rt))) return
    const at = await nowOf($)
    if (typeof e.agentId === 'string' && e.agentId) {
      if (e.reason !== 'answer') return
      const r = circuitSuccess(circuits, (isObj(e.usage) && e.usage.model) || agentModel[e.agentId], at)
      circuits = r.circuits
      const said = r.closed ? T('circuit_closed', { tier: r.tier ?? '' }) : undefined
      if (said) log($, `agent-services: ${said}`)
      return
    }
    const rec = typeof e.turnId === 'string' ? turns[e.turnId] : undefined
    if (e.isAborted === true || e.reason === 'aborted') {
      aborted = true
      pending = null
      if (rec) rec.aborted = true
    }
    if (!rec) return
    const b = cacheBreak({ prev: lastMain, cur: rec.first, longCache, toolsChangedAt })
    if (rec.last) lastMain = rec.last
    if (b) {
      counts = { ...counts, cacheBreaks: counts.cacheBreaks + 1, rebilled: counts.rebilled + b.rebilled, usd: counts.usd + (b.usd ?? 0) }
      const line = cacheBreakText(b)
      if (line) log($, line)
    }
  } catch {}
}

export async function recoverStop($: EngineInterface, e: Obj): Promise<string | null> {
  try {
    if (!isObj(e) || e.agent_id || !rulesTable('watch')) return null
    const rec = mainTurn ? turns[mainTurn] : undefined
    if (!rec) return null
    const d = emptyTurnDecision({ steps: rec.steps, text: rec.text, tools: rec.tools, lastStop: rec.lastStop, lastMessage: e.last_assistant_message, aborted: aborted || rec.aborted, sentBack })
    rec.steps = 0
    rec.text = false
    rec.tools = 0
    rec.lastStop = null
    if (!d.send || emptyTurnText(sentBack + 1) === null) return null
    const gate = await continueVia($, 'empty_turn', 'stop', { at: await nowOf($) })
    if (!gate.ok) return null
    sentBack += 1
    counts = { ...counts, emptySendBacks: counts.emptySendBacks + 1 }
    return emptyTurnText(sentBack)
  } catch {
    return null
  }
}

export function recoverPrompt(e: Obj): void {
  try {
    if (!isObj(e) || e.agentId) return
    pending = null
    if (['composer', 'sdk', 'bridge'].includes(e.origin?.kind)) {
      made = 0
      sentBack = 0
      aborted = false
    }
  } catch {}
}

async function fire($: EngineInterface, mine: number): Promise<void> {
  try {
    if (!pending || pending.token !== mine) return
    const p = pending
    pending = null
    await rulesLive()
    if (!rulesTable('watch')) return
    let surfaces: unknown[] = []
    try {
      surfaces = await $.session.surfaces()
    } catch {}
    if (!Array.isArray(surfaces) || !surfaces.length) {
      counts = { ...counts, held: counts.held + 1 }
      return
    }
    const gate = await continueVia($, 'retry', 'stop', { at: await nowOf($) })
    if (!gate.ok) {
      counts = { ...counts, held: counts.held + 1 }
      const held = gate.say ? undefined : T('held')
      if (held) await reachNotify($, 'recover:held', `agent-services: ${held}`, { present: false, cap: false })
      return
    }
    counts = { ...counts, retries: counts.retries + 1 }
    await $.prompt.submit({ text: p.text } as any)
  } catch {}
}

export async function recoverFailure($: EngineInterface, e: Obj, next: (e: Obj) => Promise<Obj>): Promise<Obj> {
  const done = await next(e)
  try {
    await rulesLive()
    if (!rulesTable('watch') || !isObj(e)) return done
    const at = await nowOf($)
    const cls = errorClassOf(e.error)
    const agent = typeof e.agent_id === 'string' && e.agent_id ? e.agent_id : ''
    if (agent) {
      let model = agentModel[agent] ?? ''
      if (!model) {
        try {
          model = (await getJob($, agent))?.model ?? ''
        } catch {}
      }
      const r = circuitFail(circuits, model, cls, at)
      circuits = r.circuits
      if (r.opened) {
        counts = { ...counts, circuitOpens: counts.circuitOpens + 1 }
        let allowed: string[] | null = null
        try {
          allowed = (await routingModels(engineStore($)))?.models ?? null
        } catch {}
        const to = circuitAlternative(r.tier!, allowed, circuitAdvice(circuits, at, allowed).map((a) => a.model)) ?? T('circuit_wait')
        const fails = N('CIRCUIT_FAILS')
        const windowMs = N('CIRCUIT_WINDOW_MS')
        const said = to === undefined || fails === undefined || windowMs === undefined
          ? undefined
          : T('circuit_opened', { tier: r.tier ?? '', fails, mins: mins(windowMs), to })
        if (said) log($, `agent-services: ${said}`)
      }
      return done
    }
    const d = resumeDecision({ error: e.error, made, aborted })
    if (d.action === 'wait') return done
    if (d.action === 'stop') {
      pending = null
      const told = d.tell ? stopText(e.error, d) : null
      if (told) {
        counts = { ...counts, stops: counts.stops + 1 }
        await reachNotify($, `recover:stop:${word(e.error) || 'unknown'}`, told, REACH_ALWAYS)
      }
      return done
    }
    const text = retryText(e.error, d)
    if (!text) return done
    made += 1
    token += 1
    const mine = token
    pending = { token: mine, text }
    const said = T('retry_log', { error: word(e.error) || 'unknown', retry: d.retry, max: d.max, secs: secs(d.delayMs ?? 0) })
    if (said) log($, `agent-services: ${said}`)
    $.clock.after(d.delayMs ?? 0, () => void fire($, mine))
  } catch {}
  return done
}

export async function routeCircuit($: EngineInterface, e: Obj, text: string | null, rt?: Ready): Promise<string | null> {
  try {
    if (!isObj(e) || (e.tool !== 'Agent' && e.tool !== 'Task')) return text
    if (!Object.keys(circuits).length) return text
    if (rt !== undefined && !(await rt)) return text
    if ((await routingLevel(engineStore($))) === 'off') return text
    let allowed: string[] | null = null
    try {
      allowed = (await routingModels(engineStore($)))?.models ?? null
    } catch {}
    const note = circuitNote(circuitAdvice(circuits, await nowOf($), allowed))
    if (!note) return text
    return text ? `${text}\n${note}` : note
  } catch {
    return text
  }
}


export function installRecover(on: any): void {
  on('classic.StopFailure', { error: ['rate_limit', 'overloaded', 'server_error', 'timeout', 'authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required', 'billing_error', 'cloud_credential_error', 'invalid_request', 'model_not_found', 'max_output_tokens', 'unknown'] }, async ($: EngineInterface, e: Obj, next: any) => recoverFailure($, e, next))
    .catch(($: EngineInterface, e: Obj, next: any) => next(e))
  on('tool.describe', { tool: /^mcp__/ }, async ($: EngineInterface, e: Obj, next: any) => {
    const r = await next(e)
    recoverToolDescribed(e)
    return r
  }).catch(($: EngineInterface, e: Obj, next: any) => next(e))
}

export function recoverResetForTest(): void {
  made = 0
  sentBack = 0
  aborted = false
  pending = null
  token = 0
  circuits = {}
  agentModel = {}
  starts = {}
  turns = {}
  mainTurn = null
  lastMain = null
  longCache = false
  toolNames = []
  toolsBaseline = false
  toolsChangedAt = null
  counts = zeroCounts()
}

export function recoverStateForTest(): Obj {
  return { made, sentBack, aborted, pending, circuits, agentModel, mainTurn, lastMain, longCache, toolsChangedAt, counts }
}
