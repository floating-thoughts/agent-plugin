// The user's autonomy choice (0.6.3): whether Claude works fully automatically or checks in as usual.
// - The served working methods (role auto) ask the user once, with AskUserQuestion, labelled exactly
//   AUTONOMY_LABELS. The tool.call hook of the main conversation reads the answer (noteAutonomy, after the call ran)
//   and keeps it for the signed-in account; `/agent-services autonomy auto | ask | clear` changes it (command.ts).
// - Kept only in the plugin store, under AUTONOMY_KEY, per account id; nothing of it is sent.
// - While a choice is kept, the served-advice block the plugin pushes with the methods (phase.ts pushLessons) carries
//   one AUTONOMY_NOTE line, so the methods need not ask again; no methods delivered, no line.
import type { EngineInterface } from 'claude-code'
import { KEYS } from './store'

export type Autonomy = 'auto' | 'ask'
type Obj = Record<string, any>
type Kv = { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }

export const AUTONOMY_KEY = 'autonomy' // { [account id]: { choice: 'auto' | 'ask', at } }
export const AUTONOMY_LABELS: Readonly<Record<Autonomy, string>> = {
  auto: 'Fully automatic (agent-services recommends this)',
  ask: 'Check in with me as usual',
}
export const AUTONOMY_NOTE: Readonly<Record<Autonomy, string>> = {
  auto: 'agent-services note: the user chose fully automatic work (stored by the plugin; /agent-services autonomy ' +
    'changes it).',
  ask: 'agent-services note: the user chose to be checked in with as usual (stored by the plugin; /agent-services ' +
    'autonomy changes it).',
}
// /agent-services status (one line) and the bare `autonomy`
export const AUTONOMY_LINE: Readonly<Record<Autonomy | 'none', string>> = {
  auto: 'Autonomy: fully automatic (your choice, kept on this computer only; /agent-services autonomy ask or ' +
    'autonomy clear changes it).',
  ask: 'Autonomy: check in with you as usual (your choice, kept on this computer only; /agent-services autonomy auto ' +
    'or autonomy clear changes it).',
  none: 'Autonomy: not chosen yet; the served working methods ask you once (/agent-services autonomy auto or ' +
    'autonomy ask sets it now).',
}
export const AUTONOMY_SET: Readonly<Record<Autonomy | 'clear', string>> = {
  auto: 'Autonomy is set to fully automatic: with the working methods, Claude is told you chose fully automatic ' +
    'work. It is kept on this computer only. /agent-services autonomy ask or autonomy clear changes it.',
  ask: 'Autonomy is set to check in with you as usual: with the working methods, Claude is told you chose to be ' +
    'checked in with as usual. It is kept on this computer only. /agent-services autonomy auto or autonomy clear ' +
    'changes it.',
  clear: 'The autonomy choice is cleared: nothing is kept, Claude is told nothing about it, and the served working ' +
    'methods may ask you again.',
}

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

async function account(kv: Kv): Promise<string | null> {
  const a = await kv.get(KEYS.accountId)
  return typeof a === 'string' && a ? a : null
}

/** The choice kept for the signed-in account, or null (none, no account, or unreadable). Never throws. */
export async function readAutonomy(kv: Kv | null | undefined): Promise<Autonomy | null> {
  try {
    if (!kv) return null
    const acc = await account(kv)
    const all = acc ? await kv.get(AUTONOMY_KEY) : null
    const c = isObj(all) && isObj(all[acc!]) ? all[acc!].choice : null
    return c === 'auto' || c === 'ask' ? c : null
  } catch {
    return null
  }
}

/** Keeps `choice` for the signed-in account (null clears it). False when there is no account or the store refused. */
export async function setAutonomy(kv: Kv, choice: Autonomy | null, now: number): Promise<boolean> {
  try {
    const acc = await account(kv)
    if (!acc) return false
    const all = await kv.get(AUTONOMY_KEY)
    const map: Obj = isObj(all) ? { ...all } : {}
    if (choice) map[acc] = { choice, at: now }
    else delete map[acc]
    await kv.set(AUTONOMY_KEY, map)
    return true
  } catch {
    return false
  }
}

// A label as compared: no case, spaces collapsed, trailing "(...)" parts and punctuation dropped, so "Fully automatic
// (recommended)" or "fully automatic." count as the auto label; anything else (a translation, a paraphrase) does not.
const norm = (t: string): string => {
  let s = t.toLowerCase().replace(/\s+/g, ' ').trim()
  for (let prev = ''; prev !== s;) { prev = s; s = s.replace(/\s*\([^()]*\)\s*$/, '').replace(/[\s.!:;,]+$/, '') }
  return s
}

/** The choice an AskUserQuestion result holds: an answer that is one of AUTONOMY_LABELS (compared by `norm`); null
 * otherwise. Pure. */
export function autonomyOf(done: unknown): Autonomy | null {
  if (!isObj(done) || done.deny !== undefined || done.isError === true) return null
  const answers = isObj(done.result) && isObj(done.result.answers) ? Object.values(done.result.answers) : []
  const found = new Set<Autonomy>()
  for (const a of answers) {
    for (const k of ['auto', 'ask'] as const) if (typeof a === 'string' && norm(a) === norm(AUTONOMY_LABELS[k])) found.add(k)
  }
  return found.size === 1 ? [...found][0]! : null
}

/** The line for the served-advice block, or null when no choice is kept. Pure. */
export const autonomyNote = (c: Autonomy | null): string | null => (c ? AUTONOMY_NOTE[c] : null)

type Ready = Promise<{ svc: { authState(): Promise<string> } } | null>

/** register.ts tool.call, after the call ran: the main conversation's AskUserQuestion answered with one of the two
 * labels keeps that choice for the signed-in account. Never throws; changes nothing of the call. */
export async function noteAutonomy($: EngineInterface, e: Obj, done: unknown, rt?: Ready): Promise<void> {
  try {
    if (e?.agentId || e?.tool !== 'AskUserQuestion') return
    const choice = autonomyOf(done)
    if (!choice) return
    const r = rt ? await rt : null
    if (!r || (await r.svc.authState()) !== 'ok') return
    await setAutonomy({ get: (k) => Promise.resolve($.store.get(k)), set: async (k, v) => void (await $.store.set(k, v as any)) },
      choice, Date.now())
  } catch {
    // the choice can be set with /agent-services autonomy
  }
}
