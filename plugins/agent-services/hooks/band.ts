// The band above the prompt (cleanup route R9): one short line of what agent-services did for this customer, in
// the board's and the status line's own facts and words, e.g.
//   "agent-services saved you $3.10 in the last 7 days | today: 5 jobs on a cheaper model | latest: ... at 2:05 pm"
//   (the parts joined by status.ts SEP, a middle dot, shown here as |)
//
// Nothing here computes a figure of its own: wiring.ts bandFacts() builds board_facts.ts timelineOf and weeklyOf
// over cached reads only (no request) after every status-line refresh, and bandFacts() below keeps the parts the
// line shows. bandSetter keeps them in this module and asks the engine to draw the band again when they changed,
// so drawing reads one value and makes no request or file read. Nothing is drawn (the hook passes the event on) while signed out,
// while the plugin is paused (the gate closed: sign-in, an org pause, offline, the server), while a survey holds
// the band, or when there is nothing to show yet.
//
// The module is .ts, not .tsx: register.ts is also run under node (type stripping, no JSX) by the test harnesses,
// so the one element is built with the surface's Text constructor, which is what JSX compiles to.
//
//   bandFacts(timeline, weekly)   -> BandFacts | null   (the parts the line uses; null: nothing to show)
//   bandLine(facts, columns, tz?) -> string | null      (the longest form that fits the band's width)
//   paused(gate)                  -> boolean            (a closed gate with a known reason)
//   bandSetter($)                 -> (facts) => void    (wiring.ts setBand: keeps them, redraws when changed)
//   installBand(on)               -> the ui.render hook on { component: 'AbovePrompt' }
import type { EngineInterface } from 'claude-code'
import { money, type Timeline } from './board_facts'
import { NAME, SEP, todayText } from './status'

type Obj = Record<string, any>
export type BandFacts = {
  saved_usd: number | null // board_facts weeklyOf this_week_usd, when at least a cent was saved
  days: number // the window of saved_usd (board_facts WEEK_DAYS)
  counts: Record<string, number> // board_facts timelineOf counts: today's, in the status line's terms
  latest: { text: string; at: string } | null // board_facts timelineOf items[0]: the newest thing done today
}

// The facts the band draws, as bandSetter last wrote them. Not $.state: a value there must be declared in a types
// contract named by plugin.json; a hot reload empties this, and the next status-line refresh writes it again.
let shown: BandFacts | null = null

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** The parts of the board's timeline and weekly facts the band shows; null when none of them has anything. */
export function bandFacts(timeline: Timeline | null | undefined, weekly: Obj | null | undefined): BandFacts | null {
  const usd = isObj(weekly) ? num(weekly.this_week_usd) : null
  const saved = usd !== null && usd >= 0.005 ? usd : null
  const counts: Record<string, number> = {}
  if (isObj(timeline) && isObj(timeline.counts)) {
    for (const [k, v] of Object.entries(timeline.counts)) if ((num(v) ?? 0) > 0) counts[k] = v as number
  }
  const first = isObj(timeline) && Array.isArray(timeline.items) ? timeline.items[0] : null
  const latest = isObj(first) && typeof first.text === 'string' && first.text && typeof first.at === 'string' ? { text: first.text, at: first.at } : null
  if (saved === null && !Object.keys(counts).length && latest === null) return null
  return { saved_usd: saved, days: isObj(weekly) && num(weekly.days) ? weekly.days : 7, counts, latest }
}

/** "2:05 pm" in the local time zone (or the one named), or null for a bad time. */
export function clockText(iso: string, timeZone?: string): string | null {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  try {
    const t = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone }).format(ms)
    return t.replace(/\s+/g, ' ').replace(/ ?AM$/i, ' am').replace(/ ?PM$/i, ' pm')
  } catch {
    return null
  }
}

/**
 * The band's one line: the saved figure, today's counts and the newest item, dropping parts from the end until it
 * fits `columns` (the band's bodyColumns); the last form is cut with an ellipsis. Null when there is nothing.
 */
export function bandLine(facts: unknown, columns?: unknown, timeZone?: string): string | null {
  if (!isObj(facts)) return null
  const usd = num(facts.saved_usd)
  const days = num(facts.days) ?? 7
  const head = usd !== null && usd >= 0.005 ? `${NAME} saved you ${money(usd)} in the last ${days} days` : null
  const today = isObj(facts.counts) ? todayText(facts.counts as Record<string, number>) : null
  const l = isObj(facts.latest) && typeof facts.latest.text === 'string' && facts.latest.text ? facts.latest : null
  const at = l && typeof l.at === 'string' ? clockText(l.at, timeZone) : null
  const latest = l ? `latest: ${l.text}${at ? ` at ${at}` : ''}` : null
  const name = head ?? NAME
  const forms = [
    [name, today, latest],
    [name, today],
    [name, latest],
    head ? [head] : [],
  ]
    .map((parts) => parts.filter((p): p is string => !!p))
    .filter((parts) => parts.length > (head ? 0 : 1))
    .map((parts) => parts.join(SEP))
  if (!forms.length) return null
  const width = num(columns) !== null && (columns as number) >= 10 ? Math.floor(columns as number) : 110
  for (const text of forms) if ([...text].length <= width) return text
  return [...forms[forms.length - 1]].slice(0, width - 1).join('') + String.fromCharCode(0x2026) // an ellipsis
}

/** True when the plugin is paused: the gate closed for a known reason (not the 'unknown' before the first hello). */
export function paused(gate: unknown): boolean {
  if (!isObj(gate) || gate.open !== false) return false
  return typeof gate.reason === 'string' && gate.reason !== '' && gate.reason !== 'unknown'
}

/** The facts the band draws now (tests). */
export const bandShown = (): BandFacts | null => shown

/** wiring.ts setBand: the band's facts, and a redraw of the band when they changed. Never throws. */
export function bandSetter($: EngineInterface): (facts: BandFacts | null) => void {
  return (facts) => {
    const next = isObj(facts) ? facts : null
    if (JSON.stringify(next) === JSON.stringify(shown)) return
    shown = next
    try {
      $.ui.invalidate('ui.render')
    } catch {
      // no redraw: the band shows the new facts at its next draw
    }
  }
}

/** The band: one dim line above the prompt from the facts bandSetter wrote; the event goes on when there are none. */
export function installBand(on: any): void {
  on('ui.render', { component: 'AbovePrompt' }, async ($: EngineInterface, e: Obj, next: (e: Obj) => unknown) => {
    if (e.props?.hasSurvey === true) return next(e)
    const line = bandLine(shown, e.props?.bodyColumns)
    if (line === null) return next(e)
    const { Text } = $.ui.resolve(e as any) as any
    return Text({ dimColor: true, children: line })
  }).catch(($: EngineInterface, e: Obj, next: (e: Obj) => unknown) => next(e))
}
