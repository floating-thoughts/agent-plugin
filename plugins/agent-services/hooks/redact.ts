
const EDGE = '(?<![A-Za-z0-9_])'
const D = '\\p{Nd}'

export const SECRET_RES: readonly (readonly [RegExp, boolean])[] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/gu, false],
  [new RegExp(EDGE + 'sk-ant-[A-Za-z0-9_-]{16,}', 'gu'), false],
  [new RegExp(EDGE + 'sk-(?:proj-)?[A-Za-z0-9_-]{16,}', 'gu'), false],
  [new RegExp(EDGE + '(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})', 'gu'), false],
  [new RegExp(EDGE + `bot${D}{6,}:[A-Za-z0-9_-]{20,}`, 'gu'), false],
  [new RegExp(EDGE + `${D}{6,12}:[A-Za-z0-9_-]{30,}(?![A-Za-z0-9_-])`, 'gu'), false],
  [new RegExp(EDGE + 'xox[abprs]-[A-Za-z0-9-]{10,}', 'gu'), false],
  [new RegExp(EDGE + 'AKIA[0-9A-Z]{16}(?![A-Za-z0-9_])', 'gu'), false],
  [new RegExp(EDGE + 'AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_])', 'gu'), false],
  [new RegExp(EDGE + '(?:(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9+/=]{24,})', 'gu'), false],
  [new RegExp(EDGE + 'eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}', 'gu'), false],
  [/(Authorization:\s*(?:Bearer|Basic)\s+)[A-Za-z0-9._\-+/=]{8,}/giu, true],
  [/((?:api[_-]?key|secret|token|passw(?:or)?d|access[_-]?key)\s*[:=]\s*['"]?)([A-Za-z0-9_\-/+=.]{12,})/giu, true],
  [/(--(?:password|passwd|pass|token|api-key|apikey|secret|access-key)(?:\s+|=)['"]?)([^\s'"]{4,})/giu, true],
  [/((?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s\/@:'"<>]+:[^\s\/@'"<>]+(?=@)/gu, true],
]

export const REDACTED = '<redacted>'

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

export function scrub(text: string, knownTokens: readonly unknown[] = []): string {
  if (!text) return text || ''
  for (const t of knownTokens) if (typeof t === 'string' && t.length >= 16) text = text.split(t).join(TOKEN_MASK)
  return redact(text).replace(HEX64, TOKEN_MASK)
}

export const DESC_LIMIT = 200
export const RAW_LIMIT = 4000

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
