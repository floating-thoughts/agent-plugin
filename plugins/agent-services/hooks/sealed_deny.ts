
import type { EngineInterface } from 'claude-code'
import { dataDir } from './engine_env'

type Obj = Record<string, any>

let knownDir = ''

export function setSealedDataDir(dir: string): void {
  knownDir = normal(String(dir ?? '').trim()).replace(/\/+$/, '')
}

export async function primeSealedDeny($: EngineInterface): Promise<void> {
  try {
    setSealedDataDir(await dataDir($))
  } catch {}
}

type Walk = { out: string[]; cut: boolean }

function stringsIn(v: unknown, w: Walk, depth = 0): Walk {
  if (w.out.length > 2000 || depth > 32) {
    w.cut = true
    return w
  }
  if (typeof v === 'string') w.out.push(v)
  else if (Array.isArray(v)) for (const x of v) stringsIn(x, w, depth + 1)
  else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Obj)) {
      w.out.push(k)
      stringsIn(x, w, depth + 1)
    }
  }
  return w
}

function mentions(v: unknown): boolean {
  let n = 0
  const hit = (s: string) => /sealed|identity/i.test(s)
  const go = (x: unknown, depth: number): boolean => {
    if (++n > 200000 || depth > 500) throw new Error('too big')
    if (typeof x === 'string') return hit(x)
    if (x === null || typeof x !== 'object') return false
    let keys: string[] = []
    try {
      keys = Object.keys(x as Obj)
    } catch {
      return false
    }
    for (const k of keys) {
      if (hit(k)) return true
      let y: unknown
      try {
        y = (x as Obj)[k]
      } catch {
        continue
      }
      if (go(y, depth + 1)) return true
    }
    return false
  }
  try {
    return go(v, 0)
  } catch {
    return true
  }
}

function normal(s: string): string {
  let t = s.toLowerCase().replace(/[`"'^]/g, '').replace(/[\\/]+/g, '/')
  for (let i = 0; i < 4 && t.includes('/./'); i++) t = t.replace(/\/\.\//g, '/')
  return t
}

export function sealedTouch(input: unknown): string | null {
  const w = stringsIn(input, { out: [], cut: false })
  const dir = knownDir
  for (const raw of w.out) {
    const s = normal(raw)
    if (/\.agent-services\/+sealed(\/|\b|$)/.test(s) || /\.agent-services\/+seal[*?[]/.test(s)) return 'key folder'
    if (s.includes('.agent-services') && /\bidentity(-[a-z0-9_-]+)?\.bin\b/.test(s)) return 'key folder'
    if (dir && dir !== '.agent-services') {
      const at = s.indexOf(`${dir}/seal`)
      if (at >= 0 && (at === 0 || !/[a-z0-9_.-]/.test(s[at - 1]!)) && /^\/seal(ed(\/|[^a-z0-9_.-]|$)|[*?[])/.test(s.slice(at + dir.length))) return 'key folder'
    }
    if (/(^|[^a-z0-9_.-])sealed\/(identity|ident[*?[]|\*)/.test(s)) return 'key folder'
    if (/\bidentity(-[a-z0-9_-]+)?\.bin\b/.test(s) && /(^|[\s;&|(])(cd|pushd|chdir|set-location|sl)\s+([^;&|\n]*[^a-z0-9_.;&|\n-])?sealed([\s;&|)/]|$)/.test(s)) return 'key folder'
    if (s.includes('agent-services-recovery-') || /agent-services-recovery[*?[]/.test(s)) return 'recovery sheet'
    if (s.includes('agent-services-sealed')) return 'keychain item'
    if (/(^|[\s;&|(])security\s+(find-generic-password|find-internet-password|dump-keychain|delete-generic-password|export)\b/.test(s)) return 'keychain item'
    if (/\bunprotect\b/.test(s) && /protecteddata|dpapi|system\.security/.test(s)) return 'dpapi unprotect'
    if (/cryptunprotectdata/.test(s)) return 'dpapi unprotect'
  }
  if (w.cut && mentions(input)) return 'unchecked input'
  return null
}

const refusal = (what: string): string =>
  `This call touches the company's sealed keys (${what}), which only the person handles through ` +
  'their own plugin commands; a hard-coded local rule refuses it for every agent. Do not try another way to reach ' +
  'these files; if the task needs the brain or ledger, ask the user to run the matching /agent-services command.'

export function sealedDeny(e: Obj): string | null {
  try {
    const { tool: _tool, agentId: _agent, tool_use_id: _call, ...input } = e && typeof e === 'object' && !Array.isArray(e) ? e : ({} as Obj)
    const what = sealedTouch(input)
    return what === null ? null : refusal(what)
  } catch {
    return mentions(e) ? refusal('unchecked input') : null
  }
}
