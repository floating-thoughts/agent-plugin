// The subagent routing level (0.6.2), read by the agent.spawn hook (command.ts routingOff), the route record
// (records.ts, the strict flag) and the slash command. Levels: off (the agent.spawn hook does nothing), suggest (the
// default: advice only, a dispatch without a task type word runs as written), strict (the request carries strict:
// true and the service refuses a dispatch without a task type word).
// The record under ROUTING_KEY keeps its 0.6.1 shape, so an older plugin reading it still sees the switch:
// { on: false, at } is off, { on: true, at } is suggest, { on: true, strict: true, at } is strict; a missing or
// unreadable record is suggest. No migration is written: a 0.6.1 record reads as its level.

export const ROUTING_KEY = 'routing' // { on: boolean, strict?: true, at }: the subagent routing level
export type RoutingLevel = 'off' | 'suggest' | 'strict'
export const ROUTING_LEVELS: readonly RoutingLevel[] = ['off', 'suggest', 'strict']

/** The level of a stored record. Pure. */
export function levelOf(v: unknown): RoutingLevel {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'suggest'
  const r = v as { on?: unknown; strict?: unknown }
  if (r.on === false) return 'off'
  return r.strict === true ? 'strict' : 'suggest'
}

/** The record stored for a level. Pure. */
export function routingRecord(level: RoutingLevel, at: number): Record<string, unknown> {
  if (level === 'off') return { on: false, at }
  return level === 'strict' ? { on: true, strict: true, at } : { on: true, at }
}

/** The stored level; suggest on any error (the default). Reads only. */
export async function routingLevel(store: { get(key: string): Promise<unknown> }): Promise<RoutingLevel> {
  try {
    return levelOf(await store.get(ROUTING_KEY))
  } catch {
    return 'suggest'
  }
}

// Since 2026-11-12: the models and efforts the person allows for subagents, and their pick for the top tier (plan,
// replan, acceptance, an asked-for deep review). Set with `models set` (the slash command, or the setup tool after the
// model asked the user with its question tool), stored here only, and sent with each routing request as `allowed`; the
// service then routes only inside this set. No record: the service's default tiers, as before.
export const MODELS_KEY = 'routing_models' // { models: string[], efforts: string[], top: { model, effort }, at }
export const ROUTER_MODELS: readonly string[] = ['fable', 'opus', 'sonnet', 'haiku'] // every model the router knows
export const ROUTER_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']
export type Allowed = { models: string[]; efforts: string[]; top: { model: string; effort: string } }

const listOf = (v: unknown, known: readonly string[]): string[] | null => {
  if (!Array.isArray(v) || !v.length) return null
  const out = known.filter((k) => v.includes(k)) // in the router's order, no repeats
  return out.length === v.length && v.every((x) => typeof x === 'string') ? out : null
}

/** A checked choice, or null when it is not a valid one (the top pick must be among the allowed). Pure. */
export function allowedOf(v: unknown): Allowed | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const r = v as { models?: unknown; efforts?: unknown; top?: unknown }
  const models = listOf(r.models, ROUTER_MODELS)
  const efforts = listOf(r.efforts, ROUTER_EFFORTS)
  const t = r.top as { model?: unknown; effort?: unknown } | null | undefined
  if (!models || !efforts || !t || typeof t !== 'object') return null
  if (!models.includes(t.model as string) || !efforts.includes(t.effort as string)) return null
  return { models, efforts, top: { model: t.model as string, effort: t.effort as string } }
}

/** The stored choice, checked; null when none is saved or on any error. Reads only. */
export async function routingModels(store: { get(key: string): Promise<unknown> }): Promise<Allowed | null> {
  try {
    return allowedOf(await store.get(MODELS_KEY))
  } catch {
    return null
  }
}

/** `models=a,b efforts=c,d top=model:effort` (any order) as a choice, or null. Pure. */
export function parseModels(words: string[]): Allowed | null {
  const kv: Record<string, string> = {}
  for (const w of words) {
    const m = /^(models|efforts|top)=(\S+)$/i.exec(w)
    if (!m || kv[m[1]!.toLowerCase()] !== undefined) return null
    kv[m[1]!.toLowerCase()] = m[2]!.toLowerCase()
  }
  if (!kv.models || !kv.efforts || !kv.top) return null
  const [model, effort, ...more] = kv.top.split(':')
  if (more.length) return null
  return allowedOf({ models: kv.models.split(','), efforts: kv.efforts.split(','), top: { model, effort } })
}
