import type { EngineInterface } from 'claude-code'
import { ensureAgentIgnore } from './agent_files'
import { concat, hex, utf8 } from './e2e'
import { sha256 } from './noble.js'
import { jobsDir } from './task_state_io'

type Obj = Record<string, any>

export const AUDIT_FILE = '.agent/audit.jsonl'
export const AUDIT_KEY = 'audit_key'
export const AUDIT_HEAD_KEY = 'audit_head'
export const AUDIT_HEADS_MAX = 50
export const AUDIT_MAX_BYTES = 1024 * 1024
export const AUDIT_SHOW = 20
export const AUDIT_WAIT_MS = 1500
export const AUDIT_GENESIS = '0'.repeat(64)
export const AUDIT_RULES: readonly string[] = [
  'acceptance_lock', 'brief_contract', 'budget_bytes', 'budget_edits', 'budget_files', 'command_guard',
  'dispatch_cycle', 'dispatch_depth', 'other', 'ownership', 'plan_hold', 'project_lock',
  'release_hold', 'service_check', 'steps_claim', 'steps_gate', 'test_lock', 'test_unlock', 'usage_line', 'webmail',
]

export type AuditKind = 'refuse' | 'hold' | 'grant'
export type AuditEntry = { at: number; session: string; agent: string | null; rule: string; kind: AuditKind; tool: string; input: unknown }
export type AuditHead = { n: number; m: string; n0: number; p0: string; gone?: number }
export type AuditLine = { v: 1; n: number; t: string; s: string; a: string; r: string; k: string; tool: string; in: string; p: string; m: string }
export type AuditVerdict = {
  state: 'intact' | 'broken' | 'unverified' | 'empty' | 'missing'
  lines: number
  bad: number | null
  why: string | null
}

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isHex = (v: unknown, n: number): v is string => typeof v === 'string' && v.length === n && /^[0-9a-f]+$/.test(v)
const safeId = (v: unknown): string => String(v ?? '').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 100)
const slashed = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')


export function hmacSha256(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const k = key.length > 64 ? sha256(key) : key
  const block = new Uint8Array(64)
  block.set(k)
  const inner = block.map((b) => b ^ 0x36)
  const outer = block.map((b) => b ^ 0x5c)
  return sha256(concat(outer, sha256(concat(inner, msg))))
}

export function canonicalJson(v: unknown, depth = 0): string {
  if (depth > 20) return '"(deep)"'
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x, depth + 1)).join(',')}]`
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k], depth + 1)}`).join(',')}}`
  const s = JSON.stringify(v)
  return s === undefined ? 'null' : s
}

export function auditInputHash(key: Uint8Array, input: unknown): string {
  return hex(hmacSha256(key, utf8(`input\u0000${canonicalJson(input)}`))).slice(0, 32)
}

export function auditLine(key: Uint8Array, n: number, prev: string, e: AuditEntry): string {
  const rule = AUDIT_RULES.includes(e.rule) ? e.rule : 'other'
  const kind = e.kind === 'hold' || e.kind === 'grant' ? e.kind : 'refuse'
  const t = new Date(Number.isFinite(e.at) ? e.at : 0).toISOString()
  const body = `{"v":1,"n":${Math.max(1, Math.floor(n))},"t":${JSON.stringify(t)},"s":${JSON.stringify(safeId(e.session))},` +
    `"a":${JSON.stringify(safeId(e.agent ?? ''))},"r":${JSON.stringify(rule)},"k":${JSON.stringify(kind)},` +
    `"tool":${JSON.stringify(safeId(e.tool))},"in":${JSON.stringify(auditInputHash(key, e.input))},"p":${JSON.stringify(isHex(prev, 64) ? prev : AUDIT_GENESIS)}`
  return `${body},"m":"${hex(hmacSha256(key, utf8(body)))}"}`
}

export function parseAuditLine(text: string): AuditLine | null {
  try {
    if (!/^\{"v":1,"n":\d+,.*,"m":"[0-9a-f]{64}"\}$/.test(text)) return null
    const d = JSON.parse(text)
    if (!isObj(d) || d.v !== 1 || !Number.isInteger(d.n) || d.n < 1 || !isHex(d.p, 64) || !isHex(d.m, 64)) return null
    for (const k of ['t', 's', 'a', 'r', 'k', 'tool', 'in']) if (typeof d[k] !== 'string') return null
    return d as AuditLine
  } catch {
    return null
  }
}

function linesOf(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines.map((l) => l.replace(/\r$/, ''))
}

export function verifyAudit(text: string | null, key: Uint8Array | null, head: AuditHead | null = null): AuditVerdict {
  if (text === null) {
    return head ? { state: 'missing', lines: 0, bad: 1, why: `the log is missing, but this machine wrote ${head.n} line${head.n === 1 ? '' : 's'} to it` } : { state: 'empty', lines: 0, bad: null, why: null }
  }
  const lines = linesOf(text)
  if (!lines.length) {
    return head ? { state: 'broken', lines: 0, bad: 1, why: `the log is empty, but this machine wrote ${head.n} line${head.n === 1 ? '' : 's'} to it` } : { state: 'empty', lines: 0, bad: null, why: null }
  }
  if (!key) return { state: 'unverified', lines: lines.length, bad: null, why: "this machine's plugin store holds no audit key (the log was written elsewhere, or the store was reset)" }
  let prev: AuditLine | null = null
  const byN = new Map<number, string>()
  for (let i = 0; i < lines.length; i++) {
    const at = i + 1
    const line = parseAuditLine(lines[i]!)
    if (!line) return { state: 'broken', lines: lines.length, bad: at, why: 'the line is not an audit line of this format (damaged or edited)' }
    const body = lines[i]!.slice(0, lines[i]!.length - 72)
    if (hex(hmacSha256(key, utf8(body))) !== line.m) return { state: 'broken', lines: lines.length, bad: at, why: 'its mac does not match its text (the line was changed)' }
    if (prev === null) {
      const fromHead = head !== null && head.n0 === line.n && head.p0 === line.p
      if (!fromHead && !(line.n === 1 && line.p === AUDIT_GENESIS)) {
        if (head !== null || line.n === 1) return { state: 'broken', lines: lines.length, bad: at, why: 'the log does not start where this machine started it (lines were removed at its start)' }
        return { state: 'unverified', lines: lines.length, bad: null, why: `the file starts at chain line ${line.n} and this machine has no record of where it starts` }
      }
    } else if (line.p !== prev.m || line.n !== prev.n + 1) {
      return { state: 'broken', lines: lines.length, bad: at, why: line.p !== prev.m ? 'it does not carry the mac of the line before (a line was removed, inserted or changed)' : 'its number does not follow the line before' }
    }
    byN.set(line.n, line.m)
    prev = line
  }
  if (head !== null && prev !== null) {
    if (prev.n < head.n) return { state: 'broken', lines: lines.length, bad: lines.length + 1, why: `the log ends at chain line ${prev.n}, but this machine wrote up to line ${head.n} (lines were removed at its end)` }
    const mine = byN.get(head.n)
    if (mine !== undefined && mine !== head.m) {
      const first = parseAuditLine(lines[0]!)!.n
      return { state: 'broken', lines: lines.length, bad: head.n - first + 1, why: 'the line differs from the one this machine wrote there' }
    }
    if (typeof head.gone === 'number') {
      return { state: 'broken', lines: lines.length, bad: 1, why: `the log was removed or emptied after this machine had written ${head.gone} line${head.gone === 1 ? '' : 's'} to it; this file starts again at chain line ${head.n0}` }
    }
  }
  return { state: 'intact', lines: lines.length, bad: null, why: null }
}

export function auditRuleOf(reason: unknown, fallback: string): string {
  const r = String(reason ?? '')
  if (r.startsWith('agent-services test lock:')) return 'test_lock'
  if (r.startsWith('agent-services acceptance lock:')) return 'acceptance_lock'
  if (r.startsWith('agent-services write ownership:')) return 'ownership'
  if (r.startsWith('agent-services steps claim:')) return 'steps_claim'
  if (r.startsWith('agent-services dispatch contract:')) return 'brief_contract'
  if (r.startsWith('agent-services dispatch depth:')) return 'dispatch_depth'
  if (r.startsWith('agent-services dispatch cycle:')) return 'dispatch_cycle'
  const budget = /^agent-services change budget \((files|edits|bytes)\):/.exec(r)
  if (budget) return `budget_${budget[1]}`
  if (/" is held: placeholder /.test(r)) return 'release_hold'
  return AUDIT_RULES.includes(fallback) ? fallback : 'other'
}

export function auditReport(path: string, text: string | null, v: AuditVerdict): string {
  const out: string[] = []
  if (text === null || !linesOf(text).length) {
    out.push(`Audit log: ${path}: no refusal or hold recorded yet.`)
    if (v.state === 'missing' || v.state === 'broken') out.push(`Chain: BROKEN: ${v.why}.`)
    return out.join('\n')
  }
  const lines = linesOf(text)
  out.push(`Audit log: ${path} (${lines.length} line${lines.length === 1 ? '' : 's'}; each refusal or hold of this plugin's rules, with ids and hashes only).`)
  out.push(`Last ${Math.min(AUDIT_SHOW, lines.length)}:`)
  out.push('  line  time (UTC)           rule              kind    tool                  agent         input')
  const from = Math.max(0, lines.length - AUDIT_SHOW)
  for (let i = from; i < lines.length; i++) {
    const l = parseAuditLine(lines[i]!)
    if (!l) {
      out.push(`  ${String(i + 1).padStart(4)}  (not an audit line)`)
      continue
    }
    const t = l.t.replace('T', ' ').replace(/\.\d+Z$/, '')
    out.push(`  ${String(i + 1).padStart(4)}  ${t.padEnd(19)}  ${l.r.padEnd(16)}  ${l.k.padEnd(6)}  ${l.tool.slice(0, 20).padEnd(20)}  ${(l.a || 'main').slice(0, 12).padEnd(12)}  ${l.in.slice(0, 12)}`)
  }
  if (v.state === 'intact') out.push(`Chain: intact (lines 1-${v.lines}, checked with this machine's key).`)
  else if (v.state === 'broken') out.push(`Chain: BROKEN at line ${v.bad}: ${v.why}.`)
  else if (v.state === 'unverified') out.push(`Chain: not checked: ${v.why}.`)
  return out.join('\n')
}


let lock: Promise<unknown> = Promise.resolve()

export function auditResetForTest(): void {
  lock = Promise.resolve()
}

const keyBytes = (h: string): Uint8Array => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)))

async function auditKey($: EngineInterface, create: boolean): Promise<{ key: Uint8Array; fresh: boolean } | null> {
  try {
    const got = await $.store.get(AUDIT_KEY)
    if (isHex(got, 64)) return { key: keyBytes(got), fresh: false }
    if (!create) return null
    await $.store.set(AUDIT_KEY, hex(globalThis.crypto.getRandomValues(new Uint8Array(32))))
    const back = await $.store.get(AUDIT_KEY)
    return isHex(back, 64) ? { key: keyBytes(back), fresh: true } : null
  } catch {
    return null
  }
}

async function heads($: EngineInterface): Promise<Record<string, AuditHead>> {
  try {
    const v = await $.store.get(AUDIT_HEAD_KEY)
    return isObj(v) ? (v as Record<string, AuditHead>) : {}
  } catch {
    return {}
  }
}

function headOf(v: unknown): AuditHead | null {
  if (!isObj(v) || !Number.isInteger(v.n) || !isHex(v.m, 64) || !Number.isInteger(v.n0) || !isHex(v.p0, 64)) return null
  return { n: v.n, m: v.m, n0: v.n0, p0: v.p0, ...(Number.isInteger(v.gone) ? { gone: v.gone } : {}) }
}

async function saveHead($: EngineInterface, path: string, head: AuditHead): Promise<void> {
  try {
    const all = { ...(await heads($)) }
    const old = headOf(all[path])
    if (old && old.n > head.n && old.n0 === head.n0) return
    delete all[path]
    all[path] = head
    const keys = Object.keys(all)
    for (const k of keys.slice(0, Math.max(0, keys.length - AUDIT_HEADS_MAX))) delete all[k]
    await $.store.set(AUDIT_HEAD_KEY, all)
  } catch {}
}

async function readLog($: EngineInterface, path: string): Promise<{ kind: 'absent' } | { kind: 'error' } | { kind: 'text'; text: string }> {
  try {
    return { kind: 'text', text: String(await $.fs.read(path)) }
  } catch {
    let there = false
    try {
      there = (await $.fs.exists(path)) === true
    } catch {}
    return there ? { kind: 'error' } : { kind: 'absent' }
  }
}

const stamp = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')

function nextOf(text: string, head: AuditHead | null): { n: number; prev: string } {
  const lines = linesOf(text)
  const last = lines.length ? parseAuditLine(lines[lines.length - 1]!) : null
  if (last) return { n: last.n + 1, prev: last.m }
  if (lines.length && head) return { n: head.n + 1, prev: head.m }
  if (lines.length) return { n: lines.length + 1, prev: AUDIT_GENESIS }
  return head ? { n: head.n + 1, prev: head.m } : { n: 1, prev: AUDIT_GENESIS }
}

function macAt(text: string, n: number): string | undefined {
  const lines = linesOf(text)
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = parseAuditLine(lines[i]!)
    if (l && l.n === n) return l.m
  }
  return undefined
}

let auditTap: ((line: AuditLine) => void) | null = null

export function setAuditTap(f: ((line: AuditLine) => void) | null): void {
  auditTap = f
}

export function auditTapSet(): boolean {
  return auditTap !== null
}

async function appendOnce($: EngineInterface, e: AuditEntry): Promise<boolean> {
  const dir = await jobsDir($)
  if (!dir) return false
  const path = `${slashed(dir)}/${AUDIT_FILE}`
  const k = await auditKey($, true)
  if (!k) return false
  await ensureAgentIgnore($, slashed(dir))
  for (let attempt = 0; attempt < 2; attempt++) {
    const fresh = k.fresh && attempt === 0
    let head = k.fresh ? null : headOf((await heads($))[path])
    const raw = await readLog($, path)
    if (raw.kind === 'error') return false
    let text = raw.kind === 'text' ? raw.text : ''
    let start: { n0: number; p0: string } | null = null
    let gone = head?.gone
    if (fresh && linesOf(text).length) {
      await $.fs.write(path.replace(/\.jsonl$/, `.nokey-${stamp(e.at)}.jsonl`), text)
      text = ''
      head = null
    }
    if (!linesOf(text).length && head) gone = head.n
    const { n, prev } = nextOf(text, head)
    const line = auditLine(k.key, n, prev, e)
    if (text.length + line.length + 1 > AUDIT_MAX_BYTES && linesOf(text).length) {
      await $.fs.write(path.replace(/\.jsonl$/, `.${stamp(e.at)}.jsonl`), text)
      text = ''
      start = { n0: n, p0: prev }
    }
    if (!text) start = start ?? { n0: n, p0: prev }
    const sep = text && !text.endsWith('\n') ? '\n' : ''
    const out = `${text}${sep}${line}\n`
    await $.fs.write(path, out)
    const m = parseAuditLine(line)!.m
    const n0 = start?.n0 ?? head?.n0 ?? 1
    const p0 = start?.p0 ?? head?.p0 ?? AUDIT_GENESIS
    const back = await readLog($, path)
    if (!(back.kind === 'text' && macAt(back.text, n) === m)) {
      if (attempt === 0) continue
      return false
    }
    const now = headOf((await heads($))[path])
    if (now && now.n0 === n0 && now.n === n && now.m !== m) {
      const again = await readLog($, path)
      if (!(again.kind === 'text' && macAt(again.text, n) === m)) {
        if (attempt === 0) continue
        return false
      }
    }
    await saveHead($, path, { n, m, n0, p0, ...(gone !== undefined ? { gone } : {}) })
    try {
      auditTap?.(parseAuditLine(line)!)
    } catch {}
    return true
  }
  return false
}

export async function auditRecord($: EngineInterface, e: AuditEntry, waitMs = AUDIT_WAIT_MS): Promise<boolean> {
  try {
    const run = () => appendOnce($, e).catch(() => false)
    const done = lock.then(run, run)
    lock = done.catch(() => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    const cap = new Promise<boolean>((res) => {
      timer = setTimeout(() => res(false), waitMs)
    })
    const out = await Promise.race([done, cap])
    clearTimeout(timer)
    return out === true
  } catch {
    return false
  }
}

export async function auditVerify($: EngineInterface): Promise<{ path: string | null; text: string | null; verdict: AuditVerdict }> {
  try {
    const dir = await jobsDir($)
    if (!dir) return { path: null, text: null, verdict: { state: 'empty', lines: 0, bad: null, why: null } }
    const path = `${slashed(dir)}/${AUDIT_FILE}`
    const raw = await readLog($, path)
    const head = headOf((await heads($))[path])
    if (raw.kind === 'error') return { path, text: null, verdict: { state: 'unverified', lines: 0, bad: null, why: 'the log could not be read' } }
    const text = raw.kind === 'text' ? raw.text : null
    const k = await auditKey($, false)
    return { path, text, verdict: verifyAudit(text, k ? k.key : null, head) }
  } catch {
    return { path: null, text: null, verdict: { state: 'unverified', lines: 0, bad: null, why: 'the log could not be checked' } }
  }
}

export async function auditCommand($: EngineInterface): Promise<string> {
  try {
    const { path, text, verdict } = await auditVerify($)
    if (!path) return 'Audit log: no project folder for this session, so there is no log.'
    return auditReport(path, text, verdict)
  } catch {
    return 'Audit log: it could not be read.'
  }
}
