import { ed25519, sha256 } from './noble.js'
import { b64Decode, b64Encode, hex, utf8 } from './e2e'
import type { Random } from './e2e'
import { canonical, openObject, sealVault, signObject, splitObject, verifyObject } from './sealed_crypto'
import type { Header } from './sealed_crypto'
import { kidOf, writerOf } from './sealed_roster'
import type { Roster } from './sealed_roster'
import { scrubDetail } from './brain_scrub'
import type { ScrubOpts } from './brain_scrub'
import type { Candidate, Send } from './brain_collect'

export type GetAnswer = { data_b64: string; sig: string; by?: string; roster_seq?: number; accepted_at?: number }
export type InboxOpts = { org: string; vault: string; roster: Roster; identity: string }
export type Refused = { object: string | null; by: string | null; reason: string }
export type DraftItem = { id: string; text: string; grade?: 'E2' | 'E3' | null }
export type ReviewItem = { id: string; grade: 'E2' | 'E3' | null; decision: string; blocked: string; text: string }
export type Pack = {
  v: 1; id: string; tier: 'company'; version: string; title: string; when: string
  items: { id: string; text: string; grade: 'E2' | 'E3' | null }[]
}
export type PublishOpts = { org: string; vault: string; epoch: number; object: string; version: number; ck: Uint8Array; seed: Uint8Array }

const BRAIN_RX = /^[a-z][a-z0-9-]{1,28}$/
const ITEM_ID_RX = /^[a-z0-9][a-z0-9-]{0,63}$/
const PACK_LIMITS = { items: 500, text: 700, bytes: 204800, title: 60, when: 160 } as const

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isGrade = (g: unknown): g is 'E2' | 'E3' => g === 'E2' || g === 'E3'

function candidateOk(p: Record<string, unknown>): boolean {
  const keys = Object.keys(p).sort().join(',')
  if (keys !== 'cand,grade,kind,project,seen,t,text,v' || p.v !== 1) return false
  if (typeof p.cand !== 'string' || !/^[0-9a-f]{32}$/.test(p.cand)) return false
  if (typeof p.project !== 'string' || !/^[0-9a-f]{32}$/.test(p.project)) return false
  if (typeof p.text !== 'string' || p.text.length < 1 || Array.from(p.text).length > 700) return false
  if (!Number.isInteger(p.seen) || (p.seen as number) < 1 || !Number.isInteger(p.t)) return false
  if (p.kind === 'lesson') return isGrade(p.grade)
  return p.kind === 'decision' && (p.grade === null || isGrade(p.grade))
}

const withdrawOk = (p: Record<string, unknown>): boolean =>
  Object.keys(p).sort().join(',') === 't,v,withdraw' && p.v === 1 && typeof p.withdraw === 'string' &&
  /^[0-9a-f]{32}$/.test(p.withdraw) && Number.isInteger(p.t)

export async function readInbox(answers: GetAnswer[], o: InboxOpts): Promise<{ candidates: Candidate[]; refused: number; reasons: Refused[] }> {
  const found: { by: string; c: Candidate }[] = []
  const withdrawn = new Set<string>()
  const reasons: Refused[] = []
  for (const a of Array.isArray(answers) ? answers : []) {
    let object: string | null = null
    let by: string | null = null
    const refuse = (reason: string) => reasons.push({ object, by, reason })
    let obj: Uint8Array
    let header: Header
    try {
      obj = b64Decode(a.data_b64)
      header = splitObject(obj).header
    } catch {
      refuse('bad_record')
      continue
    }
    object = header.object
    by = header.by
    if (header.kind !== 'inbox' || header.vault !== o.vault || header.org !== o.org || (a.by !== undefined && a.by !== header.by)) {
      refuse('header_mismatch')
      continue
    }
    const w = writerOf(o.roster, header.by, 'inbox', o.vault)
    if (!w) {
      refuse('unknown_author')
      continue
    }
    let sig: Uint8Array
    try {
      sig = b64Decode(a.sig)
    } catch {
      sig = new Uint8Array(0)
    }
    if (!verifyObject(obj, sig, b64Decode(w.device.sig_pk))) {
      refuse('bad_signature')
      continue
    }
    let p: unknown
    try {
      const opened = await openObject(obj, { identity: o.identity, org: o.org })
      p = JSON.parse(new TextDecoder().decode(opened.plain))
    } catch {
      refuse('cannot_open')
      continue
    }
    if (isObj(p) && withdrawOk(p)) withdrawn.add(`${header.by}\n${p.withdraw}`)
    else if (isObj(p) && candidateOk(p)) found.push({ by: header.by, c: p as unknown as Candidate })
    else refuse('bad_record')
  }
  const candidates = found.filter((f) => !withdrawn.has(`${f.by}\n${f.c.cand}`)).map((f) => f.c)
  return { candidates, refused: reasons.length, reasons }
}

const indent = (text: string): string[] => text.split('\n').map((l) => '  ' + l)

export function workFile(brain: string, n: number, cands: Candidate[]): { path: string; text: string } {
  if (!BRAIN_RX.test(String(brain))) throw new Error('brain name: lower-case letters, digits and hyphens (2-29), starting with a letter')
  if (!Number.isInteger(n) || n < 1) throw new Error('work file number must be a positive integer')
  const list = Array.isArray(cands) ? cands : []
  const lines = [
    `# Company brain work file: ${brain}, round ${n}`,
    '# Local only: never send, publish or paste this file anywhere; it holds your company members\' shared lessons.',
    '# Distil these candidates with the company-brain-method pack (an agent-services suggestion): merge and',
    '# deduplicate, generalise, phrase each as "when X, do Y", keep the evidence grade and drop project specifics.',
    `# candidates: ${list.length}`,
  ]
  list.forEach((c, i) => {
    lines.push('', `### ${String(i + 1).padStart(4, '0')}`, `cand: ${c.cand}`, `kind: ${c.kind}`, `grade: ${c.grade ?? '-'}`,
      `seen: ${c.seen}`, `project: ${c.project}`, 'text: |', ...indent(String(c.text)))
  })
  return { path: `~/.agent-services/sealed/work/${brain}-${n}.md`, text: lines.join('\n') + '\n' }
}

export function reviewFile(draft: DraftItem[], scrub: ScrubOpts): string {
  const items = Array.isArray(draft) ? draft : []
  const lines = [
    '# Company brain review: set `decision: keep` on an item to publish it; the default is `drop`.',
    '# An item with a `blocked:` line cannot be kept. Only a person sets keep; an agent never does.',
    '# Publish reads the fields of each block: grade, decision, blocked, text (text lines indented by two).',
  ]
  const ids = new Set<string>()
  for (const it of items) {
    const id = String(it?.id ?? '')
    if (!ITEM_ID_RX.test(id) || ids.has(id)) throw new Error(`draft item id ${JSON.stringify(id)}: lower-case letters, digits and hyphens, unique`)
    ids.add(id)
    const raw = String(it?.text ?? '').trim()
    const d = scrubDetail(raw, scrub)
    const blocked = d.blocked.length ? d.blocked : d.text !== raw ? d.classes : []
    lines.push('', `### ${id}`, `grade: ${isGrade(it?.grade) ? it.grade : '-'}`, 'decision: drop')
    if (blocked.length || d.text !== raw) lines.push(`blocked: ${(blocked.length ? blocked : ['scrub']).join(', ')}`)
    lines.push('text: |', ...indent(d.blocked.length ? '(withheld: the scrub blocked this text)' : d.text))
  }
  return lines.join('\n') + '\n'
}

export function parseReview(text: string): ReviewItem[] {
  const out: ReviewItem[] = []
  let cur: (ReviewItem & { lines: string[] }) | null = null
  let inText = false
  const close = () => {
    if (!cur) return
    while (cur.lines.length && !cur.lines[cur.lines.length - 1].trim()) cur.lines.pop()
    const { lines, ...rest } = cur
    out.push({ ...rest, text: lines.join('\n').trim() })
  }
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('### ')) {
      close()
      cur = { id: line.slice(4).trim(), grade: null, decision: 'drop', blocked: '', text: '', lines: [] }
      inText = false
      continue
    }
    if (!cur) continue
    if (inText && (line.startsWith('  ') || !line.trim())) {
      cur.lines.push(line.startsWith('  ') ? line.slice(2) : '')
      continue
    }
    inText = false
    const m = /^(grade|decision|blocked|text): ?(.*)$/.exec(line)
    if (!m) continue
    const v = m[2].trim()
    if (m[1] === 'text') inText = true
    else if (m[1] === 'grade') cur.grade = isGrade(v) ? v : null
    else if (m[1] === 'decision') cur.decision = v
    else cur.blocked = v
  }
  close()
  return out
}

export function buildPack(brain: string, review: string, meta: { title: string; when: string }, version: number, scrub?: ScrubOpts): Pack {
  if (!BRAIN_RX.test(String(brain))) throw new Error('brain name: lower-case letters, digits and hyphens (2-29), starting with a letter')
  if (!Number.isInteger(version) || version < 1) throw new Error('version must be a positive integer')
  const title = String(meta?.title ?? '').trim()
  const when = String(meta?.when ?? '').trim()
  if (title.length < 1 || title.length > PACK_LIMITS.title) throw new Error('title: 1-60 characters')
  if (when.length < 1 || when.length > PACK_LIMITS.when) throw new Error('when: 1-160 characters')
  const errors: string[] = []
  const all = parseReview(review)
  for (const it of all) if (it.decision !== 'keep' && it.decision !== 'drop') errors.push(`item ${it.id}: decision must be keep or drop`)
  const kept = all.filter((it) => {
    if (it.decision !== 'keep' || it.blocked) return false
    if (!scrub) return true
    const d = scrubDetail(it.text, scrub)
    return !d.blocked.length && d.text === it.text
  })
  if (!kept.length) errors.push('no item that can be kept is marked keep')
  if (kept.length > PACK_LIMITS.items) errors.push('more than 500 kept items')
  const ids = new Set<string>()
  let bytes = 0
  for (const it of kept) {
    if (!ITEM_ID_RX.test(it.id) || ids.has(it.id)) errors.push(`item ${it.id}: id must be unique lower-case letters, digits and hyphens`)
    ids.add(it.id)
    if (!it.text || Array.from(it.text).length > PACK_LIMITS.text) errors.push(`item ${it.id}: text must be 1-700 characters`)
    bytes += utf8(it.text).length
  }
  if (bytes > PACK_LIMITS.bytes) errors.push('item text over 204800 bytes in total')
  if (errors.length) throw new Error(errors.join('\n'))
  return {
    v: 1, id: `co-${brain}`, tier: 'company', version: `1.0.${version}`, title, when,
    items: kept.map((it) => ({ id: it.id, text: it.text, grade: it.grade })),
  }
}

export async function publishPack(pack: Pack, o: PublishOpts, send: Send, random: Random): Promise<{ object: string; version: number; sha256: string; answer: unknown }> {
  if (pack?.version !== `1.0.${o.version}` || !/^co-[a-z][a-z0-9-]{1,28}$/.test(String(pack?.id))) throw new Error('pack version or id does not match')
  const by = kidOf(b64Encode(ed25519.getPublicKey(o.seed)))
  const h = { org: o.org, vault: o.vault, kind: 'brain' as const, epoch: o.epoch, object: o.object, version: o.version, by }
  const obj = sealVault(h, o.ck, utf8(canonical(pack)), random)
  const sig = signObject(obj, o.seed)
  const digest = hex(sha256(obj))
  const answer = await send('/sealed/put', {
    vault: o.vault, kind: 'brain', object: o.object, epoch: o.epoch, version: o.version, sha256: digest, size: obj.length,
    data_b64: b64Encode(obj), sig: b64Encode(sig),
  })
  return { object: o.object, version: o.version, sha256: digest, answer }
}
