import type { EngineInterface } from 'claude-code'
import { addTrim, estimateTokens, localDay, openMeasured } from './counters'
import { riskyPattern, rulesTable, servedNumber } from './rules'
import { engineStore } from './store'

type Obj = Record<string, any>
type Table = { drop: string[]; keep: RegExp[] }
type Run = { seq: number; tokens: number; rows: number; on: boolean | undefined; lastAt: number }

export const TRIM_OFF_KEY = 'trim_off'

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

export function lineFor(type: string, text: string): string | null {
  if (type === 'invoked_skills') {
    const names = [...text.matchAll(/^### Skill: (.+)$/gm)].map((m) => (m[1] ?? '').trim()).filter(Boolean)
    return `Skills used earlier: ${names.length ? names.join(', ') : '(see the summary)'} \u2014 call Skill to reload when needed.`
  }
  if (type === 'file') return `File read earlier: ${filePath(text) ?? '(path not recorded)'} \u2014 read it again if needed.`
  if (type === 'deferred_tools_delta') return 'Tools are available on demand: search with ToolSearch to load one before calling it.'
  return null
}

export async function trimOn($: EngineInterface): Promise<boolean> {
  try {
    return (await $.store.get(TRIM_OFF_KEY)) !== true
  } catch {
    return true
  }
}

export function trimSession(): { runs: number; rows: number; tokens: number } {
  return { ...session }
}

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
    const store = engineStore($)
    if (await openMeasured(store, id, [localDay(now), localDay(now - 86_400_000)])) return
    await addTrim(store, id, model, done.tokens, now)
  } catch {
  }
}

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
      const check = (): void => {
        if (run?.seq !== id) return
        Promise.resolve($.clock.now()).then((now) => {
          if (run?.seq !== id) return
          if (now - run.lastAt > burst) closeRun($).catch(() => undefined)
          else $.clock.after(burst * 2, check)
        }).catch(() => undefined)
      }
      $.clock.after(burst * 2, check)
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
      const path = filePath(text)
      if (path === null || t.keep.some((rx) => rx.test(path))) return null
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

