import { b64Encode, hex, keyId, utf8 } from './e2e'
import type { Random } from './e2e'
import { ed25519, sha256 } from './noble.js'
import { canonical, sealDrop, signObject, signRecord, verifyRecord } from './sealed_crypto'

export type Src = 'open' | 'audit' | 'effect' | 'decision' | 'delivery' | 'roster' | 'receipt' | 'switch'
export type Entry = {
  v: 1; seg: string; seq: number; t: number; session: string; agent: string; src: Src; salt: string
  body: Record<string, unknown>; prev: string
}
export type EntryIn = { seg?: string; session: string; agent: string; src: Src; body: Record<string, unknown> }
export type Clock = () => number
export type Checkpoint = {
  v: 1; org: string; acc: string; dev: string; by: string; seg: string; seq_from: number; seq_to: number
  head: string; batch: string; t: number; sig: string
}
export type Receipt = {
  v: 1; org: string; n: number; at: number; of: 'checkpoint' | 'roster'; ref: string; roster_seq: number
  prev: string; kid: string; sig: string
}
export type Post = (route: string, body: Record<string, unknown>) => Promise<unknown>

const SRCS: readonly Src[] = ['open', 'audit', 'effect', 'decision', 'delivery', 'roster', 'receipt', 'switch']
const ENTRY_FIELDS = ['agent', 'body', 'prev', 'salt', 'seg', 'seq', 'session', 'src', 't', 'v']
const CHECKPOINT_FIELDS = ['acc', 'batch', 'by', 'dev', 'head', 'org', 'seg', 'seq_from', 'seq_to', 'sig', 't', 'v']
const RECEIPT_FIELDS = ['at', 'kid', 'n', 'of', 'org', 'prev', 'ref', 'roster_seq', 'sig', 'v']
export const ZERO_HASH = '0'.repeat(64)
export const ENTRY_MAX_BYTES = 8 * 1024
export const CUT_MARK = '...(cut)'
export const CHECKPOINT_EVERY = 50
export const CHECKPOINT_SECONDS = 15 * 60
export const BATCH_PLAIN_MAX = 16 * 1024 - 4
export const BATCH_OBJECT_MAX = 45000
const SEG_RX = /^s-[0-9a-f]{32}$/
const HEX64 = /^[0-9a-f]{64}$/
const HEX16 = /^[0-9a-f]{16}$/
const ID_RX = /^[A-Za-z0-9_-]{1,64}$/

const isCount = (n: unknown, min: number): n is number => typeof n === 'number' && Number.isInteger(n) && n >= min && n <= 2 ** 53 - 1
const sameKeys = (o: object, fields: readonly string[]): boolean => {
  const k = Object.keys(o).sort()
  return k.length === fields.length && k.every((x, i) => x === fields[i])
}
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export const hashHex = (b: Uint8Array): string => hex(sha256(b))
export const recordHash = (rec: unknown): string => hashHex(utf8(canonical(rec)))
export const entryHash = (e: Entry): string => recordHash(e)
export const newSegmentId = (random: Random): string => 's-' + hex(random(16))
export const segmentPath = (seg: string): string => {
  if (!SEG_RX.test(seg)) throw new Error('ledger: bad segment id')
  return `.agent/ledger/${seg}.jsonl`
}

export function entryProblems(e: unknown): string[] {
  if (!isObj(e)) return ['not an object']
  const out: string[] = []
  if (!sameKeys(e, ENTRY_FIELDS)) out.push('fields')
  if (e.v !== 1) out.push('v')
  if (typeof e.seg !== 'string' || !/^s-[0-9a-f]{1,64}$/.test(e.seg)) out.push('seg')
  if (!isCount(e.seq, 1)) out.push('seq')
  if (!isCount(e.t, 0)) out.push('t')
  if (typeof e.session !== 'string' || e.session.length > 64) out.push('session')
  if (typeof e.agent !== 'string' || e.agent.length > 64) out.push('agent')
  if (!SRCS.includes(e.src as Src)) out.push('src')
  if (typeof e.salt !== 'string' || e.salt.length !== 24) out.push('salt')
  if (!isObj(e.body)) out.push('body')
  if (typeof e.prev !== 'string' || !HEX64.test(e.prev)) out.push('prev')
  if (!out.length) {
    try {
      if (utf8(canonical(e)).length > ENTRY_MAX_BYTES) out.push('size')
    } catch {
      out.push('canonical')
    }
  }
  return out
}

export function segmentProblems(entries: Entry[], first = 1, prevHash = ZERO_HASH): string[] {
  const out: string[] = []
  let prev = prevHash
  entries.forEach((e, i) => {
    const bad = entryProblems(e)
    if (bad.length) out.push(`entry ${i + 1}: ${bad.join(', ')}`)
    if (e.seg !== entries[0].seg) out.push(`entry ${i + 1}: another segment`)
    if (e.seq !== first + i) out.push(`entry ${i + 1}: seq ${e.seq}, expected ${first + i}`)
    if (e.prev !== prev) out.push(`entry ${i + 1}: prev does not match the entry before`)
    try {
      prev = entryHash(e)
    } catch {
      prev = ''
    }
  })
  return out
}

function fit(e: Entry): Entry {
  for (let round = 0; round < 64 && utf8(canonical(e)).length > ENTRY_MAX_BYTES; round++) {
    let best: { o: Record<string, unknown> | unknown[]; k: string | number; len: number } | null = null
    const walk = (o: Record<string, unknown> | unknown[]): void => {
      for (const [k, v] of Object.entries(o)) {
        const key = Array.isArray(o) ? Number(k) : k
        if (typeof v === 'string' && (!best || v.length > best.len)) best = { o, k: key, len: v.length }
        else if (v && typeof v === 'object') walk(v as Record<string, unknown>)
      }
    }
    walk(e.body)
    if (!best) break
    const b = best as { o: Record<string, unknown>; k: string; len: number }
    const s = b.o[b.k] as string
    const over = utf8(canonical(e)).length - ENTRY_MAX_BYTES
    const keep = Math.max(0, s.length - over - CUT_MARK.length - 16)
    b.o[b.k] = (keep > 0 ? s.slice(0, keep) : '') + CUT_MARK
    if (keep === 0 && b.len <= CUT_MARK.length) break
  }
  if (utf8(canonical(e)).length > ENTRY_MAX_BYTES) throw new Error('ledger: entry too large')
  return e
}

function scrubBody(src: Src, body: Record<string, unknown>, scrub: (s: string) => string): Record<string, unknown> {
  const b: Record<string, unknown> = JSON.parse(JSON.stringify(body))
  const s = (v: unknown): unknown => (typeof v === 'string' ? scrub(v) : v)
  if (src === 'effect') {
    b.key = s(b.key)
    b.kind = s(b.kind)
    b.state = s(b.state)
    b.request = s(b.request)
  }
  if (src === 'decision') b.line = s(b.line)
  if (src === 'delivery') {
    b.summary = s(b.summary)
    b.tests = s(b.tests)
    if (Array.isArray(b.files)) b.files = b.files.map(s)
  }
  if (src === 'roster') b.change = s(b.change)
  return b
}

export function appendEntry(seg: Entry[], e: EntryIn, random: Random, clock: Clock, scrub: (s: string) => string = (x) => x): Entry {
  const last = seg.length ? seg[seg.length - 1] : null
  const segId = last ? last.seg : e.seg
  if (!segId || !SEG_RX.test(segId)) throw new Error('ledger: bad segment id')
  if (!SRCS.includes(e.src)) throw new Error('ledger: bad src')
  if (!last && e.src !== 'open') throw new Error('ledger: a segment starts with src open')
  const salt = random(16)
  if (!(salt instanceof Uint8Array) || salt.length !== 16) throw new Error('ledger: random')
  const entry: Entry = fit({
    v: 1, seg: segId, seq: last ? last.seq + 1 : 1, t: Math.floor(clock()),
    session: String(e.session).slice(0, 64), agent: String(e.agent).slice(0, 64), src: e.src,
    salt: b64Encode(salt), body: scrubBody(e.src, e.body, scrub), prev: last ? entryHash(last) : ZERO_HASH,
  })
  seg.push(entry)
  return entry
}

export const segmentText = (entries: Entry[]): string => entries.map((e) => canonical(e) + '\n').join('')

export function parseSegment(text: string): Entry[] {
  const out: Entry[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    const e = JSON.parse(line) as Entry
    if (canonical(e) !== line) throw new Error('ledger: line is not canonical')
    out.push(e)
  }
  return out
}

export function batchPlain(entries: Entry[], seqFrom: number, seqTo: number): Uint8Array {
  const pick = entries.filter((e) => e.seq >= seqFrom && e.seq <= seqTo).sort((a, b) => a.seq - b.seq)
  if (pick.length !== seqTo - seqFrom + 1 || pick.some((e, i) => e.seq !== seqFrom + i)) throw new Error('ledger: batch range not in segment')
  return utf8(segmentText(pick))
}

export const parseBatch = (plain: Uint8Array): Entry[] => parseSegment(new TextDecoder().decode(plain))

export type BatchIn = {
  org: string; vault: string; epoch: number; seed: Uint8Array; recipients: string[]
  entries: Entry[]; seqFrom: number; seqTo: number
}
export type SealedBatch = { object: Uint8Array; id: string; sha256: string; sig: Uint8Array }

export async function sealBatch(b: BatchIn, random: Random): Promise<SealedBatch> {
  const id = hex(random(16))
  const by = keyId(ed25519.getPublicKey(b.seed))
  const object = await sealDrop({ org: b.org, vault: b.vault, kind: 'ledger', epoch: b.epoch, object: id, version: 1, by },
    b.recipients, batchPlain(b.entries, b.seqFrom, b.seqTo), random)
  return { object, id, sha256: hashHex(object), sig: signObject(object, b.seed) }
}

export type CheckpointIn = {
  org: string; acc: string; dev: string; seg: string; entries: Entry[]; seqFrom: number; seqTo: number
  batch: Uint8Array | string; t: number; seed: Uint8Array
}

export function makeCheckpoint(c: CheckpointIn): Checkpoint {
  if (!isCount(c.seqFrom, 1) || !isCount(c.seqTo, c.seqFrom)) throw new Error('ledger: bad checkpoint range')
  const last = c.entries.find((e) => e.seq === c.seqTo && e.seg === c.seg)
  if (!last) throw new Error('ledger: checkpoint head not in segment')
  const batch = typeof c.batch === 'string' ? c.batch : hashHex(c.batch)
  if (!HEX64.test(batch)) throw new Error('ledger: bad batch hash')
  const rec = {
    v: 1 as const, org: c.org, acc: c.acc, dev: c.dev, by: keyId(ed25519.getPublicKey(c.seed)), seg: c.seg,
    seq_from: c.seqFrom, seq_to: c.seqTo, head: entryHash(last), batch, t: Math.floor(c.t),
  }
  return { ...rec, sig: signRecord('checkpoint', rec, c.seed) }
}

export function checkpointShape(c: unknown): c is Checkpoint {
  if (!isObj(c) || !sameKeys(c, CHECKPOINT_FIELDS) || c.v !== 1) return false
  return ['org', 'acc', 'dev'].every((k) => typeof c[k] === 'string' && ID_RX.test(c[k] as string)) &&
    typeof c.by === 'string' && HEX16.test(c.by) && typeof c.seg === 'string' && /^s-[0-9a-f]{1,64}$/.test(c.seg) &&
    isCount(c.seq_from, 1) && isCount(c.seq_to, c.seq_from as number) && typeof c.head === 'string' && HEX64.test(c.head) &&
    typeof c.batch === 'string' && HEX64.test(c.batch) && isCount(c.t, 0) && typeof c.sig === 'string'
}

export function verifyCheckpoint(c: Checkpoint, sigPk: Uint8Array): boolean {
  try {
    return checkpointShape(c) && keyId(sigPk) === c.by && verifyRecord('checkpoint', c, sigPk)
  } catch {
    return false
  }
}

export function receiptShape(r: unknown): r is Receipt {
  if (!isObj(r) || !sameKeys(r, RECEIPT_FIELDS) || r.v !== 1) return false
  return typeof r.org === 'string' && ID_RX.test(r.org) && isCount(r.n, 1) && isCount(r.at, 0) &&
    (r.of === 'checkpoint' || r.of === 'roster') && typeof r.ref === 'string' && HEX64.test(r.ref) &&
    isCount(r.roster_seq, 0) && typeof r.prev === 'string' && HEX64.test(r.prev) && typeof r.kid === 'string' &&
    HEX16.test(r.kid) && typeof r.sig === 'string'
}

export function verifyReceipt(r: Receipt, anchors: Record<string, Uint8Array>, prev?: Receipt): boolean {
  try {
    if (!receiptShape(r)) return false
    const pk = Object.prototype.hasOwnProperty.call(anchors, r.kid) ? anchors[r.kid] : null
    if (!(pk instanceof Uint8Array) || pk.length !== 32 || keyId(pk) !== r.kid) return false
    if (!verifyRecord('receipt', r, pk)) return false
    if (r.n === 1 && r.prev !== ZERO_HASH) return false
    if (prev) {
      if (prev.org !== r.org || r.n !== prev.n + 1 || r.prev !== recordHash(prev)) return false
    }
    return true
  } catch {
    return false
  }
}

export const receiptEntry = (seg: Entry[], r: Receipt, who: { session: string; agent: string }, random: Random, clock: Clock): Entry =>
  appendEntry(seg, { session: who.session, agent: who.agent, src: 'receipt', body: { ...r } }, random, clock)

export type CheckpointState = { nextFrom: number; lastAt: number }

export function checkpointDue(seg: Entry[], st: CheckpointState, now: number, turnEnd: boolean, maxBytes: number = BATCH_PLAIN_MAX): { seqFrom: number; seqTo: number; more: boolean } | null {
  const last = seg.length ? seg[seg.length - 1].seq : 0
  const pending = last - st.nextFrom + 1
  if (pending <= 0) return null
  let seqTo = st.nextFrom - 1
  let bytes = 0
  let over = false
  for (const e of seg) {
    if (e.seq < st.nextFrom) continue
    const n = utf8(canonical(e)).length + 1
    if (seqTo >= st.nextFrom && bytes + n > maxBytes) {
      over = true
      break
    }
    bytes += n
    seqTo = e.seq
  }
  if (seqTo < st.nextFrom) return null
  if (turnEnd || over || pending >= CHECKPOINT_EVERY || now - st.lastAt >= CHECKPOINT_SECONDS) return { seqFrom: st.nextFrom, seqTo, more: seqTo < last }
  return null
}

export type SendIn = BatchIn & { acc: string; dev: string; seg: string; t: number; anchors: Record<string, Uint8Array>; lastReceipt?: Receipt }
export type Sent = { checkpoint: Checkpoint; batch: SealedBatch; receipt: Receipt }

export async function sendCheckpoint(s: SendIn, post: Post, random: Random): Promise<Sent> {
  const batch = await sealBatch(s, random)
  const checkpoint = makeCheckpoint({
    org: s.org, acc: s.acc, dev: s.dev, seg: s.seg, entries: s.entries, seqFrom: s.seqFrom, seqTo: s.seqTo,
    batch: batch.sha256, t: s.t, seed: s.seed,
  })
  const ans = await post('/sealed/ledger/checkpoint', {
    checkpoint, batch: { vault: s.vault, object: batch.id, sha256: batch.sha256, size: batch.object.length,
      data_b64: b64Encode(batch.object), sig: b64Encode(batch.sig) },
  })
  const receipt = isObj(ans) ? (ans.receipt as Receipt) : null
  if (!receipt || receipt.of !== 'checkpoint' || receipt.org !== s.org || receipt.ref !== recordHash(checkpoint)) {
    throw new Error('ledger: receipt does not name this checkpoint')
  }
  const prev = s.lastReceipt && s.lastReceipt.n + 1 === receipt.n ? s.lastReceipt : undefined
  if (!verifyReceipt(receipt, s.anchors, prev)) throw new Error('ledger: receipt does not verify')
  return { checkpoint, batch, receipt }
}

export const openBody = (head: { seg: string; seq: number; h: string } | null): Record<string, unknown> =>
  ({ after: head && SEG_RX.test(head.seg) && isCount(head.seq, 1) && HEX64.test(head.h) ? { seg: head.seg, seq: head.seq, h: head.h } : null })

export const headOf = (e: Entry): { seg: string; seq: number; h: string } => ({ seg: e.seg, seq: e.seq, h: entryHash(e) })


export type Tail = { seg: string; path: string; next: number; at: number; end: boolean; org: string }
export const TAIL_KEEP = 16
export const TAIL_STALE_SECONDS = 6 * 3600

const tailList = (list: unknown): Tail[] => (Array.isArray(list) ? list : []).filter((t): t is Tail =>
  isObj(t) && typeof t.seg === 'string' && SEG_RX.test(t.seg) && typeof t.path === 'string' && !!t.path &&
  isCount(t.next, 1) && isCount(t.at, 0) && typeof t.end === 'boolean' && typeof t.org === 'string')

export const noteTail = (list: unknown, t: Tail): Tail[] => [t, ...tailList(list).filter((x) => x.seg !== t.seg)].slice(0, TAIL_KEEP)

export const dropTail = (list: unknown, seg: string): Tail[] => tailList(list).filter((x) => x.seg !== seg)

export const tailsDue = (list: unknown, now: number, org: string, skip: string | null): Tail[] =>
  tailList(list).filter((t) => t.org === org && t.seg !== skip && (t.end || now - t.at >= TAIL_STALE_SECONDS)).reverse()
