// Python-compatible number and time helpers (cleanup route R6, moved from metrics.ts unchanged): tuple order,
// float formatting and rounding, math.fsum-style sums, ISO time parsing, local days, HMAC and the salted ref.
// Used by metrics.ts, transcripts.ts, status.ts, render.ts, estimate.ts and migrate.ts. Nothing here touches
// the engine.
import { sha256 } from './noble.js'
import { concat, hex, utf8 } from './e2e'

type Obj = Record<string, any>

// ------------------------------------------------------------------ Python-compatible helpers

export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
export const cmp = (a: string | number, b: string | number): number => (a < b ? -1 : a > b ? 1 : 0)
export const cmpTuple = (a: (string | number | boolean)[], b: (string | number | boolean)[]): number => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = typeof a[i] === 'boolean' ? Number(a[i]) : (a[i] as string | number)
    const y = typeof b[i] === 'boolean' ? Number(b[i]) : (b[i] as string | number)
    const c = cmp(x, y)
    if (c) return c
  }
  return a.length - b.length
}

/** format(x, f".{n}f"): the exact binary value rounded half to even, as CPython does. */
export function pyFixed(x: number, n: number): string {
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : x < 0 ? '-inf' : 'nan'
  const neg = x < 0 || Object.is(x, -0)
  const ax = Math.abs(x)
  if (ax >= 1e21) return (neg ? '-' : '') + ax.toFixed(n)
  const full = ax.toFixed(100) // exact for every double of this size that matters here
  const dot = full.indexOf('.')
  const whole = full.slice(0, dot)
  const frac = full.slice(dot + 1)
  let digits = whole + frac.slice(0, n)
  const next = frac.charCodeAt(n) - 48
  const rest = frac.slice(n + 1)
  const last = digits.charCodeAt(digits.length - 1) - 48
  const up = next > 5 || (next === 5 && (/[1-9]/.test(rest) || last % 2 === 1))
  if (up) {
    const arr = digits.split('')
    let i = arr.length - 1
    while (i >= 0) {
      if (arr[i] === '9') {
        arr[i] = '0'
        i--
      } else {
        arr[i] = String.fromCharCode(arr[i].charCodeAt(0) + 1)
        break
      }
    }
    digits = (i < 0 ? '1' : '') + arr.join('')
  }
  const w = digits.slice(0, digits.length - n) || '0'
  const f = digits.slice(digits.length - n)
  return (neg ? '-' : '') + w + (n > 0 ? '.' + f : '')
}

/** sum() of floats as CPython 3.12+ adds them (Neumaier compensated summation). */
export function pySum(xs: Iterable<number>): number {
  let f = 0
  let c = 0
  for (const x of xs) {
    const t = f + x
    if (Math.abs(f) >= Math.abs(x)) c += f - t + x
    else c += x - t + f
    f = t
  }
  if (c && Number.isFinite(c)) f += c
  return f
}

/** round(x, n) for a float. */
export const pyRound = (x: number, n: number): number => (Number.isFinite(x) ? Number(pyFixed(x, n)) : x)

const pad = (v: number, w = 2): string => String(v).padStart(w, '0')
const ISO_RX =
  /^(\d{4})-?(\d{2})-?(\d{2})(?:.(\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d+))?)?)?(?:([+-])(\d{2})(?::?(\d{2})(?::?(\d{2})(?:\.(\d{1,6}))?)?)?)?)?$/s

/**
 * datetime.fromisoformat(text.replace("Z", "+00:00")) as epoch microseconds, or null when Python raises ValueError.
 * A naive time is taken as local (modules/usage parse_iso) or as UTC (host/dashboard.py _local_day).
 */
export function parseIso(text: unknown, naive: 'local' | 'utc' = 'local'): number | null {
  if (typeof text !== 'string') return null
  const m = ISO_RX.exec(text.replace(/Z/g, '+00:00'))
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const [h, mi, s] = [Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)]
  const micro = Number((m[7] ?? '').slice(0, 6).padEnd(6, '0'))
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return null
  const probe = new Date(Date.UTC(2000, mo - 1, d))
  probe.setUTCFullYear(y)
  if (probe.getUTCDate() !== d) return null
  let ms: number
  if (m[8]) {
    const oh = Number(m[9])
    const om = Number(m[10] ?? 0)
    const os = Number(m[11] ?? 0)
    if (oh > 23 || om > 59 || os > 59) return null
    const off = (m[8] === '-' ? -1 : 1) * ((oh * 3600 + om * 60 + os) * 1000)
    const t = new Date(Date.UTC(2000, mo - 1, d, h, mi, s))
    t.setUTCFullYear(y)
    ms = t.getTime() - off
    return ms * 1000 + micro - (m[8] === '-' ? -1 : 1) * Number((m[12] ?? '').padEnd(6, '0'))
  }
  if (naive === 'utc') {
    const t = new Date(Date.UTC(2000, mo - 1, d, h, mi, s))
    t.setUTCFullYear(y)
    ms = t.getTime()
  } else {
    const t = new Date(2000, mo - 1, d, h, mi, s)
    t.setFullYear(y)
    ms = t.getTime()
  }
  return ms * 1000 + micro
}

/** The local calendar day (YYYY-MM-DD) of epoch microseconds. */
export const localDay = (micro: number): string => {
  const t = new Date(Math.floor(micro / 1000))
  return `${pad(t.getFullYear(), 4)}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`
}
export const localMonth = (micro: number): string => localDay(micro).slice(0, 7)

/** date.fromisoformat(day) + n days. */
export const plusDays = (day: string, n: number): string => {
  const t = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)) + n))
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}

/** HMAC-SHA256 (RFC 2104) on the vendored sha256. */
export function hmacSha256(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const k = key.length > 64 ? sha256(key) : key
  const block = new Uint8Array(64)
  block.set(k)
  const ipad = block.map((b) => b ^ 0x36)
  const opad = block.map((b) => b ^ 0x5c)
  return sha256(concat(opad, sha256(concat(ipad, msg))))
}

/** tools/diagnostic/payload.py ref(): a salted 16-hex reference. */
export const ref = (salt: Uint8Array, kind: string, value: string): string =>
  hex(hmacSha256(salt, utf8(`${kind}:${value}`))).slice(0, 16)

/** Python's len() of a string: code points. */
export const pyLen = (s: string): number => [...s].length
