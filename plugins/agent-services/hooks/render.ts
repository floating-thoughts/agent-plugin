// The customer dashboard, harness-neutral: numbers-only facts (collect) and the page that shows them (render).
//
// A port of host/dashboard.py (collect, render, _stable, write's change test) and the pure parts of
// host/dashboard_state.py (the render interval and the published-url check). Nothing here touches the engine:
// every source is passed in, nothing is fetched, written or published. The page is written by the wiring (phase 2)
// to <data dir>/dashboard/index.html and published by the existing dashboard.ts.
//
// collect(input) takes, each optional and null when unknown (that part of the page is then null):
//   now         unix seconds (required)
//   status      the account and gate facts, shaped like the Python daemon's GET /local/status body:
//               { logged_in, plan, expires_at, services: {name: bool}, gate: { open }, offline, blocked }
//   savings     the body of GET /metrics/savings;  report  the body of GET /report
//   settings    { services: {name: bool}, served: { channel } }
//   dayCounts   local day -> event kind -> count (dayCountsOf(events) builds it from savings events); null when
//               there is no event record at all
//   estimate    the last estimate answer kept locally (as estimate.json);  servedFetch  the latest served_fetch
//               record ({ role, version, items, ts })
// The result holds exactly DATA_FIELDS: no text from a session, no path, id or host name (plan 3.8).
import { sha256 } from './noble.js'
import { hex, pyJson, utf8 } from './e2e'
import { localDay, parseIso, plusDays, pyRound, pySum } from './metrics'

export const VERSION = 1
export const RENDER_INTERVAL_S = 600 // between two renders (dashboard_state.py INTERVAL)
export const URL_MAX = 500
export const LEVERS = ['route', 'compact', 'index'] as const
export const COUNT_KINDS: Record<string, string> = { route: 'routed', compact_start: 'compactions', index: 'indexed_reads' }
export const DATA_FIELDS = [
  'v',
  'generated_at',
  'today',
  'account',
  'services',
  'metrics_on',
  'savings',
  'counts',
  'guard_blocks',
  'guidance',
  'comparison',
  'estimate',
  'activity',
] as const
const SLOT_RX = /(<script type="application\/json" id="data">)([\s\S]*?)(<\/script>)/
const DAY_RX = /^\d{4}-\d{2}-\d{2}$/
const NAME_RX = /^[a-z][a-z0-9_]{0,31}\n?$/ // re.match with $ also takes a trailing newline
const VERSION_RX = /^[0-9][0-9A-Za-z.+-]{0,31}\n?$/

type Obj = Record<string, any>
export type DayCounts = Record<string, Record<string, number>>
export type CollectInput = {
  now: number
  status?: Obj | null
  savings?: Obj | null
  report?: Obj | null
  settings?: Obj | null
  dayCounts?: DayCounts | null
  estimate?: Obj | null
  servedFetch?: Obj | null
}

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const count = (v: unknown): number | null => {
  const n = num(v)
  return n !== null && n >= 0 && n === Math.trunc(n) ? n : null
}
const day = (v: unknown): string | null => (typeof v === 'string' && DAY_RX.test(v) ? v : null)
const pad = (v: number, w = 2) => String(v).padStart(w, '0')
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** _local_day: the local day of an ISO time (a naive one taken as UTC), or null. */
export const localDayOf = (ts: unknown): string | null => {
  const m = parseIso(ts, 'utc')
  return m === null ? null : localDay(m)
}

/** The per-day event counts collect() takes, from savings events (objects or JSON lines). */
export function dayCountsOf(events: unknown[]): DayCounts {
  const out: DayCounts = {}
  for (const item of events ?? []) {
    let e: unknown = item
    if (typeof item === 'string') {
      try {
        e = JSON.parse(item)
      } catch {
        continue
      }
    }
    if (!isObj(e)) continue
    const d = localDayOf(e.ts)
    if (d === null || typeof e.kind !== 'string') continue
    const row = (out[d] ??= {})
    row[e.kind] = (row[e.kind] ?? 0) + 1
  }
  return out
}

// ------------------------------------------------------------------ parts

function events(dc: DayCounts | null | undefined, today: string): [Obj | null, Obj | null, Set<string>] {
  if (!isObj(dc)) return [null, null, new Set()]
  const zero = () => ({ routed: 0, compactions: 0, indexed_reads: 0 }) as Obj
  const counts = { today: zero(), all_time: zero() }
  const guard = { today: 0, all_time: 0 }
  let guardSeen = false
  const days = new Set<string>()
  for (const [d, kinds] of Object.entries(dc)) {
    if (!isObj(kinds)) continue
    let any = false
    for (const [kind, n] of Object.entries(kinds)) {
      if (!(typeof n === 'number' && n > 0)) continue
      any = true
      if (Object.hasOwn(COUNT_KINDS, kind)) {
        const name = COUNT_KINDS[kind]
        counts.all_time[name] += n
        if (d === today) counts.today[name] += n
      } else if (kind === 'guard_block') {
        guardSeen = true
        guard.all_time += n
        if (d === today) guard.today += n
      }
    }
    if (any) days.add(d)
  }
  return [counts, guardSeen ? guard : null, days]
}

function account(status: unknown): Obj | null {
  if (!isObj(status)) return null
  const signedIn = status.logged_in
  const plan = status.plan
  const exp = num(status.expires_at)
  let until: string | null = null
  if (exp !== null) {
    const t = new Date(Math.floor(exp * 1000))
    const y = t.getUTCFullYear()
    if (Number.isFinite(t.getTime()) && y >= 1 && y <= 9999) until = `${pad(y, 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
  }
  return {
    signed_in: typeof signedIn === 'boolean' ? signedIn : null,
    plan: ['diagnostic', 'guard', 'full'].includes(plan) ? plan : null,
    license_until: until,
  }
}

function services(status: unknown, settings: Obj | null): Obj | null {
  let flags: Obj | null = null
  let ok: boolean | null = null
  if (isObj(status) && isObj(status.services)) {
    flags = status.services
    const gate = isObj(status.gate) ? status.gate : {}
    ok = status.logged_in === true && gate.open !== false && status.offline !== true && !status.blocked
  } else if (settings && isObj(settings.services)) {
    flags = settings.services
  }
  if (!flags || !Object.keys(flags).length) return null
  const out: Obj = {}
  for (const name of Object.keys(flags).sort(cmp)) {
    const on = flags[name]
    if (NAME_RX.test(name) && typeof on === 'boolean') out[name] = { on, healthy: ok !== null ? on && ok : null }
  }
  return Object.keys(out).length ? out : null
}

function metricsOn(status: unknown, settings: unknown): boolean | null {
  for (const src of [status, settings]) {
    if (isObj(src) && isObj(src.services)) {
      const v = src.services.metrics
      if (typeof v === 'boolean') return v
    }
  }
  return null
}

type Sav = Obj & { by_day: Obj[] }
function savingsPart(s: unknown): Sav | null {
  if (!isObj(s) || 'error' in s || num(s.usd) === null) return null
  const levers: Obj = {}
  for (const name of LEVERS) {
    const lv = isObj(s[name]) ? s[name] : {}
    levers[name] = { usd: num(lv.usd), runs: count(lv.runs) }
  }
  const byDay: Obj[] = []
  for (const row of Array.isArray(s.by_day) ? s.by_day : []) {
    if (!isObj(row) || day(row.day) === null) continue
    const r: Obj = { day: row.day, usd: num(row.usd), api_usd: num(row.api_usd) }
    for (const n of LEVERS) r[`${n}_usd`] = num(row[`${n}_usd`])
    byDay.push(r)
  }
  byDay.sort((a, b) => cmp(a.day, b.day))
  return {
    usd: num(s.usd),
    pct: num(s.pct),
    api_usd: num(s.api_usd),
    first_day: day(s.first_day),
    last_day: day(s.last_day),
    days: count(s.days),
    levers,
    by_day: byDay,
  }
}

function peer(report: unknown): [number | null, number | null] {
  if (!isObj(report) || !Array.isArray(report.lines)) return [null, null]
  for (const line of report.lines) {
    if (isObj(line) && line.id === 'peer_saved' && isObj(line.values)) return [num(line.values.peer_pct), count(line.values.peers)]
  }
  return [null, null]
}

function weeks(sav: Sav | null, today: string): [number | null, number | null] {
  if (!sav || !sav.by_day.length) return [null, null]
  const cut1 = plusDays(today, -6)
  const cut2 = plusDays(today, -13)
  const thisWeek = pySum(sav.by_day.filter((r) => cut1 <= r.day && r.day <= today).map((r) => r.usd || 0))
  const last = sav.by_day.filter((r) => cut2 <= r.day && r.day < cut1)
  const lastWeek = pySum(last.map((r) => r.usd || 0))
  const any = last.length > 0
  return [pyRound(thisWeek, 6), any ? pyRound(lastWeek, 6) : null]
}

function comparison(sav: Sav | null, report: unknown, today: string): Obj | null {
  const [peerPct, peers] = peer(report)
  const [thisWeek, lastWeek] = weeks(sav, today)
  if (peerPct === null && thisWeek === null) return null
  let change: number | null = null
  if (thisWeek !== null && lastWeek !== null && lastWeek !== 0) change = pyRound((thisWeek - lastWeek) / Math.abs(lastWeek), 4)
  return {
    your_pct: sav ? sav.pct : null,
    peer_median_pct: peerPct,
    peers,
    this_week_usd: thisWeek,
    last_week_usd: lastWeek,
    week_change: change,
  }
}

const EST_KEYS: [string, string[]][] = [
  ['low_usd', ['low_usd', 'usd_low', 'low']],
  ['high_usd', ['high_usd', 'usd_high', 'high']],
  ['pct_low', ['pct_low', 'low_pct']],
  ['pct_high', ['pct_high', 'high_pct']],
  ['period_days', ['period_days', 'days']],
  ['basis_days', ['basis_days', 'sample_days']],
]

function estimatePart(d: unknown): Obj | null {
  if (!isObj(d)) return null
  const src = isObj(d.estimate) ? d.estimate : d
  const out: Obj = {}
  for (const [key, names] of EST_KEYS) {
    const hit = names.find((n) => num(src[n]) !== null)
    out[key] = hit === undefined ? null : num(src[hit])
  }
  const made = 'made_at' in src ? src.made_at : d.made_at
  out.made_on = typeof made === 'string' ? localDayOf(made) : null
  if (out.low_usd === null && out.high_usd === null && out.pct_low === null && out.pct_high === null) return null
  return out
}

function guidance(found: unknown, settings: Obj | null): Obj | null {
  if (!isObj(found) || (found.event !== undefined && found.event !== 'served_fetch')) return null
  const version = found.version
  const served = (settings ?? {}).served
  const channel = isObj(served) ? served.channel : null
  return {
    role: ['control', 'auto', 'plugin'].includes(found.role) ? found.role : null,
    version: typeof version === 'string' && VERSION_RX.test(version) ? version : null,
    items: count(found.items),
    channel: channel === 'stable' || channel === 'beta' ? channel : null,
    last_used: localDayOf(found.ts),
  }
}

function activity(days: Set<string>, sav: Sav | null, today: string): Obj | null {
  const all = new Set(days)
  if (sav) {
    for (const r of sav.by_day) if ((r.api_usd || 0) > 0 || (r.usd || 0) !== 0) all.add(r.day)
  }
  let first: string | null = null
  for (const d of all) if (first === null || d < first) first = d
  if (sav && sav.first_day && (first === null || sav.first_day < first)) first = sav.first_day
  if (first === null) return null
  let cur = all.has(today) ? today : plusDays(today, -1)
  let streak = 0
  while (all.has(cur)) {
    streak++
    cur = plusDays(cur, -1)
  }
  return { first_seen: first, streak_days: streak, active_days: all.size, active_today: all.has(today) }
}

/** The last served_fetch record of a log (objects or JSON lines), as _guidance finds it in connector.log. */
export function latestServedFetch(records: unknown[]): Obj | null {
  let found: Obj | null = null
  for (const item of records ?? []) {
    let r: unknown = item
    if (typeof item === 'string') {
      try {
        r = JSON.parse(item)
      } catch {
        continue
      }
    }
    if (isObj(r) && r.event === 'served_fetch') found = r
  }
  return found
}

// ------------------------------------------------------------------ public

const safe = <T>(f: () => T): T | null => {
  try {
    return f()
  } catch {
    return null
  }
}

/** Numbers-only facts about this customer's own use; each part that cannot be worked out is null. */
export function collect(input: CollectInput): Obj {
  const t = num(input?.now) ?? Date.now() / 1000
  const micro = Math.round(t * 1e6)
  const today = localDay(micro)
  const g = new Date(Math.floor(micro / 1e6) * 1000)
  const generated =
    `${pad(g.getUTCFullYear(), 4)}-${pad(g.getUTCMonth() + 1)}-${pad(g.getUTCDate())}` +
    `T${pad(g.getUTCHours())}:${pad(g.getUTCMinutes())}:${pad(g.getUTCSeconds())}Z`
  const settings = isObj(input.settings) ? input.settings : null
  const ev = safe(() => events(input.dayCounts, today)) ?? [null, null, new Set<string>()]
  const sav = safe(() => savingsPart(input.savings))
  return {
    v: VERSION,
    generated_at: generated,
    today,
    account: safe(() => account(input.status)),
    services: safe(() => services(input.status, settings)),
    metrics_on: safe(() => metricsOn(input.status, settings)),
    savings: sav,
    counts: ev[0],
    guard_blocks: ev[1],
    guidance: safe(() => guidance(input.servedFetch, settings)),
    comparison: safe(() => comparison(sav, input.report, today)),
    estimate: safe(() => estimatePart(input.estimate)),
    activity: safe(() => activity(ev[2], sav, today)),
  }
}

const sortKeys = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (isObj(v)) {
    const out: Obj = {}
    for (const k of Object.keys(v).sort(cmp)) out[k] = sortKeys(v[k])
    return out
  }
  return v
}

/** _encode: sorted-key ASCII JSON that cannot leave a <script> element. */
export const encode = (data: unknown): string =>
  pyJson(sortKeys(data)).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')

/** The template with its data slot filled; throws when the template has no slot. */
export function render(data: unknown, template: string): string {
  if (!SLOT_RX.test(template)) throw new Error('template has no data slot')
  const payload = encode(data)
  return template.replace(SLOT_RX, (_m, a: string, _b: string, c: string) => a + payload + c)
}

/** The page with generated_at taken out of its data, for comparing two renders. */
export function stable(html: string): string {
  return html.replace(SLOT_RX, (m0, a: string, b: string, c: string) => {
    let d: unknown
    try {
      d = JSON.parse(b)
    } catch {
      return m0
    }
    if (isObj(d)) delete d.generated_at
    return a + encode(d) + c
  })
}

/** write()'s test: false when the new page differs from the old one only in generated_at. */
export const pageChanged = (oldHtml: string | null | undefined, html: string): boolean =>
  typeof oldHtml !== 'string' || stable(oldHtml) !== stable(html)

/** The data slot of a rendered page, parsed (for checks and tests), or undefined. */
export function slotData(html: string): unknown {
  const m = SLOT_RX.exec(html)
  if (!m) return undefined
  try {
    return JSON.parse(m[2])
  } catch {
    return undefined
  }
}

/** DashboardState.on_turn_end's interval test (unix seconds). */
export const renderDue = (lastRender: number | null, now: number): boolean =>
  lastRender === null || now - lastRender >= RENDER_INTERVAL_S

/** DashboardState.published's check of the url the plugin reports. */
export const publishedUrlOk = (url: unknown): url is string =>
  typeof url === 'string' && url.startsWith('https://') && url.length <= URL_MAX

/**
 * The local log line of one dashboard publish attempt (plan 3.7, kind "artifact_publish"): the Artifact input
 * fields as dashboard.ts passes them, the page's sha256 and size, and the outcome. Publishing is never attempted
 * while auth has failed (3.9): mayPublish is false then.
 */
export function publishRecord(ts: string, input: { file_path: string; url?: string; icon?: string }, page: string, outcome: string): Obj {
  const bytes = utf8(page)
  const fields: Obj = { file_path: input.file_path }
  if (typeof input.url === 'string') fields.url = input.url
  else if (typeof input.icon === 'string') fields.icon = input.icon
  return { ts, kind: 'artifact_publish', input: fields, page_sha256: hex(sha256(bytes)), page_bytes: bytes.length, outcome }
}

export const mayPublish = (auth: { failed: boolean }): boolean => auth.failed !== true
