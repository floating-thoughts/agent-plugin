// Row trimming after a compaction. The engine re-attaches, unchanged, the full text of every skill invoked earlier,
// the files read recently and the whole list of deferred tool names. Each arrives as an attachment row through
// session.append, after the compact_boundary row and before the next prompt. Rows of the types the served trim
// table drops are rewritten to one line each; the rewrite is what the transcript keeps and what every later request
// sends. Everything else (the summary, CLAUDE.md and memory, plan and task files, the skill listing, whatever the
// person types, subagent rows) passes untouched.
//
// The table (served, in memory only, rules.ts): {"drop": [attachment types], "keep_files": [regex sources, matched
// without case against the file path], "burst_ms": ms}. No table (signed out), no usable burst_ms, or the switch off (`/agent-services trim off`, per
// user, default on): every row passes. Nothing is sent anywhere: the day counters (counters.ts addTrim) keep only the
// token estimate removed and the number of runs per model, which the daily upload carries as savings.trim.
import type { EngineInterface } from 'claude-code'
import { addTrim, estimateTokens, localDay, readDay } from './counters'
import { riskyPattern, rulesTable, servedNumber } from './rules'
import { engineStore } from './store'

type Obj = Record<string, any>
type Table = { drop: string[]; keep: RegExp[] }
type Run = { seq: number; tokens: number; rows: number; on: boolean | undefined; lastAt: number }

export const TRIM_OFF_KEY = 'trim_off' // true = the user switched trimming off (store, shared by every session)
// The run ends at the next prompt (typed, queued or delivered), or once rows stop coming for this long: the turns a
// compaction keeps come back as response and tool-result rows inside the run, so those do not end it.
// The table's burst_ms sets it; there is no built-in value (no usable burst_ms: trimming is off).

/** How long a run waits for more rows: the table's burst_ms, or null when it is missing or out of bounds. */
export function burstMs(): number | null {
  return servedNumber('trim', 'burst_ms', 0, 100, 60_000) || null
}

let compiled: { src: unknown; table: Table | null } = { src: undefined, table: null }
let run: Run | null = null
let seq = 0
const session = { runs: 0, rows: 0, tokens: 0 }

function table(): Table | null {
  const src = rulesTable<Obj>('trim')
  if (src === compiled.src) return compiled.table
  let t: Table | null = null
  if (src && Array.isArray(src.drop) && Array.isArray(src.keep_files)) {
    const keep: RegExp[] = []
    for (const s of src.keep_files) {
      try {
        if (typeof s === 'string' && !riskyPattern(s)) keep.push(new RegExp(s, 'i'))
      } catch {
        // a bad pattern keeps nothing
      }
    }
    t = { drop: src.drop.filter((x: unknown): x is string => typeof x === 'string'), keep }
  }
  compiled = { src, table: t }
  return t
}

function filePath(text: string): string | null {
  const m = /"file_path"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(text)
  if (!m?.[1]) return null
  try {
    return JSON.parse(m[1]) as string
  } catch {
    return null
  }
}

/** The one line that stands in for a dropped row of `type`, or null for a type without one. Pure. */
export function lineFor(type: string, text: string): string | null {
  if (type === 'invoked_skills') {
    const names = [...text.matchAll(/^### Skill: (.+)$/gm)].map((m) => (m[1] ?? '').trim()).filter(Boolean)
    return `Skills used earlier: ${names.length ? names.join(', ') : '(see the summary)'} \u2014 call Skill to reload when needed.`
  }
  if (type === 'file') return `File read earlier: ${filePath(text) ?? '(path not recorded)'} \u2014 read it again if needed.`
  if (type === 'deferred_tools_delta') return 'Tools are available on demand: search with ToolSearch to load one before calling it.'
  return null
}

/** The switch the engine checks: on unless the user turned it off. */
export async function trimOn($: EngineInterface): Promise<boolean> {
  try {
    return (await $.store.get(TRIM_OFF_KEY)) !== true
  } catch {
    return true
  }
}

/** This session's figures: runs that cut something, rows rewritten, token estimate removed. */
export function trimSession(): { runs: number; rows: number; tokens: number } {
  return { ...session }
}

// The run is over: count what it cut, into this session's day record.
async function closeRun($: EngineInterface): Promise<void> {
  const done = run
  run = null
  if (!done || done.rows === 0 || done.tokens <= 0) return
  session.runs += 1
  session.rows += done.rows
  session.tokens += done.tokens
  try {
    const now = await $.clock.now()
    const id = String((await $.session.id().catch(() => '')) || 'session')
    const model = String((await $.session.model().catch(() => '')) || 'other')
    await addTrim(engineStore($), id, model, done.tokens, now)
  } catch {
    // the figure is lost; the rows were trimmed anyway
  }
}

/** session.append (main conversation rows only): the event with a dropped row rewritten to one line, or null when the
 * row passes unchanged. Never throws. */
export async function trimAppend($: EngineInterface, e: Obj): Promise<Obj | null> {
  try {
    const t = table()
    const burst = burstMs()
    if (!t || burst === null || !e || e.agentId) return null
    const m = e.message
    if (m?.type === 'system' && m.name === 'compact_boundary') {
      await closeRun($)
      const id = ++seq
      run = { seq: id, tokens: 0, rows: 0, on: undefined, lastAt: await $.clock.now() }
      // nothing else may follow before the session ends: count it anyway
      $.clock.after(burst * 2, () => {
        if (run?.seq === id) closeRun($).catch(() => undefined)
      })
      return null
    }
    if (run) {
      const now = await $.clock.now()
      if (['prompt', 'queue', 'delivery'].includes(e.door) || now - run.lastAt > burst) await closeRun($)
      else run.lastAt = now
    }
    if (!run || m?.type !== 'attachment' || typeof m.name !== 'string' || !t.drop.includes(m.name)) return null
    if (run.on === undefined) run.on = await trimOn($)
    if (!run.on) return null
    const content = m.content
    const text = typeof content === 'string' ? content
      : Array.isArray(content) ? content.map((b: Obj) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join('\n')
      : ''
    if (m.name === 'file') {
      const path = filePath(text) ?? ''
      if (t.keep.some((rx) => rx.test(path))) return null
    }
    const line = lineFor(m.name, text)
    if (line === null || line.length >= text.length) return null
    run.rows += 1
    run.tokens += Math.max(0, estimateTokens(text) - estimateTokens(line))
    return { ...e, message: { ...m, content: [{ type: 'text', text: line }] } }
  } catch {
    return null
  }
}

/** /agent-services trim [on|off]: switch trimming for this user and show what it saved. */
export async function trimCommand($: EngineInterface, args: string = ''): Promise<string> {
  const arg = String(args ?? '').trim().toLowerCase()
  if (arg && arg !== 'on' && arg !== 'off') {
    return 'Usage: /agent-services trim [on|off]. On (the default) rewrites what a compaction re-attaches (skills invoked earlier, files read earlier, the deferred tool list) to one line each; instruction, memory, plan and task files stay whole.'
  }
  if (arg) await $.store.set(TRIM_OFF_KEY, arg === 'off')
  const on = arg ? arg === 'on' : await trimOn($)
  const lines = [`Trimming after a compaction: ${on ? 'on' : 'off'}.`]
  if (!table()) lines.push('It works only while agent-services is signed in: the trim rules have not arrived in this session.')
  const s = trimSession()
  lines.push(`This session: ${s.rows} row${s.rows === 1 ? '' : 's'} rewritten over ${s.runs} compaction${s.runs === 1 ? '' : 's'}, about ${s.tokens} tokens less in every later request.`)
  try {
    const day = await readDay(engineStore($), localDay(await $.clock.now()))
    const tokens = (day.trim ?? []).reduce((n, r) => n + r.tokens, 0)
    const runs = (day.trim ?? []).reduce((n, r) => n + r.runs, 0)
    lines.push(`Today on this computer: about ${tokens} tokens over ${runs} compaction${runs === 1 ? '' : 's'}.`)
  } catch {
    // no day figure
  }
  return lines.join('\n')
}
