import { commandsOf, programWords, shellLine, splitOutsideQuotes } from './cmdguard'
import { headWord } from './records'
import { methodsLevel } from './methods_level'
import { signedIn } from './subagents'

type Obj = Record<string, any>
type Answer = Record<string, unknown>
export type Ask = (head: string) => Promise<Answer>
type Note = { head: string; note: string }
type Rt = Promise<{ session?: unknown; svc: { authState(): Promise<string> }; store: { get(key: string): Promise<unknown> }; core: { records: { limits(...a: unknown[]): Promise<Answer> } } } | null>

export const RUN_LIMITS_DEADLINE_MS = 1000

let answers = new Map<string, Promise<Answer>>()
let quiet = new Set<string>()
let noted = new Set<string>()

export function commandWords(command: unknown, depth = 0): string[] {
  if (typeof command !== 'string') return []
  for (const one of commandsOf(command)) {
    const words = programWords(splitOutsideQuotes(one, /\|/)[0] ?? '')
    if (!words.length || ['cd', 'pushd', 'popd', 'set-location', 'sl', 'export', 'set'].includes(words[0]!.toLowerCase())) continue
    const inner = depth < 2 ? shellLine(words) : null
    const got = inner !== null ? commandWords(inner, depth + 1) : []
    return got.length ? got : words
  }
  return []
}

const capped = (p: Promise<Answer>): Promise<Answer> => {
  const fallback: Answer = { source: 'default', fallback: 'open_defaults' }
  const timer = new Promise<Answer>((r) => setTimeout(() => r(fallback), RUN_LIMITS_DEADLINE_MS))
  return Promise.race([p.catch(() => fallback), timer])
}

export function runStart(e: Obj, ask: Ask): Promise<Note | null> | null {
  if (e.agentId || !['Bash', 'PowerShell'].includes(e.tool) || e.run_in_background === true) return null
  const head = headWord(commandWords(e.command))
  if (head === 'other' || noted.has(head) || quiet.has(head)) return null
  let a = answers.get(head)
  if (a === undefined) {
    let asked: Promise<Answer>
    try {
      asked = ask(head)
    } catch {
      asked = Promise.reject(new Error('ask'))
    }
    a = capped(asked).then((ans) => {
      if (!(ans.background === true && typeof ans.note === 'string' && ans.note)) quiet.add(head)
      return ans
    })
    answers.set(head, a)
  }
  return a.then((ans) => (ans.background === true && typeof ans.note === 'string' && ans.note ? { head, note: ans.note } : null))
}

export async function runEnd(ran: Obj, pending: Promise<Note | null> | null): Promise<Obj> {
  if (!pending) return ran
  try {
    const got = await pending
    if (!got || !ran || ran.deny !== undefined || noted.has(got.head)) return ran
    noted.add(got.head)
    return { ...ran, context: [...(Array.isArray(ran.context) ? ran.context : []), got.note] }
  } catch {
    return ran
  }
}

export async function runLimitsStart(e: Obj, rt: Rt): Promise<Promise<Note | null> | null> {
  try {
    if (e.agentId || !['Bash', 'PowerShell'].includes(e.tool) || e.run_in_background === true) return null
    if (!(await signedIn(rt))) return null
    const r = await rt
    if (!r || (await methodsLevel(r.store)) === 'off') return null
    return runStart(e, (head) => r.core.records.limits([head], r.session, null, [], RUN_LIMITS_DEADLINE_MS))
  } catch {
    return null
  }
}

export function runLimitsAgain(): void {
  noted = new Set()
}

export function runLimitsResetForTest(): void {
  answers = new Map()
  quiet = new Set()
  noted = new Set()
}
