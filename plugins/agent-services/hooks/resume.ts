import type { EngineInterface } from 'claude-code'
import { ensureAgentIgnore } from './agent_files'
import { sha256Hex, utf8 } from './e2e'
import { getJob, jobOpen, listJobs, setJobStatus, upsertJob, type Job } from './jobs'
import { redact } from './redact'
import { relNum, relText } from './reliability'
import { NOTE_PREFIX, SUGGESTION_PREFIX } from './review'
import { loadTaskState, projectDir } from './task_state_io'
import type { TaskState } from './task_state'
import { vaultMask } from './vault'

export const RESUME_LIVE_KEY = 'resume_live'
export const RESUME_GONE_NOTE = 'its session ended'
export const HANDOVER_FILE = '.agent/handover.md'

export type Receipt = { kind: string; ok: boolean | null; at: number }
type Obj = Record<string, any>
type Live = { sessions: Record<string, number>; ended: Record<string, number> }
type Ready = Promise<unknown> | undefined

const N = (k: string): number | undefined => relNum(`resume.${k}`)
const T = (k: string, vars?: Record<string, string | number>): string | undefined => relText(`resume.text.${k}`, vars)

let loadedAt = Date.now()
let pending: Record<string, string> = {}
let children: Record<string, string> = {}
let replays: Record<string, { job: Job; id: string | null }> = {}
let changed: string[] = []
let nextStep: string | null = null
let beatAt = 0
let interrupted: string[] = []

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const oneLine = (s: unknown, n: number): string => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 3)}...` : t
}
const slashed = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
const newest = <X>(a: readonly X[], n: number): X[] => (n > 0 ? a.slice(-n) : [])

function mask(text: string): string {
  try {
    return redact(vaultMask(String(text ?? '')))
  } catch {
    return '(withheld)'
  }
}

async function nowOf($: EngineInterface): Promise<number> {
  try {
    const n = Number(await $.clock.now())
    return Number.isFinite(n) ? n : Date.now()
  } catch {
    return Date.now()
  }
}

async function sessionOf($: EngineInterface): Promise<string> {
  try {
    return String((await $.session.id()) ?? '')
  } catch {
    return ''
  }
}

async function active(rt: Ready): Promise<boolean> {
  if (rt === undefined) return true
  try {
    const r = (await rt) as { svc?: { authState?: () => Promise<string> } } | null
    if (!r) return false
    return typeof r.svc?.authState === 'function' ? (await r.svc.authState()) === 'ok' : true
  } catch {
    return false
  }
}


export function briefHash(project: unknown, description: unknown, prompt: unknown): string {
  const dir = slashed(String(project ?? '')).toLowerCase()
  return sha256Hex(utf8(`${dir}\u0000${String(description ?? '')}\u0000${String(prompt ?? '')}`)).slice(0, 16)
}

export function replayMatch(jobs: readonly Job[], hash: string, now: number, windowMs: number | undefined = N('RESUME_REPLAY_MS')): Job | null {
  if (typeof windowMs !== 'number') return null
  let best: Job | null = null
  for (const j of jobs) {
    if (!hash || j.brief_hash !== hash || (j.status !== 'done_verified' && j.status !== 'done_unverified')) continue
    const at = Number(j.last_activity_at)
    if (!Number.isFinite(at) || now - at > windowMs) continue
    if (!best || at > Number(best.last_activity_at)) best = j
  }
  return best
}

export function replayNote(job: Job, newId: string | null = null): string | null {
  const how = T(job.status === 'done_verified' ? 'replay_verified' : 'replay_unverified')
  const where = job.output ? T('replay_where_path', { path: oneLine(mask(job.output), 200) }) : T('replay_where')
  const stop = newId ? T('replay_stop_id', { id: newId }) : T('replay_stop')
  if (how === undefined || where === undefined || stop === undefined) return null
  const body = T('replay', { id: job.id, title: mask(oneLine(job.title, 120)), how, where, stop })
  return body === undefined ? null : `${SUGGESTION_PREFIX}: ${body}`
}

export function goneJobs(jobs: readonly Job[], c: {
  session: string; now: number; loadedAt: number; live: Live; resumed: boolean; liveAgents: readonly string[]
}): Job[] {
  const goneMs = N('RESUME_GONE_MS')
  return jobs.filter((j) => {
    if (j.status !== 'running') return false
    const ended = c.live.ended[j.session]
    if (j.session && typeof ended === 'number' && ended >= Number(j.started_at)) return true
    if (j.session && j.session === c.session) {
      return c.resumed && Number(j.started_at) < c.loadedAt && !c.liveAgents.includes(j.id)
    }
    if (goneMs === undefined) return false
    const beat = c.live.sessions[j.session]
    const silentSession = typeof beat !== 'number' || c.now - beat >= goneMs
    return silentSession && c.now - Number(j.last_activity_at) >= goneMs
  })
}

function liveOf(v: unknown): Live {
  const map = (m: unknown): Record<string, number> => {
    const out: Record<string, number> = Object.create(null)
    if (isObj(m)) for (const [k, x] of Object.entries(m)) if (typeof x === 'number' && Number.isFinite(x)) out[k] = x
    return out
  }
  return isObj(v) ? { sessions: map(v.sessions), ended: map(v.ended) } : { sessions: {}, ended: {} }
}

function capMap(m: Record<string, number>, max: number): Record<string, number> {
  return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, max))
}

const ago = (now: number, at: number): string => {
  const m = Math.max(0, Math.round((now - at) / 60000))
  return m < 120 ? `${m} min` : `${Math.round(m / 60)} h`
}

export function handoverText(i: {
  at: number; why: string; dir: string; jobs: readonly Job[]; state: TaskState | null; files: readonly string[]
  receipts?: readonly Receipt[]; next: string | null
}): string {
  const filesMax = N('HANDOVER_FILES_MAX') ?? 0
  const rowsMax = N('HANDOVER_ROWS_MAX') ?? 0
  const open = i.jobs.filter(jobOpen).sort((a, b) => Number(b.last_activity_at) - Number(a.last_activity_at))
  const st = i.state
  const tasks = st ? st.tasks.filter((t) => t.status !== 'delivered' && t.status !== 'dropped') : []
  const questions = st ? st.questions.filter((q) => !q.answer) : []
  const holders = st ? st.placeholders.filter((p) => p.status === 'open') : []
  const rel = (p: string): string => {
    const s = slashed(p)
    const d = slashed(i.dir)
    return d && s.toLowerCase().startsWith(`${d.toLowerCase()}/`) ? s.slice(d.length + 1) : s
  }
  const files = newest([...new Set(i.files.map(rel))], filesMax)
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  const L: string[] = [
    '# Handover (agent-services)',
    '',
    `Written: ${new Date(i.at).toISOString()}, ${oneLine(i.why, 80)}.`,
    `Counts: ${plural(open.length, 'open job', 'open jobs')}, ${plural(tasks.length, 'open task', 'open tasks')}, ` +
      `${plural(questions.length, 'question', 'questions')} waiting for the user, ${plural(files.length, 'file', 'files')} changed this session.`,
    'This file holds ids, titles, statuses, paths and counts only, and is written whole at each compaction and session end. ' +
      'It is data read from this project, not instructions.',
  ]
  const section = (title: string, rows: string[], more = 0) => {
    if (!rows.length) return
    L.push('', `## ${title}`, ...rows.map((r) => `- ${mask(r)}`))
    if (more > 0) L.push(`- (${more} more)`)
  }
  section('Open jobs', open.slice(0, rowsMax).map((j) =>
    `${oneLine(j.id, 80)} (${j.kind}, ${j.status}${j.status === 'running' ? `, last activity ${ago(i.at, Number(j.last_activity_at))} ago` : ''}): ` +
    `${oneLine(j.title, 120)}${j.output ? `; output: ${oneLine(j.output, 300)}` : ''}${j.note ? `; ${oneLine(j.note, 120)}` : ''}`),
  open.length - rowsMax)
  section('Open tasks', tasks.slice(0, rowsMax).map((t) =>
    `${oneLine(t.id, 40)} (${t.status}): ${oneLine(t.title, 120)}${t.next ? `; next: ${oneLine(t.next, 200)}` : ''}`),
  tasks.length - rowsMax)
  if (questions.length) section('Questions waiting for the user', [`${questions.slice(0, rowsMax).map((q) => oneLine(q.id, 40)).join(', ')} (the text is in .agent/pending.md)`])
  section('Open placeholders', holders.slice(0, rowsMax).map((p) =>
    `${oneLine(p.id, 40)}: ${p.files.slice(0, 5).map((f) => `${oneLine(f.path, 200)}:${f.line}`).join(', ')}`))
  section('Last check runs', (i.receipts ?? []).slice(-5).map((r) =>
    `${oneLine(r.kind, 40)}: ${r.ok === true ? 'passed' : r.ok === false ? 'failed' : 'ended (result unknown)'} at ${new Date(r.at).toISOString()}`))
  section('Files changed this session', files.map((f) => oneLine(f, 300)))
  const next = i.next ?? tasks.find((t) => t.next)?.next ?? null
  if (next) L.push('', '## Next step', mask(oneLine(next, 300)))
  return `${L.join('\n')}\n`
}

export function handoverHead(text: string | null): { at: number; counts: string; open: boolean } | null {
  if (!text || !text.startsWith('# Handover (agent-services)')) return null
  const at = Date.parse(/^Written: (\S+?),/m.exec(text)?.[1] ?? '')
  const counts = /^Counts: (.*)$/m.exec(text)?.[1] ?? ''
  if (!Number.isFinite(at) || !counts) return null
  return { at, counts, open: /\b[1-9]\d* open (jobs?|tasks?)\b|\b[1-9]\d* questions? waiting/.test(counts) }
}


async function writeBeat($: EngineInterface, session: string, at: number, ended = false): Promise<void> {
  const max = N('RESUME_LIVE_MAX')
  if (!session || max === undefined) return
  try {
    const live = liveOf(await $.store.get(RESUME_LIVE_KEY))
    if (ended) live.ended[session] = at
    else live.sessions[session] = at
    await $.store.set(RESUME_LIVE_KEY, { sessions: capMap(live.sessions, max), ended: capMap(live.ended, max) })
    beatAt = at
  } catch {}
}

async function beat($: EngineInterface, at: number): Promise<void> {
  const every = N('RESUME_BEAT_MS')
  if (every === undefined || at - beatAt < every) return
  beatAt = at
  await writeBeat($, await sessionOf($), at)
}

export async function resumeStart($: EngineInterface, rt?: Ready): Promise<void> {
  try {
    const reload = N('RESUME_RELOAD_MS')
    if (reload === undefined || !(await active(rt))) return
    const now = await nowOf($)
    const session = await sessionOf($)
    const live = liveOf(await $.store.get(RESUME_LIVE_KEY))
    const before = live.sessions[session]
    const resumed = typeof before !== 'number' || now - before >= reload
    await writeBeat($, session, now)
    const jobs = await listJobs($)
    if (!jobs.some((j) => j.status === 'running')) return
    let listed: string[] = []
    try {
      const agents = await $.agent.list()
      listed = (Array.isArray(agents) ? agents : []).filter((a: Obj) => /pending|running|waiting/i.test(String(a?.status ?? ''))).map((a: Obj) => String(a?.id ?? ''))
    } catch {}
    for (const j of goneJobs(jobs, { session, now, loadedAt, live, resumed, liveAgents: listed })) {
      await setJobStatus($, j.id, 'stalled', RESUME_GONE_NOTE)
      if (!interrupted.includes(j.id)) interrupted.push(j.id)
    }
  } catch {}
}

export async function resumeSessionEnd($: EngineInterface, rt?: Ready, capMs = 500, receipts?: () => Promise<readonly Receipt[]>): Promise<void> {
  const work = (async () => {
    if (!(await active(rt))) return
    const now = await nowOf($)
    await writeBeat($, await sessionOf($), now, true)
    await writeHandover($, 'at the end of a session', receipts ? await receipts().catch(() => []) : [])
  })().catch(() => undefined)
  let cap: Promise<unknown> = work
  try {
    cap = Promise.resolve($.clock.sleep(capMs)).catch(() => work)
  } catch {}
  await Promise.race([work, cap])
}

export async function resumeSpawnCheck($: EngineInterface, e: Obj, rt?: Ready): Promise<string | null> {
  try {
    if (!isObj(e) || e.fork === true || e.isTeammate === true || !(await active(rt))) return null
    const dir = await projectDir($)
    if (!dir) return null
    const hash = briefHash(dir, e.description, e.prompt)
    const call = typeof e.tool_use_id === 'string' && e.tool_use_id ? e.tool_use_id : null
    if (call) pending[call] = hash
    const hit = replayMatch(await listJobs($), hash, await nowOf($))
    if (!hit) return null
    const note = replayNote(hit)
    if (!note) return null
    if (call) replays[call] = { job: hit, id: null }
    return note
  } catch {
    return null
  }
}

export async function resumeSpawned($: EngineInterface, e: Obj, spawned: Obj): Promise<void> {
  try {
    const call = isObj(e) && typeof e.tool_use_id === 'string' ? e.tool_use_id : ''
    const id = isObj(spawned) && typeof spawned.agentId === 'string' ? spawned.agentId : ''
    const hash = call ? pending[call] : undefined
    if (!id || !hash) return
    delete pending[call]
    children[id] = hash
    if (replays[call]) replays[call] = { ...replays[call]!, id }
    const row = await getJob($, id)
    if (row && row.brief_hash !== hash) await upsertJob($, { id, brief_hash: hash })
  } catch {}
}

export function replayContext(e: Obj, done: Obj): Obj {
  try {
    const call = isObj(e) && typeof e.tool_use_id === 'string' ? e.tool_use_id : ''
    const hit = call ? replays[call] : undefined
    if (!hit) return done
    delete replays[call]
    const note = replayNote(hit.job, hit.id)
    if (!note || !isObj(done) || done.deny !== undefined) return done
    return { ...done, context: [...(Array.isArray(done.context) ? done.context : []), note] }
  } catch {
    return done
  }
}

async function agentEnded($: EngineInterface, id: string, output: string | null): Promise<void> {
  if (!id) return
  const row = await getJob($, id)
  if (!row) return
  const patch: Partial<Job> = {}
  if (children[id] && row.brief_hash !== children[id]) patch.brief_hash = children[id]
  if (output && !row.output) patch.output = output
  if (Object.keys(patch).length) await upsertJob($, { id, ...patch })
}

export async function resumeSubagentStop($: EngineInterface, e: Obj): Promise<void> {
  try {
    if (!isObj(e)) return
    const path = typeof e.agent_transcript_path === 'string' && e.agent_transcript_path ? e.agent_transcript_path : null
    await agentEnded($, typeof e.agent_id === 'string' ? e.agent_id : '', path)
  } catch {}
}

export async function resumeNotification($: EngineInterface, e: Obj): Promise<void> {
  try {
    if (!isObj(e) || e.origin?.kind !== 'task-notification' || typeof e.text !== 'string') return
    const id = /<task-id>([^<]*)<\/task-id>/.exec(e.text)?.[1]?.trim() ?? ''
    const out = /<output-file>([^<]*)<\/output-file>/.exec(e.text)?.[1]?.trim() || null
    await agentEnded($, id, out)
  } catch {}
}

export function resumeToolDone(e: Obj, ran: Obj | null): void {
  try {
    const filesMax = N('HANDOVER_FILES_MAX')
    if (filesMax === undefined || !isObj(e) || !isObj(ran) || ran.deny !== undefined || ran.isError === true) return
    if (!['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(e.tool)) return
    const p = e.file_path ?? e.notebook_path
    if (typeof p !== 'string' || !p) return
    const s = slashed(p)
    changed = newest([...changed.filter((x) => x.toLowerCase() !== s.toLowerCase()), s], filesMax * 2)
  } catch {}
}

export async function resumeTurnEnd($: EngineInterface): Promise<void> {
  try {
    await beat($, await nowOf($))
  } catch {}
}

export function handoverEmpty(jobs: readonly Job[], state: TaskState | null, files: readonly string[], receipts: readonly Receipt[], next: string | null): boolean {
  const open = (t: { status: string }) => t.status !== 'delivered' && t.status !== 'dropped'
  return !jobs.some(jobOpen) && !files.length && !receipts.length && !next &&
    !(state && (state.tasks.some(open) || state.questions.some((q) => !q.answer) || state.placeholders.some((p) => p.status === 'open')))
}

export async function writeHandover($: EngineInterface, why: string, receipts: readonly Receipt[] = []): Promise<boolean> {
  try {
    if (N('HANDOVER_FILES_MAX') === undefined || N('HANDOVER_ROWS_MAX') === undefined) return false
    const dir = await projectDir($)
    if (!dir) return false
    let jobs: Job[] = []
    try {
      jobs = await listJobs($)
    } catch {}
    let state: TaskState | null = null
    try {
      state = (await loadTaskState($)).state
    } catch {}
    const path = `${slashed(dir)}/${HANDOVER_FILE}`
    if (handoverEmpty(jobs, state, changed, receipts, nextStep) && !(await $.fs.exists(path).catch(() => false))) return false
    const text = handoverText({ at: await nowOf($), why, dir, jobs, state, files: changed, receipts, next: nextStep })
    await ensureAgentIgnore($, slashed(dir))
    await $.fs.write(path, text)
    return true
  } catch {
    return false
  }
}

export async function resumeCheckpoint($: EngineInterface, milestone: string, next: string, receipts: readonly Receipt[] = []): Promise<void> {
  try {
    if (next) nextStep = mask(oneLine(next, 300))
    await writeHandover($, `at the checkpoint "${oneLine(milestone, 80)}", before its compaction`, receipts)
  } catch {}
}

export async function resumeCompact($: EngineInterface, e: Obj, rt?: Ready, receipts: readonly Receipt[] = []): Promise<void> {
  try {
    if (!isObj(e) || e.agentId || !(await active(rt))) return
    const trigger = typeof e.trigger === 'string' && /^[a-z_]{1,20}$/.test(e.trigger) ? ` (${e.trigger})` : ''
    await writeHandover($, `before a compaction${trigger}`, receipts)
  } catch {}
}

export async function handoverNote($: EngineInterface, first: boolean): Promise<string | null> {
  try {
    const now = await nowOf($)
    await beat($, now)
    if (!first) return null
    const head0 = T('note_head')
    if (head0 === undefined) return null
    const dir = await projectDir($)
    if (!dir) return null
    const lines: string[] = []
    const jobs = await listJobs($)
    const cut = jobs.filter((j) => j.status === 'stalled' && (interrupted.includes(j.id) || j.note === RESUME_GONE_NOTE))
      .sort((a, b) => Number(b.last_activity_at) - Number(a.last_activity_at)).slice(0, 10)
    const cutHead = T('note_interrupted')
    if (cut.length && cutHead !== undefined) {
      lines.push(cutHead)
      for (const j of cut) lines.push(`- ${mask(`${oneLine(j.id, 80)} (${j.kind}): ${oneLine(j.title, 120)}${j.output ? `; output: ${oneLine(j.output, 300)}` : ''}`)}`)
    }
    const path = `${slashed(dir)}/${HANDOVER_FILE}`
    let text: string | null = null
    try {
      if (await $.fs.exists(path)) text = String(await $.fs.read(path)).slice(0, 64 * 1024)
    } catch {}
    const head = handoverHead(text)
    const noteMs = N('HANDOVER_NOTE_MS')
    const pointer = head && head.open && noteMs !== undefined && now - head.at <= noteMs
      ? T('note_handover', { ago: ago(now, head.at), file: HANDOVER_FILE, counts: mask(head.counts) })
      : undefined
    if (pointer !== undefined) lines.unshift(pointer)
    if (!lines.length) return null
    return [`${NOTE_PREFIX}: ${head0}`, ...lines].join('\n').slice(0, 1500)
  } catch {
    return null
  }
}

export function resumeResetForTest(o: { loadedAt?: number } = {}): void {
  loadedAt = o.loadedAt ?? Date.now()
  pending = {}
  children = {}
  replays = {}
  changed = []
  nextStep = null
  beatAt = 0
  interrupted = []
}
