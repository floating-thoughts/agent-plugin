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
//   session.start (background):  w.metricsTick()
//   slash command (P3):  w.metricsPreview(), w.metricsOn(), w.metricsOff(), w.estimatePreview(),
//                        w.estimateSend({ consent: true })
//
// Rules kept here (each one tested in tests/test_p67_wiring.py):
// - Auth fail (3.9: svc.authState() is not 'ok'): the status line is only the sign-in (or locked) line; no render,
//   no publish, no metrics or estimate request, no savings or report fetch.
// - Every dashboard publish attempt is logged in the outbox (kind artifact_publish): the Artifact input fields as
//   dashboard.ts passes them, the page's sha256 and size, and the outcome (3.7).
// - The page's data slot is collect()'s output: exactly render.ts DATA_FIELDS (3.8).
// - The daily body is metrics.ts dailyBody with the savings part from the store day counters (counters.ts readDay,
//   model ids normalized as host/metrics.py read_events does), so it equals host/metrics.py build_daily.
// - A preview (metrics or estimate) is the channel's own preview text (svc.preview: the exact inner body a send
//   carries, logged with preview true). The estimate is sent only with consent === true, once, and what is sent is
//   the text of the preview the user saw.
import type { CoreOptions } from './core'
import type { CallOptions, GateState, KV, SvcResult, Transport } from './engine_types'
import type { Outbox } from './outbox'
import type { Hook, Kind, Svc } from './svc'
import type { Facts, MetricsState, Prices, TranscriptFile } from './metrics'
import type { DayCounters } from './counters'
import { COUNTER_PREFIX, MAX_COMPACT_ROWS, MAX_INDEX_ROWS, MAX_ROUTE_ROWS, MAX_STEP_MODELS, MAX_STEPS, localDay, readDay } from './counters'
import { hex, sha256Hex, utf8 } from './e2e'
import { ESTIMATE_ROUTE, estimateRequest } from './estimate'
import { BodyTooLarge, DAILY_ROUTE, dailyBody, isDay, isLong, normModel, optIn, plusDays, READ_LIMIT, scan, uploadDays, walkOrder } from './metrics'
import { SALT_KEY } from './records'
import { collect, pageChanged, publishedUrlOk, render as renderPage, renderDue } from './render'
import { savingsDue, statusText, updateCommand, updateHintDue } from './status'
import { HOOK_BUDGET_MS, TIMEOUTS_MS } from './svc'

// Store keys of this module (shared by every session; nothing secret: numbers and days only).
export const SAVINGS_CACHE_KEY = 'savings_cache' // { tried_at, body }: the last good GET /metrics/savings body
export const REPORT_CACHE_KEY = 'report_cache' // { tried_at, body }: the last good GET /report body
export const METRICS_STATE_KEY = 'metrics_state' // { previewed_day, enabled_day, last_uploaded_day }
export const METRICS_LEASE_KEY = 'metrics_lease' // { holder, until }: best-effort, one uploading session
export const ESTIMATE_KEY = 'estimate_answer' // { made_at, estimate }: the last estimate answer, for the dashboard
export const UPDATE_HINT_KEY = 'update_hint_at' // ms of the last time the status line showed the update command
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
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

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

// ------------------------------------------------------------------ store counters, as host/metrics.py reads them

/**
 * The day counters with model ids normalized (host/metrics.py read_events applies norm_model to every event before
 * _counters folds them): rows whose ids become equal are merged, then sorted and capped as _counters does.
 */
export function normalizeDay(dc: DayCounters): DayCounters {
  const route = new Map<string, DayCounters['route'][number]>()
  for (const r of dc.route) {
    const model = normModel(r.model)
    const k = JSON.stringify([model, r.long])
    const have = route.get(k)
    if (!have) route.set(k, { ...r, model })
    else {
      have.turns += r.turns
      have.input_tokens += r.input_tokens
      have.output_tokens += r.output_tokens
      have.cache_read_tokens += r.cache_read_tokens
      have.cache_write_tokens += r.cache_write_tokens
    }
  }
  const index = new Map<string, DayCounters['index'][number]>()
  for (const r of dc.index) {
    const model = normModel(r.model)
    const k = JSON.stringify([model, r.file_tokens])
    const have = index.get(k)
    if (!have) index.set(k, { model, file_tokens: r.file_tokens, reads: r.reads })
    else have.reads += r.reads
  }
  const compact = dc.compact.map((row) => {
    const models: string[] = []
    const steps: [number, number][] = []
    for (const [context, i] of row.steps) {
      if (steps.length >= MAX_STEPS) break
      const m = normModel(row.models[i])
      if (!models.includes(m)) {
        if (models.length >= MAX_STEP_MODELS) continue
        models.push(m)
      }
      steps.push([context, models.indexOf(m)])
    }
    const start = row.start ? { ...row.start, model: normModel(row.start.model) } : null
    return { ref: row.ref, start, models, steps }
  })
  return {
    route: [...route.values()].sort((a, b) => cmp(a.model, b.model) || Number(a.long) - Number(b.long)).slice(0, MAX_ROUTE_ROWS),
    index: [...index.values()].sort((a, b) => cmp(a.model, b.model) || a.file_tokens - b.file_tokens).slice(0, MAX_INDEX_ROWS),
    compact: compact.slice(0, MAX_COMPACT_ROWS),
  }
}

const dayEmpty = (dc: DayCounters): boolean => !dc.route.length && !dc.index.length && !dc.compact.length

/** The status line's and the dashboard's event counts of one day: route turns, compactions and indexed reads. */
export function countsOf(dc: DayCounters): Record<string, number> {
  const out: Record<string, number> = {}
  const route = dc.route.reduce((n, r) => n + r.turns, 0)
  const compact = dc.compact.filter((r) => r.start !== null).length
  const index = dc.index.reduce((n, r) => n + r.reads, 0)
  if (route > 0) out.route = route
  if (compact > 0) out.compact_start = compact
  if (index > 0) out.index = index
  return out
}

/** The days that have a counter record in the store, sorted. */
export async function counterDays(store: KV): Promise<string[]> {
  let keys: string[] = []
  try {
    keys = await store.keys()
  } catch {
    return []
  }
  const days = new Set<string>()
  for (const k of keys) {
    if (!k.startsWith(COUNTER_PREFIX)) continue
    const d = k.slice(COUNTER_PREFIX.length, COUNTER_PREFIX.length + 10)
    if (isDay(d)) days.add(d)
  }
  return [...days].sort(cmp)
}

/** render.ts collect()'s dayCounts from the store: local day -> event kind -> count; null when there is none. */
export async function dayCountsFromStore(store: KV): Promise<Record<string, Record<string, number>> | null> {
  const days = await counterDays(store)
  if (!days.length) return null
  const out: Record<string, Record<string, number>> = {}
  for (const d of days) {
    const c = countsOf(await readDay(store, d))
    if (Object.keys(c).length) out[d] = c
  }
  return out
}

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
  async authState(): Promise<'ok' | 'login' | 'locked'> {
    try {
      const st = await this.d.svc.authState()
      return st === 'ok' || st === 'locked' ? st : 'login'
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
    if (st !== 'ok') return statusText({ auth: st === 'locked' ? 'locked' : 'signed_out', metricsOn: false, saved: null, counts: {} })
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

  /** The status line after session_start and turn_end: the cached figure at once, then again after a due fetch. */
  async refreshStatus(): Promise<string> {
    if (!(await this.authOk())) {
      const text = await this.line(null, null)
      this.show(text)
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
    if (update !== null) return text // the update line stays until the next refresh
    const after = await this.savingsBody(true)
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      text = await this.line(after, null)
      this.show(text)
    }
    return text
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
    return collect({
      now: this.now() / 1000,
      status,
      savings: await this.savingsBody(true),
      report: await this.cached(REPORT_CACHE_KEY, '/report', REPORT_TTL_MS, true),
      settings: { services: { ...settings.services }, served: { channel: isObj(settings.served) ? settings.served.channel : null } },
      dayCounts: await dayCountsFromStore(this.d.store),
      estimate: isObj(est) ? est : null,
      servedFetch: served,
    })
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

// ------------------------------------------------------------------ the core's Transport over the svc channel

/** The svc hook budget a core deadline fits in: agent.spawn 1 s, tool.call 8 s, else background. */
export const hookFor = (deadlineMs: number): Hook =>
  !(deadlineMs > HOOK_BUDGET_MS.spawn) ? 'spawn' : deadlineMs <= HOOK_BUDGET_MS.tool ? 'tool' : 'background'

const FAILED: SvcResult = { ok: false, status: null, body: null, error: 'failed' }

/**
 * engine_types.ts Transport on svc.ts Svc. The gate is the auth state first (3.9: 'login' or 'locked' straight
 * from the store, so a signed-out session passes every event through from its first one), then the channel's gate.
 * Never throws.
 */
export function svcTransport(svc: Svc): Transport {
  const kindOf = (k: string): Kind | undefined => (Object.hasOwn(TIMEOUTS_MS, k) ? (k as Kind) : undefined)
  return {
    async call(method: 'GET' | 'POST', path: string, body: Record<string, unknown> | null, opts: CallOptions): Promise<SvcResult> {
      try {
        return result(await svc.call(method, path, body ?? undefined, { kind: kindOf(opts?.kind), hook: hookFor(opts?.deadlineMs) }))
      } catch {
        return FAILED
      }
    },
    async gateState(): Promise<GateState> {
      try {
        const a = await svc.authState()
        if (a !== 'ok') return { open: false, reason: a === 'locked' ? 'locked' : 'login', minShell: null }
        const g = svc.gateState()
        // Signed in (in the store) while this session's gate still says login or locked: another session signed in
        // since this one's 401 or 423 (3.9 item 5). Report unknown so the core handshakes again.
        if (!g.open && (g.reason === 'login' || g.reason === 'locked')) return { open: false, reason: 'unknown', minShell: null }
        return { open: g.open, reason: g.reason, minShell: g.min_shell }
      } catch {
        return { open: false, reason: 'unavailable', minShell: null }
      }
    },
    async handshake(opts: CallOptions): Promise<SvcResult> {
      try {
        return result(await svc.handshake(hookFor(opts?.deadlineMs)))
      } catch {
        return FAILED
      }
    },
    async fetchServed(sessionRef: string, role: string, phase: string, opts: CallOptions): Promise<SvcResult> {
      try {
        return result(await svc.fetchServed(sessionRef, role, phase, hookFor(opts?.deadlineMs)))
      } catch {
        return FAILED
      }
    },
    endServedSession(sessionRef: string): void {
      try {
        svc.endServedSession(sessionRef)
      } catch {
        // local only
      }
    },
  }
}
