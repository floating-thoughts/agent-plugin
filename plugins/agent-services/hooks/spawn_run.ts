import type { EngineInterface } from 'claude-code'
import { budgetSpawned } from './budget'
import { evidenceSpawn } from './evidence'
import { jobSpawned } from './jobs'
import { briefBody, ownershipSpawn } from './ownership'
import { NOTE_PREFIX } from './review'
import { snapSpawned } from './snapshot'

type Ev = Record<string, any>
type Ready = Promise<any> | undefined

export const SPAWN_CHAIN_MS = 7500
export const SPAWN_START_BY_MS = 5500
export const SPAWN_STAGE_MS = 2500

export type SpawnCap = {
  stage<T>(name: string, p: Promise<T> | T, dflt: T, after?: boolean): Promise<T>
  left(after?: boolean): number
  cut: string[]
}

function within<T>(p: Promise<T>, ms: number): Promise<{ v: T } | null> {
  if (ms <= 0) return Promise.resolve(null)
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((res) => { timer = setTimeout(() => res(null), ms) })
  return Promise.race([p.then((v) => ({ v })), late]).finally(() => clearTimeout(timer))
}

export function spawnCap(now: () => number = Date.now): SpawnCap {
  const t0 = now()
  const cut: string[] = []
  const left = (after = false) => t0 + (after ? SPAWN_CHAIN_MS : SPAWN_START_BY_MS) - now()
  return {
    cut,
    left,
    async stage<T>(name: string, p: Promise<T> | T, dflt: T, after = false): Promise<T> {
      if (!p || typeof (p as any).then !== 'function') return p as T
      const q = Promise.resolve(p)
      const got = await within(q, Math.min(SPAWN_STAGE_MS, left(after)))
      if (got) return got.v
      q.catch(() => undefined)
      cut.push(name)
      return dflt
    },
  }
}

export function spawnCutLine(cap: SpawnCap): string | null {
  return cap.cut.length ? `${NOTE_PREFIX}: the subagent started without these slow steps of agent-services: ${[...new Set(cap.cut)].join(', ')}.` : null
}

export async function spawnRun($: EngineInterface, e: Ev, ev: Ev, next: (x: Ev) => Promise<any>, rt: Ready, routed: boolean, cap: SpawnCap): Promise<any> {
  let started: Promise<any> | null = null
  const once = (x: Ev): Promise<any> => (started ??= next(x))
  const work: Promise<any> = ownershipSpawn($, ev, async (x: Ev) => {
    const s: Ev = await once(x)
    await cap.stage('job row', jobSpawned($, x, s, rt), undefined, true)
    if (routed) budgetSpawned(x, s)
    await cap.stage('snapshot', snapSpawned($, x, s), undefined, true)
    return s
  }, rt)
  const early = await within(work, cap.left())
  let spawned: any
  if (early) spawned = early.v
  else {
    if (!started) cap.cut.push('write ownership')
    const s = await once(ev)
    const rest = await within(work, cap.left(true))
    if (!rest) {
      work.catch(() => undefined)
      cap.cut.push('after start')
    }
    spawned = rest ? rest.v : s
  }
  await cap.stage('acceptance files', evidenceSpawn($, spawned?.agentId, briefBody(e.prompt), rt), undefined, true)
  return spawned
}
