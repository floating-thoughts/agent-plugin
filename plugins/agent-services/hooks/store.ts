import type { EngineInterface } from 'claude-code'

export type KV = {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
}

export const KEYS = {
  token: 'token',
  tokenPrev: 'token_prev_sha256',
  rotatedAt: 'rotated_at',
  tokenNext: 'token_next:',
  deviceKey: 'device_key',
  deviceId: 'device_id',
  accountId: 'account_id',
  plan: 'plan',
  expiresAt: 'expires_at',
  endpoint: 'endpoint',
  loginPending: 'login_pending',
  rotateLease: 'rotate_lease',
  block: 'block',
  cool: 'cool',
  badEnvelope: 'bad_envelope',
  clockOff: 'clock_off',
  settings: 'settings',
  org: 'org',
  metricsState: 'metrics_state',
} as const

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

export const CREDENTIAL_KEYS = [KEYS.token, KEYS.tokenPrev, KEYS.rotatedAt, KEYS.accountId, KEYS.plan, KEYS.expiresAt] as const

export const tokenNextKey = (session: string): string => KEYS.tokenNext + session

export function engineStore($: EngineInterface): KV {
  return {
    get: (key) => $.store.get(key),
    set: (key, value) => $.store.set(key, value),
    delete: (key) => $.store.delete(key),
    keys: () => $.store.keys(),
  }
}

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

export async function safeGet(kv: KV, key: string): Promise<unknown> {
  try {
    return await kv.get(key)
  } catch {
    return undefined
  }
}

export async function getText(kv: KV, key: string): Promise<string | null> {
  const v = await safeGet(kv, key)
  return typeof v === 'string' && v ? v : null
}

export async function safeSet(kv: KV, key: string, value: unknown): Promise<boolean> {
  try {
    await kv.set(key, value)
    return true
  } catch {
    return false
  }
}

export async function safeDelete(kv: KV, key: string): Promise<boolean> {
  try {
    await kv.delete(key)
    return true
  } catch {
    return false
  }
}

export async function tokenNextKeys(kv: KV): Promise<string[]> {
  try {
    return (await kv.keys()).filter((k) => k.startsWith(KEYS.tokenNext))
  } catch {
    return []
  }
}
