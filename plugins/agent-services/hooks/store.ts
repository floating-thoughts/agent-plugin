// The $.store adapter and the key layout of the svc channel (plan 3.3, 3.4, 3.9).
//
// The library (svc.ts, outbox.ts, ...) never touches the engine: it gets a KV. engineStore($) is the one place that
// wraps $.store; memoryStore() is the same interface in memory (tests, and harnesses without a store).
//
// $.store is a plain JSON file under the Claude Code config directory, readable by every other plugin (measured) and by
// any process running as the user, and it has no atomic read-modify-write across sessions. So:
// - Only the device credential is kept there, in plaintext, as plan 3.4 states (any wrapping key would sit next to
//   it): token, token_next:<session> (an unconfirmed rotation of one session), device_key (the Ed25519 seed).
//   The previous token of the rotation grace is kept only as its sha256 (token_prev_sha256): the grace needs only an
//   equality check, so the old token itself is never stored.
// - Nothing else secret is ever written: no sign-in code, no served text, no answer body, no guard material.
// - Every value is read again on each request and never cached across requests (plan 3.3 item 4); every rule that
//   uses a lease stays correct when two sessions both believe they hold it.
// - The endpoint and the server keys are never read from here (plan 3.3 item 1): "endpoint" holds only the
//   fingerprint the sign-in is bound to.
import type { EngineInterface } from 'claude-code'

export type KV = {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
}

/** The svc channel's keys in $.store. */
export const KEYS = {
  token: 'token', // the bearer token (plaintext, 3.4)
  tokenPrev: 'token_prev_sha256', // sha256 hex of the token a confirmed rotation replaced (the 5 minute grace)
  rotatedAt: 'rotated_at', // ms since the epoch of that rotation
  tokenNext: 'token_next:', // + session id: the new token of a rotation not yet confirmed (plaintext)
  deviceKey: 'device_key', // base64 of the 32-byte Ed25519 device seed (plaintext, 3.4)
  deviceId: 'device_id', // dev_ + 16 hex
  accountId: 'account_id',
  plan: 'plan',
  expiresAt: 'expires_at', // unix seconds of the sign-in's expiry, as the server answered it
  endpoint: 'endpoint', // the client config fingerprint the sign-in is bound to (fp1:...)
  loginPending: 'login_pending', // { email, until }: a mailed code may be finished by any session for 10 minutes
  rotateLease: 'rotate_lease', // { holder, until }: best-effort rotation lease
  block: 'block', // { code, until, token_sha256 }: 401 / 423 / locked_out block shared by all sessions
  cool: 'cool', // { until, since }: shared cool-down (Retry-After), ms since the epoch
  badEnvelope: 'bad_envelope', // { n, at }: bad_envelope answers in a row, shared, so the IP budget is spared
  settings: 'settings', // { offline, services, served }: the user's switches (port of settings.json)
} as const

/** What a sign-out drops (the sign-in and the device binding); logout keeps the device. */
export const SIGN_OUT_KEYS = [
  KEYS.token,
  KEYS.tokenPrev,
  KEYS.rotatedAt,
  KEYS.accountId,
  KEYS.plan,
  KEYS.expiresAt,
  KEYS.deviceKey,
  KEYS.deviceId,
  KEYS.endpoint,
  KEYS.block,
] as const

/** What logout and a real revocation drop (the device key and id stay, as in host/services.py). */
export const CREDENTIAL_KEYS = [KEYS.token, KEYS.tokenPrev, KEYS.rotatedAt, KEYS.accountId, KEYS.plan, KEYS.expiresAt] as const

export const tokenNextKey = (session: string): string => KEYS.tokenNext + session

/** The KV over the engine's own store. Errors are passed on (the caller decides what a refused write means). */
export function engineStore($: EngineInterface): KV {
  return {
    get: (key) => $.store.get(key),
    set: (key, value) => $.store.set(key, value),
    delete: (key) => $.store.delete(key),
    keys: () => $.store.keys(),
  }
}

/** The same interface in memory; values are copied through JSON like $.store does. */
export function memoryStore(init: Record<string, unknown> = {}): KV & { dump(): Record<string, unknown> } {
  const m = new Map<string, string>()
  for (const [k, v] of Object.entries(init)) m.set(k, JSON.stringify(v))
  return {
    get: async (key) => (m.has(key) ? JSON.parse(m.get(key)!) : undefined),
    set: async (key, value) => {
      const text = JSON.stringify(value)
      if (text === undefined) throw new Error('not JSON data')
      m.set(key, text)
    },
    delete: async (key) => {
      m.delete(key)
    },
    keys: async () => [...m.keys()],
    dump: () => Object.fromEntries([...m].map(([k, v]) => [k, JSON.parse(v)])),
  }
}

/** get that answers undefined when the store refuses (a refused read is treated as "not there"). */
export async function safeGet(kv: KV, key: string): Promise<unknown> {
  try {
    return await kv.get(key)
  } catch {
    return undefined
  }
}

/** A string value, or null. */
export async function getText(kv: KV, key: string): Promise<string | null> {
  const v = await safeGet(kv, key)
  return typeof v === 'string' && v ? v : null
}

/** set; false when the store refused it. */
export async function safeSet(kv: KV, key: string, value: unknown): Promise<boolean> {
  try {
    await kv.set(key, value)
    return true
  } catch {
    return false
  }
}

/** delete; false when the store refused it (it may still hold the value). */
export async function safeDelete(kv: KV, key: string): Promise<boolean> {
  try {
    await kv.delete(key)
    return true
  } catch {
    return false
  }
}

/** Every token_next:<session> key now in the store. */
export async function tokenNextKeys(kv: KV): Promise<string[]> {
  try {
    return (await kv.keys()).filter((k) => k.startsWith(KEYS.tokenNext))
  } catch {
    return []
  }
}
