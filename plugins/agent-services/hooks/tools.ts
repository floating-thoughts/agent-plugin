import type { EngineInterface, Register } from 'claude-code'
import { TOOLS as CONTRACT_TOOLS } from './contract'
import { AUTH_FAIL_REASONS, checkArgs, gateNotice, LOCKED_LINE, openAnswer, SIGN_IN_LINE } from './core'
import type { GateState } from './engine_types'
import { ORG_PAUSED_LINE } from './org'
import { NOTE_PREFIX } from './review'

export const PLUGIN = 'agent-services'
export const TOOL_PREFIX = `mcp__${PLUGIN}__`
export const HARNESS = 'claude-code'
export const TOOL_BUDGET_MS = 7500
export const TIMEOUT_NOTICE = `${NOTE_PREFIX}: the service did not answer in time, so this is the open default.`
export const PENDING_NOTICE = `${NOTE_PREFIX}: the service cannot be used right now, so this is the open default.`
export const ERROR_NOTICE =`${NOTE_PREFIX}: this answer is the open default (the plugin could not finish the call).`
export const SESSION_FALLBACK = 'claude-code-session'


export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown>; isDeferred: true }

export const TOOL_SPECS: readonly ToolSpec[] = CONTRACT_TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.input_schema,
  isDeferred: true as const,
}))

export const toolName = (name: string): string => TOOL_PREFIX + name

type Sleep = (ms: number) => Promise<unknown>
type On = (event: any, matcher: any, hook: any) => { catch(h: any): unknown }
type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

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


export type ToolCore = {
  ask(tool: string, args: unknown, o: { session: unknown; harness?: unknown; cwd?: unknown }): Promise<Obj>
  gate(refresh?: boolean): Promise<{ open: boolean; reason: string | null; notice: string | null }>
  gateState(): Promise<GateState>
}

export type ToolDeps = {
  core: ToolCore
  authLine(fresh?: boolean): Promise<string | null>
  sleep: Sleep
  outbox?: { tool(name: string, args: unknown): void } | null
  harness?: string
  budgetMs?: number
}

export type ToolContext = { session: string; cwd: string | null }
export type ToolAnswer = { result: string; isError?: true }

export function render(v: unknown): string {
  const sort = (x: unknown): unknown =>
    Array.isArray(x) ? x.map(sort) : isObj(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])])) : x
  return JSON.stringify(sort(v)) ?? 'null'
}

export const authFailLine = (reason: string | null): string =>
  reason === 'locked' ? LOCKED_LINE : reason === 'paused' ? ORG_PAUSED_LINE : SIGN_IN_LINE

type Mark = { authOk: boolean }

function fallback(name: string, args: unknown, notice: string, mark: Mark): ToolAnswer {
  if (!mark.authOk) return { result: SIGN_IN_LINE }
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
  const g = await deps.core.gate(true)
  if (!g.open && AUTH_FAIL_REASONS.includes(g.reason ?? '')) return { result: (await deps.authLine(true).catch(() => null)) ?? authFailLine(g.reason) }
  return { result: render({ active: g.open, reason: g.reason, notice: g.notice }) }
}

async function respond(deps: ToolDeps, name: string, args: unknown, ctx: ToolContext, mark: Mark): Promise<ToolAnswer> {
  const line = await deps.authLine(false)
  if (line) return { result: line }
  mark.authOk = true
  try {
    deps.outbox?.tool(name, args)
  } catch {
  }
  if (name === 'status') return status(deps)
  try {
    checkArgs(name, args)
  } catch (err) {
    return { result: `bad_request: ${err instanceof Error ? err.message : 'arguments'}`, isError: true }
  }
  const ask = () => deps.core.ask(name, args, { session: ctx.session, harness: deps.harness ?? HARNESS, cwd: ctx.cwd })
  let ans = await ask()
  const after = await deps.authLine(true)
  if (after) return { result: after }
  if (ans.fallback === 'inactive' && AUTH_FAIL_REASONS.includes(typeof ans.reason === 'string' ? ans.reason : '')) {
    await deps.core.gate(true)
    ans = await ask()
  }
  if (ans.fallback === 'inactive') {
    const reason = typeof ans.reason === 'string' ? ans.reason : null
    if (AUTH_FAIL_REASONS.includes(reason ?? '')) return { result: (await deps.authLine(true).catch(() => null)) ?? authFailLine(reason) }
    let st: GateState = { open: false, reason, minShell: null }
    if (reason === 'upgrade') {
      try {
        const g = await deps.core.gateState()
        if (g.reason === 'upgrade') st = g
      } catch {
      }
    }
    return { result: render({ ...openAnswer(name, args), notice: gateNotice(st) ?? PENDING_NOTICE }) }
  }
  return { result: render(ans) }
}

const timerSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

export function answerTool(deps: ToolDeps, name: string, args: unknown, ctx: ToolContext): Promise<ToolAnswer> {
  const mark: Mark = { authOk: false }
  const work = respond(deps, name, args, ctx, mark).catch(() => fallback(name, args, ERROR_NOTICE, mark))
  return race(work, deps.sleep, deps.budgetMs ?? TOOL_BUDGET_MS, () => fallback(name, args, TIMEOUT_NOTICE, mark))
}


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
  deps: () => ToolDeps | Promise<ToolDeps>
  sleep?: Sleep
  budgetMs?: number
}

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

export function installTools(on: On, o: InstallOptions): void {
  for (const spec of TOOL_SPECS) {
    const full = toolName(spec.name)
    on('tool.describe', { tool: full }, async ($: EngineInterface, e: Obj, next: (e: Obj) => Promise<Obj>) => ({
      ...(await next(e)),
      isDeferred: true,
    })).catch(($: EngineInterface, e: Obj, next: (e: Obj) => unknown) => next(e))
    on('tool.call', { tool: full }, ($: EngineInterface, e: Obj) => callTool($, e, spec.name, o)).catch(() => ({ result: ERROR_NOTICE }))
  }
}


export function svcAuthLine(svc: { authLine(fresh?: boolean): Promise<string | null> }): (fresh?: boolean) => Promise<string | null> {
  return (fresh = false) => svc.authLine(fresh)
}
