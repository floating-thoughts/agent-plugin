import { count } from './pyfmt'

export const PREFIX = 'agent-services this session: '
export const END_KINDS = ['clear', 'session_end']

const TIERS = ['haiku', 'sonnet', 'opus', 'fable', 'mythos']

type Out = Record<string, unknown>

export function tier(model: unknown): number | null {
  if (typeof model !== 'string') return null
  const m = model.toLowerCase()
  const i = TIERS.findIndex((name) => m.includes(name))
  return i >= 0 ? i : null
}

export function cheaper(routed: unknown, _requested?: unknown, _mainModel?: unknown): boolean {
  const n = tier(routed)
  return n !== null && n < TIERS.indexOf('opus')
}

const part = (n: number, one: string, many: string): string | null => (n > 0 ? `${count(n)} ${n === 1 ? one : many}` : null)

export function summaryLine(subagents: number, compactions: number, blocked: number): string | null {
  const parts = [
    part(subagents, 'subagent on a cheaper model', 'subagents on cheaper models'),
    part(compactions, 'compaction', 'compactions'),
    part(blocked, 'risky command blocked', 'risky commands blocked'),
  ].filter((p): p is string => !!p)
  return parts.length ? PREFIX + parts.join(', ') : null
}

export class SessionSummary {
  private readonly table = new Map<string, [number, number, number]>()

  private bump(sid: string, i: 0 | 1 | 2): void {
    let c = this.table.get(sid)
    if (!c) this.table.set(sid, (c = [0, 0, 0]))
    c[i] += 1
  }

  counts(sid: string): [number, number, number] {
    const c = this.table.get(sid)
    return c ? [c[0], c[1], c[2]] : [0, 0, 0]
  }

  drop(sid: string): void {
    this.table.delete(sid)
  }

  take(sid: string): string | null {
    const c = this.table.get(sid)
    this.table.delete(sid)
    return c ? summaryLine(c[0], c[1], c[2]) : null
  }

  observe(kind: string, event: Out, out: Out, mainModel: unknown = null): void {
    const sid = event.session as string
    const action = out.action
    if (kind === 'dispatch' && action === 'rewrite') {
      const s = (out.set && typeof out.set === 'object' ? out.set : {}) as Out
      if (cheaper(s.model, event.model, mainModel)) this.bump(sid, 0)
    } else if (kind === 'compaction' && (event.agent ?? null) === null && event.done === true && event.trigger !== 'precompute') {
      this.bump(sid, 1)
    } else if (kind === 'pre_tool' && action === 'deny') {
      this.bump(sid, 2)
    }
  }

  after(kind: string, event: Out, out: Out, mainModel: unknown = null): Out {
    try {
      this.observe(kind, event, out, kind === 'dispatch' ? mainModel : null)
      if (END_KINDS.includes(kind)) {
        const line = this.take(event.session as string)
        if (line) {
          const old = out.notice
          out.notice = typeof old === 'string' && old ? `${old}\n${line}` : line
        }
      }
    } catch {
    }
    return out
  }
}
