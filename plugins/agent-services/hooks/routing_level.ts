
export const ROUTING_KEY = 'routing'
export type RoutingLevel = 'off' | 'suggest' | 'strict'
export const ROUTING_LEVELS: readonly RoutingLevel[] = ['off', 'suggest', 'strict']

export function levelOf(v: unknown): RoutingLevel {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'suggest'
  const r = v as { on?: unknown; strict?: unknown }
  if (r.on === false) return 'off'
  return r.strict === true ? 'strict' : 'suggest'
}

export function routingRecord(level: RoutingLevel, at: number): Record<string, unknown> {
  if (level === 'off') return { on: false, at }
  return level === 'strict' ? { on: true, strict: true, at } : { on: true, at }
}

export async function routingLevel(store: { get(key: string): Promise<unknown> }): Promise<RoutingLevel> {
  try {
    return levelOf(await store.get(ROUTING_KEY))
  } catch {
    return 'suggest'
  }
}

export const MODELS_KEY = 'routing_models'
export const ROUTER_MODELS: readonly string[] = ['fable', 'opus', 'sonnet', 'haiku']
export const ROUTER_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']
export type Allowed = { models: string[]; efforts: string[]; top: { model: string; effort: string } }

const listOf = (v: unknown, known: readonly string[]): string[] | null => {
  if (!Array.isArray(v) || !v.length) return null
  const out = known.filter((k) => v.includes(k))
  return out.length === v.length && v.every((x) => typeof x === 'string') ? out : null
}

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

export async function routingModels(store: { get(key: string): Promise<unknown> }): Promise<Allowed | null> {
  try {
    return allowedOf(await store.get(MODELS_KEY))
  } catch {
    return null
  }
}

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

export type SessionPick = { model?: string; effort?: string }
let pick: SessionPick | null = null

export function sessionPick(): SessionPick | null {
  return pick
}

export function setSessionPick(p: SessionPick | null): void {
  pick = p
}

export function parseUse(words: string[]): SessionPick | null {
  if (words.length < 1 || words.length > 2) return null
  const out: SessionPick = {}
  for (const raw of words) {
    const w = raw.toLowerCase()
    if (ROUTER_MODELS.includes(w) && out.model === undefined) out.model = w
    else if (ROUTER_EFFORTS.includes(w) && out.effort === undefined) out.effort = w
    else return null
  }
  return out
}

export function userPickOf(p: SessionPick | null): SessionPick | null {
  if (!p) return null
  const out: SessionPick = {}
  if (p.model !== undefined) out.model = p.model
  if (p.effort !== undefined) out.effort = p.effort
  return out.model === undefined && out.effort === undefined ? null : out
}

export function pickOutside(p: SessionPick, allowed: Allowed | null): string | null {
  if (!allowed) return null
  if (p.model !== undefined && !allowed.models.includes(p.model)) return `${p.model} is not among the models you allow for subagents`
  if (p.effort !== undefined && !allowed.efforts.includes(p.effort)) return `${p.effort} is not among the efforts you allow for subagents`
  return null
}
