import type { EngineInterface } from 'claude-code'

type Obj = Record<string, any>
export type Row = { role?: unknown; text?: unknown; toolResults?: unknown }

export function asRows(messages: unknown): Row[] {
  if (!Array.isArray(messages)) return []
  return messages.map((m): Row => {
    if (!m || typeof m !== 'object') return {}
    const o = m as Obj
    if (typeof o.text === 'string' || !('content' in o)) return o as Row
    const blocks: Obj[] = typeof o.content === 'string' ? [{ type: 'text', text: o.content }] : Array.isArray(o.content) ? o.content : []
    const texts = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => String(b.text))
    const kept = o.role === 'user' ? texts.filter((t) => !t.trim().startsWith('<')) : texts
    return { role: o.role, text: kept.join('\n'), toolResults: blocks.filter((b) => b && b.type === 'tool_result') }
  })
}

export async function recentRows($: EngineInterface, max: number): Promise<Row[]> {
  for (const read of [() => $.session.messages({ as: 'api' }), () => $.session.messages()]) {
    try {
      const got: unknown = await read()
      if (Array.isArray(got)) return asRows(got.slice(-max))
    } catch {}
  }
  return []
}
