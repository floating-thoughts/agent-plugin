// The checkpoint tool (milestone, keep, next): the model marks a finished milestone, and once its reply ends the
// conversation is compacted with instructions that keep what it listed; when it gave a next step, that step comes
// back as a message from this plugin, so the work carries on from the summary.
// - The tool is registered only when no other plugin in the session offers a tool named "checkpoint"; with another
//   one, this plugin's notes name that one (flow_state.ts checkpointToolName) and its own tool, if registered before
//   the other appeared, points to it.
// - Main conversation only. A short conversation (under CHECKPOINT_MIN_TOKENS) is not compacted.
// - A turn that did not end normally (interrupted, refused, an error) is neither compacted nor resumed; a message
//   the person sends after the turn ended means the person leads, so nothing is sent on the model's behalf.
// - The compaction instructions start with the core's CHECKPOINT_MARK, so the core counts it as a checkpoint.
// - Where $.session.compact is refused (a headless host), the /compact command is run instead.
// Functions take `$` and are wired from flow.ts; nothing here registers a hook.
import type { EngineInterface } from 'claude-code'
import { CHECKPOINT_MARK } from './core'
import { checkpointToolName, setCheckpointTool } from './flow_state'

export const CHECKPOINT_TOOL = 'mcp__agent-services__checkpoint'
export const CHECKPOINT_MIN_TOKENS = 20_000
export const CHECKPOINT_DESCRIPTION =
  'Mark a checkpoint (agent-services): once your current reply ends, the conversation is compacted into a summary ' +
  'that keeps what you list, and your next step, if you give one, comes back to you as a message so the work goes ' +
  'on from the summary. Use it after a finished, verified piece of work (for example when checkpoint_advice answers ' +
  'now), or before starting an unrelated new task. In `keep`, list what the summary must preserve: decisions and ' +
  'reasons, file paths, commands, open problems, what the user asked to remember. Leave `next` out when the work is ' +
  'done or waits for the user. Call it at most once per turn, then finish the reply.'

type Mark = { milestone: string; keep: string; next: string }
type Obj = Record<string, unknown>

let marked: Mark | null = null
let compacting = false
let personSpoke = false // the person wrote after the checkpointed turn ended
let commandOnly = false // $.session.compact was refused here: use the /compact command

const str = (v: unknown, n: number): string => (typeof v === 'string' ? [...v.trim()].slice(0, n).join('') : '')

/** The checkpoint tool another plugin offers in `names` (full tool names), or null. Pure. */
export function otherCheckpoint(names: readonly string[]): string | null {
  return names.find((n) => /^mcp__.+__checkpoint$/.test(n) && n !== CHECKPOINT_TOOL) ?? null
}

/** session.start, after the other plugins' hooks: register the tool unless another plugin has one. */
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

/** Another plugin's checkpoint tool that showed up after this one was registered: the notes name it from then on. */
export async function recheckCheckpoint($: EngineInterface): Promise<void> {
  if (checkpointToolName() !== CHECKPOINT_TOOL) return
  try {
    const other = otherCheckpoint((await $.tool.list()).map((t) => String(t.name)))
    if (other) setCheckpointTool(other)
  } catch {}
}

/** The tool's answer. */
export async function checkpointCall($: EngineInterface, e: Obj): Promise<{ result: string }> {
  if (e.agentId) return { result: 'Only the main conversation can mark a checkpoint; carry on with your task.' }
  const other = checkpointToolName()
  if (other && other !== CHECKPOINT_TOOL) return { result: `This session has another checkpoint tool, ${other}: use that one. Nothing was marked.` }
  if (compacting) return { result: 'A checkpoint is already being compacted; this one adds nothing. Finish your reply now.' }
  let tokens: number | null = null
  try {
    const t = (await $.session.usage()).context.tokens
    tokens = typeof t === 'number' ? t : null
  } catch {}
  if (tokens !== null && tokens < CHECKPOINT_MIN_TOKENS) {
    return { result: `The conversation is short (${tokens} tokens): no compaction is needed. Carry on.` }
  }
  const again = marked !== null
  marked = { milestone: str(e.milestone, 200) || 'milestone', keep: str(e.keep, 4000), next: str(e.next, 2000) }
  personSpoke = false
  const after = marked.next
    ? 'then your next step comes back to you as a message and you carry on from the summary'
    : 'nothing is sent afterwards, so the session waits for the user'
  return {
    result: `Checkpoint "${marked.milestone}" ${again ? 'replaces the one marked earlier' : 'recorded'}. The conversation ` +
      `is compacted once this reply ends, keeping what you listed; ${after}. Finish your reply now.`,
  }
}

/** prompt.submit of the main conversation from a person: after a checkpointed turn, the person leads. */
export function checkpointPersonPrompt(): void {
  if (marked === null) personSpoke = true
}

/** The instructions given to the compaction. Pure. */
export function checkpointInstructions(m: Mark): string {
  return `${CHECKPOINT_MARK} ${m.milestone}.\nThe summary must keep: ${m.keep || 'the decisions, file paths and open problems so far'}` +
    (m.next ? `\nThe next step after the compaction: ${m.next}` : '')
}

async function compactBy($: EngineInterface, instructions: string): Promise<string | null> {
  if (!commandOnly) {
    try {
      const done: Obj = (await $.session.compact({ instructions })) as any
      return typeof done?.skip === 'string' ? done.skip : null
    } catch {
      commandOnly = true
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
  try {
    $.ui.log(failure === null ? `agent-services checkpoint "${m.milestone}": compacted.` : `agent-services checkpoint "${m.milestone}": not compacted (${failure}).`)
  } catch {}
  if (!m.next || personSpoke) return
  const head = failure === null ? `The conversation was compacted at the checkpoint "${m.milestone}".` : `The checkpoint "${m.milestone}" was not compacted (${failure}).`
  await $.prompt.submit({ text: `${head} The next step you set: ${m.next}` } as any)
}

/** turn.complete of the main conversation: compact for a checkpoint marked in that turn, outside the turn. */
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
  $.clock.after(0, () => {
    void compactThenResume($, m).catch(() => undefined).finally(() => (compacting = false))
  })
}
