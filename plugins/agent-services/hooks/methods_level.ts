import { levelNow, type Level } from './methods'

export type MethodsLevel = Level

export async function methodsLevel(store: { get(key: string): Promise<unknown> }): Promise<MethodsLevel> {
  return levelNow(store)
}
