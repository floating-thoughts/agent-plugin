import type { EngineInterface } from 'claude-code'
import type { CoreOptions } from './core'
import type { GateState, KV, SvcResult, Transport } from './engine_types'
import type { Outbox } from './outbox'
import type { Hook, Kind, Svc } from './svc'
import type { Facts, MetricsState, Prices, TranscriptFile } from './metrics'
import type { DayCounters } from './counters'
import { localDay, readDay } from './counters'
import { b64Encode, hex, sha256Hex, utf8 } from './e2e'
import { BodyTooLarge, dailyBody, isDay, isLong, normModel, plusDays, READ_LIMIT, uploadDays, walkOrder } from './metrics'
import { dailyPost, SALT_KEY } from './records'
import { collect, pageChanged, publishedUrlOk, render as renderPage, renderDue } from './render'
import { savingsDue, statusText, updateCommand, updateHintDue } from './status'
import { counterDays, countsOf, dayCountsFromStore, dayEmpty, uploadDay } from './day_counts'
import { boardData, minUsd, readOutboxDay, timelineOf, weeklyOf } from './board_facts'
import { bandFacts, paused, setBandPanel, type BandFacts, type BandKind, type BandState } from './band'
import { readOrg } from './org'
import { accountOf, accountSwitched, readEntry, recordConsent, recordState, uploadFloor, uploadOn, writeEntry } from './choice'
import { boardLines, heldPlan, panelLines, panelOf, refreshUsage, USAGE_DAYS_KEY, type Panel } from './panel'
import { linesOf, Scanner, unpricedNote } from './transcripts'
import { refreshToolDays, type ProcessRun } from './usage_tool'
export { notePlan } from './panel'
import { BossBoard } from './boss'
import { daySaving, overheadTokens } from './local_savings'
import { MAIN_BOARD, type Board } from './dashboard'

export { counterDays, countsOf, dayCountsFromStore, normalizeDay } from './day_counts'
export { hookFor, svcTransport } from './transport'
export { bandSetter, installBand } from './band'

export const SAVINGS_CACHE_KEY = 'savings_cache'
export const REPORT_CACHE_KEY = 'report_cache'
export const METRICS_STATE_KEY = 'metrics_state'
export const METRICS_LEASE_KEY = 'metrics_lease'
export const TIME_REFRESH_KEY = 'time_refresh'
export const TIME_DAYS_FILE = 'time-days.json'
export const ESTIMATE_KEY = 'estimate_answer'
export const UPDATE_HINT_KEY = 'update_hint_at'
export const METRICS_LEASE_MS = 120_000
export const REPORT_TTL_MS = 600_000
export const PUBLISH_ATTEMPTS = ['published', 'updated', 'denied', 'failed']
export const ARTIFACT_URL_RX = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/
export const SALT_RX = /^[0-9a-f]{64}$/

type Obj = Record<string, any>

export type WiringFs = {
  read(path: string): Promise<string>
  write(path: string, text: string): Promise<void>
  list?(path: string): Promise<readonly { name: string; size?: number; dir?: boolean; mtime?: number }[]>
  chunks?(path: string): AsyncIterable<string>
}

export type WiringDeps = {
  svc: Svc
  store: KV
  fs: WiringFs
  dataDir: string
  prices: Prices
  template: () => Promise<string | null>
  setStatus?: (text: string) => unknown
  setBand?: (state: BandState | null) => unknown
  outbox?: Outbox | null
  clock?: () => number
  random?: (n: number) => Uint8Array
  projectsRoot?: string | null
  kinds?: () => Promise<Record<string, string> | null>
  servedFetch?: () => Promise<Obj | null>
  update?: { marketplace: string | null; selfUpdates: boolean } | null
  holder?: string
  clientVersion?: string
  run?: ProcessRun | null
}

export type TickResult = { sent: string[]; error: string | null } | { skipped: string }

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

async function get(store: KV, key: string): Promise<unknown> {
  try {
    return await store.get(key)
  } catch {
    return undefined
  }
}

async function put(store: KV, key: string, value: unknown): Promise<boolean> {
  try {
    await store.set(key, value)
    return true
  } catch {
    return false
  }
}

const result = (r: { ok: boolean; status: number | null; body: unknown; error: string | null }): SvcResult => ({
  ok: r.ok,
  status: r.status,
  body: r.body,
  error: r.error,
})


export async function loadTranscripts(
  fs: WiringFs,
  root: string | null | undefined,
  maxDepth = 6,
  bound: { since?: number; maxBytes?: number; stream?: boolean; onFile?: (f: TranscriptFile) => void | Promise<void> } = {},
): Promise<TranscriptFile[]> {
  const out: TranscriptFile[] = []
  if (!root || typeof fs.list !== 'function') return out
  const base = root.replace(/[\\/]+$/, '')
  let readBytes = 0
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    let entries: readonly { name: string; size?: number; dir?: boolean; mtime?: number }[]
    try {
      entries = await fs.list!(dir)
    } catch {
      return
    }
    for (const e of entries) {
      const path = `${dir}/${e.name}`
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.dir !== true && e.name.endsWith('.jsonl')) {
        const mtime = num(e.mtime)
        if (bound.since !== undefined && mtime !== null && mtime < bound.since) continue
        const size = num(e.size)
        if (bound.onFile) {
          later.push({ rel: r, path, size })
          continue
        }
        let text: string | null = null
        if (size === null || size <= READ_LIMIT) {
          try {
            text = String(await fs.read(path))
          } catch {
            text = null
          }
        }
        const got = text === null ? (size ?? 0) : utf8(text).length
        if (text !== null) readBytes += got
        if (bound.maxBytes !== undefined && readBytes > bound.maxBytes) throw new Error('transcripts over the read bound')
        out.push({ rel: r, size: size ?? got, text: text !== null && got > READ_LIMIT ? null : text })
      } else if (e.dir !== false && depth < maxDepth) {
        await walk(path, r, depth + 1)
      }
    }
  }
  const later: { rel: string; path: string; size: number | null }[] = []
  await walk(base, '', 0)
  if (bound.onFile) {
    for (const f of walkOrder(later)) {
      if (bound.stream && f.size !== null && f.size > READ_LIMIT && typeof fs.chunks === 'function') {
        const fits = bound.maxBytes === undefined || readBytes + f.size <= bound.maxBytes
        if (fits) readBytes += f.size
        const chunks = fs.chunks.bind(fs)
        await bound.onFile(fits ? { rel: f.rel, size: f.size, text: null, lines: linesOf(chunks(f.path)) } : { rel: f.rel, size: f.size, text: null })
        continue
      }
      let text: string | null = null
      if (f.size === null || f.size <= READ_LIMIT) {
        try {
          text = String(await fs.read(f.path))
        } catch {
          text = null
        }
      }
      const got = text === null ? (f.size ?? 0) : utf8(text).length
      if (text !== null) readBytes += got
      if (bound.maxBytes !== undefined && readBytes > bound.maxBytes) throw new Error('transcripts over the read bound')
      await bound.onFile({ rel: f.rel, size: f.size ?? got, text: text !== null && got > READ_LIMIT ? null : text })
    }
  }
  return walkOrder(out)
}

export function incompleteNote(facts: Pick<Facts, 'unread' | 'unpriced'>): string | null {
  const n = (facts.unread ?? []).length
  const parts = [
    n ? `${n} transcript file${n === 1 ? '' : 's'} could not be read, so ${n === 1 ? 'its' : 'their'} usage is left out.` : null,
    unpricedNote(facts.unpriced),
  ].filter((x): x is string => !!x)
  return parts.length ? parts.join(' ') : null
}

export const COPY_IDLE_MS = 60000

export function copyArgv(path: string): string[] {
  if (!/^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(path)) return ['cat', path]
  const script =
    "$f=[IO.File]::Open($env:AGENT_SVC_COPY,'Open','Read','ReadWrite');$o=[Console]::OpenStandardOutput();$f.CopyTo($o);$o.Flush();$f.Close()"
  const b = new Uint8Array(script.length * 2)
  for (let i = 0; i < script.length; i++) b[i * 2] = script.charCodeAt(i)
  return ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', b64Encode(b)]
}

export async function* engineChunks($: EngineInterface, path: string, idleMs = COPY_IDLE_MS): AsyncGenerator<string> {
  const child = $.process.spawn({ argv: copyArgv(path), cwd: $.plugin.root, env: { AGENT_SVC_COPY: path } })
  const pieces = child[Symbol.asyncIterator]()
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const idle = new Promise<null>((res) => { timer = setTimeout(() => res(null), idleMs) })
    const step = await Promise.race([pieces.next(), idle])
    clearTimeout(timer)
    if (!step) {
      void pieces.return?.()?.catch(() => {})
      throw new Error('copy stalled')
    }
    if (step.done) break
    if (step.value.stream === 'stdout') yield step.value.text
  }
  const end = await child.result
  if (end.code !== 0) throw new Error('copy failed')
}


export class Wiring {
  private readonly d: WiringDeps
  private readonly clock: () => number
  private readonly holder: string
  private readonly pending = new Set<Promise<unknown>>()
  private lastRender: number | null = null
  private rendering = false
  private fetching = new Set<string>()
  private tickedDay: string | null = null
  private previewed: string | null = null

  readonly boss: BossBoard

  get clientVersion(): string | undefined {
    return this.d.clientVersion
  }

  constructor(deps: WiringDeps) {
    this.d = deps
    this.clock = deps.clock ?? (() => Date.now())
    this.boss = new BossBoard({ svc: deps.svc as any, store: deps.store, fs: deps.fs, dataDir: deps.dataDir, now: () => this.now() })
    const random = deps.random ?? ((n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n)))
    this.holder = deps.holder ? String(deps.holder) : hex(random(8))
  }

  private now(): number {
    try {
      const t = Number(this.clock())
      return Number.isFinite(t) ? t : Date.now()
    } catch {
      return Date.now()
    }
  }

  private get pagePath(): string {
    return `${this.d.dataDir.replace(/[\\/]+$/, '')}/dashboard/index.html`
  }

  private get statePath(): string {
    return `${this.d.dataDir.replace(/[\\/]+$/, '')}/services/dashboard.json`
  }

  private track<T>(p: Promise<T>): Promise<T> {
    const q = p.catch(() => undefined)
    this.pending.add(q)
    q.finally(() => this.pending.delete(q))
    return p
  }

  async idle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending])
  }

  async authState(): Promise<'ok' | 'login' | 'locked' | 'paused'> {
    try {
      const st = await this.d.svc.authState()
      return st === 'ok' || st === 'locked' || st === 'paused' ? st : 'login'
    } catch {
      return 'login'
    }
  }

  private pausedBand(): BandState {
    const line = this.pausedText(false)
    return line ? { state: 'paused', paused: line } : { state: 'paused' }
  }

  private pausedText(short: boolean): string | null {
    try {
      const svc = this.d.svc as Partial<Pick<Svc, 'pausedLine' | 'pausedShort'>>
      const t = short ? svc.pausedShort?.() : svc.pausedLine?.()
      return typeof t === 'string' && t ? t : null
    } catch {
      return null
    }
  }

  private async authOk(): Promise<boolean> {
    return (await this.authState()) === 'ok'
  }

  private async settings(): Promise<{ offline: boolean; services: Record<string, boolean>; served: Obj }> {
    try {
      return await this.d.svc.settings()
    } catch {
      return { offline: false, services: {}, served: { channel: 'stable' } }
    }
  }

  private async metricsOnNow(): Promise<boolean> {
    return (await uploadOn(this.d.store)) && (await this.settings()).services.metrics === true
  }

  coreOptions(): Pick<CoreOptions, 'status' | 'dashboard' | 'metrics' | 'counters'> {
    return {
      status: { update: () => this.track(this.refreshStatus()) },
      dashboard: {
        onTurnEnd: () => this.onTurnEnd(),
        published: (url: string) => this.track(this.published(url)),
        denied: () => this.track(this.denied()),
      },
      metrics: { savings: () => this.savings() },
      counters: { isLong: (model: string, prompt: number) => this.isLong(model, prompt) },
    }
  }

  isLong(model: string, prompt: number): boolean {
    try {
      return isLong(normModel(model), prompt, this.d.prices ?? {})
    } catch {
      return false
    }
  }


  private async cached(key: string, path: string, ttl: number, fetch: boolean): Promise<Obj | null> {
    const c = await get(this.d.store, key)
    const body = isObj(c) && isObj(c.body) ? c.body : null
    const tried = isObj(c) ? num(c.tried_at) : null
    const now = this.now()
    const due = tried === null || now - tried >= ttl
    if (!fetch || !due || this.fetching.has(key) || !(await this.authOk())) return body
    this.fetching.add(key)
    try {
      await put(this.d.store, key, { tried_at: now, body })
      const r = await this.d.svc.call('GET', path, undefined, { kind: 'daily', hook: 'background' })
      if (r.ok && isObj(r.body)) {
        await put(this.d.store, key, { tried_at: now, body: r.body })
        return r.body
      }
      return body
    } finally {
      this.fetching.delete(key)
    }
  }

  async savingsBody(fetch = true): Promise<Obj | null> {
    const on = await this.metricsOnNow()
    const c = await get(this.d.store, SAVINGS_CACHE_KEY)
    const tried = isObj(c) ? num(c.tried_at) : null
    const ttlDue = savingsDue(tried, this.now(), this.fetching.has(SAVINGS_CACHE_KEY))
    return this.cached(SAVINGS_CACHE_KEY, '/metrics/savings', 0, fetch && on && ttlDue)
  }

  async savings(): Promise<SvcResult> {
    if (!(await this.metricsOnNow())) return { ok: false, status: null, body: null, error: 'service_off' }
    const r = await this.d.svc.call('GET', '/metrics/savings', undefined, { kind: 'daily', hook: 'tool' })
    if (r.ok && isObj(r.body)) await put(this.d.store, SAVINGS_CACHE_KEY, { tried_at: this.now(), body: r.body })
    return result(r)
  }


  async todayCounts(): Promise<Record<string, number>> {
    try {
      return countsOf(await readDay(this.d.store, localDay(this.now())))
    } catch {
      return {}
    }
  }

  private async line(saved: Obj | null, update: string | null): Promise<string> {
    const st = await this.authState()
    if (st !== 'ok') {
      const auth = st === 'locked' || st === 'paused' ? st : 'signed_out'
      return statusText({ auth, metricsOn: false, saved: null, counts: {}, pausedLine: st === 'paused' ? this.pausedText(true) : null })
    }
    const on = await this.metricsOnNow()
    const rec = await recordState(this.d.store)
    const sharingAsk = rec.own !== 'off' && rec.org !== 'off'
    return statusText({ auth: 'ok', metricsOn: on, sharingAsk, saved: on ? saved : null, counts: await this.todayCounts(), update, gate: this.closedGate(),
      pausedLine: this.pausedText(true) })
  }

  private closedGate(): string | null {
    try {
      const g = this.d.svc.gateState()
      return paused(g) ? (g.reason as string) : null
    } catch {
      return null
    }
  }

  private show(text: string): void {
    try {
      this.d.setStatus?.(text)
    } catch {
    }
  }

  async refreshStatus(first?: () => Promise<boolean>): Promise<string> {
    this.dailyTick()
    if (await this.authOk()) this.refreshPanel()
    if (!(await this.authOk())) {
      const text = await this.line(null, null)
      this.show(text)
      await this.band()
      return text
    }
    let update: string | null = null
    const u = this.d.update
    if (u && u.selfUpdates === false && typeof u.marketplace === 'string' && u.marketplace) {
      const last = num(await get(this.d.store, UPDATE_HINT_KEY))
      if (updateHintDue(last, this.now()) && (await put(this.d.store, UPDATE_HINT_KEY, this.now()))) update = updateCommand(u.marketplace)
    }
    const before = await this.savingsBody(false)
    let text = await this.line(before, update)
    this.show(text)
    const held = first ? await first().catch(() => false) : false
    await this.band()
    if (update !== null) return text
    const after = await this.savingsBody(true)
    if (!held && JSON.stringify(after) !== JSON.stringify(before)) {
      text = await this.line(after, null)
      this.show(text)
      await this.band()
    }
    return text
  }


  async bandFacts(): Promise<BandFacts | null> {
    try {
      if (!(await this.authOk()) || paused(this.d.svc.gateState())) return null
      const today = localDay(this.now())
      const on = await this.metricsOnNow()
      const timeline = timelineOf(await this.outboxToday(), await this.todayCounts(), today)
      const report = await this.cached(REPORT_CACHE_KEY, '/report', REPORT_TTL_MS, false)
      return bandFacts(timeline, weeklyOf(on ? await this.savingsBody(false) : null, report, today, { metricsOn: on }))
    } catch {
      return null
    }
  }

  async bandState(): Promise<BandState> {
    try {
      const st = await this.authState()
      if (st === 'paused') return this.pausedBand()
      if (st !== 'ok') return { state: st === 'locked' ? 'locked' : 'signed_out' }
      const gate = this.closedGate()
      if (gate !== null) {
        const kinds: Record<string, BandKind> = { login: 'signed_out', locked: 'locked', paused: 'paused', offline: 'offline', upgrade: 'upgrade' }
        const kind = Object.hasOwn(kinds, gate) ? kinds[gate]! : 'unreachable'
        return kind === 'paused' ? this.pausedBand() : { state: kind }
      }
      const on = await this.metricsOnNow()
      const s = on ? await this.savingsBody(false) : null
      const usd = isObj(s) ? num(s.usd) : null
      const total = usd !== null && usd >= minUsd() ? { usd, since: typeof s!.first_day === 'string' ? s!.first_day : null } : null
      const facts = await this.bandFacts()
      const estimate = total === null && (facts?.saved_usd ?? null) === null ? await this.localEstimate() : null
      if (facts || total || estimate !== null) {
        const f: BandFacts = facts ?? { saved_usd: null, days: 7, counts: {}, latest: null }
        return { state: 'facts', facts: { ...f, total, ...(estimate !== null ? { estimate } : {}) } }
      }
      if (on) return { state: 'wait' }
      const rec = await recordState(this.d.store)
      return { state: rec.own !== 'off' && rec.org !== 'off' ? 'off' : 'wait' }
    } catch {
      return { state: 'starting' }
    }
  }

  private async localEstimate(): Promise<number | null> {
    try {
      const day = await readDay(this.d.store, localDay(this.now()))
      let methods: string | null = null
      try {
        methods = await this.d.fs.read(`${this.d.dataDir}/methods.md`)
      } catch {
      }
      const usd = daySaving(day.route, this.d.prices, overheadTokens(methods))
      return usd >= minUsd() ? usd : null
    } catch {
      return null
    }
  }

  async tick(): Promise<void> {
    try {
      void this.boss.sweep()
      if (await this.authOk()) this.refreshPanel()
      await this.band()
    } catch {
    }
  }

  private async band(): Promise<void> {
    if (!this.d.setBand) return
    const state = await this.bandState()
    setBandPanel(['facts', 'wait', 'off'].includes(state.state) ? await this.panel().catch(() => null) : null)
    try {
      this.d.setBand(state)
    } catch {
    }
  }

  private dailyTick(): void {
    const day = this.today()
    if (this.tickedDay === day) return
    this.tickedDay = day
    void this.track(this.metricsTick())
  }



  private async readState(path = this.statePath): Promise<Obj> {
    return (await this.stateOrNull(path)) ?? { changed_at: null, url: null, published_at: null, denied: false }
  }

  private async stateOrNull(path: string): Promise<Obj | null> {
    const out: Obj = { changed_at: null, url: null, published_at: null, denied: false }
    let text: string
    try {
      text = String(await this.d.fs.read(path))
    } catch {
      const cut = path.search(/[\\/][^\\/]*$/)
      try {
        const there = cut > 0 && typeof this.d.fs.list === 'function' && (await this.d.fs.list(path.slice(0, cut))).some((e) => e.name === path.slice(cut + 1))
        return there ? null : out
      } catch {
        return out
      }
    }
    try {
      const got = JSON.parse(text)
      if (isObj(got)) for (const k of Object.keys(out)) if (k in got) out[k] = got[k]
      if (isObj(got) && typeof got.publishing_at === 'number') out.publishing_at = got.publishing_at
    } catch {
    }
    return out
  }

  private async updateState(fields: Obj): Promise<void> {
    const old = await this.stateOrNull(this.statePath)
    if (old === null) return
    const st = { ...old, ...fields }
    try {
      await this.d.fs.write(this.statePath, JSON.stringify(st, null, 2))
    } catch {
    }
  }

  onTurnEnd(): boolean {
    const now = this.now() / 1000
    if (this.rendering || !renderDue(this.lastRender, now)) return false
    this.lastRender = now
    this.rendering = true
    void this.track(this.renderDashboard().then(() => this.boss.render()).finally(() => (this.rendering = false)))
    return true
  }

  async dashboardData(): Promise<Obj> {
    const settings = await this.settings()
    let status: Obj | null = null
    try {
      status = { ...(await this.d.svc.status()), services: { ...settings.services } }
    } catch {
      status = null
    }
    settings.services = { ...settings.services, metrics: await this.metricsOnNow() }
    const est = await get(this.d.store, ESTIMATE_KEY)
    let served: Obj | null = null
    try {
      served = this.d.servedFetch ? await this.d.servedFetch() : null
    } catch {
      served = null
    }
    const savings = await this.savingsBody(true)
    const report = await this.cached(REPORT_CACHE_KEY, '/report', REPORT_TTL_MS, true)
    const base = collect({
      now: this.now() / 1000,
      status,
      savings,
      report,
      settings: { services: { ...settings.services }, served: { channel: isObj(settings.served) ? settings.served.channel : null } },
      dayCounts: await dayCountsFromStore(this.d.store),
      estimate: isObj(est) ? est : null,
      servedFetch: served,
    })
    const org = await readOrg(this.d.store)
    const panel = await this.panel().catch(() => null)
    return boardData(base, { outboxLines: await this.outboxToday(), todayCounts: await this.todayCounts(), savings, report, status: { ...(status ?? {}), org }, panel: panel ? boardLines(panel) : null })
  }

  async outboxToday(): Promise<Obj[]> {
    try {
      await this.d.outbox?.flush()
      return await readOutboxDay(this.d.fs, `${this.d.dataDir.replace(/[\\/]+$/, '')}/services/outbox`, this.now())
    } catch {
      return []
    }
  }

  async renderDashboard(): Promise<string> {
    try {
      if (!(await this.authOk())) return 'auth_failed'
      const template = await this.d.template()
      if (typeof template !== 'string' || !template) return 'no_template'
      const html = renderPage(await this.dashboardData(), template)
      let old: string | null = null
      try {
        old = String(await this.d.fs.read(this.pagePath))
      } catch {
        old = null
      }
      if (!pageChanged(old, html)) return 'unchanged'
      await this.d.fs.write(this.pagePath, html)
      await this.updateState({ changed_at: this.now() / 1000 })
      return 'changed'
    } catch {
      return 'failed'
    }
  }

  async published(url: string): Promise<void> {
    if (!publishedUrlOk(url)) return
    await this.updateState({ url, published_at: this.now() / 1000, denied: false })
  }

  async denied(): Promise<void> {
    await this.updateState({ denied: true })
  }

  async publish(run: (note: (d: { reason?: string; tool?: string }) => void) => Promise<string>, board: Board = MAIN_BOARD): Promise<string> {
    if (!(await this.authOk())) return 'auth_failed'
    const root = this.d.dataDir.replace(/[\\/]+$/, '')
    const pagePath = board === MAIN_BOARD ? this.pagePath : `${root}/${board.page}`
    const st = await this.readState(board === MAIN_BOARD ? this.statePath : `${root}/${board.state}`)
    const input: Record<string, string> = { file_path: pagePath }
    if (typeof st.url === 'string' && ARTIFACT_URL_RX.test(st.url)) input.url = st.url
    else input.icon = board.icon
    let outcome: string
    let reason: string | undefined
    try {
      outcome = String(await run((d) => {
        if (typeof d?.reason === 'string') reason = d.reason
        if (d?.tool === 'ArtifactData') input.tool = d.tool
      }))
    } catch {
      outcome = 'failed'
    }
    if (PUBLISH_ATTEMPTS.includes(outcome) && this.d.outbox) {
      let page = ''
      try {
        page = String(await this.d.fs.read(pagePath))
      } catch {
        page = ''
      }
      const bytes = utf8(page)
      this.d.outbox.publish(input, sha256Hex(bytes), bytes.length, outcome, outcome === 'denied' ? reason : undefined)
    }
    return outcome
  }


  private today(): string {
    return localDay(this.now())
  }

  async metricsState(): Promise<MetricsState> {
    const s = await get(this.d.store, METRICS_STATE_KEY)
    const day = (v: unknown): string | null => (isDay(v) ? v : null)
    return isObj(s)
      ? { previewed_day: day(s.previewed_day), enabled_day: day(s.enabled_day), last_uploaded_day: day(s.last_uploaded_day) }
      : { previewed_day: null, enabled_day: null, last_uploaded_day: null }
  }

  private async saveState(changes: Partial<MetricsState>): Promise<void> {
    const account = await accountOf(this.d.store)
    await put(this.d.store, METRICS_STATE_KEY, { ...(await this.metricsState()), ...changes, ...(account ? { account } : {}) })
  }

  async salt(): Promise<Uint8Array> {
    const parse = (v: unknown): Uint8Array | null =>
      typeof v === 'string' && SALT_RX.test(v) ? Uint8Array.from(v.match(/../g)!, (h) => parseInt(h, 16)) : null
    const have = parse(await get(this.d.store, SALT_KEY))
    if (have) return have
    const random = this.d.random ?? ((n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n)))
    const raw = random(32)
    await put(this.d.store, SALT_KEY, hex(raw))
    return parse(await get(this.d.store, SALT_KEY)) ?? raw
  }

  async facts(bound: { since?: number; maxBytes?: number; stream?: boolean } = {}, full = false): Promise<Facts> {
    const s = new Scanner(this.d.prices ?? {})
    await loadTranscripts(this.d.fs, this.d.projectsRoot, 6, { ...bound, onFile: async (f) => void (f.lines ? await s.addLines(f, f.lines) : s.add(f)) })
    const facts = s.finish()
    if (!full) return facts
    await refreshToolDays({ fs: this.d.fs, store: this.d.store, dataDir: this.d.dataDir, projectsRoot: this.d.projectsRoot ?? null, prices: this.d.prices, run: this.d.run ?? null, now: this.now() })
    return this.withToolDays(facts)
  }

  private async withToolDays(facts: Facts): Promise<Facts> {
    const file = await this.timeDays()
    if (file) {
      facts.full_days = file
      for (const [day, d] of Object.entries(file)) {
        facts.time_by_day[day] = {
          typed_bytes: num(d.typed_bytes) ?? 0,
          agent_seconds: num(d.agent_seconds) ?? 0,
          agent_sum_seconds: num(d.agent_sum_seconds) ?? 0,
          turns: num(d.turns) ?? 0,
        }
      }
    }
    return facts
  }

  private async timeDays(): Promise<Record<string, Obj> | null> {
    try {
      const o = JSON.parse(String(await this.d.fs.read(`${this.d.dataDir}/services/${TIME_DAYS_FILE}`)))
      if (!isObj(o) || !isObj(o.days)) return null
      const at = num(o.at)
      const fresh = at !== null && this.now() >= at && this.now() - at < 60 * 60 * 1000
      const cut = at !== null ? localDay(at) : this.today()
      return Object.fromEntries(Object.entries(o.days).filter(([d, v]) => (d < cut || (fresh && d === cut)) && isObj(v))) as Record<string, Obj>
    } catch {
      return null
    }
  }


  async panel(): Promise<Panel> {
    const held = await get(this.d.store, USAGE_DAYS_KEY)
    const days = isObj(held) && isObj(held.days) ? held.days : {}
    const savings = (await this.metricsOnNow()) ? await this.savingsBody(false) : { error: 'service_off' }
    const week: Record<string, number> = {}
    const now = this.now()
    const today = this.today()
    for (let i = 0; i < 7; i++) {
      for (const [k, v] of Object.entries(countsOf(await readDay(this.d.store, plusDays(today, -i))))) week[k] = (week[k] ?? 0) + v
    }
    return panelOf(days, heldPlan(), savings, this.today(), now, week)
  }

  async panelLines(): Promise<string[]> {
    return panelLines(await this.panel())
  }

  private refreshPanel(): void {
    void this.track(
      (async () => {
        const before = JSON.stringify((await this.panel()).columns)
        await refreshUsage(this.d.store, (since) => this.facts(since === null ? {} : { since }, true), this.now())
        if (JSON.stringify((await this.panel()).columns) !== before) await this.band()
      })().catch(() => undefined),
    )
  }

  async refreshTime(): Promise<string> {
    if (!(await uploadOn(this.d.store))) return 'The savings record is not on for this account, so no time figures were sent.'
    const settings = await this.settings()
    if (settings.services.metrics !== true) return 'The savings record is off, so no time figures were sent.'
    if (settings.offline) return 'Offline mode is on, so no time figures were sent.'
    if (await accountSwitched(this.d.store)) {
      return 'This computer last uploaded for another account, so its past time figures were not sent: they may be ' +
        "that account's work. The time figures of new days go with the daily upload."
    }
    const last = await get(this.d.store, TIME_REFRESH_KEY)
    if (isObj(last) && last.running === true && (num(last.at) ?? 0) > this.now() - 30 * 60 * 1000) {
      return 'The time figures are being sent already; ask again in a few minutes.'
    }
    const before = isObj(last) && last.running !== true
      ? ` Last run: ${num(last.sent) ?? 0} days sent${typeof last.error === 'string' ? ` (stopped: ${last.error})` : ''}.`
      : ''
    await put(this.d.store, TIME_REFRESH_KEY, { running: true, at: this.now() })
    void this.track(this.sendTime().catch(() => put(this.d.store, TIME_REFRESH_KEY, { running: false, at: this.now(), sent: 0, error: 'failed' })))
    return 'Sending the time figures of the past days of this computer again, in the background. The service adds ' +
      'them only to days it already holds without time figures; dollars do not change. Run this again to see how ' +
      'it went.' + before
  }

  private async sendTime(): Promise<void> {
    const facts = await this.facts({ stream: true }, true)
    const today = this.today()
    const keep = plusDays(today, -395)
    const upload = await uploadFloor(this.d.store, today)
    const floor = upload > keep ? upload : keep
    let sent = 0
    let error: string | null = null
    for (const day of Object.keys(facts.time_by_day).sort()) {
      if (day < floor || day >= today) continue
      let body: Obj
      try {
        body = await this.dailyBody(day, facts)
      } catch {
        continue
      }
      if (!isObj(body.time)) continue
      const r = await dailyPost(this.d.svc, { ...body, time_only: true })
      if (!r.ok) {
        error = r.error || 'failed'
        break
      }
      sent += 1
    }
    await put(this.d.store, TIME_REFRESH_KEY, { running: false, at: this.now(), sent, error })
  }

  async previewBody(day: string): Promise<Obj> {
    const since = new Date(`${day}T00:00:00`).getTime()
    const facts = await this.withToolDays(await this.facts({ since, maxBytes: 384 * 1024 * 1024, stream: true }))
    this.previewed = incompleteNote(facts)
    return this.dailyBody(day, facts)
  }

  previewNote(): string | null {
    return this.previewed
  }

  async daySavings(day: string): Promise<DayCounters> {
    return uploadDay(await readDay(this.d.store, day))
  }

  async dailyBody(day: string, facts?: Facts): Promise<Obj> {
    let kinds: Record<string, string> | null = null
    try {
      kinds = this.d.kinds ? await this.d.kinds() : null
    } catch {
      kinds = null
    }
    const f = facts ?? (await this.facts())
    let methods: string | null = null
    try {
      methods = await this.d.fs.read(`${this.d.dataDir}/methods.md`)
    } catch {
    }
    return dailyBody(day, {
      facts: f,
      time: f.time_by_day?.[day] ?? null,
      savings: await this.daySavings(day),
      salt: await this.salt(),
      prices: this.d.prices ?? {},
      kinds,
      clientVersion: this.d.clientVersion,
      overheadPerRun: overheadTokens(methods),
    })
  }

  private async lease(): Promise<boolean> {
    const now = this.now()
    const cur = await get(this.d.store, METRICS_LEASE_KEY)
    if (isObj(cur) && cur.holder !== this.holder && (num(cur.until) ?? 0) > now) return false
    if (!(await put(this.d.store, METRICS_LEASE_KEY, { holder: this.holder, until: now + METRICS_LEASE_MS }))) return false
    const back = await get(this.d.store, METRICS_LEASE_KEY)
    return isObj(back) && back.holder === this.holder
  }

  private async unlease(): Promise<void> {
    const cur = await get(this.d.store, METRICS_LEASE_KEY)
    if (isObj(cur) && cur.holder === this.holder) {
      try {
        await this.d.store.delete(METRICS_LEASE_KEY)
      } catch {
      }
    }
  }

  private consent(granted: boolean): Promise<boolean> {
    return recordConsent(this.d.store, granted, (b) =>
      this.d.svc.call('POST', '/privacy/consent', b, { kind: 'daily', hook: 'background' }))
  }

  private async forgetConsent(): Promise<void> {
    const { entry } = await readEntry(this.d.store)
    if (entry.consent === true) await writeEntry(this.d.store, { consent: undefined })
  }

  async metricsTick(): Promise<TickResult> {
    this.tickedDay = this.today()
    const notYet = (skipped: string): TickResult => ((this.tickedDay = null), { skipped })
    if (!(await this.authOk())) return notYet('auth_failed')
    try {
      const g = this.d.svc.gateState()
      if (!g.open && g.reason !== 'unknown') return notYet('inactive')
    } catch {
      return notYet('inactive')
    }
    const settings = await this.settings()
    const { entry } = await readEntry(this.d.store)
    if (entry.record === 'off' && entry.consent !== false && !settings.offline) await this.consent(false)
    if (!(await uploadOn(this.d.store))) return { sent: [], error: 'not_answered' }
    if (settings.services.metrics !== true) return { sent: [], error: 'service_off' }
    if (settings.offline) return { sent: [], error: 'offline' }
    if (!(await this.lease())) return { skipped: 'busy' }
    try {
      const saved = (await accountSwitched(this.d.store)) ? { ...(await this.metricsState()), last_uploaded_day: null } : await this.metricsState()
      const today = this.today()
      const yesterday = plusDays(today, -1)
      const start = saved.last_uploaded_day ? plusDays(saved.last_uploaded_day, 1) : plusDays(saved.enabled_day || today, -30)
      const floor = await uploadFloor(this.d.store, today)
      const first = start < floor ? floor : start
      const st = start < floor ? { ...saved, last_uploaded_day: plusDays(floor, -1) } : saved
      if (first > yesterday) {
        if (await accountSwitched(this.d.store)) await this.saveState({ last_uploaded_day: st.last_uploaded_day })
        return { sent: [], error: null }
      }
      if (entry.consent !== true && !(await this.consent(true))) return { sent: [], error: 'consent_failed' }
      const facts = await this.facts({ since: new Date(`${first}T00:00:00`).getTime(), stream: true }, true)
      const withCounts = new Set<string>()
      for (const d of await counterDays(this.d.store)) if (!dayEmpty(await readDay(this.d.store, d))) withCounts.add(d)
      const active = (day: string): boolean => {
        const b = facts.by_day[day]
        if (b && Object.keys(b.by_model).length) return true
        if (facts.dispatches.some((x) => x.day === day)) return true
        return withCounts.has(day)
      }
      const sent: string[] = []
      let skipped: string | null = null
      for (const day of uploadDays(st, today, active)) {
        if (!(await this.metricsOnNow())) return { sent, error: 'service_off' }
        let body: Obj
        try {
          body = await this.dailyBody(day, facts)
        } catch (e) {
          if (e instanceof BodyTooLarge) {
            skipped = 'too_large'
            continue
          }
          throw e
        }
        let r = await dailyPost(this.d.svc, body)
        if (!r.ok && r.status === 422 && 'time' in body) {
          const { time: _time, ...rest } = body
          r = await dailyPost(this.d.svc, rest)
        }
        if (!r.ok) {
          if (r.error === 'consent_missing') await this.forgetConsent()
          return { sent, error: r.error || 'failed' }
        }
        sent.push(day)
        await this.saveState({ last_uploaded_day: day })
      }
      await this.saveState({ last_uploaded_day: yesterday })
      return { sent, error: skipped }
    } catch {
      return { sent: [], error: 'failed' }
    } finally {
      await this.unlease()
    }
  }

}

export const createWiring = (deps: WiringDeps): Wiring => new Wiring(deps)
