// agent-services transport: one core/1 event to the local daemon's POST /core/event, the answer back. connector.json
// is read on every call (the daemon may restart on a new port or rotate its token). Any failure gives the open default
// (allow, fallback core_down); this module never throws. When the core is not there (no connector.json, a refused
// connection, or an answer without the daemon's proof: never obeyed), the first such event in this process
// starts the daemon once (agent_core.py ensure) and is retried once. A timeout, a non-200 or a bad answer starts
// nothing and is not retried: a slow core costs at most CORE_TIMEOUT_MS per event.
import type { EngineInterface } from 'claude-code'

export const CORE_TIMEOUT_MS = 3000
export const ENSURE_TIMEOUT_MS = 30000
export const ANSWER_KEYS = ['action', 'reason', 'set', 'context', 'notice', 'fallback'] as const
const EVENT_PATH = '/core/event'
const NONCE_HEADER = 'X-Connector-Nonce'
const PROOF_HEADER = 'x-connector-proof'

export type Answer = {
  action: 'allow' | 'deny' | 'rewrite' | 'inject'; reason: string | null; set: Record<string, unknown> | null
  context: string[] | null; notice: string | null; fallback: string | null
}
const fallback = (): Answer => ({ action: 'allow', reason: null, set: null, context: null, notice: null, fallback: 'core_down' })
let ensured = false // set once the daemon start was tried in this process (never tried twice)
// $.env.get takes a literal name (claude plugin validate), so each caller reads its variable and this only trims
async function envText(read: () => Promise<unknown>): Promise<string> {
  try {
    return String((await read()) ?? '').trim()
  } catch {
    return ''
  }
}
// As Python's default_data_dir(): AGENT_SVC_DATA_DIR, else <home>/.agent-services; home is USERPROFILE on Windows
export async function dataDir($: EngineInterface): Promise<string> {
  const own = await envText(() => $.env.get('AGENT_SVC_DATA_DIR'))
  if (own) {
    return own
  }
  const home = await envText(() => $.env.get('HOME'))
  const profile = await envText(() => $.env.get('USERPROFILE'))
  const windows = (await envText(() => $.env.get('OS'))) === 'Windows_NT'
  return `${(windows ? profile || home : home || profile).replace(/[\\/]+$/, '')}/.agent-services`
}
const isAnswer = (x: unknown): x is Answer =>
  !!x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length === ANSWER_KEYS.length && ANSWER_KEYS.every(k => Object.prototype.hasOwnProperty.call(x, k))
// The daemon's proof (host/httpbase.daemon_proof): hex HMAC-SHA256 under the local token of
// nonce, status, method and path (each ending in a newline) + body, on crypto.subtle.digest (no HMAC in the module).
const hex = (b: Uint8Array): string => Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
const sha = async (...parts: Uint8Array[]): Promise<Uint8Array> => {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  parts.reduce((at, p) => (all.set(p, at), at + p.length), 0)
  return new Uint8Array(await crypto.subtle.digest('SHA-256', all))
}
export async function daemonProof(token: string, nonce: string, status: number, method: string, path: string, body: string): Promise<string> {
  const enc = new TextEncoder()
  let k = enc.encode(token)
  k = k.length > 64 ? await sha(k) : k
  const pad = (c: number) => Uint8Array.from({ length: 64 }, (_, i) => (k[i] ?? 0) ^ c)
  return hex(await sha(pad(0x5c), await sha(pad(0x36), enc.encode(`${nonce}\n${status}\n${method}\n${path}\n`), enc.encode(body))))
}
const proofOk = async (token: string, nonce: string, status: number, path: string, body: string, got: unknown) => {
  const want = await daemonProof(token, nonce, status, 'POST', path, body)
  const g = typeof got === 'string' && got.length === want.length ? got : want.replace(/./g, '-')
  return [...want].reduce((d, c, i) => d | (c.charCodeAt(0) ^ g.charCodeAt(i)), 0) === 0
}
// One try: the answer, 'absent' (the core is not there) or 'failed' (it is there but did not answer well).
async function attempt($: EngineInterface, body: string): Promise<Answer | 'absent' | 'failed'> {
  let info: { port?: unknown; token?: unknown }
  try {
    info = JSON.parse(String(await $.fs.read(`${await dataDir($)}/services/connector.json`)))
  } catch {
    return 'absent'
  }
  if (!info || typeof info.token !== 'string' || (typeof info.port !== 'number' && typeof info.port !== 'string')) {
    return 'failed'
  }
  const token = info.token
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)))
  let timer: { cancel: () => void } | undefined
  const late = new Promise<'late'>(resolve => {
    timer = $.clock.after(CORE_TIMEOUT_MS, () => resolve('late'))
  })
  try {
    const headers = { 'Content-Type': 'application/json', 'X-Connector-Token': token, [NONCE_HEADER]: nonce }
    const call = Promise.resolve()
      .then(() => $.http.fetch(`http://127.0.0.1:${info.port}${EVENT_PATH}`, { method: 'POST', headers, body }))
      .then(res => ({ res }), () => 'threw' as const)
    const got = await Promise.race([call, late])
    if (got === 'late' || got === 'threw') {
      return got === 'late' ? 'failed' : 'absent'
    }
    const { status, text } = got.res
    if (!(await proofOk(token, nonce, status, EVENT_PATH, String(text), got.res.headers?.[PROOF_HEADER]))) {
      return 'absent' // not the daemon (a stale connector.json whose port another process holds)
    }
    const ans: unknown = status === 200 ? JSON.parse(text) : null
    return isAnswer(ans) ? ans : 'failed'
  } catch {
    return 'failed'
  } finally {
    await maybeCancel(timer)
  }
}

const maybeCancel = async (timer: { cancel: () => void } | undefined) => Promise.resolve().then(() => timer?.cancel()).catch(() => undefined)
export async function coreEvent($: EngineInterface, event: Record<string, unknown>): Promise<Answer> {
  try {
    const body = JSON.stringify(event)
    let got = await attempt($, body)
    if (got === 'absent' && !ensured) {
      ensured = true
      try {
        const python = (await envText(() => $.env.get('AGENT_CORE_PYTHON'))) || 'python'
        await $.process.run([python, `${$.plugin.root}/hooks/agent_core.py`, 'ensure'], { timeoutMs: ENSURE_TIMEOUT_MS })
      } catch {} // the retry below finds out
      got = await attempt($, body)
    }
    return typeof got === 'object' ? got : fallback()
  } catch {
    return fallback()
  }
}
