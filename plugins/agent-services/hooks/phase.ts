// The planning gate: every task has two phases, planning then running, kept in a local state document the agent
// writes, agent-state.md in the session's working directory. The plugin only reads it. The gate follows the methods
// level (methods.ts levelNow):
//
// - "on" (the user made the methods their own instructions): file changes (Edit, Write, MultiEdit, NotebookEdit) on
//   any path but agent-state.md are denied while the service's verdict for the document holds them (gate_verdict.ts:
//   only flags and one count about the document are sent, never its text or path). Small edits pass (smallEdit: an
//   Edit or MultiEdit that changes at most the line count the verdict names, in all). Writes to agent-state.md and to
//   files under `.agent/` always go through.
// - "suggest" (the default): nothing is denied; the first held change of a session brings the verdict's reminder
//   line with the next prompt.
// - The criteria, the line count and the texts come with the verdict; without one (offline, signed out, late, an
//   older service) the gate denies nothing and reminds of nothing (fail open). Reading agent-state.md, the deny
//   itself and the templates (STATE_TEMPLATE, STATE_EXAMPLE) stay here.
// - "off": the gate does nothing.
// - Bash and the read tools are never held at any level: a file written through Bash is not seen by the gate.
// - No session that nobody can be asked in (a -p run, choice.ts canAsk) is held.
// - lesson_lookup answers only phase `plan` until the document is running (with a verdict; without one nothing is
//   held); any other phase gets an empty item list and a short reason, without asking the server. At "off" it gives
//   no items, and at "on" it points to the approved text the CLAUDE.md line already loads.
// - Subagents are never held: the gate is the main agent's startup phase, and a subagent is dispatched by a main
//   session that has already planned (often in a git worktree with no agent-state.md). The engine's `agentId` on
//   tool.call marks a subagent, the same signal prompt.submit uses (pushLessons).
// - The caller runs this only while signed in (`active`): in auth fail the plugin stays inert.
// Harness-neutral apart from the level and canAsk: reading the file, the working directory, the auth state and the
// service's verdict are injected (register.ts wires them).
import { normPath } from './paths'
import { canAsk } from './choice'
import { LEVEL_KEY, levelNow, methodsActive, methodsWired, queueNotice, seenVersion } from './methods'
import type { Level } from './methods'
import { TRUST_KEY } from './trust'
import { autonomyNote, readAutonomy } from './autonomy'
import { askVerdict, knownVerdict, PLAN_STEPS_SENT_MAX } from './gate_verdict'
import type { AskGate, GateLevel, GateState } from './gate_verdict'
import { ToolboxPush } from './toolbox'
import { runLimitsAgain } from './run_limits'
import { watchAgain } from './watch'
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
    const item = section === 'plan' ? /^\s*(?:[-*+]|\d{1,3}[.)]) +(\S.*)$/.exec(line) : null // "- ", "* ", "+ ", "1. ", "1) "
    if (item) plan.push(item[1]!.trim())
  }
  return { exists: true, phase, goal: goal.join('\n'), plan }
}

/** What the service is told about a state document: flags and one count, no text. Pure. */
export function gateState(s: PhaseState, level: GateLevel = 'on'): GateState {
  return { exists: s.exists, running: s.phase === 'running', goal: s.goal !== '', plan_steps: Math.min(s.plan.length, PLAN_STEPS_SENT_MAX), level }
}

/** The work phase is open: the service's verdict for this state holds nothing; without a verdict only the first line
 * counts. Never asks the service (askVerdict does). */
export function isRunning(s: PhaseState, level: GateLevel = 'suggest'): boolean {
  const v = knownVerdict(gateState(s, level))
  return v ? !v.hold : s.phase === 'running'
}

/** Nothing is held for this state: no verdict (fail open), or a verdict that does not hold. */
export const workOpen = (s: PhaseState, level: GateLevel = 'on'): boolean => !knownVerdict(gateState(s, level))?.hold

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

/** A served reason with its placeholders filled in here: {path} (this project's state document), {example} and
 * {template}. Pure. */
export function fillReason(reason: string, cwd: string): string {
  const vars: Record<string, string> = { path: statePath(cwd), example: STATE_EXAMPLE, template: STATE_TEMPLATE }
  return reason.replace(/\{(path|example|template)\}/g, (_all, k: string) => vars[k]!)
}

/** The reason for one tool call (at "on" the deny, at "suggest" the reminder), or null to let it go on. Pure apart
 * from the verdicts already known (knownVerdict): `text` is the state document (null: missing). */
export function writeDeny(tool: unknown, input: Obj, cwd: string, text: string | null, level: GateLevel = 'on'): string | null {
  if (typeof tool !== 'string' || !WRITE_TOOLS.includes(tool)) return null
  if (isStatePath(input.file_path ?? input.notebook_path ?? input.path, cwd)) return null
  const v = knownVerdict(gateState(parseState(text), level))
  if (!v || !v.hold || !v.reason) return null // no verdict: the gate fails open
  return fillReason(v.reason, cwd)
}

/** The reason a lesson_lookup for `phase` is held, or null to fetch it. Pure apart from the verdicts already known. */
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
  ask?: AskGate | null // the service's verdict for a state (gate_verdict.ts); absent: only verdicts already known
  level?: GateLevel // the methods level the reason is for (default on)
}

type Check = { why: string | null; small: number | null }

async function gateCheck(tool: unknown, input: Obj, d: GateDeps): Promise<Check> {
  const none: Check = { why: null, small: null }
  try {
    if (typeof tool !== 'string' || !WRITE_TOOLS.includes(tool)) return none
    if (!(await d.active())) return none
    const start = await d.cwd()
    if (typeof start !== 'string' || !start) return none
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
    if (isStatePath(target, cwd)) return none
    // a file outside the project (a temp or scratch folder, another repository) is never held
    if (typeof target === 'string' && /^([A-Za-z]:)?\//.test(normPath(target)) &&
      !`${normPath(target).toLowerCase()}/`.startsWith(`${cwd.toLowerCase()}/`)) return none
    const level = d.level ?? 'on'
    const v = await askVerdict(gateState(parseState(text), level), d.ask ?? null) // kept per state: asked once
    return { why: writeDeny(tool, input, cwd, text, level), small: v ? v.small_edit_lines : null }
  } catch {
    return none
  }
}

/** tool.call: the reason, or null (also when signed out, without a working directory, without a verdict, or on any
 * error). */
export async function toolGate(tool: unknown, input: Obj, d: GateDeps): Promise<string | null> {
  return (await gateCheck(tool, input, d)).why
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
  if (level === 'on' && args.event === undefined) {
    // just-in-time items by name pass; "already loaded" only when CLAUDE.md really brought them to this session
    if (methodsActive()) return { ...heldLesson(args, LESSON_ON), fallback: 'claude_md' }
    return {
      ...heldLesson(args, 'the working methods you approved are not loaded in this session (the CLAUDE.md section or ' +
        'its file is missing or expired); /agent-services methods shows what to do'),
      fallback: 'claude_md',
    }
  }
  return null // suggest: the text served now, never held (lessonGate stays for a caller that wants the planning hold)
}

const lines = (v: unknown): number => (typeof v === 'string' && v ? v.split(/\r?\n/).length : 0)

/** An Edit or MultiEdit that changes at most `max` lines in all (each edit counts its longer side; `max` comes with
 * the service's verdict). Write and NotebookEdit are never small, and nothing is without a line count. */
export function smallEdit(tool: unknown, input: Obj, max: number | null): boolean {
  if (typeof max !== 'number') return false
  const one = (e: unknown) => (e && typeof e === 'object' ? Math.max(lines((e as Obj).old_string), lines((e as Obj).new_string)) : Infinity)
  // replace_all changes every occurrence: its line count says nothing about the size of the change
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
  core?: { servedGate?(session: unknown, state: Obj): Promise<unknown> }
  readText: Read
  sleep: (ms: number) => Promise<unknown>
} | null

/** The runtime's way to ask the service for a verdict, or null (a runtime without it: only known verdicts count). */
function askOf(r: { session?: unknown; core?: { servedGate?(session: unknown, state: Obj): Promise<unknown> } }): AskGate | null {
  const core = r.core
  if (!core || typeof core.servedGate !== 'function') return null
  return (s) => core.servedGate!(r.session, s)
}

const reminders = new WeakMap<object, { due: string } | 'told'>() // one per runtime: the suggest-level reminder

/** register.ts tool.call: the deny reason for a main-agent file change while planning, or null (`agent` set: a
 * subagent's call, never held). Only at methods level "on" is anything held (small edits pass); at "suggest" a held
 * change is let through and one reminder goes with the next prompt. Other tools never wait for the runtime; the
 * check is capped at PHASE_WAIT_MS (late: the call goes on, and the verdict is kept for the next call). Never throws. */
export async function holdWrite(rt: Promise<Runtime>, tool: unknown, input: Obj, cwd: () => Promise<string>, agent?: unknown): Promise<string | null> {
  if (agent || typeof tool !== 'string' || !WRITE_TOOLS.includes(tool)) return null // a subagent: never held
  try {
    const r = await rt
    if (!r || !canAsk()) return null
    const level = await levelNow()
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

/** The suggest-level reminder for this prompt, once per session (null when none is due). */
function takeReminder(r: object | null): string | null {
  const due = r ? reminders.get(r) : undefined
  if (!r || !due || due === 'told') return null
  reminders.set(r, 'told')
  return due.due
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
  gate?: AskGate | null // the service's planning-gate verdict (running or not); absent: only verdicts already known
  level?: () => Promise<GateLevel> // the methods level the verdict is asked for (default suggest)
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
    // the plan group goes with every phase: its fetch starts now, beside the verdict request, not after it
    if (!this.checked.has('plan') && !this.batch.plan) this.batch.plan = this.fetch(['plan'])
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
    if (typeof dir !== 'string' || !dir) return false
    const s = parseState(await this.d.read(statePath(dir)))
    const level: GateLevel = this.d.level ? await this.d.level().catch((): GateLevel => 'suggest') : 'suggest'
    if (this.d.gate) {
      // kept per state: asked once. Waited at most half the prompt's window, so the phase fetch still fits in it; a
      // later verdict is kept for the next prompt, and meanwhile the first line counts (isRunning)
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
    toolboxIndex?(session: string): Promise<unknown> // core.ts: the toolbox index (toolbox.ts pushes it)
  }
  readText: Read
  sleep: (ms: number) => Promise<unknown>
  store?: PushStore
} | null

const pushes = new WeakMap<object, LessonPush>() // one per runtime (register.ts builds one per session)
const toolboxes = new WeakMap<object, ToolboxPush>() // the toolbox index, one per runtime (toolbox.ts)

/** The runtime's toolbox index push, or null when its core cannot fetch the index. */
function toolboxPush(r: NonNullable<PushRuntime>): ToolboxPush | null {
  if (typeof r.core.toolboxIndex !== 'function') return null
  let p = toolboxes.get(r)
  if (!p) {
    p = new ToolboxPush({
      active: async () => (await r.svc.authState()) === 'ok',
      index: () => r.core.toolboxIndex!(r.session),
      sleep: r.sleep,
      waitMs: PHASE_WAIT_MS,
    })
    toolboxes.set(r, p)
  }
  return p
}

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
      gate: askOf(r),
      level: async () => ((await levelNow()) === 'on' ? 'on' : 'suggest'),
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

// The level for a push. Before methodsStart wired its reader (the first prompt can come first), the stored answer is
// read here without the CLAUDE.md check: a stored "on" then counts as "on", so no served text goes out until the level
// is known (the push waits for a later prompt).
async function pushLevel(r: NonNullable<PushRuntime>): Promise<Level> {
  if (methodsWired() || !r.store) return levelNow()
  const v = (await r.store.get(LEVEL_KEY)) as { level?: unknown } | null | undefined
  const l = v && typeof v === 'object' ? v.level : undefined
  if (l === 'off' || l === 'on') return l
  if (l === 'suggest') return 'suggest'
  const t = (await r.store.get(TRUST_KEY)) as { answer?: unknown } | null | undefined // the 0.5.0 answer seeds the level
  const a = t && typeof t === 'object' ? t.answer : undefined
  return a === 'on' || a === 'off' ? a : 'suggest'
}

/** register.ts, a /clear or a compaction of the main agent (agent null): push the current phase's items again on
 * the next prompt. Never throws. */
export function pushAgain(r: PushRuntime, agent: unknown): void {
  try {
    if (r && !agent) { lessonPush(r).again(); toolboxPush(r)?.again(); onNoteSent = false; runLimitsAgain(); watchAgain() }
  } catch {
    // nothing to push
  }
}

/** register.ts prompt.submit: the served-lessons blocks for this prompt, the toolbox index (toolbox.ts) and the
 * planning reminder ([] for a subagent, signed out, at level "off", on error). */
export async function pushLessons(rt: Promise<PushRuntime>, agent: unknown, cwd: () => Promise<string>,
  notify?: (line: string) => void): Promise<string[]> {
  if (agent) return []
  let toolbox: Promise<string | null> = Promise.resolve(null)
  try {
    const r = await rt
    const level = r ? await pushLevel(r) : 'off'
    if (!r || level === 'off') return []
    // the toolbox index (toolbox.ts): once per session and after /clear or a compaction, at level suggest and on
    toolbox = toolboxPush(r)?.prompt() ?? Promise.resolve(null)
    // the methods came with CLAUDE.md (methods.ts): no push repeats them. At level "on" nothing served is pushed even
    // when that file had expired: the served text may be a candidate the user has not accepted (methods.pending.md).
    const push = lessonPush(r)
    let text = level === 'suggest' && !methodsActive() ? await push.prompt(async () => cwd()) : null
    const version = push.takeVersion()
    if (text && r.store) {
      // 0.6.3: the user's kept autonomy choice goes with the methods; a new served version is said to the user once
      const note = autonomyNote(await readAutonomy(r.store))
      if (note) text = `${text}\n${note}`
      const told = version ? await seenVersion(r.store, version) : null
      if (told) (notify ?? queueNotice)(told) // flow.ts flowPrompt shows a queued one in this same prompt
    } else if (!text && (level === 'on' || methodsActive()) && !onNoteSent && r.store && (await r.svc.authState()) === 'ok') {
      // level on: the methods came with CLAUDE.md, so the kept choice goes alone, once, and again after /clear
      const note = autonomyNote(await readAutonomy(r.store))
      if (note) { text = note; onNoteSent = true }
    }
    const remind = takeReminder(r)
    return [text, await toolbox, remind].filter((t): t is string => !!t)
  } catch {
    // the index was marked sent once prompt() answered: still give it, or it waits for the next compaction
    const tb = await toolbox.catch(() => null)
    return tb ? [tb] : []
  }
}
