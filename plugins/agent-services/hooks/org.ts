// The company level on the client: a company's pause and its one choice for the daily upload. Harness-neutral: the
// store is passed in.
//
// - Pause: while the company's admin has paused the company the server answers 423 org_paused to every signed
//   request and to the sign-in. svc.ts keeps a short shared block for it (BLOCK_SECONDS.org_paused), so nothing is
//   sent meanwhile and an unpause is picked up when the block runs out; the sign-in stays. Every tool, the slash
//   command and the status line answer ORG_PAUSED_LINE (auth state 'paused').
// - Upload choice: POST /auth/hello carries {"org": {"savings": "each" | "on" | "off"}} for an account in a company
//   (definitions OrgSavings in the contract). keepOrg stores it under KEYS.org at every hello. "off" turns the daily
//   upload off for everyone (choice.ts recordState reads it over the person's own answer). "on" (0.6.2) is the
//   admin's recommendation only: each member is asked the same three options and nothing of theirs is uploaded until
//   they answer (never switched on silently). The private page stays each person's own answer. Nothing of the person's answer is written here, so a company that hands the choice
//   back ("each", or no company any more) leaves the person's own answer as it was. The person is told the company's
//   choice once (orgNotice). An answer without "org" (no company, or an older server) drops KEYS.org.
// - Company admin: the org field also carries "admin": true for the company's admin; it is kept as `admin: true` in
//   the org state (orgAdmin), and boss.ts then renders and publishes the company board.
// - What the admin sees (shell 0.8.0 and later): the org field also carries "view" ("totals" | "members", the
//   company's board view) and "has_admin" (someone sees the company board or its weekly email). keepOrg keeps both.
//   For a company with an admin, orgNotice says once (and again when the view changes) what that admin sees about
//   the member: their email address, savings estimate and device count, or company totals only (adminSees). The
//   upload question (sharingQuestion) carries the same line, so it is said before anything is uploaded.
import { CONTRACT } from './contract'
import { KEYS, safeDelete, safeGet, safeSet } from './store'
import type { KV } from './store'

export const ORG_PAUSED_LINE = 'Your company has paused agent-services. Ask your admin to turn it back on.'
export const ORG_SAVINGS: readonly string[] = (CONTRACT as any).definitions.OrgSavings.enum
export const ORG_ADMIN_SEES = "Your company's admin sees each member's email address, how many devices each member " +
  "is signed in on, and each member's weekly savings figure (\"no data yet\" while that member uploads nothing)."
export const ORG_ADMIN_TOTALS = "Your company's admin sees only company totals: the total weekly savings estimate " +
  'and how many members have figures, not any one member\'s email address, figure or devices.'
export const ORG_SAVINGS_TEXT: Readonly<Record<string, string>> = {
  on: `Your company's admin turned the savings record on for your company and recommends it. Nothing of yours is ` +
    `uploaded until you choose: /agent-services setup asks "Upload, including the past 30 days", "Upload from now on ` +
    `only" or "Don't upload". ${ORG_ADMIN_SEES}`,
  off: 'Your company turned the daily usage upload off for everyone, so you are not asked about it and nothing is ' +
    'uploaded.',
}
export const ORG_SET_TEXT = 'Your company turned the daily upload off for everyone, so it cannot be turned on here. Ask ' +
  'your admin. Your private savings page stays yours: /agent-services sharing page on|off.'

export type OrgSavings = 'each' | 'on' | 'off'
export type OrgView = 'totals' | 'members'
export type OrgState = {
  savings: OrgSavings
  at: number
  told: OrgSavings | null
  since?: number
  admin?: true
  view?: OrgView // shell 0.8.0: the company's board view
  has_admin?: boolean // shell 0.8.0: someone sees the company board or its weekly email
  told_admin?: OrgView // the view the admin line was last said for (orgNotice)
}
const isView = (v: unknown): v is OrgView => v === 'totals' || v === 'members'

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The hello answer's "org" field is well formed: {"savings": <OrgSavings>}, plus "admin": true, plus (shell 0.8.0)
 * "view" and "has_admin" together; no other key. */
export function validOrg(v: unknown): boolean {
  if (!isObj(v) || !ORG_SAVINGS.includes(v.savings)) return false
  if ('admin' in v && v.admin !== true) return false
  if ('view' in v || 'has_admin' in v) {
    if (!isView(v.view) || typeof v.has_admin !== 'boolean') return false
  }
  return Object.keys(v).every((k) => ['savings', 'admin', 'view', 'has_admin'].includes(k))
}

/** What the company admin sees about this member, in one sentence: totals only, or the member's own row. */
export function adminSees(o: OrgState | null): string {
  return o?.view === 'totals' ? ORG_ADMIN_TOTALS : ORG_ADMIN_SEES
}

/** The stored org state, or null (no company, or unreadable). */
export async function readOrg(kv: KV): Promise<OrgState | null> {
  const v = await safeGet(kv, KEYS.org)
  if (!isObj(v) || !ORG_SAVINGS.includes(v.savings) || typeof v.at !== 'number') return null
  const told = ORG_SAVINGS.includes(v.told) ? v.told : null
  const o: OrgState = { savings: v.savings, at: v.at, told }
  if (typeof v.since === 'number') o.since = v.since
  if (isView(v.view)) o.view = v.view
  if (typeof v.has_admin === 'boolean') o.has_admin = v.has_admin
  if (isView(v.told_admin)) o.told_admin = v.told_admin
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
    const { savings, admin, view, has_admin } = org as { savings: OrgSavings; admin?: true; view?: OrgView; has_admin?: boolean }
    const told = prev && prev.savings === savings ? prev.told : null
    // since: the first time this choice was seen (kept for the status; the upload floor is the member's own answer)
    const since = prev && prev.savings === savings && typeof prev.since === 'number' ? prev.since : now
    const state: OrgState = { savings, at: now, told, since }
    if (view !== undefined) state.view = view
    if (has_admin !== undefined) state.has_admin = has_admin
    if (prev?.told_admin !== undefined) state.told_admin = prev.told_admin
    await safeSet(kv, KEYS.org, admin === true ? { ...state, admin } : state)
    if (savings === 'off') await setMetrics(false)
    else if (prev?.savings === 'off') await setMetrics(true)
  } catch {
    // the org state is best effort; the next hello tries again
  }
}

/** The one-time line about the company's choice: the text the first time a choice is seen, then null. For a company
 * with an admin (has_admin), the line saying what that admin sees is also said once, and again when the view
 * changes; the "on" text carries it already. */
export async function orgNotice(kv: KV): Promise<string | null> {
  const o = await readOrg(kv)
  if (!o) return null
  const view: OrgView = o.view ?? 'members'
  if (o.savings !== 'each' && o.told !== o.savings) {
    const told_admin = o.savings === 'on' ? view : o.told_admin
    if (!(await safeSet(kv, KEYS.org, { ...o, told: o.savings, ...(told_admin ? { told_admin } : {}) }))) return null
    const text = ORG_SAVINGS_TEXT[o.savings] ?? null
    return text && o.savings === 'on' ? text.replace(ORG_ADMIN_SEES, adminSees(o)) : text
  }
  if (o.has_admin !== true || o.savings === 'off' || o.told_admin === view) return null
  if (!(await safeSet(kv, KEYS.org, { ...o, told_admin: view }))) return null
  return `Your company has an agent-services admin. ${adminSees(o)} Your own upload choice decides what is sent ` +
    '(/agent-services sharing).'
}

/** The savings question, with the admin line for a person in a company; under a company "on" it first says the
 * admin turned it on and recommends it. */
export async function sharingQuestion(kv: KV, question: string): Promise<string> {
  const o = await readOrg(kv)
  if (o && o.savings === 'on') {
    return `Your company's admin turned the savings record on and recommends it. ${question} ${adminSees(o)}`
  }
  return o && o.savings === 'each' && o.has_admin !== false ? `${question} ${adminSees(o)}` : question
}
