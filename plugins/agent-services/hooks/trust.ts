
export const TRUST_BEGIN = '<!-- agent-services:trust begin (added at your request; remove: /agent-services remove, or ask Claude to turn the methods off) -->'
export const TRUST_END = '<!-- agent-services:trust end -->'

export type TrustFile = {
  path: string
  read: () => Promise<string | null>
  write: (text: string) => Promise<void>
  importLine: () => Promise<string>
}

const BEGIN_HEAD = '<!-- agent-services:trust begin'
const count = (text: string, s: string) => text.split(s).length - 1
const at = (text: string) => {
  const b = text.indexOf(BEGIN_HEAD)
  const e = text.indexOf(TRUST_END)
  if (count(text, BEGIN_HEAD) !== 1 || count(text, TRUST_END) !== 1 || e < b) return null
  return { b, e: e + TRUST_END.length }
}

export const hasTrust = (text: string | null): boolean => text !== null && at(text) !== null

export const unbalancedTrust = (text: string | null): boolean =>
  text !== null && at(text) === null && (text.includes(BEGIN_HEAD) || text.includes(TRUST_END))

export function withTrust(text: string | null, importLine: string): string {
  const old = text ?? ''
  const nl = old.includes('\r\n') ? '\r\n' : '\n'
  const block = [TRUST_BEGIN, importLine, TRUST_END].join(nl)
  const r = at(old)
  if (r) return old.slice(r.b, r.e) === block ? old : old.slice(0, r.b) + block + old.slice(r.e)
  const head = old.trimEnd()
  return head ? `${head}${nl}${nl}${block}${nl}` : `${block}${nl}`
}

export function withoutTrust(text: string): string {
  const r = at(text)
  if (!r) return text
  const before = text.slice(0, r.b).trimEnd()
  const after = text.slice(r.e).replace(/^\s+/, '')
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  return before && after ? `${before}${nl}${nl}${after}` : before || after ? `${before}${after}${nl}` : ''
}

export const TRUST_KEY = 'trust_choice'
