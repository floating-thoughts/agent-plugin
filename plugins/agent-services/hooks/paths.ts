// Paths for indexed reads, with Windows semantics (moved from core.ts unchanged): drive-letter
// normalization, ntpath.normpath with forward slashes, and whether a file is listed in a DOCINDEX.md or has a
// codeindex page. Used by core.ts and phase.ts.
import type { ReadText } from './engine_types'

// ------------------------------------------------------------------ paths for indexed reads (Windows semantics)

export function normPath(path: string): string {
  let s = path.replace(/\\/g, '/')
  const m = /^\/([a-zA-Z])\//.exec(s)
  if (m) s = m[1] + ':/' + s.slice(3)
  if (/^[a-z]:/.test(s)) s = s[0]!.toUpperCase() + s.slice(1)
  return s
}

export const isAbsPath = (p: string): boolean => /^[A-Za-z]:\//.test(p) || p.startsWith('/')

// ntpath.normpath, written with forward slashes.
export function normpath(p: string): string {
  let s = p.replace(/\\/g, '/')
  let drive = ''
  if (/^[A-Za-z]:/.test(s)) {
    drive = s.slice(0, 2)
    s = s.slice(2)
  }
  const root = s.startsWith('/') ? '/' : ''
  const out: string[] = []
  for (const c of s.split('/')) {
    if (c === '' || c === '.') continue
    if (c === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (!root) out.push('..')
      continue
    }
    out.push(c)
  }
  const r = drive + root + out.join('/')
  return r || '.'
}

export const joinPath = (a: string, b: string): string => (/[\\/]$/.test(a) || a === '' ? a + b : a + '/' + b)
const inDir = (dir: string, name: string): string => (dir.endsWith('/') ? dir + name : dir + '/' + name)

export async function indexed(file: string, readText: ReadText): Promise<boolean> {
  const parts = file.split('/')
  for (let i = parts.length - 1; i > 0; i--) {
    const d = parts.slice(0, i).join('/')
    const dd = !d || d.endsWith(':') ? d + '/' : d
    const rel = file.slice(d.length + 1)
    let text: string | null = null
    try {
      text = await readText(inDir(dd, 'DOCINDEX.md'))
    } catch {
      text = null
    }
    if (text !== null) {
      const t = text.replace(/\\/g, '/')
      if (t.includes(rel) || t.includes(file)) return true
    }
    let page: string | null = null
    try {
      page = await readText(inDir(dd, 'codeindex/files/' + rel.split('/').join('__') + '.md'))
    } catch {
      page = null
    }
    if (page !== null) return true
  }
  return false
}
