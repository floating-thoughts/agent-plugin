

export function normPath(path: string): string {
  let s = path.replace(/\\/g, '/')
  const m = /^\/([a-zA-Z])\//.exec(s)
  if (m) s = m[1] + ':/' + s.slice(3)
  if (/^[a-z]:/.test(s)) s = s[0]!.toUpperCase() + s.slice(1)
  return s
}

export const isAbsPath = (p: string): boolean => /^[A-Za-z]:\//.test(p) || p.startsWith('/')

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
