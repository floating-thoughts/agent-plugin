// The plugin's tools in Claude Code (plan 3.2, module P5): the port of host/mcp_server.py on the hooks engine.
// `$.tool.register` replaces .mcp.json and a `tool.call` hook answers each tool from the in-process core
// (core.ts) over the svc channel (svc.ts). P8 wires it into register.ts.
//
// Rules (plan 3.2, 3.3 item 3, 3.9):
// - registerTools($) issues every `$.tool.register` call, each with isDeferred: false, before it awaits anything,
//   and it touches nothing else of `$`. session.start calls it before its first slow await (store, fetch, file).
//   All five tools are registered every session: knowing whether the user is signed in takes a store read, which
//   must not come first, so in auth fail every tool answers the sign-in line instead of being left out.
// - Schemas and descriptions are the contract's x-tools (contract.ts TOOLS, generated); names become
//   mcp__agent-services__<name>.
// - Auth fail (no valid sign-in, or a 401 / 423 that did not recover): every tool, `status` included, answers
//   exactly the one sign-in line (the locked line for a locked account) and nothing is sent or logged. The core's
//   `inactive` answer with reason login or locked maps to the same line, and so does a credential that cannot be
//   read.
// - Signed in but the service is unreachable, cooling down or unverified: the tool's open default (port of
//   open_answer) with the gate's one-line reason as `notice`.
// - Each tool.call answers within TOOL_BUDGET_MS (the hook budget is about 10 s; fetch has a 30 s built-in timeout,
//   so the answer is raced against a deadline and the late work is dropped).
// - Registered tools never ask for permission (M0a), so no tool here does anything that needs consent; consent
//   steps (estimate send, savings on) live in the slash command.
// - Served text (lesson_lookup items, wrapped by guard.ts) only travels in the tool result: nothing here writes to
//   the store or a file, and the outbox gets only the tool name and the model's arguments.
// svcAuthLine at the end is harness-neutral: it never touches `$`. The core's Transport over svc.ts is wiring.ts
// svcTransport.
import type { EngineInterface, Register } from 'claude-code'
import { TOOLS as CONTRACT_TOOLS } from './contract'
import { AUTH_FAIL_REASONS, checkArgs, gateNotice, LOCKED_LINE, openAnswer, SIGN_IN_LINE } from './core'
import type { GateState } from './engine_types'

export const PLUGIN = 'agent-services'
export const TOOL_PREFIX = `mcp__${PLUGIN}__`
export const HARNESS = 'claude-code'
export const TOOL_BUDGET_MS = 7500 // one tool answer in all, inside the ~10 s hook budget
export const TIMEOUT_NOTICE = 'agent-services: the service did not answer in time, so this is the open default.'
export const PENDING_NOTICE = 'agent-services: the service cannot be used right now, so this is the open default.'
export const ERROR_NOTICE ='agent-services: this answer is the open default (the plugin could not finish the call).'
export const SESSION_FALLBACK = 'claude-code-session' // when the engine cannot tell the session id

export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown>; isDeferred: false }

/** What registerTools passes to `$.tool.register`, in the contract's order. */
export const TOOL_SPECS: readonly ToolSpec[] = CONTRACT_TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.input_schema,
  isDeferred: false as const,
}))

export const toolName = (name: string): string => TOOL_PREFIX + name

type Sleep = (ms: number) => Promise<unknown>
type On = (event: any, matcher: any, hook: any) => { catch(h: any): unknown }
type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** Register every tool. All `$.tool.register` calls are made before this returns (nothing is awaited between them),
 * so a caller that calls it first in session.start registers the tools before any slow await. Never throws. */
export function registerTools($: EngineInterface): Promise<unknown[]> {
  const pending: Promise<unknown>[] = []
  for (const spec of TOOL_SPECS) {
    try {
      pending.push(Promise.resolve(($ as any).tool.register(clone(spec))).catch(() => null))
    } catch {
      pending.push(Promise.resolve(null))
    }
  }
  return Promise.all(pending)
}

// ------------------------------------------------------------------ answering

/** The core as the tools use it (core.ts Core). */
export type ToolCore = {
  ask(tool: string, args: unknown, o: { session: unknown; harness?: unknown; cwd?: unknown }): Promise<Obj>
  gate(refresh?: boolean): Promise<{ open: boolean; reason: string | null; notice: string | null }>
  gateState(): Promise<GateState>
}

export type ToolDeps = {
  core: ToolCore
  /** The auth-fail line (3.9) or null while signed in; `fresh` re-reads the store now (else at most every 5 s). */
  authLine(fresh?: boolean): Promise<string | null>
  sleep: Sleep
  outbox?: { tool(name: string, args: unknown): void } | null
  harness?: string
  budgetMs?: number
}

export type ToolContext = { session: string; cwd: string | null }
export type ToolAnswer = { result: string; isError?: true }

/** JSON with every object's keys sorted (json.dumps(..., sort_keys=True), compact). */
export function render(v: unknown): string {
  const sort = (x: unknown): unknown =>
    Array.isArray(x) ? x.map(sort) : isObj(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])])) : x
  return JSON.stringify(sort(v)) ?? 'null'
}

/** The one line every tool answers in auth fail (3.9 item 1). */
export const authFailLine = (reason: string | null): string => (reason === 'locked' ? LOCKED_LINE : SIGN_IN_LINE)

type Mark = { authOk: boolean }

function fallback(name: string, args: unknown, notice: string, mark: Mark): ToolAnswer {
  if (!mark.authOk) return { result: SIGN_IN_LINE } // the sign-in could not be confirmed: fail closed
  if (name === 'status') return { result: render({ active: false, reason: notice === TIMEOUT_NOTICE ? 'timeout' : 'error', notice }) }
  let base: Obj = {}
  try {
    base = openAnswer(name, args)
  } catch {
    base = {}
  }
  return { result: render({ ...base, notice }) }
}

async function status(deps: ToolDeps): Promise<ToolAnswer> {
  const g = await deps.core.gate(true) // one handshake, as the MCP server's status tool did
  if (!g.open && AUTH_FAIL_REASONS.includes(g.reason ?? '')) return { result: authFailLine(g.reason) }
  return { result: render({ active: g.open, reason: g.reason, notice: g.notice }) }
}

async function respond(deps: ToolDeps, name: string, args: unknown, ctx: ToolContext, mark: Mark): Promise<ToolAnswer> {
  const line = await deps.authLine(false)
  if (line) return { result: line }
  mark.authOk = true
  try {
    deps.outbox?.tool(name, args)
  } catch {
    // the log never breaks a call
  }
  if (name === 'status') return status(deps)
  try {
    checkArgs(name, args)
  } catch (err) {
    return { result: `bad_request: ${err instanceof Error ? err.message : 'arguments'}`, isError: true }
  }
  const ask = () => deps.core.ask(name, args, { session: ctx.session, harness: deps.harness ?? HARNESS, cwd: ctx.cwd })
  let ans = await ask()
  const after = await deps.authLine(true) // a 401 or 423 during this call that did not recover
  if (after) return { result: after }
  if (ans.fallback === 'inactive' && AUTH_FAIL_REASONS.includes(typeof ans.reason === 'string' ? ans.reason : '')) {
    // the store says signed in (another session signed in again) while this session's channel still says
    // login or locked: one handshake reopens it (plan 3.9 item 5), then the call is answered again
    await deps.core.gate(true)
    ans = await ask()
  }
  if (ans.fallback === 'inactive') {
    const reason = typeof ans.reason === 'string' ? ans.reason : null
    if (AUTH_FAIL_REASONS.includes(reason ?? '')) return { result: authFailLine(reason) }
    let st: GateState = { open: false, reason, minShell: null }
    if (reason === 'upgrade') {
      try {
        const g = await deps.core.gateState()
        if (g.reason === 'upgrade') st = g
      } catch {
        // the notice then says "minimum unknown"
      }
    }
    return { result: render({ ...openAnswer(name, args), notice: gateNotice(st) ?? PENDING_NOTICE }) }
  }
  return { result: render(ans) }
}

const timerSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The deadline: the injected sleep, or a plain timer when that sleep fails.
function deadline(sleep: Sleep, ms: number): Promise<unknown> {
  try {
    return Promise.resolve(sleep(ms)).catch(() => timerSleep(ms))
  } catch {
    return timerSleep(ms)
  }
}

function race(work: Promise<ToolAnswer>, sleep: Sleep, budgetMs: number, late: () => ToolAnswer): Promise<ToolAnswer> {
  return Promise.race([work, deadline(sleep, budgetMs).then(late)])
}

/** One tool answer from resolved deps, within the budget. Never throws. */
export function answerTool(deps: ToolDeps, name: string, args: unknown, ctx: ToolContext): Promise<ToolAnswer> {
  const mark: Mark = { authOk: false }
  const work = respond(deps, name, args, ctx, mark).catch(() => fallback(name, args, ERROR_NOTICE, mark))
  return race(work, deps.sleep, deps.budgetMs ?? TOOL_BUDGET_MS, () => fallback(name, args, TIMEOUT_NOTICE, mark))
}

// ------------------------------------------------------------------ engine hooks

/** The tool input: the engine event without the engine's own fields (as register.ts `rest`). */
export function toolInput(e: unknown): Obj {
  if (!isObj(e)) return {}
  const { tool: _tool, agentId: _agentId, tool_use_id: _call, ...input } = e
  return input
}

export function engineSleep($: EngineInterface): Sleep {
  return (ms) => {
    try {
      return Promise.resolve($.clock.sleep(ms)).catch(() => timerSleep(ms))
    } catch {
      return timerSleep(ms)
    }
  }
}

async function maybe<T>(f: () => Promise<T> | T): Promise<T | null> {
  try {
    return (await f()) ?? null
  } catch {
    return null
  }
}

export type InstallOptions = {
  /** The answering side, built by the wiring (it may still be starting: the call waits for it within the budget). */
  deps: () => ToolDeps | Promise<ToolDeps>
  sleep?: Sleep
  budgetMs?: number
}

/** One tool.call for one of our tools. Never throws; answers within the budget. */
export function callTool($: EngineInterface, e: unknown, name: string, o: InstallOptions): Promise<ToolAnswer> {
  const mark: Mark = { authOk: false }
  const args = toolInput(e)
  const sleep = o.sleep ?? engineSleep($)
  const work = (async () => {
    const deps = await o.deps()
    const sid = await maybe(() => ($ as any).session.id())
    const session = typeof sid === 'string' && sid ? sid : SESSION_FALLBACK
    const cwd = await maybe(() => ($ as any).session.cwd())
    return respond(deps, name, args, { session, cwd: typeof cwd === 'string' ? cwd : null }, mark)
  })().catch(() => fallback(name, args, ERROR_NOTICE, mark))
  return race(work, sleep, o.budgetMs ?? TOOL_BUDGET_MS, () => fallback(name, args, TIMEOUT_NOTICE, mark))
}

/** The engine hooks of the tools: tool.call answers each one, tool.describe keeps it in front of tool search. */
export function installTools(on: On, o: InstallOptions): void {
  for (const spec of TOOL_SPECS) {
    const full = toolName(spec.name)
    on('tool.describe', { tool: full }, async ($: EngineInterface, e: Obj, next: (e: Obj) => Promise<Obj>) => ({
      ...(await next(e)),
      isDeferred: false,
    })).catch(($: EngineInterface, e: Obj, next: (e: Obj) => unknown) => next(e))
    on('tool.call', { tool: full }, ($: EngineInterface, e: Obj) => callTool($, e, spec.name, o)).catch(() => ({ result: ERROR_NOTICE }))
  }
}

// ------------------------------------------------------------------ svc.ts
// The core's Transport over svc.ts is wiring.ts svcTransport; the tools only need the auth-fail line.

/** ToolDeps.authLine over svc.ts Svc: the sign-in or locked line in auth fail, else null. */
export function svcAuthLine(svc: { authState(fresh?: boolean): Promise<'ok' | 'login' | 'locked'> }): (fresh?: boolean) => Promise<string | null> {
  return async (fresh = false) => {
    const st = await svc.authState(fresh)
    return st === 'ok' ? null : authFailLine(st)
  }
}
