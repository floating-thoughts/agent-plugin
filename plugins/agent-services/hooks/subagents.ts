import type { EngineInterface } from 'claude-code'
import { claudePlanOf, dataDir, engineDirs, readTextOf } from './engine_env'
import { methodsLevel } from './methods_level'
import { expired, heldPlan, planOf } from './panel'
import { riskyPattern, rulesLive, rulesTable } from './rules'
import { engineStore } from './store'
import { toolInput } from './tools'
import { overheadTokens, runSaving, savingText } from './local_savings'
import { PRICES } from './prices'
import { routingLevel } from './routing_level'
import { collect } from './transcripts'
import { readPlan } from './plan_file'

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
  return String(text ?? '').replace(/\{(\w+)\}/g, (all, k: string) => (Object.hasOwn(values, k) ? values[k]! : all))
}

let compiledRx = new Map<string, RegExp | null>()

function rx(source: string, flags = '', screen = source): RegExp | null {
  const key = `${flags}/${source}`
  const hit = compiledRx.get(key)
  if (hit !== undefined) return hit
  let out: RegExp | null = null
  try {
    out = riskyPattern(screen) ? null : new RegExp(source, flags)
  } catch {
    out = null
  }
  if (compiledRx.size >= 500) compiledRx = new Map<string, RegExp | null>()
  compiledRx.set(key, out)
  return out
}

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


function driveForm(p: string): string {
  return p.replace(/^\/mnt\/([a-z])(\/|$)/i, '$1:/').replace(/^\/([a-z])(\/|$)/i, '$1:/')
}

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

function elsewhere(command: string, path: string): boolean {
  const re = new RegExp(`([^\\s"'|;&<>()]*)(?<![\\w.-])${escape(baseName(path))}(?![\\w.-])`, 'g')
  const own = spellPath(path).toLowerCase()
  let seen = false
  for (const m of command.replace(/\\/g, '/').matchAll(re)) {
    const dir = m[1] ?? ''
    if (!/^([a-z]:)?\//i.test(dir) || spellPath(`${dir}${baseName(path)}`).toLowerCase() === own) return false
    seen = true
  }
  return seen
}

function shellHit(command: string, locked: readonly string[], cased: string[], anyCase: string[]): string | null {
  const commands = [command, command.replace(/\\/g, '/')]
  for (const path of locked) {
    if (elsewhere(command, path)) continue
    const name = `(?<![\\w.-])${escape(baseName(path))}`
    const at = `[^|;&]*${name}\\b`
    const pats = [...cased.map((s) => rx(fill(s, { name, at }), '', s)), ...anyCase.map((s) => rx(fill(s, { name, at }), 'i', s))]
    if (commands.some((c) => pats.some((r) => r?.test(c) === true))) return path
  }
  return null
}

export function touchedBy(command: string, locked: readonly string[]): string | null {
  const a = part('authors')
  return a ? shellHit(command, locked, strings(a.shell_writes), strings(a.shell_writes_any_case)) : null
}

export function readBy(command: string, locked: readonly string[]): string | null {
  const a = part('authors')
  return a ? shellHit(command.replace(/\\/g, '/'), locked, [], strings(a.shell_reads_any_case)) : null
}

const writers = new Map<string, string>()

export function resetSubagentsForTest(): void {
  writers.clear()
  planHeld = null
}

export function authorCheck(e: Obj, cwd: string | null, hideTests = false): string | null {
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
    if (a.hide_reads === true || (a.hide_reads === 'project' && hideTests)) {
      const opened = tool === 'Read' ? input.file_path : tool === 'Grep' ? input.path : undefined
      const opens = typeof opened === 'string' ? spellPath(opened, c) : null
      const peek = opens !== null && locked.includes(opens) ? opens : shell !== null ? readBy(shell, locked) : null
      if (peek) return reason('hidden_reason', peek)
    }
  }
  if (target !== null && isTestPath(target) && (!agent || !writers.has(target))) writers.set(target, agent ?? 'main')
  return null
}


export function stepsFiles(): string[] {
  return strings(part('steps')?.files)
}

export const DONE_STATUSES: readonly string[] = ['done', 'completed', 'complete']

export function stepDone(x: unknown, evidence: boolean = part('steps')?.require_evidence === true): boolean {
  return isObj(x) && DONE_STATUSES.includes(String(x.status ?? '').trim().toLowerCase()) &&
    (!evidence || (typeof x.evidence === 'string' && x.evidence.trim() !== ''))
}

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
  const named = /\[step:\s*([^\]]+?)\s*\]/i.exec(task)?.[1]
  const step = named === undefined ? undefined : steps.find((x) => String(x.id).trim() === named)
  if (!step) return null
  const override = /\[override:\s*([^\]]+)\]/i.exec(task)?.[1]?.trim()
  if (override) return { override }
  const evidence = s.require_evidence === true
  const done = (x: Obj | undefined) => stepDone(x, evidence)
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


export function isModuleSpawn(description: unknown, parent: unknown): boolean {
  const r = part('redline')
  if (!r || (parent !== undefined && parent !== null)) return false
  return rx(String(r.module_description ?? '(?!)'), 'i')?.test(String(description ?? '').trim()) === true
}

let planHeld: { at: number; text: string } | null = null

async function claudePlan($: EngineInterface): Promise<string> {
  try {
    if (!isObj(part('redline')?.by_plan)) return ''
    if (planHeld && Date.now() - planHeld.at < 600_000) return planHeld.text
    const d = await engineDirs($)
    const text = await claudePlanOf(readTextOf($), d.configSet ? [d.configDir, d.home] : [d.home])
    planHeld = { at: Date.now(), text }
    return text
  } catch {
    return ''
  }
}

function planLine(r: Obj, plan: string | null): Obj {
  if (!isObj(r.by_plan) || !plan) return r
  for (const x of Object.values(r.by_plan)) {
    if (isObj(x) && rx(String(x.match ?? '(?!)'), 'i')?.test(plan)) return { ...r, ...x }
  }
  return r
}

export function redlineRefusal(week: Week, isModule: boolean, plan: string | null = null): string | null {
  const r = part('redline')
  if (!r || !week || typeof week.pct !== 'number') return null
  const by = isObj(r.by_reset) ? r.by_reset[(week.resets_at ?? '').slice(0, 10)] : undefined
  const line = isObj(by) ? { ...planLine(r, plan), ...by } : planLine(r, plan)
  const values = { pct: String(Math.round(week.pct)), resets: week.resets_at ?? 'the weekly reset' }
  if (typeof line.agents === 'number' && week.pct >= line.agents) return fill(r.agents_reason, { ...values, line: String(line.agents) })
  if (isModule && typeof line.modules === 'number' && week.pct >= line.modules) {
    return fill(r.modules_reason, { ...values, line: String(line.modules) })
  }
  return null
}

export async function redlineOverride($: EngineInterface, text: unknown): Promise<void> {
  try {
    const r = part('redline')
    if (!r || typeof text !== 'string' || text.length > 2000 || !rx(String(r.override_rx ?? '(?!)'), 'i')?.test(text)) return
    const week = planOf(await $.session.usage()).week
    if (!week || !week.resets_at || redlineRefusal(week, true, await claudePlan($)) === null) return
    await engineStore($).set('redline_override', week.resets_at)
    try {
      $.ui.toast(fill(r.override_notice, { resets: week.resets_at }))
    } catch {}
  } catch {}
}


export function demandTarget(e: Obj, cwd: string | null): string | null {
  const d = part('demand')
  if (!d || !isObj(e) || !['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(String(e.tool ?? ''))) return null
  const input = toolInput(e)
  const raw = input.file_path ?? input.notebook_path
  if (typeof raw !== 'string' || rx(String(d.file ?? '(?!)'), 'i')?.test(raw.replace(/\\/g, '/')) !== true) return null
  return spellPath(raw, cwd ?? '')
}

export function isLockedDemand(text: unknown): boolean {
  const d = part('demand')
  if (!d || typeof text !== 'string') return false
  const head = text.split(/\r?\n/).slice(0, typeof d.head_lines === 'number' ? d.head_lines : 12).join('\n')
  return rx(String(d.draft ?? '(?!)'), 'i')?.test(head) !== true && rx(String(d.locked ?? '(?!)'), 'i')?.test(head) === true
}

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
  } else if (e.tool === 'Edit' && typeof was === 'string' && typeof now === 'string' && was !== '' && input.replace_all !== true &&
    text.trimEnd().endsWith(lf(was).trimEnd()) && lf(now).startsWith(lf(was))) {
    added = lf(now).slice(lf(was).length)
  }
  if (added !== null && rx(String(d.amendment ?? '(?!)'), 'i')?.test(added) === true && isLockedDemand(text + added)) return null
  return fill(d.edit_reason, {})
}

export function demandShellRefusal(command: unknown): string | null {
  const d = part('demand')
  const names = strings(d?.shell_names)
  return d && typeof command === 'string' && names.length && touchedBy(command, names) ? fill(d.shell_reason, {}) : null
}

export function modelName(id: unknown): string | null {
  const c = part('coauthor')
  const m = c && typeof id === 'string' ? rx(String(c.model_id ?? '(?!)'), 'i')?.exec(id) : null
  if (!m || !m[1] || !m[2]) return null
  return `Claude ${m[1].charAt(0).toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
}

export function coAuthorOf(command: unknown): string | null {
  const c = part('coauthor')
  if (!c || typeof command !== 'string' || rx(String(c.commit ?? '(?!)'))?.test(command) !== true) return null
  return rx(String(c.trailer ?? '(?!)'), 'i')?.exec(command)?.[1] ?? null
}

export function coAuthorRefusal(command: unknown, modelId: unknown): string | null {
  const claimed = coAuthorOf(command)
  const actual = claimed === null ? null : modelName(modelId)
  if (claimed === null || actual === null || actual.toLowerCase() === claimed.toLowerCase()) return null
  return fill(part('coauthor')?.reason, { claimed, actual })
}

export async function ownerCheck($: EngineInterface, e: Obj, cwd: string | null, model: string | null): Promise<string | null> {
  try {
    if (!isObj(e) || (!part('demand') && !part('coauthor'))) return null
    const target = demandTarget(e, cwd)
    if (target !== null) {
      let current: string | null = null
      const written = toolInput(e).file_path ?? toolInput(e).notebook_path
      const asWritten = typeof written !== 'string' ? null
        : /^([a-zA-Z]:)?[\\/]/.test(written) || !cwd ? written : `${cwd.replace(/[\\/]+$/, '')}/${written}`
      for (const p of asWritten !== null && asWritten !== target ? [asWritten, target] : [target]) {
        try {
          current = String(await $.fs.read(p))
          break
        } catch {}
      }
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


export function reportFile(dirs: { home: string; data: string }, session: string, agentId: string): string | null {
  const folder = part('reports')?.folder
  if (typeof folder !== 'string' || !folder) return null
  const clean = (t: string) => String(t).replace(/[^\w.-]/g, '_').replace(/^\.*$/, '_')
  const values = { home: dirs.home.replace(/\\/g, '/').replace(/\/+$/, ''), data: dirs.data.replace(/\\/g, '/').replace(/\/+$/, ''), session: clean(session) }
  if ((folder.includes('{home}') && !values.home) || (folder.includes('{data}') && !values.data)) return null
  const dir = fill(folder, values).replace(/\\/g, '/').replace(/\/+$/, '')
  const under = (root: string) => !!root && !/(^|\/)\.{1,2}(\/|$)/.test(dir.slice(root.length)) &&
    (/^[a-zA-Z]:\//.test(root) ? dir.toLowerCase().startsWith(root.toLowerCase() + '/') : dir.startsWith(root + '/'))
  const safe = under(values.data) || under(values.home && `${values.home}/.claude/agent-reports`)
  if (!safe) return values.data ? `${values.data}/agent-reports/${values.session}/${clean(agentId)}.md` : null
  return `${dir}/${clean(agentId)}.md`
}

export function shortReport(report: string, path: string): string | null {
  const r = part('reports')
  if (!r || typeof r.cap !== 'number' || typeof report !== 'string' || report.length <= r.cap) return null
  const max = typeof r.excerpt === 'number' ? r.excerpt : 600
  let head = report.slice(0, max)
  const cut = head.lastIndexOf('\n')
  if (cut > max / 2) head = head.slice(0, cut)
  head = head.trimEnd()
  return `${head}\n...\n\n${fill(r.pointer, { chars: String(report.length), cap: String(r.cap), path })}`
}

async function shorten(report: string, agentId: string, save: Save): Promise<string | null> {
  const r = part('reports')
  if (!r || typeof r.cap !== 'number' || report.length <= r.cap) return null
  const path = await Promise.resolve(save({ agentId, report })).catch(() => null)
  return typeof path === 'string' && path ? shortReport(report, path) : null
}

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

export async function spawnGate($: EngineInterface, e: Obj, rt?: Ready, redlineOnly = false): Promise<string | null> {
  try {
    if (!table() || !isObj(e) || !(await signedIn(rt))) return null
    if (part('redline')) {
      const live = planOf(await Promise.resolve().then(() => $.session.usage()).catch(() => null)).week
      const held = heldPlan().week
      const week = live && !expired(live, Date.now()) ? live : held && !expired(held, Date.now()) ? held : null
      let refusal = redlineRefusal(week, isModuleSpawn(e.description, e.parentAgentId), await claudePlan($))
      if (refusal && week?.resets_at && (await engineStore($).get('redline_override')) === week.resets_at) refusal = null
      if (refusal) {
        try {
          $.ui.toast(refusal)
        } catch {}
        return refusal
      }
    }
    if (redlineOnly || e.fork === true || e.isTeammate === true) return null
    if (!part('steps') || (await methodsLevel(engineStore($))) === 'off') return null
    const found = await readPlan($, stepsFiles())
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

async function agentTranscript($: EngineInterface, agentId: string): Promise<string | null> {
  if (!/^[\w-]{1,80}$/.test(agentId)) return null
  const read = readTextOf($)
  const root = `${(await engineDirs($)).configDir.replace(/\\/g, '/')}/projects`
  const tail = `/${String(await $.session.id())}/subagents/agent-${agentId}.jsonl`
  const names: string[] = []
  for (const p of [await Promise.resolve($.session.root()).catch(() => ''), await Promise.resolve($.session.cwd()).catch(() => '')]) {
    const name = String(p ?? '').replace(/[^a-zA-Z0-9]/g, '-')
    if (name && !names.includes(name)) names.push(name)
  }
  for (const name of names) {
    const text = await read(`${root}/${name}${tail}`)
    if (text !== null) return text
  }
  const list: Obj[] = await Promise.resolve($.fs.list(root)).catch(() => [])
  for (const d of (Array.isArray(list) ? list : []).slice(0, 200)) {
    const name = String(d?.name ?? '')
    if (!name || names.includes(name) || (d?.kind !== undefined && d.kind !== 'dir')) continue
    const text = await read(`${root}/${name}${tail}`)
    if (text !== null) return text
  }
  return null
}

async function savingLine($: EngineInterface, agentId: string, rt?: Ready): Promise<void> {
  try {
    if (!agentId || !(await signedIn(rt)) || (await routingLevel(engineStore($))) === 'off') return
    const text = await agentTranscript($, agentId)
    if (text === null) return
    const main = String((await Promise.resolve($.session.model()).catch(() => '')) || '') || null
    const methods = await readTextOf($)(`${await dataDir($)}/methods.md`)
    const line = savingText(runSaving(collect([{ rel: 'subagents/agent.jsonl', text }]).values(), main, PRICES, overheadTokens(methods)))
    if (line) $.ui.log(line)
  } catch {}
}

export async function agentResult($: EngineInterface, e: Obj, done: Obj, rt?: Ready): Promise<Obj> {
  try {
    const r = isObj(done) && done.deny === undefined && done.isError !== true && isObj(done.result) ? done.result : null
    const foreground = r !== null && toolInput(e).run_in_background !== true && (r.status === undefined || r.status === 'completed')
    if (foreground && !e?.agentId && (e?.tool === 'Agent' || e?.tool === 'Task')) void savingLine($, String(r!.agentId ?? ''), rt)
    if (!part('reports') || e?.agentId || (e?.tool !== 'Agent' && e?.tool !== 'Task') || !(await signedIn(rt))) return done
    return (await shortenAgentResult(done, e.tool_use_id, saver($))) ?? done
  } catch {
    return done
  }
}

export async function notificationEvent($: EngineInterface, e: Obj, rt?: Ready): Promise<Obj> {
  try {
    if (isObj(e) && e.origin?.kind === 'task-notification' && typeof e.text === 'string') {
      const id = /<task-id>([^<]*)<\/task-id>/.exec(e.text)?.[1]?.trim() ?? ''
      if (id) void mainAgent($, id).then((main) => (main ? savingLine($, id, rt) : undefined), () => undefined)
    }
    if (!part('reports') || !isObj(e) || e.origin?.kind !== 'task-notification' || !(await signedIn(rt))) return e
    const text = await shortenNotification(e.text, saver($), (id) => mainAgent($, id))
    return text === null ? e : { ...e, text }
  } catch {
    return e
  }
}
