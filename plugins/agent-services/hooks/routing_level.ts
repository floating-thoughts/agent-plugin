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
