import { idParts } from './placeholders'
import { applyAsk, askFieldsOf, askInputSchema } from './inbox'
import { planSteps, type PlanStep } from './plan_file'
import { relText } from './reliability'

export type TaskStatus = 'todo' | 'running' | 'waiting_user' | 'waiting_agent' | 'delivered' | 'dropped'
export type WaitingFor = { kind: string; ref: string; since: string }
export type TaskResult = { at: string; summary: string; files: string[] }
export type TaskAgent = {
  id: string; type: string; description: string; model: string; status: string
  started: string | null; ended: string | null; report: string | null
}
export type Task = {
  id: string; title: string; status: TaskStatus; session: string; next: string | null
  waiting_for: WaitingFor | null; result: TaskResult | null; agents: TaskAgent[]; updated: string
}
export type EffectState = 'started' | 'executed' | 'failed'
export type Effect = { key: string; request: string; kind: string; state: EffectState; at: string; session: string; detail: string | null; untrusted?: true }
export type Answer = { text: string; at: string; via: string }
export type Question = {
  id: string; line_hash: string; text: string; asked_at: string; session: string; answer: Answer | null
  options?: string[]; prefer?: string | null; why?: string | null; needs_user?: boolean
}
export type PlaceholderFile = { path: string; line: number }
export type Placeholder = {
  id: string; question: string; files: PlaceholderFile[]; fake: string; status: 'open' | 'filled'; filled_at: string | null
}
export type KeepGoing = { rounds: number; settled: boolean; at: string | null; waiting: string[]; next: string | null }
export type Silenced = { subject: string; reason: string; at: string; session: string; untrusted?: true }
export type StepsSummary = { total: number; done: number; ready: string[]; at: string }
export type TaskState = {
  v: 1; rev: number; updated: string; tasks: Task[]; effects: Effect[]; questions: Question[]
  placeholders: Placeholder[]; keep_going: KeepGoing; silenced: Silenced[]; steps: StepsSummary | null
  untrusted?: true
}
export type OpCtx = {
  now: string; session: string; mask: (text: string) => string; subagent?: boolean
  markers?: Record<string, string[]>
}
export type OpResult = { state: TaskState; answer: string; changed: boolean; refused: boolean }

type Obj = Record<string, any>

const STATUSES: TaskStatus[] = ['todo', 'running', 'waiting_user', 'waiting_agent', 'delivered', 'dropped']
const OPS = ['deliver', 'effect_begin', 'effect_done', 'keep_going', 'placeholder_add', 'placeholder_filled', 'silence', 'ask', 'answer', 'read',
  'plan_goal', 'plan_add', 'plan_set', 'plan_run', 'decide', 'lesson']

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max)
const optStr = (v: unknown, max: number): string | null => (typeof v === 'string' && v ? v.slice(0, max) : null)
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : [])
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const later = (a: string | null | undefined, b: string | null | undefined): boolean => String(a ?? '') > String(b ?? '')
const oneLine = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim()
const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 3)}...` : s)
const isOpen = (t: Task): boolean => t.status !== 'delivered' && t.status !== 'dropped'

export function isWriteOp(op: unknown): boolean {
  return typeof op === 'string' && OPS.includes(op) && op !== 'read'
}

export function isFileOp(op: unknown): boolean {
  return typeof op === 'string' && /^(?:plan_(?:goal|add|set|run)|decide|lesson)$/.test(op)
}

export function emptyState(now: string): TaskState {
  return {
    v: 1, rev: 0, updated: now, tasks: [], effects: [], questions: [], placeholders: [],
    keep_going: { rounds: 0, settled: false, at: null, waiting: [], next: null }, silenced: [], steps: null,
  }
}

function normTask(t: unknown): Task | null {
  if (!isObj(t) || typeof t.id !== 'string' || !t.id) return null
  const w = isObj(t.waiting_for) ? { kind: str(t.waiting_for.kind, 40), ref: str(t.waiting_for.ref, 300), since: str(t.waiting_for.since, 40) } : null
  const r = isObj(t.result) ? { at: str(t.result.at, 40), summary: str(t.result.summary, 600), files: arr(t.result.files).map((f) => str(f, 300)).slice(0, 50) } : null
  return {
    id: str(t.id, 40), title: str(t.title, 200), status: STATUSES.includes(t.status) ? t.status : 'todo',
    session: str(t.session, 80), next: optStr(t.next, 300), waiting_for: w, result: r,
    agents: arr(t.agents).filter((a) => isObj(a) && typeof a.id === 'string').map(normAgent).slice(-20),
    updated: str(t.updated, 40),
  }
}

function normAgent(a: Obj): TaskAgent {
  return {
    id: str(a.id, 80), type: str(a.type, 80), description: str(a.description, 200), model: str(a.model, 40),
    status: str(a.status, 40), started: optStr(a.started, 40), ended: optStr(a.ended, 40), report: optStr(a.report, 600),
  }
}

function normEffect(e: unknown): Effect | null {
  if (!isObj(e) || typeof e.key !== 'string' || !e.key) return null
  const state: EffectState = e.state === 'executed' || e.state === 'failed' ? e.state : 'started'
  return { key: str(e.key, 120), request: str(e.request, 300), kind: str(e.kind, 40), state, at: str(e.at, 40), session: str(e.session, 80), detail: optStr(e.detail, 300), ...(e.untrusted === true ? { untrusted: true as const } : {}) }
}

function normQuestion(q: unknown): Question | null {
  if (!isObj(q) || typeof q.id !== 'string' || !q.id) return null
  const a = isObj(q.answer) ? { text: str(q.answer.text, 500), at: str(q.answer.at, 40), via: str(q.answer.via, 40) } : null
  return {
    id: str(q.id, 40), line_hash: str(q.line_hash, 80), text: str(q.text, 500), asked_at: str(q.asked_at, 40),
    session: str(q.session, 80), answer: a, ...askFieldsOf(q),
  }
}

function normPlaceholder(p: unknown): Placeholder | null {
  if (!isObj(p) || !idParts(p.id)) return null
  const files = arr(p.files).filter(isObj).map((f) => ({ path: str(f.path, 300), line: Number.isFinite(f.line) ? Math.max(0, Math.floor(f.line)) : 0 })).slice(0, 50)
  return {
    id: str(p.id, 40), question: str(p.question, 40), files, fake: str(p.fake, 200),
    status: p.status === 'filled' ? 'filled' : 'open', filled_at: optStr(p.filled_at, 40),
  }
}

const legacyDeferred = (q: Question): boolean => q.line_hash === '' && /^deferred-[0-9a-f]{10}$/.test(q.id)

function normState(o: Obj): TaskState {
  const kg = isObj(o.keep_going) ? o.keep_going : {}
  const st = isObj(o.steps) ? o.steps : null
  return {
    v: 1, rev: Number.isFinite(o.rev) ? Math.max(0, Math.floor(o.rev)) : 0, updated: str(o.updated, 40),
    tasks: arr(o.tasks).map(normTask).filter((t): t is Task => t !== null),
    effects: arr(o.effects).map(normEffect).filter((e): e is Effect => e !== null),
    questions: arr(o.questions).map(normQuestion).filter((q): q is Question => q !== null && !legacyDeferred(q)),
    placeholders: arr(o.placeholders).map(normPlaceholder).filter((p): p is Placeholder => p !== null),
    keep_going: {
      rounds: Number.isFinite(kg.rounds) ? Math.max(0, Math.floor(kg.rounds)) : 0, settled: kg.settled === true,
      at: optStr(kg.at, 40), waiting: arr(kg.waiting).map((w) => str(w, 80)).slice(0, 20), next: optStr(kg.next, 300),
    },
    silenced: arr(o.silenced).filter((s) => isObj(s) && typeof s.subject === 'string' && s.subject)
      .map((s) => ({ subject: str(s.subject, 200), reason: str(s.reason, 200), at: str(s.at, 40), session: str(s.session, 80), ...(s.untrusted === true ? { untrusted: true as const } : {}) })),
    steps: st ? { total: Number(st.total) || 0, done: Number(st.done) || 0, ready: arr(st.ready).map((r) => str(r, 40)).slice(0, 20), at: str(st.at, 40) } : null,
    ...(o.untrusted === true ? { untrusted: true as const } : {}),
  }
}

export function parseTaskState(text: string): { state: TaskState } | { error: 'corrupt' | 'newer' } {
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch {
    return { error: 'corrupt' }
  }
  if (!isObj(o)) return { error: 'corrupt' }
  if (typeof o.v === 'number' && o.v > 1) return { error: 'newer' }
  if (o.v !== 1) return { error: 'corrupt' }
  return { state: normState(o) }
}

function unionBy<T>(a: T[], b: T[], key: (x: T) => string, pick: (x: T, y: T) => T): T[] {
  const out = new Map<string, T>()
  for (const x of a) out.set(key(x), x)
  for (const y of b) {
    const k = key(y)
    const x = out.get(k)
    out.set(k, x === undefined ? y : pick(x, y))
  }
  return [...out.values()]
}

export function mergeStates(mine: TaskState, theirs: TaskState): TaskState {
  const a = normState(mine as Obj)
  const b = normState(theirs as Obj)
  return {
    v: 1, rev: Math.max(a.rev, b.rev), updated: later(b.updated, a.updated) ? b.updated : a.updated,
    tasks: unionBy(a.tasks, b.tasks, (t) => t.id, (x, y) => (later(y.updated, x.updated) ? y : x)),
    effects: unionBy(a.effects, b.effects, (e) => e.key, (x, y) => {
      if (x.state === 'executed' || y.state === 'executed') return x.state === 'executed' ? x : y
      return later(y.at, x.at) ? y : x
    }),
    questions: unionBy(a.questions, b.questions, (q) => q.id, (x, y) => {
      const base = later(y.asked_at, x.asked_at) ? y : x
      return { ...base, answer: x.answer ?? y.answer }
    }),
    placeholders: unionBy(a.placeholders, b.placeholders, (p) => p.id, (x, y) => {
      if (x.status !== y.status) return x.status === 'filled' ? x : y
      const files = unionBy(x.files, y.files, (f) => `${f.path}:${f.line}`, (f) => f)
      return { ...x, files }
    }),
    keep_going: later(b.keep_going.at, a.keep_going.at) ? b.keep_going : a.keep_going,
    silenced: unionBy(a.silenced, b.silenced, (s) => `${s.session}\n${s.subject}`, (x, y) => (later(y.at, x.at) ? y : x)),
    steps: !a.steps ? b.steps : !b.steps ? a.steps : later(b.steps.at, a.steps.at) ? b.steps : a.steps,
    ...(a.untrusted || b.untrusted ? { untrusted: true as const } : {}),
  }
}

function utf8Length(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c < 0xdc00) { n += 4; i++ }
    else n += 3
  }
  return n
}

export function capState(s: TaskState, maxBytes: number = 256 * 1024): TaskState {
  const st = normState(s as Obj)
  const keepNewest = <T>(list: T[], max: number, gone: (x: T) => boolean, at: (x: T) => string): T[] => {
    if (list.length <= max) return list
    const order = [...list].sort((x, y) => Number(gone(y)) - Number(gone(x)) || at(x).localeCompare(at(y)))
    const drop = new Set(order.slice(0, list.length - max))
    return list.filter((x) => !drop.has(x))
  }
  st.tasks = keepNewest(st.tasks, 50, (t) => !isOpen(t), (t) => t.updated)
  st.effects = keepNewest(st.effects, 200, (e) => e.state !== 'executed', (e) => e.at)
  st.questions = keepNewest(st.questions, 100, (q) => q.answer !== null, (q) => q.asked_at)
  st.placeholders = keepNewest(st.placeholders, 100, (p) => p.status === 'filled', (p) => p.filled_at ?? '')
  st.silenced = keepNewest(st.silenced, 100, () => false, (x) => x.at)
  const size = () => utf8Length(JSON.stringify(st, null, 1))
  let trimmed = false
  for (let guard = 0; guard < 1000 && size() > maxBytes; guard++) {
    if (st.tasks.length > 1 && st.tasks.some((t) => !isOpen(t))) st.tasks = keepNewest(st.tasks, st.tasks.length - 1, (t) => !isOpen(t), (t) => t.updated)
    else if (!trimmed) {
      for (const t of st.tasks) t.agents = t.agents.slice(-1).map((a) => ({ ...a, report: null }))
      trimmed = true
    } else if (st.effects.some((e) => e.state !== 'executed')) st.effects = keepNewest(st.effects, st.effects.length - 1, (e) => e.state !== 'executed', (e) => e.at)
    else if (st.questions.some((q) => q.answer !== null)) st.questions = keepNewest(st.questions, st.questions.length - 1, (q) => q.answer !== null, (q) => q.asked_at)
    else if (st.tasks.length > 1) st.tasks = keepNewest(st.tasks, st.tasks.length - 1, () => false, (t) => t.updated)
    else break
  }
  return st
}

export function renderMarkdown(s: TaskState): string {
  const st = normState(s as Obj)
  const L: string[] = [
    '<!-- generated by agent-services from task-state.json; do not edit, every change of the json rewrites it -->',
    '# Task state', '', `Updated ${st.updated} (rev ${st.rev}).`, '', '## Tasks',
  ]
  if (!st.tasks.length) L.push('- none')
  for (const t of st.tasks) {
    L.push(`- [${t.status}] ${oneLine(t.id)}: ${oneLine(t.title)}`)
    if (t.next) L.push(`  - next: ${oneLine(t.next)}`)
    if (t.waiting_for) L.push(`  - waiting for: ${oneLine(t.waiting_for.kind)} ${oneLine(t.waiting_for.ref)} (since ${t.waiting_for.since})`)
    if (t.result) L.push(`  - result (${t.result.at}): ${oneLine(t.result.summary)}${t.result.files.length ? `; files: ${t.result.files.map(oneLine).join(', ')}` : ''}`)
    for (const a of t.agents) L.push(`  - agent ${oneLine(a.id)} (${oneLine(a.type)}, ${oneLine(a.model)}): ${oneLine(a.status)}; ${oneLine(a.description)}`)
  }
  L.push('', '## Questions for the user')
  if (!st.questions.length) L.push('- none')
  for (const q of st.questions) {
    L.push(`- ${oneLine(q.id)}: ${oneLine(q.text)} (asked ${q.asked_at})${q.answer ? `; answer (${oneLine(q.answer.via)}, ${q.answer.at}): ${oneLine(q.answer.text)}` : ''}`)
  }
  L.push('', '## Placeholders')
  if (!st.placeholders.length) L.push('- none')
  for (const p of st.placeholders) {
    L.push(`- ${oneLine(p.id)} (${p.status}) for ${oneLine(p.question)}: ${p.files.map((f) => `${oneLine(f.path)}:${f.line}`).join(', ')}; fake ${oneLine(p.fake)}`)
  }
  L.push('', '## Side effects')
  if (!st.effects.length) L.push('- none')
  for (const e of st.effects) L.push(`- ${oneLine(e.key)}: ${e.state} ${e.at} (${oneLine(e.kind)}, session ${oneLine(e.session)}): ${oneLine(e.request)}${e.detail ? `; ${oneLine(e.detail)}` : ''}`)
  const kg = st.keep_going
  L.push('', '## Keep-going check', `- rounds ${kg.rounds}, settled ${kg.settled ? 'yes' : 'no'}${kg.at ? ` (${kg.at})` : ''}${kg.waiting.length ? `; waiting: ${kg.waiting.map(oneLine).join(', ')}` : ''}${kg.next ? `; next: ${oneLine(kg.next)}` : ''}`)
  if (st.steps) L.push('', '## Steps', `- ${st.steps.done} of ${st.steps.total} done${st.steps.ready.length ? `; ready: ${st.steps.ready.map(oneLine).join(', ')}` : ''} (${st.steps.at})`)
  if (st.silenced.length) {
    L.push('', '## Silenced subjects')
    for (const x of st.silenced) L.push(`- ${oneLine(x.subject)} (session ${oneLine(x.session)}, ${x.at}): ${oneLine(x.reason)}`)
  }
  return `${L.join('\n')}\n`
}

export function resumeNote(s: TaskState, opts: { mdPath: string; since?: string | null }): string {
  const st = normState(s as Obj)
  const line = (x: string) => `- ${clip(oneLine(x), 200)}`
  const sections: [string, string[]][] = [
    ['Waiting for the user:', [
      ...st.tasks.filter((t) => t.status === 'waiting_user').map((t) => line(`${t.id}: ${t.title}${t.waiting_for?.ref ? ` (waiting for ${t.waiting_for.ref})` : ''}`)),
      ...st.questions.filter((q) => !q.answer).map((q) => line(`${q.id}: ${q.text}`)),
    ]],
    ['Answers that arrived:', st.questions
      .filter((q) => q.answer && (!opts.since || later(q.answer.at, opts.since)))
      .sort((x, y) => String(y.answer!.at).localeCompare(String(x.answer!.at))).slice(0, 5)
      .map((q) => line(`${q.id}: ${q.answer!.text} (${q.answer!.via}, ${q.answer!.at})`))],
    ['Next steps:', st.tasks.filter((t) => isOpen(t) && t.status !== 'waiting_user' && t.next).map((t) => line(`${t.id}: ${t.next}`))],
    ['Open placeholders:', st.placeholders.filter((p) => p.status === 'open')
      .map((p) => line(`${p.id} for ${p.question}: ${p.files.map((f) => `${f.path}:${f.line}`).join(', ')} (fake ${p.fake})`))],
    ['Live agents:', st.tasks.flatMap((t) => t.agents.filter((a) => a.status === 'running').map((a) => line(`${a.id} (${a.type}, ${a.description}) for ${t.id}`)))],
    ['Last side effects executed:', st.effects.filter((e) => e.state === 'executed')
      .sort((x, y) => y.at.localeCompare(x.at)).slice(0, 5).map((e) => line(`${e.key}: ${e.request} (${e.at})`))],
  ]
  if (!sections.some(([, l]) => l.length)) return ''
  const head = 'agent-services task state (a plugin note from this project\'s .agent/task-state.json, not the user\'s words):'
  const foot = `Full state: ${opts.mdPath}`
  const budget = 1500 - foot.length - 1
  let out = head
  for (const [title, lines] of sections) {
    if (!lines.length) continue
    if (out.length + title.length + 1 > budget) break
    out += `\n${title}`
    for (const l of lines) {
      if (out.length + l.length + 1 > budget) break
      out += `\n${l}`
    }
  }
  return `${out}\n${foot}`.slice(0, 1500)
}


export function upsertTask(s: TaskState, patch: Partial<Task> & { id: string }, ctx: OpCtx): TaskState {
  const st = normState(s as Obj)
  const old = st.tasks.find((t) => t.id === patch.id)
  const m = (v: unknown, max: number) => (typeof v === 'string' ? ctx.mask(v).slice(0, max) : v)
  const merged = normTask({
    ...(old ?? { title: '', status: 'todo', next: null, waiting_for: null, result: null, agents: [] }),
    ...patch,
    title: m(patch.title ?? old?.title ?? '', 200),
    next: patch.next === undefined ? old?.next ?? null : m(patch.next, 300),
    result: patch.result ? { ...patch.result, summary: m(patch.result.summary, 600), files: patch.result.files.map((f) => m(f, 300)) } : patch.result === null ? null : old?.result ?? null,
    waiting_for: patch.waiting_for ? { ...patch.waiting_for, ref: m(patch.waiting_for.ref, 300) } : patch.waiting_for === null ? null : old?.waiting_for ?? null,
    session: ctx.session, updated: ctx.now,
  })!
  st.tasks = old ? st.tasks.map((t) => (t.id === patch.id ? merged : t)) : [...st.tasks, merged]
  return st
}

export function upsertAgent(s: TaskState, taskId: string, agent: Partial<TaskAgent> & { id: string }, ctx: OpCtx): TaskState {
  let st = normState(s as Obj)
  if (!st.tasks.some((t) => t.id === taskId)) st = upsertTask(st, { id: taskId, status: 'running' }, ctx)
  return {
    ...st,
    tasks: st.tasks.map((t) => {
      if (t.id !== taskId) return t
      const old = t.agents.find((a) => a.id === agent.id)
      const masked: Obj = {}
      for (const [k, v] of Object.entries(agent)) masked[k] = typeof v === 'string' ? ctx.mask(v) : v
      const a = normAgent({ ...(old ?? {}), ...masked })
      return { ...t, agents: (old ? t.agents.map((x) => (x.id === agent.id ? a : x)) : [...t.agents, a]).slice(-20), updated: ctx.now }
    }),
  }
}

export function upsertQuestion(s: TaskState, q: Partial<Question> & { id: string }, ctx: OpCtx): TaskState {
  const st = normState(s as Obj)
  const old = st.questions.find((x) => x.id === q.id)
  const next = normQuestion({
    ...(old ?? { line_hash: '', text: '', asked_at: ctx.now, session: ctx.session, answer: null }),
    ...q,
    ...(q.text !== undefined ? { text: ctx.mask(String(q.text)) } : {}),
    ...(q.answer ? { answer: { ...q.answer, text: ctx.mask(String(q.answer.text)) } } : {}),
  })!
  st.questions = old ? st.questions.map((x) => (x.id === q.id ? next : x)) : [...st.questions, next]
  return st
}

export function setSteps(s: TaskState, steps: { total: number; done: number; ready: string[] }, ctx: OpCtx): TaskState {
  return { ...normState(s as Obj), steps: { total: steps.total, done: steps.done, ready: steps.ready.slice(0, 20).map((r) => str(r, 40)), at: ctx.now } }
}

export function nextTaskId(s: TaskState): string {
  let top = 0
  for (const t of s.tasks) top = Math.max(top, Number(/^t(\d{1,9})$/.exec(t.id)?.[1] ?? 0))
  return `t${top + 1}`
}

export function recoverPlaceholders(text: string): Placeholder[] {
  const t = String(text ?? '')
  const start = /(?<!\\)"placeholders"\s*:\s*\[/.exec(t)
  const stand = (id: string, question: string): Placeholder => ({ id, question, files: [], fake: '(recovered from a damaged task-state.json)', status: 'open', filled_at: null })
  if (!start) return [stand('unrecovered-1', 'unrecovered')]
  const rest = t.slice(start.index + start[0].length)
  if (/^\s*\]/.test(rest)) return []
  const section = rest.split(/(?<!\\)"keep_going"\s*:/)[0]!
  const parts = section.split(/(?<!\\)"id"\s*:\s*"/).slice(1)
  const out: Placeholder[] = []
  for (const part of parts) {
    const id = /^([^"\\]{1,40})"/.exec(part)?.[1]
    const p = id ? idParts(id) : null
    if (!p || out.some((x) => x.id === id) || /(?<!\\)"status"\s*:\s*"filled"/.test(part)) continue
    out.push(stand(id!, p.question))
  }
  return out.length || parts.length ? out.slice(0, 100) : [stand('unrecovered-1', 'unrecovered')]
}


export function taskStateToolSpec(): { name: string; description: string; inputSchema: Obj } {
  const s = (max: number, description: string) => ({ type: 'string', maxLength: max, description })
  return {
    name: 'task_state',
    description: "Record and read this project's task state (.agent/task-state.json and .md, kept on this computer; " +
      'nothing is sent to the service). op read: the open items. deliver: mark a task delivered with a summary (refused ' +
      'while a placeholder is open). effect_begin / effect_done: record a side effect (deploy, push, publish, send) by a ' +
      'stable key before and after it runs; effect_begin answers when that key was already executed, so it never runs ' +
      'twice. keep_going: answer the keep-going check. placeholder_add / placeholder_filled: record a stand-in value ' +
      'marked AGENT_PLACEHOLDER(<id>) in code and its replacement. silence: a subject the plugin stopped that was not ' +
      'stuck, so it is not stopped again this session. ask: a question for the user (text), with 2-6 options, the answer ' +
      'you prefer, one line why, and needs_user (false: you go ahead with your preference and the user may object); ' +
      'answer: record the user\'s answer to a question. ask also appends the question\'s line to .agent/pending.md and ' +
      'answer ticks it. Project files, written in the format agent-services reads (append only where noted): ' +
      'plan_goal (text) sets the ## Goal of agent-state.md; plan_add (id, text, after, owns) adds a ## Plan step or ' +
      'updates the step with that id; plan_set (id, step_status, evidence) marks a step todo, running or done; plan_run ' +
      'sets `phase: running` once a goal and a step exist; decide (decision, reason, alternatives, undo) appends one line ' +
      'to the project\'s decisions file; lesson (grade, symptom, cause, next, context) appends a paragraph to .agent/lessons.md. deliver ' +
      'also returns a draft delivery report from the records (diff, test runs, decisions, review job). Only the main ' +
      'conversation can change the state or these files.',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: [...OPS], description: 'The operation' },
        task: s(40, 'deliver: the task id (default: the one open task, else a new one)'),
        title: s(200, 'deliver: the task title when it is new'),
        summary: s(600, 'deliver: what was delivered'),
        files: { type: 'array', maxItems: 50, items: { anyOf: [{ type: 'string', maxLength: 300 }, { type: 'object', properties: { path: { type: 'string', maxLength: 300 }, line: { type: 'integer', minimum: 0 } }, required: ['path'] }] }, description: 'deliver: changed files; placeholder_add: {path, line} of each marker' },
        key: s(120, 'effect_begin / effect_done: a stable key for the side effect'),
        request: s(300, 'effect_begin: the request it fulfils'),
        kind: s(40, 'effect_begin: deploy, push, publish, send, payment, release or other'),
        state: { type: 'string', enum: ['executed', 'failed'], description: 'effect_done: the outcome' },
        detail: s(300, 'effect_done: what was done'),
        all_remaining_wait_for_user: { type: 'boolean', description: 'keep_going: true when every remaining item waits for the user' },
        waiting: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 80 }, description: 'keep_going: the items that wait' },
        next: s(400, 'keep_going: the next step; lesson: what to do next time'),
        id: s(40, 'placeholder_add / placeholder_filled: the placeholder id, e.g. q3-1; ask (optional) / answer: the question id, e.g. q3; plan_add / plan_set: the step id, e.g. t1'),
        question: s(40, 'placeholder_add: the question id it waits for, e.g. q3'),
        fake: s(200, 'placeholder_add: the visibly fake value used meanwhile (e.g. a .test host)'),
        subject: s(200, 'silence: the subject key the plugin named'),
        reason: s(300, 'silence: why it was not stuck; decide: why'),
        ...askInputSchema(),
        text: s(500, 'ask: the question for the user, one line; plan_goal: the goal; plan_add: the step'),
        after: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 40 }, description: 'plan_add: ids of the steps it waits for' },
        owns: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 200 }, description: 'plan_add: globs of the files the step changes' },
        step_status: { type: 'string', enum: ['todo', 'running', 'done'], description: 'plan_set: the step\'s new status' },
        evidence: s(300, 'plan_set: the proof a done step carries (a command and its result, a commit)'),
        decision: s(300, 'decide: the decision'),
        alternatives: s(200, 'decide: the alternatives not taken'),
        undo: s(200, 'decide / ask: how to undo it'),
        grade: { type: 'string', enum: ['E0', 'E1', 'E2', 'E3'], description: 'lesson: E0 a guess, E1 seen once, E2 reproduced, E3 confirmed by a test or a fix' },
        symptom: s(400, 'lesson: what was seen'),
        cause: s(400, 'lesson: the root cause'),
        context: s(120, 'lesson: where it happened, a few words'),
      },
      required: ['op'],
      additionalProperties: false,
    },
  }
}

export function applyOp(state: TaskState, input: unknown, ctx: OpCtx): OpResult {
  const s = normState(state as Obj)
  const i: Obj = isObj(input) ? input : {}
  const refuse = (answer: string): OpResult => ({ state: s, answer, changed: false, refused: true })
  const done = (next: TaskState, answer: string, reopen = true): OpResult => ({
    state: reopen ? { ...next, keep_going: { ...next.keep_going, settled: false } } : next, answer, changed: true, refused: false,
  })
  const m = (v: unknown, max: number) => clip(ctx.mask(oneLine(v)), max)
  const op = i.op
  if (typeof op !== 'string' || !OPS.includes(op)) return refuse(`Unknown op; use one of: ${OPS.join(', ')}.`)
  if (op === 'read') return { state: s, answer: resumeNote(s, { mdPath: '.agent/task-state.md' }) || 'No open items in the task state.', changed: false, refused: false }
  if (ctx.subagent) return refuse('Only the main conversation can change the task state; op read is open to subagents.')
  if (isFileOp(op)) return refuse(`${op} writes a project file, not the task state; the task_state tool answers it.`)
  if (op === 'ask' || op === 'answer') return applyAsk(s, i, ctx)

  if (op === 'effect_begin') {
    const key = m(i.key, 120)
    if (!key) return refuse('effect_begin needs a key.')
    const old = s.effects.find((e) => e.key === key)
    if (old?.state === 'executed') return refuse(`Not run again: "${key}" was already executed at ${old.at} (session ${old.session}). Tell the user it is done; repeat it only if they confirm.`)
    if (old?.state === 'started') return refuse(`"${key}" was already started at ${old.at} (session ${old.session}). Check whether it ran; if it did not, record effect_done with state failed, then begin again.`)
    const e: Effect = { key, request: m(i.request, 300), kind: m(i.kind, 40) || 'other', state: 'started', at: ctx.now, session: ctx.session, detail: null }
    return done({ ...s, effects: [...s.effects.filter((x) => x.key !== key), e] }, `Recorded "${key}" as started; record effect_done when it has run.`)
  }
  if (op === 'effect_done') {
    const key = m(i.key, 120)
    const old = s.effects.find((e) => e.key === key)
    if (!old) return refuse(`No effect "${key}" was begun; call effect_begin first.`)
    if (old.state !== 'started') return refuse(`"${key}" is already recorded as ${old.state} at ${old.at}; effect_done records only an effect that was begun and not yet finished.`)
    const state: EffectState = i.state === 'failed' ? 'failed' : 'executed'
    const e: Effect = { key: old.key, request: old.request, kind: old.kind, state, at: ctx.now, session: ctx.session, detail: i.detail ? m(i.detail, 300) : old.detail }
    return done({ ...s, effects: s.effects.map((x) => (x.key === key ? e : x)) }, `Recorded "${key}" as ${state}.`)
  }
  if (op === 'deliver') {
    const open = s.placeholders.filter((p) => p.status === 'open')
    if (open.length) return refuse(`Not delivered: placeholders still open: ${open.map((p) => `${p.id} (${p.files.map((f) => `${f.path}:${f.line}`).join(', ')})`).join('; ')}. Fill them, run the tests, call placeholder_filled, then deliver.`)
    const left = s.placeholders.flatMap((p) => (ctx.markers?.[p.id] ?? []).map((f) => `${p.id} in ${f}`))
    if (left.length) return refuse(`Not delivered: placeholder markers are still in the code: ${left.join(', ')}.`)
    const openTasks = s.tasks.filter(isOpen)
    const id = m(i.task, 40) || (openTasks.length === 1 ? openTasks[0].id : nextTaskId(s))
    const files = arr(i.files).map((f) => m(isObj(f) ? f.path : f, 300)).filter(Boolean).slice(0, 50)
    const summary = m(i.summary, 600)
    const old = s.tasks.find((t) => t.id === id)
    const next = upsertTask(s, {
      id, title: i.title ? String(i.title) : old?.title || clip(oneLine(summary), 80), status: 'delivered',
      next: null, waiting_for: null, result: { at: ctx.now, summary, files },
    }, ctx)
    return done(next, `Task ${id} recorded as delivered.`)
  }
  if (op === 'keep_going') {
    const yes = i.all_remaining_wait_for_user === true
    const waiting = arr(i.waiting).map((w) => m(w, 80)).filter(Boolean).slice(0, 20)
    const kg: KeepGoing = { rounds: s.keep_going.rounds + 1, settled: yes, at: ctx.now, waiting, next: i.next ? m(i.next, 300) : null }
    const tasks = yes
      ? s.tasks.map((t) => (isOpen(t) && t.status !== 'waiting_user'
        ? { ...t, status: 'waiting_user' as TaskStatus, waiting_for: { kind: 'user', ref: clip(waiting.join(', '), 300), since: ctx.now }, updated: ctx.now }
        : t))
      : s.tasks
    return done({ ...s, tasks, keep_going: kg }, yes ? 'Recorded: every remaining item waits for the user.' : 'Recorded: work remains; carry on with it.', false)
  }
  if (op === 'placeholder_add') {
    const id = m(i.id, 40)
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id)) return refuse('placeholder_add needs an id of letters, digits, dot, dash or underscore, e.g. q3-1.')
    const fake = String(i.fake ?? '').slice(0, 200)
    if (!fake) return refuse('placeholder_add needs the fake value used meanwhile.')
    if (ctx.mask(fake) !== fake) return refuse('Not recorded: the fake value looks like a secret. Passwords, keys, tokens and real account details are never placeholders; they stay steps for the user.')
    const files = arr(i.files).filter(isObj).map((f) => ({ path: m(f.path, 300), line: Number.isFinite(f.line) ? Math.max(0, Math.floor(f.line)) : 0 })).filter((f) => f.path).slice(0, 50)
    const old = s.placeholders.find((p) => p.id === id)
    const p: Placeholder = {
      id, question: m(i.question, 40) || old?.question || '', fake, status: 'open', filled_at: null,
      files: unionBy(old?.files ?? [], files, (f) => `${f.path}:${f.line}`, (f) => f).slice(0, 50),
    }
    const next = { ...s, placeholders: old ? s.placeholders.map((x) => (x.id === id ? p : x)) : [...s.placeholders, p] }
    const capped = capState(next)
    const openCount = (x: TaskState) => x.placeholders.filter((y) => y.status === 'open').length
    if (openCount(capped) < openCount(next) || utf8Length(JSON.stringify(next, null, 1)) > 255 * 1024)
      return refuse('Not recorded: the task state has no room for this placeholder (at most 100 placeholders and 256 KiB in all). Fill and mark filled the placeholders you can, or record fewer or shorter file locations, then try again.')
    return done(next, `Placeholder ${id} recorded as open; mark it in code as AGENT_PLACEHOLDER(${id}).`)
  }
  if (op === 'placeholder_filled') {
    const id = m(i.id, 40)
    const old = s.placeholders.find((p) => p.id === id)
    if (!old) return refuse(`No placeholder "${id}" is recorded.`)
    const left = ctx.markers?.[id] ?? []
    if (left.length) return refuse(`Not marked filled: AGENT_PLACEHOLDER(${id}) is still in ${left.join(', ')}.`)
    const p: Placeholder = { ...old, status: 'filled', filled_at: ctx.now }
    return done({ ...s, placeholders: s.placeholders.map((x) => (x.id === id ? p : x)) }, `Placeholder ${id} recorded as filled.`)
  }
  const subject = m(i.subject, 200)
  if (!subject) return refuse('silence needs the subject key.')
  const entry: Silenced = { subject, reason: m(i.reason, 200), at: ctx.now, session: ctx.session }
  const silenced = [...s.silenced.filter((x) => !(x.subject === subject && x.session === ctx.session)), entry]
  return done({ ...s, silenced }, `"${subject}" will not be stopped again in this session.`)
}


export type FileEdit = { text: string; answer: string } | { refuse: string }

function headingOf(line: string): { level: number; title: string } | null {
  if (line.length > 500) return null
  const h = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line)
  return h ? { level: h[1]!.length, title: h[2]!.replace(/[\s#]+$/, '').trim() } : null
}

function stepParts(line: string): string[] | null {
  if (line.length > 500) return null
  return /^(\s*(?:[-*+]|\d{1,3}[.)]) +\[)([ xX~])(\] +)([A-Za-z0-9][\w.-]{0,39}) *: *(.*)$/.exec(line)
}

function sectionsOf(lines: string[]): { goal: [number, number] | null; plan: [number, number] | null; inPlan: boolean[] } {
  const out: { goal: [number, number] | null; plan: [number, number] | null; inPlan: boolean[] } = { goal: null, plan: null, inPlan: [] }
  let open: 'goal' | 'plan' | null = null
  let plan = false
  for (let i = 0; i < lines.length; i++) {
    const h = headingOf(lines[i]!)
    if (h && h.level <= 3) {
      if (open) out[open]![1] = i
      open = null
      const t = h.level > 1 ? h.title.toLowerCase() : ''
      const kind = /^goals?\b/.test(t) ? 'goal' : /^plan\b/.test(t) ? 'plan' : null
      plan = kind === 'plan'
      if (kind && !out[kind]) {
        out[kind] = [i, lines.length]
        open = kind
      }
    }
    out.inPlan.push(plan && !h)
  }
  return out
}

function gateFacts(text: string): { phase: 'planning' | 'running'; goal: string } {
  const lines = text.slice(0, 256 * 1024).split(/\r?\n/).filter((l) => l.length <= 500)
  const head = (lines.find((l) => l.trim() !== '') ?? '').trim()
  const m = /^phase\s*:\s*(planning|running)\s*$/i.exec(head)
  const goal: string[] = []
  let inGoal = false
  for (const l of lines) {
    const h = headingOf(l)
    if (h) {
      if (h.level <= 3) inGoal = h.level > 1 && /^goals?\b/.test(h.title.toLowerCase())
      continue
    }
    if (inGoal && l.trim()) goal.push(l.trim())
  }
  return { phase: m && m[1]!.toLowerCase() === 'running' ? 'running' : 'planning', goal: goal.join('\n') }
}

const eolOf = (text: string): string => (/\r\n/.test(text) ? '\r\n' : '\n')
const trimLead = (ls: string[]): string[] => {
  let k = 0
  while (k < ls.length && ls[k] === '') k++
  return ls.slice(k)
}

export function planSummary(text: string | null): string {
  const steps = planSteps(text)
  if (!steps.length) return 'The plan has no step yet.'
  const done = new Set(steps.filter((s) => s.status === 'done').map((s) => s.id))
  const rows = steps.slice(0, 30).map((s) => {
    const wait = s.deps.filter((d) => !done.has(d))
    const how = s.status !== 'todo' ? s.status : wait.length ? `todo, waits for ${wait.join(', ')}` : 'todo, ready'
    return `- ${s.id} [${how}]: ${clip(s.text, 80)}`
  })
  const more = steps.length > 30 ? `\n- ... ${steps.length - 30} more` : ''
  return `Plan in agent-state.md (${done.size} of ${steps.length} done):\n${rows.join('\n')}${more}`
}

export function planEdit(text: string | null, input: unknown, mask: (t: string) => string): FileEdit {
  const i: Obj = isObj(input) ? input : {}
  const op = String(i.op ?? '')
  const src = text ?? 'phase: planning\n\n## Goal\n\n## Open questions\n\n## Plan\n'
  const eol = eolOf(src)
  const lines = src.split(/\r?\n/)
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  const join = (ls: string[]): string => `${ls.join(eol)}${eol}`
  const m = (v: unknown, max: number): string => clip(mask(oneLine(v)), max)
  const steps = planSteps(src)
  const sec = sectionsOf(lines)
  const ok = (out: string, answer: string): FileEdit => ({ text: out, answer: `${answer}\n${planSummary(out)}` })
  const stepAt = (id: string): number => lines.findIndex((l, k) => sec.inPlan[k] && stepParts(l)?.[4] === id)

  if (op === 'plan_goal') {
    const goal = m(i.text, 500)
    if (!goal) return { refuse: 'plan_goal needs the goal as `text`.' }
    let next: string[]
    if (sec.goal) {
      const rest = trimLead(lines.slice(sec.goal[1]))
      next = [...lines.slice(0, sec.goal[0] + 1), '', goal, ...(rest.length ? ['', ...rest] : [])]
    } else {
      const at = sec.plan ? sec.plan[0] : lines.length
      const before = lines.slice(0, at)
      while (before.length && before[before.length - 1] === '') before.pop()
      next = [...before, ...(before.length ? [''] : []), '## Goal', '', goal, ...(at < lines.length ? ['', ...lines.slice(at)] : [])]
    }
    const out = join(next)
    if (gateFacts(out).goal !== goal) return { refuse: 'Not written: the goal would not read back as given; write it as plain text, not a heading.' }
    return ok(out, 'Goal set in agent-state.md.')
  }

  if (op === 'plan_add') {
    const id = oneLine(i.id)
    if (!/^[A-Za-z0-9][\w.-]{0,39}$/.test(id)) return { refuse: 'plan_add needs an id of letters, digits, dot, dash or underscore (at most 40), e.g. t1.' }
    const old = steps.find((s) => s.id === id)
    if (oneLine(i.text).length > 400) return { refuse: 'Not written: a step is at most 400 characters; shorten it or split it into two steps.' }
    const body = (i.text === undefined || i.text === null ? '' : m(i.text, 400)) || old?.text || ''
    if (!body) return { refuse: 'plan_add needs the step as `text`.' }
    const list = (v: unknown, keep: string[] | undefined, own: boolean): string[] | string => {
      if (v === undefined || v === null) return keep ?? []
      if (!Array.isArray(v)) return 'must be a list'
      const xs = v.map((x) => (own ? mask(oneLine(x)) : oneLine(x))).filter(Boolean)
      const bad = xs.find((x) => /[\s,()]/.test(x))
      return bad !== undefined ? `"${clip(bad, 60)}" has a space, comma or parenthesis` : [...new Set(xs)].slice(0, 50)
    }
    const deps = list(i.after, old?.deps, false)
    if (typeof deps === 'string') return { refuse: `Not written: after ${deps}.` }
    const owns = list(i.owns, old?.owns, true)
    if (typeof owns === 'string') return { refuse: `Not written: owns ${owns}.` }
    const known = new Set(steps.map((s) => s.id))
    const unknown = deps.filter((d) => !known.has(d) || d === id)
    if (unknown.length) return { refuse: `Not written: after names ${unknown.join(', ')}, which ${unknown.length === 1 ? 'is' : 'are'} not another step of the plan; add ${unknown.length === 1 ? 'it' : 'them'} first.` }
    const graph = new Map<string, string[]>(steps.map((s) => [s.id, s.deps]))
    graph.set(id, deps)
    const seen = new Set<string>()
    const loops = (from: string): boolean => (graph.get(from) ?? []).some((d) => d === id || (!seen.has(d) && (seen.add(d), loops(d))))
    if (loops(id)) return { refuse: `Not written: ${id} would wait for itself through its after list.` }
    const evidence = old?.evidence
    const groups = `${deps.length ? ` (after: ${deps.join(', ')})` : ''}${owns.length ? ` (owns: ${owns.join(', ')})` : ''}${evidence ? ` (evidence: ${evidence})` : ''}`
    const at = old ? stepAt(id) : -1
    let next: string[]
    if (at >= 0) {
      const g = stepParts(lines[at]!)!
      next = [...lines]
      next[at] = `${g[1]}${g[2]}${g[3]}${id}: ${body}${groups}`
    } else {
      const line = `- [ ] ${id}: ${body}${groups}`
      if (sec.plan) {
        let last = -1
        for (let k = sec.plan[0] + 1; k < sec.plan[1]; k++) if (/^\s*(?:[-*+]|\d{1,3}[.)]) +\S/.test(lines[k]!)) last = k
        if (last >= 0) next = [...lines.slice(0, last + 1), line, ...lines.slice(last + 1)]
        else {
          const rest = trimLead(lines.slice(sec.plan[0] + 1))
          next = [...lines.slice(0, sec.plan[0] + 1), '', line, ...(rest.length ? ['', ...rest] : [])]
        }
      } else {
        const before = [...lines]
        while (before.length && before[before.length - 1] === '') before.pop()
        next = [...before, ...(before.length ? [''] : []), '## Plan', '', line]
      }
    }
    const out = join(next)
    const back = planSteps(out).find((s) => s.id === id)
    const same = !!back && back.text === body && back.deps.join(' ') === deps.join(' ') && (back.owns ?? []).join(' ') === owns.join(' ') && (back.evidence ?? '') === (evidence ?? '')
    if (!same) return { refuse: 'Not written: the step would not read back as given (a line over 500 characters, or text that ends like an "(after: ...)" group); shorten or reword it.' }
    return ok(out, `Step ${id} ${at >= 0 ? 'updated' : 'added'} in agent-state.md.`)
  }

  if (op === 'plan_set') {
    const id = oneLine(i.id)
    const want = i.step_status
    if (want !== 'todo' && want !== 'running' && want !== 'done') return { refuse: 'plan_set needs step_status todo, running or done.' }
    const old = steps.find((s) => s.id === id)
    const at = old ? stepAt(id) : -1
    if (at < 0 || !old) return { refuse: `No step "${clip(id, 40)}" in the ## Plan of agent-state.md; plan_add adds it.` }
    const given = i.evidence === undefined || i.evidence === null ? '' : m(i.evidence, 300).replace(/\(/g, '[').replace(/\)/g, ']')
    const ev = given || old.evidence || ''
    const g = stepParts(lines[at]!)!
    const deps = old.deps.length ? ` (after: ${old.deps.join(', ')})` : ''
    const owns = old.owns?.length ? ` (owns: ${old.owns.join(', ')})` : ''
    const next = [...lines]
    next[at] = `${g[1]}${want === 'done' ? 'x' : want === 'running' ? '~' : ' '}${g[3]}${id}: ${old.text}${deps}${owns}${ev ? ` (evidence: ${ev})` : ''}`
    const out = join(next)
    const back = planSteps(out).find((s) => s.id === id)
    const same = !!back && back.status === want && (back.evidence ?? '') === ev && back.text === old.text && back.deps.join(' ') === old.deps.join(' ') && (back.owns ?? []).join(' ') === (old.owns ?? []).join(' ')
    if (!same) return { refuse: 'Not written: the step line would not read back as given; check its line in agent-state.md.' }
    const hint = want === 'done' && !ev ? ' It carries no evidence; give evidence (a command and its result) where the steps table asks for it.' : ''
    return ok(out, `Step ${id} marked ${want}.${hint}`)
  }

  if (op === 'plan_run') {
    const facts = gateFacts(src)
    const missing = [!facts.goal ? 'a goal (plan_goal)' : '', !steps.length ? 'a step (plan_add)' : ''].filter(Boolean)
    if (missing.length) return { refuse: `Not running yet: agent-state.md needs ${missing.join(' and ')} first.` }
    if (facts.phase === 'running') return ok(src, 'agent-state.md already says phase: running.')
    const first = lines.findIndex((l) => l.length <= 500 && l.trim() !== '')
    const next = [...lines]
    if (first >= 0 && /^\s*\uFEFF?\s*phase\s*:/i.test(lines[first]!)) next[first] = `${/^\uFEFF/.test(lines[first]!) ? '\uFEFF' : ''}phase: running`
    else next.unshift('phase: running', '')
    const out = join(next)
    if (gateFacts(out).phase !== 'running') return { refuse: 'Not written: the first line would not read as phase: running.' }
    return ok(out, 'agent-state.md now says phase: running.')
  }
  return { refuse: `${op} is not a plan op.` }
}

export function appendLines(text: string | null, block: string[], paragraph: boolean, head: string[] = []): string {
  const t = text ?? ''
  const eol = t ? eolOf(t) : '\n'
  let out = t || (head.length ? `${head.join(eol)}${eol}${eol}` : '')
  if (out && !out.endsWith('\n')) out += eol
  if (paragraph && t && !/\n[ \t]*\r?\n$/.test(out)) out += eol
  return `${out}${block.join(eol)}${eol}`
}

const sentence = (s: string): string => (/[.!?]$/.test(s) ? s : `${s}.`)

export function decisionLine(input: unknown, date: string, mask: (t: string) => string): { line: string } | { refuse: string } {
  const i: Obj = isObj(input) ? input : {}
  const cell = (v: unknown, max: number): string => clip(mask(oneLine(v)).replace(/\|/g, '/'), max)
  const decision = cell(i.decision, 300)
  const reason = cell(i.reason, 300)
  const undo = cell(i.undo, 200)
  const missing = [decision ? '' : 'decision', reason ? '' : 'reason', undo ? '' : 'undo'].filter(Boolean)
  if (missing.length) return { refuse: `decide needs ${missing.join(', ')}.` }
  return { line: `- ${date} | ${decision} | ${reason} | alt: ${cell(i.alternatives, 200) || 'none'} | undo: ${undo}` }
}

export function lessonParagraph(input: unknown, date: string, mask: (t: string) => string): { line: string } | { refuse: string } {
  const i: Obj = isObj(input) ? input : {}
  const f = (v: unknown, max: number): string => clip(mask(oneLine(v)), max)
  const grade = /^\[?(E[0-3])\]?$/i.exec(oneLine(i.grade))?.[1]?.toUpperCase() ?? ''
  const symptom = f(i.symptom, 400)
  const cause = f(i.cause, 400)
  const next = f(i.next, 400)
  const missing = [grade ? '' : 'grade (E0-E3)', symptom ? '' : 'symptom', cause ? '' : 'cause', next ? '' : 'next'].filter(Boolean)
  if (missing.length) return { refuse: `lesson needs ${missing.join(', ')}.` }
  const context = f(i.context, 120)
  return { line: `[${grade}] ${date} ${context ? `${sentence(context)} ` : ''}Symptom: ${sentence(symptom)} Root cause: ${sentence(cause)} Next time: ${sentence(next)}` }
}

export function pendingLineOf(q: Question, date: string, undo: string): string {
  const f = askFieldsOf(q)
  const prefer = f.prefer ? oneLine(f.prefer) : ''
  const chosen = f.needs_user === false && prefer ? prefer : prefer ? `waiting (recommended: ${prefer})` : 'waiting'
  const others = (f.options ?? []).map(oneLine).filter((o) => o.toLowerCase() !== prefer.toLowerCase())
  return clip(`- [ ] ${date} ${oneLine(q.id)}: ${oneLine(q.text)}; chosen for now: ${chosen}; alternatives: ${others.join(' / ') || 'none listed'}; undo: ${oneLine(undo) || 'not given'}`, 1000)
}

export type DeliveryFacts = {
  since: string | null
  diff: { base: string; summary: string; files: string[]; untracked: number } | null
  runs: { kind: string; program: string; ok: boolean | null; at: string; subagent: boolean }[]
  unrun: string[]
  editedAfterGreen: boolean
  decisions: string[]
  review: { title: string; status: string; at: string } | null
  pendingOpen: number
}

export function deliveryDraft(f: DeliveryFacts): string {
  let unserved = false
  const t = (name: string, vars: Record<string, string | number> = {}): string => {
    const s = relText(`task_state.text.report_${name}`, vars)
    if (s === undefined) unserved = true
    return s ?? ''
  }
  const L: string[] = [t('intro'), t('result')]
  if (f.diff) {
    L.push(t('scope', { base: f.diff.base, summary: f.diff.summary || t('scope_empty') }))
    for (const x of f.diff.files.slice(0, 10)) L.push(`  ${clip(oneLine(x), 120)}`)
    if (f.diff.files.length > 10) L.push(t('more_files', { n: f.diff.files.length - 10 }))
    if (f.diff.untracked) L.push(t('untracked', { n: f.diff.untracked, s: f.diff.untracked === 1 ? '' : 's' }))
  } else L.push(t('no_git'))
  L.push(t('runs_head'))
  if (!f.runs.length) L.push(t('no_runs'))
  for (const r of f.runs.slice(-8)) {
    L.push(t('run', { kind: r.kind, program: clip(oneLine(r.program), 40), subagent: r.subagent ? t('run_subagent') : '',
      outcome: r.ok === true ? t('run_passed') : r.ok === false ? t('run_failed') : t('run_unknown'), at: r.at }))
  }
  if (f.editedAfterGreen) L.push(t('edited'))
  if (f.unrun.length) L.push(t('unrun', { kinds: f.unrun.join(', ') }))
  L.push(t('decisions_head', { since: f.since ? t('since', { date: f.since }) : t('since_today') }))
  if (!f.decisions.length) L.push(t('no_decisions'))
  for (const d of f.decisions.slice(-8)) L.push(`- ${clip(oneLine(d).replace(/^[-*]\s*/, ''), 200)}`)
  L.push(f.review
    ? t('review', { title: clip(oneLine(f.review.title), 80), status: f.review.status, at: f.review.at })
    : t('no_review'))
  if (f.pendingOpen) L.push(t('pending', { n: f.pendingOpen }))
  return unserved ? '' : L.slice(0, 40).join('\n')
}
