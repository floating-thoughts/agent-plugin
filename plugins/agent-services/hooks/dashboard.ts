// agent-services dashboard publisher. After a turn, when the core has rendered a newer page
// (<data dir>/dashboard/index.html, recorded in <data dir>/services/dashboard.json), its figures reach the person's
// private Artifact through the engine's own tool calls, so the permission check and its dialog apply as to any call.
// At most one attempt per PUBLISH_INTERVAL_MS in this process; a denied call stops it for the session. The outcome
// goes back to the in-process core through `report` (register.ts passes the core's dashboard_published {url} and
// dashboard_denied events), and a deny's reason to `note` (wiring.ts logs it in the outbox). This module never throws.
//
// Live figures (2026-11-03): every Artifact publish shows the page to the person, so the page is published only when
// there is none yet, when the board was published before live figures, or when the page format changed (the page with
// its data slot emptied, hashed: the "format", kept with the doc version in Board.live). The page declares the
// artifact's `db` capability (DB_CAPS: only the owner writes) and draws the figures of its data document
// (DOC: board/figures) when there is one, else the figures baked into it. Every other update writes that data
// document with the ArtifactData tool (one `set`; a `get` first when the document's version is unknown), which does
// not publish the page. The document holds exactly the page's data slot: what the page shows, nothing more.
//
// Nothing is published or written without the user's own yes to the private page (choice.ts pageOn: `sharing on`, or
// `sharing page on`); no dialog is shown from here. With that yes, register.ts's tool.check hook allows exactly this
// module's own calls (dashboardGrant), so the tools run without a permission rule; the user's settings are never
// written.
//
// The same path serves a second board, the company admin's (boss.ts, BOSS_BOARD: <data dir>/boss/index.html and
// services/boss.json), with its own throttle and denial; the grant allows the calls of either board. It follows the
// admin's own page answer, never the company's upload choice.
import type { EngineInterface } from 'claude-code'
import { pageOn } from './choice'
import { sha256Hex, utf8 } from './e2e'
import { dataDir } from './engine_env'
import { encode } from './render'
import { engineStore } from './store'

export const PUBLISH_INTERVAL_MS = 600_000
export const PUBLISH_START_WAIT_MS = 3000 // (after the 6 s event wait: under the 10 s a hook gets) turn.complete waits this long so the first tool call starts inside it
const TOOL = 'Artifact'
const DATA_TOOL = 'ArtifactData'
const URL_RX = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/
// The tool refuses a publish to an artifact this session has neither read nor published: read it once, then retry.
const UNREAD_RX = /\bread\b/i
export const GRANT_REASON = 'agent-services savings page (user allowed)' // the tool.check verdict's reason
// A first publish (no URL stored yet) is marked in the state file; another session waits while the mark is this fresh.
export const FIRST_PUBLISH_HOLD_MS = 120_000
const INPUT_KEYS = ['action', 'file_path', 'url', 'icon', 'capabilities'] // what this module's publish call carries
/** The page's runtime capability: the artifact's own database, written by its owner only (read by whoever opens it). */
export const DB_CAPS = { db: { rules: [{ path: '', read: 'view', write: 'owner' }] } }
/** The one data document a board page reads (the page script reads db.doc('board/figures')). */
export const DOC = { collection: 'board', doc_id: 'figures' }

/** One board: its page, state file and live record under the data dir, and the icon of its first publish. */
export type Board = { page: string; state: string; live: string; icon: string }
export const MAIN_BOARD: Board = { page: 'dashboard/index.html', state: 'services/dashboard.json', live: 'services/dashboard-live.json', icon: 'chart' }
export const BOSS_BOARD: Board = { page: 'boss/index.html', state: 'services/boss.json', live: 'services/boss-live.json', icon: 'chart' }

type State = { changed_at: number | null; url: string | null; published_at: number | null; denied: boolean; publishing_at: number | null }
type Live = { url: string; format: string; version: number | null }
type Page = { data: Record<string, unknown> | null; format: string | null; empty?: boolean }
type Res = { deny?: string; text?: string; isError?: boolean; result?: unknown }
/** Where the outcome goes: (kind, fields) as a core event of this session (dashboard_published, dashboard_denied). */
export type Report = (session: string, kind: string, fields?: Record<string, unknown>) => unknown
/** note: receives a denied call's reason, and tool 'ArtifactData' when the attempt writes the figures only. */
export type Note = (d: { reason?: string; tool?: string }) => void
export type PublishOptions = { interactive?: boolean; note?: Note; board?: Board }

const lastAttempt = new Map<string, number>() // per board page
const deniedIn = new Map<string, string>() // per board page: the session whose call was denied
const sending = new Map<string, string>() // per board page: the figures this module is writing now (encoded)

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
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
const ok = (r: Res): boolean => r.deny === undefined && r.isError !== true

async function readState($: EngineInterface, dir: string, board: Board = MAIN_BOARD): Promise<State | null> {
  try {
    const s = JSON.parse(String(await $.fs.read(`${dir}/${board.state}`)))
    if (!s || typeof s !== 'object') {
      return null
    }
    // the whole value is the link (URL_RX alone finds one inside a tool's answer text)
    const url = typeof s.url === 'string' && /^https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+$/.test(s.url) ? s.url : null
    return { changed_at: num(s.changed_at), url, published_at: num(s.published_at), denied: s.denied === true, publishing_at: num(s.publishing_at) }
  } catch {
    return null
  }
}

/** The page's figures (its data slot) and format (the page with that slot emptied, hashed); nulls without a slot. */
export function pageParts(html: string): Page {
  const rx = /(<script type="application\/json" id="data">)([\s\S]*?)(<\/script>)/
  const m = rx.exec(html)
  if (!m) {
    return { data: null, format: null }
  }
  let data: unknown = null
  try {
    data = JSON.parse(m[2])
  } catch {
    data = null
  }
  const format = sha256Hex(utf8(html.replace(rx, (_m, a: string, _b: string, c: string) => `${a}null${c}`))).slice(0, 16)
  return { data: isObj(data) ? data : null, format }
}

async function readPage($: EngineInterface, dir: string, board: Board): Promise<Page> {
  try {
    const html = String(await $.fs.read(`${dir}/${board.page}`))
    return { ...pageParts(html), empty: html.trim() === '' }
  } catch {
    return { data: null, format: null } // unreadable: the publish call itself reports it
  }
}

/** Marks a first publish in the board's state file (publishing_at, ms), keeping the file's other fields. */
async function markPublishing($: EngineInterface, dir: string, board: Board, now: number): Promise<void> {
  try {
    const path = `${dir}/${board.state}`
    const s = JSON.parse(String(await $.fs.read(path)))
    if (isObj(s)) {
      await $.fs.write(path, JSON.stringify({ ...s, publishing_at: now }, null, 2))
    }
  } catch {
    // without the mark two sessions that end a turn together may each create a page
  }
}

async function readLive($: EngineInterface, dir: string, board: Board): Promise<Live | null> {
  try {
    const s = JSON.parse(String(await $.fs.read(`${dir}/${board.live}`)))
    if (!isObj(s) || typeof s.url !== 'string' || typeof s.format !== 'string') {
      return null
    }
    return { url: s.url, format: s.format, version: num(s.version) }
  } catch {
    return null
  }
}

async function writeLive($: EngineInterface, dir: string, board: Board, live: Live): Promise<void> {
  try {
    await $.fs.write(`${dir}/${board.live}`, JSON.stringify(live, null, 2))
  } catch {
    // without the record the next update publishes the page again
  }
}

/** The calls one attempt made: only its first surely starts inside the turn.complete hook (publishDashboard denied). */
type Count = { n: number }

async function call($: EngineInterface, input: Record<string, unknown>, c?: Count): Promise<Res> {
  if (c) c.n += 1
  return (await $.tool.call({ tool: TOOL, ...input } as any)) as Res
}

async function callData($: EngineInterface, input: Record<string, unknown>, c?: Count): Promise<Res> {
  if (c) c.n += 1
  return (await $.tool.call({ tool: DATA_TOOL, ...input } as any)) as Res
}

/** The data document's version in an ArtifactData answer (a write's, or a get's document), or null. */
function docVersion(r: Res): number | null {
  const res = r.result
  if (isObj(res) && isObj(res.db_write) && num(res.db_write.version) !== null) {
    return num(res.db_write.version)
  }
  if (isObj(res) && isObj(res.db_read) && Array.isArray(res.db_read.docs)) {
    const d = res.db_read.docs.find((x: unknown) => isObj(x) && x.id === DOC.doc_id)
    return isObj(d) ? num(d.version) : null
  }
  const m = /"version"\s*:\s*(\d+)/.exec(textOf(r))
  return m ? Number(m[1]) : null
}

/**
 * Writes the figures to the board's data document: one `set` pinned to the known version; when that is refused (the
 * version is unknown or changed, or this session has not read the artifact), a `get` (after an Artifact read when
 * the get is refused as unread), then the `set` once more. Resolves to the deciding answer and the new version.
 */
async function writeData($: EngineInterface, url: string, data: Record<string, unknown>, known: number | null, c?: Count): Promise<{ res: Res; done: boolean; version: number | null }> {
  const set = (v: number | null) => callData($, { action: 'set', url, ...DOC, data, ...(v === null ? {} : { if_version: v }) }, c)
  const end = (res: Res) => ({ res, done: wrote(res), version: wrote(res) ? docVersion(res) : null })
  let res = await set(known)
  if (res.deny !== undefined || wrote(res)) {
    return end(res)
  }
  let got = await callData($, { action: 'get', url, ...DOC }, c)
  if (got.deny === undefined && got.isError === true && UNREAD_RX.test(textOf(got))) {
    const read = await call($, { action: 'read', url }, c)
    if (!ok(read)) {
      return { res: read, done: false, version: null }
    }
    got = await callData($, { action: 'get', url, ...DOC }, c)
  }
  if (got.deny === undefined && got.isError === true && /not found|does not exist|no such/i.test(textOf(got))) {
    return end(await set(null)) // the document is gone: create it again
  }
  if (!ok(got)) {
    return { res: got, done: false, version: null }
  }
  return end(await set(docVersion(got)))
}

/** A set that landed: answered without error, and not reported as written-nothing (a stale if_version). */
function wrote(r: Res): boolean {
  const res = r.result
  return ok(r) && !(isObj(res) && isObj(res.db_write) && res.db_write.committed === false)
}

const send = async (report: Report | undefined, session: string, kind: string, fields: Record<string, unknown> = {}) => {
  try {
    await report?.(session, kind, fields)
  } catch {
    // the publish outcome stands
  }
}

// Called after each main-agent turn; resolves to what it did (for the log and the tests), never rejects.
// 'updated': the figures were written to the data document; 'published': the page itself was published.
export async function publishDashboard($: EngineInterface, report?: Report, opts: PublishOptions = {}): Promise<string> {
  const board = opts.board ?? MAIN_BOARD
  try {
    const session = String(await $.session.id())
    if (deniedIn.get(board.page) === session) {
      return 'denied_before'
    }
    const now = Number(await $.clock.now())
    const last = lastAttempt.get(board.page)
    if (last !== undefined && now - last < PUBLISH_INTERVAL_MS) {
      return 'throttled'
    }
    const dir = await dataDir($)
    const st = await readState($, dir, board)
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
    const tools = (await $.tool.list()).map(t => t.name)
    if (!tools.includes(TOOL)) {
      return 'no_tool'
    }
    // no dialog from here: after a turn nobody can be asked; the page is asked about by /agent-services setup
    if (!(await pageOn(engineStore($)))) {
      return 'not_allowed'
    }
    // an emptied page (the company board after its figures were removed) is never published
    const page = await readPage($, dir, board)
    if (page.empty) {
      return 'no_page'
    }
    if (st.url === null) {
      if (st.publishing_at !== null && now >= st.publishing_at && now - st.publishing_at < FIRST_PUBLISH_HOLD_MS) {
        return 'too_soon' // another session is creating the page right now
      }
      await markPublishing($, dir, board, now)
    }
    lastAttempt.set(board.page, now)
    const c: Count = { n: 0 }
    const denied = async (res: Res): Promise<string> => {
      if (c.n > 1) {
        // a later call may start after the hook returned, where the engine skips this plugin's grant and denies
        // without asking: not the user's answer, so the next turn tries again (audit 2026-11-12)
        lastAttempt.delete(board.page)
        return 'failed'
      }
      deniedIn.set(board.page, session)
      try {
        opts.note?.({ reason: typeof res.deny === 'string' ? res.deny : undefined })
      } catch {
        // the outcome stands
      }
      await send(report, session, 'dashboard_denied')
      return 'denied'
    }
    const live = page.data !== null && st.url !== null ? await readLive($, dir, board) : null
    const data = page.data
    let version = live && live.url === st.url ? live.version : null
    if (data !== null && live !== null && live.url === st.url && live.format === page.format && !tools.includes(DATA_TOOL)) {
      return 'no_tool' // the page is live in its format; without the data tool only a publish (shown to the user) could update it
    }
    if (data !== null && st.url !== null && live !== null && live.url === st.url && tools.includes(DATA_TOOL)) {
      // the board's page is published already: write its figures; publish the page only when its format changed
      sending.set(board.page, encode(data))
      const w = await writeData($, st.url, data, version, c)
      if (w.res.deny !== undefined) {
        return await denied(w.res)
      }
      if (!w.done) {
        return 'failed'
      }
      version = w.version
      await writeLive($, dir, board, { ...live, version })
      if (live.format === page.format) {
        try {
          opts.note?.({ tool: DATA_TOOL })
        } catch {
          // the outcome stands
        }
        await send(report, session, 'dashboard_published', { url: st.url })
        return 'updated'
      }
    }
    const input: Record<string, unknown> = {
      file_path: `${dir}/${board.page}`,
      ...(st.url ? { url: st.url } : { icon: board.icon }),
      ...(data !== null ? { capabilities: DB_CAPS } : {}),
    }
    let res = await call($, input, c)
    if (res.deny === undefined && res.isError === true && st.url && UNREAD_RX.test(textOf(res))) {
      const read = await call($, { action: 'read', url: st.url }, c)
      if (read.deny !== undefined) {
        res = read
      } else {
        res = await call($, input, c)
      }
    }
    if (res.deny !== undefined) {
      return await denied(res)
    }
    const url = res.isError === true ? null : (textOf(res).match(URL_RX)?.[0] ?? st.url)
    if (!url) {
      return 'failed'
    }
    if (data !== null && page.format !== null) {
      await writeLive($, dir, board, { url, format: page.format, version: url === st.url ? version : null })
    }
    await send(report, session, 'dashboard_published', { url })
    return 'published'
  } catch {
    return 'failed'
  } finally {
    sending.delete(board.page)
  }
}

/**
 * Whether a tool.check of the Artifact or ArtifactData tool is this module's own call, to be allowed: consent is
 * "allow" and the input is, for the person's board or the company board (BOSS_BOARD):
 * - Artifact: the publish of the board's page (to its stored URL when it has one, icon chart otherwise; with
 *   capabilities DB_CAPS or none) or the read of the stored URL;
 * - ArtifactData: the get of the board's data document (DOC) at the stored URL, or its set with the figures this
 *   module is writing now or the page's current figures (an if_version number allowed).
 * The caller checks that this plugin raised the call.
 */
export async function dashboardGrant($: EngineInterface, input: unknown, tool: unknown = TOOL): Promise<boolean> {
  try {
    if (!isObj(input) || (tool !== TOOL && tool !== DATA_TOOL)) {
      return false
    }
    if (!(await pageOn(engineStore($)))) {
      return false
    }
    const dir = await dataDir($)
    for (const board of [MAIN_BOARD, BOSS_BOARD]) {
      const url = (await readState($, dir, board))?.url ?? null
      if (tool === TOOL ? boardCall(input, dir, board, url) : await dataCall($, input, dir, board, url)) {
        return true
      }
    }
    return false
  } catch {
    return false
  }
}

function boardCall(input: Record<string, unknown>, dir: string, board: Board, url: string | null): boolean {
  const keys = Object.keys(input)
  if (input.action === 'read') {
    return url !== null && input.url === url && keys.every(k => k === 'action' || k === 'url')
  }
  if (input.action !== undefined && input.action !== 'publish') {
    return false
  }
  if (!keys.every(k => INPUT_KEYS.includes(k)) || input.file_path !== `${dir}/${board.page}`) {
    return false
  }
  if (input.capabilities !== undefined && encode(input.capabilities) !== encode(DB_CAPS)) {
    return false
  }
  if (input.url !== undefined) {
    return url !== null && input.url === url && input.icon === undefined
  }
  return input.icon === undefined || input.icon === board.icon
}

async function dataCall($: EngineInterface, input: Record<string, unknown>, dir: string, board: Board, url: string | null): Promise<boolean> {
  if (url === null || input.url !== url || input.collection !== DOC.collection || input.doc_id !== DOC.doc_id) {
    return false
  }
  const keys = Object.keys(input)
  if (input.action === 'get') {
    return keys.every(k => ['action', 'url', 'collection', 'doc_id'].includes(k))
  }
  if (input.action !== 'set' || !keys.every(k => ['action', 'url', 'collection', 'doc_id', 'data', 'if_version'].includes(k))) {
    return false
  }
  if ((input.if_version !== undefined && num(input.if_version) === null) || !isObj(input.data)) {
    return false
  }
  const sent = encode(input.data)
  if (sending.get(board.page) === sent) {
    return true
  }
  const page = await readPage($, dir, board)
  return page.data !== null && encode(page.data) === sent
}

// For the tests: forget this process's attempt and denial.
export function resetDashboard(): void {
  lastAttempt.clear()
  deniedIn.clear()
  sending.clear()
}
