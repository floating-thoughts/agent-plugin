import type { EngineInterface, Register } from 'claude-code'
import { dataDir, declareCommand, denyReason, engineClaudeHash, engineDirs, isRemoved, MARKETPLACE, onboardingNote, pastedCode, routingOff, serveCommand, spawnLine } from './command'
import { Core, type Answer } from './core'
import { dashboardGrant, GRANT_REASON, PUBLISH_START_WAIT_MS } from './dashboard'
import { publishBoards } from './boss'
import { briefed, flowAfter, flowLock, flowPrompt, flowStart, flowTurnEnd, installFlow, withPending } from './flow'
import { Guard } from './guard'
import { FLUSH_EVERY_MS, Outbox } from './outbox'; import { PANEL_EVERY_MS } from './panel'
import { holdWrite, methodsStart, pushAgain, pushLessons, pushStart } from './phase'
import { PRICES } from './prices'
import { engineStore, type KV } from './store'
import { Svc, type HttpAnswer } from './svc'
import { engineSleep, installTools, SESSION_FALLBACK, svcAuthLine, toolInput } from './tools'
import { probeProcess, processRunner, updateCheck, type Gate } from './update'
import { bandSetter, createWiring, engineChunks, installBand, notePlan, svcTransport, type Wiring } from './wiring'
import { canAskNow } from './choice'
import { appendRow, denied, installEngines, mailGate, toolsStart, promptIn, recoverStep, recoverStepStart, recoverTurnEnd, rulesStart, spawnDenied, spawnGated, stopCheck, toolRun } from './engines'; import { budgetCheck, budgetSpawnCheck, budgetTurn } from './budget'; import { snapPromptStart, snapSessionEnd, snapSpawnStart, snapTurnEnd } from './snapshot'; import { spawnGate } from './subagents'; import { watchPrompt } from './watch'; import { spawnCap, spawnCutLine, spawnRun } from './spawn_run'; import { jobsClaim, jobsClaimScope } from './jobs_view'; import { handoverReceipts } from './evidence'; import { dispatchFacts } from './delegate'; import { resumeCompact, resumeSessionEnd, resumeSpawnCheck } from './resume'
import { noToolsDeny } from './ownership'

type Ev = Record<string, any>
type Usage = { input: number; output: number; cache_read: number; cache_write: number }
type Sleep = (ms: number) => Promise<unknown>
type Rt = {
  setStatus: (text: string) => void
  session: string
  svc: Svc
  core: Core
  wiring: Wiring
  outbox: Outbox
  store: KV
  dir: string
  sleep: Sleep
  readText: (path: string) => Promise<string | null>
}

export const HARNESS = 'claude-code'
export const START_WAIT_MS = 3000
export const EVENT_WAIT_MS = 6000
export const END_WAIT_MS = 1500
export const PROBE_WAIT_MS = 1500
export const STAMP_PATH = 'core/host/shell_stamp.json'

const usage = (u: Ev | null | undefined): Usage | null =>
  u ? { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cache_read: u.cache_read_input_tokens ?? 0, cache_write: u.cache_creation_input_tokens ?? 0 } : null

const maybe = async <T>(f: () => Promise<T> | T): Promise<T | null> => {
  try {
    return (await f()) ?? null
  } catch {
    return null
  }
}

const capped = <T>(p: Promise<T>, sleep: Sleep, ms: number, dflt: T): Promise<T> =>
  Promise.race([p.catch(() => dflt), Promise.resolve(sleep(ms)).then(() => dflt, () => dflt)])

const show = ($: EngineInterface, notice: string | null | undefined, toast = false) => {
  if (typeof notice !== 'string' || !notice) return
  try {
    $.ui.log(notice)
  } catch {}
  try {
    if (toast) $.ui.toast(notice)
  } catch {}
}

const updates = { marketplace: MARKETPLACE as string | null, selfUpdates: true }
let runtime: Promise<Rt | null> | null = null
let declared = false
let interactive = true
let resolveFirst: (r: Rt | null) => void = () => undefined
const first = new Promise<Rt | null>((resolve) => (resolveFirst = resolve))

function declare($: EngineInterface): void {
  if (declared) return
  declared = true
  void declareCommand($).catch(() => undefined)
}

async function shellVersion($: EngineInterface): Promise<string> {
  try {
    const stamp = JSON.parse(String(await $.fs.read(`${$.plugin.root}/${STAMP_PATH}`)))
    return typeof stamp?.shell === 'string' && stamp.shell ? stamp.shell : 'dev'
  } catch {
    return 'dev'
  }
}

const engineFetch = ($: EngineInterface) => async (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
): Promise<HttpAnswer> => {
  const r: any = await $.http.fetch(url, init as any)
  return { status: Number(r?.status), headers: (r?.headers ?? {}) as Record<string, string>, text: String(r?.text ?? '') }
}

const engineFs = ($: EngineInterface) => ({
  read: async (p: string): Promise<string> => String(await $.fs.read(p)), chunks: (p: string) => engineChunks($, p),
  write: async (p: string, text: string): Promise<void> => {
    await $.fs.write(p, text)
  },
  list: async (p: string) =>
    ((await $.fs.list(p)) as any[]).map((e) => ({ name: String(e.name), size: typeof e.size === 'number' ? e.size : undefined, dir: e.kind === 'dir', mtime: e.mtimeMs })),
})

async function build($: EngineInterface): Promise<Rt | null> {
  try {
    const id = await maybe(() => $.session.id())
    const session = typeof id === 'string' && id ? id : SESSION_FALLBACK
    const dir = await dataDir($)
    const dirs = await engineDirs($)
    const store = engineStore($)
    const sleep = engineSleep($)
    const now = () => Date.now()
    const fs = engineFs($)
    const readText = async (p: string) => maybe(async () => String(await $.fs.read(p)))
    const setStatus = (text: string): void => {
      try {
        $.ui.status(withPending(text))
      } catch {}
    }
    const outbox = new Outbox({ fs, dir: `${dir}/services/outbox`, session, now })
    const svc = new Svc({
      fetch: engineFetch($),
      store,
      now,
      sleep: async (ms) => void (await sleep(ms)),
      session,
      outbox,
      durable: { fs, dir },
      claudeHash: engineClaudeHash($),
      shellVersion: await shellVersion($),
      harness: HARNESS,
    })
    const transport = svcTransport(svc)
    const hasProcess = await capped(probeProcess($), sleep, PROBE_WAIT_MS, true)
    if (!hasProcess) updates.selfUpdates = false
    const wiring = createWiring({
      svc,
      store,
      fs,
      dataDir: dir,
      prices: PRICES,
      template: async () => maybe(async () => String(await $.fs.read(`${$.plugin.root}/dashboard/index.html`))),
      setStatus,
      setBand: bandSetter($),
      outbox,
      clock: now,
      projectsRoot: `${dirs.configDir}/projects`,
      holder: session, run: processRunner($, hasProcess === true),
      clientVersion: await shellVersion($),
      update: updates,
    })
    const core = new Core({
      transport,
      store,
      guard: new Guard({ transport }),
      readText,
      harness: HARNESS,
      ...wiring.coreOptions(),
    })
    for (const [ms, run] of [[FLUSH_EVERY_MS, () => void outbox.flush().catch(() => undefined)], [PANEL_EVERY_MS, () => void wiring.tick()]] as const) try { $.clock.every(ms, run) } catch {}
    return { setStatus, session, svc, core, wiring, outbox, store, dir, sleep, readText }
  } catch {
    return null
  }
}

function ready($: EngineInterface): Promise<Rt | null> {
  declare($); if (isRemoved()) return Promise.resolve(null)
  if (!runtime) {
    runtime = build($)
    void runtime.then((r) => { resolveFirst(r); if (!r) runtime = null; else void toolsStart($, r.svc) })
  }
  return runtime
}

async function send($: EngineInterface, kind: string, agent: string | null, fields: Ev = {}): Promise<Answer | null> {
  const r = await ready($)
  if (!r) return null
  if (kind === 'clear' || (kind === 'compaction' && fields.done === true && fields.trigger !== 'precompute')) pushAgain(r, agent)
  const event = { v: 1, harness: HARNESS, kind, session: r.session, agent, ...fields }
  return capped(r.core.handle(event), r.sleep, EVENT_WAIT_MS, null)
}

function background($: EngineInterface, r: Rt, interactive: boolean): void {
  void r.wiring.metricsTick().catch(() => undefined)
  void r.outbox.sweep().catch(() => undefined); void rulesStart($, r.svc, ready($)).catch(() => undefined)
  void pushStart(r).then(() => methodsStart($, r, interactive)).catch(() => undefined)
  const gate = async (): Promise<Gate> => {
    if ((await r.svc.authState()) !== 'ok') return 'closed'
    return (await r.svc.settings()).offline ? 'offline' : r.svc.gateState().reason === 'upgrade' ? 'upgrade' : 'open'
  }
  updateCheck($, interactive, gate, () => void (updates.selfUpdates = false))
}

export const register: Register = (on) => {
  installTools(on as any, {
    deps: async () => {
      const r = await (runtime ?? first)
      if (!r || isRemoved()) throw new Error('agent-services did not start')
      return { core: r.core as any, authLine: svcAuthLine(r.svc), sleep: r.sleep, outbox: r.outbox }
    },
  })

  serveCommand(on as any, async () => {
    const r = await (runtime ?? first)
    if (!r) throw new Error('agent-services did not start')
    return {
      svc: r.svc,
      outbox: r.outbox,
      dailyBody: (day) => r.wiring.previewBody(day), previewNote: () => r.wiring.previewNote(), refreshTime: () => r.wiring.refreshTime(), panel: () => r.wiring.panelLines(),
      clientVersion: r.wiring.clientVersion,
      marketplace: MARKETPLACE,
      selfUpdates: () => updates.selfUpdates,
    }
  }, () => {
    void runtime?.then((r) => r && r.wiring.refreshStatus()).catch(() => undefined)
  })
  installBand(on); installFlow(on); installEngines(on)

  on('session.start', async ($, e: Ev, next) => {
    declare($)
    const pending = ready($)
    const asking = canAskNow($, e.isInteractive)
    const out = await next(e); await flowStart($, ready($))
    const r = await pending
    interactive = await asking
    if (r) {
      const cwd = e.cwd ?? (await maybe(() => $.session.cwd())) ?? null
      const a = await capped(send($, 'session_start', null, { cwd, inject_on: ['prompt'] }), r.sleep, START_WAIT_MS, null)
      show($, a?.notice)
      background($, r, interactive)
    }
    return out
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e: Ev, next) => jobsClaimScope(e, async () => { const c = spawnCap(); try {
    const off = await c.stage('routing switch', routingOff($), true); const gate = off ? null : await c.stage('steps gate', spawnGate($, e, ready($)), null) ?? await c.stage('job claim', jobsClaim($, e, ready($)), null) ?? await c.stage('change budget', budgetSpawnCheck($, e, ready($)), null); if (gate) return c.stage('refusal record', spawnDenied($, e, gate, 'steps_gate', ready($)), { deny: gate }); await c.stage('snapshot', snapSpawnStart($, e, ready($)), undefined)
    const call = e.tool_use_id ?? null; await c.stage('replay check', resumeSpawnCheck($, e, ready($)), undefined)
    if (off) return spawnRun($, e, e, next, ready($), false, c); const agent = e.parentAgentId ?? null
    const a = await c.stage('routing request', send($, 'dispatch', agent, {
      subagent_type: e.subagentType,
      description: e.description,
      model: e.model ?? null, parent_model: e.parentModel ?? null,
      effort: e.effort ?? null,
      fork: e.fork === true,
      teammate: e.isTeammate === true,
      call, ...(await c.stage('dispatch facts', dispatchFacts($, agent), {})),
    }), null)
    show($, spawnLine(a))
    if (a?.action === 'deny') {
      return { deny: denyReason(a.reason) }
    }
    const base: Ev = a?.action === 'rewrite' && a.set ? { ...e, model: a.set.model } : e; const brief: Ev = await c.stage('brief', briefed($, a, base), base)
    const ev: Ev = await c.stage('background rule', spawnGated(brief), brief); const spawned: Ev = await spawnRun($, e, ev, next, ready($), true, c)
    if (spawned && typeof spawned.agentId === 'string') {
      show($, (await c.stage('dispatched record', send($, 'dispatched', agent, { call, child: spawned.agentId }), null, true))?.notice)
    }
    return spawned
  } finally { show($, spawnCutLine(c)) } })).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e: Ev, next) {
    const agent = e.agentId ?? null
    const model = e.model ?? null
    const a = await send($, 'step', agent, { model })
    show($, a?.notice)
    const se: Ev = a?.action === 'rewrite' && a.set ? { ...e, ...a.set } : e; recoverStepStart(se); const step: Ev = yield* next(se); recoverStep(se, step)
    show($, (await send($, 'step_end', agent, { model, usage: usage(step?.usage) }))?.notice)
    return step
  }).catch(async function* ($, e, next) {
    return yield* next(e)
  })

  on('tool.call', async ($, e: Ev, next) => {
    let rule = 'webmail'; const held = (await mailGate(e)) ?? ((rule = 'no_tools'), noToolsDeny(e)) ?? ((rule = 'plan_hold'), await holdWrite(ready($), e.tool, toolInput(e), () => $.session.cwd(), e.agentId)) ?? ((rule = 'project_lock'), await flowLock($, e, ready($))) ?? (await budgetCheck($, e, ready($)))
    if (held) return denied($, e, held, rule, ready($))
    const fields = { tool: e.tool, input: toolInput(e), call: e.tool_use_id ?? null }
    const agent = e.agentId ?? null
    const a = await send($, 'pre_tool', agent, fields)
    show($, a?.notice)
    if (a?.action === 'deny') {
      return denied($, e, denyReason(a.reason, 'tool check'), 'service_check', ready($))
    }
    const done: Ev = await toolRun($, e, next, ready($))
    await flowAfter($, e, ready($))
    show($, (await send($, 'post_tool', agent, { ...fields, ok: done?.deny === undefined && done?.isError !== true }))?.notice)
    return done
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e: Ev, next) => {
    const done = await next(e); budgetTurn(e); void snapTurnEnd($, e, ready($)); await flowTurnEnd($, e, ready($)); await recoverTurnEnd($, e, ready($))
    const u: Ev | null = await maybe(() => $.session.usage()); notePlan(u)
    const a = await send($, 'turn_end', e.agentId ?? null, {
      reason: e.reason ?? null,
      model: e.usage?.model ?? null,
      usage: usage(e.usage),
      context_tokens: u?.context?.tokens ?? null,
      context_window: u?.context?.window ?? null,
    })
    show($, a?.notice)
    const r = await ready($)
    if (r && !e.agentId) {
      const report = (session: string, kind: string, f: Record<string, unknown> = {}) =>
        r.core.handle({ v: 1, harness: HARNESS, kind, session, agent: null, ...f })
      const pub = publishBoards($, r.wiring, report, interactive).catch(() => undefined)
      await capped(pub, r.sleep, PUBLISH_START_WAIT_MS, undefined)
    }
    return done
  }).catch(($, e, next) => next(e))

  on('tool.check', { tool: ['Artifact', 'ArtifactData'] }, async ($, e: Ev, next) => {
    const granted = (next as any).origin?.plugin === $.plugin.name && (await dashboardGrant($, e.input, e.tool))
    if (!granted) return next(e)
    const v: Ev = await next(e)
    return v?.decision === 'deny' && (v.rule || v.hook || v.setting) ? v : { decision: 'allow', reason: GRANT_REASON }
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e: Ev, next) => {
    const signedIn = await pastedCode($, e); if (signedIn !== null) return { drop: signedIn }
    e = await promptIn($, e, ready($)); await snapPromptStart($, e, ready($))
    const a = await send($, 'prompt', e.agentId ?? null, { origin: e.origin?.kind ?? null })
    show($, a?.notice, a?.action === 'inject')
    const blocks = a?.action === 'inject' && a.context && a.context.length ? [a.context.join('\n')] : []
    blocks.push(...(await pushLessons(ready($), e.agentId, () => $.session.cwd())), ...(await flowPrompt($, e, ready($))), ...(await watchPrompt($, e)))
    const note = !e.agentId && (await ready($)) ? await onboardingNote($) : null
    if (note) blocks.push(note)
    return blocks.length ? next({ ...e, context: [...(e.context ?? []), ...blocks] }) : next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Stop', async ($, e: Ev, next) => stopCheck($, e, next)).catch(($, e, next) => next(e))
  on('session.append', async ($, e: Ev, next) => next(await appendRow($, e))).catch(($, e, next) => next(e))

  on('session.compact', async ($, e: Ev, next) => {
    const b: Ev | null = await maybe(() => $.session.usage()); await resumeCompact($, e, ready($), await handoverReceipts($, ready($)))
    const done: Ev = await next(e)
    const a: Ev | null = await maybe(() => $.session.usage({ breakdown: 'summary' }))
    const ans = await send($, 'compaction', e.agentId ?? null, {
      trigger: e.trigger ?? null,
      instructions: e.instructions ?? null,
      done: done?.skip === undefined,
      before: done?.tokensBefore ?? b?.context?.tokens ?? null,
      after: done?.tokensAfter ?? null,
      window: a?.context?.window ?? b?.context?.window ?? null,
      threshold: a?.context?.breakdown?.autoCompactThreshold ?? null,
      cost_before: b?.cost?.usd ?? null,
      cost_after: a?.cost?.usd ?? null,
    })
    show($, ans?.notice)
    return done
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'clear' }, async ($, e: Ev, next) => {
    const a = await send($, 'clear', null, {})
    const done = await next(e)
    show($, a?.notice)
    return done
  }).catch(($, e, next) => next(e))

  on('classic.SessionEnd', async ($, e: Ev, next) => {
    await snapSessionEnd($, ready($)); await resumeSessionEnd($, ready($), undefined, () => handoverReceipts($, ready($))); const a = await send($, 'session_end', null, {})
    show($, a?.notice, true)
    const r = await ready($)
    if (r) {
      await capped(Promise.all([r.core.idle(), r.wiring.idle()]).then(() => undefined), r.sleep, END_WAIT_MS, undefined)
      await capped(r.outbox.flush(), r.sleep, END_WAIT_MS, undefined)
    }
    return next(e)
  }).catch(($, e, next) => next(e))
}
