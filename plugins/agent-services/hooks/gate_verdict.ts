// The planning gate's verdict from the service (black-box step 7). phase.ts reads the project's agent-state.md on this
// computer and reduces it to a GateState: whether the file exists, whether its first line says `phase: running`,
// whether a goal is written, how many plan steps it lists, and the methods level (on or suggest). Only these flags
// and the one count are sent, with a served fetch of the plan phase; no text, path or file name. The service answers
// whether such a state holds file changes, the reason to show (served text, passed on as the service wrote it; phase.ts
// fills in {path}, {example} and {template}) and how many changed lines still count as a small edit.
// Each distinct state is asked once and its verdict kept in memory for the session, so a tool call waits for the
// service only after the state document changed. Fail open: a failed or late answer holds nothing and the state is
// asked again after GATE_RETRY_MS at the earliest; a service that refuses the field (an older one) is not asked again
// in this process.

export type GateLevel = 'on' | 'suggest'
export type GateState = { exists: boolean; running: boolean; goal: boolean; plan_steps: number; level: GateLevel }
export type Verdict = { hold: boolean; reason: string; small_edit_lines: number | null }
/** Asks the service: its `gate` object, 'refused' when it does not know the field, or null on any failure. */
export type AskGate = (state: GateState) => Promise<unknown>

export const GATE_RETRY_MS = 60000
export const PLAN_STEPS_SENT_MAX = 1000 // the contract's bound on plan_steps

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

// session state (module memory only; a reload starts it over)
let kept = new Map<string, { v: Verdict | null; at: number }>() // state key -> its verdict (null: failed, at: when)
let asking = new Map<string, Promise<Verdict | null>>() // state key -> the request in flight
let refused = false // the service refused the field once: never asked again
let fake: ((s: GateState) => unknown) | null = null // tests: the service's answer per state

export const stateKey = (s: GateState): string => [s.exists, s.running, s.goal, s.plan_steps, s.level].join('|')

/** The service's gate object, checked; null when it is not one. Pure. */
export function verdictOf(raw: unknown): Verdict | null {
  if (!isObj(raw) || typeof raw.hold !== 'boolean' || typeof raw.reason !== 'string') return null
  const n = raw.small_edit_lines
  return { hold: raw.hold, reason: raw.reason, small_edit_lines: typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null }
}

/** The verdict already known for `state`, or null (not asked yet, or failed: nothing is held). Never asks. */
export function knownVerdict(s: GateState): Verdict | null {
  if (fake) return verdictOf(fake(s))
  return kept.get(stateKey(s))?.v ?? null
}

/** The verdict for `state`: the kept one, else one request shared by every caller meanwhile (null: nothing is held).
 * Never throws. */
export function askVerdict(s: GateState, ask: AskGate | null, now: () => number = Date.now): Promise<Verdict | null> {
  if (fake) return Promise.resolve(knownVerdict(s))
  const k = stateKey(s)
  const had = kept.get(k)
  if (had && (had.v !== null || now() - had.at < GATE_RETRY_MS)) return Promise.resolve(had.v)
  if (refused || !ask) return Promise.resolve(null)
  let p = asking.get(k)
  if (!p) {
    p = (async () => {
      let raw: unknown = null
      try {
        raw = await ask(s)
      } catch {
        raw = null
      }
      if (raw === 'refused') refused = true
      const v = verdictOf(raw)
      kept.set(k, { v, at: now() })
      asking.delete(k)
      return v
    })()
    asking.set(k, p)
  }
  return p
}

/** Tests only: answer every state with `f` (null: ask the service again). */
export function setGateForTest(f: ((s: GateState) => unknown) | null): void {
  fake = f
}

/** Tests only: a fresh session state. */
export function gateResetForTest(): void {
  kept = new Map()
  asking = new Map()
  refused = false
  fake = null
}
