import { isAbsPath, normPath, normpath } from './paths'
import { canAsk } from './choice'
import { levelNow, methodsActive, queueNotice, seenVersion } from './methods'
import type { Level } from './methods'
import { autonomyNote, readAutonomy } from './autonomy'
import { askVerdict, knownVerdict, PLAN_STEPS_SENT_MAX } from './gate_verdict'
import type { AskGate, GateLevel, GateState } from './gate_verdict'
import { ToolboxPush } from './toolbox'
import { runLimitsAgain } from './run_limits'
import { watchAgain } from './watch'
import { ADVICE_LABEL } from './delegate'
import { failureHintIndex } from './failure_hint'
export { methodsStart } from './methods'

export const STATE_FILE = 'agent-state.md'
export const WRITE_TOOLS: readonly string[] = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
export const PHASE_WAIT_MS = 2000
export const STATE_TEMPLATE = 'phase: planning\n\n## Goal\n\n## Open questions\n\n## Plan\n'
export const STATE_EXAMPLE = 'phase: running\n\n## Goal\n\nFix the login timeout.\n\n## Open questions\n\n## Plan\n\n' +
  '- [ ] t1: Raise the timeout and add a test for it.\n'

export type PhaseState = { exists: boolean; phase: 'planning' | 'running'; goal: string; plan: string[] }
type Read = (path: string) => Promise<string | null>
type Obj = Record<string, unknown>

export function parseState(text: string | null): PhaseState {
  if (typeof text !== 'string') return { exists: false, phase: 'planning', goal: '', plan: [] }
  const lines = text.slice(0, 256 * 1024).split(/\r?\n/).filter((l) => l.length <= 500)
  const head = lines.find((l) => l.trim() !== '') ?? ''
  const m = /^phase\s*:\s*(planning|running)\s*$/i.exec(head.trim())
  const phase = m && m[1]!.toLowerCase() === 'running' ? 'running' : 'planning'
  const goal: string[] = []
  const plan: string[] = []
  let section = ''
  for (const line of lines) {
    const hm = /^\s{0,3}(#{1,6})\s+([\s\S]*)$/.exec(line)
    const h = hm && !/[\r\u2028\u2029]/.test(hm[2]!.trimEnd()) ? hm : null
    if (h && h[1]!.length <= 3) {
      let title = h[2]!.trimEnd()
      let end = title.length
      while (end > 0 && title[end - 1] === '#') end--
      title = title.slice(0, end).trimEnd()
      const t = h[1]!.length === 1 ? '' : title.toLowerCase()
      section = /^goals?\b/.test(t) ? 'goal' : /^plan\b/.test(t) ? 'plan' : /^open questions?\b/.test(t) ? 'open questions' : ''
      continue
    }
    if (h) continue
    if (section === 'goal' && line.trim()) goal.push(line.trim())
    const item = section === 'plan' ? /^\s*(?:[-*+]|\d{1,3}[.)]) +(\S.*)$/.exec(line) : null
    if (item) plan.push(item[1]!.trim())
  }
  return { exists: true, phase, goal: goal.join('\n'), plan }
}

export function gateState(s: PhaseState, level: GateLevel = 'on'): GateState {
  return { exists: s.exists, running: s.phase === 'running', goal: s.goal !== '', plan_steps: Math.min(s.plan.length, PLAN_STEPS_SENT_MAX), level }
}

export function isRunning(s: PhaseState, level: GateLevel = 'suggest'): boolean {
  const v = knownVerdict(gateState(s, level))
  return v ? !v.hold : s.phase === 'running'
}

export const workOpen = (s: PhaseState, level: GateLevel = 'on'): boolean => !knownVerdict(gateState(s, level))?.hold

const trimDir = (p: string): string => normPath(p).replace(/\/+$/, '')

export const statePath = (cwd: string): string => `${trimDir(cwd)}/${STATE_FILE}`

export function isStatePath(path: unknown, cwd: string): boolean {
  if (typeof path !== 'string' || !path) return false
  let p = normPath(path)
  if (!/^[A-Za-z]:\//.test(p) && !p.startsWith('/')) p = `${trimDir(cwd)}/${p}`
  const parts: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '.') continue
    if (seg === '..' && parts.length > 1) parts.pop()
    else parts.push(seg)
  }
  const full = parts.join('/').toLowerCase()
  return full === statePath(cwd).toLowerCase() || full.startsWith(`${trimDir(cwd)}/.agent/`.toLowerCase())
}

export function fillReason(reason: string, cwd: string): string {
  const vars: Record<string, string> = { path: statePath(cwd), example: STATE_EXAMPLE, template: STATE_TEMPLATE }
  return reason.replace(/\{(path|example|template)\}/g, (_all, k: string) => vars[k]!)
}

export function writeDeny(tool: unknown, input: Obj, cwd: string, text: string | null, level: GateLevel = 'on'): string | null {
  if (typeof tool !== 'string' || !WRITE_TOOLS.includes(tool)) return null
  if (isStatePath(input.file_path ?? input.notebook_path ?? input.path, cwd)) return null
  const v = knownVerdict(gateState(parseState(text), level))
  if (!v || !v.hold || !v.reason) return null
  return fillReason(v.reason, cwd)
}

export type GateDeps = {
  active(): Promise<boolean>
  cwd(): Promise<string | null>
  read: Read
  ask?: AskGate | null
  level?: GateLevel
}

type Check = { why: string | null; small: number | null }

async function gateCheck(tool: unknown, input: Obj, d: GateDeps): Promise<Check> {
  const none: Check = { why: null, small: null }
  try {
    if (typeof tool !== 'string' || !WRITE_TOOLS.includes(tool)) return none
    if (!(await d.active())) return none
    const start = await d.cwd()
    if (typeof start !== 'string' || !start) return none
    let cwd = trimDir(start)
    let text = await d.read(statePath(cwd))
    for (let dir = cwd, i = 0; text === null && i < 8; i++) {
      const up = dir.replace(/\/[^/]*$/, '')
      if (!up || up === dir || !up.includes('/')) break
      dir = up
      const t = await d.read(statePath(dir))
      if (t !== null) { cwd = dir; text = t }
    }
    const target = input.file_path ?? input.notebook_path ?? input.path
    if (isStatePath(target, cwd)) return none
    const full = typeof target === 'string'
      ? normpath(isAbsPath(normPath(target)) ? normPath(target) : `${cwd}/${normPath(target)}`) : null
    if (full !== null && !`${full.toLowerCase()}/`.startsWith(`${normpath(cwd).toLowerCase()}/`)) return none
    const level = d.level ?? 'on'
    const v = await askVerdict(gateState(parseState(text), level), d.ask ?? null)
    return { why: writeDeny(tool, input, cwd, text, level), small: v ? v.small_edit_lines : null }
  } catch {
    return none
  }
}

export async function toolGate(tool: unknown, input: Obj, d: GateDeps): Promise<string | null> {
  return (await gateCheck(tool, input, d)).why
}

const lines = (v: unknown): number => (typeof v === 'string' && v ? v.split(/\r?\n/).length : 0)

export function smallEdit(tool: unknown, input: Obj, max: number | null): boolean {
  if (typeof max !== 'number') return false
  const one = (e: unknown) => (e && typeof e === 'object' ? Math.max(lines((e as Obj).old_string), lines((e as Obj).new_string)) : Infinity)
  const all = (e: unknown) => !!e && typeof e === 'object' && (e as Obj).replace_all === true
  if (tool === 'Edit') return !all(input) && one(input) <= max
  if (tool === 'MultiEdit') {
    return Array.isArray(input.edits) && !input.edits.some(all) && input.edits.reduce((n: number, e) => n + one(e), 0) <= max
  }
  return false
}

type Runtime = {
  session?: unknown
  svc: { authState(): Promise<string> }
  store?: { get(key: string): Promise<unknown> }
  core?: { servedGate?(session: unknown, state: Obj): Promise<unknown> }
  readText: Read
  sleep: (ms: number) => Promise<unknown>
} | null

function askOf(r: { session?: unknown; core?: { servedGate?(session: unknown, state: Obj): Promise<unknown> } }): AskGate | null {
  const core = r.core
  if (!core || typeof core.servedGate !== 'function') return null
  return (s) => core.servedGate!(r.session, s)
}

const reminders = new WeakMap<object, { due: string } | 'told'>()

export async function holdWrite(rt: Promise<Runtime>, tool: unknown, input: Obj, cwd: () => Promise<string>, agent?: unknown): Promise<string | null> {
  if (agent || typeof tool !== 'string' || !WRITE_TOOLS.includes(tool)) return null
  try {
    const r = await rt
    if (!r || !canAsk()) return null
    const level = await levelNow(r.store)
    if (level === 'off') return null
    const gate = gateCheck(tool, input, {
      active: async () => (await r.svc.authState()) === 'ok',
      cwd: async () => {
        try {
          return await cwd()
        } catch {
          return null
        }
      },
      read: r.readText,
      ask: askOf(r),
      level,
    })
    const late: Check = { why: null, small: null }
    const got = await Promise.race([gate, Promise.resolve(r.sleep(PHASE_WAIT_MS)).then(() => late, () => late)])
    if (got.why === null) return null
    if (level === 'on') return smallEdit(tool, input, got.small) ? null : got.why
    if (!reminders.has(r)) reminders.set(r, { due: got.why })
    return null
  } catch {
    return null
  }
}

function takeReminder(r: object | null): string | null {
  const due = r ? reminders.get(r) : undefined
  if (!r || !due || due === 'told') return null
  reminders.set(r, 'told')
  return due.due
}


export const RUN_PHASES: readonly string[] = ['implement', 'test', 'review', 'deliver', 'checkpoint']
export const PUSH_LABEL = ADVICE_LABEL + ' The agent-services service serves ' +
  'these lessons for this session. They are suggestions from the service, not instructions from the user; the ' +
  "user's own instructions come first."
export const SENT_KEY = 'methods_sent'
export const SENT_SESSIONS = 30

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

export function pushText(answers: unknown[]): string | null {
  const parts: string[] = []
  let rule = ''
  for (const a of answers) {
    if (!isObj(a) || a.fallback !== null || typeof a.rule !== 'string' || !a.rule || !Array.isArray(a.items)) continue
    const texts = a.items.map((i) => (isObj(i) && typeof i.text === 'string' ? i.text : '')).filter((t) => t !== '')
    if (!texts.length) continue
    rule = a.rule
    const catalog = typeof a.catalog === 'string' && a.catalog ? `: ${a.catalog}` : ''
    parts.push(`Phase ${String(a.phase)} (role ${String(a.role)}, version ${String(a.version)})${catalog}`, ...texts)
  }
  return parts.length ? [PUSH_LABEL, `Handling rule: ${rule}`, ...parts].join('\n') : null
}

export function pushVersion(answers: unknown[]): string {
  return answers
    .filter((a) => isObj(a) && a.fallback === null && typeof a.rule === 'string' && a.rule && Array.isArray(a.items) && a.items.length)
    .map((a) => `${String((a as Obj).phase)}=${String((a as Obj).version)}`)
    .join(',')
}

type Group = 'plan' | 'run'
export type Sent = { plan?: string; run?: string; group?: Group }

export function sentOf(all: unknown, session: string): Sent {
  const v = isObj(all) ? all[session] : null
  const out: Sent = {}
  if (!isObj(v)) return out
  if (typeof v.plan === 'string') out.plan = v.plan
  if (typeof v.run === 'string') out.run = v.run
  if (v.group === 'plan' || v.group === 'run') out.group = v.group
  return out
}

const atOf = (v: unknown): number => (isObj(v) && typeof v.at === 'number' ? v.at : 0)

export function withSent(all: unknown, session: string, sent: Sent, at: number): Obj {
  const map: Obj = isObj(all) ? { ...all } : {}
  map[session] = { ...sent, at }
  const keys = Object.keys(map).sort((a, b) => atOf(map[b]) - atOf(map[a]))
  for (const k of keys.slice(SENT_SESSIONS)) delete map[k]
  return map
}

export type PushDeps = {
  active(): Promise<boolean>
  ask(phase: string): Promise<unknown>
  read: Read
  sleep: (ms: number) => Promise<unknown>
  waitMs?: number
  seen?: { get(): Promise<Sent>; set(s: Sent): Promise<unknown> }
  gate?: AskGate | null
  level?: () => Promise<GateLevel>
}

type Batch = Promise<unknown[]>

export class LessonPush {
  private readonly d: PushDeps
  private batch: Record<Group, Batch | null> = { plan: null, run: null }
  private checked = new Set<Group>()
  private sent: Sent | null = null
  private repush = false
  private version: string | null = null

  constructor(d: PushDeps) {
    this.d = d
  }

  private fetch(phases: readonly string[]): Batch {
    return Promise.all(phases.map((p) => Promise.resolve().then(() => this.d.ask(p)).catch(() => null)))
  }

  async start(): Promise<void> {
    try {
      if (!this.batch.plan && !this.checked.has('plan') && (await this.d.active())) this.batch.plan = this.fetch(['plan'])
    } catch {
    }
  }

  again(): void {
    this.repush = true
  }

  async prompt(cwd: () => Promise<string | null>): Promise<string | null> {
    let timer: Promise<undefined>
    try {
      timer = Promise.resolve(this.d.sleep(this.d.waitMs ?? PHASE_WAIT_MS)).then(() => undefined, () => undefined)
    } catch {
      return null
    }
    return Promise.race([this.take(cwd, timer).catch(() => null), timer.then(() => null)])
  }

  private async load(): Promise<Sent> {
    if (!this.sent) {
      let s: Sent = {}
      try {
        if (this.d.seen) s = await this.d.seen.get()
      } catch {
        s = {}
      }
      this.sent = isObj(s) ? { ...s } : {}
    }
    return this.sent
  }

  private forget(sent: Sent, g: Group): void {
    delete sent[g]
    this.checked.delete(g)
  }

  private async take(cwd: () => Promise<string | null>, timer: Promise<undefined>): Promise<string | null> {
    let late = false
    void timer.then(() => { late = true })
    if (!(await this.d.active())) return null
    const sent = await this.load()
    if (!this.checked.has('plan') && !this.batch.plan) this.batch.plan = this.fetch(['plan'])
    const group: Group = (await this.running(cwd)) ? 'run' : 'plan'
    let changed = false
    if (this.repush) {
      this.repush = false
      this.forget(sent, group)
    } else if (sent.group && sent.group !== group) {
      this.forget(sent, group)
    }
    if (sent.group !== group) {
      sent.group = group
      changed = true
    }
    const groups: Group[] = group === 'run' ? ['plan', 'run'] : ['plan']
    for (const g of groups) {
      if (!this.checked.has(g) && !this.batch[g]) this.batch[g] = this.fetch(g === 'plan' ? ['plan'] : RUN_PHASES)
    }
    const got = await Promise.all(groups.map((g) => (this.batch[g] ? Promise.race([this.batch[g]!, timer]) : undefined)))
    if (late) return null
    const answers: unknown[] = []
    groups.forEach((g, i) => {
      const a = got[i]
      if (!a) return
      this.batch[g] = null
      this.checked.add(g)
      const version = pushVersion(a)
      if (!version) return
      if (sent[g] === version) return
      sent[g] = version
      changed = true
      answers.push(...a)
    })
    if (changed && this.d.seen) {
      try {
        await this.d.seen.set({ ...sent })
      } catch {
      }
    }
    const text = pushText(answers)
    const v = answers.find((a) => isObj(a) && typeof a.version === 'string' && a.version) as Obj | undefined
    if (text && v) this.version = String(v.version)
    return text
  }

  takeVersion(): string | null {
    const v = this.version
    this.version = null
    return v
  }

  private async running(cwd: () => Promise<string | null>): Promise<boolean> {
    const dir = await cwd().catch(() => null)
    if (typeof dir !== 'string' || !dir) return false
    const s = parseState(await this.d.read(statePath(dir)))
    const level: GateLevel = this.d.level ? await this.d.level().catch((): GateLevel => 'suggest') : 'suggest'
    if (this.d.gate) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const half = new Promise<void>((res) => { timer = setTimeout(res, (this.d.waitMs ?? PHASE_WAIT_MS) / 2) })
      await Promise.race([askVerdict(gateState(s, level), this.d.gate), half])
      if (timer) clearTimeout(timer)
    }
    return isRunning(s, level)
  }
}

type PushStore = { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }
type PushRuntime = {
  session: string
  svc: { authState(): Promise<string> }
  core: {
    ask(tool: string, args: unknown, o: { session: unknown; harness?: unknown; cwd?: unknown }): Promise<Obj>
    servedGate?(session: unknown, state: Obj): Promise<unknown>
    toolboxIndex?(session: string): Promise<unknown>
  }
  readText: Read
  sleep: (ms: number) => Promise<unknown>
  store?: PushStore
} | null

const pushes = new WeakMap<object, LessonPush>()
const toolboxes = new WeakMap<object, ToolboxPush>()

function toolboxPush(r: NonNullable<PushRuntime>): ToolboxPush | null {
  if (typeof r.core.toolboxIndex !== 'function') return null
  let p = toolboxes.get(r)
  if (!p) {
    p = new ToolboxPush({
      active: async () => (await r.svc.authState()) === 'ok',
      index: () => r.core.toolboxIndex!(r.session).then((a) => (failureHintIndex(a), a)),
      sleep: r.sleep,
      waitMs: PHASE_WAIT_MS,
    })
    toolboxes.set(r, p)
  }
  return p
}

function sentStore(store: PushStore | undefined, session: string): PushDeps['seen'] {
  if (!store) return undefined
  return {
    get: async () => sentOf(await store.get(SENT_KEY), session),
    set: async (s) => store.set(SENT_KEY, withSent(await store.get(SENT_KEY), session, s, Date.now())),
  }
}

function lessonPush(r: NonNullable<PushRuntime>): LessonPush {
  let p = pushes.get(r)
  if (!p) {
    p = new LessonPush({
      active: async () => (await r.svc.authState()) === 'ok',
      ask: (phase) => r.core.ask('lesson_lookup', { role: 'auto', phase }, { session: r.session, harness: 'claude-code' }),
      read: r.readText,
      sleep: r.sleep,
      seen: sentStore(r.store, r.session),
      gate: askOf(r),
      level: async () => ((await levelNow(r.store)) === 'on' ? 'on' : 'suggest'),
    })
    pushes.set(r, p)
  }
  return p
}

export async function pushStart(r: PushRuntime): Promise<void> {
  try {
    if (r) await lessonPush(r).start()
  } catch {
  }
}

let onNoteSent = false

async function pushLevel(r: NonNullable<PushRuntime>): Promise<Level> {
  return levelNow(r.store)
}

export function pushAgain(r: PushRuntime, agent: unknown): void {
  try {
    if (r && !agent) { lessonPush(r).again(); toolboxPush(r)?.again(); onNoteSent = false; runLimitsAgain(); watchAgain() }
  } catch {
  }
}

export async function pushLessons(rt: Promise<PushRuntime>, agent: unknown, cwd: () => Promise<string>,
  notify?: (line: string) => void): Promise<string[]> {
  if (agent) return []
  let toolbox: Promise<string | null> = Promise.resolve(null)
  try {
    const r = await rt
    const level = r ? await pushLevel(r) : 'off'
    if (!r || level === 'off') return []
    toolbox = toolboxPush(r)?.prompt() ?? Promise.resolve(null)
    const push = lessonPush(r)
    let text = level === 'suggest' && !methodsActive() ? await push.prompt(async () => cwd()) : null
    const version = push.takeVersion()
    if (text && r.store) {
      const note = autonomyNote(await readAutonomy(r.store))
      if (note) text = `${text}\n${note}`
      const told = version ? await seenVersion(r.store, version) : null
      if (told) (notify ?? queueNotice)(told)
    } else if (!text && (level === 'on' || methodsActive()) && !onNoteSent && r.store && (await r.svc.authState()) === 'ok') {
      const note = autonomyNote(await readAutonomy(r.store))
      if (note) { text = note; onNoteSent = true }
    }
    const remind = takeReminder(r)
    return [text, await toolbox, remind].filter((t): t is string => !!t)
  } catch {
    const tb = await toolbox.catch(() => null)
    return tb ? [tb] : []
  }
}
