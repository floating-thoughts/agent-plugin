// Phase 2 wiring of modules P6 and P7 (plan 3.7, 3.8, 3.9): the status line (status.ts), the dashboard (render.ts),
// the daily metrics (metrics.ts) and the estimate (estimate.ts), joined to the in-process core (core.ts,
// counters.ts) and the svc channel (svc.ts, outbox.ts). Harness-neutral: nothing here touches `$`; the channel,
// the store, the file access, the clock and the engine callbacks (status line, publish) are passed in.
//
// What register.ts (P8) does with it:
//   const w = createWiring({ svc, store, fs, dataDir, outbox, prices, template, setStatus, projectsRoot, ... })
//   const core = new Core({ transport: svcTransport(svc), store, ..., ...w.coreOptions() })
//                                              // coreOptions: status, dashboard, metrics, counters.isLong
//   after a main-agent turn:  await w.publish(() => publishDashboard($))     // dashboard.ts, guarded and logged
//   the band above the prompt (R9):  createWiring({ ..., setBand: bandSetter($) }) and installBand(on) (band.ts);
//                                    every refreshStatus hands it w.bandFacts() (cached reads only)
//   session.start (background):  w.metricsTick()
//   slash command (P3):  w.metricsPreview(), w.metricsOn(), w.metricsOff(), w.estimatePreview(),
//                        w.estimateSend({ consent: true })
//
// Rules kept here (each one tested in tests/test_p67_wiring.py):
// - Auth fail (3.9: svc.authState() is not 'ok'): the status line is only the sign-in (or locked) line; no render,
//   no publish, no metrics or estimate request, no savings or report fetch.
// - Every dashboard publish attempt is logged in the outbox (kind artifact_publish): the Artifact input fields as
//   dashboard.ts passes them, the page's sha256 and size, and the outcome (3.7).
// - The page's data slot is collect()'s output plus board_facts.ts timeline and weekly: exactly BOARD_FIELDS (3.8, R8).
// - The daily body is metrics.ts dailyBody with the savings part from the store day counters (counters.ts readDay,
//   model ids normalized as host/metrics.py read_events does), so it equals host/metrics.py build_daily.
// - A preview (metrics or estimate) is the channel's own preview text (svc.preview: the exact inner body a send
//   carries, logged with preview true). The estimate is sent only with consent === true, once, and what is sent is
//   the text of the preview the user saw.
import type { CoreOptions } from './core'
import type { GateState, KV, SvcResult, Transport } from './engine_types'
import type { Outbox } from './outbox'
import type { Hook, Kind, Svc } from './svc'
import type { Facts, MetricsState, Prices, TranscriptFile } from './metrics'
import type { DayCounters } from './counters'
import { localDay, readDay } from './counters'
import { hex, sha256Hex, utf8 } from './e2e'
import { ESTIMATE_ROUTE, estimateRequest } from './estimate'
import { BodyTooLarge, DAILY_ROUTE, dailyBody, isDay, isLong, normModel, optIn, plusDays, READ_LIMIT, scan, uploadDays, walkOrder } from './metrics'
import { SALT_KEY } from './records'
import { collect, pageChanged, publishedUrlOk, render as renderPage, renderDue } from './render'
import { DEFAULT_ON_NOTICE, savingsDue, statusText, updateCommand, updateHintDue, weeklyText } from './status'
import { counterDays, countsOf, dayCountsFromStore, dayEmpty, normalizeDay } from './day_counts'
import { boardData, readOutboxDay, timelineOf, weeklyOf } from './board_facts'
import { bandFacts, paused, type BandFacts } from './band'
import { readOrg } from './org'

export { counterDays, countsOf, dayCountsFromStore, normalizeDay } from './day_counts'
export { hookFor, svcTransport } from './transport'
export { bandSetter, installBand } from './band'

// Store keys of this module (shared by every session; nothing secret: numbers and days only).
export const SAVINGS_CACHE_KEY = 'savings_cache' // { tried_at, body }: the last good GET /metrics/savings body
export const REPORT_CACHE_KEY = 'report_cache' // { tried_at, body }: the last good GET /report body
export const METRICS_STATE_KEY = 'metrics_state' // { previewed_day, enabled_day, last_uploaded_day }
export const METRICS_LEASE_KEY = 'metrics_lease' // { holder, until }: best-effort, one uploading session
export const ESTIMATE_KEY = 'estimate_answer' // { made_at, estimate }: the last estimate answer, for the dashboard
export const UPDATE_HINT_KEY = 'update_hint_at' // ms of the last time the status line showed the update command
export const SAVINGS_NOTICE_KEY = 'savings_notice_at' // ms of the one time DEFAULT_ON_NOTICE was shown
export const WEEKLY_KEY = 'weekly_savings' // { week, start, usd }: the first cumulative savings figure of a week
export const METRICS_LEASE_MS = 120_000
export const REPORT_TTL_MS = 600_000
export const ESTIMATE_PREVIEW_TTL_MS = 3_600_000 // an estimate preview older than this must be shown again
export const PUBLISH_ATTEMPTS = ['published', 'denied', 'failed'] // dashboard.ts outcomes that made a tool call
export const ARTIFACT_URL_RX = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/ // as dashboard.ts URL_RX
export const SALT_RX = /^[0-9a-f]{64}$/

type Obj = Record<string, any>

/** The file access the wiring needs ($.fs in register.ts; node:fs in tests). */
export type WiringFs = {
  read(path: string): Promise<string> // rejects when missing or unreadable ($.fs.read refuses files over 4 MiB)
  write(path: string, text: string): Promise<void>
  list?(path: string): Promise<readonly { name: string; size?: number; dir?: boolean }[]>
}

export type WiringDeps = {
  svc: Svc
  store: KV
  fs: WiringFs
  dataDir: string // the same folder dashboard.ts publishes from (<data dir>)
  prices: Prices // modules/usage/prices.json, parsed
  template: () => Promise<string | null> // <plugin>/dashboard/index.html text
  setStatus?: (text: string) => unknown // $.ui.status
  setBand?: (facts: BandFacts | null) => unknown // band.ts bandSetter: the band above the prompt (R9)
  outbox?: Outbox | null
  clock?: () => number // ms since the epoch
  random?: (n: number) => Uint8Array
  projectsRoot?: string | null // <HOME>/.claude/projects (or under CLAUDE_CONFIG_DIR); null: no transcripts
  kinds?: () => Promise<Record<string, string> | null> // main session id -> auto | orchestrator | direct
  servedFetch?: () => Promise<Obj | null> // the latest served_fetch record { role, version, items, ts }
  update?: { marketplace: string | null; selfUpdates: boolean } | null // selfUpdates false: show the update line
  holder?: string // this session's id, for the metrics lease
  clientVersion?: string
}

export type TickResult = { sent: string[]; error: string | null } | { skipped: string }
export type PreviewResult = { day: string; text: string } | { error: string }
export type EstimatePreview = { text: string; note: string | null; estimated: Obj } | { error: string }
export type EstimateSend = { sent: true; answer: unknown; note: string | null } | { sent: boolean; error: string }

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

// ------------------------------------------------------------------ transcripts

/**
 * The transcript files under the projects root (every *.jsonl at any depth, as tools/diagnostic/facts.py globs),
 * in os.walk order. A file over READ_LIMIT, or one the file access refuses, is listed with text null (metrics.ts
 * leaves it out of the facts; estimate.ts scales it by size).
 */
export async function loadTranscripts(fs: WiringFs, root: string | null | undefined, maxDepth = 6): Promise<TranscriptFile[]> {
  const out: TranscriptFile[] = []
  if (!root || typeof fs.list !== 'function') return out
  const base = root.replace(/[\\/]+$/, '')
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    let entries: readonly { name: string; size?: number; dir?: boolean }[]
    try {
      entries = await fs.list!(dir)
    } catch {
      return
    }
    for (const e of entries) {
      const path = `${dir}/${e.name}`
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.dir !== true && e.name.endsWith('.jsonl')) {
        const size = num(e.size)
        let text: string | null = null
        if (size === null || size <= READ_LIMIT) {
          try {
            text = String(await fs.read(path))
          } catch {
            text = null
          }
        }
        const got = text === null ? (size ?? 0) : utf8(text).length
        out.push({ rel: r, size: size ?? got, text: text !== null && utf8(text).length > READ_LIMIT ? null : text })
      } else if (e.dir !== false && depth < maxDepth) {
        await walk(path, r, depth + 1)
      }
    }
  }
  await walk(base, '', 0)
  return walkOrder(out)
}

// ------------------------------------------------------------------ the estimate answer, for the dashboard

/** The local estimate record the dashboard reads (render.ts estimatePart), from a DiagEstimate answer. */
export function estimateFacts(answer: unknown, madeAt: string): Obj | null {
  if (!isObj(answer)) return null
  const total = isObj(answer.total) ? answer.total : {}
  const usd = isObj(total.usd) ? total.usd : {}
  const pct = isObj(answer.pct) ? answer.pct : {}
  const window = isObj(answer.window) ? answer.window : {}
  return {
    made_at: madeAt,
    estimate: {
      low_usd: num(usd.low),
      high_usd: num(usd.high),
      pct_low: num(pct.low),
      pct_high: num(pct.high),
      period_days: 30, // the answer is per month (api_usd_month)
      basis_days: num(window.days),
    },
  }
}

// ------------------------------------------------------------------ the wiring

export class Wiring {
  private readonly d: WiringDeps
  private readonly clock: () => number
  private readonly holder: string
  private readonly pending = new Set<Promise<unknown>>()
  private lastRender: number | null = null // unix seconds
  private rendering = false
  private fetching = new Set<string>()
  private estimateHeld: { text: string; note: string | null; at: number } | null = null

  constructor(deps: WiringDeps) {
    this.d = deps
    this.clock = deps.clock ?? (() => Date.now())
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

  /** Every background render, fetch and status refresh started here done (tests and session end). */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending])
  }

  /** 3.9: signed in and not blocked (re-read from the store at most every 5 s by the channel). */
  async authState(): Promise<'ok' | 'login' | 'locked' | 'paused'> {
    try {
      const st = await this.d.svc.authState()
      return st === 'ok' || st === 'locked' || st === 'paused' ? st : 'login'
    } catch {
      return 'login'
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
    return (await this.settings()).services.metrics === true
  }

  /** What the core takes: CoreOptions status, dashboard, metrics and the counters' long-prompt rule. */
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

  /** The prices' long-prompt rule on the normalized model id, as host/metrics.py _long sees it. */
  isLong(model: string, prompt: number): boolean {
    try {
      return isLong(normModel(model), prompt, this.d.prices ?? {})
    } catch {
      return false
    }
  }

  // ---------------- cached GETs (savings, report), shared by every session through the store

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
      return body // a failed fetch keeps the old figure
    } finally {
      this.fetching.delete(key)
    }
  }

  /** The savings body for the status line and the dashboard (refreshed when due and the upload is on). */
  async savingsBody(fetch = true): Promise<Obj | null> {
    const on = await this.metricsOnNow()
    const c = await get(this.d.store, SAVINGS_CACHE_KEY)
    const tried = isObj(c) ? num(c.tried_at) : null
    const ttlDue = savingsDue(tried, this.now(), this.fetching.has(SAVINGS_CACHE_KEY))
    return this.cached(SAVINGS_CACHE_KEY, '/metrics/savings', 0, fetch && on && ttlDue)
  }

  /** The savings tool's answer for the core (host/metrics.py Metrics.savings). */
  async savings(): Promise<SvcResult> {
    if (!(await this.metricsOnNow())) return { ok: false, status: null, body: null, error: 'service_off' }
    const r = await this.d.svc.call('GET', '/metrics/savings', undefined, { kind: 'daily', hook: 'tool' })
    if (r.ok && isObj(r.body)) await put(this.d.store, SAVINGS_CACHE_KEY, { tried_at: this.now(), body: r.body })
    return result(r)
  }

  // ---------------- the status line (3.8, 3.9)

  /** Today's counts from the store counters (local day). */
  async todayCounts(): Promise<Record<string, number>> {
    try {
      return countsOf(await readDay(this.d.store, localDay(this.now())))
    } catch {
      return {}
    }
  }

  private async line(saved: Obj | null, update: string | null): Promise<string> {
    const st = await this.authState()
    if (st !== 'ok') return statusText({ auth: st === 'locked' || st === 'paused' ? st : 'signed_out', metricsOn: false, saved: null, counts: {} })
    const on = await this.metricsOnNow()
    return statusText({ auth: 'ok', metricsOn: on, saved: on ? saved : null, counts: await this.todayCounts(), update })
  }

  private show(text: string): void {
    try {
      this.d.setStatus?.(text)
    } catch {
      // the status line never breaks a hook
    }
  }

  /** The status line after session_start and turn_end: the cached figure at once, then again after a due fetch.
   *  `first` runs right after the first line is shown, so a hanging fetch never delays it; when it shows a line
   *  of its own (answers true), the fetched figure does not overwrite that line in this refresh. */
  async refreshStatus(first?: () => Promise<boolean>): Promise<string> {
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
    if (update !== null) return text // the update line stays until the next refresh
    const after = await this.savingsBody(true)
    if (!held && JSON.stringify(after) !== JSON.stringify(before)) {
      text = await this.line(after, null)
      this.show(text)
      await this.band()
    }
    return text
  }

  // ---------------- the band above the prompt (R9, band.ts)

  /**
   * The band's facts: board_facts.ts timelineOf and weeklyOf over cached reads only (the savings figure as the
   * status line takes it: only while the upload is on), so the band says what the board and the status line say.
   * Null while signed out or paused (band.ts paused: an org pause included) and when there is nothing to show.
   */
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

  /** The band's state after a status-line refresh (nothing when no band is wired). */
  private async band(): Promise<void> {
    if (!this.d.setBand) return
    const facts = await this.bandFacts()
    try {
      this.d.setBand(facts)
    } catch {
      // the band never breaks a hook
    }
  }

  // ---------------- the one-time and weekly lines at session start (log line and toast)

  /** The lines to show at session start: DEFAULT_ON_NOTICE once, then the weekly summary. Nothing while auth fails. */
  async startNotices(): Promise<string[]> {
    if (!(await this.authOk()) || !(await this.metricsOnNow())) return []
    const out: string[] = []
    if (num(await get(this.d.store, SAVINGS_NOTICE_KEY)) === null && (await put(this.d.store, SAVINGS_NOTICE_KEY, this.now()))) {
      out.push(DEFAULT_ON_NOTICE)
    }
    const weekly = await this.weeklySummary()
    if (weekly) out.push(weekly)
    return out
  }

  /**
   * The first session of an ISO week (UTC) with a savings figure: "Last week agent-services saved you $X." from the
   * cumulative figure now less the one stored in an earlier week ("So far ..." the first time). Once per week; null
   * when there is nothing to say, auth fails or the upload is off.
   */
  async weeklySummary(): Promise<string | null> {
    if (!(await this.authOk()) || !(await this.metricsOnNow())) return null
    const prev = await get(this.d.store, WEEKLY_KEY)
    if (weeklyText(prev, this.now(), 0).mark === null) return null // already done this week
    const r = await this.d.svc.call('GET', '/metrics/savings', undefined, { kind: 'daily', hook: 'background' })
    if (!r.ok || !isObj(r.body)) return null
    await put(this.d.store, SAVINGS_CACHE_KEY, { tried_at: this.now(), body: r.body })
    const w = weeklyText(prev, this.now(), r.body.usd)
    if (!w.mark || !(await put(this.d.store, WEEKLY_KEY, w.mark))) return null
    return w.text
  }

  // ---------------- the dashboard (3.8)

  private async readState(): Promise<Obj> {
    const out: Obj = { changed_at: null, url: null, published_at: null, denied: false }
    try {
      const got = JSON.parse(String(await this.d.fs.read(this.statePath)))
      if (isObj(got)) for (const k of Object.keys(out)) if (k in got) out[k] = got[k]
    } catch {
      // none yet
    }
    return out
  }

  private async updateState(fields: Obj): Promise<void> {
    const st = { ...(await this.readState()), ...fields }
    try {
      await this.d.fs.write(this.statePath, JSON.stringify(st, null, 2))
    } catch {
      // best effort, as dashboard_state.py
    }
  }

  /** DashboardState.on_turn_end: start a render when none ran in the last 10 minutes; returns at once. */
  onTurnEnd(): boolean {
    const now = this.now() / 1000
    if (this.rendering || !renderDue(this.lastRender, now)) return false
    this.lastRender = now
    this.rendering = true
    void this.track(this.renderDashboard().finally(() => (this.rendering = false)))
    return true
  }

  /** The facts collect() takes, from the channel, the store and the caches (never a session text or path). */
  async dashboardData(): Promise<Obj> {
    const settings = await this.settings()
    let status: Obj | null = null
    try {
      status = { ...(await this.d.svc.status()), services: { ...settings.services } }
    } catch {
      status = null
    }
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
    // O3: a person in an org (any savings choice, "each" included) is told on the board that the admin sees the figure
    const org = await readOrg(this.d.store)
    return boardData(base, { outboxLines: await this.outboxToday(), todayCounts: await this.todayCounts(), savings, report, status: { ...(status ?? {}), org } })
  }

  /** Today's outbox lines of every session, for the board's timeline (this session's held lines written first). */
  async outboxToday(): Promise<Obj[]> {
    try {
      await this.d.outbox?.flush()
      return await readOutboxDay(this.d.fs, `${this.d.dataDir.replace(/[\\/]+$/, '')}/services/outbox`, this.now())
    } catch {
      return []
    }
  }

  /** One render: the page is written (and changed_at recorded) only when it changed beyond generated_at. */
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

  /** The core's dashboard_published report: remember the artifact (DashboardState.published). */
  async published(url: string): Promise<void> {
    if (!publishedUrlOk(url)) return
    await this.updateState({ url, published_at: this.now() / 1000, denied: false })
  }

  async denied(): Promise<void> {
    await this.updateState({ denied: true })
  }

  /**
   * One guarded dashboard publish: `run` is dashboard.ts publishDashboard($). Not run at all in auth fail (3.9).
   * Every attempt that reached the Artifact tool is logged in the outbox (3.7) with the input fields dashboard.ts
   * passed (file_path, and url or icon), the page's sha256 and size, the outcome, and a deny's reason. `run` gets
   * the `note` that takes that reason.
   */
  async publish(run: (note: (d: { reason?: string }) => void) => Promise<string>): Promise<string> {
    if (!(await this.authOk())) return 'auth_failed'
    const st = await this.readState()
    const input: Record<string, string> = { file_path: this.pagePath }
    if (typeof st.url === 'string' && ARTIFACT_URL_RX.test(st.url)) input.url = st.url
    else input.icon = 'chart'
    let outcome: string
    let reason: string | undefined
    try {
      outcome = String(await run((d) => {
        if (typeof d?.reason === 'string') reason = d.reason
      }))
    } catch {
      outcome = 'failed'
    }
    if (PUBLISH_ATTEMPTS.includes(outcome) && this.d.outbox) {
      let page = ''
      try {
        page = String(await this.d.fs.read(this.pagePath))
      } catch {
        page = ''
      }
      const bytes = utf8(page)
      this.d.outbox.publish(input, sha256Hex(bytes), bytes.length, outcome, outcome === 'denied' ? reason : undefined)
    }
    return outcome
  }

  // ---------------- daily metrics (3.8, host/metrics.py Metrics)

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
    await put(this.d.store, METRICS_STATE_KEY, { ...(await this.metricsState()), ...changes })
  }

  /** The project-hash salt, shared with records.ts (store key salt, 64 hex). */
  async salt(): Promise<Uint8Array> {
    const parse = (v: unknown): Uint8Array | null =>
      typeof v === 'string' && SALT_RX.test(v) ? Uint8Array.from(v.match(/../g)!, (h) => parseInt(h, 16)) : null
    const have = parse(await get(this.d.store, SALT_KEY))
    if (have) return have
    const random = this.d.random ?? ((n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n)))
    const raw = random(32)
    await put(this.d.store, SALT_KEY, hex(raw))
    return parse(await get(this.d.store, SALT_KEY)) ?? raw // two sessions making one at once: the stored one wins
  }

  /** The transcript facts (tools/diagnostic/facts.py scan) of the projects root. */
  async facts(): Promise<Facts> {
    return scan(await loadTranscripts(this.d.fs, this.d.projectsRoot), this.d.prices ?? {})
  }

  /** The savings part of one day's body: the store counters, normalized. */
  async daySavings(day: string): Promise<DayCounters> {
    return normalizeDay(await readDay(this.d.store, day))
  }

  /** The POST /metrics/daily body of one local day (host/metrics.py build_daily); throws BodyTooLarge. */
  async dailyBody(day: string, facts?: Facts): Promise<Obj> {
    let kinds: Record<string, string> | null = null
    try {
      kinds = this.d.kinds ? await this.d.kinds() : null
    } catch {
      kinds = null
    }
    return dailyBody(day, {
      facts: facts ?? (await this.facts()),
      savings: await this.daySavings(day),
      salt: await this.salt(),
      prices: this.d.prices ?? {},
      kinds,
      clientVersion: this.d.clientVersion,
    })
  }

  /** Metrics.preview: the exact text an upload of `day` (default yesterday) carries, logged as a preview. */
  async metricsPreview(day?: string | null): Promise<PreviewResult> {
    if (!(await this.authOk())) return { error: 'auth_failed' }
    const d = day ? String(day) : plusDays(this.today(), -1)
    if (!isDay(d)) return { error: 'bad_day' }
    let body: Obj
    try {
      body = await this.dailyBody(d)
    } catch (e) {
      return { error: e instanceof BodyTooLarge ? 'too_large' : 'failed' }
    }
    const text = this.d.svc.preview('POST', DAILY_ROUTE, body)
    if (text === null) return { error: 'invalid_body' }
    await this.saveState({ previewed_day: d })
    return { day: d, text }
  }

  /** Metrics.opt_in: only after a preview. */
  async metricsOn(): Promise<{ ok: boolean; error: string | null }> {
    if (!(await this.authOk())) return { ok: false, error: 'auth_failed' }
    const r = optIn(await this.metricsState(), this.today())
    if (!r.ok) return { ok: false, error: r.error }
    if (!(await this.d.svc.setService('metrics', true))) return { ok: false, error: 'store_failed' }
    await this.saveState({ enabled_day: r.state.enabled_day })
    return { ok: true, error: null }
  }

  async metricsOff(): Promise<{ ok: boolean; error: string | null }> {
    const ok = await this.d.svc.setService('metrics', false)
    return { ok, error: ok ? null : 'store_failed' }
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
        // expires by itself
      }
    }
  }

  /** Metrics.tick (background, at session start): upload every due active day up to yesterday, oldest first. */
  async metricsTick(): Promise<TickResult> {
    if (!(await this.authOk())) return { skipped: 'auth_failed' }
    try {
      const g = this.d.svc.gateState()
      if (!g.open && g.reason !== 'unknown') return { skipped: 'inactive' }
    } catch {
      return { skipped: 'inactive' }
    }
    const settings = await this.settings()
    if (settings.services.metrics !== true) return { sent: [], error: 'service_off' }
    if (settings.offline) return { sent: [], error: 'offline' }
    if (!(await this.lease())) return { skipped: 'busy' }
    try {
      const st = await this.metricsState()
      const today = this.today()
      const yesterday = plusDays(today, -1)
      const first = st.last_uploaded_day ? plusDays(st.last_uploaded_day, 1) : plusDays(st.enabled_day || today, -30)
      if (first > yesterday) return { sent: [], error: null }
      const facts = await this.facts()
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
            skipped = 'too_large' // would fail the same way every tick: left out
            continue
          }
          throw e
        }
        const r = await this.d.svc.call('POST', DAILY_ROUTE, body, { kind: 'daily', hook: 'background' })
        if (!r.ok) return { sent, error: r.error || 'failed' }
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

  // ---------------- the estimate (3.8, host/diagnostic.py)

  /** estimate preview: the exact text a send carries (logged as a preview), and what was scaled by size. */
  async estimatePreview(): Promise<EstimatePreview> {
    if (!(await this.authOk())) return { error: 'auth_failed' }
    const prep = estimateRequest(await this.facts(), this.d.clientVersion)
    if ('error' in prep) return { error: prep.error }
    const text = this.d.svc.preview('POST', ESTIMATE_ROUTE, prep.body)
    if (text === null) return { error: 'invalid_body' }
    this.estimateHeld = { text, note: prep.note, at: this.now() }
    return { text, note: prep.note, estimated: prep.estimated }
  }

  /**
   * estimate send: only with consent === true, only after a preview (within ESTIMATE_PREVIEW_TTL_MS), and once per
   * preview. What is sent is the previewed text itself.
   */
  async estimateSend(opts: { consent?: unknown } = {}): Promise<EstimateSend> {
    if (opts?.consent !== true) return { sent: false, error: 'consent_required' }
    if (!(await this.authOk())) return { sent: false, error: 'auth_failed' }
    const held = this.estimateHeld
    if (!held || this.now() - held.at > ESTIMATE_PREVIEW_TTL_MS) return { sent: false, error: 'preview_first' }
    this.estimateHeld = null
    const r = await this.d.svc.call('POST', ESTIMATE_ROUTE, JSON.parse(held.text), { kind: 'daily', consent: true, hook: 'tool' })
    if (!r.ok) return { sent: true, error: r.error || 'failed' }
    const rec = estimateFacts(r.body, new Date(this.now()).toISOString())
    if (rec) await put(this.d.store, ESTIMATE_KEY, rec)
    return { sent: true, answer: r.body, note: held.note }
  }
}

export const createWiring = (deps: WiringDeps): Wiring => new Wiring(deps)
