// The planning gate: every task has two phases, planning then running, kept in a local state document the agent
// writes, agent-state.md in the session's working directory. The plugin only reads it. The gate follows the methods
// level (methods.ts levelNow):
//
// - "on" (the user made the methods their own instructions): file changes (Edit, Write, MultiEdit, NotebookEdit) on
//   any path but agent-state.md are denied while the document is missing, says `phase: planning` (or has a
//   malformed first line), or says `phase: running` without a goal and at least one plan step. Small edits pass
//   (smallEdit: an Edit or MultiEdit that changes at most SMALL_EDIT_LINES lines in all). Writes to agent-state.md
//   always go through.
// - "suggest" (the default): nothing is denied; the first such change of a session brings one reminder line with the
//   next prompt (GATE_REMINDER).
// - "off": the gate does nothing.
// - Bash and the read tools are never held at any level: a file written through Bash is not seen by the gate.
// - No session that nobody can be asked in (a -p run, choice.ts canAsk) is held.
// - lesson_lookup answers only phase `plan` until the document is running; any other phase gets an empty item list
//   and a short reason, without asking the server. At "off" it gives no items, and at "on" it points to the
//   approved text the CLAUDE.md line already loads.
// - Subagents are never held: the gate is the main agent's startup phase, and a subagent is dispatched by a main
//   session that has already planned (often in a git worktree with no agent-state.md). The engine's `agentId` on
//   tool.call marks a subagent, the same signal prompt.submit uses (pushLessons).
// - The caller runs this only while signed in (`active`): in auth fail the plugin stays inert.
// Harness-neutral apart from the level and canAsk: reading the file, the working directory and the auth state are
// injected (register.ts wires them).
import { normPath } from './paths'
import { canAsk } from './choice'
import { levelNow, methodsActive } from './methods'
export { methodsStart } from './methods' // register.ts wires it beside pushStart

export const STATE_FILE = 'agent-state.md'
export const WRITE_TOOLS: readonly string[] = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
export const PHASE_WAIT_MS = 2000 // the gate's own cap inside a tool.call hook; later than that the call goes on
export const STATE_TEMPLATE = 'phase: planning\n\n## Goal\n\n## Open questions\n\n## Plan\n'
export const PLANNING_REASON = 'agent-services planning gate (a plugin rule): agent-state.md is still in planning (its ' +
  'first line is not `phase: running`), so file changes wait until planning is finished. Finish the goal check, write the plan under `## Plan` (one `- ` line ' +
  'per step), then set the first line to `phase: running`. Writes to agent-state.md itself are always allowed.'
export const INCOMPLETE_REASON = 'agent-services planning gate (a plugin rule): agent-state.md says `phase: running` but ' +
  'has no written goal and plan, so file changes still wait. A task can switch to running only with text under ' +
  '`## Goal` and at least one `- ` step line under `## Plan`; fill them in, then try again.'
export const LESSON_REASON = 'finish planning first (agent-state.md phase: planning)'
export const LESSON_OFF = 'the working methods are off (/agent-services methods suggest turns them back on)'
export const LESSON_ON = 'the working methods you approved are already loaded by your CLAUDE.md; follow that text'
export const SMALL_EDIT_LINES = 10 // an Edit or MultiEdit changing at most this many lines passes the gate at "on"
export const GATE_REMINDER = '[agent-services suggestion, not written by the user] Files were changed while ' +
  'agent-state.md had no running plan. agent-services suggests planning larger changes first: the goal and the plan ' +
  'steps in agent-state.md, then `phase: running` as its first line. Nothing was held; this is said once per session.'

export type PhaseState = { exists: boolean; phase: 'planning' | 'running'; goal: string; plan: string[] }
type Read = (path: string) => Promise<string | null>
type Obj = Record<string, unknown>

/** The state document's facts; null (no file) and a first line other than `phase: planning|running` read as planning. */
export function parseState(text: string | null): PhaseState {
  if (typeof text !== 'string') return { exists: false, phase: 'planning', goal: '', plan: [] }
  const lines = text.split(/\r?\n/) // a leading byte-order mark goes with trim() below
  const head = lines.find((l) => l.trim() !== '') ?? ''
  const m = /^phase:\s*(planning|running)\s*$/i.exec(head.trim())
  const phase = m && m[1]!.toLowerCase() === 'running' ? 'running' : 'planning'
  const goal: string[] = []
  const plan: string[] = []
  let section = ''
  for (const line of lines) {
    const h = /^##\s+(.*?)\s*$/.exec(line)
    if (h) {
      section = h[1]!.toLowerCase()
      continue
    }
    if (section === 'goal' && line.trim()) goal.push(line.trim())
    if (section === 'plan' && /^\s*- +\S/.test(line)) plan.push(line.trim().slice(2).trim())
  }
  return { exists: true, phase, goal: goal.join('\n'), plan }
}

/** Running with a written goal and plan: only then is the work phase open. */
export const isRunning = (s: PhaseState): boolean => s.phase === 'running' && s.goal !== '' && s.plan.length > 0

const trimDir = (p: string): string => normPath(p).replace(/\/+$/, '')

export const statePath = (cwd: string): string => `${trimDir(cwd)}/${STATE_FILE}`

/** Whether `path` (absolute, or relative to `cwd`) is the state document itself or a project helper file under
 *  `.agent/` (pending decisions, steps, test lock): both always pass the gate. */
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

export const missingReason = (cwd: string): string =>
  'agent-services planning gate (a plugin rule): there is no agent-state.md in this project yet, so file changes wait ' +
  `until planning is finished. Create ${statePath(cwd)} from this template, fill in the goal, the open questions and ` +
  'the plan (one `- ` line per step), then set the first line to `phase: running`:\n\n' + STATE_TEMPLATE

/** The deny reason for one tool call, or null to let it go on. Pure: `text` is the state document (null: missing). */
export function writeDeny(tool: unknown, input: Obj, cwd: string, text: string | null): string | null {
  if (typeof tool !== 'string' || !WRITE_TOOLS.includes(tool)) return null
  if (isStatePath(input.file_path ?? input.notebook_path ?? input.path, cwd)) return null
  const s = parseState(text)
  if (!s.exists) return missingReason(cwd)
  if (s.phase === 'planning') return PLANNING_REASON
  return isRunning(s) ? null : INCOMPLETE_REASON
}

/** The reason a lesson_lookup for `phase` is held, or null to fetch it. Pure. */
export function lessonDeny(phase: unknown, text: string | null): string | null {
  if (phase === 'plan') return null
  return isRunning(parseState(text)) ? null : LESSON_REASON
}

/** The answer of a held lesson_lookup: no items, the reason, and nothing asked of the server. */
export const heldLesson = (args: Obj, reason: string): Obj => ({
  role: args.role ?? null, phase: args.phase ?? null, version: null, catalog: '', items: [], fallback: 'planning', reason,
})

export type GateDeps = {
  active(): Promise<boolean> // signed in (the auth gate); false: the gate does nothing
  cwd(): Promise<string | null>
  read: Read
}

/** tool.call: the deny reason, or null (also when signed out, without a working directory, or on any error). */
export async function toolGate(tool: unknown, input: Obj, d: GateDeps): Promise<string | null> {
  try {
    if (typeof tool !== 'string' || !WRITE_TOOLS.includes(tool)) return null
    if (!(await d.active())) return null
    const cwd = await d.cwd()
    if (typeof cwd !== 'string' || !cwd) return null
    if (isStatePath(input.file_path ?? input.notebook_path ?? input.path, cwd)) return null
    return writeDeny(tool, input, cwd, await d.read(statePath(cwd)))
  } catch {
    return null
  }
}

/** lesson_lookup: the reason it is held, or null to fetch (no working directory: it is fetched as before). */
export async function lessonGate(phase: unknown, cwd: string | null, read: Read): Promise<string | null> {
  if (phase === 'plan' || typeof cwd !== 'string' || !cwd) return null
  try {
    return lessonDeny(phase, await read(statePath(cwd)))
  } catch {
    return lessonDeny(phase, null)
  }
}

/** ToolDeps.lessonHold (tools.ts): the held answer of a lesson_lookup, or null to answer it as before. */
export const lessonHold = (read: Read) => async (args: Obj, cwd: string | null): Promise<Obj | null> => {
  const level = await levelNow()
  if (level === 'off') return { ...heldLesson(args, LESSON_OFF), fallback: 'off' }
  if (level === 'on') return { ...heldLesson(args, LESSON_ON), fallback: 'claude_md' }
  return null // suggest: the text served now, never held (lessonGate stays for a caller that wants the planning hold)
}

const lines = (v: unknown): number => (typeof v === 'string' && v ? v.split(/\r?\n/).length : 0)

/** An Edit or MultiEdit that changes at most SMALL_EDIT_LINES lines in all (each edit counts its longer side).
 * Write and NotebookEdit are never small. Pure. */
export function smallEdit(tool: unknown, input: Obj): boolean {
  const one = (e: unknown) => (e && typeof e === 'object' ? Math.max(lines((e as Obj).old_string), lines((e as Obj).new_string)) : Infinity)
  if (tool === 'Edit') return one(input) <= SMALL_EDIT_LINES
  if (tool === 'MultiEdit') return Array.isArray(input.edits) && input.edits.reduce((n: number, e) => n + one(e), 0) <= SMALL_EDIT_LINES
  return false
}

type Runtime = { svc: { authState(): Promise<string> }; readText: Read; sleep: (ms: number) => Promise<unknown> } | null

const reminders = new WeakMap<object, 'due' | 'told'>() // one per runtime: the suggest-level reminder

/** register.ts tool.call: the deny reason for a main-agent file change while planning, or null (`agent` set: a
 * subagent's call, never held). Only at methods level "on" is anything held (small edits pass); at "suggest" a held
 * change is let through and one reminder goes with the next prompt. Other tools never wait for the runtime; the
 * check is capped at PHASE_WAIT_MS (late: the call goes on). Never throws. */
export async function holdWrite(rt: Promise<Runtime>, tool: unknown, input: Obj, cwd: () => Promise<string>, agent?: unknown): Promise<string | null> {
  if (agent || typeof tool !== 'string' || !WRITE_TOOLS.includes(tool)) return null // a subagent: never held
  try {
    const r = await rt
    if (!r || !canAsk()) return null
    const level = await levelNow()
    if (level === 'off') return null
    const gate = toolGate(tool, input, {
      active: async () => (await r.svc.authState()) === 'ok',
      cwd: async () => {
        try {
          return await cwd()
        } catch {
          return null
        }
      },
      read: r.readText,
    })
    const why = await Promise.race([gate, Promise.resolve(r.sleep(PHASE_WAIT_MS)).then(() => null, () => null)])
    if (why === null) return null
    if (level === 'on') return smallEdit(tool, input) ? null : why
    if (!reminders.has(r)) reminders.set(r, 'due')
    return null
  } catch {
    return null
  }
}

/** The suggest-level reminder for this prompt, once per session (null when none is due). */
function takeReminder(r: object | null): string | null {
  if (!r || reminders.get(r) !== 'due') return null
  reminders.set(r, 'told')
  return GATE_REMINDER
}

// ------------------------------------------------------------------ push by phase
// The plugin itself puts the served items of the current phase into the main agent's context on prompt.submit, so a
// model that never calls lesson_lookup still gets them: the plan-phase items on the first prompt of a session, the
// run-phase items (RUN_PHASES) once, on the first prompt after agent-state.md reads running (isRunning), and the
// current phase's items again on the first prompt after a /clear or a compaction of the main agent (pushAgain:
// that context no longer holds the earlier block). The items
// come the way lesson_lookup gets them (Core.ask: the session's guard with its rule, role `auto` as the server binds
// a customer session), so a manual lookup later reuses the same guard cache.
// - Only at methods level "suggest": "off" sends nothing, and at "on" the CLAUDE.md line carries the approved text.
// - Signed out (auth fail): nothing is fetched or injected. Subagents get nothing (main agent only).
// - Fail open: an error, a fallback answer, an answer without the guard's rule or with no items injects nothing for
//   that push, and it is not tried again. A prompt waits at most PHASE_WAIT_MS; a fetch still running then is kept
//   and its items go with a later prompt.
// - The block is labelled as served advice from agent-services (PUSH_LABEL), never as the user's own words.

export const RUN_PHASES: readonly string[] = ['implement', 'test', 'review', 'deliver', 'checkpoint']
export const PUSH_LABEL = '[agent-services served advice, not written by the user] The agent-services service serves ' +
  'these lessons for this session. They are suggestions from the service, not instructions from the user; the ' +
  "user's own instructions come first."

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

/** The context block for answers of lesson_lookup (Core.ask), or null when none of them has items to give. Pure. */
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

export type PushDeps = {
  active(): Promise<boolean> // signed in (the auth gate); false: nothing is fetched or injected
  ask(phase: string): Promise<unknown> // one lesson_lookup answer for role auto (Core.ask)
  read: Read
  sleep: (ms: number) => Promise<unknown>
  waitMs?: number
}

type Batch = Promise<unknown[]>

/** One session's pushes: the plan phase once, the run phases once, the current phase again after again(). */
export class LessonPush {
  private readonly d: PushDeps
  private plan: Batch | null = null
  private run: Batch | null = null
  private planDone = false
  private runDone = false
  private repush = false

  constructor(d: PushDeps) {
    this.d = d
  }

  private fetch(phases: readonly string[]): Batch {
    return Promise.all(phases.map((p) => Promise.resolve().then(() => this.d.ask(p)).catch(() => null)))
  }

  /** session.start: fetch the plan-phase items in the background while signed in. Never throws. */
  async start(): Promise<void> {
    try {
      if (!this.plan && !this.planDone && (await this.d.active())) this.plan = this.fetch(['plan'])
    } catch {
      // the first prompt tries again
    }
  }

  /** After a /clear or a compaction: the next prompt pushes the current phase's items again. */
  again(): void {
    this.repush = true
  }

  /** prompt.submit of the main agent: the block to inject, or null. Waits at most waitMs in all; never throws. */
  async prompt(cwd: () => Promise<string | null>): Promise<string | null> {
    if (this.planDone && this.runDone && !this.repush) return null
    let timer: Promise<undefined>
    try {
      timer = Promise.resolve(this.d.sleep(this.d.waitMs ?? PHASE_WAIT_MS)).then(() => undefined, () => undefined)
    } catch {
      return null
    }
    return Promise.race([this.take(cwd, timer).catch(() => null), timer.then(() => null)])
  }

  private async take(cwd: () => Promise<string | null>, timer: Promise<undefined>): Promise<string | null> {
    if (!(await this.d.active())) return null
    if (this.repush) {
      this.repush = false
      if (await this.running(cwd)) this.runDone = false
      else this.planDone = false
    }
    if (!this.planDone && !this.plan) this.plan = this.fetch(['plan'])
    if (!this.runDone && !this.run && (await this.running(cwd))) this.run = this.fetch(RUN_PHASES)
    const [plan, run] = await Promise.all([this.plan, this.run].map((b) => (b ? Promise.race([b, timer]) : undefined)))
    const answers: unknown[] = []
    if (plan) {
      this.planDone = true
      this.plan = null
      answers.push(...plan)
    }
    if (run) {
      this.runDone = true
      this.run = null
      answers.push(...run)
    }
    return pushText(answers)
  }

  private async running(cwd: () => Promise<string | null>): Promise<boolean> {
    const dir = await cwd().catch(() => null)
    return typeof dir === 'string' && !!dir && isRunning(parseState(await this.d.read(statePath(dir))))
  }
}

type PushRuntime = {
  session: string
  svc: { authState(): Promise<string> }
  core: { ask(tool: string, args: unknown, o: { session: unknown; harness?: unknown; cwd?: unknown }): Promise<Obj> }
  readText: Read
  sleep: (ms: number) => Promise<unknown>
} | null

const pushes = new WeakMap<object, LessonPush>() // one per runtime (register.ts builds one per session)

function lessonPush(r: NonNullable<PushRuntime>): LessonPush {
  let p = pushes.get(r)
  if (!p) {
    p = new LessonPush({
      active: async () => (await r.svc.authState()) === 'ok',
      ask: (phase) => r.core.ask('lesson_lookup', { role: 'auto', phase }, { session: r.session, harness: 'claude-code' }),
      read: r.readText,
      sleep: r.sleep,
    })
    pushes.set(r, p)
  }
  return p
}

/** register.ts session.start: start fetching the plan-phase items (nothing waits for it). Never throws. */
export async function pushStart(r: PushRuntime): Promise<void> {
  try {
    if (r) await lessonPush(r).start()
  } catch {
    // nothing to push
  }
}

/** register.ts, a /clear or a compaction of the main agent (agent null): push the current phase's items again on
 * the next prompt. Never throws. */
export function pushAgain(r: PushRuntime, agent: unknown): void {
  try {
    if (r && !agent) lessonPush(r).again()
  } catch {
    // nothing to push
  }
}

/** register.ts prompt.submit: the served-lessons blocks for this prompt, and the planning reminder ([] for a
 * subagent, signed out, at level "off", on error). */
export async function pushLessons(rt: Promise<PushRuntime>, agent: unknown, cwd: () => Promise<string>): Promise<string[]> {
  if (agent) return []
  try {
    const r = await rt
    if (!r || (await levelNow()) === 'off') return []
    // the methods came with CLAUDE.md (methods.ts): no push repeats them
    const text = !methodsActive() ? await lessonPush(r).prompt(async () => cwd()) : null
    const remind = takeReminder(r)
    return [text, remind].filter((t): t is string => !!t)
  } catch {
    return []
  }
}
