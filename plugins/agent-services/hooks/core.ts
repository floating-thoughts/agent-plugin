// The in-process core (plan 3.1, module P4): the port of host/core.py. One neutral event (core/1) in, one answer
// out, keyed by session id; per-session state lives in memory only. It talks to the service only through the
// injected svc channel (engine_types.ts Transport), keeps the savings day counters in the store (counters.ts),
// builds the minimized route and checkpoint records (records.ts), and adds receipts (receipts.ts) and the session
// summary (summary.ts) to answers. Harness-neutral: nothing here touches `$`; the store, clock, random and file
// reads are injected. register.ts runs one Core per Claude Code session (P8).
//
// Differences from host/core.py, all from the hooks-module plan (section numbers below are its own):
// - Auth fail (3.9: gate reason 'login' or 'locked'): every event passes through untouched (answer() with every
//   field null, no notice), and no counter, receipt, summary, context injection or dashboard bookkeeping is made.
// - No hook waits on the network beyond its deadline (3.3 item 3): the hello at session_start and the retry of an
//   unknown or unreachable gate run in the background, so the event that started them is answered from the gate
//   as it was; the plan notice of that hello is given once on the session's next answer without a notice. A
//   dispatch's route call has 1 s, a tool answer 8 s in all; turn_end's checkpoint call is background work.
// - session_start's facts (harness, cwd, transcript, inject_on) are kept even while the gate is closed, so a
//   session whose gate opens later still sends its project hash.
// - The dependency gate reason is gone (no Python); the login and locked texts name /agent-services login.

import { TOOLS as CONTRACT_TOOLS, CONTRACT } from './contract'
import { Counters, sweep } from './counters'
import type { CountersOptions } from './counters'
import { Receipts } from './receipts'
import { Records } from './records'
import { SessionSummary } from './summary'
import type { Clock, GateState, KV, Random, ReadText, SvcResult, Transport } from './engine_types'

export const HARNESSES = ['claude-code', 'opencode', 'codex', 'cursor', 'gemini', 'other']
export const KINDS = ['session_start', 'dispatch', 'dispatched', 'step', 'step_end', 'pre_tool', 'post_tool', 'turn_end',
  'prompt', 'compaction', 'clear', 'session_end', 'dashboard_published', 'dashboard_denied']
export const INJECT_POINTS = ['prompt', 'pre_tool', 'post_tool']
export const GATE_RETRY_SECONDS = 300 // an unreachable server is tried again after this long (and at every session start)
export const ANSWER_KEYS = ['action', 'reason', 'set', 'context', 'notice', 'fallback'] as const
export const TOOL_DEADLINE_MS = 8000 // a tool answer in all (plan 3.3 item 3)
export const HELLO_DEADLINE_MS = 30000 // background
export const AUTH_FAIL_REASONS = ['login', 'locked'] // plan 3.9

export const CHECKPOINT_MARK = 'Checkpoint reached:'
export const CHECKPOINT_NOW = '[agent-services server note, not written by the user] The server suggests a checkpoint now: once this ' +
  'stretch is done, call the checkpoint tool and keep the items below in the summary.'
export const SAVINGS_OFF_NEXT = 'The savings report is off on this machine (it is opt-in): run /agent-services savings preview ' +
  'to see what it sends, then /agent-services savings on.' // the savings tool's `next` when reason is service_off
export const DENY_TEXT = 'This subagent dispatch did not pass the routing check. Rewrite it as the hint says, then dispatch again.'

// The sign-in lines of plan 3.9 (the tools answer only these while auth has failed; P5 shows them).
export const SIGN_IN_LINE = 'agent-services is paused: sign in with /agent-services login'
export const LOCKED_LINE = 'agent-services is paused: this account is locked; contact support, then sign in with /agent-services login'
export const GATE_NOTICES: Readonly<Record<string, string>> = {
  login: SIGN_IN_LINE,
  locked: LOCKED_LINE,
  upgrade: 'agent-services is paused: this plugin version is no longer accepted; update the plugin (minimum {min_shell}).',
  offline: 'agent-services is paused: offline mode is on.',
  unavailable: 'agent-services is paused: the server could not be reached; it tries again at the next session.',
  unverified: "agent-services is paused: an answer claiming to come from the server was not signed by the server's key " +
    '(a proxy or a fake server may be in the way); nothing it said was used. It tries again at the next session.',
}
export const PLAN_NOTICE = "agent-services: this account's plan does not include every service; the others run on their open " +
  'defaults. Plan changes happen on the account, with no reinstall.'

export const COMMIT_RX = new RegExp(
  `(?:^|[\\s;&|(])git(?:\\s+-[cC]\\s+(?:[^\\s"']|"[^"]*"|'[^']*')+|\\s+--?[A-Za-z][\\w-]*` +
  `(?:=(?:[^\\s"']|"[^"]*"|'[^']*')+)?)*\\s+commit(?![\\w-])`)
const SED_RX = /\bsed\s+-n\s+['"]?\d+,\d+p['"]?\s+("[^"]+"|'[^']+'|[^\s|;&>]+)/

const DEFS = (CONTRACT as unknown as { definitions: Record<string, { enum: string[] }> }).definitions
export const SERVED_ROLES: readonly string[] = DEFS.ServedRole!.enum
export const SERVED_PHASES: readonly string[] = DEFS.ServedPhase!.enum
// The four core tools with their schemas from the contract (x-tools); `status` is answered by the tools adapter.
export const CORE_TOOLS: ReadonlyMap<string, Record<string, unknown>> = new Map(
  CONTRACT_TOOLS.filter((t) => t.name !== 'status').map((t) => [t.name, t.input_schema]))
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

// ------------------------------------------------------------------ small checks

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

// Throw ValidationError unless `event` is a valid core/1 event.
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

export function gateNotice(state: GateState | null | undefined): string | null {
  if (!state || state.open) return null
  const text = GATE_NOTICES[state.reason ?? '']
  if (text === undefined) return null
  return text.replace('{min_shell}', state.minShell || 'unknown')
}

export const planNotice = (plan: unknown): string | null => (plan === 'guard' ? PLAN_NOTICE : null)
export const isAuthFail = (st: GateState): boolean => !st.open && AUTH_FAIL_REASONS.includes(st.reason ?? '')

// ------------------------------------------------------------------ tool arguments

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
  } else if (tool === 'lesson_lookup') {
    if (typeof args.role !== 'string' || !SERVED_ROLES.includes(args.role)) bad('role')
    if (typeof args.phase !== 'string' || !SERVED_PHASES.includes(args.phase)) bad('phase')
  } else if (tool === 'checkpoint_advice') {
    const p = args.context_pct
    if (!isNum(p) || p < 0 || p > 100) bad('context_pct')
    for (const k of COUNTER_ARGS) if (has(args, k) && (!isInt(args[k]) || (args[k] as number) < 0)) bad(k)
  }
}

// What a tool answers when the service cannot be reached (`args` already checked).
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
  throw new ValidationError('unknown tool')
}

// ------------------------------------------------------------------ paths for indexed reads (Windows semantics)

export function normPath(path: string): string {
  let s = path.replace(/\\/g, '/')
  const m = /^\/([a-zA-Z])\//.exec(s)
  if (m) s = m[1] + ':/' + s.slice(3)
  if (/^[a-z]:/.test(s)) s = s[0]!.toUpperCase() + s.slice(1)
  return s
}

const isAbsPath = (p: string): boolean => /^[A-Za-z]:\//.test(p) || p.startsWith('/')

// ntpath.normpath, written with forward slashes.
export function normpath(p: string): string {
  let s = p.replace(/\\/g, '/')
  let drive = ''
  if (/^[A-Za-z]:/.test(s)) {
    drive = s.slice(0, 2)
    s = s.slice(2)
  }
  const root = s.startsWith('/') ? '/' : ''
  const out: string[] = []
  for (const c of s.split('/')) {
    if (c === '' || c === '.') continue
    if (c === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (!root) out.push('..')
      continue
    }
    out.push(c)
  }
  const r = drive + root + out.join('/')
  return r || '.'
}

const joinPath = (a: string, b: string): string => (/[\\/]$/.test(a) || a === '' ? a + b : a + '/' + b)
const inDir = (dir: string, name: string): string => (dir.endsWith('/') ? dir + name : dir + '/' + name)

export async function indexed(file: string, readText: ReadText): Promise<boolean> {
  const parts = file.split('/')
  for (let i = parts.length - 1; i > 0; i--) {
    const d = parts.slice(0, i).join('/')
    const dd = !d || d.endsWith(':') ? d + '/' : d
    const rel = file.slice(d.length + 1)
    let text: string | null = null
    try {
      text = await readText(inDir(dd, 'DOCINDEX.md'))
    } catch {
      text = null
    }
    if (text !== null) {
      const t = text.replace(/\\/g, '/')
      if (t.includes(rel) || t.includes(file)) return true
    }
    let page: string | null = null
    try {
      page = await readText(inDir(dd, 'codeindex/files/' + rel.split('/').join('__') + '.md'))
    } catch {
      page = null
    }
    if (page !== null) return true
  }
  return false
}

// ------------------------------------------------------------------ the core

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
  base: number
  pendingContext: string[] | null = null
  advised = false // checkpoint advice delivered since the last reset: not sent again
  inflight = false
  mainModel: string | null = null
  models = new Map<string, string>() // agent id -> last step model
  routed = new Map<string, unknown>() // child agent id -> effort
  dispatches: [unknown, unknown][] = [] // [call, effort] routed, not yet linked

  constructor(harness: string, cwd: string | null = null, transcript: string | null = null, injectOn: string[] | null = null, now = 0) {
    this.harness = harness
    this.cwd = cwd
    this.transcript = transcript
    this.injectOn = injectOn ? [...injectOn] : ['prompt']
    this.base = now
  }

  reset(now: number): void {
    this.turns = this.toolCalls = this.todosDone = this.commits = 0
    this.todosLast = 0
    this.base = now
    this.pendingContext = null
    this.advised = false
  }
}

export interface Guard {
  open(role: string): Promise<{ session_token: string; rule: unknown }>
  fetch(token: string, phase: string): Promise<{ version?: unknown; catalog?: unknown; items?: { id: unknown; text: unknown }[] }>
  close(token: string): unknown
}

export type CoreOptions = {
  transport: Transport
  store: KV
  clock?: Clock // milliseconds
  random?: Random
  readText?: ReadText // indexed reads; none: no index-read credit
  gated?: boolean // false: the shell gate is not consulted (local tests, the paused adapters)
  guard?: Guard | null // served items reach the agent only wrapped by it (P5 guard.ts)
  metrics?: { savings(): Promise<SvcResult> } | null // P7 metrics.ts; none: savings answers service_off
  status?: { update(): unknown } | null // P6 status line, refreshed after session_start and turn_end
  dashboard?: { onTurnEnd(): unknown; published(url: string): unknown; denied(): unknown } | null // P6
  counters?: Omit<CountersOptions, 'clock' | 'random'>
  harness?: string
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
  private readonly readText: ReadText | null
  private readonly gated: boolean
  private readonly guard: Guard | null
  private readonly metrics: { savings(): Promise<SvcResult> } | null
  private readonly status: { update(): unknown } | null
  private readonly dashboard: CoreOptions['dashboard']
  private readonly sessionsMap = new Map<string, Session>()
  private readonly noticed = new Set<string>() // sessions whose one notice was already given
  private readonly planNotices = new Map<string, string>() // session -> plan notice waiting for an answer
  private readonly guardSessions = new Map<string, Promise<{ session_token: string; rule: unknown }>>() // session \n role
  private readonly background = new Set<Promise<unknown>>()
  private helloAt: number | null = null // seconds of the last handshake attempt
  private hello: Promise<unknown> | null = null
  private swept = false

  constructor(o: CoreOptions) {
    this.transport = o.transport
    this.store = o.store
    this.clock = o.clock ?? (() => Date.now())
    const random = o.random ?? ((n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n)))
    this.readText = o.readText ?? null
    this.gated = o.gated !== false
    this.guard = o.guard ?? null
    this.metrics = o.metrics ?? null
    this.status = o.status ?? null
    this.dashboard = o.dashboard ?? null
    this.records = new Records(o.transport, { store: o.store, random, harness: o.harness })
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

  // Background work (hello, checkpoint timing, counter writes, status refresh) never throws into an answer.
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

  // Every background task started so far (and the ones they start) done; for tests and session end.
  async idle(): Promise<void> {
    while (this.background.size) await Promise.all([...this.background])
    await this.counters.flush()
  }

  // ---------------- the shell gate (read through the svc channel)
  async gateState(): Promise<GateState> {
    if (!this.gated) return { open: true, reason: null, minShell: null }
    try {
      const st = await this.transport.gateState()
      if (st && typeof st.open === 'boolean') return { open: st.open, reason: st.reason ?? null, minShell: st.minShell ?? null }
    } catch {
      // fail closed
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
        // the channel records the gate itself
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
    return st.reason === 'unknown' || ((st.reason === 'unavailable' || st.reason === 'unverified')
      && (this.helloAt === null || this.now() - this.helloAt >= GATE_RETRY_SECONDS))
  }

  private noticeOnce(session: string, notice: string | null): string | null {
    if (notice === null) return null
    if (this.noticed.has(session)) return null
    this.noticed.add(session)
    return notice
  }

  private closedAnswer(session: string, st: GateState): Answer {
    return answer('allow', { fallback: 'inactive', notice: this.noticeOnce(session, gateNotice(st)) })
  }

  // {open, reason, notice}; refresh runs a handshake first (awaited, within the tool deadline).
  async gate(refresh = false): Promise<{ open: boolean; reason: string | null; notice: string | null }> {
    if (!this.gated) return { open: true, reason: null, notice: null }
    const before = await this.gateState()
    if (refresh || this.helloDue(before)) await this.startHello(null, TOOL_DEADLINE_MS)
    const st = await this.gateState()
    return { open: st.open, reason: st.reason, notice: gateNotice(st) }
  }

  // ---------------- registry
  sessions(): { session: string; harness: string; cwd: string | null; transcript: string | null }[] {
    return [...this.sessionsMap.entries()].map(([k, s]) => ({ session: k, harness: s.harness, cwd: s.cwd, transcript: s.transcript }))
  }

  private state(e: Ev): Session {
    const sid = e.session as string
    let s = this.sessionsMap.get(sid)
    if (!s) this.sessionsMap.set(sid, (s = new Session(e.harness as string, null, null, null, this.now())))
    return s
  }

  // ---------------- events
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
    if (kind.startsWith('dashboard_')) return this.finish(kind, event, await this.run(kind, event)) // local bookkeeping
    if (kind === 'session_start') this.startHello(sid)
    else if (this.helloDue(st)) this.startHello(null)
    if (!st.open) {
      const out = this.closedAnswer(sid, st)
      if (kind === 'session_end') this.dropSession(sid)
      return out
    }
    const raw = await this.run(kind, event)
    const after = await this.gateState()
    if (isAuthFail(after)) return this.passThrough(kind, sid) // a 401 or 423 during the event: nothing of it is kept
    let out = this.finish(kind, event, raw)
    if (!after.open) out = this.closedAnswer(sid, after) // the gate closed during the event
    if (kind === 'session_end') this.dropSession(sid)
    if (!after.open) return out
    const pn = this.planNotices.get(sid)
    if (pn !== undefined && !out.notice && kind !== 'session_end') {
      this.planNotices.delete(sid)
      out.notice = this.noticeOnce(sid, pn)
    }
    return out
  }

  // Auth fail (3.9): the event comes back untouched; only local cleanup at session end.
  private passThrough(kind: string, sid: string): Answer {
    if (kind === 'session_end') {
      this.dropSession(sid)
      this.sessionsMap.delete(sid)
    } else {
      const s = this.sessionsMap.get(sid) // advice queued before the failure is never injected after it
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
        // a receipt never breaks the answer
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
      p = this.guard!.open(role)
      this.guardSessions.set(k, p)
      p.catch(() => this.guardSessions.delete(k))
    }
    return p
  }

  private deliver(s: Session, e: Ev): Answer | null {
    if (e.agent !== null || !s.injectOn.includes(e.kind as string)) return null
    const ctx = s.pendingContext
    s.pendingContext = null
    if (ctx && ctx.length) {
      s.advised = true
      return answer('inject', { context: [...ctx] })
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
    if (!this.swept) {
      this.swept = true
      this.spawn(() => sweep(this.store, this.clock()))
    }
    return answer()
  }

  private async onDispatch(e: Ev): Promise<Answer> {
    if (e.fork === true || e.teammate === true) return answer()
    const s = this.state(e)
    let r
    try {
      r = await this.records.route(e.session, e.subagent_type, e.description, e.model, e.effort, s.cwd, e.harness)
    } catch {
      return answer('allow', { fallback: 'pass_through' })
    }
    const notice = r.notice
    const fb = r.fallback
    if (r.decision === 'route') {
      s.dispatches.push([e.call, r.effort ?? null])
      return answer('rewrite', { set: { model: r.model ?? null, effort: r.effort ?? null }, notice, fallback: fb })
    }
    if (r.decision === 'deny') {
      // the caller dispatches again after a deny, so the served speed-up rule rides on the deny reason
      const sep = '\n\n'
      const extra = [r.brief_rule, r.brief_forward].filter((x): x is string => typeof x === 'string').join(sep)
      const reason = (r.hint as string) || DENY_TEXT
      return answer('deny', { reason: reason + (extra ? sep + extra : ''), notice, fallback: fb })
    }
    return answer('allow', { notice, fallback: fb })
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
    return this.deliver(s, e) ?? answer()
  }

  private onPostTool(e: Ev): Answer {
    const s = this.state(e)
    if (e.ok === true) {
      const tool = e.tool
      const inp = e.input as Ev
      const cmd = inp.command
      if ((tool === 'Bash' || tool === 'PowerShell') && typeof cmd === 'string' && COMMIT_RX.test(cmd)) s.commits += 1
      const todos = inp.todos
      if (tool === 'TodoWrite' && Array.isArray(todos)) {
        const n = todos.filter((t) => isObj(t) && t.status === 'completed').length
        s.todosDone += Math.max(0, n - s.todosLast)
        s.todosLast = n
      }
      const model = (e.agent !== null ? s.models.get(e.agent as string) : undefined) || s.mainModel
      const cwd = s.cwd
      this.spawn(() => this.indexRead(e, cwd, model ?? null))
    }
    return this.deliver(s, e) ?? answer()
  }

  private async indexRead(e: Ev, cwd: string | null, model: string | null): Promise<void> {
    const readText = this.readText
    if (!readText) return
    const tool = e.tool
    const inp = e.input as Ev
    let path: string | null = null
    if (tool === 'Read' && typeof inp.file_path === 'string' && (!nil(inp.offset) || !nil(inp.limit))) {
      path = inp.file_path
    } else if (tool === 'Bash' && typeof inp.command === 'string') {
      const m = SED_RX.exec(inp.command)
      if (m) path = m[1]!.replace(/^["']|["']$/g, '')
    }
    if (!path) return
    let file = normPath(path)
    if (!isAbsPath(file)) {
      if (typeof cwd !== 'string') return
      file = normPath(normpath(joinPath(cwd, path)))
    } else if (/^[A-Za-z]:\//.test(file)) {
      file = normPath(normpath(file))
    }
    if (!model || !(await indexed(file, readText))) return
    const text = await readText(file)
    if (text === null) return
    await this.counters.index(e.session as string, model, { text: text.replace(/\r\n?/g, '\n') })
  }

  private onTurnEnd(e: Ev): Answer {
    const agent = e.agent as string | null
    const u = e.usage as Record<string, number> | null
    const s = this.state(e)
    const sid = e.session as string
    if (agent !== null && s.routed.has(agent)) {
      if (typeof e.model === 'string' && u !== null) {
        const model = e.model
        this.spawn(() => this.counters.route(sid, model, { input: u.input!, output: u.output!, cache_read: u.cache_read!, cache_write: u.cache_write! }))
      }
      return answer()
    }
    if (agent !== null) return answer()
    if (this.dashboard) {
      try {
        this.dashboard.onTurnEnd() // returns at once; at most one render per 10 minutes
      } catch {
        // never breaks the answer
      }
    }
    const ct = e.context_tokens
    const cw = e.context_window
    const pct = isInt(ct) && isInt(cw) && cw > 0 ? (100 * ct) / cw : 0
    s.turns += 1
    if (s.inflight) return answer()
    s.inflight = true
    const counts = {
      context_pct: pct, turns: s.turns, tool_calls: s.toolCalls, todos_done: s.todosDone, commits: s.commits,
      minutes: Math.max(0, Math.floor((this.now() - s.base) / 60)),
    }
    this.spawn(() => this.checkpoint(s, sid, counts))
    return answer()
  }

  private async checkpoint(s: Session, session: string, counts: Record<string, number>): Promise<void> {
    try {
      const r = await this.records.checkpoint(session, counts as never)
      if (r && r.now === true && !r.fallback) {
        const lines = (r.keep_lines ?? []).filter((x) => typeof x === 'string')
        if (!s.advised) s.pendingContext = [CHECKPOINT_NOW, ...lines] // once per stretch
      }
    } catch {
      // no suggestion
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
    const mainModel = s.mainModel
    if (e.agent !== null || e.trigger === 'precompute' || e.done !== true) return answer()
    const ins = e.instructions
    const before = e.before
    const window = e.window
    const sid = e.session as string
    if (typeof ins === 'string' && ins.startsWith(CHECKPOINT_MARK) && isInt(before) && isInt(window) && typeof mainModel === 'string') {
      const cb = e.cost_before
      const ca = e.cost_after
      const usd = isNum(cb) && isNum(ca) ? ca - cb : null
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
        // nothing open
      }
    }
    s.reset(this.now())
    return answer()
  }

  private async onClear(e: Ev): Promise<Answer> {
    const s = this.state(e)
    try {
      await this.counters.stop(e.session as string)
    } catch {
      // nothing open
    }
    s.reset(this.now())
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
      this.spawn(() => this.counters.flush())
    }
    return answer()
  }

  // ---------------- tools
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

  private async answerTool(tool: string, args: Ev, session: string, harness: string, cwd: string | null,
    left: () => number): Promise<Record<string, unknown>> {
    if (tool === 'router_advice') {
      const r = await this.records.route(session, args.subagent_type, args.description, args.model ?? null, args.effort ?? null,
        cwd, harness, left())
      const out: Record<string, unknown> = {
        decision: r.decision, model: r.model ?? null, effort: r.effort ?? null, reason: r.reason ?? null, hint: r.hint ?? null,
        fallback: r.fallback ?? null,
      }
      // the served speed-up rule and its forwarding instruction, when the server sent them
      if (typeof r.brief_rule === 'string') out.brief_rule = r.brief_rule
      if (typeof r.brief_forward === 'string') out.brief_forward = r.brief_forward
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
      if (this.guard) { // served items reach the agent only wrapped by the guard, with its rule
        const g = await this.guardSession(session, role)
        const b = await this.guard.fetch(g.session_token, phase)
        return { role, phase, version: b.version ?? null, catalog: has(b as Ev, 'catalog') ? b.catalog : '', items: items(b), rule: g.rule, fallback: null }
      }
      const res = await this.transport.fetchServed(this.records.sessionRef(session), role, phase, { kind: 'served', deadlineMs: left() })
      if (!res || !res.ok || !isObj(res.body)) return openAnswer(tool, args)
      const b = res.body
      return { role, phase, version: b.version ?? null, catalog: has(b, 'catalog') ? b.catalog : '', items: items(b), fallback: null }
    }
    if (tool === 'savings') {
      const res = this.metrics ? await this.metrics.savings() : OFF
      if (res.ok) return { saved: res.body, fallback: null, reason: null }
      const reason = res.error || 'failed'
      return reason === 'service_off'
        ? { saved: null, fallback: 'local_only', reason, next: SAVINGS_OFF_NEXT }
        : { saved: null, fallback: 'local_only', reason }
    }
    const counts: Record<string, unknown> = { context_pct: args.context_pct }
    for (const k of COUNTER_ARGS) counts[k] = has(args, k) ? args[k] : 0
    const r = await this.records.checkpoint(session, counts as never, left())
    return { now: r.now, keep_lines: r.keep_lines, fallback: r.fallback }
  }
}
