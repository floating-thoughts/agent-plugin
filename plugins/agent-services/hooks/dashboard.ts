// agent-services dashboard publisher. After a turn, when the core has rendered a newer page
// (<data dir>/dashboard/index.html, recorded in <data dir>/services/dashboard.json), the page is published as an
// Artifact through the engine's own tool call, so the permission check and its dialog apply as to any call.
// At most one attempt per PUBLISH_INTERVAL_MS in this process; a denied call stops it for the session. The outcome
// goes back to the core (dashboard_published {url}, dashboard_denied). This module never throws.
import type { EngineInterface } from 'claude-code'
import { coreEvent, dataDir } from './core'

export const PUBLISH_INTERVAL_MS = 600_000
const TOOL = 'Artifact'
const URL_RX = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/
// The tool refuses a publish to an artifact this session has neither read nor published: read it once, then retry.
const UNREAD_RX = /\bread\b/i

type State = { changed_at: number | null; url: string | null; published_at: number | null; denied: boolean }
type Res = { deny?: string; text?: string; isError?: boolean; result?: unknown }

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

const call = async ($: EngineInterface, input: Record<string, unknown>): Promise<Res> =>
  (await $.tool.call({ tool: TOOL, ...input } as any)) as Res

const report = async ($: EngineInterface, session: string, kind: string, fields: Record<string, unknown> = {}) => {
  await coreEvent($, { v: 1, harness: 'claude-code', kind, session, agent: null, ...fields })
}

// Called after each main-agent turn; resolves to what it did (for the log and the tests), never rejects.
export async function publishDashboard($: EngineInterface): Promise<string> {
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
      await report($, session, 'dashboard_denied')
      return 'denied'
    }
    const url = res.isError === true ? null : (textOf(res).match(URL_RX)?.[0] ?? st.url)
    if (!url) {
      return 'failed'
    }
    await report($, session, 'dashboard_published', { url })
    return 'published'
  } catch {
    return 'failed'
  }
}

// For the tests: forget this process's attempt and denial.
export function resetDashboard(): void {
  lastAttempt = null
  deniedIn = null
}
