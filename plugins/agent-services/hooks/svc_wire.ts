// The svc channel's stateless helpers (moved from svc.ts unchanged): the client config, the
// contract's schema subset (check and filter), the route table, the served-answer summary and the field redaction,
// error codes, Retry-After and the injected-clock Deadline. svc.ts keeps the constants, the types and the Svc class.
import { CONTRACT } from './contract'
import { b64Decode, b64Encode, sha256Hex, utf8 } from './e2e'
import { serverKeys } from './sig'
import type { ServerKeys } from './sig'
import type { Kind } from './svc'

const HOST_RX =
  /^https:\/\/((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?)(?::(\d{1,5}))?$/
const KEY_RX = /^[A-Za-z0-9+/]{43}=$/
const CODE_RX = /^[a-z][a-z0-9_]{0,63}$/

// ------------------------------------------------------------------ helpers (ports of the Python client)

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
  // the Python client's client_fingerprint: json.dumps(doc, sort_keys=True, separators=(",", ":"))
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

export const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
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

/** the Python client's check_schema: the problems of `value` against the contract's schema subset. */
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

/** the Python client's _filter: drop properties the schema does not have (objects with additionalProperties false). */
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

export function limitProblems(route: any, body: unknown): string[] {
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

/** Metrics routes that upload nothing stay usable with the metrics switch off (the consent record included: a
 * withdrawal must reach the server whatever the switch says). */
export function ungated(route: any): boolean {
  if (route['x-inventory']?.service !== 'metrics') return false
  return route.method === 'GET' || route.method === 'DELETE' ||
    (route.method === 'POST' && ['/metrics/weekly-mail', '/org/summary-mail', '/privacy/consent'].includes(route.path))
}

export function servedProps(route: any): string[] {
  const s = resolve(route?.responses?.['200'] ?? {})
  const props = isObj(s) && isObj(s.properties) ? s.properties : {}
  return Object.entries(props)
    .filter(([, v]) => isObj(v) && v['x-served'] === true)
    .map(([k]) => k)
}

export const hashStrings = (v: unknown): unknown =>
  typeof v === 'string'
    ? 'sha256:' + sha256Hex(utf8(v))
    : Array.isArray(v)
      ? v.map(hashStrings)
      : isObj(v)
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, hashStrings(x)]))
        : v

export function servedSummary(text: string): string | null {
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

export const TOOLBOX_ROUTE = '/toolbox/fetch'

/** What the request log keeps of a toolbox answer: no served text (the index's note and lines, a pack's title and
 * items), only the kind, key, version and each item's id and sha256. */
export function toolboxSummary(text: string): string | null {
  let b: unknown
  try {
    b = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObj(b)) return null
  const items = Array.isArray(b.items) ? b.items : []
  const entries = Array.isArray(b.entries) ? b.entries : []
  return JSON.stringify({
    kind: b.kind ?? null,
    key: b.key ?? null,
    version: b.version ?? null,
    entries: entries.filter(isObj).map((e: any) => e.key ?? null),
    items: items.filter(isObj).map((i: any) => ({ id: i.id ?? null, sha256: i.sha256 ?? null })),
  })
}

/** What the request log keeps of a rule-tables answer: the version, the scope and the table names, never the tables
 * (they stay in memory only). */
export function rulesSummary(text: string): string | null {
  let b: unknown
  try {
    b = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObj(b)) return null
  return JSON.stringify({ version: b.version ?? null, scope: b.scope ?? null, tables: isObj(b.tables) ? Object.keys(b.tables).sort() : null })
}

/** What the request log keeps of a company summary: every field but the member list (emails) and the mail address,
 * which become counts and a flag. */
export function orgSummaryLog(text: string): string | null {
  let b: unknown
  try {
    b = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObj(b)) return null
  const { people, mail_to, ...rest } = b
  return JSON.stringify({ ...rest, people: Array.isArray(people) ? people.length : null, mail_to: mail_to ? 'set' : null })
}

export function redactFields(text: string | null, fields: readonly string[] | null | undefined): string | null {
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

export const throttled = (status: number | null, code: string | null): boolean =>
  (status === 429 && code === 'rate_limited') || (status === 503 && code === 'busy')

/** A Retry-After in seconds, clamped to [1, cap]; `dflt` when absent or not a number. */
export function retrySeconds(value: unknown, dflt: number, cap: number): number {
  let secs = value == null || value === '' ? dflt : Number(value)
  if (!Number.isFinite(secs)) secs = dflt
  return Math.min(Math.max(secs, 1), cap)
}

export const b64url = (b: Uint8Array): string => b64Encode(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export const dec = new TextDecoder('utf-8')
export const lower = (h: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]))
export const num = (v: unknown): number | null => {
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
