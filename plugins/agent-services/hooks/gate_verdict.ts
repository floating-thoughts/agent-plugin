
export type GateLevel = 'on' | 'suggest'
export type GateState = { exists: boolean; running: boolean; goal: boolean; plan_steps: number; level: GateLevel }
export type Verdict = { hold: boolean; reason: string; small_edit_lines: number | null }
export type AskGate = (state: GateState) => Promise<unknown>

export const GATE_RETRY_MS = 60000
export const PLAN_STEPS_SENT_MAX = 1000

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

let kept = new Map<string, { v: Verdict | null; at: number }>()
let asking = new Map<string, Promise<Verdict | null>>()
let refused = false
let fake: ((s: GateState) => unknown) | null = null

export const stateKey = (s: GateState): string => [s.exists, s.running, s.goal, s.plan_steps, s.level].join('|')

export function verdictOf(raw: unknown): Verdict | null {
  if (!isObj(raw) || typeof raw.hold !== 'boolean' || typeof raw.reason !== 'string') return null
  const n = raw.small_edit_lines
  return { hold: raw.hold, reason: raw.reason, small_edit_lines: typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null }
}

export function knownVerdict(s: GateState): Verdict | null {
  if (fake) return verdictOf(fake(s))
  return kept.get(stateKey(s))?.v ?? null
}

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

export function setGateForTest(f: ((s: GateState) => unknown) | null): void {
  fake = f
}

export function gateResetForTest(): void {
  kept = new Map()
  asking = new Map()
  refused = false
  fake = null
}
