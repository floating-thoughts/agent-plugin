import type { EngineInterface } from 'claude-code'
import { redact } from './redact'
import { relNum, relText } from './reliability'
import { routingLevel } from './routing_level'
import { onRulesClear, servedRegex } from './rules'
import { engineStore } from './store'

type Obj = Record<string, any>
type Ready = Promise<unknown> | undefined

export type HintDoc = { source: 'lessons' | 'toolbox'; key: string; text: string; hint: string; grade?: number }
export type HintPick = { doc: HintDoc; score: number; shared: number }

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

const STOP_WORDS = new Set(('the and for not with this that from are was were has have had but its into then than when what ' +
  'you your use used can cannot could should would will did does done all any one two out off see also only just ' +
  'error errors failed fail failure file files line lines command exit code status true false null none undefined ' +
  'next time symptom root cause users home appdata local temp program tmp var usr bin lib src').split(' '))

export function hintWords(text: unknown): string[] {
  if (typeof text !== 'string') return []
  return (text.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? []).filter((w) => !STOP_WORDS.has(w) && w.length <= 40)
}

export function firstSentence(text: string, max: number, advice: RegExp | null = null): string {
  const flat = text.replace(/^\s*(?:[-*+]|#{1,6}|\d+[.)])\s+/gm, '').replace(/\s+/g, ' ').trim()
  const all = flat.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean)
  const s = (advice ? all.find((x) => advice.test(x)) : undefined) ?? all.find((x) => x.split(' ').length >= 4) ?? all[0] ?? ''
  return s.length > max ? `${s.slice(0, Math.max(0, max - 3)).trimEnd()}...` : s
}

export function lessonDocs(text: unknown, max: number, advice: RegExp | null = null): HintDoc[] {
  if (typeof text !== 'string') return []
  return text.split(/\r?\n\s*\r?\n/).map((p) => p.trim()).filter((p) => p && !/^#{1,6}\s[^\n]*$/.test(p) && hintWords(p).length)
    .map((p, i) => ({ source: 'lessons' as const, key: `p${i + 1}`, text: p, hint: firstSentence(p.replace(/^\[E\d\]\s*/, ''), max, advice), grade: Number(/^\[E(\d)\]/.exec(p)?.[1] ?? 0) }))
}

export function toolboxDocs(answer: unknown, max: number): HintDoc[] {
  if (!isObj(answer) || answer.fallback !== null || answer.kind !== 'index' || !isObj(answer.entries)) return []
  return Object.entries(answer.entries).filter(([, v]) => typeof v === 'string' && v.trim())
    .map(([k, v]) => ({ source: 'toolbox' as const, key: k, text: `${k.replace(/-/g, ' ')} ${v}`, hint: String(v).replace(/\s+/g, ' ').trim().slice(0, max) }))
}

export function bestHint(error: string, docs: readonly HintDoc[], minScore: number, minShared: number): HintPick | null {
  const query = [...new Set(hintWords(error))]
  if (!query.length || !docs.length) return null
  const bags = docs.map((d) => {
    const m = new Map<string, number>()
    for (const w of hintWords(d.text)) m.set(w, (m.get(w) ?? 0) + 1)
    let n = 0
    for (const c of m.values()) n += c
    return { m, n }
  })
  const avg = bags.reduce((s, b) => s + b.n, 0) / bags.length || 1
  const df = new Map<string, number>()
  for (const w of query) df.set(w, bags.filter((b) => b.m.has(w)).length)
  let best: HintPick | null = null
  bags.forEach((b, i) => {
    let score = 0
    let shared = 0
    for (const w of query) {
      const tf = b.m.get(w) ?? 0
      if (!tf) continue
      shared += 1
      const d = df.get(w) ?? 0
      const idf = Math.log(1 + (docs.length - d + 0.5) / (d + 0.5))
      score += idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * b.n / avg))
    }
    const rank = (p: HintPick) => p.score * (1 + 0.1 * (p.doc.grade ?? 0))
    const pick = { doc: docs[i]!, score, shared }
    if (shared >= minShared && score >= minScore && (!best || rank(pick) > rank(best))) best = pick
  })
  return best
}

export function resultText(result: unknown): string {
  let s = ''
  if (typeof result === 'string') s = result
  else if (Array.isArray(result)) s = result.map((p) => (isObj(p) && typeof p.text === 'string' ? p.text : typeof p === 'string' ? p : '')).join('\n')
  else if (isObj(result) && typeof result.text === 'string') s = result.text
  return s.length > 4000 ? `${s.slice(0, 2000)}\n${s.slice(-2000)}` : s
}


let index: unknown = null
let errorsSeen = new Set<string>()
let hintsGiven = new Set<string>()

onRulesClear(() => failureHintReset())

export function failureHintIndex(answer: unknown): void {
  index = answer
}

export function failureHintReset(): void {
  index = null
  errorsSeen = new Set()
  hintsGiven = new Set()
}

export function hintFor(error: string, lessons: string | null): string | null {
  const max = relNum('failure_hint.MAX_CHARS')
  const minScore = relNum('failure_hint.MIN_SCORE')
  const minShared = relNum('failure_hint.MIN_SHARED')
  const cap = relNum('failure_hint.MAX_PER_SESSION')
  if (max === undefined || minScore === undefined || minShared === undefined || cap === undefined) return null
  if (hintsGiven.size >= cap) return null
  const masked = redact(error)
  const key = [...new Set(hintWords(masked))].sort().join(' ').slice(0, 300)
  if (!key || errorsSeen.has(key)) return null
  if (errorsSeen.size >= 500) errorsSeen = new Set()
  errorsSeen.add(key)
  const docs = [...lessonDocs(lessons, max, servedRegex('reliability_b', 'failure_hint.ADVICE_RX')), ...toolboxDocs(index, max)].filter((d) => !hintsGiven.has(`${d.source}:${d.text}`))
  const pick = bestHint(masked, docs, minScore, minShared)
  if (!pick) return null
  const source = pick.doc.source === 'lessons' ? relText('failure_hint.text.source_lessons') : relText('failure_hint.text.source_toolbox', { key: pick.doc.key })
  const line = source === undefined ? undefined : relText('failure_hint.text.hint', { source, text: redact(pick.doc.hint) })
  if (line === undefined) return null
  hintsGiven.add(`${pick.doc.source}:${pick.doc.text}`)
  return line.length > max ? `${line.slice(0, max - 3)}...` : line
}

export async function failureHint($: EngineInterface, e: Obj, done: Obj, rt?: Ready): Promise<Obj> {
  try {
    if (!isObj(e) || !isObj(done) || done.deny !== undefined || done.isError !== true) return done
    if (relNum(`failure_hint.TOOLS.${String(e.tool ?? '')}`) !== 1) return done
    const error = resultText(done.result)
    const refused = servedRegex('reliability_b', 'failure_hint.REFUSED_RX')
    if (!error.trim() || !refused || refused.test(error.slice(0, 4000))) return done
    if (rt !== undefined && !(await rt)) return done
    if ((await routingLevel(engineStore($))) === 'off') return done
    let lessons: string | null = null
    try {
      const cwd = String(await $.session.cwd()).replace(/[\\/]+$/, '')
      const limit = relNum('failure_hint.LESSONS_MAX_CHARS') ?? 0
      lessons = String(await $.fs.read(`${cwd}/.agent/lessons.md`)).slice(0, limit)
    } catch {}
    const line = hintFor(error, lessons)
    if (!line) return done
    return { ...done, context: [...(Array.isArray(done.context) ? done.context : []), line] }
  } catch {
    return done
  }
}
