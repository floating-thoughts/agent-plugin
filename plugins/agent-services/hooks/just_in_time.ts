// Just-in-time served items (black-box step 5). A few served methods apply only at certain moments, so they no longer
// come with every phase: the plugin notices the moment on this computer and asks the service for just those items,
// sending only the event name (no text, path or file name). The moments and how they are noticed:
// - resume: the session id was already seen on this computer (kept in the plugin store, JIT_SESSIONS_KEY, with its
//   last session start or prompt) and that was JIT_RESUME_IDLE_MS ago or more. A /reload-plugins in the middle of
//   work may start the same session id again; its recent last prompt keeps it from counting as a resume.
// - module_start: agent-state.md (read at a prompt of the main conversation, or before and after the main
//   conversation writes it) turns `phase: running` or lists more plan steps than at the reading before.
// - ui: the main conversation's first edit of a UI file (UI_FILE_RX).
// - delivery: agent-state.md has plan steps and every one is checked done (`- [x]`), where the reading before had not.
// - index_request: not noticed here; the model asks lesson_lookup for it by name (the served note says when).
// Each event is asked at most once per session (the answer, or its failure, is kept in memory) and its note goes to
// the model once: with the result of the tool call that brought it, when the answer is there within JIT_WAIT_MS of
// the call's end, else with the next tool result or prompt of the main conversation. The note is the served text,
// labelled as agent-services advice (PUSH_LABEL), never as the user's words. Fail open: signed out, methods level
// off, a subagent, an older service (it refuses the field) or any failure adds nothing.
import { normPath } from './paths'
import { parseState, PUSH_LABEL, pushText, STATE_FILE, statePath } from './phase'
import { methodsLevel } from './methods_level'

type Obj = Record<string, any>
type Rt = Promise<{
  session: string
  svc: { authState(): Promise<string> }
  store: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }
  core: { ask(tool: string, args: unknown, o: { session: unknown; harness?: unknown }): Promise<Obj> }
  readText(path: string): Promise<string | null>
} | null>
type Reading = { running: boolean; steps: number; done: number }

export const JIT_PHASE: Record<string, string> = { resume: 'plan', module_start: 'implement', ui: 'test', index_request: 'deliver', delivery: 'deliver' }
export const JIT_WHY: Record<string, string> = {
  resume: 'this session resumed',
  module_start: 'a new module is starting',
  ui: 'a UI file is being edited',
  delivery: 'every plan step is checked done',
}
export const UI_FILE_RX = /\.(html?|css|scss|sass|less|jsx|tsx|vue|svelte)$/i
export const JIT_SESSIONS_KEY = 'jit_sessions' // { [session id]: at }: sessions already started on this computer
export const JIT_SESSIONS = 30 // sessions kept in JIT_SESSIONS_KEY (the most recent)
export const JIT_WAIT_MS = 1000 // the longest a tool result or a prompt waits for a note asked for it
export const JIT_RESUME_IDLE_MS = 10 * 60 * 1000 // a session start this long after the session was last seen is a resume

// session state (module memory only; a reload starts it over)
let asked = new Map<string, Promise<void>>() // event -> its one request
let notes = new Map<string, string | null>() // event -> its note once answered (null: nothing to give)
let given = new Set<string>() // events whose note the model got
let readings = new Map<string, Reading>() // agent-state.md path (lower case) -> its latest reading
let touched = 0 // when this process last wrote the session's time to JIT_SESSIONS_KEY (jitPrompt)

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

/** The facts of a state document that bring events. Pure. */
export function readingOf(text: string | null): Reading {
  const s = parseState(text)
  return { running: s.exists && s.phase === 'running', steps: s.plan.length, done: s.plan.filter((l) => /^\[[xX]\]/.test(l)).length }
}

/** The events between two readings of the same state document (none without an earlier one). Pure. */
export function stateEvents(prev: Reading | undefined, cur: Reading): string[] {
  if (!prev) return []
  const out: string[] = []
  if (cur.running && (!prev.running || cur.steps > prev.steps)) out.push('module_start')
  const finished = (r: Reading) => r.running && r.steps > 0 && r.done === r.steps
  if (finished(cur) && !finished(prev)) out.push('delivery')
  return out
}

/** The note for an event's lesson_lookup answer, or null when it has nothing to give. Pure. */
export function jitNote(event: string, answer: unknown): string | null {
  const t = pushText([answer])
  return t ? t.replace(PUSH_LABEL, `${PUSH_LABEL} Sent just in time: ${JIT_WHY[event] ?? event}.`) : null
}

/** JIT_SESSIONS_KEY's value with this session put in, the oldest dropped past JIT_SESSIONS. Pure. */
export function withSession(all: unknown, session: string, at: number): Obj {
  const map: Obj = isObj(all) ? { ...all } : {}
  map[session] = at
  const n = (v: unknown) => (typeof v === 'number' ? v : 0)
  for (const k of Object.keys(map).sort((a, b) => n(map[b]) - n(map[a])).slice(JIT_SESSIONS)) delete map[k]
  return map
}

async function active(r: NonNullable<Awaited<Rt>>): Promise<boolean> {
  return (await r.svc.authState()) === 'ok' && (await methodsLevel(r.store)) !== 'off'
}

/** Asks for an event's items once per session (never throws, never waits). */
function ask(r: NonNullable<Awaited<Rt>>, event: string): Promise<void> {
  let p = asked.get(event)
  if (!p) {
    p = (async () => {
      let note: string | null = null
      try {
        if (await active(r)) {
          note = jitNote(event, await r.core.ask('lesson_lookup', { role: 'auto', phase: JIT_PHASE[event], event }, { session: r.session, harness: 'claude-code' }))
        }
      } catch {
        note = null
      }
      notes.set(event, note)
    })()
    asked.set(event, p)
  }
  return p
}

/** The notes answered and not yet given, waiting at most JIT_WAIT_MS for `waitFor`; each is then given once. */
async function take(waitFor: Promise<void>[]): Promise<string[]> {
  if (waitFor.length) {
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([Promise.all(waitFor), new Promise((res) => { timer = setTimeout(res, JIT_WAIT_MS) })])
    if (timer) clearTimeout(timer)
  }
  const out: string[] = []
  for (const [event, note] of notes) {
    if (given.has(event) || !note) continue
    given.add(event)
    out.push(note)
  }
  return out
}

/** A new reading of a state document: the asks for the events it brings. */
function noteReading(r: NonNullable<Awaited<Rt>>, path: string, text: string | null): Promise<void>[] {
  const cur = readingOf(text)
  const events = stateEvents(readings.get(path.toLowerCase()), cur)
  readings.set(path.toLowerCase(), cur)
  return events.map((e) => ask(r, e))
}

/** session.start (background): a session id seen before is a resumed session; its note is asked now. Never throws. */
export async function jitStart(rt: Rt): Promise<void> {
  try {
    const r = await rt
    if (!r || !(await active(r))) return
    const all = await r.store.get(JIT_SESSIONS_KEY)
    const at = isObj(all) ? all[r.session] : undefined
    const now = Date.now()
    await r.store.set(JIT_SESSIONS_KEY, withSession(all, r.session, now))
    touched = now
    if (typeof at === 'number' && now - at >= JIT_RESUME_IDLE_MS) void ask(r, 'resume')
  } catch {
    // nothing to add
  }
}

/** The session's last-seen time in JIT_SESSIONS_KEY, written at most every tenth of JIT_RESUME_IDLE_MS. Never throws. */
async function touch(r: NonNullable<Awaited<Rt>>): Promise<void> {
  const now = Date.now()
  if (now - touched < JIT_RESUME_IDLE_MS / 10) return
  touched = now
  try {
    if (!(await active(r))) return // signed out or methods off: nothing is written
    await r.store.set(JIT_SESSIONS_KEY, withSession(await r.store.get(JIT_SESSIONS_KEY), r.session, now))
  } catch {
    // the next prompt tries again
  }
}

/** prompt.submit of the main conversation: the prompt with the due notes added to its context. Never throws. */
export async function jitPrompt(e: Obj, rt: Rt, cwd: () => Promise<string | null>): Promise<Obj> {
  if (e.agentId) return e
  try {
    const r = await rt
    if (!r) return e
    await touch(r)
    const dir = await cwd().catch(() => null)
    const path = typeof dir === 'string' && dir ? statePath(dir) : null
    const waits = path ? noteReading(r, path, await r.readText(path)) : []
    const due = await take([...waits, ...[...asked].filter(([ev]) => !notes.has(ev)).map(([, p]) => p)])
    return due.length ? { ...e, context: [...(Array.isArray(e.context) ? e.context : []), ...due] } : e
  } catch {
    return e
  }
}

const target = (e: Obj): string | null => {
  const p = e.file_path ?? e.notebook_path ?? e.path
  return typeof p === 'string' && p ? normPath(p) : null
}
const isState = (p: string): boolean => p.toLowerCase().endsWith(`/${STATE_FILE}`) || p.toLowerCase() === STATE_FILE

/** tool.call, before the call runs (main conversation): the UI-file ask, and the state document's reading before a
 * write to it. Returns what jitToolEnd needs; never throws, never sends a request for anything but a new event. */
export async function jitToolStart(e: Obj, rt: Rt): Promise<{ path: string | null; waits: Promise<void>[] } | null> {
  if (e.agentId || !['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(e.tool)) return null
  try {
    const p = target(e)
    const r = await rt
    if (!p || !r) return null
    const waits: Promise<void>[] = []
    if (UI_FILE_RX.test(p) && !asked.has('ui')) waits.push(ask(r, 'ui'))
    if (!isState(p)) return { path: null, waits }
    if (!readings.has(p.toLowerCase())) readings.set(p.toLowerCase(), readingOf(await r.readText(p)))
    return { path: p, waits }
  } catch {
    return null
  }
}

/** tool.call, after the call ran: its result with the due notes added (not to a denied call or a subagent's). */
export async function jitToolEnd(e: Obj, ran: Obj, started: { path: string | null; waits: Promise<void>[] } | null, rt: Rt): Promise<Obj> {
  if (e.agentId || !ran || ran.deny !== undefined) return ran
  try {
    const waits = started ? [...started.waits] : []
    if (started?.path) {
      const r = await rt
      if (r) waits.push(...noteReading(r, started.path, await r.readText(started.path)))
    }
    if (!waits.length && ![...notes].some(([ev, n]) => n && !given.has(ev))) return ran // the common case: nothing due
    const due = await take(waits)
    return due.length ? { ...ran, context: [...(Array.isArray(ran.context) ? ran.context : []), ...due] } : ran
  } catch {
    return ran
  }
}

/** Tests only: a fresh session state. */
export function jitResetForTest(): void {
  asked = new Map()
  notes = new Map()
  given = new Set()
  readings = new Map()
  touched = 0
}
