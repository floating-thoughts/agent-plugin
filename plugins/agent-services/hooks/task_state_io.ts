import type { EngineInterface } from 'claude-code'
import { ensureAgentIgnore } from './agent_files'
import { dataDir } from './engine_env'
import { appendLines, applyOp, capState, decisionLine, emptyState, isFileOp, isWriteOp, lessonParagraph, mergeStates, parseTaskState, planEdit, recoverPlaceholders, renderMarkdown, resumeNote, type FileEdit, type OpCtx, type TaskState } from './task_state'
import { NOTE_PREFIX } from './review'

type Mask = (text: string) => string
type Raw = { kind: 'absent' } | { kind: 'error' } | { kind: 'big' } | { kind: 'text'; text: string }

const slashed = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
const iso = (ms: number): string => new Date(ms).toISOString()
const NO_PROJECT = 'No project folder was found (the session\'s folder could not be read); nothing was written. Open the session in a project folder, or add agent-state.md to one.'

export type Refusal = { dir: string; kind: 'home' | 'temp' | 'root' }

export function errorBrief(err: unknown, mask?: Mask): string {
  try {
    const name = String((err as any)?.name || (err as any)?.constructor?.name || typeof err).slice(0, 40)
    if (!mask) return name
    const msg = mask(String((err as any)?.message ?? err ?? '')).replace(/\s+/g, ' ').trim().slice(0, 120)
    return msg ? `${name}: ${msg}` : name
  } catch {
    return 'Error'
  }
}

export function refusalText(r: Refusal, stale: boolean, verb: 'written' | 'read' = 'written'): string {
  const shown = /^[A-Za-z]:$/.test(r.dir) || !r.dir ? `${r.dir}/` : r.dir
  const what = r.kind === 'home' ? 'your home folder' : r.kind === 'temp' ? 'a temp folder' : 'a drive root'
  const path = taskStatePaths(r.dir).json
  return `No project folder was found: ${shown} is ${what}, and task state is kept only inside a project folder; nothing was ${verb}. ` +
    `Run this from the project folder${stale ? `. A stale record from an older version exists at ${path}; the plugin no longer reads it here, so close it by editing that file by hand if needed` : ''}.`
}

export async function projectDir($: EngineInterface, start?: string): Promise<string | null> {
  try {
    const root = slashed(String(await $.session.root()))
    let dir = slashed(start ?? String(await $.session.cwd()))
    for (let i = 0; i < 12 && dir; i++) {
      if (await $.fs.exists(`${dir}/agent-state.md`).catch(() => false)) return dir
      const up = dir.replace(/\/[^/]*$/, '')
      if (!up || up === dir || !up.includes('/')) break
      dir = up
    }
    return root || null
  } catch {
    return null
  }
}

export async function projectWriteDir($: EngineInterface, start?: string): Promise<string | null> {
  return (await writeTarget($, start)).dir
}

export async function writeTarget($: EngineInterface, start?: string): Promise<{ dir: string | null; refused: Refusal | null }> {
  try {
    const dir = await projectDir($, start)
    if (!dir) return { dir: null, refused: null }
    const key = (p: string): string => slashed(p).toLowerCase()
    const env = async (read: () => unknown): Promise<string> => {
      try {
        return String((await read()) ?? '').trim()
      } catch {
        return ''
      }
    }
    const homes = [await env(() => $.env.get('HOME')), await env(() => $.env.get('USERPROFILE'))]
    const temps = [await env(() => $.env.get('TEMP')), await env(() => $.env.get('TMP')), await env(() => $.env.get('TMPDIR'))]
    const k = key(dir)
    const no = (kind: Refusal['kind']) => ({ dir: null, refused: { dir: slashed(dir), kind } })
    if (!k || /^(?:[a-z]:)?$/.test(k)) return no('root')
    if (homes.some((h) => h && key(h) === k)) return no('home')
    if (temps.some((h) => h && key(h) === k)) return no('temp')
    if (/^(?:[a-z]:)?(?:\/private)?(?:\/var)?\/tmp$/.test(k) || /\/appdata\/local\/temp$/.test(k) || /^[a-z]:\/windows\/temp$/.test(k)) return no('temp')
    return { dir, refused: null }
  } catch {
    return { dir: null, refused: null }
  }
}

export async function noProjectNote($: EngineInterface, start?: string, verb: 'written' | 'read' = 'written'): Promise<string> {
  try {
    const t = await writeTarget($, start)
    if (!t.refused) return NO_PROJECT
    const stale = !!(await $.fs.exists(taskStatePaths(t.refused.dir).json).catch(() => false))
    return refusalText(t.refused, stale, verb)
  } catch {
    return NO_PROJECT
  }
}

export async function jobsDir($: EngineInterface): Promise<string | null> {
  const dir = await projectWriteDir($)
  if (dir) return dir
  try {
    const data = slashed(await dataDir($))
    return data && data !== '/.agent-services' ? `${data}/no-project` : null
  } catch {
    return null
  }
}

export function taskStatePaths(dir: string): { json: string; md: string } {
  return { json: `${slashed(dir)}/.agent/task-state.json`, md: `${slashed(dir)}/.agent/task-state.md` }
}

async function readRaw($: EngineInterface, path: string): Promise<Raw> {
  try {
    if (!(await $.fs.exists(path))) return { kind: 'absent' }
    const text = String(await $.fs.read(path))
    return text.length > 256 * 1024 ? { kind: 'big' } : { kind: 'text', text }
  } catch {
    return { kind: 'error' }
  }
}

export async function loadTaskState($: EngineInterface, opts: { start?: string } = {}): Promise<{ dir: string | null; state: TaskState | null; error: string | null; refused?: Refusal | null }> {
  try {
    const t = await writeTarget($, opts.start)
    const dir = t.dir
    if (!dir) return { dir: null, state: null, error: null, refused: t.refused }
    const raw = await readRaw($, taskStatePaths(dir).json)
    if (raw.kind === 'absent') return { dir, state: null, error: null }
    if (raw.kind === 'big') return { dir, state: null, error: 'oversize' }
    if (raw.kind === 'error') return { dir, state: null, error: 'unreadable' }
    const p = parseTaskState(raw.text)
    return 'state' in p ? { dir, state: p.state, error: null } : { dir, state: null, error: p.error }
  } catch {
    return { dir: null, state: null, error: 'unreadable' }
  }
}

export async function updateTaskState(
  $: EngineInterface,
  mutate: ((s: TaskState) => TaskState | null) | null,
  opts: { create?: boolean; start?: string; now?: number; onText?: (text: string) => Promise<void> } = {},
): Promise<{ state: TaskState | null; wrote: boolean; note: string | null }> {
  let wrote: TaskState | null = null
  let note: string | null = null
  try {
    const nowMs = opts.now ?? Date.now()
    const now = iso(nowMs)
    const dir = await projectWriteDir($, opts.start)
    if (!dir) return { state: null, wrote: false, note: await noProjectNote($, opts.start) }
    const paths = taskStatePaths(dir)
    const first = await readRaw($, paths.json)
    if (first.kind === 'error') return { state: null, wrote: false, note: `${paths.json} could not be read; nothing was changed.` }
    if (first.kind === 'big') return { state: null, wrote: false, note: `${paths.json} is larger than 256 KiB, so it is not read; nothing was changed. Trim it or move it aside.` }
    if (first.kind === 'absent' && !opts.create) return { state: null, wrote: false, note: null }
    let base = emptyState(now)
    let damaged: string | null = null
    if (first.kind === 'text') {
      const p = parseTaskState(first.text)
      if ('error' in p && p.error === 'newer') return { state: null, wrote: false, note: `${paths.json} was written by a newer plugin version; it was left unchanged.` }
      if ('state' in p) base = p.state
      else {
        damaged = first.text
        base = { ...base, placeholders: recoverPlaceholders(first.text) }
      }
    }
    let seen = base.rev
    let next = (mutate ?? ((s: TaskState) => s))(base)
    if (!next) return { state: base, wrote: false, note: damaged === null ? null : `${paths.json} could not be read (it is not valid task state); nothing was changed.` }
    await ensureAgentIgnore($, dir)
    if (damaged !== null) {
      const bad = `${dir}/.agent/task-state.bad-${now.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.json`
      await $.fs.write(bad, damaged)
      const kept = base.placeholders.map((x) => x.id)
      note = `${paths.json} could not be read; its text was kept in ${bad.split('/').pop()} and a new task state was started` +
        (kept.includes('unrecovered-1')
          ? ' without the old records. Its placeholders could not be recovered, so placeholder unrecovered-1 stands for them: check the code for AGENT_PLACEHOLDER markers, then call task_state placeholder_filled for unrecovered-1.'
          : kept.length ? ` with its open placeholders kept (${kept.join(', ')}); its other records were not kept.` : ' without the old records.')
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const cur = await readRaw($, paths.json)
      if (cur.kind === 'text') {
        const p = parseTaskState(cur.text)
        if ('error' in p && p.error === 'newer') return { state: null, wrote: false, note: `${paths.json} was written by a newer plugin version; it was left unchanged.` }
        if ('state' in p && p.state.rev !== seen) {
          next = mergeStates(next, p.state)
          seen = p.state.rev
        }
      }
      next = capState({ ...next, rev: Math.max(seen, next.rev) + 1, updated: now })
      const text = JSON.stringify(next, null, 1)
      if (opts.onText) await opts.onText(text)
      await $.fs.write(paths.json, text)
      wrote = next
      const back = await readRaw($, paths.json)
      if (back.kind !== 'text' || back.text === text) break
      const p = parseTaskState(back.text)
      if (!('state' in p)) break
      seen = p.state.rev
      next = mergeStates(next, p.state)
    }
    try {
      await $.fs.write(paths.md, renderMarkdown(wrote!))
    } catch {
      note = `${note ? `${note} ` : ''}The task state was saved, but ${paths.md} could not be updated.`
    }
    return { state: wrote, wrote: true, note }
  } catch (err) {
    if (wrote) return { state: wrote, wrote: true, note: `${note ? `${note} ` : ''}The task state was saved, but a later step failed (${errorBrief(err)}).` }
    return { state: null, wrote: false, note: `The task state could not be written (${errorBrief(err)}); carry on without it.` }
  }
}

export async function taskStateOp(
  $: EngineInterface,
  input: unknown,
  opts: { subagent: boolean; mask: Mask; session?: string; now?: number; start?: string },
): Promise<string> {
  try {
    const i = (input && typeof input === 'object' ? input : {}) as Record<string, any>
    const nowMs = opts.now ?? Date.now()
    const session = opts.session ?? String(await $.session.id().catch(() => ''))
    const ctx: OpCtx = { now: iso(nowMs), session, mask: opts.mask, subagent: opts.subagent }
    if (!isWriteOp(i.op)) {
      if (i.op !== 'read') return applyOp(emptyState(ctx.now), i, ctx).answer
      const got = await loadTaskState($, { start: opts.start })
      if (!got.state && got.refused) return await noProjectNote($, opts.start, 'read')
      if (!got.state) return got.error ? `The task state could not be read (${got.error}).` : `No task state is recorded for this project yet${got.dir ? ` (${taskStatePaths(got.dir).json})` : ''}.`
      return resumeNote(got.state, { mdPath: taskStatePaths(got.dir!).md }) || 'No open items in the task state.'
    }
    if (opts.subagent) return applyOp(emptyState(ctx.now), i, ctx).answer
    if (isFileOp(i.op)) return (await projectFileOp($, i, { mask: opts.mask, now: nowMs, start: opts.start })).answer
    if (i.op === 'deliver' || i.op === 'placeholder_filled') {
      const got = await loadTaskState($, { start: opts.start })
      if (got.state && got.dir) ctx.markers = await markersLeft($, got.dir, got.state, i.op === 'deliver' ? null : String(i.id ?? ''))
    }
    if (i.op === 'keep_going') {
      const got = await loadTaskState($, { start: opts.start })
      if (!got.state && !got.error) return 'Noted: no task state is recorded here, so nothing is waiting on a keep-going answer; nothing was written.'
    }
    if (!(await projectWriteDir($, opts.start))) return await noProjectNote($, opts.start)
    let answer = ''
    const r = await updateTaskState($, (s) => {
      const res = applyOp(s, i, ctx)
      answer = res.answer
      return res.changed ? res.state : null
    }, { create: true, start: opts.start, now: nowMs })
    if (r.state === null) return r.note ?? 'The task state was not changed (no cause was reported); carry on without it.'
    return r.note ? `${answer} ${r.note}` : answer
  } catch (err) {
    return `The task state could not be changed (${errorBrief(err, opts.mask)}); carry on without it.`
  }
}

async function markersLeft($: EngineInterface, dir: string, s: TaskState, only: string | null): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {}
  const texts = new Map<string, string | null>()
  for (const p of s.placeholders) {
    if (only !== null && p.id !== only) continue
    for (const f of p.files) {
      const abs = /^([A-Za-z]:)?[\\/]/.test(f.path) ? slashed(f.path) : `${slashed(dir)}/${f.path.replace(/^\.\//, '')}`
      if (!texts.has(abs)) {
        if (texts.size >= 50) continue
        texts.set(abs, await Promise.resolve($.fs.read(abs)).then((t) => String(t), () => null))
      }
      const t = texts.get(abs)
      if (t && t.includes(`AGENT_PLACEHOLDER(${p.id})`)) (out[p.id] ??= []).includes(f.path) || out[p.id].push(f.path)
    }
  }
  return out
}

export async function taskStateNote($: EngineInterface, opts: { since?: string | null; start?: string } = {}): Promise<string | null> {
  try {
    const got = await loadTaskState($, { start: opts.start })
    if (!got.dir) return null
    const paths = taskStatePaths(got.dir)
    if (got.error === 'corrupt') return `${NOTE_PREFIX}: ${paths.json} could not be read; it is set aside at the next task_state change, and release commands are held until then.`
    if (got.error === 'newer') return `${NOTE_PREFIX}: ${paths.json} was written by a newer plugin version.`
    if (got.error === 'oversize') return `${NOTE_PREFIX}: ${paths.json} is larger than 256 KiB, so it is not read; release commands are held until it is trimmed or moved aside.`
    if (got.error) return `${NOTE_PREFIX}: ${paths.json} could not be read; release commands are held until it can be.`
    if (!got.state) return null
    return resumeNote(got.state, { mdPath: paths.md, since: opts.since ?? null }) || null
  } catch {
    return null
  }
}


export async function writeChecked(
  $: EngineInterface, path: string, change: (old: string | null) => FileEdit, opts: { append?: boolean } = {},
): Promise<{ answer: string; wrote: boolean; ok: boolean }> {
  const name = path.split('/').pop()
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await readRaw($, path)
      if (raw.kind === 'error') return { answer: `${name} could not be read; nothing was written.`, wrote: false, ok: false }
      if (raw.kind === 'big') return { answer: `${name} is larger than 256 KiB; nothing was written.`, wrote: false, ok: false }
      const old = raw.kind === 'text' ? raw.text : null
      const r = change(old)
      if ('refuse' in r) return { answer: r.refuse, wrote: false, ok: false }
      if (r.text === old) return { answer: r.answer, wrote: false, ok: true }
      if (opts.append && old !== null && !r.text.startsWith(old)) return { answer: `Not written: ${name} is only appended to.`, wrote: false, ok: false }
      const again = await readRaw($, path)
      if ((again.kind === 'text' ? again.text : again.kind === 'absent' ? null : undefined) !== old) continue
      await $.fs.write(path, r.text)
      const back = await readRaw($, path)
      if (back.kind !== 'text' || back.text !== r.text) return { answer: `${r.answer} Note: ${name} read back differently after the write (another writer?); check it.`, wrote: true, ok: true }
      return { answer: r.answer, wrote: true, ok: true }
    }
    return { answer: `Not written: ${name} was changed by another writer while this op ran; run the op again.`, wrote: false, ok: false }
  } catch (err) {
    return { answer: `${name} could not be written (${errorBrief(err)}); carry on without it.`, wrote: false, ok: false }
  }
}

export async function decisionsFile($: EngineInterface, dir: string): Promise<string> {
  const d = slashed(dir)
  const has = async (p: string): Promise<boolean> => !!(await $.fs.exists(p).catch(() => false))
  const file = `${d}/decisions.md`
  if (await has(file)) return file
  if (await has(`${d}/notes.md`)) return `${d}/notes.md`
  return file
}

export async function decisionsSince($: EngineInterface, dir: string, since: string): Promise<string[]> {
  try {
    const raw = await readRaw($, await decisionsFile($, dir))
    if (raw.kind !== 'text') return []
    const out: string[] = []
    for (const l of raw.text.split(/\r?\n/)) {
      const d = /^\s*(?:[-*]\s+)?(\d{4}-\d{2}-\d{2})\b/.exec(l)?.[1]
      if (d && d >= since) out.push(l.trim())
    }
    return out.slice(-50)
  } catch {
    return []
  }
}

export async function projectFileOp(
  $: EngineInterface, input: Record<string, any>, opts: { mask: Mask; now?: number; start?: string },
): Promise<{ answer: string; ran: boolean; dir: string | null }> {
  try {
    const dir = await projectWriteDir($, opts.start)
    if (!dir) return { answer: await noProjectNote($, opts.start), ran: false, dir: null }
    const date = iso(opts.now ?? Date.now()).slice(0, 10)
    const op = String(input.op ?? '')
    if (op.startsWith('plan_')) {
      const r = await writeChecked($, `${dir}/agent-state.md`, (old) => planEdit(old, input, opts.mask))
      return { answer: r.answer, ran: r.ok, dir }
    }
    if (op === 'decide') {
      const made = decisionLine(input, date, opts.mask)
      if ('refuse' in made) return { answer: made.refuse, ran: false, dir }
      const path = await decisionsFile($, dir)
      const r = await writeChecked($, path, (old) => ({ text: appendLines(old, [made.line], false, ['# Decisions']), answer: `Appended to ${path.split('/').pop()}: ${made.line}` }), { append: true })
      return { answer: r.answer, ran: r.wrote, dir }
    }
    const made = lessonParagraph(input, date, opts.mask)
    if ('refuse' in made) return { answer: made.refuse, ran: false, dir }
    const r = await writeChecked($, `${dir}/.agent/lessons.md`, (old) => ({ text: appendLines(old, [made.line], true), answer: `Appended to .agent/lessons.md: ${made.line}` }), { append: true })
    return { answer: r.answer, ran: r.wrote, dir }
  } catch (err) {
    return { answer: `The project file could not be written (${errorBrief(err, opts.mask)}); carry on without it.`, ran: false, dir: null }
  }
}
