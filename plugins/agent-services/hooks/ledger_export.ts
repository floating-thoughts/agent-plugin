import { b64Decode, b64Encode, keyId } from './e2e'
import {
  checkpointShape, entryHash, entryProblems, hashHex, parseBatch, receiptShape, recordHash, segmentProblems,
  verifyCheckpoint, verifyReceipt, ZERO_HASH,
} from './ledger'
import type { Checkpoint, Entry, Post, Receipt } from './ledger'
import { canonical, FORMAT, openObject, splitObject, verifyRecord } from './sealed_crypto'

type Obj = Record<string, any>
export type Bundle = {
  v: 1; format: string; org: string; from: number; to: number; rosters: Obj[]; receipts: Receipt[]
  checkpoints: Checkpoint[]; batches: Record<string, string>; entries: Record<string, Entry[]>
  anchor_keys: Record<string, string>
}
export type DeviceVerdict = { verdict: 'verified' | 'failed'; reasons: string[] }
export type Verdict = {
  ok: boolean; devices: Record<string, DeviceVerdict>; reasons: string[]; notes: string[]
  gaps: string[]
}
export type VerifyOptions = {
  rosterCheck?: (chain: Obj[]) => string | null
  anchors?: Record<string, Uint8Array>
  lastReceipt?: Receipt | null
}

export function pinnedRosterCheck(pin: { org?: unknown; seq?: unknown; h?: unknown; root?: unknown } | null): (chain: Obj[]) => string | null {
  return (chain) => {
    if (!pin || typeof pin.root !== 'string' || !pin.root) return 'no pinned company root on this computer to check against'
    const first = chain[0]
    if (!isObj(first) || first.root !== pin.root) return 'its root is not the company root this computer pinned'
    if (typeof pin.org === 'string' && first.org !== pin.org) return 'another company than the one this computer pinned'
    const at = chain.find((r) => isObj(r) && r.seq === pin.seq)
    if (at && typeof pin.h === 'string') {
      let h = ''
      try {
        h = recordHash(at)
      } catch {}
      if (h !== pin.h) return `roster seq ${pin.seq} differs from the one this computer pinned`
    }
    return null
  }
}

const BUNDLE_FIELDS = ['anchor_keys', 'batches', 'checkpoints', 'entries', 'format', 'from', 'org', 'receipts', 'rosters', 'to', 'v']
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const b64Strict = (s: unknown): Uint8Array | null => {
  try {
    if (typeof s !== 'string') return null
    const b = b64Decode(s)
    return b64Encode(b) === s ? b : null
  } catch {
    return null
  }
}

function batchBytes(key: string, s: unknown): Uint8Array | null {
  const b = b64Strict(s)
  return b && hashHex(b) === key ? b : null
}

export function buildBundle(p: {
  org: string; from: number; to: number; rosters: Obj[]; receipts: Receipt[]; checkpoints: Checkpoint[]
  batches: Record<string, Uint8Array>; entries: Record<string, Entry[]>; anchors: Record<string, Uint8Array>
}): Bundle {
  const batches: Record<string, string> = {}
  for (const [h, bytes] of Object.entries(p.batches)) {
    if (hashHex(bytes) !== h) throw new Error('ledger export: batch bytes do not match their hash')
    batches[h] = b64Encode(bytes)
  }
  const anchor_keys: Record<string, string> = {}
  for (const [kid, pk] of Object.entries(p.anchors)) anchor_keys[kid] = b64Encode(pk)
  const b: Bundle = {
    v: 1, format: FORMAT, org: p.org, from: p.from, to: p.to, rosters: p.rosters, receipts: p.receipts,
    checkpoints: p.checkpoints, batches, entries: p.entries, anchor_keys,
  }
  canonical(b)
  return b
}

export const bundleText = (b: Bundle): string => canonical(b)

export function parseBundle(text: string): Bundle {
  const b = JSON.parse(text) as Bundle
  if (canonical(b) !== text.replace(/\n$/, '')) throw new Error('ledger export: bundle is not canonical')
  return b
}


type Dev = { acc: string; dev: string; role: string; sig_pk: Uint8Array; kid: string }

function devicesOf(r: Obj): Dev[] {
  const out: Dev[] = []
  for (const m of Array.isArray(r?.members) ? r.members : []) {
    for (const d of Array.isArray(m?.devices) ? m.devices : []) {
      const pk = b64Strict(d?.sig_pk)
      if (pk && pk.length === 32) out.push({ acc: m.acc, dev: d.dev, role: m.role, sig_pk: pk, kid: keyId(pk) })
    }
  }
  return out
}

function rosterChainProblems(org: string, chain: Obj[]): string[] {
  const out: string[] = []
  if (!chain.length) return ['no roster in the bundle']
  let prev: Obj | null = null
  for (const r of chain) {
    const at = `roster seq ${r?.seq}`
    if (!isObj(r) || r.v !== 1) {
      out.push(`${at}: not a v1 roster`)
      break
    }
    if (r.org !== org) out.push(`${at}: another company`)
    const wantSeq = prev ? prev.seq + 1 : 1
    if (r.seq !== wantSeq) out.push(`${at}: expected seq ${wantSeq}`)
    let prevHash = ZERO_HASH
    try {
      prevHash = prev ? recordHash(prev) : ZERO_HASH
    } catch {}
    if (r.prev !== prevHash) out.push(`${at}: prev does not match the roster before`)
    if (prev && r.root !== prev.root) out.push(`${at}: root changed`)
    const signer = isObj(r.signer) ? r.signer : {}
    let pk: Uint8Array | null = null
    if (!prev) {
      const root = b64Strict(r.root)
      if (signer.kind === 'root' && root && root.length === 32 && keyId(root) === signer.kid) pk = root
    } else if (signer.kind === 'device') {
      const d = devicesOf(prev).find((x) => x.kid === signer.kid && x.role === 'admin')
      pk = d ? d.sig_pk : null
    } else if (signer.kind === 'recovery') {
      const rk = b64Strict(prev.recovery?.sig_pk)
      if (rk && rk.length === 32 && keyId(rk) === signer.kid) pk = rk
    }
    if (!pk) out.push(`${at}: signer is not allowed`)
    else if (!verifyRecord('roster', r as { sig: string }, pk)) out.push(`${at}: signature does not verify`)
    if (prev) {
      const before = new Map<string, number>((prev.vaults || []).map((v: Obj) => [v.id, v.epoch]))
      for (const v of r.vaults || []) if (before.has(v.id) && v.epoch < (before.get(v.id) as number)) out.push(`${at}: vault epoch decreased`)
    }
    prev = r
  }
  return out
}


export function verifyBundle(b: Bundle, opts: VerifyOptions = {}): Verdict {
  const global: string[] = []
  const notes: string[] = []
  const per: Record<string, string[]> = {}
  const fail = (dev: string | null, why: string): void => {
    if (dev === null) global.push(why)
    else (per[dev] ||= []).push(why)
  }
  const gaps: string[] = []
  if (!isObj(b) || b.v !== 1 || b.format !== FORMAT) {
    return { ok: false, devices: {}, reasons: ['not a v1 ledger bundle'], notes, gaps }
  }
  for (const g of exportGaps(b)) global.push(`batch ${g.batch}: ${g.reason} at export; its entries are missing from this export`)
  for (const g of periodGaps(b)) gaps.push(g)
  const keys = Object.keys(b).sort()
  if (keys.length !== BUNDLE_FIELDS.length || keys.some((k, i) => k !== BUNDLE_FIELDS[i])) global.push('bundle fields')
  const rosters = Array.isArray(b.rosters) ? b.rosters : []
  const receipts = Array.isArray(b.receipts) ? b.receipts : []
  const checkpoints = Array.isArray(b.checkpoints) ? b.checkpoints : []
  const batches = isObj(b.batches) ? b.batches : {}
  const entries = isObj(b.entries) ? b.entries : {}

  const anchors: Record<string, Uint8Array> = {}
  const pinned = opts.anchors ?? null
  if (pinned) for (const [kid, pk] of Object.entries(pinned)) if (pk instanceof Uint8Array && pk.length === 32 && keyId(pk) === kid) anchors[kid] = pk
  for (const [kid, s] of Object.entries(isObj(b.anchor_keys) ? b.anchor_keys : {})) {
    const pk = b64Strict(s)
    if (!pk || pk.length !== 32 || keyId(pk) !== kid) global.push(`anchor key ${kid}: does not match its kid`)
    else if (!pinned) anchors[kid] = pk
    else if (!Object.prototype.hasOwnProperty.call(anchors, kid) || b64Encode(anchors[kid]) !== b64Encode(pk)) {
      global.push(`anchor key ${kid}: not a published server anchor key`)
    }
  }
  if (!pinned) notes.push('anchor keys were taken from the bundle itself, not checked against the published ones')

  const chain = [...rosters].sort((x, y) => (x?.seq ?? 0) - (y?.seq ?? 0))
  for (const why of rosterChainProblems(b.org, chain)) global.push(why)
  if (opts.rosterCheck) {
    const why = opts.rosterCheck(chain)
    if (why) global.push(`roster: ${why}`)
  } else notes.push('the company root was taken from the bundle itself, not checked against a pinned one')
  const rosterBySeq = new Map<number, Obj>(chain.map((r) => [r.seq, r]))

  const rcs = [...receipts].sort((x, y) => (x?.n ?? 0) - (y?.n ?? 0))
  let prevRc: Receipt | undefined
  for (const r of rcs) {
    if (!receiptShape(r)) {
      global.push(`receipt ${(r as Obj)?.n}: not a v1 receipt`)
      prevRc = undefined
      continue
    }
    if (r.org !== b.org) global.push(`receipt ${r.n}: another company`)
    if (prevRc && r.n !== prevRc.n + 1) global.push(`receipts ${prevRc.n + 1}-${r.n - 1}: missing`)
    const linked = prevRc && r.n === prevRc.n + 1 ? prevRc : undefined
    if (!Object.prototype.hasOwnProperty.call(anchors, r.kid)) global.push(`receipt ${r.n}: unknown anchor key ${r.kid}`)
    else if (!verifyReceipt(r, anchors, linked)) global.push(`receipt ${r.n}: signature or chain does not verify`)
    prevRc = r
  }
  const receiptByRef = new Map<string, Receipt>()
  for (const r of rcs) if (receiptShape(r)) receiptByRef.set(r.ref, r)
  const good = rcs.filter((r) => receiptShape(r))
  const maxN = good.reduce((a, r) => Math.max(a, r.n), 0)
  const lastAt = good.reduce((a, r) => Math.max(a, r.at), 0)
  for (const r of good) if (r.at < b.from || r.at > b.to) gaps.push(`receipt ${r.n}: time ${r.at} is outside the period ${b.from}-${b.to}`)
  const seen = opts.lastReceipt
  if (seen && receiptShape(seen) && seen.org === b.org && seen.at >= b.from && seen.at <= b.to && seen.n > maxN) {
    gaps.push(`receipts ${maxN + 1}-${seen.n}: this computer saw receipt ${seen.n} (time ${seen.at}) inside the period, but the bundle stops at ${maxN || 'none'}; the tail was withheld or trimmed`)
  }
  for (const list of Object.values(entries)) {
    for (const e of Array.isArray(list) ? list : []) {
      const rb = e?.src === 'receipt' && isObj(e.body) ? (e.body as Receipt) : null
      if (rb && receiptShape(rb) && rb.org === b.org && rb.at >= b.from && rb.at <= b.to && rb.n > maxN) {
        gaps.push(`receipt ${rb.n}: named by entry ${e.seg} ${e.seq} inside the period, but the bundle stops at receipt ${maxN || 'none'}; the tail was withheld or trimmed`)
      }
    }
  }
  if (good.length) notes.push(`anchored up to server time ${lastAt} (receipt ${maxN}); the period ends at ${b.to}`)
  else notes.push(`no receipt in the period ${b.from}-${b.to}`)
  const rosterAt: { seq: number; at: number }[] = []
  for (const r of chain) {
    try {
      const rc = receiptByRef.get(recordHash(r))
      if (rc && rc.of === 'roster') rosterAt.push({ seq: r.seq, at: rc.at })
    } catch {}
  }

  const segDev = new Map<string, string>()
  const bySeg = new Map<string, Checkpoint[]>()
  const named = new Set<string>()
  for (const c of checkpoints) {
    if (!checkpointShape(c)) {
      global.push('a checkpoint is not a v1 checkpoint')
      continue
    }
    const dev = c.dev
    const where = `checkpoint ${c.seg} ${c.seq_from}-${c.seq_to}`
    per[dev] ||= []
    if (c.org !== b.org) fail(dev, `${where}: another company`)
    if (segDev.has(c.seg) && segDev.get(c.seg) !== dev) fail(dev, `${where}: segment claimed by two devices`)
    segDev.set(c.seg, dev)
    if (!bySeg.has(c.seg)) bySeg.set(c.seg, [])
    bySeg.get(c.seg)!.push(c)
    let ch = ''
    try {
      ch = recordHash(c)
    } catch {}
    named.add(ch)
    const rc = receiptByRef.get(ch)
    if (!rc || rc.of !== 'checkpoint') fail(dev, `${where}: no receipt names it`)
    else {
      const roster = rosterBySeq.get(rc.roster_seq)
      const d = roster ? devicesOf(roster).find((x) => x.kid === c.by) : undefined
      if (!roster) fail(dev, `${where}: roster seq ${rc.roster_seq} is not in the bundle`)
      else if (!d || d.acc !== c.acc || d.dev !== c.dev) fail(dev, `${where}: device not in roster seq ${rc.roster_seq}`)
      else if (!verifyCheckpoint(c, d.sig_pk)) fail(dev, `${where}: signature does not verify`)
      const newer = rosterAt.filter((x) => x.at < rc.at && x.seq > rc.roster_seq)
      if (newer.length) fail(dev, `${where}: accepted under roster seq ${rc.roster_seq}, older than seq ${newer[newer.length - 1].seq}`)
    }
    if (!Object.prototype.hasOwnProperty.call(batches, c.batch)) {
      fail(dev, `${where}: batch ${c.batch} is missing`)
      continue
    }
    const bytes = batchBytes(c.batch, batches[c.batch])
    if (!bytes) {
      fail(dev, `${where}: batch bytes do not match its hash`)
      continue
    }
    try {
      const h = splitObject(bytes).header
      if (h.kind !== 'ledger' || h.org !== b.org || h.by !== c.by || h.version !== 1) fail(dev, `${where}: batch header does not match`)
    } catch {
      fail(dev, `${where}: batch header does not parse`)
      continue
    }
  }
  for (const r of rcs) {
    if (receiptShape(r) && r.of === 'checkpoint' && !named.has(r.ref)) global.push(`receipt ${r.n}: its checkpoint is missing`)
  }
  for (const h of Object.keys(batches)) {
    if (!batchBytes(h, batches[h])) global.push(`batch ${h}: bytes do not match its hash`)
  }

  const segIds = new Set<string>(Object.keys(entries))
  for (const [seg, list] of Object.entries(entries)) {
    const dev = segDev.get(seg) ?? null
    const es = Array.isArray(list) ? list : []
    if (!es.length) continue
    if (es.some((e) => e?.seg !== seg)) fail(dev, `segment ${seg}: an entry names another segment`)
    for (const why of segmentProblems(es)) fail(dev, `segment ${seg}: ${why}`)
    const bySeq = new Map<number, Entry>(es.map((e) => [e.seq, e]))
    const cps = (bySeg.get(seg) || []).sort((x, y) => x.seq_from - y.seq_from)
    if (!cps.length) {
      fail(dev, `segment ${seg}: no checkpoint covers it`)
      continue
    }
    let next = 1
    for (const c of cps) {
      const where = `checkpoint ${seg} ${c.seq_from}-${c.seq_to}`
      if (c.seq_from !== next) fail(dev, `segment ${seg}: entries ${next}-${c.seq_from - 1} not covered by a checkpoint`)
      next = Math.max(next, c.seq_to + 1)
      const head = bySeq.get(c.seq_to)
      let hh = ''
      try {
        hh = head ? entryHash(head) : ''
      } catch {}
      if (!head) fail(dev, `${where}: head entry is missing`)
      else if (hh !== c.head) fail(dev, `${where}: head does not match entry ${c.seq_to}`)
    }
    const lastSeq = es[es.length - 1]?.seq ?? 0
    if (lastSeq >= next) notes.push(`segment ${seg}: entries ${next}-${lastSeq} after the last checkpoint are not anchored yet`)
    for (const e of es) {
      if (e?.src === 'receipt' && !verifyReceipt(e.body as Receipt, anchors)) fail(dev, `segment ${seg}: receipt entry ${e.seq} does not verify`)
      if (e?.src === 'open' && isObj(e.body) && isObj(e.body.after)) {
        const a = e.body.after
        if (!segIds.has(a.seg)) notes.push(`segment ${seg}: open link to ${a.seg} is outside the period`)
        else {
          const target = (entries[a.seg] || []).find((x: Entry) => x.seq === a.seq)
          const anchored = (bySeg.get(a.seg) || []).reduce((m, c) => Math.max(m, c.seq_to), 0)
          let th = ''
          try {
            th = target ? entryHash(target) : ''
          } catch {}
          if (!target && Number.isInteger(a.seq) && a.seq > anchored && anchored > 0) {
            gaps.push(`entries after checkpoint ${anchored} of segment ${a.seg} were never uploaded (the open entry of ${seg} links to entry ${a.seq})`)
          } else if (th !== a.h) fail(dev, `segment ${seg}: open link to ${a.seg} entry ${a.seq} does not match`)
        }
      }
    }
  }
  for (const seg of bySeg.keys()) {
    if (!segIds.has(seg) || !(entries[seg] || []).length) fail(segDev.get(seg) ?? null, `segment ${seg}: entries are missing`)
  }

  if (chain.length) for (const d of devicesOf(chain[chain.length - 1])) per[d.dev] ||= []
  const devices: Record<string, DeviceVerdict> = {}
  for (const [dev, why] of Object.entries(per)) {
    const reasons = [...why, ...global]
    devices[dev] = { verdict: reasons.length ? 'failed' : 'verified', reasons }
  }
  const ok = !global.length && Object.values(devices).every((d) => d.verdict === 'verified')
  return { ok, devices, reasons: global, notes, gaps: [...new Set(gaps)] }
}

export const verdictWord = (v: Verdict): string => (!v.ok ? 'FAILED' : (v.gaps ?? []).length ? 'INCOMPLETE' : 'verified')

export async function compareBatches(b: Bundle, identity: string): Promise<string[]> {
  const out: string[] = []
  for (const c of Array.isArray(b?.checkpoints) ? b.checkpoints : []) {
    const where = `checkpoint ${c?.seg} ${c?.seq_from}-${c?.seq_to}`
    const bytes = batchBytes(c?.batch, b.batches?.[c?.batch])
    if (!bytes) {
      out.push(`${where}: batch is missing`)
      continue
    }
    try {
      const opened = await openObject(bytes, { identity, org: b.org })
      const got = parseBatch(opened.plain)
      const seg = Array.isArray(b.entries?.[c.seg]) ? b.entries[c.seg] : []
      const want = seg.filter((e) => e.seq >= c.seq_from && e.seq <= c.seq_to)
      if (canonical(got) !== canonical(want)) out.push(`${where}: entries differ from the sealed batch`)
    } catch {
      out.push(`${where}: batch does not open with this identity`)
    }
  }
  return out
}


export type ExportGap = { batch: string; reason: string }

const gapsOf = new WeakMap<object, ExportGap[]>()

export function exportGaps(b: unknown): ExportGap[] {
  return b && typeof b === 'object' ? [...(gapsOf.get(b) || [])] : []
}

const periodOf = new WeakMap<object, string[]>()

export function periodGaps(b: unknown): string[] {
  return b && typeof b === 'object' ? [...(periodOf.get(b) || [])] : []
}

export type ExportIn = {
  org: string; from: number; to: number; vault: string; identity: string; anchors: Record<string, Uint8Array>
}

export async function exportLedger(x: ExportIn, post: Post): Promise<Bundle> {
  const receipts: Receipt[] = []
  const checkpoints: Checkpoint[] = []
  const periodRosters: Obj[] = []
  const cut: string[] = []
  let afterN = 0
  for (let page = 0; ; page++) {
    const period = (await post('/sealed/ledger/receipts', { from: x.from, to: x.to, ...(page ? { after_n: afterN } : {}) })) as Obj
    const rc = (Array.isArray(period?.receipts) ? period.receipts : []) as Receipt[]
    receipts.push(...rc)
    checkpoints.push(...((Array.isArray(period?.checkpoints) ? period.checkpoints : []) as Checkpoint[]))
    periodRosters.push(...(Array.isArray(period?.rosters) ? period.rosters : []))
    const top = rc.reduce((a, r) => Math.max(a, Number.isInteger(r?.n) ? r.n : 0), 0)
    if (period?.more !== true) break
    if (top <= afterN || page >= 99) {
      cut.push(`the server's receipt answer was still cut short after receipt ${top || afterN}; receipts after it in the period are not in this export`)
      break
    }
    afterN = top
  }
  const rs = (await post('/sealed/roster', { since_seq: 0 })) as Obj
  const bySeq = new Map<number, Obj>()
  for (const r of [...(rs?.rosters || []), ...periodRosters]) if (isObj(r)) bySeq.set(r.seq, r)
  const rosters = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
  const want = new Set(checkpoints.map((c) => c.batch))
  const batches: Record<string, Uint8Array> = {}
  const entries: Record<string, Entry[]> = {}
  let cursor: string | undefined
  for (let page = 0; page < 10000 && want.size > Object.keys(batches).length; page++) {
    const lst = (await post('/sealed/list', { vault: x.vault, kinds: ['ledger'], ...(cursor ? { cursor } : {}) })) as Obj
    for (const it of lst?.items || []) {
      const got = (await post('/sealed/get', { vault: x.vault, object: it.object })) as Obj
      const bytes = b64Strict(got?.data_b64)
      if (!bytes) continue
      const h = hashHex(bytes)
      if (!want.has(h)) continue
      batches[h] = bytes
    }
    if (!lst?.cursor || lst.cursor === cursor || !(lst.items || []).length) break
    cursor = lst.cursor
  }
  const gaps: ExportGap[] = []
  const gap = (batch: unknown, reason: string): void => {
    const h = String(batch ?? '')
    if (!gaps.some((g) => g.batch === h)) gaps.push({ batch: h, reason })
  }
  for (const c of checkpoints) {
    const bytes = batches[c.batch]
    if (!bytes) {
      gap(c?.batch, 'not found in the ledger vault on the server')
      continue
    }
    try {
      const opened = await openObject(bytes, { identity: x.identity, org: x.org })
      for (const e of parseBatch(opened.plain)) (entries[e.seg] ||= []).push(e)
    } catch (err) {
      gap(c.batch, `does not open with this identity (${String((err as Error)?.message ?? err).slice(0, 120)})`)
    }
  }
  for (const seg of Object.keys(entries)) {
    const seen = new Map<number, Entry>()
    for (const e of entries[seg]) seen.set(e.seq, e)
    entries[seg] = [...seen.values()].sort((a, b) => a.seq - b.seq)
  }
  const b = buildBundle({ org: x.org, from: x.from, to: x.to, rosters, receipts, checkpoints, batches, entries, anchors: x.anchors })
  if (gaps.length) gapsOf.set(b, gaps)
  if (cut.length) periodOf.set(b, cut)
  return b
}


export function bundleReport(b: Bundle, v: Verdict): string {
  const all: Entry[] = Object.values(b.entries || {}).flat()
  const agents = new Set<string>()
  const refusals = new Map<string, number>()
  const effects: string[] = []
  const decisions: string[] = []
  const deliveries: string[] = []
  const roster: string[] = []
  for (const e of all) {
    if (entryProblems(e).length) continue
    agents.add(e.agent)
    const body = e.body as Obj
    if (e.src === 'audit' && typeof body.rule === 'string' && /deny|refus|block/i.test(String(body.decision ?? body.result ?? ''))) {
      refusals.set(body.rule, (refusals.get(body.rule) || 0) + 1)
    }
    if (e.src === 'effect') effects.push(`${body.kind ?? ''} ${body.key ?? ''}: ${body.state ?? ''}`)
    if (e.src === 'decision') decisions.push(String(body.line ?? ''))
    if (e.src === 'delivery') deliveries.push(String(body.summary ?? ''))
    if (e.src === 'roster') roster.push(`seq ${body.seq}: ${body.change ?? ''}`)
  }
  const item = (s: string): string => `  - ${s.length > 300 ? s.slice(0, 300) + '...' : s}`
  const at = new Map<string, number>()
  for (const r of b.receipts || []) at.set(r.ref, r.at)
  const lines: string[] = [
    `Ledger export for ${b.org}, period ${b.from} to ${b.to} (format ${b.format})`,
    `Overall: ${verdictWord(v)}${v.ok && (v.gaps ?? []).length ? ': nothing present was changed, but part of the period is missing (see Gaps)' : ''}`,
    ...(() => {
      const gaps = exportGaps(b)
      return gaps.length
        ? ['', `Entries are missing: ${gaps.length} batch(es) named by checkpoints could not be read at export:`, ...gaps.map((g) => `  - ${g.batch}: ${g.reason}`)]
        : []
    })(),
    '',
    `Agents: ${[...agents].sort().join(', ') || 'none'}`,
    `Refusals by rule: ${[...refusals].map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`,
    `Side effects (${effects.length}):`, ...effects.map(item),
    `Decisions (${decisions.length}):`, ...decisions.map(item),
    `Deliveries (${deliveries.length}):`, ...deliveries.map(item),
    `Roster changes (${roster.length}):`, ...roster.map(item),
    '',
    'Verification per device:',
  ]
  for (const [dev, d] of Object.entries(v.devices).sort()) {
    const cps = (b.checkpoints || []).filter((c) => c.dev === dev)
    const last = cps.map((c) => {
      try {
        return at.get(recordHash(c)) ?? 0
      } catch {
        return 0
      }
    }).reduce((a, x) => Math.max(a, x), 0)
    lines.push(d.verdict === 'verified'
      ? `  ${dev}: verified: recorded and signed by device ${dev}, anchored by the server at time ${last}`
      : `  ${dev}: failed`)
    for (const r of d.reasons) lines.push(`    - ${r}`)
  }
  if (v.reasons.length) lines.push('Problems not tied to one device:', ...v.reasons.map((r) => `  - ${r}`))
  if ((v.gaps ?? []).length) lines.push('Gaps (parts of the period this bundle does not cover):', ...v.gaps.map((r) => `  - ${r}`))
  if (v.notes.length) lines.push('Notes:', ...v.notes.map((r) => `  - ${r}`))
  lines.push('', 'This shows tamper evidence: what was recorded was not changed afterwards. It does not prove the records were true when made.')
  return lines.join('\n') + '\n'
}
