// End-to-end request envelope, client side: a port of host/e2e.py (seal_request, open_response) for the hooks
// module, so a TLS-terminating edge (the Cloudflare Tunnel) sees only ciphertext. Harness-neutral: it never touches
// the engine; the clock (ts), the challenge and the random source are passed in.
//
// Wire format (contract: host/service_api.json x-transport "e2e"; byte for byte the same as host/e2e.py):
//   outer request  POST /svc/v1/x, or /svc/v1/auth/login/x for login start and finish
//                  X-Agent-E2E: v=1; kid=<16 hex>; epk=<base64 X25519 public key>; ts=<unix seconds>
//                  X-Agent-Challenge: <32 hex>
//                  body = nonce (12) || AES-256-GCM(k_req, nonce, frame, aad_req)
//   frame          compact ASCII JSON {"method","path","headers"} + "\n" + body bytes
//   keys           HKDF-SHA256(X25519(eph, server), salt DOMAIN, info "keys" + epk + server key, 64) -> k_req, k_resp
//   aad            DOMAIN \n req|resp \n POST \n <outer path> \n <kid> \n <epk> \n <ts> \n <challenge>
//   answer         200 with body nonce (12) || AES-256-GCM(k_resp, nonce, {"status","headers"} + "\n" + body)
//
// Encodings (contract x-transport.e2e encodings). The engine's fetch carries text only, so the hooks module sends the base64
// variant: Content-Type application/x-agent-e2e-b64 (or, when the engine overrides Content-Type, the header
// X-Agent-E2E-Encoding: b64), body = standard padded base64 of exactly the binary body. The sealed answer then comes
// back base64 too, with that Content-Type. Keys, AAD and frames are the same in both encodings.
import { gcm, hkdf, sha256, x25519 } from './noble.js'

export const DOMAIN = 'agent-svc-e2e/1'
export const HEADER = 'X-Agent-E2E'
export const CHALLENGE_HEADER = 'X-Agent-Challenge'
export const CONTENT_TYPE = 'application/octet-stream'
export const CONTENT_TYPE_B64 = 'application/x-agent-e2e-b64'
export const ENCODING_HEADER = 'X-Agent-E2E-Encoding' // the fallback b64 flag (value ENCODING_B64)
export const ENCODING_B64 = 'b64'
export const PREFIX = '/svc/v1'
export const OUTER_PATH = PREFIX + '/x'
export const OUTER_LOGIN_PATH = PREFIX + '/auth/login/x'
export const LOGIN_PATHS = [PREFIX + '/auth/login/start', PREFIX + '/auth/login/finish']
export const NONCE_BYTES = 12
export const MAX_META = 4096
export const INNER_HEADERS = [
  'Authorization',
  'X-Agent-Account',
  'X-Agent-Device',
  'X-Agent-Claude',
  'X-Agent-Timestamp',
  'X-Agent-Nonce',
  'X-Agent-Signature',
  'Content-Type',
]
const CHALLENGE_RX = /^[0-9a-f]{32}$/

export type Encoding = 'binary' | 'base64'
export type Random = (n: number) => Uint8Array
export type Body = Uint8Array | string | null | undefined

/** The envelope could not be built or opened; message is a short reason, never key material. */
export class EnvelopeError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'EnvelopeError'
  }
}

export const defaultRandom: Random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))

// ------------------------------------------------------------------ bytes

const enc = new TextEncoder()

export const utf8 = (s: string): Uint8Array => enc.encode(s)

export const toBytes = (b: Body): Uint8Array => (b == null ? new Uint8Array(0) : typeof b === 'string' ? utf8(b) : b)

export const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let i = 0
  for (const p of parts) {
    out.set(p, i)
    i += p.length
  }
  return out
}

export const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

export const sha256Hex = (b: Uint8Array): string => hex(sha256(b))

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_INDEX = new Map(Array.from(B64, (c, i) => [c, i] as [string, number]))
// What Python's base64.b64decode(s, validate=True) accepts: whole groups of four, padding only at the end. Like
// Python, unused low bits of the last character are ignored.
const B64_RX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/** Standard base64 (RFC 4648 section 4), padded, no line breaks. */
export function b64Encode(b: Uint8Array): string {
  let out = ''
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0)
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
    out += i + 1 < b.length ? B64[(n >> 6) & 63] : '='
    out += i + 2 < b.length ? B64[n & 63] : '='
  }
  return out
}

/** Strict base64 decode (no whitespace, padding required); EnvelopeError('b64') otherwise. */
export function b64Decode(s: string): Uint8Array {
  if (typeof s !== 'string' || !B64_RX.test(s)) throw new EnvelopeError('b64')
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0
  const out = new Uint8Array((s.length / 4) * 3 - pad)
  let o = 0
  for (let i = 0; i < s.length; i += 4) {
    const n =
      (B64_INDEX.get(s[i])! << 18) |
      (B64_INDEX.get(s[i + 1])! << 12) |
      ((B64_INDEX.get(s[i + 2]) ?? 0) << 6) |
      (B64_INDEX.get(s[i + 3]) ?? 0)
    out[o++] = (n >> 16) & 255
    if (o < out.length) out[o++] = (n >> 8) & 255
    if (o < out.length) out[o++] = n & 255
  }
  return out
}

/** json.dumps(value, ensure_ascii=True, separators=(",", ":")) for strings, numbers, objects and arrays. */
export const pyJson = (v: unknown): string =>
  JSON.stringify(v).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))

// ------------------------------------------------------------------ envelope

export const keyId = (publicRaw: Uint8Array): string => sha256Hex(publicRaw).slice(0, 16)

/** The outer path category for an inner path: the login routes keep their own, everything else shares one. */
export const outerPath = (innerPath: string): string =>
  LOGIN_PATHS.includes(innerPath.split('?', 1)[0]) ? OUTER_LOGIN_PATH : OUTER_PATH

const aad = (kind: string, outer: string, kid: string, epk: string, ts: number, challenge: string): Uint8Array =>
  utf8([DOMAIN, kind, 'POST', outer, kid, epk, String(ts), challenge].join('\n'))

/** What one request's answer is opened with (memory only, one request; the key never prints). */
export class Context {
  #kResp: Uint8Array
  readonly aadResp: Uint8Array
  readonly encoding: Encoding
  constructor(kResp: Uint8Array, aadResp: Uint8Array, encoding: Encoding) {
    this.#kResp = kResp
    this.aadResp = aadResp
    this.encoding = encoding
  }
  open(data: Uint8Array): Uint8Array {
    if (!(data instanceof Uint8Array) || data.length < NONCE_BYTES + 16) throw new EnvelopeError('short')
    try {
      return gcm(this.#kResp, data.subarray(0, NONCE_BYTES), this.aadResp).decrypt(data.subarray(NONCE_BYTES))
    } catch {
      throw new EnvelopeError('tag')
    }
  }
  toJSON(): Record<string, never> {
    return {}
  }
}

export type Sealed = {
  outer: string // the outer path
  headers: Record<string, string> // the outer envelope headers (X-Agent-E2E, X-Agent-Challenge, Content-Type)
  body: Uint8Array | string // binary, or the base64 text for encoding 'base64'
  ctx: Context
}

export type SealOptions = {
  encoding?: Encoding // default 'binary'
  flagHeader?: boolean // base64 only: also send X-Agent-E2E-Encoding: b64 (for an engine that rewrites Content-Type)
  random?: Random // the ephemeral key (32 bytes) is drawn first, then the nonce (12)
}

/** host/e2e.py seal_request: -> outer path, outer headers, outer body, context for the answer. */
export function sealRequest(
  serverPub: Uint8Array,
  method: string,
  path: string,
  headers: Record<string, string> | null | undefined,
  body: Body,
  ts: number,
  challenge: string,
  opts: SealOptions = {},
): Sealed {
  const encoding = opts.encoding ?? 'binary'
  const random = opts.random ?? defaultRandom
  if (encoding !== 'binary' && encoding !== 'base64') throw new EnvelopeError('encoding')
  if (typeof challenge !== 'string' || !CHALLENGE_RX.test(challenge)) throw new EnvelopeError('challenge')
  if (!Number.isSafeInteger(ts) || ts < 0) throw new EnvelopeError('ts')
  if (typeof path !== 'string' || typeof method !== 'string') throw new EnvelopeError('inner')
  if (!(serverPub instanceof Uint8Array) || serverPub.length !== 32) throw new EnvelopeError('server key')
  const eph = random(32)
  if (!(eph instanceof Uint8Array) || eph.length !== 32) throw new EnvelopeError('random')
  let epkRaw: Uint8Array
  let shared: Uint8Array
  try {
    epkRaw = x25519.getPublicKey(eph)
    shared = x25519.getSharedSecret(eph, serverPub)
  } catch {
    throw new EnvelopeError('server key')
  }
  if (shared.every((b) => b === 0)) throw new EnvelopeError('server key')
  const okm = hkdf(sha256, shared, utf8(DOMAIN), concat(utf8('keys'), epkRaw, serverPub), 64)
  const kid = keyId(serverPub)
  const epk = b64Encode(epkRaw)
  const outer = outerPath(path)
  const inner: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers ?? {})) if (INNER_HEADERS.includes(k)) inner[k] = v
  const frame = concat(utf8(pyJson({ method: method.toUpperCase(), path, headers: inner }) + '\n'), toBytes(body))
  const nonce = random(NONCE_BYTES)
  if (!(nonce instanceof Uint8Array) || nonce.length !== NONCE_BYTES) throw new EnvelopeError('random')
  const sealed = concat(nonce, gcm(okm.slice(0, 32), nonce, aad('req', outer, kid, epk, ts, challenge)).encrypt(frame))
  const out: Record<string, string> = {
    [HEADER]: `v=1; kid=${kid}; epk=${epk}; ts=${ts}`,
    [CHALLENGE_HEADER]: challenge,
    'Content-Type': encoding === 'base64' ? CONTENT_TYPE_B64 : CONTENT_TYPE,
  }
  if (encoding === 'base64' && opts.flagHeader) out[ENCODING_HEADER] = ENCODING_B64
  const ctx = new Context(okm.slice(32), aad('resp', outer, kid, epk, ts, challenge), encoding)
  return { outer, headers: out, body: encoding === 'base64' ? b64Encode(sealed) : sealed, ctx }
}

export type Opened = { status: number; headers: Record<string, string>; body: Uint8Array }

/** host/e2e.py open_response: the sealed answer (bytes, or the base64 text) -> inner status, headers and body. */
export function openResponse(ctx: Context, data: Uint8Array | string): Opened {
  const raw = typeof data === 'string' ? b64Decode(data) : data
  const plain = ctx.open(raw)
  const nl = plain.indexOf(0x0a)
  if (nl < 0 || nl > MAX_META) throw new EnvelopeError('frame')
  const line = plain.subarray(0, nl)
  if (line.some((b) => b > 0x7f)) throw new EnvelopeError('frame')
  let meta: unknown
  try {
    meta = JSON.parse(String.fromCharCode(...line))
  } catch {
    throw new EnvelopeError('frame')
  }
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) throw new EnvelopeError('frame')
  const { status, headers } = meta as { status?: unknown; headers?: unknown }
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
    throw new EnvelopeError('frame')
  }
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) throw new EnvelopeError('frame')
  if (!Object.values(headers).every((v) => typeof v === 'string')) throw new EnvelopeError('frame')
  return { status, headers: headers as Record<string, string>, body: plain.slice(nl + 1) }
}

/** Header lookup in either letter case (a plain record, or anything with a get() like fetch's Headers). */
export function headerValue(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== 'object') return null
  const h = headers as { get?: (n: string) => unknown }
  if (typeof h.get === 'function') {
    const v = h.get(name)
    return typeof v === 'string' ? v : null
  }
  const want = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === want && typeof v === 'string') return v
  return null
}

/** Which sealed form an outer answer is: 'binary', 'base64', or null when it is not a sealed answer (not 200, or
 * a plain JSON error from before the envelope opened). */
export function answerEncoding(status: number, headers: unknown): Encoding | null {
  if (status !== 200) return null
  const media = (headerValue(headers, 'Content-Type') ?? '').split(';')[0].trim() // exact, as host/services.py
  return media === CONTENT_TYPE ? 'binary' : media === CONTENT_TYPE_B64 ? 'base64' : null
}
