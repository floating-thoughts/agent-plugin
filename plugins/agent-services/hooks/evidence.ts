import type { EngineInterface } from 'claude-code'
import { ensureAgentIgnore } from './agent_files'
import { checkOf } from './brief_check'
import { commandsOf, programBase, programWords, shellLine, splitOutsideQuotes } from './cmdguard'
import { sha256Hex, utf8 } from './e2e'
import { getJob, listJobs, setJobStatus, type Job } from './jobs'
import { relNum, relText } from './reliability'
import { stallProgress } from './stall'
import { signedIn } from './subagents'
import { jobsDir } from './task_state_io'
import { toolInput } from './tools'

type Obj = Record<string, any>
type Ready = Promise<{ svc: { authState(): Promise<string> } } | null> | undefined
export type CheckKind = 'test' | 'lint' | 'typecheck' | 'build' | 'check'
export type Receipt = { at: number; end: number; session: string; agent: string; kind: CheckKind; program: string; ok: boolean | null; hash: string }
export type EditMark = { session: string; agent: string; at: number }
export type Store = { v: 1; receipts: Receipt[]; edits: EditMark[]; acceptance: Record<string, string[]> }
export type Verdict = 'deliverable' | 'rework' | 'no_evidence'
export type VerdictResult = { verdict: Verdict; edited: boolean; last_edit: number | null; run: Receipt | null }
export type Scope = { edits?: { session?: string; agent?: string }; runs?: { session?: string; kinds?: CheckKind[]; hashes?: string[] } }
export type StageHit = { kind: CheckKind; program: string; hash: string; green_ok: boolean; red_ok: boolean }

export const EVIDENCE_FILE = '.agent/evidence.json'
export const CHECK_KINDS: readonly CheckKind[] = ['test', 'lint', 'typecheck', 'build', 'check']

export const CHECK_PROGRAMS: Readonly<Record<string, CheckKind | Readonly<Record<string, CheckKind>>>> = {
  pytest: 'test', 'py.test': 'test', jest: 'test', vitest: 'test', mocha: 'test', ava: 'test', karma: 'test', rspec: 'test',
  phpunit: 'test', ctest: 'test', tox: 'test', nox: 'test', unittest: 'test', nose2: 'test',
  playwright: { test: 'test' }, cypress: { run: 'test' },
  eslint: 'lint', flake8: 'lint', pylint: 'lint', rubocop: 'lint', shellcheck: 'lint', stylelint: 'lint',
  ruff: { check: 'lint' }, biome: { check: 'lint', lint: 'lint', ci: 'lint' }, 'golangci-lint': { run: 'lint' },
  tsc: 'typecheck', 'vue-tsc': 'typecheck', mypy: 'typecheck', pyright: 'typecheck', compileall: 'build',
  cargo: { test: 'test', nextest: 'test', build: 'build', clippy: 'lint', check: 'typecheck' },
  go: { test: 'test', build: 'build', vet: 'lint' },
  dotnet: { test: 'test', build: 'build' },
  swift: { test: 'test', build: 'build' },
  deno: { test: 'test', lint: 'lint', check: 'typecheck' },
  mvn: { test: 'test', verify: 'test', package: 'build', compile: 'build' },
  mvnw: { test: 'test', verify: 'test', package: 'build', compile: 'build' },
  gradle: { test: 'test', check: 'test', build: 'build' },
  gradlew: { test: 'test', check: 'test', build: 'build' },
  make: { test: 'test', check: 'test', lint: 'lint', build: 'build' },
}
export const SCRIPT_RUNNERS: readonly string[] = ['npm', 'pnpm', 'yarn', 'bun']
export const SCRIPT_KINDS: readonly (readonly [RegExp, CheckKind])[] = [
  [/^(?:p?tests?|unit|e2e|spec|run[-_]?tests?|test[-_:].*)$/i, 'test'],
  [/^lint(?:[-_:].*)?$/i, 'lint'],
  [/^(?:typecheck|type-check|types|tsc|check[-_:]?types)(?:[-_:].*)?$/i, 'typecheck'],
  [/^build(?:[-_:].*)?$/i, 'build'],
]
export const TEXT_RED: readonly RegExp[] = [
  /\b[1-9]\d* (?:failed|errors?)\b/, /^FAILED\b/m, /\btest result: FAILED\b/, /^FAIL\b/m, /\berror TS\d+\b/,
  /^npm ERR!/m, /\bBUILD FAILED\b/, /^error(?:\[E\d+\])?:/m, /\b[1-9]\d* problems?\b/,
]
export const TEXT_GREEN: readonly RegExp[] = [
  /\b\d+ passed\b/, /\btest result: ok\b/, /^ok\s+\S+/m, /\bSuccess: no issues found\b/, /\bAll checks passed!/,
  /\bBUILD SUCCESS(?:FUL)?\b/, /\b\d+ passing\b/, /^Ran \d+ tests? in [\d.]+s\s*\n\s*OK\b/m,
]
export const EDIT_IGNORE_RX = /(?:^|\/)\.agent\/|(?:^|\/)(?:agent-state|progress|notes|decisions|needs_you)\.md$/i
export const GATE_LINES: Readonly<Record<Verdict, string>> = {
  deliverable: 'gate: green',
  rework: 'gate: red',
  no_evidence: 'gate: no test run since last edit',
}

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const EDITS: readonly string[] = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
const empty = (): Store => ({ v: 1, receipts: [], edits: [], acceptance: {} })
const txt = (k: string, vars: Record<string, string | number> = {}): string | undefined => relText(`evidence.text.${k}`, vars)
type Caps = { receipts: number; edits: number; jobs: number; globs: number }
function caps(): Caps | null {
  const v = ['RECEIPTS_MAX', 'EDIT_MARKS_MAX', 'ACCEPTANCE_JOBS_MAX', 'ACCEPTANCE_GLOBS_MAX'].map((k) => relNum(`evidence.${k}`))
  if (v.some((x) => x === undefined)) return null
  const [receipts, edits, jobs, globs] = v as number[]
  return { receipts: receipts!, edits: edits!, jobs: jobs!, globs: globs! }
}

let lastTick = 0
function tick(): number {
  lastTick = Math.max(Date.now(), lastTick + 1)
  return lastTick
}

type Seen = { check: string | null; acceptance: string[] }
let briefs = new Map<string, Seen>()
let seenStore: Store = empty()


export function stageHash(stage: string): string {
  return sha256Hex(utf8(programWords(stage).join(' '))).slice(0, 16)
}

function firstWord(words: string[], from = 1): { word: string; at: number } | null {
  for (let i = from; i < words.length; i++) if (!words[i]!.startsWith('-')) return { word: words[i]!, at: i }
  return null
}

function scriptKind(name: string): CheckKind | null {
  for (const [rx, kind] of SCRIPT_KINDS) if (rx.test(name)) return kind
  return null
}

export function classify(words: string[], depth = 0): { kind: CheckKind; program: string } | null {
  if (!words.length || depth > 4) return null
  const p = programBase(words[0]!)
  const hit = (kind: CheckKind | null | undefined, program = p) => (kind ? { kind, program } : null)
  if (/^(?:py|pypy3?|python(?:\d+(?:\.\d+)?)?)$/.test(p)) {
    for (let i = 1; i < words.length; i++) {
      const w = words[i]!
      if (w === '-m') return i + 1 < words.length ? classify(words.slice(i + 1), depth + 1) : null
      if (w === '-c') return null
      if (w === '-X' || w === '-W') i++
      else if (!w.startsWith('-')) return classify(words.slice(i), depth + 1)
    }
    return null
  }
  if (p === 'node') {
    if (words.some((w) => w === '--test')) return hit('test')
    const s = firstWord(words)
    return s ? classify(words.slice(s.at), depth + 1) : null
  }
  if (/^(?:uv|poetry|pipenv|hatch|pdm|rye)$/.test(p) && firstWord(words)?.word === 'run') {
    const s = firstWord(words, firstWord(words)!.at + 1)
    return s ? classify(words.slice(s.at), depth + 1) : null
  }
  if (p === 'timeout' || p === 'xvfb-run') {
    const s = firstWord(words, p === 'timeout' ? (firstWord(words)?.at ?? words.length) + 1 : 1)
    return s ? classify(words.slice(s.at), depth + 1) : null
  }
  if (SCRIPT_RUNNERS.includes(p)) {
    const sub = firstWord(words)
    if (!sub) return null
    const w = sub.word.toLowerCase()
    if (w === 'test' || w === 't' || w === 'tst') return hit('test')
    if (w === 'exec' || w === 'dlx' || w === 'x') {
      const s = firstWord(words, sub.at + 1)
      return s ? classify(words.slice(s.at), depth + 1) : null
    }
    if (w === 'run' || w === 'run-script') {
      const s = firstWord(words, sub.at + 1)
      return s ? hit(scriptKind(s.word)) : null
    }
    return p === 'npm' ? null : hit(scriptKind(w))
  }
  const entry = Object.hasOwn(CHECK_PROGRAMS, p) ? CHECK_PROGRAMS[p] : undefined
  if (typeof entry === 'string') return hit(entry)
  if (entry) {
    const sub = firstWord(words)
    const k = sub ? sub.word.toLowerCase() : ''
    return hit(Object.hasOwn(entry, k) ? entry[k] : null)
  }
  return /[\\/]|\.(?:sh|py|js|mjs|ps1|bat|cmd)$/i.test(words[0]!) ? hit(scriptKind(p)) : null
}

export function stagesOf(command: string, tool = 'Bash', extra: readonly string[] = [], depth = 0): StageHit[] {
  const out: StageHit[] = []
  if (typeof command !== 'string' || !command.trim() || depth > 2) return out
  const cmds = commandsOf(command)
  const piped = (c: string) => splitOutsideQuotes(c, /\|/).map((s) => s.trim()).filter(Boolean)
  const andOnly = cmds.length > 1 && splitOutsideQuotes(command, /&&/).map((s) => s.trim()).filter(Boolean).length === cmds.length &&
    cmds.every((c) => piped(c).length === 1)
  const shellOk = tool !== 'PowerShell' || cmds.length === 1
  cmds.forEach((c, i) => {
    const stages = piped(c)
    stages.forEach((s, k) => {
      const lastStage = k === stages.length - 1
      const last = i === cmds.length - 1 && lastStage && shellOk
      const green = (last || (andOnly && shellOk)) && stages.length === 1
      const red = last && stages.length === 1
      const words = programWords(s)
      const inner = shellLine(words)
      if (inner !== null) {
        for (const h of stagesOf(inner, 'Bash', extra, depth + 1)) out.push({ ...h, green_ok: h.green_ok && green, red_ok: h.red_ok && red })
        return
      }
      const hash = stageHash(s)
      const r = classify(words)
      if (r) out.push({ kind: r.kind, program: r.program, hash, green_ok: green, red_ok: red })
      else if (extra.includes(hash) && words.length) out.push({ kind: 'check', program: programBase(words[0]!), hash, green_ok: green, red_ok: red })
    })
  })
  return out
}

export function checkHashes(check: unknown): string[] {
  if (typeof check !== 'string' || !check.trim()) return []
  const hits = stagesOf(check).map((h) => h.hash)
  if (hits.length) return [...new Set(hits)]
  const cmds = commandsOf(check)
  const last = cmds.length ? splitOutsideQuotes(cmds[cmds.length - 1]!, /\|/).pop()?.trim() : ''
  return last ? [stageHash(last)] : []
}

export function textVerdict(text: string): 'red' | 'green' | null {
  const t = String(text ?? '').slice(-20000)
  if (TEXT_RED.some((rx) => rx.test(t))) return 'red'
  if (TEXT_GREEN.some((rx) => rx.test(t))) return 'green'
  return null
}

export function outcomeOf(hit: Pick<StageHit, 'green_ok' | 'red_ok'>, exit: number | null, text: string): boolean | null {
  const tv = textVerdict(text)
  if (tv === 'red') return false
  if (exit === 0 && hit.green_ok) return true
  if (exit !== 0 && hit.red_ok) return false
  if (tv === 'green' && exit === 0) return true
  return null
}

function allText(v: unknown, depth = 0): string {
  if (typeof v === 'string') return v
  if (depth > 6 || !v || typeof v !== 'object') return ''
  return (Array.isArray(v) ? v : Object.values(v)).map((x) => allText(x, depth + 1)).filter((t) => t.trim()).join('\n')
}

export function exitOf(done: Obj, text: string): number | null {
  const r = isObj(done.result) ? done.result : null
  for (const k of ['exitCode', 'exit_code', 'returnCode']) if (r && typeof r[k] === 'number' && Number.isInteger(r[k])) return r[k]
  const m = /^\s*Exit code:? (-?\d+)/i.exec(text.slice(0, 400))
  if (m) return Number(m[1])
  return done.isError === true ? null : 0
}


export function parseStore(text: string | null): Store {
  const c = caps()
  if (!text || !c) return empty()
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    return empty()
  }
  if (!isObj(j) || j.v !== 1) return empty()
  const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
  const receipts = (Array.isArray(j.receipts) ? j.receipts : []).filter((r: unknown): r is Receipt =>
    isObj(r) && num(r.at) && num(r.end) && typeof r.session === 'string' && typeof r.agent === 'string' &&
    CHECK_KINDS.includes(r.kind) && typeof r.program === 'string' && (r.ok === true || r.ok === false || r.ok === null) &&
    typeof r.hash === 'string' && /^[0-9a-f]{16}$/.test(r.hash))
  const edits = (Array.isArray(j.edits) ? j.edits : []).filter((m: unknown): m is EditMark =>
    isObj(m) && typeof m.session === 'string' && typeof m.agent === 'string' && num(m.at))
  const acceptance: Record<string, string[]> = Object.create(null)
  if (isObj(j.acceptance)) {
    for (const [k, v] of Object.entries(j.acceptance).slice(-c.jobs)) {
      const globs = Array.isArray(v) ? v.filter((g): g is string => typeof g === 'string' && g.trim() !== '').slice(0, c.globs) : []
      if (globs.length) acceptance[k] = globs
    }
  }
  return { v: 1, receipts: receipts.slice(-c.receipts), edits: edits.slice(-c.edits), acceptance }
}

export function verdictOf(store: Store, scope: Scope = {}): VerdictResult {
  const s = parseStore(JSON.stringify(store ?? null))
  const e = scope.edits ?? {}
  const r = scope.runs ?? {}
  let lastEdit: number | null = null
  for (const m of s.edits) {
    if ((e.session === undefined || m.session === e.session) && (e.agent === undefined || m.agent === e.agent)) lastEdit = Math.max(lastEdit ?? m.at, m.at)
  }
  const runs = s.receipts
    .filter((x) => (r.session === undefined || x.session === r.session) && (r.kinds === undefined || r.kinds.includes(x.kind)) &&
      (r.hashes === undefined || r.hashes.includes(x.hash)))
    .filter((x) => x.ok !== null && (lastEdit === null || x.at > lastEdit))
    .sort((a, b) => a.at - b.at || a.end - b.end)
  const run = runs.length ? runs[runs.length - 1]! : null
  return { verdict: run === null ? 'no_evidence' : run.ok ? 'deliverable' : 'rework', edited: lastEdit !== null, last_edit: lastEdit, run }
}

export function gateLine(v: VerdictResult): string | null {
  if (!v.edited && v.run === null) return null
  return GATE_LINES[v.verdict]
}

const refuseOf = (n: number | undefined): boolean | undefined => (n === undefined ? undefined : n === 1)

export function deliveryText(v: VerdictResult, refuse: boolean | undefined = refuseOf(relNum('evidence.DELIVERY_REFUSE'))): { text: string; refuse: boolean } | null {
  if (refuse === undefined || v.verdict === 'deliverable' || !v.edited) return null
  const program = v.run?.program ?? txt('why_rework_program')
  const why = v.verdict === 'rework' ? (program === undefined ? undefined : txt('why_rework', { program })) : txt('why_none')
  const text = why === undefined ? undefined : txt(refuse ? 'delivery_refuse' : 'delivery_warn', { why })
  return text === undefined ? null : { text, refuse }
}

export function acceptanceOf(prompt: unknown): string[] {
  const c = caps()
  if (typeof prompt !== 'string' || !c) return []
  const out: string[] = []
  for (const m of prompt.slice(0, 200000).matchAll(/^[ \t]*(?:[-*][ \t]*)?acceptance(?:[ \t]+(?:files?|tests?))?[ \t]*:[ \t]*(.+)$/gim)) {
    for (const g of m[1]!.split(/[,\s]+/)) {
      const t = g.replace(/^[`'"]+|[`'".;]+$/g, '').trim()
      if (t && t.length <= 300 && !out.includes(t)) out.push(t)
    }
  }
  return out.slice(0, c.globs)
}


let chain: Promise<unknown> = Promise.resolve()

async function storePath($: EngineInterface, write = false): Promise<string | null> {
  const dir = await jobsDir($)
  if (dir === null) return null
  const root = dir.replace(/[\\/]+$/, '')
  if (write) await ensureAgentIgnore($, root)
  return `${root}/${EVIDENCE_FILE}`
}

async function readAt($: EngineInterface, path: string): Promise<Store> {
  try {
    if (!(await $.fs.exists(path))) return empty()
    const text = String(await $.fs.read(path))
    return text.length > 512 * 1024 ? empty() : parseStore(text)
  } catch {
    return empty()
  }
}

export async function readEvidence($: EngineInterface): Promise<Store> {
  try {
    const p = await storePath($)
    return p === null ? empty() : await readAt($, p)
  } catch {
    return empty()
  }
}

function mutate($: EngineInterface, f: (s: Store) => Store | null): Promise<void> {
  const run = chain.then(async () => {
    const c = caps()
    if (!c) return
    const p = await storePath($, true)
    if (p === null) return
    const next = f(await readAt($, p))
    if (next === null) return
    const kept: Store = { v: 1, receipts: next.receipts.slice(-c.receipts), edits: next.edits.slice(-c.edits), acceptance: next.acceptance }
    await $.fs.write(p, JSON.stringify(kept))
  }).catch(() => undefined)
  chain = run
  return run
}

async function sessionOf($: EngineInterface): Promise<string> {
  try {
    return String((await $.session.id()) ?? '')
  } catch {
    return ''
  }
}


export function jobVerdict(store: Store, job: Pick<Job, 'id' | 'check'>): VerdictResult | null {
  const hashes = checkHashes(job.check)
  if (!hashes.length) return null
  return verdictOf(store, { edits: { agent: job.id }, runs: { hashes } })
}

const seenCheck = (id: string): string | null => briefs.get(id)?.check ?? null

async function settle($: EngineInterface, job: Job): Promise<Verdict | null> {
  const check = seenCheck(job.id)
  if (check === null && typeof job.check === 'string' && job.check.trim()) {
    const ledgerOnly = txt('ledger_only')
    if (ledgerOnly !== undefined && (job.status !== 'done_unverified' || job.note !== ledgerOnly)) await setJobStatus($, job.id, 'done_unverified', ledgerOnly)
    return 'no_evidence'
  }
  const v = jobVerdict(seenStore, { id: job.id, check: check ?? undefined })
  if (v === null) {
    const own = txt('own_word')
    if (own !== undefined && (job.status !== 'done_unverified' || job.note !== own)) await setJobStatus($, job.id, 'done_unverified', own)
    return null
  }
  const status = v.verdict === 'deliverable' ? 'done_verified' : 'done_unverified'
  const note = txt(`settle_${v.verdict}`)
  if (note === undefined) return null
  if (job.status !== status || job.note !== note) await setJobStatus($, job.id, status, note)
  return v.verdict
}

export async function evidenceJobEnd($: EngineInterface, id: unknown, rt?: Ready): Promise<Verdict | null> {
  try {
    if (typeof id !== 'string' || !id) return null
    const job = await getJob($, id)
    if (!job || (job.status !== 'done_unverified' && job.status !== 'done_verified') || !(await signedIn(rt))) return null
    return await settle($, job)
  } catch {
    return null
  }
}

export async function evidenceSpawn($: EngineInterface, agentId: unknown, prompt: unknown, rt?: Ready): Promise<void> {
  try {
    const globs = acceptanceOf(prompt)
    const check = checkOf(prompt)
    const c = caps()
    if (!c || typeof agentId !== 'string' || !agentId || (!globs.length && check === null) || !(await signedIn(rt))) return
    if (briefs.size >= c.jobs * 5) briefs = new Map<string, Seen>()
    briefs.set(agentId, { check, acceptance: globs })
    if (!globs.length) return
    await mutate($, (s) => {
      const acceptance = { ...s.acceptance, [agentId]: globs }
      const keys = Object.keys(acceptance)
      for (const k of keys.slice(0, Math.max(0, keys.length - c.jobs))) delete acceptance[k]
      return { ...s, acceptance }
    })
  } catch {}
}

export async function acceptanceCheck(
  $: EngineInterface, e: Obj, cwd: string | null, match: (file: string, cwd: string | null, globs: readonly string[]) => string | null,
): Promise<string | null> {
  try {
    const agent = typeof e?.agentId === 'string' && e.agentId ? e.agentId : null
    if (!agent || !EDITS.includes(String(e.tool ?? ''))) return null
    const input = toolInput(e)
    const file = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : null
    if (!file) return null
    const globs = briefs.get(agent)?.acceptance ?? []
    if (!globs.length) return null
    const glob = match(file, cwd, globs)
    if (!glob) return null
    return txt('acceptance_lock', { file, glob: glob.slice(0, 200) }) ?? null
  } catch {
    return null
  }
}


async function record($: EngineInterface, e: Obj, done: Obj, at: number): Promise<void> {
  const c = caps()
  if (!c || !isObj(done) || done.deny !== undefined) return
  const tool = String(e.tool ?? '')
  const input = toolInput(e)
  const agent = typeof e.agentId === 'string' ? e.agentId : ''
  const end = tick()
  if (EDITS.includes(tool)) {
    const file = input.file_path ?? input.notebook_path
    if (done.isError === true || typeof file !== 'string' || EDIT_IGNORE_RX.test(file.replace(/\\/g, '/'))) return
    const session = await sessionOf($)
    const mark = (s: Store): Store => ({ ...s, edits: [...s.edits.filter((m) => !(m.session === session && m.agent === agent)), { session, agent, at: end }].slice(-c.edits) })
    seenStore = mark(seenStore)
    await mutate($, mark)
    return
  }
  const command = typeof input.command === 'string' ? input.command : ''
  if (!command.trim() || input.run_in_background === true) return
  const text = allText(done.result)
  if (/\b(?:running in (?:the )?background|moved to (?:the )?background|background task id)\b|interrupted by user/i.test(text)) return
  if (isObj(done.result) && (done.result.interrupted === true || typeof done.result.backgroundTaskId === 'string')) return
  const declared = new Map<string, string[]>()
  for (const [id, b] of briefs) if (b.check) declared.set(id, checkHashes(b.check))
  const extra = [...new Set([...declared.values()].flat())]
  const hits = stagesOf(command, tool, extra)
  if (!hits.length) return
  const exit = exitOf(done, text)
  const session = await sessionOf($)
  const rows: Receipt[] = hits.map((h) => ({ at, end, session, agent, kind: h.kind, program: h.program.slice(0, 40), ok: outcomeOf(h, exit, text), hash: h.hash }))
  seenStore = { ...seenStore, receipts: [...seenStore.receipts, ...rows].slice(-c.receipts) }
  await mutate($, (s) => ({ ...s, receipts: [...s.receipts, ...rows] }))
  if (rows.some((r) => r.ok === true)) stallProgress()
  const ran = new Set(rows.filter((r) => r.ok !== null).map((r) => r.hash))
  const ids = [...declared].filter(([, hs]) => hs.some((h) => ran.has(h))).map(([id]) => id)
  if (!ids.length) return
  const ended = (await listJobs($)).filter((j) => ids.includes(j.id) && (j.status === 'done_unverified' || j.status === 'done_verified'))
  for (const j of ended) await settle($, j)
}

export async function evidenceRun($: EngineInterface, e: Obj, run: () => Promise<any>, rt?: Ready): Promise<any> {
  const tool = String(e?.tool ?? '')
  if (tool !== 'Bash' && tool !== 'PowerShell' && !EDITS.includes(tool)) return run()
  const at = tick()
  const done = await run()
  try {
    if (await signedIn(rt)) await record($, e, done, at)
  } catch {}
  return done
}


export async function sessionVerdict($: EngineInterface): Promise<VerdictResult> {
  const session = await sessionOf($)
  return verdictOf(await readEvidence($), { edits: { session }, runs: { session, kinds: ['test'] } })
}

export async function evidenceBandLine($: EngineInterface): Promise<string | null> {
  try {
    return gateLine(await sessionVerdict($))
  } catch {
    return null
  }
}

export async function deliveryCheck($: EngineInterface): Promise<{ text: string; refuse: boolean } | null> {
  try {
    return deliveryText(await sessionVerdict($))
  } catch {
    return null
  }
}

export async function handoverReceipts($: EngineInterface, rt?: Ready): Promise<{ kind: string; ok: boolean | null; at: number }[]> {
  try {
    if (!(await signedIn(rt))) return []
    const session = await sessionOf($)
    const mine = (await readEvidence($)).receipts.filter((r) => r.session === session)
    return mine.slice(-5).map((r) => ({ kind: r.kind, ok: r.ok, at: Number(r.end) || r.at }))
  } catch {
    return []
  }
}
