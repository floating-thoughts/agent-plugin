// The served workflow table (rules.ts, table `workflow`): the thresholds and advice texts of the turn notes (flow.ts),
// the checkpoint answers (checkpoint.ts) and the update and changed-methods notes (review.ts). The planning gate
// (phase.ts) no longer reads it: its verdict comes from the service (gate_verdict.ts). The plugin keeps only the
// engines; each reads its section here, and without the table (signed out, or not arrived yet) every value is null
// and the feature does nothing.
import { rulesTable } from './rules'

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

/** One section of the served workflow table, or null. */
export function workflowPart(name: string): Obj | null {
  const t = rulesTable<Obj>('workflow')
  const p = isObj(t) ? t[name] : null
  return isObj(p) ? p : null
}

/** A whole number of at least `min` from a section, or null. */
export function servedInt(part: string, key: string, min = 1): number | null {
  const v = workflowPart(part)?.[key]
  return typeof v === 'number' && Number.isInteger(v) && v >= min ? v : null
}


/** A text from a section with its {name} placeholders filled from `vars` (unknown ones stay), or null. */
export function servedText(part: string, key: string, vars: Record<string, string | number> = {}): string | null {
  const v = workflowPart(part)?.[key]
  if (typeof v !== 'string' || v === '') return null
  return v.replace(/\{(\w+)\}/g, (all, k: string) => (Object.prototype.hasOwnProperty.call(vars, k) ?String(vars[k]) : all))
}
