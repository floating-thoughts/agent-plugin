// Per-action receipts, ported one to one from host/receipts.py: one short line in an answer's `notice` each time
// the core applies a saving or safety action (a dispatch routed to a cheaper model, a recorded compaction saving,
// a denied risky tool call). No dollar figure, no model name. At most one receipt per kind per session every
// THROTTLE_SECONDS; a notice the answer already carries is never replaced. Memory only.

export const THROTTLE_SECONDS = 600
export const PREFIX = 'agent-services: '
export const TEXTS: Readonly<Record<string, string>> = {
  route: 'ran this subagent on a cheaper model',
  compaction: 'compacted this session at a checkpoint and recorded the saving',
  block: 'blocked a risky command',
}
export const REASON_MAX = 160
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/ // what Python's str.splitlines() splits on

type Out = Record<string, unknown>

function firstLine(text: unknown): string | null {
  if (typeof text !== 'string') return null
  const line = text.split(LINE_BREAK).map((x) => x.trim()).find((x) => x) ?? ''
  if (!line) return null
  return line.length <= REASON_MAX ? line : line.slice(0, REASON_MAX - 3).trimEnd() + '...'
}

export function receiptText(kind: string, reason: unknown = null): string {
  const text = PREFIX + TEXTS[kind]
  const r = kind === 'block' ? firstLine(reason) : null
  return r ? text + ': ' + r : text
}

export class Receipts {
  private last = new Map<string, number>() // session + '\n' + kind -> seconds of the last receipt
  private pending = new Set<string>() // noted while handling, stamped after
  private readonly now: () => number // seconds
  constructor(now: () => number) {
    this.now = now
  }

  note(session: string, kind: string): void {
    this.pending.add(session + '\n' + kind)
  }

  drop(session: string): void {
    for (const k of [...this.last.keys()]) if (k.startsWith(session + '\n')) this.last.delete(k)
    for (const k of [...this.pending]) if (k.startsWith(session + '\n')) this.pending.delete(k)
  }

  private kindOf(session: string, eventKind: string, out: Out): string | null {
    const action = out.action
    if (eventKind === 'dispatch' && action === 'rewrite') return 'route'
    if (eventKind === 'pre_tool' && action === 'deny') return 'block'
    if (eventKind === 'compaction' && this.pending.delete(session + '\ncompaction')) return 'compaction'
    return null
  }

  // Add the receipt for this answer to its notice when one is due; returns `out`.
  stamp(session: string, eventKind: string, out: Out): Out {
    if (out === null || typeof out !== 'object' || Array.isArray(out)) return out
    if (eventKind === 'session_end') {
      this.drop(session)
      return out
    }
    const kind = this.kindOf(session, eventKind, out)
    if (kind === null || out.notice) return out
    const now = this.now()
    const key = session + '\n' + kind
    const last = this.last.get(key)
    if (last !== undefined && now - last < THROTTLE_SECONDS) return out
    this.last.set(key, now)
    out.notice = receiptText(kind, out.reason)
    return out
  }
}
