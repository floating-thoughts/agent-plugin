
import { relNum, relText } from './reliability'

export type BriefPart = 'goal' | 'check' | 'files' | 'off_limits' | 'handback'

export const BRIEF_PARTS: readonly BriefPart[] = ['goal', 'check', 'files', 'off_limits', 'handback']

export const READ_ONLY_TYPES: readonly string[] = ['Explore', 'Plan', 'claude-code-guide', 'web-fetch']

export const PART_RX: Readonly<Record<BriefPart, readonly RegExp[]>> = {
  goal: [
    /^[ \t>*#_-]*(goal|goals|objective|aim|purpose|task|mission|context|background|problem)\b[^\n:]{0,30}:/im,
    /\b(the goal|your goal|objective|so that|in order to|done means|the aim|your (task|job)|you (build|write|fix|add|implement|find|review|investigate|check|update|port|create|make|refactor|research|audit|design|plan))\b/i,
    /^[ \t]*(fix|add|build|write|implement|find|review|investigate|update|port|create|make|refactor|remove|rename|move|migrate|test|check|research|read|search|explore|audit|draft|design|plan|analy[sz]e|summari[sz]e|compare|look|debug|run|change|convert|replace|improve|clean|delete|wire|extract|translate|document|verify|measure|profile|benchmark|diagnose|trace|collect|list|answer)\b/im,
  ],
  check: [
    /^[ \t>*#_-]*(check|checks|test|tests|testing|verify|verification|validation|acceptance|success|done when|done means|definition of done)\b[^\n:]{0,40}:/im,
    /\b(pytest|npm (run )?test|npx (jest|vitest|tsc|playwright)|jest|vitest|cargo (test|check|build|clippy)|go (test|vet|build)|tsc|ruff|eslint|mypy|pyright|make (test|check)|gradle|mvn|dotnet test|ctest|node --test|bun test|deno test|unittest|lune|selene|stylua)\b/i,
    /\btests? (pass|passes|must pass|are green|stay green|go green)\b/i,
  ],
  files: [
    /^[ \t>*#_`-]*(owns|files|you own|you may (change|edit|touch|write)|allowed( files)?|write scope|scope|may (change|edit))\b[^\n:]{0,40}:/im,
    /\b(you own only|you own|only (edit|change|touch|write)|files? you may (change|edit|touch|write))\b/i,
  ],
  off_limits: [
    /\b(do not|don't|never|must not|may not|mustn't|cannot|can't|should not|shouldn't)\s+(touch|edit|change|modify|write|commit|push|delete|alter|create)\b/i,
    /\b(not touch|read[- ]only|off[- ]limits|out of scope|leave (it|them|everything else) (alone|untouched|as (it|they) (is|are))|everything else|nothing else|no other (file|files))\b/i,
  ],
  handback: [
    /\b(report|hand[- ]?back|handback|reply|return (a|the|your|with|only)|final (message|answer|report|response)|summary|summari[sz]e (what|your)|tell me|respond with|output (a|the))\b/i,
  ],
}

export const CHECK_MAX = 300

const scanMax = (): number | undefined => relNum('brief_check.BRIEF_SCAN_MAX')
const head = (text: unknown): string => {
  const max = scanMax()
  return typeof text === 'string' && max !== undefined ? text.slice(0, max) : ''
}

export function isWriterType(subagentType: unknown): boolean {
  return !(typeof subagentType === 'string' && READ_ONLY_TYPES.includes(subagentType))
}

export function missingParts(text: unknown, writer = true): BriefPart[] {
  if (scanMax() === undefined) return []
  const t = head(text)
  const needed: readonly BriefPart[] = writer ? BRIEF_PARTS : ['goal', 'handback']
  return needed.filter((p) => !PART_RX[p].some((r) => r.test(t)))
}

export function editTaskWord(description: unknown): boolean {
  return typeof description === 'string' && /^\s*(implement|debug|tests|refactor|merge)(?![\w-])/i.test(description)
}

export function missingText(missing: readonly BriefPart[]): string {
  const names = missing.map((p) => relText(`brief_check.text.part_${p}`))
  if (names.some((n) => n === undefined)) return ''
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

export function globProblem(glob: string): string | null {
  const max = relNum('brief_check.GLOB_MAX')
  if (max === undefined || glob.length === 0 || glob.length > max) return 'too long or empty'
  if (glob.split('/').includes('..')) return 'leaves the project'
  if (!/[^*?/.]/.test(glob)) return 'too broad'
  return null
}

export function cleanGlob(token: string): string | null {
  let g = String(token).trim().replace(/^[('"`[{<]+/, '').replace(/[)'"`\]}>,;:!]+$/, '')
  if (/[^.]\.$/.test(g)) g = g.slice(0, -1)
  g = g.replace(/\\/g, '/').replace(/^(\.\/)+/, '')
  if (!/[/.*?]/.test(g)) return null
  if (g.endsWith('/')) g = `${g.replace(/\/+$/, '')}/**`
  return g
}

export function ownedPart(value: string): string {
  let v = value
  for (let i = 0; i < 5 && /\([^()]*\s[^()]*\)/.test(v); i++) v = v.replace(/\([^()]*\s[^()]*\)/g, ' ')
  const kept: string[] = []
  for (const clause of v.split(/\.(?=\s|$)/)[0]!.split(/[,;]|\s[-\u2013\u2014]+\s/)) {
    if (/\b(do\s*n['\u2019]?t|do not|never|must\s*n['\u2019]?t|must not|may not|should\s*n['\u2019]?t|should not|cannot|can['\u2019]?t|not (yours|your|ours|owned|to be)|leave\b[^,;]{0,40}\balone|off[- ]limits|read[- ]only|except|excluding|but not|none of|owned by|belongs? to|someone else|another (agent|worker|subagent|session|job)|other (agents?|workers?|subagents?|sessions?|jobs?)|parallel (agents?|workers?|subagents?)|their (files?|paths?))\b/i.test(clause)) break
    if (/^\s*not\b/i.test(clause) || /^\s*[A-Za-z][A-Za-z -]{1,30}:(\s|$)/.test(clause)) break
    kept.push(clause)
  }
  return kept.join(' ')
}

export function ownsOf(text: unknown): { globs: string[]; dropped: { glob: string; why: string }[] } {
  const globs: string[] = []
  const dropped: { glob: string; why: string }[] = []
  const max = relNum('brief_check.OWNS_MAX') ?? 0
  for (const line of head(text).split(/\r?\n/)) {
    const m = /^[\s>*_`-]*owns[`*_]*\s*:[`*_]*\s*(.*)$/i.exec(line)
    if (!m) continue
    for (const word of ownedPart(m[1] ?? '').split(/[\s,;]+/)) {
      const g = cleanGlob(word)
      if (g === null) continue
      const why = globProblem(g)
      if (why) dropped.push({ glob: [...g].length > 80 ? `${[...g].slice(0, 77).join('')}...` : g, why })
      else if (!globs.includes(g) && globs.length < max) globs.push(g)
    }
  }
  return { globs, dropped }
}

export type NoTool = { tool: string; arg: string | null }

export function noToolsOf(text: unknown): NoTool[] {
  const out: NoTool[] = []
  const max = relNum('brief_check.NO_TOOLS_MAX') ?? 0
  for (const line of head(text).split(/\r?\n/)) {
    const m = /^[\s>*_`-]*no[- _]tools[`*_]*\s*:[`*_]*\s*(.*)$/i.exec(line)
    if (!m) continue
    let depth = 0
    let cur = ''
    const parts: string[] = []
    for (const ch of m[1] ?? '') {
      if (ch === '(') depth++
      else if (ch === ')') depth = Math.max(0, depth - 1)
      if (depth === 0 && (ch === ',' || ch === ';')) {
        parts.push(cur)
        cur = ''
      } else cur += ch
    }
    parts.push(cur)
    for (const raw of parts) {
      const p = raw.trim().replace(/^[`'"]+|[`'".]+$/g, '').trim()
      const e = /^([A-Za-z0-9_*.-]{1,200})\s*(?:\((.{1,300})\))?$/.exec(p)
      if (!e || !/[^*]/.test(e[1]!)) continue
      const rule = { tool: e[1]!, arg: e[2]?.trim() || null }
      if (out.length < max && !out.some((r) => r.tool === rule.tool && r.arg === rule.arg)) out.push(rule)
    }
  }
  return out
}

export function checkOf(text: unknown): string | null {
  for (const line of head(text).split(/\r?\n/)) {
    const m = /^[\s>*_-]*`?check[`*_]*\s*:[*_]*\s*(.*)$/i.exec(line)
    if (!m) continue
    let c = (m[1] ?? '').trim()
    const fenced = /^`+([^`]+)`+\s*[.;]?$/.exec(c)
    if (fenced) c = fenced[1]!.trim()
    c = c.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
    if (c) return c.slice(0, CHECK_MAX)
  }
  return null
}
