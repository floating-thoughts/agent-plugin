import type { EngineInterface } from 'claude-code'
import { bech32, chacha20poly1305, ed25519, hkdf, hmac, sha256, x25519 } from './noble.js'
import { b64Decode, b64Encode, hex, utf8 } from './e2e'
import type { Random } from './e2e'
import { dataDir } from './engine_env'
import { canonical, keywrapObjectId, openKeyWrap, orgCode, safetyCode, sealKeyWrap, signObject, signRecord, verifyRecord } from './sealed_crypto'
import { isRecipient, kidOf, nextRoster, readersOf } from './sealed_roster'
import type { Roster, RosterMember } from './sealed_roster'

export type Identity = {
  v: 1; org: string; acc: string; dev: string; enc_sk: string; sig_seed: string; project_key: string; t: number
}
export type Protect = 'dpapi' | 'keychain' | 'none'
export type Enroll = { v: 1; org: string; acc: string; dev: string; enc: string; sig_pk: string; t: number; sig: string }
export type RecoverySheet = { org: string; orgCode: string; ageSecret: string }

const SEALED_ID_RX = /^[A-Za-z0-9_-]{1,64}$/
const KEYCHAIN_SERVICE = 'agent-services-sealed'

const now = (): number => Math.floor(Date.now() / 1000)

function drawN(random: Random, n: number): Uint8Array {
  const b = random(n)
  if (!(b instanceof Uint8Array) || b.length !== n) throw new Error('random')
  return b
}

function strict32(s: unknown, what: string): Uint8Array {
  if (typeof s !== 'string') throw new Error(what)
  const b = b64Decode(s)
  if (b.length !== 32 || b64Encode(b) !== s) throw new Error(what)
  return b
}


export function ageSecretBytes(ageSecret: string): Uint8Array {
  if (typeof ageSecret !== 'string' || !ageSecret.startsWith('AGE-SECRET-KEY-1') || ageSecret !== ageSecret.toUpperCase()) {
    throw new Error('age identity')
  }
  const d = bech32.decodeToBytes(ageSecret)
  if (d.prefix !== 'age-secret-key-' || d.bytes.length !== 32) throw new Error('age identity')
  return d.bytes
}

export function ageKeys(secret: Uint8Array): { identity: string; recipient: string } {
  if (!(secret instanceof Uint8Array) || secret.length !== 32) throw new Error('age identity')
  return {
    identity: bech32.encodeFromBytes('AGE-SECRET-KEY-', secret).toUpperCase(),
    recipient: bech32.encodeFromBytes('age', x25519.getPublicKey(secret)),
  }
}

export const recipientOf = (ageSecret: string): string => ageKeys(ageSecretBytes(ageSecret)).recipient


export function newIdentity(org: string, acc: string, dev: string, random: Random, t: number = now()): Identity {
  for (const x of [org, acc, dev]) if (typeof x !== 'string' || !SEALED_ID_RX.test(x)) throw new Error('id')
  const enc = drawN(random, 32)
  const sig = drawN(random, 32)
  const project = drawN(random, 32)
  return {
    v: 1, org, acc, dev, enc_sk: ageKeys(enc).identity, sig_seed: b64Encode(sig), project_key: b64Encode(project), t,
  }
}

export function identityPublic(id: Identity): { enc: string; encPk: Uint8Array; sigPk: Uint8Array; sig_pk: string; kid: string; safety: string } {
  const encSk = ageSecretBytes(id.enc_sk)
  const encPk = x25519.getPublicKey(encSk)
  const sigPk = ed25519.getPublicKey(strict32(id.sig_seed, 'sig_seed'))
  const sig_pk = b64Encode(sigPk)
  return { enc: ageKeys(encSk).recipient, encPk, sigPk, sig_pk, kid: kidOf(sig_pk), safety: safetyCode(encPk, sigPk) }
}

export const signingSeed = (id: Identity): Uint8Array => strict32(id.sig_seed, 'sig_seed')

export function projectHash(id: Identity, rootPath: string): string {
  const k = strict32(id.project_key, 'project_key')
  const msg = new Uint8Array([...utf8('agent-sealed/1 project'), 0, ...utf8(String(rootPath))])
  return hex(hmac(sha256, k, msg)).slice(0, 32)
}


export function enrollRecord(id: Identity, t: number = now()): Enroll {
  const p = identityPublic(id)
  const rec = { v: 1 as const, org: id.org, acc: id.acc, dev: id.dev, enc: p.enc, sig_pk: p.sig_pk, t }
  return { ...rec, sig: signRecord('enroll', rec, signingSeed(id)) }
}

export function enrollSafetyCode(rec: unknown): string | null {
  try {
    const r = rec as Enroll
    const keys = Object.keys(r).sort().join(',')
    if (keys !== 'acc,dev,enc,org,sig,sig_pk,t,v' || r.v !== 1) return null
    if (![r.org, r.acc, r.dev].every((x) => typeof x === 'string' && SEALED_ID_RX.test(x))) return null
    if (!Number.isInteger(r.t) || r.t < 0 || !isRecipient(r.enc)) return null
    const sigPk = strict32(r.sig_pk, 'sig_pk')
    if (!verifyRecord('enroll', r, sigPk)) return null
    return safetyCode(bech32.decodeToBytes(r.enc).bytes, sigPk)
  } catch {
    return null
  }
}

export function memberFromEnroll(rec: Enroll, role: RosterMember['role'], vaults: string[], verified: boolean, t: number = now()): RosterMember {
  if (enrollSafetyCode(rec) === null) throw new Error('enroll')
  return { acc: rec.acc, role, vaults: [...vaults].sort(), devices: [{ dev: rec.dev, enc: rec.enc, sig_pk: rec.sig_pk, added: t, verified }] }
}


export function recoverySigningKey(ageSecret: string): Uint8Array {
  return hkdf(sha256, ageSecretBytes(ageSecret), new Uint8Array(0), utf8('agent-sealed/1 recovery-sign'), 32)
}

export function newRecovery(random: Random): { ageSecret: string; enc: string; sig_pk: string } {
  const k = ageKeys(drawN(random, 32))
  return { ageSecret: k.identity, enc: k.recipient, sig_pk: b64Encode(ed25519.getPublicKey(recoverySigningKey(k.identity))) }
}

export function recoveryFileText(org: string, date: string, rootPk: Uint8Array, ageSecret: string): string {
  ageSecretBytes(ageSecret)
  if (!SEALED_ID_RX.test(org) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('recovery sheet')
  return [
    'agent-services recovery sheet', 'Format: agent-sealed/1', `Company: ${org}`, `Created: ${date}`,
    `Organisation code: ${orgCode(rootPk)}`, `Recovery key: ${ageSecret}`,
    '1. Print this page or store it in your password manager.',
    "2. Keep it in a safe place; anyone holding it can read and control your company's brain and ledger.",
    '3. Delete this file from the computer.', '',
  ].join('\n')
}

export function parseRecoveryFile(text: string): RecoverySheet {
  if (typeof text !== 'string') throw new Error('recovery sheet')
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const one = (prefix: string): string => {
    const hits = lines.filter((l) => l.startsWith(prefix))
    if (hits.length !== 1) throw new Error('recovery sheet')
    return hits[0].slice(prefix.length).trim()
  }
  if (one('Format: ') !== 'agent-sealed/1') throw new Error('recovery sheet format')
  const org = one('Company: ')
  const code = one('Organisation code: ')
  const ageSecret = one('Recovery key: ')
  if (!SEALED_ID_RX.test(org) || !/^\d{5}( \d{5}){5}$/.test(code)) throw new Error('recovery sheet')
  ageSecretBytes(ageSecret)
  return { org, orgCode: code, ageSecret }
}

export function checkRecoverySheet(sheet: RecoverySheet, roster: Roster, pinnedRoot: string): string | null {
  try {
    if (sheet.org !== roster.org) return 'company'
    if (recipientOf(sheet.ageSecret) !== roster.recovery.enc) return 'recovery key'
    if (b64Encode(ed25519.getPublicKey(recoverySigningKey(sheet.ageSecret))) !== roster.recovery.sig_pk) return 'recovery key'
    if (roster.root !== pinnedRoot || sheet.orgCode !== orgCode(b64Decode(pinnedRoot))) return 'organisation code'
    return null
  } catch {
    return 'recovery sheet'
  }
}

export function confirmsRecovery(typed: string, ageSecret: string): boolean {
  const t = String(typed ?? '').trim().toUpperCase()
  return t.length === 6 && ageSecret.toUpperCase().endsWith(t)
}


export const newContentKey = (random: Random): Uint8Array => drawN(random, 32)

export async function wrapEpoch(
  r: Roster, vault: string, epoch: number, ck: Uint8Array, version: number,
  author: { kid: string; seed: Uint8Array }, random: Random,
): Promise<{ object: string; data: Uint8Array; sig: Uint8Array }> {
  const recipients = readersOf(r, vault, 'keywrap')
  if (!recipients.length) throw new Error('no readers')
  const data = await sealKeyWrap({ org: r.org, vault, epoch, version, by: author.kid }, recipients, ck, random)
  return { object: keywrapObjectId(vault, epoch), data, sig: signObject(data, author.seed) }
}

export function recoveryRoster(
  prev: Roster, sheet: RecoverySheet, pinnedRoot: string, fresh: Identity, lostDevs: string[], random: Random, t: number = now(),
): { roster: Roster; contentKeys: Record<string, Uint8Array> } {
  const why = checkRecoverySheet(sheet, prev, pinnedRoot)
  if (why) throw new Error(why)
  const p = identityPublic(fresh)
  const lost = new Set(lostDevs)
  const members: RosterMember[] = []
  for (const m of prev.members) {
    if (m.acc === fresh.acc) continue
    const devices = m.devices.filter((d) => !lost.has(d.dev))
    if (devices.length) members.push({ ...m, devices })
  }
  const old = prev.members.find((m) => m.acc === fresh.acc)
  const keep = (old?.devices ?? []).filter((d) => !lost.has(d.dev) && d.dev !== fresh.dev)
  const brains = prev.vaults.filter((v) => v.kind === 'brain').map((v) => v.id)
  members.push({
    acc: fresh.acc, role: 'admin', vaults: brains,
    devices: [...keep, { dev: fresh.dev, enc: p.enc, sig_pk: p.sig_pk, added: t, verified: true }],
  })
  const seed = recoverySigningKey(sheet.ageSecret)
  const { roster, rotated } = nextRoster(prev, { members, rotate: brains }, { kind: 'recovery', seed, pk: ed25519.getPublicKey(seed) }, t)
  const contentKeys: Record<string, Uint8Array> = {}
  for (const v of rotated) contentKeys[v] = newContentKey(random)
  return { roster, contentKeys }
}

export async function rewrapOld(
  r: Roster, keywrap: Uint8Array, currentVersion: number, identity: string,
  author: { kid: string; seed: Uint8Array }, random: Random,
): Promise<{ object: string; data: Uint8Array; sig: Uint8Array }> {
  const ck = await openKeyWrap(keywrap, identity)
  const head = JSON.parse(new TextDecoder().decode(keywrap.subarray(0, keywrap.indexOf(0x0a))))
  return wrapEpoch(r, head.vault, head.epoch, ck, currentVersion + 1, author, random)
}


const LOCAL_AAD = utf8('agent-sealed/1 local')

export function encodeIdentityFile(id: Identity, protect: Protect, kek: Uint8Array, kekField: string | null, nonce: Uint8Array): string {
  if (kek.length !== 32 || nonce.length !== 12) throw new Error('kek')
  const data = chacha20poly1305(kek, nonce, LOCAL_AAD).encrypt(utf8(canonical(id)))
  return canonical({ v: 1, protect, kek: kekField, nonce: b64Encode(nonce), data: b64Encode(data) })
}

export async function decodeIdentityFile(
  text: string, kekOf: (outer: { protect: Protect; kek: string | null }) => Promise<Uint8Array>,
): Promise<Identity> {
  const outer = JSON.parse(text)
  if (canonical(outer) !== text.trim()) throw new Error('identity file')
  if (Object.keys(outer).sort().join(',') !== 'data,kek,nonce,protect,v' || outer.v !== 1) throw new Error('identity file')
  if (!['dpapi', 'keychain', 'none'].includes(outer.protect)) throw new Error('identity file')
  const kek = await kekOf(outer)
  const plain = chacha20poly1305(kek, b64Decode(outer.nonce), LOCAL_AAD).decrypt(b64Decode(outer.data))
  const text2 = new TextDecoder('utf-8', { fatal: true }).decode(plain)
  const id = JSON.parse(text2) as Identity
  if (canonical(id) !== text2) throw new Error('identity file')
  if (Object.keys(id).sort().join(',') !== 'acc,dev,enc_sk,org,project_key,sig_seed,t,v' || id.v !== 1) throw new Error('identity file')
  ageSecretBytes(id.enc_sk)
  strict32(id.sig_seed, 'sig_seed')
  strict32(id.project_key, 'project_key')
  return id
}

const DPAPI_PROTECT =
  "Add-Type -AssemblyName System.Security; $e=[Text.Encoding]::ASCII.GetBytes('agent-sealed/1'); $k=New-Object byte[] 32; " +
  '[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($k); ' +
  "$p=[Security.Cryptography.ProtectedData]::Protect($k,$e,'CurrentUser'); " +
  "[Console]::Out.Write([Convert]::ToBase64String($k)+' '+[Convert]::ToBase64String($p))"
const DPAPI_UNPROTECT =
  "& { param($b) Add-Type -AssemblyName System.Security; $e=[Text.Encoding]::ASCII.GetBytes('agent-sealed/1'); " +
  "$k=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($b),$e,'CurrentUser'); " +
  '[Console]::Out.Write([Convert]::ToBase64String($k)) }'

async function runArgv($: EngineInterface, argv: string[]): Promise<string | null> {
  try {
    const r: any = await $.process.run(argv, { cwd: $.plugin.root, timeoutMs: 20000 })
    return r && r.exitCode === 0 && r.isStdoutTruncated !== true ? String(r.stdout ?? '') : null
  } catch {
    return null
  }
}

async function protectionOf($: EngineInterface): Promise<Protect> {
  let os = ''
  try {
    os = String((await $.env.get('OS')) ?? '')
  } catch {}
  if (os === 'Windows_NT') return 'dpapi'
  const u = await runArgv($, ['uname', '-s'])
  return u !== null && u.trim() === 'Darwin' ? 'keychain' : 'none'
}

async function identityPaths($: EngineInterface, org: string): Promise<string[]> {
  if (!SEALED_ID_RX.test(org)) throw new Error('org')
  const dir = `${await dataDir($)}/sealed`
  return [`${dir}/identity.bin`, `${dir}/identity-${org}.bin`]
}

async function kekFor($: EngineInterface, outer: { protect: Protect; kek: string | null }, org: string, dev: string): Promise<Uint8Array> {
  if (outer.protect === 'none') return strict32(outer.kek, 'kek')
  if (outer.protect === 'dpapi') {
    const blob = String(outer.kek ?? '')
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) throw new Error('kek')
    const out = await runArgv($, ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', DPAPI_UNPROTECT, blob])
    if (out === null) throw new Error('dpapi')
    return strict32(out.trim(), 'kek')
  }
  const out = await runArgv($, ['security', 'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', `${org}/${dev}`, '-w'])
  if (out === null || !/^[0-9a-f]{64}$/.test(out.trim())) throw new Error('keychain')
  return Uint8Array.from(out.trim().match(/../g)!.map((x) => parseInt(x, 16)))
}

export async function loadIdentity($: EngineInterface, org?: string): Promise<Identity | null> {
  const dir = `${await dataDir($)}/sealed`
  const paths = org ? await identityPaths($, org) : [`${dir}/identity.bin`]
  for (const path of paths) {
    let text: string
    try {
      if ((await $.fs.exists(path)) !== true) continue
      text = String(await $.fs.read(path))
    } catch {
      continue
    }
    const tryOpen = async (o: string, d: string) => decodeIdentityFile(text, (outer) => kekFor($, outer, o, d))
    let id: Identity | null = null
    try {
      const outer = JSON.parse(text)
      if (outer.protect === 'keychain') {
        const side = JSON.parse(String(await $.fs.read(`${path}.who`)))
        id = await tryOpen(String(side.org), String(side.dev))
      } else {
        id = await tryOpen('', '')
      }
    } catch {
      id = null
    }
    if (id && (!org || id.org === org)) return id
  }
  return null
}

export async function saveIdentity($: EngineInterface, id: Identity, random: Random): Promise<Protect> {
  const [first, perOrg] = await identityPaths($, id.org)
  let path = first
  if ((await $.fs.exists(first)) === true) {
    const there = await loadIdentity($, id.org)
    if (there && there.org === id.org) throw new Error('identity exists')
    path = perOrg
    if ((await $.fs.exists(perOrg)) === true) throw new Error('identity exists')
  }
  let protect = await protectionOf($)
  let kek: Uint8Array | null = null
  let field: string | null = null
  if (protect === 'dpapi') {
    const out = await runArgv($, ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', DPAPI_PROTECT])
    const parts = out === null ? [] : out.trim().split(' ')
    try {
      if (parts.length !== 2) throw new Error('dpapi')
      kek = strict32(parts[0], 'kek')
      field = parts[1]
    } catch {
      protect = 'none'
    }
  } else if (protect === 'keychain') {
    kek = drawN(random, 32)
    const ok = await runArgv($, ['security', 'add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', `${id.org}/${id.dev}`, '-w', hex(kek)])
    if (ok === null) protect = 'none'
    field = null
  }
  if (protect === 'none') {
    kek = drawN(random, 32)
    field = b64Encode(kek)
  }
  const text = encodeIdentityFile(id, protect, kek as Uint8Array, field, drawN(random, 12))
  if (protect === 'keychain') await $.fs.write(`${path}.who`, canonical({ v: 1, org: id.org, dev: id.dev }))
  await $.fs.write(path, text)
  return protect
}
