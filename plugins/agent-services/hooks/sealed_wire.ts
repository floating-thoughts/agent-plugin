import type { EngineInterface } from 'claude-code'
import { b64Decode, b64Encode, defaultRandom, hex, keyId } from './e2e'
import { sha256 } from './noble.js'
import { SEALED_ANCHOR_KEYS } from './contract'
import { primeSealedDeny, sealedDeny } from './sealed_deny'
import { keywrapObjectId, openKeyWrap, sealNames, splitObject, verifyObject } from './sealed_crypto'
import {
  checkRecoverySheet, confirmsRecovery, enrollRecord, enrollSafetyCode, identityPublic, loadIdentity, memberFromEnroll,
  newContentKey, newIdentity, newRecovery, parseRecoveryFile, recoveryFileText, recoveryRoster, saveIdentity,
  rewrapOld, signingSeed, wrapEpoch, type Enroll, type Identity,
} from './sealed_keys'
import { acceptRoster, firstRoster, kidOf, nextRoster, parseRoster, pinFromEnrollment, readersOf, recordHash, writerOf, type Pin, type Roster } from './sealed_roster'
import {
  appendEntry, BATCH_OBJECT_MAX, BATCH_PLAIN_MAX, checkpointDue, dropTail, headOf, newSegmentId, noteTail, openBody,
  parseSegment, receiptEntry, segmentPath, segmentProblems, sealBatch, segmentText, sendCheckpoint, tailsDue, type Entry,
  type Receipt, type Src,
} from './ledger'
import { bundleReport, bundleText, exportGaps, exportLedger, parseBundle, pinnedRosterCheck, verdictWord, verifyBundle, type VerifyOptions } from './ledger_export'
import { BRAIN_RULES, collect, shareCandidates, type Rules } from './brain_collect'
import { buildPack, parseReview, publishPack, readInbox, reviewFile, workFile, type DraftItem, type GetAnswer } from './brain_review'
import { brainTerms, companyAnswer, mergeIndex, serveBrain, type CompanyEntry } from './brain_serve'
import type { ScrubOpts } from './brain_scrub'
import { vaultMask } from './vault'
import { redact } from './redact'
import { rulesTable } from './rules'
import { setDecideShare, taskStateToolSpec } from './task_state'
import { jobsDir, setTaskTap, type TaskTap } from './task_state_io'
import { setAuditTap } from './audit_log'
import { dataDir, engineDirs } from './engine_env'
import { orgAdmin } from './org'
import { engineStore } from './store'
import { folderSend, SealedFolderError, type FolderFs } from './sealed_folder'
import { acceptKits, kitVaultIds, type Pins } from './ckit'
import { exportKits } from './ckit_export'

type Obj = Record<string, any>
type Result = { ok: boolean; body: unknown; error: string | null }
type SvcLike = {
  call(method: string, path: string, body?: unknown): Promise<Result>; status(): Promise<Record<string, unknown>>
  graceUntil?(): Promise<number | null>
}
type Rt = { svc: SvcLike; session: string } | null
export type SealedState = {
  v: 1; org: string; acc: string; dev: string; role: 'admin' | 'member'; on: boolean
  ledger?: string | null; brain?: string | null; brain_name?: string | null
}

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const scrub = (s: string): string => redact(vaultMask(s))
const nowS = (): number => Math.floor(Date.now() / 1000)
const slashed = (p: string): string => String(p).replace(/\\/g, '/').replace(/\/+$/, '')


export function sealedAction(sub: string, rest: string[]): string | null {
  const w = String(rest?.[0] ?? '').toLowerCase()
  const words: Record<string, string[]> = {
    brain: ['setup', 'members', 'distill', 'review', 'publish', 'recover', 'leave', 'storage'],
    ledger: ['export', 'verify', 'status'],
    kit: ['accept', 'export', 'status'],
  }
  const list = words[String(sub).toLowerCase()]
  return list && list.includes(w) ? `${String(sub).toLowerCase()} ${w}` : null
}

export function sealedOn(st: unknown): boolean {
  return isObj(st) && st.v === 1 && st.on === true && typeof st.org === 'string' && typeof st.acc === 'string' &&
    typeof st.dev === 'string' && (st.role === 'admin' || st.role === 'member')
}

function keepDeny(e: Obj): string | null {
  try {
    const tool = String(e?.tool ?? '')
    const path = slashed(String(e?.file_path ?? e?.path ?? e?.notebook_path ?? '')).toLowerCase()
    const review = (s: string) => /brain-work\/[^/\s'"]*\.review\.md/i.test(s)
    const keep = (s: unknown) => typeof s === 'string' && /decision["'`]?\s*[:=]\s*(?:[|>][-+]?\s*)?["'`]?\s*keep\b/i.test(s)
    let hit = false
    if (review(path)) {
      if (keep(e.content) || keep(e.new_string) || keep(e.new_source)) hit = true
      if (Array.isArray(e.edits) && e.edits.some((x: Obj) => keep(x?.new_string))) hit = true
    }
    if (!hit && /^(bash|powershell)$/i.test(tool)) {
      const cmd = slashed(String(e.command ?? ''))
      hit = review(cmd) && /keep/i.test(cmd)
    }
    if (!hit) return null
    return 'Only a person sets `decision: keep` in a company brain review file; a hard-coded local rule refuses it ' +
      'for every agent. Leave every item at drop, and tell the user which items you recommend keeping and why; they ' +
      'edit the file themselves, then type /agent-services brain publish.'
  } catch {
    return null
  }
}

export function sealedGate(e: Obj): string | null {
  return sealedDeny(e) ?? keepDeny(e)
}

export function ledgerText(text: string, ev: { seg?: string; session: string; agent: string; src: Src; body: Obj }, head: Obj | null): { text: string; head: Obj } {
  const seg = parseSegment(String(text ?? ''))
  const segId = seg.length ? seg[0]!.seg : ev.seg ?? newSegmentId(defaultRandom)
  const who = { session: String(ev.session ?? ''), agent: String(ev.agent ?? '') }
  if (!seg.length) appendEntry(seg, { seg: segId, ...who, src: 'open', body: openBody(isObj(head) ? head as any : null) }, defaultRandom, nowS, scrub)
  const e = appendEntry(seg, { ...who, src: ev.src, body: ev.body }, defaultRandom, nowS, scrub)
  return { text: segmentText(seg), head: headOf(e) }
}

export function ledgerProblems(text: string): string[] {
  return segmentProblems(parseSegment(String(text ?? '')))
}


let company: CompanyEntry[] | null = null

export function companyNow(): CompanyEntry[] | null {
  return company
}

export function companyIndex(answer: unknown): unknown {
  return company && company.length ? mergeIndex(answer, company) : answer
}

export function companyKey(key: string): Obj | null {
  return company && company.length ? companyAnswer(company, key) : null
}


type Io = {
  get(k: string): Promise<unknown>; set(k: string, v: string): Promise<void>; del(k: string): Promise<void>
  read(p: string): Promise<string>; list(p: string): Promise<{ name: string }[]>; write(p: string, t: string): Promise<void>
}

function ioOf($: EngineInterface): Io {
  return {
    get: async (k) => $.store.get(k),
    set: async (k, v) => void (await $.store.set(k, v as any)),
    del: async (k) => void (await $.store.delete(k)),
    read: async (p) => String(await $.fs.read(p)),
    list: async (p) => ((await $.fs.list(p)) as any[]).map((x) => ({ name: String(x?.name) })),
    write: async (p, t) => void (await $.fs.write(p, t)),
  }
}

async function readState(io: Io): Promise<SealedState | null> {
  try {
    const v = await io.get('sealed_state')
    const st = typeof v === 'string' ? JSON.parse(v) : v
    return sealedOn(st) ? (st as SealedState) : null
  } catch {
    return null
  }
}

async function getJson(io: Io, k: string): Promise<any> {
  try {
    const v = await io.get(k)
    return typeof v === 'string' ? JSON.parse(v) : v ?? null
  } catch {
    return null
  }
}

async function putJson(io: Io, k: string, v: unknown): Promise<void> {
  try {
    await io.set(k, JSON.stringify(v))
  } catch {}
}

class RouteError extends Error {
  constructor(code: string) {
    super(code)
    this.name = 'RouteError'
  }
}

async function ownStorage(io: Io): Promise<{ folder: string; org: string } | null> {
  const s = await getJson(io, 'sealed_storage')
  return isObj(s) && s.mode === 'own' && typeof s.folder === 'string' && s.folder && typeof s.org === 'string' ? { folder: s.folder, org: s.org } : null
}

function engineFolderFs(io: Io): FolderFs {
  return { read: (p) => io.read(p), list: (p) => io.list(p), write: (p, text) => io.write(p, text) }
}

function poster(io: Io, svc: SvcLike) {
  let folder: Promise<((route: string, body: Obj) => Promise<unknown>) | null> | null = null
  return async (route: string, body: Record<string, unknown>): Promise<unknown> => {
    folder ??= ownStorage(io).then((o) => (o ? folderSend({ fs: engineFolderFs(io), root: o.folder, org: o.org }) : null))
    const f = await folder
    if (f && ['/sealed/put', '/sealed/list', '/sealed/get', '/sealed/roster', '/sealed/roster/put', '/sealed/pending', '/sealed/enroll'].includes(route)) {
      try {
        return await f(route, body)
      } catch (e) {
        throw new RouteError(e instanceof SealedFolderError ? e.code : 'folder_failed')
      }
    }
    const r = await svc.call('POST', route, body)
    if (r.ok) return r.body
    if (r.error === 'sealed_off') {
      const st = await readState(io)
      if (st) await putJson(io, 'sealed_state', { ...st, on: false })
      off()
    }
    throw new RouteError(String(r.error ?? 'failed'))
  }
}

let idCache: Identity | null = null
async function identity($: EngineInterface, org: string): Promise<Identity | null> {
  if (idCache && idCache.org === org) return idCache
  idCache = await loadIdentity($, org).catch(() => null)
  return idCache
}

async function roster(io: Io, post: ReturnType<typeof poster>): Promise<Roster | null> {
  const pin = (await getJson(io, 'sealed_pin')) as Pin | null
  const held = parseRoster(await getJson(io, 'sealed_roster'))
  if (!pin || !held) return held
  try {
    const got = (await post('/sealed/roster', { since_seq: pin.seq })) as Obj
    const newer = Array.isArray(got?.rosters) ? got.rosters : []
    if (!newer.length) return held
    const a = acceptRoster(pin, [held, ...newer])
    if (!a.ok) return held
    await putJson(io, 'sealed_pin', a.pin)
    await putJson(io, 'sealed_roster', a.roster)
    return a.roster
  } catch {
    return held
  }
}

async function keep(io: Io, r: Roster): Promise<void> {
  await putJson(io, 'sealed_pin', { org: r.org, seq: r.seq, h: recordHash(r), root: r.root })
  await putJson(io, 'sealed_roster', r)
}

const anchors = (): Record<string, Uint8Array> => {
  const out: Record<string, Uint8Array> = {}
  for (const k of SEALED_ANCHOR_KEYS as readonly string[]) {
    try {
      const pk = b64Decode(k)
      out[keyId(pk)] = pk
    } catch {}
  }
  return out
}


type Seg = { id: string; entries: Entry[]; path: string | null; nextFrom: number; lastAt: number }
let seg: Seg | null = null
let lock: Promise<unknown> = Promise.resolve()
let live: { io: Io; rt: Promise<Rt>; st: SealedState; home: string; dir: string | null } | null = null

function off(): void {
  live = null
  company = null
  setAuditTap(null)
  setTaskTap(null)
  setDecideShare(false)
}

function segmentOf(dir: string | null): Seg {
  if (seg) return seg
  const id = newSegmentId(defaultRandom)
  seg = { id, entries: [], path: dir ? `${slashed(dir)}/${segmentPath(id)}` : null, nextFrom: 1, lastAt: Date.now() }
  return seg
}

function ledgerAdd(src: Src, body: Obj, agent: string, turnEnd = false): Promise<void> {
  return serial(async () => {
    const l = live
    if (!l) return
    const io = l.io
    const s = segmentOf(l.dir)
    const rt = await l.rt
    const who = { session: rt?.session ?? '', agent }
    if (!s.entries.length) appendEntry(s.entries, { seg: s.id, ...who, src: 'open', body: openBody(await getJson(io, 'ledger_head')) }, defaultRandom, nowS, scrub)
    if (src !== 'open') appendEntry(s.entries, { ...who, src, body }, defaultRandom, nowS, scrub)
    await flush(io, s)
    await checkpoint(io, s, rt, turnEnd)
  })
}

async function flush(io: Io, s: Seg): Promise<void> {
  if (!s.path || !s.entries.length) return
  await io.write(s.path, segmentText(s.entries))
  await putJson(io, 'ledger_head', headOf(s.entries[s.entries.length - 1]!))
  await noteSeg(io, s, false)
}

async function noteSeg(io: Io, s: Seg, end: boolean): Promise<void> {
  if (!s.path || !live) return
  const list = await getJson(io, 'ledger_tails')
  const done = end && s.nextFrom > (s.entries[s.entries.length - 1]?.seq ?? 0)
  await putJson(io, 'ledger_tails', done ? dropTail(list, s.id) : noteTail(list, { seg: s.id, path: s.path, next: s.nextFrom, at: nowS(), end, org: live.st.org }))
}

function serial(fn: () => Promise<void>): Promise<void> {
  const done = lock.then(fn, fn).catch(() => undefined)
  lock = done
  return done
}

async function catchUp(io: Io, rt: Rt): Promise<void> {
  const l = live
  if (!l || !rt) return
  for (const t of tailsDue(await getJson(io, 'ledger_tails'), nowS(), l.st.org, seg?.id ?? null).slice(0, 4)) {
    let entries: Entry[] = []
    try {
      entries = parseSegment(await io.read(t.path))
    } catch {}
    const s: Seg = { id: t.seg, entries, path: t.path, nextFrom: t.next, lastAt: 0 }
    const intact = entries.length > 0 && entries[0].seg === t.seg && !segmentProblems(entries).length
    const gap = intact ? await checkpoint(io, s, rt, true, false) : true
    const list = await getJson(io, 'ledger_tails')
    const last = entries[entries.length - 1]?.seq ?? 0
    await putJson(io, 'ledger_tails', gap || s.nextFrom > last ? dropTail(list, t.seg) : noteTail(list, { ...t, next: s.nextFrom }))
  }
}

async function checkpoint(io: Io, s: Seg, rt: Rt, turnEnd: boolean, receipts = true): Promise<boolean> {
  const l = live
  if (!l || !rt || !l.st.ledger) return false
  const first = checkpointDue(s.entries, { nextFrom: s.nextFrom, lastAt: Math.floor(s.lastAt / 1000) }, nowS(), turnEnd)
  if (!first) return false
  const id = idCache && idCache.org === l.st.org ? idCache : null
  const post = poster(io, rt.svc)
  const r = id ? await roster(io, post) : null
  const v = r?.vaults.find((x) => x.id === l.st.ledger)
  if (!id || !r || !v) return false
  const seed = signingSeed(id)
  const by = kidOf(identityPublic(id).sig_pk)
  const own = !!(await ownStorage(io))
  let maxBytes = BATCH_PLAIN_MAX
  for (let round = 0; round < 16; round++) {
    const due = round === 0 && maxBytes === BATCH_PLAIN_MAX ? first
      : checkpointDue(s.entries, { nextFrom: s.nextFrom, lastAt: Math.floor(s.lastAt / 1000) }, nowS(), true, maxBytes)
    if (!due) return false
    const batch = { org: l.st.org, vault: v.id, epoch: v.epoch, seed, recipients: readersOf(r, v.id, 'ledger', by), entries: s.entries, seqFrom: due.seqFrom, seqTo: due.seqTo }
    try {
      if (own) {
        const b = await sealBatch(batch, defaultRandom)
        await putObject(post, v.id, 'ledger', b.id, v.epoch, 1, b.object, b.sig)
        s.nextFrom = due.seqTo + 1
        s.lastAt = Date.now()
        if (receipts) await noteSeg(io, s, false)
      } else {
        const probe = await sealBatch(batch, defaultRandom)
        if (probe.object.length > BATCH_OBJECT_MAX) {
          if (due.seqTo === due.seqFrom || maxBytes < 1024) throw new Error('ledger: batch object too large')
          maxBytes = Math.floor(maxBytes / 2)
          continue
        }
        const last = (await getJson(io, 'ledger_receipt')) as Receipt | null
        const sent = await sendCheckpoint({
          ...batch, acc: l.st.acc, dev: l.st.dev, seg: s.id, t: nowS(), anchors: anchors(),
          ...(last ? { lastReceipt: last } : {}),
        }, post, defaultRandom)
        s.nextFrom = due.seqTo + 1
        s.lastAt = Date.now()
        await putJson(io, 'ledger_receipt', sent.receipt)
        if (receipts) {
          receiptEntry(s.entries, sent.receipt, { session: rt.session, agent: '' }, defaultRandom, nowS)
          await flush(io, s)
        }
      }
    } catch (err) {
      s.lastAt = Date.now()
      if (err instanceof RouteError && err.message === 'checkpoint_gap' && seg === s) seg = null
      return err instanceof RouteError && err.message === 'checkpoint_gap'
    }
    if (!due.more) return false
  }
  return false
}


export async function brainScrubOpts(home: string, r: Roster, terms: string[] | null): Promise<ScrubOpts | null> {
  if (terms === null) return null
  return { home, names: r.members.map((m) => m.acc), terms }
}

async function companyTerms(post: ReturnType<typeof poster>, st: SealedState, id: Identity, r: Roster): Promise<string[] | null> {
  if (!st.brain) return []
  const v = r.vaults.find((x) => x.id === st.brain)
  if (!v) return []
  try {
    return await brainTerms({ org: st.org, vault: v.id, roster: r, identity: id.enc_sk }, post)
  } catch {
    return null
  }
}


async function brainShare(io: Io, entry: { kind: 'lesson' | 'decision'; grade?: string | null; text: string; share?: boolean }, root: string | null): Promise<void> {
  const l = live
  if (!l || !l.st.brain) return
  const rt = await l.rt
  const id = idCache && idCache.org === l.st.org ? idCache : null
  if (!rt || !id) return
  const post = poster(io, rt.svc)
  const r = await roster(io, post)
  if (!r) return
  const day = new Date().toISOString().slice(0, 10)
  const shared = await getJson(io, 'brain_shared')
  const today = isObj(shared) && shared.day === day && Number.isInteger(shared.n) ? shared.n : 0
  const opts = await brainScrubOpts(l.home, r, await companyTerms(post, l.st, id, r))
  if (!opts) return
  const got = collect([entry], {
    rules: rulesTable<Rules>('brain') ?? BRAIN_RULES, scrub: opts, shared_today: today,
    project_key: b64Decode(id.project_key), project_root: root ?? '', random: defaultRandom, clock: nowS,
  })
  if (!got.candidates.length) return
  const sent = await shareCandidates(got.candidates, { org: l.st.org, vault: l.st.brain, roster: r, seed: signingSeed(id) }, post, defaultRandom)
  const ids = isObj(shared) && Array.isArray(shared.ids) ? shared.ids.slice(-200) : []
  await putJson(io, 'brain_shared', { day, n: today + sent.length, ids: [...ids, ...sent.map((x) => x.cand)] })
}

const taskTap: TaskTap = (ev) => {
  const l = live
  if (!l) return
  const io = l.io
  void (async () => {
    const i: Obj = isObj(ev.input) ? ev.input : {}
    if (ev.op === 'decide' && ev.line) {
      await ledgerAdd('decision', { line: ev.line }, '')
      if (i.share === true) await brainShare(io, { kind: 'decision', text: ev.line, share: true }, ev.dir ?? null)
    } else if (ev.op === 'lesson' && ev.line) {
      const grade = /^\[(E[0-3])\]/.exec(ev.line)?.[1] ?? null
      await brainShare(io, { kind: 'lesson', grade, text: ev.line }, ev.dir ?? null)
    } else if (ev.op === 'effect_begin' || ev.op === 'effect_done') {
      await ledgerAdd('effect', {
        key: String(i.key ?? ''), kind: String(i.kind ?? ''), state: ev.op === 'effect_begin' ? 'started' : String(i.state ?? ''),
        request: String(i.request ?? i.detail ?? ''),
      }, '')
    } else if (ev.op === 'deliver') {
      const files = Array.isArray(i.files) ? i.files.map((f: unknown) => (isObj(f) ? String(f.path ?? '') : String(f))).slice(0, 50) : []
      await ledgerAdd('delivery', { summary: String(i.summary ?? ''), files, tests: '' }, '')
    }
  })().catch(() => undefined)
}


export async function sealedStart($: EngineInterface, rt: Promise<Rt> | Rt): Promise<void> {
  try {
    void primeSealedDeny($)
    const io = ioOf($)
    const st = await readState(io)
    if (!st) return
    const r = await rt
    if (!r) return
    await licenseNotice($, io, st, r.svc)
    await identity($, st.org)
    live = { io, rt: Promise.resolve(r), st, home: (await engineDirs($)).home, dir: await jobsDir($) }
    setAuditTap((line) => void ledgerAdd('audit', line, String(line?.a ?? '')))
    setTaskTap(taskTap)
    setDecideShare(true)
    try {
      await $.tool.register({ ...taskStateToolSpec(), isDeferred: false } as any)
    } catch {}
    void serial(() => catchUp(io, r))
    void ledgerAdd('open', {}, '')
    const id = await identity($, st.org)
    const post = poster(io, r.svc)
    const ros = id ? await roster(io, post) : null
    if (!id || !ros) return
    const entries = await serveAll(io, st, id, ros, post)
    if (!live) return
    company = entries.length ? entries : null
    if (!isAdmin(ros, st)) return
    const n = waitingParts(await post('/sealed/kit/list', {}).catch(() => null))
    if (n > 0) $.ui.log(kitWaitingNotice(n))
  } catch {}
}


export function kitWaitingNotice(n: number): string {
  const one = n === 1
  return `${n} company kit part${one ? '' : 's'} from agent-services ${one ? 'waits' : 'wait'} for a company admin: ` +
    `type /agent-services kit accept to add ${one ? 'it' : 'them'} to your company brain.`
}

export function kitLicenseNotice(by: string): string {
  return "Your company's agent-services license ended. As a company admin, export your company kit and company brain " +
    `with /agent-services kit export <folder> within 30 days of the license end (no later than ${by}); after that ` +
    'agent-services erases its copy.'
}

let testKitKeys: Record<string, string> | undefined

export function kitKeysForTest(keys: Record<string, string> | undefined): void {
  testKitKeys = keys
}

const isAdmin = (r: Roster | null, st: SealedState): boolean => !!r && r.members.some((m) => m.acc === st.acc && m.role === 'admin')

function waitingParts(ans: unknown): number {
  const raw = isObj(ans) ? (ans.kits ?? ans.parts) : null
  return Array.isArray(raw) ? raw.filter((k) => isObj(k) && k.state !== 'reseal').length : 0
}

async function kitPins(io: Io): Promise<Pins> {
  const p = await getJson(io, 'ckit_pin')
  const out: Pins = {}
  if (isObj(p)) for (const [k, v] of Object.entries(p)) if (typeof v === 'string') out[k] = v
  return out
}

async function licenseNotice($: EngineInterface, io: Io, st: SealedState, svc: SvcLike): Promise<void> {
  try {
    const line = await kitGraceLine(svc)
    if (line === null || !isAdmin(parseRoster(await getJson(io, 'sealed_roster')), st)) return
    $.ui.log(line)
  } catch {}
}

export async function kitGraceLine(svc: SvcLike | null | undefined): Promise<string | null> {
  try {
    const until = svc && typeof svc.graceUntil === 'function' ? await svc.graceUntil() : null
    return typeof until === 'number' && Number.isFinite(until) ? kitLicenseNotice(new Date(until).toISOString().slice(0, 10)) : null
  } catch {
    return null
  }
}

async function serveAll(io: Io, st: SealedState, id: Identity, ros: Roster, post: ReturnType<typeof poster>): Promise<CompanyEntry[]> {
  const pin = await getJson(io, 'sealed_brain_pin')
  const pins: Obj = isObj(pin) ? { ...pin } : {}
  const out: CompanyEntry[] = []
  const vaults = ros.vaults.filter((v) => v.kind === 'brain').sort((a, b) => Number(b.id === st.brain) - Number(a.id === st.brain))
  for (const v of vaults) {
    if (out.length >= 10) break
    const pinned = Number.isInteger(pins[v.id]) ? pins[v.id] : 0
    const got = await serveBrain({ org: st.org, vault: v.id, roster: ros, identity: id.enc_sk, pinnedVersion: pinned }, post)
    if (!got.ok || out.some((e) => e.key === got.entry.key)) continue
    if (v.id !== st.brain && !got.entry.key.startsWith('co-kit-')) continue
    out.push(got.entry)
    pins[v.id] = Math.max(pinned, got.version)
  }
  if (out.length) await putJson(io, 'sealed_brain_pin', pins)
  return out
}

async function kitAccept($: EngineInterface, post: ReturnType<typeof poster>): Promise<string> {
  const { st, id, r } = await adminCtx($, post)
  if (!isAdmin(r, st)) return 'Only a company admin accepts company kits; nothing was sent.'
  const io = ioOf($)
  const out = await acceptKits({ org: st.org, identity: id, roster: r, keys: testKitKeys, pins: await kitPins(io), random: defaultRandom, t: nowS() }, post)
  await putJson(io, 'ckit_pin', out.pins)
  if (out.roster.seq !== r.seq) {
    await keep(io, out.roster)
    void ledgerAdd('roster', { seq: out.roster.seq, h: recordHash(out.roster), change: 'company kit vaults added' }, '')
  }
  if (out.accepted.length && live) {
    const entries = await serveAll(io, st, id, out.roster, post)
    company = entries.length ? entries : null
  }
  const lines: string[] = []
  if (out.accepted.length) {
    lines.push(`Accepted ${out.accepted.length} company kit part(s): ${out.accepted.map((a) => `co-${a.vault} v${a.version}`).join(', ')}. ` +
      'They are in your company brain now, readable by every member, and served to each member\'s Claude through the toolbox.')
  }
  if (out.reseal.length) {
    lines.push(`${out.reseal.length} part(s) were sealed to an earlier list of admin devices, so this computer cannot open them; ` +
      'agent-services seals them again to the current admins. Type /agent-services kit accept again later.')
  }
  if (out.refused.length) {
    lines.push(`${out.refused.length} part(s) were refused (${[...new Set(out.refused.map((x) => x.code))].join(', ')}) and nothing was ` +
      'written for them; tell agent-services support.')
    if (out.refused.some((x) => x.code === 'roster' || x.code === 'keywrap')) lines.push('A roster or key-wrap write failed; type /agent-services kit accept again to retry.')
  }
  return lines.length ? lines.join('\n') : 'No company kit is waiting for your company.'
}

async function kitExport($: EngineInterface, post: ReturnType<typeof poster>, args: string[]): Promise<string> {
  const folder = slashed(args.join(' ').trim())
  if (!folder) return USAGE
  const { st, id, r } = await adminCtx($, post)
  if (!isAdmin(r, st)) return 'Only a company admin exports the company kits; nothing was sent.'
  const later: Obj[] = []
  const send = async (route: string, body: Obj): Promise<unknown> => (route === '/sealed/kit/exported' ? (later.push(body), {}) : post(route, body))
  const out = await exportKits({ org: st.org, identity: id, roster: r, t: nowS() }, send)
  const paths = Object.keys(out.files)
  if (paths.length <= 1) return 'Nothing to export: no company kit or company brain could be read on this computer.'
  for (const p of paths) await $.fs.write(`${folder}/${p}`, out.files[p]!)
  for (const b of later) await post('/sealed/kit/exported', b)
  const packs = paths.filter((p) => p.endsWith('/SKILL.md')).length
  return `Wrote ${packs} company pack(s) to ${folder}: one folder each with SKILL.md (a Claude Code skill) and kit.json, ` +
    'and MANIFEST.txt with the sha256 of every file. The files stay readable without agent-services.' +
    (out.kits.length ? ` Company kits: ${out.kits.map((k) => `${k.key} v${k.version}`).join(', ')}.` : '')
}

async function kitStatus($: EngineInterface, post: ReturnType<typeof poster>, svc?: SvcLike): Promise<string> {
  const io = ioOf($)
  const st = await readState(io)
  if (!st) return 'Company kits are off on this computer (the company brain is not set up here).'
  const pins = await kitPins(io)
  const keys = Object.keys(pins).sort()
  const served = (company ?? []).filter((e) => e.key.startsWith('co-kit-'))
  const lines = [
    keys.length ? `Accepted on this computer: ${keys.map((k) => `${k} v${pins[k]}`).join(', ')}.` : 'No company kit was accepted on this computer.',
    served.length ? `Served this session: ${served.map((e) => `${e.key} (${e.title})`).join(', ')}.` : 'No company kit is served this session.',
  ]
  if (isAdmin(parseRoster(await getJson(io, 'sealed_roster')), st)) {
    const n = await post('/sealed/kit/list', {}).then(waitingParts, () => -1)
    lines.push(n < 0 ? 'The waiting company kits could not be read.' : n ? kitWaitingNotice(n) : 'No company kit is waiting for your company.')
    const grace = await kitGraceLine(svc)
    if (grace) lines.push(grace)
  }
  return lines.join('\n')
}

export function sealedEnd(): Promise<void> {
  return serial(async () => {
    const l = live
    const s = seg
    if (!l || !s) return
    seg = null
    await noteSeg(l.io, s, true)
    if (await checkpoint(l.io, s, await l.rt, true, false)) await putJson(l.io, 'ledger_tails', dropTail(await getJson(l.io, 'ledger_tails'), s.id))
    else await noteSeg(l.io, s, true)
  })
}

export async function sealedTurnEnd($: EngineInterface, e: Obj): Promise<void> {
  try {
    if (!live || e?.agentId || !seg) return
    await ledgerAdd('open', {}, '', true)
  } catch {}
}


const USAGE = 'Usage: /agent-services brain setup [<company id> | <organisation code>] | brain setup confirm <last 6> | ' +
  'brain members [approve <device> | approve-unchecked <device> | remove <account>] | brain distill | ' +
  'brain review <draft file> | brain publish | brain recover <recovery file> | brain leave | ' +
  'brain storage [server | own <folder> <company id>] | ' +
  'ledger export <from YYYY-MM-DD> <to YYYY-MM-DD> | ledger verify <bundle file> | ledger status | ' +
  'kit accept | kit export <folder> | kit status'

export async function sealedCommand($: EngineInterface, svc: SvcLike, sub: string, rest: string[]): Promise<string> {
  const action = sealedAction(sub, rest)
  if (!action) return USAGE
  try {
    const post = poster(ioOf($), svc)
    const args = rest.slice(1)
    switch (action) {
      case 'brain setup': return await brainSetup($, svc, post, args)
      case 'brain members': return await brainMembers($, post, args)
      case 'brain distill': return await brainDistill($, post)
      case 'brain review': return await brainReview($, post, args)
      case 'brain publish': return await brainPublish($, post)
      case 'brain recover': return await brainRecover($, svc, post, args)
      case 'brain leave': return await brainLeave($)
      case 'brain storage': return await brainStorage($, post, args)
      case 'ledger export': return await ledgerExport($, post, args)
      case 'ledger verify': return await ledgerVerify($, args)
      case 'kit accept': return await kitAccept($, post)
      case 'kit export': return await kitExport($, post, args)
      case 'kit status': return await kitStatus($, post, svc)
      default: return await ledgerStatus($)
    }
  } catch (err) {
    const why = err instanceof RouteError ? `the service answered ${err.message}` : scrub(String((err as Error)?.message ?? err)).slice(0, 200)
    return `That did not complete (${why}); nothing more was changed.`
  }
}

const newDev = (): string => 'd-' + hex(defaultRandom(8))
async function docs($: EngineInterface): Promise<string> {
  return `${(await engineDirs($)).home}/Documents`
}
async function recoveryPath($: EngineInterface, org: string): Promise<string> {
  return `${await docs($)}/agent-services-recovery-${org}.txt`
}
async function workDir($: EngineInterface): Promise<string> {
  return `${slashed(await dataDir($))}/brain-work`
}

async function account(svc: SvcLike): Promise<string> {
  const acc = (await svc.status())?.account_id
  if (typeof acc !== 'string' || !acc) throw new Error('not signed in')
  return acc
}

async function brainSetup($: EngineInterface, svc: SvcLike, post: ReturnType<typeof poster>, args: string[]): Promise<string> {
  if (args[0]?.toLowerCase() === 'confirm') return setupConfirm($, svc, post, args[1] ?? '')
  if (await readState(ioOf($))) return 'The company brain and ledger are already set up on this computer (/agent-services ledger status).'
  const acc = await account(svc)
  const code = args.join(' ').trim()
  if (/^\d{5}( \d{5}){5}$/.test(code)) return enrollMember($, post, acc, code)
  const typed = args[0] ?? ''
  if (typed && !/^[A-Za-z0-9_-]{1,64}$/.test(typed)) return 'To set up your company, type /agent-services brain setup; to join it, type /agent-services brain setup <organisation code> (the 30 digits your admin gave you).'
  if (!(await orgAdmin(engineStore($)).catch(() => false))) return 'Only a company admin sets up the brain and ledger; to join, ask your admin for the organisation code.'
  const existing = (await post('/sealed/roster', {})) as Obj
  if (Array.isArray(existing?.rosters) && existing.rosters.length) return 'Your company is already set up; join with /agent-services brain setup <organisation code>.'
  const told = await companyId(post)
  if (typed && told && typed !== told) return `That is not your company's id (the service says ${told}); type /agent-services brain setup without an id to use it.`
  const org = typed || told
  if (!org) return 'The service did not say your company id; type /agent-services brain setup <company id>.'
  const choice = await $.ui.ask('Only your company can read this. If every admin loses their key and the recovery sheet, the brain and ledger are gone for good; agent-services cannot recover them.', { options: ['Set up', 'Cancel'] }).catch(() => 'Cancel')
  if (choice !== 'Set up') return 'Nothing was set up.'
  const id = newIdentity(org, acc, newDev(), defaultRandom)
  const protect = await saveIdentity($, id, defaultRandom)
  idCache = id
  const pub = identityPublic(id)
  const rec = newRecovery(defaultRandom)
  const ledgerVault = hex(defaultRandom(16))
  const brainVault = hex(defaultRandom(16))
  const names = await sealNames({ [ledgerVault]: 'ledger', [brainVault]: org.toLowerCase() }, [pub.enc, rec.enc])
  const r1 = firstRoster({
    org, t: nowS(), names, recovery: { enc: rec.enc, sig_pk: rec.sig_pk },
    admin: { acc, role: 'admin', vaults: [brainVault], devices: [{ dev: id.dev, enc: pub.enc, sig_pk: pub.sig_pk, added: nowS(), verified: true }] },
    vaults: [{ id: ledgerVault, kind: 'ledger', epoch: 1 }, { id: brainVault, kind: 'brain', epoch: 1 }],
  }, signingSeed(id), pub.sigPk)
  const path = await recoveryPath($, org)
  await $.fs.write(path, recoveryFileText(org, new Date().toISOString().slice(0, 10), pub.sigPk, rec.ageSecret))
  await putJson(ioOf($), 'sealed_setup', { v: 1, org, acc, dev: id.dev, roster: r1, ledger: ledgerVault, brain: brainVault, brain_name: brainName(org) })
  return `Your recovery sheet is at ${path} (the key is not shown here). Print it or put it in your password manager, ` +
    `then type /agent-services brain setup confirm <the last 6 characters of the recovery key> to finish. Your key ` +
    `is kept on this computer (${protect === 'none' ? 'a plain file: this system has no key store the plugin can use' : protect}).`
}

async function companyId(post: ReturnType<typeof poster>): Promise<string> {
  try {
    const a = (await post('/sealed/config', {})) as Obj
    return typeof a?.org === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(a.org) ? a.org : ''
  } catch {
    return ''
  }
}

const brainName = (org: string): string => {
  const n = org.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 29)
  return n.length >= 2 ? n : 'company'
}

async function setupConfirm($: EngineInterface, svc: SvcLike, post: ReturnType<typeof poster>, typed: string): Promise<string> {
  const p = await getJson(ioOf($), 'sealed_setup')
  if (!isObj(p)) return 'There is no setup waiting for confirmation; type /agent-services brain setup first.'
  const sheet = parseRecoveryFile(String(await $.fs.read(await recoveryPath($, p.org))))
  if (!confirmsRecovery(typed, sheet.ageSecret)) return 'Those are not the last 6 characters of the recovery key on your sheet; nothing was set up yet.'
  const id = await identity($, p.org)
  const r1 = parseRoster(p.roster)
  if (!id || !r1) throw new Error('the key set of this setup cannot be opened')
  await post('/sealed/enroll', { enroll: enrollRecord(id) })
  await post('/sealed/roster/put', { roster: r1 })
  const ck = newContentKey(defaultRandom)
  const kw = await wrapEpoch(r1, p.brain, 1, ck, 1, { kid: kidOf(identityPublic(id).sig_pk), seed: signingSeed(id) }, defaultRandom)
  await putObject(post, p.brain, 'keywrap', kw.object, 1, 1, kw.data, kw.sig)
  await keep(ioOf($), r1)
  await putJson(ioOf($), 'sealed_state', { v: 1, org: p.org, acc: p.acc, dev: p.dev, role: 'admin', on: true, ledger: p.ledger, brain: p.brain, brain_name: p.brain_name })
  try { await ioOf($).del('sealed_setup') } catch {}
  await sealedStart($, { svc, session: '' })
  void ledgerAdd('roster', { seq: 1, h: recordHash(r1), change: 'company set up' }, '')
  return `Set up. Delete the recovery sheet file from this computer once it is printed or saved. Organisation code for ` +
    `your members: ${sheet.orgCode} (they type /agent-services brain setup <that code>). A second admin is strongly advised.`
}

async function putObject(post: ReturnType<typeof poster>, vault: string, kind: string, object: string, epoch: number, version: number, data: Uint8Array, sig: Uint8Array): Promise<unknown> {
  return post('/sealed/put', { vault, kind, object, epoch, version, sha256: hex(sha256(data)), size: data.length, data_b64: b64Encode(data), sig: b64Encode(sig) })
}

async function enrollMember($: EngineInterface, post: ReturnType<typeof poster>, acc: string, code: string): Promise<string> {
  const got = (await post('/sealed/roster', { since_seq: 0 })) as Obj
  const chain = Array.isArray(got?.rosters) ? got.rosters : []
  if (!chain.length) return 'Your company has not set up its brain yet; ask your admin.'
  const first = pinFromEnrollment(chain[0], code)
  if (!first.ok) return `The organisation code does not match your company's records (${first.reason}); check it with your admin.`
  const a = chain.length > 1 ? acceptRoster(first.pin, chain) : first
  if (!a.ok) return `Your company's records did not verify (${a.reason}); nothing was set up.`
  const r = a.roster
  const id = newIdentity(r.org, acc, newDev(), defaultRandom)
  await saveIdentity($, id, defaultRandom)
  idCache = id
  await post('/sealed/enroll', { enroll: enrollRecord(id) })
  await keep(ioOf($), r)
  const ledger = r.vaults.find((v) => v.kind === 'ledger')?.id ?? null
  const brain = r.vaults.find((v) => v.kind === 'brain')?.id ?? null
  await putJson(ioOf($), 'sealed_state', { v: 1, org: r.org, acc, dev: id.dev, role: 'member', on: true, ledger, brain, brain_name: brainName(r.org) })
  return `Enrolled. Your safety code: ${identityPublic(id).safety}. Read it to your admin by phone or chat; they approve ` +
    'you with /agent-services brain members.'
}

async function adminCtx($: EngineInterface, post: ReturnType<typeof poster>): Promise<{ st: SealedState; id: Identity; r: Roster }> {
  const st = await readState(ioOf($))
  if (!st) throw new Error('the company brain is not set up on this computer')
  const id = await identity($, st.org)
  const r = id ? await roster(ioOf($), post) : null
  if (!id || !r) throw new Error('the key set or the company records cannot be read')
  return { st, id, r }
}

async function brainMembers($: EngineInterface, post: ReturnType<typeof poster>, args: string[]): Promise<string> {
  const { st, id, r } = await adminCtx($, post)
  const me = r.members.find((m) => m.acc === st.acc)
  if (me?.role !== 'admin') return 'Only a company admin manages the brain members.'
  const pending = (((await post('/sealed/pending', {})) as Obj)?.pending ?? []) as Enroll[]
  const verb = (args[0] ?? '').toLowerCase()
  if (!verb) {
    const rows = pending.map((e) => `- account ${e.acc}, device ${e.dev}: safety code ${enrollSafetyCode(e) ?? '(does not verify: do not approve)'}`)
    return [`Members: ${r.members.map((m) => `${m.acc} (${m.role})`).join(', ')}.`, rows.length ? 'Waiting for approval (check each code with the person by phone or chat first):' : 'Nobody is waiting for approval.', ...rows,
      rows.length ? 'Approve with /agent-services brain members approve <device> (or approve-unchecked <device>, recorded as unverified).' : ''].filter(Boolean).join('\n')
  }
  const signer = { kind: 'device' as const, seed: signingSeed(id), pk: identityPublic(id).sigPk }
  const author = { kid: kidOf(identityPublic(id).sig_pk), seed: signingSeed(id) }
  let next: { roster: Roster; rotated: string[] }
  let change: string
  if (verb === 'approve' || verb === 'approve-unchecked') {
    const rec = pending.find((e) => e.dev === args[1])
    if (!rec) return 'No waiting device has that id; type /agent-services brain members to list them.'
    const grant = [...new Set([...(st.brain ? [st.brain] : []), ...(await kitVaultIds(r, id.enc_sk))])]
    const m = memberFromEnroll(rec, 'member', grant, verb === 'approve')
    const old = r.members.find((x) => x.acc === m.acc)
    const members = [...r.members.filter((x) => x.acc !== m.acc), old ? { ...old, devices: [...old.devices, ...m.devices], vaults: [...new Set([...old.vaults, ...grant])] } : m]
    next = nextRoster(r, { members }, signer, nowS())
    change = `${verb === 'approve' ? 'approved' : 'approved unverified'} ${m.acc}/${rec.dev}`
  } else if (verb === 'remove' && args[1]) {
    if (!r.members.some((x) => x.acc === args[1])) return 'That account is not on the company roster.'
    next = nextRoster(r, { members: r.members.filter((x) => x.acc !== args[1]) }, signer, nowS())
    change = `removed ${args[1]}`
  } else return USAGE
  await post('/sealed/roster/put', { roster: next.roster })
  await keep(ioOf($), next.roster)
  for (const v of next.roster.vaults.filter((x) => x.kind === 'brain')) {
    const rotated = next.rotated.includes(v.id)
    const ck = rotated ? newContentKey(defaultRandom) : await currentKey(post, v.id, v.epoch, id)
    const version = rotated ? 1 : (await latestVersion(post, v.id, keywrapObjectId(v.id, v.epoch))) + 1
    const kw = await wrapEpoch(next.roster, v.id, v.epoch, ck, version, author, defaultRandom)
    await putObject(post, v.id, 'keywrap', kw.object, v.epoch, version, kw.data, kw.sig)
  }
  void ledgerAdd('roster', { seq: next.roster.seq, h: recordHash(next.roster), change }, '')
  return `Done: ${change}.${next.rotated.length ? ' The brain moved to a new key; the removed devices cannot read new versions.' : ''}`
}

async function currentKey(post: ReturnType<typeof poster>, vault: string, epoch: number, id: Identity): Promise<Uint8Array> {
  const got = (await post('/sealed/get', { vault, object: keywrapObjectId(vault, epoch) })) as GetAnswer
  return openKeyWrap(b64Decode(got.data_b64), id.enc_sk)
}

async function latestVersion(post: ReturnType<typeof poster>, vault: string, object: string): Promise<number> {
  let best = 0
  let cursor: string | undefined
  for (let page = 0; page < 100; page++) {
    const lst = (await post('/sealed/list', { vault, ...(cursor ? { cursor } : {}) })) as Obj
    for (const it of lst?.items ?? []) if (it?.object === object && Number.isInteger(it.version)) best = Math.max(best, it.version)
    if (!lst?.cursor || lst.cursor === cursor || !(lst.items ?? []).length) break
    cursor = lst.cursor
  }
  return best
}

async function brainDistill($: EngineInterface, post: ReturnType<typeof poster>): Promise<string> {
  const { st, id, r } = await adminCtx($, post)
  if (!st.brain) return 'Your company has no brain vault.'
  const answers: GetAnswer[] = []
  let cursor: string | undefined
  for (let page = 0; page < 100; page++) {
    const lst = (await post('/sealed/list', { vault: st.brain, kinds: ['inbox'], ...(cursor ? { cursor } : {}) })) as Obj
    for (const it of lst?.items ?? []) answers.push((await post('/sealed/get', { vault: st.brain, object: it.object })) as GetAnswer)
    if (!lst?.cursor || lst.cursor === cursor || !(lst.items ?? []).length) break
    cursor = lst.cursor
  }
  const got = await readInbox(answers, { org: st.org, vault: st.brain, roster: r, identity: id.enc_sk })
  if (!got.candidates.length) return `No lessons are waiting to be distilled${got.refused ? ` (${got.refused} could not be opened or verified)` : ''}.`
  const n = (Number(await getJson(ioOf($), 'brain_round')) || 0) + 1
  const w = workFile(st.brain_name ?? 'company', n, got.candidates)
  const path = `${await workDir($)}/${st.brain_name ?? 'company'}-${n}.md`
  await $.fs.write(path, w.text)
  await putJson(ioOf($), 'brain_round', n)
  return `Wrote ${got.candidates.length} candidates to ${path} (local only). Ask Claude to distil it with the ` +
    `company-brain-method toolbox pack into ${path.replace(/\.md$/, '.draft.md')} (one "### <item-id>" block per ` +
    `item, an optional "grade: E2|E3" line, then the text), then type /agent-services brain review ${path.replace(/\.md$/, '.draft.md')}.`
}

function parseDraft(text: string): DraftItem[] {
  const out: DraftItem[] = []
  let cur: { id: string; grade: 'E2' | 'E3' | null; lines: string[] } | null = null
  const close = () => {
    if (cur) out.push({ id: cur.id, grade: cur.grade, text: cur.lines.join('\n').trim() })
  }
  for (const l of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const h = /^###\s+(\S+)\s*$/.exec(l)
    if (h) {
      close()
      cur = { id: h[1]!.toLowerCase(), grade: null, lines: [] }
    } else if (cur && !cur.lines.length && /^grade:\s*(E[23])\s*$/i.test(l)) cur.grade = l.replace(/^grade:\s*/i, '').trim().toUpperCase() as 'E2' | 'E3'
    else if (cur) cur.lines.push(l)
  }
  close()
  return out.filter((x) => x.text)
}

async function brainReview($: EngineInterface, post: ReturnType<typeof poster>, args: string[]): Promise<string> {
  const st = await readState(ioOf($))
  if (!st) return 'The company brain is not set up on this computer.'
  const draftPath = slashed(args.join(' ').trim())
  if (!draftPath) return USAGE
  const items = parseDraft(String(await $.fs.read(draftPath)))
  if (!items.length) return 'The draft has no "### <item-id>" blocks.'
  const { id, r } = await adminCtx($, post)
  const opts = await brainScrubOpts((await engineDirs($)).home, r, await companyTerms(post, st, id, r))
  if (!opts) return 'The company terms list (the brain config) could not be read or verified, so no review file was written; try again later.'
  const path = draftPath.replace(/(\.draft)?\.md$/, '') + '.review.md'
  await $.fs.write(path, reviewFile(items, opts))
  await putJson(ioOf($), 'brain_review', path)
  return `Wrote the review file ${path}: every item starts at "decision: drop". Open it yourself, change "drop" to ` +
    '"keep" on the items to publish (an agent cannot set keep), then type /agent-services brain publish.'
}

async function brainPublish($: EngineInterface, post: ReturnType<typeof poster>): Promise<string> {
  const { st, id, r } = await adminCtx($, post)
  const path = await getJson(ioOf($), 'brain_review')
  if (!st.brain || typeof path !== 'string') return 'There is no review file yet; type /agent-services brain review <draft file> first.'
  const v = r.vaults.find((x) => x.id === st.brain)
  if (!v) throw new Error('the brain vault is not on the roster')
  const object = hex(sha256(new TextEncoder().encode(`agent-sealed/1 brain\n${st.brain}`))).slice(0, 32)
  const version = (await latestVersion(post, st.brain, object)) + 1
  const text = String(await $.fs.read(path))
  const kept = parseReview(text).filter((x) => x.decision === 'keep').length
  const opts = await brainScrubOpts((await engineDirs($)).home, r, await companyTerms(post, st, id, r))
  if (!opts) return 'The company terms list (the brain config) could not be read or verified, so nothing was published; try again later.'
  const pack = buildPack(st.brain_name ?? 'company', text, { title: `Company brain: ${st.brain_name ?? 'company'}`, when: 'Before work where your company\'s shared lessons may apply' }, version, opts)
  const ck = await currentKey(post, v.id, v.epoch, id)
  await publishPack(pack, { org: st.org, vault: v.id, epoch: v.epoch, object, version, ck, seed: signingSeed(id) }, post, defaultRandom)
  return `Published ${pack.items.length} of ${kept} kept items as ${pack.id} version ${pack.version}; members get it at their next session start.`
}

async function brainRecover($: EngineInterface, svc: SvcLike, post: ReturnType<typeof poster>, args: string[]): Promise<string> {
  const file = slashed(args.join(' ').trim())
  if (!file) return USAGE
  const sheet = parseRecoveryFile(String(await $.fs.read(file)))
  const got = (await post('/sealed/roster', { since_seq: 0 })) as Obj
  const chain = Array.isArray(got?.rosters) ? got.rosters : []
  const first = chain.length ? pinFromEnrollment(chain[0], sheet.orgCode) : null
  const a = first && first.ok ? (chain.length > 1 ? acceptRoster(first.pin, chain) : first) : null
  if (!a || !a.ok) return 'The recovery sheet does not match your company\'s records; nothing was changed.'
  const why = checkRecoverySheet(sheet, a.roster, a.roster.root)
  if (why) return `The recovery sheet does not match (${why}); nothing was changed.`
  const acc = await account(svc)
  const fresh = newIdentity(a.roster.org, acc, newDev(), defaultRandom)
  await saveIdentity($, fresh, defaultRandom)
  idCache = fresh
  const lost = (a.roster.members.find((m) => m.acc === acc)?.devices ?? []).map((d) => d.dev)
  const rec = recoveryRoster(a.roster, sheet, a.roster.root, fresh, lost, defaultRandom)
  await post('/sealed/enroll', { enroll: enrollRecord(fresh) })
  await post('/sealed/roster/put', { roster: rec.roster })
  const author = { kid: kidOf(identityPublic(fresh).sig_pk), seed: signingSeed(fresh) }
  for (const [vault, ck] of Object.entries(rec.contentKeys)) {
    const v = rec.roster.vaults.find((x) => x.id === vault)!
    const kw = await wrapEpoch(rec.roster, vault, v.epoch, ck, 1, author, defaultRandom)
    await putObject(post, vault, 'keywrap', kw.object, v.epoch, 1, kw.data, kw.sig)
  }
  await keep(ioOf($), rec.roster)
  const ledger = rec.roster.vaults.find((v) => v.kind === 'ledger')?.id ?? null
  const brain = rec.roster.vaults.find((v) => v.kind === 'brain')?.id ?? null
  await putJson(ioOf($), 'sealed_state', { v: 1, org: rec.roster.org, acc, dev: fresh.dev, role: 'admin', on: true, ledger, brain, brain_name: brainName(rec.roster.org) })
  const old = await rewrapEpochs([...chain, rec.roster], rec.roster, sheet.ageSecret, author, post, defaultRandom)
  void ledgerAdd('roster', { seq: rec.roster.seq, h: recordHash(rec.roster), change: `recovered, ${old.rewrapped} earlier keys re-wrapped, ${old.skipped.length} skipped` }, '')
  const left = old.skipped.length
    ? ` ${old.skipped.length} earlier brain key(s) could not be re-wrapped (${old.skipped.slice(0, 5).join(', ')}); their versions stay readable with the recovery sheet or an earlier admin device.`
    : ''
  return `Recovered: this computer holds a new admin key and the brain moved to a new key; ${old.rewrapped} earlier brain key(s) ` +
    `were re-wrapped so this computer reads the older versions too.${left} Delete the recovery sheet file again now.`
}

export async function rewrapEpochs(
  chain: Roster[], r: Roster, ageSecret: string, author: { kid: string; seed: Uint8Array },
  send: (route: string, body: Obj) => Promise<unknown>, random: typeof defaultRandom,
): Promise<{ rewrapped: number; skipped: string[] }> {
  const bySeq = new Map<number, Roster>()
  for (const x of chain) if (isObj(x) && Number.isInteger(x.seq)) bySeq.set(x.seq, x)
  let rewrapped = 0
  const skipped: string[] = []
  for (const v of r.vaults.filter((x) => x.kind === 'brain')) {
    for (let e = 1; e < v.epoch; e++) {
      const at = `${v.id.slice(0, 8)}:${e}`
      try {
        const got = (await send('/sealed/get', { vault: v.id, object: keywrapObjectId(v.id, e) })) as GetAnswer
        const data = b64Decode(got.data_b64)
        const h = splitObject(data).header
        if (h.org !== r.org || h.vault !== v.id || h.kind !== 'keywrap' || h.epoch !== e || h.by !== got.by) { skipped.push(`${at} header`); continue }
        const under = bySeq.get(Number(got.roster_seq))
        const w = under ? writerOf(under, h.by, 'keywrap', v.id) : null
        if (!w || w.member.role !== 'admin' || !verifyObject(data, b64Decode(got.sig), b64Decode(w.device.sig_pk))) { skipped.push(`${at} signer`); continue }
        const kw = await rewrapOld(r, data, h.version, ageSecret, author, random)
        await putObject(send, v.id, 'keywrap', kw.object, e, h.version + 1, kw.data, kw.sig)
        rewrapped++
      } catch (err) {
        skipped.push(`${at} ${err instanceof RouteError ? err.message : 'failed'}`)
      }
    }
  }
  return { rewrapped, skipped }
}

async function brainStorage($: EngineInterface, post: ReturnType<typeof poster>, args: string[]): Promise<string> {
  const mode = (args[0] ?? '').toLowerCase()
  const cur = await ownStorage(ioOf($))
  if (!mode) return cur ? `Storage: own folder ${cur.folder} (company ${cur.org}).` : 'Storage: the agent-services server (the default).'
  if (mode === 'server') {
    try { await ioOf($).del('sealed_storage') } catch {}
    return 'Storage: the agent-services server from the next session on.'
  }
  const org = args[args.length - 1] ?? ''
  const folder = slashed(args.slice(1, -1).join(' ').trim())
  if (mode !== 'own' || !folder || !/^[A-Za-z0-9_-]{1,64}$/.test(org)) return USAGE
  await putJson(ioOf($), 'sealed_storage', { mode: 'own', folder, org })
  if ((await readState(ioOf($)))?.role === 'admin') await post('/sealed/config', { storage: 'own' }).catch(() => undefined)
  return `Storage: your own folder ${folder} from the next session on (objects and rosters are written there; the ` +
    'ledger keeps its batches there with no server receipts). Every member types the same command with the same folder.'
}

async function brainLeave($: EngineInterface): Promise<string> {
  const st = await readState(ioOf($))
  if (!st) return 'The company brain is not on for this computer.'
  await putJson(ioOf($), 'sealed_state', { ...st, on: false })
  off()
  return 'Left: this computer no longer shares lessons or serves the company brain. Your key stays on this computer; ' +
    'your admin removes you from the roster.'
}

const dayStart = (s: string): number | null => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? Math.floor(Date.parse(`${s}T00:00:00Z`) / 1000) : null)

async function ledgerExport($: EngineInterface, post: ReturnType<typeof poster>, args: string[]): Promise<string> {
  const { st, id } = await adminCtx($, post)
  const from = dayStart(args[0] ?? '')
  const to0 = dayStart(args[1] ?? '')
  if (from === null || to0 === null || to0 < from || !st.ledger) return USAGE
  const to = to0 + 86399
  const b = await exportLedger({ org: st.org, from, to, vault: st.ledger, identity: id.enc_sk, anchors: anchors() }, post)
  const v = verifyBundle(b, await verifyOpts(ioOf($)))
  const base = `${await docs($)}/agent-services-ledger-${args[0]}-${args[1]}`
  await $.fs.write(`${base}.json`, bundleText(b))
  await $.fs.write(`${base}.txt`, bundleReport(b, v))
  return `Wrote ${base}.txt (readable report) and ${base}.json (the bundle; anyone can recheck it with ` +
    `/agent-services ledger verify <file>). Verdict: ${verdictWord(v)}.` +
    (exportGaps(b).length ? ` ${exportGaps(b).length} batch(es) could not be read, so their entries are missing; the report names each one.` : '') +
    (v.gaps.length ? ` Part of the period is missing (${v.gaps.length} gap(s)); the report names each one.` : '')
}

async function ledgerVerify($: EngineInterface, args: string[]): Promise<string> {
  const file = slashed(args.join(' ').trim())
  if (!file) return USAGE
  const b = parseBundle(String(await $.fs.read(file)))
  const v = verifyBundle(b, await verifyOpts(ioOf($)))
  return bundleReport(b, v)
}

async function verifyOpts(io: Io): Promise<VerifyOptions> {
  const pin = await getJson(io, 'sealed_pin')
  const last = (await getJson(io, 'ledger_receipt')) as Receipt | null
  const o: VerifyOptions = { anchors: anchors(), lastReceipt: isObj(last) ? last : null }
  if (isObj(pin) && typeof pin.root === 'string') o.rosterCheck = pinnedRosterCheck(pin)
  return o
}

async function ledgerStatus($: EngineInterface): Promise<string> {
  const st = await readState(ioOf($))
  if (!st) return 'The ledger is off on this computer (the company brain and ledger are not set up here).'
  const last = (await getJson(ioOf($), 'ledger_receipt')) as Receipt | null
  return [`Ledger: on for company ${st.org} (${st.role}).`,
    seg ? `This session: ${seg.entries.length} entries in ${seg.path ?? 'memory'}; checkpointed up to entry ${seg.nextFrom - 1}.` : 'This session: no entries yet.',
    last ? `Last server receipt: number ${last.n}.` : 'No server receipt yet.'].join('\n')
}

export function sealedResetForTest(): void {
  off()
  testKitKeys = undefined
  seg = null
  idCache = null
}
