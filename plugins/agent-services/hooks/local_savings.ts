import type { DayCounters } from './counters'
import { TOOLS as CONTRACT_TOOLS } from './contract'
import { money } from './pyfmt'
import { bare, priceOf, type Counts, type Entry, type Prices } from './transcripts'
import { utf8 } from './e2e'

export type RunSaving = { used: string; baseline: string; usd: number }

function aboveBaseline(model: string): boolean {
  const m = model.toLowerCase()
  return m.includes('fable') || m.includes('mythos')
}

function opusId(prices: Prices): string | null {
  const row = (prices?.models ?? []).find((r: any) => typeof r?.prefix === 'string' && r.prefix.includes('opus'))
  return row ? String(row.prefix) : null
}

function costAt(model: string, c: Counts, prompt: number, prices: Prices): number | null {
  const p = priceOf(model, prompt, prices)
  if (!p) return null
  return (c.input * p.input + c.output * p.output + c.cacheRead * p.cacheRead + c.cacheWrite5m * p.cacheWrite5m + c.cacheWrite1h * p.cacheWrite1h) / 1e6
}

function baselineCost(c: Counts, prompt: number, main: string | null, prices: Prices): number | null {
  const opus = opusId(prices)
  const base = opus ? costAt(opus, c, prompt, prices) : null
  if (base === null) return null
  const m = main ? costAt(main, c, prompt, prices) : null
  return m === null ? base : Math.min(base, m)
}

function overheadUsd(model: string, tokens: number, prices: Prices): number {
  const p = priceOf(model, 0, prices)
  return p ? (tokens * p.input) / 1e6 : 0
}

export function overheadTokens(methodsText: string | null): number {
  let bytes = 2000
  for (const t of CONTRACT_TOOLS) bytes += utf8(JSON.stringify({ name: t.name, description: t.description, input_schema: t.input_schema })).length
  if (typeof methodsText === 'string') bytes += utf8(methodsText).length
  return Math.ceil(bytes / 4)
}

export function daySaving(route: DayCounters['route'], prices: Prices, overhead: number): number {
  let usd = 0
  for (const r of route ?? []) {
    if (!r || typeof r.model !== 'string') continue
    usd -= r.turns * overheadUsd(r.model, overhead, prices)
    if (aboveBaseline(r.model)) continue
    const c: Counts = { input: r.input_tokens, output: r.output_tokens, cacheRead: r.cache_read_tokens, cacheWrite5m: r.cache_write_tokens, cacheWrite1h: 0 }
    const prompt = r.long ? 1e12 : 0
    const actual = costAt(r.model, c, prompt, prices)
    const base = baselineCost(c, prompt, r.main_model ?? null, prices)
    if (actual !== null && base !== null) usd += Math.max(0, base - actual)
  }
  return usd
}

function family(model: string): string {
  const name = bare(model)
  return /\b(haiku|sonnet|opus|fable|mythos)\b/.exec(name.replace(/-/g, ' '))?.[1] ?? name
}

export function runSaving(entries: Iterable<Entry>, main: string | null, prices: Prices, overhead: number): RunSaving | null {
  let usd = 0
  let used: string | null = null
  for (const e of entries) {
    if (!e || typeof e.model !== 'string' || !e.model) continue
    used ??= e.model
    if (aboveBaseline(e.model)) return null
    const prompt = e.counts.input + e.counts.cacheRead + e.counts.cacheWrite5m + e.counts.cacheWrite1h
    const actual = costAt(e.model, e.counts, prompt, prices)
    const base = baselineCost(e.counts, prompt, main, prices)
    if (actual === null || base === null) return null
    usd += Math.max(0, base - actual)
  }
  if (used === null) return null
  usd -= overheadUsd(used, overhead, prices)
  const opus = opusId(prices)
  const mainCheaper = main && opus && (priceOf(main, 0, prices)?.input ?? Infinity) < (priceOf(opus, 0, prices)?.input ?? Infinity)
  return { used: family(used), baseline: family(mainCheaper ? main! : opus ?? 'opus'), usd }
}


type Row = Record<string, unknown>
function numOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function hours(s: unknown): string {
  return `${(Math.round(((numOf(s) ?? 0) / 3600) * 10) / 10).toFixed(1)} h`
}

function sessionGap(r: Row): boolean {
  return numOf(r.sessions) === 0 && ((numOf(r.agent_seconds) ?? 0) > 0)
}

function dayLine(r: Row): string {
  const parts: string[] = []
  for (const [k, word] of [['route_usd', 'route'], ['compact_usd', 'compact'], ['trim_usd', 'trim'], ['index_usd', 'index']] as const) {
    const v = numOf(r[k])
    if (v === null || Math.abs(v) < 0.005) continue
    parts.push(`${word} ${money(v)}${v < 0 ? ' loss' : ''}`)
  }
  let line = `${String(r.day)}: saved ${money(numOf(r.usd) ?? 0)}${parts.length ? ` (${parts.join(', ')})` : ''}`
  if (numOf(r.api_usd) !== null) line += ` of ${money(r.api_usd)} usage`
  if (sessionGap(r)) line += '; sessions not recorded'
  else if (numOf(r.sessions) !== null) line += `; ${r.sessions} sessions`
  if (numOf(r.subagent_runs) !== null) line += `, ${r.subagent_runs} subagents`
  if (numOf(r.agent_seconds) !== null) line += `, agent ${hours(r.agent_seconds)}`
  return line
}

export function savingsSummary(body: unknown): Row {
  const b: Row = body && typeof body === 'object' && !Array.isArray(body) ? (body as Row) : {}
  const days: Row[] = Array.isArray(b.by_day) ? (b.by_day as unknown[]).filter((r): r is Row => !!r && typeof r === 'object') : []
  const out: Row = {
    total: { usd: b.usd ?? null, api_usd: b.api_usd ?? null, pct: b.pct ?? null, first_day: b.first_day ?? null, last_day: b.last_day ?? null, days: b.days ?? null },
  }
  const levers: Row = {}
  for (const k of ['route', 'compact', 'trim', 'index']) if (b[k] && typeof b[k] === 'object') levers[k] = b[k]
  out.levers = levers
  const t = b.time && typeof b.time === 'object' ? (b.time as Row) : null
  if (t) out.time = { agent: hours(t.agent_seconds), concurrency_saved: hours(t.concurrent_seconds), typing: hours(t.typing_seconds), turns: t.turns ?? null }
  out.last_7_days = days.slice(-7).map(dayLine)
  out.best_days = [...days]
    .filter((r) => (numOf(r.usd) ?? 0) > 0)
    .sort((x, y) => (numOf(y.usd) ?? 0) - (numOf(x.usd) ?? 0))
    .slice(0, 3)
    .map((r) => `${String(r.day)}: ${money(r.usd)}`)
  const lossDays = (k: string): string[] => days.filter((r) => (numOf(r[k]) ?? 0) <= -0.005).map((r) => `${String(r.day)} ${money(r[k])}`)
  const losses: Row = {}
  const route = lossDays('route_usd')
  if (route.length) {
    losses.route = { days: route.slice(-5), more: Math.max(0, route.length - 5),
      why: "the plugin's own overhead on the day's routed runs cost more than routing saved (routing alone never goes below zero)" }
  }
  const compactLoss = lossDays('compact_usd')
  if (compactLoss.length) {
    losses.compact = { days: compactLoss.slice(-5), more: Math.max(0, compactLoss.length - 5),
      why: "a compaction's cost is counted on its first request after it, its saving on later requests (often the next day; never if the session ends soon)" }
  }
  if (Object.keys(losses).length) out.losses = losses
  const gaps = days.filter(sessionGap).map((r) => String(r.day))
  if (gaps.length) {
    out.notes = [`Sessions not recorded on ${gaps.slice(-6).join(', ')}${gaps.length > 6 ? ` and ${gaps.length - 6} more days` : ''} ` +
      'despite agent time: older plugin releases left main transcripts over 4 MiB out of the record\'s session count.']
  }
  out.full_view = 'Full history: savings with detail "full" (large), or the private savings page (link: /agent-services).'
  return out
}

export function savingText(run: RunSaving | null): string | null {
  if (!run || !(run.usd >= 0.005) || run.used === run.baseline) return null
  return `agent-services: ${run.used} instead of ${run.baseline}: ~${money(run.usd)} saved (est.)`
}
