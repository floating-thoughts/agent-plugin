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
import { deviceFileOf, resolveDeviceId, type DeviceFile, type DurableDir } from './device_id'
import { Outbox } from './outbox'
import type { RequestLine } from './outbox'
import { keepOrg, ORG_PAUSED_LINE, validOrg } from './org'
import { ORG_PAUSED_STATUS } from './status'
import { devicePublicKey, newDeviceSeed, SIG_SKEW_SECONDS, signedHeaders, signedTs, verifyResponse } from './sig'
import {
  CREDENTIAL_KEYS,
  getText,
  KEYS,
  readText,
  safeDelete,
  safeGet,
  safeSet,
  SIGN_OUT_KEYS,
  tokenNextKey,
  tokenNextKeys,
} from './store'
import type { KV } from './store'
import {
  b64url,
  bindingKept,
  checkSchema,
  Deadline,
  dec,
  defaultKind,
  errorCode,
  filterBody,
  hashStrings,
  isObj,
  limitProblems,
  lower,
  matchRoute,
  membersLogBody,
  membersLogText,
  num,
  parseConfig,
  orgSummaryLog,
  redactFields,
  retrySeconds,
  rulesSummary,
  servedProps,
  servedSummary,
  toolboxFilesSummary,
  toolboxSummary,
  TOOLBOX_FILES_ROUTE,
  TOOLBOX_ROUTE,
  throttled,
  ungated,
} from './svc_wire'

export { checkSchema, Deadline, defaultKind, errorCode, filterBody, matchRoute, parseConfig, retrySeconds }


export const DEFAULT_CONFIG = {
  endpoint: 'https://svc.yzcanadianholdings.com',
  pin: { kind: 'ca' },
  server_keys: ['q3eePMcOg3Ds0W/qzkEV1r18qJo7IDA83Tg6KY7DgJE='],
  e2e_keys: ['MbNUgR1sQVd5oZlN77nOJraHgVSlMol9QeYfgB6fGnY='],
} as const

export type Kind = 'router' | 'checkpoint' | 'served' | 'run_limits' | 'daily' | 'auth' | 'health'
export type Hook = 'tool' | 'spawn' | 'prompt' | 'background'

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
export const HOOK_BUDGET_MS: Record<Hook, number> = { tool: 8000, spawn: 1000, prompt: 0, background: 25000 }

export const ROTATE_MARGIN_S = 7 * 86400
export const MAX_ATTEMPTS = 3
export const BLOCK_SECONDS = { locked_out: 900, account_locked: 3600, org_paused: 60 } as const
export const THROTTLE_MAX_SECONDS = 300
export const THROTTLE_NOTICE_AFTER = 120
export const NOTICE_EVERY_MS = 3600000
export const UNSIGNED_RETRY_MAX = 60
export const EDGE_COOL_SECONDS = 30
export const MAX_RESPONSE_CHARS = Math.ceil((4 * 1048576) / 3) * 4
export const TOOLBOX_FILES_MAX_RESPONSE_CHARS = Math.ceil((12 * 1048576) / 3) * 4
export const TOKEN_PREV_GRACE_MS = 5 * 60000
export const LEASE_MS = 30000
export const LEASE_SETTLE_MS = 200
export const AUTH_STATE_TTL_MS = 5000
export const BAD_ENVELOPE_LIMIT = 2
export const BAD_ENVELOPE_WINDOW_MS = 600000
export const LOGIN_PENDING_MS = 600000
export const CLAUDE_UNREADABLE_MS = 60000
export const HELLO_PATH = '/auth/hello'
export const PLAN_PATH = '/auth/plan'
export const RETRY_STATUS = [500, 502, 503, 504]
export const EDGE_STATUS = [403, 429]
export const SERVICES = ['health', 'updates', 'incidents', 'metrics', 'router', 'checkpoint', 'limits'] as const
export const SERVICE_DEFAULTS: Record<string, boolean> = {
  health: true,
  updates: true,
  incidents: false,
  metrics: true,
  router: true,
  checkpoint: true,
  limits: true,
}
export const SERVED_ROUTE = '/served/fetch'
export const SERVED_ROLES: readonly string[] = (CONTRACT as any).definitions.ServedRole.enum
export const SERVED_CHANNELS = ['stable', 'beta']
export const CONSENT_ROUTES = ['POST /diagnostic/estimate']
export const PLAN_VALUES = ['diagnostic', 'guard', 'full']

export const PAUSED_LINE = 'agent-services is signed out: sign in with /agent-services login'
export const LOCKED_LINE =
  'agent-services is paused: this account is locked; contact support, then sign in with /agent-services login'
export const LICENSE_INACTIVE_LINE =
  "Your company's agent-services license is not active, so agent-services is off for now and works as if signed " +
  'out. Your sign-in is kept: nothing needs signing in again, and it starts again by itself once the license is active.'
export const LICENSE_INACTIVE_STATUS = "off: your company's license is not active; it restarts by itself once active"
export const GATE_NOTICES: Record<string, string> = {
  login: PAUSED_LINE,
  locked: LOCKED_LINE,
  paused: ORG_PAUSED_LINE,
  upgrade: 'agent-services needs an update: this plugin version is no longer accepted; update the plugin (minimum {min_shell}).',
  offline: 'agent-services is offline: offline mode is on, so nothing is sent.',
  unavailable: "agent-services can't reach its server; it tries again in a few minutes and at the next session.",
  unavailable_until: 'agent-services stopped sending: the server could not open two requests in a row; it tries ' +
    'again in about {minutes} minutes.',
  clock:
    "agent-services paused: this computer's clock is more than 5 minutes off, so the server's answers cannot be " +
    'checked. Set the clock right (turn on automatic time); it tries again in about 30 minutes or once the clock is right.',
  unverified:
    "agent-services can't verify its server: an answer claiming to come from the server was not signed by the server's key (a " +
    'proxy or a fake server may be in the way); nothing it said was used. It tries again in a few minutes.',
}
export const NOTICE_TEXT: Record<string, string> = {
  login_expired: 'Your agent-services sign-in expired; sign in again with /agent-services login.',
  auth_required: 'Your agent-services sign-in ended; sign in again with /agent-services login.',
  session_replaced: 'Your account signed in on another device; sign in again here with /agent-services login.',
  claude_account_mismatch: 'The Claude account changed since sign-in; sign in again to re-pair this device.',
  account_locked: 'Your agent-services account is locked; contact support.',
  org_paused: ORG_PAUSED_LINE,
  license_inactive: LICENSE_INACTIVE_LINE,
  locked_out:'Too many failed requests; agent-services paused for 15 minutes.',
  rate_limited:
    'agent-services is busy and is slowing requests down; the plugin keeps working on its defaults and retries on its own.',
  server_unverified:
    "agent-services stopped: an answer was not signed by the server's key, so it was not used (a proxy or a fake " +
    'server may be in the way). It tries again in a few minutes.',
  clock_skew:
    "agent-services paused: this computer's clock is more than 5 minutes off, so the server's answers cannot be " +
    'checked. Set the clock right (turn on automatic time); it tries again in about 30 minutes or once the clock is right.',
  endpoint_changed: 'The agent-services address or server keys changed, so this machine was signed out; sign in again.',
  bad_envelope:
    'agent-services stopped sending: the server could not open two requests in a row; it tries again in 10 minutes.',
}

const ROUTE_KEY_RX = /^(GET|POST|PUT|DELETE) \/\S+$/
const RELEASE_RX = /^\d+\.\d+\.\d+$/


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
  now: () => number
  sleep: (ms: number) => Promise<void>
  session: string
  random?: Random
  outbox?: Outbox | null
  claudeHash?: () => Promise<string | null>
  config?: ClientConfig
  shellVersion?: string
  harness?: string
  durable?: DurableDir | null
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
export type AuthState = 'ok' | 'login' | 'locked' | 'paused'
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

export function gateNotice(state: GateState, retryInMs: number | null = null): string | null {
  if (!state || state.open) return null
  if (state.reason === 'unavailable' && retryInMs !== null && retryInMs > 0)
    return GATE_NOTICES.unavailable_until!.replace('{minutes}', String(Math.max(1, Math.ceil(retryInMs / 60000))))
  const t = GATE_NOTICES[state.reason ?? '']
  return t ? t.replace('{min_shell}', state.min_shell || 'unknown') : null
}


export class Svc {
  readonly session: string
  private d: Required<Omit<Deps, 'outbox' | 'config' | 'durable'>> & { outbox: Outbox | null; file: DeviceFile | null }
  private cfg: ReturnType<typeof parseConfig>
  private gs: GateState = { open: false, reason: 'unknown', min_shell: null }
  private envelopeUntil: number | null = null
  private holder: string
  private helloP: Promise<Result> | null = null
  private planRoutes: Set<string> | null = null
  private refused = new Map<string, string>()
  private notes: { ts: number; code: string; text: string }[] = []
  private lastNotice = new Map<string, number>()
  private authCache: { at: number; value: AuthState; unsure?: boolean } | null = null
  private pauseCode = 'org_paused'
  private ready: Promise<void> | null = null
  private claude: string | null = null
  private claudeSent = ''
  private claudeBadSince: number | null = null
  private clockTold = false
  private servedBind = new Map<string, string>()
  private servedJitRefused = false

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
      file: deps.durable ? deviceFileOf(deps.durable) : null,
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

  private init(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        const tok = await getText(this.kv, KEYS.token)
        if (!tok) return
        const bound = await getText(this.kv, KEYS.endpoint)
        if (bound === null || (bound !== this.cfg.binding && bindingKept(bound, this.cfg))) {
          await safeSet(this.kv, KEYS.endpoint, this.cfg.binding)
        } else if (bound !== this.cfg.binding) {
          for (const k of SIGN_OUT_KEYS) await safeDelete(this.kv, k)
          for (const k of await tokenNextKeys(this.kv)) await safeDelete(this.kv, k)
          this.authCache = null
          this.notice('endpoint_changed')
        }
      })().catch(() => undefined)
    }
    return this.ready
  }

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
  private async metricsDefault(d: Record<string, any>): Promise<boolean> {
    const stored = isObj(d.services) ? d.services.metrics : undefined
    return d.metrics_set === true && typeof stored === 'boolean' ? stored : true
  }
  private async saveSettings(f: (s: Settings) => void, choseMetrics = false): Promise<boolean> {
    const s = await this.settings()
    f(s)
    const raw = await safeGet(this.kv, KEYS.settings)
    const set = choseMetrics || (isObj(raw) && raw.metrics_set === true)
    return safeSet(this.kv, KEYS.settings, set ? { ...s, metrics_set: true } : s)
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

  private setGate(reason: string | null, minShell: string | null = null): void {
    this.gs = { open: reason === null, reason, min_shell: minShell }
  }
  gateState(): GateState {
    return { ...this.gs }
  }
  retryAt(): number | null {
    const u = this.envelopeUntil
    return !this.gs.open && this.gs.reason === 'unavailable' && u !== null && u > this.d.now() ? u : null
  }
  gateText(): string | null {
    if (!this.gs.open && this.gs.reason === 'paused') return this.pausedLine()
    const u = this.retryAt()
    return gateNotice(this.gs, u === null ? null : u - this.d.now())
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

  private async pauseBlock(): Promise<Block | null> {
    const b = await this.block()
    if (!b || (b.code !== 'org_paused' && b.code !== 'license_inactive') || !b.token_sha256) return null
    const tok = await getText(this.kv, KEYS.token)
    return tok && sha256Hex(utf8(tok)) === b.token_sha256 ? b : null
  }

  pausedLine(): string {
    return this.pauseCode === 'license_inactive' ? LICENSE_INACTIVE_LINE : ORG_PAUSED_LINE
  }

  pausedShort(): string {
    return this.pauseCode === 'license_inactive' ? LICENSE_INACTIVE_STATUS : ORG_PAUSED_STATUS
  }

  async authState(fresh = false): Promise<AuthState> {
    const now = this.d.now()
    if (!fresh && this.authCache && now - this.authCache.at < AUTH_STATE_TTL_MS) return this.authCache.value
    await this.init()
    let value: AuthState = 'ok'
    const t = await readText(this.kv, KEYS.token)
    const a = await readText(this.kv, KEYS.accountId)
    const tok = t.text
    const acc = a.text
    const exp = num(await safeGet(this.kv, KEYS.expiresAt))
    const expired = exp !== null && now / 1000 >= exp
    const unsure = (t.failed || a.failed) && !expired
    if (!tok || !acc || expired) value = 'login'
    else {
      const pause = await this.pauseBlock()
      const code = pause ? pause.code : await this.blocked()
      if (code === 'account_locked' || code === 'locked_out') value = 'locked'
      else if (code === 'org_paused' || code === 'license_inactive') value = 'paused'
      else if (code) value = 'login'
      if (pause) {
        this.pauseCode = pause.code
        if (pause.until !== null && now >= pause.until && !this.helloP) void this.handshake('background')
      }
    }
    this.authCache = { at: now, value, unsure: value === 'login' && unsure }
    return value
  }

  authUnsure(): boolean {
    return this.authCache?.unsure === true
  }

  async authLine(fresh = false): Promise<string | null> {
    const st = await this.authState(fresh)
    return st === 'ok' ? null : st === 'locked' ? LOCKED_LINE : st === 'paused' ? this.pausedLine() : PAUSED_LINE
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
    await this.envelopeOpened()
  }
  private async envelopeOpened(): Promise<void> {
    this.envelopeUntil = null
    if ((await safeGet(this.kv, KEYS.badEnvelope)) !== undefined) await safeDelete(this.kv, KEYS.badEnvelope)
  }
  private async envelopeBlocked(): Promise<boolean> {
    const b = await safeGet(this.kv, KEYS.badEnvelope)
    const on = isObj(b) && typeof b.n === 'number' && typeof b.at === 'number' && b.n >= BAD_ENVELOPE_LIMIT && this.d.now() - b.at < BAD_ENVELOPE_WINDOW_MS
    this.envelopeUntil = on ? (b.at as number) + BAD_ENVELOPE_WINDOW_MS : null
    return on
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

  private async clockOff(server: number | null): Promise<void> {
    if (server !== null) await safeSet(this.kv, KEYS.clockOff, { server, local: this.nowS(), until: this.d.now() + 30 * 60000 })
    this.clockStop()
  }
  private clockStop(): void {
    if (!this.clockTold) this.notice('clock_skew')
    this.clockTold = true
    this.setGate('clock')
  }
  private async clockPaused(): Promise<boolean> {
    const c = await safeGet(this.kv, KEYS.clockOff)
    if (!isObj(c) || typeof c.server !== 'number' || typeof c.local !== 'number' || typeof c.until !== 'number') return false
    const now = this.nowS()
    if (now < c.local || this.d.now() >= c.until) return false
    return !(c.server > c.local && now >= c.server - SIG_SKEW_SECONDS)
  }

  private async claudeNow(): Promise<string | null> {
    if (this.claude) return this.claude
    for (let i = 0; i < 2; i++) {
      if (i) await this.d.sleep(100)
      const h = await this.d.claudeHash().catch(() => null)
      if (typeof h !== 'string') continue
      if (h) this.claude = h
      this.claudeBadSince = null
      return h
    }
    const now = this.d.now()
    this.claudeBadSince ??= now
    return now - this.claudeBadSince >= CLAUDE_UNREADABLE_MS ? '' : null
  }

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

  private async signing(token: string, method: string, wire: string, body: string): Promise<Record<string, string> | string | null> {
    const seedB64 = await getText(this.kv, KEYS.deviceKey)
    let seed: Uint8Array
    try {
      seed = b64Decode(seedB64 ?? '')
    } catch {
      return null
    }
    if (seed.length !== 32) return null
    const claude = await this.claudeNow()
    if (claude === null) return 'claude_unreadable'
    this.claudeSent = claude
    return signedHeaders(
      method,
      wire,
      body,
      {
        token,
        accountId: (await getText(this.kv, KEYS.accountId)) ?? '',
        deviceId: (await resolveDeviceId(this.kv, this.d.file, this.d.random, false)) ?? '',
        deviceSeed: seed,
        claudeHash: claude,
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
      if (!plain && (await this.clockPaused())) {
        this.clockStop()
        last = R(false, { error: 'clock_skew', attempts })
        break
      }
      const inner: Record<string, string> = {}
      if (method === 'POST') inner['Content-Type'] = 'application/json'
      if (o.token) {
        const sh = await this.signing(o.token, method, wire, body ?? '')
        if (!sh || typeof sh === 'string') {
          last = R(false, { error: sh || 'not_logged_in', attempts })
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
          last = R(false, { error: 'e2e_failed', attempts })
          break
        }
      }
      attempts++
      const line = this.log(service, method, wire, membersLogBody(wire, body), plain ? undefined : outer, outBody?.length)
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
      if (text.length > (wire.split('?', 1)[0] === PREFIX + TOOLBOX_FILES_ROUTE ? TOOLBOX_FILES_MAX_RESPONSE_CHARS : MAX_RESPONSE_CHARS)) {
        this.logged(line, null, null, 'response_too_large')
        last = R(false, { error: 'response_too_large', attempts })
        break
      }
      const bad = verifyResponse(this.cfg.keys, plain ? 'GET' : 'POST', outer, challenge, status, rh, text, this.nowS())
      if (bad) {
        this.logged(line, null, null, bad)
        if (bad === 'unsigned_response' && status >= 500) {
          last = R(false, { error: 'server_unreachable', attempts })
          if (o.retry && RETRY_STATUS.includes(status) && (await this.backoff(attempts, deadline))) continue
          if (rh['retry-after'] !== undefined) await this.throttle(retrySeconds(rh['retry-after'], EDGE_COOL_SECONDS, UNSIGNED_RETRY_MAX))
          break
        }
        if (bad === 'unsigned_response' && EDGE_STATUS.includes(status)) {
          last = R(false, { error: 'server_unreachable', attempts })
          await this.throttle(retrySeconds(rh['retry-after'], EDGE_COOL_SECONDS, UNSIGNED_RETRY_MAX))
          break
        }
        if (bad === 'stale_response') {
          await this.clockOff(signedTs(rh))
          last = R(false, { error: 'clock_skew', attempts })
          break
        }
        last = R(false, { error: bad, attempts })
        this.distrust()
        break
      }
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
            if (ist < 200 || ist >= 300) await this.envelopeOpened()
          } catch {
            this.logged(line, null, null, 'undecryptable_response')
            last = R(false, { error: 'undecryptable_response', attempts })
            this.distrust()
            break
          }
        } else if (status >= 200 && status < 300) {
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
      if (ok && wire.split('?', 1)[0] === PREFIX + TOOLBOX_ROUTE) shown = toolboxSummary(data)
      if (wire.split('?', 1)[0] === PREFIX + TOOLBOX_FILES_ROUTE) shown = ok ? toolboxFilesSummary(data) : shown
      if (ok && wire.split('?', 1)[0] === PREFIX + '/served/rules') shown = rulesSummary(data)
      if (ok && wire.split('?', 1)[0] === PREFIX + '/org/summary') shown = orgSummaryLog(data)
      shown = membersLogText(wire, shown)
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
        if ((await this.badEnvelope()) >= BAD_ENVELOPE_LIMIT) {
          this.envelopeUntil = this.d.now() + BAD_ENVELOPE_WINDOW_MS
          this.notice('bad_envelope')
          this.setGate('unavailable')
        }
        break
      }
      if (!sealed && ist === 503 && code === 'restarted') {
        const ms = retrySeconds(ih['retry-after'], 1, 10) * 1000
        if (o.retry && attempts < MAX_ATTEMPTS && ms < deadline.remaining()) {
          await this.d.sleep(ms)
          continue
        }
        break
      }
      if (ist === 401 && o.signed && code === 'license_inactive') {
        await this.setBlock(code, BLOCK_SECONDS.org_paused, o.token ?? null)
        this.pauseCode = code
        this.notice(code)
        this.setGate('paused')
        break
      }
      if (ist === 401 && o.signed) break
      if (ist === 423) {
        const paused = code === 'org_paused'
        if (o.signed || !(await getText(this.kv, KEYS.token))) {
          await this.setBlock(code, paused ? BLOCK_SECONDS.org_paused : BLOCK_SECONDS.account_locked, o.token ?? null)
        }
        if (paused && o.signed) this.pauseCode = code
        this.notice(code)
        if (o.signed) this.setGate(paused ? 'paused' : 'locked')
        break
      }
      if (ist === 429 && code === 'locked_out') {
        if (o.signed || !(await getText(this.kv, KEYS.token))) await this.setBlock(code, BLOCK_SECONDS.locked_out, o.token ?? null)
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
        await this.throttle(retrySeconds(ih['retry-after'], 1, THROTTLE_MAX_SECONDS))
        break
      }
      if (o.retry && RETRY_STATUS.includes(ist) && (await this.backoff(attempts, deadline))) continue
      break
    }
    return last
  }

  private async exchange(method: string, wire: string, body: string | null, service: string, deadline: Deadline, o: Omit<XOpts, 'token'> & { token?: string }): Promise<Res> {
    if (!o.signed) return this.attempt(method, wire, body, service, deadline, o)
    const tok = o.token ?? (await getText(this.kv, KEYS.token))
    if (!tok) return R(false, { error: 'not_logged_in' })
    const first = await this.attempt(method, wire, body, service, deadline, { ...o, token: tok })
    if (first.status !== 401 || first.error === 'license_inactive') return first
    return this.recover401(method, wire, body, service, deadline, o, tok, first)
  }

  private async recover401(method: string, wire: string, body: string | null, service: string, deadline: Deadline, o: XOpts, sent: string, first: Res): Promise<Res> {
    const failed = new Set<string>([sent])
    const tried = new Set<string>([sent])
    let last = first
    let attempts = first.attempts
    if (first.error === 'claude_account_mismatch') {
      const was = this.claudeSent
      this.claude = null
      const now = await this.claudeNow()
      if (now === null || this.claudeBadSince !== null) return first
      if (now !== was) {
        const r = await this.attempt(method, wire, body, service, deadline, { ...o, token: sent })
        attempts += r.attempts
        if (r.status !== 401 || r.error === 'license_inactive') return { ...r, attempts }
        last = { ...r, attempts }
      }
    }
    const send = async (t: string): Promise<Res | null> => {
      tried.add(t)
      const r = await this.attempt(method, wire, body, service, deadline, { ...o, token: t })
      attempts += r.attempts
      if (r.status !== 401 || r.error === 'license_inactive') return { ...r, attempts }
      failed.add(t)
      last = { ...r, attempts }
      return null
    }
    for (let round = 0; round < 3; round++) {
      const cur = await getText(this.kv, KEYS.token)
      if (cur && !tried.has(cur)) {
        const r = await send(cur)
        if (r) return r
      }
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
        return last
      }
      for (const k of await tokenNextKeys(this.kv)) {
        const v = await getText(this.kv, k)
        if (!v || tried.has(v)) continue
        const r = await send(v)
        if (r) {
          if (r.ok || r.error === 'license_inactive') {
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
      const held = await getText(this.kv, KEYS.token)
      if (held && !failed.has(held)) continue
      await this.revoked(last.error ?? 'http_401', held)
      return last
    }
    return last
  }

  private async revoked(code: string, held: string | null): Promise<void> {
    if (held) {
      const again = await getText(this.kv, KEYS.token)
      if (again === held || again === null) {
        for (const k of CREDENTIAL_KEYS) await safeDelete(this.kv, k)
      }
    }
    for (const k of await tokenNextKeys(this.kv)) await safeDelete(this.kv, k)
    if (held && (await getText(this.kv, KEYS.token)) === held) await this.setBlock(code, null, held)
    this.authCache = null
    this.planRoutes = null
    this.refused.clear()
    this.notice(code)
    this.setGate('login')
  }

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
    const at = num(await safeGet(this.kv, KEYS.rotatedAt))
    if (at !== null && this.d.now() - at < 86400 * 1000) return null
    return this.rotate(deadline)
  }

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
      const fresh = (await getText(this.kv, nk)) ?? b64url(this.d.random(32))
      if (!(await safeSet(this.kv, nk, fresh))) return null
      const res = await this.exchange('POST', PREFIX + '/auth/rotate', JSON.stringify({ new_token_hash: sha256Hex(utf8(fresh)) }), 'auth', deadline, {
        signed: true,
        retry: true,
        token: start,
      })
      if (res.ok && isObj(res.body) && res.body.expires_at != null) {
        const held = await getText(this.kv, KEYS.token)
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

  private deadline(kind: Kind, hook: Hook): Deadline {
    return new Deadline(this.d.now, Math.min(TIMEOUTS_MS[kind], HOOK_BUDGET_MS[hook]))
  }

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
    const pause = st === 'paused' ? await this.pauseBlock() : null
    const due = pause !== null && pause.until !== null && this.d.now() >= pause.until
    if (st !== 'ok' && !due) {
      this.setGate(st)
      return R(false, { error: (await this.blocked()) ?? (pause ? pause.code : 'not_logged_in') })
    }
    if (await this.cooling()) return R(false, { error: 'rate_limited' })
    if (pause) await this.setBlock(pause.code, BLOCK_SECONDS.org_paused, await getText(this.kv, KEYS.token))
    const err = await this.ensureFresh(d, rotate)
    if (err) {
      const paused = err === 'org_paused' || err === 'license_inactive' || (pause !== null && err !== 'login_expired')
      this.setGate(err === 'account_locked' || err === 'locked_out' ? 'locked' : paused ? 'paused' : 'login')
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
        ['accept,plan,routes', 'accept,org,plan,routes'].includes(Object.keys(b).sort().join(',')) &&
        (b.org === undefined || validOrg(b.org)) &&
        b.accept === true &&
        PLAN_VALUES.includes(b.plan as string) &&
        Array.isArray(b.routes) &&
        b.routes.every((r) => typeof r === 'string' && ROUTE_KEY_RX.test(r))
      ) {
        await safeSet(this.kv, KEYS.plan, b.plan)
        await keepOrg(this.kv, b.org, this.d.now(), (on) => this.setService('metrics', on))
        this.planRoutes = new Set(b.routes as string[])
        this.refused.clear()
        if (await this.pauseBlock()) await safeDelete(this.kv, KEYS.block)
        this.authCache = null
        this.setGate(null)
        return strip(res)
      }
      this.setGate('unavailable')
      return R(false, { status: res.status, error: 'bad_response', attempts: res.attempts })
    }
    if (res.status === 426 && res.error === 'upgrade_required') {
    } else if (res.status === 401 && res.error === 'license_inactive') this.setGate('paused')
    else if (pause && !(await this.pauseBlock())) this.setGate('login')
    else if (pause && res.status !== 423) this.setGate('paused')
    else if (res.status === 401 || res.error === 'not_logged_in') this.setGate('login')
    else if (res.status === 423 && res.error === 'org_paused') this.setGate('paused')
    else if (res.status === 423 || (res.status === 429 && res.error === 'locked_out')) this.setGate('locked')
    else if (throttled(res.status, res.error)) {
    } else if (this.gs.reason === 'unverified' || this.gs.reason === 'unavailable' || this.gs.reason === 'clock') {
    } else this.setGate('unavailable')
    return strip(res)
  }

  async sessionStart(): Promise<{ plan: string | null; notice: string | null; gate: GateState; error?: string | null }> {
    const r = await this.handshake('background')
    const st = this.gateState()
    if (st.open) {
      const p = isObj(r.body) && typeof r.body.plan === 'string' ? r.body.plan : await getText(this.kv, KEYS.plan)
      return { plan: p, notice: p === 'guard' ? PLAN_NOTICE : null, gate: st }
    }
    return { plan: (await this.status()).plan as string | null, notice: this.gateText(), gate: st, error: r.error ?? st.reason }
  }

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

  private async ensureOpen(d: Deadline, hook: Hook): Promise<boolean> {
    if (this.gs.open) return true
    if (this.gs.reason === 'clock' && !(await this.clockPaused())) this.setGate('unknown')
    if (!['unknown', 'login', 'locked', 'paused'].includes(this.gs.reason ?? '')) return false
    const hello = this.handshake(hook)
    const got = await this.within(hello, d.remaining())
    return got !== null && this.gs.open
  }

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

  preview(method: string, path: string, body?: unknown): string | null {
    const prep = this.prepare(method, path, body)
    if (typeof prep === 'string') return null
    this.d.outbox?.preview(prep.route['x-inventory'].service, prep.route.method, prep.wire.split('?', 1)[0], prep.data)
    return prep.data
  }

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
        if ((await this.authState()) !== 'ok') return fail('auth_failed')
        if (await this.cooling()) return fail('rate_limited')
        if (!(await this.ensureOpen(d, hook))) return fail('inactive')
      }
      const service = route['x-inventory'].service
      if (!(await this.serviceOn(service)) && !ungated(route) && !(opts.consent && CONSENT_ROUTES.includes(key))) return fail('service_off')
      if (signed && this.refused.has(key)) return fail(this.refused.get(key)!)
      if (signed && this.planRoutes !== null && !this.planRoutes.has(key)) return fail('not_in_plan')
      if (await this.cooling()) return fail('rate_limited')
      if (signed) {
        const blk = await this.blocked()
        if (blk) return fail(blk)
        if (!(await getText(this.kv, KEYS.token)) || !(await getText(this.kv, KEYS.accountId))) return fail('not_logged_in')
        const err = await this.ensureFresh(d, hook === 'background')
        if (err) return fail(err)
      }
      const res = await this.exchange(route.method, wire, data, service, d, {
        signed,
        retry: key !== 'POST /org/members' && key !== 'POST /org/members/remove',
        served: servedProps(route),
        secret: route['x-response-secret'] ?? null,
      })
      if (!res.ok) {
        if (res.status === 403 && (res.error === 'not_in_plan' || res.error === 'no_license')) this.refused.set(key, res.error)
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

  async fetchServed(sessionRef: string, role: string, phase: string, hook: Hook = 'tool', state?: Record<string, unknown>,
    select?: { jit?: boolean; event?: string }): Promise<Result> {
    const key = `${sessionRef}\n${role}`
    const s = await this.settings()
    const bound = this.servedBind.get(key)
    const own = SERVED_ROLES.includes(role) ? s.served.pins[role] ?? null : null
    let pin = bound ?? own
    const body: Record<string, unknown> = { session_ref: sessionRef, role, phase, pinned_version: pin, channel: s.served.channel }
    if (state) body.state = state
    if (select?.event) body.event = select.event
    else if (select?.jit && !this.servedJitRefused) body.jit = true
    let res = await this.call('POST', SERVED_ROUTE, body, { hook })
    if (!res.ok && res.status === 409 && res.error === 'session_required') {
      const opened = await this.call('POST', '/served/session', { session_ref: sessionRef, role }, { hook })
      if (opened.ok) res = await this.call('POST', SERVED_ROUTE, body, { hook })
    }
    if (!res.ok && res.status === 422 && body.jit === true) {
      delete body.jit
      res = await this.call('POST', SERVED_ROUTE, body, { hook })
      if (res.ok) this.servedJitRefused = true
    }
    if (!res.ok && res.status === 404 && bound !== undefined && bound !== own && ['version_withdrawn', 'no_such_version'].includes(res.error ?? '')) {
      this.servedBind.delete(key)
      pin = own
      body.pinned_version = pin
      res = await this.call('POST', SERVED_ROUTE, body, { hook })
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
    if (!state && !this.servedBind.has(key)) this.servedBind.set(key, b.version)
    return res
  }

  endServedSession(sessionRef: string): void {
    for (const k of [...this.servedBind.keys()]) if (k.startsWith(sessionRef + '\n')) this.servedBind.delete(k)
  }

  private async loginGate(): Promise<Result | null> {
    if ((await this.settings()).offline) return R(false, { error: 'offline' })
    const b = await this.block()
    if (b && b.code === 'account_locked' && (b.until === null || this.d.now() < b.until)) return R(false, { error: 'account_locked' })
    if (await this.cooling()) return R(false, { error: 'rate_limited' })
    return null
  }

  async loginStart(email: string, hook: Hook = 'tool'): Promise<Result> {
    const g = await this.loginGate()
    if (g) return g
    if (typeof email !== 'string' || email.length < 3 || email.length > 254 || !email.includes('@')) return R(false, { error: 'invalid_body' })
    const held = await safeGet(this.kv, 'login_check')
    const check = isObj(held) && held.email === email && typeof held.check === 'string' && typeof held.until === 'number' &&
      this.d.now() < held.until ? held.check : null
    const res = await this.exchange('POST', PREFIX + '/auth/login/start', JSON.stringify(check ? { email, check } : { email }), 'auth', this.deadline('auth', hook), {
      signed: false,
      retry: true,
      secret: ['check', 'check_url'],
    })
    const got = isObj(res.body) ? res.body.check : null
    if (res.error === 'check_required' && typeof got === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(got)) {
      await safeSet(this.kv, 'login_check', { email, check: got, until: this.d.now() + LOGIN_PENDING_MS })
    } else if (check) await safeDelete(this.kv, 'login_check')
    if (res.ok) await safeSet(this.kv, KEYS.loginPending, { email, until: this.d.now() + LOGIN_PENDING_MS })
    return strip(res)
  }

  async noteTerms(version: string | null): Promise<void> {
    if (version === null) await safeDelete(this.kv, 'terms_accepted')
    else await safeSet(this.kv, 'terms_accepted', version.slice(0, 32))
  }

  async pendingEmail(): Promise<string | null> {
    const p = await safeGet(this.kv, KEYS.loginPending)
    return isObj(p) && typeof p.email === 'string' && typeof p.until === 'number' && this.d.now() < p.until ? p.email : null
  }

  async cancelLogin(): Promise<void> {
    await safeDelete(this.kv, KEYS.loginPending)
    await safeDelete(this.kv, 'login_check')
  }

  private async device(): Promise<{ id: string; pub: string }> {
    const id = await resolveDeviceId(this.kv, this.d.file, this.d.random, true)
    if (!id) throw new Error('store')
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
    this.claude = null
    const ch = await this.claudeNow()
    if (ch === null) return R(false, { error: 'claude_unreadable' })
    const token = b64url(this.d.random(32))
    const body: Record<string, string> = { email: mail, code, token_hash: sha256Hex(utf8(token)), device_pubkey: dev.pub, device_id: dev.id }
    if (ch) body.claude_hash = ch
    body.harness = this.d.harness
    const terms = await safeGet(this.kv, 'terms_accepted')
    if (typeof terms === 'string' && terms) { body.accept_terms = terms; body.business_18 = 'true' }
    const d = this.deadline('auth', hook)
    const res = await this.exchange('POST', PREFIX + '/auth/login/finish',
      JSON.stringify(body.business_18 ? { ...body, business_18: true } : body), 'auth', d, { signed: false, retry: false })
    if (res.ok && isObj(res.body)) {
      const b = res.body
      if (!(await safeSet(this.kv, KEYS.token, token))) return R(false, { error: 'store_unavailable' })
      await safeSet(this.kv, KEYS.endpoint, this.cfg.binding)
      for (const k of await tokenNextKeys(this.kv)) await safeDelete(this.kv, k)
      for (const k of [KEYS.tokenPrev, KEYS.rotatedAt, KEYS.block, KEYS.loginPending]) await safeDelete(this.kv, k)
      for (const [k, n] of [[KEYS.accountId, 'account_id'], [KEYS.plan, 'plan'], [KEYS.expiresAt, 'expires_at']] as const) {
        if (b[n] != null) await safeSet(this.kv, k, n === 'expires_at' ? b[n] : String(b[n]))
        else await safeDelete(this.kv, k)
      }
      this.claude = ch || null
      this.authCache = null
      this.planRoutes = null
      this.refused.clear()
      this.setGate('unknown')
      if (d.remaining() > 0) await this.within(this.handshake(hook), d.remaining())
    }
    return strip(res)
  }

  async logout(hook: Hook = 'tool'): Promise<Result> {
    if ((await this.settings()).offline) return R(false, { error: 'offline' })
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
