// The methods level for the mechanisms in flow.ts (the subagent brief and the turn notes), read without writing:
// methods.ts readLevel seeds the record. Levels: off (nothing from the served methods reaches the model), suggest
// (served as agent-services suggestions, the default), on (the user approved them into CLAUDE.md).
import { LEVEL_KEY } from './methods'
import { TRUST_KEY } from './trust'

export type MethodsLevel = 'off' | 'suggest' | 'on'

export async function methodsLevel(store: { get(key: string): Promise<unknown> }): Promise<MethodsLevel> {
  try {
    const v = await store.get(LEVEL_KEY)
    const l = v && typeof v === 'object' ? (v as { level?: unknown }).level : undefined
    if (l === 'off' || l === 'on' || l === 'suggest') return l
    const old = await store.get(TRUST_KEY) // a 0.5.0 answer not yet seeded
    const a = old && typeof old === 'object' ? (old as { answer?: unknown }).answer : undefined
    return a === 'off' ? 'off' : a === 'on' ? 'on' : 'suggest'
  } catch {
    return 'suggest'
  }
}
