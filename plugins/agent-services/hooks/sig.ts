import { ed25519, sha512 } from './noble.js'
import { b64Decode, b64Encode, concat, defaultRandom, headerValue, hex, keyId, sha256Hex, toBytes, utf8 } from './e2e'
import type { Body, Random } from './e2e'

export const SIG_HEADER = 'X-Agent-Server-Signature'
export const SIG_DOMAIN = 'agent-svc-response/1'
export const SIG_SKEW_SECONDS = 300
export const STRICT = { zip215: false } as const
const SIG_FIELDS = /^v=1; kid=([0-9a-f]{16}); ts=(\d{1,12}); sig=([A-Za-z0-9+/]{86}==)$/

export type ServerKeys = Record<string, Uint8Array>
export type Unverified = 'unsigned_response' | 'bad_signature' | 'stale_response'

export function serverKeys(publicKeysB64: string[]): ServerKeys {
  const out: ServerKeys = {}
  for (const k of publicKeysB64) {
    const raw = b64Decode(k)
    if (raw.length !== 32) throw new Error('server key is not 32 bytes')
    let ok = false
    try {
      ok = !ed25519.Point.fromBytes(raw, false).isSmallOrder()
    } catch {
      ok = false
    }
    if (!ok) throw new Error('server key is small order or not canonical')
    out[keyId(raw)] = raw
  }
  return out
}

const L = 2n ** 252n + 27742317777372353535851937790883648493n
const le = (b: Uint8Array): bigint => {
  let n = 0n
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i])
  return n
}
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i])

export function verifyEd25519(sig: Uint8Array, msg: Uint8Array, pub: Uint8Array): boolean {
  if (!(sig instanceof Uint8Array) || sig.length !== 64 || !(pub instanceof Uint8Array) || pub.length !== 32) {
    return false
  }
  try {
    if (!ed25519.verify(sig, msg, pub, STRICT)) return false
    const r = sig.subarray(0, 32)
    const s = le(sig.subarray(32))
    if (s >= L) return false
    const k = le(sha512(concat(r, pub, msg))) % L
    const A = ed25519.Point.fromBytes(pub, false)
    const check = ed25519.Point.BASE.multiplyUnsafe(s).subtract(A.multiplyUnsafe(k))
    return same(check.toBytes(), r)
  } catch {
    return false
  }
}

export const responseMessage = (
  status: number,
  method: string,
  path: string,
  challenge: string,
  ts: number,
  body: Body,
): Uint8Array =>
  utf8(
    [SIG_DOMAIN, String(Math.trunc(status)), method.toUpperCase(), path, challenge, String(ts), sha256Hex(toBytes(body))].join(
      '\n',
    ),
  )

export function verifyResponse(
  keys: ServerKeys,
  method: string,
  wirePath: string,
  challenge: string,
  status: number,
  headers: unknown,
  body: Body,
  now: number,
): Unverified | null {
  const hv = headerValue(headers, SIG_HEADER)
  if (!hv) return 'unsigned_response'
  const m = SIG_FIELDS.exec(hv.trim())
  if (!m || !Object.prototype.hasOwnProperty.call(keys, m[1])) return 'bad_signature'
  const ts = Number(m[2])
  const msg = responseMessage(status, method, wirePath.split('?', 1)[0], challenge, ts, body)
  let sig: Uint8Array
  try {
    sig = b64Decode(m[3])
  } catch {
    return 'bad_signature'
  }
  if (!verifyEd25519(sig, msg, keys[m[1]])) return 'bad_signature'
  if (Math.abs(now - ts) > SIG_SKEW_SECONDS) return 'stale_response'
  return null
}

export function signedTs(headers: unknown): number | null {
  const m = SIG_FIELDS.exec((headerValue(headers, SIG_HEADER) ?? '').trim())
  return m ? Number(m[2]) : null
}


export const newDeviceSeed = (random: Random = defaultRandom): Uint8Array => {
  const seed = random(32)
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error('random')
  return seed
}

export const devicePublicKey = (seed: Uint8Array): string => b64Encode(ed25519.getPublicKey(seed))

export const deviceMessage = (method: string, wirePath: string, body: Body, ts: string, nonce: string): Uint8Array =>
  utf8(`${method}\n${wirePath.split('?', 1)[0]}\n${sha256Hex(toBytes(body))}\n${ts}\n${nonce}`)

export type DeviceAuth = {
  token: string
  accountId: string
  deviceId: string
  deviceSeed: Uint8Array
  claudeHash: string
}

export function signedHeaders(
  method: string,
  wirePath: string,
  body: Body,
  auth: DeviceAuth,
  now: number,
  random: Random = defaultRandom,
): Record<string, string> {
  const ts = String(Math.trunc(now))
  const nonce = hex(random(16))
  const sig = b64Encode(ed25519.sign(deviceMessage(method, wirePath, body, ts, nonce), auth.deviceSeed))
  return {
    Authorization: `Bearer ${auth.token}`,
    'X-Agent-Account': auth.accountId,
    'X-Agent-Device': auth.deviceId,
    'X-Agent-Claude': auth.claudeHash,
    'X-Agent-Timestamp': ts,
    'X-Agent-Nonce': nonce,
    'X-Agent-Signature': sig,
  }
}
