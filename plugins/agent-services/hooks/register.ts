// agent-services Claude Code adapter: the engine's hooks wired to the in-process core.
// Nothing here talks to a local process: the core (core.ts), the svc channel (svc.ts), the tools (tools.ts), the slash
// command (command.ts), the status line, dashboard, metrics and estimate (wiring.ts), the dashboard publish
// (dashboard.ts) and the update check (update.ts) all run in this module, one instance per Claude Code session.
//
// Rules kept here:
// - session.start registers the tools and the slash command first, before anything is awaited;
//   the rest is built after, and every network step (hello, plan, rotation, metrics, migration) runs in the
//   background, so no hook comes near the ~10 s budget. Every other hook waits at most a fixed time for the core
//   and otherwise passes the event through untouched.
// - Each engine hook becomes one or two core/1 events; the core's answer is applied as before (deny, rewrite,
//   inject, notice). While auth has failed the core answers pass-through, so every event goes on unchanged.
// - The first session.start of this release runs the one-time move from the Python core (migrate.ts) in the
//   background; it never starts or kills a process.
// - Nothing here writes the user's settings or permission rules ($.settings is read only).
import type { EngineInterface, Register } from 'claude-code'
import { dataDir, declareCommand, denyReason, engineClaudeHash, engineDirs, isRemoved, MARKETPLACE, onboardingNote, pastedCode, routingOff, serveCommand, spawnLine } from './command'
import { Core, type Answer } from './core'
import { dashboardGrant, GRANT_REASON, PUBLISH_START_WAIT_MS } from './dashboard'
import { publishBoards } from './boss' // the person's board, then the company admin's
import { briefed, flowAfter, flowLock, flowPrompt, flowStart, flowTurnEnd, installFlow, withPending } from './flow' // checkpoint tool, test lock, brief, notes
import { Guard } from './guard'
import { migrate, OLD_SIGNIN_KEY, OLD_SIGNIN_LINE } from './migrate'
import { FLUSH_EVERY_MS, Outbox } from './outbox'; import { PANEL_EVERY_MS } from './panel'
import { holdWrite, lessonHold, methodsStart, noteAutonomy, pushAgain, pushLessons, pushStart } from './phase'
import { PRICES } from './prices'
import { engineStore, safeDelete, safeGet, type KV } from './store'
import { Svc, type HttpAnswer } from './svc'
import { engineSleep, installTools, registerTools, SESSION_FALLBACK, svcAuthLine, toolInput } from './tools'
import { probeProcess, processRunner, updateCheck, type Gate } from './update'
import { bandSetter, createWiring, engineChunks, installBand, notePlan, svcTransport, type Wiring } from './wiring'
import { canAskNow } from './choice'
import { appendRow, denied, installEngines, mailGate, promptIn, rulesStart, spawnGated, stopCheck, toolRun } from './engines'; import { spawnGate } from './subagents'; import { watchPrompt } from './watch' // rule-table engines

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
export const END_WAIT_MS = 1500 // session end: background work, then again for the outbox write (6 + 1.5 + 1.5 s: under the 10 s a hook gets)
export const PROBE_WAIT_MS = 1500 // the $.process probe (it runs nothing)
export const STAMP_PATH = 'core/host/shell_stamp.json' // under the plugin root: the export's version stamp

const usage = (u: Ev | null | undefined): Usage | null =>
  u ? { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cache_read: u.cache_read_input_tokens ?? 0, cache_write: u.cache_creation_input_tokens ?? 0 } : null

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
  if (typeof notice !== 'string' || !notice) return
  try {
    $.ui.log(notice)
  } catch {}
  try {
    if (toast) $.ui.toast(notice)
  } catch {}
}
// ------------------------------------------------------------------ the session's runtime, built once

// The status line's update hint: selfUpdates turns false once update.ts finds no $.process here.
const updates = { marketplace: MARKETPLACE as string | null, selfUpdates: true }
let runtime: Promise<Rt | null> | null = null
let declared = false
let interactive = true // choice.ts canAskNow at session.start (false in a -p run: nobody to ask)
let resolveFirst: (r: Rt | null) => void = () => undefined
const first = new Promise<Rt | null>((resolve) => (resolveFirst = resolve))

// The tools and the command, before anything is awaited (also when a hook other than session.start comes first,
// say after /reload-plugins).
function declare($: EngineInterface): void {
  if (declared) return
  declared = true
  void registerTools($).catch(() => undefined)
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
        $.ui.status(withPending(text)) // flow.ts: the open-decision count
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
    // no $.process here: update.ts runs nothing, and the status line shows the terminal update command
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
      setBand: bandSetter($), // band.ts: the band above the prompt
      outbox,
      clock: now,
      projectsRoot: `${dirs.configDir}/projects`,
      holder: session, run: processRunner($, hasProcess === true), // usage_tool.ts: the local scan tool
      clientVersion: await shellVersion($), // the release version in every body (was the fixed 0.1.0)
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
    // each timer on its own: the band and panel redraw (PANEL_EVERY_MS) moves during a long turn too
    for (const [ms, run] of [[FLUSH_EVERY_MS, () => void outbox.flush().catch(() => undefined)], [PANEL_EVERY_MS, () => void wiring.tick()]] as const) try { $.clock.every(ms, run) } catch {}
    return { setStatus, session, svc, core, wiring, outbox, store, dir, sleep, readText }
  } catch {
    return null
  }
}

function ready($: EngineInterface): Promise<Rt | null> {
  declare($); if (isRemoved()) return Promise.resolve(null) // after /agent-services remove: every event passes
  if (!runtime) {
    runtime = build($)
    void runtime.then((r) => { resolveFirst(r); if (!r) runtime = null }) // a failed build is tried again at the next event
  }
  return runtime
}

// One core/1 event of this session; null (pass the event through) when the core is not there or too slow.
async function send($: EngineInterface, kind: string, agent: string | null, fields: Ev = {}): Promise<Answer | null> {
  const r = await ready($)
  if (!r) return null
  if (kind === 'clear' || (kind === 'compaction' && fields.done === true && fields.trigger !== 'precompute')) pushAgain(r, agent) // phase.ts: again after a real one
  const event = { v: 1, harness: HARNESS, kind, session: r.session, agent, ...fields }
  return capped(r.core.handle(event), r.sleep, EVENT_WAIT_MS, null)
}

// Session-start background: metrics upload, outbox sweep, migration, update check.
function background($: EngineInterface, r: Rt, interactive: boolean): void {
  void r.wiring.metricsTick().catch(() => undefined)
  void r.outbox.sweep().catch(() => undefined); void rulesStart($, r.svc, ready($)).catch(() => undefined) // engines.ts: rule tables, just-in-time resume
  void pushStart(r).then(() => methodsStart($, r, interactive)).catch(() => undefined) // phase.ts: plan items; methods.ts: CLAUDE.md file
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
  updateCheck($, interactive, gate, () => void (updates.selfUpdates = false))
}

export const register: Register = (on) => {
  installTools(on as any, {
    deps: async () => {
      const r = await (runtime ?? first)
      if (!r || isRemoved()) throw new Error('agent-services did not start') // removed: the tools answer nothing
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
      dailyBody: (day) => r.wiring.previewBody(day), previewNote: () => r.wiring.previewNote(), refreshTime: () => r.wiring.refreshTime(), panel: () => r.wiring.panelLines(), // wiring.ts
      clientVersion: r.wiring.clientVersion,
      marketplace: MARKETPLACE,
      selfUpdates: () => updates.selfUpdates,
    }
  }, () => {
    void runtime?.then((r) => r && refreshStatus(r.setStatus, r.wiring, r.store)).catch(() => undefined)
  })
  installBand(on); installFlow(on); installEngines(on) // engines.ts: command guard and shell watch hooks; flow.ts: the checkpoint tool; band.ts: the band above the prompt draws the facts setBand writes

  on('session.start', async ($, e: Ev, next) => {
    declare($)
    const pending = ready($)
    const asking = canAskNow($, e.isInteractive) // the one "can we ask the user now" check
    const out = await next(e); await flowStart($, ready($)) // flow.ts: the checkpoint tool, after the other plugins' tools
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

  on('agent.spawn', async ($, e: Ev, next) => {
    const off = await routingOff($); const gate = await spawnGate($, e, ready($), off); if (gate) return { deny: gate } // subagents.ts: usage line always, steps gate unless routing is off
    if (off) return next(e); const agent = e.parentAgentId ?? null // routing off: nothing else (command.ts)
    const call = e.tool_use_id ?? null
    const a = await send($, 'dispatch', agent, {
      subagent_type: e.subagentType,
      description: e.description,
      model: e.model ?? null, parent_model: e.parentModel ?? null,
      effort: e.effort ?? null,
      fork: e.fork === true,
      teammate: e.isTeammate === true,
      call,
    })
    show($, spawnLine(a)) // a changed model is said every time (hooks_list.ts)
    if (a?.action === 'deny') {
      return { deny: denyReason(a.reason) }
    }
    const spawned: Ev = await next(await spawnGated(await briefed($, a, a?.action === 'rewrite' && a.set ? { ...e, model: a.set.model } : e)))
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
    const held = (await mailGate(e)) ?? (await holdWrite(ready($), e.tool, toolInput(e), () => $.session.cwd(), e.agentId)) ?? (await flowLock($, e, ready($))) // phase.ts: main agent; flow.ts: test lock
    if (held) return denied(e, held) // engines.ts: counted for the turn advice
    const fields = { tool: e.tool, input: toolInput(e), call: e.tool_use_id ?? null }
    const agent = e.agentId ?? null
    const a = await send($, 'pre_tool', agent, fields)
    show($, a?.notice)
    if (a?.action === 'deny') {
      return denied(e, denyReason(a.reason, 'tool check'))
    }
    const done: Ev = await toolRun($, e, next, ready($)) // engines.ts: a tool's input is never changed (but where served rules unmask secrets)
    await flowAfter($, e, ready($)); await noteAutonomy($, e, done, ready($)) // flow.ts: timing; autonomy.ts: the user's choice
    show($, (await send($, 'post_tool', agent, { ...fields, ok: done?.deny === undefined && done?.isError !== true }))?.notice)
    return done
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e: Ev, next) => {
    const done = await next(e); await flowTurnEnd($, e, ready($)) // flow.ts: checkpoint compaction, next turn's notes
    const u: Ev | null = await maybe(() => $.session.usage()); notePlan(u) // panel.ts: the plan and context the panel shows
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
      const pub = publishBoards($, r.wiring, report, interactive).catch(() => undefined)
      await capped(pub, r.sleep, PUBLISH_START_WAIT_MS, undefined)
    }
    return done
  }).catch(($, e, next) => next(e))

  // On the user's consent, this plugin's own board calls (dashboard.ts dashboardGrant) are allowed without a rule;
  // a deny from the user's own rule, hook or setting stands, and every other call goes on unchanged.
  on('tool.check', { tool: ['Artifact', 'ArtifactData'] }, async ($, e: Ev, next) => {
    const granted = (next as any).origin?.plugin === $.plugin.name && (await dashboardGrant($, e.input, e.tool))
    if (!granted) return next(e)
    const v: Ev = await next(e)
    return v?.decision === 'deny' && (v.rule || v.hook || v.setting) ? v : { decision: 'allow', reason: GRANT_REASON }
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e: Ev, next) => {
    const signedIn = await pastedCode($, e); if (signedIn !== null) return { drop: signedIn } // a pasted sign-in code
    e = await promptIn($, e, ready($)) // engines.ts: a long report shortened, secrets masked
    const a = await send($, 'prompt', e.agentId ?? null, { origin: e.origin?.kind ?? null })
    show($, a?.notice, a?.action === 'inject') // inject: the checkpoint advice, also shown to the user
    // The server's advice and the first prompt's setup note: their own labelled context blocks (text untouched)
    const blocks = a?.action === 'inject' && a.context && a.context.length ? [a.context.join('\n')] : []
    blocks.push(...(await pushLessons(ready($), e.agentId, () => $.session.cwd())), ...(await flowPrompt($, e, ready($))), ...(await watchPrompt($, e))) // phase.ts: served items by phase; flow.ts: notes
    const note = !e.agentId && (await ready($)) ? await onboardingNote($) : null
    if (note) blocks.push(note)
    return blocks.length ? next({ ...e, context: [...(e.context ?? []), ...blocks] }) : next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Stop', async ($, e: Ev, next) => stopCheck(e, next)).catch(($, e, next) => next(e)) // engines.ts: promise send-back
  on('session.append', async ($, e: Ev, next) => next(await appendRow($, e))).catch(($, e, next) => next(e)) // engines.ts: trim, masking

  on('session.compact', async ($, e: Ev, next) => {
    const b: Ev | null = await maybe(() => $.session.usage())
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
