import { cleanGlob } from './brief_check'
import { lockedBy } from './flow'
import { globMatch } from './glob'
import { clean } from './guard'
import { candidatesOf, stampState } from './memory_facts'
import { globsOverlap } from './ownership'
import { redact } from './redact'
import { relNum, relText } from './reliability'
import { vaultMask } from './vault'

export type MemProject = { description: string; map: string[] }
export type MemModule = { id: string; globs: string[]; line: string }
export type MemEdge = { from: string; to: string; kind: 'calls' | 'data'; what: string }
export type MemModules = { modules: MemModule[]; map: MemEdge[] }
export type MemIntro = { text: string; see: string | null }
export type MemCandidate = { id: string; globs: string[]; files: number }
export type IntroState = 'none' | 'ok' | 'stale'
export type ModuleMark = { state: IntroState; commits?: number | null }
export type ProjectStale = { uncovered: string[]; empty: string[] }

const num = (k: string): number | undefined => relNum(`memory.${k}`)
const txt = (k: string, vars?: Record<string, string | number>): string | undefined => relText(`memory.text.${k}`, vars)
const idOk = (id: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(id) && !id.includes('..')


export function memSections(text: string | null | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  if (typeof text !== 'string') return out
  let cur: string[] | null = null
  for (const raw of text.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*#*\s*$/.exec(raw)
    if (h && !raw.startsWith('###')) {
      const name = h[1]!.toLowerCase()
      cur = out[name] ?? (out[name] = [])
      continue
    }
    if (cur) cur.push(raw.replace(/\s+$/, ''))
  }
  for (const k of Object.keys(out)) {
    const l = out[k]!
    while (l.length && !l[0]) l.shift()
    while (l.length && !l[l.length - 1]) l.pop()
  }
  return out
}

export function parseProject(text: string | null | undefined): MemProject | null {
  const s = memSections(text)
  if (!s['description'] && !s['map']) return null
  return { description: (s['description'] ?? []).join('\n').trim(), map: (s['map'] ?? []).filter((l) => l.trim() !== '') }
}

function globsOf(part: string): string[] {
  const out: string[] = []
  for (const w of part.split(/[,\s]+/)) {
    const g = w ? cleanGlob(w) : null
    if (g && !g.split('/').includes('..') && !out.includes(g)) out.push(g)
  }
  return out
}

export function parseModules(text: string | null | undefined): MemModules | null {
  const s = memSections(text)
  if (!s['modules'] && !s['map']) return null
  const modules: MemModule[] = []
  for (const l of s['modules'] ?? []) {
    const m = /^\s*[-*]\s+`?([^\s:`]+)`?\s*:\s*(.*)$/.exec(l)
    if (!m || !idOk(m[1]!) || modules.some((x) => x.id === m[1])) continue
    const dash = m[2]!.search(/\s[-\u2013\u2014]\s/)
    const globs = globsOf(dash < 0 ? m[2]! : m[2]!.slice(0, dash))
    if (!globs.length) continue
    modules.push({ id: m[1]!, globs, line: dash < 0 ? '' : m[2]!.slice(dash + 3).trim() })
  }
  const map: MemEdge[] = []
  for (const l of s['map'] ?? []) {
    const m = /^\s*[-*]\s+`?([^\s`]+?)`?\s*->\s*`?([^\s:`]+)`?\s*:\s*(calls|data)\b\s*(.*)$/i.exec(l)
    if (m) map.push({ from: m[1]!, to: m[2]!, kind: m[3]!.toLowerCase() as 'calls' | 'data', what: m[4]!.trim() })
  }
  return { modules, map }
}

export function parseIntro(text: string | null | undefined): MemIntro | null {
  if (typeof text !== 'string') return null
  const body = text.trim()
  if (!body) return null
  const m = /^\s*see:\s*`?([^`\s][^`]*?)`?\s*$/im.exec(body)
  return { text: body, see: m ? m[1]! : null }
}

export function introPath(id: string): string | null {
  return typeof id === 'string' && idOk(id) ? `.agent/memory/modules/${id}.md` : null
}


export function moduleCandidates(files: readonly string[]): MemCandidate[] | null {
  const cap = num('CANDIDATE_FILES_MAX')
  if (cap === undefined || !Array.isArray(files)) return null
  const paths = files.filter((f): f is string => typeof f === 'string')
    .map((f) => f.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^"|"$/g, '')).filter((p) => p.indexOf('/') > 0)
  return candidatesOf(paths, Math.max(1, Math.floor(cap)), Number.MAX_SAFE_INTEGER).modules
}

export function moduleOf(file: string, modules: readonly MemModule[], cwd: string | null = null): string | null {
  try {
    for (const m of modules) if (lockedBy(file, cwd, m.globs)) return m.id
  } catch {}
  return null
}

export const memGlobMatch = (glob: string, path: string): boolean => globMatch(glob, path.replace(/\\/g, '/'))


export const introState: (hasIntro: boolean, stamp: string | null | undefined, treeHash: string | null | undefined) => IntroState | null = stampState

export function projectStale(modules: readonly MemModule[], candidates: readonly MemCandidate[] | null): ProjectStale | null {
  const budget = num('OVERLAP_BUDGET')
  if (budget === undefined || !Array.isArray(candidates) || !candidates.length) return null
  const hit = (a: readonly string[], b: readonly string[]): boolean =>
    a.some((x) => b.some((y) => globsOverlap(x, y, true, budget)))
  const uncovered = candidates.filter((c) => !modules.some((m) => hit(m.globs, c.globs))).map((c) => c.id)
  const empty = modules
    .filter((m) => m.globs.every((g) => g.includes('/')) && !candidates.some((c) => hit(m.globs, c.globs)))
    .map((m) => m.id)
  return { uncovered, empty }
}


export function memLine(text: unknown, max: number): string {
  let t: string
  try {
    t = clean(redact(vaultMask(String(text ?? ''))))
  } catch {
    return '(withheld)'
  }
  t = t.replace(/\s+/g, ' ').trim().replace(/</g, '&lt;')
  return t.length > max ? `${t.slice(0, Math.max(0, max - 3))}...` : t
}

function maskWhole(text: string): string {
  try {
    return redact(vaultMask(text))
  } catch {
    return '(withheld)'
  }
}

function block(attrs: string, header: string, lines: readonly string[], max: number, lineMax: number): string {
  const kept: string[] = []
  let used = 0
  let i = 0
  for (; i < lines.length; i++) {
    const l = lines[i]!
    if (used + l.length + 1 > max) break
    kept.push(l)
    used += l.length + 1
  }
  if (i < lines.length) {
    const cut = txt('truncated', { n: lines.length - i })
    if (cut !== undefined) kept.push(memLine(cut, lineMax))
  }
  return `<agent-memory ${attrs}>\n${memLine(header, lineMax)}\n${kept.join('\n')}\n</agent-memory>`
}

const markOf = (mark: ModuleMark | undefined): string => {
  if (!mark) return ''
  const t = mark.state === 'none' ? txt('mark_none') : mark.state === 'stale'
    ? txt('mark_stale', { commits: typeof mark.commits === 'number' && Number.isFinite(mark.commits) ? mark.commits : '?' })
    : txt('mark_ok')
  return t ? ` ${t}` : ''
}

export function renderOverview(project: MemProject | null, modules: MemModules | null, opts: {
  marks?: Record<string, ModuleMark> | null; stale?: ProjectStale | null; candidates?: readonly MemCandidate[] | null
} = {}): string | null {
  try {
    const header = txt('header')
    const max = num('OVERVIEW_MAX_CHARS')
    const lineMax = num('LINE_MAX_CHARS')
    if (header === undefined || max === undefined || lineMax === undefined) return null
    const L = (s: unknown): string => memLine(s, lineMax)
    const lines: string[] = []
    if (!project && !modules) {
      const cold = txt('cold')
      const capC = num('COLD_CANDIDATES_MAX')
      if (cold === undefined || capC === undefined) return null
      lines.push(L(cold))
      for (const c of (opts.candidates ?? []).slice(0, Math.max(0, capC))) {
        const t = txt('candidate', { id: c.id, globs: c.globs.join(', '), files: c.files })
        if (t !== undefined) lines.push(L(t))
      }
      return block('layer="overview"', header, lines, max, lineMax)
    }
    const descMax = num('DESCRIPTION_MAX_CHARS')
    const mapMax = num('MAP_LINES_MAX')
    const modMax = num('MODULES_MAX')
    if (descMax === undefined || mapMax === undefined || modMax === undefined) return null
    if (project) {
      lines.push('# project.md')
      if (project.description) {
        lines.push('## Description')
        const desc = maskWhole(project.description)
        const d = desc.length > descMax ? `${desc.slice(0, Math.max(0, descMax - 3))}...` : desc
        for (const p of d.split(/\n+/)) if (p.trim()) lines.push(L(p))
      }
      if (project.map.length) {
        lines.push('## Map')
        for (const l of project.map.slice(0, Math.max(0, mapMax))) lines.push(L(l))
      }
    }
    if (modules) {
      lines.push('# modules.md')
      if (modules.modules.length) {
        lines.push('## Modules')
        for (const m of modules.modules.slice(0, Math.max(0, modMax))) {
          lines.push(L(`- ${m.id}: ${m.globs.join(', ')}${m.line ? ` - ${m.line}` : ''}${markOf(opts.marks?.[m.id])}`))
        }
      }
      if (modules.map.length) {
        lines.push('## Map')
        for (const e of modules.map.slice(0, Math.max(0, mapMax))) lines.push(L(`- ${e.from} -> ${e.to}: ${e.kind}${e.what ? ` ${e.what}` : ''}`))
      }
    }
    const st = opts.stale
    if (st && (st.uncovered.length || st.empty.length)) {
      const t = txt('project_stale', { uncovered: st.uncovered.slice(0, 8).join(', ') || '-', empty: st.empty.slice(0, 8).join(', ') || '-' })
      if (t !== undefined) lines.push(L(t))
    }
    return block('layer="overview"', header, lines, max, lineMax)
  } catch {
    return null
  }
}

export function renderIntro(id: string, intro: MemIntro | null, mark: ModuleMark | null = null): string | null {
  try {
    const header = txt('header')
    const max = num('INTRO_MAX_CHARS')
    const lineMax = num('LINE_MAX_CHARS')
    const title = txt('intro_title', { id })
    if (!idOk(id) || header === undefined || max === undefined || lineMax === undefined || title === undefined) return null
    const lines = [memLine(`${title}${markOf(mark ?? undefined)}`, lineMax)]
    if (!intro) {
      const none = txt('intro_none', { id, path: introPath(id) ?? '' })
      if (none === undefined) return null
      lines.push(memLine(none, lineMax))
    } else {
      if (intro.see) {
        const see = txt('intro_see', { path: intro.see })
        if (see !== undefined) lines.push(memLine(see, lineMax))
      }
      for (const l of maskWhole(intro.text).split(/\r?\n/)) if (l.trim()) lines.push(memLine(l, lineMax))
    }
    return block(`layer="module" id="${id}"`, header, lines, max, lineMax)
  } catch {
    return null
  }
}
