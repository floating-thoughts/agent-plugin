import { RX_INPUT_MAX, riskyPattern } from './rules'
import { workflowPart } from './workflow_table'

type Obj = Record<string, unknown>

let shown: Record<string, true> = {}

function matches(pattern: unknown, text: string): boolean {
  if (typeof pattern !== 'string' || pattern === '' || riskyPattern(pattern)) return false
  try {
    return new RegExp(pattern, 'i').test(text.slice(0, RX_INPUT_MAX))
  } catch {
    return false
  }
}

function skipped(prefix: unknown, description: unknown): boolean {
  if (typeof prefix !== 'string' || prefix === '' || typeof description !== 'string') return false
  const d = description.trim()
  return d.toLowerCase().startsWith(prefix.toLowerCase()) && d.slice(prefix.length).trim() !== ''
}

export function hwKind(e: Obj): string | null {
  const part = workflowPart('hw_hint')
  if (!part || (e.tool !== 'Bash' && e.tool !== 'PowerShell')) return null
  const command = typeof e.command === 'string' ? e.command : ''
  if (command === '' || skipped(part.skip_prefix, e.description)) return null
  if (matches(part.parallel_markers, command)) return null
  const kinds = Array.isArray(part.kinds) ? part.kinds : []
  for (const k of kinds) {
    const row = (k ?? {}) as Obj
    if (typeof row.kind === 'string' && row.kind !== '' && matches(row.pattern, command)) return row.kind
  }
  return null
}

export function hwHint(e: Obj): string | null {
  const kind = hwKind(e)
  if (kind === null) return null
  const key = `${typeof e.agentId === 'string' ? e.agentId : ''}\n${kind}`
  if (shown[key]) return null
  const part = workflowPart('hw_hint')!
  const target = typeof part.target_percent === 'number' && part.target_percent > 0 && part.target_percent <= 100 ? part.target_percent : 80
  const text = typeof part.text === 'string' ? part.text : ''
  if (text === '') return null
  shown[key] = true
  return text.split('{kind}').join(kind).split('{target}').join(String(target))
}

export function hwHintResetForTest(): void {
  shown = {}
}
