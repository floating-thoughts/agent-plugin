import type { EngineInterface } from 'claude-code'
import { dataDir } from './engine_env'
import { methodsLevel } from './methods_level'
import { planSteps, PLAN_FILE } from './plan_file'
import { engineStore } from './store'
import { rulesLive, servedValue } from './rules'
import { asRows, holdsToolUse, recentRaw, transcriptRows } from './session_rows'
import { toolInput } from './tools'
import { TYPE_WORDS } from './transcripts'

type Obj = Record<string, any>
type Msg = { role?: unknown; text?: unknown; toolResults?: unknown }

export const CONCURRENCY_EXEMPT_TYPES: readonly string[] = ['web-fetch', 'Explore', 'claude-code-guide']

export const CONCURRENCY_NOTE =
  'agent-services: this dispatch was stopped once by the concurrency plan check. Before every subagent dispatch ' +
  '(an Agent call, or a SendMessage that adds new work to a running subagent) it looks for a concurrency plan, so ' +
  'that independent work runs in parallel instead of one agent doing it in sequence; none was found in your recent ' +
  'replies or in agent-state.md.\n' +
  'To satisfy it, write the plan in your reply as a table (or one line per task with the same four fields): ' +
  'Task | Depends on | Owns (files or scope) | How it runs (now in parallel / worktree / after X / merged by main). ' +
  'For example:\n' +
  '| Task | Depends on | Owns | How it runs |\n' +
  '| A fix failure hooks | none | plugin/hooks/failure* | now, main checkout |\n' +
  '| B dispatch check | none | plugin/hooks/dispatch* | now, worktree |\n' +
  '| C merge | A, B | shared hook manifest | after A and B, main session |\n' +
  'Step lines with (after: ...) and (owns: ...) in agent-state.md count too. Then dispatch the independent tasks as ' +
  'separate agents in one reply, with owned files that do not overlap; give a shared file to one owner, or use a ' +
  'separate git worktree and merge.\n' +
  'The surest places are step lines in agent-state.md or the plan inside the dispatch prompt itself (the table, or a ' +
  'line "Plan: Task ...; Depends on: ...; Owns: ...; How it runs: ..."; for a SendMessage, inside the message). An ' +
  'earlier reply\'s text may also count if it was saved; a plan written only in thinking is never read.\n' +
  'To skip the check for a one-part task, start the Agent description or prompt with "single use: <reason>", or put it ' +
  'right after the leading task word ("implement single use: <reason>"); for a SendMessage, start the message with it. ' +
  'The check denies a dispatch only once: an Agent call sent again with the same description and subagent type goes ' +
  'through even if its prompt changed, and a SendMessage is stopped at most once per recipient, so sending it again ' +
  'goes through. A SendMessage that replies to another session or to an agent that messaged you is not checked.'

const denied: string[] = []
const spawned: string[] = []
const live = { text: '', block: -1 }

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export function singleUse(text: unknown): boolean {
  const t = str(text).replace(/^[\s>*_`"']+/, '')
  if (/^single[ -]use\s*:/i.test(t)) return true
  const word = /^([^\s:]+)\s*:?\s+([\s\S]*)$/.exec(t)
  if (!word) return false
  const w = word[1].toLowerCase()
  return (w === 'final-review' || TYPE_WORDS.includes(w)) && /^single[ -]use\s*:/i.test(word[2])
}

const norm = (v: unknown): string => str(v).toLowerCase().replace(/\s+/g, ' ').trim()

export function replySenders(messages: unknown): string[] {
  const out: string[] = []
  if (!Array.isArray(messages)) return out
  for (const m of messages) {
    let text = ''
    try {
      const parts = [(m as Obj)?.content, (m as Obj)?.message?.content, (m as Obj)?.text]
      text = parts.map((c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: Obj) => str(b?.text)).join('\n') : '')).join('\n')
    } catch {}
    for (const hit of text.matchAll(/<(?:cross-session-message|teammate-message)\b[^>]*?\b(?:from|teammate_id)="([^"]{1,300})"/g)) {
      if (!out.includes(hit[1])) out.push(hit[1])
    }
  }
  return out
}

export function inProcessTarget(to: unknown, senders: readonly string[]): boolean {
  const t = str(to).trim()
  if (!t || senders.some((s) => norm(s) === norm(t))) return false
  if (/^a[0-9a-f]{16,}$/i.test(t) || spawned.includes(norm(t))) return true
  return !(/^(?:uds|bridge|local|session|cloud)[:_]/i.test(t) || /\s\[[^\]]*\]$/.test(t) || /^main$/i.test(t) || /\s/.test(t))
}

export function noteSpawn(input: Obj): void {
  const n = norm(input?.name)
  if (!n || spawned.includes(n)) return
  spawned.push(n)
  if (spawned.length > 200) spawned.splice(0, spawned.length - 200)
}

export type PlanWords = { task: string[]; depends: string[]; owns: string[]; runs: string[]; separators: string[]; colons: string[] }

export function planWords(): PlanWords {
  const fallback: PlanWords = { task: ['task', 'tasks'], depends: ['depends on'], owns: ['owns'], runs: ['how it runs'], separators: ['|'], colons: [':'] }
  const served = servedValue('concurrency', 'plan_header')
  const s: Obj = served && typeof served === 'object' && !Array.isArray(served) ? (served as Obj) : {}
  const out = { ...fallback }
  for (const k of Object.keys(fallback) as (keyof PlanWords)[]) {
    const v = s[k]
    const max = k === 'separators' || k === 'colons' ? 1 : 40
    if (Array.isArray(v) && v.length > 0 && v.length <= 20 && v.every((w) => typeof w === 'string' && w.trim() !== '' && w.length <= max)) out[k] = v as string[]
  }
  return out
}

const rxEsc = (w: string): string => w.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
const rxWord = (w: string): string => `${/^\w/.test(w) ? '\\b' : ''}${rxEsc(w)}${/\w$/.test(w) ? '\\b' : ''}`
const rxAny = (ws: string[]): string => `(?:${ws.map(rxWord).join('|')})`

export function planInText(text: unknown): boolean {
  const t = str(text)
  const w = planWords()
  const [T, D, O, R] = [rxAny(w.task), rxAny(w.depends), rxAny(w.owns), rxAny(w.runs)]
  const seps = w.separators.map(rxEsc).join('')
  const colons = w.colons.map(rxEsc).join('')
  const S = `[${seps}]`
  const N = `[^\\n${seps}]`
  if (new RegExp(`^[ \\t>]*${S}?${N}*${T}${N}*${S}${N}*${D}${N}*${S}${N}*${O}${N}*${S}${N}*${R}`, 'im').test(t)) return true
  const C = `[${colons}]`
  const NC = `[^\\n${colons}]`
  if (new RegExp(`^[ \\t>*_\`-]*${T}${NC}{0,20}${C}`, 'im').test(t) && new RegExp(`${D}\\s*${C}`, 'i').test(t) &&
    new RegExp(`${O}${NC}{0,30}${C}`, 'i').test(t) && new RegExp(`${R}${NC}{0,30}${C}`, 'i').test(t)) return true
  const plan = /^[ \t>*_`-]*plan\s*:([^\n]*)$/im.exec(t)
  if (plan && [T, D, O, R].every((f) => new RegExp(f, 'i').test(plan[1]))) return true
  return /^[ \t>*#_`-]*concurrency (plan|map)\b[^\n]{0,60}(:|$)/im.test(t)
}

export function dispatchText(tool: string, input: Obj): string {
  if (tool === 'SendMessage') return str(input.message) || str(input.text) || str(input.content)
  return tool === 'Agent' || tool === 'Task' ? str(input.prompt) : ''
}

export function planInFile(stateText: string | null): boolean {
  return planSteps(stateText).some((s) => s.status !== 'done' && (s.deps.length > 0 || (s.owns?.length ?? 0) > 0))
}

export function recentAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return ''
  const out: string[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Msg
    if (!m || typeof m !== 'object') continue
    if (m.role === 'assistant') out.push(str(m.text))
    else if (m.role === 'user') {
      const t = str(m.text).trim()
      const results = Array.isArray(m.toolResults) && m.toolResults.length > 0
      if (t && !results && !t.startsWith('<')) break
    }
  }
  return out.reverse().join('\n')
}

export function addsWork(text: unknown): boolean {
  const t = str(text).trim()
  const strong = /\b(also|additionally|in addition|one more|another (task|thing|part|requirement)|new requirement|implement|add|fix|build|change|refactor|create|extend)\b/i
  if (t.length < 400 && /\b(report|status|summary|summari[sz]e|stop|hand ?back|wrap up)\b/i.test(t)) return strong.test(t)
  if (t.length >= 200) return true
  return strong.test(t) || /\b(and then|write|update)\b/i.test(t)
}

export function exemptType(subagentType: unknown): boolean {
  const t = str(subagentType)
  return CONCURRENCY_EXEMPT_TYPES.includes(t) || /:explore$/i.test(t)
}

export type Facts = { tool: string; input: Obj; agentId?: unknown; recent?: unknown; stateText?: string | null; liveText?: unknown; senders?: readonly string[] }

export function dispatchKey(tool: string, input: Obj, agentId?: unknown, senders: readonly string[] = []): string | null {
  if (agentId) return null
  if (tool === 'Agent' || tool === 'Task') {
    const description = str(input.description)
    const prompt = str(input.prompt)
    if (exemptType(input.subagent_type) || singleUse(description) || singleUse(prompt)) return null
    return `Agent\n${norm(description) || norm(prompt.slice(0, 400)).slice(0, 200)}\n${str(input.subagent_type)}`
  }
  if (tool === 'SendMessage') {
    const text = str(input.message) || str(input.text) || str(input.content)
    if (singleUse(text) || !addsWork(text) || !inProcessTarget(input.to, senders)) return null
    return `SendMessage\n${norm(input.to)}`
  }
  return null
}

export function concurrencyVerdict(f: Facts): string | null {
  const key = dispatchKey(f.tool, f.input, f.agentId, f.senders ?? [])
  if (key === null || denied.includes(key)) return null
  if (planInText(dispatchText(f.tool, f.input)) || planInText(`${recentAssistantText(f.recent)}\n${str(f.liveText)}`) || planInFile(f.stateText ?? null)) return null
  denied.push(key)
  if (denied.length > 200) denied.splice(0, denied.length - 200)
  return CONCURRENCY_NOTE
}

export function resetConcurrency(): void {
  denied.length = 0
  spawned.length = 0
  liveStep(undefined)
}

export function liveStep(agentId: unknown): void {
  if (agentId) return
  live.text = ''
  live.block = -1
}

export function liveChunk(agentId: unknown, chunk: unknown): void {
  if (agentId || !chunk || typeof chunk !== 'object') return
  const c = chunk as Obj
  if (c.kind !== 'text' || typeof c.text !== 'string' || live.text.length > 64 * 1024) return
  if (live.block !== -1 && c.index !== live.block) live.text += '\n'
  live.block = typeof c.index === 'number' ? c.index : live.block
  live.text += c.text
}

export function liveStepText(): string {
  return live.text
}

export async function* stepWatch($: EngineInterface, e: Obj, next: any): AsyncGenerator<any, any> {
  liveStep(e?.agentId)
  const stream = next(e)
  const it = typeof stream?.next === 'function' ? stream : stream[Symbol.asyncIterator]()
  for (;;) {
    const r = await it.next()
    if (r.done) return r.value
    try {
      liveChunk(e?.agentId, r.value)
    } catch {}
    yield r.value
  }
}

export function traceLine(f: { e: Obj; form: string; raw: unknown[]; liveText: string; transcript: unknown[] | null; verdict: string | null }): Obj {
  const cut = (v: unknown): string => str(v).slice(0, 200)
  const shape = (m: unknown): Obj => {
    if (!m || typeof m !== 'object') return { kind: typeof m }
    const o = m as Obj
    const content = o.content ?? o.message?.content
    return {
      keys: Object.keys(o).slice(0, 12),
      role: o.role ?? o.message?.role ?? o.type,
      content: typeof content === 'string' ? `string:${content.length}` : Array.isArray(content) ? content.map((b: Obj) => str(b?.type) || typeof b) : typeof content,
      text: cut(asRows([o])[0]?.text),
    }
  }
  return {
    at: Date.now(),
    tool: str(f.e.tool),
    toolUseId: str(f.e.tool_use_id),
    eventKeys: Object.keys(f.e).slice(0, 30),
    form: f.form,
    count: f.raw.length,
    holdsCall: holdsToolUse(f.raw, f.e.tool_use_id),
    tail: f.raw.slice(-6).map(shape),
    liveLength: f.liveText.length,
    live: cut(f.liveText.slice(-200)),
    transcript: f.transcript === null ? null : { count: f.transcript.length, tail: f.transcript.slice(-4).map(shape) },
    denied: f.verdict !== null,
  }
}

async function traceOn($: EngineInterface): Promise<boolean> {
  try {
    return String((await $.env.get('AS_TRACE_CONCURRENCY')) ?? '').trim() === '1'
  } catch {
    return false
  }
}

async function traceWrite($: EngineInterface, line: Obj): Promise<void> {
  try {
    const path = `${await dataDir($)}/trace-concurrency.jsonl`
    let old = ''
    try {
      old = String(await $.fs.read(path))
    } catch {}
    if (old.length > 1024 * 1024) old = old.slice(-512 * 1024).replace(/^[^\n]*\n/, '')
    await $.fs.write(path, `${old}${JSON.stringify(line)}\n`)
  } catch {}
}

async function stateText($: EngineInterface): Promise<string | null> {
  let dir = ''
  try {
    dir = String((await $.session.cwd()) ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  } catch {}
  for (let i = 0; dir && i < 9; i++) {
    try {
      const text = String(await $.fs.read(`${dir}/${PLAN_FILE}`))
      return text.length > 256 * 1024 ? null : text
    } catch {}
    const up = dir.replace(/\/[^/]*$/, '')
    if (!up || up === dir || !up.includes('/')) break
    dir = up
  }
  return null
}

export async function concurrencyCall($: EngineInterface, e: Obj, next: any, live?: boolean): Promise<any> {
  let note: string | null = null
  try {
    if (!e.agentId && (live ?? (await rulesLive())) && (await methodsLevel(engineStore($))) !== 'off') {
      const input = toolInput(e)
      const got = String(e.tool) === 'SendMessage' ? await recentRaw($, 60) : null
      const senders = got ? replySenders(got.messages) : []
      const key = dispatchKey(String(e.tool), input, undefined, senders)
      if (key !== null && !denied.includes(key)) {
        const raw = got ?? (await recentRaw($, 60))
        const recent = asRows(raw.messages)
        const liveText = liveStepText()
        const plan = await stateText($)
        let transcript: unknown[] | null = null
        let extra = ''
        if (!planInText(dispatchText(String(e.tool), input)) && !planInText(`${recentAssistantText(recent)}\n${liveText}`) && !planInFile(plan)) {
          transcript = await transcriptRows($, 60)
          extra = recentAssistantText(transcript)
        }
        note = concurrencyVerdict({ tool: String(e.tool), input, recent, liveText: `${liveText}\n${extra}`, stateText: plan, senders })
        if (await traceOn($)) await traceWrite($, traceLine({ e, form: raw.form, raw: raw.messages, liveText, transcript, verdict: note }))
      }
    }
  } catch {
    note = null
  }
  if (note) return { deny: note }
  if (e.tool === 'Agent' || e.tool === 'Task') {
    try {
      noteSpawn(toolInput(e))
    } catch {}
  }
  return next(e)
}

export function installConcurrency(on: any): void {
  on('tool.call', { tool: ['Agent', 'Task', 'SendMessage'] }, async ($: EngineInterface, e: Obj, next: any) => concurrencyCall($, e, next))
    .catch(($: EngineInterface, e: Obj, next: any) => next(e))
}
