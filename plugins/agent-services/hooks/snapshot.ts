import type { EngineInterface } from 'claude-code'
import { isPluginPath } from './agent_files'
import { budgetChanges } from './budget'
import { ownsOf } from './brief_check'
import { jobOpen, listJobs, upsertJob, type Job } from './jobs'
import { briefBody, contractSpawn } from './ownership'
import { PERSON_ORIGINS } from './flow'
import { oneLine } from './placeholders'
import { redact } from './redact'
import { relNum, relText } from './reliability'
import { NOTE_PREFIX } from './review'
import { signedIn } from './subagents'
import { projectDir } from './task_state_io'

type Obj = Record<string, any>
type Ready = Promise<{ svc: { authState(): Promise<string> } } | null> | undefined
type Ran = { exitCode: number; stdout: string; stderr: string; truncated: boolean }
type Repo = { root: string; gitDir: string; head: string | null }
export type Snap = { id: string; ref: string; commit: string; tree: string; label?: string }
export type Taken = { snap: Snap; fresh: boolean } | { skipped: string }

export const SNAP_REF_PREFIX = 'refs/agent-services/snap/'
export const SNAP_TIMEOUT_MS = 60_000
export const SNAP_FILE_MAX = 8 * 1024 * 1024
export const SNAP_UNTRACKED_MAX = 5000
export const SNAP_TOTAL_MAX = 64 * 1024 * 1024
export const SNAP_LIST_MAX = 100
export const SNAP_CLEAN_CHUNK = 100
export const SNAP_PROMPT_WAIT_MS = 1500
export const SNAP_LABEL_MAX = 60
export const SNAP_GIT_BUSY: readonly (readonly [string, string])[] = [
  ['MERGE_HEAD', 'merge'], ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase or am'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'],
]
export const SNAP_GIT_OPTS: readonly string[] = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null']
export const SNAP_ENV: Readonly<Record<string, string>> = {
  GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1',
  GIT_AUTHOR_NAME: 'agent-services', GIT_AUTHOR_EMAIL: 'snapshot@agent-services.invalid',
  GIT_COMMITTER_NAME: 'agent-services', GIT_COMMITTER_EMAIL: 'snapshot@agent-services.invalid',
}

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const slashed = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
const isOid = (v: unknown): v is string => typeof v === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(v)
const safeWord = (v: unknown): string => String(v ?? '').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 80)


export function snapId(ms: number, rand: string): string {
  const t = new Date(Number.isFinite(ms) ? ms : 0).toISOString().replace(/[-:]/g, '').replace('.', '')
  return `${t}-${rand.replace(/[^0-9a-f]/g, '').slice(0, 4).padEnd(4, '0')}`
}

export const isSnapId = (v: unknown): v is string => typeof v === 'string' && /^\d{8}T\d{9}Z-[0-9a-f]{4}$/.test(v)

export function snapTime(id: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(id)
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]} UTC` : id
}

export function snapMs(id: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z/.exec(id)
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]) : 0
}

export function promptLabel(text: unknown): string {
  const flat = oneLine(redact(typeof text === 'string' ? text.slice(0, 2000) : ''), 10_000)
  return flat ? oneLine(flat, SNAP_LABEL_MAX) : ''
}

export function snapSubject(id: string, label?: string): string {
  return label ? `agent-services snapshot ${id} - before prompt: ${oneLine(label, SNAP_LABEL_MAX + 3)}` : `agent-services snapshot ${id}`
}

export function labelOf(subject: string | undefined): string | undefined {
  const m = /^agent-services snapshot \S+ - before prompt: ?(.*)$/.exec(subject ?? '')
  return m ? oneLine(m[1]!, SNAP_LABEL_MAX + 3) : undefined
}

export function parseSnaps(out: string): Snap[] {
  const snaps: Snap[] = []
  for (const line of out.split('\n')) {
    const [ref, commit, tree, subject] = line.split('\u0000')
    if (!ref || !ref.startsWith(SNAP_REF_PREFIX)) continue
    const id = ref.slice(SNAP_REF_PREFIX.length)
    const label = labelOf(subject)
    if (isSnapId(id) && isOid(commit) && isOid(tree)) snaps.push({ id, ref, commit, tree, ...(label !== undefined ? { label } : {}) })
  }
  return snaps.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export function pruneList(snaps: readonly Snap[], keep: string | null, max: number | undefined = relNum('snapshot.SNAP_KEEP')): Snap[] {
  if (max === undefined) return []
  const old = snaps.slice(0, Math.max(0, snaps.length - max))
  return old.filter((s) => s.id !== keep)
}

export type Change = { status: 'A' | 'D' | 'M'; path: string }

export function parseNameStatus(out: string): Change[] {
  const parts = out.split('\u0000')
  const changes: Change[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const s = parts[i]!.trim().charAt(0)
    const path = parts[i + 1]!
    if (!path) continue
    changes.push({ status: s === 'A' ? 'A' : s === 'D' ? 'D' : 'M', path })
  }
  return changes
}

export function parseNumstat(out: string): Record<string, string> {
  const res: Record<string, string> = Object.create(null)
  for (const rec of out.split('\u0000')) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(rec.replace(/^\n/, ''))
    if (m) res[m[3]!] = m[1] === '-' ? 'binary' : `+${m[1]} -${m[2]}`
  }
  return res
}

export type UndoPlan = {
  restore: string[]
  recreate: string[]
  remove: string[]
  conflicts: string[]
  uncaptured: string[]
}

export function undoPlan(changes: readonly Change[], later: readonly string[] | null, onDiskUncaptured: readonly string[] = []): UndoPlan {
  const plan: UndoPlan = { restore: [], recreate: [], remove: [], conflicts: [], uncaptured: [] }
  const lateSet = later === null ? null : new Set(later)
  const unc = new Set(onDiskUncaptured)
  for (const c of changes) {
    if (c.status === 'D' && unc.has(c.path)) {
      plan.uncaptured.push(c.path)
      continue
    }
    if (c.status === 'M') plan.restore.push(c.path)
    else if (c.status === 'D') plan.recreate.push(c.path)
    else plan.remove.push(c.path)
    if (lateSet === null || lateSet.has(c.path)) plan.conflicts.push(c.path)
  }
  return plan
}

export function leftoverLine(jobs: readonly Job[], session: string): string | null {
  const left = jobs.filter((j) => j.kind === 'shell' && jobOpen(j) && (!session || j.session === session))
  if (!left.length) return null
  const list = left.slice(0, 10).map((j) => `${j.id} ("${oneLine(j.title || '(no title)', 60)}"${j.output ? `, output ${oneLine(j.output, 200)}` : ''})`)
  const text = relText('snapshot.text.leftover', { n: left.length, s: left.length === 1 ? '' : 's', list: list.join(', '), more: left.length > 10 ? ', ...' : '' })
  return text === undefined ? null : `${NOTE_PREFIX}: ${text}`
}


async function git($: EngineInterface, root: string, args: string[], o: { index?: string; stdin?: string } = {}): Promise<Ran | null> {
  try {
    const env: Record<string, string> = { ...SNAP_ENV, ...(o.index ? { GIT_INDEX_FILE: o.index } : {}) }
    const r: any = await $.process.run(['git', '-C', root, ...SNAP_GIT_OPTS, ...args], {
      cwd: $.plugin.root, env, timeoutMs: SNAP_TIMEOUT_MS, ...(o.stdin !== undefined ? { stdin: o.stdin } : {}),
    })
    return { exitCode: typeof r?.exitCode === 'number' ? r.exitCode : 1, stdout: String(r?.stdout ?? ''), stderr: String(r?.stderr ?? ''), truncated: r?.isStdoutTruncated === true }
  } catch {
    return null
  }
}

const ok = (r: Ran | null): r is Ran => r !== null && r.exitCode === 0 && !r.truncated

async function repoOf($: EngineInterface): Promise<Repo | null> {
  const dir = await projectDir($)
  if (!dir) return null
  const top = await git($, dir, ['rev-parse', '--show-toplevel', '--absolute-git-dir'])
  if (!ok(top)) return null
  const [root, gitDir] = top.stdout.split(/\r?\n/).map((s) => s.trim())
  if (!root || !gitDir) return null
  const head = await git($, root, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'])
  const sha = head && head.exitCode === 0 ? head.stdout.trim() : null
  return { root: slashed(root), gitDir: slashed(gitDir), head: isOid(sha) ? sha : null }
}

async function sessionTag($: EngineInterface): Promise<string> {
  try {
    return String((await $.session.id()) ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'x'
  } catch {
    return 'x'
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

async function snaps($: EngineInterface, root: string): Promise<Snap[] | null> {
  const r = await git($, root, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(tree)%00%(subject)', SNAP_REF_PREFIX])
  return ok(r) ? parseSnaps(r.stdout) : null
}

async function capture($: EngineInterface, repo: Repo): Promise<{ tree: string; left: string[] } | { skipped: string }> {
  const index = `${repo.gitDir}/agent-services-snap-${await sessionTag($)}.index`
  try {
    const seed = await git($, repo.root, repo.head ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'], { index })
    if (!ok(seed)) return { skipped: 'git could not start the temporary index' }
    const own = await git($, repo.root, ['ls-files', '-z', '--', '.agent'], { index })
    if (!ok(own)) return { skipped: 'git could not list the .agent files' }
    const mine = own.stdout.split('\u0000').filter(isPluginPath)
    if (mine.length && !ok(await git($, repo.root, ['update-index', '--force-remove', '-z', '--stdin'], { index, stdin: `${mine.join('\u0000')}\u0000` }))) {
      return { skipped: 'git could not leave out the plugin files' }
    }
    const others = await git($, repo.root, ['ls-files', '-o', '--exclude-standard', '-z'], { index })
    if (!ok(others)) return { skipped: 'git could not list the untracked files' }
    const paths = others.stdout.split('\u0000').filter((p) => p && !p.endsWith('/') && !isPluginPath(p))
    if (paths.length > SNAP_UNTRACKED_MAX) return { skipped: `more than ${SNAP_UNTRACKED_MAX} untracked files` }
    const keep: string[] = []
    const left: string[] = []
    let total = 0
    for (const p of paths) {
      let size: number | null = null
      try {
        const st: any = await $.fs.stat(`${repo.root}/${p}`)
        size = typeof st?.size === 'number' && Number.isFinite(st.size) ? st.size : null
      } catch {}
      if (size === null || size > SNAP_FILE_MAX) {
        left.push(p)
        continue
      }
      total += size
      if (total > SNAP_TOTAL_MAX) return { skipped: `the untracked files are larger than ${Math.round(SNAP_TOTAL_MAX / 1048576)} MiB` }
      keep.push(p)
    }
    if (!ok(await git($, repo.root, ['add', '-u'], { index }))) return { skipped: 'git could not add the tracked files' }
    if (keep.length && !ok(await git($, repo.root, ['add', '--pathspec-from-file=-', '--pathspec-file-nul'], { index, stdin: `${keep.join('\u0000')}\u0000` }))) {
      return { skipped: 'git could not add the untracked files' }
    }
    const tree = await git($, repo.root, ['write-tree'], { index })
    const sha = tree && ok(tree) ? tree.stdout.trim() : ''
    return isOid(sha) ? { tree: sha, left } : { skipped: 'git could not write the tree' }
  } finally {
    try {
      await $.fs.write(index, '')
    } catch {}
  }
}

type Work = { run: () => Promise<unknown>; waiters: ((v: unknown) => void)[] }
let first: Work[] = []
let turnEnd: Work | null = null
let running = false
let lastChanges = -1
let atSpawn = new Map<string, Promise<Taken | null>>()
let dryRun = new Set<string>()

export function snapResetForTest(): void {
  first = []
  turnEnd = null
  running = false
  lastChanges = -1
  atSpawn = new Map<string, Promise<Taken | null>>()
  dryRun = new Set<string>()
}

async function takeNow($: EngineInterface, reason: string, agent: string | null, late: () => boolean = () => false, label?: string): Promise<Taken> {
  try {
    const repo = await repoOf($)
    if (!repo) return { skipped: 'not in a git repository' }
    const got = await capture($, repo)
    if ('skipped' in got) return got
    const list = (await snaps($, repo.root)) ?? []
    const newest = list[list.length - 1]
    if (newest && newest.tree === got.tree && reason !== 'before-undo') return { snap: newest, fresh: false }
    if (late()) return { skipped: 'finished after its spawn had gone on' }
    const ms = Math.max(await nowOf($), newest ? snapMs(newest.id) + 1 : 0)
    const id = snapId(ms, Array.from(globalThis.crypto.getRandomValues(new Uint8Array(2)), (b) => b.toString(16).padStart(2, '0')).join(''))
    const msg = `${snapSubject(id, label)}\n\nreason: ${safeWord(reason)}\nagent: ${safeWord(agent) || 'main'}\nsession: ${safeWord(await sessionTag($))}`
    const commit = await git($, repo.root, ['commit-tree', got.tree, ...(repo.head ? ['-p', repo.head] : []), '-m', msg])
    const sha = commit && ok(commit) ? commit.stdout.trim() : ''
    if (!isOid(sha)) return { skipped: 'git could not write the snapshot commit' }
    const ref = `${SNAP_REF_PREFIX}${id}`
    if (!ok(await git($, repo.root, ['update-ref', '--stdin'], { stdin: `create ${ref} ${sha}\n` }))) return { skipped: 'git could not store the snapshot ref' }
    const drop = pruneList([...list, { id, ref, commit: sha, tree: got.tree }], id)
    if (drop.length) await git($, repo.root, ['update-ref', '--stdin'], { stdin: drop.map((s) => `delete ${s.ref} ${s.commit}\n`).join('') })
    return { snap: { id, ref, commit: sha, tree: got.tree, ...(label ? { label } : {}) }, fresh: true }
  } catch {
    return { skipped: 'the snapshot failed' }
  }
}

async function pump(): Promise<void> {
  if (running) return
  running = true
  try {
    for (;;) {
      const w = first.shift() ?? turnEnd
      if (!w) break
      if (w === turnEnd) turnEnd = null
      let v: unknown
      try {
        v = await w.run()
      } catch {
        v = undefined
      }
      for (const done of w.waiters) done(v)
    }
  } finally {
    running = false
  }
}

function locked<T>(fn: () => Promise<T>, lane: 'first' | 'turn-end' = 'first'): Promise<T> {
  const p = new Promise<T>((res) => {
    const done = res as (v: unknown) => void
    if (lane === 'turn-end' && turnEnd) {
      turnEnd.run = fn
      turnEnd.waiters.push(done)
    } else if (lane === 'turn-end') {
      turnEnd = { run: fn, waiters: [done] }
    } else {
      first.push({ run: fn, waiters: [done] })
    }
  })
  void pump()
  return p
}

export function snapTake($: EngineInterface, reason: string, agent: string | null, late?: () => boolean, label?: string): Promise<Taken> {
  return locked(() => takeNow($, reason, agent, late, label), reason === 'turn-end' ? 'turn-end' : 'first')
}


export async function snapSpawnStart($: EngineInterface, e: Obj, rt?: Ready): Promise<void> {
  try {
    const wait = relNum('snapshot.SNAP_SPAWN_WAIT_MS')
    if (!relNum('snapshot.SNAP_ON') || wait === undefined || !isObj(e) || !contractSpawn(e) || !ownsOf(briefBody(e.prompt)).globs.length || !(await signedIn(rt))) return
    const p = snapTake($, 'before-writer', typeof e.parentAgentId === 'string' ? e.parentAgentId : null)
    const call = typeof e.tool_use_id === 'string' ? e.tool_use_id : ''
    if (call) {
      atSpawn.set(call, p.then((t) => t, () => null))
      while (atSpawn.size > 100) atSpawn.delete(atSpawn.keys().next().value as string)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const cap = new Promise<null>((res) => {
      timer = setTimeout(() => res(null), wait)
    })
    await Promise.race([p, cap])
    clearTimeout(timer)
  } catch {}
}

async function snapIntoRow($: EngineInterface, id: string, t: Taken | null): Promise<void> {
  try {
    if (!t || !('snap' in t)) return
    const row = (await listJobs($)).find((j) => j.id === id)
    if (row) await upsertJob($, { id, snapshot: t.snap.id } as Partial<Job> & { id: string })
  } catch {}
}

export async function snapSpawned($: EngineInterface, e: Obj, spawned: Obj): Promise<void> {
  try {
    const call = isObj(e) && typeof e.tool_use_id === 'string' ? e.tool_use_id : ''
    const id = isObj(spawned) && typeof spawned.agentId === 'string' ? spawned.agentId : ''
    const p = call ? atSpawn.get(call) : undefined
    if (!p || !id) return
    atSpawn.delete(call)
    const t = await Promise.race([p, Promise.resolve('not-yet' as const)])
    if (t === 'not-yet') void p.then((x) => snapIntoRow($, id, x)).catch(() => undefined)
    else await snapIntoRow($, id, t)
  } catch {}
}

export async function snapTurnEnd($: EngineInterface, e: Obj, rt?: Ready): Promise<void> {
  try {
    if (!relNum('snapshot.SNAP_ON') || !isObj(e)) return
    const n = budgetChanges()
    if (n === lastChanges || n === 0) return
    if (!(await signedIn(rt))) return
    lastChanges = n
    void snapTake($, 'turn-end', typeof e.agentId === 'string' ? e.agentId : null).catch(() => undefined)
  } catch {}
}

export async function snapPromptStart($: EngineInterface, e: Obj, rt?: Ready): Promise<void> {
  try {
    if (!relNum('snapshot.SNAP_ON') || !isObj(e) || e.agentId || !PERSON_ORIGINS.includes(e.origin?.kind)) return
    const atStart = budgetChanges()
    const label = promptLabel(e.text) || '(no text)'
    const work = (async () => {
      if (!(await signedIn(rt))) return
      await snapTake($, 'before-prompt', null, () => budgetChanges() !== atStart, label)
    })().catch(() => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    const cap = new Promise<void>((res) => {
      timer = setTimeout(res, SNAP_PROMPT_WAIT_MS)
    })
    await Promise.race([work, cap])
    clearTimeout(timer)
  } catch {}
}

export async function snapSessionEnd($: EngineInterface, rt?: Ready): Promise<void> {
  try {
    if (!(await signedIn(rt))) return
    let session = ''
    try {
      session = String((await $.session.id()) ?? '')
    } catch {}
    const line = leftoverLine(await listJobs($), session)
    if (line) $.ui.log(line)
  } catch {}
}


async function diffNames($: EngineInterface, root: string, a: string, b: string): Promise<Change[] | null> {
  const r = await git($, root, ['diff-tree', '-r', '-z', '--no-renames', '--name-status', a, b])
  return ok(r) ? parseNameStatus(r.stdout).filter((c) => !isPluginPath(c.path)) : null
}

async function existsOnDisk($: EngineInterface, root: string, path: string): Promise<boolean> {
  try {
    return (await $.fs.exists(`${root}/${path}`)) === true
  } catch {
    return true
  }
}

async function gitBusy($: EngineInterface, gitDir: string): Promise<{ op: string; marker: string } | null> {
  for (const [marker, op] of SNAP_GIT_BUSY) {
    let there = true
    try {
      there = (await $.fs.exists(`${gitDir}/${marker}`)) === true
    } catch {}
    if (there) return { op, marker }
  }
  return null
}

export function restoreCheck(touched: readonly string[], still: readonly Change[] | null): { left: string[]; unchecked: boolean } {
  if (still === null) return { left: [], unchecked: true }
  const t = new Set(touched)
  return { left: [...new Set(still.map((c) => c.path).filter((p) => t.has(p)))], unchecked: false }
}

export function undoCommand($: EngineInterface, args: readonly string[]): Promise<string> {
  return locked(() => undoNow($, args)).catch(() => 'Undo: it failed; nothing more was changed.')
}

async function trackedOf($: EngineInterface, root: string, paths: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>()
  for (let i = 0; i < paths.length; i += SNAP_CLEAN_CHUNK) {
    const r = await git($, root, ['ls-files', '-z', '--', ...paths.slice(i, i + SNAP_CLEAN_CHUNK)])
    if (ok(r)) for (const p of r.stdout.split('\u0000')) if (p) out.add(p)
  }
  return out
}

async function undoNow($: EngineInterface, args: readonly string[]): Promise<string> {
  try {
    const words = args.map((a) => String(a).trim()).filter(Boolean)
    const apply = words.includes('--apply')
    const skip = words.includes('--skip-changed')
    const unknown = words.filter((w) => w.startsWith('-') && w !== '--apply' && w !== '--skip-changed')
    const ids = words.filter((w) => !w.startsWith('-'))
    if (unknown.length || ids.length > 1) return 'Undo: the id must be one snapshot id from the list (call undo without an id for the list).'
    const repo = await repoOf($)
    if (!repo) return 'Undo: this session is not in a git repository, so there are no snapshots.'
    const list = await snaps($, repo.root)
    if (list === null) return 'Undo: git could not list the snapshots.'
    if (!ids.length) {
      if (!list.length) return `Undo: no snapshot in ${repo.root} yet.`
      const jobs = await listJobs($)
      const lines = [...list].reverse().slice(0, 20).map((s) => {
        const job = jobs.find((j) => (j as Obj).snapshot === s.id)
        if (s.label !== undefined) return `  ${s.id}  before prompt ${snapTime(s.id)}: "${s.label}"`
        return `  ${s.id}  ${snapTime(s.id)}${job ? `  before background job ${job.id} ("${oneLine(job.title || '', 60)}")` : ''}`
      })
      return [`Snapshots in ${repo.root} (newest first, ${list.length} kept):`, ...lines,
        'Call undo with an id to see what restoring that snapshot would change; nothing changes without apply true.'].join('\n')
    }
    const id = ids[0]!
    if (!isSnapId(id)) return `Undo: "${oneLine(id, 40)}" is not a snapshot id (call undo without an id for the list).`
    const at = list.findIndex((s) => s.id === id)
    if (at < 0) return `Undo: no snapshot ${id} in ${repo.root} (call undo without an id for the list).`
    const snap = list[at]!
    const next = list[at + 1] ?? null
    const now = await capture($, repo)
    if ('skipped' in now) return `Undo: the working tree could not be read (${now.skipped}); nothing was changed.`
    const changes = await diffNames($, repo.root, snap.tree, now.tree)
    const later = next ? await diffNames($, repo.root, next.tree, now.tree) : null
    if (changes === null || (next && later === null)) return 'Undo: git could not compare the snapshot with the working tree; nothing was changed.'
    const unc: string[] = []
    for (const c of changes) if (c.status === 'D' && (await existsOnDisk($, repo.root, c.path))) unc.push(c.path)
    const plan = undoPlan(changes, later ? later.map((c) => c.path) : null, unc)
    const nums = await git($, repo.root, ['diff-tree', '-r', '-z', '--no-renames', '--numstat', snap.tree, now.tree])
    const counts: Record<string, string> = ok(nums) ? parseNumstat(nums.stdout) : Object.create(null)
    const head = `Snapshot ${id} (taken ${snapTime(id)}) in ${repo.root}`
    const total = plan.restore.length + plan.recreate.length + plan.remove.length
    if (!total && !plan.uncaptured.length) return `${head}: the working tree is the same as the snapshot; nothing to restore.`
    const conflict = new Set(plan.conflicts)
    const tracked = await trackedOf($, repo.root, plan.remove)
    const row = (what: string, p: string) => `  ${what.padEnd(9)} ${p}${counts[p] ? ` (${counts[p]})` : ''}` +
      `${conflict.has(p) ? '  [changed later]' : ''}${what === 'delete' && tracked.has(p) ? '  [git tracks it: left as it is]' : ''}`
    const rows = [
      ...plan.restore.map((p) => row('restore', p)),
      ...plan.recreate.map((p) => row('re-create', p)),
      ...plan.remove.map((p) => row('delete', p)),
    ]
    const laterWhy = next ? `changed after the next snapshot ${next.id} (${snapTime(next.id)})` : 'changed after this snapshot, which is the newest (no later snapshot shows which changes belong to the step being undone)'
    const busy = await gitBusy($, repo.gitDir)
    const busyWhy = busy ? `a git ${busy.op} is in progress in ${repo.root} (${busy.marker} in its git folder)` : ''
    if (!apply) {
      const out = [`${head}: restoring it would change ${total} file${total === 1 ? '' : 's'}:`, ...rows.slice(0, SNAP_LIST_MAX)]
      if (rows.length > SNAP_LIST_MAX) out.push(`  ... and ${rows.length - SNAP_LIST_MAX} more`)
      if (plan.uncaptured.length) out.push(`Left as they are (on disk but in no snapshot: ignored or too large): ${plan.uncaptured.slice(0, 20).join(', ')}`)
      if (plan.conflicts.length) out.push(`[changed later]: ${laterWhy}; apply refuses while there are any, skip_changed true leaves them as they are.`)
      if (busy) out.push(`Apply refuses now: ${busyWhy}. Finish or abort it first (for example git ${busy.op.split(' ')[0]} --continue or --abort).`)
      out.push(`This was a dry run. To restore: call undo with this id and apply true${plan.conflicts.length ? ' (and skip_changed true)' : ''}. The current state is saved as a snapshot first.`)
      return out.join('\n')
    }
    if (busy) {
      return `Not restored: ${busyWhy}. Restoring files in the middle of it could mix the two. Nothing was changed. ` +
        'Finish or abort that operation first, then call undo with this id again (the dry run first).'
    }
    if (plan.conflicts.length && !skip) {
      return `Not restored: ${plan.conflicts.length} file${plan.conflicts.length === 1 ? ' was' : 's were'} ${laterWhy}: ` +
        `${plan.conflicts.slice(0, 20).join(', ')}${plan.conflicts.length > 20 ? ', ...' : ''}. Nothing was changed. Call ` +
        'undo with this id, apply true and skip_changed true to restore the others and leave those as they are.'
    }
    const skipSet = skip ? conflict : new Set<string>()
    const write = [...plan.restore, ...plan.recreate].filter((p) => !skipSet.has(p))
    const remove = plan.remove.filter((p) => !skipSet.has(p) && !tracked.has(p))
    if (!write.length && !remove.length) return `${head}: every file to restore changed later and was left as it is; nothing was changed.`
    const saved = await takeNow($, 'before-undo', null)
    if (!('snap' in saved)) return `Not restored: the current state could not be saved first (${saved.skipped}); nothing was changed.`
    const index = `${repo.gitDir}/agent-services-snap-${await sessionTag($)}.index`
    const failed: string[] = []
    try {
      if (write.length) {
        const seeded = await git($, repo.root, ['read-tree', snap.commit], { index })
        const out = ok(seeded) ? await git($, repo.root, ['checkout-index', '-f', '-z', '--stdin'], { index, stdin: `${write.join('\u0000')}\u0000` }) : null
        if (!ok(out)) failed.push(...write)
      }
    } finally {
      try {
        await $.fs.write(index, '')
      } catch {}
    }
    for (let i = 0; i < remove.length; i += SNAP_CLEAN_CHUNK) {
      const part = remove.slice(i, i + SNAP_CLEAN_CHUNK)
      if (!ok(await git($, repo.root, ['clean', '-f', '-q', '--', ...part]))) failed.push(...part)
    }
    const after = await capture($, repo)
    const still = 'tree' in after ? await diffNames($, repo.root, snap.tree, after.tree) : null
    const touched = new Set([...write, ...remove])
    const { left, unchecked } = restoreCheck([...touched], still)
    const done = touched.size - left.length
    const out = [unchecked
      ? `${head}: wrote ${touched.size} file${touched.size === 1 ? '' : 's'}, but the working tree could not be read again, so the result was not checked (call undo with this id again for a dry run: an empty one means every file came back). The state before this restore is snapshot ${saved.snap.id} (call undo with that id to see how to go back).`
      : `${head}: restored ${done} of ${touched.size} file${touched.size === 1 ? '' : 's'}. The state before this restore is snapshot ${saved.snap.id} (call undo with that id to see how to go back).`]
    if (left.length) out.push(`Not restored (still different from the snapshot after the restore): ${left.slice(0, 20).join(', ')}${left.length > 20 ? ', ...' : ''}`)
    if (unchecked && failed.length) out.push(`git reported an error for: ${failed.slice(0, 20).join(', ')}${failed.length > 20 ? ', ...' : ''}`)
    if (tracked.size) out.push(`Left as they are (git tracks them, so they are never deleted here; remove them with git rm if wanted): ${[...tracked].slice(0, 20).join(', ')}`)
    if (skip && plan.conflicts.length) out.push(`Left as they are (changed later): ${plan.conflicts.slice(0, 20).join(', ')}`)
    if (plan.uncaptured.length) out.push(`Left as they are (in no snapshot): ${plan.uncaptured.slice(0, 20).join(', ')}`)
    if (failed.length && !left.length && !unchecked) out.push('git reported an error on some steps, but the files now match the snapshot.')
    return out.join('\n')
  } catch {
    return 'Undo: it failed; nothing more was changed.'
  }
}


export const UNDO_SPEC = {
  name: 'undo',
  isDeferred: true,
  description: 'List the working-tree snapshots agent-services took in this git repository, or restore one. Use it ' +
    'only when the user asked in this conversation to rewind, undo or restore files; never on your own initiative, ' +
    'and no confirmation question is needed then. No id: the list, newest first. An id: a dry run that lists what ' +
    'restoring it would change; nothing changes. apply true (only after the dry run of that id in this session): ' +
    'restores it. The current state is saved as a snapshot first, files git tracks are never deleted, and files ' +
    'changed after the next snapshot stop the restore unless skip_changed is true, which leaves them as they are. ' +
    'Afterwards tell the user what was restored and the id of the snapshot that holds the state before. Only the main ' +
    'conversation can use it. Answered on this machine: nothing is sent to the service.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', maxLength: 64, description: 'A snapshot id from the list; leave it out for the list' },
      apply: { type: 'boolean', description: 'true restores the snapshot (only after its dry run in this session)' },
      skip_changed: { type: 'boolean', description: 'true leaves files changed after the next snapshot as they are' },
    },
    required: [],
    additionalProperties: false,
  },
}

export async function registerUndo($: EngineInterface): Promise<void> {
  try {
    await $.tool.register({ ...UNDO_SPEC } as any)
  } catch {}
}

export async function undoTool($: EngineInterface, e: Obj): Promise<{ result: string }> {
  try {
    if (!isObj(e) || e.agentId) return { result: 'Only the main conversation can restore a snapshot; nothing was changed.' }
    const id = typeof e.id === 'string' ? e.id.trim() : ''
    const apply = e.apply === true
    if (apply && id && !dryRun.has(id)) {
      return { result: `Not restored: look at what snapshot ${oneLine(id, 40)} would change first (call undo with the id and without apply).` }
    }
    const words = [id, ...(apply && id ? ['--apply'] : []), ...(e.skip_changed === true ? ['--skip-changed'] : [])]
    const result = await undoCommand($, words)
    if (id && !apply && isSnapId(id)) dryRun.add(id)
    return { result }
  } catch {
    return { result: 'Undo: it failed; nothing more was changed.' }
  }
}
