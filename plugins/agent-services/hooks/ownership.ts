import type { EngineInterface } from 'claude-code'
import { checkOf, CHECK_MAX, globProblem, isWriterType, missingParts, missingText, noToolsOf, ownsOf, type NoTool } from './brief_check'
import { commandsOf } from './cmdguard'
import { BRIEF_LABEL, EDIT_TOOLS, globMatch } from './flow'
import { jobOpen, jobText, listJobs, upsertJob, JOBS_FILE, type Job } from './jobs'
import { oneLine } from './placeholders'
import { relNum, relText } from './reliability'
import { NOTE_PREFIX, SUGGESTION_PREFIX } from './review'
import { signedIn, spellPath } from './subagents'
import { projectDir } from './task_state_io'
import { toolInput } from './tools'

type Obj = Record<string, any>
type Ready = Promise<{ svc: { authState(): Promise<string> } } | null> | undefined

export const LIVE_STATUSES: readonly string[] = ['pending', 'running', 'waiting', 'idle']

const num = (k: string): number | undefined => relNum(`ownership.${k}`)
const txt = (k: string, vars: Record<string, string | number> = {}): string | undefined => relText(`ownership.text.${k}`, vars)
type Cfg = { refuse: boolean; quietMs: number; mergeMin: number; overlap: number; notesKept: number; tries: number; toldMax: number; ancestry: number }
function cfg(): Cfg | null {
  const v = ['OWNERSHIP_ON', 'BRIEF_REFUSE', 'OWNER_QUIET_MS', 'MERGE_MIN_WRITERS', 'OVERLAP_BUDGET', 'NOTES_KEPT', 'LEDGER_TRIES', 'TOLD_MAX', 'ANCESTRY_MAX'].map(num)
  if (v.some((x) => x === undefined) || !v[0]) return null
  const [, refuse, quietMs, mergeMin, overlap, notesKept, tries, toldMax, ancestry] = v as number[]
  return { refuse: refuse !== 0, quietMs: quietMs!, mergeMin: mergeMin!, overlap: overlap!, notesKept: notesKept!, tries: tries!, toldMax: toldMax!, ancestry: ancestry! }
}

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isWin = (p: string): boolean => /^[a-z]:(\/|$)/i.test(p)


export function claimGlob(glob: unknown, root: string): string | null {
  if (typeof glob !== 'string') return null
  let g = glob.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '')
  if (/^([a-zA-Z]:)?\//.test(g) || /^\/(mnt\/)?[a-zA-Z]\//.test(g)) {
    const r = spellPath(root)
    const spelled = spellPath(g)
    const win = isWin(r)
    const base = `${r.replace(/\/+$/, '')}/`
    if (!(win ? spelled.toLowerCase().startsWith(base.toLowerCase()) : spelled.startsWith(base))) return null
    g = spelled.slice(base.length)
  }
  return globProblem(g) === null ? g : null
}

const exact = (s: string): string =>
  s.replace(/[^\0-@[-\u00bf]/g, (c) => (c !== c.toLowerCase() && c.charCodeAt(0) < 0x1900 ? String.fromCharCode(0xe000 + c.charCodeAt(0)) : c))

export function claimMatches(glob: string, rel: string, caseless: boolean): boolean {
  return caseless ? globMatch(glob, rel) : globMatch(exact(glob), exact(rel))
}

export function projectPath(file: string, cwd: string | null, root: string): string | null {
  if (!file || !root) return null
  const r = spellPath(root).replace(/\/+$/, '')
  const abs = spellPath(file, cwd || root)
  const base = `${r}/`
  if (!abs.startsWith(base)) return null
  const rel = abs.slice(base.length)
  if (!rel || /(^|\/)\.[^/]+\/worktrees\/[^/]+\//i.test(rel)) return null
  return rel
}

export type Claim = { job: Job; glob: string }

export function claimsOn(rel: string, jobs: readonly Job[], root: string): Claim[] {
  const caseless = isWin(spellPath(root))
  const out: Claim[] = []
  for (const job of jobs) {
    if (!isObj(job) || !jobOpen(job) || !Array.isArray(job.owns)) continue
    for (const raw of job.owns) {
      const glob = claimGlob(raw, root)
      if (glob !== null && claimMatches(glob, rel, caseless)) {
        out.push({ job, glob })
        break
      }
    }
  }
  return out
}

export type WriteInput = {
  file: string
  cwd: string | null
  root: string
  writer: string | null
  known: boolean
  related: (a: string, b: string) => boolean
  session: string
  now: number
  jobs: readonly Job[]
  agents: Record<string, string> | null
  held?: ReadonlySet<string> | null
}

export type Decision =
  | { kind: 'allow' }
  | { kind: 'refuse'; owner: string; reason: string }
  | { kind: 'tell'; owner: string; key: string; note: string }

const ALLOW: Decision = { kind: 'allow' }
const titleOf = (j: Job): string => oneLine(String(j.title || '(no title)'), 120)

export function refuseReason(file: string, c: Claim): string | null {
  return txt('refuse', { file: oneLine(file, 300), job: c.job.id, title: titleOf(c.job), glob: oneLine(c.glob, 200) }) ?? null
}

export type ClaimSeen = 'live' | 'quiet' | 'ledger'

export function tellNote(rel: string, c: Claim, seen: ClaimSeen | boolean): string | null {
  const how: ClaimSeen = seen === true ? 'quiet' : seen === false ? 'live' : seen
  const who = txt(how === 'live' ? 'tell_who_live' : 'tell_who')
  const tail = how === 'quiet' ? txt('tell_quiet') : how === 'ledger' ? txt('tell_ledger', { file: JOBS_FILE }) : ''
  if (who === undefined || tail === undefined) return null
  const text = txt('tell', { rel: oneLine(rel, 300), who, job: c.job.id, title: titleOf(c.job), glob: oneLine(c.glob, 200), how: tail })
  return text === undefined ? null : `${NOTE_PREFIX}: ${text}`
}

export function ownerLive(job: Job, w: Pick<WriteInput, 'agents'>): boolean {
  const status = w.agents?.[job.id]
  return typeof status === 'string' && LIVE_STATUSES.includes(status)
}

export function decideWrite(w: WriteInput): Decision {
  const quietMs = num('OWNER_QUIET_MS')
  if (quietMs === undefined || !w || typeof w.file !== 'string' || !w.root || !Array.isArray(w.jobs)) return ALLOW
  const rel = projectPath(w.file, w.cwd, w.root)
  if (rel === null) return ALLOW
  const claims = claimsOn(rel, w.jobs, w.root)
  if (!claims.length) return ALLOW
  const writer = typeof w.writer === 'string' && w.writer ? w.writer : null
  if (writer !== null && claims.some((c) => c.job.id === writer)) return ALLOW
  const others = claims.filter((c) => writer === null || !w.related(writer, c.job.id))
  if (!others.length) return ALLOW
  const held = (c: Claim) => !w.held || w.held.has(c.job.id)
  const seen = (c: Claim): ClaimSeen => {
    if (ownerLive(c.job, w)) return 'live'
    const recent = w.now - Number(c.job.last_activity_at) < quietMs
    const other = typeof c.job.session === 'string' && c.job.session !== '' && c.job.session !== w.session
    return recent && (!held(c) || other) ? 'ledger' : 'quiet'
  }
  if (writer === null) {
    const c = others[0]!
    const note = tellNote(rel, c, seen(c))
    return note === null ? ALLOW : { kind: 'tell', owner: c.job.id, key: `${c.job.id}\n${rel}`, note }
  }
  if (!w.known) return ALLOW
  const live = others.find((c) => held(c) && ownerLive(c.job, w))
  const reason = live ? refuseReason(w.file, live) : null
  if (live && reason !== null) return { kind: 'refuse', owner: live.job.id, reason }
  if (live) return ALLOW
  const c = others[0]!
  const how = seen(c)
  const note = tellNote(rel, c, how === 'live' ? 'ledger' : how)
  return note === null ? ALLOW : { kind: 'tell', owner: c.job.id, key: `${writer}\n${c.job.id}\n${rel}`, note }
}

function tokens(glob: string, caseless: boolean): string[] {
  const g = glob.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  const out: string[] = []
  for (let i = 0; i < g.length; i++) {
    if (g[i] === '*' && g[i + 1] === '*') {
      i++
      if (g[i + 1] === '/') {
        i++
        out.push('dirs')
      } else out.push('any')
    } else out.push(g[i] === '*' ? 'star' : g[i] === '?' ? 'one' : `=${caseless ? g[i]!.toLowerCase() : g[i]}`)
  }
  return out
}

function stepGlob(toks: string[], s: number, sym: string): number[] {
  const out: number[] = []
  const k = s >= 0 ? s : -s - 1
  const t = toks[k]
  if (s < 0 || t === 'dirs') {
    out.push(-k - 1)
    if (sym === '/') out.push(k + 1)
  } else if (t === 'any') out.push(k)
  else if (t === 'star') {
    if (sym !== '/') out.push(k)
  } else if (t === 'one') {
    if (sym !== '/') out.push(k + 1)
  } else if (t !== undefined && t.slice(1) === sym) out.push(k + 1)
  return out
}

function closeGlob(toks: string[], states: number[]): number[] {
  const out = [...new Set(states)]
  for (let i = 0; i < out.length; i++) {
    const s = out[i]!
    const t = s >= 0 ? toks[s] : undefined
    if ((t === 'dirs' || t === 'any' || t === 'star') && !out.includes(s + 1)) out.push(s + 1)
  }
  return out
}

export function globsOverlap(a: string, b: string, caseless = true, steps: number = num('OVERLAP_BUDGET') ?? 0): boolean {
  const ta = tokens(a, caseless)
  const tb = tokens(b, caseless)
  const lits = new Set<string>(['/', '\u0000'])
  for (const t of [...ta, ...tb]) if (t.startsWith('=')) lits.add(t.slice(1))
  const syms = [...lits]
  const seen = new Set<string>()
  let queue: [number, number][] = []
  for (const p of closeGlob(ta, [0])) for (const q of closeGlob(tb, [0])) queue.push([p, q])
  let budget = steps
  while (queue.length) {
    const next: [number, number][] = []
    for (const [p, q] of queue) {
      const key = `${p},${q}`
      if (seen.has(key)) continue
      seen.add(key)
      if (p === ta.length && q === tb.length) return true
      for (const sym of syms) {
        if (--budget <= 0) return true
        const ps = closeGlob(ta, stepGlob(ta, p, sym))
        if (!ps.length) continue
        const qs = closeGlob(tb, stepGlob(tb, q, sym))
        for (const p2 of ps) for (const q2 of qs) if (!seen.has(`${p2},${q2}`)) next.push([p2, q2])
      }
    }
    queue = next
  }
  return false
}

export function overlapsWith(id: string, globs: readonly string[], jobs: readonly Job[], root: string,
  related: (a: string, b: string) => boolean = () => false): { job: Job; mine: string; theirs: string }[] {
  const caseless = isWin(spellPath(root))
  const out: { job: Job; mine: string; theirs: string }[] = []
  for (const job of jobs) {
    if (!isObj(job) || job.id === id || !jobOpen(job) || !Array.isArray(job.owns) || related(id, job.id)) continue
    let hit: { job: Job; mine: string; theirs: string } | null = null
    for (const mine of globs) {
      for (const raw of job.owns) {
        const theirs = claimGlob(raw, root)
        if (theirs !== null && globsOverlap(mine, theirs, caseless)) {
          hit = { job, mine, theirs }
          break
        }
      }
      if (hit) break
    }
    if (hit) out.push(hit)
  }
  return out
}

export function overlapNote(id: string, hits: readonly { job: Job; mine: string; theirs: string }[]): string | null {
  if (!hits.length) return null
  const list = hits.slice(0, 5).map((h) => `${h.job.id} ("${titleOf(h.job)}": "${oneLine(h.mine, 120)}" overlaps "${oneLine(h.theirs, 120)}")`)
  const text = txt('overlap', { id, s: hits.length > 1 ? 's' : '', list: list.join(', ') })
  return text === undefined ? null : `${NOTE_PREFIX}: ${text}`
}

export function briefBody(prompt: unknown): string {
  const p = typeof prompt === 'string' ? prompt : ''
  const at = p.indexOf(BRIEF_LABEL)
  return at >= 0 ? p.slice(0, at) : p
}

export function contractSpawn(e: Obj): boolean {
  return isObj(e) && e.background === true && e.fork !== true && e.isTeammate !== true && !e.workflow && !e.resume
}

export type SpawnPlan = {
  contract: boolean
  writer: boolean
  missing: string[]
  owns: string[]
  dropped: { glob: string; why: string }[]
  check: string | null
  noTools: NoTool[]
  refusal: string | null
  note: string | null
}

export function spawnPlan(e: Obj, refuse: boolean = num('BRIEF_REFUSE') === 1): SpawnPlan {
  const contract = contractSpawn(e)
  const body = briefBody(e?.prompt)
  const writer = isWriterType(e?.subagentType)
  const { globs, dropped } = ownsOf(body)
  const check = checkOf(body)
  const missing = contract ? missingParts(`${typeof e?.description === 'string' ? e.description : ''}\n${body}`, writer) : []
  const notes: (string | undefined)[] = []
  const parts = missing.length ? missingText(missing) : ''
  if (parts) notes.push(txt('brief_lacks', { parts }))
  if (contract && dropped.length) notes.push(txt('owns_dropped', { list: dropped.slice(0, 5).map((d) => `"${d.glob}" (${d.why})`).join(', ') }))
  const said = notes.filter((n): n is string => n !== undefined)
  const note = said.length ? `${SUGGESTION_PREFIX}: ${said.join(' ')}` : null
  const refusal = refuse && contract && writer && parts ? txt('contract_refusal', { parts }) ?? null : null
  return { contract, writer, missing, owns: globs, dropped, check, noTools: noToolsOf(body), refusal, note }
}

export function mergeBackNote(jobs: readonly Job[], endedId: string, root = ''): string | null {
  if (!Array.isArray(jobs)) return null
  const writes = (j: Job) => Array.isArray(j.owns) && j.owns.some((g) => (root ? claimGlob(g, root) : typeof g === 'string' && globProblem(g) === null ? g : null) !== null)
  const ended = jobs.find((j) => isObj(j) && j.id === endedId)
  if (!ended || !writes(ended)) return null
  const group = jobs.filter((j) => isObj(j) && writes(j) && (ended.task ? j.task === ended.task : !j.task && j.session === ended.session))
  const batch = group.filter((j) => j.id === endedId || jobOpen(j) || Number(j.last_activity_at) >= Number(ended.started_at))
  const min = num('MERGE_MIN_WRITERS')
  if (min === undefined || batch.some((j) => j.id !== endedId && jobOpen(j)) || batch.length < min) return null
  const checks = [...new Set(batch.map((j) => (typeof j.check === 'string' ? oneLine(j.check, 200) : '')).filter(Boolean))]
  const task = ended.task ? txt('merge_task', { task: oneLine(ended.task, 60) }) : ''
  const text = task === undefined ? undefined : txt('merge_back', {
    id: endedId, title: titleOf(ended), n: batch.length, task, ids: batch.map((j) => j.id).slice(0, 10).join(', '),
    checks: checks.length ? ` (${checks.slice(0, 3).join('; ')})` : '',
  })
  return text === undefined ? null : `${SUGGESTION_PREFIX}: ${text}`
}


let parentOf = new Map<string, string | null>()
let notesByCall = new Map<string, string[]>()
let told = new Set<string>()
let ledgerLock: Promise<unknown> = Promise.resolve()
let claimsHeld = new Map<string, { owns: string[]; title: string; session: string }>()
let noToolsHeld = new Map<string, NoTool[]>()

export function resetOwnershipForTest(): void {
  parentOf = new Map<string, string | null>()
  notesByCall = new Map<string, string[]>()
  told = new Set<string>()
  ledgerLock = Promise.resolve()
  claimsHeld = new Map()
  noToolsHeld = new Map()
}

function noteFor(call: unknown, note: string | null): void {
  if (typeof call !== 'string' || !call || !note) return
  const list = notesByCall.get(call) ?? []
  if (!list.includes(note)) notesByCall.set(call, [...list, note])
  while (notesByCall.size > (num('NOTES_KEPT') ?? 0)) notesByCall.delete(notesByCall.keys().next().value as string)
}

export function ownershipNote(call: unknown, note: string | null): void {
  try {
    noteFor(call, note)
  } catch {}
}

function withHeld(jobs: readonly Job[], session: string): Job[] {
  const out = jobs.map((j) => (claimsHeld.has(j.id) ? { ...j, owns: claimsHeld.get(j.id)!.owns, status: 'running' as const, session: claimsHeld.get(j.id)!.session } : j))
  for (const [id, c] of claimsHeld) {
    if (!out.some((j) => j.id === id)) out.push({ id, kind: 'subagent', title: c.title, status: 'running', started_at: 0, last_activity_at: 0, session: c.session || session, owns: c.owns })
  }
  return out
}

function relatedBy(parents: Map<string, string | null>, max: number): (a: string, b: string) => boolean {
  const up = (x: string): string[] => {
    const out: string[] = []
    let cur: string | null | undefined = parents.get(x)
    for (let i = 0; i < max && cur; i++) {
      if (out.includes(cur)) break
      out.push(cur)
      cur = parents.get(cur)
    }
    return out
  }
  return (a, b) => a === b || up(a).includes(b) || up(b).includes(a)
}

async function agentRows($: EngineInterface): Promise<Obj[] | null> {
  try {
    const list = await Promise.resolve($.agent.list())
    return Array.isArray(list) ? list.filter(isObj) : null
  } catch {
    return null
  }
}

async function sessionId($: EngineInterface): Promise<string> {
  try {
    return String((await $.session.id()) ?? '')
  } catch {
    return ''
  }
}

async function clockNow($: EngineInterface): Promise<number> {
  try {
    const n = Number(await $.clock.now())
    return Number.isFinite(n) ? n : Date.now()
  } catch {
    return Date.now()
  }
}

async function sessionCwd($: EngineInterface): Promise<string | null> {
  try {
    const c = await $.session.cwd()
    return typeof c === 'string' && c ? c : null
  } catch {
    return null
  }
}

async function recordClaims($: EngineInterface, e: Obj, id: string, plan: SpawnPlan, tries: number): Promise<void> {
  const run = async () => {
    const check = plan.check ? jobText(plan.check, CHECK_MAX) : null
    for (let i = 0; i < tries; i++) {
      const before = (await listJobs($)).find((j) => j.id === id)
      const patch: Partial<Job> & { id: string } = { id, ...(plan.owns.length ? { owns: plan.owns } : {}), ...(check ? { check } : {}) }
      if (!before) {
        Object.assign(patch, { kind: 'subagent', status: 'running', title: jobText(e.description ?? '', 120), session: await sessionId($) })
      }
      await upsertJob($, patch)
      const after = (await listJobs($)).find((j) => j.id === id)
      if (after && (!plan.owns.length || JSON.stringify(after.owns) === JSON.stringify(plan.owns)) && (!check || after.check === check)) return
    }
  }
  const done = ledgerLock.then(run, run)
  ledgerLock = done.catch(() => undefined)
  await done
}


export async function ownershipSpawn($: EngineInterface, e: Obj, next: (e: Obj) => Promise<any>, rt?: Ready): Promise<any> {
  let plan: SpawnPlan | null = null
  const k = cfg()
  try {
    if (k && isObj(e) && (await signedIn(rt))) plan = spawnPlan(e, k.refuse)
  } catch {
    plan = null
  }
  if (plan?.refusal) return { deny: plan.refusal }
  const spawned = await next(e)
  if (!plan || !k) return spawned
  try {
    const id = isObj(spawned) && typeof spawned.agentId === 'string' && spawned.agentId ? spawned.agentId : null
    if (id === null) return spawned
    if (!e.resume) parentOf.set(id, typeof e.parentAgentId === 'string' && e.parentAgentId ? e.parentAgentId : null)
    noteFor(e.tool_use_id, plan.note)
    if (plan.noTools.length) {
      if (noToolsHeld.size >= k.toldMax) noToolsHeld = new Map()
      noToolsHeld.set(id, plan.noTools)
    }
    if (!plan.contract || (!plan.owns.length && !plan.check)) return spawned
    if (plan.owns.length) {
      if (claimsHeld.size >= k.toldMax) claimsHeld = new Map()
      claimsHeld.set(id, { owns: [...plan.owns], title: jobText(e.description ?? '', 120), session: await sessionId($) })
    }
    await recordClaims($, e, id, plan, k.tries)
    if (!plan.owns.length) return spawned
    const root = await projectDir($)
    if (root === null) return spawned
    const hits = overlapsWith(id, plan.owns, await listJobs($), root, relatedBy(parentOf, k.ancestry))
    noteFor(e.tool_use_id, overlapNote(id, hits))
  } catch {}
  return spawned
}

export async function ownershipCheck($: EngineInterface, e: Obj, rt?: Ready): Promise<string | null> {
  try {
    const k = cfg()
    if (!k || !isObj(e) || !EDIT_TOOLS.includes(String(e.tool ?? ''))) return null
    const input = toolInput(e)
    const file = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : null
    if (!file || !(await signedIn(rt))) return null
    const session = await sessionId($)
    const ledger = await listJobs($)
    let jobs = withHeld(ledger, session)
    if (!jobs.some((j) => jobOpen(j) && Array.isArray(j.owns) && j.owns.length)) return null
    const root = await projectDir($)
    if (root === null) return null
    const writer = typeof e.agentId === 'string' && e.agentId ? e.agentId : null
    const cwd = await sessionCwd($)
    const rel = projectPath(file, cwd, root)
    if (rel === null || !claimsOn(rel, jobs, root).length) return null
    const parents = new Map(parentOf)
    let known = writer === null || parentOf.has(writer)
    const rows = await agentRows($)
    const agents: Record<string, string> | null = rows === null ? null : Object.create(null)
    for (const a of rows ?? []) {
      if (typeof a.id !== 'string' || !a.id) continue
      if (a.id === writer) known = true
      if (agents && typeof a.status === 'string') agents[a.id] = a.status
      if (!parents.has(a.id) || parents.get(a.id) === null) parents.set(a.id, typeof a.parentId === 'string' && a.parentId ? a.parentId : null)
    }
    if (agents) {
      let dropped = false
      for (const id of [...claimsHeld.keys()]) {
        if (!LIVE_STATUSES.includes(Object.hasOwn(agents, id) ? agents[id]! : '')) dropped = claimsHeld.delete(id) || dropped
      }
      if (dropped) jobs = withHeld(ledger, session)
    }
    const d = decideWrite({
      file, cwd, root, writer, known, related: relatedBy(parents, k.ancestry), session, now: await clockNow($), jobs, agents, held: new Set(claimsHeld.keys()),
    })
    if (d.kind === 'refuse') return d.reason
    if (d.kind === 'tell' && !told.has(d.key)) {
      if (told.size >= k.toldMax) told = new Set<string>()
      told.add(d.key)
      noteFor(e.tool_use_id, d.note)
    }
  } catch {}
  return null
}

export function ownershipContext(e: Obj, ran: Obj): Obj {
  try {
    const call = isObj(e) ? e.tool_use_id : undefined
    if (typeof call !== 'string' || !notesByCall.has(call)) return ran
    const notes = notesByCall.get(call)!
    notesByCall.delete(call)
    if (!isObj(ran) || ran.deny !== undefined) return ran
    return { ...ran, context: [...(Array.isArray(ran.context) ? ran.context : []), ...notes] }
  } catch {
    return ran
  }
}

export async function ownershipEnded($: EngineInterface, endedId: string, rt?: Ready): Promise<string | null> {
  try {
    if (!cfg() || typeof endedId !== 'string' || !endedId || told.has(`ended\n${endedId}`) || !(await signedIn(rt))) return null
    const root = await projectDir($)
    const note = mergeBackNote(await listJobs($), endedId, root ?? '')
    if (note) told.add(`ended\n${endedId}`)
    return note
  } catch {
    return null
  }
}

export async function ownershipPrompt($: EngineInterface, e: Obj, rt?: Ready): Promise<Obj> {
  try {
    if (!cfg() || !isObj(e) || e.origin?.kind !== 'task-notification' || typeof e.text !== 'string') return e
    const id = /<task-id>([^<]{1,200})<\/task-id>/.exec(e.text)?.[1]?.trim()
    const ends = /<status>\s*(completed|failed|killed|stopped|cancelled|error)\s*<\/status>/i.test(e.text)
    if (!id || (!ends && /<status>/i.test(e.text))) return e
    const note = await ownershipEnded($, id, rt)
    return note ? { ...e, context: [...(Array.isArray(e.context) ? e.context : []), note] } : e
  } catch {
    return e
  }
}


export function noToolsMatch(pattern: string, value: string): boolean {
  const rx = pattern.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*')
  return new RegExp(`^${rx}$`, 'i').test(value)
}

export function noToolsArgs(tool: string, input: Obj): string[] {
  if ((tool === 'Bash' || tool === 'PowerShell') && typeof input.command === 'string') {
    return [input.command.trim(), ...commandsOf(input.command)]
  }
  return ['file_path', 'notebook_path', 'path', 'url', 'pattern', 'query', 'command', 'skill', 'subagent_type']
    .map((k) => input[k])
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
}

export function noToolsHit(rules: readonly NoTool[], tool: string, input: Obj): string | null {
  for (const r of rules) {
    if (!noToolsMatch(r.tool, tool)) continue
    if (r.arg === null) return r.tool
    if (noToolsArgs(tool, input).some((v) => noToolsMatch(r.arg!, v))) return `${r.tool}(${r.arg})`
  }
  return null
}

export function noToolsDeny(e: Obj): string | null {
  try {
    if (!isObj(e) || typeof e.agentId !== 'string' || typeof e.tool !== 'string' || !cfg()) return null
    const rules = noToolsHeld.get(e.agentId)
    if (!rules?.length) return null
    const hit = noToolsHit(rules, e.tool, toolInput(e))
    return hit === null ? null : relText('brief_check.text.no_tools', { tool: hit }) ?? null
  } catch {
    return null
  }
}
