// Workflow mechanisms, all local (no request of their own): the checkpoint tool (checkpoint.ts), the review flag
// for routing (flow_state.ts), the served speed-up rule added to a routed subagent's brief, the test lock, the
// pending-decisions count on the status line, and the facts of a turn the turn advice needs (delegate.ts).
// Project files, read from the session's working directory, never written by the plugin:
// - .agent/test-lock.json  {"locked": ["tests/**", ...]}: globs of test files a subagent may not change with Edit,
//   Write, MultiEdit or NotebookEdit (the main conversation may). Bash and other tools are not checked. Beside it,
//   the served test-author lock (subagents.ts) keeps another subagent off a test file an agent wrote this session.
// - .agent/pending.md  one "- [ ] ..." line per decision waiting for the user ("- [x]" once answered): the status
//   line shows how many are open.
// - .agent/steps.json  {"steps": [{"id", "deps": [ids], "status": "todo" | "running" | "done"}]}: at the end of a main
//   turn, how many steps are ready to start (todo, every dependency done) goes into the turn's counts, only when that
//   list changed since it was last counted; the step ids are never sent.
// - How long a foreground Bash, PowerShell or subagent call of the main conversation ran goes into the turn's counts.
// The turn advice itself (which note, when, its text) comes from the service with the checkpoint timing answer and
// reaches the model at the next prompt.
// - The routing hint (0.6.2): the first hint the routing service sent with a pass (a description without a task type
//   word) reaches the model once per session, as a note on the next prompt of the main conversation. It follows the
//   routing level, not the methods level: the agent.spawn hook does nothing at routing off, so no hint is kept.
// The brief, the turn counts and the turn advice are off when the methods level is off (methods_level.ts).
import type { EngineInterface } from 'claude-code'
import { checkpointCall, checkpointPersonPrompt, checkpointTurnEnd, recheckCheckpoint, setupCheckpoint } from './checkpoint'
import { countForeground, setTurnFacts, takeAdvice } from './delegate'
import { briefFor, notePersonPrompt, takeRouteHint } from './flow_state'
import { takeNotice } from './methods'
import { methodsLevel } from './methods_level'
import { setBandPending } from './band'
import { engineStore } from './store'
import { authorCheck, ownerCheck, redlineOverride, signedIn } from './subagents'
import { toolInput } from './tools'
import { servedText } from './workflow_table'

type Obj = Record<string, any>

export const FLOW_NOTE_LABEL = '[agent-services plugin note, not written by the user]'
export const BRIEF_LABEL = '[agent-services suggestion, added to this brief by the agent-services plugin]'
export const LOCK_FILE = '.agent/test-lock.json'
export const PENDING_FILE = '.agent/pending.md'
export const STEPS_FILE = '.agent/steps.json'
export const EDIT_TOOLS: readonly string[] = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
export const LONG_TOOLS: readonly string[] = ['Bash', 'PowerShell', 'Agent', 'Task']
export const PERSON_ORIGINS: readonly string[] = ['composer', 'sdk', 'bridge']

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const slash = (p: string): string => p.replace(/\\/g, '/')

// ------------------------------------------------------------------ pure parts

/** A glob ("**" any depth, "*" within one segment, "?" one character) as an anchored regex. Pure. */
export function globRx(glob: string): RegExp {
  let rx = ''
  const g = slash(glob.trim()).replace(/^\.\//, '')
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!
    if (c === '*' && g[i + 1] === '*') {
      i++
      if (g[i + 1] === '/') {
        i++
        rx += '(?:.*/)?'
      } else rx += '.*'
    } else if (c === '*') rx += '[^/]*'
    else if (c === '?') rx += '[^/]'
    else rx += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${rx}$`, 'i') // without case: a lock that matches too much only denies, never lets through
}

/** The project-relative path of `file` under `cwd` (absolute paths outside it stay absolute). Pure. */
export function relPath(file: string, cwd: string | null): string {
  const f = slash(file)
  if (!cwd) return f.replace(/^\.\//, '')
  const c = slash(cwd).replace(/\/+$/, '') + '/'
  const win = /^[a-zA-Z]:\//.test(c)
  if (win ? f.toLowerCase().startsWith(c.toLowerCase()) : f.startsWith(c)) return f.slice(c.length)
  return f.replace(/^\.\//, '')
}

/** The lock file's globs; [] for anything but {"locked": [strings]} (or a bare list). Pure. */
export function lockGlobs(text: string | null): string[] {
  if (!text) return []
  try {
    const j = JSON.parse(text)
    const list = Array.isArray(j) ? j : isObj(j) && Array.isArray(j.locked) ? j.locked : []
    return list.filter((x: unknown): x is string => typeof x === 'string' && x.trim() !== '').slice(0, 200)
  } catch {
    return []
  }
}

/** The glob that locks `file`, or null; a file in a git worktree (".../worktrees/<id>/...", where a subagent with
 * isolation works) is also matched by its path inside that worktree. Pure. */
export function lockedBy(file: string, cwd: string | null, globs: readonly string[]): string | null {
  const rel = relPath(file, cwd)
  const paths = [rel, slash(file)]
  const inTree = /(?:^|\/)worktrees\/[^/]+\/(.+)$/i.exec(rel)?.[1] // a match too many only denies
  if (inTree) paths.push(inTree)
  return globs.find((g) => paths.some((p) => globRx(g).test(p))) ?? null
}

/** The deny reason for a subagent's edit of a locked test file. Pure. */
export const lockReason = (file: string, glob: string): string =>
  `agent-services test lock: ${file} matches "${glob}" in ${LOCK_FILE}, so a subagent may not change it. Leave the ` +
  'test as it is and report the change you think it needs to the main session, which may edit it.'

/** Open decisions in the pending file: lines "- [ ] ..." (or "* [ ]"). Pure. */
export function pendingCount(text: string | null): number {
  if (!text) return 0
  return text.split(/\r?\n/).filter((l) => /^\s*[-*]\s+\[ \]\s*\S/.test(l)).length
}

export const DONE_STATUSES: readonly string[] = ['done', 'completed', 'complete']
export const TODO_STATUSES: readonly string[] = ['todo', 'pending', 'ready', 'open', '']

/** The ids of the steps ready to start: status todo (or none) and every dependency done. Pure. */
export function readySteps(text: string | null): string[] {
  if (!text) return []
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    return []
  }
  const list: unknown[] = Array.isArray(j) ? j : isObj(j) && Array.isArray(j.steps) ? j.steps : []
  const steps = list.filter(isObj).filter((s) => typeof s.id === 'string' || typeof s.id === 'number')
  const status = (s: Obj) => (typeof s.status === 'string' ? s.status.trim().toLowerCase() : '')
  const done = new Set(steps.filter((s) => DONE_STATUSES.includes(status(s))).map((s) => String(s.id)))
  return steps
    .filter((s) => TODO_STATUSES.includes(status(s)))
    .filter((s) => {
      const deps = Array.isArray(s.deps) ? s.deps : Array.isArray(s.depends_on) ? s.depends_on : []
      return deps.every((d: unknown) => done.has(String(d)))
    })
    .map((s) => String(s.id))
}

// The routing hint's text comes from the served workflow table (section flow, workflow_table.ts); without it the
// note is null and the hint is kept. The label in front of it stays local.
const labelled = (text: string | null): string | null => (text === null ? null : `${FLOW_NOTE_LABEL} ${text}`)

/** The routing hint note, shown once per session, or null without the table. */
export const routeHintNote = (hint: string): string | null =>
  labelled(servedText('flow', 'route_hint_note', { hint: [...hint].slice(0, 500).join('') }))

/** The subagent prompt with the served rule added once; unchanged without a rule or when it already holds it. Pure. */
export function briefedPrompt(prompt: unknown, rule: string | null): string | null {
  if (typeof prompt !== 'string' || !rule) return null
  const r = [...rule].slice(0, 2000).join('')
  if (prompt.includes(r)) return null
  return `${prompt.replace(/\s+$/, '')}\n\n${BRIEF_LABEL}\n${r}`
}

// ------------------------------------------------------------------ session state

let lastStatus = '' // the status line as the plugin last set it, before the count
let openDecisions = 0
let lastReady = ''

/** register.ts setStatus: the status line text with the open-decision count added. */
export function withPending(text: string): string {
  lastStatus = text
  return text // the open-decision count shows at the top of the band (band.ts setBandPending), not in the status line
}

async function readProject($: EngineInterface, name: string): Promise<string | null> {
  try {
    const cwd = await $.session.cwd()
    if (typeof cwd !== 'string' || !cwd) return null
    return String(await $.fs.read(`${slash(cwd).replace(/\/+$/, '')}/${name}`))
  } catch {
    return null
  }
}

async function refreshPending($: EngineInterface): Promise<void> {
  const n = pendingCount(await readProject($, PENDING_FILE))
  setBandPending(n)
  if (n === openDecisions) return
  openDecisions = n
}

async function notesOn($: EngineInterface): Promise<boolean> {
  return (await methodsLevel(engineStore($))) !== 'off'
}

/** agent.spawn (register.ts): the routed subagent's event with the served brief rule of this spawn's own routing
 * answer (its tool call id; else the session's latest) added to its prompt. Forks,
 * teammates and workflow agents, a spawn the service did not answer, and methods level off: unchanged. */
export async function briefed($: EngineInterface, a: { fallback?: unknown } | null, ev: Obj): Promise<Obj> {
  try {
    if (!a || a.fallback || ev.fork === true || ev.isTeammate === true || ev.workflow) return ev
    const prompt = briefedPrompt(ev.prompt, briefFor(ev.tool_use_id))
    if (prompt === null || !(await notesOn($))) return ev
    return { ...ev, prompt }
  } catch {
    return ev
  }
}

// The model the calling agent's last step ran on (the runtime's core keeps it), or null.
async function stepModel(rt: Ready, agent: unknown): Promise<string | null> {
  try {
    const r = (await rt) as { core?: { modelOf?: (s: string, a: string | null) => string | null }; session?: string } | null
    const m = r?.session ? r.core?.modelOf?.(r.session, typeof agent === 'string' && agent ? agent : null) : null
    return typeof m === 'string' && m ? m : null
  } catch {
    return null
  }
}

// The explicit lock file first (subagent edits only), then the served demand lock and commit check, then the served
// test-author lock (subagents.ts), which also notes who wrote each test file this session.
async function lockCheck($: EngineInterface, e: Obj, rt?: Ready): Promise<string | null> {
  if (![...EDIT_TOOLS, 'Bash', 'PowerShell', 'Read', 'Grep'].includes(e.tool)) return null
  let cwd: string | null = null
  try {
    const c = await $.session.cwd()
    cwd = typeof c === 'string' && c ? c : null
  } catch {}
  const input = toolInput(e)
  const file = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : null
  if (e.agentId && file && EDIT_TOOLS.includes(e.tool)) {
    const globs = lockGlobs(await readProject($, LOCK_FILE))
    const glob = globs.length ? lockedBy(file, cwd, globs) : null
    if (glob) return lockReason(file, glob)
  }
  return (await ownerCheck($, e, cwd, await stepModel(rt, e.agentId))) ?? authorCheck(e, cwd)
}

async function turnEnd($: EngineInterface, e: Obj): Promise<void> {
  await checkpointTurnEnd($, e.reason)
  await refreshPending($)
  const ready = readySteps(await readProject($, STEPS_FILE))
  const key = ready.join('\n')
  const changed = key !== lastReady
  lastReady = key
  setTurnFacts(changed ? ready.length : 0, await notesOn($)) // delegate.ts: read by the core's turn-end request
}

// ------------------------------------------------------------------ hook parts
// The engine takes one hook per event without a matcher from a plugin, so register.ts's hooks call these; the only
// hook registered here is the checkpoint tool's (it has a matcher). Each part fails open, and does nothing while
// signed out: register.ts passes its runtime promise (rt), and only a signed-in runtime lets a part act. A part called
// without one (the tests) acts.

type Ready = Promise<{ svc: { authState(): Promise<string> } } | null> | undefined
let checkpointSetUp = false

/** session.start, after next(e): the other plugins' tools are registered by now. */
export async function flowStart($: EngineInterface, rt?: Ready): Promise<void> {
  try {
    if (!(await signedIn(rt))) return
    checkpointSetUp = true
    await setupCheckpoint($)
    await refreshPending($)
  } catch {}
}

/** prompt.submit of any agent: the context blocks to add (main conversation only; text untouched). */
export async function flowPrompt($: EngineInterface, e: Obj, rt?: Ready): Promise<string[]> {
  try {
    if (e.agentId || !(await signedIn(rt))) return []
    if (!checkpointSetUp) { // signed in after the session started
      checkpointSetUp = true
      await setupCheckpoint($)
    }
    if (PERSON_ORIGINS.includes(e.origin?.kind)) {
      notePersonPrompt(e.text)
      checkpointPersonPrompt()
      await redlineOverride($, e.text) // the user's own words only: allows spawns past the usage line until the reset
    }
    void recheckCheckpoint($)
    const advice = takeAdvice() // delegate.ts: the service's note on the last turn, labelled
    const out = advice && (await notesOn($)) ? [advice] : []
    // the routing level decides this one, not the methods level; without the table the hint is kept for later
    const hint = routeHintNote('') !== null ? takeRouteHint() : null
    const hintNote = hint ? routeHintNote(hint) : null
    if (hintNote) out.push(hintNote)
    const told = takeNotice() // methods.ts: a new served methods version, for the user (never the model)
    if (told) {
      try {
        $.ui.log(told)
      } catch {}
      try {
        $.ui.toast(told)
      } catch {}
    }
    return out
  } catch {
    return []
  }
}

const started = new WeakMap<object, number>() // a tool.call event -> when flowLock let it through

/** tool.call, before the call runs: the test lock's deny reason, or null; a call let through is timed from here. */
export async function flowLock($: EngineInterface, e: Obj, rt?: Ready): Promise<string | null> {
  try {
    if (!(await signedIn(rt))) return null
    const locked = await lockCheck($, e, rt)
    if (locked) return locked
    started.set(e, Date.now())
  } catch {}
  return null
}

/** tool.call, after the call ran: a foreground call of the main conversation is timed for the turn's counts; an
 * edit of the pending file refreshes the count. */
export async function flowAfter($: EngineInterface, e: Obj, rt?: Ready): Promise<void> {
  try {
    if (!(await signedIn(rt))) return
    const start = started.get(e)
    started.delete(e)
    const input = toolInput(e)
    const fg = !e.agentId && LONG_TOOLS.includes(e.tool) && input.run_in_background !== true
    const ms = start === undefined ? 0 : Date.now() - start
    if (fg) countForeground(ms) // delegate.ts
    const file = input.file_path
    if (EDIT_TOOLS.includes(e.tool) && typeof file === 'string' && slash(file).endsWith(PENDING_FILE)) await refreshPending($)
  } catch {}
}

/** flowLock, the call, flowAfter: the order register.ts's tool.call hook runs them in (for tests). */
export async function flowTimed<T>($: EngineInterface, e: Obj, run: () => Promise<T>): Promise<T> {
  await flowLock($, e)
  const done = await run()
  await flowAfter($, e)
  return done
}

/** turn.complete, after next(e): the main conversation's checkpoint compaction and the turn's facts. */
export async function flowTurnEnd($: EngineInterface, e: Obj, rt?: Ready): Promise<void> {
  try {
    if (!e.agentId && (await signedIn(rt))) await turnEnd($, e)
  } catch {}
}

export function installFlow(on: any): void {
  on('tool.call', { tool: 'mcp__agent-services__checkpoint' }, async ($: EngineInterface, e: Obj) => checkpointCall($, e))
    .catch(() => ({ result: 'The checkpoint could not be recorded; carry on.' }))
}
