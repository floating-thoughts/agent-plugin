import { relText } from './reliability'
import { NOTE_PREFIX } from './review'

export type Autonomy = 'auto' | 'ask'

export const AUTONOMY_LINE = 'Autonomy: fully automatic (the agent-services default; tell Claude how you want it to ' +
  'work and that wins).'

export const readAutonomy = async (_kv?: unknown): Promise<Autonomy> => 'auto'

export const autonomyNote = (_c?: Autonomy | null): string | null => relText('autonomy.text.note', { prefix: NOTE_PREFIX }) ?? null
