// Shared state of the workflow mechanisms (flow.ts), read by the core and the route record. Pure: no engine calls.
// One module instance per Claude Code session, like the rest of the hooks module.
// - The review flag: whether the person's latest message asked for a review. Only this boolean is sent with a
//   routing request (user_asked_review); the message text never leaves the machine.
// - The served brief rule: the latest speed-up rule the routing service sent (brief_rule), which flow.ts adds to a
//   routed subagent's prompt.
// - The checkpoint tool the session uses: this plugin's own, another plugin's, or none.
// - The routing hint (0.6.2): the hint of the first pass answer that carried one (the service sends it when a
//   description has no task type word), held for the next prompt's note (flow.ts) and taken once per session.

import { RX_INPUT_MAX, servedRegex } from './rules'

// The review words: the served pattern (rules patterns.json, review) covers every language the service knows; the
// built-in one, used only without the tables, keeps the English words.
export const REVIEW_RX = /\b(code[- ]?)?review(s|ed|ing)?\b|\baudit(s|ed|ing)?\b/i

let askedReview = false
let briefRule: string | null = null
let checkpointTool: string | null = null
let routeHint: string | null = null
let routeHintTaken = false

/** A message the person wrote (not a plugin's or a notification): sets the review flag for this turn. */
export function notePersonPrompt(text: unknown): void {
  askedReview = typeof text === 'string' && servedRegex('patterns', 'review', REVIEW_RX).test(text.slice(0, RX_INPUT_MAX))
}

export const userAskedReview = (): boolean => askedReview

/** The brief_rule of a routing answer, when the service sent one. */
export function noteBrief(rule: unknown): void {
  if (typeof rule === 'string' && rule.trim()) briefRule = rule.trim()
}

export const servedBrief = (): string | null => briefRule

// Black-box step 2: the brief rule differs per task type, so each dispatch keeps the rule of its own answer, by the
// spawn's tool call id (parallel spawns would otherwise take another dispatch's rule). Bounded: a denied spawn never
// takes its rule.
const callBriefs = new Map<string, string>()

/** The brief_rule of the routing answer for one spawn (core.ts onDispatch). */
export function noteCallBrief(call: unknown, rule: unknown): void {
  if (typeof call !== 'string' || !call || typeof rule !== 'string' || !rule.trim()) return
  callBriefs.delete(call)
  callBriefs.set(call, rule.trim())
  while (callBriefs.size > 32) callBriefs.delete(callBriefs.keys().next().value as string)
}

/** The rule of this spawn's own answer, taken once; the session's latest rule when the spawn has none. */
export function briefFor(call: unknown): string | null {
  if (typeof call !== 'string' || !callBriefs.has(call)) return briefRule
  const rule = callBriefs.get(call) ?? null
  callBriefs.delete(call)
  return rule
}

/** The hint of a routing pass answer (core.ts onDispatch); only the first one of a session is kept. */
export function noteRouteHint(hint: unknown): void {
  if (routeHintTaken || routeHint !== null || typeof hint !== 'string' || !hint.trim()) return
  routeHint = hint.trim()
}

/** The routing hint for the next prompt's note, once per session; null when there is none or it was taken. */
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

/** The full name of the checkpoint tool this session has, or null when it has none. */
export const checkpointToolName = (): string | null => checkpointTool
