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
import { b64Encode, hex, sha256Hex, utf8 } from './e2e'
import type { Random, SvcResult, Transport } from './engine_types'
import { checkSchema, TOOLBOX_ROUTE } from './svc_wire'

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
const TOOLBOX_SCHEMA = route(TOOLBOX_ROUTE).responses['200']
export const MAX_ITEMS: number = route(FETCH_ROUTE).responses['200'].properties.items.maxItems
export const MAX_BYTES = 4194304
export const MAX_SESSIONS = 64
export const CALL_DEADLINE_MS = 4000 // each guard request; the tool answer in all is capped by its caller
export const ROLES: readonly string[] = API.definitions.ServedRole!.enum
export const PHASES: readonly string[] = API.definitions.ServedPhase!.enum
export const EVENTS: readonly string[] = API.definitions.ServedEvent!.enum

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
  const plain = clean(text) // no invisible character reaches the model
  return `<agent-method id="${role}/${phase}/${itemId}@${version}">\n${plain}\n</agent-method>`
}

/** UTF-8 bytes of an item text, without invisible characters. */
/** A toolbox item for the model: plain text in an <agent-pack> wrapper naming its pack, item id and version. */
export function wrapPack(key: string, version: string, itemId: string, text: string): string {
  return `<agent-pack key="${key}" id="${itemId}" version="${version}">\n${clean(text)}\n</agent-pack>`
}

/** A served text without invisible characters (no-break spaces become spaces). */
export function clean(text: string): string {
  return text.replace(NBSP_RX, ' ').replace(MARK_RX, '')
}

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
// One toolbox answer (POST /toolbox/fetch), texts cleaned: the index as a dict key -> when line (the server's order),
// or one pack with each item wrapped in <agent-pack>. Cached per key and topic for the guard session.
export type ToolboxAnswer =
  | { kind: 'index'; version: string; note: string; entries: Record<string, string> }
  | { kind: 'pack'; key: string; title: string; version: string; topic: string | null; items: GuardItem[]; branched: number }

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
  toolbox: Map<string, ToolboxAnswer>
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
        toolbox: new Map(),
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
    s.toolbox.clear()
    s.items.clear()
    this.transport.endServedSession(s.ref)
  }

  // ---------------- planning gate
  /** The planning-gate verdict for `state` (phase.ts gateState) through this session's served fetch of the plan
   * phase: the answer's `gate` object, 'refused' when the service does not know the field (422: an older server),
   * or null on any other failure. Nothing is cached or charged here (the answer carries no items). */
  async gate(token: string, state: Record<string, unknown>): Promise<Record<string, unknown> | 'refused' | null> {
    const s = this.get(token)
    let res: SvcResult
    try {
      res = await this.transport.fetchServed(s.ref, s.role, 'plan', { kind: 'served', deadlineMs: this.deadlineMs }, state)
    } catch {
      return null
    }
    if (!res || !res.ok) return res && res.status === 422 ? 'refused' : null
    return isObj(res.body) && isObj(res.body.gate) ? res.body.gate : null
  }

  // ---------------- fetch
  /** One phase, without the items served just in time (black-box step 5; an older service sends them all). With
   * `event`: only that event's items (cached per event; `phase` is only echoed). */
  async fetch(token: string, phase: string, event?: string): Promise<GuardAnswer> {
    const s = this.get(token)
    if (typeof phase !== 'string' || !PHASES.includes(phase)) throw new GuardError(400, 'bad_request')
    if (event !== undefined && (typeof event !== 'string' || !EVENTS.includes(event))) throw new GuardError(400, 'bad_request')
    const key = event ? `@${event}` : phase
    const cached = s.cache.get(key)
    if (cached) return cached
    let res: SvcResult
    try {
      res = await this.transport.fetchServed(s.ref, s.role, phase, { kind: 'served', deadlineMs: this.deadlineMs }, undefined,
        event ? { event } : { jit: true })
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
      keys.push(event ? `${key}/${it.id}` : `${phase}/${it.id}`)
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
    const again = s.cache.get(key) // another call for the same phase or event finished first
    if (again) return again
    const merged = new Set([...s.items, ...keys])
    if (keys.length > MAX_ITEMS || merged.size > MAX_ITEMS * (PHASES.length + EVENTS.length)) throw new GuardError(429, 'quota_items')
    if (s.bytes + size > MAX_BYTES) throw new GuardError(429, 'quota_bytes')
    s.items = merged
    s.bytes += size
    s.cache.set(key, answer)
    return answer
  }
  // ---------------- toolbox
  /** The toolbox index (key 'index') or one pack (POST /toolbox/fetch through this guard session's ref), cached per
   * key and topic for the session and charged against the session's MAX_BYTES (UTF-8 of the texts, cleaned). A
   * session the server no longer knows (409 session_required) is opened again once. Errors: 400 bad_request, 404
   * no_such_pack (also a server without the route), 403 with the server's code, 429 quota_bytes, 503 otherwise. */
  async fetchToolbox(token: string, key: string, topic?: string): Promise<ToolboxAnswer> {
    const s = this.get(token)
    const rx = /^[a-z][a-z0-9-]{1,39}$/
    if (typeof key !== 'string' || !rx.test(key)) throw new GuardError(400, 'bad_request')
    if (topic !== undefined && (typeof topic !== 'string' || !rx.test(topic) || key === 'index')) throw new GuardError(400, 'bad_request')
    const ck = `${key}\n${topic ?? ''}`
    const cached = s.toolbox.get(ck)
    if (cached) return cached
    const opts = { kind: 'served', deadlineMs: this.deadlineMs }
    let res: SvcResult
    try {
      res = await this.transport.fetchToolbox(s.ref, key, topic, opts)
      if (res && !res.ok && res.status === 409 && res.error === 'session_required') {
        const opened = await this.transport.call('POST', SESSION_ROUTE, { session_ref: s.ref, role: s.role }, opts)
        if (opened && opened.ok) res = await this.transport.fetchToolbox(s.ref, key, topic, opts)
      }
    } catch {
      throw new GuardError(503, 'failed')
    }
    if (!res || !res.ok) {
      if (res && res.status === 404) throw new GuardError(404, 'no_such_pack') // also a server without the route
      throw new GuardError(res && res.status === 403 ? 403 : 503, (res && res.error) || 'failed')
    }
    const b = res.body
    if (!isObj(b) || checkSchema(b, TOOLBOX_SCHEMA).length || (b.kind === 'index') !== (key === 'index')) {
      throw new GuardError(503, 'bad_response')
    }
    let answer: ToolboxAnswer
    let size = 0
    if (b.kind === 'index') {
      const entries: Record<string, string> = {}
      for (const e of b.entries as { key: string; when: string }[]) {
        entries[e.key] = clean(e.when)
        size += unmarkedBytes(e.when) + e.key.length
      }
      size += unmarkedBytes(b.note as string)
      answer = { kind: 'index', version: b.version as string, note: clean(b.note as string), entries }
    } else {
      const list = b.items as { id: string; text: string; sha256: string }[]
      if (b.key !== key || list.some((i) => sha256Hex(utf8(i.text)) !== i.sha256)) throw new GuardError(503, 'bad_response')
      const version = b.version as string
      size += unmarkedBytes(b.title as string)
      const items = list.map((i) => {
        size += unmarkedBytes(i.text)
        return { id: i.id, text: wrapPack(key, version, i.id, i.text) }
      })
      answer = { kind: 'pack', key, title: clean(b.title as string), version, topic: topic ?? null, items, branched: b.branched as number }
    }
    if (!this.sessions.has(s.token)) throw new GuardError(401, 'session_token_required') // closed meanwhile
    const again = s.toolbox.get(ck) // another call for the same key and topic finished first
    if (again) return again
    if (s.bytes + size > MAX_BYTES) throw new GuardError(429, 'quota_bytes')
    s.bytes += size
    s.toolbox.set(ck, answer)
    return answer
  }
}
