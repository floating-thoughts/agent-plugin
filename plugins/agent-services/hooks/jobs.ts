import type { EngineInterface } from 'claude-code'
import { ensureAgentIgnore } from './agent_files'
import { CHECK_MAX } from './brief_check'
import { redact } from './redact'
import { jobsDir } from './task_state_io'
import { vaultMask } from './vault'

export type JobKind = 'subagent' | 'workflow' | 'shell' | 'session'
export type JobStatus = 'running' | 'waiting' | 'stalled' | 'failed' | 'cancelled' | 'done_unverified' | 'done_verified'
export type Job = {
  id: string
  kind: JobKind
  title: string
  status: JobStatus
  started_at: number
  last_activity_at: number
  session: string
  model?: string
  output?: string
  owns?: string[]
  check?: string
  brief_hash?: string
  attempts?: number
  task?: string
  note?: string
  call?: string
  agent?: string | null
  step?: string
  ended_at?: number | null
  updated_at?: number
  unread?: boolean
  snapshot?: string
  asked_at?: number
}

export const JOBS_FILE = '.agent/jobs.json'
export const JOBS_MAX = 200
export const JOB_TITLE_MAX = 120
export const JOB_NOTE_MAX = 200
export const JOBS_FILE_MAX = 512 * 1024
export const JOBS_STALLED_MAX = 50
export const JOBS_VERSION = 1
export const JOB_TOUCH_EVERY_MS = 30_000

type Obj = Record<string, any>
type Ready = Promise<unknown> | undefined
type Ledger = { rev: number; jobs: Job[] }
type Raw = { kind: 'absent' } | { kind: 'error' } | { kind: 'newer' } | { kind: 'bad'; text: string } | { kind: 'ok'; ledger: Ledger; text: string }

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
const KINDS: readonly string[] = ['subagent', 'workflow', 'shell', 'session']
const STATUSES: readonly string[] = ['running', 'waiting', 'stalled', 'failed', 'cancelled', 'done_unverified', 'done_verified']
export const jobIdOk = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(v)
export const jobOpen = (j: Job): boolean => j.status === 'running' || j.status === 'waiting' || j.status === 'stalled'
export const jobHasResult = (j: Job): boolean => j.status === 'done_unverified' || j.status === 'done_verified' || j.status === 'failed'

export function fitLines(head: string, lines: readonly string[], max: number, extra = 0): string {
  const more = (n: number): string => `- and ${n} more`
  const total = lines.length + Math.max(0, extra)
  let out = head.slice(0, max)
  let kept = 0
  for (const l of lines) {
    const reserve = total - kept - 1 > 0 ? more(total).length + 1 : 0
    if (out.length + 1 + l.length + reserve > max) break
    out += `\n${l}`
    kept++
  }
  const tail = total > kept ? `\n${more(total - kept)}` : ''
  if (out.length + tail.length <= max) return out + tail
  if (!tail || kept > 0) return out
  const room = Math.max(0, max - tail.length)
  const cut = /[\uD800-\uDBFF]/.test(head.charAt(room - 1)) ? room - 1 : room
  return head.slice(0, cut) + tail
}

let bandShown: string | null = null
let touchedAt = new Map<string, number>()
let modes = new Map<string, string>()

export function jobText(text: unknown, max: number): string {
  try {
    const s = redact(vaultMask(String(text ?? ''))).replace(/[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim()
    return [...s].slice(0, max).join('')
  } catch {
    return '(withheld)'
  }
}

export function ago(ms: number): string {
  const v = Number.isFinite(ms) && ms > 0 ? ms : 0
  const m = Math.floor(v / 60_000)
  if (m < 1) return '<1m'
  if (m < 60) return `${m}m`
  const h = v / 3_600_000
  if (h < 10) return `${Math.round(h * 10) / 10}h`
  if (h < 48) return `${Math.round(h)}h`
  return `${Math.round(h / 24)}d`
}

export function statusWord(status: string): string {
  if (status === 'waiting') return 'waiting on you'
  if (status === 'done_unverified') return 'done, unchecked'
  if (status === 'done_verified') return 'done, checked'
  return status
}

export function jobStepOf(text: unknown): string | null {
  const m = /\[step:\s*([^\]]+?)\s*\]/i.exec(typeof text === 'string' ? text : '')
  return m ? m[1]!.slice(0, 80) : null
}


async function pathOf($: EngineInterface): Promise<string | null> {
  const dir = await jobsDir($)
  return dir === null ? null : `${dir}/${JOBS_FILE}`
}

function rowOf(r: unknown): Job | null {
  if (!isObj(r) || !jobIdOk(r.id) || typeof r.status !== 'string' || !STATUSES.includes(r.status)) return null
  const started = typeof r.started_at === 'number' && Number.isFinite(r.started_at) ? r.started_at : 0
  const last = typeof r.last_activity_at === 'number' && Number.isFinite(r.last_activity_at) ? r.last_activity_at : started
  const row: Obj = { ...r, kind: typeof r.kind === 'string' && KINDS.includes(r.kind) ? r.kind : 'subagent', title: typeof r.title === 'string' ? jobText(r.title, JOB_TITLE_MAX) : '', started_at: started, last_activity_at: last, session: typeof r.session === 'string' ? r.session : '' }
  for (const [k, max] of [['note', JOB_NOTE_MAX], ['model', 80], ['step', 80], ['check', CHECK_MAX], ['task', 80]] as const) {
    if (k in row) {
      if (typeof row[k] === 'string') row[k] = jobText(row[k], max)
      else delete row[k]
    }
  }
  if ('output' in row) {
    if (typeof row.output === 'string') row.output = [...row.output.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim()].slice(0, 400).join('')
    else delete row.output
  }
  if ('call' in row && !jobIdOk(row.call)) delete row.call
  if ('asked_at' in row && !(typeof row.asked_at === 'number' && Number.isFinite(row.asked_at))) delete row.asked_at
  return row as Job
}

export function parseJobs(text: string): { ledger: Ledger } | { error: 'corrupt' | 'newer' } {
  try {
    const d = JSON.parse(text)
    if (!isObj(d)) return { error: 'corrupt' }
    if (typeof d.v === 'number' && d.v > JOBS_VERSION) return { error: 'newer' }
    if (!Array.isArray(d.jobs)) return { error: 'corrupt' }
    const jobs = d.jobs.map(rowOf).filter((j: Job | null): j is Job => j !== null)
    return { ledger: { rev: typeof d.rev === 'number' && Number.isFinite(d.rev) ? d.rev : 0, jobs } }
  } catch {
    return { error: 'corrupt' }
  }
}

async function readRaw($: EngineInterface, path: string): Promise<Raw> {
  let text: string
  try {
    text = String(await $.fs.read(path))
  } catch {
    let there = false
    try {
      there = (await $.fs.exists(path)) === true
    } catch {}
    return there ? { kind: 'error' } : { kind: 'absent' }
  }
  if (text.length > JOBS_FILE_MAX) return { kind: 'bad', text }
  if (!text.trim()) return { kind: 'absent' }
  const p = parseJobs(text)
  if ('ledger' in p) return { kind: 'ok', ledger: p.ledger, text }
  return p.error === 'newer' ? { kind: 'newer' } : { kind: 'bad', text }
}

export function capJobs(jobs: readonly Job[]): Job[] {
  const quiet = (a: Job, b: Job): number => (b.last_activity_at || 0) - (a.last_activity_at || 0)
  const stalled = jobs.filter((j) => j.status === 'stalled').sort(quiet).slice(0, JOBS_STALLED_MAX)
  const open = [...jobs.filter((j) => jobOpen(j) && j.status !== 'stalled'), ...stalled].sort(quiet).slice(0, JOBS_MAX)
  const closed = jobs.filter((j) => !jobOpen(j)).sort((a, b) => (a.ended_at ?? a.updated_at ?? a.started_at) - (b.ended_at ?? b.updated_at ?? b.started_at))
  return [...closed.slice(Math.max(0, closed.length - Math.max(0, JOBS_MAX - open.length))), ...open].sort((a, b) => a.started_at - b.started_at)
}

const stampOf = (j: Job): number => (typeof j.updated_at === 'number' ? j.updated_at : j.last_activity_at || 0)

export function newerRow(a: Job, b: Job): Job {
  const aDone = !jobOpen(a)
  const bDone = !jobOpen(b)
  let win: Job
  if (aDone !== bDone) {
    const [done, open] = aDone ? [a, b] : [b, a]
    win = (open.attempts ?? 1) > (done.attempts ?? 1) ? open : done
  } else win = stampOf(a) >= stampOf(b) ? a : b
  const lose = win === a ? b : a
  const out: Obj = { ...win, last_activity_at: Math.max(a.last_activity_at || 0, b.last_activity_at || 0) }
  for (const [k, v] of Object.entries(lose)) if (!(k in out)) out[k] = v
  return out as Job
}

export function mergeJobs(mine: readonly Job[], theirs: readonly Job[]): Job[] {
  const out = new Map<string, Job>()
  for (const j of theirs) out.set(j.id, j)
  for (const j of mine) {
    const t = out.get(j.id)
    out.set(j.id, t ? newerRow(j, t) : j)
  }
  return [...out.values()]
}

export function stampJobs(before: readonly Job[], after: readonly Job[], now: number): Job[] {
  const old = new Map(before.map((j) => [j.id, j]))
  return after.map((j) => {
    const o = old.get(j.id)
    if (o && JSON.stringify(o) === JSON.stringify(j)) return j
    const n: Job = { ...j, updated_at: now }
    const was = o ? !jobOpen(o) : false
    if (!jobOpen(n) && (!o || !was)) {
      n.ended_at = typeof n.ended_at === 'number' ? n.ended_at : now
      if (n.unread === undefined || (o && o.unread === n.unread)) n.unread = jobHasResult(n)
    } else if (jobOpen(n) && o && was) {
      n.ended_at = null
      n.unread = false
    }
    if (o && o.status !== n.status && o.note === n.note) n.note = ''
    return n
  })
}

async function setAside($: EngineInterface, path: string, text: string, now: number): Promise<boolean> {
  if (!text) return false
  try {
    await $.fs.write(path.replace(/\.json$/, `.bad-${new Date(now).toISOString().replace(/[-:]/g, '')}.json`), text)
    return true
  } catch {
    return false
  }
}

export function jobsBandLine(jobs: readonly Job[] | null): string | null {
  if (!jobs) return null
  const n = (f: (j: Job) => boolean): number => jobs.filter(f).length
  const parts = [
    [n((j) => j.status === 'running'), 'running'],
    [n((j) => j.status === 'stalled'), 'stalled'],
    [n((j) => j.status === 'failed' && j.unread === true), 'failed'],
  ].filter(([k]) => (k as number) > 0).map(([k, w]) => `${k} ${w}`)
  return parts.length ? `jobs: ${parts.join(', ')}` : null
}

export function jobsBandText(): string | null {
  return bandShown
}

export function jobAskedAt(j: Job): number | null {
  if (!j || j.status !== 'waiting' || j.note !== askNote) return null
  const t = [j.asked_at, j.updated_at, j.last_activity_at].find((v) => typeof v === 'number' && Number.isFinite(v))
  return typeof t === 'number' ? t : null
}

export function jobsPermissionWaits(jobs: readonly Job[] | null | undefined, now: number, ms: number | undefined): Job[] {
  if (!Array.isArray(jobs) || typeof ms !== 'number' || !Number.isFinite(ms) || !Number.isFinite(now)) return []
  return jobs.filter((j) => {
    const t = jobAskedAt(j)
    return t !== null && now - t >= ms
  })
}

function remember($: EngineInterface, jobs: Job[]): void {
  const line = jobsBandLine(jobs)
  if (line === bandShown) return
  bandShown = line
  try {
    $.ui.invalidate('ui.render')
  } catch {
  }
}

export async function listJobs($: EngineInterface): Promise<Job[]> {
  try {
    const p = await pathOf($)
    if (p === null) {
      return []
    }
    const raw = await readRaw($, p)
    const jobs = raw.kind === 'ok' ? raw.ledger.jobs : []
    if (raw.kind === 'ok' || raw.kind === 'absent') remember($, jobs)
    return jobs
  } catch {
    return []
  }
}

export async function getJob($: EngineInterface, id: string): Promise<Job | null> {
  return (await listJobs($)).find(j => j.id === id) ?? null
}

export async function updateJobs($: EngineInterface, mutate: (jobs: Job[], now: number) => Job[] | null): Promise<Job[] | null> {
  try {
    const dir = await jobsDir($)
    if (dir === null) return null
    const path = `${dir}/${JOBS_FILE}`
    const now = Number(await $.clock.now())
    const first = await readRaw($, path)
    if (first.kind === 'error' || first.kind === 'newer') return null
    const base = first.kind === 'ok' ? first.ledger.jobs : []
    let seen = first.kind === 'ok' ? first.ledger.rev : 0
    const out = mutate(base.map((j) => ({ ...j })), now)
    if (!out) {
      if (first.kind !== 'bad') remember($, base)
      return base
    }
    await ensureAgentIgnore($, dir)
    let next = stampJobs(base, out, now)
    if (first.kind === 'bad' && !(await setAside($, path, first.text, now))) return null
    let written: Job[] | null = null
    for (let attempt = 0; attempt < 2; attempt++) {
      const cur = await readRaw($, path)
      if (cur.kind === 'newer') return null
      if (cur.kind === 'error') return written
      if (cur.kind === 'bad' && (first.kind !== 'bad' || cur.text !== first.text) && !(await setAside($, path, cur.text, now))) return written
      if (cur.kind === 'ok' && cur.ledger.rev !== seen) {
        next = mergeJobs(next, cur.ledger.jobs)
        seen = cur.ledger.rev
      }
      const kept = capJobs(next)
      const text = JSON.stringify({ v: JOBS_VERSION, rev: seen + 1, jobs: kept }, null, 1)
      await $.fs.write(path, text)
      written = kept
      seen += 1
      const back = await readRaw($, path)
      if (back.kind !== 'ok' || back.text === text) break
      next = mergeJobs(kept, back.ledger.jobs)
      seen = back.ledger.rev
    }
    if (written) remember($, written)
    return written
  } catch {
    return null
  }
}

function putRow(jobs: Job[], patch: Partial<Job> & { id: string }, now: number): Job[] {
  if (!jobIdOk(patch.id)) return jobs
  const i = jobs.findIndex((j) => j.id === patch.id)
  const base: Job = i >= 0 ? jobs[i]! : { id: patch.id, kind: 'subagent', title: '', status: 'running', started_at: now, last_activity_at: now, session: '' }
  const row: Job = { ...base, ...patch, title: String(patch.title ?? base.title).slice(0, JOB_TITLE_MAX) }
  if (typeof row.note === 'string') row.note = row.note.slice(0, JOB_NOTE_MAX)
  if (i >= 0) jobs[i] = row
  else jobs.push(row)
  return jobs
}

export async function upsertJob($: EngineInterface, patch: Partial<Job> & { id: string }): Promise<Job> {
  let row: Job | null = null
  const written = await updateJobs($, (jobs, now) => {
    putRow(jobs, patch, now)
    row = jobs.find((j) => j.id === patch.id) ?? null
    return jobs
  })
  const saved = written?.find((j) => j.id === patch.id)
  if (saved) return saved
  const now = Number(await Promise.resolve($.clock.now()).catch(() => Date.now()))
  return row ?? putRow([], patch, now)[0]!
}

export async function setJobStatus($: EngineInterface, id: string, status: JobStatus, note?: string): Promise<void> {
  await updateJobs($, (jobs, now) => {
    const j = jobs.find((x) => x.id === id)
    if (!j) return null
    return putRow(jobs, { id, status, ...(note === undefined ? {} : { note }) }, now)
  })
}

export async function touchJob($: EngineInterface, id: string, at?: number): Promise<void> {
  await updateJobs($, (jobs, now) => {
    const j = jobs.find((x) => x.id === id)
    if (!j) return null
    return putRow(jobs, { id, last_activity_at: Math.max(j.last_activity_at || 0, at ?? now) }, now)
  })
}

export async function jobsMarkRead($: EngineInterface, ids: readonly string[]): Promise<void> {
  if (!ids.length) return
  await updateJobs($, (jobs) => {
    let changed = false
    for (const j of jobs) {
      if (ids.includes(j.id) && j.unread === true) {
        j.unread = false
        changed = true
      }
    }
    return changed ? jobs : null
  })
}


export async function jobsLive(rt: Ready): Promise<boolean> {
  if (rt === undefined) return true
  try {
    const r = (await rt) as { svc?: { authState?: () => Promise<string> } } | null
    if (!r) return false
    const auth = r.svc?.authState
    return typeof auth !== 'function' || (await auth.call(r.svc)) === 'ok'
  } catch {
    return false
  }
}

const textOf = (done: Obj): string => {
  const t = typeof done.text === 'string' ? done.text : ''
  const r = done.result
  if (typeof r === 'string') return `${t}\n${r}`
  if (isObj(r) && Array.isArray(r.content)) return `${t}\n${r.content.map((c: Obj) => (typeof c?.text === 'string' ? c.text : '')).join('\n')}`
  return t
}

function programOf(command: unknown): string {
  const first = String(command ?? '').trim().split(/\s+/)[0] ?? ''
  return first.replace(/^["']|["']$/g, '').split(/[\\/]/).pop()!.slice(0, 40)
}

export function jobStartOf(e: Obj, done: Obj): (Partial<Job> & { id: string; kind: JobKind }) | null {
  if (!isObj(e) || !isObj(done) || done.deny !== undefined || done.isError === true) return null
  const tool = String(e.tool ?? '')
  const r: Obj = isObj(done.result) ? done.result : {}
  const text = textOf(done)
  const call = str(e.tool_use_id)
  const agent = str(e.agentId)
  const common = { ...(call ? { call } : {}), agent }
  if (tool === 'Agent' || tool === 'Task') {
    const async = r.isAsync === true || r.status === 'async_launched' || e.run_in_background === true
    const id = str(r.agentId) ?? /\bagentId:\s*([A-Za-z0-9_-]{4,})/.exec(text)?.[1] ?? null
    if (!async || !id) return null
    const output = str(r.outputFile) ?? str(r.output_file) ?? /\boutput_file:\s*(\S+)/.exec(text)?.[1] ?? null
    const model = str(r.resolvedModel) ?? str(e.model)
    const named = jobStepOf(`${e.description ?? ''}\n${e.prompt ?? ''}`)
    const step = named === null ? null : jobText(named, 80)
    return { id, kind: 'subagent', title: jobText(e.description ?? e.subagent_type ?? 'subagent', JOB_TITLE_MAX), ...common, ...(output ? { output } : {}), ...(model ? { model } : {}), ...(step ? { step } : {}) }
  }
  if (tool === 'Workflow') {
    const id = str(r.taskId) ?? str(r.task_id) ?? str(r.backgroundTaskId) ?? str(r.workflowId) ?? str(r.runId) ??
      /<task-id>([^<]+)<\/task-id>/.exec(text)?.[1]?.trim() ?? call
    if (!id) return null
    const output = str(r.outputFile) ?? str(r.output_file) ?? str(r.backgroundOutputPath) ?? null
    return { id, kind: 'workflow', title: jobText(e.description ?? e.name ?? e.title ?? 'workflow', JOB_TITLE_MAX), ...common, ...(output ? { output } : {}) }
  }
  if (tool === 'Bash' || tool === 'PowerShell') {
    const moved = typeof r.timedOutAfterMs === 'number'
    if (e.run_in_background !== true && !moved) return null
    const id = str(r.backgroundTaskId) ?? (e.run_in_background === true ? /Command running in background with ID:\s*([A-Za-z0-9]+)/.exec(text)?.[1] ?? null : null)
    if (!id) return null
    const output = str(r.backgroundOutputPath) ?? /Output is being written to:\s*(.+?\.output)\b/.exec(text)?.[1] ?? null
    const title = jobText(e.description ?? `${programOf(e.command) || tool} command`, JOB_TITLE_MAX)
    return { id, kind: 'shell', title, ...common, ...(output ? { output } : {}), ...(moved ? { note: 'moved to the background when it reached its timeout' } : {}) }
  }
  return null
}

export type JobNotice = { id: string | null; call: string | null; output: string | null; status: string; summary: string }

export function noticesOf(text: unknown): JobNotice[] {
  const out: JobNotice[] = []
  const s = typeof text === 'string' ? text : ''
  for (const m of s.matchAll(/<task-notification>([\s\S]*?)(?:<\/task-notification>|$)/g)) {
    const body = m[1] ?? ''
    const tag = (name: string): string | null => {
      const v = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)?.[1]?.trim()
      return v ? v : null
    }
    const id = tag('task-id')
    const call = tag('tool-use-id')
    if (!id && !call) continue
    out.push({ id, call, output: tag('output-file'), status: (tag('status') ?? '').toLowerCase(), summary: tag('summary') ?? '' })
  }
  return out
}

export function noticeStatus(status: string, summary: string): JobStatus | null {
  if (status === 'completed') {
    const code = /exit code[:\s]+(-?\d+)/i.exec(summary)?.[1]
    return code !== undefined && Number(code) !== 0 ? 'failed' : 'done_unverified'
  }
  if (status === 'failed' || status === 'error') return 'failed'
  if (['killed', 'stopped', 'cancelled', 'canceled'].includes(status)) return 'cancelled'
  return null
}

function noticeKind(n: JobNotice): JobKind {
  if (/^Agent\b/i.test(n.summary) || /^a[0-9a-f]{8,}$/.test(n.id ?? '')) return 'subagent'
  if (/\b(shell|command)\b/i.test(n.summary) || /^b[a-z0-9]{8}$/.test(n.id ?? '')) return 'shell'
  return 'workflow'
}

function listedStatus(status: unknown): JobStatus | 'live' | null {
  const s = String(status ?? '').toLowerCase()
  if (/completed|complete|done/.test(s)) return 'done_unverified'
  if (/failed|error/.test(s)) return 'failed'
  if (/killed|stopped|cancel/.test(s)) return 'cancelled'
  if (/waiting/.test(s)) return 'waiting'
  if (/running|pending/.test(s)) return 'live'
  return null
}

const listWaitingNote = 'the engine lists it as waiting'
const askNote = 'a permission question waits for you'

export function jobsAfterList(jobs: Job[], listed: readonly Obj[], now: number): Job[] | null {
  let changed = false
  for (const a of listed) {
    const id = str(a?.id)
    const j = id ? jobs.find((x) => x.id === id) : undefined
    if (!j) continue
    const s = listedStatus(a.status)
    if (!jobOpen(j) && !(s === 'failed' && j.status === 'done_unverified')) continue
    if (s === null) continue
    if (s === 'live') {
      if (j.status === 'waiting' && (j.note === listWaitingNote || j.note === askNote)) {
        putRow(jobs, { id: j.id, status: 'running', last_activity_at: now }, now)
        changed = true
      }
    } else if (s === 'waiting') {
      if (j.status === 'running') {
        putRow(jobs, { id: j.id, status: 'waiting', note: listWaitingNote }, now)
        changed = true
      }
    } else {
      putRow(jobs, { id: j.id, status: s, note: s === 'done_unverified' ? 'the engine lists it as completed; its result is not checked yet' : `the engine lists it as ${String(a.status ?? '').toLowerCase()}`, last_activity_at: now }, now)
      changed = true
    }
  }
  return changed ? jobs : null
}


async function sessionOf($: EngineInterface): Promise<string> {
  try {
    return String((await $.session.id()) ?? '')
  } catch {
    return ''
  }
}

export async function jobSpawned($: EngineInterface, ev: Obj, spawned: Obj, rt?: Ready): Promise<void> {
  try {
    if (!isObj(ev) || !isObj(spawned)) return
    const id = str(spawned.agentId)
    if (!id || (ev.background !== true && ev.run_in_background !== true)) return
    if (!(await jobsLive(rt))) return
    const session = await sessionOf($)
    const named = jobStepOf(`${ev.description ?? ''}\n${ev.prompt ?? ''}`)
    const step = named === null ? null : jobText(named, 80)
    const model = str(spawned.model) ?? str(ev.model)
    const call = str(ev.tool_use_id)
    const mode = str(ev.permissionMode)
    if (mode) {
      if (modes.size >= 500) modes = new Map<string, string>()
      modes.set(id, mode)
    }
    await updateJobs($, (jobs, now) => {
      const had = jobs.find((j) => j.id === id)
      return putRow(jobs, {
        id, kind: ev.workflow ? 'workflow' : had?.kind ?? 'subagent',
        title: had?.title || jobText(ev.description ?? ev.subagentType ?? 'subagent', JOB_TITLE_MAX),
        ...(had ? {} : { status: 'running' as JobStatus, started_at: now, session, attempts: 1 }),
        last_activity_at: now, agent: str(ev.parentAgentId),
        ...(model ? { model } : {}), ...(call ? { call } : {}), ...(step ? { step } : {}),
      }, now)
    })
  } catch {}
}

export async function jobsToolEnd($: EngineInterface, e: Obj, done: Obj, rt?: Ready): Promise<void> {
  try {
    if (!isObj(e) || !isObj(done)) return
    const tool = String(e.tool ?? '')
    const refused = done.deny !== undefined
    const ok = !refused && done.isError !== true
    const start = refused ? null : jobStartOf(e, done)
    const stopId = tool === 'TaskStop' && ok ? str(e.task_id) ?? str(e.shell_id) ?? str(e.agent_id) : null
    const resumeId = tool === 'SendMessage' && ok ? str(e.to) ?? str(e.agentId_to) ?? str(e.recipient) ?? str(e.agent_id) : null
    const agent = str(e.agentId)
    const at = Date.now()
    const touch = agent !== null && at - (touchedAt.get(agent) ?? 0) >= JOB_TOUCH_EVERY_MS
    if (!start && !stopId && !resumeId && !touch) return
    if (!(await jobsLive(rt))) return
    if (touch) {
      if (touchedAt.size >= 500) touchedAt = new Map<string, number>()
      touchedAt.set(agent!, at)
    }
    const session = start ? await sessionOf($) : ''
    await updateJobs($, (jobs, now) => {
      let changed = false
      if (start) {
        const had = jobs.find((j) => j.id === start.id)
        putRow(jobs, { ...start, ...(had ? { title: had.title || start.title } : { status: 'running' as JobStatus, started_at: now, session, attempts: 1 }), last_activity_at: now }, now)
        changed = true
      }
      const stopped = stopId ? jobs.find((j) => j.id === stopId) : undefined
      if (stopped && jobOpen(stopped)) {
        putRow(jobs, { id: stopped.id, status: 'cancelled', note: 'stopped with TaskStop', last_activity_at: now }, now)
        changed = true
      }
      const resumed = resumeId ? jobs.find((j) => j.id === resumeId) : undefined
      if (resumed && resumed.status !== 'running' && resumed.status !== 'waiting') {
        putRow(jobs, { id: resumed.id, status: 'running', note: 'continued with SendMessage', attempts: (resumed.attempts ?? 1) + 1, last_activity_at: now }, now)
        changed = true
      }
      const own = touch ? jobs.find((j) => j.id === agent) : undefined
      if (own && jobOpen(own)) {
        putRow(jobs, { id: own.id, last_activity_at: now, ...(own.status === 'running' ? {} : { status: 'running' as JobStatus }) }, now)
        changed = true
      }
      return changed ? jobs : null
    })
  } catch {}
}

export async function jobsNotification($: EngineInterface, text: unknown, rt?: Ready): Promise<void> {
  try {
    const notes = noticesOf(text)
    if (!notes.length || !(await jobsLive(rt))) return
    const session = await sessionOf($)
    await updateJobs($, (jobs, now) => {
      let changed = false
      for (const n of notes) {
        const j = jobs.find((x) => (n.id !== null && x.id === n.id) || (n.call !== null && x.call === n.call))
        let status = noticeStatus(n.status, n.summary)
        const note = jobText(n.summary || `the task notification says ${n.status || 'nothing'}`, JOB_NOTE_MAX)
        if (j) {
          if (j.status === 'done_verified' && status === 'done_unverified') status = null
          putRow(jobs, { id: j.id, last_activity_at: now, ...(n.output ? { output: n.output } : {}), ...(status ? { status, note } : {}) }, now)
          changed = true
        } else if (status) {
          changed = true
          const quoted = /"([^"]{1,200})"/.exec(n.summary)?.[1]
          putRow(jobs, {
            id: n.id ?? n.call!, kind: noticeKind(n), title: jobText(quoted ?? n.summary ?? 'background task', JOB_TITLE_MAX), status, note,
            started_at: now, last_activity_at: now, session, ...(n.call ? { call: n.call } : {}), ...(n.output ? { output: n.output } : {}),
          }, now)
        }
      }
      return changed ? jobs : null
    })
  } catch {}
}

export async function jobSubagentStop($: EngineInterface, agentId: unknown, rt?: Ready): Promise<void> {
  try {
    const id = str(agentId)
    if (!id || !(await jobsLive(rt))) return
    await updateJobs($, (jobs, now) => {
      const j = jobs.find((x) => x.id === id)
      if (!j || !jobOpen(j)) return null
      return putRow(jobs, { id, status: 'done_unverified', note: 'the subagent ended its work; its result is not checked yet', last_activity_at: now }, now)
    })
  } catch {}
}

const DIALOG_MODES: readonly string[] = ['default', 'acceptEdits', 'plan']

export function asksPerson(e: Obj, verdict: Obj, mode: string | null | undefined, background?: boolean): boolean {
  if (background === true) return false
  if (!isObj(e) || !isObj(verdict) || verdict.decision !== 'ask' || e.approver !== 'person') return false
  if (typeof verdict.plugin === 'string' && verdict.plugin) return true
  return typeof mode === 'string' && DIALOG_MODES.includes(mode)
}

export async function jobPermission($: EngineInterface, e: Obj, verdict: Obj, rt?: Ready): Promise<void> {
  try {
    const id = isObj(e) ? str(e.agentId) : null
    if (!id || !asksPerson(e, verdict, modes.get(id), true) || !(await jobsLive(rt))) return
    touchedAt.delete(id)
    await updateJobs($, (jobs, now) => {
      const j = jobs.find((x) => x.id === id)
      if (!j || j.status !== 'running') return null
      return putRow(jobs, { id, status: 'waiting', note: askNote, asked_at: now }, now)
    })
  } catch {}
}

export async function jobsFromList($: EngineInterface, listed: unknown, rt?: Ready): Promise<void> {
  try {
    if (!(await jobsLive(rt))) return
    const list = Array.isArray(listed) ? listed.filter(isObj) : []
    await updateJobs($, (jobs, now) => jobsAfterList(jobs, list, now))
  } catch {}
}

export function jobsResetForTest(): void {
  bandShown = null
  touchedAt = new Map<string, number>()
  modes = new Map<string, string>()
}
