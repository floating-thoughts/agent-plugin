import type { EngineInterface } from 'claude-code'
import { RX_INPUT_MAX, RX_SOURCE_MAX, rulesLive, rulesTable } from './rules'
import { keepGoingStop, taskNoteAgain, taskTick } from './task_wire'
import { resumeSubagentStop } from './resume'
import { evidenceJobEnd } from './evidence'
import { jobSubagentStop } from './jobs'
import { recoverStop } from './recover'
import { vaultMask } from './vault'
import { NOTE_PREFIX } from './review'
import { continueVia } from './stall'

type Obj = Record<string, any>
type Rule = { pattern?: string; tool?: string; first_alert_minutes?: number; repeat_minutes?: number; never?: boolean; foreground?: boolean; until?: string; reason?: string }
type Texts = Record<string, string>
type Table = {
  timers?: { threshold_minutes?: number; repeat_minutes?: number; wall_retry_minutes?: number; wall_tries?: number; tick_seconds?: number }
  auto_background?: Texts & { seconds?: number; tools?: string[] }
  rules?: Rule[]
  kept?: string
  self_check?: Texts
  shells?: Texts
  wall?: Texts
  run_command?: Texts & { whitelist?: string[]; panels?: string[]; output_cap?: number }
  alerts?: { lines?: Record<string, number>; by_reset?: Record<string, number>; labels?: Record<string, string>; note?: string; toast?: string; unknown_reset?: string }
}
type Timer = { first: number; every: number; wallRetry: number; wallTries: number; tickMs: number; autoMs: number | null; rules: Rule[] }
type Limits = { first: number; every: number } | null
type Task = { id: string; startedAt: number; description?: string }
type AutoTask = { id: string; tool: string; command: string; agentId: string | null; output: string; startedAt: number; backgroundedAt: number; endsWithCaller: boolean; isChecked: boolean; user?: boolean; description?: string }
type Wall = { at: number; tries: number; resumed: boolean }

let tasks: Task[] = []
let shellAsked: Record<string, number> = {}
let shellOwner: Record<string, string> = {}
let autoTasks: AutoTask[] = []
let walled: Record<string, Wall> = {}
let ranOutputs: string[] = []
let alertsGiven: string[] = []
let ticking = false
let loadedAt = Date.now()
let listedAt = -Infinity

function table(): Table | null {
  const t = rulesTable<Table>('watch')
  return t && typeof t === 'object' ? t : null
}

function oneLine(text: string): string {
  const s = vaultMask(String(text ?? '')).replace(/[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim()
  return s.length > 160 ? s.slice(0, 159) + '\u2026' : s
}

function fill(text: string | undefined, vars: Record<string, string | number>): string {
  let out = String(text ?? '')
  for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v))
  return out
}

const minutesOf = (v: unknown, fallback: number): number => (typeof v === 'number' && v > 0 ? v * 60_000 : fallback)
const mins = (ms: number): number => Math.max(0, Math.round(ms / 60_000))

function timerOf(t: Table): Timer {
  const x = t.timers ?? {}
  const sec = t.auto_background?.seconds
  return {
    first: minutesOf(x.threshold_minutes, 30 * 60_000),
    every: minutesOf(x.repeat_minutes, 30 * 60_000),
    wallRetry: minutesOf(x.wall_retry_minutes, 20 * 60_000),
    wallTries: typeof x.wall_tries === 'number' && x.wall_tries >= 0 ? x.wall_tries : 36,
    tickMs: typeof x.tick_seconds === 'number' && x.tick_seconds >= 1 ? x.tick_seconds * 1000 : 15_000,
    autoMs: typeof sec === 'number' && sec >= 0 ? (sec > 0 ? sec * 1000 : null) : 60_000,
    rules: Array.isArray(t.rules) ? t.rules.filter((r): r is Rule => !!r && typeof r === 'object' && !Array.isArray(r)) : [],
  }
}


export function untilOf(s: unknown): number | null {
  const m = typeof s === 'string' ? /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(s.trim()) : null
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])]
  return m[4] === undefined ? new Date(y, mo, d + 1).getTime() : new Date(y, mo, d, Number(m[4]), Number(m[5])).getTime()
}

function test(pattern: string, text: string, whole = false): boolean | null {
  if (typeof pattern !== 'string' || pattern.length > RX_SOURCE_MAX) return null
  try {
    return new RegExp(whole ? `^(?:${pattern})$` : pattern, 'i').test(String(text).slice(0, RX_INPUT_MAX))
  } catch {
    return null
  }
}

type Subject = { id: string; description?: string; tool?: string; text?: string }

function holds(r: Rule, s: Subject, at: number): boolean {
  const isForeground = s.tool !== undefined
  const text = isForeground ? `${s.tool}\n${s.text ?? ''}` : `${s.description ?? ''}\n${s.id}`
  const until = untilOf(r.until)
  if (until !== null && until <= at) return false
  if (r.tool && (!isForeground || test(r.tool, s.tool ?? '', true) !== true)) return false
  return !(r.pattern && test(r.pattern, text) !== true)
}

export function limitsFor(s: Subject, at: number): Limits {
  const t = table()
  if (!t) return null
  const timer = timerOf(t)
  for (const r of timer.rules) {
    if (r.foreground === true || !holds(r, s, at)) continue
    return r.never ? null : { first: minutesOf(r.first_alert_minutes, timer.first), every: minutesOf(r.repeat_minutes, timer.every) }
  }
  return { first: timer.first, every: timer.every }
}

export function autoBackgroundMs(call: { tool: string; text: string }, at: number): number | null {
  const t = table()
  if (!t) return null
  const timer = timerOf(t)
  const tools = Array.isArray(t.auto_background?.tools) ? t.auto_background!.tools : ['Bash', 'PowerShell']
  if (timer.autoMs === null || !tools.includes(call.tool)) return null
  return timer.rules.some((r) => r.foreground === true && holds(r, { id: '', tool: call.tool, text: call.text }, at)) ? null : timer.autoMs
}


function writtenTo(text: unknown): string | undefined {
  return /Output is being written to:\s*(.+?\.output)\b/.exec(typeof text === 'string' ? text : '')?.[1]
}

export function backgroundedOf(result: unknown, text: unknown): { id: string; output: string; endsWithCaller: boolean } | null {
  const r = (result ?? {}) as Obj
  if (typeof r.timedOutAfterMs !== 'number' || typeof r.backgroundTaskId !== 'string' || r.backgroundTaskId === '') return null
  const output = typeof r.backgroundOutputPath === 'string' && r.backgroundOutputPath !== '' ? r.backgroundOutputPath : (writtenTo(text) ?? '')
  return { id: r.backgroundTaskId, output, endsWithCaller: r.backgroundEndsWithFinalResponse === true }
}

function startedOf(result: unknown, text: unknown): { id: string; output: string } | null {
  const r = (result ?? {}) as Obj
  const id = typeof r.backgroundTaskId === 'string' && r.backgroundTaskId !== ''
    ? r.backgroundTaskId
    : /Command running in background with ID:\s*(b[a-z0-9]{8})\b/.exec(typeof text === 'string' ? text : '')?.[1]
  if (!id) return null
  const output = typeof r.backgroundOutputPath === 'string' && r.backgroundOutputPath !== '' ? r.backgroundOutputPath : (writtenTo(text) ?? '')
  return { id, output }
}

export function shellIdsIn(result: unknown): string[] {
  const text = typeof result === 'string' ? result : JSON.stringify(result ?? '')
  return [...new Set(text.match(/\b[b][a-z0-9]{8}\b/g) ?? [])]
}

function callText(e: Obj): string {
  return ['command', 'description', 'prompt', 'url'].map((k) => (typeof e[k] === 'string' ? e[k] : '')).join('\n')
}

function takeRunOutputs(): string[] {
  return ranOutputs.splice(0)
}

export async function watchBash($: EngineInterface, e: Obj, next: (e: Obj) => Promise<Obj>): Promise<Obj> {
  await rulesLive()
  const t = table()
  if (!t) return next(e)
  const startedAt = await $.clock.now()
  const auto = e.run_in_background !== true ? autoBackgroundMs({ tool: String(e.tool), text: callText(e) }, startedAt) : null
  const ran = await next(e)
  try {
    if (!ran || ran.deny !== undefined) return ran
    let done = ran
    const command = vaultMask(typeof e.command === 'string' ? e.command : '').replace(/\s+/g, ' ').trim().slice(0, 200)
    const moved = auto !== null ? backgroundedOf(ran.result, ran.text) : null
    if (moved !== null) {
      const task: AutoTask = {
        id: moved.id,
        tool: String(e.tool),
        command,
        agentId: e.agentId ?? null,
        output: moved.output,
        startedAt,
        backgroundedAt: await $.clock.now(),
        endsWithCaller: moved.endsWithCaller,
        isChecked: false,
        ...(typeof e.description === 'string' && e.description ? { description: e.description } : {}),
      }
      autoTasks = [...autoTasks.filter((x) => x.id !== task.id), task]
      if (e.agentId) shellOwner[task.id] = e.agentId
      ensureTick($, t)
      const a = t.auto_background ?? {}
      const after = typeof ran.result?.timedOutAfterMs === 'number' ? ran.result.timedOutAfterMs : auto!
      const note = fill(a.note, { tool: task.tool, seconds: Math.round(after / 1000), task: task.id, output: task.output || a.no_output || '', caller: task.endsWithCaller ? a.caller ?? '' : '' })
      done = { ...done, context: [...(done.context ?? []), note] }
    }
    const started = e.run_in_background === true && (e.tool === 'Bash' || e.tool === 'PowerShell') ? startedOf(ran.result, ran.text) : null
    if (started !== null) {
      autoTasks = [...autoTasks.filter((x) => x.id !== started.id), {
        id: started.id, tool: String(e.tool), command, agentId: e.agentId ?? null, output: started.output,
        startedAt, backgroundedAt: startedAt, endsWithCaller: false, isChecked: false, user: true,
        ...(typeof e.description === 'string' && e.description ? { description: e.description } : {}),
      }]
      ensureTick($, t)
    }
    if (e.agentId && (e.tool === 'Monitor' || e.run_in_background === true)) {
      for (const id of shellIdsIn(done.result)) shellOwner[id] = e.agentId
    }
    const notes = e.agentId ? [] : takeRunOutputs()
    return notes.length ? { ...done, context: [...(done.context ?? []), ...notes] } : done
  } catch {
    return ran
  }
}

function selfCheck(t: Table, owner: string | null, listed: unknown, at: number): string | null {
  const running = Array.isArray(listed)
    ? new Set(listed.filter((x: Obj) => /running|pending/i.test(String(x?.status ?? ''))).map((x: Obj) => x.id))
    : null
  const due: AutoTask[] = []
  const keep: AutoTask[] = []
  for (const task of autoTasks) {
    if (task.agentId !== owner) keep.push(task)
    else if (running !== null && !running.has(task.id)) continue
    else if (task.user) keep.push(task)
    else if (!task.isChecked && !(task.id in shellAsked)) due.push(task)
    else if (owner !== null && task.endsWithCaller) continue
    else keep.push(task)
  }
  autoTasks = [...keep, ...due.map((x) => ({ ...x, isChecked: true }))]
  if (!due.length) return null
  for (const task of due) shellAsked[task.id] = at
  const s = t.self_check ?? {}
  const lines = due.map((x) => fill(s.line, { tool: x.tool, command: x.command, task: x.id, minutes: mins(at - x.startedAt), output: x.output || s.no_output || '' }))
  return fill(s.text, { lines: lines.join('\n'), caller: due.some((x) => x.endsWithCaller) ? s.caller ?? '' : '' })
}

function ensureTick($: EngineInterface, t: Table): void {
  if (ticking) return
  ticking = true
  $.clock.every(timerOf(t).tickMs, () => void watchTick($).catch(() => undefined))
}

export async function watchStop($: EngineInterface, e: Obj, next: (e: Obj) => Promise<Obj>): Promise<Obj> {
  await rulesLive()
  const t = table()
  if (!t) return next(e)
  const at = await $.clock.now()
  delete walled['']
  const listed = (Array.isArray(e.background_tasks) ? e.background_tasks : []).filter(
    (x: Obj) => x?.type !== 'subagent' && /running|pending/i.test(String(x?.status ?? '')))
  const known = new Map(tasks.map((x) => [x.id, x]))
  tasks = listed.map((x: Obj) => known.get(x.id) ?? { id: String(x.id), description: x.description || x.command || x.type, startedAt: autoTasks.find((y) => y.id === x.id)?.startedAt ?? at })
  listedAt = at
  if (tasks.length) ensureTick($, t)
  const done = await next(e)
  try {
    if (!done || done.block !== undefined) return done
    const check = selfCheck(t, null, e.background_tasks, at)
    if (check !== null) return (await continueVia($, 'self_check', 'stop', { at })).ok ? { ...done, block: check } : done
    const empty = await recoverStop($, e)
    if (empty !== null) return { ...done, block: empty }
    return await keepGoingStop($, e, done, (l) => alertsOf(l).length > 0)
  } catch {
    return done
  }
}

export function watchEnsureTick($: EngineInterface): void {
  try {
    const t = table()
    if (t) ensureTick($, t)
  } catch {
  }
}

export async function watchSubagentStop($: EngineInterface, e: Obj, next: (e: Obj) => Promise<Obj>): Promise<Obj> {
  await rulesLive()
  const t = table()
  if (!t) return next(e)
  const at = await $.clock.now()
  const id = typeof e.agent_id === 'string' ? e.agent_id : ''
  if (id && walled[id]?.resumed) delete walled[id]
  const done = await next(e)
  try {
    if (!done || done.block !== undefined || !id) return done
    const check = selfCheck(t, id, e.background_tasks, at)
    if (check === null) {
      await jobSubagentStop($, id)
      await evidenceJobEnd($, id)
      await resumeSubagentStop($, e)
    }
    return check === null ? done : { ...done, block: check }
  } catch {
    return done
  }
}

export async function watchFailure($: EngineInterface, e: Obj, next: (e: Obj) => Promise<Obj>): Promise<Obj> {
  await rulesLive()
  const t = table()
  if (t && e?.error === 'rate_limit') {
    const at = await $.clock.now()
    const id = typeof e.agent_id === 'string' ? e.agent_id : ''
    const w = walled[id]
    walled[id] = { at: w?.at ?? at, tries: w?.tries ?? 0, resumed: false }
    ensureTick($, t)
  }
  return next(e)
}


export function shellsDue<T extends Task>(list: T[], at: number, asked: Record<string, number>, since: number): T[] {
  const kept = table()?.kept
  return list.filter((x) => {
    const l = limitsFor(x, at)
    if (l === null || (kept && test(kept, x.description ?? '') === true) || at - x.startedAt < l.first) return false
    const last = asked[x.id] ?? (x.startedAt < since ? since : null)
    return last === null || at - last >= l.every
  })
}

export function watchDue(at: number, live: string[]): { prompts: string[]; sends: { agentId: string; text: string }[] } {
  const out = { prompts: [] as string[], sends: [] as { agentId: string; text: string }[] }
  const t = table()
  if (!t) return out
  const timer = timerOf(t)
  const running = new Set(live)
  const due = shellsDue(tasks.filter((x) => !(shellOwner[x.id] && running.has(shellOwner[x.id]!))), at, shellAsked, loadedAt)
  if (due.length) {
    const s = t.shells ?? {}
    const lines = due.map((x) => {
      shellAsked[x.id] = at
      return fill(s.line, { description: oneLine(x.description ?? ''), task: x.id, minutes: mins(at - x.startedAt) })
    })
    out.prompts.push(fill(s.text, { lines: lines.join('\n') }))
  }
  for (const [id, w] of Object.entries(walled)) {
    if (id && running.has(id)) {
      w.resumed = true
      continue
    }
    if (at - w.at < timer.wallRetry) continue
    if (w.tries >= timer.wallTries) {
      delete walled[id]
      continue
    }
    walled[id] = { at, tries: w.tries + 1, resumed: w.resumed }
    const raw: unknown = id ? t.wall?.sub : t.wall?.main
    const text = typeof raw === 'string' ? raw : ''
    if (!text.trim()) continue
    if (id) out.sends.push({ agentId: id, text })
    else out.prompts.push(text)
  }
  return out
}

export async function watchTick($: EngineInterface): Promise<void> {
  await rulesLive()
  if (!table() || (await $.session.surfaces()).length === 0) return
  const at = await $.clock.now()
  const listed = await $.agent.list()
  const live = listed.filter((a: Obj) => /pending|running|waiting/i.test(String(a?.status ?? ''))).map((a: Obj) => String(a.id))
  const plan = watchDue(at, live)
  const wall: unknown = table()?.wall?.main
  for (const text of plan.prompts) {
    if (typeof wall === 'string' && text === wall && !(await continueVia($, 'wall', 'stop', { at })).ok) continue
    await $.prompt.submit({ text }).catch(() => undefined)
  }
  for (const s of plan.sends) await $.session.send({ to: { agentId: s.agentId }, text: s.text } as any).catch(() => undefined)
  const kept = table()?.kept
  const own = autoTasks.filter((x) => x.agentId === null || x.user === true).flatMap((x) => {
    const k = tasks.find((y) => y.id === x.id)
    if (!k && x.backgroundedAt <= listedAt) return []
    const description = String(k?.description ?? (x.description || x.command))
    if (limitsFor({ id: x.id, description }, at) === null || (kept && test(kept, description) === true)) return []
    return [{ ...x, description }]
  })
  await taskTick($, at, listed as Obj[], own, tasks.length, (l) => alertsOf(l).length > 0)
}


export function checkRun(command: unknown, args: unknown): { ok: true; command: string; args: string } | { ok: false; text: string } {
  const rc = table()?.run_command ?? {}
  const name = typeof command === 'string' ? command.trim() : ''
  const rest = typeof args === 'string' ? args.trim() : ''
  const list = Array.isArray(rc.whitelist) ? rc.whitelist : []
  if (name !== '' && list.includes(name)) return { ok: true, command: name, args: rest }
  const shown = name === '' ? rc.no_name ?? '' : `/${name}${rest ? ` ${rest}` : ''}`
  const panels = Array.isArray(rc.panels) ? rc.panels : []
  return { ok: false, text: fill(panels.includes(name) ? rc.panel : rc.refused, { shown, list: list.join(', ') }) }
}

export function outputOf(text: unknown): string {
  const rc = table()?.run_command ?? {}
  const trimmed = (typeof text === 'string' ? text : '').trim()
  if (trimmed === '') return rc.empty ?? ''
  const cap = typeof rc.output_cap === 'number' && rc.output_cap > 0 ? rc.output_cap : 4000
  const chars = [...trimmed]
  return chars.length > cap ? chars.slice(0, cap).join('') + fill(rc.cut, { total: chars.length, cap }) : trimmed
}

const labelOf = (command: string, args: string): string => (args ? `${command} ${args}` : command)

export async function runQueued($: EngineInterface, command: string, args: string): Promise<void> {
  const rc = table()?.run_command ?? {}
  let text: string
  try {
    text = outputOf((await $.command.run({ command, args } as any))?.text)
  } catch (err) {
    text = fill(rc.failed, { error: err instanceof Error ? err.message : String(err) })
  }
  ranOutputs.push(fill(rc.output, { label: labelOf(command, args), text }))
}

export async function runCommandTool($: EngineInterface, e: Obj): Promise<{ result: string }> {
  await rulesLive()
  const rc = table()?.run_command
  if (!rc) return { result: `${NOTE_PREFIX}: run_command is off until the rule tables have arrived; carry on without it.` }
  if (e?.agentId) return { result: rc.subagent ?? '' }
  const c = checkRun(e?.command, e?.args)
  if (!c.ok) return { result: c.text }
  $.clock.after(0, () => void runQueued($, c.command, c.args).catch(() => undefined))
  return { result: fill(rc.queued, { label: labelOf(c.command, c.args) }) }
}


export function alertsOf(limits: unknown): { key: string; toast: string; note: string }[] {
  const a = table()?.alerts
  if (!a || !Array.isArray(limits)) return []
  const out: { key: string; toast: string; note: string }[] = []
  for (const l of limits as Obj[]) {
    const label = a.labels?.[l?.kind]
    const reset = typeof l?.resetsAt === 'string' ? l.resetsAt : null
    const byReset = reset ? a.by_reset?.[reset.slice(0, 10)] : undefined
    const line = typeof byReset === 'number' ? byReset : a.lines?.[l?.kind]
    if (!label || typeof line !== 'number' || typeof l.percentUsed !== 'number' || l.percentUsed < line) continue
    const vars = { label, used: Math.round(l.percentUsed), line, resets: reset ?? a.unknown_reset ?? '' }
    out.push({ key: `${l.kind}:${reset ?? ''}`, toast: fill(a.toast, vars), note: fill(a.note, vars) })
  }
  return out
}

export async function watchPrompt($: EngineInterface, e: Obj): Promise<string[]> {
  await rulesLive()
  try {
    if (e?.agentId || !table()) return []
    const notes = takeRunOutputs()
    const usage = await $.session.usage()
    for (const a of alertsOf(usage?.rateLimits)) {
      if (alertsGiven.includes(a.key)) continue
      alertsGiven = [...alertsGiven, a.key].slice(-10)
      notes.push(a.note)
      try {
        $.ui.toast(a.toast)
      } catch {}
    }
    return notes
  } catch {
    return []
  }
}


export function parallelStats(spans: [number, number][]): { serial: number; saved: number } {
  const sorted = spansOf(spans).filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0])
  let total = 0
  let covered = 0
  let start = -Infinity
  let end = -Infinity
  for (const [s, e] of sorted) {
    total += e - s
    if (s > end) {
      if (end > start) covered += end - start
      start = s
      end = e
    } else if (e > end) end = e
  }
  if (end > start) covered += end - start
  return { serial: total, saved: total - covered }
}

export function duration(ms: number): string {
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${m}m`
  const h = ms / 3_600_000
  return h < 10 ? `${Math.round(h * 10) / 10}h` : `${Math.round(h)}h`
}

export function spansOf(value: unknown): [number, number][] {
  return Array.isArray(value)
    ? value.filter((v): v is [number, number] => Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number')
    : []
}


export function installWatch(on: any): void {
  on('tool.call', { tool: ['Bash', 'PowerShell', 'Monitor'] }, async ($: EngineInterface, e: Obj, next: any) => watchBash($, e, next))
    .catch(($: EngineInterface, e: Obj, next: any) => next(e))
  on('classic.Stop', { stop_hook_active: [true, false] }, async ($: EngineInterface, e: Obj, next: any) => watchStop($, e, next))
    .catch(($: EngineInterface, e: Obj, next: any) => next(e))
  on('classic.SubagentStop', { stop_hook_active: [true, false] }, async ($: EngineInterface, e: Obj, next: any) => watchSubagentStop($, e, next))
    .catch(($: EngineInterface, e: Obj, next: any) => next(e))
  on('classic.StopFailure', { error: 'rate_limit' }, async ($: EngineInterface, e: Obj, next: any) => watchFailure($, e, next))
    .catch(($: EngineInterface, e: Obj, next: any) => next(e))
}

export function watchAgain(): void {
  alertsGiven = []
  taskNoteAgain()
}

export function watchResetForTest(since = 0): void {
  tasks = []
  shellAsked = {}
  shellOwner = {}
  autoTasks = []
  walled = {}
  ranOutputs = []
  alertsGiven = []
  ticking = false
  loadedAt = since
  listedAt = -Infinity
}
