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

export function savingText(run: RunSaving | null): string | null {
  if (!run || !(run.usd >= 0.005) || run.used === run.baseline) return null
  return `agent-services: ${run.used} instead of ${run.baseline}: ~${money(run.usd)} saved (est.)`
}
