// The device id: "dev_" + 16 hex digits, one per computer and OS user. The service keys the sign-in, every signed
// request and the per-computer usage rows by it, so it must not change when the plugin is reinstalled.
//
// It is kept in two places: the plugin store (KEYS.deviceId, which a reinstall starts empty) and a small file in the
// data folder, <data dir>/services/device.json, a JSON object with the id, which survives a reinstall and a new
// plugin store. The load order is in resolveDeviceId: a valid file wins and is copied into the store when the store
// differs; else a valid store id is copied into the file (an install from before the file existed keeps its id);
// else a new id is made, and that happens at sign-in only.
//
// The engine's file access has no rename and no permissions, so the file is written in one piece and read back: a
// write that did not stick does not count. A file that cannot be written leaves the store as the only copy, as
// before, and never fails a sign-in. The device key (the Ed25519 seed) is not in the file.
import { hex, type Random } from './e2e'
import { getText, KEYS, safeSet, type KV } from './store'

/** The durable copy: read gives its text, or null when there is no file or it cannot be read. */
export type DeviceFile = {
  read(): Promise<string | null>
  write(text: string): Promise<void>
}

/** The engine's file access as register.ts passes it: read and write only. */
export type DeviceFs = {
  read(path: string): Promise<string>
  write(path: string, text: string): Promise<void>
}

/** The data folder the durable file lives in, with the file access to it. */
export type DurableDir = { fs: DeviceFs; dir: string }

function validId(v: unknown): v is string {
  return typeof v === 'string' && /^dev_[0-9a-f]{16}$/.test(v)
}

/** The durable file of a data folder: <dir>/services/device.json. */
export function deviceFileOf(d: DurableDir): DeviceFile {
  const path = `${d.dir.replace(/[\\/]+$/, '')}/services/device.json`
  return {
    read: async () => {
      try {
        return String(await d.fs.read(path))
      } catch {
        return null
      }
    },
    write: (text) => d.fs.write(path, text),
  }
}

/** The id the file holds, or null when there is no file, it does not parse, or its id has the wrong form. */
async function readFile(file: DeviceFile): Promise<string | null> {
  const text = await file.read().catch(() => null)
  try {
    const o = JSON.parse(text ?? '')
    const id = o !== null && typeof o === 'object' ? o.device_id : null
    return validId(id) ? id : null
  } catch {
    return null
  }
}

/** Writes the id in one piece and reads it back; true only when the file then holds exactly that id. */
async function writeFile(file: DeviceFile, id: string): Promise<boolean> {
  try {
    await file.write(JSON.stringify({ device_id: id }) + '\n')
  } catch {
    return false
  }
  return (await readFile(file)) === id
}

/** The device id of this computer. Every reader of the id calls this (sign-in, signed requests).
 * mint: make a new id when neither the file nor the store has a valid one (sign-in only); otherwise the answer is
 * null when there is none. A new id that neither place could keep throws 'store', as the store refusing did before. */
export async function resolveDeviceId(kv: KV, file: DeviceFile | null, random: Random, mint: boolean): Promise<string | null> {
  const fromFile = file ? await readFile(file) : null
  const raw = await getText(kv, KEYS.deviceId)
  const fromStore = validId(raw) ? raw : null
  let id = fromFile ?? fromStore
  const fresh = id === null
  if (id === null) {
    if (!mint) return null
    id = 'dev_' + hex(random(8))
  }
  const inFile = fromFile === id || (file !== null && (await writeFile(file, id)))
  const inStore = fromStore === id || (await safeSet(kv, KEYS.deviceId, id))
  if (fresh && !inFile && !inStore) throw new Error('store')
  return id
}
