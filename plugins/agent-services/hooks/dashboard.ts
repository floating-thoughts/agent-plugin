import type { EngineInterface } from 'claude-code'
import { pageOn } from './choice'
import { sha256Hex, utf8 } from './e2e'
import { dataDir } from './engine_env'
import { encode } from './render'
import { engineStore } from './store'

export const PUBLISH_INTERVAL_MS = 600_000
export const PUBLISH_START_WAIT_MS = 3000
const TOOL = 'Artifact'
const DATA_TOOL = 'ArtifactData'
const URL_RX = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/
const UNREAD_RX = /\bread\b/i
const GONE_RX = /\bartifact not found\b|\bno such artifact\b/i
const isGone = (r: Res | null): boolean => GONE_RX.test((textOf(r).trimStart().split('\n', 1)[0] ?? '').slice(0, 400))
export const GRANT_REASON = 'agent-services savings page (user allowed)'
export const FIRST_PUBLISH_HOLD_MS = 120_000
const INPUT_KEYS = ['action', 'file_path', 'url', 'icon', 'capabilities']
export const DB_CAPS = { db: { rules: [{ path: '', read: 'view', write: 'owner' }] } }
export const DOC = { collection: 'board', doc_id: 'figures' }

export type Board = { page: string; state: string; live: string; icon: string }
export const MAIN_BOARD: Board = { page: 'dashboard/index.html', state: 'services/dashboard.json', live: 'services/dashboard-live.json', icon: 'chart' }
export const BOSS_BOARD: Board = { page: 'boss/index.html', state: 'services/boss.json', live: 'services/boss-live.json', icon: 'chart' }

type State = { changed_at: number | null; url: string | null; published_at: number | null; denied: boolean; publishing_at: number | null }
type Live = { url: string; format: string; version: number | null }
type Page = { data: Record<string, unknown> | null; format: string | null; empty?: boolean }
type Res = { deny?: string; text?: string; isError?: boolean; result?: unknown }
export type Report = (session: string, kind: string, fields?: Record<string, unknown>) => unknown
export type Note = (d: { reason?: string; tool?: string }) => void
export type PublishOptions = { interactive?: boolean; note?: Note; board?: Board }

const lastAttempt = new Map<string, number>()
const deniedIn = new Map<string, string>()
const sending = new Map<string, string>()

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
    const url = typeof s.url === 'string' && /^https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+$/.test(s.url) ? s.url : null
    return { changed_at: num(s.changed_at), url, published_at: num(s.published_at), denied: s.denied === true, publishing_at: num(s.publishing_at) }
  } catch {
    return null
  }
}

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
    return { data: null, format: null }
  }
}

async function forgetPage($: EngineInterface, dir: string, board: Board, gone: string, now: number): Promise<{ url: string | null; busy: boolean }> {
  try {
    const path = `${dir}/${board.state}`
    let s: unknown = {}
    try {
      s = JSON.parse(String(await $.fs.read(path)))
    } catch {
      s = {}
    }
    const o = isObj(s) ? s : {}
    if (typeof o.url === 'string' && URL_RX.test(o.url) && o.url !== gone) {
      return { url: o.url, busy: false }
    }
    const at = num(o.publishing_at)
    if (typeof o.url !== 'string' && at !== null && now >= at && now - at < FIRST_PUBLISH_HOLD_MS) {
      return { url: null, busy: true }
    }
    await $.fs.write(path, JSON.stringify({ ...o, url: null, published_at: null, publishing_at: now }, null, 2))
    await $.fs.write(`${dir}/${board.live}`, '{}')
  } catch {
  }
  return { url: null, busy: false }
}

async function markPublishing($: EngineInterface, dir: string, board: Board, now: number): Promise<void> {
  try {
    const path = `${dir}/${board.state}`
    const s = JSON.parse(String(await $.fs.read(path)))
    if (isObj(s)) {
      await $.fs.write(path, JSON.stringify({ ...s, publishing_at: now }, null, 2))
    }
  } catch {
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
  }
}

type Count = { n: number }

async function call($: EngineInterface, input: Record<string, unknown>, c?: Count): Promise<Res> {
  if (c) c.n += 1
  return (await $.tool.call({ tool: TOOL, ...input } as any)) as Res
}

async function callData($: EngineInterface, input: Record<string, unknown>, c?: Count): Promise<Res> {
  if (c) c.n += 1
  return (await $.tool.call({ tool: DATA_TOOL, ...input } as any)) as Res
}

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

async function writeData($: EngineInterface, url: string, data: Record<string, unknown>, known: number | null, c?: Count): Promise<{ res: Res; done: boolean; version: number | null }> {
  const set = (v: number | null) => callData($, { action: 'set', url, ...DOC, data, ...(v === null ? {} : { if_version: v }) }, c)
  const end = (res: Res) => ({ res, done: wrote(res), version: wrote(res) ? docVersion(res) : null })
  let res = await set(known)
  if (res.deny !== undefined || wrote(res) || isGone(res)) {
    return end(res)
  }
  let got = await callData($, { action: 'get', url, ...DOC }, c)
  if (isGone(got)) {
    return { res: got, done: false, version: null }
  }
  if (got.deny === undefined && got.isError === true && UNREAD_RX.test(textOf(got))) {
    const read = await call($, { action: 'read', url }, c)
    if (!ok(read) || isGone(read)) {
      return { res: read, done: false, version: null }
    }
    got = await callData($, { action: 'get', url, ...DOC }, c)
    if (isGone(got)) {
      return { res: got, done: false, version: null }
    }
  }
  if (got.deny === undefined && got.isError === true && /not found|does not exist|no such/i.test(textOf(got))) {
    return end(await set(null))
  }
  if (!ok(got)) {
    return { res: got, done: false, version: null }
  }
  return end(await set(docVersion(got)))
}

function wrote(r: Res): boolean {
  const res = r.result
  return ok(r) && !(isObj(res) && isObj(res.db_write) && res.db_write.committed === false)
}

const send = async (report: Report | undefined, session: string, kind: string, fields: Record<string, unknown> = {}) => {
  try {
    await report?.(session, kind, fields)
  } catch {
  }
}

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
    if (!(await pageOn(engineStore($)))) {
      return 'not_allowed'
    }
    const page = await readPage($, dir, board)
    if (page.empty) {
      return 'no_page'
    }
    if (st.url === null) {
      if (st.publishing_at !== null && now >= st.publishing_at && now - st.publishing_at < FIRST_PUBLISH_HOLD_MS) {
        return 'too_soon'
      }
      await markPublishing($, dir, board, now)
    }
    lastAttempt.set(board.page, now)
    const c: Count = { n: 0 }
    const denied = async (res: Res): Promise<string> => {
      if (c.n > 1) {
        lastAttempt.delete(board.page)
        return 'failed'
      }
      deniedIn.set(board.page, session)
      try {
        opts.note?.({ reason: typeof res.deny === 'string' ? res.deny : undefined })
      } catch {
      }
      await send(report, session, 'dashboard_denied')
      return 'denied'
    }
    let stored = st.url
    const gone = async (r: Res): Promise<boolean> => {
      if (stored === null || r.deny !== undefined) {
        return false
      }
      if (isGone(r)) {
        return true
      }
      const read = await call($, { action: 'read', url: stored }, c)
      return read.deny === undefined && isGone(read)
    }
    const forget = async (): Promise<boolean> => {
      const f = await forgetPage($, dir, board, stored ?? '', now)
      stored = f.url
      version = null
      return !f.busy
    }
    const live = page.data !== null && stored !== null ? await readLive($, dir, board) : null
    const data = page.data
    let version = live && live.url === stored ? live.version : null
    if (data !== null && live !== null && live.url === stored && live.format === page.format && !tools.includes(DATA_TOOL)) {
      return 'no_tool'
    }
    if (data !== null && stored !== null && live !== null && live.url === stored && tools.includes(DATA_TOOL)) {
      sending.set(board.page, encode(data))
      const w = await writeData($, stored, data, version, c)
      if (w.res.deny !== undefined) {
        return await denied(w.res)
      }
      if (!w.done) {
        if (!(await gone(w.res))) {
          return 'failed'
        }
        if (!(await forget())) {
          return 'too_soon'
        }
      } else {
        version = w.version
        await writeLive($, dir, board, { ...live, version })
        if (live.format === page.format) {
          try {
            opts.note?.({ tool: DATA_TOOL })
          } catch {
          }
          await send(report, session, 'dashboard_published', { url: stored })
          return 'updated'
        }
      }
    }
    const inputFor = (to: string | null): Record<string, unknown> => ({
      file_path: `${dir}/${board.page}`,
      ...(to ? { url: to } : { icon: board.icon }),
      ...(data !== null ? { capabilities: DB_CAPS } : {}),
    })
    let res = await call($, inputFor(stored), c)
    let readGone = false
    if (res.deny === undefined && res.isError === true && stored && UNREAD_RX.test(textOf(res)) && !isGone(res)) {
      const read = await call($, { action: 'read', url: stored }, c)
      readGone = read.deny === undefined && isGone(read)
      if (read.deny !== undefined || readGone) {
        res = read
      } else {
        res = await call($, inputFor(stored), c)
      }
    }
    if (res.deny === undefined && stored !== null && (readGone || (res.isError === true && (await gone(res))))) {
      if (!(await forget())) {
        return 'too_soon'
      }
      res = await call($, inputFor(stored), c)
    }
    if (res.deny !== undefined) {
      return await denied(res)
    }
    const url = res.isError === true ? null : (textOf(res).match(URL_RX)?.[0] ?? stored)
    if (!url) {
      return 'failed'
    }
    if (data !== null && page.format !== null) {
      await writeLive($, dir, board, { url, format: page.format, version: url === stored ? version : null })
    }
    await send(report, session, 'dashboard_published', { url })
    return 'published'
  } catch {
    return 'failed'
  } finally {
    sending.delete(board.page)
  }
}

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

export function resetDashboard(): void {
  lastAttempt.clear()
  deniedIn.clear()
  sending.clear()
}
