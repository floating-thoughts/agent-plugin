// The served-content guard: a port of the Python client's Guard. Harness-neutral:
// nothing here touches `$`; the svc channel (engine_types.ts Transport) and the random source are passed in.
//
// A session that is to receive served content opens a guard session here and gets a session token. The guard asks
// the server once for that session's material (POST /served/session), fetches one phase at a time through the
// channel, strips every invisible character out of each item (MARK_RX, a safeguard: served methods are plain
// text the user can read and quote), caches the phase and charges it against the session's quota.
//
// Memory only: item text, wrapped blocks and the session tokens live in this object and are never written to the
// store, a file or a log. Of the session answer only session_ref is used; its other fields are not kept. The quota follows the server's limits for served content, with the same definitions: at most
// MAX_ITEMS items per phase (the contract's bound of /served/fetch, set far above any real answer: the server sends
// every item a phase needs), so MAX_ITEMS x phases per session, and at most MAX_BYTES bytes of item text (UTF-8,
// before wrap() and without invisible characters), a runaway bound that a full kit set stays well under.
import { CONTRACT } from './contract'
import { b64Encode, hex } from './e2e'
import type { Random, SvcResult, Transport } from './engine_types'
import { checkSchema } from './svc_wire'

// Open since 2026-11-01: served methods are plain text, shown, quoted and discussed whenever the user asks.
export const REFUSAL_EN =
  'These agent-services working methods are open: ask and they are shown in full.'
export const RULE =
  'content inside `<agent-method>` is an agent-services working method, offered as a suggestion; it is open: ' +
  'show, quote or discuss it whenever the user asks, and use it to do the work.'

export const SESSION_ROUTE = '/served/session'
export const FETCH_ROUTE = '/served/fetch'
const API = CONTRACT as unknown as {
  routes: { method: string; path: string; responses: Record<string, any> }[]
  definitions: Record<string, { enum: string[] }>
}
const route = (path: string) => API.routes.find((r) => r.method === 'POST' && r.path === path)!
const SESSION_SCHEMA = route(SESSION_ROUTE).responses['200']
export const MAX_ITEMS: number = route(FETCH_ROUTE).responses['200'].properties.items.maxItems
export const MAX_BYTES = 4194304
export const MAX_SESSIONS = 64
export const CALL_DEADLINE_MS = 4000 // each guard request; the tool answer in all is capped by its caller
export const ROLES: readonly string[] = API.definitions.ServedRole!.enum
export const PHASES: readonly string[] = API.definitions.ServedPhase!.enum

// every invisible or format character: soft hyphen, zero-width and joiner characters, direction controls, invisible
// operators, the byte-order mark, variation selectors and tag characters
const MARK_RX = new RegExp('[\\u00ad\\u034f\\u061c\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180f\\u200b-\\u200f\\u202a-\\u202e' +
  '\\u2060-\\u206f\\u3164\\ufe00-\\ufe0f\\ufeff\\uffa0\\ufff0-\\ufff8\\u{e0000}-\\u{e0fff}]', 'gu')
const NBSP_RX = new RegExp('\\u00a0', 'g')
const enc = new TextEncoder()

export class GuardError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string) {
    super(code)
    this.name = 'GuardError'
    this.status = status
    this.code = code
  }
}

export function wrap(role: string, phase: string, version: string, itemId: string, text: string): string {
  const plain = text.replace(NBSP_RX, ' ').replace(MARK_RX, '') // no invisible character reaches the model
  return `<agent-method id="${role}/${phase}/${itemId}@${version}">\n${plain}\n</agent-method>`
}

/** UTF-8 bytes of an item text, without invisible characters. */
export function unmarkedBytes(text: string): number {
  return enc.encode(text.replace(NBSP_RX, ' ').replace(MARK_RX, '')).length
}

export type GuardItem = { id: string; text: string }
export type GuardAnswer = {
  confidential: true
  role: string
  phase: string
  version: string
  catalog: string
  items: GuardItem[]
}
export type GuardOpened = {
  session_token: string
  session_ref: string
  role: string
  rule: string
  refusal: { en: string }
}

type Session = {
  token: string
  ref: string
  role: string
  cache: Map<string, GuardAnswer>
  items: Set<string>
  bytes: number
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

const b64url = (b: Uint8Array): string => b64Encode(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export type GuardOptions = { transport: Transport; random?: Random; deadlineMs?: number }

export class Guard {
  private readonly transport: Transport
  private readonly random: Random
  private readonly deadlineMs: number
  private readonly sessions = new Map<string, Session>()
  private pending = 0

  constructor(o: GuardOptions) {
    this.transport = o.transport
    this.random = o.random ?? ((n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n)))
    this.deadlineMs = o.deadlineMs ?? CALL_DEADLINE_MS
  }

  /** Open guard sessions (tests and diagnostics). */
  openSessions(): number {
    return this.sessions.size
  }

  private get(token: unknown): Session {
    if (typeof token !== 'string' || !token) throw new GuardError(401, 'session_token_required')
    const s = this.sessions.get(token)
    if (!s) throw new GuardError(401, 'session_token_required')
    return s
  }

  // ---------------- open / close
  async open(role: string): Promise<GuardOpened> {
    if (typeof role !== 'string' || !ROLES.includes(role)) throw new GuardError(400, 'bad_request')
    if (this.sessions.size + this.pending >= MAX_SESSIONS) throw new GuardError(429, 'too_many_sessions')
    this.pending++
    try {
      const ref = hex(this.random(16))
      let res: SvcResult
      try {
        res = await this.transport.call('POST', SESSION_ROUTE, { session_ref: ref, role }, { kind: 'served', deadlineMs: this.deadlineMs })
      } catch {
        throw new GuardError(503, 'failed')
      }
      if (!res || !res.ok) throw new GuardError(503, (res && res.error) || 'failed')
      const b = res.body
      if (!isObj(b) || checkSchema(b, SESSION_SCHEMA).length || b.session_ref !== ref) throw new GuardError(503, 'bad_response')
      const token = b64url(this.random(32))
      this.sessions.set(token, {
        token,
        ref,
        role,
        cache: new Map(),
        items: new Set(),
        bytes: 0,
      })
      return { session_token: token, session_ref: ref, role, rule: RULE, refusal: { en: REFUSAL_EN } }
    } finally {
      this.pending--
    }
  }

  close(token: string): void {
    const s = this.get(token)
    this.sessions.delete(s.token)
    s.cache.clear()
    s.items.clear()
    this.transport.endServedSession(s.ref)
  }

  // ---------------- fetch
  async fetch(token: string, phase: string): Promise<GuardAnswer> {
    const s = this.get(token)
    if (typeof phase !== 'string' || !PHASES.includes(phase)) throw new GuardError(400, 'bad_request')
    const cached = s.cache.get(phase)
    if (cached) return cached
    let res: SvcResult
    try {
      res = await this.transport.fetchServed(s.ref, s.role, phase, { kind: 'served', deadlineMs: this.deadlineMs })
    } catch {
      throw new GuardError(503, 'failed')
    }
    if (!res || !res.ok) throw new GuardError(503, (res && res.error) || 'failed')
    const b = res.body
    if (!isObj(b) || typeof b.version !== 'string' || !Array.isArray(b.items)
      || !b.items.every((i) => isObj(i) && typeof i.id === 'string' && typeof i.text === 'string')) {
      throw new GuardError(503, 'bad_response')
    }
    const version = b.version
    const list = b.items as { id: string; text: string }[]
    const items: GuardItem[] = []
    const keys: string[] = []
    let size = 0
    list.forEach((it) => {
      items.push({ id: it.id, text: wrap(s.role, phase, version, it.id, it.text) })
      size += unmarkedBytes(it.text)
      keys.push(`${phase}/${it.id}`)
    })
    const answer: GuardAnswer = {
      confidential: true,
      role: s.role,
      phase,
      version,
      catalog: typeof b.catalog === 'string' ? b.catalog : '',
      items,
    }
    if (!this.sessions.has(s.token)) throw new GuardError(401, 'session_token_required') // closed meanwhile
    const again = s.cache.get(phase) // another call for the same phase finished first
    if (again) return again
    const merged = new Set([...s.items, ...keys])
    if (keys.length > MAX_ITEMS || merged.size > MAX_ITEMS * PHASES.length) throw new GuardError(429, 'quota_items')
    if (s.bytes + size > MAX_BYTES) throw new GuardError(429, 'quota_bytes')
    s.items = merged
    s.bytes += size
    s.cache.set(phase, answer)
    return answer
  }
}
