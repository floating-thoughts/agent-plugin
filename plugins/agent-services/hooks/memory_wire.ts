import type { EngineInterface } from 'claude-code'
import { EDIT_TOOLS } from './flow'
import { introPath, moduleOf, parseIntro, parseModules, parseProject, projectStale, renderIntro, renderOverview, type MemCandidate, type MemModules, type ModuleMark } from './memory'
import { factsStart, introState, readFacts, stampIntro, type MemoryFacts } from './memory_facts'
import { methodsLevel } from './methods_level'
import { relNum } from './reliability'
import { engineStore } from './store'
import { projectDir } from './task_state_io'
import { noteRound } from './task_wire'

type Obj = Record<string, any>
type Ready = Promise<unknown> | undefined

export const MEMORY_DIR = '.agent/memory'

let givenRound = -1
let intros = new Map<string, Set<string>>()

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const slashed = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
const withContext = (o: Obj, block: string): Obj => ({ ...o, context: [...(Array.isArray(o.context) ? o.context : []), block] })

async function active($: EngineInterface, rt: Ready): Promise<boolean> {
  try {
    const r = (await rt) as { svc?: { authState?: () => Promise<string> } } | null
    if (!r || typeof r.svc?.authState !== 'function' || (await r.svc.authState()) !== 'ok') return false
    return (await methodsLevel(engineStore($))) !== 'off'
  } catch {
    return false
  }
}

async function readText($: EngineInterface, path: string): Promise<string | null> {
  try {
    if ((await $.fs.exists(path)) !== true) return null
    return String(await $.fs.read(path))
  } catch {
    return null
  }
}

function candidatesOf(facts: MemoryFacts | null): MemCandidate[] | null {
  if (!facts) return null
  return facts.modules.filter((m) => m.globs.every((g) => g.includes('/'))).map((m) => ({ id: m.id, globs: m.globs, files: m.files }))
}

export function markOf(hasIntro: boolean, facts: MemoryFacts | null, id: string): ModuleMark | undefined {
  if (!hasIntro) return { state: 'none' }
  if (!facts) return undefined
  const st = introState(facts, id.toLowerCase())
  if (st.state === 'ok') return { state: 'ok' }
  return { state: 'stale', commits: st.state === 'stale' && !st.more ? st.since : null }
}

async function modulesAt($: EngineInterface, dir: string): Promise<MemModules | null> {
  return parseModules(await readText($, `${dir}/${MEMORY_DIR}/modules.md`))
}

async function overview($: EngineInterface): Promise<string | null> {
  const dir = await projectDir($)
  if (!dir) return null
  const root = slashed(dir)
  const [pText, modules, facts] = await Promise.all([readText($, `${root}/${MEMORY_DIR}/project.md`), modulesAt($, root), readFacts($)])
  const candidates = candidatesOf(facts)
  let marks: Record<string, ModuleMark> | null = null
  if (modules) {
    marks = {}
    for (const m of modules.modules) {
      const p = introPath(m.id)
      const mark = markOf(!!p && (await $.fs.exists(`${root}/${p}`).catch(() => false)) === true, facts, m.id)
      if (mark) marks[m.id] = mark
    }
  }
  return renderOverview(parseProject(pText), modules, { marks, stale: modules ? projectStale(modules.modules, candidates) : null, candidates })
}

export async function memoryStart($: EngineInterface, rt: Ready): Promise<void> {
  try {
    if (await active($, rt)) void factsStart($)
  } catch {}
}

export async function memoryPrompt($: EngineInterface, e: Obj, rt: Ready): Promise<Obj> {
  if (!isObj(e) || e.agentId) return e
  try {
    const round = noteRound()
    if (round === givenRound || !(await active($, rt))) return e
    givenRound = round
    intros.delete('')
    const block = await overview($)
    return block ? withContext(e, block) : e
  } catch {
    return e
  }
}

export async function memoryToolEnd($: EngineInterface, e: Obj, done: Obj, rt: Ready): Promise<Obj> {
  try {
    if (!isObj(e) || !isObj(done) || done.deny !== undefined || done.isError === true || (e.tool !== 'Read' && !EDIT_TOOLS.includes(String(e.tool)))) return done
    const file = e.file_path ?? e.notebook_path
    if (typeof file !== 'string' || !file) return done
    const agent = typeof e.agentId === 'string' ? e.agentId : ''
    const cap = relNum('memory.INTROS_PER_SESSION')
    const given = intros.get(agent) ?? new Set<string>()
    const wrote = EDIT_TOOLS.includes(String(e.tool))
    if (!wrote && (cap === undefined || given.size >= cap)) return done
    if (!(await active($, rt))) return done
    const dir = await projectDir($)
    if (!dir) return done
    const root = slashed(dir)
    const modules = await modulesAt($, root)
    if (wrote) {
      const m = /(?:^|\/)\.agent\/memory\/modules\/([^/]+)\.md$/i.exec(slashed(file))
      const abs = slashed(file).toLowerCase()
      if (m && introPath(m[1]!) && (!/^([a-z]:)?\//i.test(abs) || abs.startsWith(`${root.toLowerCase()}/`))) {
        const globs = modules?.modules.find((x) => x.id.toLowerCase() === m[1]!.toLowerCase())?.globs
        void stampIntro($, m[1]!, globs)
        return done
      }
    }
    if (!modules || cap === undefined || given.size >= cap) return done
    const id = moduleOf(file, modules.modules, root)
    if (!id || given.has(id)) return done
    given.add(id)
    if (!intros.has(agent) && intros.size >= 500) intros = new Map<string, Set<string>>()
    intros.set(agent, given)
    const p = introPath(id)
    const intro = p ? parseIntro(await readText($, `${root}/${p}`)) : null
    const block = renderIntro(id, intro, markOf(!!intro, await readFacts($), id) ?? null)
    return block ? withContext(done, block) : done
  } catch {
    return done
  }
}

export function memoryResetForTest(): void {
  givenRound = -1
  intros = new Map()
}
