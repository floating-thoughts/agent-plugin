import type { EngineInterface } from 'claude-code'
import { jobOpen, listJobs, setJobStatus, type Job, type JobStatus } from './jobs'
import { ROUTER_MODELS, routingLevel, routingModels } from './routing_level'
import { NOTE_PREFIX } from './review'
import { rulesTable } from './rules'
import { briefHash } from './resume'
import { engineStore } from './store'
import { projectDir } from './task_state_io'
import { vaultMask } from './vault'
import { stallSubjectOf } from './watchdog'
import { reachNotify } from './reach'
import { relNum, relText } from './reliability'

type Obj = Record<string, any>


export const STALL_LADDER_KEY = 'stall_ladder'

const N = (k: string): number | undefined => relNum(`stall.${k}`)
const T = (k: string, vars?: Record<string, string | number>): string | undefined => relText(`stall.text.${k}`, vars)

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const mins = (ms: number): number => Math.max(0, Math.round(ms / 60_000))

function shown(text: unknown): string {
  let s = String(text ?? '')
  try {
    s = vaultMask(s)
  } catch {}
  s = s.replace(/[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim()
  return s.length > 120 ? s.slice(0, 119) + '\u2026' : s
}


export type LadderEntry = { rung: number; stalledAt: number | null; rungAt: number | null }
export type LadderLedger = Record<string, LadderEntry>
export type LadderSnapshot = {
  session?: string
  jobs: Job[]
  outputs?: Record<string, number | null>
  toolAt?: Record<string, number | null>
  live?: string[] | null
  ledger?: LadderLedger
  allowed?: string[] | null
}
export type LadderPlan = {
  ledger: LadderLedger
  statuses: { id: string; status: JobStatus; note: string }[]
  toMain: string[]
  notifies: string[]
  covered: string[]
}

function quietOf(kind: unknown): number | undefined {
  return typeof kind === 'string' && kind ? N(`LADDER_QUIET_MS.${kind}`) : undefined
}

export function ladderDelay(given: number): number {
  const start = N('LADDER_BACKOFF_START_MS')
  const max = N('LADDER_BACKOFF_MAX_MS')
  if (start === undefined || max === undefined) return Infinity
  return Math.min(start * 2 ** Math.max(0, given), max)
}

export function tierUp(model: unknown, allowed?: string[] | null): string | null {
  const m = String(model ?? '').toLowerCase()
  const i = ROUTER_MODELS.findIndex((x) => m.includes(x))
  if (i < 0) return null
  for (let j = i - 1; j >= 0; j--) {
    const t = ROUTER_MODELS[j]!
    if (!Array.isArray(allowed) || !allowed.length || allowed.includes(t)) return t
  }
  return null
}

function rungText(rung: number, j: Job, quiet: number, allowed: string[] | null | undefined): string | null {
  const who = T('who', { kind: j.kind, id: j.id, title: shown(j.title) })
  if (who === undefined) return null
  const v = { who, mins: mins(quiet), id: j.id }
  let body: string | undefined
  if (rung === 1) body = T(j.kind === 'subagent' ? 'rung1_subagent' : 'rung1', v)
  else if (rung === 2) {
    const to = tierUp(j.model, allowed) ?? T('rung2_no_tier')
    const from = j.model ? shown(j.model) : T('rung2_no_model')
    body = to === undefined || from === undefined ? undefined : T('rung2', { ...v, to, from })
  } else body = T('rung3', v)
  return body === undefined ? null : `${NOTE_PREFIX}: ${body}`
}

export function ladderPlan(snapshot: LadderSnapshot, at: number): LadderPlan {
  const out: LadderPlan = { ledger: Object.create(null), statuses: [], toMain: [], notifies: [], covered: [] }
  try {
    const old = snapshot?.ledger && typeof snapshot.ledger === 'object' ? snapshot.ledger : {}
    const jobs = Array.isArray(snapshot?.jobs) ? snapshot.jobs : []
    const ids = new Set(jobs.map((j) => j?.id))
    for (const [k, v] of Object.entries(old)) if (ids.has(k)) out.ledger[k] = v
    const rungs = N('LADDER_RUNGS')
    if (typeof at !== 'number' || rungs === undefined) return out
    const session = typeof snapshot.session === 'string' ? snapshot.session : ''
    const live = Array.isArray(snapshot.live) ? new Set(snapshot.live) : null
    for (const j of jobs) {
      if (!j || typeof j.id !== 'string') continue
      const quietMs = quietOf(j.kind)
      if (!quietMs || (j.status !== 'running' && j.status !== 'stalled')) continue
      if (session && j.session && j.session !== session) continue
      if (j.kind === 'subagent' && live !== null && !live.has(j.id)) continue
      if (j.kind === 'subagent') out.covered.push(j.id)
      const signs = [num(j.started_at), num(j.last_activity_at), num(snapshot.outputs?.[j.id]), num(snapshot.toolAt?.[j.id])]
      const sign = Math.max(...signs.map((x) => x ?? -Infinity))
      const prev = out.ledger[j.id]
      const L: LadderEntry = { rung: Math.max(0, Math.floor(num(prev?.rung) ?? 0)), stalledAt: num(prev?.stalledAt), rungAt: num(prev?.rungAt) }
      const mark = Math.max(L.rungAt ?? -Infinity, L.stalledAt ?? -Infinity)
      const revived = Number.isFinite(mark) && sign > mark && (L.stalledAt !== null || j.status === 'stalled')
      if (revived) L.stalledAt = null
      out.ledger[j.id] = L
      const from = Math.max(sign, L.rungAt ?? -Infinity)
      const quiet = Number.isFinite(from) && at - from >= quietMs
      if (revived && !quiet && j.status === 'stalled') out.statuses.push({ id: j.id, status: 'running', note: T('status_active') ?? '' })
      if (L.rung >= rungs || !quiet) continue
      if (L.stalledAt === null) L.stalledAt = at
      if (j.status !== 'stalled') out.statuses.push({ id: j.id, status: 'stalled', note: T('status_quiet', { mins: mins(at - from) }) ?? '' })
      if (at - L.stalledAt < ladderDelay(L.rung)) continue
      L.rung += 1
      L.rungAt = at
      L.stalledAt = null
      const say = rungText(L.rung, j, at - from, snapshot.allowed)
      if (say) out.toMain.push(say)
      if (L.rung >= rungs) {
        out.statuses.push({ id: j.id, status: 'stalled', note: T('status_stuck') ?? '' })
        const tell = T('notify_stuck', { kind: j.kind, title: shown(j.title), id: j.id })
        if (tell) out.notifies.push(tell)
      }
    }
    return out
  } catch {
    return out
  }
}


export type LoopState = { calls: string[]; n: number; fired: Record<string, { times: number; at: number }> }
export const emptyLoop = (): LoopState => ({ calls: [], n: 0, fired: {} })

function stable(v: unknown, depth = 0): string {
  if (depth > 8) return '"\u2026"'
  if (Array.isArray(v)) return `[${v.map((x) => stable(x, depth + 1)).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Obj).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Obj)[k], depth + 1)}`).join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

export function loopFingerprint(e: unknown): string {
  const { tool, tool_use_id: _c, agentId: _a, requestMeta: _m, consent: _k, ...input } = (e && typeof e === 'object' ? e : {}) as Obj
  return stallSubjectOf(tool, stable(input))
}

const sameList = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])

export function loopStep(state: LoopState | null | undefined, fp: string): { state: LoopState; level: 0 | 1 | 2; repeats: number; period: number } {
  const s0 = state && Array.isArray(state.calls) ? state : emptyLoop()
  const windowLen = N('LOOP_WINDOW')
  const repeatsMin = N('LOOP_REPEATS')
  const maxPeriod = N('LOOP_MAX_PERIOD')
  if (windowLen === undefined || repeatsMin === undefined || maxPeriod === undefined) return { state: s0, level: 0, repeats: 1, period: 0 }
  const calls = [...s0.calls, fp].slice(-windowLen)
  const n = (num(s0.n) ?? 0) + 1
  const fired = { ...(s0.fired ?? {}) }
  for (let p = 1; p <= maxPeriod; p++) {
    if (calls.length < repeatsMin * p) break
    const block = calls.slice(-p)
    let reps = 1
    while (calls.length >= (reps + 1) * p && sameList(calls.slice(calls.length - (reps + 1) * p, calls.length - reps * p), block)) reps++
    if (reps < repeatsMin) continue
    const rotations = block.map((_, i) => [...block.slice(i), ...block.slice(0, i)].join('|'))
    const key = rotations.sort()[0]!
    const f = fired[key]
    if (f && n - f.at < repeatsMin * p) return { state: { calls, n, fired }, level: 0, repeats: reps, period: p }
    const times = (f?.times ?? 0) + 1
    fired[key] = { times, at: n }
    const keys = Object.keys(fired)
    for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete fired[k]
    return { state: { calls, n, fired }, level: times === 1 ? 1 : times === 2 ? 2 : 0, repeats: reps, period: p }
  }
  return { state: { calls, n, fired }, level: 0, repeats: 1, period: 0 }
}

export function loopNote(level: number, tool: unknown, repeats: number, period: number): string | null {
  if (level !== 1 && level !== 2) return null
  const name = shown(tool) || T('loop_tool')
  const what = period > 1 ? T('loop_calls', { period }) : name === undefined ? undefined : T('loop_call', { tool: name })
  if (what === undefined) return null
  const body = T(level === 1 ? 'loop1' : 'loop2', { what, repeats })
  return body === undefined ? null : `${NOTE_PREFIX}: ${body}`
}


export type EndKind = 'finished' | 'aborted' | 'error' | 'plugin_abort'
export type Round = { at: number; progress: boolean; error: string | null }
export type ContinueState = {
  rounds: Round[]
  open: number | null
  auto: number
  aborted: boolean
  lastEnd: EndKind | null
  progressAt: number | null
  errorKey: string | null
  errorAt: number | null
  breaker: { until: number; why: string } | null
}
export type ContinueWhy = 'aborted' | 'error' | 'breaker' | 'cap'
export type ContinueDecision = { ok: boolean; why: ContinueWhy | null; say: string | null; state: ContinueState }
export type ContinueKind = 'promise' | 'self_check' | 'wall' | 'checkpoint_next' | 'to_main' | 'keep_going' | 'empty_turn' | 'retry'

export const emptyContinue = (): ContinueState => ({
  rounds: [], open: null, auto: 0, aborted: false, lastEnd: null, progressAt: null, errorKey: null, errorAt: null, breaker: null,
})

function contOf(s: unknown): ContinueState {
  const x = (s && typeof s === 'object' ? s : {}) as Obj
  const e = emptyContinue()
  return {
    rounds: Array.isArray(x.rounds) ? x.rounds.filter((r: Obj) => r && typeof r.at === 'number').slice(-10) : e.rounds,
    open: num(x.open),
    auto: Math.max(0, Math.floor(num(x.auto) ?? 0)),
    aborted: x.aborted === true,
    lastEnd: ['finished', 'aborted', 'error', 'plugin_abort'].includes(x.lastEnd) ? x.lastEnd : null,
    progressAt: num(x.progressAt),
    errorKey: typeof x.errorKey === 'string' && x.errorKey ? x.errorKey : null,
    errorAt: num(x.errorAt),
    breaker: x.breaker && typeof x.breaker.until === 'number' ? { until: x.breaker.until, why: String(x.breaker.why ?? '') } : null,
  }
}

export function endKindOf(reason: unknown, ownAbort: boolean): EndKind {
  if (reason === 'aborted') return ownAbort ? 'plugin_abort' : 'aborted'
  if (reason === 'error' || reason === 'refusal') return 'error'
  return 'finished'
}

function closeOpen(s: ContinueState): ContinueState {
  if (s.open === null) return s
  const progress = s.progressAt !== null && s.progressAt >= s.open
  const error = s.errorKey !== null && s.errorAt !== null && s.errorAt >= s.open ? s.errorKey : null
  return { ...s, rounds: [...s.rounds, { at: s.open, progress, error }].slice(-10), open: null }
}

export function onTurnEnd(state: unknown, kind: EndKind, at: number): ContinueState {
  const s = contOf(state)
  const n: ContinueState = { ...s, lastEnd: kind, aborted: s.aborted || kind === 'aborted' }
  return kind === 'error' ? { ...n, errorKey: 'turn-error', errorAt: at } : n
}

export function onPersonPrompt(state: unknown): ContinueState {
  return { ...closeOpen(contOf(state)), aborted: false, auto: 0 }
}

export function onProgress(state: unknown, at: number): ContinueState {
  return { ...contOf(state), progressAt: at }
}

export function onError(state: unknown, key: string, at: number): ContinueState {
  return typeof key === 'string' && key ? { ...contOf(state), errorKey: key, errorAt: at } : contOf(state)
}

export function continueDecision(state: unknown, at: number, entry: 'stop' | 'idle', mustSend = false): ContinueDecision {
  const d = decide(state, at, entry)
  if (d.ok || !mustSend) return d
  const s = closeOpen(d.state)
  return { ...d, ok: true, state: { ...s, open: at, auto: s.auto + 1 } }
}

function decide(state: unknown, at: number, entry: 'stop' | 'idle'): ContinueDecision {
  let s = contOf(state)
  const no = (why: ContinueWhy, say: string | null = null): ContinueDecision => ({ ok: false, why, say, state: s })
  if (s.breaker) {
    if (at < s.breaker.until) return no('breaker')
    s = { ...s, breaker: null, rounds: [], open: null }
  }
  if (s.aborted) return no('aborted')
  if (entry === 'idle' && (s.lastEnd === 'error' || s.lastEnd === 'aborted')) return no(s.lastEnd === 'error' ? 'error' : 'aborted')
  s = closeOpen(s)
  const cooldown = N('BREAKER_COOLDOWN_MS')
  const noProgress = N('BREAKER_NO_PROGRESS')
  const sameError = N('BREAKER_SAME_ERROR')
  const cap = N('CONTINUE_CAP')
  const trip = (cool: number, why: string): ContinueDecision => {
    s = { ...s, breaker: { until: at + cool, why } }
    const body = T('breaker', { mins: mins(cool), why })
    return no('breaker', body === undefined ? null : `${NOTE_PREFIX}: ${body}`)
  }
  if (cooldown !== undefined && noProgress !== undefined) {
    const lastN = s.rounds.slice(-noProgress)
    if (lastN.length === noProgress && lastN.every((r) => !r.progress)) return trip(cooldown, T('breaker_no_progress', { n: noProgress }) ?? '')
  }
  if (cooldown !== undefined && sameError !== undefined) {
    const lastE = s.rounds.slice(-sameError)
    if (lastE.length === sameError && lastE[0]!.error && lastE.every((r) => r.error === lastE[0]!.error)) {
      return trip(cooldown, T('breaker_same_error', { n: sameError }) ?? '')
    }
  }
  if (cap === undefined || s.auto >= cap) return no('cap')
  return { ok: true, why: null, say: null, state: { ...s, open: at, auto: s.auto + 1 } }
}


export type Escalation = { ids: string[]; from: string | null; to: string | null }

export function escalateDue(jobs: Job[], hash: string, at: number, allowed?: string[] | null): Escalation | null {
  try {
    const windowMs = N('ESCALATE_WINDOW_MS')
    const fails = N('ESCALATE_FAILS')
    if (!hash || !Array.isArray(jobs) || windowMs === undefined || fails === undefined) return null
    const failed = jobs
      .filter((j) => j && j.brief_hash === hash && j.status === 'failed' && at - Math.max(num(j.last_activity_at) ?? 0, num(j.started_at) ?? 0) <= windowMs)
      .sort((a, b) => (num(a.started_at) ?? 0) - (num(b.started_at) ?? 0))
    if (failed.length < fails) return null
    const from = failed[failed.length - 1]!.model ?? null
    return { ids: failed.map((j) => j.id), from, to: tierUp(from, allowed) }
  } catch {
    return null
  }
}

export function escalateNote(d: Escalation): string | null {
  const windowMs = N('ESCALATE_WINDOW_MS')
  if (windowMs === undefined) return null
  const ids = d.ids.slice(-5).map((x) => shown(x)).join(', ')
  const tier = d.to ? T('escalate_up', { to: d.to }) : T('escalate_none')
  const on = d.from ? T('escalate_on', { model: shown(d.from) }) : ''
  if (tier === undefined || on === undefined) return null
  const body = T('escalate', { count: d.ids.length, hours: Math.round(windowMs / 3_600_000), ids, on, tier })
  return body === undefined ? null : `${NOTE_PREFIX}: ${body}`
}


let cont: ContinueState = emptyContinue()
let loops: Record<string, LoopState> = {}
let ownAborts: string[] = []
let gateCounts: Partial<Record<ContinueKind, { sent: number; held: number }>> = {}

const clockNow = (): number => Date.now()

export function stallToolEnd(e: Obj, ran: Obj, at?: number): string | null {
  try {
    if (!e || !ran || typeof ran !== 'object' || ran.deny !== undefined) return null
    const tool = String(e.tool ?? '')
    if (tool && N(`EDIT_TOOLS_PROGRESS.${tool}`) === 1 && ran.isError !== true) cont = onProgress(cont, at ?? clockNow())
    const agent = typeof e.agentId === 'string' && e.agentId ? e.agentId : ''
    const r = loopStep(loops[agent], loopFingerprint(e))
    loops[agent] = r.state
    const keys = Object.keys(loops)
    for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete loops[k]
    return rulesTable('watch') ? loopNote(r.level, tool, r.repeats, r.period) : null
  } catch {
    return null
  }
}

export function stallFailure(key: unknown, _tool: unknown, at?: number): void {
  try {
    if (typeof key !== 'string' || !key) return
    cont = onError(cont, key, at ?? clockNow())
  } catch {}
}

export function stallProgress(at?: number): void {
  cont = onProgress(cont, typeof at === 'number' ? at : clockNow())
}

export function stallOwnAbort(turnId: unknown): void {
  if (typeof turnId === 'string' && turnId) ownAborts = [...ownAborts.filter((x) => x !== turnId), turnId].slice(-20)
}

export function stallTurnEnd(e: Obj, at?: number): void {
  try {
    if (!e || e.agentId) return
    const own = typeof e.turnId === 'string' && ownAborts.includes(e.turnId)
    cont = onTurnEnd(cont, endKindOf(e.reason, own), at ?? clockNow())
  } catch {}
}

export function stallPersonPrompt(): void {
  try {
    cont = onPersonPrompt(cont)
  } catch {}
}

export async function continueVia($: EngineInterface, kind: ContinueKind, entry: 'stop' | 'idle', opts?: { at?: number; mustSend?: boolean }):
  Promise<{ ok: boolean; say: string | null }> {
  try {
    let at = opts?.at
    if (typeof at !== 'number') {
      try {
        at = Number(await $.clock.now())
      } catch {}
    }
    const d = continueDecision(cont, typeof at === 'number' && Number.isFinite(at) ? at : clockNow(), entry, opts?.mustSend === true)
    cont = d.state
    const c = gateCounts[kind] ?? { sent: 0, held: 0 }
    gateCounts[kind] = d.ok ? { ...c, sent: c.sent + 1 } : { ...c, held: c.held + 1 }
    if (d.say) {
      try {
        await reachNotify($, 'breaker', d.say.replace(`${NOTE_PREFIX}: `, 'agent-services: '))
      } catch {}
    }
    return { ok: d.ok, say: d.say }
  } catch {
    return { ok: true, say: null }
  }
}

async function readLadder($: EngineInterface): Promise<LadderLedger> {
  try {
    const v = await $.store.get(STALL_LADDER_KEY)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as LadderLedger) : {}
  } catch {
    return {}
  }
}

export async function jobStallTick($: EngineInterface, at: number, toolAt: Record<string, number | null>, live: string[] | null):
  Promise<{ toMain: string[]; notifies: string[]; covered: string[] }> {
  const none = { toMain: [] as string[], notifies: [] as string[], covered: [] as string[] }
  try {
    const jobs = await listJobs($)
    if (!jobs.some((j) => jobOpen(j) && quietOf(j.kind))) return none
    let session = ''
    try {
      session = String(await $.session.id())
    } catch {}
    const outputs: Record<string, number | null> = Object.create(null)
    for (const j of jobs) {
      if (!jobOpen(j) || !quietOf(j.kind) || !j.output) continue
      try {
        outputs[j.id] = num(Number((await $.fs.stat(j.output)).mtimeMs))
      } catch {
        outputs[j.id] = null
      }
    }
    const ledger = await readLadder($)
    let allowed: string[] | null = null
    try {
      allowed = (await routingModels(engineStore($)))?.models ?? null
    } catch {}
    const plan = ladderPlan({ session, jobs, outputs, toolAt, live, ledger, allowed }, at)
    for (const s of plan.statuses) await setJobStatus($, s.id, s.status, s.note)
    if (JSON.stringify(plan.ledger) !== JSON.stringify(ledger)) {
      try {
        await $.store.set(STALL_LADDER_KEY, plan.ledger)
      } catch {}
    }
    return { toMain: plan.toMain, notifies: plan.notifies, covered: plan.covered }
  } catch {
    return none
  }
}

export async function routeEscalation($: EngineInterface, e: Obj, text: string | null, rt?: Promise<unknown>): Promise<string | null> {
  try {
    if (!e || (e.tool !== 'Agent' && e.tool !== 'Task')) return text
    if (rt !== undefined && !(await rt)) return text
    if ((await routingLevel(engineStore($))) === 'off') return text
    const jobs = await listJobs($)
    if (!jobs.some((j) => j.status === 'failed' && j.brief_hash)) return text
    let allowed: string[] | null = null
    try {
      allowed = (await routingModels(engineStore($)))?.models ?? null
    } catch {}
    const dir = await projectDir($)
    if (!dir) return text
    const d = escalateDue(jobs, briefHash(dir, e.description, e.prompt), Number(await $.clock.now()), allowed)
    if (!d) return text
    const note = escalateNote(d)
    if (!note) return text
    return text ? `${text}\n${note}` : note
  } catch {
    return text
  }
}

export function continueCounts(): Partial<Record<ContinueKind, { sent: number; held: number }>> {
  return JSON.parse(JSON.stringify(gateCounts))
}

export function stallResetForTest(): void {
  cont = emptyContinue()
  loops = {}
  ownAborts = []
  gateCounts = {}
}
