// The minimized route and checkpoint records, ported from host/conclusions.py. The routing table, the checkpoint
// rule and the run-limit table live on the server; this file only builds the minimal records, sends them through
// the svc channel and falls back to open defaults. What leaves the machine: the first word of a subagent
// description, its length, a per-session dispatch number, a salted project hash, the command head (only from the
// public KNOWN_HEADS list) and run durations. The rest of the description, paths and the local session id never
// leave and are never written. The salt lives in the store (key SALT_KEY, 64 hex); it is not secret, only a
// per-machine blind for project paths.

import { sha256 } from './noble.js'
import type { KV, Random, Transport } from './engine_types'

export const OPEN_DEFAULTS = { idle_seconds: 180, max_seconds: 3600 }
// Public list of common developer commands. A privacy filter: any other name is sent as "other".
export const KNOWN_HEADS: ReadonlySet<string> = new Set([
  'python', 'node', 'deno', 'bun', 'npm', 'npx', 'pnpm', 'yarn', 'pytest', 'pip', 'pip3', 'uv', 'uvx', 'poetry',
  'cargo', 'rustc', 'go', 'gradle', 'gradlew', 'mvn', 'java', 'javac', 'dotnet', 'msbuild', 'make', 'cmake',
  'ninja', 'docker', 'kubectl', 'git', 'gh', 'bash', 'sh', 'zsh', 'pwsh', 'powershell', 'cmd', 'mypy', 'ruff',
  'tox', 'nox', 'black', 'flake8', 'pylint', 'eslint', 'tsc', 'jest', 'vitest', 'playwright', 'terraform',
])
export const ROUTER_NOTICE =
  'The routing service is temporarily unavailable; this subagent dispatch runs as written, with the model and effort the caller set.'
export const SALT_KEY = 'salt'
export const ROUTE_DEADLINE_MS = 1000 // agent.spawn (plan 3.3 item 3)
export const BACKGROUND_DEADLINE_MS = 30000 // turn_end checkpoint timing runs in the background

const PYTHONS = /^(python|python3|python3\.\d+|py|pythonw)$/
const SUFFIXES = ['.exe', '.cmd', '.bat', '.ps1', '.sh', '.py']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const MODEL_RX = /^[A-Za-z0-9.[\]_:-]+$/
const SUBTYPE_RX = /^[A-Za-z0-9 _.:-]+$/
const CAP = 1000000
const DUR_CAP = 604800
const HARNESSES = ['claude-code', 'opencode', 'codex', 'other']
// what Python's str.split() splits on (str.isspace), which differs from JS \s on U+FEFF and U+001C-U+001F, U+0085
const PY_SPACE = /[\t\n\v\f\r \x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/

const enc = new TextEncoder()
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

export function hmacSha256(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const k = new Uint8Array(64)
  k.set(key.length > 64 ? sha256(key) : key)
  const inner = new Uint8Array(64 + msg.length)
  const outer = new Uint8Array(64 + 32)
  for (let i = 0; i < 64; i++) {
    inner[i] = k[i]! ^ 0x36
    outer[i] = k[i]! ^ 0x5c
  }
  inner.set(msg, 64)
  outer.set(sha256(inner), 64)
  return sha256(outer)
}

export function typeWord(description: unknown): string {
  const parts = typeof description === 'string' ? description.split(PY_SPACE).filter((x) => x) : []
  return parts.length ? [...parts[0]!].slice(0, 32).join('') : ''
}

function base(word: string): string {
  let b = (word.split(/[\\/]/).pop() ?? '').toLowerCase()
  for (const suf of SUFFIXES) {
    if (b.endsWith(suf)) {
      b = b.slice(0, -suf.length)
      break
    }
  }
  return b
}

export function headWord(argv: unknown[] | null | undefined): string {
  if (!argv || !argv.length) return 'other'
  const b = base(String(argv[0]))
  if (PYTHONS.test(b)) {
    const args = argv.slice(1).map(String)
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '-m') {
        const mod = args[i + 1]!.split('.')[0]!.toLowerCase()
        return KNOWN_HEADS.has(mod) ? mod : 'python'
      }
    }
    return 'python'
  }
  return KNOWN_HEADS.has(b) ? b : 'other'
}

export function projectHash(salt: Uint8Array, projectDir: string): string {
  const key = projectDir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return hex(hmacSha256(salt, enc.encode('project:' + key))).slice(0, 16)
}

function num(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string' && v.trim() && !Number.isNaN(Number(v.trim()))) return Number(v.trim())
  return NaN
}

const intOf = (v: unknown): number => {
  const x = num(v)
  return Number.isNaN(x) ? 0 : Math.trunc(Math.min(Math.max(x, 0), CAP))
}

const pctOf = (v: unknown): number => {
  const x = num(v)
  return Number.isNaN(x) ? 0 : Math.min(Math.max(x, 0), 100)
}

function durations(values: unknown[] | null | undefined): number[] {
  const out: number[] = []
  for (const v of (values ?? []).slice(-5)) {
    const x = num(v)
    if (Number.isNaN(x)) continue
    out.push(Math.min(Math.max(x, 0), DUR_CAP))
  }
  return out
}

export type RouteAnswer = {
  decision: string
  model: unknown
  effort: unknown
  reason: unknown
  hint: unknown
  fallback: string | null
  notice: string | null
  brief_rule?: string
  brief_forward?: string
}

export type CheckpointCounts = {
  context_pct: unknown
  turns: unknown
  tool_calls: unknown
  todos_done: unknown
  commits: unknown
  minutes: unknown
}

export type RecordsOptions = { store: KV; random: Random; harness?: string }

export class Records {
  readonly harness: string
  private readonly svc: Transport
  private readonly store: KV
  private readonly random: Random
  private readonly refs = new Map<string | null, string>()
  private readonly dispatch = new Map<string | null, number>()
  private readonly notified = new Set<string | null>()
  private saltP: Promise<Uint8Array> | null = null

  constructor(svc: Transport, opts: RecordsOptions) {
    this.svc = svc
    this.store = opts.store
    this.random = opts.random
    const h = opts.harness ?? 'claude-code'
    this.harness = HARNESSES.includes(h) ? h : 'other'
  }

  // ---------------- local state
  salt(): Promise<Uint8Array> {
    if (!this.saltP) this.saltP = this.loadSalt()
    return this.saltP
  }

  private async loadSalt(): Promise<Uint8Array> {
    const parse = (v: unknown): Uint8Array | null =>
      typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? Uint8Array.from(v.match(/../g)!, (h) => parseInt(h, 16)) : null
    try {
      const have = parse(await this.store.get(SALT_KEY))
      if (have) return have
    } catch {
      // unreadable: make one
    }
    const raw = this.random(32)
    try {
      await this.store.set(SALT_KEY, hex(raw))
      const back = parse(await this.store.get(SALT_KEY)) // two sessions making one at once: the stored one wins
      if (back) return back
    } catch {
      // kept in memory only
    }
    return raw
  }

  private ref(session: unknown): string {
    const key = typeof session === 'string' ? session : null
    let r = this.refs.get(key)
    if (r === undefined) this.refs.set(key, (r = hex(this.random(16))))
    return r
  }

  // The ref the conclusion calls send for `session` (the same one as route and checkpoint use).
  sessionRef(session: unknown): string {
    return this.ref(session)
  }

  private async phash(projectDir: unknown): Promise<string | null> {
    return typeof projectDir === 'string' ? projectHash(await this.salt(), projectDir) : null
  }

  private async post(path: string, body: Record<string, unknown>, kind: string, deadlineMs: number,
    errors?: (string | null)[]): Promise<Record<string, unknown> | null> {
    let r
    try {
      r = await this.svc.call('POST', path, body, { kind, deadlineMs })
    } catch {
      return null // a conclusion never breaks the caller
    }
    if (!r || !r.ok || !r.body || typeof r.body !== 'object' || Array.isArray(r.body)) {
      if (errors) errors.push(r ? r.error : null)
      return null
    }
    return r.body as Record<string, unknown>
  }

  // ---------------- router
  async route(session: unknown, subagentType: unknown, description: unknown, model: unknown = null, effort: unknown = null,
    projectDir: unknown = null, harness: unknown = null, deadlineMs = ROUTE_DEADLINE_MS): Promise<RouteAnswer> {
    const key = typeof session === 'string' ? session : null
    const ref = this.ref(session)
    const n = (this.dispatch.get(key) ?? 0) + 1
    this.dispatch.set(key, n)
    const desc = typeof description === 'string' ? description : ''
    const st = typeof subagentType === 'string' ? subagentType : ''
    const body: Record<string, unknown> = {
      session_ref: ref,
      type_word: typeWord(desc),
      subagent_type: [...st].slice(0, 64).join(''),
      requested_model: typeof model === 'string' && model ? model : null,
      requested_effort: typeof effort === 'string' && EFFORTS.includes(effort) ? effort : null,
      harness: harness === null || harness === undefined ? this.harness
        : typeof harness === 'string' && HARNESSES.includes(harness) ? harness : 'other',
      desc_len: Math.min([...desc].length, 100000),
      dispatch_no: Math.min(n, CAP),
      project_hash: await this.phash(projectDir),
    }
    let ans: Record<string, unknown> | null = null
    const errors: (string | null)[] = []
    const rm = body.requested_model as string | null
    if (SUBTYPE_RX.test(body.subagent_type as string) && (rm === null || ([...rm].length <= 64 && MODEL_RX.test(rm)))) {
      ans = await this.post('/router/decide', body, 'router', deadlineMs, errors)
    }
    if (ans !== null && ['route', 'pass', 'deny'].includes(ans.decision as string)) {
      // brief_rule / brief_forward: served rule text, passed through as the server wrote it (absent when not sent)
      const out: RouteAnswer = {
        decision: ans.decision as string, model: ans.model ?? null, effort: ans.effort ?? null, reason: ans.reason ?? null,
        hint: ans.hint ?? null, fallback: null, notice: null,
      }
      if (typeof ans.brief_rule === 'string') out.brief_rule = ans.brief_rule
      if (typeof ans.brief_forward === 'string') out.brief_forward = ans.brief_forward
      return out
    }
    const pass: RouteAnswer = { decision: 'pass', model: null, effort: null, reason: null, hint: null, fallback: 'pass_through', notice: null }
    if (errors.length === 1 && errors[0] === 'not_in_plan') return pass // not "temporarily unavailable": no notice
    const first = !this.notified.has(key)
    this.notified.add(key)
    pass.notice = first ? ROUTER_NOTICE : null
    return pass
  }

  // ---------------- checkpoint
  async checkpoint(session: unknown, c: CheckpointCounts, deadlineMs = BACKGROUND_DEADLINE_MS):
    Promise<{ now: boolean; keep_lines: string[]; fallback: string | null }> {
    const body = {
      session_ref: this.ref(session), context_pct: pctOf(c.context_pct), turns: intOf(c.turns),
      tool_calls: intOf(c.tool_calls), todos_done: intOf(c.todos_done), commits: intOf(c.commits), minutes: intOf(c.minutes),
    }
    const ans = await this.post('/checkpoint/timing', body, 'checkpoint', deadlineMs)
    if (ans !== null && typeof ans.now === 'boolean' && Array.isArray(ans.keep_lines)) {
      return { now: ans.now, keep_lines: ans.keep_lines.filter((x): x is string => typeof x === 'string'), fallback: null }
    }
    return { now: false, keep_lines: [], fallback: 'no_suggestion' }
  }

  // ---------------- run limits
  async limits(argv: unknown[] | null, session: unknown = null, projectDir: unknown = null, priorDurations: unknown[] = [],
    deadlineMs = BACKGROUND_DEADLINE_MS): Promise<Record<string, unknown>> {
    const body = {
      session_ref: this.ref(session), head: headWord(argv ?? []), project_hash: await this.phash(projectDir),
      prior_durations: durations(priorDurations),
    }
    const ans = await this.post('/limits/run', body, 'run_limits', deadlineMs)
    if (ans !== null) {
      const idle = ans.idle_seconds
      const mx = ans.max_seconds
      if (typeof idle === 'number' && typeof mx === 'number' && idle >= 1 && mx >= 0) {
        return { idle_seconds: idle, max_seconds: mx, source: 'service', fallback: null }
      }
    }
    return { ...OPEN_DEFAULTS, source: 'default', fallback: 'open_defaults' }
  }
}
