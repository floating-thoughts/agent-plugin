// The svc channel, harness-neutral: a port of host/services.py Connector (plan 3.3, 3.4, 3.9).
// Fetch-as-text, the store, the clock, sleep, random, the outbox and the Claude account hash are passed in; nothing
// here touches the engine.
//
// What it keeps from the Python connector: the schema allowlist (_filter plus the schema check) and the body limit,
// per-kind deadlines and fallbacks, retries inside the deadline, the 401 / 423 / 429 blocks, the shell gate with
// /auth/hello as the handshake and plan refresh, rotation 7 days before expiry, the outbox, and the settings
// (offline, service switches, served channel and pins).
//
// What is new for the hooks engine (measured in the engine):
// - Every request except GET /health is sealed in the base64 envelope (e2e.ts) and POSTed as text. The answer's
//   signature is checked first (sig.ts), over the text as sent, then the base64 is decoded and opened. A request
//   that cannot be sealed is never sent; a signed success that is not a sealed answer, or does not open, is never
//   used.
// - Hook budget about 10 s: every fetch is raced against a deadline (the engine's own timeout is 30 s), retries
//   happen only inside it, and nothing ever sleeps out a Retry-After: it becomes a shared cool-down in the store
//   and calls answer at once with their fallback. Deadlines: tool.call 8 s in all, agent.spawn 1 s, prompt.submit no
//   network, session.start and turn.complete background only.
// - Several sessions share one store with no atomic read-modify-write: the credential is read on every request,
//   rotation runs under a best-effort lease with per-session token_next keys, and a 401 deletes the token only after
//   the re-read, token_prev grace and token_next steps, and only if the stored token is still one that got the 401.
// - Auth fail (3.9): with no valid sign-in, or after a 401 or 423 that does not recover, nothing is sent but
//   GET /health and the login routes, in every session (the state is derived from the store, re-read at most every
//   5 s by hooks).
// - Production ignores overrides: the endpoint and keys are DEFAULT_CONFIG unless the caller (a staging build)
//   passes its own config; nothing is ever read from the store for them.
import { API, BODY_LIMIT, CONTRACT, E2E_CONTENT_TYPE_B64, PREFIX } from './contract'
import {
  answerEncoding,
  b64Decode,
  b64Encode,
  defaultRandom,
  hex,
  openResponse,
  sealRequest,
  sha256Hex,
  utf8,
} from './e2e'
import type { Random } from './e2e'
import { Outbox } from './outbox'
import type { RequestLine } from './outbox'
import { devicePublicKey, newDeviceSeed, serverKeys, signedHeaders, verifyResponse } from './sig'
import type { ServerKeys } from './sig'
import {
  CREDENTIAL_KEYS,
  getText,
  KEYS,
  safeDelete,
  safeGet,
  safeSet,
  SIGN_OUT_KEYS,
  tokenNextKey,
  tokenNextKeys,
} from './store'
import type { KV } from './store'

// ------------------------------------------------------------------ constants

/** The shipped client config (host/client_defaults.json; a test keeps them equal). */
export const DEFAULT_CONFIG = {
  endpoint: 'https://svc.yzcanadianholdings.com',
  pin: { kind: 'ca' },
  server_keys: ['q3eePMcOg3Ds0W/qzkEV1r18qJo7IDA83Tg6KY7DgJE='],
  e2e_keys: ['MbNUgR1sQVd5oZlN77nOJraHgVSlMol9QeYfgB6fGnY='],
} as const

export type Kind = 'router' | 'checkpoint' | 'served' | 'run_limits' | 'daily' | 'auth' | 'health'
export type Hook = 'tool' | 'spawn' | 'prompt' | 'background'

/** Per-kind deadlines (host/services.py TIMEOUTS, in ms); dist_token is gone (A23). */
export const TIMEOUTS_MS: Record<Kind, number> = {
  router: 1000,
  checkpoint: 5000,
  served: 5000,
  run_limits: 2000,
  daily: 30000,
  auth: 10000,
  health: 5000,
}
export const FALLBACKS: Record<Kind, string | null> = {
  router: 'pass_through',
  checkpoint: 'no_suggestion',
  served: 'keep_fetched',
  run_limits: 'open_defaults',
  daily: 'retry_next_day',
  auth: null,
  health: null,
}
/** The whole budget of one call, by the hook it runs in (plan 3.3 item 3); a call gets the smaller of this and its
 * kind's deadline. prompt.submit sends nothing. */
export const HOOK_BUDGET_MS: Record<Hook, number> = { tool: 8000, spawn: 1000, prompt: 0, background: 25000 }

export const ROTATE_MARGIN_S = 7 * 86400
export const MAX_ATTEMPTS = 3
export const BLOCK_SECONDS = { locked_out: 900, account_locked: 3600 } as const
export const THROTTLE_MAX_SECONDS = 300 // the longest signed Retry-After honored
export const THROTTLE_NOTICE_AFTER = 120
export const NOTICE_EVERY_MS = 3600000
export const UNSIGNED_RETRY_MAX = 60 // the longest unsigned Retry-After honored
export const EDGE_COOL_SECONDS = 30 // an edge refusal without a usable Retry-After
export const MAX_RESPONSE_CHARS = Math.ceil((4 * 1048576) / 3) * 4 // 4 MiB of answer, as base64 text
export const TOKEN_PREV_GRACE_MS = 5 * 60000
export const LEASE_MS = 30000
export const LEASE_SETTLE_MS = 200
export const AUTH_STATE_TTL_MS = 5000
export const BAD_ENVELOPE_LIMIT = 2
export const BAD_ENVELOPE_WINDOW_MS = 600000 // the server's failure window (5 in 10 minutes locks the IP)
export const LOGIN_PENDING_MS = 600000
export const HELLO_PATH = '/auth/hello'
export const PLAN_PATH = '/auth/plan'
export const RETRY_STATUS = [500, 502, 503, 504]
export const EDGE_STATUS = [403, 429]
export const UNVERIFIED_ERRORS = ['unsigned_response', 'bad_signature', 'stale_response']
export const SERVICES = ['health', 'updates', 'incidents', 'metrics', 'router', 'checkpoint', 'limits'] as const
export const SERVICE_DEFAULTS: Record<string, boolean> = {
  health: true,
  updates: true,
  incidents: false,
  metrics: true, // on by default since 2026-10-31; settings() keeps an explicit off (metricsDefault)
  router: true,
  checkpoint: true,
  limits: true,
}
export const SERVED_ROUTE = '/served/fetch'
export const SERVED_ROLES: readonly string[] = (CONTRACT as any).definitions.ServedRole.enum
export const SERVED_CHANNELS = ['stable', 'beta']
/** Routes a caller may send once with consent while their service switch is off. */
export const CONSENT_ROUTES = ['POST /diagnostic/estimate']
export const PLAN_VALUES = ['diagnostic', 'guard', 'full']

/** The one line every tool answers while auth has failed (3.9). */
export const PAUSED_LINE = 'agent-services is paused: sign in with /agent-services login'
export const LOCKED_LINE =
  'agent-services is paused: this account is locked; contact support, then sign in with /agent-services login'
export const GATE_NOTICES: Record<string, string> = {
  login: PAUSED_LINE,
  locked: LOCKED_LINE,
  upgrade: 'agent-services is paused: this plugin version is no longer accepted; update the plugin (minimum {min_shell}).',
  offline: 'agent-services is paused: offline mode is on.',
  unavailable: 'agent-services is paused: the server could not be reached; it tries again at the next session.',
  unverified:
    "agent-services is paused: an answer claiming to come from the server was not signed by the server's key (a " +
    'proxy or a fake server may be in the way); nothing it said was used. It tries again at the next session.',
}
export const NOTICE_TEXT: Record<string, string> = {
  login_expired: 'Your agent-services sign-in expired; sign in again with /agent-services login.',
  session_replaced: 'Your account signed in on another device; sign in again here with /agent-services login.',
  claude_account_mismatch: 'The Claude account changed since sign-in; sign in again to re-pair this device.',
  account_locked: 'Your agent-services account is locked; contact support.',
  locked_out: 'Too many failed requests; agent-services paused for 15 minutes.',
  rate_limited:
    'agent-services is busy and is slowing requests down; the plugin keeps working on its defaults and retries on its own.',
  server_unverified:
    "agent-services stopped: an answer was not signed by the server's key, so it was not used (a proxy or a fake " +
    'server may be in the way). It tries again at the next session.',
  endpoint_changed: 'The agent-services address or server keys changed, so this machine was signed out; sign in again.',
  bad_envelope:
    'agent-services stopped sending: the server could not open two requests in a row; it tries again in 10 minutes.',
}

const HOST_RX =
  /^https:\/\/((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?)(?::(\d{1,5}))?$/
const KEY_RX = /^[A-Za-z0-9+/]{43}=$/
const ROUTE_KEY_RX = /^(GET|POST|PUT|DELETE) \/\S+$/
const CODE_RX = /^[a-z][a-z0-9_]{0,63}$/
const RELEASE_RX = /^\d+\.\d+\.\d+$/

// ------------------------------------------------------------------ types

export type HttpAnswer = { status: number; headers: Record<string, string>; text: string }
export type FetchText = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<HttpAnswer>

export type ClientConfig = {
  endpoint: string
  pin: { kind: string }
  server_keys: readonly string[]
  e2e_keys: readonly string[]
}

export type Deps = {
  fetch: FetchText
  store: KV
  now: () => number // ms since the epoch
  sleep: (ms: number) => Promise<void>
  session: string // the harness session id (token_next:<session>, lease holder)
  random?: Random
  outbox?: Outbox | null
  claudeHash?: () => Promise<string> // sha256 hex of the Claude account id, "" when unknown
  config?: ClientConfig // a staging build only; the shipped shell passes nothing
  shellVersion?: string
  harness?: string
}

export type Result = {
  ok: boolean
  status: number | null
  body: unknown
  error: string | null
  fallback: string | null
  attempts: number
}
type Res = Result & { sent?: string }

export type GateState = { open: boolean; reason: string | null; min_shell: string | null }
export type AuthState = 'ok' | 'login' | 'locked'
type Block = { code: string; until: number | null; token_sha256: string | null }
type Settings = {
  offline: boolean
  services: Record<string, boolean>
  served: { channel: string; pins: Record<string, string | null> }
}
type CallOpts = { kind?: Kind; consent?: boolean; hook?: Hook }
type XOpts = { signed: boolean; retry: boolean; served?: readonly string[]; secret?: readonly string[] | null; token?: string }

const R = (ok: boolean, p: Partial<Result> = {}): Res => ({
  ok,
  status: p.status ?? null,
  body: p.body ?? null,
  error: p.error ?? null,
  fallback: p.fallback ?? null,
  attempts: p.attempts ?? 0,
})

// ------------------------------------------------------------------ helpers (ports of host/services.py)

/** client.json -> the parsed config, or an Error. Only https hostname endpoints (CA trust by the engine's TLS);
 * server_keys and e2e_keys are always required; an IPv4 endpoint with a pinned certificate is refused. */
export function parseConfig(c: unknown): {
  origin: string
  host: string
  port: number
  keys: ServerKeys
  e2eSend: Uint8Array
  fingerprint: string
} {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('config must be an object')
  const o = c as Record<string, unknown>
  const extra = Object.keys(o).filter((k) => !['endpoint', 'pin', 'server_keys', 'e2e_keys', 'client_id'].includes(k))
  if (extra.length) throw new Error('config has unknown fields: ' + extra.sort().join(', '))
  const ep = o.endpoint
  if (typeof ep !== 'string') throw new Error('config endpoint missing')
  const m = HOST_RX.exec(ep)
  if (!m || m[1].length > 253) throw new Error('config endpoint must be https://<hostname>[:<port>]')
  const port = m[2] ? Number(m[2]) : 443
  if (!(port > 0 && port < 65536)) throw new Error('config endpoint port is out of range')
  const pin = o.pin as Record<string, unknown> | undefined
  if (!pin || typeof pin !== 'object' || Object.keys(pin).length !== 1 || pin.kind !== 'ca') {
    throw new Error('a hostname endpoint needs pin {"kind": "ca"}')
  }
  const list = (v: unknown, what: string): string[] => {
    if (!Array.isArray(v) || v.length < 1 || v.length > 2 || new Set(v).size !== v.length) {
      throw new Error(`config ${what} must be one or two base64 public keys`)
    }
    if (!v.every((k) => typeof k === 'string' && KEY_RX.test(k))) throw new Error(`config ${what} must be base64 keys`)
    return v as string[]
  }
  const sk = list(o.server_keys, 'server_keys')
  const ek = list(o.e2e_keys, 'e2e_keys')
  const keys = serverKeys(sk)
  const e2eSend = b64Decode(ek[0])
  const doc = {
    ca: true,
    e2e_keys: ek,
    endpoint: `https://${m[1]}:${port}`,
    pins: [] as string[],
    server_keys: [...sk].sort(),
  }
  // host/services.py client_fingerprint: json.dumps(doc, sort_keys=True, separators=(",", ":"))
  const fingerprint = 'fp1:' + sha256Hex(utf8(JSON.stringify(doc)))
  return { origin: port === 443 ? `https://${m[1]}` : `https://${m[1]}:${port}`, host: m[1], port, keys, e2eSend, fingerprint }
}

const resolve = (s: any): any => {
  while (s && typeof s === 'object' && typeof s.$ref === 'string') {
    let node: any = CONTRACT
    for (const part of s.$ref.slice(2).split('/')) node = node?.[part]
    s = node
  }
  return s
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const cps = (s: string): number => Array.from(s).length
const sortedJson = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    isObj(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as any)[k]])) : x,
  )
const TYPES: Record<string, (v: unknown) => boolean> = {
  object: isObj,
  array: Array.isArray,
  string: (v) => typeof v === 'string',
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  null: (v) => v === null,
}

/** host/jsonschema_lite.py check_schema: the problems of `value` against the contract's schema subset. */
export function checkSchema(value: unknown, schema: unknown, where = '$'): string[] {
  const s = resolve(schema)
  if (!isObj(s)) return []
  if (Array.isArray(s.anyOf)) {
    const branches = s.anyOf.map((b: unknown) => checkSchema(value, b, where))
    if (!branches.some((b: string[]) => b.length === 0)) return [`${where}: does not match any anyOf branch`]
  }
  if (s.type !== undefined) {
    const ts = Array.isArray(s.type) ? s.type : [s.type]
    if (!ts.some((t: string) => TYPES[t]?.(value))) return [`${where}: type should be ${String(s.type)}`]
  }
  const out: string[] = []
  if ('const' in s && sortedJson(value) !== sortedJson(s.const)) out.push(`${where}: should be the constant`)
  if (Array.isArray(s.enum) && !s.enum.some((e: unknown) => sortedJson(e) === sortedJson(value))) {
    out.push(`${where}: not in the enum`)
  }
  if (typeof value === 'string') {
    if (typeof s.pattern === 'string' && !new RegExp(s.pattern).test(value)) out.push(`${where}: does not match`)
    if (typeof s.maxLength === 'number' && cps(value) > s.maxLength) out.push(`${where}: too long`)
    if (typeof s.minLength === 'number' && cps(value) < s.minLength) out.push(`${where}: too short`)
  }
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) out.push(`${where}: below the minimum`)
    if (typeof s.maximum === 'number' && value > s.maximum) out.push(`${where}: above the maximum`)
  }
  if (isObj(value)) {
    const props = isObj(s.properties) ? s.properties : {}
    for (const k of Array.isArray(s.required) ? s.required : []) if (!(k in value)) out.push(`${where}: missing ${k}`)
    for (const [k, v] of Object.entries(value)) {
      if (k in props) out.push(...checkSchema(v, props[k], `${where}.${k}`))
      else if (s.additionalProperties === false) out.push(`${where}: unexpected field ${k}`)
    }
  }
  if (Array.isArray(value)) {
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) out.push(`${where}: too many items`)
    if (typeof s.minItems === 'number' && value.length < s.minItems) out.push(`${where}: too few items`)
    if (s.uniqueItems && new Set(value.map(sortedJson)).size < value.length) out.push(`${where}: duplicate items`)
    if (s.items !== undefined) value.forEach((v, i) => out.push(...checkSchema(v, s.items, `${where}[${i}]`)))
  }
  return out
}

/** host/services.py _filter: drop properties the schema does not have (objects with additionalProperties false). */
export function filterBody(value: unknown, schema: unknown): unknown {
  const s = resolve(schema)
  if (!isObj(s)) return value
  if (isObj(value) && s.type === 'object') {
    const props = isObj(s.properties) ? s.properties : {}
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (k in props) out[k] = filterBody(v, props[k])
      else if (s.additionalProperties !== false) out[k] = v
    }
    return out
  }
  if (Array.isArray(value) && s.type === 'array' && s.items !== undefined) return value.map((v) => filterBody(v, s.items))
  return value
}

function limitProblems(route: any, body: unknown): string[] {
  const lim = route['x-limits'] ?? {}
  const out: string[] = []
  if (!isObj(body)) return out
  if (typeof lim.external_excerpts_total_chars === 'number') {
    const ex = Array.isArray(body.external_excerpts) ? body.external_excerpts : []
    if (ex.reduce((n: number, x: unknown) => n + (typeof x === 'string' ? cps(x) : 0), 0) > lim.external_excerpts_total_chars) {
      out.push('external_excerpts total too long')
    }
  }
  if (typeof lim.excerpt_total_chars === 'number') {
    const items = Array.isArray(body.items) ? body.items : []
    const total = items.reduce(
      (n: number, i: any) => n + (isObj(i) && typeof i.excerpt === 'string' ? cps(i.excerpt) : 0),
      0,
    )
    if (total > lim.excerpt_total_chars) out.push('excerpt total too long')
  }
  return out
}

const escapeRx = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

const ROUTES: { r: any; rx: RegExp }[] = (CONTRACT as any).routes.map((r: any) => {
  const params = r['x-params'] ?? {}
  let pat = ''
  for (const part of String(r.path).split(/(\{[a-z_]+\})/)) {
    if (part.startsWith('{') && part.endsWith('}')) {
      const p = String(params[part.slice(1, -1)] ?? '^[^/]+$')
      pat += '(' + p.replace(/^\^/, '').replace(/\$$/, '') + ')'
    } else pat += escapeRx(part)
  }
  return { r, rx: new RegExp('^' + pat + '$') }
})

export function matchRoute(method: string, path: string): any | null {
  for (const { r, rx } of ROUTES) if (r.method === method && rx.test(path)) return r
  return null
}

export function defaultKind(path: string): Kind {
  if (path === '/health') return 'health'
  if (path === '/updates/check' || path.startsWith('/packs/') || path === '/incidents' || path.startsWith('/metrics') || path === '/report') {
    return 'daily'
  }
  if (path.startsWith('/auth/')) return 'auth'
  if (path.startsWith('/router/')) return 'router'
  if (path.startsWith('/checkpoint/')) return 'checkpoint'
  if (path.startsWith('/limits/')) return 'run_limits'
  if (path.startsWith('/served/')) return 'served'
  return 'daily'
}

/** Metrics routes that upload nothing stay usable with the metrics switch off. */
function ungated(route: any): boolean {
  if (route['x-inventory']?.service !== 'metrics') return false
  return route.method === 'GET' || route.method === 'DELETE' || (route.method === 'POST' && route.path === '/metrics/weekly-mail')
}

function servedProps(route: any): string[] {
  const s = resolve(route?.responses?.['200'] ?? {})
  const props = isObj(s) && isObj(s.properties) ? s.properties : {}
  return Object.entries(props)
    .filter(([, v]) => isObj(v) && v['x-served'] === true)
    .map(([k]) => k)
}

const hashStrings = (v: unknown): unknown =>
  typeof v === 'string'
    ? 'sha256:' + sha256Hex(utf8(v))
    : Array.isArray(v)
      ? v.map(hashStrings)
      : isObj(v)
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, hashStrings(x)]))
        : v

function servedSummary(text: string): string | null {
  let b: unknown
  try {
    b = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObj(b)) return null
  const items = Array.isArray(b.items) ? b.items : []
  return JSON.stringify({
    role: b.role ?? null,
    phase: b.phase ?? null,
    version: b.version ?? null,
    channel: b.channel ?? null,
    pinned: b.pinned ?? null,
    items: items.filter(isObj).map((i: any) => ({ id: i.id ?? null, sha256: i.sha256 ?? null })),
  })
}

function redactFields(text: string | null, fields: readonly string[] | null | undefined): string | null {
  if (text == null || !fields || !fields.length) return text
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObj(o)) return null
  for (const f of fields) if (f in o) o[f] = '[redacted]'
  return JSON.stringify(o)
}

export function errorCode(parsed: unknown, status: number): string {
  if (isObj(parsed)) {
    let e: unknown = parsed.error
    if (isObj(e)) e = e.code
    if (typeof e === 'string' && CODE_RX.test(e)) return e
  }
  return `http_${status}`
}

const throttled = (status: number | null, code: string | null): boolean =>
  (status === 429 && code === 'rate_limited') || (status === 503 && code === 'busy')

/** A Retry-After in seconds, clamped to [1, cap]; `dflt` when absent or not a number. */
export function retrySeconds(value: unknown, dflt: number, cap: number): number {
  let secs = value == null || value === '' ? dflt : Number(value)
  if (!Number.isFinite(secs)) secs = dflt
  return Math.min(Math.max(secs, 1), cap)
}

/** The one notice for a closed gate; null when open or the reason is unknown. */
export function gateNotice(state: GateState): string | null {
  if (!state || state.open) return null
  const t = GATE_NOTICES[state.reason ?? '']
  return t ? t.replace('{min_shell}', state.min_shell || 'unknown') : null
}

const b64url = (b: Uint8Array): string => b64Encode(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const dec = new TextDecoder('utf-8')
const lower = (h: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]))
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

/** A total budget in ms on the injected clock (sleeping on the injected sleep counts against it). */
export class Deadline {
  private t0: number
  private now: () => number
  readonly total: number
  constructor(now: () => number, total: number) {
    this.now = now
    this.total = total
    this.t0 = now()
  }
  remaining(): number {
    return this.total - (this.now() - this.t0)
  }
}

// ------------------------------------------------------------------ the channel

export class Svc {
  readonly session: string
  private d: Required<Omit<Deps, 'outbox' | 'config'>> & { outbox: Outbox | null }
  private cfg: ReturnType<typeof parseConfig>
  private gs: GateState = { open: false, reason: 'unknown', min_shell: null }
  private holder: string
  private helloP: Promise<Result> | null = null
  private planRoutes: Set<string> | null = null
  private refused = new Set<string>()
  private notes: { ts: number; code: string; text: string }[] = []
  private lastNotice = new Map<string, number>()
  private authCache: { at: number; value: AuthState } | null = null
  private ready: Promise<void> | null = null
  private claude: string | null = null
  private servedBind = new Map<string, string>()

  constructor(deps: Deps) {
    this.session = String(deps.session)
    this.d = {
      fetch: deps.fetch,
      store: deps.store,
      now: deps.now,
      sleep: deps.sleep,
      session: this.session,
      random: deps.random ?? defaultRandom,
      outbox: deps.outbox ?? null,
      claudeHash: deps.claudeHash ?? (async () => ''),
      shellVersion: deps.shellVersion ?? 'dev',
      harness: deps.harness ?? 'claude-code',
    }
    this.cfg = parseConfig(deps.config ?? DEFAULT_CONFIG)
    this.holder = `${this.session}#${hex(this.d.random(4))}`
  }

  private get kv(): KV {
    return this.d.store
  }
  private nowS(): number {
    return Math.trunc(this.d.now() / 1000)
  }

  // ---------------- binding (host/services.py _bind_endpoint), once per instance
  private init(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        const tok = await getText(this.kv, KEYS.token)
        if (!tok) return
        const bound = await getText(this.kv, KEYS.endpoint)
        if (bound === null) {
          await safeSet(this.kv, KEYS.endpoint, this.cfg.fingerprint)
        } else if (bound !== this.cfg.fingerprint) {
          for (const k of SIGN_OUT_KEYS) await safeDelete(this.kv, k)
          for (const k of await tokenNextKeys(this.kv)) await safeDelete(this.kv, k)
          this.authCache = null
          this.notice('endpoint_changed')
        }
      })().catch(() => undefined)
    }
    return this.ready
  }

  // ---------------- settings (port of settings.json, in the store)
  async settings(): Promise<Settings> {
    const s: Settings = {
      offline: false,
      services: { ...SERVICE_DEFAULTS },
      served: { channel: 'stable', pins: Object.fromEntries(SERVED_ROLES.map((r) => [r, null])) },
    }
    const d = await safeGet(this.kv, KEYS.settings)
    if (!isObj(d)) {
      s.services.metrics = await this.metricsDefault({})
      return s
    }
    if (typeof d.offline === 'boolean') s.offline = d.offline
    if (isObj(d.services)) {
      for (const [k, v] of Object.entries(d.services)) if (k in SERVICE_DEFAULTS && typeof v === 'boolean') s.services[k] = v
    }
    s.services.metrics = await this.metricsDefault(d)
    const sv = isObj(d.served) ? d.served : {}
    if (typeof sv.channel === 'string' && SERVED_CHANNELS.includes(sv.channel)) s.served.channel = sv.channel
    if (isObj(sv.pins)) {
      for (const [k, v] of Object.entries(sv.pins)) {
        if (SERVED_ROLES.includes(k) && validVersion(v)) s.served.pins[k] = v as string
      }
    }
    return s
  }
  /**
   * The daily metrics upload is on unless the user chose off. A choice made with the savings commands is kept as
   * metrics_set; before that switch existed an explicit off was a stored metrics false after the upload had been on
   * (an enabled_day), or a "Not now" to the savings question. A stored false without either was only the old default.
   */
  private async metricsDefault(d: Record<string, any>): Promise<boolean> {
    const stored = isObj(d.services) ? d.services.metrics : undefined
    if (d.metrics_set === true && typeof stored === 'boolean') return stored
    if (stored === true) return true
    const prompt = await safeGet(this.kv, KEYS.savingsPrompt)
    if (isObj(prompt) && prompt.answer === 'not_now') return false
    const state = await safeGet(this.kv, KEYS.metricsState)
    if (stored === false && isObj(state) && typeof state.enabled_day === 'string' && state.enabled_day) return false
    return true
  }
  private async saveSettings(f: (s: Settings) => void, choseMetrics = false): Promise<boolean> {
    const s = await this.settings()
    f(s)
    const raw = await safeGet(this.kv, KEYS.settings)
    const set = choseMetrics || (isObj(raw) && raw.metrics_set === true)
    return safeSet(this.kv, KEYS.settings, set ? { ...s, metrics_set: true } : s)
  }
  async setOffline(on: boolean): Promise<boolean> {
    const ok = await this.saveSettings((s) => void (s.offline = Boolean(on)))
    this.setGate(on ? 'offline' : 'unknown')
    return ok
  }
  async setService(name: string, on: boolean): Promise<boolean> {
    if (!(name in SERVICE_DEFAULTS)) throw new Error(`unknown service ${name}`)
    return this.saveSettings((s) => void (s.services[name] = Boolean(on)), name === 'metrics')
  }
  async setServedPin(role: string, version: string | null): Promise<boolean> {
    if (!SERVED_ROLES.includes(role)) throw new Error('bad role')
    if (version !== null && !validVersion(version)) throw new Error('bad version')
    return this.saveSettings((s) => void (s.served.pins[role] = version))
  }
  async setServedChannel(channel: string): Promise<boolean> {
    if (!SERVED_CHANNELS.includes(channel)) throw new Error('bad channel')
    return this.saveSettings((s) => void (s.served.channel = channel))
  }
  private async serviceOn(name: string): Promise<boolean> {
    if (name === 'auth') return true
    return Boolean((await this.settings()).services[name])
  }

  // ---------------- gate, auth state, notices
  private setGate(reason: string | null, minShell: string | null = null): void {
    this.gs = { open: reason === null, reason, min_shell: minShell }
  }
  gateState(): GateState {
    return { ...this.gs }
  }
  notices(): { ts: number; code: string; text: string }[] {
    return this.notes.map((n) => ({ ...n }))
  }
  private notice(code: string): void {
    const now = this.d.now()
    const last = this.lastNotice.get(code)
    if (last !== undefined && now - last < NOTICE_EVERY_MS) return
    this.lastNotice.set(code, now)
    this.notes.push({ ts: now, code, text: NOTICE_TEXT[code] ?? `agent-services stopped: ${code}` })
  }

  private async block(): Promise<Block | null> {
    const b = await safeGet(this.kv, KEYS.block)
    if (!isObj(b) || typeof b.code !== 'string') return null
    return { code: b.code, until: num(b.until), token_sha256: typeof b.token_sha256 === 'string' ? b.token_sha256 : null }
  }
  private async setBlock(code: string, seconds: number | null, token: string | null): Promise<void> {
    await safeSet(this.kv, KEYS.block, {
      code,
      until: seconds === null ? null : this.d.now() + seconds * 1000,
      token_sha256: token ? sha256Hex(utf8(token)) : null,
    })
    this.authCache = null
  }

  /** The active block's code (shared by all sessions), or null. A block belongs to the token it was set for: a newer
   * sign-in (another token) is not blocked by it. An expired lock allows one new attempt. */
  async blocked(): Promise<string | null> {
    const b = await this.block()
    if (!b) return null
    if (b.token_sha256) {
      const tok = await getText(this.kv, KEYS.token)
      if (tok && sha256Hex(utf8(tok)) !== b.token_sha256) return null
    }
    if (b.until !== null && this.d.now() >= b.until) return null
    return b.code
  }

  /** 3.9: "login" (no valid sign-in), "locked" (a 423 or locked_out block in force), else "ok". Read from the store,
   * at most every AUTH_STATE_TTL_MS unless `fresh`. */
  async authState(fresh = false): Promise<AuthState> {
    const now = this.d.now()
    if (!fresh && this.authCache && now - this.authCache.at < AUTH_STATE_TTL_MS) return this.authCache.value
    await this.init()
    let value: AuthState = 'ok'
    const tok = await getText(this.kv, KEYS.token)
    const acc = await getText(this.kv, KEYS.accountId)
    const exp = num(await safeGet(this.kv, KEYS.expiresAt))
    if (!tok || !acc || (exp !== null && now / 1000 >= exp)) value = 'login'
    else {
      const code = await this.blocked()
      if (code === 'account_locked' || code === 'locked_out') value = 'locked'
      else if (code) value = 'login'
    }
    this.authCache = { at: now, value }
    return value
  }

  /** The line tools answer in auth fail (3.9), or null while signed in. */
  async authLine(): Promise<string | null> {
    const st = await this.authState()
    return st === 'ok' ? null : st === 'locked' ? LOCKED_LINE : PAUSED_LINE
  }

  async status(): Promise<Record<string, unknown>> {
    await this.init()
    const tok = await getText(this.kv, KEYS.token)
    const acc = await getText(this.kv, KEYS.accountId)
    const exp = num(await safeGet(this.kv, KEYS.expiresAt))
    const logged = Boolean(tok && acc) && (exp === null || this.d.now() / 1000 < exp)
    return {
      logged_in: logged,
      account_id: logged ? acc : null,
      plan: logged ? await getText(this.kv, KEYS.plan) : null,
      expires_at: logged ? exp : null,
      offline: (await this.settings()).offline,
      blocked: await this.blocked(),
      gate: this.gateState(),
    }
  }

  // ---------------- shared cool-down and the bad_envelope counter
  private async cooling(): Promise<boolean> {
    const c = await safeGet(this.kv, KEYS.cool)
    return isObj(c) && typeof c.until === 'number' && this.d.now() < c.until
  }
  private async throttle(secs: number): Promise<void> {
    const now = this.d.now()
    const c = await safeGet(this.kv, KEYS.cool)
    const until0 = isObj(c) && typeof c.until === 'number' ? c.until : 0
    const since = isObj(c) && typeof c.since === 'number' && until0 > now - 60000 ? c.since : now
    await safeSet(this.kv, KEYS.cool, { until: Math.max(until0, now + secs * 1000), since })
    if (now - since >= THROTTLE_NOTICE_AFTER * 1000) this.notice('rate_limited')
  }
  private async unthrottle(): Promise<void> {
    if ((await safeGet(this.kv, KEYS.cool)) !== undefined) await safeDelete(this.kv, KEYS.cool)
    if ((await safeGet(this.kv, KEYS.badEnvelope)) !== undefined) await safeDelete(this.kv, KEYS.badEnvelope)
  }
  private async envelopeBlocked(): Promise<boolean> {
    const b = await safeGet(this.kv, KEYS.badEnvelope)
    return isObj(b) && typeof b.n === 'number' && typeof b.at === 'number' && b.n >= BAD_ENVELOPE_LIMIT && this.d.now() - b.at < BAD_ENVELOPE_WINDOW_MS
  }
  private async badEnvelope(): Promise<number> {
    const now = this.d.now()
    const b = await safeGet(this.kv, KEYS.badEnvelope)
    const n = (isObj(b) && typeof b.n === 'number' && typeof b.at === 'number' && now - b.at < BAD_ENVELOPE_WINDOW_MS ? b.n : 0) + 1
    await safeSet(this.kv, KEYS.badEnvelope, { n, at: now })
    return n
  }
  private distrust(): void {
    this.notice('server_unverified')
    this.setGate('unverified')
  }

  // ---------------- transport: one token, retries inside the deadline
  private async within<T>(p: Promise<T>, ms: number): Promise<{ v: T } | { err: unknown } | null> {
    if (ms <= 0) return null
    const guarded = p.then(
      (v) => ({ v }),
      (err) => ({ err }),
    )
    return Promise.race([guarded, this.d.sleep(ms).then(() => null)])
  }

  private async backoff(attempts: number, deadline: Deadline): Promise<boolean> {
    if (attempts >= MAX_ATTEMPTS) return false
    const delay = 500 * 2 ** (attempts - 1) * (1 + (this.d.random(1)[0] / 255) * 0.25)
    if (delay >= deadline.remaining()) return false
    await this.d.sleep(delay)
    return true
  }

  private async signing(token: string, method: string, wire: string, body: string): Promise<Record<string, string> | null> {
    const seedB64 = await getText(this.kv, KEYS.deviceKey)
    let seed: Uint8Array
    try {
      seed = b64Decode(seedB64 ?? '')
    } catch {
      return null
    }
    if (seed.length !== 32) return null
    if (this.claude === null) this.claude = await this.d.claudeHash().catch(() => '')
    return signedHeaders(
      method,
      wire,
      body,
      {
        token,
        accountId: (await getText(this.kv, KEYS.accountId)) ?? '',
        deviceId: (await getText(this.kv, KEYS.deviceId)) ?? '',
        deviceSeed: seed,
        claudeHash: this.claude ?? '',
      },
      this.nowS(),
      this.d.random,
    )
  }

  private log(service: string, method: string, wire: string, body: string | null, outer?: string, bytes?: number): RequestLine | null {
    return this.d.outbox?.request({ service, method, route: wire.split('?', 1)[0], body, outerPath: outer, outerBytes: bytes }) ?? null
  }
  private logged(line: RequestLine | null, status: number | null, text: string | null, error: string | null): void {
    if (line && this.d.outbox) this.d.outbox.answer(line, status, text, error)
  }

  private async attempt(method: string, wire: string, body: string | null, service: string, deadline: Deadline, o: XOpts): Promise<Res> {
    let attempts = 0
    let last: Res = R(false, { error: 'timeout' })
    const plain = wire.split('?', 1)[0] === '/health'
    for (;;) {
      const remaining = deadline.remaining()
      if (remaining <= 0) {
        last = R(false, { error: 'timeout', attempts })
        break
      }
      if (!plain && (await this.envelopeBlocked())) {
        this.setGate('unavailable')
        last = R(false, { error: 'unavailable', attempts })
        break
      }
      const inner: Record<string, string> = {}
      if (method === 'POST') inner['Content-Type'] = 'application/json'
      if (o.token) {
        const sh = await this.signing(o.token, method, wire, body ?? '')
        if (!sh) {
          last = R(false, { error: 'not_logged_in', attempts })
          break
        }
        Object.assign(inner, sh)
      }
      const challenge = hex(this.d.random(16))
      let outer: string
      let headers: Record<string, string>
      let outBody: string | undefined
      let ctx: ReturnType<typeof sealRequest>['ctx'] | null = null
      if (plain) {
        outer = wire
        headers = { Accept: 'application/json', 'X-Agent-Challenge': challenge }
      } else {
        try {
          const s = sealRequest(this.cfg.e2eSend, method, wire, inner, body, this.nowS(), challenge, {
            encoding: 'base64',
            random: this.d.random,
          })
          outer = s.outer
          headers = { ...s.headers, Accept: E2E_CONTENT_TYPE_B64 }
          outBody = s.body as string
          ctx = s.ctx
        } catch {
          last = R(false, { error: 'e2e_failed', attempts }) // a request that cannot be sealed is never sent
          break
        }
      }
      attempts++
      const line = this.log(service, method, wire, body, plain ? undefined : outer, outBody?.length)
      const got = await this.within(
        this.d.fetch(this.cfg.origin + outer, { method: plain ? 'GET' : 'POST', headers, ...(outBody !== undefined ? { body: outBody } : {}) }),
        remaining,
      )
      if (got === null) {
        this.logged(line, null, null, 'timeout')
        last = R(false, { error: 'timeout', attempts })
        break
      }
      if ('err' in got) {
        this.logged(line, null, null, 'connection_failed')
        last = R(false, { error: 'connection_failed', attempts })
        if (o.retry && (await this.backoff(attempts, deadline))) continue
        break
      }
      const status = Number(got.v?.status)
      const rh = lower(got.v?.headers ?? {})
      const text = typeof got.v?.text === 'string' ? got.v.text : ''
      if (text.length > MAX_RESPONSE_CHARS) {
        this.logged(line, null, null, 'response_too_large')
        last = R(false, { error: 'response_too_large', attempts })
        break
      }
      const bad = verifyResponse(this.cfg.keys, plain ? 'GET' : 'POST', outer, challenge, status, rh, text, this.nowS())
      if (bad) {
        // never used, never logged as text: only the error code reaches the outbox
        this.logged(line, null, null, bad)
        if (bad === 'unsigned_response' && status >= 500) {
          // the edge's own error page (origin down): unreachable, retried like one
          last = R(false, { error: 'server_unreachable', attempts })
          if (o.retry && RETRY_STATUS.includes(status) && (await this.backoff(attempts, deadline))) continue
          if (rh['retry-after'] !== undefined) await this.throttle(retrySeconds(rh['retry-after'], EDGE_COOL_SECONDS, UNSIGNED_RETRY_MAX))
          break
        }
        if (bad === 'unsigned_response' && EDGE_STATUS.includes(status)) {
          // the edge's own refusal (WAF, rate rule): not a forgery; back off with a capped Retry-After
          last = R(false, { error: 'server_unreachable', attempts })
          await this.throttle(retrySeconds(rh['retry-after'], EDGE_COOL_SECONDS, UNSIGNED_RETRY_MAX))
          break
        }
        last = R(false, { error: bad, attempts })
        this.distrust()
        break
      }
      // signed. The signature covers status and body, not the outer headers: an outer Retry-After is capped; a sealed
      // answer's own headers replace them and are authenticated.
      let ist = status
      let ih: Record<string, string> = {}
      if (rh['retry-after'] !== undefined) ih['retry-after'] = String(retrySeconds(rh['retry-after'], 1, UNSIGNED_RETRY_MAX))
      let data = text
      let sealed = false
      if (ctx) {
        if (answerEncoding(status, rh) === 'base64') {
          try {
            const op = openResponse(ctx, text)
            ist = op.status
            ih = lower(op.headers)
            data = dec.decode(op.body)
            sealed = true
          } catch {
            this.logged(line, null, null, 'undecryptable_response')
            last = R(false, { error: 'undecryptable_response', attempts })
            this.distrust()
            break
          }
        } else if (status >= 200 && status < 300) {
          // a signed success that is not sealed is never used for a sealed request
          this.logged(line, null, null, 'undecryptable_response')
          last = R(false, { error: 'undecryptable_response', attempts })
          this.distrust()
          break
        }
      }
      let parsed: unknown = null
      if (data) {
        try {
          parsed = JSON.parse(data)
        } catch {
          parsed = null
        }
      }
      const ok = ist >= 200 && ist < 300
      let shown: string | null = data
      if (ok && o.served && o.served.length && isObj(parsed)) {
        shown = JSON.stringify(Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, o.served!.includes(k) ? hashStrings(v) : v])))
      }
      if (ok && wire.split('?', 1)[0] === PREFIX + SERVED_ROUTE) shown = servedSummary(data)
      if (o.secret) shown = redactFields(shown, o.secret)
      this.logged(line, ist, shown, null)
      if (ok) {
        last = { ...R(true, { status: ist, body: parsed, attempts }), sent: o.token }
        await this.unthrottle()
        break
      }
      const code = errorCode(parsed, ist)
      last = { ...R(false, { status: ist, body: parsed, error: code, attempts }), sent: o.token }
      if (!sealed && ist === 400 && code === 'bad_envelope') {
        // the server could not open it; each one counts against this IP's failure budget
        if ((await this.badEnvelope()) >= BAD_ENVELOPE_LIMIT) {
          this.notice('bad_envelope')
          this.setGate('unavailable')
        }
        break
      }
      if (ist === 401 && o.signed) break // recovered (or not) by the caller: 3.3 item 4
      if (ist === 423) {
        await this.setBlock(code, BLOCK_SECONDS.account_locked, o.token ?? null)
        this.notice(code)
        if (o.signed) this.setGate('locked')
        break
      }
      if (ist === 429 && code === 'locked_out') {
        await this.setBlock(code, BLOCK_SECONDS.locked_out, o.token ?? null)
        this.notice(code)
        if (o.signed) this.setGate('locked')
        break
      }
      if (o.signed && ist === 426 && code === 'upgrade_required') {
        const ms = isObj(parsed) && typeof parsed.min_shell === 'string' && RELEASE_RX.test(parsed.min_shell) ? parsed.min_shell : null
        this.setGate('upgrade', ms)
        break
      }
      if (o.signed && ist === 428 && code === 'hello_required') {
        this.setGate('unknown')
        break
      }
      if (throttled(ist, code)) {
        // the server is up but asks for less traffic: never waited out here; a shared cool-down instead
        await this.throttle(retrySeconds(ih['retry-after'], 1, THROTTLE_MAX_SECONDS))
        break
      }
      if (o.retry && RETRY_STATUS.includes(ist) && (await this.backoff(attempts, deadline))) continue
      break
    }
    return last
  }

  // ---------------- signed exchange with the 401 rules of 3.3 item 4
  private async exchange(method: string, wire: string, body: string | null, service: string, deadline: Deadline, o: Omit<XOpts, 'token'> & { token?: string }): Promise<Res> {
    if (!o.signed) return this.attempt(method, wire, body, service, deadline, o)
    const tok = o.token ?? (await getText(this.kv, KEYS.token))
    if (!tok) return R(false, { error: 'not_logged_in' })
    const first = await this.attempt(method, wire, body, service, deadline, { ...o, token: tok })
    if (first.status !== 401) return first
    return this.recover401(method, wire, body, service, deadline, o, tok, first)
  }

  private async recover401(method: string, wire: string, body: string | null, service: string, deadline: Deadline, o: XOpts, sent: string, first: Res): Promise<Res> {
    const failed = new Set<string>([sent])
    const tried = new Set<string>([sent])
    let last = first
    let attempts = first.attempts
    const send = async (t: string): Promise<Res | null> => {
      tried.add(t)
      const r = await this.attempt(method, wire, body, service, deadline, { ...o, token: t })
      attempts += r.attempts
      if (r.status !== 401) return { ...r, attempts }
      failed.add(t)
      last = { ...r, attempts }
      return null
    }
    for (let round = 0; round < 3; round++) {
      // 1. another session may have written a new token: retry once with it
      const cur = await getText(this.kv, KEYS.token)
      if (cur && !tried.has(cur)) {
        const r = await send(cur)
        if (r) return r
      }
      // 2. the token sent was replaced by a confirmed rotation moments ago: rotated meanwhile, never a sign-out
      const prev = await getText(this.kv, KEYS.tokenPrev)
      const at = num(await safeGet(this.kv, KEYS.rotatedAt))
      const inGrace =
        prev !== null && at !== null && this.d.now() - at < TOKEN_PREV_GRACE_MS && [...failed].some((t) => sha256Hex(utf8(t)) === prev)
      if (inGrace) {
        const now = await getText(this.kv, KEYS.token)
        if (now && !tried.has(now)) {
          const r = await send(now)
          if (r) return r
        }
        return last // inside the grace a 401 never signs out; the next request decides with the current token
      }
      // 3. an unconfirmed rotation (its answer lost) of any session: each token_next once; one that works is promoted
      for (const k of await tokenNextKeys(this.kv)) {
        const v = await getText(this.kv, k)
        if (!v || tried.has(v)) continue
        const r = await send(v)
        if (r) {
          if (r.ok) {
            const held = await getText(this.kv, KEYS.token)
            if (!held || failed.has(held)) {
              await safeSet(this.kv, KEYS.token, v)
              await safeSet(this.kv, KEYS.tokenPrev, sha256Hex(utf8(held ?? sent)))
              await safeSet(this.kv, KEYS.rotatedAt, this.d.now())
              await safeDelete(this.kv, k)
              this.authCache = null
            }
          }
          return r
        }
      }
      // 4. delete only if the stored token is still one that got the 401 (re-read right before the delete)
      const held = await getText(this.kv, KEYS.token)
      if (held && !failed.has(held)) continue // changed meanwhile: start again at step 1
      await this.revoked(last.error ?? 'http_401', held)
      return last
    }
    return last // still changing after two restarts: nothing deleted
  }

  /** An unrecovered 401: drop the token and every token_next, block that token, close the gate (auth fail). */
  private async revoked(code: string, held: string | null): Promise<void> {
    if (held) {
      const again = await getText(this.kv, KEYS.token)
      if (again === held || again === null) {
        for (const k of CREDENTIAL_KEYS) await safeDelete(this.kv, k)
      }
    }
    for (const k of await tokenNextKeys(this.kv)) await safeDelete(this.kv, k)
    if (held && (await getText(this.kv, KEYS.token)) === held) await this.setBlock(code, null, held) // the delete was refused
    this.authCache = null
    this.planRoutes = null
    this.refused.clear()
    this.notice(code)
    this.setGate('login')
  }

  // ---------------- expiry and rotation
  private async ensureFresh(deadline: Deadline, rotate: boolean): Promise<string | null> {
    const exp = num(await safeGet(this.kv, KEYS.expiresAt))
    if (exp === null) return null
    const now = this.d.now() / 1000
    if (now >= exp) {
      const tok = await getText(this.kv, KEYS.token)
      if (tok && (await getText(this.kv, KEYS.token)) === tok) {
        for (const k of CREDENTIAL_KEYS) await safeDelete(this.kv, k)
      }
      this.authCache = null
      this.setGate('login')
      this.notice('login_expired')
      return 'login_expired'
    }
    if (exp - ROTATE_MARGIN_S > now || !rotate) return null
    return this.rotate(deadline)
  }

  /** Rotation under a best-effort lease (3.3 item 4). The new token waits under token_next:<session> until the
   * server confirms it, so two sessions rotating at once never overwrite each other's unconfirmed token. */
  private async rotate(deadline: Deadline): Promise<string | null> {
    const lease = await safeGet(this.kv, KEYS.rotateLease)
    if (isObj(lease) && lease.holder !== this.holder && typeof lease.until === 'number' && lease.until > this.d.now()) return null
    await safeSet(this.kv, KEYS.rotateLease, { holder: this.holder, until: this.d.now() + LEASE_MS })
    await this.d.sleep(LEASE_SETTLE_MS)
    const mine = await safeGet(this.kv, KEYS.rotateLease)
    if (!isObj(mine) || mine.holder !== this.holder) return null
    try {
      const start = await getText(this.kv, KEYS.token)
      if (!start) return 'not_logged_in'
      const nk = tokenNextKey(this.session)
      // an earlier rotation the server may have committed (its answer lost) is offered again, not replaced
      const fresh = (await getText(this.kv, nk)) ?? b64url(this.d.random(32))
      if (!(await safeSet(this.kv, nk, fresh))) return null
      const res = await this.exchange('POST', PREFIX + '/auth/rotate', JSON.stringify({ new_token_hash: sha256Hex(utf8(fresh)) }), 'auth', deadline, {
        signed: true,
        retry: true,
        token: start,
      })
      if (res.ok && isObj(res.body) && res.body.expires_at != null) {
        const held = await getText(this.kv, KEYS.token)
        // write only while the stored token is still the one this rotation started from or the one it was sent with;
        // otherwise another session has rotated past it and this answer is stale
        if (held === start || (res.sent && held === res.sent)) {
          await safeSet(this.kv, KEYS.token, fresh)
          await safeSet(this.kv, KEYS.tokenPrev, sha256Hex(utf8(res.sent ?? start)))
          await safeSet(this.kv, KEYS.rotatedAt, this.d.now())
          await safeSet(this.kv, KEYS.expiresAt, res.body.expires_at)
        }
        await safeDelete(this.kv, nk)
        this.authCache = null
      }
      if (res.status === 401 || (await this.blocked())) return res.error
      return null
    } finally {
      const l = await safeGet(this.kv, KEYS.rotateLease)
      if (isObj(l) && l.holder === this.holder) await safeDelete(this.kv, KEYS.rotateLease)
    }
  }

  // ---------------- handshake (POST /auth/hello) and plan
  private deadline(kind: Kind, hook: Hook): Deadline {
    return new Deadline(this.d.now, Math.min(TIMEOUTS_MS[kind], HOOK_BUDGET_MS[hook]))
  }

  /** One signed POST /auth/hello at a time; opens or closes the gate. Never throws. */
  handshake(hook: Hook = 'background'): Promise<Result> {
    if (!this.helloP) {
      this.helloP = this.hello(this.deadline('auth', hook), hook === 'background')
        .catch(() => {
          this.setGate('unavailable')
          return R(false, { error: 'failed' }) as Result
        })
        .finally(() => {
          this.helloP = null
        })
    }
    if (hook === 'background') return this.helloP
    // A hook never waits out a handshake begun with a longer budget (say session.start's background one): it waits
    // its own budget at most, and the handshake goes on.
    return this.within(this.helloP, Math.min(TIMEOUTS_MS.auth, HOOK_BUDGET_MS[hook])).then((r) =>
      r && 'v' in r ? r.v : (R(false, { error: 'timeout', fallback: FALLBACKS.auth }) as Result),
    )
  }

  private async hello(d: Deadline, rotate: boolean): Promise<Result> {
    await this.init()
    if ((await this.settings()).offline) {
      this.setGate('offline')
      return R(false, { error: 'offline' })
    }
    const st = await this.authState(true)
    if (st !== 'ok') {
      this.setGate(st)
      return R(false, { error: (await this.blocked()) ?? 'not_logged_in' })
    }
    if (await this.cooling()) return R(false, { error: 'rate_limited' }) // the gate stays as it is
    const err = await this.ensureFresh(d, rotate)
    if (err) {
      this.setGate(err === 'account_locked' || err === 'locked_out' ? 'locked' : 'login')
      return R(false, { error: err })
    }
    const res = await this.exchange('POST', PREFIX + HELLO_PATH, JSON.stringify({ shell: this.d.shellVersion, contract: API }), 'auth', d, {
      signed: true,
      retry: false,
    })
    const b = res.body
    if (res.ok) {
      if (
        res.status === 200 &&
        isObj(b) &&
        Object.keys(b).sort().join(',') === 'accept,plan,routes' &&
        b.accept === true &&
        PLAN_VALUES.includes(b.plan as string) &&
        Array.isArray(b.routes) &&
        b.routes.every((r) => typeof r === 'string' && ROUTE_KEY_RX.test(r))
      ) {
        await safeSet(this.kv, KEYS.plan, b.plan)
        this.planRoutes = new Set(b.routes as string[])
        this.refused.clear()
        this.setGate(null)
        return strip(res)
      }
      this.setGate('unavailable')
      return R(false, { status: res.status, error: 'bad_response', attempts: res.attempts })
    }
    if (res.status === 426 && res.error === 'upgrade_required') {
      // attempt() closed the gate with the minimum
    } else if (res.status === 401 || res.error === 'not_logged_in') this.setGate('login')
    else if (res.status === 423 || (res.status === 429 && res.error === 'locked_out')) this.setGate('locked')
    else if (throttled(res.status, res.error)) {
      // rate limited or busy: the server is up; the gate keeps its state
    } else if (this.gs.reason === 'unverified' || this.gs.reason === 'unavailable') {
      // attempt() closed it already
    } else this.setGate('unavailable')
    return strip(res)
  }

  /** Session start (background): the handshake, then the plan and the notice for the status line. */
  async sessionStart(): Promise<{ plan: string | null; notice: string | null; gate: GateState; error?: string | null }> {
    const r = await this.handshake('background')
    const st = this.gateState()
    if (st.open) {
      const p = isObj(r.body) && typeof r.body.plan === 'string' ? r.body.plan : await getText(this.kv, KEYS.plan)
      return { plan: p, notice: p === 'guard' ? PLAN_NOTICE : null, gate: st }
    }
    return { plan: (await this.status()).plan as string | null, notice: gateNotice(st), gate: st, error: r.error ?? st.reason }
  }

  /** GET /auth/plan: store the plan, keep the routes in memory, clear the refused set. */
  async planInfo(hook: Hook = 'background'): Promise<Result> {
    if ((await this.settings()).offline) return R(false, { error: 'offline' })
    if ((await this.authState()) !== 'ok') return R(false, { error: 'auth_failed' })
    if (!this.gs.open) return R(false, { error: 'inactive' })
    const d = this.deadline('auth', hook)
    const err = await this.ensureFresh(d, hook === 'background')
    if (err) return R(false, { error: err })
    const res = await this.exchange('GET', PREFIX + PLAN_PATH, null, 'auth', d, { signed: true, retry: true })
    if (!res.ok) return strip(res)
    const b = res.body
    if (!isObj(b) || !PLAN_VALUES.includes(b.plan as string) || !Array.isArray(b.routes) || !b.routes.every((r) => typeof r === 'string' && ROUTE_KEY_RX.test(r))) {
      return R(false, { status: res.status, error: 'bad_response', attempts: res.attempts })
    }
    await safeSet(this.kv, KEYS.plan, b.plan)
    this.planRoutes = new Set(b.routes as string[])
    this.refused.clear()
    return strip(res)
  }

  /** Open the gate when it can be: a signed-in session whose gate is unknown (or whose lock expired) shakes hands
   * first, inside the caller's deadline. */
  private async ensureOpen(d: Deadline, hook: Hook): Promise<boolean> {
    if (this.gs.open) return true
    if (!['unknown', 'login', 'locked'].includes(this.gs.reason ?? '')) return false // unverified, unavailable, upgrade, offline
    const hello = this.handshake(hook)
    const got = await this.within(hello, d.remaining())
    return got !== null && this.gs.open
  }

  // ---------------- calls
  private prepare(method: string, path: string, body: unknown): { route: any; sub: string; wire: string; data: string | null } | string {
    method = (method || '').toUpperCase()
    let p = path || ''
    if (p.startsWith(PREFIX + '/')) p = p.slice(PREFIX.length)
    const qi = p.indexOf('?')
    const sub = qi < 0 ? p : p.slice(0, qi)
    const query = qi < 0 ? '' : p.slice(qi + 1)
    const route = matchRoute(method, sub)
    if (!route) return 'unknown_route'
    let wire = sub === '/health' ? sub : PREFIX + sub
    if (query) wire += '?' + query
    let data: string | null = null
    if (method === 'POST') {
      const schema = route.request
      const b = schema ? filterBody(body ?? {}, schema) : (body ?? {})
      if ((schema ? checkSchema(b, schema) : []).length || limitProblems(route, b).length) return 'invalid_body'
      data = JSON.stringify(b)
      if (utf8(data).length > BODY_LIMIT) return 'invalid_body'
    }
    return { route, sub, wire, data }
  }

  /** The body as it would be sent, logged as a preview; nothing is sent. */
  preview(method: string, path: string, body?: unknown): string | null {
    const prep = this.prepare(method, path, body)
    if (typeof prep === 'string') return null
    this.d.outbox?.preview(prep.route['x-inventory'].service, prep.route.method, prep.wire.split('?', 1)[0], prep.data)
    return prep.data
  }

  /** One request through the channel. Never throws; every failure carries the kind's fallback. */
  async call(method: string, path: string, body?: unknown, opts: CallOpts = {}): Promise<Result> {
    const p = path || ''
    const sub0 = (p.startsWith(PREFIX + '/') ? p.slice(PREFIX.length) : p).split('?', 1)[0]
    const kind: Kind = opts.kind ?? defaultKind(sub0)
    const hook: Hook = opts.hook ?? 'tool'
    const fb = FALLBACKS[kind] ?? null
    const fail = (error: string, extra: Partial<Result> = {}): Result => strip({ ...R(false, extra), error, fallback: fb })
    try {
      if (!(kind in TIMEOUTS_MS)) return fail('unknown_kind')
      if (hook === 'prompt') return fail('no_network')
      const d = this.deadline(kind, hook)
      const prep = this.prepare(method, path, body)
      if (typeof prep === 'string') return fail(prep)
      const { route, sub, wire, data } = prep
      await this.init()
      if ((await this.settings()).offline) {
        this.setGate('offline')
        return fail('offline')
      }
      const signed = sub !== '/health'
      const key = `${route.method} ${route.path}`
      if (signed) {
        if ((await this.authState()) !== 'ok') return fail('auth_failed') // 3.9: nothing is sent
        if (await this.cooling()) return fail('rate_limited') // shared: every session backs off together
        if (!(await this.ensureOpen(d, hook))) return fail('inactive')
      }
      const service = route['x-inventory'].service
      if (!(await this.serviceOn(service)) && !ungated(route) && !(opts.consent && CONSENT_ROUTES.includes(key))) return fail('service_off')
      if (signed && (this.refused.has(key) || (this.planRoutes !== null && !this.planRoutes.has(key)))) return fail('not_in_plan')
      if (await this.cooling()) return fail('rate_limited') // a Retry-After in force: nothing sent, the fallback runs
      if (signed) {
        const blk = await this.blocked()
        if (blk) return fail(blk)
        if (!(await getText(this.kv, KEYS.token)) || !(await getText(this.kv, KEYS.accountId))) return fail('not_logged_in')
        const err = await this.ensureFresh(d, hook === 'background')
        if (err) return fail(err)
      }
      const res = await this.exchange(route.method, wire, data, service, d, {
        signed,
        retry: true,
        served: servedProps(route),
        secret: route['x-response-secret'] ?? null,
      })
      if (!res.ok) {
        if (res.status === 403 && res.error === 'not_in_plan') this.refused.add(key)
        return { ...strip(res), fallback: fb }
      }
      return strip(res)
    } catch {
      return fail('failed')
    }
  }

  health(hook: Hook = 'background'): Promise<Result> {
    return this.call('GET', '/health', undefined, { hook })
  }

  /** One phase of a role's served items. The first successful fetch of (session_ref, role) binds this session to
   * the version served; later fetches send it as the pin. The texts stay in memory (the result) only. */
  async fetchServed(sessionRef: string, role: string, phase: string, hook: Hook = 'tool'): Promise<Result> {
    const key = `${sessionRef}\n${role}`
    const s = await this.settings()
    const bound = this.servedBind.get(key)
    const pin = bound ?? (SERVED_ROLES.includes(role) ? s.served.pins[role] ?? null : null)
    const body = { session_ref: sessionRef, role, phase, pinned_version: pin, channel: s.served.channel }
    let res = await this.call('POST', SERVED_ROUTE, body, { hook })
    if (!res.ok && res.status === 409 && res.error === 'session_required') {
      const opened = await this.call('POST', '/served/session', { session_ref: sessionRef, role }, { hook })
      if (opened.ok) res = await this.call('POST', SERVED_ROUTE, body, { hook })
    }
    if (!res.ok) return res
    const b: any = res.body
    const schema = matchRoute('POST', SERVED_ROUTE)?.responses?.['200']
    if (
      checkSchema(b, schema).length ||
      b.role !== role ||
      b.phase !== phase ||
      (pin !== null && b.version !== pin) ||
      b.items.some((i: any) => sha256Hex(utf8(i.text)) !== i.sha256)
    ) {
      return R(false, { status: res.status, error: 'bad_response', fallback: FALLBACKS.served, attempts: res.attempts })
    }
    if (!this.servedBind.has(key)) this.servedBind.set(key, b.version)
    return res
  }

  endServedSession(sessionRef: string): void {
    for (const k of [...this.servedBind.keys()]) if (k.startsWith(sessionRef + '\n')) this.servedBind.delete(k)
  }

  // ---------------- sign-in (3.4): the login routes, the only signed-out traffic besides /health
  private async loginGate(): Promise<Result | null> {
    if ((await this.settings()).offline) return R(false, { error: 'offline' })
    const b = await this.block()
    // a locked_out block (failed signed requests) never stops a fresh sign-in; a locked account does
    if (b && b.code === 'account_locked' && (b.until === null || this.d.now() < b.until)) return R(false, { error: 'account_locked' })
    if (await this.cooling()) return R(false, { error: 'rate_limited' })
    return null
  }

  /** POST /auth/login/start {email}, sealed through /svc/v1/auth/login/x; the email waits as pending for 10 minutes
   * so any session may finish the sign-in. */
  async loginStart(email: string, hook: Hook = 'tool'): Promise<Result> {
    const g = await this.loginGate()
    if (g) return g
    if (typeof email !== 'string' || email.length < 3 || email.length > 254 || !email.includes('@')) return R(false, { error: 'invalid_body' })
    const res = await this.exchange('POST', PREFIX + '/auth/login/start', JSON.stringify({ email }), 'auth', this.deadline('auth', hook), {
      signed: false,
      retry: true,
    })
    if (res.ok) await safeSet(this.kv, KEYS.loginPending, { email, until: this.d.now() + LOGIN_PENDING_MS })
    return strip(res)
  }

  /** The pending email of a sign-in started in any session, or null. */
  async pendingEmail(): Promise<string | null> {
    const p = await safeGet(this.kv, KEYS.loginPending)
    return isObj(p) && typeof p.email === 'string' && typeof p.until === 'number' && this.d.now() < p.until ? p.email : null
  }

  private async device(): Promise<{ id: string; pub: string }> {
    let id = await getText(this.kv, KEYS.deviceId)
    if (!id || !/^dev_[0-9a-f]{16}$/.test(id)) {
      id = 'dev_' + hex(this.d.random(8))
      if (!(await safeSet(this.kv, KEYS.deviceId, id))) throw new Error('store')
    }
    let seed: Uint8Array | null = null
    try {
      const raw = b64Decode((await getText(this.kv, KEYS.deviceKey)) ?? '')
      seed = raw.length === 32 ? raw : null
    } catch {
      seed = null
    }
    if (!seed) {
      seed = newDeviceSeed(this.d.random)
      if (!(await safeSet(this.kv, KEYS.deviceKey, b64Encode(seed)))) throw new Error('store')
    }
    return { id, pub: devicePublicKey(seed) }
  }

  /** POST /auth/login/finish: makes or reuses the device, makes a token; only token_hash and the public key leave
   * the machine (inside the envelope). On success the credential goes to the store, the auth-fail state clears for
   * every session, and /auth/hello runs. */
  async loginFinish(email: string | null, code: string, hook: Hook = 'tool'): Promise<Result> {
    const g = await this.loginGate()
    if (g) return g
    const mail = email ?? (await this.pendingEmail())
    if (typeof mail !== 'string' || mail.length < 3 || mail.length > 254 || !mail.includes('@') || typeof code !== 'string' || code.length < 1 || code.length > 32) {
      return R(false, { error: 'invalid_body' })
    }
    let dev: { id: string; pub: string }
    try {
      dev = await this.device()
    } catch {
      return R(false, { error: 'store_unavailable' })
    }
    const token = b64url(this.d.random(32))
    const body: Record<string, string> = { email: mail, code, token_hash: sha256Hex(utf8(token)), device_pubkey: dev.pub, device_id: dev.id }
    const ch = await this.d.claudeHash().catch(() => '')
    if (ch) body.claude_hash = ch
    body.harness = this.d.harness
    const d = this.deadline('auth', hook)
    const res = await this.exchange('POST', PREFIX + '/auth/login/finish', JSON.stringify(body), 'auth', d, { signed: false, retry: true })
    if (res.ok && isObj(res.body)) {
      const b = res.body
      if (!(await safeSet(this.kv, KEYS.token, token))) return R(false, { error: 'store_unavailable' })
      await safeSet(this.kv, KEYS.endpoint, this.cfg.fingerprint)
      for (const k of await tokenNextKeys(this.kv)) await safeDelete(this.kv, k)
      for (const k of [KEYS.tokenPrev, KEYS.rotatedAt, KEYS.block, KEYS.loginPending]) await safeDelete(this.kv, k)
      for (const [k, n] of [[KEYS.accountId, 'account_id'], [KEYS.plan, 'plan'], [KEYS.expiresAt, 'expires_at']] as const) {
        if (b[n] != null) await safeSet(this.kv, k, n === 'expires_at' ? b[n] : String(b[n]))
        else await safeDelete(this.kv, k)
      }
      this.claude = ch
      this.authCache = null
      this.planRoutes = null
      this.refused.clear()
      this.setGate('unknown')
      if (d.remaining() > 0) await this.within(this.handshake(hook), d.remaining())
    }
    return strip(res)
  }

  /** A signed POST /auth/logout, then the credential keys are deleted. In auth fail nothing is sent. Never reports a
   * sign-out that did not happen: a refused delete answers store_unavailable. */
  async logout(hook: Hook = 'tool'): Promise<Result> {
    if ((await this.settings()).offline) return R(false, { error: 'offline' }) // nothing sent, the sign-in stays
    let res: Result
    if ((await this.authState(true)) !== 'ok') res = R(false, { error: 'not_logged_in' })
    else {
      res = strip(
        await this.exchange('POST', PREFIX + '/auth/logout', JSON.stringify({}), 'auth', this.deadline('auth', hook), {
          signed: true,
          retry: false,
        }),
      )
    }
    let dropped = true
    for (const k of [...CREDENTIAL_KEYS, KEYS.block]) dropped = (await safeDelete(this.kv, k)) && dropped
    for (const k of await tokenNextKeys(this.kv)) dropped = (await safeDelete(this.kv, k)) && dropped
    if (dropped && (await getText(this.kv, KEYS.token))) dropped = false
    this.authCache = null
    this.planRoutes = null
    this.refused.clear()
    this.setGate('login')
    if (!dropped) return R(false, { error: 'store_unavailable' })
    return res
  }
}

export const PLAN_NOTICE =
  "agent-services: this account's plan does not include every service; the others run on their open defaults. Plan changes happen on the account, with no reinstall."

const VERSION_RX = new RegExp(String((CONTRACT as any).definitions.Version.pattern))
const VERSION_MAX = Number((CONTRACT as any).definitions.Version.maxLength ?? 40)
function validVersion(v: unknown): boolean {
  return typeof v === 'string' && v.length <= VERSION_MAX && VERSION_RX.test(v)
}

function strip(r: Res | Result): Result {
  return { ok: r.ok, status: r.status, body: r.body, error: r.error, fallback: r.fallback, attempts: r.attempts }
}
