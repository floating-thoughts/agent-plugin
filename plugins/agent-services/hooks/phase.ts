// The planning gate: every task has two phases, planning then running, kept in a local state document the agent
// writes, agent-state.md in the session's working directory. The plugin only reads it. The gate follows the methods
// level (methods.ts levelNow):
//
// - "on" (the user made the methods their own instructions): file changes (Edit, Write, MultiEdit, NotebookEdit) on
//   any path but agent-state.md are denied while the document is missing, says `phase: planning` (or has a
//   malformed first line), or says `phase: running` without the served plan-validity criteria met (a goal and plan
//   steps). Small edits pass (smallEdit: an Edit or MultiEdit that changes at most the served number of lines in
//   all). Writes to agent-state.md always go through.
// - "suggest" (the default): nothing is denied; the first such change of a session brings one reminder line with the
//   next prompt (gateReminder).
// - The criteria, the line count and the texts come from the served workflow table (workflow_table.ts); without it
//   the gate denies nothing and reminds of nothing (fail open). The deny decision and reading agent-state.md stay here.
// - "off": the gate does nothing.
// - Bash and the read tools are never held at any level: a file written through Bash is not seen by the gate.
// - No session that nobody can be asked in (a -p run, choice.ts canAsk) is held.
// - lesson_lookup answers only phase `plan` until the document is running (with the served table; without it nothing
//   is held); any other phase gets an empty item list and a short reason, without asking the server. At "off" it gives no items, and at "on" it points to the
//   approved text the CLAUDE.md line already loads.
// - Subagents are never held: the gate is the main agent's startup phase, and a subagent is dispatched by a main
//   session that has already planned (often in a git worktree with no agent-state.md). The engine's `agentId` on
//   tool.call marks a subagent, the same signal prompt.submit uses (pushLessons).
// - The caller runs this only while signed in (`active`): in auth fail the plugin stays inert.
// Harness-neutral apart from the level and canAsk: reading the file, the working directory and the auth state are
// injected (register.ts wires them).
import { normPath } from './paths'
import { canAsk } from './choice'
import { levelNow, methodsActive, queueNotice, seenVersion } from './methods'
import { autonomyNote, readAutonomy } from './autonomy'
import { servedFlag, servedInt, servedText, workflowPart } from './workflow_table'
export { methodsStart } from './methods' // register.ts wires it beside pushStart
export { noteAutonomy } from './autonomy' // register.ts tool.call, after the call ran

export const STATE_FILE = 'agent-state.md'
export const WRITE_TOOLS: readonly string[] = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
export const PHASE_WAIT_MS = 2000 // the gate's own cap inside a tool.call hook; later than that the call goes on
export const STATE_TEMPLATE = 'phase: planning\n\n## Goal\n\n## Open questions\n\n## Plan\n'
// STATE_TEMPLATE filled in: the shortest file the gate lets through; every deny reason ends with it
export const STATE_EXAMPLE = 'phase: running\n\n## Goal\n\nFix the login timeout.\n\n## Open questions\n\n## Plan\n\n' +
  '- Raise the timeout and add a test for it.\n'
export const LESSON_REASON = 'finish planning first (agent-state.md phase: planning)'
export const LESSON_OFF = 'the working methods are off (/agent-services methods suggest turns them back on)'
export const LESSON_ON = 'the working methods you approved are already loaded by your CLAUDE.md; follow that text'

// The served planning-gate values (workflow table, section planning_gate); null without the table, and then the gate
// denies nothing and reminds of nothing (fail open).
/** The deny reason while agent-state.md is in planning, ending with STATE_EXAMPLE. */
export const planningReason = (): string | null => servedText('planning_gate', 'planning_reason', { example: STATE_EXAMPLE })
/** The deny reason for `phase: running` without the served criteria met, ending with STATE_EXAMPLE. */
export const incompleteReason = (): string | null => servedText('planning_gate', 'incomplete_reason', { example: STATE_EXAMPLE })
/** The suggest-level reminder, once per session. */
export const gateReminder = (): string | null => servedText('planning_gate', 'reminder')
/** An Edit or MultiEdit changing at most this many lines passes the gate at "on". */
export const smallEditLines = (): number | null => servedInt('planning_gate', 'small_edit_lines', 0)

export type PhaseState = { exists: boolean; phase: 'planning' | 'running'; goal: string; plan: string[] }
type Read = (path: string) => Promise<string | null>
type Obj = Record<string, unknown>

/** The state document's facts; null (no file) and a first line other than `phase: planning|running` read as planning. */
export function parseState(text: string | null): PhaseState {
  if (typeof text !== 'string') return { exists: false, phase: 'planning', goal: '', plan: [] }
  const lines = text.split(/\r?\n/) // a leading byte-order mark goes with trim() below
  const head = lines.find((l) => l.trim() !== '') ?? ''
  const m = /^phase\s*:\s*(planning|running)\s*$/i.exec(head.trim())
  const phase = m && m[1]!.toLowerCase() === 'running' ? 'running' : 'planning'
  const goal: string[] = []
  const plan: string[] = []
  let section = ''
  for (const line of lines) {
    // a level-2 or level-3 heading starting with Goal, Plan or Open questions (any case, any words after) opens that
    // section; any other heading of level 1 to 3 closes it; deeper headings stay inside the section
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (h && h[1]!.length <= 3) {
      const t = h[1]!.length === 1 ? '' : h[2]!.toLowerCase()
      section = /^goals?\b/.test(t) ? 'goal' : /^plan\b/.test(t) ? 'plan' : /^open questions?\b/.test(t) ? 'open questions' : ''
      continue
    }
    if (h) continue
    if (section === 'goal' && line.trim()) goal.push(line.trim())
    if (section === 'plan' && /^\s*- +\S/.test(line)) plan.push(line.trim().slice(2).trim())
  }
  return { exists: true, phase, goal: goal.join('\n'), plan }
}

/** Running and meeting the served plan-validity criteria (a written goal, at least plan_steps_min plan steps): only
 * then is the work phase open. Without the table only the first line counts (the gate denies nothing then anyway). */
export function isRunning(s: PhaseState): boolean {
  if (s.phase !== 'running') return false
  if (!workflowPart('planning_gate')) return true
  const goal = servedFlag('planning_gate', 'goal_required') === true
  return (!goal || s.goal !== '') && s.plan.length >= (servedInt('planning_gate', 'plan_steps_min', 0) ?? 0)
}

/** The work phase is open: no served planning-gate table (nothing is held then, like the gate), or isRunning. */
export const workOpen = (s: PhaseState): boolean => !workflowPart('planning_gate') || isRunning(s)

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
  `until planning is finished. Create ${statePath(cwd)} from this template (at the end), fill in the goal, the open ` +
  'questions and the plan (one `- ` line per step), then set the first line to `phase: running`. A valid file, filled in:\n\n' +
  STATE_EXAMPLE + '\nThe template:\n\n' + STATE_TEMPLATE

/** The deny reason for one tool call, or null to let it go on. Pure: `text` is the state document (null: missing). */
export function writeDeny(tool: unknown, input: Obj, cwd: string, text: string | null): string | null {
  if (typeof tool !== 'string' || !WRITE_TOOLS.includes(tool)) return null
  if (!workflowPart('planning_gate')) return null // no served table: the gate fails open
  if (smallEditLines() === null) return null // a partial table without a usable small_edit_lines: fail open too
  if (isStatePath(input.file_path ?? input.notebook_path ?? input.path, cwd)) return null
  const s = parseState(text)
  if (!s.exists) return missingReason(cwd)
  if (s.phase === 'planning') return planningReason()
  return isRunning(s) ? null : incompleteReason()
}

/** The reason a lesson_lookup for `phase` is held, or null to fetch it. Pure. */
export function lessonDeny(phase: unknown, text: string | null): string | null {
  if (phase === 'plan') return null
  return workOpen(parseState(text)) ? null : LESSON_REASON
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
    const start = await d.cwd()
    if (typeof start !== 'string' || !start) return null
    // the project is the nearest folder from the working directory up that has agent-state.md (a `cd` into a
    // subfolder keeps the project's plan); none: the working directory itself
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
    if (isStatePath(target, cwd)) return null
    // a file outside the project (a temp or scratch folder, another repository) is never held
    if (typeof target === 'string' && /^([A-Za-z]:)?\//.test(normPath(target)) &&
      !`${normPath(target).toLowerCase()}/`.startsWith(`${cwd.toLowerCase()}/`)) return null
    return writeDeny(tool, input, cwd, text)
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

/** An Edit or MultiEdit that changes at most smallEditLines() lines in all (each edit counts its longer side).
 * Write and NotebookEdit are never small, and nothing is without the served table. */
export function smallEdit(tool: unknown, input: Obj): boolean {
  const max = smallEditLines()
  if (max === null) return false
  const one = (e: unknown) => (e && typeof e === 'object' ? Math.max(lines((e as Obj).old_string), lines((e as Obj).new_string)) : Infinity)
  if (tool === 'Edit') return one(input) <= max
  if (tool === 'MultiEdit') return Array.isArray(input.edits) && input.edits.reduce((n: number, e) => n + one(e), 0) <= max
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
  const text = gateReminder()
  if (text) reminders.set(r, 'told') // no served text yet: it stays due
  return text
}

// ------------------------------------------------------------------ push by phase
// The plugin itself puts the served items of the current phase into the main agent's context on prompt.submit, so a
// model that never calls lesson_lookup still gets them. The full text goes once per session (0.6.2: a session's
// context still holds it, so repeating it costs every user tokens on every turn):
// - the plan-phase items on the first prompt of a session, and the run-phase items (RUN_PHASES) on the first prompt
//   after agent-state.md reads running (isRunning);
// - the current phase's items again on the first prompt after a /clear or a real compaction of the main agent
//   (pushAgain: that context no longer holds the earlier block), after a phase change (planning to running or back),
//   or when the served version differs from the one sent;
// - every other prompt gets nothing.
// What was sent, per session id, is kept in the store (SENT_KEY), so a session resumed in a new process (claude
// --resume, an SDK resume) does not get the text again: its first prompt fetches the items as before and sends them
// only when their version differs from the one kept.
// The items come the way lesson_lookup gets them (Core.ask: the session's guard with its rule, role `auto` as the
// server binds a customer session), so a manual lookup later reuses the same guard cache, and lesson_lookup still
// returns the full text whenever the model asks.
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
export const SENT_KEY = 'methods_sent' // { [session id]: { plan?, run?, group?, at } }: the versions sent in full
export const SENT_SESSIONS = 30 // sessions kept in SENT_KEY (the most recent)

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

/** The served version of the answers pushText would send ('' when none has items). Pure. */
export function pushVersion(answers: unknown[]): string {
  return answers
    .filter((a) => isObj(a) && a.fallback === null && typeof a.rule === 'string' && a.rule && Array.isArray(a.items) && a.items.length)
    .map((a) => `${String((a as Obj).phase)}=${String((a as Obj).version)}`)
    .join(',')
}

type Group = 'plan' | 'run'
export type Sent = { plan?: string; run?: string; group?: Group }

/** One session's record from SENT_KEY's value, cleaned. Pure. */
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

/** SENT_KEY's value with one session's record put in, the oldest dropped past SENT_SESSIONS. Pure. */
export function withSent(all: unknown, session: string, sent: Sent, at: number): Obj {
  const map: Obj = isObj(all) ? { ...all } : {}
  map[session] = { ...sent, at }
  const keys = Object.keys(map).sort((a, b) => atOf(map[b]) - atOf(map[a]))
  for (const k of keys.slice(SENT_SESSIONS)) delete map[k]
  return map
}

export type PushDeps = {
  active(): Promise<boolean> // signed in (the auth gate); false: nothing is fetched or injected
  ask(phase: string): Promise<unknown> // one lesson_lookup answer for role auto (Core.ask)
  read: Read
  sleep: (ms: number) => Promise<unknown>
  waitMs?: number
  // what this session was sent, kept across processes (SENT_KEY); without it the record lives in memory only
  seen?: { get(): Promise<Sent>; set(s: Sent): Promise<unknown> }
}

type Batch = Promise<unknown[]>

/** One session's pushes: each phase group in full once, again after again(), a phase change or a new version. */
export class LessonPush {
  private readonly d: PushDeps
  private batch: Record<Group, Batch | null> = { plan: null, run: null } // a fetch in flight
  private checked = new Set<Group>() // fetched in this process (sent, or found the same as sent)
  private sent: Sent | null = null // loaded once from d.seen
  private repush = false
  private version: string | null = null // the served version of the latest block delivered (takeVersion)

  constructor(d: PushDeps) {
    this.d = d
  }

  private fetch(phases: readonly string[]): Batch {
    return Promise.all(phases.map((p) => Promise.resolve().then(() => this.d.ask(p)).catch(() => null)))
  }

  /** session.start: fetch the plan-phase items in the background while signed in. Never throws. */
  async start(): Promise<void> {
    try {
      if (!this.batch.plan && !this.checked.has('plan') && (await this.d.active())) this.batch.plan = this.fetch(['plan'])
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

  /** The context no longer holds `g`'s block: send it again. */
  private forget(sent: Sent, g: Group): void {
    delete sent[g]
    this.checked.delete(g)
  }

  private async take(cwd: () => Promise<string | null>, timer: Promise<undefined>): Promise<string | null> {
    // past the wait, prompt() has already answered null: nothing may be recorded as sent (the settled batches are
    // kept and go out with the next prompt)
    let late = false
    void timer.then(() => { late = true })
    if (!(await this.d.active())) return null
    const sent = await this.load()
    const group: Group = (await this.running(cwd)) ? 'run' : 'plan'
    let changed = false
    if (this.repush) {
      this.repush = false
      this.forget(sent, group)
    } else if (sent.group && sent.group !== group) {
      this.forget(sent, group) // a phase change: the new phase's items again
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
      if (!version) return // nothing to give: not tried again
      if (sent[g] === version) return // this session's context already holds this text
      sent[g] = version
      changed = true
      answers.push(...a)
    })
    if (changed && this.d.seen) {
      try {
        await this.d.seen.set({ ...sent })
      } catch {
        // kept in memory for this process
      }
    }
    const text = pushText(answers)
    const v = answers.find((a) => isObj(a) && typeof a.version === 'string' && a.version) as Obj | undefined
    if (text && v) this.version = String(v.version)
    return text
  }

  /** The served version of the latest block delivered, once (null: none since the last call). */
  takeVersion(): string | null {
    const v = this.version
    this.version = null
    return v
  }

  private async running(cwd: () => Promise<string | null>): Promise<boolean> {
    const dir = await cwd().catch(() => null)
    return typeof dir === 'string' && !!dir && isRunning(parseState(await this.d.read(statePath(dir))))
  }
}

type PushStore = { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }
type PushRuntime = {
  session: string
  svc: { authState(): Promise<string> }
  core: { ask(tool: string, args: unknown, o: { session: unknown; harness?: unknown; cwd?: unknown }): Promise<Obj> }
  readText: Read
  sleep: (ms: number) => Promise<unknown>
  store?: PushStore
} | null

const pushes = new WeakMap<object, LessonPush>() // one per runtime (register.ts builds one per session)

/** The session's SENT_KEY record in the plugin store (undefined: no store, memory only). */
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

let onNoteSent = false // level on: the autonomy note was sent in this process (pushLessons)

/** register.ts, a /clear or a compaction of the main agent (agent null): push the current phase's items again on
 * the next prompt. Never throws. */
export function pushAgain(r: PushRuntime, agent: unknown): void {
  try {
    if (r && !agent) { lessonPush(r).again(); onNoteSent = false }
  } catch {
    // nothing to push
  }
}

/** register.ts prompt.submit: the served-lessons blocks for this prompt, and the planning reminder ([] for a
 * subagent, signed out, at level "off", on error). */
export async function pushLessons(rt: Promise<PushRuntime>, agent: unknown, cwd: () => Promise<string>,
  notify?: (line: string) => void): Promise<string[]> {
  if (agent) return []
  try {
    const r = await rt
    if (!r || (await levelNow()) === 'off') return []
    // the methods came with CLAUDE.md (methods.ts): no push repeats them
    const push = lessonPush(r)
    let text = !methodsActive() ? await push.prompt(async () => cwd()) : null
    const version = push.takeVersion()
    if (text && r.store) {
      // 0.6.3: the user's kept autonomy choice goes with the methods; a new served version is said to the user once
      const note = autonomyNote(await readAutonomy(r.store))
      if (note) text = `${text}\n${note}`
      const told = version ? await seenVersion(r.store, version) : null
      if (told) (notify ?? queueNotice)(told) // flow.ts flowPrompt shows a queued one in this same prompt
    } else if (!text && methodsActive() && !onNoteSent && r.store && (await r.svc.authState()) === 'ok') {
      // level on: the methods came with CLAUDE.md, so the kept choice goes alone, once, and again after /clear
      const note = autonomyNote(await readAutonomy(r.store))
      if (note) { text = note; onNoteSent = true }
    }
    const remind = takeReminder(r)
    return [text, remind].filter((t): t is string => !!t)
  } catch {
    return []
  }
}
