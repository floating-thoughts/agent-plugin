import { RELIABILITY_TABLES, reliabilityTable } from './rules'

function relValue(key: string): unknown {
  for (const name of RELIABILITY_TABLES) {
    const t = reliabilityTable(name)
    if (t && Object.prototype.hasOwnProperty.call(t, key)) return t[key]
  }
  return undefined
}

export function relNum(key: string): number | undefined {
  const v = relValue(key)
  if (typeof v === 'boolean') return v ? 1 : 0
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export function relText(key: string, vars: Record<string, string | number> = {}): string | undefined {
  const v = relValue(key)
  if (typeof v !== 'string') return undefined
  return v.replace(/\{([a-z_][a-z0-9_]*)\}/gi, (m, k: string) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m)
}

export function relOn(table: string): boolean {
  return reliabilityTable(table) !== null
}
