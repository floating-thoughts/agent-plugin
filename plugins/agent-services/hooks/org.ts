// The company level on the client: a company's pause and its one choice for the daily upload. Harness-neutral: the
// store is passed in.
//
// - Pause: while the company's admin has paused the company the server answers 423 org_paused to every signed
//   request and to the sign-in. svc.ts keeps a short shared block for it (BLOCK_SECONDS.org_paused), so nothing is
//   sent meanwhile and an unpause is picked up when the block runs out; the sign-in stays. Every tool, the slash
//   command and the status line answer ORG_PAUSED_LINE (auth state 'paused').
// - Upload choice: POST /auth/hello carries {"org": {"savings": "each" | "on" | "off"}} for an account in a company
//   (definitions OrgSavings in the contract). keepOrg stores it under KEYS.org at every hello. "on" or "off" decides
//   the daily upload for everyone (choice.ts recordState reads it over the person's own answer); the private page
//   stays each person's own answer. Nothing of the person's answer is written here, so a company that hands the choice
//   back ("each", or no company any more) leaves the person's own answer as it was. The person is told the company's
//   choice once (orgNotice). An answer without "org" (no company, or an older server) drops KEYS.org.
// - Company admin: the org field also carries "admin": true for the company's admin; it is kept as `admin: true` in
//   the org state (orgAdmin), and boss.ts then renders and publishes the company board.
import { CONTRACT } from './contract'
import { KEYS, safeDelete, safeGet, safeSet } from './store'
import type { KV } from './store'

export const ORG_PAUSED_LINE = 'Your company has paused agent-services. Ask your admin to turn it back on.'
export const ORG_SAVINGS: readonly string[] = (CONTRACT as any).definitions.OrgSavings.enum
export const ORG_ADMIN_SEES = "Your company's admin sees each member's email address, how many devices each member " +
  "is signed in on, and each member's weekly savings figure (\"no data yet\" while that member uploads nothing)."
export const ORG_SAVINGS_TEXT: Readonly<Record<string, string>> = {
  on: `Your company turned the daily usage upload on for everyone, so you are not asked about it, and only your ` +
    `company's admin can turn it off. Your private savings page stays your own choice (/agent-services sharing page ` +
    `on). ${ORG_ADMIN_SEES}`,
  off: 'Your company turned the daily usage upload off for everyone, so you are not asked about it and nothing is ' +
    'uploaded.',
}
export const ORG_SET_TEXT = 'Your company decides the daily upload for everyone, so it cannot be changed here. Ask your ' +
  'admin. Your private savings page stays yours: /agent-services sharing page on|off.'

export type OrgSavings = 'each' | 'on' | 'off'
export type OrgState = { savings: OrgSavings; at: number; told: OrgSavings | null; since?: number; admin?: true }

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The hello answer's "org" field is well formed: exactly {"savings": <OrgSavings>}, plus "admin": true. */
export function validOrg(v: unknown): boolean {
  if (!isObj(v) || !ORG_SAVINGS.includes(v.savings)) return false
  const keys = Object.keys(v).sort().join(',')
  return keys === 'savings' || (keys === 'admin,savings' && v.admin === true)
}

/** The stored org state, or null (no company, or unreadable). */
export async function readOrg(kv: KV): Promise<OrgState | null> {
  const v = await safeGet(kv, KEYS.org)
  if (!isObj(v) || !ORG_SAVINGS.includes(v.savings) || typeof v.at !== 'number') return null
  const told = ORG_SAVINGS.includes(v.told) ? v.told : null
  const o: OrgState = { savings: v.savings, at: v.at, told }
  if (typeof v.since === 'number') o.since = v.since
  return v.admin === true ? { ...o, admin: true } : o
}

/** True while the signed-in account is its company's admin. */
export async function orgAdmin(kv: KV): Promise<boolean> {
  return (await readOrg(kv))?.admin === true
}

/** 'on' or 'off' while the company set the daily upload for everyone, else null. */
export async function orgChoice(kv: KV): Promise<'on' | 'off' | null> {
  const o = await readOrg(kv)
  return o && (o.savings === 'on' || o.savings === 'off') ? o.savings : null
}

/** Keep the hello's org field (undefined: none). `setMetrics` gets the upload switch the svc channel keeps for the
 * metrics routes: off while the company says off, on again when it no longer does (the record decides the upload).
 * Never throws. */
export async function keepOrg(kv: KV, org: unknown, now: number, setMetrics: (on: boolean) => Promise<boolean>): Promise<void> {
  try {
    const prev = await readOrg(kv)
    if (!validOrg(org)) {
      if (prev) await safeDelete(kv, KEYS.org)
      if (prev?.savings === 'off') await setMetrics(true)
      return
    }
    const { savings, admin } = org as { savings: OrgSavings; admin?: true }
    const told = prev && prev.savings === savings ? prev.told : null
    // since: the first time this choice was seen (the 30-day floor of the upload for a company "on")
    const since = prev && prev.savings === savings && typeof prev.since === 'number' ? prev.since : now
    const state: OrgState = { savings, at: now, told, since }
    await safeSet(kv, KEYS.org, admin === true ? { ...state, admin } : state)
    if (savings === 'off') await setMetrics(false)
    else if (prev?.savings === 'off') await setMetrics(true)
  } catch {
    // the org state is best effort; the next hello tries again
  }
}

/** The one-time line about the company's choice: the text the first time a choice is seen, then null. */
export async function orgNotice(kv: KV): Promise<string | null> {
  const o = await readOrg(kv)
  if (!o || o.savings === 'each' || o.told === o.savings) return null
  if (!(await safeSet(kv, KEYS.org, { ...o, told: o.savings }))) return null
  return ORG_SAVINGS_TEXT[o.savings] ?? null
}

/** The savings question, with the admin line for a person in a company where each person decides. */
export async function sharingQuestion(kv: KV, question: string): Promise<string> {
  const o = await readOrg(kv)
  return o && o.savings === 'each' ? `${question} ${ORG_ADMIN_SEES}` : question
}
