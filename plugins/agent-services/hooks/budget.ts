import type { EngineInterface } from 'claude-code'
import { auditRecord, auditRuleOf, type AuditKind } from './audit_log'
import { ownsOf } from './brief_check'
import { commandsOf, programBase, programWords, splitOutsideQuotes } from './cmdguard'
import { EDIT_TOOLS } from './flow'
import { listJobs, type Job } from './jobs'
import { briefBody } from './ownership'
import { oneLine } from './placeholders'
import { redact } from './redact'
import { relNum, relText } from './reliability'
import { briefHash } from './resume'
import { NOTE_PREFIX, SUGGESTION_PREFIX } from './review'
import { signedIn, spellPath } from './subagents'
import { projectDir } from './task_state_io'
import { toolInput } from './tools'
import { vaultMask } from './vault'
import { utf8 } from './e2e'

type Obj = Record<string, any>
type Ready = Promise<{ svc: { authState(): Promise<string> } } | null> | undefined

type Cfg = { refuse: boolean; limits: Limits; depthMax: number; chainMax: number; stateAt: number; agentsMax: number; waitMs: number }
const num = (k: string): number | undefined => relNum(`budget.${k}`)
const txt = (k: string, vars: Record<string, string | number> = {}): string | undefined => relText(`budget.text.${k}`, vars)
function cfg(): Cfg | null {
  const v = ['BUDGET_ON', 'BUDGET_REFUSE', 'BUDGET_FILES', 'BUDGET_EDITS', 'BUDGET_BYTES', 'DISPATCH_DEPTH_MAX', 'DISPATCH_CHAIN_MAX', 'STATE_NOTE_AT', 'BUDGET_AGENTS_MAX', 'DEFER_WAIT_MS'].map(num)
  if (v.some((x) => x === undefined) || !v[0]) return null
  const [, refuse, files, edits, bytes, depthMax, chainMax, stateAt, agentsMax, waitMs] = v as number[]
  return { refuse: refuse !== 0, limits: { files: files!, edits: edits!, bytes: bytes! }, depthMax: depthMax!, chainMax: chainMax!, stateAt: stateAt!, agentsMax: agentsMax!, waitMs: waitMs! }
}
export const READ_ONLY_PROGRAMS: readonly string[] = [
  'basename', 'cat', 'cd', 'cmp', 'date', 'diff', 'dir', 'dirname', 'du', 'df', 'echo', 'false', 'file', 'find', 'findstr',
  'format-list', 'format-table', 'get-childitem', 'get-content', 'get-date', 'get-filehash', 'get-item', 'get-location',
  'get-process', 'grep', 'head', 'hostname', 'jq', 'less', 'ls', 'md5sum', 'measure-object', 'more', 'out-string',
  'printenv', 'pwd', 'readlink', 'realpath', 'resolve-path', 'rg', 'select-object', 'select-string', 'sha256sum', 'sleep',
  'sort', 'sort-object', 'stat', 'tail', 'test', 'test-path', 'tree', 'true', 'type', 'uniq', 'wc', 'where', 'where-object',
  'which', 'whoami', 'write-host', 'write-output',
]
export const READ_ONLY_GIT: readonly string[] = [
  'blame', 'cat-file', 'check-attr', 'check-ignore', 'count-objects', 'describe', 'diff', 'for-each-ref', 'grep', 'help',
  'log', 'ls-files', 'ls-tree', 'merge-base', 'name-rev', 'rev-list', 'rev-parse', 'shortlog', 'show', 'show-ref',
  'status', 'var', 'version',
]

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const bytesOf = (v: unknown): number => (typeof v === 'string' ? utf8(v).length : 0)
const kib = (n: number): string => `${Math.round(n / 1024)} KiB`

function mask(text: string): string {
  try {
    return redact(vaultMask(String(text ?? '')))
  } catch {
    return '(withheld)'
  }
}


export type CallSize = { file: string | null; edits: number; bytes: number }
export type Used = { files: ReadonlySet<string> | readonly string[]; edits: number; bytes: number }
export type Limits = { files: number; edits: number; bytes: number }
export type Over = { what: 'files' | 'edits' | 'bytes'; used: number; limit: number }

export const budgetLimits = (): Limits | null => cfg()?.limits ?? null

export function ownedLimits(base: Limits, owned: number): Limits {
  const per = num('EDITS_PER_OWNED_FILE')
  const ceiling = num('EDITS_CEILING')
  if (per === undefined || ceiling === undefined || !(owned > 0)) return base
  return { ...base, edits: Math.max(base.edits, Math.min(ceiling, per * owned)) }
}

export function callSize(e: Obj, cwd: string | null): CallSize | null {
  if (!isObj(e) || !EDIT_TOOLS.includes(String(e.tool ?? ''))) return null
  const input = toolInput(e)
  const raw = str(input.file_path) ?? str(input.notebook_path)
  const file = raw ? spellPath(raw, cwd ?? '') : null
  if (e.tool === 'Write') return { file, edits: 1, bytes: bytesOf(input.content) }
  if (e.tool === 'NotebookEdit') return { file, edits: 1, bytes: bytesOf(input.new_source) }
  if (e.tool === 'MultiEdit') {
    const list = Array.isArray(input.edits) ? input.edits : []
    return { file, edits: Math.max(1, list.length), bytes: list.reduce((n: number, x: Obj) => n + bytesOf(x?.new_string), 0) }
  }
  return { file, edits: 1, bytes: bytesOf(input.new_string) }
}

export function budgetOver(used: Used, size: CallSize, given: Limits | null = budgetLimits()): Over | null {
  if (!given) return null
  const limits = given
  const files = used.files instanceof Set ? used.files : new Set(used.files as readonly string[])
  const fresh = size.file !== null && !files.has(size.file)
  if (fresh && files.size + 1 > limits.files) return { what: 'files', used: files.size, limit: limits.files }
  if (used.edits > 0 && used.edits + size.edits > limits.edits) return { what: 'edits', used: used.edits, limit: limits.edits }
  if (used.bytes > 0 && used.bytes + size.bytes > limits.bytes) return { what: 'bytes', used: used.bytes, limit: limits.bytes }
  return null
}

const limitText = (l: Limits): string | undefined => txt('limits', { files: l.files, edits: l.edits, bytes: kib(l.bytes) })
const usedText = (what: Over['what'], used: number): string | undefined => txt(`used_${what}`, { n: what === 'bytes' ? kib(used) : used })

export function budgetRefusal(o: Over, l: Limits | null = budgetLimits()): string | null {
  const used = usedText(o.what, o.used)
  const limits = l ? limitText(l) : undefined
  return used === undefined || limits === undefined ? null : txt('refusal', { what: o.what, used, limits }) ?? null
}

export function budgetMainNote(what: Over['what'], n: number, l: Limits | null = budgetLimits()): string | null {
  const used = usedText(what, n)
  const limits = l ? limitText(l) : undefined
  const text = used === undefined || limits === undefined ? undefined : txt('main_note', { used, limits })
  return text === undefined ? null : `${NOTE_PREFIX}: ${text}`
}

export function budgetToldNote(agent: string, title: string | null, o: Over): string | null {
  const text = txt('told_note', { agent, title: title ? ` ("${oneLine(title, 80)}")` : '', limit: o.what === 'bytes' ? kib(o.limit) : `${o.limit} ${o.what}` })
  return text === undefined ? null : `${NOTE_PREFIX}: ${text}`
}

export function shellWrites(command: unknown): boolean {
  const line = String(command ?? '')
  if (!line.trim()) return false
  for (const one of commandsOf(line)) {
    for (const stage of splitOutsideQuotes(one, /\|/)) {
      const s = stage.trim()
      if (!s) continue
      if (/(?:^|[^0-9&<>])>{1,2}(?!&)\s*(?!\/dev\/null\b|\$null\b|nul\b)\S/i.test(s.replace(/"[^"]*"|'[^']*'/g, 'Q'))) return true
      const words = programWords(s)
      if (!words.length) continue
      const prog = programBase(words[0]!)
      if (prog === 'git') {
        let sub = ''
        for (let i = 1; i < words.length; i++) {
          const w = words[i]!
          if (w === '-C' || w === '-c') i++
          else if (!w.startsWith('-')) {
            sub = w.toLowerCase()
            break
          }
        }
        if (!READ_ONLY_GIT.includes(sub)) return true
        continue
      }
      if (!READ_ONLY_PROGRAMS.includes(prog)) return true
      if (prog === 'find' && words.some((w) => /^-(?:delete|exec|execdir|ok|okdir|fprint\w*)$/.test(w))) return true
    }
  }
  return false
}

export function changesState(e: Obj): boolean {
  if (!isObj(e)) return false
  const tool = String(e.tool ?? '')
  if (EDIT_TOOLS.includes(tool)) return true
  const input = toolInput(e)
  if (tool === 'Bash' || tool === 'PowerShell') return shellWrites(input.command)
  if (tool === 'Artifact') return !['read', 'list', 'open', 'quickstart', 'pin', 'unpin'].includes(String(input.action ?? 'publish'))
  if (tool === 'ArtifactData') return ['set', 'update', 'delete', 'batch'].includes(String(input.action ?? ''))
  if (['Agent', 'Task', 'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'TaskStop', 'SendMessage'].includes(tool)) return false
  const name = tool.includes('__') ? tool.slice(tool.lastIndexOf('__') + 2) : tool
  return /(?:^|[_-])(?:add|apply|archive|cancel|close|create|delete|deploy|edit|forward|insert|merge|move|post|publish|push|put|remove|rename|reply|send|set|submit|update|upload|write)(?:[_-]|$)/i.test(name)
}

export function stateNote(n: number): string | null {
  const text = txt('state_note', { n })
  return text === undefined ? null : `${SUGGESTION_PREFIX}: ${text}`
}

export function dispatchDepth(parent: string | null, parentOf: (id: string) => string | null | undefined, chainMax: number = num('DISPATCH_CHAIN_MAX') ?? 0): { depth: number; exact: boolean; chain: string[] } {
  const chain: string[] = []
  let cur: string | null | undefined = parent
  let exact = true
  for (let i = 0; cur && i < chainMax; i++) {
    if (chain.includes(cur)) {
      exact = false
      break
    }
    chain.push(cur)
    const up = parentOf(cur)
    if (up === undefined) {
      exact = false
      break
    }
    cur = up
  }
  if (cur && chain.length >= chainMax) exact = false
  return { depth: chain.length + 1, exact, chain }
}

export function dispatchCycle(hashes: readonly string[], chain: readonly string[], hashesOf: (id: string) => readonly string[]): string | null {
  if (!hashes.length) return null
  for (const id of chain) if (hashesOf(id).some((h) => hashes.includes(h))) return id
  return null
}

export function depthRefusal(depth: number, max: number | undefined = num('DISPATCH_DEPTH_MAX')): string | null {
  return max === undefined ? null : txt('depth_refusal', { depth, max }) ?? null
}

export function cycleRefusal(ancestor: string, self: boolean, title: string | null): string | null {
  const who = self ? txt('cycle_self') : txt('cycle_ancestor', { id: ancestor })
  if (who === undefined) return null
  return txt('cycle_refusal', { who, title: title ? ` ("${oneLine(title, 80)}")` : '' }) ?? null
}

export const deferText = (): string | undefined => txt('defer')

export function deferredNote(d: { job: Pick<Job, 'id' | 'title'>; rule: string; tool: string }): string | null {
  return txt('deferred_note', { job: d.job.id, title: oneLine(d.job.title || '(no title)', 80), rule: d.rule.replace(/_/g, ' '), tool: oneLine(d.tool, 60) }) ?? null
}


type Counts = { files: Set<string>; edits: number; bytes: number; state: number; told: Set<string> }
type Placed = { parent: string | null; hashes: string[]; title: string | null; owned: number }
const NO_DEFER: readonly string[] = ['budget_files', 'budget_edits', 'budget_bytes', 'ownership', 'steps_claim', 'dispatch_depth', 'dispatch_cycle']
export const defers = (rule: string, reason: string): boolean =>
  !NO_DEFER.includes(rule) && !/\bstop\b|\bend (?:your|its) turn\b/i.test(reason)

let counts = new Map<string, Counts>()
let placed = new Map<string, Placed>()
let pending = new Map<string, Placed>()
let forMain: string[] = []
let changes = 0

export function budgetResetForTest(): void {
  counts = new Map<string, Counts>()
  placed = new Map<string, Placed>()
  pending = new Map<string, Placed>()
  forMain = []
  changes = 0
}

export function budgetChanges(): number {
  return changes
}

function countsOf(agent: string, agentsMax: number): Counts {
  let c = counts.get(agent)
  if (!c) {
    if (counts.size >= agentsMax) counts = new Map<string, Counts>()
    c = { files: new Set<string>(), edits: 0, bytes: 0, state: 0, told: new Set<string>() }
    counts.set(agent, c)
  }
  return c
}

function tellMain(note: string): void {
  if (!forMain.includes(note)) forMain = [...forMain, note].slice(-10)
}

async function cwdOf($: EngineInterface): Promise<string | null> {
  try {
    const c = await $.session.cwd()
    return typeof c === 'string' && c ? c : null
  } catch {
    return null
  }
}

async function capped<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const cap = new Promise<T>((res) => {
    timer = setTimeout(() => res(fallback), ms)
  })
  try {
    return await Promise.race([p.catch(() => fallback), cap])
  } finally {
    clearTimeout(timer)
  }
}


export function budgetTurn(e: Obj): void {
  try {
    counts.delete(isObj(e) && typeof e.agentId === 'string' ? e.agentId : '')
  } catch {}
}

export async function budgetCheck($: EngineInterface, e: Obj, rt?: Ready): Promise<string | null> {
  try {
    const k = cfg()
    if (!k || !k.refuse || !isObj(e) || !EDIT_TOOLS.includes(String(e.tool ?? ''))) return null
    const agent = str(e.agentId)
    if (agent === null || !(await signedIn(rt))) return null
    const size = callSize(e, await cwdOf($))
    if (!size) return null
    const c = countsOf(agent, k.agentsMax)
    const limits = ownedLimits(k.limits, placed.get(agent)?.owned ?? 0)
    const over = budgetOver(c, size, limits)
    if (!over) return null
    const refusal = budgetRefusal(over, limits)
    if (refusal === null) return null
    if (!c.told.has(`main:${over.what}`)) {
      c.told.add(`main:${over.what}`)
      const row = (await capped(listJobs($), k.waitMs, [] as Job[])).find((j) => j.id === agent)
      const told = budgetToldNote(agent, row?.title ?? null, over)
      if (told !== null) tellMain(told)
    }
    return refusal
  } catch {
    return null
  }
}

export async function budgetAfter($: EngineInterface, e: Obj, done: Obj, rt?: Ready): Promise<Obj> {
  try {
    const k = cfg()
    if (!k || !isObj(e) || !isObj(done) || done.deny !== undefined) return done
    if (!(await signedIn(rt))) return done
    const agent = str(e.agentId) ?? ''
    const notes: string[] = []
    if (done.isError !== true && changesState(e)) {
      changes++
      const c = countsOf(agent, k.agentsMax)
      const size = callSize(e, await cwdOf($))
      if (size) {
        if (size.file !== null) c.files.add(size.file)
        c.edits += size.edits
        c.bytes += size.bytes
        if (agent === '') {
          for (const [what, used, limit] of [['files', c.files.size, k.limits.files], ['edits', c.edits, k.limits.edits], ['bytes', c.bytes, k.limits.bytes]] as const) {
            const note = used > limit && !c.told.has(what) ? budgetMainNote(what, used, k.limits) : null
            if (note !== null) {
              c.told.add(what)
              notes.push(note)
            }
          }
        }
      }
      c.state++
      const sn = c.state === k.stateAt ? stateNote(c.state) : null
      if (sn !== null) notes.push(sn)
    }
    if (agent === '' && forMain.length) {
      notes.push(...forMain)
      forMain = []
    }
    return notes.length ? { ...done, context: [...(Array.isArray(done.context) ? done.context : []), ...notes] } : done
  } catch {
    return done
  }
}

export function budgetPrompt(e: Obj): Obj {
  try {
    if (!isObj(e) || e.agentId || !forMain.length) return e
    const notes = forMain
    forMain = []
    return { ...e, context: [...(Array.isArray(e.context) ? e.context : []), ...notes] }
  } catch {
    return e
  }
}

async function agentRows($: EngineInterface): Promise<Obj[] | null> {
  try {
    const list = await Promise.resolve($.agent.list())
    return Array.isArray(list) ? list.filter(isObj) : null
  } catch {
    return null
  }
}

function ownedCount(e: Obj): number {
  try {
    return ownsOf(briefBody(e.prompt)).globs.length
  } catch {
    return 0
  }
}

function hashesOf(dir: string, e: Obj): string[] {
  const raw = typeof e.prompt === 'string' ? e.prompt : ''
  const out = [briefHash(dir, e.description, raw)]
  const body = briefBody(raw).trimEnd()
  if (body !== raw) out.push(briefHash(dir, e.description, body))
  return out
}

export async function budgetSpawnCheck($: EngineInterface, e: Obj, rt?: Ready): Promise<string | null> {
  try {
    const k = cfg()
    if (!k || !isObj(e) || e.resume || !(await signedIn(rt))) return null
    const parent = str(e.parentAgentId)
    const exempt = e.workflow || e.isTeammate === true
    const dir = await projectDir($)
    const hashes = dir && !exempt && e.fork !== true ? hashesOf(dir, e) : []
    const call = str(e.tool_use_id)
    if (call) {
      pending.set(call, { parent, hashes, title: typeof e.description === 'string' ? oneLine(mask(e.description), 120) : null, owned: ownedCount(e) })
      while (pending.size > k.agentsMax) pending.delete(pending.keys().next().value as string)
    }
    if (parent === null || exempt) return null
    const known = (id: string): string | null | undefined => placed.get(id)?.parent
    let walk = dispatchDepth(parent, known, k.chainMax)
    if (!walk.exact) {
      const listed = await capped(agentRows($), k.waitMs, null)
      walk = dispatchDepth(parent, (id) => {
        const p = placed.get(id)
        if (p) return p.parent
        const row = listed?.find((a) => a.id === id)
        return row ? str(row.parentId) : undefined
      }, k.chainMax)
    }
    if (walk.depth > k.depthMax) return depthRefusal(walk.depth, k.depthMax)
    if (!hashes.length) return null
    const ancestor = dispatchCycle(hashes, walk.chain, (id) => placed.get(id)?.hashes ?? [])
    if (ancestor === null) return null
    return cycleRefusal(ancestor, ancestor === parent, placed.get(ancestor)?.title ?? null)
  } catch {
    return null
  }
}

export function budgetSpawned(e: Obj, spawned: Obj): void {
  try {
    const call = isObj(e) ? str(e.tool_use_id) : null
    const id = isObj(spawned) ? str(spawned.agentId) : null
    if (!id || !isObj(e) || e.resume) return
    const p = (call ? pending.get(call) : undefined) ?? { parent: str(e.parentAgentId), hashes: [], title: null, owned: ownedCount(e) }
    if (call) pending.delete(call)
    const max = num('BUDGET_AGENTS_MAX')
    if (max === undefined) return
    if (placed.size >= max) placed = new Map<string, Placed>()
    placed.set(id, p)
  } catch {}
}

export async function gateRefusal($: EngineInterface, e: Obj, rule: string, reason: string, opts: { rt?: Ready; spawn?: boolean; kind?: AuditKind } = {}): Promise<string> {
  try {
    if (!isObj(e) || typeof reason !== 'string' || !reason || !(await signedIn(opts.rt))) return reason
    const spawn = opts.spawn === true
    const agent = str(spawn ? e.parentAgentId : e.agentId)
    const tool = spawn ? 'Agent' : String(e.tool ?? '')
    const input = spawn ? { description: e.description ?? null, prompt: e.prompt ?? null, subagentType: e.subagentType ?? null } : toolInput(e)
    const r = auditRuleOf(reason, rule)
    const kind: AuditKind = opts.kind ?? (r === 'plan_hold' || r === 'release_hold' ? 'hold' : 'refuse')
    let session = ''
    try {
      session = String((await $.session.id()) ?? '')
    } catch {}
    let at = Date.now()
    try {
      const n = Number(await $.clock.now())
      if (Number.isFinite(n)) at = n
    } catch {}
    await auditRecord($, { at, session, agent, rule: r, kind, tool, input })
    const words = deferText()
    const waitMs = num('DEFER_WAIT_MS')
    if (agent === null || words === undefined || waitMs === undefined || !defers(r, reason)) return reason
    const job = (await capped(listJobs($), waitMs, [] as Job[])).find((j) => j.id === agent && (j.kind === 'subagent' || j.kind === 'workflow'))
    if (!job) return reason
    const note = deferredNote({ job, rule: r, tool })
    if (note !== null) tellMain(note)
    return reason.includes(words) ? reason : `${reason}\n\n${words}`
  } catch {
    return reason
  }
}
