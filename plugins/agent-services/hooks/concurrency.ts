import type { EngineInterface } from 'claude-code'
import { methodsLevel } from './methods_level'
import { planSteps, PLAN_FILE } from './plan_file'
import { engineStore } from './store'
import { rulesLive } from './rules'
import { recentRows } from './session_rows'
import { toolInput } from './tools'

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
  'To skip the check for a one-part task, start the Agent description or prompt with "single use: <reason>" (for a ' +
  'SendMessage, start the message with it). The check denies a dispatch only once: sending the same call again goes ' +
  'through.'

const denied: string[] = []

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export function singleUse(text: unknown): boolean {
  return /^[\s>*_`"']*single[ -]use\s*:/i.test(str(text))
}

export function planInText(text: unknown): boolean {
  const t = str(text)
  if (/^[ \t>]*\|?[^\n|]*\btasks?\b[^\n|]*\|[^\n|]*\bdepends on\b[^\n|]*\|[^\n|]*\bowns\b[^\n|]*\|[^\n|]*\bhow it runs\b/im.test(t)) return true
  if (/^[ \t>*_`-]*tasks?\b[^\n:]{0,20}:/im.test(t) && /\bdepends on\s*:/i.test(t) && /\bowns\b[^\n:]{0,30}:/i.test(t) && /\bhow it runs\b[^\n:]{0,30}:/i.test(t)) return true
  return /^[ \t>*#_`-]*concurrency (plan|map)\b[^\n]{0,60}(:|$)/im.test(t)
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

export type Facts = { tool: string; input: Obj; agentId?: unknown; recent?: unknown; stateText?: string | null }

export function dispatchKey(tool: string, input: Obj, agentId?: unknown): string | null {
  if (agentId) return null
  if (tool === 'Agent' || tool === 'Task') {
    const description = str(input.description)
    const prompt = str(input.prompt)
    if (exemptType(input.subagent_type) || singleUse(description) || singleUse(prompt)) return null
    return `${tool}\n${description}\n${prompt.slice(0, 4000)}`
  }
  if (tool === 'SendMessage') {
    const text = str(input.message) || str(input.text) || str(input.content)
    if (singleUse(text) || !addsWork(text)) return null
    return `SendMessage\n${str(input.to)}\n${text.slice(0, 4000)}`
  }
  return null
}

export function concurrencyVerdict(f: Facts): string | null {
  const key = dispatchKey(f.tool, f.input, f.agentId)
  if (key === null || denied.includes(key)) return null
  if (planInText(recentAssistantText(f.recent)) || planInFile(f.stateText ?? null)) return null
  denied.push(key)
  if (denied.length > 200) denied.splice(0, denied.length - 200)
  return CONCURRENCY_NOTE
}

export function resetConcurrency(): void {
  denied.length = 0
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
      const key = dispatchKey(String(e.tool), input)
      if (key !== null && !denied.includes(key)) {
        note = concurrencyVerdict({ tool: String(e.tool), input, recent: await recentRows($, 60), stateText: await stateText($) })
      }
    }
  } catch {
    note = null
  }
  return note ? { deny: note } : next(e)
}

export function installConcurrency(on: any): void {
  on('tool.call', { tool: ['Agent', 'Task', 'SendMessage'] }, async ($: EngineInterface, e: Obj, next: any) => concurrencyCall($, e, next))
    .catch(($: EngineInterface, e: Obj, next: any) => next(e))
}
