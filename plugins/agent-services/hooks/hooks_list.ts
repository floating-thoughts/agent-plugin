// Every hook this plugin registers, as a fixed table: `/agent-services hooks` and the setup tool's
// "hooks" print it, so the user and the model can see what each hook may do before trusting it. A test reads the
// on(...) calls of register.ts and the modules it wires (tools.ts, command.ts, band.ts) and fails when a hook is
// missing here or listed here without being registered. Pure: no engine calls.
import { receiptText } from './receipts'

export type HookRow = {
  event: string
  matcher: string // '' for every event of that kind
  file: string // where it is registered
  does: string[] // context, drop, deny, rewrite, ui, process, file, network, answer, count
  what: string
  shown: string // what the user sees when it acts
}

export const HOOK_EFFECTS: Readonly<Record<string, string>> = {
  context: 'adds context for the model',
  drop: 'drops a prompt',
  deny: 'denies a tool call or a subagent',
  rewrite: 'changes a request before it runs',
  ui: 'shows something on screen',
  process: 'runs a command on this computer',
  file: 'writes files',
  network: 'sends a request to the service',
  answer: 'answers a call itself',
  count: 'counts locally',
}

export const HOOKS: readonly HookRow[] = [
  {
    event: 'session.start', matcher: '', file: 'register.ts', does: ['network', 'file', 'process', 'ui', 'count'],
    what: 'Registers the tools and the slash command. In the background: the sign-in check, whether this session id was seen at an earlier start (a resumed session; the id is kept in the plugin store and the service is asked once for the resume items, sending only the event name), the daily usage upload ' +
      '(only after you chose to upload, never before your own answer, also when your company turned the savings ' +
      'record on; with "Upload from now on only" nothing from before the day you chose), the request-log cleanup (90 days), the working methods for the first ' +
      'prompt (only at methods level suggest) and the CLAUDE.md methods file (only at methods on), a one-time move ' +
      'from an older version, and the update check (`claude plugin list --json` and `claude plugin marketplace ' +
      'update agent-plugin`; it never updates the plugin; not in a session nobody can be asked in), and, only when a usage scan tool sits at ' +
      '~/.agent-services/tools/usage_scan.py, that tool with Python (`py -3`, `python3` or `python`; at most every 15 minutes; ' +
      'it reads your transcripts and writes services/time-days.json, nothing is sent). After the other plugins\' start hooks: registers the ' +
      'checkpoint tool, unless another plugin in the session already has a tool named checkpoint (then the notes ' +
      'name that one), and reads the open count of .agent/pending.md in the project.',
    shown: 'A dim line when the sign-in check has something to say.',
  },
  {
    event: 'agent.spawn', matcher: '', file: 'register.ts', does: ['network', 'deny', 'rewrite', 'ui'],
    what: 'While subagent routing is off (/agent-services routing off) it sends no request, changes no model and ' +
      'adds nothing; only the weekly usage line below can still deny a subagent. Otherwise it asks the service for routing advice on each subagent (forks and ' +
      'teammates are skipped). The advice can ' +
      'deny the subagent with a reason, or set its model and effort. At routing suggest (the default) a subagent ' +
      'whose description has no task type word is never denied for it; at routing strict the request says so and ' +
      'the service refuses it. The request also carries the main session\'s ' +
      'model id and whether your latest message asked for a review (yes or no; your text is not sent). Unless the ' +
      'methods level is off, the service\'s speed-up suggestion is added once to the end of the subagent\'s prompt, ' +
      'labelled as an agent-services suggestion. ' +
      'With the served rule tables (signed in): a subagent whose task names a step with [step:ID] is denied while that step\'s dependencies in .agent/steps.json are not done ([override: reason] lets it start; not while routing is off); the weekly usage line that stops new subagents applies only to accounts whose served rules include it; on accounts whose served rules turn it on (not product accounts), the main conversation\'s subagents are started in the background. These checks send nothing.',
    shown: 'A deny shows its reason, which starts with "agent-services routing", "agent-services steps gate" or ' +
      '"agent-services usage line". A changed model is said each ' +
      'time in a dim line naming the model. The added suggestion is in the subagent\'s prompt.',
  },
  {
    event: 'turn.step', matcher: '', file: 'register.ts', does: ['rewrite', 'count'],
    what: 'Counts token usage locally. For a subagent whose model agent-services set, it also sets the effort of ' +
      'its model requests to the advised effort.',
    shown: 'The dim line at the subagent\'s start names it.',
  },
  {
    event: 'tool.call', matcher: '', file: 'register.ts', does: ['deny', 'file', 'count', 'network', 'context'],
    what: 'The planning gate, only at methods level on (methods on): while you are signed in, it denies Edit, Write, ' +
      'MultiEdit and NotebookEdit of the main agent when the project has no agent-state.md, or it is still in ' +
      'planning, or it has no goal and plan (the criteria, texts and small-edit size come from the served rule tables; without them nothing is held); an Edit or MultiEdit of at most the served number of changed lines passes, and writes to ' +
      'agent-state.md and to files under .agent/ always go through. Bash is never held, so a file written through Bash is not seen. At ' +
      'level suggest it only notes such a change for one reminder; at off it does nothing. It also counts tool ' +
      'calls, commits and finished todos locally, and the size of files read in parts. It never changes a tool\'s input, except on an account whose served rules turn it on (not product accounts): there it puts back, on this machine and for that call only, a secret of yours in place of a {{secret:NAME}} placeholder that this plugin\'s secret masking made.' +
      ' The test lock: it denies a subagent\'s Edit, Write, MultiEdit or NotebookEdit of a file that ' +
      'matches a glob in the project\'s .agent/test-lock.json (the main conversation may edit them; Bash is ' +
      'not checked). It times the main conversation\'s foreground Bash, PowerShell and subagent calls and ' +
      'counts its subagent dispatches, locally. After the main conversation\'s AskUserQuestion call, while you are ' +
      'signed in, it keeps your answer when it is one of the two autonomy labels of the working methods ' +
      '(/agent-services autonomy), locally. ' +
      'With the served rule tables (signed in): browser tools and WebFetch are denied on webmail sites and on a tab seen showing one (navigating that tab away or closing it stays allowed); secrets in a tool\'s output are masked again; a subagent report longer than the served cap is saved whole in a file in the agent-services data folder and the conversation gets its opening and the file\'s path; the test-author lock denies another subagent\'s change to a test file an agent wrote in this session; only on an account whose served rules include them (not product accounts), a locked requirements file the rules name takes only an amendment appended at its end by the main conversation (never a shell command), and a commit whose Co-Authored-By names another model than the agent runs on is denied; when the calls of the main conversation in one turn reach a count or a result size the served delegation table names, the result gets the note of that table suggesting a subagent for such work (counted in memory only). None of this sends anything.' +
      ' Run limits (signed in, not at methods level off): the first foreground Bash or PowerShell call of the main conversation with a command head from the public list asks the service about that head, once per head and session (only the head is sent; it waits at most 1 second, then goes on without an answer); when the answer says such commands are better run in the background, its note is added once to the result of a call with that head.' +
      ' Just-in-time items (signed in, not at methods level off, main conversation): the first edit of a UI file, or a write of agent-state.md that makes it running, adds plan steps or checks every step done, asks the service once per moment and session for that moment\'s items (only the event name is sent; agent-state.md is read on this computer before and after the write); the labelled note goes with this call\'s result when it comes within 1 second, else with a later one.',
    shown: 'The deny reason, which starts with "agent-services planning gate" or "agent-services test lock".',
  },
  {
    event: 'tool.call', matcher: 'tool: mcp__agent-services__<tool>', file: 'tools.ts', does: ['answer', 'network'],
    what: 'Answers this plugin\'s own tools: router_advice, lesson_lookup, checkpoint_advice, savings, toolbox and status (toolbox sends only the session id, the pack key and the optional topic).',
    shown: 'The tool call and its answer.',
  },
  {
    event: 'tool.describe', matcher: 'tool: mcp__agent-services__<tool>', file: 'tools.ts', does: ['answer'],
    what: 'Marks this plugin\'s own tools as always loaded.',
    shown: 'Nothing.',
  },
  {
    event: 'tool.describe', matcher: 'tool: mcp__agent-services__setup', file: 'command.ts', does: ['answer'],
    what: 'Marks the setup tool as always loaded.',
    shown: 'Nothing.',
  },
  {
    event: 'tool.call', matcher: 'tool: mcp__agent-services__setup', file: 'command.ts', does: ['answer', 'network', 'file'],
    what: 'Runs one subcommand from a fixed list with the answer you gave (sharing, methods, routing, update, info); ' +
      'a choice-changing one only in the main conversation of a session you are at. It never turns the savings ' +
      'upload on: only you do.',
    shown: 'The tool call and its answer.',
  },
  {
    event: 'command.run', matcher: 'command: agent-services', file: 'command.ts', does: ['answer', 'network', 'file', 'ui'],
    what: 'The /agent-services slash command.',
    shown: 'Its answer.',
  },
  {
    event: 'turn.complete', matcher: '', file: 'register.ts', does: ['network', 'file', 'process', 'ui'],
    what: 'Asks the service whether this is a good moment to compact (counters only). Refreshes the usage panel\'s ' +
      'figures at most every 10 minutes, running the usage scan tool at ~/.agent-services/tools/usage_scan.py first ' +
      'when it is there (in the background, at most every 15 minutes, nothing sent). Keeps your private ' +
      'savings page (and a company admin\'s board) current, only when you allowed it: the page is published once ' +
      'with Claude Code\'s Artifact tool, then its figures are written to the page\'s own data with the ' +
      'ArtifactData tool, which does not publish the page again. ' +
      'Once a day, a session left open sends the daily usage summary of the new day (only while the savings record ' +
      'is on). ' +
      'After a main turn it also runs the compaction of a checkpoint marked in it, reads .agent/pending.md and ' +
      '.agent/steps.json in the project, and keeps a note for the next turn when steps are ready to start but ' +
      'fewer subagents were dispatched, or when a foreground call ran longer than the served time.',
    shown: 'The Artifact or ArtifactData call. The open count on the status line.',
  },
  {
    event: 'tool.check', matcher: 'tool: Artifact, ArtifactData', file: 'register.ts', does: ['answer'],
    what: 'Allows this plugin\'s own savings-page publish and its writes of the page\'s figures without a ' +
      'permission prompt once you allowed it. A deny from your own rule or hook stands; every other Artifact or ' +
      'ArtifactData call goes on unchanged.',
    shown: 'The permission reason "agent-services savings page (user allowed)".',
  },
  {
    event: 'prompt.submit', matcher: '', file: 'register.ts', does: ['drop', 'context', 'rewrite', 'file', 'ui'],
    what: 'Drops a message that is only a sign-in code while a sign-in waits for one, and finishes the sign-in with ' +
      'it, so the code never reaches the model. Adds context blocks for the model, after your text and without ' +
      'changing it: the service\'s compaction advice, the working methods of the current phase (in full once per ' +
      'session, and again only after /clear, a compaction, a phase change or a new served version; nothing on ' +
      'other prompts), the toolbox index (the list of toolbox packs, fetched once per session with the first prompt, sending only the session id and the key index; in full once per ' +
      'session and again only after /clear or a compaction; not at methods level off), and the plugin ' +
      'notes (a newer version, and that /agent-services methods diff shows a change; never the setup questions), the ' +
      'autonomy choice you gave (one line with the working methods), one ' +
      'planning reminder at methods level ' +
      'suggest and, unless the methods level is off, a reminder to run long work in the background and the steps ' +
      'of .agent/steps.json ready to start, the just-in-time items that are due (a resumed session, a new module or every plan step done in agent-state.md, read on this computer; the service gets only the event name, once per moment and session), and once per session the hint the routing service sent for a subagent ' +
      'without a task type word, each labelled as an agent-services note. It notes locally whether ' +
      'your message asks for a review (the routing request carries only yes or no). ' +
      'With the served rule tables (signed in): secrets in your prompt (API keys, tokens, private keys, passwords after key= or --password) are replaced by {{secret:NAME}} placeholders before the model sees them; the real values stay in memory for this session only, never written or sent (/agent-services secrets lists the names). A long background subagent report is shortened the same way as in tool.call, and the shell watch adds its notes (queued run_command output, usage-limit alerts) for the main conversation.',
    shown: 'A dropped code: a toast and the sign-in answer in its place. A new served methods version: a line and ' +
      'a toast, once. The context blocks are not shown.',
  },
  {
    event: 'session.compact', matcher: '', file: 'register.ts', does: ['count', 'ui'],
    what: 'Counts the compaction and its token saving locally; after a real compaction of the main conversation ' +
      'the working methods are given again at the next prompt.',
    shown: 'A dim line now and then.',
  },
  {
    event: 'command.run', matcher: 'command: clear', file: 'register.ts', does: ['count', 'ui'],
    what: 'After /clear: starts the counters over and gives the working methods again at the next prompt.',
    shown: 'A dim line now and then.',
  },
  {
    event: 'classic.SessionEnd', matcher: '', file: 'register.ts', does: ['file', 'ui'],
    what: 'Writes the request log and the counters before the session ends.',
    shown: 'A session summary toast.',
  },
  {
    event: 'ui.render', matcher: 'component: AbovePrompt', file: 'band.ts', does: ['ui'],
    what: 'Draws above the prompt: a top row with the decisions waiting for you (.agent/pending.md) and the ' +
      'connection state, one dim line (sign-in state, savings) and, while figures show, a usage panel (tokens, quota ' +
      'and context, time saved). While setup questions are open the line says how many and ' +
      'names /agent-services setup instead (at most once every 7 days after that command ran); the questions are ' +
      'asked only when you run it.',
    shown: 'The band itself.',
  },
  {
    event: 'tool.call', matcher: 'tool: mcp__agent-services__checkpoint', file: 'flow.ts', does: ['answer', 'ui', 'context'],
    what: 'Answers the checkpoint tool (main conversation only): once that reply ends, it compacts the conversation ' +
      'with instructions that keep what the model listed, then, when the model gave a next step, sends that step ' +
      'as a message from this plugin. Nothing is compacted after an interrupted turn, and nothing is sent once you ' +
      'wrote a message yourself.',
    shown: 'The tool call, a dim line after the compaction, and the plugin\'s message with the next step.',
  },
  {
    event: 'classic.Stop', matcher: '', file: 'register.ts', does: ['deny'],
    what: 'With the served rule tables (signed in): when a main turn ends on a promise of more of its own work and ' +
      'nothing is running in the background to wake it, it is sent back once to do that work. Runs locally; sends nothing.',
    shown: 'The reason the turn was sent back, as the model\'s next instruction.',
  },
  {
    event: 'session.append', matcher: '', file: 'register.ts', does: ['rewrite'],
    what: 'With the served rule tables (signed in): after a compaction, the re-attached rows of skills invoked ' +
      'earlier, files read earlier and the deferred tool list are rewritten to one line each (instruction, memory, ' +
      'plan and task files stay whole; /agent-services trim off turns it off), and a secret in any kept row is ' +
      'masked. It counts, per day and model, the estimated tokens removed; nothing else is kept or sent.',
    shown: 'Nothing; the transcript keeps the one-line rows.',
  },
  {
    event: 'tool.call', matcher: 'tool: Bash, PowerShell', file: 'cmdguard.ts', does: ['deny'],
    what: 'With the served rule tables (signed in): a find, grep -r, rg or ls -R, or a PowerShell Get-ChildItem ' +
      '-Recurse (gci, dir, ls), whose path argument is a whole drive or the home folder, and a `cat >` with no input ' +
      'are denied (a drive reached through an earlier cd is not seen), and a git command that takes every changed file is denied ' +
      'while other agents are running; each denial says how to write the command instead. Runs locally; sends nothing.',
    shown: 'The denial reason.',
  },
  {
    event: 'tool.call', matcher: 'tool: mcp__agent-services__run_command', file: 'engines.ts', does: ['answer'],
    what: 'Answers the run_command tool (main conversation only): /reload-plugins or /context is queued for the ' +
      'idle session, any other command is refused. Answered on this machine; nothing is sent.',
    shown: 'The tool call and its answer; the command output comes with the next message.',
  },
  {
    event: 'tool.call', matcher: 'tool: Bash, PowerShell, Monitor', file: 'watch.ts', does: ['rewrite', 'context'],
    what: 'With the served rule tables (signed in), on accounts whose served rules turn it on (not product accounts): ' +
      'a foreground Bash or PowerShell command still running after the served time is moved to the background (the ' +
      'call\'s timeout is lowered; the engine moves it), and the model is told the task id and output file. Sends nothing.',
    shown: 'A note to the model with the task id.',
  },
  {
    event: 'classic.Stop', matcher: 'stop_hook_active: [true, false]', file: 'watch.ts', does: ['deny', 'context'],
    what: 'With the served rule tables (signed in): when a turn stops with a moved command still running, the model ' +
      'is asked once whether it is stuck; background tasks still running past the served time are named to the main ' +
      'conversation so ones no longer needed get stopped. Sends nothing.',
    shown: 'A note to the model.',
  },
  {
    event: 'classic.SubagentStop', matcher: 'stop_hook_active: [true, false]', file: 'watch.ts', does: ['deny', 'context'],
    what: 'The same check as classic.Stop, for a subagent that stops with a moved command still running. Sends nothing.',
    shown: 'A note to the subagent.',
  },
  {
    event: 'classic.StopFailure', matcher: 'error: rate_limit', file: 'watch.ts', does: ['context'],
    what: 'With the served rule tables (signed in): a turn that ended at the usage limit is told to carry on later, ' +
      'on the served schedule. Sends nothing.',
    shown: 'A message to the model when it may carry on.',
  },
]

export const HOOKS_ALSO =
  'Not hooks, also used: the status line ($.ui.status; with the count of open lines in .agent/pending.md), timers (the request log is written every 5 seconds; the ' +
  'update check; with the served rule tables, a check every few seconds that asks the main conversation about ' +
  'background tasks running past the served time and carries on after a usage limit), and questions in Claude Code\'s own dialog when you run a command (sign-in, /agent-services setup).'

/** The table as text, for /agent-services hooks and the setup tool. */
export function hooksText(): string {
  const rows = HOOKS.map((h) =>
    `- ${h.event}${h.matcher ? ` (${h.matcher})` : ''}: ${h.what} It ${h.does.map((d) => HOOK_EFFECTS[d] ?? d).join(', ')}. ` +
    `Shown: ${h.shown}`)
  return `The hooks this plugin registers in Claude Code (${HOOKS.length}):\n${rows.join('\n')}\n${HOOKS_ALSO}`
}

/** agent.spawn: the line shown when the routing advice set the subagent's model (every time), else the answer's own
 * notice. The throttled receipt for the same change is not repeated. */
export function spawnLine(a: { action?: unknown; set?: { model?: unknown; effort?: unknown } | null; notice?: unknown } | null): string | null {
  const notice = typeof a?.notice === 'string' && a.notice ? a.notice : null
  const model = a?.action === 'rewrite' && typeof a.set?.model === 'string' && a.set.model ? a.set.model : null
  if (!model) return notice
  const effort = typeof a?.set?.effort === 'string' && a.set.effort ? ` at ${a.set.effort} effort` : ''
  const line = `agent-services: this subagent runs on ${model}${effort}, set by the agent-services routing advice.`
  return notice && notice !== receiptText('route') ? `${line}\n${notice}` : line
}

/** agent.spawn and tool.call: a deny always says that agent-services denied it, and why. */
export function denyReason(reason: unknown, check = 'routing check'): string {
  const r = typeof reason === 'string' ? reason.trim() : ''
  if (r.startsWith('agent-services')) return r
  return r ? `agent-services ${check}: ${r}` : 'agent-services denied this call (no reason was given).'
}
