// Secret redaction, harness-neutral: a port of host/explain.py (redact, scrub, clean_description) with the same
// patterns (A22 item 2). Applied to every text the hooks module shows, logs or writes: status line, notices,
// receipts, command answers, outbox lines and tool answers.
//
// Parity with Python's re: the patterns run with the u and i flags where Python has (?i), so case folding is
// Unicode-wide as in Python (long s, Kelvin sign); \d is \p{Nd} because Python's \d on str matches every Unicode
// decimal digit. Word edges are ASCII lookarounds, not \b, so a token glued to CJK text is still masked.

const EDGE = '(?<![A-Za-z0-9_])'
const D = '\\p{Nd}'

/** [pattern, keeps its first group] in the order host/explain.py applies them. */
export const SECRET_RES: readonly (readonly [RegExp, boolean])[] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/gu, false],
  [new RegExp(EDGE + 'sk-ant-[A-Za-z0-9_-]{16,}', 'gu'), false],
  [new RegExp(EDGE + 'sk-(?:proj-)?[A-Za-z0-9_-]{16,}', 'gu'), false],
  [new RegExp(EDGE + '(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})', 'gu'), false],
  [new RegExp(EDGE + `bot${D}{6,}:[A-Za-z0-9_-]{20,}`, 'gu'), false],
  // bare chat-bot token format (no bot prefix): <digits>:<long string>
  [new RegExp(EDGE + `${D}{6,12}:[A-Za-z0-9_-]{30,}(?![A-Za-z0-9_-])`, 'gu'), false],
  [new RegExp(EDGE + 'xox[abprs]-[A-Za-z0-9-]{10,}', 'gu'), false],
  [new RegExp(EDGE + 'AKIA[0-9A-Z]{16}(?![A-Za-z0-9_])', 'gu'), false],
  [new RegExp(EDGE + 'AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_])', 'gu'), false],
  [/(Authorization:\s*(?:Bearer|Basic)\s+)[A-Za-z0-9._\-+/=]{8,}/giu, true],
  [/((?:api[_-]?key|secret|token|passw(?:or)?d|access[_-]?key)\s*[:=]\s*['"]?)([A-Za-z0-9_\-/+=.]{12,})/giu, true],
  // command-line flags: --password x, --token=x; -p is too ambiguous to touch
  [/(--(?:password|passwd|pass|token|api-key|apikey|secret|access-key)(?:\s+|=)['"]?)([^\s'"]{4,})/giu, true],
]

export const REDACTED = '<redacted>'

/** Mask the parts of the text that look like secrets (private key blocks, vendor API tokens, Authorization headers,
 * key=..., --token ...). */
export function redact(text: string): string {
  if (!text) return text
  let out = text
  for (const [rx, keep] of SECRET_RES) {
    rx.lastIndex = 0
    out = keep ? out.replace(rx, (_m, g1: string) => g1 + REDACTED) : out.replace(rx, REDACTED)
  }
  return out
}

export const TOKEN_MASK = '[token hidden]'
const HEX64 = /(?<![0-9A-Fa-f])[0-9A-Fa-f]{64}(?![0-9A-Fa-f])/g

/** redact plus token masking: known tokens (16 characters or more) are replaced as they are, and any 64-digit hex
 * string is masked (session tokens have this shape; over-masking is preferred). */
export function scrub(text: string, knownTokens: readonly unknown[] = []): string {
  if (!text) return text || ''
  for (const t of knownTokens) if (typeof t === 'string' && t.length >= 16) text = text.split(t).join(TOKEN_MASK)
  return redact(text).replace(HEX64, TOKEN_MASK)
}

export const DESC_LIMIT = 200
export const RAW_LIMIT = 4000

/** Tool-call description: redact, flatten to one line, truncate (redact first, so no half secret is left). null
 * unless it is a non-empty string. Lengths count code points, as Python does. */
export function cleanDescription(raw: unknown, limit: number = DESC_LIMIT): string | null {
  if (typeof raw !== 'string') return null
  const text = redact(Array.from(raw).slice(0, RAW_LIMIT).join(''))
    .split(/\s+/u)
    .filter(Boolean)
    .join(' ')
  if (!text) return null
  const cps = Array.from(text)
  return cps.length > limit ? cps.slice(0, limit).join('') + '\u2026' : text
}
