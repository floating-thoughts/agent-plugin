import { rulesTable } from './rules'

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

export function workflowPart(name: string): Obj | null {
  const t = rulesTable<Obj>('workflow')
  const p = isObj(t) ? t[name] : null
  return isObj(p) ? p : null
}

export function servedInt(part: string, key: string, min = 1): number | null {
  const v = workflowPart(part)?.[key]
  return typeof v === 'number' && Number.isInteger(v) && v >= min ? v : null
}


export function servedText(part: string, key: string, vars: Record<string, string | number> = {}): string | null {
  const v = workflowPart(part)?.[key]
  if (typeof v !== 'string' || v === '') return null
  return v.replace(/\{(\w+)\}/g, (all, k: string) => (Object.prototype.hasOwnProperty.call(vars, k) ?String(vars[k]) : all))
}
