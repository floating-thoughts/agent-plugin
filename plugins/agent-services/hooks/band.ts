import type { EngineInterface } from 'claude-code'
import { minUsd, type Timeline } from './board_facts'
import { money } from './pyfmt'
import { EXPLAIN, EXPLAIN_KEY, EXPLAIN_POLL_MS, explainKeyOf, explainOn } from './explain'
import { ORG_PAUSED_LINE } from './org'
import { panelLines, type Panel } from './panel'
import { COMMAND, NAME, SEP, shortDay, todayText } from './status'
import { jobsBandText } from './jobs'

type Obj = Record<string, any>
export type BandFacts = {
  saved_usd: number | null
  days: number
  counts: Record<string, number>
  latest: { text: string; at: string } | null
  total?: { usd: number; since: string | null } | null
  estimate?: number | null
}
export type BandKind = 'facts' | 'wait' | 'off' | 'signed_out' | 'locked' | 'paused' | 'offline' | 'unreachable' | 'upgrade' | 'starting'
export type BandState = { state: BandKind; facts?: BandFacts | null; setup?: number; paused?: string | null }

export const BAND_TEXT: Readonly<Record<string, string>> = {
  wait: `${NAME} is on. Its estimated savings show here once your subagents run.`,
  off: `${NAME} is on. Its estimated savings show here once your subagents run. To keep a record of them, type ${COMMAND} sharing on.`,
  signed_out: `${NAME}: signed out. Type ${COMMAND} login to sign in. Command guarding and secret masking are off.`,
  locked: `${NAME}: this account is locked. Ask your company admin or the company that gave you access, then type ${COMMAND} login.`,
  paused: ORG_PAUSED_LINE,
  offline: `${NAME}: offline mode is on, so nothing is sent.`,
  unreachable: `${NAME} can't reach its server right now. It tries again in a few minutes.`,
  upgrade: `${NAME}: this version is no longer accepted. Type ${COMMAND} update to keep using it.`,
  starting: `${NAME} is starting. Its status shows here after your next message.`,
}

let shown: BandState | null = null
let setupOpen = 0
let redraw: (() => void) | null = null

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function bandFacts(timeline: Timeline | null | undefined, weekly: Obj | null | undefined): BandFacts | null {
  const usd = isObj(weekly) ? num(weekly.this_week_usd) : null
  const saved = usd !== null && usd >= minUsd() ? usd : null
  const counts: Record<string, number> = {}
  if (isObj(timeline) && isObj(timeline.counts)) {
    for (const [k, v] of Object.entries(timeline.counts)) if ((num(v) ?? 0) > 0) counts[k] = v as number
  }
  const first = isObj(timeline) && Array.isArray(timeline.items) ? timeline.items[0] : null
  const latest = isObj(first) && typeof first.text === 'string' && first.text && typeof first.at === 'string' ? { text: first.text, at: first.at } : null
  if (saved === null && !Object.keys(counts).length && latest === null) return null
  return { saved_usd: saved, days: isObj(weekly) && num(weekly.days) ? weekly.days : 7, counts, latest }
}

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

export function bandLine(facts: unknown, columns?: unknown, timeZone?: string): string | null {
  if (!isObj(facts)) return null
  const usd = num(facts.saved_usd)
  const days = num(facts.days) ?? 7
  const t = isObj(facts.total) ? facts.total : null
  const all = t ? num(t.usd) : null
  const since = t ? shortDay(t.since) : null
  const est = num(facts.estimate)
  const head =
    usd !== null && usd >= minUsd()
      ? `${NAME} saved you ${money(usd)} in the last ${days} days`
      : all !== null && all >= minUsd()
        ? `${NAME} saved you ${money(all)} ${since ? `since ${since}` : 'so far'}`
        : est !== null && est >= minUsd()
          ? `${NAME} saved you about ${money(est)} today (est.)`
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
  return [...forms[forms.length - 1]].slice(0, width - 1).join('') + String.fromCharCode(0x2026)
}

export function paused(gate: unknown): boolean {
  if (!isObj(gate) || gate.open !== false) return false
  return typeof gate.reason === 'string' && gate.reason !== '' && gate.reason !== 'unknown'
}

export function setupLine(n: number): string {
  return `${NAME}: ${n} setup choice${n === 1 ? '' : 's'} open - ask Claude to finish setup`
}

export function bandText(state: unknown, columns?: unknown, timeZone?: string): string {
  const st: Obj | null = isObj(state) ? (typeof state.state === 'string' ? state : { state: 'facts', facts: state }) : null
  if (st === null) return BAND_TEXT.starting
  const n = num(st.setup)
  if (n !== null && n >= 1 && ['facts', 'wait', 'off'].includes(st.state)) return setupLine(Math.floor(n))
  if (st.state === 'facts') return bandLine(st.facts, columns, timeZone) ?? BAND_TEXT.wait
  if (st.state === 'paused' && typeof st.paused === 'string' && st.paused) return st.paused
  return BAND_TEXT[st.state] ?? BAND_TEXT.starting
}


export function bandSetter($: EngineInterface): (state: BandState | BandFacts | null) => void {
  redraw = () => $.ui.invalidate('ui.render')
  explainWatch($)
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
    }
  }
}

export function bandSetup(n: unknown): void {
  const v = typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : 0
  if (v === setupOpen) return
  setupOpen = v
  try {
    redraw?.()
  } catch {
  }
}

let panelShown: Panel | null = null
let pendingShown = 0

export function setBandPending(n: unknown): void {
  const v = typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  if (v === pendingShown) return
  pendingShown = v
  try {
    redraw?.()
  } catch {
  }
}

export const pendingLine = (n: number): string => `${n} action${n === 1 ? '' : 's'} waiting for you`

export function jobsShort(line: unknown): string | null {
  return typeof line === 'string' && line ? line : null
}

export const CONN_WORDS: Readonly<Record<string, string>> = {
  facts: 'online', wait: 'online', off: 'online', offline: 'offline', unreachable: 'offline',
  signed_out: 'signed out', locked: 'locked', paused: 'paused', upgrade: 'update needed', starting: 'starting',
}
export const connLine = (state: unknown): string => `${NAME}: ${state === true ? 'online' : (typeof state === 'string' && CONN_WORDS[state]) || 'starting'}`

export function connShort(state: unknown): string | null {
  const t = connLine(state)
  return t === `${NAME}: online` ? null : t
}

export function topParts(state: unknown): { key: string; text: string; bold?: true }[] {
  const jobs = jobsShort(jobsBandText())
  return [
    { key: 'pending', text: pendingShown > 0 ? pendingLine(pendingShown) : null },
    { key: 'jobs', text: jobs },
    { key: 'conn', text: connShort(state) },
  ].filter((p): p is { key: string; text: string; bold?: true } => typeof p.text === 'string' && p.text !== '')
}

export const EXPLAIN_TIP = 'use /agent-services explain on/off to toggle'

let explainShown: boolean | null = null
let explainReadAt = 0
let explainWanted = false
let explainWatching = false

async function readExplain($: EngineInterface): Promise<boolean | null> {
  try {
    return explainOn(await $.store.get(EXPLAIN_KEY))
  } catch {
    return null
  }
}

async function explainNow($: EngineInterface): Promise<boolean> {
  explainWanted = true
  if (explainShown === null || Date.now() - explainReadAt >= EXPLAIN_POLL_MS) {
    const v = await readExplain($)
    if (v !== null) {
      explainShown = v
      explainReadAt = Date.now()
    }
  }
  return explainShown ?? true
}

function explainWatch($: EngineInterface): void {
  if (explainWatching) return
  try {
    $.clock.every(EXPLAIN_POLL_MS, () => {
      if (!explainWanted || Date.now() - explainReadAt < EXPLAIN_POLL_MS - 50) return
      void readExplain($).then((v) => {
        if (v === null) return
        const before = explainShown ?? true
        explainShown = v
        explainReadAt = Date.now()
        if (v !== before) redraw?.()
      }).catch(() => undefined)
    })
    explainWatching = true
  } catch {
  }
}

export function setBandExplain(on: boolean | null): void {
  explainShown = on
  explainReadAt = on === null ? 0 : Date.now()
  try {
    redraw?.()
  } catch {
  }
}

export function panelWidth(panel: Panel): number {
  const box = (c: Panel['columns'][number]): number => {
    const n = Math.max(0, ...c.rows.map((r) => r.length))
    let cells = 2 * Math.max(0, n - 1)
    for (let k = 0; k < n; k++) cells += Math.max(1, ...c.rows.map((r) => (r[k] || ' ').length))
    return Math.max(c.title.length, cells) + 4
  }
  return panel.columns.reduce((a, c) => a + box(c), 0) + 2 * Math.max(0, panel.columns.length - 1)
}

export function setBandPanel(panel: Panel | null): void {
  const next = isObj(panel) && Array.isArray(panel.columns) && panel.columns.length >= 3 && typeof panel.method === 'string' ? panel : null
  if (JSON.stringify(next) === JSON.stringify(panelShown)) return
  panelShown = next
  try {
    redraw?.()
  } catch {
  }
}

export function bandPanel(state: unknown): Panel | null {
  return isObj(state) && ['facts', 'wait', 'off'].includes(state.state) ? panelShown : null
}

let hoverOk: boolean | null = null

async function hoverEngine($: EngineInterface): Promise<boolean> {
  if (hoverOk !== null) return hoverOk
  try {
    const v: Obj = (await $.session.version()) as Obj
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v?.base ?? v?.version ?? ''))
    const n = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
    hoverOk = !!n && (n[0] !== 2 ? n[0] > 2 : n[1] !== 1 ? n[1] > 1 : n[2] >= 317)
  } catch {
    hoverOk = false
  }
  return hoverOk
}

export function setHoverForTest(v: boolean | null): void {
  hoverOk = v
}

export function installBand(on: any): void {
  on('ui.render', { component: 'AbovePrompt' }, async ($: EngineInterface, e: Obj, next: (e: Obj) => unknown) => {
    if (e.props?.hasSurvey === true) return next(e)
    const line = bandText(shown && setupOpen ? { ...shown, setup: setupOpen } : shown, e.props?.bodyColumns)
    const { Text, Box } = $.ui.resolve(e as any) as any
    const panel = bandPanel(shown)
    const isOnline = isObj(shown) ? String(shown.state) : 'starting'
    let hover = false
    const card = (k: string | null, at: Obj): Obj[] =>
      hover && k && EXPLAIN[k]
        ? [Box({ position: 'absolute', ...at, display: 'none', hover: { display: 'flex' }, backgroundColor: 'inverseText', paddingX: 1, children: Text({ color: 'text', children: EXPLAIN[k] }) })]
        : []
    const below = { top: 1, left: 0, right: 0 }
    const topText = (online: unknown): string[] => {
      const t = topParts(online).map((p) => p.text).join(SEP)
      return t ? [t] : []
    }
    const topRow = (online: unknown, tip = false): Obj[] => {
      const parts = topParts(online)
      if (!parts.length && !tip) return []
      const texts = parts.map((p) => Text({ key: p.key, bold: p.key === 'pending' || p.bold === true, dimColor: p.key !== 'pending' && p.bold !== true, children: p.text }))
      return [Box({
        key: 'top', flexDirection: 'row', justifyContent: 'space-between',
        children: tip
          ? [Box({ key: 'news', flexDirection: 'row', columnGap: 2, children: texts }), Text({ key: 'tip', dimColor: true, children: EXPLAIN_TIP }), ...(parts.length ? card('band-top', below) : [])]
          : [...texts, ...card('band-top', below)],
      })]
    }
    if (!panel) {
      if (typeof Box !== 'function') return Text({ dimColor: true, children: [...topText(isOnline), line].join('\n') })
      return Box({ flexDirection: 'column', children: [...topRow(isOnline), Text({ key: 'line', dimColor: true, children: line })] })
    }
    const cols = e.props?.bodyColumns
    const narrow = e.surface !== 'desktop' && typeof cols === 'number' && Number.isFinite(cols) && cols > 0 && cols < panelWidth(panel)
    if (typeof Box !== 'function' || narrow) return Text({ dimColor: true, children: [...topText(true), ...(setupOpen ? [line] : []), ...panelLines(panel).slice(0, -1)].join('\n') })
    hover = e.surface === 'desktop' && (await hoverEngine($)) && (await explainNow($))
    const column = (c: Panel['columns'][number], i: number) =>
      Box({
        key: String(i), flexDirection: 'column', borderStyle: 'round', borderDimColor: true, paddingX: 1, flexShrink: 0,
        flexGrow: e.surface === 'desktop' ? 1 : 0,
        children: [Text({ key: 't', bold: true, children: c.title }), cells(c.rows, c.align), ...card(explainKeyOf(c.title), { top: 0, left: 0, right: 0, bottom: 0 })],
      })
    const cells = (rows: string[][], align?: string[]) => {
      const n = Math.max(...rows.map((r) => r.length))
      return Box({
        key: 'cells', flexDirection: 'row', columnGap: 2,
        children: Array.from({ length: n }, (_, k) => Box({
          key: String(k), flexDirection: 'column', alignItems: 'stretch', flexGrow: k === 0 ? 0 : 1,
          children: rows.map((r, j) => Box({
            key: String(j), flexDirection: 'row',
            justifyContent: { left: 'flex-start', center: 'center', right: 'flex-end' }[align?.[k] ?? (k === 0 ? 'left' : 'right')] ?? 'flex-end',
            children: Text({ children: r[k] || ' ' }),
          })),
        })),
      })
    }
    const setupText = Text({ key: 'line', dimColor: true, children: line })
    const setupRow = hover ? Box({ key: 'line', flexDirection: 'column', children: [setupText, ...card('band-setup', below)] }) : setupText
    return Box({
      flexDirection: 'column',
      children: [
        ...topRow(true, e.surface === 'desktop'),
        ...(setupOpen ? [setupRow] : []),
        Box({ key: 'cols', flexDirection: 'row', columnGap: 2, flexWrap: 'nowrap', children: panel.columns.map(column) }),
      ],
    })
  }).catch(($: EngineInterface, e: Obj, next: (e: Obj) => unknown) => next(e))
}
