import { sha256 } from './noble.js'
import { b64Decode, b64Encode, concat, hex, utf8 } from './e2e'
import type { Random } from './e2e'
import { verifyEd25519 } from './sig'
import { COMPANY_KIT_KEYS } from './contract'
import { SealedError, ageOpen, canonical, keywrapObjectId, openKeyWrap, openNames, sealNames } from './sealed_crypto'
import { kidOf, nextRoster } from './sealed_roster'
import type { Roster, RosterMember } from './sealed_roster'
import { identityPublic, newContentKey, signingSeed, wrapEpoch } from './sealed_keys'
import type { Identity } from './sealed_keys'
import { publishPack } from './brain_review'
import { serveBrain } from './brain_serve'
import type { Send } from './brain_serve'

type Obj = Record<string, unknown>
export type KitCode = 'header' | 'unknown_kid' | 'signature' | 'org' | 'replay' | 'mismatch' | 'reseal' | 'pack' | 'too_large' | 'not_admin' | 'roster' | 'keywrap'
export type KitHeader = {
  v: 1; kind: 'company-kit'; org: string; kit: string; version: string; parts: number; part: number
  roster_seq: number; roster_h: string; recipients: number; plain: string; t: number; kid: string
}
export type KitItem = { id: string; text: string; grade: null }
export type KitPack = { v: 1; id: string; tier: 'company'; version: string; title: string; when: string; items: KitItem[] }
export type KitInner = { v: 1; org: string; kit: string; version: string; part: number; roster_h: string; pack: KitPack; sig: string }
export type Pins = Record<string, string>
export type Opened = { header: KitHeader; inner: KitInner; pack: KitPack; plain: string }
export type OpenIn = {
  handoff: Uint8Array | string; outerSig: string; keys?: Record<string, string | Uint8Array>; org: string
  identity: string | { enc_sk: string }; pins?: Pins
}
export type AcceptIn = {
  org: string; identity: Identity; roster: Roster; keys?: Record<string, string | Uint8Array>; pins?: Pins; random: Random; t: number
}
export type PartRef = { kit: string; version: string; part: number }
export type Accepted = PartRef & { vault: string }
export type AcceptOut = {
  accepted: Accepted[]; reseal: PartRef[]; refused: (PartRef & { code: string })[]; pins: Pins; roster: Roster
}

export class KitError extends Error {
  readonly code: KitCode
  header?: KitHeader
  constructor(code: KitCode, header?: KitHeader) {
    super(code)
    this.name = 'KitError'
    this.code = code
    this.header = header
  }
}

const fail = (code: KitCode, header?: KitHeader): never => {
  throw new KitError(code, header)
}
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const isInt = (v: unknown, min: number, max: number = 2 ** 53 - 1): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
const isHex = (v: unknown, n: number): v is string => typeof v === 'string' && v.length === n && /^[0-9a-f]+$/.test(v)
const sameKeys = (o: Obj, keys: string): boolean => Object.keys(o).sort().join(',') === keys
const chars = (s: string): number => s.length
const cj = (v: unknown): Uint8Array => utf8(canonical(v))

export function vaultName(kit: string, part: number): string {
  return part === 1 ? `kit-${kit}` : `kit-${kit}-${part}`
}

export function packId(kit: string, part: number): string {
  return `co-${vaultName(kit, part)}`
}

export function servedPack(pack: KitPack, kitVer: string, objVer: number): KitPack {
  return { ...pack, version: `1.0.${objVer}`, title: `${pack.title} (v${kitVer})` }
}

function semver(v: unknown): [number, number, number] | null {
  if (typeof v !== 'string' || !/^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/.test(v)) return null
  const [a, b, c] = v.split('.').map(Number)
  return [a, b, c]
}

export function compareVersions(x: string, y: string): number {
  const a = semver(x)
  const b = semver(y)
  if (!a || !b) throw new KitError('header')
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

function parseHeader(bytes: Uint8Array): KitHeader {
  let text: string
  let h: unknown
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (!/^[\x20-\x7e]*$/.test(text)) return fail('header')
    h = JSON.parse(text)
    if (canonical(h) !== text) return fail('header')
  } catch {
    return fail('header')
  }
  if (!isObj(h) || !sameKeys(h, 'kid,kind,kit,org,part,parts,plain,recipients,roster_h,roster_seq,t,v,version')) fail('header')
  const o = h as Obj
  const ok = o.v === 1 && o.kind === 'company-kit' &&
    typeof o.org === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(o.org) &&
    typeof o.kit === 'string' && /^[a-z][a-z0-9-]{1,21}$/.test(o.kit) &&
    semver(o.version) !== null && isInt(o.parts, 1, 9) && isInt(o.part, 1, o.parts as number) &&
    isInt(o.roster_seq, 1) && isHex(o.roster_h, 64) && isInt(o.recipients, 1) && isHex(o.plain, 64) &&
    isInt(o.t, 0) && isHex(o.kid, 16)
  if (!ok) fail('header')
  return o as KitHeader
}

function contractKey(keys: Record<string, string | Uint8Array>, kid: string, h: KitHeader): Uint8Array {
  const k = Object.prototype.hasOwnProperty.call(keys, kid) ? keys[kid] : undefined
  if (k === undefined) return fail('unknown_kid', h)
  let pk: Uint8Array
  try {
    pk = typeof k === 'string' ? b64Decode(k) : k
  } catch {
    return fail('unknown_kid', h)
  }
  if (!(pk instanceof Uint8Array) || pk.length !== 32 || kidOf(b64Encode(pk)) !== kid) fail('unknown_kid', h)
  return pk
}

function sigBytes(s: unknown): Uint8Array | null {
  if (typeof s !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(s)) return null
  try {
    return b64Decode(s)
  } catch {
    return null
  }
}

function replayed(pins: Pins, h: KitHeader): boolean {
  for (const [key, ver] of Object.entries(pins ?? {})) {
    const slash = key.lastIndexOf('/')
    if (slash < 0 || key.slice(0, slash) !== h.kit || !semver(ver)) continue
    const c = compareVersions(h.version, ver)
    if (c < 0 || (key === `${h.kit}/${h.part}` && c <= 0)) return true
  }
  return false
}

function stanzaCount(age: Uint8Array): number {
  const n = Math.min(age.length, 65536 * 4)
  let text = ''
  for (let i = 0; i < n; i += 8192) text += String.fromCharCode(...age.subarray(i, Math.min(n, i + 8192)))
  const end = text.indexOf('\n--- ')
  if (!text.startsWith('age-encryption.org/v1\n') || end < 0) return -1
  return text.slice(0, end).split('\n').filter((l) => l.startsWith('-> ')).length
}

function checkPack(p: unknown, h: KitHeader): KitPack {
  if (!isObj(p) || !sameKeys(p, 'id,items,tier,title,v,version,when')) fail('pack', h)
  const pk = p as Obj
  const trimmed = (s: unknown, max: number): boolean => typeof s === 'string' && chars(s) >= 1 && chars(s) <= max && s.trim() === s
  if (pk.v !== 1 || pk.tier !== 'company' || pk.version !== '1.0.0' || pk.id !== packId(h.kit, h.part)) fail('pack', h)
  if (!trimmed(pk.title, 60 - ` (v${h.version})`.length) || !trimmed(pk.when, 160)) fail('pack', h)
  const items = pk.items
  if (!Array.isArray(items) || items.length < 1 || items.length > 500) fail('pack', h)
  const seen = new Set<string>()
  for (const it of items as unknown[]) {
    if (!isObj(it) || !sameKeys(it, 'grade,id,text')) fail('pack', h)
    const i = it as Obj
    if (typeof i.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(i.id) || seen.has(i.id)) fail('pack', h)
    if (typeof i.text !== 'string' || chars(i.text) < 1 || chars(i.text) > 700 || i.grade !== null) fail('pack', h)
    seen.add(i.id as string)
  }
  if (cj(pk).length > 15000) fail('too_large', h)
  return pk as KitPack
}

export async function openHandoff(a: OpenIn): Promise<Opened> {
  let handoff: Uint8Array
  try {
    handoff = typeof a.handoff === 'string' ? b64Decode(a.handoff) : a.handoff
  } catch {
    return fail('header')
  }
  if (!(handoff instanceof Uint8Array) || handoff.length > 1048576) fail('header')
  const nl = handoff.indexOf(0x0a)
  if (nl < 0) fail('header')
  const headerBytes = handoff.subarray(0, nl)
  const age = handoff.subarray(nl + 1)
  const h = parseHeader(headerBytes)
  const pk = contractKey(a.keys ?? (COMPANY_KIT_KEYS as Record<string, string>), h.kid, h)
  const outer = sigBytes(a.outerSig)
  const outerMsg = concat(utf8('agent-kit/1 outer\n'), headerBytes, Uint8Array.of(0x0a), sha256(age))
  if (!outer || !verifyEd25519(outer, outerMsg, pk)) fail('signature', h)
  if (h.org !== a.org) fail('org', h)
  if (replayed(a.pins ?? {}, h)) fail('replay', h)
  const stanzas = stanzaCount(age)
  if (stanzas < 0) fail('header', h)
  if (stanzas !== h.recipients) fail('mismatch', h)
  const identity = typeof a.identity === 'string' ? a.identity : a.identity?.enc_sk
  let innerBytes: Uint8Array
  try {
    innerBytes = await ageOpen(age, String(identity ?? ''))
  } catch (e) {
    return fail(e instanceof SealedError && /no identity/.test(e.message) ? 'reseal' : 'header', h)
  }
  if (hex(sha256(innerBytes)) !== h.plain) fail('mismatch', h)
  let inner: unknown
  let innerText: string
  try {
    innerText = new TextDecoder('utf-8', { fatal: true }).decode(innerBytes)
    inner = JSON.parse(innerText)
    if (canonical(inner) !== innerText) return fail('mismatch', h)
  } catch (e) {
    return fail(e instanceof KitError ? e.code : 'mismatch', h)
  }
  if (!isObj(inner) || !sameKeys(inner, 'kit,org,pack,part,roster_h,sig,v,version')) fail('mismatch', h)
  const ir = inner as Obj
  if (ir.v !== 1 || ir.org !== h.org || ir.kit !== h.kit || ir.version !== h.version || ir.part !== h.part || ir.roster_h !== h.roster_h) {
    fail('mismatch', h)
  }
  const { sig: innerSig, ...unsigned } = ir
  const isig = sigBytes(innerSig)
  if (!isig || !verifyEd25519(isig, concat(utf8('agent-kit/1 inner\n'), cj(unsigned)), pk)) fail('signature', h)
  const pack = checkPack(ir.pack, h)
  return { header: h, inner: ir as KitInner, pack, plain: h.plain }
}


const brainObjectId = (vault: string): string => hex(sha256(utf8(`agent-sealed/1 brain\n${vault}`))).slice(0, 32)

function nameRecipients(r: Roster): string[] {
  const out = new Set<string>()
  for (const m of r.members) if (m.role === 'admin') for (const d of m.devices) out.add(d.enc)
  out.add(r.recovery.enc)
  return [...out].sort()
}

async function latestVersion(send: Send, vault: string, object: string): Promise<number> {
  let best = 0
  let cursor: unknown
  for (let page = 0; page < 100; page++) {
    const body: Obj = { vault }
    if (typeof cursor === 'string') body.cursor = cursor
    const lst = (await send('/sealed/list', body)) as Obj
    const items = Array.isArray(lst?.items) ? (lst.items as Obj[]) : []
    for (const it of items) if (it?.object === object && isInt(it.version, 1)) best = Math.max(best, it.version as number)
    if (typeof lst?.cursor !== 'string' || !lst.cursor || lst.cursor === cursor || !items.length) break
    cursor = lst.cursor
  }
  return best
}

async function currentKey(send: Send, vault: string, epoch: number, encSk: string): Promise<Uint8Array> {
  const got = (await send('/sealed/get', { vault, object: keywrapObjectId(vault, epoch) })) as Obj
  if (typeof got?.data_b64 !== 'string') throw new Error('keywrap')
  return openKeyWrap(b64Decode(got.data_b64), encSk)
}

async function freshKeywrap(send: Send, r: Roster, vault: string, epoch: number, author: { kid: string; seed: Uint8Array }, random: Random): Promise<Uint8Array> {
  const ck = newContentKey(random)
  const kw = await wrapEpoch(r, vault, epoch, ck, 1, author, random)
  await putObject(send, vault, 'keywrap', kw.object, epoch, 1, kw.data, kw.sig)
  return ck
}

async function keyOrRepair(send: Send, r: Roster, vault: string, epoch: number, encSk: string, author: { kid: string; seed: Uint8Array }, random: Random): Promise<Uint8Array> {
  try {
    return await currentKey(send, vault, epoch, encSk)
  } catch (e) {
    if (!(e instanceof Error) || e.message !== 'not_found') throw e
  }
  return freshKeywrap(send, r, vault, epoch, author, random)
}

function titleVersion(title: string): string | null {
  const m = / \(v([0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6})\)$/.exec(title)
  return m && semver(m[1]) ? m[1] : null
}

async function servedPins(listed: PartRef[], byName: Map<string, string>, r: Roster, encSk: string, pins: Pins, send: Send): Promise<void> {
  const seen = new Set<string>()
  for (const p of listed) {
    const key = `${p.kit}/${p.part}`
    const vid = byName.get(vaultName(p.kit, p.part))
    if (!vid || seen.has(key)) continue
    seen.add(key)
    const got = await serveBrain({ org: r.org, vault: vid, roster: r, identity: encSk }, send)
    const ver = got.ok ? titleVersion(got.entry.title) : null
    if (ver && (!pins[key] || !semver(pins[key]) || compareVersions(ver, pins[key]) > 0)) pins[key] = ver
  }
}

export async function kitVaultIds(r: Roster, encSk: string): Promise<string[]> {
  if (!r.names) return []
  const names = await openNames(r.names, encSk)
  return r.vaults.filter((v) => v.kind === 'brain' && typeof names[v.id] === 'string' && names[v.id].startsWith('kit-')).map((v) => v.id).sort()
}

async function putObject(send: Send, vault: string, kind: string, object: string, epoch: number, version: number, data: Uint8Array, sig: Uint8Array): Promise<unknown> {
  return send('/sealed/put', {
    vault, kind, object, epoch, version, sha256: hex(sha256(data)), size: data.length, data_b64: b64Encode(data), sig: b64Encode(sig),
  })
}

function partList(ans: unknown): (PartRef & { state: string })[] {
  const raw = isObj(ans) ? (ans.kits ?? ans.parts) : undefined
  const kits = Array.isArray(raw) ? (raw as unknown[]) : []
  const out: (PartRef & { state: string })[] = []
  for (const k of kits) {
    if (!isObj(k) || typeof k.kit !== 'string' || !semver(k.version) || !isInt(k.part, 1, 9)) continue
    out.push({ kit: k.kit, version: k.version as string, part: k.part as number, state: String(k.state ?? 'sealed') })
  }
  return out.sort((x, y) => (x.kit < y.kit ? -1 : x.kit > y.kit ? 1 : compareVersions(x.version, y.version) || x.part - y.part))
}

function failedCode(e: unknown): string {
  const name = e instanceof Error ? e.name : typeof e
  const msg = e instanceof Error ? e.message : ''
  const reason = name === 'RouteError' && /^[a-z0-9_]{1,40}$/.test(msg) ? `route ${msg}` : /^[A-Za-z]{1,40}$/.test(name) ? name : 'error'
  return `failed: ${reason}`
}

export async function acceptKits(a: AcceptIn, send: Send): Promise<AcceptOut> {
  const id = a.identity
  const pub = identityPublic(id)
  let r = a.roster
  const me = r.members.find((m) => m.devices.some((d) => d.sig_pk === pub.sig_pk))
  if (!me || me.role !== 'admin' || r.org !== a.org) throw new KitError('not_admin')
  const pins: Pins = { ...(a.pins ?? {}) }
  const out: AcceptOut = { accepted: [], reseal: [], refused: [], pins, roster: r }

  const listed = partList(await send('/sealed/kit/list', {}))
  let names: Record<string, string> | null = null
  try {
    names = r.names ? await openNames(r.names, id.enc_sk) : {}
  } catch {}
  const byName = new Map<string, string>()
  for (const [vid, n] of Object.entries(names ?? {})) if (r.vaults.some((v) => v.id === vid && v.kind === 'brain')) byName.set(n, vid)
  await servedPins(listed, byName, r, id.enc_sk, pins, send)

  const opened: Opened[] = []
  const working: Pins = { ...pins }
  for (const p of listed) {
    if (p.state === 'reseal') continue
    const ref: PartRef = { kit: p.kit, version: p.version, part: p.part }
    try {
      const got = (await send('/sealed/kit/get', { ...ref })) as Obj
      if (typeof got?.handoff_b64 !== 'string' || typeof got?.outer_sig !== 'string') throw new KitError('header')
      const o = await openHandoff({ handoff: got.handoff_b64, outerSig: got.outer_sig, keys: a.keys, org: a.org, identity: id.enc_sk, pins: working })
      if (o.header.kit !== p.kit || o.header.version !== p.version || o.header.part !== p.part) throw new KitError('mismatch', o.header)
      working[`${p.kit}/${p.part}`] = p.version
      opened.push(o)
    } catch (e) {
      const code = e instanceof KitError ? e.code : failedCode(e)
      if (code === 'reseal' && e instanceof KitError && e.header) {
        await send('/sealed/kit/ack', { ...ref, plain: e.header.plain, reseal: true })
        out.reseal.push(ref)
      } else {
        out.refused.push({ ...ref, code })
      }
    }
  }
  if (!opened.length) return out

  if (names === null) names = r.names ? await openNames(r.names, id.enc_sk) : {}
  const fresh: string[] = []
  for (const o of opened) {
    const n = vaultName(o.header.kit, o.header.part)
    if (byName.has(n)) continue
    const vid = hex(a.random(16))
    byName.set(n, vid)
    names[vid] = n
    fresh.push(vid)
  }
  const author = { kid: pub.kid, seed: signingSeed(id) }
  const keys = new Map<string, Uint8Array>()
  const broken = new Map<string, string>()
  if (fresh.length) {
    const members: RosterMember[] = r.members.map((m) => ({ ...m, vaults: [...new Set([...m.vaults, ...fresh])] }))
    const vaults = [...r.vaults, ...fresh.map((v) => ({ id: v, kind: 'brain' as const, epoch: 1 }))]
    const draftNames = await sealNames(names, nameRecipients({ ...r, members }))
    const next = nextRoster(r, { members, vaults, names: draftNames }, { kind: 'device', seed: signingSeed(id), pk: pub.sigPk }, a.t)
    let put = false
    try {
      await send('/sealed/roster/put', { roster: next.roster })
      put = true
    } catch {
      for (const vid of fresh) broken.set(vid, 'roster')
    }
    if (put) {
      r = next.roster
      out.roster = r
      for (const vid of [...new Set([...fresh, ...next.rotated])]) {
        const v = r.vaults.find((x) => x.id === vid)
        if (!v) continue
        try {
          keys.set(vid, await freshKeywrap(send, r, vid, v.epoch, author, a.random))
        } catch (e) {
          if (!fresh.includes(vid)) throw e
          broken.set(vid, 'keywrap')
        }
      }
    }
  }

  for (const o of opened) {
    const { kit, version, part } = o.header
    const ref: PartRef = { kit, version, part }
    try {
      const name = vaultName(kit, part)
      const vid = byName.get(name) as string
      const why = broken.get(vid)
      if (why) throw new KitError(why as KitCode, o.header)
      const v = r.vaults.find((x) => x.id === vid)
      if (!v) throw new Error('vault')
      const object = brainObjectId(vid)
      const objVer = fresh.includes(vid) ? 1 : (await latestVersion(send, vid, object)) + 1
      if (!keys.has(vid)) keys.set(vid, await keyOrRepair(send, r, vid, v.epoch, id.enc_sk, author, a.random))
      const ck = keys.get(vid) as Uint8Array
      await publishPack(servedPack(o.pack, version, objVer), { org: r.org, vault: vid, epoch: v.epoch, object, version: objVer, ck, seed: signingSeed(id) }, send, a.random)
      pins[`${kit}/${part}`] = version
      await send('/sealed/kit/ack', { ...ref, vault: vid, plain: o.plain })
      out.accepted.push({ ...ref, vault: name })
    } catch (e) {
      out.refused.push({ ...ref, code: e instanceof KitError ? e.code : failedCode(e) })
    }
  }
  return out
}
