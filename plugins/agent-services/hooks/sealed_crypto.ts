import { Decrypter, Encrypter, bech32, chacha20poly1305, ed25519, forceWebCryptoOff, hkdf, sha256 } from './noble.js'
import { b64Decode, b64Encode, concat, hex, pyJson, utf8 } from './e2e'
import type { Random } from './e2e'
import { verifyEd25519 } from './sig'

export type { Random }
export type SealedCode = 'header' | 'padding' | 'too_large' | 'aead' | 'binding' | 'signature' | 'age'

export class SealedError extends Error {
  readonly code: SealedCode
  constructor(code: SealedCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'SealedError'
    this.code = code
  }
}

export type Kind = 'keywrap' | 'brain' | 'config' | 'inbox' | 'ledger'
export type HeaderIn = { org: string; vault: string; kind: Kind; epoch: number; object: string; version: number; by: string }
export type Header = HeaderIn & { v: 1; salt: string; nonce: string; wrap: number }
export type KeyWrapIn = { org: string; vault: string; epoch: number; version?: number; by: string }
export type RecordDomain = 'roster' | 'enroll' | 'checkpoint' | 'receipt'

export const FORMAT = 'agent-sealed/1'
const D = {
  obj: utf8('agent-sealed/1 obj'),
  sig: utf8('agent-sealed/1 sig\n'),
  fp: utf8('agent-sealed/1 fp\n'),
  org: utf8('agent-sealed/1 org\n'),
  kw: 'agent-sealed/1 kw\n',
  ck: utf8('agent-sealed/1 ck\n'),
  dk: utf8('agent-sealed/1 dk\n'),
}
const RECORD_DOMAINS: readonly RecordDomain[] = ['roster', 'enroll', 'checkpoint', 'receipt']
const SHARED_KINDS: readonly Kind[] = ['brain', 'config']
const DROP_KINDS: readonly Kind[] = ['inbox', 'ledger']
const KINDS: readonly Kind[] = ['keywrap', 'brain', 'config', 'inbox', 'ledger']
const HEADER_FIELDS = ['by', 'epoch', 'kind', 'nonce', 'object', 'org', 'salt', 'v', 'vault', 'version', 'wrap']
const ID_RX = /^[A-Za-z0-9_-]{1,64}$/
const HEX32 = /^[0-9a-f]{32}$/
const HEX16 = /^[0-9a-f]{16}$/
const KEY_RX = /^[A-Za-z0-9_-]{1,64}$/
const MAX_INT = 2 ** 53 - 1
const SALT_BYTES = 32
const NONCE_BYTES = 12
const KEY_BYTES = 32
const TAG_BYTES = 16
const WRAP_PLAIN = 18 + 32 + 32
const MAX_RECIPIENTS = 512
const KIB = 1024
const MIB = 1024 * KIB
export const BUCKETS: readonly number[] = [KIB, 4 * KIB, 16 * KIB, 64 * KIB, 256 * KIB, 512 * KIB, MIB, 2 * MIB, 4 * MIB, 8 * MIB]


function checkValue(v: unknown, depth: number): void {
  if (depth > 64) throw new SealedError('header', 'nesting')
  if (v === null || v === true || v === false || typeof v === 'string') return
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || v < 0 || v > MAX_INT) throw new SealedError('header', 'number')
    return
  }
  if (Array.isArray(v)) {
    for (const x of v) checkValue(x, depth + 1)
    return
  }
  if (typeof v === 'object' && Object.getPrototypeOf(v) !== null && Object.getPrototypeOf(v) !== Object.prototype) {
    throw new SealedError('header', 'value')
  }
  if (typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (!KEY_RX.test(k)) throw new SealedError('header', 'key')
      checkValue(x, depth + 1)
    }
    return
  }
  throw new SealedError('header', 'value')
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(o).sort()) out[k] = sortKeys(o[k])
    return out
  }
  return v
}

export function canonical(v: unknown): string {
  checkValue(v, 0)
  return pyJson(sortKeys(v))
}

const cjBytes = (v: unknown): Uint8Array => utf8(canonical(v))
const H = (b: Uint8Array): string => hex(sha256(b))


export function bucketOf(n: number): number {
  if (!Number.isInteger(n) || n < 0) throw new SealedError('too_large')
  for (const b of BUCKETS) if (4 + n <= b) return b
  throw new SealedError('too_large')
}

export function pad(p: Uint8Array): Uint8Array {
  const out = new Uint8Array(bucketOf(p.length))
  new DataView(out.buffer).setUint32(0, p.length, false)
  out.set(p, 4)
  return out
}

export function unpad(b: Uint8Array): Uint8Array {
  if (!BUCKETS.includes(b.length)) throw new SealedError('padding')
  const n = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, false)
  if (n > b.length - 4) throw new SealedError('padding')
  let acc = 0
  for (let i = 4 + n; i < b.length; i++) acc |= b[i]
  if (acc !== 0) throw new SealedError('padding')
  return b.slice(4, 4 + n)
}


export function keywrapObjectId(vault: string, epoch: number): string {
  if (!HEX32.test(vault) || !Number.isInteger(epoch) || epoch < 1 || epoch > MAX_INT) throw new SealedError('header')
  return H(utf8(`${D.kw}${vault}\n${epoch}`)).slice(0, 32)
}

function code30(domain: Uint8Array, ...keys: Uint8Array[]): string {
  for (const k of keys) if (!(k instanceof Uint8Array) || k.length !== 32) throw new SealedError('header', 'key length')
  const d = sha256(concat(domain, ...keys))
  const groups: string[] = []
  for (let i = 0; i < 30; i += 5) {
    let n = 0
    for (let j = 0; j < 5; j++) n = n * 256 + d[i + j]
    groups.push(String(n % 100000).padStart(5, '0'))
  }
  return groups.join(' ')
}

export const safetyCode = (enc: Uint8Array, sig: Uint8Array): string => code30(D.fp, enc, sig)
export const orgCode = (root: Uint8Array): string => code30(D.org, root)


function strictB64(s: unknown, len: number): Uint8Array {
  if (typeof s !== 'string') throw new SealedError('header')
  let b: Uint8Array
  try {
    b = b64Decode(s)
  } catch {
    throw new SealedError('header')
  }
  if (b.length !== len || b64Encode(b) !== s) throw new SealedError('header')
  return b
}

const isCount = (n: unknown, min: number): n is number => typeof n === 'number' && Number.isInteger(n) && n >= min && n <= MAX_INT

function checkHeaderIn(h: HeaderIn): void {
  if (!h || typeof h !== 'object') throw new SealedError('header')
  if (typeof h.org !== 'string' || !ID_RX.test(h.org)) throw new SealedError('header', 'org')
  if (typeof h.vault !== 'string' || !HEX32.test(h.vault)) throw new SealedError('header', 'vault')
  if (!KINDS.includes(h.kind)) throw new SealedError('header', 'kind')
  if (!isCount(h.epoch, 1)) throw new SealedError('header', 'epoch')
  if (typeof h.object !== 'string' || !HEX32.test(h.object)) throw new SealedError('header', 'object')
  if (!isCount(h.version, 1)) throw new SealedError('header', 'version')
  if (typeof h.by !== 'string' || !HEX16.test(h.by)) throw new SealedError('header', 'by')
}

function draw(random: Random, n: number): Uint8Array {
  const b = random(n)
  if (!(b instanceof Uint8Array) || b.length !== n) throw new SealedError('header', 'random')
  return b
}

function makeHeader(h: HeaderIn, random: Random, wrap: number): { header: Header; bytes: Uint8Array } {
  checkHeaderIn(h)
  const salt = draw(random, SALT_BYTES)
  const nonce = draw(random, NONCE_BYTES)
  const header: Header = {
    v: 1, org: h.org, vault: h.vault, kind: h.kind, epoch: h.epoch, object: h.object, version: h.version, by: h.by,
    salt: b64Encode(salt), nonce: b64Encode(nonce), wrap,
  }
  return { header, bytes: cjBytes(header) }
}

type Split = { header: Header; headerBytes: Uint8Array; body: Uint8Array; salt: Uint8Array; nonce: Uint8Array }

export function splitObject(obj: Uint8Array): Split {
  if (!(obj instanceof Uint8Array)) throw new SealedError('header')
  const nl = obj.indexOf(0x0a)
  if (nl <= 0 || nl > 4096) throw new SealedError('header')
  const headerBytes = obj.subarray(0, nl)
  for (const c of headerBytes) if (c < 0x20 || c > 0x7e) throw new SealedError('header')
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(headerBytes))
  } catch {
    throw new SealedError('header')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SealedError('header')
  const h = parsed as Header
  const keys = Object.keys(h).sort()
  if (keys.length !== HEADER_FIELDS.length || keys.some((k, i) => k !== HEADER_FIELDS[i])) throw new SealedError('header')
  if (h.v !== 1) throw new SealedError('header', 'v')
  checkHeaderIn(h)
  if (!isCount(h.wrap, 0)) throw new SealedError('header', 'wrap')
  const salt = strictB64(h.salt, SALT_BYTES)
  const nonce = strictB64(h.nonce, NONCE_BYTES)
  let again: Uint8Array
  try {
    again = cjBytes(h)
  } catch {
    throw new SealedError('header')
  }
  if (again.length !== headerBytes.length || again.some((c, i) => c !== headerBytes[i])) throw new SealedError('header')
  const body = obj.subarray(nl + 1)
  if (h.kind === 'keywrap' ? h.wrap !== body.length : SHARED_KINDS.includes(h.kind) ? h.wrap !== 0 : h.wrap < 1 || h.wrap >= body.length) {
    throw new SealedError('header', 'wrap')
  }
  return { header: h, headerBytes: headerBytes.slice(), body, salt, nonce }
}


function objectKey(k: Uint8Array, salt: Uint8Array): Uint8Array {
  if (!(k instanceof Uint8Array) || k.length !== KEY_BYTES) throw new SealedError('binding', 'key length')
  return hkdf(sha256, k, salt, D.obj, KEY_BYTES)
}

function aeadSeal(k: Uint8Array, salt: Uint8Array, nonce: Uint8Array, plain: Uint8Array, aad: Uint8Array): Uint8Array {
  return chacha20poly1305(objectKey(k, salt), nonce, aad).encrypt(pad(plain))
}

function aeadOpen(k: Uint8Array, s: Split, ct: Uint8Array): Uint8Array {
  let padded: Uint8Array
  try {
    padded = chacha20poly1305(objectKey(k, s.salt), s.nonce, s.headerBytes).decrypt(ct)
  } catch (e) {
    if (e instanceof SealedError) throw e
    throw new SealedError('aead')
  }
  return unpad(padded)
}


type Chunk = IteratorResult<Uint8Array, undefined>
type Puller = () => Promise<Chunk>

class MiniController {
  queue: Uint8Array[] = []
  closed = false
  err: unknown = undefined
  enqueue(c: Uint8Array): void {
    this.queue.push(c)
  }
  close(): void {
    this.closed = true
  }
  error(e: unknown): void {
    this.err = e ?? new Error('stream error')
  }
  terminate(): void {
    this.closed = true
  }
}

class MiniReadable {
  _pull: Puller
  constructor(source?: { start?: (c: MiniController) => void }, puller?: Puller) {
    if (puller) {
      this._pull = puller
      return
    }
    const c = new MiniController()
    source?.start?.(c)
    this._pull = async () => {
      if (c.err !== undefined) throw c.err
      if (c.queue.length) return { done: false, value: c.queue.shift()! }
      return { done: true, value: undefined }
    }
  }
  getReader(): { read: Puller; releaseLock: () => void; cancel: () => Promise<void> } {
    return { read: () => this._pull(), releaseLock: () => {}, cancel: async () => {} }
  }
  pipeThrough(t: MiniTransform): MiniReadable {
    return t._attach(this)
  }
}

type Transformer = {
  start?: (c: MiniController) => void
  transform?: (chunk: Uint8Array, c: MiniController) => void | Promise<void>
  flush?: (c: MiniController) => void | Promise<void>
}

class MiniTransform {
  #t: Transformer
  #c = new MiniController()
  #src: MiniReadable | null = null
  #flushed = false
  readonly readable: MiniReadable
  constructor(t: Transformer = {}) {
    this.#t = t
    t.start?.(this.#c)
    this.readable = new MiniReadable(undefined, () => this.#next())
  }
  _attach(src: MiniReadable): MiniReadable {
    this.#src = src
    return this.readable
  }
  async #next(): Promise<Chunk> {
    const c = this.#c
    for (;;) {
      if (c.err !== undefined) throw c.err
      if (c.queue.length) return { done: false, value: c.queue.shift()! }
      if (this.#flushed || c.closed || !this.#src) return { done: true, value: undefined }
      const r = await this.#src._pull()
      if (r.done) {
        this.#flushed = true
        await this.#t.flush?.(c)
      } else if (this.#t.transform) {
        await this.#t.transform(r.value, c)
      } else {
        c.enqueue(r.value)
      }
    }
  }
}

function ensureStreams(): void {
  const g = globalThis as Record<string, unknown>
  if (typeof g.ReadableStream !== 'function' || typeof g.TransformStream !== 'function') {
    g.ReadableStream = MiniReadable
    g.TransformStream = MiniTransform
  }
}

let ageReady = false
function ageInit(): void {
  if (ageReady) return
  ensureStreams()
  forceWebCryptoOff(true)
  ageReady = true
}

function toStream(b: Uint8Array): unknown {
  const RS = (globalThis as Record<string, unknown>).ReadableStream as new (s: unknown) => unknown
  return new RS({
    start(c: MiniController) {
      c.enqueue(b)
      c.close()
    },
  })
}

async function drain(s: unknown): Promise<Uint8Array> {
  const reader = (s as MiniReadable).getReader()
  const parts: Uint8Array[] = []
  for (;;) {
    const r = await reader.read()
    if (r.done) break
    parts.push(r.value)
  }
  reader.releaseLock()
  return concat(...parts)
}


function checkRecipients(recipients: string[]): void {
  if (!Array.isArray(recipients) || recipients.length < 1 || recipients.length > MAX_RECIPIENTS) {
    throw new SealedError('age', 'recipient count')
  }
  if (new Set(recipients).size !== recipients.length) throw new SealedError('age', 'duplicate recipient')
  for (const r of recipients) {
    let ok = false
    try {
      const d = bech32.decodeToBytes(r)
      ok = d.prefix === 'age' && d.bytes.length === 32 && r === r.toLowerCase()
    } catch {
      ok = false
    }
    if (!ok) throw new SealedError('age', 'recipient')
  }
}

export const wrapLength = (n: number): number => 22 + 98 * n + 48 + 16 + WRAP_PLAIN + TAG_BYTES

async function ageEncrypt(recipients: string[], plain: Uint8Array, fixed = true): Promise<Uint8Array> {
  checkRecipients(recipients)
  ageInit()
  try {
    const e = new Encrypter()
    for (const r of recipients) e.addRecipient(r)
    const out = await drain(await e.encrypt(toStream(plain) as never))
    if (fixed && out.length !== wrapLength(recipients.length)) throw new SealedError('age', 'length')
    return out
  } catch (e) {
    if (e instanceof SealedError) throw e
    throw new SealedError('age')
  }
}

function checkAgeHeader(file: Uint8Array): void {
  const end = indexOfSeq(file, utf8('\n--- '))
  if (end < 0) throw new SealedError('age', 'header')
  const text = new TextDecoder().decode(file.subarray(0, end))
  const lines = text.split('\n')
  if (lines[0] !== 'age-encryption.org/v1') throw new SealedError('age', 'version')
  let stanzas = 0
  for (const l of lines.slice(1)) {
    if (!l.startsWith('-> ')) continue
    stanzas++
    if (l.split(' ')[1] !== 'X25519') throw new SealedError('age', 'stanza type')
  }
  if (stanzas < 1 || stanzas > MAX_RECIPIENTS) throw new SealedError('age', 'stanza count')
}

function indexOfSeq(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

async function ageDecrypt(file: Uint8Array, identity: string): Promise<Uint8Array> {
  if (typeof identity !== 'string' || !identity.startsWith('AGE-SECRET-KEY-1')) throw new SealedError('age', 'identity')
  checkAgeHeader(file)
  ageInit()
  try {
    const d = new Decrypter()
    d.addIdentity(identity)
    return await drain(await d.decrypt(toStream(file) as never))
  } catch {
    throw new SealedError('age')
  }
}

export async function ageOpen(file: Uint8Array, identity: string): Promise<Uint8Array> {
  if (typeof identity !== 'string' || !identity.startsWith('AGE-SECRET-KEY-1')) throw new SealedError('age', 'identity')
  checkAgeHeader(file)
  ageInit()
  try {
    const d = new Decrypter()
    d.addIdentity(identity)
    return await drain(await d.decrypt(toStream(file) as never))
  } catch (e) {
    throw new SealedError('age', /no identity matched/i.test(String((e as Error)?.message ?? '')) ? 'no identity' : undefined)
  }
}

function unwrapKey(plain: Uint8Array, prefix: Uint8Array, binding: Uint8Array): Uint8Array {
  if (plain.length !== WRAP_PLAIN) throw new SealedError('binding', 'length')
  let acc = 0
  for (let i = 0; i < prefix.length; i++) acc |= plain[i] ^ prefix[i]
  const want = sha256(binding)
  for (let i = 0; i < 32; i++) acc |= plain[prefix.length + i] ^ want[i]
  if (acc !== 0) throw new SealedError('binding')
  return plain.slice(prefix.length + 32)
}


export function sealVault(h: HeaderIn, ck: Uint8Array, plain: Uint8Array, random: Random): Uint8Array {
  if (!SHARED_KINDS.includes(h?.kind)) throw new SealedError('header', 'kind')
  const { header, bytes } = makeHeader(h, random, 0)
  const ct = aeadSeal(ck, strictB64(header.salt, SALT_BYTES), strictB64(header.nonce, NONCE_BYTES), plain, bytes)
  return concat(bytes, Uint8Array.of(0x0a), ct)
}

export async function sealDrop(h: HeaderIn, recipients: string[], plain: Uint8Array, random: Random): Promise<Uint8Array> {
  if (!DROP_KINDS.includes(h?.kind)) throw new SealedError('header', 'kind')
  checkRecipients(recipients)
  const { header, bytes } = makeHeader(h, random, wrapLength(recipients.length))
  const dk = draw(random, KEY_BYTES)
  const agePart = await ageEncrypt(recipients, concat(D.dk, sha256(bytes), dk))
  const ct = aeadSeal(dk, strictB64(header.salt, SALT_BYTES), strictB64(header.nonce, NONCE_BYTES), plain, bytes)
  return concat(bytes, Uint8Array.of(0x0a), agePart, ct)
}

export async function sealKeyWrap(b: KeyWrapIn, recipients: string[], ck: Uint8Array, random: Random): Promise<Uint8Array> {
  if (!(ck instanceof Uint8Array) || ck.length !== KEY_BYTES) throw new SealedError('binding', 'key length')
  checkRecipients(recipients)
  const h: HeaderIn = {
    org: b.org, vault: b.vault, kind: 'keywrap', epoch: b.epoch, object: keywrapObjectId(b.vault, b.epoch),
    version: b.version ?? 1, by: b.by,
  }
  const { bytes } = makeHeader(h, random, wrapLength(recipients.length))
  const binding = cjBytes({ v: 1, org: b.org, vault: b.vault, epoch: b.epoch })
  const agePart = await ageEncrypt(recipients, concat(D.ck, sha256(binding), ck))
  return concat(bytes, Uint8Array.of(0x0a), agePart)
}


function checkPlainJson(kind: Kind, plain: Uint8Array): void {
  if (kind === 'ledger') return
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain))
  } catch {
    throw new SealedError('binding', 'plaintext')
  }
  let again: Uint8Array
  try {
    again = cjBytes(parsed)
  } catch {
    throw new SealedError('binding', 'plaintext')
  }
  if (again.length !== plain.length || again.some((c, i) => c !== plain[i])) throw new SealedError('binding', 'plaintext')
}

export async function openKeyWrap(obj: Uint8Array, identity: string): Promise<Uint8Array> {
  const s = splitObject(obj)
  if (s.header.kind !== 'keywrap') throw new SealedError('header', 'kind')
  if (s.header.object !== keywrapObjectId(s.header.vault, s.header.epoch)) throw new SealedError('binding', 'object id')
  const plain = await ageDecrypt(s.body, identity)
  const { org, vault, epoch } = s.header
  return unwrapKey(plain, D.ck, cjBytes({ v: 1, org, vault, epoch }))
}

export async function openObject(
  obj: Uint8Array,
  k: { ck?: Uint8Array; identity?: string; org?: string },
): Promise<{ header: Header; plain: Uint8Array }> {
  const s = splitObject(obj)
  const h = s.header
  if (k?.org !== undefined && h.org !== k.org) throw new SealedError('header', 'org')
  if (h.kind === 'keywrap') {
    if (typeof k?.identity !== 'string') throw new SealedError('age', 'identity')
    return { header: h, plain: await openKeyWrap(obj, k.identity) }
  }
  let key: Uint8Array
  let ct: Uint8Array
  if (SHARED_KINDS.includes(h.kind)) {
    if (!(k?.ck instanceof Uint8Array)) throw new SealedError('binding', 'content key')
    key = k.ck
    ct = s.body
  } else {
    if (typeof k?.identity !== 'string') throw new SealedError('age', 'identity')
    const dkPlain = await ageDecrypt(s.body.subarray(0, h.wrap), k.identity)
    key = unwrapKey(dkPlain, D.dk, s.headerBytes)
    ct = s.body.subarray(h.wrap)
  }
  const plain = aeadOpen(key, s, ct)
  checkPlainJson(h.kind, plain)
  return { header: h, plain }
}


function objectMessage(obj: Uint8Array): Uint8Array {
  const s = splitObject(obj)
  return concat(D.sig, s.headerBytes, Uint8Array.of(0x0a), sha256(s.body))
}

function checkSeed(seed: Uint8Array): void {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new SealedError('signature', 'seed length')
}

export function signObject(obj: Uint8Array, seed: Uint8Array): Uint8Array {
  checkSeed(seed)
  return ed25519.sign(objectMessage(obj), seed)
}

export function verifyObject(obj: Uint8Array, sig: Uint8Array, pk: Uint8Array): boolean {
  try {
    if (!(sig instanceof Uint8Array) || sig.length !== 64 || !(pk instanceof Uint8Array) || pk.length !== 32) return false
    return verifyEd25519(sig, objectMessage(obj), pk)
  } catch {
    return false
  }
}

function recordMessage(domain: RecordDomain, rec: object): Uint8Array {
  if (!RECORD_DOMAINS.includes(domain)) throw new SealedError('signature', 'domain')
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) throw new SealedError('signature', 'record')
  const rest: Record<string, unknown> = { ...(rec as Record<string, unknown>) }
  delete rest.sig
  return concat(utf8(`${FORMAT} ${domain}\n`), cjBytes(rest))
}

export function signRecord(domain: RecordDomain, rec: object, seed: Uint8Array): string {
  checkSeed(seed)
  return b64Encode(ed25519.sign(recordMessage(domain, rec), seed))
}

export function verifyRecord(domain: RecordDomain, rec: { sig: string }, pk: Uint8Array): boolean {
  try {
    if (!(pk instanceof Uint8Array) || pk.length !== 32) return false
    const sig = b64Decode(rec.sig)
    if (sig.length !== 64 || b64Encode(sig) !== rec.sig) return false
    return verifyEd25519(sig, recordMessage(domain, rec), pk)
  } catch {
    return false
  }
}


export async function sealNames(names: Record<string, string>, recipients: string[]): Promise<string> {
  if (!names || typeof names !== 'object' || Array.isArray(names)) throw new SealedError('binding', 'names')
  for (const [id, name] of Object.entries(names)) {
    if (!HEX32.test(id) || typeof name !== 'string' || name.length < 1 || name.length > 64) throw new SealedError('binding', 'names')
  }
  return b64Encode(await ageEncrypt(recipients, cjBytes({ v: 1, names }), false))
}

export async function openNames(b64: string, identity: string): Promise<Record<string, string>> {
  let file: Uint8Array
  try {
    file = b64Decode(b64)
  } catch {
    throw new SealedError('age', 'names')
  }
  const plain = await ageDecrypt(file, identity)
  let parsed: { v?: unknown; names?: unknown }
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain))
  } catch {
    throw new SealedError('binding', 'names')
  }
  const names = parsed?.names as Record<string, unknown>
  const ok = parsed?.v === 1 && Object.keys(parsed).length === 2 && names && typeof names === 'object' && !Array.isArray(names) &&
    Object.entries(names).every(([id, n]) => HEX32.test(id) && typeof n === 'string' && n.length >= 1 && n.length <= 64)
  if (!ok || canonical(parsed) !== new TextDecoder().decode(plain)) throw new SealedError('binding', 'names')
  return names as Record<string, string>
}
