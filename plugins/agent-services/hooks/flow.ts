// Workflow mechanisms, all local (no request of their own): the checkpoint tool (checkpoint.ts), the review flag
// for routing (flow_state.ts), the served speed-up rule added to a routed subagent's brief, the test lock, the
// pending-decisions count on the status line, the background reminder and the concurrency note.
// Project files, read from the session's working directory, never written by the plugin:
// - .agent/test-lock.json  {"locked": ["tests/**", ...]}: globs of test files a subagent may not change with Edit,
//   Write, MultiEdit or NotebookEdit (the main conversation may). Bash and other tools are not checked.
// - .agent/pending.md  one "- [ ] ..." line per decision waiting for the user ("- [x]" once answered): the status
//   line shows how many are open.
// - .agent/steps.json  {"steps": [{"id", "deps": [ids], "status": "todo" | "running" | "done"}]}: at the end of a main
//   turn that dispatched fewer subagents than there are steps ready to start (todo, every dependency done), the next
//   turn carries one note naming those steps (the same list is not repeated).
// - A foreground Bash, PowerShell or subagent call of the main conversation that ran longer than BACKGROUND_AFTER_MS:
//   the next turn carries one note suggesting background runs (at most BACKGROUND_NOTES_MAX per session).
// - The routing hint (0.6.2): the first hint the routing service sent with a pass (a description without a task type
//   word) reaches the model once per session, as a note on the next prompt of the main conversation. It follows the
//   routing level, not the methods level: the agent.spawn hook does nothing at routing off, so no hint is kept.
// The brief and the turn notes are off when the methods level is off (methods_level.ts).
import type { EngineInterface } from 'claude-code'
import { checkpointCall, checkpointPersonPrompt, checkpointTurnEnd, recheckCheckpoint, setupCheckpoint } from './checkpoint'
import { notePersonPrompt, servedBrief, takeRouteHint } from './flow_state'
import { methodsLevel } from './methods_level'
import { SEP } from './status'
import { engineStore } from './store'
import { toolInput } from './tools'

type Obj = Record<string, any>

export const BACKGROUND_AFTER_MS = 60_000
export const BACKGROUND_NOTES_MAX = 3
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

/** The glob that locks `file`, or null. Pure. */
export function lockedBy(file: string, cwd: string | null, globs: readonly string[]): string | null {
  const rel = relPath(file, cwd)
  return globs.find((g) => globRx(g).test(rel) || globRx(g).test(slash(file))) ?? null
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

/** The status line with the open-decision count added. Pure. */
export function pendingSuffix(text: string, n: number): string {
  if (n <= 0) return text
  const part = n === 1 ? '1 decision waits for you' : `${n} decisions wait for you`
  return text ? `${text}${SEP}${part}` : part
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

/** The concurrency note, or null when the dispatches cover the ready steps. Pure. */
export function stepsNote(ready: readonly string[], dispatched: number): string | null {
  if (ready.length === 0 || dispatched >= ready.length) return null
  const shown = ready.slice(0, 10).join(', ') + (ready.length > 10 ? `, and ${ready.length - 10} more` : '')
  return `${FLOW_NOTE_LABEL} ${STEPS_FILE} lists ${ready.length} step(s) ready to start (every dependency done): ` +
    `${shown}; the last turn dispatched ${dispatched} subagent(s). agent-services suggests dispatching the ` +
    'independent ones together in one reply, or updating their status in the file if they are already running or done.'
}

/** The background reminder. Pure. */
export const backgroundNote = (tool: string, ms: number): string =>
  `${FLOW_NOTE_LABEL} A foreground ${tool === 'Task' ? 'Agent' : tool} call ran for ${Math.round(ms / 1000)} s in the ` +
  'last turn. agent-services suggests starting work that may take this long in the background (run_in_background: ' +
  'true) and carrying on meanwhile; you are told when it ends.'

/** The routing hint note, shown once per session. Pure. */
export const routeHintNote = (hint: string): string =>
  `${FLOW_NOTE_LABEL} The agent-services routing service let a subagent dispatch run without routing advice and ` +
  `sent this hint for it: "${[...hint].slice(0, 500).join('')}" agent-services suggests following it in the next ` +
  'dispatches; this note is shown once per session.'

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
let dispatchedThisTurn = 0
let longCall: { tool: string; ms: number } | null = null
let backgroundNotes = 0
let lastReady = ''
let queued: string[] = []

/** register.ts setStatus: the status line text with the open-decision count added. */
export function withPending(text: string): string {
  lastStatus = text
  return pendingSuffix(text, openDecisions)
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
  if (n === openDecisions) return
  openDecisions = n
  try {
    $.ui.status(pendingSuffix(lastStatus, n))
  } catch {}
}

async function notesOn($: EngineInterface): Promise<boolean> {
  return (await methodsLevel(engineStore($))) !== 'off'
}

/** agent.spawn (register.ts): the routed subagent's event with the served speed-up rule added to its prompt. Forks,
 * teammates and workflow agents, a spawn the service did not answer, and methods level off: unchanged. */
export async function briefed($: EngineInterface, a: { fallback?: unknown } | null, ev: Obj): Promise<Obj> {
  try {
    if (!a || a.fallback || ev.fork === true || ev.isTeammate === true || ev.workflow) return ev
    const prompt = briefedPrompt(ev.prompt, servedBrief())
    if (prompt === null || !(await notesOn($))) return ev
    return { ...ev, prompt }
  } catch {
    return ev
  }
}

async function lockCheck($: EngineInterface, e: Obj): Promise<string | null> {
  if (!e.agentId || !EDIT_TOOLS.includes(e.tool)) return null
  const input = toolInput(e)
  const file = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : null
  if (!file) return null
  const globs = lockGlobs(await readProject($, LOCK_FILE))
  if (!globs.length) return null
  let cwd: string | null = null
  try {
    cwd = await $.session.cwd()
  } catch {}
  const glob = lockedBy(file, cwd, globs)
  return glob ? lockReason(file, glob) : null
}

async function turnEnd($: EngineInterface, e: Obj): Promise<void> {
  await checkpointTurnEnd($, e.reason)
  await refreshPending($)
  const ready = readySteps(await readProject($, STEPS_FILE))
  const key = ready.join('\n')
  const note = key !== lastReady ? stepsNote(ready, dispatchedThisTurn) : null
  if (note) lastReady = key
  if (ready.length === 0) lastReady = ''
  if (note) queued.push(note)
  if (longCall && backgroundNotes < BACKGROUND_NOTES_MAX) {
    backgroundNotes++
    queued.push(backgroundNote(longCall.tool, longCall.ms))
  }
  longCall = null
}

// ------------------------------------------------------------------ hook parts
// The engine takes one hook per event without a matcher from a plugin, so register.ts's hooks call these; the only
// hook registered here is the checkpoint tool's (it has a matcher). Each part fails open, and does nothing while
// signed out: register.ts passes its runtime promise (rt), and only a signed-in runtime lets a part act. A part called
// without one (the tests) acts.

type Ready = Promise<{ svc: { authState(): Promise<string> } } | null> | undefined
let checkpointSetUp = false

async function signedIn(rt: Ready): Promise<boolean> {
  if (rt === undefined) return true
  try {
    const r = await rt
    return !!r && (await r.svc.authState()) === 'ok'
  } catch {
    return false
  }
}

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
    }
    dispatchedThisTurn = 0
    void recheckCheckpoint($)
    const notes = queued.splice(0)
    const out = notes.length && (await notesOn($)) ? [notes.join('\n')] : []
    const hint = takeRouteHint() // the routing level decides this one, not the methods level
    if (hint) out.push(routeHintNote(hint))
    return out
  } catch {
    return []
  }
}

const started = new WeakMap<object, number>() // a tool.call event -> when flowLock let it through

/** tool.call, before the call runs: the test lock's deny reason, or null; a call let through is timed from here and
 * a main-conversation dispatch is counted. */
export async function flowLock($: EngineInterface, e: Obj, rt?: Ready): Promise<string | null> {
  try {
    if (!(await signedIn(rt))) return null
    const locked = await lockCheck($, e)
    if (locked) return locked
    if (!e.agentId && (e.tool === 'Agent' || e.tool === 'Task')) dispatchedThisTurn++
    started.set(e, Date.now())
  } catch {}
  return null
}

/** tool.call, after the call ran: a foreground long call of the main conversation is kept for the next turn's note;
 * an edit of the pending file refreshes the count. */
export async function flowAfter($: EngineInterface, e: Obj, rt?: Ready): Promise<void> {
  try {
    if (!(await signedIn(rt))) return
    const start = started.get(e)
    started.delete(e)
    const input = toolInput(e)
    const fg = !e.agentId && LONG_TOOLS.includes(e.tool) && input.run_in_background !== true
    const ms = start === undefined ? 0 : Date.now() - start
    if (fg && ms >= BACKGROUND_AFTER_MS && (!longCall || ms > longCall.ms)) longCall = { tool: e.tool, ms }
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

/** turn.complete, after next(e): the main conversation's checkpoint compaction and next turn's notes. */
export async function flowTurnEnd($: EngineInterface, e: Obj, rt?: Ready): Promise<void> {
  try {
    if (!e.agentId && (await signedIn(rt))) await turnEnd($, e)
  } catch {}
}

export function installFlow(on: any): void {
  on('tool.call', { tool: 'mcp__agent-services__checkpoint' }, async ($: EngineInterface, e: Obj) => checkpointCall($, e))
    .catch(() => ({ result: 'The checkpoint could not be recorded; carry on.' }))
}
