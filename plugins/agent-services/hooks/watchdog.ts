import { bindSession, isFinished, isSilencedHere } from './quiet'
import { vaultMask } from './vault'

type Obj = Record<string, any>

export type StallLedger = Record<string, { first: number; last: number; count: number }>
export type StallCall = {
  id: string
  tool?: string
  text?: string
  description?: string
  agentId?: string | null
  taskId?: string | null
  turnId?: string | null
  startedAt: number
  timeoutMs?: number | null
}
export type StallSnapshot = {
  session?: string
  surfaces?: number
  main?: { running?: boolean; turnId?: string | null; turnStartedAt?: number | null }
  calls?: StallCall[]
  agents?: { id: string; description?: string; startedAt?: number; lastToolAt?: number | null }[]
  autoTasks?: { id: string; command?: string; description?: string; agentId?: string | null; outputChangedAt?: number | null; redirectChangedAt?: number | null; output?: string; user?: boolean }[]
  state?: Obj | null
  ledger?: StallLedger
}
export type StallAbort =
  | { kind: 'turn'; turnId: string; callId: string; subject: string }
  | { kind: 'agent'; agentId: string; callId: string; subject: string }
  | { kind: 'task'; taskId: string; callId: string; subject: string }
export type StallPlan = {
  prompts: string[]
  sends: { agentId: string; text: string }[]
  contexts: { agentId: string | null; text: string }[]
  notifies: string[]
  aborts: StallAbort[]
  ledger: StallLedger
}

export type KeepGoingLedger = { prompt_at: number | null; prompt_rounds: number; session_rounds: number; idle_count: number; last_work?: string | null }
export type KeepGoingInput = {
  entry: 'stop' | 'idle'
  at: number
  table: Obj | null
  autonomy: string | null
  isSubagent?: boolean
  surfaces?: number
  stopHookActive?: boolean
  blocked?: boolean
  endedNormally?: boolean
  backgroundRunning?: number
  liveAgents?: number
  turnRunning?: boolean
  lastTurnEndAt?: number | null
  personPromptAt?: number | null
  usageAlert?: boolean
  state?: Obj | null
  ledger?: KeepGoingLedger | null
}
export type KeepGoingPlan = { block: string | null; prompt: string | null; ledger: KeepGoingLedger }

function fill(text: unknown, vars: Record<string, string | number>): string {
  let out = typeof text === 'string' ? text : ''
  for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v))
  return out
}

function textOf(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

function minutesOf(v: unknown, fallback: number): number {
  return (typeof v === 'number' && v > 0 ? v : fallback) * 60_000
}

function countOf(v: unknown, fallback: number): number {
  return typeof v === 'number' && v >= 0 ? Math.floor(v) : fallback
}

function mins(ms: number): number {
  return Math.max(0, Math.round(ms / 60_000))
}

function timeOf(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : t
  }
  return null
}

function oneLine(text: unknown): string {
  let s = String(text ?? '')
  try {
    s = vaultMask(s)
  } catch {}
  s = s.replace(/[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim()
  return s.length > 160 ? s.slice(0, 159) + '\u2026' : s
}

export function stallSubjectOf(tool: unknown, text: unknown): string {
  const s = `${String(tool ?? '')}\n${String(text ?? '').replace(/\s+/g, ' ').trim()}`
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `call-${h.toString(16).padStart(8, '0')}`
}

export function isSilenced(state: unknown, subject: string, session: string | undefined): boolean {
  const list = (state as Obj | null)?.silenced
  if (!Array.isArray(list)) return false
  return list.some((x: Obj) => x && x.subject === subject && (typeof x.session !== 'string' || x.session === '' || session === undefined || x.session === session))
}

export function repeatDue(ledger: StallLedger, subject: string, at: number, start: number, max: number, cap: number): boolean {
  const e = ledger[subject]
  if (!e) return cap > 0
  if (e.count >= cap) return false
  const wait = Math.min(start * 2 ** Math.max(0, e.count - 1), max)
  return at - e.last >= wait
}

function mark(ledger: StallLedger, subject: string, at: number): void {
  const e = ledger[subject]
  ledger[subject] = { first: e?.first ?? at, last: at, count: (e?.count ?? 0) + 1 }
}

function prune(ledger: StallLedger): StallLedger {
  const keys = Object.keys(ledger)
  if (keys.length <= 200) return ledger
  const held = (k: string) => k.startsWith('abort:') || k.startsWith('stop:')
  const kept = keys.filter((k) => !held(k)).sort((a, b) => ledger[b]!.last - ledger[a]!.last).slice(0, 200)
  return Object.fromEntries([...keys.filter(held), ...kept].map((k) => [k, ledger[k]!]))
}

export function redirectTargetOf(command: unknown): string | null {
  try {
    const text = typeof command === 'string' ? command.slice(0, 4000) : ''
    if (!text.trim()) return null
    let masked = ''
    let q: string | null = null
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!
      if (q) {
        masked += ch === q ? ch : 'x'
        if (ch === q) q = null
      } else {
        if (ch === '"' || ch === "'") q = ch
        masked += ch
      }
    }
    let from = 0
    for (let i = 0; i < masked.length; i++) {
      const c = masked[i]
      if (c === ';' || c === '\n' || c === '|') from = i + 1
      else if (c === '&' && masked[i - 1] !== '>' && masked[i + 1] !== '>') from = i + 1
    }
    const seg = text.slice(from)
    const mseg = masked.slice(from)
    if (!seg.trim()) return null
    const word = (i: number): string | null => {
      while (i < seg.length && /\s/.test(seg[i]!)) i++
      if (i >= seg.length) return null
      const open = seg[i]
      if (open === '"' || open === "'") {
        const end = seg.indexOf(open, i + 1)
        const w = end < 0 ? seg.slice(i + 1) : seg.slice(i + 1, end)
        return w.trim() || null
      }
      let j = i
      while (j < mseg.length && !/[\s;|&<>()]/.test(mseg[j]!)) j++
      return seg.slice(i, j) || null
    }
    const ps = /^\s*(?:out-file|set-content|add-content)\b/i.exec(mseg)
    if (ps) {
      const parts = seg.slice(ps[0].length).trim().split(/\s+/).filter(Boolean)
      const unq = (x: string | undefined) => (x ?? '').replace(/^["']|["']$/g, '') || null
      const named = parts.findIndex((x) => /^-(?:file|literal)?path$/i.test(x))
      if (named >= 0) return unq(parts[named + 1])
      return unq(parts.find((x, k) => !x.startsWith('-') && !(k > 0 && parts[k - 1]!.startsWith('-'))))
    }
    let target: string | null = null
    for (let i = 0; i < mseg.length; i++) {
      if (mseg[i] !== '>' || mseg[i - 1] === '>') continue
      const before = mseg[i - 1] ?? ''
      if (/\d/.test(before) && before !== '1') continue
      if (before === '-' || before === '=') continue
      let k = i + 1
      if (mseg[k] === '>') k++
      if (mseg[k] === '&') continue
      if (mseg[k] === '|') k++
      const w = word(k)
      if (w) target = w
    }
    return target
  } catch {
    return null
  }
}

function keptBy(pattern: unknown, text: string): boolean {
  if (typeof pattern !== 'string' || pattern === '' || pattern.length > 2000) return false
  try {
    return new RegExp(pattern, 'i').test(text.slice(0, 2000))
  } catch {
    return false
  }
}

function emptyStall(ledger: StallLedger): StallPlan {
  return { prompts: [], sends: [], contexts: [], notifies: [], aborts: [], ledger }
}

export function stallDue(snapshot: StallSnapshot, at: number, table: Obj | null): StallPlan {
  let ledger: StallLedger = {}
  try {
    ledger = { ...((snapshot?.ledger && typeof snapshot.ledger === 'object' ? snapshot.ledger : {}) as StallLedger) }
  } catch {}
  try {
    const s: Obj | null = table && typeof table === 'object' && table.stall && typeof table.stall === 'object' ? table.stall : null
    if (!s || typeof at !== 'number' || (typeof snapshot?.surfaces === 'number' && snapshot.surfaces <= 0)) return emptyStall(ledger)
    const out = emptyStall(ledger)
    const session = typeof snapshot.session === 'string' ? snapshot.session : undefined
    const state = snapshot.state ?? null
    const start = minutesOf(s.repeat_start_minutes, 2)
    const max = minutesOf(s.repeat_max_minutes, 60)
    const cap = countOf(s.max_per_subject, 3)
    const mainRunning = snapshot.main?.running === true
    const calls = Array.isArray(snapshot.calls) ? snapshot.calls.filter((c) => c && typeof c.id === 'string' && typeof c.startedAt === 'number') : []
    if (session) bindSession(session)
    const quiet = (subject: string) => isSilenced(state, subject, session) || isSilencedHere(subject)
    const toMain = (text: string) => (mainRunning ? out.contexts.push({ agentId: null, text }) : out.prompts.push(text))
    const signal = (subject: string, text: string | null, deliver: (t: string) => void, most: number = cap) => {
      if (text === null || quiet(subject) || !repeatDue(ledger, subject, at, start, max, most)) return
      mark(ledger, subject, at)
      deliver(text)
    }

    const limit = minutesOf(s.call_abort_minutes, 20)
    const hanging = new Set<string>()
    for (const c of calls) {
      const own = typeof c.timeoutMs === 'number' && Number.isFinite(c.timeoutMs) && c.timeoutMs > 0 ? c.timeoutMs : 0
      if (at - c.startedAt < Math.max(limit, own)) continue
      const agentId = typeof c.agentId === 'string' && c.agentId !== '' ? c.agentId : null
      if (agentId) hanging.add(agentId)
      const command = oneLine(c.text ?? c.description ?? '')
      const subject = stallSubjectOf(c.tool, c.text ?? c.description ?? '')
      if (quiet(subject) || keptBy(table!.kept, String(c.description ?? '')) || ledger[`abort:${c.id}`]) continue
      if ((ledger[`stop:${subject}`]?.count ?? 0) >= cap) continue
      const taskId = typeof c.taskId === 'string' && c.taskId !== '' ? c.taskId : null
      const turnId = typeof c.turnId === 'string' && c.turnId !== '' ? c.turnId : typeof snapshot.main?.turnId === 'string' && snapshot.main.turnId !== '' ? snapshot.main.turnId : null
      const vars = { tool: oneLine(c.tool ?? ''), command, minutes: mins(at - c.startedAt), subject, agent: agentId ?? '', task: taskId ?? '' }
      let abort: StallAbort | null = null
      let ask: string | null = null
      if (taskId) {
        abort = { kind: 'task', taskId, callId: c.id, subject }
        ask = textOf(s.abort_ask_task)
      } else if (agentId) {
        abort = { kind: 'agent', agentId, callId: c.id, subject }
        ask = textOf(s.abort_ask_agent)
      } else if (turnId) {
        abort = { kind: 'turn', turnId, callId: c.id, subject }
        ask = textOf(s.abort_ask)
      }
      if (abort === null || ask === null) continue
      mark(ledger, `abort:${c.id}`, at)
      mark(ledger, `stop:${subject}`, at)
      out.aborts.push(abort)
      const text = fill(ask, vars)
      if (abort.kind === 'turn') out.prompts.push(text)
      else toMain(text)
      const note = textOf(s.abort_notify)
      if (note) out.notifies.push(fill(note, vars))
    }

    const silent = minutesOf(s.subagent_silent_minutes, 15)
    const agentCap = countOf(s.subagent_silent_max, Math.min(cap, 2))
    for (const a of Array.isArray(snapshot.agents) ? snapshot.agents : []) {
      if (!a || typeof a.id !== 'string' || hanging.has(a.id) || isFinished(a.id)) continue
      if (calls.some((c) => c.agentId === a.id)) continue
      const last = typeof a.lastToolAt === 'number' ? a.lastToolAt : typeof a.startedAt === 'number' ? a.startedAt : null
      if (last === null || at - last < silent) continue
      const subject = `agent:${a.id}`
      signal(subject, textOf(s.subagent_silent) && fill(s.subagent_silent, { agent: a.id, description: oneLine(a.description ?? ''), minutes: mins(at - last), subject }), toMain, agentCap)
    }

    const still = minutesOf(s.auto_task_still_minutes, 10)
    const taskCap = countOf(s.auto_task_still_max, Math.min(cap, 2))
    const live = new Set((Array.isArray(snapshot.agents) ? snapshot.agents : []).map((a) => a?.id))
    for (const t of Array.isArray(snapshot.autoTasks) ? snapshot.autoTasks : []) {
      if (!t || typeof t.id !== 'string' || isFinished(t.id)) continue
      const target = redirectTargetOf(t.command)
      const watched = target !== null && typeof t.redirectChangedAt === 'number' ? t.redirectChangedAt : t.outputChangedAt
      if (typeof watched !== 'number' || at - watched < still) continue
      if (keptBy(table!.kept, String(t.description ?? ''))) continue
      const subject = `task:${t.id}`
      const owner = typeof t.agentId === 'string' && t.agentId !== '' && live.has(t.agentId) ? t.agentId : null
      const deliver = owner ? (x: string) => out.sends.push({ agentId: owner, text: x }) : toMain
      const command = oneLine(t.command ?? '')
      if (target !== null && typeof t.redirectChangedAt !== 'number') {
        const key = `redirect:${t.id}`
        if (quiet(subject) || ledger[key] || !textOf(s.auto_task_still)) continue
        mark(ledger, key, at)
        deliver(`${(textOf(s.auto_task_still) ?? "").split(': ', 1)[0]}: background task ${t.id} ("${command}") writes its output to ${oneLine(target)}, so its own output file stays empty by design; read ${oneLine(target)} to follow it. This note comes once.`)
        continue
      }
      const shown = textOf(s.auto_task_still) && fill(s.auto_task_still, { task: t.id, command, minutes: mins(at - watched), subject })
      const file = target !== null ? target : t.user === true && t.output ? t.output : null
      const text = shown && file ? `${shown} Output file: ${oneLine(file)}.` : shown
      signal(subject, text, deliver, taskCap)
    }

    const long = minutesOf(s.main_turn_minutes, 45)
    const turnId = typeof snapshot.main?.turnId === 'string' ? snapshot.main.turnId : ''
    const began = snapshot.main?.turnStartedAt
    const mainCall = calls.some((c) => !(typeof c.agentId === 'string' && c.agentId !== '') && !(typeof c.taskId === 'string' && c.taskId !== ''))
    if (mainRunning && !mainCall && turnId && typeof began === 'number' && at - began >= long) {
      const subject = `turn:${turnId}`
      signal(subject, textOf(s.main_turn) && fill(s.main_turn, { minutes: mins(at - began), subject }), (x) => out.contexts.push({ agentId: null, text: x }))
    }
    out.ledger = prune(ledger)
    return out
  } catch {
    return emptyStall(ledger)
  }
}


function freshLedger(l: unknown): KeepGoingLedger {
  const x = (l && typeof l === 'object' ? l : {}) as Obj
  return {
    prompt_at: typeof x.prompt_at === 'number' ? x.prompt_at : null,
    prompt_rounds: countOf(x.prompt_rounds, 0),
    session_rounds: countOf(x.session_rounds, 0),
    idle_count: countOf(x.idle_count, 0),
    last_work: typeof x.last_work === 'string' ? x.last_work : null,
  }
}

export function actionableWork(state: unknown): { items: string[]; mark: string } {
  const answered = (a: unknown): boolean => !(a === undefined || a === null || a === '')
  const s = (state && typeof state === 'object' ? state : {}) as Obj
  const kg = (s.keep_going && typeof s.keep_going === 'object' ? s.keep_going : {}) as Obj
  const said = new Set((Array.isArray(kg.waiting) ? kg.waiting : []).flatMap((w: unknown) => String(w ?? '').split(/[\s,:;()]+/)).filter(Boolean))
  const steps = openWork(s).steps.filter((id) => !said.has(id))
  const questions = Array.isArray(s.questions) ? s.questions : []
  const fills = (Array.isArray(s.placeholders) ? s.placeholders : [])
    .filter((p: Obj) => p && p.status === 'open' && typeof p.id === 'string')
    .filter((p: Obj) => {
      const qid = typeof p.question === 'string' && p.question ? p.question : (/^([A-Za-z][A-Za-z0-9_]{0,39})-[1-9][0-9]{0,3}$/.exec(p.id)?.[1] ?? '')
      const q = questions.find((x: Obj) => x && String(x.id) === qid)
      return !!q && answered(q.answer)
    })
    .map((p: Obj) => `placeholder ${p.id}`)
  const items = [...steps, ...fills]
  const tasks = (Array.isArray(s.tasks) ? s.tasks : []).filter((t: Obj) => t && steps.includes(String(t.id)))
    .map((t: Obj) => `${t.id}:${t.status}:${t.updated ?? ''}`)
  const mark = JSON.stringify([items, tasks, s.steps?.done ?? null, s.steps?.total ?? null])
  return { items, mark }
}

export function openWork(state: unknown): { steps: string[]; waiting: string[]; placeholders: number } {
  const s = (state && typeof state === 'object' ? state : {}) as Obj
  const open = (Array.isArray(s.tasks) ? s.tasks : [])
    .filter((t: Obj) => t && ['todo', 'running', 'waiting_agent'].includes(t.status))
    .map((t: Obj) => String(t.id))
  const ready = Array.isArray(s.steps?.ready) ? s.steps.ready.filter((x: unknown) => typeof x === 'string' || typeof x === 'number').map(String) : []
  const steps = [...new Set([...open, ...ready])]
  const waiting = (Array.isArray(s.questions) ? s.questions : [])
    .filter((q: Obj) => q && q.needs_user !== false && (q.answer === undefined || q.answer === null || q.answer === ''))
    .map((q: Obj) => String(q.id))
  const placeholders = (Array.isArray(s.placeholders) ? s.placeholders : []).filter((p: Obj) => p && p.status === 'open').length
  return { steps, waiting, placeholders }
}

function listOf(ids: string[], k: Obj): string {
  if (!ids.length) return typeof k.none === 'string' ? k.none : ''
  const shown = ids.slice(0, 10).map((x) => oneLine(x)).join(', ')
  return ids.length > 10 ? `${shown}${fill(k.more, { n: ids.length - 10 })}` : shown
}

export function keepGoingDue(input: KeepGoingInput): KeepGoingPlan {
  let ledger = freshLedger(input?.ledger)
  const none = (): KeepGoingPlan => ({ block: null, prompt: null, ledger })
  try {
    const k: Obj | null = input.table && typeof input.table === 'object' && input.table.keep_going && typeof input.table.keep_going === 'object' ? input.table.keep_going : null
    const at = input.at
    if (!k || typeof at !== 'number') return none()
    const person = typeof input.personPromptAt === 'number' ? input.personPromptAt : null
    if (person !== ledger.prompt_at) ledger = { ...ledger, prompt_at: person, prompt_rounds: 0, idle_count: 0 }
    const text = textOf(k.question)
    if (text === null || input.autonomy !== 'auto' || input.isSubagent === true || input.usageAlert === true) return none()
    if (typeof input.surfaces === 'number' && input.surfaces <= 0) return none()
    if ((input.backgroundRunning ?? 0) > 0 || (input.liveAgents ?? 0) > 0) return none()
    if (ledger.prompt_rounds >= countOf(k.prompt_rounds, 3) || ledger.session_rounds >= countOf(k.session_rounds, 10)) return none()
    const state = input.state && typeof input.state === 'object' ? input.state : null
    if (state === null) return none()
    const kg = state.keep_going as Obj | undefined
    if (kg?.settled === true) {
      const settledAt = timeOf(kg.at)
      const changed = timeOf(state.updated)
      const reopened = settledAt === null || (person !== null && person > settledAt) || (changed !== null && changed > settledAt)
      if (!reopened) return none()
    }
    const work = openWork(state)
    const act = actionableWork(state)
    if (!act.items.length || act.mark === ledger.last_work) return none()
    if (input.entry === 'stop') {
      if (input.stopHookActive === true || input.blocked === true || input.endedNormally === false) return none()
    } else if (input.entry === 'idle') {
      if (input.turnRunning === true || typeof input.lastTurnEndAt !== 'number') return none()
      const wait = Math.min(minutesOf(k.idle_minutes, 20) * 2 ** ledger.idle_count, minutesOf(k.idle_max_minutes, 120))
      if (at - input.lastTurnEndAt < wait) return none()
    } else return none()
    const question = fill(text, { steps: listOf(act.items, k), waiting: listOf(work.waiting, k), placeholders: work.placeholders })
    ledger = {
      ...ledger,
      last_work: act.mark,
      prompt_rounds: ledger.prompt_rounds + 1,
      session_rounds: ledger.session_rounds + 1,
      idle_count: input.entry === 'idle' ? ledger.idle_count + 1 : ledger.idle_count,
    }
    return input.entry === 'stop' ? { block: question, prompt: null, ledger } : { block: null, prompt: question, ledger }
  } catch {
    return none()
  }
}
