import { commandsOf, programBase, programWords, shellLine, splitOutsideQuotes } from './cmdguard'
import { redact } from './redact'
import { vaultMask } from './vault'
import { NOTE_PREFIX } from './review'

type Obj = Record<string, any>
export type PlaceholderFile = { path: string; line: number }
export type Placeholder = { id: string; question: string; files: PlaceholderFile[]; fake: string; status: 'open' | 'filled'; filled_at: string | null }
export type Marker = { id: string; line: number; bad?: boolean }
export type GateResult = { ok: boolean; open: string[]; markers: { path: string; line: number; id: string }[]; unchecked: number; reason: string | null }
export type Checked = { ok: true; record: Placeholder } | { ok: false; reason: string }

function maxFiles(): number {
  return 50
}

export function idParts(id: unknown): { question: string; n: number } | null {
  if (typeof id !== 'string') return null
  const m = /^([A-Za-z][A-Za-z0-9_]{0,39})-([1-9][0-9]{0,3})$/.exec(id)
  return m ? { question: m[1]!, n: Number(m[2]) } : null
}

function list(x: unknown): any[] {
  return Array.isArray(x) ? x : []
}

function placeholdersOf(state: unknown): Obj[] {
  return list((state as Obj | null)?.placeholders).filter((p) => p && typeof p === 'object' && !Array.isArray(p))
}

function isOpen(p: Obj): boolean {
  return p.status !== 'filled'
}

function openIds(state: unknown): string[] {
  return placeholdersOf(state)
    .filter(isOpen)
    .map((p) => (typeof p.id === 'string' ? p.id : '?'))
}

export function oneLine(text: string, cap: number): string {
  const flat = String(text).replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ').trim()
  if (flat.length <= cap) return flat
  const end = cap > 0 && /[\uD800-\uDBFF]/.test(flat[cap - 1]!) ? cap - 1 : cap
  return `${flat.slice(0, end)}...`
}

function masked(text: string): string {
  try {
    return vaultMask(redact(text))
  } catch {
    return '[hidden]'
  }
}

function idList(ids: string[], cap = 10): string {
  const one = ids.map((id) => oneLine(id, 80))
  return one.length > cap ? `${one.slice(0, cap).join(', ')} and ${one.length - cap} more` : one.join(', ')
}


export function scanMarkers(text: unknown): Marker[] {
  try {
    if (typeof text !== 'string') return []
    const out: Marker[] = []
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i]!.matchAll(/AGENT_PLACEHOLDER\(([^()\r\n]{0,64})\)/g)) {
        const id = m[1]!
        out.push(idParts(id) ? { id, line: i + 1 } : { id, line: i + 1, bad: true })
      }
    }
    return out
  } catch {
    return []
  }
}


function secretQuestion(text: string): boolean {
  return /\b(?:passwords?|passwd|passphrases?|api[-_ ]?keys?|secrets?|secret[-_ ]?keys?|private[-_ ]?keys?|ssh[-_ ]?keys?|(?:access|auth|api|bearer|bot|refresh|session|secret)[-_ ]?tokens?|credentials?|(?:credit|debit)[-_ ]?cards?|card[-_ ]?numbers?|account[-_ ]?numbers?|routing[-_ ]?numbers?|iban|swift|cvv|cvc|ssn|social security|bank[-_ ]?details|payment[-_ ]?details)\b/i.test(text)
}

function secretFake(text: string): boolean {
  return /(?:^|[^a-z])(?:passwords?|passwd|passphrase|secrets?|tokens?|apikey|api[-_ ]?key|private[-_ ]?key|credentials?|cvv|ssn|iban)(?:[^a-z]|$)/i.test(text)
}

export function validatePlaceholder(record: unknown, state: unknown, mask: unknown): Checked {
  try {
    const r = record && typeof record === 'object' && !Array.isArray(record) ? (record as Obj) : null
    if (!r) return { ok: false, reason: 'A placeholder record must be an object with id, files and fake.' }
    const parts = idParts(r.id)
    if (!parts) return { ok: false, reason: 'The placeholder id must look like <question>-<n>, for example q3-1 (n from 1 to 9999).' }
    const id = r.id as string
    if (r.question !== undefined && r.question !== null && r.question !== parts.question)
      return { ok: false, reason: `The placeholder id ${id} belongs to question ${parts.question}, not to the question given.` }
    const q = list((state as Obj | null)?.questions).find((x) => x && typeof x === 'object' && x.id === parts.question)
    if (!q) return { ok: false, reason: `No recorded question ${parts.question}: record the question first, then its placeholders.` }
    if (q.answer !== null && q.answer !== undefined && q.answer !== '')
      return { ok: false, reason: `Question ${parts.question} is already answered: use the real value instead of a placeholder.` }
    if (secretQuestion(typeof q.text === 'string' ? q.text : ''))
      return { ok: false, reason: `Question ${parts.question} asks for a password, key, token, account or payment detail: never a placeholder; that stays a step only the user can do.` }
    if (placeholdersOf(state).some((p) => p.id === id)) return { ok: false, reason: `Placeholder ${id} is already recorded.` }
    const files: PlaceholderFile[] = []
    if (!Array.isArray(r.files) || r.files.length === 0 || r.files.length > maxFiles())
      return { ok: false, reason: `A placeholder needs 1 to ${maxFiles()} file locations ({path, line}).` }
    for (const f of r.files) {
      const path = f && typeof f === 'object' ? f.path : null
      const line = f && typeof f === 'object' ? f.line : null
      if (typeof path !== 'string' || !path.trim() || path.length > 512 || path.includes('\0') || !Number.isInteger(line) || line < 1 || line > 10_000_000)
        return { ok: false, reason: 'Each file location needs a path and a line number of 1 or more.' }
      files.push({ path, line })
    }
    const fake = r.fake
    if (typeof fake !== 'string' || !fake.trim() || fake.length > 200)
      return { ok: false, reason: 'A placeholder needs a visibly fake value of 1 to 200 characters (for example a .test host).' }
    if (typeof mask !== 'function') return { ok: false, reason: 'The fake value could not be checked for secrets, so it is refused.' }
    let same = false
    try {
      same = mask(fake) === fake
    } catch {
      same = false
    }
    if (!same || secretFake(fake))
      return { ok: false, reason: 'The fake value looks like a secret (a password, key or token): never use a placeholder for one; use a plainly fake value, or leave that step to the user.' }
    return { ok: true, record: { id, question: parts.question, files, fake, status: 'open', filled_at: null } }
  } catch {
    return { ok: false, reason: 'The placeholder record could not be checked.' }
  }
}


export function gateFiles(state: unknown): string[] {
  try {
    const seen: string[] = []
    for (const p of placeholdersOf(state)) {
      for (const f of list(p.files)) {
        const path = f && typeof f === 'object' ? f.path : null
        if (typeof path === 'string' && path && !seen.includes(path)) seen.push(path)
      }
    }
    return seen.slice(0, maxFiles())
  } catch {
    return []
  }
}

function allPaths(state: unknown): number {
  const s = new Set<string>()
  for (const p of placeholdersOf(state)) for (const f of list(p.files)) if (typeof f?.path === 'string' && f.path) s.add(f.path)
  return s.size
}

export function deliverGate(state: unknown, fileTexts: unknown): GateResult {
  try {
    const open = openIds(state)
    const texts = fileTexts && typeof fileTexts === 'object' && !Array.isArray(fileTexts) ? (fileTexts as Obj) : {}
    const markers: { path: string; line: number; id: string }[] = []
    const paths = gateFiles(state)
    for (const path of paths) {
      const text = Object.prototype.hasOwnProperty.call(texts, path) ? texts[path] : null
      for (const m of scanMarkers(text)) markers.push({ path, line: m.line, id: m.id })
    }
    const unchecked = Math.max(0, allPaths(state) - paths.length)
    const why: string[] = []
    if (open.length) why.push(`placeholder ${idList(open)} is still open: fill it with the answer to its question first`)
    if (markers.length) {
      const at = markers.slice(0, 20).map((m) => `${m.path}:${m.line}`)
      why.push(`a placeholder marker is still in ${at.join(', ')}${markers.length > 20 ? ` and ${markers.length - 20} more` : ''}: replace it with the real value`)
    }
    const ok = why.length === 0
    return {
      ok,
      open,
      markers,
      unchecked,
      reason: ok ? null : `${NOTE_PREFIX}: not delivered yet; ${why.join('; ')}. Then run the tests again and deliver.`,
    }
  } catch {
    return { ok: false, open: [], markers: [], unchecked: 0, reason: `${NOTE_PREFIX}: the placeholder check failed, so delivery waits.` }
  }
}


export function releaseWords(): string[] {
  return [
    'git push',
    'npm publish', 'pnpm publish', 'yarn publish', 'yarn npm publish', 'bun publish', 'cargo publish', 'twine upload',
    'gem push', 'poetry publish', 'flit publish', 'dotnet nuget push', 'nuget push', 'mvn deploy', 'gradle publish',
    'gradlew publish', 'docker push', 'podman push', 'gh release create', 'gh release upload',
    'vercel deploy', 'vercel --prod', 'netlify deploy', 'firebase deploy', 'fly deploy', 'flyctl deploy', 'wrangler deploy',
    'wrangler publish', 'serverless deploy', 'sls deploy', 'cdk deploy', 'gcloud app deploy', 'gcloud run deploy',
    'eb deploy', 'terraform apply', 'helm upgrade', 'helm install', 'kubectl apply',
    'npm run deploy', 'npm run release', 'npm run publish', 'pnpm run deploy', 'pnpm run release', 'yarn deploy',
    'yarn release', 'make deploy', 'make release', 'make publish',
    'deploy*', 'release*', 'publish*',
  ]
}

function programMatches(entry: string, token: string): boolean {
  const base = programBase(token)
  if (!entry.endsWith('*')) return base === entry
  const stem = entry.slice(0, -1)
  return base === stem || [`${stem}-`, `${stem}_`].some((h) => base.startsWith(h) && /^(?:prod|production|live|stable|all)$/.test(base.slice(h.length)))
}

function wordsMatch(want: string[], args: string[]): boolean {
  let pos = 0
  for (const w of want) {
    if (w.startsWith('-')) {
      if (!args.some((a) => a === w || a.startsWith(`${w}=`))) return false
      continue
    }
    let afterOption = false
    for (;;) {
      const a = args[pos]
      if (a === undefined) return false
      pos++
      if (a === w) break
      if (a.startsWith('-')) {
        afterOption = !a.includes('=')
        continue
      }
      if (afterOption) {
        afterOption = false
        continue
      }
      return false
    }
  }
  return true
}

function isInterpreter(base: string): boolean {
  return /^(?:bash|sh|zsh|dash|ksh|pwsh|powershell|python|python3|py|node)$/.test(base)
}

function entryOf(word: unknown): { program: string; want: string[] } | null {
  if (typeof word !== 'string') return null
  const t = word.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return t.length ? { program: t[0]!, want: t.slice(1) } : null
}

function stageHit(stage: string, entries: { program: string; want: string[] }[], depth: number): boolean {
  const toks = programWords(stage)
  if (!toks.length) return false
  const low = toks.map((t) => t.toLowerCase())
  const tryAt = (prog: string, args: string[]): boolean => entries.some((e) => programMatches(e.program, prog) && wordsMatch(e.want, args))
  if (tryAt(low[0]!, low.slice(1))) return true
  const inner = shellLine(toks)
  if (inner !== null) return depth < 2 && lineHit(inner, entries, depth + 1) !== null
  if (!isInterpreter(programBase(low[0]!))) return false
  for (let i = 1; i < low.length; i++) {
    const a = low[i]!
    if (/^-(?:c|command)$/.test(a) || (/^(?:bash|sh|zsh|dash|ksh)$/.test(programBase(low[0]!)) && /^-[a-z]*c[a-z]*$/.test(a))) return depth < 2 && i + 1 < toks.length && lineHit(toks[i + 1]!, entries, depth + 1) !== null
    if (/^-(?:file|f)$/.test(a)) continue
    if (a.startsWith('-')) continue
    return tryAt(a, low.slice(i + 1))
  }
  return false
}

function lineHit(command: string, entries: { program: string; want: string[] }[], depth: number): string | null {
  for (const one of commandsOf(command)) {
    for (const stage of splitOutsideQuotes(one, /\|/)) {
      const s = stage.trim()
      if (s && stageHit(s, entries, depth)) return s
    }
  }
  return null
}

export function releaseCommandDenied(command: unknown, state: unknown, words?: unknown): string | null {
  try {
    const open = openIds(state)
    if (!open.length) return null
    const hit = releaseCommandHit(command, words)
    if (hit === null) return null
    const qs = [...new Set(open.map((id) => idParts(id)?.question ?? '?'))]
    return (
      `${NOTE_PREFIX}: "${oneLine(masked(hit), 200)}" is held: placeholder ${idList(open)} is still open ` +
      `(question ${idList(qs)} waits for the user's answer). Nothing is pushed, published, deployed or released while a ` +
      'placeholder is open. Keep working on what the answer does not affect; once it arrives, fill every placeholder, ' +
      'run the tests again, call task_state placeholder_filled, then run this again.'
    )
  } catch {
    return null
  }
}

export function releaseCommandHit(command: unknown, words?: unknown): string | null {
  try {
    if (typeof command !== 'string' || !command.trim()) return null
    const source = words === null || words === undefined ? releaseWords() : Array.isArray(words) ? words : []
    const entries = source.map(entryOf).filter((e): e is { program: string; want: string[] } => e !== null)
    return entries.length ? lineHit(command.slice(0, 8192), entries, 0) : null
  } catch {
    return null
  }
}


export function fillNote(state: unknown, questionId: unknown, answer: unknown): string | null {
  try {
    if (typeof questionId !== 'string' || !questionId) return null
    const mine = placeholdersOf(state).filter((p) => isOpen(p) && typeof p.id === 'string' && (p.question === questionId || idParts(p.id)?.question === questionId))
    if (!mine.length) return null
    const said = oneLine(masked(typeof answer === 'string' ? answer : answer === null || answer === undefined ? '' : String(answer)), 600)
    const rows: string[] = []
    let more = 0
    for (const p of mine) {
      const fake = oneLine(masked(typeof p.fake === 'string' ? p.fake : ''), 120)
      for (const f of list(p.files)) {
        if (typeof f?.path !== 'string') continue
        if (rows.length >= 40) {
          more++
          continue
        }
        rows.push(`- ${oneLine(p.id, 80)}: ${oneLine(f.path, 200)}:${Number.isInteger(f.line) ? f.line : '?'} (fake was ${fake})`)
      }
    }
    if (more) rows.push(`- and ${more} more locations (see the task state)`)
    const ids = mine.map((p) => p.id as string)
    return [
      `${NOTE_PREFIX}: question ${questionId} was answered: "${said}". Its open placeholders:`,
      ...rows,
      'Steps:',
      `1. Replace each marker AGENT_PLACEHOLDER(<id>) and its fake value with the real value from the answer (ids ${idList(ids, 20)}).`,
      '2. Run the tests again with the real values.',
      `3. Call the task_state tool with op placeholder_filled for ${idList(ids, 20)}.`,
      '4. Then deliver: nothing is delivered, pushed, published, deployed or released while a placeholder is open.',
    ].join('\n')
  } catch {
    return null
  }
}
