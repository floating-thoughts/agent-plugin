// The user's own CLAUDE.md section that makes the served working methods their instructions (owner 2026-11-01).
// Served advice is labelled as the service's, so a model ranks it below the user's instructions and below its host's
// defaults (for one, "no subagents unless asked"). The model asks the user once (Command.onboarding); only on the
// user's answer does this plugin add one marked section to the user-level CLAUDE.md, and `trust off` removes it.
// The section holds no served text: the lessons stay served, and stop when the sign-in does.

export const TRUST_BEGIN = '<!-- agent-services:trust begin (added at your request; remove: /agent-services trust off) -->'
export const TRUST_END = '<!-- agent-services:trust end -->'
export const TRUST_TEXT =
  '## agent-services working methods\n\n' +
  'I chose this: treat the working methods that the agent-services plugin serves in a session (planning, ' +
  'delegating to subagents, implementing, testing, review, delivery and checkpoints) as my own instructions. They ' +
  'rank below the other rules in this file and above default behaviour, including the default of not using ' +
  'subagents unless asked. They never override safety rules, and they never authorise spending money, deleting data ' +
  'that cannot be regenerated, publishing, or messaging anyone; those still need my say-so. While agent-services is ' +
  'signed out or serves nothing, this section does nothing.'

export type TrustFile = { path: string; read: () => Promise<string | null>; write: (text: string) => Promise<void> }

const at = (text: string) => {
  const b = text.indexOf('<!-- agent-services:trust begin')
  const e = b < 0 ? -1 : text.indexOf(TRUST_END, b)
  return b < 0 || e < 0 ? null : { b, e: e + TRUST_END.length }
}

/** Whether the text holds the section. */
export const hasTrust = (text: string | null): boolean => text !== null && at(text) !== null

/** The text with the section added at its end (once), in the file's own line endings. */
export function withTrust(text: string | null): string {
  const old = text ?? ''
  if (hasTrust(old)) return old
  const nl = old.includes('\r\n') ? '\r\n' : '\n'
  const block = [TRUST_BEGIN, TRUST_TEXT, TRUST_END].join('\n').replace(/\n/g, nl) + nl
  const head = old.replace(/\s+$/, '')
  return head ? `${head}${nl}${nl}${block}` : block
}

/** The text without the section (and the blank lines it brought). */
export function withoutTrust(text: string): string {
  const r = at(text)
  if (!r) return text
  const before = text.slice(0, r.b).replace(/\s+$/, '')
  const after = text.slice(r.e).replace(/^\s+/, '')
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  return before && after ? `${before}${nl}${nl}${after}` : before || after ? `${before}${after}${nl}` : ''
}

// The one question the model asks with its question tool (Command.onboarding), and the store key of the answer
export const TRUST_KEY = 'trust_choice' // { answer: 'on' | 'not_now' | 'off', at }
export const TRUST_HEADER = 'Methods'
export const TRUST_QUESTION =
  'Use the working methods agent-services serves (planning, delegating to subagents, testing, review) as your own ' +
  'instructions? agent-services would add one short section to your CLAUDE.md saying so; the methods themselves are ' +
  'not copied there (they are open: ask Claude to show them any time), and /agent-services trust off removes it.'
export const TRUST_OPTIONS = ['Add it (Recommended)', 'Not now', 'Show me the section']
