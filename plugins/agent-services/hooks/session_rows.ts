import type { EngineInterface } from 'claude-code'

type Obj = Record<string, any>
export type Row = { role?: unknown; text?: unknown; toolResults?: unknown }

export function asRows(messages: unknown): Row[] {
  if (!Array.isArray(messages)) return []
  return messages.map((m): Row => {
    if (!m || typeof m !== 'object') return {}
    let o = m as Obj
    if (typeof o.text !== 'string' && !('content' in o) && o.message && typeof o.message === 'object') {
      o = { role: o.message.role ?? o.role ?? o.type, content: o.message.content ?? o.message.text ?? '' }
    }
    if (typeof o.text === 'string' || !('content' in o)) return o as Row
    const blocks: Obj[] = typeof o.content === 'string' ? [{ type: 'text', text: o.content }] : Array.isArray(o.content) ? o.content : []
    const texts = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => String(b.text))
    const kept = o.role === 'user' ? texts.filter((t) => !t.trim().startsWith('<')) : texts
    return { role: o.role, text: kept.join('\n'), toolResults: blocks.filter((b) => b && b.type === 'tool_result') }
  })
}

export async function recentRaw($: EngineInterface, max: number): Promise<{ form: string; messages: unknown[] }> {
  try {
    const got: unknown = await $.session.messages({ as: 'api' })
    if (Array.isArray(got)) return { form: 'api', messages: got.slice(-max) }
  } catch {}
  try {
    const got: unknown = await $.session.messages()
    if (Array.isArray(got)) return { form: 'rows', messages: got.slice(-max) }
  } catch {}
  return { form: 'none', messages: [] }
}

export async function recentRows($: EngineInterface, max: number): Promise<Row[]> {
  return asRows((await recentRaw($, max)).messages)
}

export function holdsToolUse(messages: unknown, id: unknown): boolean {
  if (!Array.isArray(messages) || typeof id !== 'string' || !id) return false
  return messages.some((m) => {
    if (!m || typeof m !== 'object') return false
    const o = m as Obj
    const blocks = [o.content, o.message?.content, o.toolUses].filter(Array.isArray).flat() as Obj[]
    return blocks.some((b) => b && typeof b === 'object' && (b.id === id || b.tool_use_id === id) && b.type !== 'tool_result')
  })
}

export function transcriptLines(text: string, max: number): Row[] {
  const lines = text.split('\n')
  const out: Obj[] = []
  for (let i = lines.length - 1; i >= 0 && out.length < max; i--) {
    const l = lines[i].trim()
    if (!l.startsWith('{')) continue
    try {
      const o = JSON.parse(l)
      if (o && (o.type === 'user' || o.type === 'assistant') && !o.isSidechain && o.message) out.push(o)
    } catch {}
  }
  return asRows(out.reverse())
}

export async function transcriptRows($: EngineInterface, max: number): Promise<Row[]> {
  try {
    const path = String((await $.session.info())?.transcriptPath ?? '')
    if (!path) return []
    const text = String(await $.fs.read(path))
    return text.length > 32 * 1024 * 1024 ? [] : transcriptLines(text, max)
  } catch {
    return []
  }
}
