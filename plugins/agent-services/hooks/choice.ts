// The person's own choices and when they may be asked (0.6.0). Harness-neutral except canAskNow, which reads the
// engine once at session start.
//
// - The savings record: one record per signed-in account, on, off or unanswered (CHOICE_KEY, keyed by account id),
//   so switching account never carries a yes over. Its parts: the daily upload (the record itself), the private
//   savings page (`page`, the person's own answer; it follows the record until set alone) and the weekly email (a
//   server setting, changed with the record). The status line, the band, the savings page, the upload and the weekly
//   email all read this one record (recordState, uploadOn, pageOn).
// - The person's "on" says how far back the first upload goes (`backfill`, 0.6.2): true ("Upload, including the past
//   30 days", and every "on" kept before 0.6.2) sends up to 30 earlier days; false ("Upload from now on only") sends
//   only the days after the day of the choice.
// - A company's choice (org.ts, from the sign-in check): "off" turns the upload off for everyone. "on" (0.6.2) no
//   longer switches anyone on: it is the admin's recommendation, and each member answers the same question; until a
//   member answers, nothing of theirs is uploaded. The private page stays each person's own answer, also for a
//   company admin (whose company board follows the same page answer, so a company "off" never hides it).
// - "off" is final: never asked again. Unanswered is asked at most once per ASK_EVERY_MS across all sessions: the
//   shared "last asked" time is a small file in the plugin data folder (the caller reads and writes it).
// - The 0.5.0 keys (sharing, dashboard_consent, savings_prompt and the upload switch) are read once, for the account
//   signed in then, to seed the record (seedChoices); after that they are never read again.
// - canAskNow is the one "can we ask the user now" check: an interactive session with a surface to ask on. A -p
//   run, a CI run or an SDK call without a surface gets no question, no dialog and no question note.
import type { EngineInterface } from 'claude-code'
import { localDay } from './counters'
import { plusDays } from './pyfmt'
import { getText, KEYS, safeDelete, safeGet, safeSet } from './store'
import type { KV } from './store'
import { readOrg } from './org'

export const CHOICE_KEY = 'savings_choice' // { [account id]: { record, at, page, page_at } }
export const SEEDED_KEY = 'choices_seeded' // true once the 0.5.0 keys were read
export const ASK_EVERY_MS = 7 * 86_400_000 // an unanswered question is asked at most this often
export const ASKED_FILE = 'asked.json' // <data dir>/services/asked.json: { at } of the last question, any session
export const OLD_KEYS: readonly string[] = ['sharing', 'dashboard_consent', 'savings_prompt']
const DASHBOARD_URL_RX = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+$/ // as dashboard.ts URL_RX

export type Side = 'on' | 'off'
export type RecordValue = Side | 'unanswered'
export type Entry = { record?: Side; at?: number; backfill?: boolean; page?: Side; page_at?: number }
export type RecordState = {
  record: RecordValue // what the upload does: the company's "off", else the person's own answer
  own: RecordValue // the person's own answer
  org: Side | null // the company's choice for everyone, if any
  page: boolean // the private page is to be published
  pageSet: boolean // the person answered the page on its own
  account: string | null
}

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const side = (v: unknown): Side | undefined => (v === 'on' || v === 'off' ? v : undefined)

/** The signed-in account id, or null. */
export const accountOf = (kv: KV): Promise<string | null> => getText(kv, KEYS.accountId)

/** One entry as stored, cleaned. Pure. */
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
  return e
}

/** The record the 0.5.0 keys describe, for one account. Pure. */
export function seedEntry(old: { sharing: unknown; consent: unknown; settings: unknown }): Entry {
  const s = old.sharing
  const c = isObj(old.consent) && old.consent.by !== 'org' ? old.consent : null
  const set = isObj(old.settings) ? old.settings : {}
  const uploadSwitch = isObj(set.services) ? set.services.metrics : undefined
  const e: Entry = {}
  if (isObj(s) && s.by !== 'org' && s.on === true) {
    // the record was on; an upload turned off on its own since then counts as off
    e.record = set.metrics_set === true && uploadSwitch === false ? 'off' : 'on'
    if (num(s.at) !== null) e.at = s.at
  } else if (!(isObj(s) && s.by === 'org') && set.metrics_set === true && uploadSwitch === true) {
    e.record = 'on' // "savings on" after its preview (a company's yes switched it too: never the person's own)
  }
  if (c && (c.answer === 'allow' || c.answer === 'not_now')) {
    e.page = c.answer === 'allow' ? 'on' : e.record === 'on' ? 'off' : undefined
    if (num(c.at) !== null && e.page) e.page_at = c.at
    if (!e.page) delete e.page
  }
  return e
}

/** Read the 0.5.0 keys once, for the account signed in now, and stop reading them. Waits for a sign-in. */
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

/** The signed-in account's own entry ({} when there is none or nobody is signed in). */
export async function readEntry(kv: KV): Promise<{ account: string | null; entry: Entry }> {
  await seedChoices(kv)
  const account = await accountOf(kv)
  if (!account) return { account: null, entry: {} }
  const all = await safeGet(kv, CHOICE_KEY)
  return { account, entry: entryOf(isObj(all) ? all[account] : null) }
}

/** Change the signed-in account's own entry; false when nobody is signed in or the store refused. A field set to
 * undefined is dropped. */
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

/** The record as every surface shows it. Never throws. */
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

/** The daily upload is on: the person's own "on", unless the company turned it off. */
export const uploadOn = async (kv: KV): Promise<boolean> => (await recordState(kv)).record === 'on'

/** The private savings page (and, for a company admin, the company board) may be published. */
export const pageOn = async (kv: KV): Promise<boolean> => (await recordState(kv)).page

/** The savings question is open: no answer of the person's own and no company "off" (a company "on" asks too, as a
 * recommendation). "off" is never open. */
export const savingsOpen = (s: RecordState): boolean => s.org !== 'off' && s.own === 'unanswered'

/** The 0.6.1 page-only question under a company "on": never open since 0.6.2 (the savings question sets the page
 * too); kept one version for callers that import it. */
export const pageOpen = (_s: RecordState): boolean => false

/** The first day the daily upload may send: 30 days (`days`) before the person's "on"; `today` minus `days` with no
 * day known. "Upload from now on only" (backfill false): the day after the day of the choice, so nothing from before
 * the choice is sent. After an account switch on this machine (the upload state names another account) nothing
 * before the new yes is sent. Never throws. */
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

/** The upload state (store metrics_state) was written for another account than the one signed in now. */
export async function accountSwitched(kv: KV): Promise<boolean> {
  const st = await safeGet(kv, KEYS.metricsState)
  const account = await accountOf(kv)
  return isObj(st) && typeof st.account === 'string' && !!account && st.account !== account
}

/** Whether a question may be asked now: never asked, or last asked ASK_EVERY_MS ago or more. Pure. */
export const askDue = (askedAt: number | null, now: number): boolean => askedAt === null || now - askedAt >= ASK_EVERY_MS

/** The "last asked" time from the text of ASKED_FILE, or null. Pure. */
export function askedFrom(text: string | null): number | null {
  try {
    const v = text === null ? null : JSON.parse(text)
    return isObj(v) ? num(v.at) : null
  } catch {
    return null
  }
}

/** The published page's artifact URL from <data dir>/services/dashboard.json (a company admin's: boss.json), or
 * null. */
export async function dashboardUrl(readText: (path: string) => Promise<string | null>, dir: string, file = 'dashboard.json'): Promise<string | null> {
  try {
    const t = await readText(`${dir.replace(/[\\/]+$/, '')}/services/${file}`)
    const s = t === null ? null : JSON.parse(t)
    return isObj(s) && typeof s.url === 'string' && DASHBOARD_URL_RX.test(s.url) ? s.url : null
  } catch {
    return null
  }
}

// ------------------------------------------------------------------ can we ask the user now

let askable = false // set once per session by canAskNow

/** session.start: an interactive session with at least one surface to ask on. Kept for canAsk(). Never throws. */
export async function canAskNow($: EngineInterface, isInteractive: unknown): Promise<boolean> {
  let surfaces: unknown = []
  try {
    surfaces = await Promise.resolve().then(() => $.session.surfaces())
  } catch {
    surfaces = []
  }
  askable = isInteractive === true && Array.isArray(surfaces) && surfaces.length > 0
  return askable
}

/** The answer of this session's canAskNow (false before it ran). */
export const canAsk = (): boolean => askable

// For the tests: a session with (or without) someone to ask.
export function setCanAsk(v: boolean): void {
  askable = v
}
