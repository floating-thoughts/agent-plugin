import type { EngineInterface } from 'claude-code'
import { jobAskedAt, jobsPermissionWaits, listJobs, type Job } from './jobs'
import { redact } from './redact'
import { relNum, relText } from './reliability'
import { loadTaskState } from './task_state_io'
import { vaultMask } from './vault'

export const REACH_STORE_KEY = 'reach_gate'
export const REACH_ALWAYS: ReachCheck = { present: false, cooldown: false, cap: false }

type Obj = Record<string, any>

const N = (k: string): number | undefined => relNum(`reach.${k}`)
const T = (k: string, vars?: Record<string, string | number>): string | undefined => relText(`reach.text.${k}`, vars)

function quietHours(): readonly [number, number] | null {
  const from = N('REACH_QUIET_HOURS.from')
  const to = N('REACH_QUIET_HOURS.to')
  return from === undefined || to === undefined ? null : [from, to]
}

export type ReachLedger = { day: string; sent: number; subjects: Record<string, number>; person: number | null }
export type ReachWhy = 'present' | 'quiet' | 'cooldown' | 'cap' | 'empty'
export type ReachCheck = { present?: boolean; quiet?: boolean; cooldown?: boolean; cap?: boolean }
export type ReachInput = {
  subjects: readonly string[]
  at: number
  ledger: unknown
  tzMin?: number
  quietHours?: readonly [number, number] | null
  cap?: number
  cooldownMs?: number
  presentMs?: number
  check?: ReachCheck
}
export type ReachVerdict = { ok: boolean; why: ReachWhy | null; subjects: string[]; ledger: ReachLedger }

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function reachText(text: unknown, max: number | undefined = N('REACH_TEXT_MAX')): string {
  try {
    if (typeof max !== 'number' || !Number.isFinite(max)) return ''
    const s = redact(vaultMask(String(text ?? ''))).replace(/[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim()
    const chars = [...s]
    const n = Math.max(1, Math.floor(max))
    return chars.length > n ? chars.slice(0, n - 1).join('') + String.fromCharCode(0x2026) : s
  } catch {
    return '(withheld)'
  }
}

export function localDay(at: number, tzMin = 0): string {
  return new Date(at + tzMin * 60_000).toISOString().slice(0, 10)
}

export function localHour(at: number, tzMin = 0): number {
  return new Date(at + tzMin * 60_000).getUTCHours()
}

export function inQuietHours(hour: number, quiet: readonly [number, number] | null | undefined): boolean {
  if (!Array.isArray(quiet) || quiet.length !== 2) return false
  const [from, to] = quiet as [number, number]
  if (!Number.isInteger(from) || !Number.isInteger(to) || from === to) return false
  return from < to ? hour >= from && hour < to : hour >= from || hour < to
}

export function normReach(v: unknown): ReachLedger {
  const x: Obj = isObj(v) ? v : {}
  const subjects: Record<string, number> = Object.create(null)
  if (isObj(x.subjects)) for (const [k, t] of Object.entries(x.subjects)) if (num(t) !== null && k) subjects[k] = t as number
  return {
    day: typeof x.day === 'string' ? x.day : '',
    sent: Math.max(0, Math.floor(num(x.sent) ?? 0)),
    subjects,
    person: num(x.person),
  }
}

function pruneSubjects(s: Record<string, number>, at: number, cooldownMs: number): Record<string, number> {
  const keep = Object.entries(s).filter(([, t]) => at - t < Math.max(cooldownMs, 86_400_000))
  keep.sort((a, b) => b[1] - a[1])
  return Object.fromEntries(keep.slice(0, N('REACH_SUBJECTS_MAX')))
}

export function reachGate(input: ReachInput): ReachVerdict {
  const subjects = Array.isArray(input?.subjects) ? [...new Set(input.subjects.filter((s) => typeof s === 'string' && s !== ''))] : []
  let ledger = normReach(input?.ledger)
  try {
    if (!subjects.length) return { ok: false, why: 'empty', subjects, ledger }
    const at = num(input.at)
    if (at === null) return { ok: true, why: null, subjects, ledger }
    const check: ReachCheck = input.check ?? {}
    const tz = num(input.tzMin) ?? 0
    const cap = num(input.cap) ?? N('REACH_DAILY_CAP')
    const cooldown = num(input.cooldownMs) ?? N('REACH_COOLDOWN_MS')
    const present = num(input.presentMs) ?? N('REACH_PRESENT_MS')
    const quiet = input.quietHours === undefined ? quietHours() : input.quietHours
    const day = localDay(at, tz)
    if (ledger.day !== day) ledger = { ...ledger, day, sent: 0 }
    ledger = { ...ledger, subjects: pruneSubjects(ledger.subjects, at, cooldown ?? 0) }
    const no = (why: ReachWhy, left: string[] = subjects): ReachVerdict => ({ ok: false, why, subjects: left, ledger })
    if (check.present !== false && present !== undefined && ledger.person !== null && at - ledger.person >= 0 && at - ledger.person < present) return no('present')
    if (check.quiet !== false && inQuietHours(localHour(at, tz), quiet)) return no('quiet')
    const free = check.cooldown === false || cooldown === undefined ? subjects : subjects.filter((s) => {
      const t = ledger.subjects[s]
      return t === undefined || at - t >= cooldown || at < t
    })
    if (!free.length) return no('cooldown', [])
    if (check.cap !== false && cap !== undefined && ledger.sent >= cap) return no('cap', free)
    const marked = { ...ledger.subjects }
    for (const s of free) marked[s] = at
    return { ok: true, why: null, subjects: free, ledger: { ...ledger, sent: ledger.sent + 1, subjects: marked } }
  } catch {
    return { ok: true, why: null, subjects, ledger }
  }
}


export type Wait = { key: string; kind: 'job' | 'question' | 'task'; title: string; what: string; since: number | null }
export type NeedsState = { seen: Record<string, number>; alerted: Record<string, number>; lastAt: number | null }

export function emptyNeeds(): NeedsState {
  return { seen: {}, alerted: {}, lastAt: null }
}

const timeOf = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v) {
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : t
  }
  return null
}

export function waitsOf(jobs: readonly Job[] | null | undefined, state: unknown, session = ''): Wait[] {
  const out: Wait[] = []
  try {
    const waiting = T('wait_default') ?? ''
    for (const j of Array.isArray(jobs) ? jobs : []) {
      if (!j || typeof j.id !== 'string' || j.status !== 'waiting') continue
      if (session && j.session && j.session !== session) continue
      out.push({ key: `job:${j.id}`, kind: 'job', title: String(j.title || j.kind || T('job_default') || ''), what: String(j.note || waiting), since: num(j.updated_at) ?? num(j.last_activity_at) })
    }
    const s: Obj = isObj(state) ? state : {}
    for (const q of Array.isArray(s.questions) ? s.questions : []) {
      if (!isObj(q) || typeof q.id !== 'string' || !q.id || (q.answer !== null && q.answer !== undefined) || q.needs_user === false) continue
      out.push({ key: `question:${q.id}`, kind: 'question', title: q.id, what: String(q.text ?? ''), since: timeOf(q.asked_at) })
    }
    for (const t of Array.isArray(s.tasks) ? s.tasks : []) {
      if (!isObj(t) || typeof t.id !== 'string' || t.status !== 'waiting_user') continue
      const w: Obj = isObj(t.waiting_for) ? t.waiting_for : {}
      out.push({ key: `task:${t.id}`, kind: 'task', title: String(t.title || t.id), what: String(w.ref || waiting), since: timeOf(w.since) ?? timeOf(t.updated) })
    }
  } catch {}
  return out
}

export function needsYouDue(input: { waits: readonly Wait[]; at: number; personAt: number | null; needs: NeedsState | null | undefined }): { due: Wait[]; needs: NeedsState } {
  const old = input?.needs && typeof input.needs === 'object' ? input.needs : emptyNeeds()
  const at = num(input?.at)
  const waits = Array.isArray(input?.waits) ? input.waits.filter((w) => w && typeof w.key === 'string') : []
  const needs: NeedsState = { seen: {}, alerted: {}, lastAt: num(old.lastAt) }
  try {
    if (at === null) return { due: [], needs: { ...needs, seen: { ...(old.seen ?? {}) }, alerted: { ...(old.alerted ?? {}) } } }
    for (const [k, t] of Object.entries(old.alerted ?? {})) if (num(t) !== null && at - (t as number) < 86_400_000) needs.alerted[k] = t as number
    for (const w of waits) {
      const began = num(w.since)
      needs.seen[w.key] = num(old.seen?.[w.key]) ?? Math.min(at, began !== null && began <= at ? began : at)
    }
    const grace = N('NEEDS_YOU_GRACE_MS')
    const present = N('REACH_PRESENT_MS')
    const throttle = N('NEEDS_YOU_THROTTLE_MS')
    if (grace === undefined) return { due: [], needs }
    const person = num(input.personAt)
    if (present !== undefined && person !== null && at - person >= 0 && at - person < present) return { due: [], needs }
    if (throttle !== undefined && needs.lastAt !== null && at - needs.lastAt >= 0 && at - needs.lastAt < throttle) return { due: [], needs }
    const due = waits.filter((w) => needs.alerted[w.key] === undefined && at - needs.seen[w.key]! >= grace)
    return { due, needs }
  } catch {
    return { due: [], needs }
  }
}

export function needsYouSent(needs: NeedsState, keys: readonly string[], at: number, sent: boolean): NeedsState {
  const alerted = { ...(needs?.alerted ?? {}) }
  for (const k of keys) alerted[k] = at
  return { seen: { ...(needs?.seen ?? {}) }, alerted, lastAt: sent ? at : needs?.lastAt ?? null }
}

function waitLine(w: Wait): string | undefined {
  if (w.kind === 'job') return T('wait_job', { title: reachText(w.title, 60), what: reachText(w.what) })
  if (w.kind === 'question') return T('wait_question', { id: reachText(w.title, 40), what: reachText(w.what) })
  return T('wait_task', { title: reachText(w.title, 60), what: reachText(w.what) })
}

export function needsYouText(items: readonly Wait[]): string {
  const list = Array.isArray(items) ? items.filter(Boolean) : []
  const max = N('REACH_NOTIFY_MAX')
  if (!list.length || max === undefined || N('REACH_TEXT_MAX') === undefined) return ''
  const lines: string[] = []
  for (const w of list) {
    const l = waitLine(w)
    if (l === undefined) return ''
    lines.push(l)
  }
  const body = lines.length === 1 ? `${lines[0]![0]!.toUpperCase()}${lines[0]!.slice(1)}.` : T('waits_many', { n: lines.length, lines: lines.join('; ') })
  if (body === undefined) return ''
  const text = `agent-services: ${body}`
  const chars = [...text]
  return chars.length > max ? chars.slice(0, max - 1).join('') + String.fromCharCode(0x2026) : text
}


let memo: ReachLedger | null = null
let needs: NeedsState = emptyNeeds()
const permDone = new Set<string>()

const tzOf = (at: number): number => {
  try {
    return -new Date(at).getTimezoneOffset()
  } catch {
    return 0
  }
}

async function nowOf($: EngineInterface): Promise<number> {
  try {
    const t = Number(await $.clock.now())
    return Number.isFinite(t) ? t : Date.now()
  } catch {
    return Date.now()
  }
}

async function readLedger($: EngineInterface): Promise<ReachLedger> {
  try {
    const v = await $.store.get(REACH_STORE_KEY)
    if (v !== undefined && v !== null) {
      memo = normReach(v)
      return memo
    }
  } catch {}
  return memo ?? normReach(null)
}

async function writeLedger($: EngineInterface, l: ReachLedger): Promise<void> {
  memo = l
  try {
    await $.store.set(REACH_STORE_KEY, l)
  } catch {}
}

export async function reachPerson($: EngineInterface, at?: number): Promise<number | null> {
  try {
    const t = typeof at === 'number' && Number.isFinite(at) ? at : await nowOf($)
    const l = await readLedger($)
    const prev = l.person
    needs = { ...needs, alerted: {} }
    await writeLedger($, { ...l, person: t })
    return prev
  } catch {
    return null
  }
}

export async function reachNotify($: EngineInterface, subject: string, text: string, check?: ReachCheck): Promise<boolean> {
  try {
    const line = reachText(text, N('REACH_NOTIFY_MAX'))
    if (!line) return false
    const at = await nowOf($)
    const v = reachGate({ subjects: [subject], at, ledger: await readLedger($), tzMin: tzOf(at), check })
    if (!v.ok) return false
    await Promise.resolve($.ui.notify(line))
    await writeLedger($, v.ledger)
    return true
  } catch {
    return false
  }
}

export async function needsYouTick($: EngineInterface, at?: number, state?: unknown): Promise<string | null> {
  try {
    const now = typeof at === 'number' && Number.isFinite(at) ? at : await nowOf($)
    const jobs = await listJobs($)
    const st = state !== undefined ? state : (await loadTaskState($)).state
    let session = ''
    try {
      session = String((await $.session.id()) ?? '')
    } catch {}
    const ledger = await readLedger($)
    const asked = await permissionAlert($, jobs, session, now, ledger)
    if (asked !== null) return asked
    const d = needsYouDue({ waits: waitsOf(jobs, st, session), at: now, personAt: ledger.person, needs })
    needs = d.needs
    if (!d.due.length) return null
    const subjectOf = (w: Wait) => `needs:${w.key}`
    const v = reachGate({ subjects: d.due.map(subjectOf), at: now, ledger, tzMin: tzOf(now) })
    if (!v.ok) {
      if (v.why === 'cooldown') needs = needsYouSent(needs, d.due.map((w) => w.key), now, false)
      return null
    }
    const items = d.due.filter((w) => v.subjects.includes(subjectOf(w)))
    const text = needsYouText(items)
    if (!text) return null
    needs = needsYouSent(needs, d.due.map((w) => w.key), now, true)
    await Promise.resolve($.ui.notify(text))
    await writeLedger($, v.ledger)
    return text
  } catch {
    return null
  }
}

export function permissionText(items: readonly Job[], at: number): string {
  const list = Array.isArray(items) ? items.filter(Boolean) : []
  const max = N('REACH_NOTIFY_MAX')
  if (!list.length || max === undefined || N('REACH_TEXT_MAX') === undefined) return ''
  const lines: string[] = []
  for (const j of list) {
    const since = jobAskedAt(j)
    const mins = since === null ? 0 : Math.max(1, Math.floor((at - since) / 60_000))
    const l = T('wait_permission', { title: reachText(j.title || j.kind || T('job_default') || '', 60), mins })
    if (l === undefined) return ''
    lines.push(l)
  }
  const body = lines.length === 1 ? `${lines[0]![0]!.toUpperCase()}${lines[0]!.slice(1)}.` : T('waits_many', { n: lines.length, lines: lines.join('; ') })
  if (body === undefined) return ''
  const text = `agent-services: ${body}`
  const chars = [...text]
  return chars.length > max ? chars.slice(0, max - 1).join('') + String.fromCharCode(0x2026) : text
}

async function permissionAlert($: EngineInterface, jobs: readonly Job[], session: string, now: number, ledger: ReachLedger): Promise<string | null> {
  const ms = N('PERMISSION_WAIT_MS')
  const waits = jobsPermissionWaits(jobs.filter((j) => !session || !j.session || j.session === session), now, ms)
  const live = new Set(waits.map((j) => `${j.id}@${jobAskedAt(j)}`))
  for (const k of [...permDone]) if (!live.has(k)) permDone.delete(k)
  const due = waits.filter((j) => {
    const k = `${j.id}@${jobAskedAt(j)}`
    if (permDone.has(k)) return false
    const named = needs.alerted[`job:${j.id}`]
    if (typeof named === 'number' && named >= (jobAskedAt(j) ?? now)) {
      permDone.add(k)
      return false
    }
    return true
  })
  if (!due.length) return null
  const subjectOf = (j: Job) => `perm:${j.id}@${jobAskedAt(j)}`
  const v = reachGate({ subjects: due.map(subjectOf), at: now, ledger, tzMin: tzOf(now), check: { present: false } })
  if (!v.ok) {
    if (v.why === 'cooldown') for (const j of due) permDone.add(`${j.id}@${jobAskedAt(j)}`)
    return null
  }
  const items = due.filter((j) => v.subjects.includes(subjectOf(j)))
  const text = permissionText(items, now)
  if (!text) return null
  for (const j of items) permDone.add(`${j.id}@${jobAskedAt(j)}`)
  needs = needsYouSent(needs, items.map((j) => `job:${j.id}`), now, true)
  await Promise.resolve($.ui.notify(text))
  await writeLedger($, v.ledger)
  return text
}

export function reachResetForTest(): void {
  memo = null
  needs = emptyNeeds()
  permDone.clear()
}
