// The org level on the client (O2 and O3): a company's pause and its one savings-record choice. Harness-neutral:
// the store is passed in.
//
// - O2 kill switch: while the org's admin has paused the org the server answers 423 org_paused to every signed
//   request and to the sign-in. svc.ts keeps a short shared block for it (BLOCK_SECONDS.org_paused), so nothing is
//   sent meanwhile and an unpause is picked up when the block runs out; the sign-in stays. Every tool, the slash
//   command and the status line answer ORG_PAUSED_LINE (auth state 'paused').
// - O3 savings record: POST /auth/hello carries {"org": {"savings": "each" | "on" | "off"}} for an account in an org
//   (definitions OrgSavings in host/service_api.json). keepOrg stores it under KEYS.org at every hello and, for on
//   or off, applies it as the person's own savings-record choice (the record, the upload switch and the board
//   consent). While it is on or off the savings question is not asked, the parts cannot be changed here, and the
//   person is told the choice once (orgNotice). An answer without "org" (no org, or an older server) drops KEYS.org.
// - O5 company admin: the org field also carries "admin": true for the org's admin (shell 0.4.0 or later); it is kept
//   as `admin: true` in the org state (orgAdmin), and boss.ts then renders and publishes the company board.
import { CONTRACT } from './contract'
import { CONSENT_KEY } from './consent'
import { KEYS, safeDelete, safeGet, safeSet } from './store'
import type { KV } from './store'

export const ORG_PAUSED_LINE = 'Your company has paused agent-services. Ask your admin to turn it back on.'
export const ORG_SAVINGS: readonly string[] = (CONTRACT as any).definitions.OrgSavings.enum
export const ORG_ADMIN_SEES = "Your company's admin sees each person's savings figure."
export const ORG_SAVINGS_TEXT: Readonly<Record<string, string>> = {
  on: `Your company turned the savings record on for everyone, so you are not asked about it. ${ORG_ADMIN_SEES}`,
  off: 'Your company turned the savings record off for everyone, so you are not asked about it and nothing is uploaded.',
}
export const ORG_SET_TEXT = 'Your company set the savings record for everyone, so it cannot be changed here. Ask your admin.'

export type OrgSavings = 'each' | 'on' | 'off'
export type OrgState = { savings: OrgSavings; at: number; told: OrgSavings | null; admin?: true }

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The hello answer's "org" field is well formed: exactly {"savings": <OrgSavings>}, plus "admin": true (O5). */
export function validOrg(v: unknown): boolean {
  if (!isObj(v) || !ORG_SAVINGS.includes(v.savings)) return false
  const keys = Object.keys(v).sort().join(',')
  return keys === 'savings' || (keys === 'admin,savings' && v.admin === true)
}

/** The stored org state, or null (no org, or unreadable). */
export async function readOrg(kv: KV): Promise<OrgState | null> {
  const v = await safeGet(kv, KEYS.org)
  if (!isObj(v) || !ORG_SAVINGS.includes(v.savings) || typeof v.at !== 'number') return null
  const told = ORG_SAVINGS.includes(v.told) ? v.told : null
  return v.admin === true ? { savings: v.savings, at: v.at, told, admin: true } : { savings: v.savings, at: v.at, told }
}

/** True while the signed-in account is its company's admin (O5). */
export async function orgAdmin(kv: KV): Promise<boolean> {
  return (await readOrg(kv))?.admin === true
}

/** 'on' or 'off' while the org set the savings record for everyone, else null. */
export async function orgChoice(kv: KV): Promise<'on' | 'off' | null> {
  const o = await readOrg(kv)
  return o && (o.savings === 'on' || o.savings === 'off') ? o.savings : null
}

/** Keep the hello's org field (undefined: none) and apply an on or off choice. Never throws. */
export async function keepOrg(kv: KV, org: unknown, now: number, setMetrics: (on: boolean) => Promise<boolean>): Promise<void> {
  try {
    const prev = await readOrg(kv)
    if (!validOrg(org)) {
      if (prev) await safeDelete(kv, KEYS.org)
      return
    }
    const { savings, admin } = org as { savings: OrgSavings; admin?: true }
    const told = prev && prev.savings === savings ? prev.told : null
    await safeSet(kv, KEYS.org, admin === true ? { savings, at: now, told, admin } : { savings, at: now, told })
    if (savings === 'each') return
    const on = savings === 'on'
    await safeSet(kv, KEYS.sharing, { on, at: now })
    await setMetrics(on)
    await safeSet(kv, CONSENT_KEY, { answer: on ? 'allow' : 'not_now', at: now })
  } catch {
    // the org state is best effort; the next hello tries again
  }
}

/** The one-time line about the org's choice: the text the first time a choice is seen, then null. */
export async function orgNotice(kv: KV): Promise<string | null> {
  const o = await readOrg(kv)
  if (!o || o.savings === 'each' || o.told === o.savings) return null
  if (!(await safeSet(kv, KEYS.org, { ...o, told: o.savings }))) return null
  return ORG_SAVINGS_TEXT[o.savings] ?? null
}

/** The savings question, with the admin line for a person in an org where each person decides. */
export async function sharingQuestion(kv: KV, question: string): Promise<string> {
  const o = await readOrg(kv)
  return o && o.savings === 'each' ? `${question} ${ORG_ADMIN_SEES}` : question
}
