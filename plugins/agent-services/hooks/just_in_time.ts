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

export const JIT_PHASE: Record<string, string> = { resume: 'plan', module_start: 'implement', ui: 'test', delivery: 'deliver' }
export const JIT_WHY: Record<string, string> = {
  resume: 'this session resumed',
  module_start: 'a new module is starting',
  ui: 'a UI file is being edited',
  delivery: 'every plan step is checked done',
}
export const UI_FILE_RX = /\.(html?|css|scss|sass|less|jsx|tsx|vue|svelte)$/i
export const JIT_SESSIONS_KEY = 'jit_sessions'
export const JIT_SESSIONS = 30
export const JIT_WAIT_MS = 1000
export const JIT_RESUME_IDLE_MS = 10 * 60 * 1000

let asked = new Map<string, Promise<void>>()
let notes = new Map<string, string | null>()
let given = new Set<string>()
let readings = new Map<string, Reading>()
let touched = 0
let deliveryMoment = false

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

export function readingOf(text: string | null): Reading {
  const s = parseState(text)
  return { running: s.exists && s.phase === 'running', steps: s.plan.length, done: s.plan.filter((l) => /^\[[xX]\]/.test(l)).length }
}

export function stateEvents(prev: Reading | undefined, cur: Reading): string[] {
  if (!prev) return []
  const out: string[] = []
  if (cur.running && (!prev.running || cur.steps > prev.steps)) out.push('module_start')
  const finished = (r: Reading) => r.running && r.steps > 0 && r.done === r.steps
  if (finished(cur) && !finished(prev)) out.push('delivery')
  return out
}

export function jitNote(event: string, answer: unknown): string | null {
  const t = pushText([answer])
  return t ? t.replace(PUSH_LABEL, `${PUSH_LABEL} Sent just in time: ${JIT_WHY[event] ?? event}.`) : null
}

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

function noteReading(r: NonNullable<Awaited<Rt>>, path: string, text: string | null): Promise<void>[] {
  const cur = readingOf(text)
  const events = stateEvents(readings.get(path.toLowerCase()), cur)
  readings.set(path.toLowerCase(), cur)
  if (events.includes('delivery')) deliveryMoment = true
  return events.map((e) => ask(r, e))
}

export function jitDeliveryTaken(): boolean {
  const was = deliveryMoment
  deliveryMoment = false
  return was
}

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
  }
}

async function touch(r: NonNullable<Awaited<Rt>>): Promise<void> {
  const now = Date.now()
  if (now - touched < JIT_RESUME_IDLE_MS / 10) return
  touched = now
  try {
    if (!(await active(r))) return
    await r.store.set(JIT_SESSIONS_KEY, withSession(await r.store.get(JIT_SESSIONS_KEY), r.session, now))
  } catch {
  }
}

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

export async function jitToolEnd(e: Obj, ran: Obj, started: { path: string | null; waits: Promise<void>[] } | null, rt: Rt): Promise<Obj> {
  if (e.agentId || !ran || ran.deny !== undefined) return ran
  try {
    const waits = started ? [...started.waits] : []
    if (started?.path) {
      const r = await rt
      if (r) waits.push(...noteReading(r, started.path, await r.readText(started.path)))
    }
    if (!waits.length && ![...notes].some(([ev, n]) => n && !given.has(ev))) return ran
    const due = await take(waits)
    return due.length ? { ...ran, context: [...(Array.isArray(ran.context) ? ran.context : []), ...due] } : ran
  } catch {
    return ran
  }
}

export function jitResetForTest(): void {
  asked = new Map()
  notes = new Map()
  given = new Set()
  readings = new Map()
  touched = 0
  deliveryMoment = false
}
