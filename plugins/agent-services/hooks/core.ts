
import { TOOLS as CONTRACT_TOOLS, CONTRACT } from './contract'
import { Counters, sweep } from './counters'
import type { CountersOptions } from './counters'
import { savingsSummary } from './local_savings'
import { Receipts } from './receipts'
import { sha256Hex } from './e2e'
import { pyRound } from './pyfmt'
import { Records } from './records'
import { SessionSummary } from './summary'
import type { Clock, GateState, KV, Random, SvcResult, Transport } from './engine_types'
import { filesAnswer, install, KIT_WAIT_MS, KitFilesError, kitJob, onDisk, type KitFilesOptions, type KitResult, type ServedFile } from './kit_files'
import { GATE_NOTICES, LOCKED_LINE, PAUSED_LINE as SIGN_IN_LINE, PLAN_NOTICE } from './svc'
import { checkpointToolName, explicitFor, noteCallBrief, noteCallExplicit, noteCallRoute, noteRouteHint, setTableAsk, userAskedOverride, userAskedReview } from './flow_state'
import { ADVICE_LABEL, adviceIn, takeTurn } from './delegate'
import { RX_INPUT_MAX, servedRegex } from './rules'
import { companyIndex, companyKey } from './sealed_wire'

export { normpath, normPath } from './paths'

export const HARNESSES = ['claude-code', 'opencode', 'codex', 'cursor', 'gemini', 'other']
export const KINDS = ['session_start', 'dispatch', 'dispatched', 'step', 'step_end', 'pre_tool', 'post_tool', 'turn_end',
  'prompt', 'compaction', 'clear', 'session_end', 'dashboard_published', 'dashboard_denied']
export const INJECT_POINTS = ['prompt', 'pre_tool', 'post_tool']
export const GATE_RETRY_SECONDS = 300
export const ANSWER_KEYS = ['action', 'reason', 'set', 'context', 'notice', 'fallback'] as const
export const TOOL_DEADLINE_MS = 8000
export const HELLO_DEADLINE_MS = 30000
export const AUTH_FAIL_REASONS = ['login', 'locked', 'paused']

export const CHECKPOINT_MARK = 'Checkpoint reached:'
export const CHECKPOINT_NOW = ADVICE_LABEL + ' The server suggests a checkpoint now: call the checkpoint tool once this ' +
  'stretch is done.'
export const CHECKPOINT_SHOWN = 'agent-services: the context is large; a checkpoint is suggested now. Claude compacts at the next ' +
  'finished step and carries on from the summary.'
const CKPT_KEY = 'checkpoint_counts'
export const SAVINGS_OFF_NEXT = 'The savings record is not on for this account: /agent-services sharing preview shows ' +
  'what it sends, and /agent-services sharing on turns it on.'
export const DENY_TEXT = 'This subagent dispatch did not pass the routing check. Rewrite it as the hint says, then dispatch again.'

export { GATE_NOTICES, LOCKED_LINE, PLAN_NOTICE, SIGN_IN_LINE }


export function isCommit(cmd: string): boolean {
  return servedRegex('patterns', 'commit')?.test(cmd.slice(0, RX_INPUT_MAX)) === true
}

const DEFS = (CONTRACT as unknown as { definitions: Record<string, { enum: string[] }> }).definitions
export const SERVED_ROLES: readonly string[] = DEFS.ServedRole!.enum
export const SERVED_PHASES: readonly string[] = DEFS.ServedPhase!.enum
export const CORE_TOOLS: ReadonlyMap<string, Record<string, unknown>> = new Map(
  [...CONTRACT_TOOLS, ...(CONTRACT as unknown as { 'x-core-tools': typeof CONTRACT_TOOLS })['x-core-tools']]
    .filter((t) => t.name !== 'status').map((t) => [t.name, t.input_schema]))
const COUNTER_ARGS = ['turns', 'tool_calls', 'todos_done', 'commits', 'minutes']

export type Answer = {
  action: string
  reason: string | null
  set: Record<string, unknown> | null
  context: string[] | null
  notice: string | null
  fallback: string | null
}
type Ev = Record<string, unknown>

export class ValidationError extends Error {}


const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const has = (e: Ev, k: string): boolean => Object.prototype.hasOwnProperty.call(e, k)
const cpLen = (s: string): number => [...s].length
const nil = (v: unknown): boolean => v === null || v === undefined

function bad(name: string): never {
  throw new ValidationError(name)
}

function req(e: Ev, k: string): unknown {
  if (!has(e, k)) bad(k)
  return e[k]
}

function strN(v: unknown, name: string, lo = 1, hi = 200): void {
  if (typeof v !== 'string' || cpLen(v) < lo || cpLen(v) > hi) bad(name)
}

function strOrNull(e: Ev, k: string): void {
  const v = req(e, k)
  if (v !== null && typeof v !== 'string') bad(k)
}

function optStr(e: Ev, k: string): void {
  if (!nil(e[k]) && typeof e[k] !== 'string') bad(k)
}

function intOrNull(e: Ev, k: string): void {
  const v = req(e, k)
  if (v !== null && !isInt(v)) bad(k)
}

function numOrNull(e: Ev, k: string): void {
  const v = req(e, k)
  if (v !== null && !isNum(v)) bad(k)
}

function boolean(e: Ev, k: string): void {
  if (typeof req(e, k) !== 'boolean') bad(k)
}

function optBool(e: Ev, k: string): void {
  if (!nil(e[k]) && typeof e[k] !== 'boolean') bad(k)
}

function usage(e: Ev, k = 'usage'): void {
  const u = req(e, k)
  if (u === null) return
  if (!isObj(u)) bad(k)
  for (const f of ['input', 'output', 'cache_read', 'cache_write']) {
    const n = u[f]
    if (!isInt(n) || n < 0) bad(k)
  }
}

function toolFields(e: Ev): void {
  strN(req(e, 'tool'), 'tool')
  if (!isObj(req(e, 'input'))) bad('input')
  strOrNull(e, 'call')
}

export function validate(event: unknown): asserts event is Ev {
  if (!isObj(event)) bad('event')
  const e = event
  const v = req(e, 'v')
  if (!isInt(v) || v !== 1) bad('v')
  if (!HARNESSES.includes(req(e, 'harness') as string)) bad('harness')
  const kind = req(e, 'kind')
  if (!KINDS.includes(kind as string)) bad('kind')
  strN(req(e, 'session'), 'session')
  const agent = req(e, 'agent')
  if (agent !== null) strN(agent, 'agent')
  if (kind === 'session_start') {
    strOrNull(e, 'cwd')
    optStr(e, 'transcript')
    const io = e.inject_on
    if (!nil(io) && (!Array.isArray(io) || io.some((x) => !INJECT_POINTS.includes(x)))) bad('inject_on')
  } else if (kind === 'dispatch') {
    if (typeof req(e, 'subagent_type') !== 'string') bad('subagent_type')
    if (typeof req(e, 'description') !== 'string') bad('description')
    for (const k of ['model', 'effort', 'call']) strOrNull(e, k)
    optBool(e, 'fork')
    optBool(e, 'teammate')
    optBool(e, 'plan_done')
    if (!nil(e.prior_failures) && (!isInt(e.prior_failures) || e.prior_failures < 0)) bad('prior_failures')
  } else if (kind === 'dispatched') {
    strOrNull(e, 'call')
    strN(req(e, 'child'), 'child')
  } else if (kind === 'step') {
    strOrNull(e, 'model')
  } else if (kind === 'step_end') {
    strOrNull(e, 'model')
    usage(e)
  } else if (kind === 'pre_tool') {
    toolFields(e)
  } else if (kind === 'post_tool') {
    toolFields(e)
    boolean(e, 'ok')
  } else if (kind === 'turn_end') {
    strOrNull(e, 'reason')
    strOrNull(e, 'model')
    usage(e)
    intOrNull(e, 'context_tokens')
    intOrNull(e, 'context_window')
  } else if (kind === 'prompt') {
    optStr(e, 'origin')
  } else if (kind === 'compaction') {
    strOrNull(e, 'trigger')
    strOrNull(e, 'instructions')
    boolean(e, 'done')
    for (const k of ['before', 'after', 'window', 'threshold']) intOrNull(e, k)
    for (const k of ['cost_before', 'cost_after']) numOrNull(e, k)
  } else if (kind === 'dashboard_published') {
    strN(req(e, 'url'), 'url', 1, 500)
  }
}

export function answer(action = 'allow', f: Partial<Omit<Answer, 'action'>> = {}): Answer {
  return {
    action, reason: f.reason ?? null, set: f.set ?? null, context: f.context ?? null, notice: f.notice ?? null,
    fallback: f.fallback ?? null,
  }
}

export function gateNotice(state: GateState | null | undefined, nowS: number | null = null): string | null {
  if (!state || state.open) return null
  const left = state.retryAt != null && nowS !== null ? state.retryAt - nowS : 0
  if (state.reason === 'unavailable' && left > 0)
    return GATE_NOTICES.unavailable_until!.replace('{minutes}', String(Math.max(1, Math.ceil(left / 60))))
  const reason = state.reason ?? ''
  const text = Object.hasOwn(GATE_NOTICES, reason) ? GATE_NOTICES[reason] : undefined
  if (text === undefined) return null
  return text.replace('{min_shell}', state.minShell || 'unknown')
}

export const planNotice = (plan: unknown): string | null => (plan === 'guard' ? PLAN_NOTICE : null)
export const isAuthFail = (st: GateState): boolean => !st.open && AUTH_FAIL_REASONS.includes(st.reason ?? '')


export function checkArgs(tool: string, args: unknown): void {
  const schema = CORE_TOOLS.get(tool) as { properties: Record<string, unknown>; required: string[] } | undefined
  if (!schema) bad('unknown tool')
  if (!isObj(args)) bad('arguments must be an object')
  for (const k of Object.keys(args)) if (!has(schema.properties, k)) bad(`unknown argument ${k}`)
  for (const k of schema.required) if (!has(args, k)) bad(`missing ${k}`)
  if (tool === 'router_advice') {
    const st = args.subagent_type
    const d = args.description
    if (typeof st !== 'string' || cpLen(st) < 1 || cpLen(st) > 64) bad('subagent_type')
    if (typeof d !== 'string' || cpLen(d) > 100000) bad('description')
    for (const k of ['model', 'effort']) if (!nil(args[k]) && typeof args[k] !== 'string') bad(k)
    if (has(args, 'scope')) checkScope(args.scope, (schema.properties.scope as Ev).properties as Ev)
  } else if (tool === 'lesson_lookup') {
    if (typeof args.role !== 'string' || !SERVED_ROLES.includes(args.role)) bad('role')
    if (typeof args.phase !== 'string' || !SERVED_PHASES.includes(args.phase)) bad('phase')
    if (has(args, 'event') && !((schema.properties.event as { enum: unknown[] }).enum).includes(args.event)) bad('event')
  } else if (tool === 'toolbox') {
    const rx = /^[a-z][a-z0-9-]{1,39}$/
    if (typeof args.key !== 'string' || !rx.test(args.key)) bad('key')
    if (has(args, 'topic') && (typeof args.topic !== 'string' || !rx.test(args.topic))) bad('topic')
    if (has(args, 'files') && typeof args.files !== 'boolean') bad('files')
  } else if (tool === 'savings') {
    if (has(args, 'detail') && !((schema.properties.detail as { enum: unknown[] }).enum).includes(args.detail)) bad('detail')
  } else if (tool === 'checkpoint_advice') {
    const p = args.context_pct
    if (!isNum(p) || p < 0 || p > 100) bad('context_pct')
    for (const k of COUNTER_ARGS) if (has(args, k) && (!isInt(args[k]) || (args[k] as number) < 0)) bad(k)
    if (has(args, 'event') && !((schema.properties.event as { enum: unknown[] }).enum).includes(args.event)) bad('event')
  }
}

function checkScope(scope: unknown, props: Ev): void {
  if (!isObj(scope)) bad('scope')
  for (const [k, v] of Object.entries(scope)) {
    const p = has(props, k) ? (props[k] as { type: string; enum?: unknown[]; minimum?: number; maximum?: number }) : null
    if (!p) bad(`scope.${k}`)
    const ok = p.enum ? p.enum.includes(v)
      : p.type === 'boolean' ? typeof v === 'boolean'
        : isInt(v) && (p.minimum === undefined || v >= p.minimum) && (p.maximum === undefined || v <= p.maximum)
    if (!ok) bad(`scope.${k}`)
  }
}

export function openAnswer(tool: string, args: unknown): Record<string, unknown> {
  const a = isObj(args) ? args : {}
  if (tool === 'router_advice') {
    return { decision: 'pass', model: null, effort: null, reason: null, hint: null, fallback: 'pass_through' }
  }
  if (tool === 'lesson_lookup') {
    return { role: a.role ?? null, phase: a.phase ?? null, version: null, catalog: '', items: [], fallback: 'no_served' }
  }
  if (tool === 'savings') return { saved: null, fallback: 'local_only', reason: 'core_down' }
  if (tool === 'checkpoint_advice') return { now: false, keep_lines: [], fallback: 'no_suggestion' }
  if (tool === 'toolbox') return { key: a.key ?? null, topic: a.topic ?? null, items: [], fallback: 'no_toolbox' }
  throw new ValidationError('unknown tool')
}


class Session {
  harness: string
  cwd: string | null
  transcript: string | null
  injectOn: string[]
  turns = 0
  toolCalls = 0
  todosDone = 0
  commits = 0
  todosLast = 0
  tasksDone = new Set<string>()
  base: number
  pendingContext: string[] | null = null
  advised = false
  restored = false
  inflight = false
  mainModel: string | null = null
  models = new Map<string, string>()
  routed = new Map<string, unknown>()
  dispatches: [unknown, unknown][] = []
  tableDue = true
  tablePointer = false

  constructor(harness: string, cwd: string | null = null, transcript: string | null = null, injectOn: string[] | null = null, now = 0) {
    this.harness = harness
    this.cwd = cwd
    this.transcript = transcript
    this.injectOn = injectOn ? [...injectOn] : ['prompt']
    this.base = now
  }

  reset(now: number): void {
    this.turns = this.toolCalls = this.todosDone = this.commits = 0
    this.base = now
    this.pendingContext = null
    this.advised = false
    this.restored = true
  }
}

export interface Guard {
  open(role: string): Promise<{ session_token: string; rule: unknown }>
  fetch(token: string, phase: string): Promise<{ version?: unknown; catalog?: unknown; items?: { id: unknown; text: unknown }[] }>
  close(token: string): unknown
  fetchToolbox?(token: string, key: string, topic?: string): Promise<Record<string, unknown>>
  fetchToolboxFiles?(token: string, key: string, version: string): Promise<ServedFile[]>
}

export type CoreOptions = {
  transport: Transport
  store: KV
  clock?: Clock
  random?: Random
  gated?: boolean
  guard?: Guard | null
  metrics?: { savings(): Promise<SvcResult> } | null
  status?: { update(): unknown } | null
  dashboard?: { onTurnEnd(): unknown; published(url: string): unknown; denied(): unknown } | null
  counters?: Omit<CountersOptions, 'clock' | 'random'>
  harness?: string
  kitFiles?: KitFilesOptions | null
}

const OFF: SvcResult = { ok: false, status: null, body: null, error: 'service_off' }

export class Core {
  readonly transport: Transport
  readonly store: KV
  readonly records: Records
  readonly counters: Counters
  readonly receipts: Receipts
  readonly summary = new SessionSummary()
  private readonly clock: Clock
  private readonly gated: boolean
  private readonly guard: Guard | null
  private readonly metrics: { savings(): Promise<SvcResult> } | null
  private readonly status: { update(): unknown } | null
  private readonly dashboard: CoreOptions['dashboard']
  private readonly kitFiles: KitFilesOptions | null
  private readonly sessionsMap = new Map<string, Session>()
  private lastSession: string | null = null
  private readonly noticed = new Set<string>()
  private readonly planNotices = new Map<string, string>()
  private readonly guardSessions = new Map<string, Promise<{ session_token: string; rule: unknown }>>()
  private readonly background = new Set<Promise<unknown>>()
  private helloAt: number | null = null
  private hello: Promise<unknown> | null = null
  private swept = false

  constructor(o: CoreOptions) {
    this.transport = o.transport
    this.store = o.store
    this.clock = o.clock ?? (() => Date.now())
    const random = o.random ?? ((n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n)))
    this.gated = o.gated !== false
    this.guard = o.guard ?? null
    this.metrics = o.metrics ?? null
    this.status = o.status ?? null
    this.dashboard = o.dashboard ?? null
    this.kitFiles = o.kitFiles ?? null
    this.records = new Records(o.transport, { store: o.store, random, harness: o.harness })
    setTableAsk(() => this.routingTable())
    this.counters = new Counters(o.store, { ...(o.counters ?? {}), clock: this.clock, random })
    this.receipts = new Receipts(() => this.now())
  }

  private now(): number {
    try {
      const t = Number(this.clock())
      return Number.isFinite(t) ? t / 1000 : Date.now() / 1000
    } catch {
      return Date.now() / 1000
    }
  }

  private spawn(fn: () => unknown): void {
    let p: Promise<unknown>
    try {
      p = Promise.resolve(fn()).catch(() => undefined)
    } catch {
      return
    }
    this.background.add(p)
    p.finally(() => this.background.delete(p))
  }

  async idle(): Promise<void> {
    while (this.background.size) await Promise.all([...this.background])
    await this.counters.flush()
  }

  async gateState(): Promise<GateState> {
    if (!this.gated) return { open: true, reason: null, minShell: null }
    try {
      const st = await this.transport.gateState()
      if (st && typeof st.open === 'boolean') {
        const g: GateState = { open: st.open, reason: st.reason ?? null, minShell: st.minShell ?? null }
        if (typeof st.retryAt === 'number') g.retryAt = st.retryAt
        return g
      }
    } catch {
    }
    return { open: false, reason: 'core_down', minShell: null }
  }

  private startHello(session: string | null, deadlineMs = HELLO_DEADLINE_MS): Promise<unknown> {
    if (this.hello) return this.hello
    this.helloAt = this.now()
    const p = (async () => {
      try {
        const r = await this.transport.handshake({ kind: 'hello', deadlineMs })
        if (session !== null && r && r.ok && isObj(r.body)) {
          const n = planNotice(r.body.plan)
          if (n) this.planNotices.set(session, n)
        }
      } catch {
      } finally {
        this.hello = null
      }
    })()
    this.hello = p
    this.spawn(() => p)
    return p
  }

  private helloDue(st: GateState): boolean {
    if (!this.gated || st.open) return false
    if (st.reason === 'unknown') return true
    if (st.reason !== 'unavailable' && st.reason !== 'unverified') return false
    if (this.helloAt === null || this.now() - this.helloAt >= GATE_RETRY_SECONDS) return true
    return typeof st.retryAt === 'number' && this.now() >= st.retryAt && this.helloAt < st.retryAt
  }

  private noticeOnce(session: string, notice: string | null): string | null {
    if (notice === null) return null
    if (this.noticed.has(session)) return null
    this.noticed.add(session)
    return notice
  }

  private closedAnswer(session: string, st: GateState): Answer {
    return answer('allow', { fallback: 'inactive', notice: this.noticeOnce(session, gateNotice(st, this.now())) })
  }

  async gate(refresh = false): Promise<{ open: boolean; reason: string | null; notice: string | null }> {
    if (!this.gated) return { open: true, reason: null, notice: null }
    const before = await this.gateState()
    if (refresh || this.helloDue(before)) await this.startHello(null, TOOL_DEADLINE_MS)
    const st = await this.gateState()
    return { open: st.open, reason: st.reason, notice: gateNotice(st, this.now()) }
  }

  modelOf(session: string, agent: string | null): string | null {
    const s = this.sessionsMap.get(session)
    return (agent === null ? s?.mainModel : s?.models.get(agent)) ?? null
  }

  sessions(): { session: string; harness: string; cwd: string | null; transcript: string | null }[] {
    return [...this.sessionsMap.entries()].map(([k, s]) => ({ session: k, harness: s.harness, cwd: s.cwd, transcript: s.transcript }))
  }

  private state(e: Ev): Session {
    const sid = e.session as string
    this.lastSession = sid
    let s = this.sessionsMap.get(sid)
    if (!s) this.sessionsMap.set(sid, (s = new Session(e.harness as string, null, null, null, this.now())))
    return s
  }

  async handle(event: unknown): Promise<Answer> {
    const out = await this.handleEvent(event)
    const kind = (event as Ev).kind
    if ((kind === 'session_start' || kind === 'turn_end') && this.status) {
      const st = this.status
      this.spawn(() => st.update())
    }
    return out
  }

  private async handleEvent(event: unknown): Promise<Answer> {
    validate(event)
    const kind = event.kind as string
    const sid = event.session as string
    if (kind === 'session_start') {
      const io = event.inject_on
      this.sessionsMap.set(sid, new Session(event.harness as string, (event.cwd as string | null) ?? null,
        (event.transcript as string | undefined) ?? null, nil(io) ? null : (io as string[]), this.now()))
    }
    if (!this.gated) return this.finish(kind, event, await this.run(kind, event))
    const st = await this.gateState()
    if (isAuthFail(st)) return this.passThrough(kind, sid)
    if (kind.startsWith('dashboard_')) return this.finish(kind, event, await this.run(kind, event))
    if (kind === 'session_start') this.startHello(sid)
    else if (this.helloDue(st)) this.startHello(null)
    if (!st.open) {
      if (kind === 'session_start') this.sweepOnce()
      const out = this.closedAnswer(sid, st)
      if (kind === 'session_end') {
        this.dropSession(sid)
        this.endCounters(sid)
      }
      return out
    }
    const raw = await this.run(kind, event)
    const after = await this.gateState()
    if (isAuthFail(after)) return this.passThrough(kind, sid)
    let out = this.finish(kind, event, raw)
    if (!after.open) out = this.closedAnswer(sid, after)
    if (kind === 'session_end') this.dropSession(sid)
    if (!after.open) return out
    const pn = this.planNotices.get(sid)
    if (pn !== undefined && !out.notice && kind !== 'session_end') {
      this.planNotices.delete(sid)
      out.notice = this.noticeOnce(sid, pn)
    }
    return out
  }

  private passThrough(kind: string, sid: string): Answer {
    if (kind === 'session_end') {
      this.dropSession(sid)
      this.sessionsMap.delete(sid)
    } else {
      const s = this.sessionsMap.get(sid)
      if (s) s.pendingContext = null
    }
    return answer()
  }

  private async run(kind: string, event: Ev): Promise<{ out: Answer; ok: boolean }> {
    try {
      return { out: await this.on(kind, event), ok: true }
    } catch {
      return { out: kind === 'dispatch' ? answer('allow', { fallback: 'pass_through' }) : answer(), ok: false }
    }
  }

  private finish(kind: string, event: Ev, r: { out: Answer; ok: boolean }): Answer {
    let out = r.out
    if (r.ok) {
      try {
        out = (this.receipts.stamp(event.session as string, kind, out) as Answer) ?? out
      } catch {
      }
    }
    const s = kind === 'dispatch' ? this.sessionsMap.get(event.session as string) : undefined
    return this.summary.after(kind, event, out, s ? s.mainModel : null) as Answer
  }

  private dropSession(sid: string): void {
    this.sessionsMap.delete(sid)
    this.noticed.delete(sid)
    this.planNotices.delete(sid)
    this.receipts.drop(sid)
    this.summary.drop(sid)
    this.closeGuard(sid)
  }

  private closeGuard(sid: string): void {
    for (const [k, p] of [...this.guardSessions.entries()]) {
      if (!k.startsWith(sid + '\n')) continue
      this.guardSessions.delete(k)
      const g = this.guard
      if (g) this.spawn(async () => g.close((await p).session_token))
    }
  }

  private guardSession(sid: string, role: string): Promise<{ session_token: string; rule: unknown }> {
    const k = sid + '\n' + role
    let p = this.guardSessions.get(k)
    if (!p) {
      const q = this.guard!.open(role)
      this.guardSessions.set(k, q)
      q.catch(() => {
        if (this.guardSessions.get(k) === q) this.guardSessions.delete(k)
      })
      p = q
    }
    return p
  }

  async servedGate(session: unknown, state: Record<string, unknown>): Promise<Record<string, unknown> | 'refused' | null> {
    if (!this.guard || typeof session !== 'string' || !session) return null
    try {
      const g = await this.guardSession(session, 'auto')
      return await this.guard.gate(g.session_token, state)
    } catch {
      return null
    }
  }

  private deliver(s: Session, e: Ev): Answer | null {
    if (e.agent !== null || !s.injectOn.includes(e.kind as string)) return null
    const ctx = s.pendingContext
    s.pendingContext = null
    if (ctx && ctx.length) {
      s.advised = true
      return answer('inject', { context: [...ctx], notice: CHECKPOINT_SHOWN })
    }
    return null
  }

  private on(kind: string, e: Ev): Promise<Answer> | Answer {
    switch (kind) {
      case 'session_start': return this.onSessionStart()
      case 'dispatch': return this.onDispatch(e)
      case 'dispatched': return this.onDispatched(e)
      case 'step': return this.onStep(e)
      case 'step_end': return this.onStepEnd(e)
      case 'pre_tool': return this.onPreTool(e)
      case 'post_tool': return this.onPostTool(e)
      case 'turn_end': return this.onTurnEnd(e)
      case 'prompt': return this.onPrompt(e)
      case 'compaction': return this.onCompaction(e)
      case 'clear': return this.onClear(e)
      case 'session_end': return this.onSessionEnd(e)
      case 'dashboard_published': return this.onDashboardPublished(e)
      case 'dashboard_denied': return this.onDashboardDenied()
    }
    throw new ValidationError('kind')
  }

  private onSessionStart(): Answer {
    this.sweepOnce()
    return answer()
  }

  private sweepOnce(): void {
    if (!this.swept) {
      this.swept = true
      this.spawn(() => sweep(this.store, this.clock()))
    }
  }

  private async onDispatch(e: Ev): Promise<Answer> {
    if (e.fork === true || e.teammate === true) return answer()
    const s = this.state(e)
    let r
    const explicit = explicitFor(e.call)
    try {
      const main = e.agent === null && typeof e.parent_model === 'string' && e.parent_model ? e.parent_model : s.mainModel
      r = await this.records.route(e.session, e.subagent_type, e.description, explicit.model, explicit.effort, s.cwd, e.harness, undefined,
        { main_model: main, user_asked_review: userAskedReview(), user_asked_override: userAskedOverride(), want_table: s.tableDue,
          plan_done: e.plan_done, prior_failures: e.prior_failures })
    } catch {
      return answer('allow', { fallback: 'pass_through' })
    }
    const notice = r.notice
    const fb = r.fallback
    noteCallBrief(e.call, r.brief_rule)
    const pointer = s.tablePointer && typeof r.table !== 'string' && r.decision !== 'deny'
      ? 'The routing table was given earlier in this session; /agent-services models table shows it again.' : null
    if (pointer !== null) s.tablePointer = false
    const routeText = [r.note, r.table, pointer].filter((x): x is string => typeof x === 'string' && x !== '').join('\n')
    if (r.decision === 'route') {
      s.dispatches.push([e.call, r.effort ?? null])
      if (s.dispatches.length > 64) s.dispatches.splice(0, s.dispatches.length - 64)
      noteCallRoute(e.call, routeText)
      if (typeof r.table === 'string') s.tableDue = false
      return answer('rewrite', { set: { model: r.model ?? null, effort: r.effort ?? null }, notice: typeof r.note === 'string' ? r.note : notice, fallback: fb })
    }
    if (r.decision === 'deny') {
      const reason = [r.note, (r.hint as string) || DENY_TEXT].filter((x): x is string => typeof x === 'string' && x !== '').join('\n')
      return answer('deny', { reason, notice, fallback: fb })
    }
    noteCallRoute(e.call, routeText)
    if (typeof r.table === 'string') s.tableDue = false
    if (!fb) noteRouteHint(r.hint)
    return answer('allow', { notice, fallback: fb })
  }

  routingTable(): Promise<string | null> {
    const session = this.lastSession
    if (session === null) return Promise.resolve(null)
    return this.records.table(session, { main_model: this.sessionsMap.get(session)?.mainModel ?? null, user_asked_review: userAskedReview(),
      user_asked_override: userAskedOverride() })
  }

  private onDispatched(e: Ev): Answer {
    const s = this.state(e)
    const i = s.dispatches.findIndex(([c]) => c === e.call)
    if (i >= 0) {
      const [, effort] = s.dispatches[i]!
      s.dispatches.splice(i, 1)
      s.routed.set(e.child as string, effort)
    }
    return answer()
  }

  private onStep(e: Ev): Answer {
    const agent = e.agent as string | null
    const s = this.state(e)
    if (typeof e.model === 'string') {
      if (agent === null) s.mainModel = e.model
      else s.models.set(agent, e.model)
    }
    const effort = agent !== null ? s.routed.get(agent) : undefined
    if (!nil(effort)) return answer('rewrite', { set: { effort } })
    return answer()
  }

  private onStepEnd(e: Ev): Answer {
    this.state(e)
    const u = e.usage as Record<string, number> | null
    if (e.agent === null && typeof e.model === 'string' && u !== null) {
      const model = e.model
      const sid = e.session as string
      this.spawn(() => this.counters.request(sid, model, { input: u.input!, cache_read: u.cache_read!, cache_write: u.cache_write! }))
    }
    return answer()
  }

  private onPreTool(e: Ev): Answer {
    const s = this.state(e)
    s.toolCalls += 1
    if (e.tool === 'Agent' || e.tool === 'Task') noteCallExplicit(e.call, e.input)
    return this.deliver(s, e) ?? answer()
  }

  private onPostTool(e: Ev): Answer {
    const s = this.state(e)
    if (e.ok === true) {
      const tool = e.tool
      const inp = e.input as Ev
      const cmd = inp.command
      if ((tool === 'Bash' || tool === 'PowerShell') && typeof cmd === 'string' && isCommit(cmd)) s.commits += 1
      const todos = inp.todos
      if (tool === 'TodoWrite' && Array.isArray(todos)) {
        const n = todos.filter((t) => isObj(t) && t.status === 'completed').length
        s.todosDone += Math.max(0, n - s.todosLast)
        s.todosLast = n
      }
      if ((tool === 'TaskUpdate' || tool === 'TaskCreate') && inp.status === 'completed') {
        const id = inp.taskId
        if (tool === 'TaskCreate') s.todosDone += 1
        else if ((typeof id === 'string' || typeof id === 'number') && !s.tasksDone.has(String(id))) {
          s.tasksDone.add(String(id))
          s.todosDone += 1
        }
      }
    }
    return this.deliver(s, e) ?? answer()
  }

  private onTurnEnd(e: Ev): Answer {
    const agent = e.agent as string | null
    const u = e.usage as Record<string, number> | null
    const s = this.state(e)
    const sid = e.session as string
    if (agent !== null && s.routed.has(agent)) {
      if (typeof e.model === 'string' && u !== null) {
        const model = e.model
        const main = s.mainModel
        this.spawn(() => this.counters.route(sid, model, { input: u.input!, output: u.output!, cache_read: u.cache_read!, cache_write: u.cache_write! }, main))
      }
      return answer()
    }
    if (agent !== null) return answer()
    if (this.dashboard) {
      try {
        this.dashboard.onTurnEnd()
      } catch {
      }
    }
    const ct = e.context_tokens
    const cw = e.context_window
    const pct = isInt(ct) && isInt(cw) && cw > 0 ? (100 * ct) / cw : 0
    s.turns += 1
    const turn = takeTurn()
    if (s.inflight) return answer()
    s.inflight = true
    const tokens = isInt(ct) && ct >= 0 ? ct : null
    this.spawn(() => this.checkpoint(s, sid, pct, tokens, turn))
    return answer()
  }

  private async keepCounts(s: Session, session: string): Promise<void> {
    try {
      const all = ((await this.store.get(CKPT_KEY)) ?? {}) as Record<string, Record<string, number>>
      const id = sha256Hex(new TextEncoder().encode('checkpoint:' + session)).slice(0, 16)
      const old = all[id]
      if (!s.restored && old && isInt(old.base) && old.base < s.base) {
        s.turns += isInt(old.turns) ? old.turns : 0
        s.toolCalls += isInt(old.tool_calls) ? old.tool_calls : 0
        s.todosDone += isInt(old.todos_done) ? old.todos_done : 0
        s.commits += isInt(old.commits) ? old.commits : 0
        s.base = old.base
      }
      s.restored = true
      const keep = Object.entries(all).filter(([k]) => k !== id)
        .sort((a, b) => (b[1].saved ?? 0) - (a[1].saved ?? 0)).slice(0, 49)
      const row = { base: s.base, turns: s.turns, tool_calls: s.toolCalls, todos_done: s.todosDone, commits: s.commits, saved: this.now() }
      await this.store.set(CKPT_KEY, Object.fromEntries([[id, row], ...keep]))
    } catch {
      s.restored = true
    }
  }

  private async checkpoint(s: Session, session: string, pct: number, tokens: number | null, turn: unknown = null): Promise<void> {
    try {
      await this.keepCounts(s, session)
      const counts: Record<string, number> = {
        context_pct: pct, turns: s.turns, tool_calls: s.toolCalls, todos_done: s.todosDone, commits: s.commits,
        minutes: Math.max(0, Math.floor((this.now() - s.base) / 60)),
      }
      if (tokens !== null) counts.context_tokens = tokens
      const r = await this.records.checkpoint(session, { ...counts, turn } as never)
      if (r && !r.fallback && r.note) adviceIn(r.note, r.cases)
      if (r && r.now === true && !r.fallback) {
        const tool = checkpointToolName()
        const note = tool ? CHECKPOINT_NOW.replace('the checkpoint tool', `the checkpoint tool (${tool})`) : CHECKPOINT_NOW
        if (!s.advised) s.pendingContext = [note]
      }
    } catch {
    } finally {
      s.inflight = false
    }
  }

  private onPrompt(e: Ev): Answer {
    const s = this.state(e)
    return this.deliver(s, e) ?? answer()
  }

  private async onCompaction(e: Ev): Promise<Answer> {
    const s = this.state(e)
    if (e.agent === null && e.done === true && e.trigger !== 'precompute' && !s.tableDue) s.tablePointer = true
    const mainModel = s.mainModel
    if (e.agent !== null || e.trigger === 'precompute' || e.done !== true) return answer()
    const ins = e.instructions
    const before = e.before
    const window = e.window
    const sid = e.session as string
    if (typeof ins === 'string' && ins.startsWith(CHECKPOINT_MARK) && isInt(before) && isInt(window) && typeof mainModel === 'string') {
      const cb = e.cost_before
      const ca = e.cost_after
      const usd = isNum(cb) && isNum(ca) ? pyRound(ca - cb, 6) : null
      let ref: string | null = null
      try {
        ref = await this.counters.compaction(sid, {
          model: mainModel, before, after: e.after as number | null, window, threshold: e.threshold as number | null, compact_usd: usd,
        })
      } catch {
        ref = null
      }
      if (ref !== null) this.receipts.note(sid, 'compaction')
    } else {
      try {
        await this.counters.stop(sid)
      } catch {
      }
    }
    s.reset(this.now())
    await this.keepCounts(s, sid)
    return answer()
  }

  private async onClear(e: Ev): Promise<Answer> {
    const s = this.state(e)
    try {
      await this.counters.stop(e.session as string)
    } catch {
    }
    s.reset(this.now())
    if (!s.tableDue) s.tablePointer = true
    await this.keepCounts(s, e.session as string)
    return answer()
  }

  private onDashboardPublished(e: Ev): Answer {
    if (this.dashboard) this.dashboard.published(e.url as string)
    return answer()
  }

  private onDashboardDenied(): Answer {
    if (this.dashboard) this.dashboard.denied()
    return answer()
  }

  private onSessionEnd(e: Ev): Answer {
    const sid = e.session as string
    try {
      this.transport.endServedSession(this.records.sessionRef(sid))
    } finally {
      this.sessionsMap.delete(sid)
      this.closeGuard(sid)
      this.endCounters(sid)
    }
    return answer()
  }

  private endCounters(sid: string): void {
    this.spawn(async () => {
      await this.counters.stop(sid).catch(() => undefined)
      await this.counters.flush()
    })
  }

  toolboxIndex(session: string): Promise<Record<string, unknown>> {
    return this.ask('toolbox', { key: 'index' }, { session, harness: 'claude-code' })
  }

  async ask(tool: string, args: unknown, o: { session: unknown; harness?: unknown; cwd?: unknown }): Promise<Record<string, unknown>> {
    checkArgs(tool, args)
    const session = o.session
    const harness = o.harness ?? 'other'
    const cwd = o.cwd ?? null
    if (typeof session !== 'string' || cpLen(session) < 1 || cpLen(session) > 200) bad('session')
    if (!HARNESSES.includes(harness as string)) bad('harness')
    if (cwd !== null && typeof cwd !== 'string') bad('cwd')
    const start = this.clock()
    const left = (): number => Math.max(0, TOOL_DEADLINE_MS - (this.clock() - start))
    if (this.gated) {
      const before = await this.gateState()
      if (!isAuthFail(before) && this.helloDue(before)) await this.startHello(null, left())
      const st = await this.gateState()
      if (!st.open) return { fallback: 'inactive', reason: st.reason }
    }
    try {
      return await this.answerTool(tool, args as Ev, session, harness as string, cwd as string | null, left)
    } catch {
      return openAnswer(tool, args)
    }
  }

  private async toolboxFiles(token: string, key: string, b: Record<string, unknown>, left: () => number): Promise<Record<string, unknown>> {
    const head = { key, title: b.title ?? null, version: b.version ?? null, fallback: null }
    const o = this.kitFiles
    const g = this.guard
    if (b.kind !== 'pack' || typeof b.version !== 'string') return { ...head, files: { status: 'no_files' } }
    if (!o || !g || typeof g.fetchToolboxFiles !== 'function') return { ...head, files: { status: 'unavailable' } }
    const version = b.version
    const job = kitJob(o, key, version, async () => (await onDisk(o, key, version)) ?? install(o, key, version, await g.fetchToolboxFiles!(token, key, version)))
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<null>((res) => { timer = setTimeout(() => res(null), Math.max(0, Math.min(o.waitMs ?? KIT_WAIT_MS, left() - 1500))) })
    try {
      const r: KitResult | null = await Promise.race([job, late])
      if (!r) return { ...head, files: { status: 'downloading', hint: 'The files are still downloading; call the toolbox tool again with files true in a moment.' } }
      return { ...head, files: filesAnswer(r, key) }
    } catch (e) {
      if (e instanceof KitFilesError) return { ...head, files: { status: 'failed', reason: e.reason } }
      const code = typeof (e as { code?: unknown })?.code === 'string' ? (e as { code: string }).code : 'failed'
      return { ...head, files: code === 'no_files' ? { status: 'no_files' } : { status: 'failed', reason: code } }
    } finally {
      clearTimeout(timer)
    }
  }

  private async answerTool(tool: string, args: Ev, session: string, harness: string, cwd: string | null,
    left: () => number): Promise<Record<string, unknown>> {
    if (tool === 'router_advice') {
      const r = await this.records.route(session, args.subagent_type, args.description, args.model ?? null, args.effort ?? null,
        cwd, harness, left(), { main_model: this.sessionsMap.get(session)?.mainModel ?? null, user_asked_review: userAskedReview(),
          user_asked_override: userAskedOverride(), scope: args.scope,
          want_table: args.table === true })
      const out: Record<string, unknown> = {
        decision: r.decision, model: r.model ?? null, effort: r.effort ?? null, reason: r.reason ?? null, hint: r.hint ?? null,
        fallback: r.fallback ?? null,
      }
      if (typeof r.brief_rule === 'string') out.brief_rule = r.brief_rule
      if (typeof r.brief_forward === 'string') out.brief_forward = r.brief_forward
      if (typeof r.note === 'string') out.note = r.note
      if (typeof r.table === 'string') out.table = r.table
      return out
    }
    if (tool === 'lesson_lookup') {
      const role = args.role as string
      const phase = args.phase as string
      const items = (b: { items?: unknown }): { id: unknown; text: unknown }[] => {
        const list = has(b as Ev, 'items') ? b.items : []
        if (!Array.isArray(list)) throw new ValidationError('items')
        return list.map((i: unknown) => {
          if (!isObj(i) || !has(i, 'id') || !has(i, 'text')) throw new ValidationError('items')
          return { id: i.id, text: i.text }
        })
      }
      if (this.guard) {
        const g = await this.guardSession(session, role)
        const b = await this.guard.fetch(g.session_token, phase, has(args, 'event') ? args.event as string : undefined)
        return { role, phase, version: b.version ?? null, catalog: has(b as Ev, 'catalog') ? b.catalog : '', items: items(b), rule: g.rule, fallback: null }
      }
      const res = await this.transport.fetchServed(this.records.sessionRef(session), role, phase, { kind: 'served', deadlineMs: left() },
        undefined, has(args, 'event') ? { event: args.event as string } : { jit: true })
      if (!res || !res.ok || !isObj(res.body)) return openAnswer(tool, args)
      const b = res.body
      return { role, phase, version: b.version ?? null, catalog: has(b, 'catalog') ? b.catalog : '', items: items(b), fallback: null }
    }
    if (tool === 'toolbox') {
      const co = companyKey(String(args.key ?? '')); if (co) return co
      if (!this.guard || typeof this.guard.fetchToolbox !== 'function') return openAnswer(tool, args)
      const g = await this.guardSession(session, 'auto')
      const b = await this.guard.fetchToolbox(g.session_token, args.key as string, has(args, 'topic') ? args.topic as string : undefined)
      if (args.files === true) return this.toolboxFiles(g.session_token, args.key as string, b, left)
      return args.key === 'index' ? companyIndex({ ...b, fallback: null }) as Record<string, unknown> : { ...b, fallback: null }
    }
    if (tool === 'savings') {
      const res = this.metrics ? await this.metrics.savings() : OFF
      if (res.ok) return args.detail === 'full' ? { saved: res.body, fallback: null, reason: null } : { saved: savingsSummary(res.body), detail: 'summary', fallback: null, reason: null }
      const reason = res.error || 'failed'
      return reason === 'service_off'
        ? { saved: null, fallback: 'local_only', reason, next: SAVINGS_OFF_NEXT }
        : { saved: null, fallback: 'local_only', reason }
    }
    const counts: Record<string, unknown> = { context_pct: args.context_pct }
    const s = this.sessionsMap.get(session)
    const own: Record<string, number> = s
      ? { turns: s.turns, tool_calls: s.toolCalls, todos_done: s.todosDone, commits: s.commits, minutes: Math.max(0, Math.floor((this.now() - s.base) / 60)) }
      : {}
    for (const k of COUNTER_ARGS) counts[k] = has(args, k) ? args[k] : own[k] ?? 0
    if (has(args, 'event')) counts.event = args.event
    const r = await this.records.checkpoint(session, counts as never, left())
    return { now: r.now, keep_lines: r.keep_lines, fallback: r.fallback }
  }
}
