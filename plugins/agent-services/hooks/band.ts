// The band above the prompt: one short line of what agent-services did for this customer, in
// the board's and the status line's own facts and words, e.g.
//   "agent-services saved you $3.10 in the last 7 days | today: 5 jobs on a cheaper model | latest: ... at 2:05 pm"
//   (the parts joined by status.ts SEP, a middle dot, shown here as |)
//
// Decision (it replaced "hidden while signed out, paused or with nothing to show"): the band
// always shows something. wiring.ts bandState() says which state the session is in and hands the facts along;
// bandText() turns it into the line, in plain words for readers who are not technical, saying in full what the
// status line (status.ts statusText) says in short:
//   facts        the saved figure (the 7-day one, else the total the status line shows), today's counts, the latest
//   wait / off   signed in with no figure yet / the savings record turned off
//   signed_out, locked, paused, offline, unreachable, upgrade: one BAND_TEXT line each
//   starting     nothing written yet by this copy of the module (just loaded, or reloaded after an update)
//   setup        while signed in with setup questions open (command.ts setupDue: at most once per 7 days), one line
//                naming /agent-services setup takes the place of facts / wait / off (setupLine); the questions are
//                asked only when the user runs that command, never by the model
// Only a survey holding the band passes the event on.
//
// Nothing here computes a figure of its own: wiring.ts bandFacts() builds board_facts.ts timelineOf and weeklyOf
// over cached reads only (no request) after every status-line refresh, and bandFacts() below keeps the parts the
// line shows. bandSetter keeps the state in this module and asks the engine to draw the band again when it
// changed, so drawing reads one value and makes no request or file read.
//
// The module is .ts, not .tsx: register.ts is also run under node (type stripping, no JSX) by the test harnesses,
// so the one element is built with the surface's Text constructor, which is what JSX compiles to. Text is in every
// surface's element table, and both the terminal and the desktop app raise AbovePrompt.
//
//   bandFacts(timeline, weekly)   -> BandFacts | null   (the parts the line uses; null: nothing to show)
//   bandLine(facts, columns, tz?) -> string | null      (the longest form that fits the band's width)
//   bandText(state, columns, tz?) -> string             (the line for any state: never null)
//   setupLine(n)                  -> string             (the line while n setup choices are open)
//   bandSetup(n)                  -> void               (command.ts: how many are open now; redraws when changed)
//   paused(gate)                  -> boolean            (a closed gate with a known reason)
//   bandSetter($)                 -> (state) => void    (wiring.ts setBand: keeps it, redraws when changed)
//   installBand(on)               -> the ui.render hook on { component: 'AbovePrompt' }
import type { EngineInterface } from 'claude-code'
import { money, type Timeline } from './board_facts'
import { ORG_PAUSED_LINE } from './org'
import { panelLines, type Panel } from './panel'
import { COMMAND, NAME, SEP, shortDay, todayText } from './status'

type Obj = Record<string, any>
export type BandFacts = {
  saved_usd: number | null // board_facts weeklyOf this_week_usd, when at least a cent was saved
  days: number // the window of saved_usd (board_facts WEEK_DAYS)
  counts: Record<string, number> // board_facts timelineOf counts: today's, in the status line's terms
  latest: { text: string; at: string } | null // board_facts timelineOf items[0]: the newest thing done today
  total?: { usd: number; since: string | null } | null // the status line's figure, used when there is no 7-day one
}
export type BandKind = 'facts' | 'wait' | 'off' | 'signed_out' | 'locked' | 'paused' | 'offline' | 'unreachable' | 'upgrade' | 'starting'
export type BandState = { state: BandKind; facts?: BandFacts | null; setup?: number }

// The band's line for every state but 'facts'. The status line says the same in short (status.ts SIGN_IN_LINE,
// LOCKED_LINE, ORG_PAUSED_STATUS, GATE_STATUS, HINT_WAIT, HINT_OFF).
export const BAND_TEXT: Readonly<Record<string, string>> = {
  wait: `${NAME} is on. Your savings show here after your first full day of use.`,
  off: `${NAME} is on. To see how much it saves you, type ${COMMAND} sharing on.`,
  signed_out: `${NAME}: signed out. Type ${COMMAND} login to sign in. Command guarding and secret masking are off.`,
  locked: `${NAME}: this account is locked. Contact support, then type ${COMMAND} login.`,
  paused: ORG_PAUSED_LINE,
  offline: `${NAME}: offline mode is on, so nothing is sent. Type ${COMMAND} offline off to turn it off.`,
  unreachable: `${NAME} can't reach its server right now. It tries again at the next session.`,
  upgrade: `${NAME}: this version is no longer accepted. Update the plugin to keep using it.`,
  starting: `${NAME} is starting. Its status shows here after your next message.`,
}

// The state the band draws, as bandSetter last wrote it (null: nothing written yet, the 'starting' line). Not $.state: a value there must be declared in a types
// contract named by plugin.json; a hot reload empties this, and the next status-line refresh writes it again.
let shown: BandState | null = null
let setupOpen = 0 // the open setup choices command.ts last counted (bandSetup)
let redraw: (() => void) | null = null // the redraw of the latest bandSetter

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
  const t = isObj(facts.total) ? facts.total : null
  const all = t ? num(t.usd) : null
  const since = t ? shortDay(t.since) : null
  const head =
    usd !== null && usd >= 0.005
      ? `${NAME} saved you ${money(usd)} in the last ${days} days`
      : all !== null && all >= 0.005
        ? `${NAME} saved you ${money(all)} ${since ? `since ${since}` : 'so far'}` // the status line's figure and words
        : null
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

/** The band's line while `n` setup choices are open, e.g. "agent-services: 2 setup choices open - /agent-services setup". */
export function setupLine(n: number): string {
  return `${NAME}: ${n} setup choice${n === 1 ? '' : 's'} open - ${COMMAND} setup`
}

/** The band's line for a state (a BandState, or bare BandFacts as before); never null: the band always shows. */
export function bandText(state: unknown, columns?: unknown, timeZone?: string): string {
  const st: Obj | null = isObj(state) ? (typeof state.state === 'string' ? state : { state: 'facts', facts: state }) : null
  if (st === null) return BAND_TEXT.starting
  const n = num(st.setup)
  if (n !== null && n >= 1 && ['facts', 'wait', 'off'].includes(st.state)) return setupLine(Math.floor(n))
  if (st.state === 'facts') return bandLine(st.facts, columns, timeZone) ?? BAND_TEXT.wait
  return BAND_TEXT[st.state] ?? BAND_TEXT.starting
}


/** wiring.ts setBand: the band's state (bare facts are the 'facts' state), and a redraw when it changed. Never throws. */
export function bandSetter($: EngineInterface): (state: BandState | BandFacts | null) => void {
  redraw = () => $.ui.invalidate('ui.render') // bandSetup redraws through the latest setter
  return (state) => {
    const next: BandState | null = isObj(state)
      ? typeof state.state === 'string'
        ? (state as BandState)
        : { state: 'facts', facts: state as BandFacts }
      : null
    if (JSON.stringify(next) === JSON.stringify(shown)) return
    shown = next
    try {
      $.ui.invalidate('ui.render')
    } catch {
      // no redraw: the band shows the new facts at its next draw
    }
  }
}

/** command.ts: how many setup choices the band names now (0: none); a redraw when it changed. Never throws. */
export function bandSetup(n: unknown): void {
  const v = typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : 0
  if (v === setupOpen) return
  setupOpen = v
  try {
    redraw?.()
  } catch {
    // no redraw: the band shows the line at its next draw
  }
}

let panelShown: Panel | null = null // the usage panel setBandPanel last wrote (wiring.ts, after each band state)

/** wiring.ts: the usage panel (panel.ts panelOf) shown under the band's line; a redraw when it changed. Never throws. */
export function setBandPanel(panel: Panel | null): void {
  const next = isObj(panel) && Array.isArray(panel.columns) && panel.columns.length === 3 && typeof panel.method === 'string' ? panel : null
  if (JSON.stringify(next) === JSON.stringify(panelShown)) return
  panelShown = next
  try {
    redraw?.()
  } catch {
    // no redraw: the band shows it at its next draw
  }
}

/** The usage panel shown under the band's line, in the states that show figures; null otherwise. */
export function bandPanel(state: unknown): Panel | null {
  return isObj(state) && ['facts', 'wait', 'off'].includes(state.state) ? panelShown : null
}

/** The band: one dim line above the prompt from the state bandSetter wrote, on the terminal and the desktop app alike,
 *  then the usage panel in three columns (Token | Quota and context | Time saved) and its disclosure; the event goes
 *  on only while a survey holds the band. */
export function installBand(on: any): void {
  on('ui.render', { component: 'AbovePrompt' }, async ($: EngineInterface, e: Obj, next: (e: Obj) => unknown) => {
    if (e.props?.hasSurvey === true) return next(e)
    const line = bandText(shown && setupOpen ? { ...shown, setup: setupOpen } : shown, e.props?.bodyColumns)
    const { Text, Box } = $.ui.resolve(e as any) as any
    const panel = bandPanel(shown)
    if (!panel) return Text({ dimColor: true, children: line })
    // the band leaves out the disclosure (panel.method): the status command and the board still show it
    if (typeof Box !== 'function') return Text({ dimColor: true, children: [line, ...panelLines(panel).slice(0, -1)].join('\n') })
    const column = (c: Panel['columns'][number], i: number) =>
      Box({
        key: String(i), flexDirection: 'column', borderStyle: 'round', borderDimColor: true, paddingX: 1, flexShrink: 0,
        children: [Text({ key: 't', bold: true, children: c.title }), cells(c.rows, c.align)],
      })
    // one sub-column per cell position, so the figures line up in proportional fonts (the desktop app) as well:
    // labels flush left, figures flush right
    const cells = (rows: string[][], align?: string[]) => {
      const n = Math.max(...rows.map((r) => r.length))
      return Box({
        key: 'cells', flexDirection: 'row', columnGap: 2,
        children: Array.from({ length: n }, (_, k) => Box({
          key: String(k), flexDirection: 'column', alignItems: 'stretch', flexGrow: k === 0 ? 0 : 1, // the figures fill the box: the last one ends under the title's right edge
          // each cell in its own full-width row box: the desktop app lays a bare Text out full width, so alignItems
          // on the column alone does not move it
          children: rows.map((r, j) => Box({
            key: String(j), flexDirection: 'row',
            justifyContent: { left: 'flex-start', center: 'center', right: 'flex-end' }[align?.[k] ?? (k === 0 ? 'left' : 'right')] ?? 'flex-end',
            children: Text({ children: r[k] || ' ' }),
          })),
        })),
      })
    }
    return Box({
      flexDirection: 'column',
      children: [
        Text({ key: 'line', dimColor: true, children: line }),
        Box({ key: 'cols', flexDirection: 'row', columnGap: 1, flexWrap: 'nowrap', children: panel.columns.map(column) }),
      ],
    })
  }).catch(($: EngineInterface, e: Obj, next: (e: Obj) => unknown) => next(e))
}
