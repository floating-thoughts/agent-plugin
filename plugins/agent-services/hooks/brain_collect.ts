import { ed25519, hmac, sha256 } from './noble.js'
import { b64Encode, hex, utf8 } from './e2e'
import type { Random } from './e2e'
import { canonical, sealDrop, signObject } from './sealed_crypto'
import { kidOf, readersOf } from './sealed_roster'
import type { Roster } from './sealed_roster'
import { scrubCandidate } from './brain_scrub'
import type { ScrubOpts } from './brain_scrub'

export type Rules = { min_grade?: string; daily_cap?: number; text_cap?: number }
export type Entry = { kind?: string; grade?: string | null; text?: string; share?: boolean; projects?: number | string[]; seen?: number }
export type Candidate = { v: 1; cand: string; kind: 'lesson' | 'decision'; text: string; grade: 'E2' | 'E3' | null; project: string; seen: number; t: number }
export type Withdrawal = { v: 1; withdraw: string; t: number }
export type CollectCtx = {
  rules?: Rules; scrub?: ScrubOpts; shared_today?: number; project_key: Uint8Array; project_root: string
  random: Random; clock: () => number
}
export type Collected = { candidates: Candidate[]; blocked: number; capped: number; classes: string[] }
export type ShareOpts = { org: string; vault: string; roster: Roster; dev?: string; seed: Uint8Array }
export type Send = (route: string, body: Record<string, unknown>) => Promise<unknown>

export const BRAIN_RULES = { min_grade: 'E2', daily_cap: 20, text_cap: 700 } as const

const gradeRank = (g: unknown): number => (typeof g === 'string' && /^E[0-3]$/.test(g) ? Number(g[1]) : -1)

function rulesOf(r: Rules | undefined): { min: number; cap: number; textCap: number } {
  const min = gradeRank(r?.min_grade ?? BRAIN_RULES.min_grade)
  const cap = Number.isInteger(r?.daily_cap) && (r?.daily_cap as number) >= 0 ? (r?.daily_cap as number) : BRAIN_RULES.daily_cap
  const tc = Number.isInteger(r?.text_cap) && (r?.text_cap as number) >= 1 ? Math.min(r?.text_cap as number, 700) : BRAIN_RULES.text_cap
  return { min: Math.max(min, 2), cap, textCap: tc }
}

function projectsOf(e: Entry): number {
  if (Array.isArray(e.projects)) return new Set(e.projects).size
  if (Number.isInteger(e.projects)) return e.projects as number
  return Number.isInteger(e.seen) ? (e.seen as number) : 1
}

export function qualifies(entry: Entry, rules?: Rules): boolean {
  if (!entry || typeof entry !== 'object' || typeof entry.text !== 'string' || !entry.text.trim()) return false
  const { min } = rulesOf(rules)
  if (entry.kind === 'lesson') return gradeRank(entry.grade) >= min
  if (entry.kind === 'decision') return entry.share === true || projectsOf(entry) >= 2
  return false
}

export function projectHashOf(projectKey: Uint8Array, root: string): string {
  if (!(projectKey instanceof Uint8Array) || projectKey.length !== 32) throw new Error('project_key must be 32 bytes')
  const msg = new Uint8Array([...utf8('agent-sealed/1 project'), 0, ...utf8(String(root))])
  return hex(hmac(sha256, projectKey, msg)).slice(0, 32)
}

function cut(text: string, cap: number): string {
  const cps = Array.from(text)
  if (cps.length <= cap) return text
  let head = cps.slice(0, cap - 3).join('')
  const sp = head.lastIndexOf(' ')
  if (sp >= cap * 0.6) head = head.slice(0, sp)
  return head.trimEnd() + '...'
}

export function collect(entries: Entry[], ctx: CollectCtx): Collected {
  const { cap, textCap } = rulesOf(ctx.rules)
  let room = Math.max(0, cap - (Number.isInteger(ctx.shared_today) ? (ctx.shared_today as number) : 0))
  const project = projectHashOf(ctx.project_key, ctx.project_root)
  const out: Collected = { candidates: [], blocked: 0, capped: 0, classes: [] }
  const classes = new Set<string>()
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!qualifies(e, ctx.rules)) continue
    const s = scrubCandidate(String(e.text).trim(), ctx.scrub ?? {})
    if (!s.ok) {
      out.blocked++
      s.blocked.forEach((c) => classes.add(c))
      continue
    }
    const text = cut(s.text.trim(), textCap)
    if (!text) continue
    if (room <= 0) {
      out.capped++
      continue
    }
    room--
    const decision = e.kind === 'decision'
    out.candidates.push({
      v: 1, cand: hex(ctx.random(16)), kind: decision ? 'decision' : 'lesson', text,
      grade: decision ? null : (e.grade as 'E2' | 'E3'), project, seen: Number.isInteger(e.seen) && (e.seen as number) >= 1 ? (e.seen as number) : 1, t: ctx.clock(),
    })
  }
  out.classes = [...classes].sort()
  return out
}

export function withdrawal(cand: Candidate | string, clock: () => number): Withdrawal {
  const id = typeof cand === 'string' ? cand : cand?.cand
  if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) throw new Error('not a candidate id')
  return { v: 1, withdraw: id, t: clock() }
}

export async function shareCandidates(
  items: (Candidate | Withdrawal)[], o: ShareOpts, send: Send, random: Random,
): Promise<{ cand: string; object: string; answer: unknown }[]> {
  const v = o.roster.vaults.find((x) => x.id === o.vault)
  if (!v || v.kind !== 'brain') throw new Error('not a brain vault of this roster')
  const by = kidOf(b64Encode(ed25519.getPublicKey(o.seed)))
  const readers = readersOf(o.roster, o.vault, 'inbox', by)
  const out: { cand: string; object: string; answer: unknown }[] = []
  for (const item of items) {
    const object = hex(random(16))
    const h = { org: o.org, vault: o.vault, kind: 'inbox' as const, epoch: v.epoch, object, version: 1, by }
    const obj = await sealDrop(h, readers, utf8(canonical(item)), random)
    const sig = signObject(obj, o.seed)
    const answer = await send('/sealed/put', {
      vault: o.vault, kind: 'inbox', object, epoch: v.epoch, version: 1, sha256: hex(sha256(obj)), size: obj.length,
      data_b64: b64Encode(obj), sig: b64Encode(sig),
    })
    out.push({ cand: 'cand' in item ? item.cand : item.withdraw, object, answer })
  }
  return out
}
