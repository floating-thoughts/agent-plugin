// Per-turn counters for the turn advice (0.10: they replace the local delegation hints and turn notes). The main
// conversation's tool calls in one turn are counted in this module's memory; at the end of the turn the core sends
// the counts with its checkpoint timing request, and the service may answer with a short labelled note, which the
// next prompt carries (flow.ts). Only counts leave the machine: no tool name, input, output, path or error text.
// A failed call's signature (its last error lines) is compared with earlier ones as a salted hash kept in memory only,
// so only "how often the same failure happened" is known. A subagent's calls are never counted.
import { CONTRACT } from './contract'
import { sha256 } from './noble.js'

type Obj = Record<string, any>
export type TurnCounts = Record<string, number | { case: string; ago: number; times: number }[]>

export const ADVICE_LABEL = '[agent-services server note, not written by the user]'
// the case ids the contract knows (the answer's cases enum); any other is never sent back
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

// session state (module memory only; a reload starts it over)
let turnNo = 0
let c = fresh()
let on = true // flow.ts: false while the methods level is off (then nothing is sent and no note is kept)
let history: Record<string, { turn: number; times: number }> = {}
let failures = new Map<string, number>() // salted hash of a failure's signature -> times seen this session
let advice: string | null = null
const salt = `${Date.now()}:${Math.random()}`

/** Tests: a fresh session. */
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

/** The characters of every string in a tool's result (its text as the model gets it, roughly). */
function charsOf(v: unknown, depth = 0): number {
  if (typeof v === 'string') return v.length
  if (depth > 8 || !v || typeof v !== 'object') return 0
  let n = 0
  for (const x of Array.isArray(v) ? v : Object.values(v)) n += charsOf(x, depth + 1)
  return n
}

/** Every string in a result, depth first, joined by newlines (the error often sits in a later one, e.g. stderr). */
function allText(v: unknown, depth = 0): string {
  if (typeof v === 'string') return v
  if (depth > 8 || !v || typeof v !== 'object') return ''
  return (Array.isArray(v) ? v : Object.values(v)).map((x) => allText(x, depth + 1)).filter((t) => t.trim()).join('\n')
}

/** The salted hash of a failure: the tool and its last 4 error lines (else its last 3 lines) within the last 20000
 * characters, digits folded (line numbers, times, counts), each line cut to 200 characters. Results often start with
 * a constant header (pytest's session line, "Exit code N"), so the signature comes from the end, where errors are. */
function failureKey(tool: string, result: unknown): string | null {
  const lines = allText(result).slice(-20000).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (!lines.length) return null
  const errors = lines.filter((l) => /error|fail|exception|traceback|fatal|panic|denied|refused|not found|cannot|assert/i.test(l))
  const sig = (errors.length ? errors.slice(-4) : lines.slice(-3)).map((l) => l.slice(0, 200).replace(/\d+/g, '#'))
  const text = `${salt}\n${tool}\n${sig.join('\n')}`
  return Array.from(sha256(new TextEncoder().encode(text)), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** prompt.submit (engines.ts promptIn): a main-conversation prompt starts a new turn; a subagent's prompt is not one. */
export function delegateTurn(e: Obj): void {
  try {
    if (!isObj(e) || e.agentId) return
    turnNo += 1
    c = fresh()
  } catch {}
}

/** A main-conversation call refused before it ran (this plugin's own checks, register.ts). */
export function countDenied(e: Obj): void {
  if (isObj(e) && !e.agentId) c.denials += 1
}

/** tool.call, after the tool ran (engines.ts toolRun): the main conversation's call counted; the result unchanged. */
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
        const n = (failures.get(key) ?? 0) + 1
        failures.set(key, n)
        c.same_failure = Math.max(c.same_failure, n)
      }
    }
  } catch {}
  return done
}

/** flow.ts flowAfter: a foreground Bash, PowerShell or subagent call of the main conversation, and how long it ran. */
export function countForeground(ms: number): void {
  if (Number.isFinite(ms)) c.foreground_seconds = Math.max(c.foreground_seconds, cap(ms / 1000, 604800))
}

/** flow.ts turnEnd: the steps ready to start (0 when the list did not change), and whether notes are on. */
export function setTurnFacts(stepsReady: number, notesOn: boolean): void {
  c.steps_ready = cap(stepsReady)
  on = notesOn
}

/** core.ts onTurnEnd: this turn's counts for the checkpoint timing request, or null when there is nothing to send. */
export function takeTurn(): TurnCounts | null {
  if (!on) return null
  const out: TurnCounts = {}
  for (const [k, v] of Object.entries(c)) if (k !== 'run' && v > 0) out[k] = cap(v, k === 'foreground_seconds' ? 604800 : 100000)
  if (!Object.keys(out).length) return null
  const seen = Object.entries(history).slice(0, 8).map(([k, h]) => ({ case: k, ago: cap(turnNo - h.turn), times: cap(h.times) }))
  if (seen.length) out.history = seen
  return out
}

/** core.ts: the service's note on the last turn and its cases; held for the next prompt (takeAdvice). */
export function adviceIn(note: unknown, cases: unknown): void {
  if (!on || typeof note !== 'string' || !note.trim()) return
  advice = note.trim()
  for (const k of Array.isArray(cases) ? cases : []) {
    if (typeof k !== 'string' || !adviceCases().includes(k)) continue
    history[k] = { turn: turnNo, times: (history[k]?.times ?? 0) + 1 }
  }
}

/** flow.ts flowPrompt: the held note, labelled, once; null when there is none. */
export function takeAdvice(): string | null {
  const a = advice
  advice = null
  return a === null ? null : `${ADVICE_LABEL}\n${a}`
}
