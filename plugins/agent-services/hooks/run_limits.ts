// Run limits for the main conversation's foreground Bash and PowerShell calls (black-box step 6). The first such call
// whose command head is on the public list (records.ts KNOWN_HEADS) asks the service about that head; the answer is
// kept in memory for the session, so each head is asked at most once. Only the head is sent: no arguments, paths,
// project hash or durations; a head outside the list (`other`) sends nothing. The request waits at most 1 second
// from the start of the call; a failure or a timeout counts as the open default (no figures, no advice) and adds
// nothing. When the answer says such commands are better run in the background, its note (served text, passed on as
// the service wrote it) goes to the model once per head, with the result of a call of that head. Nothing here while
// signed out, at methods level off, for a subagent's call or a call that already runs in the background.
import { headWord } from './records'
import { methodsLevel } from './methods_level'
import { signedIn } from './subagents'

type Obj = Record<string, any>
type Answer = Record<string, unknown>
/** Asks the service about one head and resolves to the answer (Records.limits with only that head). */
export type Ask = (head: string) => Promise<Answer>
type Note = { head: string; note: string }
type Rt = Promise<{ session?: unknown; svc: { authState(): Promise<string> }; store: { get(key: string): Promise<unknown> }; core: { records: { limits(...a: unknown[]): Promise<Answer> } } } | null>

export const RUN_LIMITS_DEADLINE_MS = 1000

// session state (module memory only; a reload starts it over)
let answers = new Map<string, Promise<Answer>>() // head -> the session's one answer for it
let quiet = new Set<string>() // heads whose answer came with no note
let noted = new Set<string>() // heads whose note the model got

/** The words of a shell command line's first command that runs a program: leading `cd`/`Set-Location`-style parts,
 * variable assignments and a PowerShell `&` are skipped; quotes around a word are removed. */
export function commandWords(command: unknown): string[] {
  if (typeof command !== 'string') return []
  for (const part of command.split(/&&|\|\||[;|\n]/)) {
    const words = (part.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^(["'])(.*)\1$/s, '$2'))
    while (words.length && (words[0] === '&' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!))) words.shift()
    if (!words.length || ['cd', 'pushd', 'popd', 'set-location', 'sl', 'export', 'set'].includes(words[0]!.toLowerCase())) continue
    return words
  }
  return []
}

const capped = (p: Promise<Answer>): Promise<Answer> => {
  const fallback: Answer = { source: 'default', fallback: 'open_defaults' }
  const timer = new Promise<Answer>((r) => setTimeout(() => r(fallback), RUN_LIMITS_DEADLINE_MS))
  return Promise.race([p.catch(() => fallback), timer])
}

/** tool.call, before the call runs: for a foreground Bash or PowerShell call of the main conversation, the note to add
 * to its result once the call ran (a promise), or null when there is nothing to ask or to say for its head. */
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

/** tool.call, after the call ran: its result with the note added once per head (not to a denied call). */
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

/** runStart wired to the runtime (engines.ts toolRun): signed in and methods level not off, the head asked through the
 * core's records with the 1 second deadline. Never throws. */
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

/** Tests only: a fresh session state. */
export function runLimitsResetForTest(): void {
  answers = new Map()
  quiet = new Set()
  noted = new Set()
}
