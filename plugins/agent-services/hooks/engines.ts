import type { EngineInterface } from 'claude-code'
import { countDenied, delegateAfter, delegateTurn } from './delegate'
import { commandRule, installCmdguard, mailAfter, mailDeny, spawnBackground, stopSendBack } from './cmdguard'
import { loadRules, RULES_OFF_LINE, RULES_PENDING_LINE, rulesLive, rulesSettled, rulesState, rulesTable, rulesVersion } from './rules'
import { agentResult, notificationEvent } from './subagents'
import { vaultAppend, vaultPendingLine, vaultPrompt, vaultSecrets, vaultToolOut } from './vault'
import { installWatch, watchEnsureTick } from './watch'
import { runEnd, runLimitsStart } from './run_limits'
import { jitPrompt, jitStart, jitToolEnd, jitToolStart } from './just_in_time'
import { carryNow } from './carry'
import { failureHint } from './failure_hint'
import { callEnd, callStart, permissionChecked, registerTaskState, taskPromptIn, taskStateTool, turnStarted } from './task_wire'
import { budgetAfter, budgetPrompt, budgetTurn, gateRefusal } from './budget'
import { routeNoteFor } from './flow_state'
import { resumeNotification, resumeStart } from './resume'
import { continueVia } from './stall'
import { reportHasOpen, reportPrompt, reportStop, turnTexts } from './failure_report'
import { installCacheBreak } from './cache_break'
export { cacheStep, cacheStepStart, cacheTurnEnd } from './cache_break'
import { jobPermission, jobsToolEnd } from './jobs'
import { jobsNoticeSeen, jobsPrompt } from './jobs_view'
import { bindSession, textHash } from './quiet'
import { inboxPrompt } from './inbox'
import { engineStore } from './store'
import { evidenceRun } from './evidence'
import { registerUndo, undoTool } from './snapshot'
import { ownershipContext, ownershipPrompt } from './ownership'
import { registerTools } from './tools'

type Obj = Record<string, any>
type Next = (e: Obj) => Promise<any>
type Ready = Promise<unknown>
type RulesSvc = Parameters<typeof loadRules>[0]

let gateSession = ''
let gateGiven = new Map<string, true>()
let gateHeld: string[] = []

export function installEngines(on: any): void {
  installCmdguard(on)
  installWatch(on)
  installCacheBreak(on)
  on('tool.call', { tool: 'mcp__agent-services__task_state' }, async ($: EngineInterface, e: Obj) => failureHint($, e, await taskStateTool($, e)))
    .catch(() => ({ result: 'task_state failed inside the agent-services plugin (an unexpected error in the plugin, not in your request), so nothing was recorded. What to do: retry the same call once; if it fails again, continue with what does not need the task state and tell the user that the plugin\'s task_state tool failed (they can run /agent-services info log to see the plugin log). This answer is advice only and does not hold your turn; you may skip the task-state step for now.' }))
  on('tool.call', { tool: 'mcp__agent-services__undo' }, async ($: EngineInterface, e: Obj) => failureHint($, e, await undoTool($, e)))
    .catch(($: EngineInterface, e: Obj) => failureHint($, e, { result: 'Undo: it failed; nothing more was changed.' }))
  on('tool.describe', { tool: 'mcp__agent-services__undo' }, async ($: EngineInterface, e: Obj, next: any) => ({ ...(await next(e)), isDeferred: true }))
    .catch(($: EngineInterface, e: Obj, next: any) => next(e))
  on('turn.start', async ($: EngineInterface, e: Obj, next: any) => {
    turnStarted(e)
    budgetTurn(e)
    watchEnsureTick($)
    return next(e)
  }).catch(($: EngineInterface, e: Obj, next: any) => next(e))
  on('tool.check', async ($: EngineInterface, e: Obj, next: any) => {
    const v = await next(e)
    permissionChecked(e, v)
    await jobPermission($, e, v)
    return v
  }).catch(($: EngineInterface, e: Obj, next: any) => next(e))
}

export async function registerSignedIn($: EngineInterface): Promise<void> {
  await registerTools($)
  await registerTaskState($)
}

export async function toolsStart($: EngineInterface, svc: { authState(): Promise<string> }): Promise<void> {
  try {
    if ((await svc.authState()) === 'ok') await registerSignedIn($)
  } catch {}
}

export async function rulesStart($: EngineInterface, svc: RulesSvc, rt?: Ready): Promise<void> {
  if (rt) void jitStart(rt as any)
  void resumeStart($, rt)
  await registerUndo($)
  if ((await loadRules(svc, engineStore($))) !== 'off') {
    return carryNow($, false)
  }
  const signedOut = await Promise.resolve(svc.authState()).then((s) => s !== 'ok', () => true)
  try {
    $.ui.log(signedOut ? RULES_OFF_LINE : 'Command guarding and secret masking are off: the rule tables could not be fetched.')
  } catch {}
}

export async function toolRun($: EngineInterface, e: Obj, next: Next, rt: Ready): Promise<Obj> {
  await rulesLive()
  const limits = await runLimitsStart(e, rt as any)
  const jit = await jitToolStart(e, rt as any)
  callStart(e)
  watchEnsureTick($)
  const ran: Obj = await evidenceRun($, e, () => next(e), rt as any).finally(() => callEnd(e, null as any))
  const done = routeContext(await agentResult($, e, vaultToolOut($, ran) ?? ran, rt as any), routeNoteFor(e.tool_use_id))
  mailAfter(e, done)
  await jobsToolEnd($, e, done, rt)
  return callEnd(e, await failureHint($, e, ownershipContext(e, await budgetAfter($, e, await jitToolEnd(e, await runEnd(delegateAfter(e, done), limits), jit, rt as any), rt as any)), rt))
}

function routeContext(done: Obj, text: string | null): Obj {
  if (!text || !done || done.deny !== undefined) return done
  return { ...done, context: [...(Array.isArray(done.context) ? done.context : []), text] }
}

export async function denied($: EngineInterface, e: Obj, reason: string, rule = 'other', rt?: Ready): Promise<Obj> {
  countDenied(e)
  return { deny: await gateRefusal($, e, rule, reason, { rt: rt as any }) }
}

export async function spawnDenied($: EngineInterface, e: Obj, reason: string, rule: string, rt?: Ready): Promise<Obj> {
  return { deny: await gateRefusal($, e, rule, reason, { rt: rt as any, spawn: true }) }
}

export function noiseGate(blocks: readonly unknown[], subagent: boolean): unknown[] {
  if (subagent) return [...blocks]
  const others: unknown[] = []
  const texts: string[] = []
  for (const b of [...gateHeld.splice(0), ...blocks]) {
    if (typeof b !== 'string') others.push(b)
    else if (b.trim() && !texts.includes(b) && !gateGiven.has(textHash(b))) texts.push(b)
  }
  const rank = (t: string): number =>
    /waiting on (?:your|the user'?s?) (?:decision|answer)|\bneeds? you\b|your decision/i.test(t) ? 0 : /\b(?:refus|denied|den(?:y|ies)\b|blocked)/i.test(t) ? 1 : 2
  const ordered = texts.map((t, i) => ({ t, i, k: rank(t) })).sort((a, b) => a.k - b.k || a.i - b.i)
  const kept: string[] = []
  for (const { t } of ordered) {
    if (kept.length < 3) {
      kept.push(t)
      gateGiven.delete(textHash(t))
      gateGiven.set(textHash(t), true)
      while (gateGiven.size > 500) gateGiven.delete(gateGiven.keys().next().value as string)
    } else if (gateHeld.length < 10 || rank(t) < 2) gateHeld.push(t)
  }
  gateHeld.sort((a, b) => texts.indexOf(a) - texts.indexOf(b))
  return [...others, ...kept]
}

export function noiseGateResetForTest(): void {
  gateSession = ''
  gateGiven = new Map<string, true>()
  gateHeld = []
}

async function bindPrompt($: EngineInterface): Promise<void> {
  try {
    const id = String((await $.session.id()) ?? '')
    if (!id) return
    bindSession(id)
    if (id !== gateSession) {
      if (gateSession) noiseGateResetForTest()
      gateSession = id
    }
  } catch {}
}

function gatePrompt(e: Obj, base: readonly unknown[], subagent: boolean): Obj {
  if (!e || typeof e !== 'object') return e
  const ctx: unknown[] = Array.isArray(e.context) ? e.context : []
  if (ctx.length < base.length || base.some((b, i) => ctx[i] !== b)) return e
  const added = ctx.slice(base.length)
  if (!added.length && (subagent || !gateHeld.length)) return e
  const kept = noiseGate(added, subagent)
  if (kept.length === added.length && kept.every((b, i) => b === added[i])) return e
  return { ...e, context: [...base, ...kept] }
}

export async function promptIn($: EngineInterface, e: Obj, rt: Ready): Promise<Obj> {
  const r = (await rt) as { svc?: RulesSvc } | null
  if (r?.svc) void loadRules(r.svc)
  await rulesSettled(1500)
  await rulesLive()
  await bindPrompt($)
  if (!e.agentId) await carryNow($, true)
  delegateTurn(e)
  const carried = reportPrompt(e)
  const masked = vaultPrompt($, e) ?? e
  const shortened = await notificationEvent($, masked, rt as any)
  await resumeNotification($, shortened)
  const line = vaultPendingLine()
  if (line) {
    try {
      $.ui.log(line)
    } catch {}
  }
  const base: unknown[] = Array.isArray(shortened?.context) ? [...shortened.context] : []
  const out = inboxPrompt($, budgetPrompt(await ownershipPrompt($, await jobsPrompt($, await taskPromptIn($, await jitPrompt(shortened, rt as any, async () => $.session.cwd()), rt), rt), rt as any)), rt)
  const o = await out
  return gatePrompt(carried ? { ...o, context: [...(Array.isArray(o.context) ? o.context : []), carried] } : o, base, !!e.agentId)
}

export async function appendRow($: EngineInterface, e: Obj, rt?: Ready): Promise<Obj> {
  try {
    await rulesLive()
    const c = e?.message?.content
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: Obj) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('\n') : ''
    if (!e?.agentId && e?.door !== 'prompt' && text.includes('<task-notification>')) await jobsNoticeSeen($, text, rt)
    return vaultAppend($, e) ?? e
  } catch {
    return e
  }
}

export async function stopCheck($: EngineInterface, e: Obj, next: Next): Promise<Obj> {
  const done = await next(e)
  await rulesLive()
  const out = stopSendBack(e, done)
  if (out === done || out?.block === undefined) {
    const last = String(e?.last_assistant_message ?? '')
    let recent: unknown = []
    if (done?.block === undefined && reportHasOpen('')) {
      try {
        recent = await $.session.messages({ last: 60 })
      } catch {}
    }
    const block = done?.block === undefined ? reportStop('', last, turnTexts(recent, last)) : null
    if (!block) return out
    return (await continueVia($, 'report', 'stop')).ok ? { ...done, block } : done
  }
  return (await continueVia($, 'promise', 'stop')).ok ? out : done
}

export async function mailGate(e: Obj): Promise<string | null> {
  await rulesLive()
  return mailDeny(e)
}

export async function spawnGated(e: Obj): Promise<Obj> {
  await rulesLive()
  return spawnBackground(e)
}

export async function checkLines($: EngineInterface): Promise<string> {
  const state = rulesState()
  if (state !== 'on') return state === 'pending' ? RULES_PENDING_LINE : RULES_OFF_LINE
  const on = (b: boolean) => (b ? 'on' : 'off')
  const vault = rulesTable<{ patterns?: unknown[] }>('vault')
  const subs = rulesTable<Obj>('subagents')
  return [
    `Rule tables: version ${rulesVersion()}.`,
    `Command guard: ${on(commandRule('git add -A') !== null)} (a git command that takes every changed file is refused while other agents run).`,
    `Webmail check: ${on(mailDeny({ tool: 'WebFetch', url: 'https://mail.google.com/' }) !== null)}.`,
    `Secret masking: ${on(Array.isArray(vault?.patterns) && vault!.patterns!.length > 0)}${vault?.patterns ? ` (${vault.patterns.length} patterns)` : ''}.`,
    `Subagent gates and long reports: ${on(subs !== null)}${subs?.redline ? '; the weekly usage line stops new subagents on this account' : ''}${subs?.demand || subs?.coauthor ? '; the requirements-file lock and the commit co-author check are on' : ''}.`,
    `Shell watch: ${on(rulesTable('watch') !== null)}.`,
  ].join('\n')
}

export async function engineCommand($: EngineInterface, sub: string, rest: string[]): Promise<string> {
  if (sub === 'secrets') return vaultSecrets(rest.join(' ')).join('\n')
  return checkLines($)
}
