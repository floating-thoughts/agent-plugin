import type { EngineInterface } from 'claude-code'
import { checkpointCall, checkpointPersonPrompt, checkpointTurnEnd, recheckCheckpoint, setupCheckpoint } from './checkpoint'
import { countForeground, setTurnFacts, takeAdvice } from './delegate'
import { briefFor, notePersonPrompt, takeRouteHint } from './flow_state'
import { takeNotice } from './methods'
import { methodsLevel } from './methods_level'
import { rulesTable } from './rules'
import { setBandPending } from './band'
import { acceptanceCheck } from './evidence'
import { engineStore } from './store'
import { ownerCheck, redlineOverride, signedIn, spellPath, stepDone } from './subagents'
import { unlockGate, unlockPrompt } from './test_unlock'
import { globsOverlap, ownershipCheck } from './ownership'
import { toolInput } from './tools'
import { servedText } from './workflow_table'
import { captureTurnEnd, releaseHold } from './task_wire'
import { stallTurnEnd } from './stall'
import { oneLine } from './placeholders'
import { jitDeliveryTaken } from './just_in_time'
import { watchEnsureTick } from './watch'
import { NOTE_LABEL } from './review'
import { readPlan } from './plan_file'
import { globMatch } from './glob'

type Obj = Record<string, any>

export const FLOW_NOTE_LABEL = NOTE_LABEL
export const BRIEF_LABEL = '[agent-services suggestion, added to this brief by the agent-services plugin]'
export const LOCK_FILE = '.agent/test-lock.json'
export const PENDING_FILE = '.agent/pending.md'
export const STEPS_FILE = '.agent/steps.json'
export const EDIT_TOOLS: readonly string[] = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
export const LONG_TOOLS: readonly string[] = ['Bash', 'PowerShell', 'Agent', 'Task']
export const PERSON_ORIGINS: readonly string[] = ['composer', 'sdk', 'bridge']

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const slash = (p: string): string => p.replace(/\\/g, '/')


export { globMatch } from './glob'

export function relPath(file: string, cwd: string | null): string {
  const f = slash(file)
  if (!cwd) return f.replace(/^\.\//, '')
  const c = slash(cwd).replace(/\/+$/, '') + '/'
  const win = /^[a-zA-Z]:\//.test(c)
  if (win ? f.toLowerCase().startsWith(c.toLowerCase()) : f.startsWith(c)) return f.slice(c.length)
  return f.replace(/^\.\//, '')
}

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

export function hideTests(text: string | null): boolean {
  if (!text) return false
  try {
    const j = JSON.parse(text)
    return isObj(j) && j.hide_tests === true
  } catch {
    return false
  }
}

export function lockedBy(file: string, cwd: string | null, globs: readonly string[]): string | null {
  const raw = slash(file)
  const abs = /^([a-zA-Z]:)?\//.test(raw) || cwd ? spellPath(raw, cwd ?? '') : spellPath(`/${raw}`).slice(1)
  const rel = relPath(abs, cwd ? spellPath(cwd) : null)
  const paths = [rel, abs, relPath(file, cwd), raw]
  const inTree = /(?:^|\/)worktrees\/[^/]+\/(.+)$/i.exec(rel)?.[1]
  if (inTree) paths.push(inTree)
  return globs.find((g) => paths.some((p) => globMatch(g, p))) ?? null
}

export const lockReason = (file: string, glob: string): string =>
  `agent-services test lock: ${file} matches "${oneLine(glob, 200)}" in ${LOCK_FILE}, so a subagent may not change it. The edit was ` +
  'refused, and every subagent edit of a matching file is refused; no override is open to a subagent (this file never locks the ' +
  'main conversation). Leave the ' +
  'test as it is and report the change you think it needs to the main session, which may edit it.'

export function pendingCount(text: string | null): number {
  if (!text) return 0
  return text.split(/\r?\n/).filter((l) => /^\s*[-*]\s+\[ \]\s*\S/.test(l)).length
}

export const TODO_STATUSES: readonly string[] = ['todo', 'pending', 'ready', 'open', '']

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
  const done = new Set(steps.filter((s) => stepDone(s)).map((s) => String(s.id)))
  return steps
    .filter((s) => TODO_STATUSES.includes(status(s)))
    .filter((s) => {
      const deps = Array.isArray(s.deps) ? s.deps : Array.isArray(s.depends_on) ? s.depends_on : []
      return deps.every((d: unknown) => done.has(String(d)))
    })
    .map((s) => String(s.id))
}

export function readyTogether(text: string | null): { steps: string[]; unknown: string[] } {
  const ready = readySteps(text)
  if (!ready.length) return { steps: [], unknown: [] }
  const owns = new Map<string, string[]>()
  const taken: string[] = []
  try {
    const j = JSON.parse(text ?? '')
    const list: unknown[] = Array.isArray(j) ? j : isObj(j) && Array.isArray(j.steps) ? j.steps : []
    for (const s of list) {
      if (!isObj(s) || (typeof s.id !== 'string' && typeof s.id !== 'number')) continue
      const o = Array.isArray(s.owns) ? s.owns.filter((g: unknown): g is string => typeof g === 'string' && g !== '').slice(0, 50) : []
      if (!owns.has(String(s.id))) owns.set(String(s.id), o)
      const st = typeof s.status === 'string' ? s.status.trim().toLowerCase() : ''
      if (st === 'running' || st === 'in_progress') taken.push(...o)
    }
  } catch {}
  if (![...owns.values()].some((o) => o.length)) return { steps: ready, unknown: [] }
  const steps: string[] = []
  const unknown: string[] = []
  for (const id of ready) {
    const o = owns.get(id) ?? []
    if (!o.length) {
      steps.push(id)
      unknown.push(id)
    } else if (!o.some((g) => taken.some((t) => globsOverlap(g, t, true, 20000)))) {
      taken.push(...o)
      steps.push(id)
    }
  }
  return { steps, unknown }
}

export function stepCounts(text: string | null): { total: number; done: number } {
  try {
    const j = JSON.parse(text ?? '')
    const list: unknown[] = Array.isArray(j) ? j : isObj(j) && Array.isArray(j.steps) ? j.steps : []
    const steps = list.filter(isObj)
    return { total: steps.length, done: steps.filter((s) => stepDone(s)).length }
  } catch {
    return { total: 0, done: 0 }
  }
}

const labelled = (text: string | null): string | null => (text === null ? null : `${FLOW_NOTE_LABEL} ${text}`)

export const routeHintNote = (hint: string): string | null =>
  labelled(servedText('flow', 'route_hint_note', { hint: [...hint].slice(0, 500).join('') }))

export function briefedPrompt(prompt: unknown, rule: string | null): string | null {
  if (typeof prompt !== 'string' || !rule) return null
  const r = [...rule].slice(0, 2000).join('')
  if (prompt.includes(r)) return null
  return `${prompt.trimEnd()}\n\n${BRIEF_LABEL}\n${r}`
}


let lastStatus = ''
let openDecisions = 0
let lastReady = ''

export function withPending(text: string): string {
  lastStatus = text
  return text
}

async function readProject($: EngineInterface, name: string): Promise<string | null> {
  try {
    const cwd = await $.session.cwd()
    if (typeof cwd !== 'string' || !cwd) return null
    const text = String(await $.fs.read(`${slash(cwd).replace(/\/+$/, '')}/${name}`))
    return text.length > 256 * 1024 ? null : text
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

async function stepModel(rt: Ready, agent: unknown): Promise<string | null> {
  try {
    const r = (await rt) as { core?: { modelOf?: (s: string, a: string | null) => string | null }; session?: string } | null
    const m = r?.session ? r.core?.modelOf?.(r.session, typeof agent === 'string' && agent ? agent : null) : null
    return typeof m === 'string' && m ? m : null
  } catch {
    return null
  }
}

async function lockCheck($: EngineInterface, e: Obj, rt?: Ready): Promise<string | null> {
  if (![...EDIT_TOOLS, 'Bash', 'PowerShell', 'Read', 'Grep'].includes(e.tool)) return null
  let cwd: string | null = null
  try {
    const c = await $.session.cwd()
    cwd = typeof c === 'string' && c ? c : null
  } catch {}
  const input = toolInput(e)
  const file = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : null
  let lock: Promise<string | null> | null = null
  const lockText = (): Promise<string | null> => (lock ??= readProject($, LOCK_FILE))
  if (e.agentId && file && EDIT_TOOLS.includes(e.tool)) {
    const globs = lockGlobs(await lockText())
    const glob = globs.length ? lockedBy(file, cwd, globs) : null
    if (glob) return lockReason(file, glob)
  }
  const accepted = await acceptanceCheck($, e, cwd, lockedBy)
  if (accepted) return accepted
  const owned = await ownershipCheck($, e, rt)
  if (owned) return owned
  const held = await releaseHold($, e)
  if (held) return held
  const owner = await ownerCheck($, e, cwd, await stepModel(rt, e.agentId))
  if (owner) return owner
  let hide = false
  try {
    const authors = (rulesTable<Obj>('subagents') as Obj | null)?.authors
    if (e.agentId && isObj(authors) && authors.hide_reads === 'project') {
      const text = await lockText()
      hide = text !== null && text.length <= 65536 && hideTests(text)
    }
  } catch {}
  return unlockGate($, e, cwd, hide)
}

async function turnEnd($: EngineInterface, e: Obj): Promise<void> {
  stallTurnEnd(e)
  await checkpointTurnEnd($, e.reason)
  await refreshPending($)
  const stepsText = (await readPlan($, [STEPS_FILE]))?.text ?? null
  const ready = readyTogether(stepsText).steps
  const key = ready.join('\n')
  const changed = key !== lastReady
  lastReady = key
  setTurnFacts(changed ? ready.length : 0, await notesOn($))
  await captureTurnEnd($, { ...stepCounts(stepsText), ready }, jitDeliveryTaken())
  watchEnsureTick($)
}


type Ready = Promise<{ svc: { authState(): Promise<string> } } | null> | undefined
let checkpointSetUp = false

export async function flowStart($: EngineInterface, rt?: Ready): Promise<void> {
  try {
    if (!(await signedIn(rt))) return
    checkpointSetUp = true
    await setupCheckpoint($)
    await refreshPending($)
  } catch {}
}

export async function flowPrompt($: EngineInterface, e: Obj, rt?: Ready): Promise<string[]> {
  try {
    if (e.agentId || !(await signedIn(rt))) return []
    if (!checkpointSetUp) {
      checkpointSetUp = true
      await setupCheckpoint($)
    }
    if (PERSON_ORIGINS.includes(e.origin?.kind)) {
      notePersonPrompt(e.text)
      checkpointPersonPrompt()
      await redlineOverride($, e.text)
      await unlockPrompt($, e)
    }
    void recheckCheckpoint($)
    const advice = takeAdvice()
    const out = advice && (await notesOn($)) ? [advice] : []
    const hint = routeHintNote('') !== null ? takeRouteHint() : null
    const hintNote = hint ? routeHintNote(hint) : null
    if (hintNote) out.push(hintNote)
    const told = takeNotice()
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

const started = new WeakMap<object, number>()

export async function flowLock($: EngineInterface, e: Obj, rt?: Ready): Promise<string | null> {
  try {
    if (!(await signedIn(rt))) return null
    const locked = await lockCheck($, e, rt)
    if (locked) return locked
    started.set(e, Date.now())
  } catch {}
  return null
}

export async function flowAfter($: EngineInterface, e: Obj, rt?: Ready): Promise<void> {
  try {
    if (!(await signedIn(rt))) return
    const start = started.get(e)
    started.delete(e)
    const input = toolInput(e)
    const fg = !e.agentId && LONG_TOOLS.includes(e.tool) && input.run_in_background !== true
    const ms = start === undefined ? 0 : Date.now() - start
    if (fg) countForeground(ms)
    const file = input.file_path
    if (EDIT_TOOLS.includes(e.tool) && typeof file === 'string' && slash(file).endsWith(PENDING_FILE)) await refreshPending($)
  } catch {}
}

export async function flowTimed<T>($: EngineInterface, e: Obj, run: () => Promise<T>): Promise<T> {
  await flowLock($, e)
  const done = await run()
  await flowAfter($, e)
  return done
}

export async function flowTurnEnd($: EngineInterface, e: Obj, rt?: Ready): Promise<void> {
  try {
    if (!e.agentId && (await signedIn(rt))) await turnEnd($, e)
  } catch {}
}

export function installFlow(on: any): void {
  on('tool.call', { tool: 'mcp__agent-services__checkpoint' }, async ($: EngineInterface, e: Obj) => checkpointCall($, e))
    .catch(() => ({ result: 'The checkpoint could not be recorded; carry on.' }))
}
