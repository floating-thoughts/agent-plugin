import type { KV } from './engine_types'
import type { WiringFs } from './wiring'
import { localDay } from './counters'
import { isDay } from './metrics'
import { sha256Hex } from './e2e'

export const USAGE_TOOL_KEY = 'usage_tool'
export const USAGE_TOOL_EVERY_MS = 15 * 60 * 1000
export const USAGE_TOOL_TIMEOUT_MS = 300_000
export const USAGE_TOOL_SHA256: readonly string[] = ['896270070a3c13198093dbcca628eb3007080e7b51d6f8458623627cb7862d3e']

export type ProcessRun = (
  argv: string[],
  opts: { timeoutMs: number; stdin?: string },
) => Promise<{ exitCode?: number | null; stdout?: string; stderr?: string }>

export type ToolDeps = {
  fs: WiringFs
  store: KV
  dataDir: string
  projectsRoot: string | null
  prices: unknown
  run: ProcessRun | null
  now: number
}

export type DaysRow = Record<string, number>
type Obj = Record<string, any>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function validDays(o: unknown): Record<string, DaysRow> | null {
  if (!isObj(o) || !isObj(o.days)) return null
  const names = ['tokens', 'cache_read_tokens', 'usd', 'typed_bytes', 'agent_seconds', 'agent_sum_seconds', 'turns']
  const entries = Object.entries(o.days)
  if (entries.length > 5000) return null
  const out: Record<string, DaysRow> = {}
  for (const [day, v] of entries) {
    const at = isDay(day) ? new Date(`${day}T12:00:00Z`) : null
    const real = at !== null && Number.isFinite(at.getTime()) && at.toISOString().slice(0, 10) === day
    if (!real || !isObj(v) || Object.keys(v).length !== names.length) return null
    const row: DaysRow = {}
    for (const k of names) {
      const n = num(v[k])
      if (n === null || n < 0) return null
      row[k] = n
    }
    out[day] = row
  }
  return out
}

async function safeGet(kv: KV, key: string): Promise<unknown> {
  try {
    return await kv.get(key)
  } catch {
    return undefined
  }
}

async function safeSet(kv: KV, key: string, value: unknown): Promise<void> {
  try {
    await kv.set(key, value)
  } catch {}
}

async function previous(d: ToolDeps, path: string): Promise<{ at: number; days: Record<string, DaysRow> } | null> {
  try {
    const o = JSON.parse(String(await d.fs.read(path)))
    const days = validDays({ days: o?.days })
    return isObj(o) && num(o.at) !== null && days ? { at: o.at, days } : null
  } catch {
    return null
  }
}

export async function refreshToolDays(d: ToolDeps): Promise<string> {
  if (!d.run || !d.projectsRoot) return 'absent'
  const held = await safeGet(d.store, USAGE_TOOL_KEY)
  const h: Obj = isObj(held) ? held : {}
  if ((num(h.lock) ?? 0) > d.now) return 'busy'
  if (num(h.at) !== null && d.now >= h.at && d.now - h.at < USAGE_TOOL_EVERY_MS) return 'fresh'
  const root = d.dataDir.replace(/[\\/]+$/, '')
  const tool = `${root}/tools/usage_scan.py`
  let present = false
  try {
    present = typeof d.fs.list === 'function' && (await d.fs.list(`${root}/tools`)).some((e) => e.name === 'usage_scan.py' && e.dir !== true)
  } catch {}
  if (!present) {
    await safeSet(d.store, USAGE_TOOL_KEY, { at: d.now, ok: false, error: 'absent' })
    return 'absent'
  }
  let pinned = false
  try {
    const text = String(await d.fs.read(tool)).replace(/\r\n/g, '\n')
    pinned = USAGE_TOOL_SHA256.includes(sha256Hex(new TextEncoder().encode(text)))
  } catch {}
  if (!pinned) {
    await safeSet(d.store, USAGE_TOOL_KEY, { at: d.now, ok: false, error: 'unknown_tool' })
    return 'absent'
  }
  const holder = `${d.now}-${Math.random()}`
  await safeSet(d.store, USAGE_TOOL_KEY, { ...h, lock: d.now + USAGE_TOOL_TIMEOUT_MS + 60_000, holder })
  const back = await safeGet(d.store, USAGE_TOOL_KEY)
  if (!isObj(back) || back.holder !== holder) return 'busy'
  const file = `${root}/services/time-days.json`
  const prev = await previous(d, file)
  const sinceDay = prev ? localDay(prev.at) : null
  const stdin = JSON.stringify({ root: d.projectsRoot, since_ms: sinceDay ? new Date(`${sinceDay}T00:00:00`).getTime() : null, prices: d.prices ?? {} })
  const launchers: string[][] = [['py', '-3'], ['python3'], ['python']]
  const known = Array.isArray(h.launcher) && h.launcher.every((x: unknown) => typeof x === 'string') ? (h.launcher as string[]) : null
  if (known) launchers.sort((a, b) => Number(b.join(' ') === known.join(' ')) - Number(a.join(' ') === known.join(' ')))
  let error = 'no python'
  let got: Record<string, DaysRow> | null = null
  let used: string[] | null = null
  for (const l of launchers) {
    const t0 = Date.now()
    let r: { exitCode?: number | null; stdout?: string; stderr?: string }
    try {
      r = await d.run([...l, '-I', tool, '--days'], { timeoutMs: USAGE_TOOL_TIMEOUT_MS, stdin })
    } catch {
      if (Date.now() - t0 > 5000) {
        error = 'failed'
        break
      }
      continue
    }
    if (r.exitCode !== 0) {
      error = `exit ${r.exitCode}`
      if (Date.now() - t0 > 5000 || String(r.stderr ?? '').includes('usage_scan')) break
      continue
    }
    const out = String(r.stdout ?? '')
    if (out.length > 8 * 1024 * 1024) {
      error = 'too_large'
      break
    }
    try {
      got = validDays(JSON.parse(out))
    } catch {
      got = null
    }
    if (!got) error = 'bad_output'
    else used = l
    break
  }
  if (!got || !used) {
    await safeSet(d.store, USAGE_TOOL_KEY, { at: d.now, ok: false, error, ...(known ? { launcher: known } : {}) })
    return 'failed'
  }
  const days: Record<string, DaysRow> = {}
  for (const [day, v] of Object.entries(prev?.days ?? {})) if (sinceDay === null || day < sinceDay) days[day] = v
  for (const [day, v] of Object.entries(got)) if (sinceDay === null || day >= sinceDay) days[day] = v
  const sorted = Object.fromEntries(Object.keys(days).sort().map((k) => [k, days[k]]))
  try {
    await d.fs.write(file, JSON.stringify({ at: d.now, by: 'usage_tool', days: sorted }))
  } catch {
    await safeSet(d.store, USAGE_TOOL_KEY, { at: d.now, ok: false, error: 'write', launcher: used })
    return 'failed'
  }
  await safeSet(d.store, USAGE_TOOL_KEY, { at: d.now, ok: true, launcher: used })
  return 'ran'
}
