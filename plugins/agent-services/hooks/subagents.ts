// The subagents engine, run locally on the served "subagents" table (rules.ts); with no table every part is off and
// passes each event through untouched. Nothing here sends a request: no task, prompt, path or report leaves the machine.
// - Test-author lock (flow.ts flowLock calls authorCheck): the session remembers who wrote each test file (the main
//   conversation or a subagent); another subagent may not change it with an edit tool or a shell command, and where
//   the table says so (hide_reads) may not read it either. The main conversation may always edit. The list lives in
//   this module's memory for the session only. It sits beside flow.ts's explicit lock file (.agent/test-lock.json).
// - Steps gate (spawnGate, agent.spawn): a task that names a step with [step:ID] is not started while a dependency of
//   that step in the project's steps file is not done; [override: reason] in the task lets it start (logged to the
//   debug log). A task naming no step always starts.
// - Long reports (agentResult for a foreground Agent call, notificationEvent for a background one): a subagent report
//   longer than the table's cap is written whole to the report folder, and the conversation gets its opening and the
//   file's path instead. Only reports of subagents the main conversation started; any failure keeps the report as is.
// - Usage line (spawnGate): only where the table has a "redline" (never in the product table), a spawn is refused when
//   the weekly plan window is past the line, read from the engine's own session usage.
// - Demand lock and commit check (ownerCheck, from flow.ts flowLock): only where the table has a "demand" or
//   "coauthor" part (never in the product table). A requirements file the table names, whose opening lines say it is locked, takes only an
//   amendment appended at its end, by the main conversation; a shell command never changes it. A commit whose
//   Co-Authored-By trailer names another model than the one the agent runs on is refused with the right line.
import type { EngineInterface } from 'claude-code'
import { dataDir, engineDirs } from './engine_env'
import { methodsLevel } from './methods_level'
import { planOf } from './panel'
import { rulesLive, rulesTable } from './rules'
import { engineStore } from './store'
import { toolInput } from './tools'

type Obj = Record<string, any>
type Ready = Promise<{ svc: { authState(): Promise<string> } } | null> | undefined
type Save = (r: { agentId: string; report: string }) => Promise<string | null>
type Week = { pct: number; resets_at: string | null } | null

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function table(): Obj | null {
  const t = rulesTable<Obj>('subagents')
  return isObj(t) ? t : null
}

function part(name: string): Obj | null {
  const p = table()?.[name]
  return isObj(p) ? p : null
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function fill(text: unknown, values: Record<string, string>): string {
  return String(text ?? '').replace(/\{(\w+)\}/g, (all, k: string) => (k in values ? values[k]! : all))
}

function rx(source: string, flags = ''): RegExp | null {
  try {
    return new RegExp(source, flags)
  } catch {
    return null
  }
}

/** True when the runtime is signed in; no runtime given (the tests) counts as signed in. A sign-in that no longer
 * holds clears the rule tables first (rules.ts rulesLive). */
export async function signedIn(rt: Ready): Promise<boolean> {
  await rulesLive()
  if (rt === undefined) return true
  try {
    const r = await rt
    return !!r && (await r.svc.authState()) === 'ok'
  } catch {
    return false
  }
}

// ------------------------------------------------------------------ test-author lock (pure but for the writers list)

function driveForm(p: string): string {
  return p.replace(/^\/mnt\/([a-z])(\/|$)/i, '$1:/').replace(/^\/([a-z])(\/|$)/i, '$1:/')
}

/** One spelling per file: `C:\r\a`, `c:/r/a`, `/c/r/a` and `/mnt/c/r/a` are the same path; a relative one is read
 * against `cwd`; Windows paths compare lower-case. */
export function spellPath(raw: string, cwd = ''): string {
  let p = driveForm(String(raw).trim().replace(/\\/g, '/'))
  if (!/^([a-z]:)?\//i.test(p) && cwd) p = `${driveForm(cwd.replace(/\\/g, '/')).replace(/\/+$/, '')}/${p}`
  const out: string[] = []
  for (const [i, seg] of p.split('/').entries()) {
    if (seg === '.' || (seg === '' && i > 0)) continue
    if (seg === '..' && out.length > 1) {
      out.pop()
      continue
    }
    out.push(seg)
  }
  p = out.join('/') || '/'
  return /^[a-z]:(\/|$)/i.test(p) ? p.toLowerCase() : p
}

/** Whether the table counts this path as a test file. */
export function isTestPath(raw: string): boolean {
  const p = spellPath(raw)
  return strings(part('authors')?.test_paths).some((s) => rx(s)?.test(p) === true)
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

function shellHit(command: string, locked: readonly string[], cased: string[], anyCase: string[]): string | null {
  const commands = [command, command.replace(/\\/g, '/')]
  for (const path of locked) {
    const name = `(?<![\\w.-])${escape(baseName(path))}` // so RetroP3_X.spec.luau is not taken for X.spec.luau
    const at = `[^|;&]*${name}\\b`
    const pats = [...cased.map((s) => rx(fill(s, { name, at }))), ...anyCase.map((s) => rx(fill(s, { name, at }), 'i'))]
    if (commands.some((c) => pats.some((r) => r?.test(c) === true))) return path
  }
  return null
}

/** The locked file a shell command would change (redirect, in-place edit, remove, move, copy, checkout), or null. */
export function touchedBy(command: string, locked: readonly string[]): string | null {
  const a = part('authors')
  return a ? shellHit(command, locked, strings(a.shell_writes), strings(a.shell_writes_any_case)) : null
}

/** The locked file a shell command would print (named after a reader in the same pipeline segment), or null. */
export function readBy(command: string, locked: readonly string[]): string | null {
  const a = part('authors')
  return a ? shellHit(command.replace(/\\/g, '/'), locked, [], strings(a.shell_reads_any_case)) : null
}

const writers = new Map<string, string>() // spelled path -> 'main' or the writing subagent's id, this session only

/** Tests only: forget the session's writers. */
export function resetSubagentsForTest(): void {
  writers.clear()
}

/** tool.call (from flow.ts flowLock): the deny reason for a subagent changing (or, with hide_reads, reading) a test
 * another agent wrote this session, or null; a test file an allowed edit writes is noted as that agent's. */
export function authorCheck(e: Obj, cwd: string | null): string | null {
  const a = part('authors')
  if (!a || !isObj(e)) return null
  const input = toolInput(e)
  const tool = String(e.tool ?? '')
  const c = cwd ?? ''
  const edits = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)
  const raw = edits ? input.file_path ?? input.notebook_path : undefined
  const target = typeof raw === 'string' ? spellPath(raw, c) : null
  const shell = (tool === 'Bash' || tool === 'PowerShell') && typeof input.command === 'string' ? input.command : null
  const agent = typeof e.agentId === 'string' && e.agentId ? e.agentId : null
  const reason = (key: string, path: string) =>
    fill(a[key], { path, writer: String(writers.get(path) === 'main' ? a.writer_main : a.writer_other) })
  if (agent) {
    const locked = [...writers].filter(([, by]) => by !== agent).map(([p]) => p)
    const hit = target !== null && locked.includes(target) ? target : shell !== null ? touchedBy(shell, locked) : null
    if (hit) return reason('locked_reason', hit)
    if (a.hide_reads === true) {
      const opened = tool === 'Read' ? input.file_path : tool === 'Grep' ? input.path : undefined
      const opens = typeof opened === 'string' ? spellPath(opened, c) : null
      const peek = opens !== null && locked.includes(opens) ? opens : shell !== null ? readBy(shell, locked) : null
      if (peek) return reason('hidden_reason', peek)
    }
  }
  if (target !== null && isTestPath(target) && (!agent || !writers.has(target))) writers.set(target, agent ?? 'main')
  return null
}

// ------------------------------------------------------------------ steps gate (pure)

/** The steps files the table names, project-relative, in the order they are looked up. */
export function stepsFiles(): string[] {
  return strings(part('steps')?.files)
}

/** The gate's answer for a task: {deny} when the step it names has a dependency not done, {override} when the task
 * says to go ahead anyway, null otherwise (no table, no steps, no step named, or every dependency done). */
export function stepGate(text: string | null, file: string, task: string): { deny: string } | { override: string } | null {
  const s = part('steps')
  if (!s || typeof text !== 'string') return null
  let list: unknown
  try {
    const j = JSON.parse(text)
    list = Array.isArray(j) ? j : isObj(j) ? j.steps : null
  } catch {
    return null
  }
  if (!Array.isArray(list)) return null
  const steps = list.filter(isObj).filter((x) => typeof x.id === 'string' || typeof x.id === 'number')
  const named = /\[step:\s*([A-Za-z0-9_.-]+)\]/i.exec(task)?.[1]
  const step = named === undefined ? undefined : steps.find((x) => String(x.id) === named)
  if (!step) return null
  const override = /\[override:\s*([^\]]+)\]/i.exec(task)?.[1]?.trim()
  if (override) return { override }
  const evidence = s.require_evidence === true
  const done = (x: Obj | undefined) =>
    !!x && ['done', 'completed', 'complete'].includes(String(x.status ?? '').trim().toLowerCase()) &&
    (!evidence || (typeof x.evidence === 'string' && x.evidence.trim() !== ''))
  const deps: unknown[] = Array.isArray(step.deps) ? step.deps : Array.isArray(step.depends_on) ? step.depends_on : []
  const unmet = deps.map(String).filter((d) => !done(steps.find((x) => String(x.id) === d)))
  if (!unmet.length) return null
  const shown = unmet.map((d) => {
    const x = steps.find((y) => String(y.id) === d)
    if (!x) return `${d} (not in the file)`
    return `${d} (status ${String(x.status ?? 'todo')}${done({ ...x, evidence: 'x' }) ? ', no evidence written down' : ''})`
  })
  return { deny: fill(s.deny_reason, { step: String(step.id), file, unmet: shown.join(', '), evidence: evidence ? String(s.evidence_hint ?? '') : '' }) }
}

// ------------------------------------------------------------------ usage line (pure)

/** Whether a spawn starts a new module: a main-conversation spawn whose description the table marks so. */
export function isModuleSpawn(description: unknown, parent: unknown): boolean {
  const r = part('redline')
  if (!r || (parent !== undefined && parent !== null)) return false
  return rx(String(r.module_description ?? '(?!)'), 'i')?.test(String(description ?? '').trim()) === true
}

/** Why a spawn is refused at this weekly usage, or null (no redline in the table, no figure, under the line). */
export function redlineRefusal(week: Week, isModule: boolean): string | null {
  const r = part('redline')
  if (!r || !week || typeof week.pct !== 'number') return null
  const by = isObj(r.by_reset) ? r.by_reset[(week.resets_at ?? '').slice(0, 10)] : undefined
  const line = isObj(by) ? by : r
  const values = { pct: String(Math.round(week.pct)), resets: week.resets_at ?? 'the weekly reset' }
  if (typeof line.agents === 'number' && week.pct >= line.agents) return fill(r.agents_reason, { ...values, line: String(line.agents) })
  if (isModule && typeof line.modules === 'number' && week.pct >= line.modules) {
    return fill(r.modules_reason, { ...values, line: String(line.modules) })
  }
  return null
}

/** A person's own prompt that matches the table's override words: spawns past the usage line are allowed until the
 * current weekly reset, and the user is told so. Fails quietly. */
export async function redlineOverride($: EngineInterface, text: unknown): Promise<void> {
  try {
    const r = part('redline')
    if (!r || typeof text !== 'string' || !rx(String(r.override_rx ?? '(?!)'), 'i')?.test(text.slice(0, 2000))) return
    const week = planOf(await $.session.usage()).week
    if (!week || !week.resets_at) return
    await engineStore($).set('redline_override', week.resets_at)
    try {
      $.ui.toast(fill(r.override_notice, { resets: week.resets_at }))
    } catch {}
  } catch {}
}

// ------------------------------------------------------------------ demand lock and commit co-author (pure)

/** The demand file an edit tool call writes, spelled one way, or null (no demand part, not an edit, another file). */
export function demandTarget(e: Obj, cwd: string | null): string | null {
  const d = part('demand')
  if (!d || !isObj(e) || !['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(String(e.tool ?? ''))) return null
  const input = toolInput(e)
  const raw = input.file_path ?? input.notebook_path
  if (typeof raw !== 'string' || rx(String(d.file ?? '(?!)'), 'i')?.test(raw.replace(/\\/g, '/')) !== true) return null
  return spellPath(raw, cwd ?? '')
}

/** Whether a demand file's opening lines say it is locked, and not a draft. */
export function isLockedDemand(text: unknown): boolean {
  const d = part('demand')
  if (!d || typeof text !== 'string') return false
  const head = text.split(/\r?\n/).slice(0, typeof d.head_lines === 'number' ? d.head_lines : 12).join('\n')
  return rx(String(d.draft ?? '(?!)'), 'i')?.test(head) !== true && rx(String(d.locked ?? '(?!)'), 'i')?.test(head) === true
}

/** Why an edit of a locked demand file is refused, or null: only an amendment appended at its end, by the main
 * conversation, passes. A CRLF file is matched by the tool from LF text, so line endings are compared as LF. */
export function demandRefusal(e: Obj, current: unknown, isMain: boolean): string | null {
  const d = part('demand')
  if (!d || !isObj(e) || !isLockedDemand(current)) return null
  if (!isMain) return fill(d.subagent_reason, {})
  const input = toolInput(e)
  const lf = (t: string) => t.replace(/\r\n/g, '\n')
  const text = lf(String(current))
  const { content, old_string: was, new_string: now } = input
  let added: string | null = null
  if (e.tool === 'Write' && typeof content === 'string' && lf(content).startsWith(text)) {
    added = lf(content).slice(text.length)
  } else if (e.tool === 'Edit' && typeof was === 'string' && typeof now === 'string' && was !== '' &&
    text.trimEnd().endsWith(lf(was).trimEnd()) && lf(now).startsWith(lf(was))) {
    added = lf(now).slice(lf(was).length)
  }
  if (added !== null && rx(String(d.amendment ?? '(?!)'), 'i')?.test(added) === true) return null
  return fill(d.edit_reason, {})
}

/** Why a shell command that would change a demand file is refused (it is changed with the Edit tool only), or null. */
export function demandShellRefusal(command: unknown): string | null {
  const d = part('demand')
  const names = strings(d?.shell_names)
  return d && typeof command === 'string' && names.length && touchedBy(command, names) ? fill(d.shell_reason, {}) : null
}

/** A model id as the name a commit trailer gives it ("claude-haiku-5-5" -> "Claude Haiku 5.5"), or null. */
export function modelName(id: unknown): string | null {
  const c = part('coauthor')
  const m = c && typeof id === 'string' ? rx(String(c.model_id ?? '(?!)'), 'i')?.exec(id) : null
  if (!m || !m[1] || !m[2]) return null
  return `Claude ${m[1].charAt(0).toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
}

/** The model a commit command's co-author trailer names, or null (no coauthor part, not a commit, no trailer). */
export function coAuthorOf(command: unknown): string | null {
  const c = part('coauthor')
  if (!c || typeof command !== 'string' || rx(String(c.commit ?? '(?!)'))?.test(command) !== true) return null
  return rx(String(c.trailer ?? '(?!)'), 'i')?.exec(command)?.[1] ?? null
}

/** Why a commit whose trailer names another model than the one running is refused, or null (also for an unknown model). */
export function coAuthorRefusal(command: unknown, modelId: unknown): string | null {
  const claimed = coAuthorOf(command)
  const actual = claimed === null ? null : modelName(modelId)
  if (claimed === null || actual === null || actual.toLowerCase() === claimed.toLowerCase()) return null
  return fill(part('coauthor')?.reason, { claimed, actual })
}

/** tool.call (from flow.ts lockCheck): the demand lock's or the commit check's deny reason, or null. `model` is the
 * model the calling agent's last step ran on (null: unknown, no check). Reads only the demand file the call edits. */
export async function ownerCheck($: EngineInterface, e: Obj, cwd: string | null, model: string | null): Promise<string | null> {
  try {
    if (!isObj(e) || (!part('demand') && !part('coauthor'))) return null
    const target = demandTarget(e, cwd)
    if (target !== null) {
      let current: string | null = null
      try {
        current = String(await $.fs.read(target))
      } catch {}
      const why = demandRefusal(e, current, !e.agentId)
      if (why) return why
    }
    const input = toolInput(e)
    if ((e.tool !== 'Bash' && e.tool !== 'PowerShell') || typeof input.command !== 'string') return null
    return demandShellRefusal(input.command) ?? coAuthorRefusal(input.command, model)
  } catch {
    return null
  }
}

// ------------------------------------------------------------------ long reports (pure but for save)

/** Where a report is kept, from the table's folder ({home}, {data}, {session}); null without a table or a home. */
export function reportFile(dirs: { home: string; data: string }, session: string, agentId: string): string | null {
  const folder = part('reports')?.folder
  if (typeof folder !== 'string' || !folder) return null
  const clean = (t: string) => String(t).replace(/[^\w.-]/g, '_').replace(/^\.*$/, '_') // never '', '.' or '..'
  const values = { home: dirs.home.replace(/\\/g, '/').replace(/\/+$/, ''), data: dirs.data.replace(/\\/g, '/').replace(/\/+$/, ''), session: clean(session) }
  if ((folder.includes('{home}') && !values.home) || (folder.includes('{data}') && !values.data)) return null
  return `${fill(folder, values)}/${clean(agentId)}.md`
}

/** The text the conversation gets in place of a report over the cap: its opening and the pointer; null keeps it. */
export function shortReport(report: string, path: string): string | null {
  const r = part('reports')
  if (!r || typeof r.cap !== 'number' || typeof report !== 'string' || report.length <= r.cap) return null
  const max = typeof r.excerpt === 'number' ? r.excerpt : 600
  let head = report.slice(0, max)
  const cut = head.lastIndexOf('\n')
  if (cut > max / 2) head = head.slice(0, cut)
  head = head.replace(/\s+$/, '')
  return `${head}\n...\n\n${fill(r.pointer, { chars: String(report.length), cap: String(r.cap), path })}`
}

async function shorten(report: string, agentId: string, save: Save): Promise<string | null> {
  const r = part('reports')
  if (!r || typeof r.cap !== 'number' || report.length <= r.cap) return null
  const path = await Promise.resolve(save({ agentId, report })).catch(() => null)
  return typeof path === 'string' && path ? shortReport(report, path) : null
}

/** A foreground Agent result holding one long report: the result with the short text instead; null keeps it. A
 * result the harness marked up (a note, a refused or withheld hand-back) stays as it is. */
export async function shortenAgentResult(done: Obj, toolUseId: string | undefined, save: Save): Promise<Obj | null> {
  try {
    if (!isObj(done) || done.deny !== undefined || done.isError === true || !isObj(done.result)) return null
    const record = done.result
    const blocks = record.content
    const first = Array.isArray(blocks) && blocks.length === 1 ? blocks[0] : undefined
    if (!isObj(first) || first.type !== 'text' || typeof first.text !== 'string') return null
    if ((record.harnessNoteCount ?? 0) > 0 || (record.harnessTailCount ?? 0) > 0) return null
    if (record.handback !== undefined && record.handback !== 'send') return null
    const agentId = record.agentId || toolUseId
    if (!agentId) return null
    const short = await shorten(first.text, String(agentId), save)
    return short === null ? null : { ...done, result: { ...record, content: [{ type: 'text', text: short }] } }
  } catch {
    return null
  }
}

/** A task notification with a long <result> from a subagent the main conversation started: the notification with
 * the short text as its result; null keeps it. */
export async function shortenNotification(text: string, save: Save, isMain: (agentId: string) => Promise<boolean>): Promise<string | null> {
  try {
    if (typeof text !== 'string' || !part('reports')) return null
    const agentId = /<task-id>([^<]*)<\/task-id>/.exec(text)?.[1]?.trim()
    const open = text.indexOf('<result>')
    const close = text.lastIndexOf('</result>')
    if (!agentId || open < 0 || close < open + 8) return null
    const report = text.slice(open + 8, close)
    const cap = part('reports')?.cap
    if (typeof cap !== 'number' || report.length <= cap || !(await isMain(agentId))) return null
    const short = await shorten(report, agentId, save)
    return short === null ? null : `${text.slice(0, open + 8)}\n${short}\n${text.slice(close)}`
  } catch {
    return null
  }
}

// ------------------------------------------------------------------ hook parts (register.ts calls these)

function saver($: EngineInterface): Save {
  return async ({ agentId, report }) => {
    const path = reportFile({ home: (await engineDirs($)).home, data: await dataDir($) }, String(await $.session.id()), agentId)
    if (path === null) return null
    await $.fs.write(path, report)
    try {
      $.ui.log(`agent-services: a subagent report of ${report.length} characters was kept in ${path}`, { to: 'debug' })
    } catch {}
    return path
  }
}

async function mainAgent($: EngineInterface, agentId: string): Promise<boolean> {
  const list: Obj[] = await Promise.resolve($.agent.list()).catch(() => [])
  return (Array.isArray(list) ? list : []).some((a) => a?.id === agentId && a.parentId === undefined && a.teammateId === undefined && a.type !== 'fork')
}

async function readStepsFile($: EngineInterface): Promise<{ text: string; file: string } | null> {
  let cwd = ''
  try {
    cwd = String((await $.session.cwd()) ?? '')
  } catch {}
  if (!cwd) return null
  for (const file of stepsFiles()) {
    try {
      return { text: String(await $.fs.read(`${cwd.replace(/\\/g, '/').replace(/\/+$/, '')}/${file}`)), file }
    } catch {}
  }
  return null
}

/** agent.spawn, before anything else: the deny reason (usage line, then steps gate), or null. Forks and teammates
 * pass. The steps gate is off at methods level off. Fails open. */
export async function spawnGate($: EngineInterface, e: Obj, rt?: Ready): Promise<string | null> {
  try {
    if (!table() || !isObj(e) || e.fork === true || e.isTeammate === true || !(await signedIn(rt))) return null
    if (part('redline')) {
      const week = planOf(await $.session.usage()).week
      let refusal = redlineRefusal(week, isModuleSpawn(e.description, e.parentAgentId))
      // the user said to go past the line: allowed until this weekly reset (redlineOverride)
      if (refusal && week?.resets_at && (await engineStore($).get('redline_override')) === week.resets_at) refusal = null
      if (refusal) {
        try {
          $.ui.toast(refusal)
        } catch {}
        return refusal
      }
    }
    if (!part('steps') || (await methodsLevel(engineStore($))) === 'off') return null
    const found = await readStepsFile($)
    if (!found) return null
    const v = stepGate(found.text, found.file, `${String(e.description ?? '')}\n${String(e.prompt ?? '')}`)
    if (v && 'override' in v) {
      try {
        $.ui.log(`agent-services steps gate: "${String(e.description ?? '')}" started early (override: ${v.override})`, { to: 'debug' })
      } catch {}
      return null
    }
    return v ? v.deny : null
  } catch {
    return null
  }
}

/** tool.call, after the call ran: a foreground Agent result of the main conversation with a long report shortened. */
export async function agentResult($: EngineInterface, e: Obj, done: Obj, rt?: Ready): Promise<Obj> {
  try {
    if (!part('reports') || e?.agentId || (e?.tool !== 'Agent' && e?.tool !== 'Task') || !(await signedIn(rt))) return done
    return (await shortenAgentResult(done, e.tool_use_id, saver($))) ?? done
  } catch {
    return done
  }
}

/** prompt.submit, first: a task notification of a long background report, with the short text in its place; any
 * other event unchanged. */
export async function notificationEvent($: EngineInterface, e: Obj, rt?: Ready): Promise<Obj> {
  try {
    if (!part('reports') || !isObj(e) || e.origin?.kind !== 'task-notification' || !(await signedIn(rt))) return e
    const text = await shortenNotification(e.text, saver($), (id) => mainAgent($, id))
    return text === null ? e : { ...e, text }
  } catch {
    return e
  }
}
