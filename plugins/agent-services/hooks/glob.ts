
export function globMatch(glob: string, path: string): boolean {
  const g = glob.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  const toks: string[] = []
  for (let i = 0; i < g.length; i++) {
    if (g[i] === '*' && g[i + 1] === '*') {
      i++
      if (g[i + 1] === '/') { i++; toks.push('dirs') } else toks.push('any')
    } else toks.push(g[i] === '*' ? 'star' : g[i] === '?' ? 'one' : `=${g[i]}`)
  }
  const wild = (k: number) => toks[k] === 'dirs' || toks[k] === 'any' || toks[k] === 'star'
  const close = (s: Set<number>) => { for (const k of s) if (wild(k)) s.add(k + 1) }
  let cur = new Set([0])
  let inDirs = new Set<number>()
  close(cur)
  for (let i = 0; i < path.length; i++) {
    const ch = path[i]!
    const next = new Set<number>()
    const nextDirs = new Set<number>()
    for (const k of cur) {
      const t = toks[k]
      if (t === undefined) continue
      if (t === 'any') next.add(k)
      else if (t === 'star') { if (ch !== '/') next.add(k) }
      else if (t === 'one') { if (ch !== '/') next.add(k + 1) }
      else if (t === 'dirs') { nextDirs.add(k); if (ch === '/') next.add(k + 1) }
      else if (t[1] === ch || t[1]!.toLowerCase() === ch.toLowerCase() || t[1]!.toUpperCase() === ch.toUpperCase()) next.add(k + 1)
    }
    for (const k of inDirs) { nextDirs.add(k); if (ch === '/') next.add(k + 1) }
    close(next)
    cur = next
    inDirs = nextDirs
    if (!cur.size && !inDirs.size) return false
  }
  return cur.has(toks.length)
}
