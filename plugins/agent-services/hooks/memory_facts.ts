import type { EngineInterface } from 'claude-code'
import { ensureAgentIgnore } from './agent_files'
import { sha256Hex, utf8 } from './e2e'
import { globMatch } from './glob'
import { relNum } from './reliability'
import { projectWriteDir } from './task_state_io'

export type FactModule = { id: string; globs: string[]; files: number; hash: string }
export type FactEdge = { a: string; b: string; n: number }
export type FactStamp = { globs: string[]; hash: string; head: string; at: number }
export type FactIntro = { hash: string; since: number; more: boolean }
export type MemoryFacts = {
  v: 1
  head: string
  at: number
  files: number
  modules: FactModule[]
  edges: FactEdge[]
  stamps: Record<string, FactStamp>
  intros: Record<string, FactIntro>
}
type Limits = { split: number; max: number; timeoutMs: number; log: { commits: number; filesMax: number; edgesMax: number; edgeMin: number } | null }
type Ran = { exitCode: number; stdout: string; truncated: boolean }
type Entry = { path: string; blob: string }
type Commit = { sha: string; paths: string[] }
export type GlobTest = { test(path: string): boolean }
export type StampState = 'none' | 'ok' | 'stale'

const slashed = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
const isOid = (v: unknown): v is string => typeof v === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(v)
const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)
const posInt = (v: number | undefined): number | null => (v !== undefined && Number.isFinite(v) && v >= 1 ? Math.floor(v) : null)

let noProcess = false
let chain: Promise<unknown> = Promise.resolve()
const lastHead = new Map<string, string>()
let started = false


export function factLimits(): Limits | null {
  const split = posInt(relNum('memory.FACTS_SPLIT_FILES'))
  const max = posInt(relNum('memory.FACTS_MODULES_MAX'))
  const timeoutMs = posInt(relNum('memory.FACTS_GIT_TIMEOUT_MS'))
  if (split === null || max === null || timeoutMs === null) return null
  const commits = posInt(relNum('memory.FACTS_LOG_COMMITS'))
  const filesMax = posInt(relNum('memory.FACTS_COMMIT_FILES_MAX'))
  const edgesMax = posInt(relNum('memory.FACTS_EDGES_MAX'))
  const edgeMin = posInt(relNum('memory.FACTS_EDGE_MIN'))
  const log = commits !== null && filesMax !== null && edgesMax !== null && edgeMin !== null ? { commits, filesMax, edgesMax, edgeMin } : null
  return { split, max, timeoutMs, log }
}

export function parseLsFiles(out: string): Entry[] {
  const seen = new Set<string>()
  const list: Entry[] = []
  for (const rec of out.split('\0')) {
    const m = /^\d{6} ([0-9a-f]{40}|[0-9a-f]{64}) \d\t(.+)$/s.exec(rec)
    if (!m || seen.has(m[2]!)) continue
    seen.add(m[2]!)
    list.push({ path: m[2]!, blob: m[1]! })
  }
  return list
}

export function parseLog(out: string): Commit[] {
  const list: Commit[] = []
  for (const part of out.split('\u0001').slice(1)) {
    const lines = part.split(/\r?\n/)
    const sha = lines[0]!.trim()
    if (!isOid(sha)) continue
    list.push({ sha, paths: lines.slice(1).map((l) => l.trim()).filter(Boolean) })
  }
  return list
}

export function moduleId(prefix: string): string {
  return prefix.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'root'
}

export function globRegex(glob: string): GlobTest | null {
  const g = slashed(String(glob).trim()).replace(/^\.\//, '')
  if (!g || g.length > 200) return null
  return { test: (path: string) => globMatch(g, slashed(String(path))) }
}

export function candidatesOf(paths: readonly string[], split: number, max: number): { modules: Omit<FactModule, 'hash'>[]; of: Map<string, string> } {
  type Raw = { prefix: string; globs: string[]; files: string[] }
  const raw: Raw[] = []
  const walk = (prefix: string, files: string[], depth: number) => {
    const own: string[] = []
    const sub = new Map<string, string[]>()
    for (const f of files) {
      const i = f.indexOf('/')
      if (i < 0) own.push(f)
      else {
        const k = f.slice(0, i)
        const l = sub.get(k)
        if (l) l.push(f.slice(i + 1)); else sub.set(k, [f.slice(i + 1)])
      }
    }
    const full = (f: string) => (prefix ? `${prefix}/${f}` : f)
    if (prefix && (files.length <= split || depth >= 3)) {
      raw.push({ prefix, globs: [`${prefix}/**`], files: files.map(full) })
      return
    }
    if (own.length) raw.push({ prefix: prefix || 'root', globs: [prefix ? `${prefix}/*` : '*'], files: own.map(full) })
    for (const [k, l] of [...sub.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (!prefix && k === '.agent') continue
      walk(full(k), l, depth + 1)
    }
  }
  const clean = paths.map((p) => slashed(String(p)).replace(/^\.\//, ''))
  walk('', clean.filter((p) => p && p !== '.agent' && !p.startsWith('.agent/') && !p.split('/').includes('..')), 0)
  const kept = raw.sort((a, b) => b.files.length - a.files.length || a.prefix.localeCompare(b.prefix)).slice(0, max)
  const used = new Set<string>()
  const of = new Map<string, string>()
  const modules = kept.sort((a, b) => a.prefix.localeCompare(b.prefix)).map((r) => {
    let id = moduleId(r.prefix)
    for (let n = 2; used.has(id); n++) id = `${moduleId(r.prefix).slice(0, 60)}-${n}`
    used.add(id)
    for (const f of r.files) of.set(f, id)
    return { id, globs: r.globs, files: r.files.length }
  })
  return { modules: modules.sort((a, b) => a.id.localeCompare(b.id)), of }
}

export function hashOf(entries: readonly Entry[], globs: readonly string[]): string {
  const rxs = globs.map(globRegex).filter((r): r is GlobTest => r !== null)
  const lines = entries.filter((e) => rxs.some((r) => r.test(e.path))).map((e) => `${e.path}\0${e.blob}\n`).sort()
  return sha256Hex(utf8(lines.join('')))
}

export function edgesOf(commits: readonly Commit[], moduleOf: (path: string) => string | null, filesMax: number, edgesMax: number, edgeMin: number): FactEdge[] {
  const count = new Map<string, number>()
  for (const c of commits) {
    if (!c.paths.length || c.paths.length > filesMax) continue
    const ids = [...new Set(c.paths.map(moduleOf).filter((x): x is string => !!x))].sort()
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const k = `${ids[i]}\u0000${ids[j]}`
      count.set(k, (count.get(k) ?? 0) + 1)
    }
  }
  return [...count.entries()].filter(([, n]) => n >= edgeMin)
    .map(([k, n]) => ({ a: k.split('\u0000')[0]!, b: k.split('\u0000')[1]!, n }))
    .sort((x, y) => y.n - x.n || x.a.localeCompare(y.a) || x.b.localeCompare(y.b)).slice(0, edgesMax)
}

export function sinceOf(commits: readonly Commit[] | null, stampHead: string, head: string, globs: readonly string[]): { since: number; more: boolean } {
  if (stampHead === head) return { since: 0, more: false }
  if (!commits) return { since: 0, more: true }
  const rxs = globs.map(globRegex).filter((r): r is GlobTest => r !== null)
  let since = 0
  for (const c of commits) {
    if (c.sha === stampHead) return { since, more: false }
    if (c.paths.some((p) => rxs.some((r) => r.test(p)))) since++
  }
  return { since, more: true }
}

export function parseFacts(text: string): MemoryFacts | null {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObj(v) || v.v !== 1 || !isOid(v.head) || !Array.isArray(v.modules) || !Array.isArray(v.edges) || !isObj(v.stamps) || !isObj(v.intros)) return null
  const strs = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : [])
  const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
  const modules = v.modules.filter(isObj).filter((m) => typeof m.id === 'string' && typeof m.hash === 'string')
    .map((m) => ({ id: String(m.id), globs: strs(m.globs), files: num(m.files), hash: String(m.hash) }))
  const edges = v.edges.filter(isObj).filter((e) => typeof e.a === 'string' && typeof e.b === 'string')
    .map((e) => ({ a: String(e.a), b: String(e.b), n: num(e.n) }))
  const stamps: Record<string, FactStamp> = {}
  for (const [id, s] of Object.entries(v.stamps)) {
    if (isObj(s) && typeof s.hash === 'string' && isOid(s.head)) stamps[id] = { globs: strs(s.globs), hash: s.hash, head: s.head, at: num(s.at) }
  }
  const intros: Record<string, FactIntro> = {}
  for (const [id, s] of Object.entries(v.intros)) {
    if (isObj(s) && typeof s.hash === 'string') intros[id] = { hash: s.hash, since: num(s.since), more: s.more === true }
  }
  return { v: 1, head: v.head, at: num(v.at), files: num(v.files), modules, edges, stamps, intros }
}

export function stampState(hasIntro: boolean, stamp: string | null | undefined, treeHash: string | null | undefined): StampState | null {
  if (!hasIntro) return 'none'
  if (typeof treeHash !== 'string' || !treeHash) return null
  return stamp === treeHash ? 'ok' : 'stale'
}

export function introState(facts: MemoryFacts | null, id: string): { state: StampState; since: number; more: boolean } {
  const s = facts?.stamps[id]
  const now = facts?.intros[id]
  const state = stampState(!!s, s?.hash, now?.hash) ?? 'none'
  return state === 'stale' ? { state, since: now!.since, more: now!.more } : { state, since: 0, more: false }
}


async function git($: EngineInterface, dir: string, args: string[], timeoutMs: number): Promise<Ran | null> {
  if (noProcess) return null
  try {
    const opts = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.quotePath=false']
    const env = { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' }
    const r: any = await $.process.run(['git', '-C', dir, ...opts, ...args], { cwd: $.plugin.root, env, timeoutMs })
    return { exitCode: typeof r?.exitCode === 'number' ? r.exitCode : 1, stdout: String(r?.stdout ?? ''), truncated: r?.isStdoutTruncated === true }
  } catch (err) {
    if (!/time|kill|signal/i.test(String((err as { message?: unknown })?.message ?? err))) noProcess = true
    return null
  }
}

const ok = (r: Ran | null): r is Ran => r !== null && r.exitCode === 0 && !r.truncated

async function headOf($: EngineInterface, dir: string, timeoutMs: number): Promise<string | null> {
  const r = await git($, dir, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'], timeoutMs)
  const sha = ok(r) ? r.stdout.trim() : null
  return isOid(sha) ? sha : null
}

async function entriesOf($: EngineInterface, dir: string, timeoutMs: number): Promise<Entry[] | null> {
  const r = await git($, dir, ['ls-files', '-s', '-z'], timeoutMs)
  return ok(r) ? parseLsFiles(r.stdout) : null
}

async function logOf($: EngineInterface, dir: string, commits: number, timeoutMs: number): Promise<Commit[] | null> {
  const r = await git($, dir, ['log', '-n', String(commits), '--no-renames', '--relative', '--name-only', '--format=%x01%H', 'HEAD'], timeoutMs)
  return ok(r) ? parseLog(r.stdout) : null
}

function factsPath(dir: string): string {
  return `${slashed(dir)}/.agent/memory-facts.json`
}

async function readAt($: EngineInterface, dir: string): Promise<MemoryFacts | null> {
  try {
    if ((await $.fs.exists(factsPath(dir))) !== true) return null
    return parseFacts(String(await $.fs.read(factsPath(dir))))
  } catch {
    return null
  }
}

async function writeAt($: EngineInterface, dir: string, facts: MemoryFacts): Promise<boolean> {
  try {
    await $.fs.write(factsPath(dir), `${JSON.stringify(facts)}\n`)
    lastHead.set(dir, facts.head)
    await ensureAgentIgnore($, dir)
    return true
  } catch {
    return false
  }
}

async function compute($: EngineInterface, dir: string, lim: Limits, before: MemoryFacts | null): Promise<MemoryFacts | null> {
  const head = await headOf($, dir, lim.timeoutMs)
  if (!head) return null
  const entries = await entriesOf($, dir, lim.timeoutMs)
  if (!entries) return null
  const { modules, of } = candidatesOf(entries.map((e) => e.path), lim.split, lim.max)
  const withHash = modules.map((m) => ({ ...m, hash: hashOf(entries, m.globs) }))
  const stamps = before?.stamps ?? {}
  const commits = lim.log ? await logOf($, dir, lim.log.commits, lim.timeoutMs) : null
  let edges: FactEdge[] = []
  if (lim.log && commits) {
    const rx = withHash.map((m) => ({ id: m.id, rxs: m.globs.map(globRegex).filter((r): r is GlobTest => r !== null) }))
    const moduleOf = (p: string) => of.get(p) ?? rx.find((m) => m.rxs.some((r) => r.test(p)))?.id ?? null
    edges = edgesOf(commits, moduleOf, lim.log.filesMax, lim.log.edgesMax, lim.log.edgeMin)
  }
  const intros: Record<string, FactIntro> = {}
  for (const [id, s] of Object.entries(stamps)) intros[id] = { hash: hashOf(entries, s.globs), ...sinceOf(commits, s.head, head, s.globs) }
  return { v: 1, head, at: Date.now(), files: entries.length, modules: withHash, edges, stamps, intros }
}

function serial<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  const run = chain.then(fn, fn).catch(() => fallback)
  chain = run
  return run
}

async function refresh($: EngineInterface, onlyIfMoved: boolean): Promise<MemoryFacts | null> {
  const lim = factLimits()
  if (!lim || noProcess) return null
  const dir = await projectWriteDir($)
  if (!dir) return null
  const before = await readAt($, dir)
  if (onlyIfMoved) {
    const head = await headOf($, dir, lim.timeoutMs)
    if (!head || head === (lastHead.get(dir) ?? before?.head)) return null
  }
  const facts = await compute($, dir, lim, before)
  if (!facts) return null
  return (await writeAt($, dir, facts)) ? facts : null
}


export function factsStart($: EngineInterface): Promise<void> {
  started = true
  return serial(async () => void (await refresh($, false)), undefined)
}

export function factsIfHeadMoved($: EngineInterface): Promise<void> {
  if (!started) return Promise.resolve()
  return serial(async () => void (await refresh($, true)), undefined)
}

export function stampIntro($: EngineInterface, id: string, globs?: readonly string[]): Promise<boolean> {
  return serial(async () => {
    const key = String(id ?? '').toLowerCase()
    if (!/^[a-z0-9][a-z0-9_.-]{0,79}$/.test(key) || key.includes('..')) return false
    const lim = factLimits()
    if (!lim || noProcess) return false
    const dir = await projectWriteDir($)
    if (!dir) return false
    let facts = await readAt($, dir)
    const head = await headOf($, dir, lim.timeoutMs)
    if (!head) return false
    if (!facts || facts.head !== head) facts = await compute($, dir, lim, facts)
    if (!facts) return false
    const g = (globs && globs.length ? [...globs] : facts.modules.find((m) => m.id === key)?.globs ?? [])
      .map(String).filter((x) => globRegex(x) !== null).slice(0, 20)
    if (!g.length) return false
    const entries = await entriesOf($, dir, lim.timeoutMs)
    if (!entries) return false
    const hash = hashOf(entries, g)
    const next: MemoryFacts = {
      ...facts,
      stamps: { ...facts.stamps, [key]: { globs: g, hash, head, at: Date.now() } },
      intros: { ...facts.intros, [key]: { hash, since: 0, more: false } },
    }
    return writeAt($, dir, next)
  }, false)
}

export async function readFacts($: EngineInterface): Promise<MemoryFacts | null> {
  try {
    const dir = await projectWriteDir($)
    return dir ? await readAt($, dir) : null
  } catch {
    return null
  }
}

export function resetFactsForTest(): void {
  noProcess = false
  started = false
  chain = Promise.resolve()
  lastHead.clear()
}
