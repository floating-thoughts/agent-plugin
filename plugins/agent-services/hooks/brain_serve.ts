import { b64Decode } from './e2e'
import { keywrapObjectId, openKeyWrap, openObject, splitObject, verifyObject } from './sealed_crypto'
import type { Header } from './sealed_crypto'
import { readersOf, writerOf } from './sealed_roster'
import type { Roster } from './sealed_roster'
import { recipientOf } from './sealed_keys'

type Obj = Record<string, unknown>
export type Send = (route: string, body: Obj) => Promise<unknown>
export type CompanyItem = { id: string; text: string; grade: 'E2' | 'E3' | null }
export type CompanyEntry = {
  key: string; title: string; when: string; source: 'company'; version: string; items: CompanyItem[]
}
export type ServeIn = { org: string; vault: string; roster: Roster; identity: string; pinnedVersion?: number }
export type Served = { ok: true; entry: CompanyEntry; version: number } | { ok: false; reason: string }

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const isCo = (k: unknown): boolean => typeof k === 'string' && k.startsWith('co-')
const isInt = (v: unknown, min: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min

class Refused extends Error {}
const refuse = (reason: string): never => {
  throw new Refused(reason)
}

async function newestBrain(vault: string, send: Send): Promise<Obj> {
  let best: Obj | null = null
  let cursor: unknown = undefined
  for (let page = 0; page < 50; page++) {
    const body: Obj = { vault, kinds: ['brain'] }
    if (typeof cursor === 'string') body.cursor = cursor
    const ans = await send('/sealed/list', body)
    if (!isObj(ans) || !Array.isArray(ans.items)) refuse('list')
    for (const it of (ans as Obj).items as unknown[]) {
      if (!isObj(it) || it.kind !== 'brain') continue
      if (!isInt(it.version, 1) || typeof it.object !== 'string') refuse('list')
      if (!best || (it.version as number) > (best.version as number)) best = it
    }
    cursor = (ans as Obj).cursor
    if (typeof cursor !== 'string' || !cursor) break
  }
  if (!best) refuse('no_brain')
  return best as Obj
}

async function getObject(vault: string, object: string, version: number | undefined, send: Send) {
  const body: Obj = { vault, object }
  if (version !== undefined) body.version = version
  const ans = await send('/sealed/get', body)
  if (!isObj(ans) || typeof ans.data_b64 !== 'string' || typeof ans.sig !== 'string' || typeof ans.by !== 'string') refuse('get')
  const a = ans as Obj
  return { obj: b64Decode(a.data_b64 as string), sig: b64Decode(a.sig as string), by: a.by as string, rosterSeq: a.roster_seq }
}

function checkAuthor(r: Roster, h: Header, by: string, obj: Uint8Array, sig: Uint8Array, rosterSeq: unknown): void {
  if (by !== h.by) refuse('author')
  if (!isInt(rosterSeq, 1) || rosterSeq > r.seq) refuse('roster_seq')
  const w = writerOf(r, h.by, h.kind, h.vault)
  if (!w || w.member.role !== 'admin') refuse('signer')
  if (!verifyObject(obj, sig, b64Decode((w as { device: { sig_pk: string } }).device.sig_pk))) refuse('signature')
}

function checkPack(plain: Uint8Array, h: Header): CompanyEntry {
  let p: unknown
  try {
    p = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain))
  } catch {
    refuse('pack')
  }
  if (!isObj(p)) refuse('pack')
  const pk = p as Obj
  if (Object.keys(pk).sort().join(',') !== 'id,items,tier,title,v,version,when') refuse('pack')
  if (pk.v !== 1 || pk.tier !== 'company') refuse('pack')
  if (typeof pk.id !== 'string' || !/^co-[a-z][a-z0-9-]{1,28}$/.test(pk.id)) refuse('pack_id')
  if (pk.version !== `1.0.${h.version}`) refuse('pack_version')
  if (typeof pk.title !== 'string' || pk.title.length < 1 || pk.title.length > 60) refuse('pack')
  if (typeof pk.when !== 'string' || pk.when.length < 1 || pk.when.length > 160) refuse('pack')
  const items = pk.items
  if (!Array.isArray(items) || items.length < 1 || items.length > 500) refuse('pack_items')
  const seen = new Set<string>()
  let bytes = 0
  const out: CompanyItem[] = []
  for (const it of items as unknown[]) {
    if (!isObj(it) || Object.keys(it).sort().join(',') !== 'grade,id,text') refuse('pack_items')
    const i = it as Obj
    if (typeof i.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(i.id) || seen.has(i.id)) refuse('pack_items')
    if (typeof i.text !== 'string' || i.text.length < 1 || i.text.length > 700) refuse('pack_items')
    if (i.grade !== 'E2' && i.grade !== 'E3' && i.grade !== null) refuse('pack_items')
    seen.add(i.id as string)
    bytes += new TextEncoder().encode(i.text as string).length
    out.push({ id: i.id as string, text: i.text as string, grade: i.grade as CompanyItem['grade'] })
  }
  if (bytes > 204800) refuse('pack_items')
  return { key: pk.id as string, title: pk.title as string, when: pk.when as string, source: 'company', version: pk.version as string, items: out }
}

export type EntryIn = {
  ck: Uint8Array; roster: Roster; rosterSeq: unknown; pinnedVersion?: number; by?: string; sig?: Uint8Array
}

async function openBrain(obj: Uint8Array, o: EntryIn): Promise<CompanyEntry> {
  const r = o.roster
  if (!isObj(r) || !Array.isArray(r.vaults)) refuse('roster')
  if (!(o.ck instanceof Uint8Array)) refuse('content_key')
  let h: Header
  try {
    h = splitObject(obj).header
  } catch {
    return refuse('header')
  }
  if (h.org !== r.org) refuse('org')
  if (h.kind !== 'brain') refuse('header')
  const v = r.vaults.find((x) => x.id === h.vault)
  if (!v || v.kind !== 'brain') refuse('vault')
  const pin = o.pinnedVersion ?? 0
  if (!isInt(pin, 0)) refuse('pin')
  if (h.version < pin) refuse('rollback')
  if (h.epoch !== (v as { epoch: number }).epoch) refuse('epoch')
  if (o.by !== undefined && o.by !== h.by) refuse('author')
  if (!isInt(o.rosterSeq, 1) || (o.rosterSeq as number) > r.seq) refuse('roster_seq')
  const w = writerOf(r, h.by, 'brain', h.vault)
  if (!w || w.member.role !== 'admin') refuse('signer')
  if (o.sig !== undefined && !verifyObject(obj, o.sig, b64Decode((w as { device: { sig_pk: string } }).device.sig_pk))) refuse('signature')
  let plain: Uint8Array
  try {
    plain = (await openObject(obj, { ck: o.ck, org: r.org })).plain
  } catch {
    return refuse('open')
  }
  return checkPack(plain, h)
}

export async function companyEntry(obj: Uint8Array, o: EntryIn): Promise<CompanyEntry> {
  return openBrain(obj, o)
}

export function servedPacks<T>(packs: T[]): T[] {
  if (!Array.isArray(packs)) return []
  return packs.filter((p) => !(isObj(p) && isCo(p.key)))
}

export async function serveBrain(a: ServeIn, send: Send): Promise<Served> {
  try {
    if (!isObj(a) || typeof a.org !== 'string' || typeof a.vault !== 'string' || typeof a.identity !== 'string') refuse('input')
    const r = a.roster
    if (!isObj(r) || r.org !== a.org || !Array.isArray(r.vaults) || !Array.isArray(r.members)) refuse('roster')
    const v = r.vaults.find((x) => x.id === a.vault)
    if (!v || v.kind !== 'brain') refuse('vault')
    const pin = a.pinnedVersion ?? 0
    if (!isInt(pin, 0)) refuse('pin')
    let me: string
    try {
      me = recipientOf(a.identity)
    } catch {
      return refuse('identity')
    }
    if (!readersOf(r, a.vault, 'brain').includes(me) || me === r.recovery.enc) refuse('not_reader')

    const item = await newestBrain(a.vault, send)
    const got = await getObject(a.vault, item.object as string, item.version as number, send)
    let h: Header
    try {
      h = splitObject(got.obj).header
    } catch {
      return refuse('header')
    }
    if (h.org !== a.org) refuse('org')
    if (h.vault !== a.vault || h.kind !== 'brain' || h.object !== item.object || h.version !== item.version) refuse('header')
    if (h.version < pin) refuse('rollback')
    if (h.epoch !== (v as { epoch: number }).epoch) refuse('epoch')
    checkAuthor(r, h, got.by, got.obj, got.sig, got.rosterSeq)

    const kw = await getObject(a.vault, keywrapObjectId(a.vault, h.epoch), undefined, send)
    let kh: Header
    try {
      kh = splitObject(kw.obj).header
    } catch {
      return refuse('keywrap')
    }
    if (kh.org !== a.org || kh.vault !== a.vault || kh.kind !== 'keywrap' || kh.epoch !== h.epoch) refuse('keywrap')
    checkAuthor(r, kh, kw.by, kw.obj, kw.sig, kw.rosterSeq)
    let ck: Uint8Array
    try {
      ck = await openKeyWrap(kw.obj, a.identity)
    } catch {
      return refuse('keywrap_open')
    }
    const entry = await openBrain(got.obj, { ck, roster: r, rosterSeq: got.rosterSeq, pinnedVersion: pin, by: got.by, sig: got.sig })
    return { ok: true, entry, version: h.version }
  } catch (e) {
    return { ok: false, reason: e instanceof Refused ? e.message : 'failed' }
  }
}

export type TermsIn = { org: string; vault: string; roster: Roster; identity: string }

export async function brainTerms(a: TermsIn, send: Send): Promise<string[]> {
  const r = a.roster
  if (!isObj(r) || r.org !== a.org || !Array.isArray(r.vaults) || !Array.isArray(r.members)) refuse('roster')
  const v = r.vaults.find((x) => x.id === a.vault)
  if (!v || v.kind !== 'brain') refuse('vault')
  let best: Obj | null = null
  let cursor: unknown = undefined
  for (let page = 0; page < 50; page++) {
    const body: Obj = { vault: a.vault, kinds: ['config'] }
    if (typeof cursor === 'string') body.cursor = cursor
    const ans = await send('/sealed/list', body)
    if (!isObj(ans) || !Array.isArray(ans.items)) refuse('list')
    for (const it of (ans as Obj).items as unknown[]) {
      if (!isObj(it) || it.kind !== 'config') continue
      if (!isInt(it.version, 1) || typeof it.object !== 'string') refuse('list')
      if (!best || (it.accepted_at ?? 0) > (best.accepted_at ?? 0) || ((it.accepted_at ?? 0) === (best.accepted_at ?? 0) && (it.version as number) > (best.version as number))) best = it
    }
    cursor = (ans as Obj).cursor
    if (typeof cursor !== 'string' || !cursor) break
  }
  if (!best) return []
  const got = await getObject(a.vault, best.object as string, best.version as number, send)
  let h: Header
  try {
    h = splitObject(got.obj).header
  } catch {
    return refuse('header')
  }
  if (h.org !== a.org || h.vault !== a.vault || h.kind !== 'config' || h.object !== best.object || h.version !== best.version) refuse('header')
  if (h.epoch !== (v as { epoch: number }).epoch) refuse('epoch')
  checkAuthor(r, h, got.by, got.obj, got.sig, got.rosterSeq)
  const kw = await getObject(a.vault, keywrapObjectId(a.vault, h.epoch), undefined, send)
  let kh: Header
  try {
    kh = splitObject(kw.obj).header
  } catch {
    return refuse('keywrap')
  }
  if (kh.org !== a.org || kh.vault !== a.vault || kh.kind !== 'keywrap' || kh.epoch !== h.epoch) refuse('keywrap')
  checkAuthor(r, kh, kw.by, kw.obj, kw.sig, kw.rosterSeq)
  let plain: Uint8Array
  try {
    const ck = await openKeyWrap(kw.obj, a.identity)
    plain = (await openObject(got.obj, { ck, org: r.org })).plain
  } catch {
    return refuse('open')
  }
  let c: unknown
  try {
    c = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain))
  } catch {
    return refuse('config')
  }
  if (!isObj(c) || Object.keys(c).sort().join(',') !== 'language,terms,v' || c.v !== 1 || typeof c.language !== 'string') refuse('config')
  const terms = (c as Obj).terms
  if (!Array.isArray(terms) || terms.length > 500 || terms.some((t) => typeof t !== 'string' || t.length < 1 || t.length > 80)) refuse('config')
  return [...(terms as string[])]
}

export function mergeIndex(answer: unknown, entries: CompanyEntry[] | null | undefined): unknown {
  if (!isObj(answer) || answer.kind !== 'index') return answer
  const own = (Array.isArray(entries) ? entries : []).filter((e) => isObj(e) && isCo(e.key) && typeof e.when === 'string')
  const cur = answer.entries
  if (isObj(cur)) {
    const servedCo = Object.keys(cur).some(isCo)
    if (!servedCo && !own.length) return answer
    const out: Obj = {}
    for (const [k, w] of Object.entries(cur)) if (!isCo(k)) out[k] = w
    for (const e of own) out[e.key] = e.when
    return { ...answer, entries: out }
  }
  if (Array.isArray(cur)) {
    const servedCo = cur.some((x) => isObj(x) && isCo(x.key))
    if (!servedCo && !own.length) return answer
    const out = cur.filter((x) => !(isObj(x) && isCo(x.key)))
    for (const e of own) out.push({ key: e.key, when: e.when })
    return { ...answer, entries: out }
  }
  return answer
}

export function companyAnswer(entries: CompanyEntry[] | null | undefined, key: string): Obj | null {
  if (!isCo(key) || !Array.isArray(entries)) return null
  const e = entries.find((x) => isObj(x) && x.key === key)
  if (!e) return null
  const out: Obj = {
    kind: 'pack', key: e.key, title: e.title, version: e.version, topic: null, source: 'company',
    items: e.items.map((i) => ({ id: i.id, text: i.text, grade: i.grade })), branched: 0, fallback: null,
  }
  const label = kitLabel(e.key)
  if (label) out.label = label
  return out
}

export function kitLabel(key: unknown): string | null {
  return typeof key === 'string' && key.startsWith('co-kit-')
    ? 'Your company kit: know-how agent-services made for your company, sealed to it and accepted by your company admin.'
    : null
}

export function outboxRecord(entry: CompanyEntry): { key: string; version: string } {
  return { key: entry.key, version: entry.version }
}
