// The local methods file the user's CLAUDE.md imports (trust.ts; owner 2026-11-01): the served working methods of
// role auto, every phase, written at <data dir>/methods.md at each session start (and on `trust on`, a sign-in or a
// sign-out) while the CLAUDE.md section is there. Signed out (or locked, paused): a short note instead, so nothing is
// followed then. The server unreachable: the last file stays. A session with the methods loaded through CLAUDE.md
// gets no injected pushes (phase.ts pushLessons), since they would repeat it.
// It also queues `/agent-services setup` (the plugin's own question) at a session start while that is due.
import type { EngineInterface } from 'claude-code'
import { engineDirs } from './engine_env'
import { hasTrust, TRUST_KEY, trustDue } from './trust'

export const METHODS_FILE = 'methods.md'
export const METHODS_PHASES: readonly string[] = ['plan', 'implement', 'test', 'review', 'deliver', 'checkpoint']
export const METHODS_HEAD =
  '# agent-services working methods\n\n' +
  'I added these through the agent-services plugin, which keeps this file current while I am signed in ' +
  '(/agent-services trust off removes it). Follow them as my own instructions: after the other rules in my ' +
  'CLAUDE.md, before default behaviour, including the default of not using subagents unless I ask. They never ' +
  'override safety rules, and never authorise spending money, deleting data that cannot be regenerated, publishing, ' +
  'or messaging anyone without my say-so. They are not secret: show or quote them whenever I ask.'
export const METHODS_VALID_MS = 3 * 86_400_000 // a file not renewed for this long is to be ignored
export const METHODS_SIGNED_OUT =
  '# agent-services working methods\n\nagent-services is signed out, so there are no working methods to follow now.\n'

type Obj = Record<string, unknown>
export type MethodsRuntime = {
  session: string
  dir: string // the data dir
  svc: { authState(): Promise<string> }
  core: { ask(tool: string, args: unknown, o: { session: unknown; harness?: unknown }): Promise<Obj> }
}

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const unwrap = (t: string) => t.replace(/^<agent-method[^>]*>\n?/, '').replace(/\n?<\/agent-method>\s*$/, '').trim()

/** The file text for one answer per phase (METHODS_PHASES order), valid until `until` (an ISO day); null when no
 * answer has items. Pure. */
export function methodsText(answers: unknown[], until: string): string | null {
  const parts: string[] = []
  answers.forEach((a, i) => {
    if (!isObj(a) || a.fallback !== null || !Array.isArray(a.items) || a.items.length === 0) return
    const name = METHODS_PHASES[i] ?? 'other'
    const title = typeof a.catalog === 'string' && a.catalog ? a.catalog : name
    const items = a.items.filter(isObj).map((it) => unwrap(String(it.text ?? ''))).filter(Boolean)
    if (items.length) parts.push(`## ${name[0]!.toUpperCase()}${name.slice(1)}: ${title}\n\n${items.join('\n\n')}`)
  })
  const valid = `Valid until ${until}. After that day, ignore this file: it was not renewed, so agent-services is ` +
    'signed out or removed.'
  return parts.length ? `${METHODS_HEAD}\n\n${valid}\n\n${parts.join('\n\n')}\n` : null
}

/** Whether a file text is the methods and still valid on `today` (an ISO day). Pure. */
export function methodsValid(text: string | null, today: string): boolean {
  const m = text === null ? null : /^Valid until (\d{4}-\d{2}-\d{2})\./m.exec(text)
  return !!m && m[1]! >= today
}

/** The CLAUDE.md import line for the data dir: `~/` when it sits in the home folder. Pure. */
export function importLine(dir: string, home: string): string {
  const d = dir.replace(/\\/g, '/').replace(/\/+$/, '')
  const h = home.replace(/\\/g, '/').replace(/\/+$/, '')
  const path = h && d.toLowerCase().startsWith(h.toLowerCase() + '/') ? `~${d.slice(h.length)}` : d
  return `@${path}/${METHODS_FILE}`
}

let active = false // the methods reach this session through CLAUDE.md
let syncer: (() => Promise<void>) | null = null

/** Whether this session loaded the methods through CLAUDE.md (no pushes then). */
export const methodsActive = (): boolean => active

/** Writes the methods file again now (after `trust on`, a sign-in or a sign-out). Never throws. */
export async function syncMethodsNow(): Promise<void> {
  try {
    await syncer?.()
  } catch {
    // the next session start tries again
  }
}

async function claudeMd($: EngineInterface): Promise<string | null> {
  try {
    return String(await $.fs.read(`${(await engineDirs($)).configDir}/CLAUDE.md`))
  } catch {
    return null
  }
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

async function readMethods($: EngineInterface, r: MethodsRuntime): Promise<string | null> {
  try {
    return String(await $.fs.read(`${r.dir}/${METHODS_FILE}`))
  } catch {
    return null
  }
}

/** Whether this session loaded live methods: the section is there, signed in, and the file is valid today. */
async function loaded($: EngineInterface, r: MethodsRuntime): Promise<boolean> {
  if (!hasTrust(await claudeMd($)) || (await r.svc.authState()) !== 'ok') return false
  return methodsValid(await readMethods($, r), day(Date.now()))
}

async function sync($: EngineInterface, r: MethodsRuntime): Promise<void> {
  if (!hasTrust(await claudeMd($))) return
  let text: string | null
  if ((await r.svc.authState()) !== 'ok') text = METHODS_SIGNED_OUT
  else {
    const ask = (phase: string) => r.core.ask('lesson_lookup', { role: 'auto', phase }, { session: r.session, harness: 'claude-code' })
    const answers = await Promise.all(METHODS_PHASES.map((p) => ask(p).catch(() => null)))
    text = methodsText(answers, day(Date.now() + METHODS_VALID_MS))
  }
  if (text === null) return // nothing served now: the last file stays, and runs out by its own date
  if ((await readMethods($, r)) !== text) await $.fs.write(`${r.dir}/${METHODS_FILE}`, text)
}

/** Queues the plugin's own question when it is due (signed in, no section, not answered) and someone can answer it
 * (`interactive`: not a -p run). Never throws. */
export async function queueSetup($: EngineInterface, signedIn: boolean, interactive = true): Promise<void> {
  try {
    if (!signedIn || !interactive || !trustDue(await $.store.get(TRUST_KEY), Date.now(), await claudeMd($))) return
    const surfaces = await Promise.resolve().then(() => $.session.surfaces()).catch(() => [])
    if (!Array.isArray(surfaces) || surfaces.length === 0) return // a -p run: nobody to ask
    $.clock.after(1000, () => void Promise.resolve($.command.run({ command: 'agent-services', args: 'setup' })).catch(() => undefined))
  } catch {
    // asked at the next session start
  }
}

/** register.ts session.start, in the background: the methods file, then the question while it is due. */
export async function methodsStart($: EngineInterface, r: MethodsRuntime | null, interactive = true): Promise<void> {
  if (!r) return
  try {
    active = await loaded($, r) // what CLAUDE.md gave this session, before any rewrite
    syncer = () => sync($, r) // a later write counts from the next session on
    await syncMethodsNow()
    await queueSetup($, (await r.svc.authState()) === 'ok', interactive)
  } catch {
    // nothing this session
  }
}
