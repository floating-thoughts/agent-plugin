// The served rule tables (POST /served/rules): fetched once per signed-in session, kept in this module's memory only
// (never written to the store, a file or a log), and read by the local engines (cmdguard.ts, vault.ts, trim.ts,
// subagents.ts, watch.ts). No command, prompt or tool text is sent; the request carries only the channel.
//
// Sign-in gate: no tables means every engine is off and passes each event through untouched. Once tables arrived in
// this session they stay while the sign-in they were fetched for holds, also when the server becomes unreachable
// later; a sign-out, an expired or blocked sign-in, a new sign-in or another account clears them at once
// (clearRules), together with what the engines keep in memory (the secret vault, remembered mail tabs).
// While the tables are missing the band, the status line and one session-start line say so (RULES_OFF_LINE).
import { CONTRACT } from './contract'
import { checkSchema } from './svc_wire'

export type RulesState = 'pending' | 'on' | 'off'
export type RulesAnswer = { version: string; scope: string; tables: Record<string, unknown> }
type RulesSvc = {
  authState: () => Promise<string>
  settings: () => Promise<{ served: { channel: string } }>
  call: (method: string, path: string, body?: unknown, opts?: { kind?: any }) => Promise<{ ok: boolean; body?: unknown }>
  status?: () => Promise<Record<string, unknown>>
}

export const RULES_ROUTE = '/served/rules'
export const RULES_OFF_LINE = 'Command guarding and secret masking are off: agent-services is signed out.'
export const RULES_PENDING_LINE = 'Secret masking is not ready yet: the rule tables have not arrived.'

const API = CONTRACT as unknown as { routes: { method: string; path: string; responses: Record<string, any> }[] }
const SCHEMA = API.routes.find((r) => r.method === 'POST' && r.path === RULES_ROUTE)!.responses['200']

let held: RulesAnswer | null = null
let state: RulesState = 'pending'
let loading: Promise<RulesState> | null = null
let svcRef: RulesSvc | null = null // the sign-in the tables were fetched with (null: set by a test)
let account: string | null = null // the account they were fetched for
let checkedAt = 0 // when the account was last compared (ms)
let clearers: (() => void)[] = []

/** An engine's in-memory state to drop whenever the tables are cleared (vault.ts, cmdguard.ts). */
export function onRulesClear(fn: () => void): void {
  clearers.push(fn)
}

/** Drop the tables and everything the engines keep in memory: every engine is off until a new fetch. */
export function clearRules(): void {
  held = null
  state = 'off'
  loading = null
  svcRef = null
  account = null
  checkedAt = 0
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

/** Every engine entry point awaits this first: true while the tables are held for a sign-in that is still ok; on
 * an auth fail (signed out, expired, locked, paused) or another account signed in the tables are cleared and it is
 * false. The account is compared at most every 5 s (the auth state itself is cached by the sign-in). */
export async function rulesLive(): Promise<boolean> {
  if (!held) return false
  const svc = svcRef
  if (!svc) return true // set by a test
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

/** The state of the tables in this session: pending until the first fetch ends, then on or off. */
export function rulesState(): RulesState {
  return held ? 'on' : state
}

/** One table by name, or null (signed out, not loaded, or not served). */
export function rulesTable<T = unknown>(name: string): T | null {
  const t = held?.tables[name]
  return t === undefined ? null : (t as T)
}

/** The served version of the tables, or null. */
export function rulesVersion(): string | null {
  return held?.version ?? null
}

/** Fetch the tables (session.start, background). Never throws. Tables already held stay held while their sign-in
 * holds (rulesLive; else they are fetched again); a failure before any arrived turns the state to off. */
export function loadRules(svc: RulesSvc): Promise<RulesState> {
  if (held) return rulesLive().then((on) => (on ? 'on' : loadRules(svc)))
  if (loading) return loading
  loading = (async (): Promise<RulesState> => {
    try {
      if ((await svc.authState()) !== 'ok') return (state = 'off')
      const who = await accountOf(svc)
      const channel = (await svc.settings()).served.channel
      const res = await svc.call('POST', RULES_ROUTE, { channel }, { kind: 'served' })
      const b = res?.body as RulesAnswer | undefined
      if (!res?.ok || !b || typeof b !== 'object' || checkSchema(b, SCHEMA).length) return (state = 'off')
      if ((await svc.authState()) !== 'ok' || (await accountOf(svc)) !== who) return (state = 'off') // changed meanwhile
      held = { version: b.version, scope: b.scope, tables: b.tables }
      svcRef = svc
      account = who
      checkedAt = 0
      return (state = 'on')
    } catch {
      return (state = 'off')
    } finally {
      loading = null
    }
  })()
  return loading
}

/** The state once a fetch in flight has ended, waiting at most `ms` (prompt.submit masks the first prompt then). */
export async function rulesSettled(ms: number): Promise<RulesState> {
  if (loading) await Promise.race([loading, new Promise((r) => setTimeout(r, ms))])
  return rulesState()
}

/** Tests only: set the tables (null clears them) and the state; no sign-in is checked for them. */
export function setRulesForTest(tables: Record<string, unknown> | null, s: RulesState = tables ? 'on' : 'off'): void {
  held = tables ? { version: 'test', scope: 'product', tables } : null
  state = s
  loading = null
  svcRef = null
  account = null
  checkedAt = 0
}
