import { CONTRACT } from './contract'
import { sha256 } from './noble.js'
import { SUGGESTION_PREFIX } from './review'
import type { EngineInterface } from 'claude-code'
import { readPlan } from './plan_file'

type Obj = Record<string, any>
export type TurnCounts = Record<string, number | { case: string; ago: number; times: number }[]>

export const ADVICE_LABEL = `[${SUGGESTION_PREFIX}, not written by the user]`
const adviceCases = (): string[] => {
  try {
    const r = (CONTRACT as any).routes.find((x: Obj) => x.path === '/checkpoint/timing')
    return [...r.responses['200'].properties.cases.items.enum]
  } catch {
    return []
  }
}

const fresh = () => ({ reads: 0, searches: 0, web: 0, run: 0, lookup_run: 0, shell_kchars: 0, read_kchars: 0, denials: 0,
  same_failure: 0, steps_ready: 0, subagents_dispatched: 0, foreground_seconds: 0 })

let turnNo = 0
let c = fresh()
let on = true
let history: Record<string, { turn: number; times: number }> = {}
let failures = new Map<string, { n: number; turn: number }>()
const FAILURE_TURNS = 3
let advice: string | null = null
const salt = `${Date.now()}:${Math.random()}`

export function delegateResetForTest(): void {
  turnNo = 0
  c = fresh()
  on = true
  history = {}
  failures = new Map()
  advice = null
}

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const cap = (n: number, max = 100000): number => Math.max(0, Math.min(Math.trunc(n), max))

function charsOf(v: unknown, depth = 0): number {
  if (typeof v === 'string') return v.length
  if (depth > 8 || !v || typeof v !== 'object') return 0
  let n = 0
  for (const x of Array.isArray(v) ? v : Object.values(v)) n += charsOf(x, depth + 1)
  return n
}

function allText(v: unknown, depth = 0): string {
  if (typeof v === 'string') return v
  if (depth > 8 || !v || typeof v !== 'object') return ''
  return (Array.isArray(v) ? v : Object.values(v)).map((x) => allText(x, depth + 1)).filter((t) => t.trim()).join('\n')
}

function failureKey(tool: string, result: unknown): string | null {
  const lines = allText(result).slice(-20000).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (!lines.length) return null
  const errors = lines.filter((l) => /error|fail|exception|traceback|fatal|panic|denied|refused|not found|cannot|assert/i.test(l))
  const sig = (errors.length ? errors.slice(-4) : lines.slice(-3)).map((l) => l.slice(0, 200).replace(/\d+/g, '#'))
  const text = `${salt}\n${tool}\n${sig.join('\n')}`
  return Array.from(sha256(new TextEncoder().encode(text)), (b) => b.toString(16).padStart(2, '0')).join('')
}

export function delegateTurn(e: Obj): void {
  try {
    if (!isObj(e) || e.agentId) return
    turnNo += 1
    c = fresh()
  } catch {}
}

export function countDenied(e: Obj): void {
  if (isObj(e) && !e.agentId) c.denials += 1
}

export function delegateAfter(e: Obj, done: Obj): Obj {
  try {
    if (!isObj(e) || e.agentId || !isObj(done)) return done
    const tool = String(e.tool ?? '')
    if (done.deny !== undefined) {
      c.denials += 1
      return done
    }
    if (tool === 'Read') c.reads += 1
    if (tool === 'Grep' || tool === 'Glob') c.searches += 1
    if (tool === 'WebFetch' || tool === 'WebSearch') c.web += 1
    if (tool === 'Agent' || tool === 'Task') c.subagents_dispatched += 1
    if (tool === 'Read' || tool === 'Grep' || tool === 'Glob') c.lookup_run = Math.max(c.lookup_run, ++c.run)
    if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) c.run = 0
    const k = Math.floor(charsOf(done.result) / 1000)
    if (tool === 'Bash' || tool === 'PowerShell') c.shell_kchars = Math.max(c.shell_kchars, k)
    if (tool === 'Read') c.read_kchars = Math.max(c.read_kchars, k)
    if (done.isError === true) {
      const key = failureKey(tool, done.result)
      if (key) {
        if (failures.size >= 500) failures.clear()
        const seen = failures.get(key)
        const live = seen && turnNo - seen.turn < FAILURE_TURNS ? seen : { n: 0, turn: turnNo }
        const n = live.n + 1
        failures.set(key, { n, turn: live.turn })
        c.same_failure = Math.max(c.same_failure, n)
      }
    }
  } catch {}
  return done
}

export type DispatchFacts = { plan_done?: true; prior_failures?: number }

async function planDone($: EngineInterface): Promise<boolean> {
  try {
    const plan = await readPlan($, [])
    if (!plan) return false
    const steps = (JSON.parse(plan.text) as { steps?: { status?: string }[] }).steps
    return Array.isArray(steps) && steps.length > 0 && steps.every((s) => s?.status === 'done')
  } catch {
    return false
  }
}

export async function dispatchFacts($: EngineInterface, agent: string | null): Promise<DispatchFacts> {
  const out: DispatchFacts = {}
  if (await planDone($)) out.plan_done = true
  const n = agent === null && on ? c.same_failure : 0
  if (Number.isInteger(n) && n >= 1) out.prior_failures = Math.min(n, 1000)
  return out
}

export function countForeground(ms: number): void {
  if (Number.isFinite(ms)) c.foreground_seconds = Math.max(c.foreground_seconds, cap(ms / 1000, 604800))
}

export function setTurnFacts(stepsReady: number, notesOn: boolean): void {
  c.steps_ready = cap(stepsReady)
  on = notesOn
}

export function takeTurn(): TurnCounts | null {
  if (!on) return null
  const out: TurnCounts = {}
  for (const [k, v] of Object.entries(c)) if (k !== 'run' && v > 0) out[k] = cap(v, k === 'foreground_seconds' ? 604800 : 100000)
  if (!Object.keys(out).length) return null
  const seen = Object.entries(history).slice(0, 8).map(([k, h]) => ({ case: k, ago: cap(turnNo - h.turn), times: cap(h.times) }))
  if (seen.length) out.history = seen
  return out
}

export function adviceIn(note: unknown, cases: unknown): void {
  if (!on || typeof note !== 'string' || !note.trim()) return
  advice = note.trim()
  for (const k of Array.isArray(cases) ? cases : []) {
    if (typeof k !== 'string' || !adviceCases().includes(k)) continue
    history[k] = { turn: turnNo, times: (history[k]?.times ?? 0) + 1 }
  }
}

export function takeAdvice(): string | null {
  const a = advice
  advice = null
  return a === null ? null : `${ADVICE_LABEL}\n${a}`
}
