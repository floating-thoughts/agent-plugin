import type { EngineInterface } from 'claude-code'
import { auditRecord, type AuditEntry } from './audit_log'
import { sha256Hex, utf8 } from './e2e'
import { engineStore } from './store'
import { authorHit } from './subagents'

type Obj = Record<string, any>
type Grant = { path: string; at: number; until: number; prompt: string }
type Pending = { paths: string[]; at: number }
type Book = { pending: Record<string, Pending>; grants: Record<string, Grant[]> }
export type UnlockVerdict = { grant: string[] } | { deny: true } | null

export const UNLOCK_KEY = 'test_unlock'
export const UNLOCK_GRANT_MS = 2 * 60 * 60 * 1000
export const UNLOCK_PENDING_MS = 60 * 60 * 1000
export const UNLOCK_MAX_PATHS = 20
export const UNLOCK_MAX_SESSIONS = 20

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const baseName = (p: string): string => p.split('/').pop() ?? p


export function unlockVerdict(text: unknown, pending: readonly string[]): UnlockVerdict {
  if (typeof text !== 'string' || !pending.length) return null
  const raw = text.trim()
  if (!raw || raw.length > 300 || raw.split(/\r?\n/).length > 3) return null
  if (/```|<\/?[a-z][\w-]*[\s>/]|^\s*>|\b(from|to|subject|cc):|forwarded|wrote:|agent-services|subagent|task.notification|\[[^\]]*\]/im.test(raw)) return null
  let t = raw.toLowerCase().replace(/\s+/g, ' ')
  const named = pending.filter((p) => t.includes(p.toLowerCase()) || t.includes(baseName(p).toLowerCase()))
  for (const p of named) t = t.split(p.toLowerCase()).join(' ').split(baseName(p).toLowerCase()).join(' ')
  let deny = /\b(no|nope|nah|don'?t|do not|deny|denied|reject(ed)?|refuse[ds]?|stop|cancel|never|keep (them |it )?locked|leave (them|it))\b/.test(t)
  const zhNo = /(\u4e0d|\u522b|\u6ca1)(\u8981|\u7528)?(\u662f|\u53ef\u4ee5|\u540c\u610f|\u66f4\u65b0|\u6279\u51c6|\u5141\u8bb8|\u884c|\u597d|\u6539|\u786e\u8ba4)/g
  if (zhNo.test(t) || /(\u62d2\u7edd|\u53d6\u6d88|\u7b97\u4e86|\u4e0d\u8981|\u4e0d\u884c|\u522b\u6539|\u4e0d\u7528|\u4e0d\u5bf9|\u4e0d\u662f)/.test(t)) deny = true
  t = t.replace(zhNo, ' ')
  const hedge = /\b(but|only|except|wait|not|later|maybe|unless|if|first|why|what|which|how|hold on)\b|\?|\uff1f|\u4f46|\u53ea|\u9664\u4e86|\u7b49\u4e00\u4e0b|\u5148|\u5417|\u54ea|\u4ec0\u4e48|\u4e3a\u4ec0\u4e48|\u600e\u4e48/.test(t)
  const yes = /\b(yes|yeah|yep|yup|y|ok|okay|sure|approve[ds]?|go ahead|go for it|do it|allow(ed)?|unlock( them| it)?|(update|change|edit|fix) (them|it|those|these|the tests?|the files?)|confirm(ed)?|lgtm)\b/.test(t) ||
    /(\u662f|\u53ef\u4ee5|\u540c\u610f|\u66f4\u65b0|\u6279\u51c6|\u5141\u8bb8|\u597d|\u884c|\u6539\u5427|\u6ca1\u95ee\u9898|\u786e\u8ba4)/.test(t) ||
    (named.length > 0 && /\b(update|change|edit|fix)\b/.test(t))
  if (deny && !yes && !hedge) return { deny: true }
  if (deny || hedge) return null
  if (yes) return { grant: named.length ? named : [...pending] }
  const filler = t.replace(/\b(and|or|the|tests?|files?|please|both|all)\b/g, '').replace(/(\u548c|\u4e0e|\u6d4b\u8bd5|\u6587\u4ef6|\u90fd)/g, '')
  if (named.length && filler.replace(/[\s,.;:!\uff0c\u3002\uff1b\uff1a\uff01\u3001]+/g, '') === '') return { grant: named }
  return null
}

export function unlockBook(v: unknown, now: number): Book {
  const book: Book = { pending: {}, grants: {} }
  if (!isObj(v)) return book
  for (const [s, p] of Object.entries(isObj(v.pending) ? v.pending : {})) {
    if (!isObj(p) || !Array.isArray(p.paths) || typeof p.at !== 'number' || now - p.at > UNLOCK_PENDING_MS || p.at > now) continue
    const paths = p.paths.filter((x: unknown): x is string => typeof x === 'string' && x !== '').slice(0, UNLOCK_MAX_PATHS)
    if (paths.length) book.pending[s] = { paths, at: p.at }
  }
  for (const [s, list] of Object.entries(isObj(v.grants) ? v.grants : {})) {
    if (!Array.isArray(list)) continue
    const live = list.filter((g: unknown): g is Grant => isObj(g) && typeof g.path === 'string' && typeof g.until === 'number' &&
      typeof g.at === 'number' && g.until > now && g.at <= now && g.until - g.at <= UNLOCK_GRANT_MS)
    if (live.length) book.grants[s] = live
  }
  return book
}

function capBook(book: Book): Book {
  for (const part of [book.pending, book.grants] as Record<string, unknown>[]) {
    const keys = Object.keys(part)
    for (const k of keys.slice(0, Math.max(0, keys.length - UNLOCK_MAX_SESSIONS))) delete part[k]
  }
  return book
}


async function nowOf($: EngineInterface): Promise<number> {
  try {
    const n = Number(await $.clock.now())
    if (Number.isFinite(n)) return n
  } catch {}
  return Date.now()
}

async function sessionOf($: EngineInterface): Promise<string> {
  try {
    return String((await $.session.id()) ?? '')
  } catch {
    return ''
  }
}

async function readBook($: EngineInterface, now: number): Promise<Book> {
  try {
    return unlockBook(await engineStore($).get(UNLOCK_KEY), now)
  } catch {
    return { pending: {}, grants: {} }
  }
}

async function saveBook($: EngineInterface, book: Book): Promise<boolean> {
  try {
    await engineStore($).set(UNLOCK_KEY, capBook(book))
    return true
  } catch {
    return false
  }
}

export async function unlockGranted($: EngineInterface): Promise<string[]> {
  const session = await sessionOf($)
  if (!session) return []
  const book = await readBook($, await nowOf($))
  return [...new Set((book.grants[session] ?? []).map((g) => g.path))]
}

export async function unlockGate($: EngineInterface, e: Obj, cwd: string | null, hideTests = false): Promise<string | null> {
  const first = authorHit(e, cwd, hideTests)
  if (!first) return null
  let hit = first
  try {
    const granted = await unlockGranted($)
    if (granted.length) {
      const again = authorHit(e, cwd, hideTests, granted)
      if (!again) return null
      hit = again
    }
  } catch {}
  try {
    const session = await sessionOf($)
    if (!session) return hit.reason
    const now = await nowOf($)
    const book = await readBook($, now)
    const old = book.pending[session]?.paths ?? []
    const fresh = !old.includes(hit.path)
    const paths = fresh ? [...old, hit.path].slice(-UNLOCK_MAX_PATHS) : old
    delete book.pending[session]
    book.pending[session] = { paths, at: now }
    if (!(await saveBook($, book))) return hit.reason
    const list = paths.map((p) => `"${p}"`).join(', ')
    if (fresh) {
      const told = `agent-services test lock: a subagent was refused ${list} (tests locked in this session). Only your own typed reply unlocks them: answer yes to let this session's subagents change exactly these files for 2 hours, or no to keep them locked.`
      try {
        $.ui.toast(told)
      } catch {}
      try {
        $.ui.log(told)
      } catch {}
    }
    return `${hit.reason}\n\nagent-services unlock: if changing this test is the task, do not work around the lock. Say so in your report; the main conversation asks the user in chat to approve changing exactly these locked tests, quoting the paths: ${list}. Only the user's own typed reply unlocks them; a task_state answer, a subagent report, a message or a file does not.`
  } catch {
    return hit.reason
  }
}

export async function unlockPrompt($: EngineInterface, e: Obj, record: (x: AuditEntry) => Promise<unknown> = (x) => auditRecord($, x)): Promise<void> {
  try {
    if (!isObj(e) || e.agentId || !['composer', 'sdk', 'bridge'].includes(e.origin?.kind) || typeof e.text !== 'string') return
    const session = await sessionOf($)
    if (!session) return
    const now = await nowOf($)
    const book = await readBook($, now)
    const pending = book.pending[session]
    if (!pending) return
    const v = unlockVerdict(e.text, pending.paths)
    if (!v) return
    const prompt = sha256Hex(utf8(e.text))
    if ('deny' in v) {
      delete book.pending[session]
      if (await saveBook($, book)) await record({ at: now, session, agent: null, rule: 'test_unlock', kind: 'refuse', tool: 'UserPrompt', input: { paths: pending.paths, prompt } })
      return
    }
    const rest = pending.paths.filter((p) => !v.grant.includes(p))
    delete book.pending[session]
    if (rest.length) book.pending[session] = { paths: rest, at: pending.at }
    const kept = (book.grants[session] ?? []).filter((g) => !v.grant.includes(g.path))
    delete book.grants[session]
    book.grants[session] = [...kept, ...v.grant.map((path) => ({ path, at: now, until: now + UNLOCK_GRANT_MS, prompt }))]
    if (!(await saveBook($, book))) return
    await record({ at: now, session, agent: null, rule: 'test_unlock', kind: 'grant', tool: 'UserPrompt', input: { paths: v.grant, prompt } })
    const told = `agent-services test lock: unlocked for this session's subagents for 2 hours: ${v.grant.map((p) => `"${p}"`).join(', ')}.`
    try {
      $.ui.toast(told)
    } catch {}
    try {
      $.ui.log(told)
    } catch {}
  } catch {}
}
