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
    `uploaded until you choose: /agent-services sharing on asks "Upload, including the past 30 days", "Upload from now on ` +
    `only" or "Don't upload". ${ORG_ADMIN_SEES}`,
  off: 'Your company turned the savings record off for everyone, so you are not asked about it and nothing is ' +
    'uploaded.',
}
export const ORG_SET_TEXT = 'Your company turned the savings record off for everyone, so it cannot be turned on here. Ask ' +
  'your admin. Your private savings page stays yours: /agent-services sharing page on|off.'

export type OrgSavings = 'each' | 'on' | 'off'
export type OrgView = 'totals' | 'members'
export type OrgState = {
  savings: OrgSavings
  at: number
  told: OrgSavings | null
  since?: number
  admin?: true
  view?: OrgView
  has_admin?: boolean
  told_admin?: OrgView
}
const isView = (v: unknown): v is OrgView => v === 'totals' || v === 'members'

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function validOrg(v: unknown): boolean {
  if (!isObj(v) || !ORG_SAVINGS.includes(v.savings)) return false
  if ('admin' in v && v.admin !== true) return false
  if ('view' in v || 'has_admin' in v) {
    if (!isView(v.view) || typeof v.has_admin !== 'boolean') return false
  }
  return Object.keys(v).every((k) => ['savings', 'admin', 'view', 'has_admin'].includes(k))
}

export function adminSees(o: OrgState | null): string {
  return o?.view === 'totals' ? ORG_ADMIN_TOTALS : ORG_ADMIN_SEES
}

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

export async function orgAdmin(kv: KV): Promise<boolean> {
  return (await readOrg(kv))?.admin === true
}

export async function orgChoice(kv: KV): Promise<'on' | 'off' | null> {
  const o = await readOrg(kv)
  return o && (o.savings === 'on' || o.savings === 'off') ? o.savings : null
}

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
    const since = prev && prev.savings === savings && typeof prev.since === 'number' ? prev.since : now
    const state: OrgState = { savings, at: now, told, since }
    if (view !== undefined) state.view = view
    if (has_admin !== undefined) state.has_admin = has_admin
    if (prev?.told_admin !== undefined) state.told_admin = prev.told_admin
    await safeSet(kv, KEYS.org, admin === true ? { ...state, admin } : state)
    if (savings === 'off') await setMetrics(false)
    else if (prev?.savings === 'off') await setMetrics(true)
  } catch {
  }
}

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

export async function sharingQuestion(kv: KV, question: string): Promise<string> {
  const o = await readOrg(kv)
  if (o && o.savings === 'on') {
    return `Your company's admin turned the savings record on and recommends it. ${question} ${adminSees(o)}`
  }
  return o && o.savings === 'each' && o.has_admin !== false ? `${question} ${adminSees(o)}` : question
}
