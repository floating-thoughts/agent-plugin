import type { EngineInterface } from 'claude-code'
import { sha256Hex } from './e2e'
import { checkpointToolName } from './flow_state'
import { NOTE_LABEL, SUGGESTION_PREFIX } from './review'
import { servedInt, servedText } from './workflow_table'

type Obj = Record<string, any>
type State = {
  since: number
  prompts: number
  turns: number
  shown: number | null
  why: string
  ignored: number
  holdDue: boolean
  spanUsed: boolean
  note: string | null
}

export const NUDGE_SKIP = 'no checkpoint:'
export const NUDGE_STORE_KEY = 'checkpoint_span'

const fresh = (now: number): State => ({ since: now, prompts: 0, turns: 0, shown: null, why: '', ignored: 0, holdDue: false, spanUsed: false, note: null })
let st: State = fresh(Date.now())
let loaded = false
let sessionKey: string | null = null

const label = `[${SUGGESTION_PREFIX}, not written by the user]`
const tool = (): string => checkpointToolName() ?? 'the checkpoint tool'


export function hasSkipLine(text: unknown): boolean {
  if (typeof text !== 'string') return false
  return text.split(/\r?\n/).some((l) => /^\s*(?:[-*>]\s*)*(?:\*\*)?no checkpoint:(?:\*\*)?\s*\S/i.test(l))
}

export function spanWhy(prompts: number, minutes: number): string | null {
  const maxPrompts = servedInt('checkpoint', 'span_prompts')
  const maxMinutes = servedInt('checkpoint', 'span_minutes')
  if (maxPrompts !== null && prompts > maxPrompts) return servedText('checkpoint', 'why_prompts', { prompts })
  if (maxMinutes !== null && minutes > maxMinutes) return servedText('checkpoint', 'why_hours', { hours: Math.floor(minutes / 60) })
  return null
}


export function nudgeResetForTest(now = 0): void {
  st = fresh(now)
  loaded = true
  sessionKey = null
}

export const nudgeState = (): State => ({ ...st })

export function nudgeCompacted(now: number): void {
  st = fresh(now)
}

function spanOver(now: number): void {
  st.since = now
  st.prompts = 0
  st.spanUsed = false
}

export function nudgeShown(why?: string): void {
  if (st.shown !== null) return
  st.shown = st.turns
  st.why = why ?? servedText('checkpoint', 'why_server') ?? st.why
}

export function nudgeAnswered(): void {
  st.shown = null
  st.ignored = 0
  st.holdDue = false
  st.note = null
}

export function nudgePrompt(): void {
  st.prompts += 1
}

export function nudgeTurnEnd(now: number, contextTokens: number | null): void {
  st.turns += 1
  const ignoreTurns = servedInt('checkpoint', 'ignore_turns')
  const ignoredMax = servedInt('checkpoint', 'ignored_max')
  if (ignoreTurns === null || ignoredMax === null) return
  if (st.shown !== null) {
    if (st.turns - st.shown < ignoreTurns) return
    st.shown = null
    st.ignored += 1
    if (st.ignored >= ignoredMax) st.holdDue = true
    else st.note = servedText('checkpoint', 'again_note', { tool: tool(), why: st.why, turns: ignoreTurns })
    return
  }
  if (st.note !== null || st.holdDue || st.spanUsed) return
  const min = servedInt('checkpoint', 'min_tokens', 0)
  if (min !== null && contextTokens !== null && contextTokens < min) return
  const why = spanWhy(st.prompts, Math.max(0, Math.floor((now - st.since) / 60000)))
  if (!why) return
  const note = servedText('checkpoint', 'span_note', { tool: tool(), why })
  if (!note) return
  st.spanUsed = true
  st.why = why
  st.note = note
}

export function nudgeNotes(): string[] {
  const n = st.note
  if (!n) return []
  st.note = null
  st.shown = null
  nudgeShown(st.why)
  return [`${label} ${n}`]
}

export function nudgeStop(lastMessage: unknown, now: number): string | null {
  if (hasSkipLine(lastMessage)) {
    nudgeAnswered()
    spanOver(now)
    return null
  }
  if (!st.holdDue) return null
  const text = servedText('checkpoint', 'hold', { tool: tool(), why: st.why, count: st.ignored, skip: NUDGE_SKIP })
  st.holdDue = false
  st.ignored = 0
  st.shown = null
  spanOver(now)
  return text ? `${NOTE_LABEL} ${text}` : null
}


async function keyOf($: EngineInterface): Promise<string | null> {
  if (sessionKey) return sessionKey
  try {
    const id = await $.session.id()
    if (typeof id === 'string' && id) sessionKey = sha256Hex(new TextEncoder().encode('checkpoint_span:' + id)).slice(0, 16)
  } catch {}
  return sessionKey
}

export async function nudgeLoad($: EngineInterface): Promise<void> {
  if (loaded) return
  loaded = true
  try {
    const k = await keyOf($)
    const all: Obj = ((await $.store.get(NUDGE_STORE_KEY)) ?? {}) as Obj
    const row = k ? all[k] : null
    if (row && typeof row.since === 'number' && typeof row.prompts === 'number' && row.since <= st.since) {
      st.since = row.since
      st.prompts += row.prompts
    }
  } catch {}
}

export async function nudgeSave($: EngineInterface): Promise<void> {
  try {
    const k = await keyOf($)
    if (!k) return
    const all: Obj = ((await $.store.get(NUDGE_STORE_KEY)) ?? {}) as Obj
    const keep = Object.entries(all).filter(([x]) => x !== k)
      .sort((a, b) => (b[1]?.saved ?? 0) - (a[1]?.saved ?? 0)).slice(0, 49)
    await $.store.set(NUDGE_STORE_KEY, Object.fromEntries([[k, { since: st.since, prompts: st.prompts, saved: Date.now() }], ...keep]))
  } catch {}
}
