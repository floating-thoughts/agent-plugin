// The wiring of the status line (status.ts), the dashboard (render.ts),
// the daily metrics (metrics.ts) and the estimate (estimate.ts), joined to the in-process core (core.ts,
// counters.ts) and the svc channel (svc.ts, outbox.ts). Harness-neutral: nothing here touches `$`; the channel,
// the store, the file access, the clock and the engine callbacks (status line, publish) are passed in.
//
// What register.ts does with it:
//   const w = createWiring({ svc, store, fs, dataDir, outbox, prices, template, setStatus, projectsRoot, ... })
//   const core = new Core({ transport: svcTransport(svc), store, ..., ...w.coreOptions() })
//                                              // coreOptions: status, dashboard, metrics, counters.isLong
//   after a main-agent turn:  await w.publish(() => publishDashboard($))     // dashboard.ts, guarded and logged
//   the band above the prompt:  createWiring({ ..., setBand: bandSetter($) }) and installBand(on) (band.ts);
//                                    every refreshStatus hands it w.bandFacts() (cached reads only)
//   session.start (background):  w.metricsTick(); after a turn, refreshStatus runs it again once a day
//
// Rules kept here (each one tested in tests/test_p67_wiring.py):
// - Auth fail (svc.authState() is not 'ok'): the status line is only the sign-in (or locked) line; no render,
//   no publish, no metrics or estimate request, no savings or report fetch.
// - Every dashboard publish attempt is logged in the outbox (kind artifact_publish): the Artifact input fields as
//   dashboard.ts passes them, the page's sha256 and size, and the outcome.
// - The page's data slot is collect()'s output plus board_facts.ts timeline and weekly: exactly BOARD_FIELDS.
// - The daily body is metrics.ts dailyBody with the savings part from the store day counters (counters.ts readDay,
//   model ids normalized as the Python client's read_events does), so it equals the Python client's build_daily.
// - Nothing is uploaded unless the savings record is on (choice.ts uploadOn), and never a day before its floor
//   (choice.ts uploadFloor).
import type { EngineInterface } from 'claude-code'
import type { CoreOptions } from './core'
import type { GateState, KV, SvcResult, Transport } from './engine_types'
import type { Outbox } from './outbox'
import type { Hook, Kind, Svc } from './svc'
import type { Facts, MetricsState, Prices, TranscriptFile } from './metrics'
import type { DayCounters } from './counters'
import { localDay, readDay } from './counters'
import { b64Encode, hex, sha256Hex, utf8 } from './e2e'
import { BodyTooLarge, DAILY_ROUTE, dailyBody, isDay, isLong, normModel, plusDays, READ_LIMIT, uploadDays, walkOrder } from './metrics'
import { SALT_KEY } from './records'
import { collect, pageChanged, publishedUrlOk, render as renderPage, renderDue } from './render'
import { savingsDue, statusText, updateCommand, updateHintDue } from './status'
import { counterDays, countsOf, dayCountsFromStore, dayEmpty, normalizeDay } from './day_counts'
import { boardData, minUsd, readOutboxDay, timelineOf, weeklyOf } from './board_facts'
import { bandFacts, paused, setBandPanel, type BandFacts, type BandKind, type BandState } from './band'
import { readOrg } from './org'
import { accountOf, accountSwitched, readEntry, recordConsent, recordState, uploadFloor, uploadOn, writeEntry } from './choice'
import { boardLines, heldPlan, panelLines, panelOf, refreshUsage, USAGE_DAYS_KEY, type Panel } from './panel'
import { linesOf, Scanner, unpricedNote } from './transcripts'
import { refreshToolDays, type ProcessRun } from './usage_tool'
export { notePlan } from './panel' // register.ts imports it through this module
import { BossBoard } from './boss'
import { MAIN_BOARD, type Board } from './dashboard'

export { counterDays, countsOf, dayCountsFromStore, normalizeDay } from './day_counts'
export { hookFor, svcTransport } from './transport'
export { estimateFacts } from './estimate'
export { bandSetter, installBand } from './band'

// Store keys of this module (shared by every session; nothing secret: numbers and days only).
export const SAVINGS_CACHE_KEY = 'savings_cache' // { tried_at, body }: the last good GET /metrics/savings body
export const REPORT_CACHE_KEY = 'report_cache' // { tried_at, body }: the last good GET /report body
export const METRICS_STATE_KEY = 'metrics_state' // { previewed_day, enabled_day, last_uploaded_day }
export const METRICS_LEASE_KEY = 'metrics_lease' // { holder, until }: best-effort, one uploading session
export const TIME_REFRESH_KEY = 'time_refresh' // { running, at, sent?, error? }: the last sharing refresh_time run
export const TIME_DAYS_FILE = 'time-days.json' // under <data dir>/services: the owner tool's per-day figures
export const ESTIMATE_KEY = 'estimate_answer' // { made_at, estimate }: the last estimate answer, for the dashboard
export const UPDATE_HINT_KEY = 'update_hint_at' // ms of the last time the status line showed the update command
export const METRICS_LEASE_MS = 120_000
export const REPORT_TTL_MS = 600_000
export const PUBLISH_ATTEMPTS = ['published', 'updated', 'denied', 'failed'] // dashboard.ts outcomes that made a tool call
export const ARTIFACT_URL_RX = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/ // as dashboard.ts URL_RX
export const SALT_RX = /^[0-9a-f]{64}$/

type Obj = Record<string, any>

/** The file access the wiring needs ($.fs in register.ts; node:fs in tests). */
export type WiringFs = {
  read(path: string): Promise<string> // rejects when missing or unreadable ($.fs.read refuses files over 4 MiB)
  write(path: string, text: string): Promise<void>
  list?(path: string): Promise<readonly { name: string; size?: number; dir?: boolean; mtime?: number }[]> // mtime: ms
  // a file too large for read(), its text in pieces (engineChunks in register.ts); rejects or throws when it fails
  chunks?(path: string): AsyncIterable<string>
}

export type WiringDeps = {
  svc: Svc
  store: KV
  fs: WiringFs
  dataDir: string // the same folder dashboard.ts publishes from (<data dir>)
  prices: Prices // the shipped price table, parsed
  template: () => Promise<string | null> // <plugin>/dashboard/index.html text
  setStatus?: (text: string) => unknown // $.ui.status
  setBand?: (state: BandState | null) => unknown // band.ts bandSetter: the band above the prompt
  outbox?: Outbox | null
  clock?: () => number // ms since the epoch
  random?: (n: number) => Uint8Array
  projectsRoot?: string | null // <HOME>/.claude/projects (or under CLAUDE_CONFIG_DIR); null: no transcripts
  kinds?: () => Promise<Record<string, string> | null> // main session id -> auto | orchestrator | direct
  servedFetch?: () => Promise<Obj | null> // the latest served_fetch record { role, version, items, ts }
  update?: { marketplace: string | null; selfUpdates: boolean } | null // selfUpdates false: show the update line
  holder?: string // this session's id, for the metrics lease
  clientVersion?: string
  run?: ProcessRun | null // $.process.run: the local usage scan tool (usage_tool.ts); absent or null: never run
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

// ------------------------------------------------------------------ transcripts

/**
 * The transcript files under the projects root (every *.jsonl at any depth, as the diagnostic tool's globs),
 * in os.walk order. A file over READ_LIMIT, or one the file access refuses, is listed with text null (metrics.ts
 * leaves it out of the facts and lists it in facts.unread; estimate.ts scales it by size).
 * `since` (ms): a file last changed before it is left out, as it holds no entry of a later moment (a listing without
 * mtime keeps every file). `maxBytes`: reading more text than this throws, so a caller under a hook's time budget
 * stops before parsing gigabytes (the parse is the hook's own time; the reads are not).
 * `stream` (with onFile): a file over READ_LIMIT is given as `lines` read from fs.chunks (Scanner.addLines), one
 * line held at a time; under maxBytes a file that would pass the bound stays unread instead of throwing.
 */
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
        const got = text === null ? (size ?? 0) : utf8(text).length // encoded once: it is the hook's own time
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
    // one file at a time, in walkOrder: no text is kept after the callback
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

/** The sentence a view adds when its figures are incomplete: transcripts it could not read (their sessions, tokens
 * and subagent runs are left out) and models with no known price (their dollars count as 0); null when complete. */
export function incompleteNote(facts: Pick<Facts, 'unread' | 'unpriced'>): string | null {
  const n = (facts.unread ?? []).length
  const parts = [
    n ? `${n} transcript file${n === 1 ? '' : 's'} could not be read, so ${n === 1 ? 'its' : 'their'} usage is left out.` : null,
    unpricedNote(facts.unpriced),
  ].filter((x): x is string => !!x)
  return parts.length ? parts.join(' ') : null
}

/** How long the copy command may send nothing before it is stopped and the file counts as unread. */
export const COPY_IDLE_MS = 60000

/** The argv that copies one file's bytes to standard output (engineChunks): `cat` on macOS and Linux; on Windows
 * PowerShell opens the file named by the AGENT_SVC_COPY variable read-only, sharing writes (the session may still be
 * writing it), and copies it. Fixed text, no shell: the path never becomes part of a command. */
export function copyArgv(path: string): string[] {
  if (!/^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(path)) return ['cat', path]
  const script =
    "$f=[IO.File]::Open($env:AGENT_SVC_COPY,'Open','Read','ReadWrite');$o=[Console]::OpenStandardOutput();$f.CopyTo($o);$o.Flush();$f.Close()"
  const b = new Uint8Array(script.length * 2)
  for (let i = 0; i < script.length; i++) b[i * 2] = script.charCodeAt(i) // UTF-16LE of an ASCII text
  return ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', b64Encode(b)]
}

/**
 * The text of a transcript too large for $.fs.read, in pieces as the engine streams them ($.process.spawn of
 * copyArgv): register.ts passes it as the file access's `chunks`. Throws when the command cannot start or ends with
 * another code than 0, or sends nothing for COPY_IDLE_MS (it is then stopped), so the file counts as unread. Only
 * this process reads the text; nothing is sent.
 */
export async function* engineChunks($: EngineInterface, path: string, idleMs = COPY_IDLE_MS): AsyncGenerator<string> {
  // cwd: the plugin's own folder, never the session's project folder (a bare command name is looked up there first on Windows)
  const child = $.process.spawn({ argv: copyArgv(path), cwd: $.plugin.root, env: { AGENT_SVC_COPY: path } })
  const pieces = child[Symbol.asyncIterator]()
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const idle = new Promise<null>((res) => { timer = setTimeout(() => res(null), idleMs) })
    const step = await Promise.race([pieces.next(), idle])
    clearTimeout(timer)
    if (!step) {
      void pieces.return?.()?.catch(() => {}) // leaving the stream ends the command
      throw new Error('copy stalled')
    }
    if (step.done) break
    if (step.value.stream === 'stdout') yield step.value.text
  }
  const end = await child.result
  if (end.code !== 0) throw new Error('copy failed')
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
  private tickedDay: string | null = null // the local day the daily upload last ran in this session
  private previewed: string | null = null // previewNote: what the last previewBody left out

  /** the company admin's board (boss.ts), rendered after the person's own board. */
  readonly boss: BossBoard

  /** The plugin's version as the bodies carry it (metrics.ts releaseVersion), for the slash command's estimate. */
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

  /** Every background render, fetch and status refresh started here done (tests and session end). */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending])
  }

  /** Signed in and not blocked (re-read from the store at most every 5 s by the channel). */
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

  /** The daily upload is on: the savings record (choice.ts uploadOn) and the metrics routes' transport switch. */
  private async metricsOnNow(): Promise<boolean> {
    return (await uploadOn(this.d.store)) && (await this.settings()).services.metrics === true
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

  /** The prices' long-prompt rule on the normalized model id, as the Python client's _long sees it. */
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

  /** The savings tool's answer for the core (the Python client's Metrics.savings). */
  async savings(): Promise<SvcResult> {
    if (!(await this.metricsOnNow())) return { ok: false, status: null, body: null, error: 'service_off' }
    const r = await this.d.svc.call('GET', '/metrics/savings', undefined, { kind: 'daily', hook: 'tool' })
    if (r.ok && isObj(r.body)) await put(this.d.store, SAVINGS_CACHE_KEY, { tried_at: this.now(), body: r.body })
    return result(r)
  }

  // ---------------- the status line

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
    // sharingAsk false: the person's final "Don't upload" or a company "off", where asking to turn sharing on is moot
    const rec = await recordState(this.d.store)
    const sharingAsk = rec.own !== 'off' && rec.org !== 'off'
    return statusText({ auth: 'ok', metricsOn: on, sharingAsk, saved: on ? saved : null, counts: await this.todayCounts(), update, gate: this.closedGate() })
  }

  /** The reason the service gate is closed ('unknown' before the first hello counts as open), or null. */
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
      // the status line never breaks a hook
    }
  }

  /** The status line after session_start and turn_end: the cached figure at once, then again after a due fetch.
   *  `first` runs right after the first line is shown, so a hanging fetch never delays it; when it shows a line
   *  of its own (answers true), the fetched figure does not overwrite that line in this refresh. */
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
    if (update !== null) return text // the update line stays until the next refresh
    const after = await this.savingsBody(true)
    if (!held && JSON.stringify(after) !== JSON.stringify(before)) {
      text = await this.line(after, null)
      this.show(text)
      await this.band()
    }
    return text
  }

  // ---------------- the band above the prompt (band.ts)

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

  /**
   * The band's state (the band always shows something): the sign-in, lock and company
   * pause as the status line takes them, then a closed gate, then the facts (bandFacts, plus the status line's
   * total figure for when there is no 7-day one), else 'wait' or, with the savings record off, 'off'.
   */
  async bandState(): Promise<BandState> {
    try {
      const st = await this.authState()
      if (st !== 'ok') return { state: st === 'locked' ? 'locked' : st === 'paused' ? 'paused' : 'signed_out' }
      const gate = this.closedGate()
      if (gate !== null) {
        const kinds: Record<string, BandKind> = { login: 'signed_out', locked: 'locked', paused: 'paused', offline: 'offline', upgrade: 'upgrade' }
        return { state: Object.hasOwn(kinds, gate) ? kinds[gate]! : 'unreachable' }
      }
      const on = await this.metricsOnNow()
      const s = on ? await this.savingsBody(false) : null
      const usd = isObj(s) ? num(s.usd) : null
      const total = usd !== null && usd >= minUsd() ? { usd, since: typeof s!.first_day === 'string' ? s!.first_day : null } : null
      const facts = await this.bandFacts()
      if (facts || total) {
        const f: BandFacts = facts ?? { saved_usd: null, days: 7, counts: {}, latest: null }
        return { state: 'facts', facts: { ...f, total } }
      }
      return { state: on ? 'wait' : 'off' }
    } catch {
      return { state: 'starting' }
    }
  }

  /** The periodic redraw (register.ts, every PANEL_EVERY_MS): the stored days scanned again when due and the band
   *  redrawn, so reset countdowns and figures move during a long turn, not only at its end. Never throws. */
  async tick(): Promise<void> {
    try {
      void this.boss.sweep() // boss.ts: the company summary and board deleted when stale, signed out or not admin
      if (await this.authOk()) this.refreshPanel()
      await this.band()
    } catch {
      // the band never breaks a hook
    }
  }

  /** The band's state after a status-line refresh (nothing when no band is wired). */
  private async band(): Promise<void> {
    if (!this.d.setBand) return
    const state = await this.bandState()
    setBandPanel(['facts', 'wait', 'off'].includes(state.state) ? await this.panel().catch(() => null) : null)
    try {
      this.d.setBand(state)
    } catch {
      // the band never breaks a hook
    }
  }

  /** A session left open over midnight uploads the new day too: metricsTick at most once per local day here. */
  private dailyTick(): void {
    const day = this.today()
    if (this.tickedDay === day) return
    this.tickedDay = day
    void this.track(this.metricsTick())
  }


  // ---------------- the dashboard

  private async readState(path = this.statePath): Promise<Obj> {
    return (await this.stateOrNull(path)) ?? { changed_at: null, url: null, published_at: null, denied: false }
  }

  /** The state, or null when the file is listed but its read failed: a write then would erase the page's url. */
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
        return out // no folder to list: nothing there yet
      }
    }
    try {
      const got = JSON.parse(text)
      if (isObj(got)) for (const k of Object.keys(out)) if (k in got) out[k] = got[k]
      // dashboard.ts markPublishing: another session's first publish is under way; kept so this write does not erase it
      if (isObj(got) && typeof got.publishing_at === 'number') out.publishing_at = got.publishing_at
    } catch {
      // not JSON: nothing to keep
    }
    return out
  }

  private async updateState(fields: Obj): Promise<void> {
    const old = await this.stateOrNull(this.statePath)
    if (old === null) return // unreadable, not missing: keep the file as it is
    const st = { ...old, ...fields }
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
    void this.track(this.renderDashboard().then(() => this.boss.render()).finally(() => (this.rendering = false)))
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
    settings.services = { ...settings.services, metrics: await this.metricsOnNow() } // the board says what the record says
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
    // a person in an org (any savings choice, "each" included) is told on the board that the admin sees the figure
    const org = await readOrg(this.d.store)
    const panel = await this.panel().catch(() => null)
    return boardData(base, { outboxLines: await this.outboxToday(), todayCounts: await this.todayCounts(), savings, report, status: { ...(status ?? {}), org }, panel: panel ? boardLines(panel) : null })
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
   * One guarded dashboard publish: `run` is dashboard.ts publishDashboard($). Not run at all in auth fail.
   * Every attempt that reached the Artifact tool is logged in the outbox with the input fields dashboard.ts
   * passed (file_path, and url or icon; tool ArtifactData when only the figures were written to the page's data
   * document), the page's sha256 and size, the outcome, and a deny's reason. `run` gets the `note` that takes them.
   */
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
        if (d?.tool === 'ArtifactData') input.tool = d.tool // the figures only, written to the page's data document
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

  // ---------------- daily metrics (the Python client's Metrics)

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
    const account = await accountOf(this.d.store) // the account the upload state is for (choice.ts accountSwitched)
    await put(this.d.store, METRICS_STATE_KEY, { ...(await this.metricsState()), ...changes, ...(account ? { account } : {}) })
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

  /** The transcript facts (the diagnostic tool's scan) of the projects root. `full`: one file at a time (no text
   * kept), and the days of the days file (TIME_DAYS_FILE, written by the owner tool that reads every transcript,
   * over-4-MiB ones included; usage_tool.ts runs it when it is on this computer) take the place of the scan's time
   * figures and go to `full_days` for the panel. */
  async facts(bound: { since?: number; maxBytes?: number; stream?: boolean } = {}, full = false): Promise<Facts> {
    // one file at a time (the facts of scan() over the same files); `stream`: files over READ_LIMIT are read line by line
    const s = new Scanner(this.d.prices ?? {})
    await loadTranscripts(this.d.fs, this.d.projectsRoot, 6, { ...bound, onFile: async (f) => void (f.lines ? await s.addLines(f, f.lines) : s.add(f)) })
    const facts = s.finish()
    if (!full) return facts
    // usage_tool.ts: the local scan tool, when it is on this computer and due, writes the days file first
    await refreshToolDays({ fs: this.d.fs, store: this.d.store, dataDir: this.d.dataDir, projectsRoot: this.d.projectsRoot ?? null, prices: this.d.prices, run: this.d.run ?? null, now: this.now() })
    return this.withToolDays(facts)
  }

  /** The tool's days file (when there is one) laid over the scan: its time figures and full days replace the scan's. */
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

  /** The days file's days (written by a separate tool that reads every transcript), or null when there is none. */
  private async timeDays(): Promise<Record<string, Obj> | null> {
    try {
      const o = JSON.parse(String(await this.d.fs.read(`${this.d.dataDir}/services/${TIME_DAYS_FILE}`)))
      if (!isObj(o) || !isObj(o.days)) return null
      // the day the tool ran counts when the file is under an hour old (the plugin runs the tool every 15 minutes:
      // usage_tool.ts); in an older file that day was not over yet, so it and any later one come from the scan
      const at = num(o.at)
      const fresh = at !== null && this.now() >= at && this.now() - at < 60 * 60 * 1000
      const cut = at !== null ? localDay(at) : this.today()
      return Object.fromEntries(Object.entries(o.days).filter(([d, v]) => (d < cut || (fresh && d === cut)) && isObj(v))) as Record<string, Obj>
    } catch {
      return null
    }
  }

  // ---------------- the usage panel (panel.ts): band, status command, board

  /** The panel from the stored days (no scan here), the plan last seen and the cached savings figure. */
  async panel(): Promise<Panel> {
    const held = await get(this.d.store, USAGE_DAYS_KEY)
    const days = isObj(held) && isObj(held.days) ? held.days : {}
    // the savings record off -> { error: 'service_off' }, so the panel shows "off" rather than an unknown "--"
    const savings = (await this.metricsOnNow()) ? await this.savingsBody(false) : { error: 'service_off' }
    // the week's counts for the Stats column: the last 7 local days of the store counters, summed
    const week: Record<string, number> = {}
    const now = this.now()
    const today = this.today()
    for (let i = 0; i < 7; i++) {
      // calendar days back from today (a DST change makes a day 23 or 25 hours: now - i*24h would skip or repeat one)
      for (const [k, v] of Object.entries(countsOf(await readDay(this.d.store, plusDays(today, -i))))) week[k] = (week[k] ?? 0) + v
    }
    return panelOf(days, heldPlan(), savings, this.today(), now, week)
  }

  async panelLines(): Promise<string[]> {
    return panelLines(await this.panel())
  }

  /** The stored days, scanned again when due (panel.ts refreshUsage: every 10 minutes at most), then a redraw. */
  private refreshPanel(): void {
    void this.track(
      (async () => {
        const before = JSON.stringify((await this.panel()).columns)
        await refreshUsage(this.d.store, (since) => this.facts(since === null ? {} : { since }, true), this.now())
        if (JSON.stringify((await this.panel()).columns) !== before) await this.band() // a redraw only on a change
      })().catch(() => undefined),
    )
  }

  /**
   * `sharing refresh_time`: the past days of this computer's transcripts the daily upload may send (from the upload
   * floor on, at most the 395 days the service keeps) sent again with their time figures as a time-only refresh,
   * under the same switches as the daily upload (the savings record, the metrics transport, offline). The service
   * adds `time` only to a day of this account it already holds that has no time figures yet, and stores nothing
   * else, so dollars never change, another computer's figures are never overwritten and sending twice changes
   * nothing. Not after an account switch on this computer (its transcripts may be the other account's work).
   * Runs in the background; the answer says it started, and asking again says how the last run went.
   */
  async refreshTime(): Promise<string> {
    if (!(await uploadOn(this.d.store))) return 'The savings record is not on for this account, so no time figures were sent.'
    const settings = await this.settings()
    if (settings.services.metrics !== true) return 'The daily upload is off, so no time figures were sent.'
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
    const upload = await uploadFloor(this.d.store, today) // the daily upload's floor (the choice, an account switch)
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
      const r = await this.d.svc.call('POST', DAILY_ROUTE, { ...body, time_only: true }, { kind: 'daily', hook: 'background' })
      if (!r.ok) {
        error = r.error || 'failed'
        break
      }
      sent += 1
    }
    await put(this.d.store, TIME_REFRESH_KEY, { running: false, at: this.now(), sent, error })
  }

  /** One day's body for a preview inside a hook (10 s of its own time, where parsing is counted and reads are not):
   * only the transcripts changed since the day began (local time, as the day of an entry), and it throws past
   * 384 MiB of text (about 4 s to encode and parse, measured 9.5 ms per MiB) rather than overrun the hook. The day's
   * figures are those of a full scan: an entry of the day was written after the day began. */
  async previewBody(day: string): Promise<Obj> {
    const since = new Date(`${day}T00:00:00`).getTime()
    // the tool's days file as the upload has it (withToolDays), without running the tool inside the hook
    const facts = await this.withToolDays(await this.facts({ since, maxBytes: 384 * 1024 * 1024, stream: true }))
    this.previewed = incompleteNote(facts)
    return this.dailyBody(day, facts)
  }

  /** What the last preview's figures leave out (transcripts that could not be read, models with no price), or null. */
  previewNote(): string | null {
    return this.previewed
  }

  /** The savings part of one day's body: the store counters, normalized. */
  async daySavings(day: string): Promise<DayCounters> {
    return normalizeDay(await readDay(this.d.store, day))
  }

  /** The POST /metrics/daily body of one local day (the Python client's build_daily); throws BodyTooLarge. */
  async dailyBody(day: string, facts?: Facts): Promise<Obj> {
    let kinds: Record<string, string> | null = null
    try {
      kinds = this.d.kinds ? await this.d.kinds() : null
    } catch {
      kinds = null
    }
    const f = facts ?? (await this.facts())
    return dailyBody(day, {
      facts: f,
      time: f.time_by_day?.[day] ?? null,
      savings: await this.daySavings(day),
      salt: await this.salt(),
      prices: this.d.prices ?? {},
      kinds,
      clientVersion: this.d.clientVersion,
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
        // expires by itself
      }
    }
  }

  /** The upload choice as a consent record on the server (choice.ts recordConsent); quiet, true when confirmed. */
  private consent(granted: boolean): Promise<boolean> {
    return recordConsent(this.d.store, granted, (b) =>
      this.d.svc.call('POST', '/privacy/consent', b, { kind: 'daily', hook: 'background' }))
  }

  private async forgetConsent(): Promise<void> {
    const { entry } = await readEntry(this.d.store)
    if (entry.consent === true) await writeEntry(this.d.store, { consent: undefined })
  }

  /** Metrics.tick (background, at session start and once a day after): upload every due active day up to yesterday,
   * oldest first. */
  async metricsTick(): Promise<TickResult> {
    this.tickedDay = this.today()
    // skipped before signing in: the day is not done, so a sign-in later in this session still uploads it
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
    // a withdrawal ("off") the server did not confirm yet is sent again, while nothing is uploaded
    if (entry.record === 'off' && entry.consent !== false && !settings.offline) await this.consent(false)
    if (!(await uploadOn(this.d.store))) return { sent: [], error: 'not_answered' } // the record first: no upload, no back-fill
    if (settings.services.metrics !== true) return { sent: [], error: 'service_off' }
    if (settings.offline) return { sent: [], error: 'offline' }
    if (!(await this.lease())) return { skipped: 'busy' }
    try {
      // another account's upload state never decides what this account sends
      const saved = (await accountSwitched(this.d.store)) ? { ...(await this.metricsState()), last_uploaded_day: null } : await this.metricsState()
      const today = this.today()
      const yesterday = plusDays(today, -1)
      const start = saved.last_uploaded_day ? plusDays(saved.last_uploaded_day, 1) : plusDays(saved.enabled_day || today, -30)
      // never further back than 30 days before the yes (a long gap, or an old enabled_day, would send more)
      const floor = await uploadFloor(this.d.store, today)
      const first = start < floor ? floor : start
      const st = start < floor ? { ...saved, last_uploaded_day: plusDays(floor, -1) } : saved
      if (first > yesterday) {
        // nothing due yet after an account switch: write the state for this account now (last_uploaded_day = the day
        // before the floor, as the loop below would), so a later tick sends from the switch day on to this account
        if (await accountSwitched(this.d.store)) await this.saveState({ last_uploaded_day: st.last_uploaded_day })
        return { sent: [], error: null }
      }
      // 0.7.9: the server takes a day only with a granted consent record; a yes not recorded yet (one given before
      // 0.7.9, or a failed call) is recorded once first, and nothing is uploaded today when that fails
      if (entry.consent !== true && !(await this.consent(true))) return { sent: [], error: 'consent_failed' }
      // only the transcripts changed since the first day to send began: the same figures, far less to parse
      // files over READ_LIMIT are read line by line (stream), so long sessions count in by_model, by_task and sessions
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
            skipped = 'too_large' // would fail the same way every tick: left out
            continue
          }
          throw e
        }
        let r = await this.d.svc.call('POST', DAILY_ROUTE, body, { kind: 'daily', hook: 'background' })
        if (!r.ok && r.status === 422 && 'time' in body) {
          // a server older than the time figures refuses the field: send the day once more without it
          const { time: _time, ...rest } = body
          r = await this.d.svc.call('POST', DAILY_ROUTE, rest, { kind: 'daily', hook: 'background' })
        }
        if (!r.ok) {
          // the server holds no consent record: record the yes again before the next upload (quietly, no retry now)
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
