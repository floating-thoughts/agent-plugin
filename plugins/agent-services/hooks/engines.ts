// The local engines that run on the served rule tables (rules.ts), wired from register.ts's existing hooks with one
// call each: command guard (cmdguard.ts), secret masking (vault.ts), row trimming (trim.ts), subagent gates and long
// reports (subagents.ts) and the shell watch (watch.ts). Each engine does nothing without its table (signed out), and
// nothing here sends a command, prompt, tool input or output anywhere (run_limits.ts sends only a command head from
// the public list, once per head and session; just_in_time.ts sends only the name of a just-in-time event, once per
// event and session). The per-turn counters (delegate.ts) are counts only; the core sends them with its turn-end
// checkpoint request.
import type { EngineInterface } from 'claude-code'
import { countDenied, delegateAfter, delegateTurn } from './delegate'
import { commandRule, installCmdguard, mailAfter, mailDeny, spawnBackground, stopSendBack } from './cmdguard'
import { loadRules, RULES_OFF_LINE, RULES_PENDING_LINE, rulesLive, rulesSettled, rulesState, rulesTable, rulesVersion } from './rules'
import { agentResult, notificationEvent } from './subagents'
import { lineFor, trimAppend, trimCommand, trimOn } from './trim'
import { vaultAppend, vaultPendingLine, vaultPrompt, vaultSecrets, vaultToolIn, vaultToolOut } from './vault'
import { installWatch, runCommandTool } from './watch'
import { runEnd, runLimitsStart } from './run_limits'
import { jitPrompt, jitStart, jitToolEnd, jitToolStart } from './just_in_time'

type Obj = Record<string, any>
type Next = (e: Obj) => Promise<any>
type Ready = Promise<unknown>
type RulesSvc = Parameters<typeof loadRules>[0]

/** register.ts: the engines' hooks that carry a matcher (Bash and shell timers, Stop/StopFailure timers). */
export function installEngines(on: any): void {
  installCmdguard(on)
  installWatch(on)
  on('tool.call', { tool: 'mcp__agent-services__run_command' }, async ($: EngineInterface, e: Obj) => runCommandTool($, e))
    .catch(() => ({ result: 'agent-services: run_command could not run; carry on without it.' }))
}

/** session.start (background): the run_command tool, answered on this machine from the served watch table. */
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

/** session.start (background): fetch the rule tables; while they are missing, one plain line says what is off. Also
 * the just-in-time check for a resumed session (just_in_time.ts). */
export async function rulesStart($: EngineInterface, svc: RulesSvc, rt?: Ready): Promise<void> {
  if (rt) void jitStart(rt as any)
  await registerRunCommand($)
  if ((await loadRules(svc)) !== 'off') return
  // signed in but the tables did not arrive: say that, not "signed out"
  const signedOut = await Promise.resolve(svc.authState()).then((s) => s !== 'ok', () => true)
  try {
    $.ui.log(signedOut ? RULES_OFF_LINE : 'Command guarding and secret masking are off: the rule tables could not be fetched.')
  } catch {}
}

/** tool.call: run the tool with this plugin's secret placeholders put back for the call only, mask its output again,
 * shorten a long foreground subagent report, remember mail tabs, and add the run-limits note of a shell call's head
 * and the just-in-time notes that are due (just_in_time.ts). */
export async function toolRun($: EngineInterface, e: Obj, next: Next, rt: Ready): Promise<Obj> {
  await rulesLive() // a sign-in that no longer holds clears the tables first: then nothing below changes anything
  const limits = await runLimitsStart(e, rt as any) // run_limits.ts: one request per command head and session, 1 s cap
  const jit = await jitToolStart(e, rt as any) // just_in_time.ts: a UI file or agent-state.md write; no request otherwise
  const ran: Obj = await next(vaultToolIn(e) ?? e)
  const done = await agentResult($, e, vaultToolOut($, ran) ?? ran, rt as any)
  mailAfter(e, done)
  return jitToolEnd(e, await runEnd(delegateAfter(e, done), limits), jit, rt as any) // delegate.ts: the main turn's call counted for the turn advice
}

/** tool.call (register.ts): a call this plugin refuses before it runs, counted as a refusal of the main turn. */
export function denied(e: Obj, reason: string): Obj {
  countDenied(e)
  return { deny: reason }
}

/** prompt.submit: secrets in the prompt masked, then a long background report shortened (so the report file is
 * saved masked too); the pending line once; the just-in-time notes that are due (just_in_time.ts). */
export async function promptIn($: EngineInterface, e: Obj, rt: Ready): Promise<Obj> {
  const r = (await rt) as { svc?: RulesSvc } | null
  if (r?.svc) void loadRules(r.svc) // not fetched yet (a prompt before session.start ran), or cleared: start it now
  await rulesSettled(1500) // a fetch in flight at the first prompt: wait briefly so the prompt is masked
  await rulesLive()
  delegateTurn(e) // delegate.ts: a main prompt starts a new turn of counts
  const masked = vaultPrompt($, e) ?? e
  const shortened = await notificationEvent($, masked, rt as any)
  const line = vaultPendingLine()
  if (line) {
    try {
      $.ui.log(line)
    } catch {}
  }
  return jitPrompt(shortened, rt as any, async () => $.session.cwd())
}

/** session.append: a re-attached row trimmed to one line, then any secret in it masked. */
export async function appendRow($: EngineInterface, e: Obj): Promise<Obj> {
  try {
    await rulesLive()
    const t = (await trimAppend($, e)) ?? e
    return vaultAppend($, t) ?? t
  } catch {
    return e
  }
}

/** classic.Stop: a main turn that ends on a promise of more of its own work is sent back once. */
export async function stopCheck(e: Obj, next: Next): Promise<Obj> {
  const done = await next(e)
  await rulesLive()
  return stopSendBack(e, done)
}

/** tool.call, first (register.ts): the webmail deny reason, or null; checked only while the sign-in holds. */
export async function mailGate(e: Obj): Promise<string | null> {
  await rulesLive()
  return mailDeny(e)
}

/** agent.spawn, before next() (register.ts): the spawn, in the background where the served table says so. */
export async function spawnGated(e: Obj): Promise<Obj> {
  await rulesLive()
  return spawnBackground(e)
}

/** `/agent-services check`: each engine on fixed inputs with this session's served tables, on or off. */
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

/** The engines' subcommands: `secrets [forget]`, `trim [on|off]`, `check`. */
export async function engineCommand($: EngineInterface, sub: string, rest: string[]): Promise<string> {
  if (sub === 'secrets') return vaultSecrets(rest.join(' ')).join('\n')
  if (sub === 'trim') return trimCommand($, rest.join(' '))
  return checkLines($)
}
