// The dashboard publish consent and the savings-record choice state (cleanup route R6, moved from command.ts
// unchanged): the stored answers, the once-per-session dialog question and the published dashboard's URL.
// Harness-neutral: the store and the dialog are passed in.
import { KEYS, safeGet, safeSet } from './store'
import type { KV } from './store'
import type { Ask } from './command'

// the dashboard publish consent (dashboard.ts publishes only while it is "allow")
export const CONSENT_KEY = 'dashboard_consent' // { answer: 'allow' | 'not_now', at }: at in ms since the epoch
export const CONSENT_QUESTION =
  'agent-services can publish your usage dashboard as a private Artifact on claude.ai (only you can see it unless ' +
  'you share it). Allow it to publish and update it automatically?'
export const CONSENT_OPTIONS = ['Allow', 'Not now']
export const CONSENT_HEADER = 'Dashboard'
export const CONSENT_SNOOZE_MS = 7 * 86400000 // "Not now" is not asked again for this long
const DASHBOARD_URL_RX = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+$/ // as dashboard.ts URL_RX

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

// ------------------------------------------------------------------ the dashboard publish consent

export type Consent = { answer: 'allow' | 'not_now'; at: number }
export type ConsentState = 'allow' | 'not_now' | 'ask'

let consentAsked = false // asked in this session (one module instance per Claude Code session)

/** The stored answer, or null when there is none (or it is unreadable). */
export async function readConsent(kv: KV): Promise<Consent | null> {
  const v = await safeGet(kv, CONSENT_KEY)
  if (!isObj(v) || (v.answer !== 'allow' && v.answer !== 'not_now') || num(v.at) === null) return null
  return { answer: v.answer, at: v.at }
}

/** 'allow'; 'not_now' while that answer is under CONSENT_SNOOZE_MS old; else 'ask' (never answered, or run out). */
export function consentState(c: Consent | null, now: number): ConsentState {
  if (!c) return 'ask'
  if (c.answer === 'allow') return 'allow'
  return now - c.at < CONSENT_SNOOZE_MS ? 'not_now' : 'ask'
}

/** Ask once per session in the dialog and keep the answer. null when not asked (already asked in this session, no
 * dialog) or not answered (dismissed, a -p run, a typed answer): nothing is kept then. */
export async function askConsent(kv: KV, ask: Ask | null | undefined, now: () => number): Promise<'allow' | 'not_now' | null> {
  if (consentAsked || !ask) return null
  consentAsked = true
  let a: string
  try {
    a = String(await ask(CONSENT_QUESTION, { options: CONSENT_OPTIONS, header: CONSENT_HEADER })).trim()
  } catch {
    return null
  }
  if (!CONSENT_OPTIONS.includes(a)) return null
  const answer = a === CONSENT_OPTIONS[0] ? 'allow' : 'not_now'
  await safeSet(kv, CONSENT_KEY, { answer, at: now() })
  return answer
}

/** The one savings-record choice: 'on'; 'not_now' while an off is under CONSENT_SNOOZE_MS old; else 'ask'. */
export async function sharingState(kv: KV, now: number): Promise<'on' | 'not_now' | 'ask'> {
  const v = await safeGet(kv, KEYS.sharing)
  if (!isObj(v) || typeof v.on !== 'boolean' || num(v.at) === null) return 'ask'
  if (v.on) return 'on'
  return now - v.at < CONSENT_SNOOZE_MS ? 'not_now' : 'ask'
}

/** Claim this session's one dialog question (shared by askConsent and the sharing question): false when it was
 * already asked. */
export function claimAsk(): boolean {
  if (consentAsked) return false
  consentAsked = true
  return true
}

// For the tests: a new session.
export function resetConsentAsk(): void {
  consentAsked = false
}

/** The published dashboard's artifact URL from <data dir>/services/dashboard.json (O5: boss.json), or null. */
export async function dashboardUrl(readText: (path: string) => Promise<string | null>, dir: string, file = 'dashboard.json'): Promise<string | null> {
  try {
    const t = await readText(`${dir.replace(/[\\/]+$/, '')}/services/${file}`)
    const s = t === null ? null : JSON.parse(t)
    return isObj(s) && typeof s.url === 'string' && DASHBOARD_URL_RX.test(s.url) ? s.url : null
  } catch {
    return null
  }
}
