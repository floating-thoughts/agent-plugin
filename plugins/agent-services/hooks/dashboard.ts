// agent-services dashboard publisher. After a turn, when the core has rendered a newer page
// (<data dir>/dashboard/index.html, recorded in <data dir>/services/dashboard.json), the page is published as an
// Artifact through the engine's own tool call, so the permission check and its dialog apply as to any call.
// At most one attempt per PUBLISH_INTERVAL_MS in this process; a denied call stops it for the session. The outcome
// goes back to the in-process core through `report` (register.ts passes the core's dashboard_published {url} and
// dashboard_denied events), and a deny's reason to `note` (wiring.ts logs it in the outbox). This module never throws.
//
// Nothing is published without the user's consent (command.ts CONSENT_KEY): when it was never given, the first
// publish that is due asks once in the dialog (not in a -p run, at most once per session; "Not now" holds 7 days).
// With consent, register.ts's tool.check hook allows exactly this module's own calls (dashboardGrant), so the
// Artifact tool runs without a permission rule; the user's settings are never written.
import type { EngineInterface } from 'claude-code'
import { consentState, dataDir, readConsent } from './command'
import { engineStore } from './store'

export const PUBLISH_INTERVAL_MS = 600_000
export const PUBLISH_START_WAIT_MS = 4000 // turn.complete waits this long so the Artifact call starts inside it
const TOOL = 'Artifact'
const URL_RX = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/
// The tool refuses a publish to an artifact this session has neither read nor published: read it once, then retry.
const UNREAD_RX = /\bread\b/i
export const GRANT_REASON = 'agent-services dashboard (user allowed)' // the tool.check verdict's reason
const INPUT_KEYS = ['action', 'file_path', 'url', 'icon'] // what this module's publish call carries

type State = { changed_at: number | null; url: string | null; published_at: number | null; denied: boolean }
type Res = { deny?: string; text?: string; isError?: boolean; result?: unknown }
/** Where the outcome goes: (kind, fields) as a core event of this session (dashboard_published, dashboard_denied). */
export type Report = (session: string, kind: string, fields?: Record<string, unknown>) => unknown
/** interactive: false in a -p run (no consent dialog then); note: receives a denied call's reason. */
export type PublishOptions = { interactive?: boolean; note?: (d: { reason?: string }) => void }

let lastAttempt: number | null = null
let deniedIn: string | null = null // the session whose call was denied

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const textOf = (r: Res | null): string => {
  if (!r) {
    return ''
  }
  if (typeof r.text === 'string') {
    return r.text
  }
  try {
    return JSON.stringify(r.result ?? '')
  } catch {
    return ''
  }
}

async function readState($: EngineInterface, dir: string): Promise<State | null> {
  try {
    const s = JSON.parse(String(await $.fs.read(`${dir}/services/dashboard.json`)))
    if (!s || typeof s !== 'object') {
      return null
    }
    const url = typeof s.url === 'string' && URL_RX.test(s.url) ? s.url : null
    return { changed_at: num(s.changed_at), url, published_at: num(s.published_at), denied: s.denied === true }
  } catch {
    return null
  }
}

async function call($: EngineInterface, input: Record<string, unknown>): Promise<Res> {
  return (await $.tool.call({ tool: TOOL, ...input } as any)) as Res
}

const send = async (report: Report | undefined, session: string, kind: string, fields: Record<string, unknown> = {}) => {
  try {
    await report?.(session, kind, fields)
  } catch {
    // the publish outcome stands
  }
}

// Called after each main-agent turn; resolves to what it did (for the log and the tests), never rejects.
export async function publishDashboard($: EngineInterface, report?: Report, opts: PublishOptions = {}): Promise<string> {
  try {
    const session = String(await $.session.id())
    if (deniedIn === session) {
      return 'denied_before'
    }
    const now = Number(await $.clock.now())
    if (lastAttempt !== null && now - lastAttempt < PUBLISH_INTERVAL_MS) {
      return 'throttled'
    }
    const dir = await dataDir($)
    const st = await readState($, dir)
    if (!st || st.changed_at === null) {
      return 'no_page'
    }
    const published = st.published_at ?? 0
    if (st.changed_at <= published) {
      return 'unchanged'
    }
    if (st.published_at !== null && now - st.published_at * 1000 < PUBLISH_INTERVAL_MS) {
      return 'too_soon'
    }
    if (!(await $.tool.list()).some(t => t.name === TOOL)) {
      return 'no_tool'
    }
    // no dialog from here: after a turn nobody can be asked (the desktop app showed none); the consent is asked by
    // the slash command (after a sign-in, and by status while unanswered)
    if (consentState(await readConsent(engineStore($)), now) !== 'allow') {
      return 'not_allowed'
    }
    lastAttempt = now
    const input: Record<string, unknown> = { file_path: `${dir}/dashboard/index.html`, ...(st.url ? { url: st.url } : { icon: 'chart' }) }
    let res = await call($, input)
    if (res.deny === undefined && res.isError === true && st.url && UNREAD_RX.test(textOf(res))) {
      const read = await call($, { action: 'read', url: st.url })
      if (read.deny !== undefined) {
        res = read
      } else {
        res = await call($, input)
      }
    }
    if (res.deny !== undefined) {
      deniedIn = session
      try {
        opts.note?.({ reason: typeof res.deny === 'string' ? res.deny : undefined })
      } catch {
        // the outcome stands
      }
      await send(report, session, 'dashboard_denied')
      return 'denied'
    }
    const url = res.isError === true ? null : (textOf(res).match(URL_RX)?.[0] ?? st.url)
    if (!url) {
      return 'failed'
    }
    await send(report, session, 'dashboard_published', { url })
    return 'published'
  } catch {
    return 'failed'
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Whether a tool.check of the Artifact tool is this module's own call, to be allowed: consent is "allow" and the
 * input is the publish of <data dir>/dashboard/index.html (to the stored dashboard URL when it has one, icon chart
 * otherwise) or the read of the stored dashboard URL. The caller checks that this plugin raised the call.
 */
export async function dashboardGrant($: EngineInterface, input: unknown): Promise<boolean> {
  try {
    if (!isObj(input)) {
      return false
    }
    if (consentState(await readConsent(engineStore($)), Number(await $.clock.now())) !== 'allow') {
      return false
    }
    const dir = await dataDir($)
    const url = (await readState($, dir))?.url ?? null
    const keys = Object.keys(input)
    if (input.action === 'read') {
      return url !== null && input.url === url && keys.every(k => k === 'action' || k === 'url')
    }
    if (input.action !== undefined && input.action !== 'publish') {
      return false
    }
    if (!keys.every(k => INPUT_KEYS.includes(k)) || input.file_path !== `${dir}/dashboard/index.html`) {
      return false
    }
    if (input.url !== undefined) {
      return url !== null && input.url === url && input.icon === undefined
    }
    return input.icon === undefined || input.icon === 'chart'
  } catch {
    return false
  }
}

// For the tests: forget this process's attempt and denial.
export function resetDashboard(): void {
  lastAttempt = null
  deniedIn = null
}
