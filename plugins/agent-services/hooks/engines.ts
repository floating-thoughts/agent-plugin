import type { EngineInterface } from 'claude-code'
import { countDenied, delegateAfter, delegateTurn } from './delegate'
import { commandRule, installCmdguard, mailAfter, mailDeny, spawnBackground, stopSendBack } from './cmdguard'
import { loadRules, RULES_OFF_LINE, RULES_PENDING_LINE, rulesLive, rulesSettled, rulesState, rulesTable, rulesVersion } from './rules'
import { agentResult, notificationEvent } from './subagents'
import { lineFor, trimAppend, trimOn } from './trim'
import { vaultAppend, vaultPendingLine, vaultPrompt, vaultSecrets, vaultToolOut } from './vault'
import { installWatch, runCommandTool, watchEnsureTick } from './watch'
import { runEnd, runLimitsStart } from './run_limits'
import { jitPrompt, jitStart, jitToolEnd, jitToolStart } from './just_in_time'
import { carryNow } from './carry'
import { failureHint } from './failure_hint'
import { callEnd, callStart, permissionChecked, registerTaskState, taskPromptIn, taskStateTool, turnStarted } from './task_wire'
import { budgetAfter, budgetPrompt, budgetTurn, gateRefusal } from './budget'
import { routeNoteFor } from './flow_state'
import { replayContext, resumeNotification, resumeStart } from './resume'
import { continueVia, routeEscalation } from './stall'
import { installRecover, routeCircuit } from './recover'
export { recoverStep, recoverStepStart, recoverTurnEnd } from './recover'
import { jobPermission, jobsToolEnd } from './jobs'
import { jobsPrompt } from './jobs_view'
import { inboxPrompt } from './inbox'
import { engineStore } from './store'
import { NOTE_PREFIX } from './review'
import { evidenceRun } from './evidence'
import { registerUndo, undoTool } from './snapshot'
import { briefPackTool, registerBriefPack } from './brief_pack'
import { ownershipContext, ownershipPrompt } from './ownership'
import { registerTools } from './tools'
import { memoryPrompt, memoryStart, memoryToolEnd } from './memory_wire'

type Obj = Record<string, any>
type Next = (e: Obj) => Promise<any>
type Ready = Promise<unknown>
type RulesSvc = Parameters<typeof loadRules>[0]

export function installEngines(on: any): void {
  installCmdguard(on)
  installWatch(on)
  installRecover(on)
  on('tool.call', { tool: 'mcp__agent-services__run_command' }, async ($: EngineInterface, e: Obj) => runCommandTool($, e))
    .catch(() => ({ result: `${NOTE_PREFIX}: run_command could not run; carry on without it.` }))
  on('tool.call', { tool: 'mcp__agent-services__task_state' }, async ($: EngineInterface, e: Obj) => taskStateTool($, e))
    .catch(() => ({ result: 'The task state could not be changed; carry on without it.' }))
  on('tool.call', { tool: 'mcp__agent-services__undo' }, async ($: EngineInterface, e: Obj) => undoTool($, e))
    .catch(() => ({ result: 'Undo: it failed; nothing more was changed.' }))
  on('tool.call', { tool: 'mcp__agent-services__brief_pack' }, async (_$: EngineInterface, e: Obj) => briefPackTool(e))
    .catch(() => ({ result: 'Not packed: the brief packer failed; no brief was made.' }))
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

export async function registerRunCommand($: EngineInterface): Promise<void> {
  try {
    await $.tool.register({
      name: 'run_command',
      isDeferred: false,
      description: 'Run one slash command for Claude (name without the slash) and get its text output, as if the user ' +
        'typed /command. Only reload-plugins and context are allowed. The command runs once the session is idle, so ' +
        "this call only answers that it is queued; its output comes with your next tool call or the user's next " +
        'message, so carry on with other work meanwhile. Any other command is refused and not run. Only the main ' +
        'conversation can use it. Answered on this machine: nothing is sent to the service.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', minLength: 1, maxLength: 64, description: 'The command name without the slash, e.g. context' },
          args: { type: 'string', maxLength: 200, description: 'Arguments for the command; may be left out' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    } as any)
  } catch {}
}

export async function registerSignedIn($: EngineInterface): Promise<void> {
  await registerTools($)
  await registerRunCommand($)
  await registerTaskState($)
  await registerBriefPack($)
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
    void memoryStart($, rt)
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
  const done = replayContext(e, routeContext(await agentResult($, e, vaultToolOut($, ran) ?? ran, rt as any), await routeCircuit($, e, await routeEscalation($, e, routeNoteFor(e.tool_use_id), rt), rt)))
  mailAfter(e, done)
  await jobsToolEnd($, e, done, rt)
  return callEnd(e, await memoryToolEnd($, e, await failureHint($, e, ownershipContext(e, await budgetAfter($, e, await jitToolEnd(e, await runEnd(delegateAfter(e, done), limits), jit, rt as any), rt as any)), rt), rt))
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

export async function promptIn($: EngineInterface, e: Obj, rt: Ready): Promise<Obj> {
  const r = (await rt) as { svc?: RulesSvc } | null
  if (r?.svc) void loadRules(r.svc)
  await rulesSettled(1500)
  await rulesLive()
  if (!e.agentId) await carryNow($, true)
  delegateTurn(e)
  const masked = vaultPrompt($, e) ?? e
  const shortened = await notificationEvent($, masked, rt as any)
  await resumeNotification($, shortened)
  const line = vaultPendingLine()
  if (line) {
    try {
      $.ui.log(line)
    } catch {}
  }
  return inboxPrompt($, budgetPrompt(await ownershipPrompt($, await jobsPrompt($, await memoryPrompt($, await taskPromptIn($, await jitPrompt(shortened, rt as any, async () => $.session.cwd()), rt), rt), rt), rt as any)), rt)
}

export async function appendRow($: EngineInterface, e: Obj): Promise<Obj> {
  try {
    await rulesLive()
    const t = (await trimAppend($, e)) ?? e
    return vaultAppend($, t) ?? t
  } catch {
    return e
  }
}

export async function stopCheck($: EngineInterface, e: Obj, next: Next): Promise<Obj> {
  const done = await next(e)
  await rulesLive()
  const out = stopSendBack(e, done)
  if (out === done || out?.block === undefined) return out
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
    `Row trimming after a compaction: ${on(lineFor('invoked_skills', 'x') !== null && (await trimOn($)))}.`,
    `Subagent gates and long reports: ${on(subs !== null)}${subs?.redline ? '; the weekly usage line stops new subagents on this account' : ''}${subs?.demand || subs?.coauthor ? '; the requirements-file lock and the commit co-author check are on' : ''}.`,
    `Shell watch: ${on(rulesTable('watch') !== null)}.`,
  ].join('\n')
}

export async function engineCommand($: EngineInterface, sub: string, rest: string[]): Promise<string> {
  if (sub === 'secrets') return vaultSecrets(rest.join(' ')).join('\n')
  return checkLines($)
}
