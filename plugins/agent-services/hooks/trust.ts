// The user's own CLAUDE.md line that makes the served working methods their instructions (methods level "on").
// The plugin never decides this: the setup question asks, and before "on" the model reads the full text ("methods
// preview") and tells the user what it is (review.ts setupNoteText); only the user's answer, through the setup tool
// or `/agent-services methods on`, writes one marked section to the user-level CLAUDE.md that imports a local file
// (methods.ts) holding the text the user approved. `methods suggest` and `methods off` remove the section.

export const TRUST_BEGIN = '<!-- agent-services:trust begin (added at your request; remove: /agent-services methods suggest) -->'
export const TRUST_END = '<!-- agent-services:trust end -->'

export type TrustFile = {
  path: string
  read: () => Promise<string | null>
  write: (text: string) => Promise<void>
  importLine: () => Promise<string> // `@~/.agent-services/methods.md` (methods.ts importLine)
}

const BEGIN_HEAD = '<!-- agent-services:trust begin'
const count = (text: string, s: string) => text.split(s).length - 1
// The one section: exactly one begin marker, then exactly one end marker after it; anything else is unbalanced.
const at = (text: string) => {
  const b = text.indexOf(BEGIN_HEAD)
  const e = text.indexOf(TRUST_END)
  if (count(text, BEGIN_HEAD) !== 1 || count(text, TRUST_END) !== 1 || e < b) return null
  return { b, e: e + TRUST_END.length }
}

/** Whether the text holds the section. */
export const hasTrust = (text: string | null): boolean => text !== null && at(text) !== null

/** A marker without its pair (or more than one section): the text is left alone. */
export const unbalancedTrust = (text: string | null): boolean =>
  text !== null && at(text) === null && (text.includes(BEGIN_HEAD) || text.includes(TRUST_END))

/** The text with the section (the import line between the markers) at its end, in the file's own line endings. A
 * section with other text is replaced in place. */
export function withTrust(text: string | null, importLine: string): string {
  const old = text ?? ''
  const nl = old.includes('\r\n') ? '\r\n' : '\n'
  const block = [TRUST_BEGIN, importLine, TRUST_END].join(nl)
  const r = at(old)
  if (r) return old.slice(r.b, r.e) === block ? old : old.slice(0, r.b) + block + old.slice(r.e)
  const head = old.replace(/\s+$/, '')
  return head ? `${head}${nl}${nl}${block}${nl}` : `${block}${nl}`
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

// The 0.5.0 store key of the user's answer; read once to seed the methods level (methods.ts readLevel)
export const TRUST_KEY = 'trust_choice' // { answer: 'on' | 'not_now' | 'off', at }
