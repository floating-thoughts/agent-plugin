import type { EngineInterface } from 'claude-code'
import { CHECKPOINT_MARK } from './core'
import { checkpointToolName, setCheckpointTool } from './flow_state'
import { captureCheckpoint } from './task_wire'
import { resumeCheckpoint } from './resume'
import { handoverReceipts } from './evidence'
import { servedInt, servedText } from './workflow_table'
import { continueVia } from './stall'
import { nudgeAnswered } from './checkpoint_nudge'

export const CHECKPOINT_TOOL = 'mcp__agent-services__checkpoint'
export const CHECKPOINT_DESCRIPTION =
  'Mark a checkpoint (agent-services): once your current reply ends, the conversation is compacted into a summary ' +
  'that keeps what you list, and your next step, if you give one, comes back to you as a message so the work goes ' +
  'on from the summary. Use it after a finished, verified piece of work, ' +
  'or before starting an unrelated new task. In `keep`, list what the summary must preserve: decisions and ' +
  'reasons, file paths, commands, open problems, what the user asked to remember. Leave `next` out when the work is ' +
  'done or waits for the user. Call it at most once per turn, then finish the reply.'

type Mark = { milestone: string; keep: string; next: string }
type Obj = Record<string, unknown>

let marked: Mark | null = null
let compacting = false
let personSpoke = false
let compactRefusals = 0

const str = (v: unknown, n: number): string => (typeof v === 'string' ? [...v.trim()].slice(0, n).join('') : '')

export function otherCheckpoint(names: readonly string[]): string | null {
  return names.find((n) => /^mcp__.+__checkpoint$/.test(n) && n !== CHECKPOINT_TOOL) ?? null
}

export async function setupCheckpoint($: EngineInterface): Promise<void> {
  let names: string[] = []
  try {
    names = (await $.tool.list()).map((t) => String(t.name))
  } catch {}
  const other = otherCheckpoint(names)
  if (other) return setCheckpointTool(other)
  try {
    await $.tool.register({
      name: 'checkpoint',
      description: CHECKPOINT_DESCRIPTION,
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          milestone: { type: 'string', description: 'The milestone just finished, in a few words' },
          keep: { type: 'string', description: 'What the summary must preserve to carry on' },
          next: { type: 'string', description: 'The next concrete step, sent back after the compaction; leave out when done' },
        },
        required: ['milestone', 'keep'],
      },
    } as any)
    setCheckpointTool(CHECKPOINT_TOOL)
  } catch {}
}

export async function recheckCheckpoint($: EngineInterface): Promise<void> {
  if (checkpointToolName() !== CHECKPOINT_TOOL) return
  try {
    const other = otherCheckpoint((await $.tool.list()).map((t) => String(t.name)))
    if (other) setCheckpointTool(other)
  } catch {}
}

export async function checkpointCall($: EngineInterface, e: Obj): Promise<{ result: string }> {
  if (e.agentId) return { result: 'Only the main conversation can mark a checkpoint; carry on with your task.' }
  nudgeAnswered()
  const other = checkpointToolName()
  if (other && other !== CHECKPOINT_TOOL) return { result: `This session has another checkpoint tool, ${other}: use that one. Nothing was marked.` }
  if (compacting) return { result: 'A checkpoint is already being compacted; this one adds nothing. Finish your reply now.' }
  let tokens: number | null = null
  try {
    const t = (await $.session.usage()).context.tokens
    tokens = typeof t === 'number' ? t : null
  } catch {}
  const short = tokens === null ? null : checkpointShort(tokens)
  if (short) return { result: short }
  const milestone = str(e.milestone, 200) || 'milestone'
  const next = str(e.next, 2000)
  const how = servedText('checkpoint', marked !== null ? 'how_again' : 'how_first')
  const after = servedText('checkpoint', next ? 'after_next' : 'after_none')
  const answer = how && after ? servedText('checkpoint', 'recorded', { milestone, how, after }) : null
  if (!answer || servedInt('checkpoint', 'min_tokens', 0) === null) {
    return { result: 'The checkpoint is not available yet (the agent-services rule tables have not arrived): nothing was marked. Carry on.' }
  }
  marked = { milestone, keep: str(e.keep, 4000), next }
  personSpoke = false
  await captureCheckpoint($, milestone, next)
  await resumeCheckpoint($, milestone, next, await handoverReceipts($))
  return { result: answer }
}

export function checkpointShort(tokens: number): string | null {
  const min = servedInt('checkpoint', 'min_tokens', 0)
  return min !== null && tokens < min ? servedText('checkpoint', 'short', { tokens }) : null
}

export function checkpointPersonPrompt(): void {
  personSpoke = true
}

export function checkpointInstructions(m: Mark): string {
  return `${CHECKPOINT_MARK} ${m.milestone}.\nThe summary must keep: ${m.keep || 'the decisions, file paths and open problems so far'}` +
    (m.next ? `\nThe next step after the compaction: ${m.next}` : '')
}

async function compactBy($: EngineInterface, instructions: string): Promise<string | null> {
  if (compactRefusals < 3) {
    try {
      const done: Obj = (await $.session.compact({ instructions })) as any
      compactRefusals = 0
      return typeof done?.skip === 'string' ? done.skip : null
    } catch {
      compactRefusals += 1
    }
  }
  const out: Obj = (await $.command.run({ command: 'compact', args: instructions.replace(/\s*\n\s*/g, ' ') })) as any
  const text = typeof out?.text === 'string' ? out.text : undefined
  return text !== undefined && !/^\s*compacted\b/i.test(text) ? text.trim() : null
}

async function compactThenResume($: EngineInterface, m: Mark): Promise<void> {
  let failure: string | null = null
  try {
    failure = await compactBy($, checkpointInstructions(m))
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err)
  }
  compacting = false
  try {
    $.ui.log(failure === null ? `agent-services checkpoint "${m.milestone}": compacted.` : `agent-services checkpoint "${m.milestone}": not compacted (${failure}).`)
  } catch {}
  if (!m.next || personSpoke) return
  const head = failure === null ? `The conversation was compacted at the checkpoint "${m.milestone}".` : `The checkpoint "${m.milestone}" was not compacted (${failure}).`
  const text = `${head} The next step you set: ${m.next}`
  await continueVia($, 'checkpoint_next', 'stop', { mustSend: true })
  await $.prompt.submit({ text } as any)
}

export async function checkpointTurnEnd($: EngineInterface, reason: unknown): Promise<void> {
  const m = marked
  if (m === null) return
  marked = null
  if (reason !== 'answer') {
    try {
      $.ui.log(`agent-services checkpoint "${m.milestone}": the turn did not end normally, so nothing was compacted.`)
    } catch {}
    return
  }
  compacting = true
  try {
    $.clock.after(0, () => {
      void compactThenResume($, m).catch(() => undefined).finally(() => (compacting = false))
    })
  } catch {
    compacting = false
  }
}
