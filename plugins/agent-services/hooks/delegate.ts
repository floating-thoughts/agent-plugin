// Delegation hints, run locally on the served delegate table: when the main conversation does in one turn the kind
// of work the table names (a count of calls to some tools, or one result over a size), the tool result gets the
// table's note, the same way the shell watch adds its notes. Each rule fires at most once per turn and at most once
// every cooldown_turns turns in this session. Every tool name, number and text comes from the table; without it
// (signed out) nothing here changes anything. Only the main conversation is counted, never a subagent. Nothing is
// sent anywhere: the counts live in this module's memory for the session only.
import { rulesLive, rulesTable } from './rules'
import { signedIn } from './subagents'

type Obj = Record<string, any>
type Rule = { id: string; tools: string[]; calls: number | null; reset: boolean; sizes: Record<string, number>; note: string; cooldown: number }

// session state (module memory only; a reload starts it over)
let turn = 0
let counts: Record<string, number> = {} // rule id -> calls this turn (since the last reset tool, for a reset rule)
let firedAt: Record<string, number> = {} // rule id -> the turn it last fired

/** Tests: a fresh session. */
export function delegateResetForTest(): void {
  turn = 0
  counts = {}
  firedAt = {}
}

function isObj(v: unknown): v is Obj {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function posInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null
}

function names(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function table(): Obj | null {
  const t = rulesTable<Obj>('delegate')
  return isObj(t) ? t : null
}

/** The table's usable rules: an id, a note, and a call count over named tools or result sizes per tool. */
function rulesOf(t: Obj): Rule[] {
  const cooldown = posInt(t.cooldown_turns) ?? 1
  const out: Rule[] = []
  for (const r of Array.isArray(t.rules) ? t.rules : []) {
    if (!isObj(r) || typeof r.id !== 'string' || typeof r.note !== 'string' || r.note === '') continue
    const sizes: Record<string, number> = {}
    if (isObj(r.result_chars)) for (const [k, n] of Object.entries(r.result_chars)) if (posInt(n) !== null) sizes[k] = n as number
    const calls = posInt(r.calls)
    const tools = names(r.tools)
    if ((calls === null || tools.length === 0) && Object.keys(sizes).length === 0) continue
    out.push({ id: r.id, tools, calls, reset: r.reset === true, sizes, note: r.note, cooldown: posInt(r.cooldown_turns) ?? cooldown })
  }
  return out
}

/** The characters of every string in a tool's result (its text as the model gets it, roughly). */
function charsOf(v: unknown, depth = 0): number {
  if (typeof v === 'string') return v.length
  if (depth > 8 || !v || typeof v !== 'object') return 0
  let n = 0
  for (const x of Array.isArray(v) ? v : Object.values(v)) n += charsOf(x, depth + 1)
  return n
}

function fill(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (all, k: string) => (k in vars ? String(vars[k]) : all))
}

function mayFire(r: Rule): boolean {
  const last = firedAt[r.id]
  return last === undefined || turn - last >= Math.max(1, r.cooldown)
}

/** prompt.submit (engines.ts promptIn): a main-conversation prompt starts a new turn; a subagent's prompt is not one. */
export function delegateTurn(e: Obj): void {
  try {
    if (!isObj(e) || e.agentId) return
    turn += 1
    counts = {}
  } catch {}
}

/** tool.call, after the tool ran (engines.ts toolRun): the call counted for the main conversation, and the note of a
 * rule that reached its threshold appended to the result's context; any other result unchanged. */
export async function delegateAfter(e: Obj, done: Obj, rt?: Promise<unknown> | unknown): Promise<Obj> {
  try {
    if (!isObj(e) || e.agentId || !isObj(done) || done.deny !== undefined) return done
    await rulesLive()
    const t = table()
    if (!t || !(await signedIn(rt as any))) return done
    const name = String(e.tool ?? '')
    const resets = names(t.reset_tools).includes(name)
    const chars = charsOf(done.result)
    const add: string[] = []
    for (const r of rulesOf(t)) {
      let hit = false
      if (r.calls !== null && r.tools.includes(name)) {
        counts[r.id] = (counts[r.id] ?? 0) + 1
        hit = counts[r.id]! >= r.calls
      } else if (r.reset && resets) {
        counts[r.id] = 0
      }
      const size = r.sizes[name]
      if (size !== undefined && chars >= size) hit = true
      if (!hit || !mayFire(r)) continue
      firedAt[r.id] = turn
      add.push(fill(r.note, { count: counts[r.id] ?? 1, chars, tool: name }))
    }
    return add.length ? { ...done, context: [...(Array.isArray(done.context) ? done.context : []), ...add] } : done
  } catch {
    return done
  }
}
