// The store's day counters as the Python client reads them (moved from wiring.ts unchanged): model
// ids normalized, the status line's and the dashboard's event counts, and the days with a counter record. The
// counters themselves are counters.ts; this module only reads them.
import { COUNTER_PREFIX, MAX_COMPACT_ROWS, MAX_INDEX_ROWS, MAX_ROUTE_ROWS, MAX_STEP_MODELS, MAX_STEPS, MAX_TRIM_ROWS, readDay } from './counters'
import type { DayCounters } from './counters'
import type { KV } from './engine_types'
import { isDay } from './metrics'
import { normModel } from './transcripts'
import { cheaper } from './summary'

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

// ------------------------------------------------------------------ store counters, as the Python client reads them

/**
 * The day counters with model ids normalized (the Python client's read_events applies norm_model to every event before
 * _counters folds them): rows whose ids become equal are merged, then sorted and capped as _counters does.
 */
export function normalizeDay(dc: DayCounters): DayCounters {
  const route = new Map<string, DayCounters['route'][number]>()
  for (const r of dc.route) {
    const model = normModel(r.model)
    const main = typeof r.main_model === 'string' && r.main_model ? normModel(r.main_model) : null
    const k = JSON.stringify([model, r.long, main])
    const have = route.get(k)
    if (!have) route.set(k, main ? { ...r, model, main_model: main } : { ...r, model })
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
  const out: DayCounters = {
    route: [...route.values()]
      .sort((a, b) => cmp(a.model, b.model) || Number(a.long) - Number(b.long) || cmp(a.main_model ?? '', b.main_model ?? ''))
      .slice(0, MAX_ROUTE_ROWS),
    index: [...index.values()].sort((a, b) => cmp(a.model, b.model) || a.file_tokens - b.file_tokens).slice(0, MAX_INDEX_ROWS),
    compact: compact.slice(0, MAX_COMPACT_ROWS),
  }
  if (dc.trim?.length) {
    const trim = new Map<string, { model: string; tokens: number; runs: number }>()
    for (const r of dc.trim) {
      const model = normModel(r.model)
      const have = trim.get(model)
      if (!have) trim.set(model, { model, tokens: r.tokens, runs: r.runs })
      else {
        have.tokens += r.tokens
        have.runs += r.runs
      }
    }
    out.trim = [...trim.values()].sort((a, b) => cmp(a.model, b.model)).slice(0, MAX_TRIM_ROWS)
  }
  return out
}

/** The day counters as the daily upload sends them: normalized, and each trim row marked `net` (2026-11-12): its runs
 * leave out those after a checkpoint compaction measured from the next request (trim.ts), which the server's
 * compaction lever already counts. Rows without the mark (older plugins) get that share left out on the server. */
export function uploadDay(dc: DayCounters): DayCounters {
  const out = normalizeDay(dc)
  if (out.trim) out.trim = out.trim.map((r) => ({ ...r, net: true }))
  return out
}

export const dayEmpty =(dc: DayCounters): boolean => !dc.route.length && !dc.index.length && !dc.compact.length && !dc.trim?.length

/** The status line's and the dashboard's event counts of one day: route turns, compactions and indexed reads. */
export function countsOf(dc: DayCounters): Record<string, number> {
  const out: Record<string, number> = {}
  const route = dc.route.reduce((n, r) => n + (cheaper(r.model) ? r.turns : 0), 0) // summary.ts cheaper: below the baseline
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
