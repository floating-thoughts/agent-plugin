import type { EngineInterface } from 'claude-code'

export type PlanStep = { id: string; text: string; deps: string[]; status: 'todo' | 'running' | 'done'; evidence?: string; owns?: string[] }

export const PLAN_FILE = 'agent-state.md'

const slash = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')

export function planSteps(text: string | null): PlanStep[] {
  if (typeof text !== 'string') return []
  const out: PlanStep[] = []
  const seen = new Set<string>()
  let inPlan = false
  for (const line of text.slice(0, 256 * 1024).split(/\r?\n/)) {
    if (line.length > 500) continue
    const h = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      if (h[1]!.length <= 3) inPlan = h[1]!.length > 1 && /^plan\b/i.test(h[2]!.trim())
      continue
    }
    if (!inPlan) continue
    const m = /^\s*(?:[-*+]|\d{1,3}[.)]) +\[([ xX~])\] +([A-Za-z0-9][\w.-]{0,39}) *: *(.*)$/.exec(line)
    if (!m) continue
    let rest = m[3]!.trim()
    let deps: string[] = []
    let owns: string[] = []
    let evidence: string | undefined
    for (let i = 0; i < 6; i++) {
      const g = /\(\s*(after|evidence|owns)\s*:\s*([^()]*)\)\s*$/i.exec(rest)
      if (!g) break
      rest = rest.slice(0, g.index).trim()
      const kind = g[1]!.toLowerCase()
      if (kind === 'after') deps = g[2]!.split(/[\s,]+/).filter((d) => d !== '').slice(0, 50)
      else if (kind === 'owns') owns = g[2]!.split(/[\s,]+/).filter((d) => d !== '').slice(0, 50)
      else evidence = g[2]!.trim()
    }
    const id = m[2]!
    if (seen.has(id)) continue
    seen.add(id)
    const box = m[1]!.toLowerCase()
    const step: PlanStep = { id, text: rest, deps, status: box === 'x' ? 'done' : box === '~' ? 'running' : 'todo' }
    if (evidence) step.evidence = evidence
    if (owns.length) step.owns = owns
    out.push(step)
    if (out.length >= 1000) break
  }
  return out
}

export function stepsText(stateText: string | null, jsonText: string | null): string | null {
  const steps = planSteps(stateText)
  return steps.length ? JSON.stringify({ steps }) : jsonText
}

async function readSmall($: EngineInterface, path: string): Promise<string | null> {
  try {
    const text = String(await $.fs.read(path))
    return text.length > 256 * 1024 ? null : text
  } catch {
    return null
  }
}

export async function readPlan($: EngineInterface, jsonFiles: readonly string[], moreDirs: readonly unknown[] = []): Promise<{ text: string; file: string } | null> {
  let cwd: unknown = null
  try {
    cwd = await $.session.cwd()
  } catch {}
  const dirs = [cwd, ...moreDirs].filter((d): d is string => typeof d === 'string' && d !== '').map(slash)
  if (dirs.length) {
    for (let dir = dirs[0]!, i = 0; i < 9; i++) {
      const state = await readSmall($, `${dir}/${PLAN_FILE}`)
      if (state !== null) {
        if (planSteps(state).length) return { text: stepsText(state, null)!, file: PLAN_FILE }
        break
      }
      const up = dir.replace(/\/[^/]*$/, '')
      if (!up || up === dir || !up.includes('/')) break
      dir = up
    }
  }
  for (const dir of dirs) {
    for (const file of jsonFiles) {
      const text = await readSmall($, `${dir}/${file}`)
      if (text !== null) return { text, file }
    }
  }
  return null
}
