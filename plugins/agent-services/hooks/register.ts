// agent-services Claude Code adapter.
// Each engine hook becomes one or two core/1 events for the local core; the core's answer is applied as the table
// says. Nothing is decided or kept here: rules, counters and savings live in the core. Every answer's notice goes to
// the log. When the core cannot be reached the answer is allow (core.ts), so a hook never blocks the session.
import type { EngineInterface, Register } from 'claude-code'
import { coreEvent, type Answer } from './core'

type Ev = Record<string, any>
type Usage = { input: number; output: number; cache_read: number; cache_write: number }

const usage = (u: Ev | null | undefined): Usage | null =>
  u
    ? {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cache_read: u.cache_read_input_tokens ?? 0,
        cache_write: u.cache_creation_input_tokens ?? 0,
      }
    : null

// The tool input: the engine event without the engine's own fields.
const rest = (e: Ev): Ev => {
  const { tool: _tool, agentId: _agentId, tool_use_id: _call, ...input } = e
  return input
}

// An engine lookup that may fail: null then.
const maybe = async <T>(f: () => Promise<T> | T): Promise<T | null> => {
  try {
    return (await f()) ?? null
  } catch {
    return null
  }
}

const send = async ($: EngineInterface, kind: string, agent: string | null, fields: Ev = {}): Promise<Answer> => {
  const session = await $.session.id()
  const answer = await coreEvent($, { v: 1, harness: 'claude-code', kind, session, agent, ...fields })
  if (typeof answer.notice === 'string' && answer.notice) {
    try {
      $.ui.log(answer.notice)
    } catch {
      // the log is best effort
    }
  }
  return answer
}

export const register: Register = on => {
  on('session.start', async ($, e: Ev, next) => {
    const cwd = e.cwd ?? (await maybe(() => $.session.cwd())) ?? null
    await send($, 'session_start', null, { cwd, inject_on: ['prompt'] })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e: Ev, next) => {
    const agent = e.parentAgentId ?? null
    const call = e.tool_use_id ?? null
    const a = await send($, 'dispatch', agent, {
      subagent_type: e.subagentType,
      description: e.description,
      model: e.model ?? null,
      effort: e.effort ?? null,
      fork: e.fork === true,
      teammate: e.isTeammate === true,
      call,
    })
    if (a.action === 'deny') {
      return { deny: a.reason }
    }
    const spawned: Ev = await next(a.action === 'rewrite' && a.set ? { ...e, model: a.set.model } : e)
    if (spawned && typeof spawned.agentId === 'string') {
      await send($, 'dispatched', agent, { call, child: spawned.agentId })
    }
    return spawned
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e: Ev, next) {
    const agent = e.agentId ?? null
    const model = e.model ?? null
    const a = await send($, 'step', agent, { model })
    const step: Ev = yield* next(a.action === 'rewrite' && a.set ? { ...e, ...a.set } : e)
    await send($, 'step_end', agent, { model, usage: usage(step?.usage) })
    return step
  }).catch(async function* ($, e, next) {
    return yield* next(e)
  })

  on('tool.call', async ($, e: Ev, next) => {
    const fields = { tool: e.tool, input: rest(e), call: e.tool_use_id ?? null }
    const agent = e.agentId ?? null
    const a = await send($, 'pre_tool', agent, fields)
    if (a.action === 'deny') {
      return { deny: a.reason }
    }
    const done: Ev = await next(a.action === 'rewrite' && a.set ? { ...e, ...a.set } : e)
    await send($, 'post_tool', agent, { ...fields, ok: done.deny === undefined && done.isError !== true })
    return done
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e: Ev, next) => {
    const done = await next(e)
    const u: Ev | null = await maybe(() => $.session.usage())
    await send($, 'turn_end', e.agentId ?? null, {
      reason: e.reason ?? null,
      model: e.usage?.model ?? null,
      usage: usage(e.usage),
      context_tokens: u?.context?.tokens ?? null,
      context_window: u?.context?.window ?? null,
    })
    return done
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e: Ev, next) => {
    const a = await send($, 'prompt', e.agentId ?? null, { origin: e.origin?.kind ?? null })
    // The server's advice rides as its own context block, labelled as the server's in its first line; the model
    // reads it beside the prompt and the user's text is never rewritten.
    if (a.action === 'inject' && a.context && a.context.length) {
      return next({ ...e, context: [...(e.context ?? []), a.context.join('\n')] })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e: Ev, next) => {
    const b: Ev | null = await maybe(() => $.session.usage())
    const done: Ev = await next(e)
    const a: Ev | null = await maybe(() => $.session.usage({ breakdown: 'summary' }))
    await send($, 'compaction', e.agentId ?? null, {
      trigger: e.trigger ?? null,
      instructions: e.instructions ?? null,
      done: done.skip === undefined,
      before: done.tokensBefore ?? b?.context?.tokens ?? null,
      after: done.tokensAfter ?? null,
      window: a?.context?.window ?? b?.context?.window ?? null,
      threshold: a?.context?.breakdown?.autoCompactThreshold ?? null,
      cost_before: b?.cost?.usd ?? null,
      cost_after: a?.cost?.usd ?? null,
    })
    return done
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'clear' }, async ($, e: Ev, next) => {
    await send($, 'clear', null)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.SessionEnd', async ($, e: Ev, next) => {
    await send($, 'session_end', null)
    return next(e)
  }).catch(($, e, next) => next(e))
}
