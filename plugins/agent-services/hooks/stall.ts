import type { EngineInterface } from 'claude-code'
import { NOTE_PREFIX } from './review'
import { rulesTable } from './rules'
import { vaultMask } from './vault'
import { stallSubjectOf } from './watchdog'
import { relNum, relText } from './reliability'

type Obj = Record<string, any>


const N = (k: string): number | undefined => relNum(`stall.${k}`)
const T = (k: string, vars?: Record<string, string | number>): string | undefined => relText(`stall.text.${k}`, vars)

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function shown(text: unknown): string {
  let s = String(text ?? '')
  try {
    s = vaultMask(s)
  } catch {}
  s = s.replace(/[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim()
  return s.length > 120 ? s.slice(0, 119) + '\u2026' : s
}


export type LoopState = { calls: string[]; n: number; fired: Record<string, { times: number; at: number }> }
export const emptyLoop = (): LoopState => ({ calls: [], n: 0, fired: {} })

function stable(v: unknown, depth = 0): string {
  if (depth > 8) return '"\u2026"'
  if (Array.isArray(v)) return `[${v.map((x) => stable(x, depth + 1)).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Obj).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Obj)[k], depth + 1)}`).join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

export function loopFingerprint(e: unknown): string {
  const { tool, tool_use_id: _c, agentId: _a, requestMeta: _m, consent: _k, ...input } = (e && typeof e === 'object' ? e : {}) as Obj
  return stallSubjectOf(tool, stable(input))
}

const sameList = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])

export function loopStep(state: LoopState | null | undefined, fp: string): { state: LoopState; level: 0 | 1 | 2; repeats: number; period: number } {
  const s0 = state && Array.isArray(state.calls) ? state : emptyLoop()
  const windowLen = N('LOOP_WINDOW')
  const repeatsMin = N('LOOP_REPEATS')
  const maxPeriod = N('LOOP_MAX_PERIOD')
  if (windowLen === undefined || repeatsMin === undefined || maxPeriod === undefined) return { state: s0, level: 0, repeats: 1, period: 0 }
  const calls = [...s0.calls, fp].slice(-windowLen)
  const n = (num(s0.n) ?? 0) + 1
  const fired = { ...(s0.fired ?? {}) }
  for (let p = 1; p <= maxPeriod; p++) {
    if (calls.length < repeatsMin * p) break
    const block = calls.slice(-p)
    let reps = 1
    while (calls.length >= (reps + 1) * p && sameList(calls.slice(calls.length - (reps + 1) * p, calls.length - reps * p), block)) reps++
    if (reps < repeatsMin) continue
    const rotations = block.map((_, i) => [...block.slice(i), ...block.slice(0, i)].join('|'))
    const key = rotations.sort()[0]!
    const f = fired[key]
    if (f && n - f.at < repeatsMin * p) return { state: { calls, n, fired }, level: 0, repeats: reps, period: p }
    const times = (f?.times ?? 0) + 1
    fired[key] = { times, at: n }
    const keys = Object.keys(fired)
    for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete fired[k]
    return { state: { calls, n, fired }, level: times === 1 ? 1 : times === 2 ? 2 : 0, repeats: reps, period: p }
  }
  return { state: { calls, n, fired }, level: 0, repeats: 1, period: 0 }
}

export function loopNote(level: number, tool: unknown, repeats: number, period: number): string | null {
  if (level !== 1 && level !== 2) return null
  const name = shown(tool) || T('loop_tool')
  const what = period > 1 ? T('loop_calls', { period }) : name === undefined ? undefined : T('loop_call', { tool: name })
  if (what === undefined) return null
  const body = T(level === 1 ? 'loop1' : 'loop2', { what, repeats })
  return body === undefined ? null : `${NOTE_PREFIX}: ${body}`
}


export type EndKind = 'finished' | 'aborted' | 'error' | 'plugin_abort'
export type ContinueState = {
  auto: number
  aborted: boolean
  lastEnd: EndKind | null
}
export type ContinueWhy = 'aborted' | 'error' | 'cap'
export type ContinueDecision = { ok: boolean; why: ContinueWhy | null; say: string | null; state: ContinueState }
export type ContinueKind = 'promise' | 'self_check' | 'wall' | 'checkpoint_next' | 'to_main' | 'keep_going' | 'report'

export const emptyContinue = (): ContinueState => ({ auto: 0, aborted: false, lastEnd: null })

function contOf(s: unknown): ContinueState {
  const x = (s && typeof s === 'object' ? s : {}) as Obj
  return {
    auto: Math.max(0, Math.floor(num(x.auto) ?? 0)),
    aborted: x.aborted === true,
    lastEnd: ['finished', 'aborted', 'error', 'plugin_abort'].includes(x.lastEnd) ? x.lastEnd : null,
  }
}

export function endKindOf(reason: unknown, ownAbort: boolean): EndKind {
  if (reason === 'aborted') return ownAbort ? 'plugin_abort' : 'aborted'
  if (reason === 'error' || reason === 'refusal') return 'error'
  return 'finished'
}

export function onTurnEnd(state: unknown, kind: EndKind, _at?: number): ContinueState {
  const s = contOf(state)
  return { ...s, lastEnd: kind, aborted: s.aborted || kind === 'aborted' }
}

export function onPersonPrompt(state: unknown): ContinueState {
  return { ...contOf(state), aborted: false, auto: 0 }
}

export function continueDecision(state: unknown, _at: number, entry: 'stop' | 'idle', mustSend = false): ContinueDecision {
  const d = decide(state, entry)
  if (d.ok || !mustSend) return d
  return { ...d, ok: true, state: { ...d.state, auto: d.state.auto + 1 } }
}

function decide(state: unknown, entry: 'stop' | 'idle'): ContinueDecision {
  const s = contOf(state)
  const no = (why: ContinueWhy): ContinueDecision => ({ ok: false, why, say: null, state: s })
  if (s.aborted) return no('aborted')
  if (entry === 'idle' && (s.lastEnd === 'error' || s.lastEnd === 'aborted')) return no(s.lastEnd === 'error' ? 'error' : 'aborted')
  const cap = N('CONTINUE_CAP')
  if (cap === undefined || s.auto >= cap) return no('cap')
  return { ok: true, why: null, say: null, state: { ...s, auto: s.auto + 1 } }
}


let cont: ContinueState = emptyContinue()
let loops: Record<string, LoopState> = {}
let ownAborts: string[] = []

const clockNow = (): number => Date.now()

export function stallToolEnd(e: Obj, ran: Obj, at?: number): string | null {
  try {
    if (!e || !ran || typeof ran !== 'object' || ran.deny !== undefined) return null
    const tool = String(e.tool ?? '')
    const agent = typeof e.agentId === 'string' && e.agentId ? e.agentId : ''
    const r = loopStep(loops[agent], loopFingerprint(e))
    loops[agent] = r.state
    const keys = Object.keys(loops)
    for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete loops[k]
    return rulesTable('watch') ? loopNote(r.level, tool, r.repeats, r.period) : null
  } catch {
    return null
  }
}

export function stallOwnAbort(turnId: unknown): void {
  if (typeof turnId === 'string' && turnId) ownAborts = [...ownAborts.filter((x) => x !== turnId), turnId].slice(-20)
}

export function stallTurnEnd(e: Obj, at?: number): void {
  try {
    if (!e || e.agentId) return
    const own = typeof e.turnId === 'string' && ownAborts.includes(e.turnId)
    cont = onTurnEnd(cont, endKindOf(e.reason, own), at ?? clockNow())
  } catch {}
}

export function stallPersonPrompt(): void {
  try {
    cont = onPersonPrompt(cont)
  } catch {}
}

export async function continueVia($: EngineInterface, _kind: ContinueKind, entry: 'stop' | 'idle', opts?: { at?: number; mustSend?: boolean }):
  Promise<{ ok: boolean; say: string | null }> {
  try {
    let at = opts?.at
    if (typeof at !== 'number') {
      try {
        at = Number(await $.clock.now())
      } catch {}
    }
    const d = continueDecision(cont, typeof at === 'number' && Number.isFinite(at) ? at : clockNow(), entry, opts?.mustSend === true)
    cont = d.state
    return { ok: d.ok, say: d.say }
  } catch {
    return { ok: true, say: null }
  }
}

export function stallResetForTest(): void {
  cont = emptyContinue()
  loops = {}
  ownAborts = []
}
