import type { EngineInterface } from 'claude-code'
import { checkOf, CHECK_MAX, cleanGlob, globProblem, missingParts, missingText, ownsOf } from './brief_check'
import { relText } from './reliability'

type Obj = Record<string, unknown>
export type PackResult = { ok: true; description: string; brief: string } | { ok: false; reasons: string[] }

function isObj(v: unknown): v is Obj {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function taskWords(): string[] {
  return ['lookup', 'check', 'implement', 'debug', 'tests', 'refactor', 'merge', 'plan', 'replan', 'acceptance', 'review', 'default']
}

function line(v: unknown, max: number): string {
  return String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max)
}

function textList(v: unknown, max: number): string[] | null {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v) || v.length > max) return null
  const out: string[] = []
  for (const x of v) {
    if (typeof x !== 'string') return null
    const t = x.trim()
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

export function packBrief(input: Obj): PackResult {
  const reasons: string[] = []
  const word = typeof input.word === 'string' ? input.word.trim().toLowerCase() : ''
  if (!taskWords().includes(word)) reasons.push(`word must be one of ${taskWords().join(', ')}`)
  const goal = line(input.goal, 1000)
  if (!goal) reasons.push('goal: what the agent must achieve, in one sentence')
  const writer = input.read_only !== true

  const owns = textList(input.owns, 50)
  if (owns === null) reasons.push('owns must be a list of up to 50 paths')
  const globs: string[] = []
  const served = globProblem('x') === null
  if (writer && owns && owns.length && !served) reasons.push('the plugin would not take any owns path (the served brief limits are not in yet: sign in first)')
  for (const raw of served ? owns ?? [] : []) {
    const g = /\s/.test(raw) ? null : cleanGlob(raw)
    const why = g === null ? 'not a path' : globProblem(g)
    if (g === null || why) reasons.push(`owns "${line(raw, 60)}": ${why ?? 'not a path'}`)
    else if (!globs.includes(g)) globs.push(g)
  }
  if (writer && !owns?.length) reasons.push('owns: the paths the agent may change')

  const check = line(input.check, 2000)
  if (check.length > CHECK_MAX) reasons.push(`check is longer than ${CHECK_MAX} characters`)
  if (writer && !check) reasons.push('check: the command that checks success')

  const acceptance = textList(input.acceptance, 20)
  if (acceptance === null) reasons.push('acceptance must be a list of up to 20 globs')
  const accept: string[] = []
  for (const a of acceptance ?? []) {
    if (/\s/.test(a) || a.length > 300) reasons.push(`acceptance "${line(a, 60)}": one glob without spaces, up to 300 characters`)
    else accept.push(a)
  }

  const rl = input.return_limit === undefined ? 20 : Number(input.return_limit)
  if (!Number.isInteger(rl) || rl < 1 || rl > 200) reasons.push('return_limit: a whole number from 1 to 200')

  const files = textList(input.files_to_read, 30)
  if (files === null) reasons.push('files_to_read must be a list of up to 30 paths')
  const ruled = line(input.ruled_out, 1000)
  const notes = line(input.notes, 1000)
  if (reasons.length) return { ok: false, reasons }

  let unserved = false
  const t = (name: string, vars: Record<string, string | number> = {}): string => {
    const s = relText(`brief_pack.text.${name}`, vars)
    if (s === undefined) unserved = true
    return s ?? ''
  }
  const short = goal.split(' ').slice(0, 6).join(' ').slice(0, 60)
  const description = `${word} ${short}`
  const lines: string[] = [t('goal', { goal })]
  if (writer) lines.push(t('owns', { owns: globs.join(', ') }))
  if (check) lines.push(t('check', { check }))
  if (accept.length) lines.push(t('acceptance', { acceptance: accept.join(', ') }))
  if (files && files.length) lines.push(t('read_first', { files: files.join(', ') }))
  if (ruled) lines.push(t('ruled_out', { ruled_out: ruled }))
  if (notes) lines.push(t('notes', { notes }))
  lines.push(t(writer ? 'writer_rule' : 'reader_rule'))
  lines.push(t('hand_back', { limit: rl }))
  if (unserved) return { ok: false, reasons: ['the served brief lines are not in yet: sign in first'] }
  const brief = lines.join('\n')

  const missing = missingParts(`${description}\n${brief}`, writer)
  if (missing.length) reasons.push(`the brief would still lack ${missingText(missing) || missing.join(', ')}`)
  const taken = ownsOf(brief)
  if (writer && (taken.globs.length !== globs.length || taken.dropped.length > 0)) {
    reasons.push('the plugin would not take every owns path (the served brief limits are not in yet: sign in first)')
  }
  if (check && checkOf(brief) === null) reasons.push('the plugin would not take the check line (the served brief limits are not in yet)')
  if (reasons.length) return { ok: false, reasons }
  return { ok: true, description, brief }
}

export function packAnswer(input: Obj): string {
  const r = packBrief(input)
  if (!r.ok) return `Not packed: ${r.reasons.join('; ')}. No brief was made; fix these and call brief_pack again.`
  return [
    'Packed. Pass the description and the brief to the Agent call unchanged (run_in_background true for a writer).',
    '',
    `description: ${r.description}`,
    '----- brief start -----',
    r.brief,
    '----- brief end -----',
  ].join('\n')
}

export async function briefPackTool(e: Obj): Promise<{ result: string }> {
  try {
    return { result: packAnswer(isObj(e) ? e : {}) }
  } catch {
    return { result: 'Not packed: the brief packer failed; no brief was made.' }
  }
}

export function briefPackSpec(): Record<string, unknown> {
  return {
    name: 'brief_pack',
    description: 'Format the parts of a background subagent brief so that it passes the plugin\'s brief check before the ' +
      'dispatch: give the task word (lookup, check, implement, debug, tests, refactor, merge, plan, replan, acceptance, ' +
      'review or default), the goal, the owns paths the agent may change, the check command, acceptance globs, the return ' +
      'limit, files to read, ruled-out approaches and notes. You get back the description and the brief text to pass to ' +
      'the Agent call, or the list of parts still missing (then no brief is made). Answered on this machine: nothing is ' +
      'sent to the service and nothing is written.',
    inputSchema: {
      type: 'object',
      properties: {
        word: { type: 'string', maxLength: 20, description: 'The task word the description starts with' },
        goal: { type: 'string', maxLength: 1000, description: 'What the agent must achieve, in one sentence' },
        owns: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 300 }, description: 'Paths the agent may change (globs); a writer needs at least one' },
        check: { type: 'string', maxLength: 300, description: 'The one command that checks success' },
        acceptance: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 300 }, description: 'Tests the agent must make pass and may not edit (globs)' },
        return_limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Lines of the hand-back; 20 when left out' },
        files_to_read: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 300 }, description: 'Files the agent should read first' },
        ruled_out: { type: 'string', maxLength: 1000, description: 'What was already tried and must not be repeated' },
        notes: { type: 'string', maxLength: 1000, description: 'Anything else the agent needs' },
        read_only: { type: 'boolean', description: 'true for an agent that writes no file (goal and hand-back only)' },
      },
      required: ['word', 'goal'],
      additionalProperties: false,
    },
  }
}

export async function registerBriefPack($: EngineInterface): Promise<void> {
  try {
    await $.tool.register({ ...briefPackSpec(), isDeferred: false } as any)
  } catch {}
}
