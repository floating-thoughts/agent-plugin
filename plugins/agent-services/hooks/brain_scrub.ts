import { SECRET_RES } from './redact'

export type ScrubOpts = { home?: string | readonly string[]; names?: readonly string[]; emails?: readonly string[]; terms?: readonly string[] }
export type ScrubResult = { ok: true; text: string } | { ok: false; blocked: string[] }

const EMAIL_RX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
const URL_RX = /\b(?:https?|wss?):\/\/[^\s<>"'`)\]]*[^\s<>"'`)\].,;:!?]/g
const WIN_HOME_RX = /\b[a-z]:(?:\\+|\/+)users(?:\\+|\/+)[^\\/\s"'`<>|*?]+/gi
const UNIX_HOME_RX = /(?<![\w.-])\/(?:users|home)\/[^/\s"'`<>|*?]+/gi
const PHONE_INTL_RX = /(?<![\w.+/-])(?:\+\d{1,3}|\(\d{2,4}\)|0\d)[\d ().-]{7,18}\d(?!\w)/g
const PHONE_US_RX = /(?<![\w.+/-])\d{3}[-. ]\d{3}[-. ]\d{4}(?!\w)/g
const NUMBER_ID_RX = /(?<![\w.-])\d(?:[ -]?\d){8,}(?:\s?[a-z]{2}\s?\d{4})?(?!\w)/gi
const UUID_RX = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const IPV4_RX = /(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?!\w)(?!\.\d)/g
const PRIVATE_KEY_RX = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|PRIVATE KEY-----/
const MASK_PLACEHOLDER_RX = /\{\{secret:[a-z0-9_]+\}\}/g
const PRIVATE_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.ts.net', '.test', '.corp', '.intranet', '.localdomain', '.private']
const MIN_LITERAL = 3

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function privateIp(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
}

export function privateHost(host: string): boolean {
  const h = String(host || '').toLowerCase().replace(/\.$/, '')
  if (!h || h === 'localhost' || h.startsWith('[')) return true
  return PRIVATE_HOST_SUFFIXES.some((s) => h.endsWith(s)) || privateIp(h)
}

function hostOf(url: string): string {
  const m = /^[a-z]+:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]+)/i.exec(url)
  return m ? m[1] : ''
}

function literals(list: readonly string[] | undefined, flexSpace: boolean): RegExp[] {
  const words = [...new Set((list ?? []).map((s) => String(s ?? '').trim()).filter((s) => s.length >= 1))]
  words.sort((a, b) => b.length - a.length)
  return words.map((w) => {
    const body = flexSpace ? w.split(/\s+/).map(esc).join('\\s+') : esc(w)
    return new RegExp(w.length < MIN_LITERAL ? `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])` : body, 'giu')
  })
}

function homeRxs(home: string | readonly string[] | undefined): RegExp[] {
  const list = (Array.isArray(home) ? home : [home]).map((h) => String(h ?? '').trim().replace(/[\\/]+$/, ''))
  return [...new Set(list.filter((h) => h.length >= MIN_LITERAL))]
    .sort((a, b) => b.length - a.length)
    .map((h) => new RegExp(h.split(/[\\/]+/).map(esc).join('[\\\\/]+'), 'gi'))
}

type Rule = { cls: string; rx: RegExp; to: string | ((m: string) => string) }

function rules(o: ScrubOpts): Rule[] {
  const out: Rule[] = []
  for (const rx of homeRxs(o.home)) out.push({ cls: 'home', rx, to: '[home]' })
  for (const rx of literals(o.emails, false)) out.push({ cls: 'member', rx, to: '[member]' })
  out.push({ cls: 'url', rx: URL_RX, to: (m) => (privateHost(hostOf(m)) ? '[private-url]' : m) })
  out.push({ cls: 'email', rx: EMAIL_RX, to: '[email]' })
  out.push({ cls: 'home', rx: WIN_HOME_RX, to: '[home]' })
  out.push({ cls: 'home', rx: UNIX_HOME_RX, to: '[home]' })
  out.push({ cls: 'phone', rx: PHONE_INTL_RX, to: (m) => {
    const n = (m.match(/\d/g) ?? []).length
    return n >= 9 && n <= 15 ? '[phone]' : m
  } })
  out.push({ cls: 'phone', rx: PHONE_US_RX, to: '[phone]' })
  out.push({ cls: 'number', rx: UUID_RX, to: '[number]' })
  out.push({ cls: 'number', rx: NUMBER_ID_RX, to: '[number]' })
  out.push({ cls: 'ip', rx: IPV4_RX, to: '<ip>' })
  for (const rx of literals(o.names, true)) out.push({ cls: 'member', rx, to: '[member]' })
  for (const rx of literals(o.terms, false)) out.push({ cls: 'term', rx, to: '[term]' })
  return out
}

function maskSecrets(text: string): string {
  let out = text.replace(MASK_PLACEHOLDER_RX, '[key]')
  for (const [rx, keep] of SECRET_RES) {
    rx.lastIndex = 0
    out = keep ? out.replace(rx, (_m, g1: string) => g1 + '[key]') : out.replace(rx, '[key]')
  }
  return out
}

function residual(text: string, rs: Rule[]): string[] {
  const probe = text.replace(/\[(?:key|email|home|private-url|phone|number|member|term)\]|<ip>/g, ' ')
  const out = new Set<string>()
  if (maskSecrets(probe) !== probe) out.add('key')
  for (const r of rs) {
    r.rx.lastIndex = 0
    if (r.cls === 'url') {
      for (const m of probe.matchAll(r.rx)) if (privateHost(hostOf(m[0]))) out.add('url')
      continue
    }
    if (r.cls === 'phone') continue
    if (r.rx.test(probe)) out.add(r.cls)
    r.rx.lastIndex = 0
  }
  return [...out].sort()
}

export function scrubDetail(text: string, opts: ScrubOpts = {}): { text: string; classes: string[]; blocked: string[] } {
  const src = typeof text === 'string' ? text : ''
  if (PRIVATE_KEY_RX.test(src)) return { text: '', classes: ['private_key'], blocked: ['private_key'] }
  const rs = rules(opts ?? {})
  const classes = new Set<string>()
  let out = maskSecrets(src)
  if (out !== src) classes.add('key')
  for (const r of rs) {
    r.rx.lastIndex = 0
    const next = typeof r.to === 'string' ? out.replace(r.rx, r.to) : out.replace(r.rx, r.to)
    if (next !== out) classes.add(r.cls)
    out = next
  }
  return { text: out, classes: [...classes].sort(), blocked: residual(out, rs) }
}

export function scrubCandidate(text: string, opts: ScrubOpts = {}): ScrubResult {
  const d = scrubDetail(text, opts)
  return d.blocked.length ? { ok: false, blocked: d.blocked } : { ok: true, text: d.text }
}
