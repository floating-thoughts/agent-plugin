// The usage estimate, harness-neutral: the POST /diagnostic/estimate body, its preview and the one consented send.
//
// A port of tools/diagnostic/estimate.py build_request() and host/diagnostic.py estimate(): the body is built from
// metrics.ts scan() facts of the transcripts under <HOME>/.claude/projects (or CLAUDE_CONFIG_DIR/projects). Nothing
// here touches the engine; the facts and the send function are passed in.
//
// Inputs:
//   estimateRequest(facts, clientVersion?)  facts: metrics.ts scan(files, prices), where files over READ_LIMIT (4 MiB)
//                                           have text null. -> { request, estimated, note } or { error }.
//   runEstimate(facts, { consent, send })   consent: the user's explicit yes for this one send (the slash command's
//                                           `estimate send`); send(request): the svc channel (P2), called at most
//                                           once and only with consent, with the very request the preview shows.
//
// Files over 4 MiB are not read. They are counted by size and scaled: each such file adds its bytes times the
// per-byte figures of the files that were read on the same side (main conversation or subagents) to the token,
// dollar and response counts, the dispatch and compaction counts, and (main files) one session each, placed in the
// response histogram by its estimated response count. `estimated` and `note` say how much was estimated that way.
// With no unread file the body equals the Python one.
import { BODY_LIMIT } from './contract'
import { CLIENT_VERSION, pyRound, pySum, type Facts, type Request } from './metrics'

export const SCHEMA = 'diag-est-1'
export const HARNESS = 'claude-code'
export const MAX_MODELS = 40
export const BUCKETS = 14
export const ESTIMATE_ROUTE = '/diagnostic/estimate'
export const TOKEN_FIELDS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'] as const
const MIB = 1024 * 1024

type Obj = Record<string, any>
type Side = {
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  api_usd: number
  responses: number
}
export type Estimated = {
  files: number // files over the read limit that were scaled in
  bytes: number
  share: number // their share of all transcript bytes, 0-1
  skipped_files: number // files over the limit with no read file on their side to scale from
  skipped_bytes: number
}

const side = (): Side => ({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, api_usd: 0, responses: 0 })
const add = (into: Side, s: Side) => {
  for (const k of [...TOKEN_FIELDS, 'api_usd', 'responses'] as const) into[k] += s[k]
}

/** a * b // c for non-negative counts, exact for integers. */
const mulDiv = (a: number, b: number, c: number): number =>
  Number.isSafeInteger(a) && Number.isSafeInteger(b) && Number.isSafeInteger(c)
    ? Number((BigInt(a) * BigInt(b)) / BigInt(c))
    : Math.floor((a * b) / c)

const bitLength = (n: number): number => {
  let bits = 0
  while (n >= 1) {
    n = Math.floor(n / 2)
    bits++
  }
  return bits
}

function byModel(facts: Facts): { model: string; main: Side; subagents: Side }[] {
  let models = new Map<string, { main: Side; subagents: Side }>()
  for (const day of Object.keys(facts.by_day).sort()) {
    for (const [model, b] of Object.entries(facts.by_day[day].by_model)) {
      const r = b.responses
      const mr = b.main_responses
      let row = models.get(model)
      if (!row) {
        row = { main: side(), subagents: side() }
        models.set(model, row)
      }
      for (const k of TOKEN_FIELDS) {
        const part = r ? mulDiv(b[k], mr, r) : 0
        row.main[k] += part
        row.subagents[k] += b[k] - part
      }
      const usd = r ? (b.api_usd * mr) / r : 0
      row.main.api_usd += usd
      row.subagents.api_usd += b.api_usd - usd
      row.main.responses += mr
      row.subagents.responses += b.subagent_responses
    }
  }
  if (models.size > MAX_MODELS) {
    const total = (m: string) => models.get(m)!.main.api_usd + models.get(m)!.subagents.api_usd
    const ranked = [...models.keys()].sort((a, b) => total(b) - total(a) || (a < b ? -1 : a > b ? 1 : 0))
    const keep = ranked.slice(0, MAX_MODELS - 1).filter((m) => m !== 'other')
    const merged = { main: side(), subagents: side() }
    for (const [m, row] of models) {
      if (!keep.includes(m)) {
        add(merged.main, row.main)
        add(merged.subagents, row.subagents)
      }
    }
    const next = new Map<string, { main: Side; subagents: Side }>()
    for (const m of keep) next.set(m, models.get(m)!)
    next.set('other', merged)
    models = next
  }
  return [...models.keys()].sort().map((model) => {
    const row = models.get(model)!
    for (const s of [row.main, row.subagents]) s.api_usd = pyRound(s.api_usd, 6)
    return { model, main: row.main, subagents: row.subagents }
  })
}

function dispatches(facts: Facts): { type_word: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const data of Object.values(facts.by_day)) {
    for (const [word, n] of Object.entries(data.dispatches_by_type)) counts.set(word, (counts.get(word) ?? 0) + n)
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 1)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([type_word, count]) => ({ type_word, count }))
}

const bucket = (r: number): number => Math.min(BUCKETS - 1, bitLength(r) - 1)

function sessions(facts: Facts): { count: number; minutes_total: number; by_responses: number[] } {
  const hist = new Array(BUCKETS).fill(0)
  for (const row of facts.sessions.rows) if (row.responses >= 1) hist[bucket(row.responses)] += 1
  const minutes = pySum(facts.sessions.rows.map((r) => r.minutes))
  return { count: facts.sessions.count, minutes_total: pyRound(minutes, 1), by_responses: hist }
}

/** build_request(): the body for scan() facts, or null when there is no model response at all (NoData). */
export function buildRequest(facts: Facts, clientVersion: string = CLIENT_VERSION): Obj | null {
  if (facts.first_day === null) return null
  const c = facts.compactions
  return {
    schema: SCHEMA,
    client_version: clientVersion,
    harness: HARNESS,
    window: { first_day: facts.first_day, last_day: facts.last_day },
    by_model: byModel(facts),
    dispatches: dispatches(facts),
    compactions: { total: c.total, manual: c.manual, auto: c.auto },
    sessions: sessions(facts),
  }
}

/** Adds the files over the read limit to a built body by size (see the header); returns what was estimated. */
export function scaleUnread(body: Obj, facts: Facts): Estimated {
  const read = facts.read
  const est: Estimated = { files: 0, bytes: 0, share: 0, skipped_files: 0, skipped_bytes: 0 }
  let mainExtra = 0
  let subExtra = 0
  const bigMain: number[] = []
  for (const f of facts.unread) {
    const basis = f.subagent ? read.subagent_bytes : read.main_bytes
    if (basis <= 0) {
      est.skipped_files += 1
      est.skipped_bytes += f.size
      continue
    }
    est.files += 1
    est.bytes += f.size
    if (f.subagent) subExtra += f.size
    else {
      mainExtra += f.size
      bigMain.push(f.size)
    }
  }
  const all = read.bytes + est.bytes + est.skipped_bytes
  est.share = all > 0 ? pyRound(est.bytes / all, 4) : 0
  if (!est.files) return est
  const fMain = read.main_bytes > 0 ? (read.main_bytes + mainExtra) / read.main_bytes : 1
  const fSub = read.subagent_bytes > 0 ? (read.subagent_bytes + subExtra) / read.subagent_bytes : 1
  const fAll = read.bytes > 0 ? (read.bytes + mainExtra + subExtra) / read.bytes : 1
  for (const row of body.by_model) {
    for (const [s, f] of [
      [row.main, fMain],
      [row.subagents, fSub],
    ] as [Side, number][]) {
      for (const k of TOKEN_FIELDS) s[k] = Math.round(s[k] * f)
      s.responses = Math.round(s.responses * f)
      s.api_usd = pyRound(s.api_usd * f, 6)
    }
  }
  for (const d of body.dispatches) d.count = Math.max(1, Math.round(d.count * fAll))
  const c = body.compactions
  c.manual = Math.round(c.manual * fAll)
  c.auto = Math.round(c.auto * fAll)
  c.total = Math.max(Math.round(c.total * fAll), c.manual + c.auto)
  const s = body.sessions
  const rows = facts.sessions.rows
  const responses = rows.reduce((n, r) => n + r.responses, 0)
  const minutes = pySum(rows.map((r) => r.minutes))
  let extraMinutes = 0
  for (const size of bigMain) {
    s.count += 1
    const r = Math.round((size * responses) / read.main_bytes)
    if (r >= 1) s.by_responses[bucket(r)] += 1
    extraMinutes += (size * minutes) / read.main_bytes
  }
  s.minutes_total = pyRound(minutes + extraMinutes, 1)
  return est
}

/** The sentence the answer carries about the scaled files, or null when every file was read. */
export function estimateNote(est: Estimated): string | null {
  const parts: string[] = []
  if (est.files) {
    parts.push(
      `${est.files} transcript file${est.files === 1 ? '' : 's'} over 4 MiB (${(est.bytes / MIB).toFixed(1)} MiB, ` +
        `${(est.share * 100).toFixed(1)}% of all transcript bytes) ${est.files === 1 ? 'was' : 'were'} not read; ` +
        'their usage is estimated from their size',
    )
  }
  if (est.skipped_files) {
    parts.push(
      `${est.skipped_files} file${est.skipped_files === 1 ? '' : 's'} over 4 MiB (${(est.skipped_bytes / MIB).toFixed(1)} MiB) ` +
        'had no readable file to scale from and ' + (est.skipped_files === 1 ? 'is' : 'are') + ' left out',
    )
  }
  return parts.length ? parts.join('; ') + '.' : null
}

export type Prepared = { request: Request; body: Obj; estimated: Estimated; note: string | null }
export type EstimateError = { error: 'no_data' | 'invalid_body' }

/** The exact request one estimate send carries; the preview shows this same text. */
export function estimateRequest(facts: Facts, clientVersion: string = CLIENT_VERSION): Prepared | EstimateError {
  const body = buildRequest(facts, clientVersion)
  if (body === null) return { error: 'no_data' }
  const estimated = scaleUnread(body, facts)
  const text = JSON.stringify(body)
  if (new TextEncoder().encode(text).length > BODY_LIMIT) return { error: 'invalid_body' }
  return { request: { method: 'POST', route: ESTIMATE_ROUTE, body_text: text }, body, estimated, note: estimateNote(estimated) }
}

export type Send<A> = (request: Request) => Promise<A>
export type EstimateRun<A> =
  | EstimateError
  | (Prepared & { sent: false })
  | (Prepared & { sent: true; answer: A })

/**
 * host/diagnostic.py estimate(): without consent nothing is sent and the result is the preview; with consent the
 * same request is sent once. The metrics switch is not involved: the consent covers this one send only.
 */
export async function runEstimate<A>(facts: Facts, opts: { consent: boolean; send: Send<A>; clientVersion?: string }): Promise<EstimateRun<A>> {
  const prep = estimateRequest(facts, opts.clientVersion)
  if ('error' in prep) return prep
  if (opts.consent !== true) return { ...prep, sent: false }
  const answer = await opts.send(prep.request)
  return { ...prep, sent: true, answer }
}
