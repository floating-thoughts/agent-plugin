import { sha256 } from './noble.js'
import { b64Decode, b64Encode, hex } from './e2e'
import { BUCKETS, canonical, splitObject, verifyObject } from './sealed_crypto'
import type { Header, Kind } from './sealed_crypto'
import { acceptRoster, deviceByKid, kidOf, parseRoster, recordHash, verifyRosterChain, writerOf } from './sealed_roster'
import type { Roster } from './sealed_roster'
import { enrollSafetyCode } from './sealed_keys'

type Obj = Record<string, unknown>
export type Send = (route: string, body: Obj) => Promise<unknown>

export type FolderFs = {
  read(path: string): Promise<string>
  list(path: string): Promise<{ name: string }[]>
  write(path: string, text: string): Promise<void>
  create?(path: string, text: string): Promise<boolean>
  remove?(path: string): Promise<void>
}
export type FolderOpts = { fs: FolderFs; root: string; org: string; clock?: () => number   }

export class SealedFolderError extends Error {
  status: number
  code: string
  constructor(status: number, code: string) {
    super(`sealed folder: ${status} ${code}`)
    this.status = status
    this.code = code
  }
}

const refuse = (status: number, code: string): never => {
  throw new SealedFolderError(status, code)
}
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const isInt = (v: unknown, min: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= 2 ** 53 - 1
const isHex = (v: unknown, n: number): v is string => typeof v === 'string' && v.length === n && /^[0-9a-f]+$/.test(v)
const isDev = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v)
const line = (v: unknown): string => canonical(v) + '\n'
const seqName = (seq: number): string => String(seq).padStart(10, '0') + '.json'
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export function folderSend(o: FolderOpts): Send {
  if (!isObj(o) || !o.fs || typeof o.root !== 'string' || !o.root || !isDev(o.org)) throw new Error('sealed folder: options')
  const root = o.root.replace(/\\/g, '/').replace(/\/+$/, '')
  const fs = o.fs
  const now = (): number => Math.floor(o.clock ? o.clock() : Date.now() / 1000)
  const p = (...parts: string[]): string => [root, ...parts].join('/')

  const names = async (dir: string): Promise<string[]> => {
    try {
      const l = await fs.list(dir)
      return Array.isArray(l) ? l.map((e) => String(e?.name)) : []
    } catch {
      return []
    }
  }
  const create = async (path: string, text: string, dir: string, name: string): Promise<boolean> => {
    if (fs.create) return fs.create(path, text)
    if ((await names(dir)).includes(name)) return false
    await fs.write(path, text)
    return true
  }
  const readJson = async (path: string): Promise<unknown> => {
    try {
      return JSON.parse((await fs.read(path)).replace(/\s+$/, ''))
    } catch {
      return null
    }
  }
  let marked = false
  const markText = async (): Promise<void> => {
    if (marked) return
    if (!(await names(root)).includes('.gitattributes')) await create(p('.gitattributes'), '* -text\n', root, '.gitattributes')
    marked = true
  }

  const rosterSeqs = async (): Promise<number[]> =>
    (await names(p('rosters'))).filter((n) => /^\d{10}\.json$/.test(n)).map((n) => Number(n.slice(0, 10))).filter((n) => n >= 1).sort((a, b) => a - b)
  const rosterAt = async (seq: number): Promise<Roster | null> => {
    const r = parseRoster(await readJson(p('rosters', seqName(seq))))
    return r && r.seq === seq && r.org === o.org ? r : null
  }
  const newest = async (): Promise<Roster | null> => {
    const seqs = await rosterSeqs()
    return seqs.length ? rosterAt(seqs[seqs.length - 1]) : null
  }

  async function roster(b: Obj): Promise<Obj> {
    if (!('since_seq' in b)) {
      const r = await newest()
      return { rosters: r ? [r] : [] }
    }
    if (!isInt(b.since_seq, 0)) refuse(422, 'bad_request')
    const out: Roster[] = []
    for (const s of (await rosterSeqs()).filter((x) => x > (b.since_seq as number)).slice(0, 1000)) {
      const r = await rosterAt(s)
      if (r) out.push(r)
    }
    return { rosters: out }
  }

  async function rosterPut(b: Obj): Promise<Obj> {
    if (!isObj(b.roster)) refuse(422, 'bad_request')
    const r = parseRoster(b.roster)
    if (!r || r.org !== o.org) return refuse(400, 'bad_record')
    const prev = await newest()
    if (r.seq !== (prev ? prev.seq : 0) + 1) refuse(409, 'seq_conflict')
    if (!prev) {
      if (!verifyRosterChain([r]).ok) refuse(400, 'bad_signature')
    } else {
      if (r.prev !== recordHash(prev)) refuse(409, 'seq_conflict')
      if (r.root !== prev.root) refuse(400, 'bad_signature')
      const ok = acceptRoster({ org: prev.org, seq: prev.seq, h: recordHash(prev), root: prev.root }, [prev, r])
      if (!ok.ok) refuse(400, ok.reason === 'epoch' ? 'bad_record' : 'bad_signature')
    }
    await markText()
    if (!(await create(p('rosters', seqName(r.seq)), line(r), p('rosters'), seqName(r.seq)))) refuse(409, 'seq_conflict')
    if (fs.remove) {
      for (const m of r.members) for (const d of m.devices) await fs.remove(p('pending', `${d.dev}.json`)).catch(() => undefined)
    }
    return { receipt: null, roster_seq: r.seq }
  }

  async function enroll(b: Obj): Promise<Obj> {
    const e = b.enroll
    if (!isObj(e) || !isDev(e.dev)) return refuse(422, 'bad_request')
    if (e.org !== o.org) refuse(403, 'not_yours')
    if (enrollSafetyCode(e) === null) refuse(400, 'bad_signature')
    const r = await newest()
    const kid = kidOf(e.sig_pk as string)
    if (r && r.members.some((m) => m.devices.some((d) => d.dev === e.dev || kidOf(d.sig_pk) === kid))) refuse(409, 'already_enrolled')
    const have = (await names(p('pending'))).filter((n) => /^[A-Za-z0-9_-]{1,64}\.json$/.test(n))
    const mine = `${e.dev}.json`
    if (have.includes(mine)) {
      const old = await readJson(p('pending', mine))
      if (isObj(old) && old.acc !== e.acc) refuse(409, 'already_enrolled')
    } else if (have.length >= 500) {
      refuse(429, 'day_limit')
    }
    await markText()
    await fs.write(p('pending', mine), line(e))
    return { root: r ? r.root : null, roster_seq: r ? r.seq : 0 }
  }

  async function pending(): Promise<Obj> {
    const r = await newest()
    const listed = new Set(r ? r.members.flatMap((m) => m.devices.map((d) => d.dev)) : [])
    const out: Obj[] = []
    for (const n of (await names(p('pending'))).filter((x) => /^[A-Za-z0-9_-]{1,64}\.json$/.test(x)).sort(byName)) {
      const e = await readJson(p('pending', n))
      if (!isObj(e) || e.org !== o.org || `${e.dev}.json` !== n || listed.has(e.dev as string) || enrollSafetyCode(e) === null) continue
      out.push(e)
    }
    out.sort((a, b) => (a.t as number) - (b.t as number) || byName(a.dev as string, b.dev as string))
    return { pending: out.slice(0, 500) }
  }

  async function vaultOf(vault: unknown): Promise<{ r: Roster; epoch: number; vkind: 'brain' | 'ledger' }> {
    if (!isHex(vault, 32)) refuse(422, 'bad_request')
    const r = await newest()
    const v = r?.vaults.find((x) => x.id === vault)
    if (!r || !v) return refuse(404, 'not_found')
    return { r, epoch: v.epoch, vkind: v.kind }
  }

  type Meta = { object: string; version: number; kind: Kind; epoch: number; size: number; sha256: string; by: string; roster_seq: number; accepted_at: number }

  async function metas(vault: string): Promise<Meta[]> {
    const out: Meta[] = []
    for (const n of await names(p('objects', vault))) {
      const m = /^([0-9a-f]{32})\.([1-9][0-9]{0,15})\.json$/.exec(n)
      if (!m) continue
      const j = await readJson(p('objects', vault, n))
      if (!isObj(j) || j.v !== 1 || typeof j.kind !== 'string' || !isInt(j.epoch, 1) || !isInt(j.size, 1) || !isHex(j.sha256, 64)
        || !isHex(j.by, 16) || !isInt(j.roster_seq, 1) || !isInt(j.accepted_at, 0)) continue
      out.push({ object: m[1], version: Number(m[2]), kind: j.kind as Kind, epoch: j.epoch, size: j.size, sha256: j.sha256, by: j.by,
        roster_seq: j.roster_seq, accepted_at: j.accepted_at })
    }
    const key = (x: Meta): string => `${String(x.accepted_at).padStart(16, '0')}-${x.object}-${String(x.version).padStart(16, '0')}`
    return out.sort((a, b) => byName(key(a), key(b)))
  }
  const cursorOf = (x: Meta): string => `${x.accepted_at}-${x.object}-${x.version}`

  async function list(b: Obj): Promise<Obj> {
    await vaultOf(b.vault)
    if (b.kinds !== undefined && (!Array.isArray(b.kinds) || !b.kinds.every((k) => typeof k === 'string'))) refuse(422, 'bad_request')
    const cur = b.cursor ?? ''
    if (typeof cur !== 'string') return refuse(422, 'bad_request')
    let after: [number, string, number] | null = null
    if (cur) {
      const m = /^(\d{1,16})-([0-9a-f]{32})-([1-9][0-9]{0,15})$/.exec(cur)
      if (!m) return refuse(400, 'bad_record')
      after = [Number(m[1]), m[2], Number(m[3])]
    }
    const kinds = Array.isArray(b.kinds) && b.kinds.length ? new Set(b.kinds as string[]) : null
    const items: Obj[] = []
    let last: Meta | null = null
    for (const x of await metas(b.vault as string)) {
      if (after) {
        const [t, ob, ver] = after
        if (x.accepted_at < t || (x.accepted_at === t && (x.object < ob || (x.object === ob && x.version <= ver)))) continue
      }
      last = x
      if (kinds && !kinds.has(x.kind)) continue
      items.push({ object: x.object, kind: x.kind, epoch: x.epoch, version: x.version, size: x.size, by: x.by,
        roster_seq: x.roster_seq, accepted_at: x.accepted_at })
      if (items.length >= 1000) break
    }
    return { items, cursor: last ? cursorOf(last) : null }
  }

  async function get(b: Obj): Promise<Obj> {
    await vaultOf(b.vault)
    if (!isHex(b.object, 32) || (b.version !== undefined && !isInt(b.version, 1))) refuse(422, 'bad_request')
    const vault = b.vault as string
    const mine = (await metas(vault)).filter((x) => x.object === b.object && (b.version === undefined || x.version === b.version))
    const x = mine.sort((a, c) => c.version - a.version)[0]
    if (!x) return refuse(404, 'not_found')
    const base = p('objects', vault, `${x.object}.${x.version}`)
    let data: Uint8Array
    let sig: unknown
    try {
      data = b64Decode((await fs.read(`${base}.obj`)).replace(/\s+$/, ''))
      sig = await readJson(`${base}.sig`)
    } catch {
      return refuse(404, 'not_found')
    }
    if (data.length !== x.size || hex(sha256(data)) !== x.sha256 || !isObj(sig) || sig.v !== 1 || sig.by !== x.by || typeof sig.sig !== 'string') {
      return refuse(404, 'not_found')
    }
    return { data_b64: b64Encode(data), sig: sig.sig, by: x.by, roster_seq: x.roster_seq, accepted_at: x.accepted_at }
  }

  async function put(b: Obj): Promise<Obj> {
    if (!isHex(b.vault, 32) || !isHex(b.object, 32) || !isInt(b.size, 1) || !isHex(b.sha256, 64) || typeof b.data_b64 !== 'string'
      || typeof b.sig !== 'string' || (b.kind !== undefined && typeof b.kind !== 'string')
      || (b.epoch !== undefined && !isInt(b.epoch, 1)) || (b.version !== undefined && !isInt(b.version, 1))) refuse(422, 'bad_request')
    const { r, epoch, vkind } = await vaultOf(b.vault)
    let data: Uint8Array
    let sig: Uint8Array
    try {
      data = b64Decode(b.data_b64 as string)
      sig = b64Decode(b.sig as string)
    } catch {
      return refuse(400, 'bad_record')
    }
    if (sig.length !== 64) refuse(400, 'bad_record')
    if (data.length !== b.size) refuse(400, 'bad_size')
    if (hex(sha256(data)) !== b.sha256) refuse(400, 'header_mismatch')
    let h: Header
    let body: Uint8Array
    try {
      const s = splitObject(data)
      h = s.header
      body = s.body
    } catch {
      return refuse(400, 'header_mismatch')
    }
    const want: Obj = { org: o.org, vault: b.vault, object: b.object }
    for (const k of ['kind', 'epoch', 'version']) if (b[k] !== undefined) want[k] = b[k]
    if (Object.entries(want).some(([k, v]) => (h as unknown as Obj)[k] !== v)) refuse(400, 'header_mismatch')
    if (vkind === 'ledger' && (h.kind !== 'ledger' || h.version !== 1)) refuse(403, 'sealed_role')
    const dev = deviceByKid(r, h.by)
    if (!dev) return refuse(403, 'not_enrolled')
    if (!writerOf(r, h.by, h.kind, h.vault)) refuse(403, 'sealed_role')
    if (!verifyObject(data, sig, b64Decode(dev.device.sig_pk))) refuse(400, 'bad_signature')
    const shared = h.kind === 'brain' || h.kind === 'config'
    const layout = h.kind === 'keywrap' ? h.wrap > 0 && h.wrap === body.length
      : (shared ? h.wrap === 0 : h.wrap > 0) && BUCKETS.includes(body.length - h.wrap - 16)
    if (!layout) refuse(400, 'bad_size')
    if ((shared && h.epoch !== epoch) || (h.kind === 'keywrap' && h.epoch > epoch)) refuse(409, 'version_conflict')
    const dir = p('objects', h.vault)
    const claimed = (await names(dir)).map((n) => /^([0-9a-f]{32})\.([1-9][0-9]{0,15})\.obj$/.exec(n)).filter((m) => m && m[1] === h.object)
    if (claimed.some((m) => Number(m![2]) >= h.version)) refuse(409, 'version_conflict')
    await markText()
    const base = `${h.object}.${h.version}`
    if (!(await create(`${dir}/${base}.obj`, b64Encode(data) + '\n', dir, `${base}.obj`))) refuse(409, 'version_conflict')
    const seq = r.seq
    const at = now()
    await fs.write(`${dir}/${base}.sig`, line({ v: 1, by: h.by, sig: b.sig }))
    await fs.write(`${dir}/${base}.json`, line({ v: 1, kind: h.kind, epoch: h.epoch, size: data.length, sha256: b.sha256, by: h.by,
      roster_seq: seq, accepted_at: at }))
    return { roster_seq: seq, accepted_at: at }
  }

  const routes: Record<string, (b: Obj) => Promise<Obj>> = {
    '/sealed/roster': roster, '/sealed/roster/put': rosterPut, '/sealed/enroll': enroll, '/sealed/pending': pending,
    '/sealed/put': put, '/sealed/list': list, '/sealed/get': get,
  }
  return async (route: string, body: Obj): Promise<unknown> => {
    const fn = routes[route]
    if (!fn) return refuse(404, 'not_found')
    if (!isObj(body)) return refuse(422, 'bad_request')
    return fn(body)
  }
}
