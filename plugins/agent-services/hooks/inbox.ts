import type { EngineInterface } from 'claude-code'
import { ago, jobOpen, jobsLive, jobText, listJobs, statusWord, type Job } from './jobs'
import { reachPerson } from './reach'
import { NOTE_PREFIX } from './review'
import { COMMAND } from './status'
import type { OpCtx, OpResult, TaskState } from './task_state'
import { loadTaskState } from './task_state_io'
import { relNum, relText } from './reliability'

export const ASK_OPTIONS_MAX = 6
export const ASK_OPTION_MAX = 80
export const ASK_TEXT_MAX = 500
export const ASK_WHY_MAX = 200
export const ASK_OPEN_MAX = 100

const N = (k: string): number | undefined => relNum(`inbox.${k}`)

type Obj = Record<string, any>
type Ready = Promise<unknown> | undefined

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const oneLine = (v: unknown): string => String(v ?? '').replace(/[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim()
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const timeOf = (v: unknown): number | null => {
  if (num(v) !== null) return v as number
  if (typeof v === 'string' && v) {
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : t
  }
  return null
}


export type AskFields = { options?: string[]; prefer?: string | null; why?: string | null; needs_user?: boolean }
export type Ask = { id: string | null; text: string; options: string[]; prefer: string | null; why: string | null; needs_user: boolean }

export function askFieldsOf(q: unknown): AskFields {
  const out: AskFields = {}
  if (!isObj(q)) return out
  try {
    if (Array.isArray(q.options)) {
      const seen = new Set<string>()
      const opts: string[] = []
      for (const o of q.options) {
        const t = oneLine(o).slice(0, ASK_OPTION_MAX)
        if (!t || seen.has(t.toLowerCase())) continue
        seen.add(t.toLowerCase())
        opts.push(t)
      }
      if (opts.length >= 2) out.options = opts.slice(0, ASK_OPTIONS_MAX)
    }
    if (typeof q.prefer === 'string' && oneLine(q.prefer)) out.prefer = oneLine(q.prefer).slice(0, ASK_OPTION_MAX)
    else if (q.prefer === null) out.prefer = null
    if (typeof q.why === 'string' && oneLine(q.why)) out.why = oneLine(q.why).slice(0, ASK_WHY_MAX)
    else if (q.why === null) out.why = null
    if (typeof q.needs_user === 'boolean') out.needs_user = q.needs_user
  } catch {}
  return out
}

export function optionOf(options: readonly string[], choice: unknown): string | null {
  const c = oneLine(choice)
  if (!c || !options.length) return null
  if (/^\d{1,2}$/.test(c)) {
    const i = Number(c) - 1
    return i >= 0 && i < options.length ? options[i]! : null
  }
  return options.find((o) => o.toLowerCase() === c.toLowerCase()) ?? null
}

export function validateAsk(input: unknown, mask: (s: string) => string = (s) => s): { ok: true; ask: Ask } | { ok: false; reason: string } {
  const i: Obj = isObj(input) ? input : {}
  const no = (reason: string) => ({ ok: false as const, reason })
  const m = (v: unknown): string => {
    try {
      return oneLine(mask(oneLine(v)))
    } catch {
      return '(withheld)'
    }
  }
  try {
    let id: string | null = null
    if (i.id !== undefined && i.id !== null && i.id !== '') {
      id = String(i.id)
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/.test(id)) return no('the question id may hold only letters, digits, dot, dash or underscore (at most 40), e.g. q7; leave it out for the next free one.')
    }
    if (typeof i.text !== 'string' || !oneLine(i.text)) return no('ask needs the question as `text` (one line).')
    const text = m(i.text)
    if ([...text].length > ASK_TEXT_MAX) return no(`the question is longer than ${ASK_TEXT_MAX} characters; shorten it.`)
    let options: string[] = []
    if (i.options !== undefined && i.options !== null) {
      if (!Array.isArray(i.options)) return no('options must be a list of short texts.')
      if (i.options.length === 1 || i.options.length > ASK_OPTIONS_MAX) return no(`give 2 to ${ASK_OPTIONS_MAX} options, or none.`)
      const seen = new Set<string>()
      for (const o of i.options) {
        if (typeof o !== 'string' || !oneLine(o)) return no('every option must be a non-empty text.')
        const t = m(o)
        if ([...t].length > ASK_OPTION_MAX) return no(`every option must be at most ${ASK_OPTION_MAX} characters.`)
        if (seen.has(t.toLowerCase())) return no('the options must differ from each other.')
        seen.add(t.toLowerCase())
        options.push(t)
      }
    }
    let prefer: string | null = null
    if (i.prefer !== undefined && i.prefer !== null && oneLine(i.prefer) !== '') {
      if (options.length) {
        prefer = optionOf(options, m(i.prefer))
        if (prefer === null) return no('prefer must name one of the options (its text or its number).')
      } else {
        prefer = m(i.prefer)
        if ([...prefer].length > ASK_OPTION_MAX) return no(`prefer must be at most ${ASK_OPTION_MAX} characters.`)
      }
    }
    let why: string | null = null
    if (i.why !== undefined && i.why !== null && oneLine(i.why) !== '') {
      why = m(i.why)
      if ([...why].length > ASK_WHY_MAX) return no(`why must be one line of at most ${ASK_WHY_MAX} characters.`)
    }
    if (i.needs_user !== undefined && typeof i.needs_user !== 'boolean') return no('needs_user must be true or false.')
    const needs_user = i.needs_user !== false
    if (!needs_user && prefer === null) return no('a question that does not need the user needs `prefer`: what you go ahead with.')
    return { ok: true, ask: { id, text, options, prefer, why, needs_user } }
  } catch {
    return no('the question could not be read.')
  }
}

export function nextQuestionId(state: unknown): string {
  const s: Obj = isObj(state) ? state : {}
  let top = 0
  const look = (v: unknown) => {
    const n = /^q(\d{1,6})$/.exec(String(v ?? ''))?.[1]
    if (n) top = Math.max(top, Number(n))
  }
  for (const q of Array.isArray(s.questions) ? s.questions : []) look(q?.id)
  for (const p of Array.isArray(s.placeholders) ? s.placeholders : []) look(p?.question)
  return `q${top + 1}`
}

export function applyAsk(state: TaskState, input: unknown, ctx: OpCtx): OpResult {
  const s = state
  const i: Obj = isObj(input) ? input : {}
  const refuse = (answer: string): OpResult => ({ state: s, answer, changed: false, refused: true })
  const done = (questions: TaskState['questions'], answer: string): OpResult => ({
    state: { ...s, questions, keep_going: { ...s.keep_going, settled: false } }, answer, changed: true, refused: false,
  })
  const mask = (t: string): string => {
    try {
      return ctx.mask(t)
    } catch {
      return '(withheld)'
    }
  }
  const qs = Array.isArray(s?.questions) ? s.questions : []
  if (i.op === 'answer') {
    const id = oneLine(i.id)
    const old = qs.find((q) => q.id === id)
    if (!id || !old) return refuse(`No question "${id}" is recorded; op read lists the open ones.`)
    if (old.answer) return refuse(`Question ${id} was already answered (${old.answer.at}).`)
    const raw = typeof i.answer === 'string' && oneLine(i.answer) ? i.answer : typeof i.text === 'string' ? i.text : ''
    if (!oneLine(raw)) return refuse('answer needs the user\'s answer as `answer`.')
    const opts = askFieldsOf(old).options ?? []
    const text = (optionOf(opts, raw) ?? oneLine(mask(oneLine(raw)))).slice(0, ASK_TEXT_MAX)
    const q = { ...old, answer: { text, at: ctx.now, via: 'chat' } }
    return done(qs.map((x) => (x.id === id ? q : x)), `Recorded the answer to ${id}: ${text}`)
  }
  const v = validateAsk(i, mask)
  if (!v.ok) return refuse(`Not recorded: ${v.reason}`)
  const a = v.ask
  const id = a.id ?? nextQuestionId(s)
  const old = qs.find((q) => q.id === id)
  if (old?.answer) return refuse(`Question ${id} was already answered (${old.answer.at}); ask a new one without an id.`)
  if (!old && qs.filter((q) => !q.answer).length >= ASK_OPEN_MAX) return refuse(`Not recorded: ${ASK_OPEN_MAX} questions are open already; answer or drop some first.`)
  const q: Obj = {
    id, line_hash: old?.line_hash ?? '', text: a.text, asked_at: old?.asked_at ?? ctx.now, session: old?.session || ctx.session, answer: null,
    ...(a.options.length ? { options: a.options } : {}), prefer: a.prefer, why: a.why, needs_user: a.needs_user,
  }
  const questions = old ? qs.map((x) => (x.id === id ? (q as any) : x)) : [...qs, q as any]
  const tail = a.needs_user
    ? 'It waits for the user: ask them in your reply too, then record their answer with op answer.'
    : `It does not need the user: go ahead with "${a.prefer}"; the inbox shows it so they can object.`
  return done(questions, `Question ${id} recorded. ${tail}`)
}

export function renderQuestion(q: unknown): string[] {
  if (!isObj(q) || typeof q.id !== 'string') return []
  const f = askFieldsOf(q)
  const out = [`${jobText(q.id, 40)}: ${jobText(q.text, 200)}`]
  if (f.options?.length) {
    out.push(`options: ${f.options.map((o, k) => `${k + 1}) ${jobText(o, ASK_OPTION_MAX)}${f.prefer && o.toLowerCase() === f.prefer.toLowerCase() ? ' (the agent prefers this)' : ''}`).join('; ')}`)
  } else if (f.prefer) out.push(`the agent prefers: ${jobText(f.prefer, ASK_OPTION_MAX)}`)
  if (f.why) out.push(`why: ${jobText(f.why, ASK_WHY_MAX)}`)
  if (f.needs_user === false) out.push(`does not need you: the agent goes ahead with "${jobText(f.prefer ?? '', ASK_OPTION_MAX)}" unless you say otherwise`)
  return out
}

export function askInputSchema(): Obj {
  return {
    text: { type: 'string', maxLength: ASK_TEXT_MAX, description: 'ask: the question for the user, one line' },
    options: { type: 'array', maxItems: ASK_OPTIONS_MAX, items: { type: 'string', maxLength: ASK_OPTION_MAX }, description: `ask: 2 to ${ASK_OPTIONS_MAX} short answers to choose from (optional)` },
    prefer: { type: 'string', maxLength: ASK_OPTION_MAX, description: 'ask: the answer you would choose (an option\'s text or number)' },
    why: { type: 'string', maxLength: ASK_WHY_MAX, description: 'ask: one line on why you prefer it' },
    needs_user: { type: 'boolean', description: 'ask: false when you can go ahead with your preference and the user may object later (default true)' },
    answer: { type: 'string', maxLength: ASK_TEXT_MAX, description: 'answer: the user\'s answer (an option\'s number is taken as its text)' },
  }
}


export type InboxGroup = { key: 'decide' | 'confirm' | 'trouble' | 'finished'; title: string; lines: string[]; count: number }
export type Inbox = { groups: InboxGroup[]; count: number }
export type InboxInput = { jobs: readonly Job[] | null | undefined; state: unknown; now: number; since?: number | null }

const endOf = (j: Job): number => num(j.ended_at) ?? num(j.updated_at) ?? num(j.last_activity_at) ?? 0

function jobLine(j: Job, now: number): string {
  const ended = !jobOpen(j) ? ` ${ago(now - endOf(j))} ago` : ''
  const note = j.note ? `: ${jobText(j.note, 100)}` : ''
  return `${statusWord(j.status)}${ended}: "${jobText(j.title || `(${j.kind})`, 80)}" (${j.kind} ${jobText(j.id, 40)})${note}`
}

export function inboxOf(input: InboxInput): Inbox {
  const groups: InboxGroup[] = [
    { key: 'decide', title: 'Waiting on your decision', lines: [], count: 0 },
    { key: 'confirm', title: 'Done, waiting for your confirmation', lines: [], count: 0 },
    { key: 'trouble', title: 'Failed or stalled', lines: [], count: 0 },
    { key: 'finished', title: input?.since != null ? 'Finished since you left' : 'Finished, not seen yet', lines: [], count: 0 },
  ]
  const rows = new Map<InboxGroup['key'], { at: number; lines: string[] }[]>()
  try {
    const now = num(input?.now) ?? 0
    const since = num(input?.since)
    const jobs = Array.isArray(input?.jobs) ? input.jobs.filter((j) => isObj(j) && typeof j.id === 'string') : []
    const recent = N('INBOX_RECENT_MS')
    const lineCap = N('INBOX_LINES')
    const fresh = (j: Job): boolean => (since !== null ? endOf(j) >= since : j.unread === true || (recent !== undefined && now - endOf(j) <= recent))
    const add = (k: InboxGroup['key'], at: number, lines: string[]) => rows.set(k, [...(rows.get(k) ?? []), { at, lines }])
    for (const j of jobs) {
      if (j.status === 'waiting') add('decide', num(j.updated_at) ?? j.last_activity_at ?? 0, [jobLine(j, now)])
      else if (j.status === 'stalled') add('trouble', num(j.updated_at) ?? j.last_activity_at ?? 0, [jobLine(j, now)])
      else if (j.status === 'failed' && fresh(j)) add('trouble', endOf(j), [jobLine(j, now)])
      else if (j.status === 'done_unverified' && fresh(j)) add('confirm', endOf(j), [jobLine(j, now)])
      else if (j.status === 'done_verified' && fresh(j)) add('finished', endOf(j), [jobLine(j, now)])
    }
    const s: Obj = isObj(input?.state) ? (input!.state as Obj) : {}
    const questions = (Array.isArray(s.questions) ? s.questions : []).filter((q: unknown) => isObj(q) && typeof (q as Obj).id === 'string' && !(q as Obj).answer)
    for (const q of [...questions.filter((x: Obj) => x.needs_user !== false), ...questions.filter((x: Obj) => x.needs_user === false)]) {
      const [head, ...rest] = renderQuestion(q)
      if (head) add('decide', (q.needs_user === false ? -1e15 : 0) + (timeOf(q.asked_at) ?? 0), [`question ${head}`, ...rest.map((l) => `  ${l}`)])
    }
    for (const t of Array.isArray(s.tasks) ? s.tasks : []) {
      if (!isObj(t) || typeof t.id !== 'string') continue
      const title = `task ${jobText(t.id, 40)} "${jobText(t.title || t.id, 80)}"`
      if (t.status === 'waiting_user') {
        const ref = isObj(t.waiting_for) ? t.waiting_for.ref : ''
        add('decide', timeOf(t.updated) ?? 0, [`${title}: waiting for ${ref ? jobText(ref, 120) : 'you'}`])
      } else if (t.status === 'delivered' && isObj(t.result)) {
        const at = timeOf(t.result.at)
        if (at === null || (since !== null ? at < since : recent === undefined || now - at > recent)) continue
        add('confirm', at, [`${title} delivered ${ago(now - at)} ago${t.result.summary ? `: ${jobText(t.result.summary, 120)}` : ''}`])
      }
    }
    for (const g of groups) {
      const list = [...(rows.get(g.key) ?? [])].sort((a, b) => b.at - a.at)
      const shown = list.slice(0, lineCap)
      g.count = list.length
      g.lines = shown.flatMap((r) => r.lines.map((l, k) => (k === 0 ? `- ${l}` : `  ${l}`)))
      if (list.length > shown.length) g.lines.push(`- and ${list.length - shown.length} more`)
    }
  } catch {
    for (const g of groups) {
      g.lines = []
      g.count = 0
    }
  }
  return { groups: groups.filter((g) => g.count > 0), count: groups.reduce((n, g) => n + g.count, 0) }
}

export function inboxText(inbox: Inbox | null | undefined, opts: { stateError?: string | null } = {}): string {
  const trouble = opts.stateError ? `\n(.agent/task-state.json could not be read: ${jobText(opts.stateError, 40)}; its questions and tasks are not shown.)` : ''
  if (!inbox || !Array.isArray(inbox.groups) || !inbox.groups.length) {
    return `Nothing waiting for you: no open question, no job waiting on you, nothing failed, stalled or newly finished in this project.${trouble}`
  }
  const out = ['Decision inbox for this project (read on this computer from .agent/jobs.json and .agent/task-state.json):']
  for (const g of inbox.groups) out.push('', `${g.title} (${g.count}):`, ...g.lines)
  out.push('', 'Ask Claude to list every background job.')
  return out.join('\n') + trouble
}

export function inboxIdleNote(prev: number | null, at: number, jobs: readonly Job[] | null | undefined, state: unknown): string | null {
  try {
    const idle = N('INBOX_IDLE_MS')
    const max = N('INBOX_NOTE_MAX')
    if (idle === undefined || max === undefined || num(prev) === null || num(at) === null || at - (prev as number) < idle) return null
    const inbox = inboxOf({ jobs, state, now: at, since: prev })
    if (!inbox.count) return null
    const body = relText('inbox.text.idle_note', {
      ago: ago(at - (prev as number)), jobs_file: '.agent/jobs.json', state_file: '.agent/task-state.json', command: COMMAND,
    })
    if (body === undefined) return null
    const lines = inbox.groups.flatMap((g) => [`${g.title} (${g.count}):`, ...g.lines])
    return [`${NOTE_PREFIX}: ${body}`, ...lines].join('\n').slice(0, max)
  } catch {
    return null
  }
}

export async function inboxPrompt($: EngineInterface, e: Obj, rt?: Ready): Promise<Obj> {
  try {
    if (!isObj(e) || e.agentId || !(await jobsLive(rt))) return e
    const blocks: string[] = []
    if (['composer', 'sdk', 'bridge'].includes(e.origin?.kind)) {
      const at = Number(await $.clock.now())
      const prev = await reachPerson($, at)
      const idle = N('INBOX_IDLE_MS')
      if (prev !== null && idle !== undefined && at - prev >= idle) {
        const got = await loadTaskState($)
        const note = inboxIdleNote(prev, at, await listJobs($), got.state)
        if (note) blocks.push(note)
      }
    }
    return blocks.length ? { ...e, context: [...(Array.isArray(e.context) ? e.context : []), ...blocks] } : e
  } catch {
    return e
  }
}

export async function inboxCommand($: EngineInterface, rest: string[]): Promise<string> {
  try {
    if ((rest ?? []).length) return `Usage: ${COMMAND} inbox`
    const now = Number(await Promise.resolve($.clock.now()).catch(() => Date.now()))
    const jobs = await listJobs($)
    const got = await loadTaskState($)
    return inboxText(inboxOf({ jobs, state: got.state, now, since: null }), { stateError: got.error })
  } catch {
    return inboxText(null, { stateError: 'unreadable' })
  }
}
