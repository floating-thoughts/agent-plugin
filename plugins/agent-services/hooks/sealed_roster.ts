import { bech32, sha256 } from './noble.js'
import { b64Decode, b64Encode, hex, utf8 } from './e2e'
import { canonical, orgCode, signRecord, verifyRecord } from './sealed_crypto'
import type { Kind } from './sealed_crypto'

export type Role = 'admin' | 'curator' | 'member' | 'auditor'
export type RosterDevice = { dev: string; enc: string; sig_pk: string; added: number; verified: boolean }
export type RosterMember = { acc: string; role: Role; vaults: string[]; devices: RosterDevice[] }
export type RosterVault = { id: string; kind: 'brain' | 'ledger'; epoch: number }
export type Signer = { kind: 'device' | 'recovery' | 'root'; kid: string }
export type Roster = {
  v: 1; org: string; seq: number; prev: string; t: number; root: string
  members: RosterMember[]; vaults: RosterVault[]; recovery: { enc: string; sig_pk: string }
  names: string; signer: Signer; sig: string
}
export type Pin = { org: string; seq: number; h: string; root: string }
export type Accepted = { ok: true; pin: Pin; roster: Roster } | { ok: false; reason: string }

const ZERO64 = '0'.repeat(64)
const ROSTER_LIMITS = { members: 500, devices: 8, vaults: 64, bytes: 512 * 1024 } as const

class RosterError extends Error {}
const fail = (reason: string): never => {
  throw new RosterError(reason)
}


export function kidOf(pkB64: string): string {
  return hex(sha256(b64Decode(pkB64))).slice(0, 16)
}

export function recordHash(rec: object): string {
  return hex(sha256(utf8(canonical(rec))))
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isInt = (n: unknown, min: number): n is number => typeof n === 'number' && Number.isInteger(n) && n >= min && n <= 2 ** 53 - 1
const isId = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s)
const isHex = (s: unknown, n: number): s is string => typeof s === 'string' && s.length === n && /^[0-9a-f]+$/.test(s)

function keysExactly(o: Record<string, unknown>, keys: string[], what: string): void {
  const have = Object.keys(o).sort()
  const want = [...keys].sort()
  if (have.length !== want.length || have.some((k, i) => k !== want[i])) fail(`${what} fields`)
}

function b64Key(s: unknown, what: string): Uint8Array {
  if (typeof s !== 'string') return fail(what)
  let b: Uint8Array
  try {
    b = b64Decode(s)
  } catch {
    return fail(what)
  }
  if (b.length !== 32 || b64Encode(b) !== s) fail(what)
  return b
}

export function isRecipient(s: unknown): s is string {
  if (typeof s !== 'string' || !s.startsWith('age1') || s !== s.toLowerCase()) return false
  try {
    const d = bech32.decodeToBytes(s)
    return d.prefix === 'age' && d.bytes.length === 32
  } catch {
    return false
  }
}

function sorted(list: string[]): boolean {
  for (let i = 1; i < list.length; i++) if (!(list[i - 1] < list[i])) return false
  return true
}


function checkShape(r: unknown): Roster {
  if (!isObj(r)) return fail('roster')
  keysExactly(r, ['v', 'org', 'seq', 'prev', 't', 'root', 'members', 'vaults', 'recovery', 'names', 'signer', 'sig'], 'roster')
  if (r.v !== 1) fail('version')
  if (!isId(r.org)) fail('org')
  if (!isInt(r.seq, 1)) fail('seq')
  if (!isHex(r.prev, 64)) fail('prev')
  if (r.seq === 1 && r.prev !== ZERO64) fail('prev')
  if (!isInt(r.t, 0)) fail('t')
  b64Key(r.root, 'root')
  if (typeof r.names !== 'string' || !r.names) fail('names')
  if (typeof r.sig !== 'string') fail('sig')
  if (!isObj(r.signer)) return fail('signer')
  keysExactly(r.signer, ['kind', 'kid'], 'signer')
  if (!['device', 'recovery', 'root'].includes(r.signer.kind as string) || !isHex(r.signer.kid, 16)) fail('signer')
  if (!isObj(r.recovery)) return fail('recovery')
  keysExactly(r.recovery, ['enc', 'sig_pk'], 'recovery')
  if (!isRecipient(r.recovery.enc)) fail('recovery')
  b64Key(r.recovery.sig_pk, 'recovery')

  if (!Array.isArray(r.vaults) || r.vaults.length > ROSTER_LIMITS.vaults) return fail('vaults')
  const vaultIds: string[] = []
  let ledgers = 0
  for (const v of r.vaults) {
    if (!isObj(v)) return fail('vault')
    keysExactly(v, ['id', 'kind', 'epoch'], 'vault')
    if (!isHex(v.id, 32) || !['brain', 'ledger'].includes(v.kind as string) || !isInt(v.epoch, 1)) fail('vault')
    if (v.kind === 'ledger') ledgers++
    vaultIds.push(v.id as string)
  }
  if (ledgers !== 1) fail('ledger vault')
  if (!sorted(vaultIds)) fail('vault order')

  if (!Array.isArray(r.members) || r.members.length > ROSTER_LIMITS.members) return fail('members')
  const accs: string[] = []
  const devIds = new Set<string>()
  const kids = new Set<string>()
  for (const m of r.members) {
    if (!isObj(m)) return fail('member')
    keysExactly(m, ['acc', 'role', 'vaults', 'devices'], 'member')
    if (!isId(m.acc) || !['admin', 'curator', 'member', 'auditor'].includes(m.role as string)) fail('member')
    accs.push(m.acc as string)
    if (!Array.isArray(m.vaults) || !m.vaults.every((x) => isHex(x, 32) && vaultIds.includes(x)) || !sorted(m.vaults)) fail('member vaults')
    if (!Array.isArray(m.devices) || m.devices.length < 1 || m.devices.length > ROSTER_LIMITS.devices) return fail('devices')
    const devs: string[] = []
    for (const d of m.devices) {
      if (!isObj(d)) return fail('device')
      keysExactly(d, ['dev', 'enc', 'sig_pk', 'added', 'verified'], 'device')
      if (!isId(d.dev) || !isRecipient(d.enc) || !isInt(d.added, 0) || typeof d.verified !== 'boolean') fail('device')
      b64Key(d.sig_pk, 'device')
      const kid = kidOf(d.sig_pk as string)
      if (devIds.has(d.dev as string) || kids.has(kid)) fail('duplicate device')
      devIds.add(d.dev as string)
      kids.add(kid)
      devs.push(d.dev as string)
    }
    if (!sorted(devs)) fail('device order')
  }
  if (!sorted(accs)) fail('member order')
  if (utf8(canonical(r)).length > ROSTER_LIMITS.bytes) fail('too large')
  return r as unknown as Roster
}

export function parseRoster(r: unknown): Roster | null {
  try {
    return checkShape(r)
  } catch {
    return null
  }
}


function adminDevice(r: Roster, kid: string): RosterDevice | null {
  for (const m of r.members) {
    if (m.role !== 'admin') continue
    for (const d of m.devices) if (kidOf(d.sig_pk) === kid) return d
  }
  return null
}

function checkSigner(next: Roster, prev: Roster | null): void {
  let pk: string | null = null
  const s = next.signer
  if (prev === null) {
    if (next.seq !== 1 || s.kind !== 'root' || s.kid !== kidOf(next.root)) fail('signer')
    pk = next.root
  } else if (s.kind === 'device') {
    pk = adminDevice(prev, s.kid)?.sig_pk ?? null
    if (pk === null) fail('signer not admin')
  } else if (s.kind === 'recovery') {
    if (s.kid !== kidOf(prev.recovery.sig_pk)) fail('signer')
    pk = prev.recovery.sig_pk
  } else {
    fail('signer')
  }
  if (!verifyRecord('roster', next, b64Decode(pk as string))) fail('signature')
}

function checkLink(prev: Roster, next: Roster): void {
  if (next.org !== prev.org) fail('org')
  if (next.seq !== prev.seq + 1) fail('seq')
  if (next.prev !== recordHash(prev)) fail('prev')
  if (next.root !== prev.root) fail('root')
  for (const v of prev.vaults) {
    const n = next.vaults.find((x) => x.id === v.id)
    if (n && (n.kind !== v.kind || n.epoch < v.epoch)) fail('epoch')
  }
  checkSigner(next, prev)
}

export function acceptRoster(pin: Pin, chain: unknown[]): Accepted {
  try {
    if (!isObj(pin) || !isId(pin.org) || !isInt(pin.seq, 1) || typeof pin.root !== 'string') fail('pin')
    const h = (pin as any).h ?? (pin as any).hash
    if (!isHex(h, 64)) fail('pin')
    if (!Array.isArray(chain) || chain.length < 1) fail('empty')
    const rs = chain.map((r) => checkShape(r))
    for (const r of rs) {
      if (r.org !== pin.org) fail('org')
      if (r.root !== pin.root) fail('root')
    }
    const top = rs[rs.length - 1]
    if (top.seq <= pin.seq) fail('rollback')
    const pinned = rs.find((r) => r.seq === pin.seq)
    if (!pinned || recordHash(pinned) !== h) fail('pinned roster missing')
    let prev = pinned as Roster
    for (const r of rs.filter((x) => x.seq > pin.seq)) {
      checkLink(prev, r)
      prev = r
    }
    if (prev !== top) fail('order')
    return { ok: true, pin: { org: top.org, seq: top.seq, h: recordHash(top), root: top.root }, roster: top }
  } catch (e) {
    return { ok: false, reason: e instanceof RosterError ? e.message : 'roster' }
  }
}

export function verifyRosterChain(chain: unknown[], root?: string): Accepted {
  try {
    if (!Array.isArray(chain) || chain.length < 1) fail('empty')
    const rs = chain.map((r) => checkShape(r))
    if (rs[0].seq !== 1) fail('seq')
    if (root !== undefined && rs[0].root !== root) fail('root')
    checkSigner(rs[0], null)
    for (let i = 1; i < rs.length; i++) checkLink(rs[i - 1], rs[i])
    const top = rs[rs.length - 1]
    return { ok: true, pin: { org: top.org, seq: top.seq, h: recordHash(top), root: top.root }, roster: top }
  } catch (e) {
    return { ok: false, reason: e instanceof RosterError ? e.message : 'roster' }
  }
}

const normCode = (s: string): string => String(s ?? '').replace(/\s+/g, ' ').trim()

export function pinFromEnrollment(r1: unknown, givenOrgCode: string): Accepted {
  try {
    const r = checkShape(r1)
    if (r.seq !== 1) fail('seq')
    checkSigner(r, null)
    if (normCode(givenOrgCode) !== orgCode(b64Decode(r.root))) fail('organisation code')
    return { ok: true, pin: { org: r.org, seq: 1, h: recordHash(r), root: r.root }, roster: r }
  } catch (e) {
    return { ok: false, reason: e instanceof RosterError ? e.message : 'roster' }
  }
}


export function readersOf(r: Roster, vault: string, kind: Kind, author?: string): string[] {
  const v = r.vaults.find((x) => x.id === vault)
  if (!v) return []
  const out = new Set<string>()
  const add = (m: RosterMember) => m.devices.forEach((d) => out.add(d.enc))
  if (kind === 'keywrap' || kind === 'brain' || kind === 'config') {
    if (v.kind !== 'brain') return []
    for (const m of r.members) if (m.role === 'admin' || m.vaults.includes(vault)) add(m)
  } else if (kind === 'inbox') {
    if (v.kind !== 'brain') return []
    for (const m of r.members) if (m.role === 'admin' || (m.role === 'curator' && m.vaults.includes(vault))) add(m)
  } else if (kind === 'ledger') {
    if (v.kind !== 'ledger') return []
    for (const m of r.members) if (m.role === 'admin' || m.role === 'auditor') add(m)
  } else {
    return []
  }
  if (kind === 'inbox' || kind === 'ledger') {
    if (author !== undefined) {
      const d = deviceByKid(r, author)
      if (d) out.add(d.device.enc)
    }
  }
  out.add(r.recovery.enc)
  return [...out]
}

export function deviceByKid(r: Roster, kid: string): { member: RosterMember; device: RosterDevice } | null {
  for (const m of r.members) for (const d of m.devices) if (kidOf(d.sig_pk) === kid) return { member: m, device: d }
  return null
}

export function writerOf(r: Roster, kid: string, kind: Kind, vault: string): { member: RosterMember; device: RosterDevice } | null {
  const hit = deviceByKid(r, kid)
  const v = r.vaults.find((x) => x.id === vault)
  if (!hit || !v) return null
  const role = hit.member.role
  if (kind === 'keywrap' || kind === 'brain' || kind === 'config') return v.kind === 'brain' && role === 'admin' ? hit : null
  if (kind === 'inbox') return v.kind === 'brain' && (role === 'admin' || hit.member.vaults.includes(vault)) ? hit : null
  if (kind === 'ledger') return v.kind === 'ledger' ? hit : null
  return null
}


function brainReaders(r: Roster): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const v of r.vaults) {
    if (v.kind !== 'brain') continue
    const s = new Set<string>()
    for (const m of r.members) if (m.role === 'admin' || m.vaults.includes(v.id)) m.devices.forEach((d) => s.add(`${m.acc}/${d.dev}/${d.sig_pk}`))
    out.set(v.id, s)
  }
  return out
}

export function rotationsNeeded(prev: Roster, next: Roster): string[] {
  const before = brainReaders(prev)
  const after = brainReaders(next)
  const out: string[] = []
  for (const [id, readers] of before) {
    const now = after.get(id)
    if (!now) continue
    let lost = [...readers].some((x) => !now.has(x))
    for (const m of prev.members) {
      if (m.role !== 'admin' && m.role !== 'curator') continue
      const n = next.members.find((x) => x.acc === m.acc)
      if (n && n.role !== m.role && (m.role === 'admin' || m.vaults.includes(id))) lost = true
    }
    if (lost) out.push(id)
  }
  return out
}

export type RosterChange = {
  members?: RosterMember[]
  vaults?: RosterVault[]
  recovery?: { enc: string; sig_pk: string }
  names?: string
  rotate?: string[]
}

export function nextRoster(
  prev: Roster,
  change: RosterChange,
  signer: { kind: 'device' | 'recovery'; seed: Uint8Array; pk: Uint8Array },
  t: number,
): { roster: Roster; rotated: string[] } {
  const members = (change.members ?? prev.members)
    .map((m) => ({ ...m, vaults: [...m.vaults].sort(), devices: [...m.devices].sort((a, b) => (a.dev < b.dev ? -1 : a.dev > b.dev ? 1 : 0)) }))
    .sort((a, b) => (a.acc < b.acc ? -1 : a.acc > b.acc ? 1 : 0))
  const vaults = (change.vaults ?? prev.vaults).map((v) => ({ ...v })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const draft: Roster = {
    v: 1, org: prev.org, seq: prev.seq + 1, prev: recordHash(prev), t, root: prev.root, members, vaults,
    recovery: change.recovery ?? prev.recovery, names: change.names ?? prev.names,
    signer: { kind: signer.kind, kid: hex(sha256(signer.pk)).slice(0, 16) }, sig: '',
  }
  const rotate = new Set([...rotationsNeeded(prev, draft), ...(change.rotate ?? [])])
  const rotated: string[] = []
  for (const v of draft.vaults) {
    if (v.kind !== 'brain' || !rotate.has(v.id)) continue
    const old = prev.vaults.find((x) => x.id === v.id)
    if (old && v.epoch <= old.epoch) v.epoch = old.epoch + 1
    rotated.push(v.id)
  }
  const { sig: _drop, ...unsigned } = draft
  draft.sig = signRecord('roster', unsigned, signer.seed)
  const ok = acceptRoster({ org: prev.org, seq: prev.seq, h: recordHash(prev), root: prev.root }, [prev, draft])
  if (!ok.ok) throw new Error(`roster: ${ok.reason}`)
  return { roster: draft, rotated }
}

export function firstRoster(
  b: { org: string; t: number; admin: RosterMember; vaults: RosterVault[]; recovery: { enc: string; sig_pk: string }; names: string },
  rootSeed: Uint8Array,
  rootPk: Uint8Array,
): Roster {
  const root = b64Encode(rootPk)
  const draft: Roster = {
    v: 1, org: b.org, seq: 1, prev: ZERO64, t: b.t, root,
    members: [{ ...b.admin, role: 'admin', vaults: [...b.admin.vaults].sort() }],
    vaults: b.vaults.map((v) => ({ ...v })).sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)),
    recovery: b.recovery, names: b.names, signer: { kind: 'root', kid: kidOf(root) }, sig: '',
  }
  const { sig: _drop, ...unsigned } = draft
  draft.sig = signRecord('roster', unsigned, rootSeed)
  const ok = verifyRosterChain([draft], root)
  if (!ok.ok) throw new Error(`roster: ${ok.reason}`)
  return draft
}
