// agent-services transport: one core/1 event to the local daemon's
// POST /core/event, the answer back. connector.json is read on every call (the daemon may restart on a new port or
// rotate its token). Any failure gives the open default (allow, fallback core_down); this module never throws.
// When the core is simply not there (no connector.json, or the fetch threw before the timer, e.g. a refused
// connection), the first such event in this process starts the daemon once (agent_core.py ensure) and is retried
// once. A timeout, a non-200 or a bad answer starts nothing and is not retried: a slow core costs at most
// CORE_TIMEOUT_MS per event.
import type { EngineInterface } from 'claude-code'

export const CORE_TIMEOUT_MS = 3000
export const ENSURE_TIMEOUT_MS = 30000
export const ANSWER_KEYS = ['action', 'reason', 'set', 'context', 'notice', 'fallback'] as const

export type Answer = {
  action: 'allow' | 'deny' | 'rewrite' | 'inject'
  reason: string | null
  set: Record<string, unknown> | null
  context: string[] | null
  notice: string | null
  fallback: string | null
}

const fallback = (): Answer => ({ action: 'allow', reason: null, set: null, context: null, notice: null, fallback: 'core_down' })

// Set once the daemon start was tried in this process (never tried twice).
let ensured = false

// $.env.get takes a literal name (claude plugin validate), so each caller reads its variable and this only trims
async function envText(read: () => Promise<unknown>): Promise<string> {
  try {
    return String((await read()) ?? '').trim()
  } catch {
    return ''
  }
}

async function dataDir($: EngineInterface): Promise<string> {
  const own = await envText(() => $.env.get('AGENT_SVC_DATA_DIR'))
  if (own) {
    return own
  }
  const home = (await envText(() => $.env.get('HOME'))) || (await envText(() => $.env.get('USERPROFILE')))
  return `${home.replace(/[\\/]+$/, '')}/.agent-services`
}

const isAnswer = (x: unknown): x is Answer => {
  if (!x || typeof x !== 'object' || Array.isArray(x)) {
    return false
  }
  const keys = Object.keys(x)
  return keys.length === ANSWER_KEYS.length && ANSWER_KEYS.every(k => keys.includes(k))
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
  let timer: { cancel: () => void } | undefined
  const late = new Promise<'late'>(resolve => {
    timer = $.clock.after(CORE_TIMEOUT_MS, () => resolve('late'))
  })
  try {
    const call = Promise.resolve()
      .then(() =>
        $.http.fetch(`http://127.0.0.1:${info.port}/core/event`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Connector-Token': info.token as string },
          body,
        }),
      )
      .then(res => ({ res }), () => 'threw' as const)
    const got = await Promise.race([call, late])
    if (got === 'late') {
      return 'failed'
    }
    if (got === 'threw') {
      return 'absent'
    }
    if (got.res.status !== 200) {
      return 'failed'
    }
    const ans: unknown = JSON.parse(got.res.text)
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
      } catch {
        // the retry below finds out
      }
      got = await attempt($, body)
    }
    return typeof got === 'object' ? got : fallback()
  } catch {
    return fallback()
  }
}
