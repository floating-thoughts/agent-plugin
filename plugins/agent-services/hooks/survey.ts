// Survey quality counters (cleanup route R11): how well the startup-phase multiple-choice questions work.
//
// While agent-state.md is in planning (phase.ts), every AskUserQuestion call is one round. For each round the
// plugin counts the questions, the options offered, and for each question how it ended: one of the offered guesses
// (and whether it was the first, the likeliest one), the user's own words (Other), dismissed (the call was denied,
// failed or left the question unanswered), or unread (the answer could not be told apart). When the document
// switches to running (goal and plan written), the switch and the rounds it took are counted.
//
// Only counts are kept: never question text, option labels, answers, prompts, paths or session ids (the store is
// readable by other plugins). Like counters.ts, each session keeps its own record per local day under
// SURVEY_PREFIX + '<day>:<key>' (key = sessionKey) and rewrites it whole; readers merge every record of a day.
// The keys do not start with counters.ts COUNTER_PREFIX, so the savings counters and the daily upload never see
// them. The POST /metrics/daily contract has no field for these counts (additionalProperties false), so they stay
// local until the contract gains one; surveyFromStore is the reader for the board and the band (R8, R9).
// Harness-neutral: nothing here touches `$`.
import { localDay, sessionKey } from './counters'
import type { KV } from './engine_types'

export const SURVEY_PREFIX = 'survey:'
export const SURVEY_TOOL = 'AskUserQuestion'
export const SURVEY_KEEP_DAYS = 90
// rounds: AskUserQuestion calls while planning; questions, options: asked and offered in them; first, guess, other,
// dismissed, unread: how each question ended (first is part of guess); goal_clear: switches to running after
// planning was seen; rounds_to_goal: the rounds before those switches (rounds_to_goal / goal_clear = rounds per goal)
export const SURVEY_FIELDS: readonly string[] = [
  'rounds', 'questions', 'options', 'first', 'guess', 'other', 'dismissed', 'unread', 'goal_clear', 'rounds_to_goal',
]

export type SurveyCounts = Record<string, number>
type Obj = Record<string, unknown>

const DAY_MS = 86400000
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0

export function emptySurvey(): SurveyCounts {
  const out: SurveyCounts = {}
  for (const f of SURVEY_FIELDS) out[f] = 0
  return out
}

/** Adds b into a (both SURVEY_FIELDS records); bad values in b count as 0. Returns a. */
export function addSurvey(a: SurveyCounts, b: unknown): SurveyCounts {
  if (!isObj(b)) return a
  for (const f of SURVEY_FIELDS) if (isCount(b[f])) a[f] = (a[f] ?? 0) + b[f]
  return a
}

type Question = { text: string; labels: string[]; multi: boolean }

function questionsOf(input: unknown): Question[] {
  if (!isObj(input) || !Array.isArray(input.questions)) return []
  const out: Question[] = []
  for (const q of input.questions) {
    if (!isObj(q)) continue
    const labels = Array.isArray(q.options)
      ? q.options.map((o) => (isObj(o) && typeof o.label === 'string' ? o.label : typeof o === 'string' ? o : '')).filter((l) => l !== '')
      : []
    out.push({ text: typeof q.question === 'string' ? q.question : '', labels, multi: q.multiSelect === true })
  }
  return out
}

const unquote = (s: string): string => s.replace(/\\(.)/g, '$1')

// The answers map of a finished call: the structured result ({questions, answers}), its JSON text, or the result
// text Claude Code writes ('... "question"="answer", "question"="answer" ...'). null: none found.
function answersOf(done: Obj): Obj | null {
  for (const v of [done.result, done.output, done.text, done.content]) {
    if (isObj(v) && isObj(v.answers)) return v.answers
    if (typeof v !== 'string' || !v) continue
    try {
      const j = JSON.parse(v)
      if (isObj(j) && isObj(j.answers)) return j.answers
    } catch {
      // not JSON: the result text
    }
    const pairs: Obj = {}
    let n = 0
    for (const m of v.matchAll(/"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/g)) {
      pairs[unquote(m[1]!)] = unquote(m[2]!)
      n++
    }
    if (n) return pairs
  }
  return null
}

const doneText = (done: Obj): string =>
  [done.result, done.output, done.text, done.content, done.deny].filter((v) => typeof v === 'string').join('\n')

/**
 * One AskUserQuestion call's counts (every SURVEY_FIELDS key; rounds 1), from its input and the finished call as the
 * engine returns it ({deny?, isError?, result?, text?}); null when the input has no question. Pure; never throws.
 */
export function roundCounts(input: unknown, done: unknown): SurveyCounts | null {
  try {
    const qs = questionsOf(input)
    if (!qs.length) return null
    const c = emptySurvey()
    c.rounds = 1
    c.questions = qs.length
    c.options = qs.reduce((n, q) => n + q.labels.length, 0)
    const d = isObj(done) ? done : null
    if (!d || d.deny !== undefined || d.isError === true) {
      c.dismissed = qs.length
      return c
    }
    const answers = answersOf(d)
    if (!answers) {
      if (/doesn.t want to proceed|rejected|declined|dismissed|cancel/i.test(doneText(d))) c.dismissed = qs.length
      else c.unread = qs.length
      return c
    }
    const values = Object.values(answers)
    qs.forEach((q, i) => {
      // keyed by question text; positional when the keys are something else and the counts agree
      let a = q.text && q.text in answers ? answers[q.text] : values.length === qs.length ? values[i] : undefined
      if (Array.isArray(a)) a = a.join(', ')
      if (typeof a !== 'string' || !a.trim()) {
        c.dismissed++
        return
      }
      const picks = q.labels.includes(a) ? [a] : q.multi ? a.split(',').map((p) => p.trim()).filter((p) => p !== '') : [a]
      if (picks.length && picks.every((p) => q.labels.includes(p))) {
        c.guess++
        if (picks.includes(q.labels[0]!)) c.first++
      } else c.other++
    })
    return c
  } catch {
    return null
  }
}

export type SurveyOptions = { store: KV; session: string; now?: () => number; dayOf?: (ms: number) => string }

/** One session's survey counters: rounds while planning and the switches to running. Never throws. */
export class Survey {
  private readonly store: KV
  private readonly key: string
  private readonly now: () => number
  private readonly dayOf: (ms: number) => string
  private day = ''
  private rec: SurveyCounts | null = null
  private planning: boolean | null = null // the last phase seen; null before the first look
  private since = 0 // rounds since planning was last seen starting
  private swept = false

  constructor(o: SurveyOptions) {
    this.store = o.store
    this.key = sessionKey(o.session)
    this.now = o.now ?? (() => Date.now())
    this.dayOf = o.dayOf ?? localDay
  }

  private async load(): Promise<SurveyCounts> {
    const day = this.dayOf(this.now())
    if (this.rec && day === this.day) return this.rec
    this.day = day
    let have: unknown = null
    try {
      have = await this.store.get(`${SURVEY_PREFIX}${day}:${this.key}`) // a resumed session goes on with its record
    } catch {}
    this.rec = addSurvey(emptySurvey(), have)
    if (!this.swept) {
      this.swept = true
      void surveySweep(this.store, this.now(), this.dayOf).catch(() => undefined)
    }
    return this.rec
  }

  private async save(): Promise<void> {
    try {
      await this.store.set(`${SURVEY_PREFIX}${this.day}:${this.key}`, { v: 1, day: this.day, ...this.rec })
    } catch {}
  }

  /** The phase as just read from agent-state.md (running = phase.ts isRunning). A switch from planning counts. */
  async phase(running: boolean): Promise<void> {
    try {
      const was = this.planning
      this.planning = !running
      if (!running) {
        if (was !== true) this.since = 0
        return
      }
      if (was !== true) return
      const rec = await this.load()
      rec.goal_clear += 1
      rec.rounds_to_goal += this.since
      this.since = 0
      await this.save()
    } catch {}
  }

  /** One round while planning (roundCounts). */
  async round(c: SurveyCounts): Promise<void> {
    try {
      this.planning = true
      this.since += 1
      addSurvey(await this.load(), c)
      await this.save()
    } catch {}
  }
}

/** Local day -> the merged counts of every session's record that day; null when there is none. For R8/R9. */
export async function surveyFromStore(store: KV): Promise<Record<string, SurveyCounts> | null> {
  let keys: string[] = []
  try {
    keys = await store.keys()
  } catch {
    return null
  }
  const out: Record<string, SurveyCounts> = {}
  for (const k of keys.filter((k) => k.startsWith(SURVEY_PREFIX)).sort()) {
    const day = k.slice(SURVEY_PREFIX.length, SURVEY_PREFIX.length + 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
    let rec: unknown = null
    try {
      rec = await store.get(k)
    } catch {}
    addSurvey((out[day] ??= emptySurvey()), rec)
  }
  return Object.keys(out).length ? out : null
}

/** The shares a board shows from summed counts; null where the base is 0. */
export function surveyRates(c: SurveyCounts): Record<string, number | null> {
  const answered = (c.guess ?? 0) + (c.other ?? 0)
  const asked = c.questions ?? 0
  const div = (a: number, b: number): number | null => (b > 0 ? a / b : null)
  return {
    rounds_per_goal: div(c.rounds_to_goal ?? 0, c.goal_clear ?? 0),
    guess_share: div(c.guess ?? 0, answered),
    first_share: div(c.first ?? 0, answered),
    other_share: div(c.other ?? 0, answered),
    dismissed_share: div(c.dismissed ?? 0, asked),
  }
}

/** Deletes survey records older than SURVEY_KEEP_DAYS local days; returns how many. Never throws. */
export async function surveySweep(store: KV, nowMs: number, dayOf: (ms: number) => string = localDay): Promise<number> {
  const oldest = dayOf(nowMs - SURVEY_KEEP_DAYS * DAY_MS)
  let n = 0
  try {
    for (const k of await store.keys()) {
      if (!k.startsWith(SURVEY_PREFIX)) continue
      const day = k.slice(SURVEY_PREFIX.length, SURVEY_PREFIX.length + 10)
      if (day < oldest) {
        await store.delete(k)
        n++
      }
    }
  } catch {}
  return n
}
