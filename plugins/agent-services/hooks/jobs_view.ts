import type { EngineInterface } from 'claude-code'
import { readyTogether, STEPS_FILE } from './flow'
import { ago, jobOpen, jobsLive, jobsMarkRead, jobsNotification, jobStepOf, jobText, listJobs, noticesOf, statusWord, JOBS_FILE, type Job } from './jobs'
import { ownershipNote } from './ownership'
import { readPlan } from './plan_file'
import { NOTE_PREFIX } from './review'
import { relNum, relText } from './reliability'
import { loadTaskState, projectDir } from './task_state_io'

export { ago, jobsBandLine, statusWord } from './jobs'

const freshMs = (): number | undefined => relNum('jobs_view.CLAIM_FRESH_MS')
const pendingMs = (): number | undefined => relNum('jobs_view.CLAIM_PENDING_MS')

type Obj = Record<string, any>
type Ready = Promise<unknown> | undefined
type TaskLike = { id: string; title?: string; status: string }
export type ReadyQueue = {
  steps: string[]
  ownsUnknown: string[]
  tasks: { id: string; title: string }[]
  claimed: { step: string | null; task: string | null; job: string; status: string }[]
}

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const cut = (s: unknown, n: number): string => {
  const t = [...String(s ?? '').replace(/[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim()]
  return t.length > n ? t.slice(0, n - 1).join('') + String.fromCharCode(0x2026) : t.join('')
}

type Pending = { call: string; at: number; ev: object }
type Held = { agent: string; call: string; at: number; title: string }

let lastSeen: Record<string, string> | null = null
let pendingClaims = new Map<string, Pending>()
let heldClaims = new Map<string, Held>()
let claimOf = new WeakMap<object, string>()

const attention = (j: Job): number => (j.status === 'waiting' ? 0 : j.status === 'stalled' ? 1 : 2)
const endOf = (j: Job): number => (typeof j.ended_at === 'number' ? j.ended_at : j.updated_at ?? j.last_activity_at ?? 0)

export function jobsTable(jobs: readonly Job[], now: number, opts: { all?: boolean } = {}): { text: string; shown: string[] } {
  if (!jobs.length) return { text: `No background jobs are recorded for this project yet (${JOBS_FILE}).`, shown: [] }
  const open = jobs.filter(jobOpen).sort((a, b) => attention(a) - attention(b) || b.last_activity_at - a.last_activity_at)
  const done = jobs.filter((j) => !jobOpen(j)).sort((a, b) => endOf(b) - endOf(a))
  const shownMax = relNum('jobs_view.JOBS_SHOWN_DONE')
  const listed = opts.all ? done : done.slice(0, shownMax ?? 0)
  const hidden = done.length - listed.length
  const rows = [...open, ...listed].map((j) => [
    `${statusWord(j.status)}${j.unread === true ? ' *' : ''}`,
    ago(now - j.started_at),
    `${ago(now - j.last_activity_at)} ago`,
    cut(j.title || `(${j.kind})`, 48),
    cut(j.model || '-', 16),
    cut(j.note || '', 70),
    j.id,
  ])
  const head = ['STATUS', 'AGE', 'LAST ACTIVITY', 'TITLE', 'MODEL', 'NOTE', 'ID']
  const widths = head.map((h, k) => Math.max(h.length, ...rows.map((r) => [...r[k]!].length)))
  const line = (r: string[]) => r.map((c, k) => (k === r.length - 1 ? c : c + ' '.repeat(widths[k]! - [...c].length))).join('  ').trimEnd()
  const unread = listed.filter((j) => j.unread === true)
  const out = [
    `Background jobs in ${JOBS_FILE}: ${open.length} open, ${done.length} finished` +
      (hidden > 0 ? ` (${hidden} older finished not shown; the setup tool's "jobs all" lists them).` : '.'),
    '',
    line(head),
    ...rows.map(line),
  ]
  if (unread.length) out.push('', '* a finished result shown here for the first time.')
  return { text: out.join('\n'), shown: unread.map((j) => j.id) }
}

export function jobsChangeNote(prev: Readonly<Record<string, string>> | null, jobs: readonly Job[], session: string): { note: string | null; snapshot: Record<string, string> } {
  const mine = jobs.filter((j) => !session || j.session === session)
  const snapshot: Record<string, string> = Object.create(null)
  for (const j of mine) snapshot[j.id] = j.status
  if (prev === null) return { note: null, snapshot }
  const before = (id: string): string | undefined => (Object.hasOwn(prev, id) ? prev[id] : undefined)
  const changed = mine.filter((j) => (before(j.id) !== undefined ? before(j.id) !== j.status : j.status !== 'running'))
  const max = relNum('jobs_view.JOBS_NOTE_LINES')
  const head = relText('jobs_view.text.change_head', { file: JOBS_FILE })
  if (!changed.length || max === undefined || head === undefined) return { note: null, snapshot }
  const lines = changed.slice(0, max).map((j) => {
    const was = before(j.id)
    return `- ${cut(j.title || '(no title)', 80)} (${j.kind} ${j.id}): ${was ? `${statusWord(was)} -> ` : ''}${statusWord(j.status)}${j.note ? `: ${cut(j.note, 120)}` : ''}`
  })
  if (changed.length > lines.length) lines.push(`- and ${changed.length - lines.length} more`)
  return { note: [`${NOTE_PREFIX}: ${head}`, ...lines].join('\n').slice(0, 1500), snapshot }
}

function depsOf(text: string | null): Map<string, string[]> {
  const out = new Map<string, string[]>()
  try {
    const j = JSON.parse(text ?? '')
    const list: unknown[] = Array.isArray(j) ? j : isObj(j) && Array.isArray(j.steps) ? j.steps : []
    for (const s of list) {
      if (!isObj(s) || (typeof s.id !== 'string' && typeof s.id !== 'number')) continue
      const d = Array.isArray(s.deps) ? s.deps : Array.isArray(s.depends_on) ? s.depends_on : []
      out.set(String(s.id), d.map(String))
    }
  } catch {}
  return out
}

export function readyQueue(stepsText: string | null, tasks: readonly TaskLike[] | null, jobs: readonly Job[]): ReadyQueue {
  const open = jobs.filter(jobOpen)
  const heldSteps = new Set(open.map((j) => j.step).filter((s): s is string => typeof s === 'string' && s !== ''))
  const heldTasks = new Set(open.map((j) => j.task).filter((s): s is string => typeof s === 'string' && s !== ''))
  const deps = depsOf(stepsText)
  const together = readyTogether(stepsText)
  const steps = together.steps.filter((id) => !heldSteps.has(id) && !(deps.get(id) ?? []).some((d) => heldSteps.has(d)))
  return {
    steps,
    ownsUnknown: together.unknown.filter((id) => steps.includes(id)),
    tasks: (tasks ?? []).filter((t) => isObj(t) && t.status === 'todo' && !heldTasks.has(t.id)).map((t) => ({ id: t.id, title: String(t.title ?? '') })),
    claimed: open.filter((j) => j.step || j.task).map((j) => ({ step: j.step ?? null, task: j.task ?? null, job: j.id, status: j.status })),
  }
}

export function readyText(q: ReadyQueue): string {
  const out: string[] = []
  const now = [...q.steps.map((s) => `step ${s}${(q.ownsUnknown ?? []).includes(s) ? ' (owns unknown)' : ''}`),...q.tasks.map((t) => `task ${t.id}${t.title ? ` (${cut(t.title, 60)})` : ''}`)]
  if (now.length) out.push(`Ready to start now: ${now.join(', ')}.`)
  if (q.claimed.length) {
    out.push(`Claimed by open jobs: ${q.claimed.map((c) => `${c.step !== null ? `step ${c.step}` : `task ${c.task}`} (job ${c.job}, ${statusWord(c.status)})`).join(', ')}.`)
  }
  return out.join('\n')
}

export type ClaimHit = { holder: Job; pending?: undefined } | { holder?: undefined; pending: { call: string; at: number } }

export function claimHit(step: string, jobs: readonly Job[], now: number, pending: { call: string; at: number } | null = null): ClaimHit | null {
  const fresh = freshMs()
  const wait = pendingMs()
  if (fresh === undefined || wait === undefined) return null
  const holder = jobs.find((j) => j.step === step && (j.status === 'running' || j.status === 'waiting') && now - (j.last_activity_at || 0) <= fresh)
  if (holder) return { holder }
  if (pending && now - pending.at <= wait) return { pending }
  return null
}

function hitText(step: string, hit: ClaimHit, now: number, fact: boolean): string | null {
  const tail = relText('jobs_view.text.claim_tail') ?? null
  if (!fact && tail === null) return null
  const vars = hit.holder
    ? { step, job: hit.holder.id, title: cut(hit.holder.title, 80), status: statusWord(hit.holder.status), ago: ago(now - hit.holder.last_activity_at), tail: tail ?? '' }
    : { step, call: hit.pending.call, tail: tail ?? '' }
  return relText(`jobs_view.text.claim_${hit.holder ? 'held' : 'pending'}${fact ? '_fact' : ''}`, vars) ?? null
}

export function claimRefusal(step: string, jobs: readonly Job[], now: number, pending: { call: string; at: number } | null = null): string | null {
  const hit = claimHit(step, jobs, now, pending)
  return hit ? hitText(step, hit, now, false) : null
}


async function sessionOf($: EngineInterface): Promise<string> {
  try {
    return String((await $.session.id()) ?? '')
  } catch {
    return ''
  }
}

export function claimNote(step: string, hit: ClaimHit | null, ledger: Job | null, now: number): string | null {
  if (hit) {
    const fact = hitText(step, hit, now, true)
    const anyway = relText('jobs_view.text.claim_anyway')
    return fact !== null && anyway !== undefined ? `${NOTE_PREFIX}: ${fact} ${anyway}` : null
  }
  if (!ledger) return null
  const text = relText('jobs_view.text.claim_ledger', {
    step: cut(step, 80), job: ledger.id, title: cut(ledger.title, 80), status: statusWord(ledger.status), ago: ago(now - ledger.last_activity_at), file: JOBS_FILE,
  })
  return text === undefined ? null : `${NOTE_PREFIX}: ${text}`
}

async function agentStatus($: EngineInterface, id: string): Promise<string | null | undefined> {
  try {
    const list = await Promise.resolve($.agent.list())
    if (!Array.isArray(list)) return undefined
    const a = list.find((x) => isObj(x) && x.id === id)
    return a ? String(a.status ?? '') : null
  } catch {
    return undefined
  }
}

export async function jobsClaim($: EngineInterface, e: Obj, rt?: Ready): Promise<string | null> {
  try {
    if (!isObj(e) || e.fork === true || e.isTeammate === true) return null
    const text = `${e.description ?? ''}\n${e.prompt ?? ''}`
    const step = jobStepOf(text)
    const fresh = freshMs()
    const wait = pendingMs()
    if (!step || fresh === undefined || wait === undefined || /\[override:\s*[^\]]+\]/i.test(text) || !(await jobsLive(rt))) return null
    const now = Number(await Promise.resolve($.clock.now()).catch(() => Date.now()))
    for (const [k, v] of pendingClaims) if (now - v.at > wait) pendingClaims.delete(k)
    const call = String(e.tool_use_id ?? '')
    const main = !(typeof e.parentAgentId === 'string' && e.parentAgentId)
    const holder = heldClaims.get(step)
    const rows = await listJobs($)
    let facts: Job[] = []
    if (holder) {
      const status = await agentStatus($, holder.agent)
      if (status === null || (typeof status === 'string' && !['pending', 'running', 'waiting'].includes(status))) heldClaims.delete(step)
      else if (typeof status === 'string') {
        facts = [{ id: holder.agent, kind: 'subagent', title: holder.title, status: status === 'waiting' ? 'waiting' : 'running', started_at: holder.at, last_activity_at: now, session: '', step }]
      }
    }
    const taken = pendingClaims.get(step)
    const hit = claimHit(step, facts, now, taken && taken.ev !== e && (taken.call !== call || !call) ? taken : null)
    const why = hit ? hitText(step, hit, now, false) : null
    if (hit && why === null) return null
    if (why && !main) return why
    const known = (id: string) => id === heldClaims.get(step)?.agent
    const ledger = why ? null : rows.find((j) => j.step === jobText(step, 80) && !known(j.id) && (j.status === 'running' || j.status === 'waiting') && now - (j.last_activity_at || 0) <= fresh) ?? null
    const note = claimNote(step, hit, ledger, now)
    if (note) ownershipNote(e.tool_use_id, note)
    if (!why) {
      pendingClaims.set(step, { call, at: now, ev: e })
      claimOf.set(e, step)
    }
    return null
  } catch {
    return null
  }
}

export async function jobsClaimScope<T>(e: Obj, run: () => Promise<T>): Promise<T> {
  let out: unknown
  try {
    out = await run()
    return out as T
  } finally {
    try {
      const step = isObj(e) ? claimOf.get(e) : undefined
      if (step !== undefined) {
        claimOf.delete(e)
        if (pendingClaims.get(step)?.ev === e) pendingClaims.delete(step)
        const id = isObj(out) && out.deny === undefined && typeof out.agentId === 'string' && out.agentId ? out.agentId : null
        if (id && (e.background === true || e.run_in_background === true)) {
          if (heldClaims.size >= 500) heldClaims = new Map<string, Held>()
          heldClaims.set(step, { agent: id, call: String(e.tool_use_id ?? ''), at: Date.now(), title: jobText(e.description ?? 'subagent', 120) })
        }
      }
    } catch {}
  }
}

export async function jobsPrompt($: EngineInterface, e: Obj, rt?: Ready): Promise<Obj> {
  try {
    if (!isObj(e) || !(await jobsLive(rt))) return e
    const text = typeof e.text === 'string' ? e.text : ''
    const notices = e.origin?.kind === 'task-notification' || text.includes('<task-notification>') ? noticesOf(text) : []
    if (notices.length) await jobsNotification($, text)
    if (e.agentId) return e
    const jobs = await listJobs($)
    if (notices.length) {
      if (lastSeen !== null) {
        for (const n of notices) {
          const j = jobs.find((x) => (n.id !== null && x.id === n.id) || (n.call !== null && x.call === n.call))
          if (j) lastSeen[j.id] = j.status
        }
      }
      return e
    }
    const r = jobsChangeNote(lastSeen, jobs, await sessionOf($))
    lastSeen = r.snapshot
    return r.note ? { ...e, context: [...(Array.isArray(e.context) ? e.context : []), r.note] } : e
  } catch {
    return e
  }
}

async function readSteps($: EngineInterface): Promise<string | null> {
  return (await readPlan($, [STEPS_FILE], [await projectDir($)]))?.text ?? null
}

export async function jobsCommand($: EngineInterface, rest: string[]): Promise<string> {
  try {
    const words = (rest ?? []).map((w) => String(w).toLowerCase())
    const all = words.length === 1 && words[0] === 'all'
    if (words.length && !all) return 'Usage: jobs [all]'
    const now = Number(await Promise.resolve($.clock.now()).catch(() => Date.now()))
    const jobs = await listJobs($)
    const view = jobsTable(jobs, now, { all })
    const tasks = (await loadTaskState($)).state?.tasks ?? null
    const ready = readyText(readyQueue(await readSteps($), tasks, jobs))
    await jobsMarkRead($, view.shown)
    return ready ? `${view.text}\n\n${ready}` : view.text
  } catch {
    return `The job ledger (${JOBS_FILE}) could not be read.`
  }
}
