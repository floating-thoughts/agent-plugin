import { CONTRACT } from './contract'
import { checkSchema } from './svc_wire'
import type { KV } from './store'

export type RulesState = 'pending' | 'on' | 'off'
export type RulesAnswer = { version: string; scope: string; tables: Record<string, unknown>; support_contact?: string }
type RulesSvc = {
  authState: () => Promise<string>
  settings: () => Promise<{ served: { channel: string } }>
  call: (method: string, path: string, body?: unknown, opts?: { kind?: any }) => Promise<{ ok: boolean; status?: number; body?: unknown }>
  status?: () => Promise<Record<string, unknown>>
}

export const RULES_ROUTE = '/served/rules'
export const RULES_OFF_LINE = 'Command guarding and secret masking are off: agent-services is signed out.'
export const RULES_PENDING_LINE = 'Secret masking is not ready yet: the rule tables have not arrived.'
export const RELIABILITY_TABLES = ['reliability_a', 'reliability_b'] as const
export const RELIABILITY_KEY = 'rules_reliability'

const API = CONTRACT as unknown as { routes: { method: string; path: string; responses: Record<string, any> }[] }
const SCHEMA = API.routes.find((r) => r.method === 'POST' && r.path === RULES_ROUTE)!.responses['200']

let held: RulesAnswer | null = null
let state: RulesState = 'pending'
let loading: Promise<RulesState> | null = null
let svcRef: RulesSvc | null = null
let account: string | null = null
let checkedAt = 0
let clearers: (() => void)[] = []
let kept: Record<string, unknown> | null = null
let keptKv: KV | null = null

export function onRulesClear(fn: () => void): void {
  clearers.push(fn)
}

export function clearRules(): void {
  held = null
  state = 'off'
  loading = null
  svcRef = null
  account = null
  checkedAt = 0
  kept = null
  if (keptKv) void keptKv.delete(RELIABILITY_KEY).catch(() => undefined)
  for (const fn of clearers) {
    try {
      fn()
    } catch {}
  }
}

async function accountOf(svc: RulesSvc): Promise<string | null> {
  try {
    const id = svc.status ? (await svc.status()).account_id : null
    return typeof id === 'string' && id ? id : null
  } catch {
    return null
  }
}

export async function rulesLive(): Promise<boolean> {
  if (!held && !kept) return false
  const svc = svcRef
  if (!svc) return held !== null
  try {
    if ((await svc.authState()) !== 'ok') {
      clearRules()
      return false
    }
    const now = Date.now()
    if (svc.status && now - checkedAt >= 5000) {
      checkedAt = now
      if ((await accountOf(svc)) !== account) {
        clearRules()
        return false
      }
    }
  } catch {
    clearRules()
    return false
  }
  return held !== null
}

export function rulesState(): RulesState {
  return held ? 'on' : state
}

export function rulesTable<T = unknown>(name: string): T | null {
  const t = held?.tables[name]
  return t === undefined ? null : (t as T)
}


export function servedValue(name: string, key: string): unknown {
  const t = held?.tables[name]
  return t && typeof t === 'object' && !Array.isArray(t) ? (t as Record<string, unknown>)[key] : undefined
}

export function servedNumber(name: string, key: string, fallback: number, min = Number.MIN_VALUE,
  max = Number.MAX_SAFE_INTEGER): number {
  const v = servedValue(name, key)
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v >= min && v <= max ? v : fallback
}

export const RX_SOURCE_MAX = 512
export const RX_INPUT_MAX = 8192

const repeatAt = (src: string, i: number): boolean =>
  src[i] === '+' || src[i] === '*' || (src[i] === '{' && /^\{\d+(,\d*)?\}/.test(src.slice(i)))

export function riskyPattern(src: string): boolean {
  if (src.length > RX_SOURCE_MAX) return true
  const open: boolean[] = []
  const optional = (k: number) => /^(?:\?|\*|\{0[,}])/.test(src.slice(k, k + 3))
  let inClass = false
  let wide = false
  let run = 0
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!
    if (c === '\\') {
      const e = src[i + 1] ?? ''
      i++
      if (inClass) continue
      wide = /[sSwWD]/.test(e)
      if (!wide && !/[bBd0-9]/.test(e) && !optional(i + 1)) run = 0
      continue
    }
    if (inClass) { if (c === ']') { inClass = false; wide = true } continue }
    if (c === '[') { inClass = true; continue }
    if (c === '.') { wide = true; continue }
    if (wide && (c === '*' || c === '+' || (c === '{' && /^\{\d+,\}/.test(src.slice(i)))) && ++run > 2) return true
    wide = false
    if (c === '(') { open.push(false); continue }
    if (c === ')') {
      const inner = open.pop() ?? false
      if (inner && repeatAt(src, i + 1)) return true
      if (inner && open.length) open[open.length - 1] = true
      continue
    }
    if (open.length && (c === '|' || repeatAt(src, i))) open[open.length - 1] = true
    const q = c === '{' ? /^\{\d+(?:,\d*)?\}/.exec(src.slice(i)) : null
    if (q) i += q[0].length - 1
    else if (!'*+?{}|^$'.includes(c) && !optional(i + 1)) run = 0
  }
  return false
}

let rxCache = new Map<string, RegExp | null>()

export function servedRegex(name: string, key: string, fallback: RegExp | null = null): RegExp | null {
  const v = servedValue(name, key) as Record<string, unknown> | undefined
  if (!v || typeof v !== 'object' || typeof v.pattern !== 'string' || riskyPattern(v.pattern)) return fallback
  const flags = typeof v.flags === 'string' ? [...new Set(v.flags.replace(/[^imsu]/g, ''))].join('') : ''
  const id = `${flags}/${v.pattern}`
  if (!rxCache.has(id)) {
    if (rxCache.size > 64) rxCache = new Map()
    let rx: RegExp | null = null
    try {
      rx = new RegExp(v.pattern, flags)
    } catch {}
    rxCache.set(id, rx)
  }
  return rxCache.get(id) ?? fallback
}

const plain = (t: unknown): t is Record<string, unknown> => !!t && typeof t === 'object' && !Array.isArray(t)

export function reliabilityTable(name: string): Record<string, unknown> | null {
  if (!(RELIABILITY_TABLES as readonly string[]).includes(name)) return null
  const t = held?.tables[name]
  if (plain(t)) return t
  const k = kept?.[name]
  return plain(k) ? k : null
}

async function readKept(kv: KV, who: string): Promise<Record<string, unknown> | null> {
  try {
    const v = await kv.get(RELIABILITY_KEY)
    return plain(v) && v.account === who && plain(v.tables) ? v.tables : null
  } catch {
    return null
  }
}

async function writeKept(kv: KV, who: string | null, tables: Record<string, unknown>): Promise<void> {
  const keep: Record<string, unknown> = {}
  for (const n of RELIABILITY_TABLES) if (plain(tables[n])) keep[n] = tables[n]
  try {
    if (who && Object.keys(keep).length) await kv.set(RELIABILITY_KEY, { account: who, tables: keep })
    else await kv.delete(RELIABILITY_KEY)
  } catch {}
}

export function rulesAccount(): string | null {
  return held ? account : null
}

export function supportContact(): string | null {
  return held?.support_contact || null
}

export function rulesVersion(): string | null {
  return held?.version ?? null
}

export function loadRules(svc: RulesSvc, kv: KV | null = null): Promise<RulesState> {
  if (kv) keptKv = kv
  if (held) return rulesLive().then((on) => (on ? 'on' : loadRules(svc, kv)))
  if (loading) return loading
  loading = (async (): Promise<RulesState> => {
    try {
      if ((await svc.authState()) !== 'ok') return (state = 'off')
      const who = await accountOf(svc)
      if (keptKv && who && !kept) {
        kept = await readKept(keptKv, who)
        if (kept) {
          svcRef = svc
          account = who
          checkedAt = 0
        }
      }
      const channel = (await svc.settings()).served.channel
      let res = await svc.call('POST', RULES_ROUTE, { channel, contact: true }, { kind: 'served' })
      if (!res?.ok && res?.status === 422) res = await svc.call('POST', RULES_ROUTE, { channel }, { kind: 'served' })
      const b = res?.body as RulesAnswer | undefined
      if (!res?.ok || !b || typeof b !== 'object' || checkSchema(b, SCHEMA).length) return (state = 'off')
      if ((await svc.authState()) !== 'ok' || (await accountOf(svc)) !== who) {
        kept = null
        return (state = 'off')
      }
      held = { version: b.version, scope: b.scope, tables: b.tables, support_contact: b.support_contact }
      svcRef = svc
      account = who
      checkedAt = 0
      if (keptKv) await writeKept(keptKv, who, b.tables)
      return (state = 'on')
    } catch {
      return (state = 'off')
    } finally {
      loading = null
    }
  })()
  return loading
}

export async function rulesSettled(ms: number): Promise<RulesState> {
  if (loading) await Promise.race([loading, new Promise((r) => setTimeout(r, ms))])
  return rulesState()
}

export function setRulesForTest(tables: Record<string, unknown> | null, s: RulesState = tables ? 'on' : 'off',
  acc: string | null = null, contact?: string): void {
  held = tables ? { version: 'test', scope: 'product', tables, support_contact: contact } : null
  state = s
  loading = null
  svcRef = null
  account = acc
  checkedAt = 0
  kept = null
}
