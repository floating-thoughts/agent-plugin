// agent-services Claude Code adapter (plan 3.1, module P8): the engine's hooks wired to the in-process core.
// Nothing here talks to a local process: the core (core.ts), the svc channel (svc.ts), the tools (tools.ts), the slash
// command (command.ts), the status line, dashboard, metrics and estimate (wiring.ts), the dashboard publish
// (dashboard.ts) and the self-update (update.ts) all run in this module, one instance per Claude Code session.
//
// Rules kept here:
// - session.start registers the tools and the slash command first, before anything is awaited (plan 3.2 item 1);
//   the rest is built after, and every network step (hello, plan, rotation, metrics, migration) runs in the
//   background, so no hook comes near the ~10 s budget. Every other hook waits at most a fixed time for the core
//   and otherwise passes the event through untouched.
// - Each engine hook becomes one or two core/1 events; the core's answer is applied as before (deny, rewrite,
//   inject, notice). While auth has failed (3.9) the core answers pass-through, so every event goes on unchanged.
// - The first session.start of this release runs the one-time move from the Python core (migrate.ts) in the
//   background; it never starts or kills a process.
// - Nothing here writes the user's settings or permission rules ($.settings is read only).
import type { EngineInterface, Register } from 'claude-code'
import { dataDir, declareCommand, engineClaudeHash, engineDirs, MARKETPLACE, onboardingNote, serveCommand } from './command'
import { Core, type Answer } from './core'
import { dashboardGrant, GRANT_REASON, PUBLISH_START_WAIT_MS, publishDashboard } from './dashboard'
import { Guard } from './guard'
import { migrate, OLD_SIGNIN_KEY, OLD_SIGNIN_LINE } from './migrate'
import { FLUSH_EVERY_MS, Outbox } from './outbox'
import { holdWrite, lessonHold, pushLessons, pushStart } from './phase'
import { PRICES } from './prices'
import { engineStore, safeDelete, safeGet, type KV } from './store'
import { Svc, type HttpAnswer } from './svc'
import { engineSleep, installTools, registerTools, SESSION_FALLBACK, svcAuthLine } from './tools'
import { probeProcess, selfUpdate, type Gate } from './update'
import { createWiring, svcTransport, type Wiring } from './wiring'

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
export const START_WAIT_MS = 3000 // session.start waits this long at most for the core's first answer
export const EVENT_WAIT_MS = 6000 // any other hook: the core's answer (a dispatch has its own 1 s inside)
export const END_WAIT_MS = 2500 // session end: background work, then again for the outbox write
export const PROBE_WAIT_MS = 1500 // the $.process probe (it runs nothing)
export const STAMP_PATH = 'core/host/shell_stamp.json' // under the plugin root: the export's version stamp

const usage = (u: Ev | null | undefined): Usage | null =>
  u
    ? {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cache_read: u.cache_read_input_tokens ?? 0,
        cache_write: u.cache_creation_input_tokens ?? 0,
      }
    : null

// The tool input: the engine event without the engine's own fields.
const rest = (e: Ev): Ev => {
  const { tool: _tool, agentId: _agentId, tool_use_id: _call, ...input } = e
  return input
}

// An engine lookup that may fail: null then.
const maybe = async <T>(f: () => Promise<T> | T): Promise<T | null> => {
  try {
    return (await f()) ?? null
  } catch {
    return null
  }
}

// `p`, or `dflt` once `ms` have passed (the late work goes on in the background, its result unused).
const capped = <T>(p: Promise<T>, sleep: Sleep, ms: number, dflt: T): Promise<T> =>
  Promise.race([p.catch(() => dflt), Promise.resolve(sleep(ms)).then(() => dflt, () => dflt)])

// A notice is a dim transcript line. The session summary at exit is also a toast: a line logged as the session
// ends may never be drawn. Both are best effort.
const show = ($: EngineInterface, notice: string | null | undefined, toast = false) => {
  if (typeof notice !== 'string' || !notice) {
    return
  }
  try {
    $.ui.log(notice)
  } catch {}
  try {
    if (toast) $.ui.toast(notice)
  } catch {}
}

// ------------------------------------------------------------------ the session's runtime, built once

// The status line's update hint: selfUpdates turns false once update.ts finds no $.process here (plan 3.8).
const updates = { marketplace: MARKETPLACE as string | null, selfUpdates: true }

let runtime: Promise<Rt | null> | null = null
let declared = false
let interactive = true // session.start's isInteractive (false in a -p run: no consent dialog)
let resolveFirst: (r: Rt | null) => void = () => undefined
const first = new Promise<Rt | null>((resolve) => (resolveFirst = resolve))

// The tools and the command, before anything is awaited (also when a hook other than session.start comes first,
// say after /reload-plugins).
function declare($: EngineInterface): void {
  if (declared) return
  declared = true
  void registerTools($)
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
  read: async (p: string): Promise<string> => String(await $.fs.read(p)),
  write: async (p: string, text: string): Promise<void> => {
    await $.fs.write(p, text)
  },
  list: async (p: string) =>
    ((await $.fs.list(p)) as any[]).map((e) => ({ name: String(e.name), size: typeof e.size === 'number' ? e.size : undefined, dir: e.kind === 'dir' })),
})

// The status line after session_start and turn_end; once after a new sign-in, the old-sign-in line of the migration.
async function refreshStatus(setStatus: (text: string) => void, w: Wiring, store: KV): Promise<void> {
  const old = async () => (await w.authState()) === 'ok' && (await safeGet(store, OLD_SIGNIN_KEY)) === true && (await safeDelete(store, OLD_SIGNIN_KEY))
  await w.refreshStatus(async () => ((await old()) ? (setStatus(OLD_SIGNIN_LINE), true) : false))
}

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
        $.ui.status(text)
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
      claudeHash: engineClaudeHash($),
      shellVersion: await shellVersion($),
      harness: HARNESS,
    })
    const transport = svcTransport(svc)
    // no $.process here: update.ts runs nothing, and the status line shows the terminal update command (plan 3.8)
    if (!(await capped(probeProcess($), sleep, PROBE_WAIT_MS, true))) updates.selfUpdates = false
    const wiring = createWiring({
      svc,
      store,
      fs,
      dataDir: dir,
      prices: PRICES,
      template: async () => maybe(async () => String(await $.fs.read(`${$.plugin.root}/dashboard/index.html`))),
      setStatus,
      outbox,
      clock: now,
      projectsRoot: `${dirs.configDir}/projects`,
      holder: session,
      update: updates,
    })
    const core = new Core({
      transport,
      store,
      guard: new Guard({ transport }),
      readText,
      harness: HARNESS,
      ...wiring.coreOptions(),
      status: { update: () => refreshStatus(setStatus, wiring, store) },
    })
    try {
      $.clock.every(FLUSH_EVERY_MS, () => void outbox.flush().catch(() => undefined))
    } catch {}
    return { setStatus, session, svc, core, wiring, outbox, store, dir, sleep, readText }
  } catch {
    return null
  }
}

function ready($: EngineInterface): Promise<Rt | null> {
  declare($)
  if (!runtime) {
    runtime = build($)
    void runtime.then(resolveFirst)
  }
  return runtime
}

// One core/1 event of this session; null (pass the event through) when the core is not there or too slow.
async function send($: EngineInterface, kind: string, agent: string | null, fields: Ev = {}): Promise<Answer | null> {
  const r = await ready($)
  if (!r) return null
  const event = { v: 1, harness: HARNESS, kind, session: r.session, agent, ...fields }
  return capped(r.core.handle(event), r.sleep, EVENT_WAIT_MS, null)
}

// Session-start background: metrics upload, savings lines (startNotices), outbox sweep, migration, self-update.
function background($: EngineInterface, r: Rt, interactive: boolean): void {
  void r.wiring.metricsTick().catch(() => undefined)
  void r.wiring.startNotices().then((lines) => lines.forEach((line) => show($, line, true))).catch(() => undefined)
  void r.outbox.sweep().catch(() => undefined)
  void pushStart(r) // phase.ts: the plan-phase served items, for the first prompt
  void migrate({
    dataDir: r.dir,
    fs: engineFs($),
    fetch: engineFetch($),
    store: r.store,
    now: () => Date.now(),
    sleep: r.sleep,
    isLong: (model, prompt) => r.wiring.isLong(model, prompt),
    log: (line) => show($, line),
  }).catch(() => undefined)
  const gate = async (): Promise<Gate> => {
    if ((await r.svc.authState()) !== 'ok') return 'closed'
    return r.svc.gateState().reason === 'upgrade' ? 'upgrade' : 'open'
  }
  // update.ts, later; without $.process it runs nothing and the status line and status show the terminal command
  selfUpdate($, interactive, gate, () => void (updates.selfUpdates = false))
}

export const register: Register = (on) => {
  installTools(on as any, {
    deps: async () => {
      const r = await (runtime ?? first)
      if (!r) throw new Error('agent-services did not start')
      return { core: r.core as any, authLine: svcAuthLine(r.svc), sleep: r.sleep, outbox: r.outbox, lessonHold: lessonHold(r.readText) }
    },
  })

  serveCommand(on as any, async () => {
    const r = await (runtime ?? first)
    if (!r) throw new Error('agent-services did not start')
    return {
      svc: r.svc,
      outbox: r.outbox,
      prices: PRICES,
      dailyBody: (day) => r.wiring.dailyBody(day),
      marketplace: MARKETPLACE,
      selfUpdates: () => updates.selfUpdates,
    }
  }, () => {
    void runtime?.then((r) => r && refreshStatus(r.setStatus, r.wiring, r.store)).catch(() => undefined)
  })

  on('session.start', async ($, e: Ev, next) => {
    declare($)
    const pending = ready($)
    interactive = e.isInteractive !== false
    const out = await next(e)
    const r = await pending
    if (r) {
      const cwd = e.cwd ?? (await maybe(() => $.session.cwd())) ?? null
      const a = await capped(send($, 'session_start', null, { cwd, inject_on: ['prompt'] }), r.sleep, START_WAIT_MS, null)
      show($, a?.notice)
      background($, r, e.isInteractive === true)
    }
    return out
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e: Ev, next) => {
    const agent = e.parentAgentId ?? null
    const call = e.tool_use_id ?? null
    const a = await send($, 'dispatch', agent, {
      subagent_type: e.subagentType,
      description: e.description,
      model: e.model ?? null,
      effort: e.effort ?? null,
      fork: e.fork === true,
      teammate: e.isTeammate === true,
      call,
    })
    show($, a?.notice)
    if (a?.action === 'deny') {
      return { deny: a.reason }
    }
    const spawned: Ev = await next(a?.action === 'rewrite' && a.set ? { ...e, model: a.set.model } : e)
    if (spawned && typeof spawned.agentId === 'string') {
      show($, (await send($, 'dispatched', agent, { call, child: spawned.agentId }))?.notice)
    }
    return spawned
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e: Ev, next) {
    const agent = e.agentId ?? null
    const model = e.model ?? null
    const a = await send($, 'step', agent, { model })
    show($, a?.notice)
    const step: Ev = yield* next(a?.action === 'rewrite' && a.set ? { ...e, ...a.set } : e)
    show($, (await send($, 'step_end', agent, { model, usage: usage(step?.usage) }))?.notice)
    return step
  }).catch(async function* ($, e, next) {
    return yield* next(e)
  })

  on('tool.call', async ($, e: Ev, next) => {
    const held = await holdWrite(ready($), e.tool, rest(e), () => $.session.cwd()) // phase.ts, signed in only
    if (held) return { deny: held }
    const fields = { tool: e.tool, input: rest(e), call: e.tool_use_id ?? null }
    const agent = e.agentId ?? null
    const a = await send($, 'pre_tool', agent, fields)
    show($, a?.notice)
    if (a?.action === 'deny') {
      return { deny: a.reason }
    }
    const done: Ev = await next(a?.action === 'rewrite' && a.set ? { ...e, ...a.set } : e)
    show($, (await send($, 'post_tool', agent, { ...fields, ok: done?.deny === undefined && done?.isError !== true }))?.notice)
    return done
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e: Ev, next) => {
    const done = await next(e)
    const u: Ev | null = await maybe(() => $.session.usage())
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
      // the publish starts inside this hook (awaited up to 4 s): a $ call after it returns skips our tool.check grant
      const report = (session: string, kind: string, f: Record<string, unknown> = {}) =>
        r.core.handle({ v: 1, harness: HARNESS, kind, session, agent: null, ...f })
      const pub = r.wiring.publish((note) => publishDashboard($, report, { interactive, note })).catch(() => undefined)
      await capped(pub, r.sleep, PUBLISH_START_WAIT_MS, undefined)
    }
    return done
  }).catch(($, e, next) => next(e))

  // On the user's consent, this plugin's own dashboard call (dashboard.ts dashboardGrant) is allowed without a rule;
  // a deny from the user's own rule or hook stands, and every other call goes on unchanged.
  on('tool.check', { tool: 'Artifact' }, async ($, e: Ev, next) => {
    const granted = (next as any).origin?.plugin === $.plugin.name && (await dashboardGrant($, e.input))
    if (!granted) return next(e)
    const v: Ev = await next(e)
    return v?.decision === 'deny' && (v.rule || v.hook) ? v : { decision: 'allow', reason: GRANT_REASON }
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e: Ev, next) => {
    const a = await send($, 'prompt', e.agentId ?? null, { origin: e.origin?.kind ?? null })
    show($, a?.notice)
    // The server's advice and the first prompt's setup note: their own labelled context blocks (text untouched)
    const blocks = a?.action === 'inject' && a.context && a.context.length ? [a.context.join('\n')] : []
    blocks.push(...(await pushLessons(ready($), e.agentId, () => $.session.cwd()))) // phase.ts: served items by phase
    const note = !e.agentId && (await ready($)) ? await onboardingNote($) : null
    if (note) blocks.push(note)
    return blocks.length ? next({ ...e, context: [...(e.context ?? []), ...blocks] }) : next(e)
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e: Ev, next) => {
    const b: Ev | null = await maybe(() => $.session.usage())
    const done: Ev = await next(e)
    const a: Ev | null = await maybe(() => $.session.usage({ breakdown: 'summary' }))
    const ans = await send($, 'compaction', e.agentId ?? null, {
      trigger: e.trigger ?? null,
      instructions: e.instructions ?? null,
      done: done.skip === undefined,
      before: done.tokensBefore ?? b?.context?.tokens ?? null,
      after: done.tokensAfter ?? null,
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
    show($, a?.notice) // after /clear has run, so the new transcript keeps the line
    return done
  }).catch(($, e, next) => next(e))

  on('classic.SessionEnd', async ($, e: Ev, next) => {
    const a = await send($, 'session_end', null, {})
    show($, a?.notice, true)
    const r = await ready($)
    if (r) {
      await capped(Promise.all([r.core.idle(), r.wiring.idle()]).then(() => undefined), r.sleep, END_WAIT_MS, undefined)
      await capped(r.outbox.flush(), r.sleep, END_WAIT_MS, undefined)
    }
    return next(e)
  }).catch(($, e, next) => next(e))
}
