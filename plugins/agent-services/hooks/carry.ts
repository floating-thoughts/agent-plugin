import type { EngineInterface } from 'claude-code'
import { CHOICE_KEY } from './choice'
import { sha256Hex, utf8 } from './e2e'
import { rulesAccount, rulesTable } from './rules'
import { CREDENTIAL_KEYS, KEYS, memoryStore, SIGN_OUT_KEYS } from './store'

type Obj = Record<string, any>
type Kv = { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const isAccMap = (v: unknown): v is Obj =>
  isObj(v) && Object.entries(v).every(([k, x]) => k.startsWith('acc_') && isObj(x))

export async function carryOver(kv: Kv, table: unknown, account: unknown,
  notify: (line: string, told: () => Promise<void>) => void): Promise<void> {
  try {
    if (!isObj(table) || !isObj(table.keys) || typeof account !== 'string' || !account.startsWith('acc_')) return
    const from = new Set((Array.isArray(table.from) ? table.from : []).filter((h: unknown) => typeof h === 'string')
      .map((h: string) => h.toLowerCase()))
    const fixed = new Set<string>([...Object.values(KEYS), ...SIGN_OUT_KEYS, ...CREDENTIAL_KEYS, 'carry_told'])
    let tell = false
    for (const [key, how] of Object.entries(table.keys)) {
      if ((how !== 'carry' && how !== 'tell') || fixed.has(key) || key.startsWith(KEYS.tokenNext)) continue
      const all = await kv.get(key)
      if (!isAccMap(all)) continue
      const map: Obj = { ...all }
      const movable = how === 'carry' && ['autonomy', 'methods_seen'].includes(key) && key !== CHOICE_KEY
      let moved = false
      for (const old of Object.keys(all)) {
        if (old === account) continue
        const same = movable && from.has(sha256Hex(utf8(old)))
        if (same && !(account in map)) {
          map[account] = map[old]
          delete map[old]
          moved = true
        } else if (!same) tell = true
      }
      if (moved) await kv.set(key, map)
    }
    const line = typeof table.notice === 'string' ? table.notice.replace(/\s+/g, ' ').trim().slice(0, 300) : ''
    if (!tell || !line) return
    const told = await kv.get('carry_told')
    if (isObj(told) && isObj(told[account])) return
    notify(line, async () => {
      const now = await kv.get('carry_told')
      await kv.set('carry_told', { ...(isObj(now) ? now : {}), [account]: { at: Date.now() } })
    })
  } catch {
  }
}

let doneFor: string | null = null
let pending: { account: string; line: string; told: () => Promise<void> } | null = null

async function carryWith(kv: Kv, show: ((line: string) => void) | null): Promise<void> {
  try {
    const table = rulesTable('carry')
    const acc = await kv.get(KEYS.accountId)
    const signed = typeof acc === 'string' && acc !== '' && rulesAccount() === acc ? acc : null
    if (table && signed && signed !== doneFor) {
      doneFor = signed
      await carryOver(kv, table, signed, (line, told) => { pending = { account: signed, line, told } })
    }
    if (!show || !pending) return
    const p = pending
    pending = null
    if (p.account !== signed) return
    show(p.line)
    await p.told()
  } catch {
  }
}

export async function carryNow($: EngineInterface, show: boolean): Promise<void> {
  try {
    const kv: Kv = { get: (k) => Promise.resolve($.store.get(k)), set: async (k, v) => void (await $.store.set(k, v as any)) }
    await carryWith(kv, show ? (line) => {
      try {
        $.ui.log(line)
      } catch {}
      try {
        $.ui.toast(line)
      } catch {}
    } : null)
  } catch {
  }
}

export async function carryForTest(init: Obj, table: unknown, account: unknown): Promise<{ store: Obj; told: string[] }> {
  const kv = memoryStore(init)
  const told: string[] = []
  const marks: (() => Promise<void>)[] = []
  await carryOver(kv, table, account, (line, mark) => { told.push(line); marks.push(mark) })
  for (const mark of marks) await mark()
  return { store: kv.dump(), told }
}

export async function carryNowForTest(init: Obj, shows: boolean[]): Promise<{ store: Obj; shown: string[] }> {
  const kv = memoryStore(init)
  const shown: string[] = []
  doneFor = null
  pending = null
  for (const s of shows) await carryWith(kv, s ? (line) => shown.push(line) : null)
  return { store: kv.dump(), shown }
}
