import { hex, type Random } from './e2e'
import { getText, KEYS, safeSet, type KV } from './store'

export type DeviceFile = {
  read(): Promise<string | null>
  write(text: string): Promise<void>
}

export type DeviceFs = {
  read(path: string): Promise<string>
  write(path: string, text: string): Promise<void>
}

export type DurableDir = { fs: DeviceFs; dir: string }

function validId(v: unknown): v is string {
  return typeof v === 'string' && /^dev_[0-9a-f]{16}$/.test(v)
}

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

async function writeFile(file: DeviceFile, id: string): Promise<boolean> {
  try {
    await file.write(JSON.stringify({ device_id: id }) + '\n')
  } catch {
    return false
  }
  return (await readFile(file)) === id
}

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
