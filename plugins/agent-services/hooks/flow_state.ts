
import { RX_INPUT_MAX, servedRegex } from './rules'


let askedReview = false
let askedOverride = false
let briefRule: string | null = null
let checkpointTool: string | null = null
let routeHint: string | null = null
let routeHintTaken = false

export function notePersonPrompt(text: unknown): void {
  askedReview = typeof text === 'string' && servedRegex('patterns', 'review')?.test(text.slice(0, RX_INPUT_MAX)) === true
  askedOverride = typeof text === 'string' && (servedRegex('patterns', 'override') ?? /\boverride\b/i).test(text.slice(0, RX_INPUT_MAX))
}

export const userAskedReview = (): boolean => askedReview
export const userAskedOverride = (): boolean => askedOverride

export function noteBrief(rule: unknown): void {
  if (typeof rule === 'string' && rule.trim()) briefRule = rule.trim()
}

export const servedBrief = (): string | null => briefRule

const callBriefs = new Map<string, string>()

export function noteCallBrief(call: unknown, rule: unknown): void {
  if (typeof call !== 'string' || !call || typeof rule !== 'string' || !rule.trim()) return
  callBriefs.delete(call)
  callBriefs.set(call, rule.trim())
  while (callBriefs.size > 32) callBriefs.delete(callBriefs.keys().next().value as string)
}

export function briefFor(call: unknown): string | null {
  if (typeof call !== 'string' || !callBriefs.has(call)) return briefRule
  const rule = callBriefs.get(call) ?? null
  callBriefs.delete(call)
  return rule
}

export function noteRouteHint(hint: unknown): void {
  if (routeHintTaken || routeHint !== null || typeof hint !== 'string' || !hint.trim()) return
  routeHint = hint.trim()
}

export function takeRouteHint(): string | null {
  if (routeHintTaken || routeHint === null) return null
  routeHintTaken = true
  const h = routeHint
  routeHint = null
  return h
}

export function setCheckpointTool(name: string | null): void {
  checkpointTool = name
}

export const checkpointToolName = (): string | null => checkpointTool

export type Explicit = { model: string | null; effort: string | null }
const explicitByCall = new Map<string, Explicit>()
const routeByCall = new Map<string, string>()
let tableAsk: (() => Promise<string | null>) | null = null

export function noteCallExplicit(call: unknown, input: unknown): void {
  if (typeof call !== 'string' || !call || !input || typeof input !== 'object') return
  const i = input as Record<string, unknown>
  const model = typeof i.model === 'string' && i.model.trim() ? i.model.trim() : null
  const effort = typeof i.effort === 'string' && i.effort.trim() ? i.effort.trim() : null
  if (model === null && effort === null) return
  explicitByCall.delete(call)
  explicitByCall.set(call, { model, effort })
  while (explicitByCall.size > 64) explicitByCall.delete(explicitByCall.keys().next().value as string)
}

export function explicitFor(call: unknown): Explicit {
  const none: Explicit = { model: null, effort: null }
  if (typeof call !== 'string') return none
  const v = explicitByCall.get(call)
  explicitByCall.delete(call)
  return v ?? none
}

export function noteCallRoute(call: unknown, text: unknown): void {
  if (typeof call !== 'string' || !call || typeof text !== 'string' || !text.trim()) return
  routeByCall.delete(call)
  routeByCall.set(call, text.trim())
  while (routeByCall.size > 64) routeByCall.delete(routeByCall.keys().next().value as string)
}

export function routeNoteFor(call: unknown): string | null {
  if (typeof call !== 'string' || !routeByCall.has(call)) return null
  const v = routeByCall.get(call) ?? null
  routeByCall.delete(call)
  return v
}

export function setTableAsk(f: (() => Promise<string | null>) | null): void {
  tableAsk = f
}

export async function routingTable(): Promise<string | null> {
  try {
    return tableAsk ? await tableAsk() : null
  } catch {
    return null
  }
}
