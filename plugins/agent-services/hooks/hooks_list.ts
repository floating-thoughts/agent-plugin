// Every hook this plugin registers, as a fixed table (owner 2026-11-01): `/agent-services hooks` and the setup tool's
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
    what: 'Registers the tools and the slash command. In the background: the sign-in check, the daily usage upload ' +
      '(only after you turned the savings record on), the start notices, the request-log cleanup (90 days), the ' +
      'working methods for the first prompt and the CLAUDE.md methods file (only after trust on), a one-time move ' +
      'from an older version, and the update check (`claude plugin list --json` and `claude plugin marketplace ' +
      'update agent-plugin`; it never updates the plugin).',
    shown: 'Start notices as dim lines or toasts.',
  },
  {
    event: 'agent.spawn', matcher: '', file: 'register.ts', does: ['network', 'deny', 'rewrite', 'ui'],
    what: 'Asks the service for routing advice on each subagent (forks and teammates are skipped). The advice can ' +
      'deny the subagent with a reason, or set its model and effort.',
    shown: 'A deny shows its reason, which starts with "agent-services routing". A changed model is said each ' +
      'time in a dim line naming the model.',
  },
  {
    event: 'turn.step', matcher: '', file: 'register.ts', does: ['rewrite', 'count'],
    what: 'Counts token usage locally. For a subagent whose model agent-services set, it also sets the effort of ' +
      'its model requests to the advised effort.',
    shown: 'The dim line at the subagent\'s start names it.',
  },
  {
    event: 'tool.call', matcher: '', file: 'register.ts', does: ['deny', 'count'],
    what: 'The planning gate: while you are signed in, it denies Edit, Write, MultiEdit and NotebookEdit of the ' +
      'main agent when the project has no agent-state.md, or it is still in planning, or it has no goal and plan ' +
      '(writes to agent-state.md itself always go through). It also counts tool calls, commits and finished todos ' +
      'locally, and the size of files read in parts. It never changes a tool\'s input.',
    shown: 'The deny reason, which starts with "agent-services planning gate".',
  },
  {
    event: 'tool.call', matcher: 'tool: mcp__agent-services__<tool>', file: 'tools.ts', does: ['answer', 'network'],
    what: 'Answers this plugin\'s own tools: router_advice, lesson_lookup, checkpoint_advice, savings and status.',
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
    what: 'Runs one subcommand from a fixed list with the answer you gave (sharing, savings, dashboard, trust, ' +
      'update, data, hooks).',
    shown: 'The tool call and its answer.',
  },
  {
    event: 'command.run', matcher: 'command: agent-services', file: 'command.ts', does: ['answer', 'network', 'file', 'ui'],
    what: 'The /agent-services slash command.',
    shown: 'Its answer.',
  },
  {
    event: 'turn.complete', matcher: '', file: 'register.ts', does: ['network', 'file', 'ui'],
    what: 'Asks the service whether this is a good moment to compact (counters only). Publishes your private ' +
      'savings page (and a company admin\'s board) with Claude Code\'s Artifact tool, only when you allowed it.',
    shown: 'The Artifact call.',
  },
  {
    event: 'tool.check', matcher: 'tool: Artifact', file: 'register.ts', does: ['answer'],
    what: 'Allows this plugin\'s own savings-page publish without a permission prompt once you allowed it. A deny ' +
      'from your own rule or hook stands; every other Artifact call goes on unchanged.',
    shown: 'The permission reason "agent-services dashboard (user allowed)".',
  },
  {
    event: 'prompt.submit', matcher: '', file: 'register.ts', does: ['drop', 'context', 'ui'],
    what: 'Drops a message that is only a sign-in code while a sign-in waits for one, and finishes the sign-in with ' +
      'it, so the code never reaches the model. Adds context blocks for the model, after your text and without ' +
      'changing it: the service\'s compaction advice, the working methods of the current phase, and the plugin ' +
      'notes (the setup question, a newer version, the methods review), each labelled as an agent-services note.',
    shown: 'A dropped code: a toast and the sign-in answer in its place. The context blocks are not shown.',
  },
  {
    event: 'session.compact', matcher: '', file: 'register.ts', does: ['count', 'ui'],
    what: 'Counts the compaction and its token saving locally.',
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
    what: 'Draws one dim line above the prompt (sign-in state, savings).',
    shown: 'The line itself.',
  },
]

export const HOOKS_ALSO =
  'Not hooks, also used: the status line ($.ui.status), timers (the request log is written every 5 seconds; the ' +
  'update check), and questions in Claude Code\'s own dialog when you run a command (sign-in, savings record).'

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
