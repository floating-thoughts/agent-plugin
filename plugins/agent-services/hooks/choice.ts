import type { EngineInterface } from 'claude-code'
import { localDay } from './counters'
import { plusDays } from './pyfmt'
import { getText, KEYS, safeDelete, safeGet, safeSet } from './store'
import type { KV } from './store'
import { readOrg } from './org'

export const CHOICE_KEY = 'savings_choice'
export const SEEDED_KEY = 'choices_seeded'
export const ASK_EVERY_MS = 7 * 86_400_000
export const ASKED_FILE = 'asked.json'
export const SETUP_DONE_KEY = 'setup_done'
export const OLD_KEYS: readonly string[] = ['sharing', 'dashboard_consent', 'savings_prompt']
const DASHBOARD_URL_RX = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+$/

export type Side = 'on' | 'off'
export type RecordValue = Side | 'unanswered'
export type Entry = { record?: Side; at?: number; backfill?: boolean; page?: Side; page_at?: number; consent?: boolean }
export type RecordState = {
  record: RecordValue
  own: RecordValue
  org: Side | null
  page: boolean
  pageSet: boolean
  account: string | null
}

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const side = (v: unknown): Side | undefined => (v === 'on' || v === 'off' ? v : undefined)

export const accountOf = (kv: KV): Promise<string | null> => getText(kv, KEYS.accountId)

export function entryOf(v: unknown): Entry {
  if (!isObj(v)) return {}
  const e: Entry = {}
  const r = side(v.record)
  if (r) e.record = r
  if (num(v.at) !== null) e.at = v.at
  if (typeof v.backfill === 'boolean') e.backfill = v.backfill
  const p = side(v.page)
  if (p) e.page = p
  if (num(v.page_at) !== null) e.page_at = v.page_at
  if (typeof v.consent === 'boolean') e.consent = v.consent
  return e
}

export function seedEntry(old: { sharing: unknown; consent: unknown; settings: unknown }): Entry {
  const s = old.sharing
  const c = isObj(old.consent) && old.consent.by !== 'org' ? old.consent : null
  const set = isObj(old.settings) ? old.settings : {}
  const uploadSwitch = isObj(set.services) ? set.services.metrics : undefined
  const e: Entry = {}
  if (isObj(s) && s.by !== 'org' && s.on === true) {
    e.record = set.metrics_set === true && uploadSwitch === false ? 'off' : 'on'
    if (num(s.at) !== null) e.at = s.at
  } else if (!(isObj(s) && s.by === 'org') && set.metrics_set === true && uploadSwitch === true) {
    e.record = 'on'
  }
  if (c && (c.answer === 'allow' || c.answer === 'not_now')) {
    e.page = c.answer === 'allow' ? 'on' : e.record === 'on' ? 'off' : undefined
    if (num(c.at) !== null && e.page) e.page_at = c.at
    if (!e.page) delete e.page
  }
  return e
}

export async function seedChoices(kv: KV): Promise<void> {
  if ((await safeGet(kv, SEEDED_KEY)) === true) return
  const account = await accountOf(kv)
  if (!account) return
  const e = seedEntry({
    sharing: await safeGet(kv, OLD_KEYS[0]!),
    consent: await safeGet(kv, OLD_KEYS[1]!),
    settings: await safeGet(kv, KEYS.settings),
  })
  const all = await safeGet(kv, CHOICE_KEY)
  const map = isObj(all) ? { ...all } : {}
  if (!isObj(map[account]) && Object.keys(e).length) map[account] = e
  if (!(await safeSet(kv, CHOICE_KEY, map))) return
  if (!(await safeSet(kv, SEEDED_KEY, true))) return
  for (const k of OLD_KEYS) await safeDelete(kv, k)
}

export async function readEntry(kv: KV): Promise<{ account: string | null; entry: Entry }> {
  await seedChoices(kv)
  const account = await accountOf(kv)
  if (!account) return { account: null, entry: {} }
  const all = await safeGet(kv, CHOICE_KEY)
  return { account, entry: entryOf(isObj(all) ? all[account] : null) }
}

export async function writeEntry(kv: KV, patch: Partial<Record<keyof Entry, unknown>>): Promise<boolean> {
  const { account, entry } = await readEntry(kv)
  if (!account) return false
  const next: Record<string, unknown> = { ...entry }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k]
    else next[k] = v
  }
  const all = await safeGet(kv, CHOICE_KEY)
  return safeSet(kv, CHOICE_KEY, { ...(isObj(all) ? all : {}), [account]: next })
}

export async function recordConsent(
  kv: KV,
  granted: boolean,
  send: (body: { purpose: 'usage_upload'; granted: boolean }) => Promise<{ ok: boolean }>,
): Promise<boolean> {
  let ok = false
  try {
    ok = (await send({ purpose: 'usage_upload', granted })).ok === true
  } catch {
    ok = false
  }
  try {
    await writeEntry(kv, { consent: ok ? granted : undefined })
  } catch {
  }
  return ok
}

export async function recordState(kv: KV): Promise<RecordState> {
  try {
    const { account, entry } = await readEntry(kv)
    const o = await readOrg(kv)
    const org: Side | null = o && (o.savings === 'on' || o.savings === 'off') ? o.savings : null
    const own: RecordValue = entry.record ?? 'unanswered'
    const page = entry.page ? entry.page === 'on' : own === 'on'
    return { record: org === 'off' ? 'off' : own, own, org, page, pageSet: entry.page !== undefined, account }
  } catch {
    return { record: 'unanswered', own: 'unanswered', org: null, page: false, pageSet: false, account: null }
  }
}

export const uploadOn = async (kv: KV): Promise<boolean> => (await recordState(kv)).record === 'on'

export const pageOn = async (kv: KV): Promise<boolean> => (await recordState(kv)).page

export const savingsOpen = (s: RecordState): boolean => s.org !== 'off' && s.own === 'unanswered'

export const pageOpen = (_s: RecordState): boolean => false

export async function uploadFloor(kv: KV, today: string, days = 30): Promise<string> {
  try {
    const s = await recordState(kv)
    let answered: string | null = null
    if (s.own === 'on') {
      const { entry } = await readEntry(kv)
      if (num(entry.at) !== null) answered = localDay(entry.at!)
      if (entry.backfill === false) return plusDays(answered ?? today, 1)
    }
    const base = answered && answered < today ? answered : today
    return plusDays(base, (await accountSwitched(kv)) ? 0 : -days)
  } catch {
    return plusDays(today, -days)
  }
}

export async function accountSwitched(kv: KV): Promise<boolean> {
  const st = await safeGet(kv, KEYS.metricsState)
  const account = await accountOf(kv)
  return isObj(st) && typeof st.account === 'string' && !!account && st.account !== account
}

export async function readSetupDone(kv: KV): Promise<boolean> {
  try {
    const account = await accountOf(kv)
    if (!account) return false
    const all = await safeGet(kv, SETUP_DONE_KEY)
    return isObj(all) && isObj(all[account])
  } catch {
    return false
  }
}

export async function markSetupDone(kv: KV, now: number): Promise<boolean> {
  try {
    const account = await accountOf(kv)
    if (!account) return false
    const all = await safeGet(kv, SETUP_DONE_KEY)
    if (isObj(all) && isObj(all[account])) return true
    return await safeSet(kv, SETUP_DONE_KEY, { ...(isObj(all) ? all : {}), [account]: { at: now } })
  } catch {
    return false
  }
}

export const askDue = (askedAt: number | null, now: number): boolean => askedAt === null || now - askedAt >= ASK_EVERY_MS

export function askedFrom(text: string | null): number | null {
  try {
    const v = text === null ? null : JSON.parse(text)
    return isObj(v) ? num(v.at) : null
  } catch {
    return null
  }
}

export async function dashboardUrl(readText: (path: string) => Promise<string | null>, dir: string, file = 'dashboard.json'): Promise<string | null> {
  try {
    const t = await readText(`${dir.replace(/[\\/]+$/, '')}/services/${file}`)
    const s = t === null ? null : JSON.parse(t)
    return isObj(s) && typeof s.url === 'string' && DASHBOARD_URL_RX.test(s.url) ? s.url : null
  } catch {
    return null
  }
}


let askable = false

const engineCall = <T>(f: () => Promise<T> | T, d: T): Promise<T> => Promise.resolve().then(f).catch(() => d)

export async function onDesktop($: EngineInterface): Promise<boolean> {
  return String((await engineCall(() => $.env.get('CLAUDE_CODE_ENTRYPOINT'), '')) ?? '').trim() === 'claude-desktop'
}

export async function attended($: EngineInterface): Promise<boolean> {
  if (await onDesktop($)) return true
  const s = await engineCall(() => $.session.surfaces(), [] as unknown)
  return Array.isArray(s) && s.length > 0
}

export async function canAskNow($: EngineInterface, isInteractive: unknown): Promise<boolean> {
  const surfaces = await engineCall(() => $.session.surfaces(), [] as unknown)
  const list = Array.isArray(surfaces) ? surfaces : []
  askable = (isInteractive === true && list.length > 0) || list.includes('desktop') || (await onDesktop($))
  return askable
}

export const canAsk = (): boolean => askable

export function setCanAsk(v: boolean): void {
  askable = v
}
