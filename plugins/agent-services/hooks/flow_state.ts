// Shared state of the workflow mechanisms (flow.ts), read by the core and the route record. Pure: no engine calls.
// One module instance per Claude Code session, like the rest of the hooks module.
// - The review flag: whether the person's latest message asked for a review. Only this boolean is sent with a
//   routing request (user_asked_review); the message text never leaves the machine.
// - The served brief rule: the latest speed-up rule the routing service sent (brief_rule), which flow.ts adds to a
//   routed subagent's prompt.
// - The checkpoint tool the session uses: this plugin's own, another plugin's, or none.

export const REVIEW_RX = /\b(code[- ]?)?review(s|ed|ing)?\b|\baudit(s|ed|ing)?\b|\u5ba1\u67e5|\u8bc4\u5ba1|\u5ba1\u6838|\u30ec\u30d3\u30e5\u30fc|\ub9ac\ubdf0/i // also review words in Chinese, Japanese, Korean

let askedReview = false
let briefRule: string | null = null
let checkpointTool: string | null = null

/** A message the person wrote (not a plugin's or a notification): sets the review flag for this turn. */
export function notePersonPrompt(text: unknown): void {
  askedReview = typeof text === 'string' && REVIEW_RX.test(text)
}

export const userAskedReview = (): boolean => askedReview

/** The brief_rule of a routing answer, when the service sent one. */
export function noteBrief(rule: unknown): void {
  if (typeof rule === 'string' && rule.trim()) briefRule = rule.trim()
}

export const servedBrief = (): string | null => briefRule

export function setCheckpointTool(name: string | null): void {
  checkpointTool = name
}

/** The full name of the checkpoint tool this session has, or null when it has none. */
export const checkpointToolName = (): string | null => checkpointTool
