import { b64Decode, sha256Hex, utf8 } from './e2e'

export type KitFs = {
  read(path: string): Promise<string>
  write(path: string, text: string): Promise<void>
  readBytes?(path: string): Promise<Uint8Array>
}
export type KitFilesOptions = { fs: KitFs; dir: string; waitMs?: number }
export type ServedFile = { path: string; sha256: string; size: number; data_b64: string }
type Entry = { path: string; sha256: string; size: number }

export const KIT_FILE_MAX = 2097152
export const KIT_TOTAL_MAX = 8388608
export const KIT_FILES_MAX = 500
export const KIT_FILES_DEADLINE_MS = 25000
export const KIT_WAIT_MS = 5500
export const KIT_PATHS_SHOWN = 40
export const KIT_EXTENSIONS: readonly string[] = ['.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.sh', '.ps1', '.md', '.txt',
  '.json', '.xml', '.xsd', '.html', '.css', '.yaml', '.yml', '.toml', '.csv', '.svg', '.ini', '.cfg', '.png', '.jpg', '.jpeg', '.gif']

export class KitFilesError extends Error {
  readonly reason: string
  constructor(reason: string) {
    super(reason)
    this.name = 'KitFilesError'
    this.reason = reason
  }
}

export function checkPath(p: unknown): string | null {
  if (typeof p !== 'string' || !/^[A-Za-z0-9._/-]{1,160}$/.test(p)) return 'characters'
  if (p.startsWith('/') || p.includes('..')) return 'relative'
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg.startsWith('-') || seg.endsWith('.')) return 'segment'
    if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(seg)) return 'segment'
  }
  const name = p.slice(p.lastIndexOf('/') + 1)
  const ext = name.slice(1).includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : ''
  return KIT_EXTENSIONS.includes(ext) ? null : 'extension'
}

const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export function checkSet(files: readonly ServedFile[]): { entries: Entry[]; texts: Map<string, string>; bytes: number } {
  if (!Array.isArray(files) || files.length < 1 || files.length > KIT_FILES_MAX) throw new KitFilesError('bad_file')
  const seen = new Map<string, string>()
  const folders = new Map<string, string>()
  const texts = new Map<string, string>()
  const entries: Entry[] = []
  let total = 0
  for (const f of files) {
    if (checkPath(f?.path) !== null) throw new KitFilesError('bad_path')
    const low = f.path.toLowerCase()
    if (seen.has(low)) throw new KitFilesError('bad_path')
    seen.set(low, f.path)
    const parts = f.path.split('/')
    for (let n = 1; n < parts.length; n++) {
      const d = parts.slice(0, n).join('/')
      const had = folders.get(d.toLowerCase())
      if (had !== undefined && had !== d) throw new KitFilesError('bad_path')
      folders.set(d.toLowerCase(), d)
    }
  }
  for (const d of folders.keys()) if (seen.has(d)) throw new KitFilesError('bad_path')
  for (const f of files) {
    if (!Number.isInteger(f.size) || f.size < 0 || f.size > KIT_FILE_MAX || !/^[0-9a-f]{64}$/.test(f.sha256)) throw new KitFilesError('bad_file')
    let b: Uint8Array
    try {
      b = b64Decode(f.data_b64)
    } catch {
      throw new KitFilesError('bad_file')
    }
    if (b.length !== f.size || sha256Hex(b) !== f.sha256) throw new KitFilesError('bad_file')
    total += b.length
    if (total > KIT_TOTAL_MAX) throw new KitFilesError('bad_file')
    let text: string
    try {
      text = strict.decode(b)
    } catch {
      throw new KitFilesError('binary_file')
    }
    texts.set(f.path, text)
    entries.push({ path: f.path, sha256: f.sha256, size: f.size })
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { entries, texts, bytes: total }
}

export function kitFolder(dir: string, key: string, version: string): { folder: string; marker: string } {
  const base = `${dir.replace(/\\/g, '/').replace(/\/+$/, '')}/${key}`
  return { folder: `${base}/${version}`, marker: `${base}/${version}.complete.json` }
}

async function holds(fs: KitFs, path: string, e: Entry, text?: string): Promise<boolean> {
  try {
    if (fs.readBytes) {
      const b = await fs.readBytes(path)
      return b.length === e.size && sha256Hex(b) === e.sha256
    }
    const t = await fs.read(path)
    return text !== undefined ? t === text : sha256Hex(utf8(t)) === e.sha256
  } catch {
    return false
  }
}

export type KitResult =
  | { status: 'saved' | 'ready'; folder: string; entries: Entry[]; bytes: number }
  | { status: 'changed'; folder: string; changed: string[] }

export async function onDisk(o: KitFilesOptions, key: string, version: string): Promise<KitResult | null> {
  const { folder, marker } = kitFolder(o.dir, key, version)
  let m: { key?: unknown; version?: unknown; files?: unknown }
  try {
    m = JSON.parse(await o.fs.read(marker))
  } catch {
    return null
  }
  if (!m || m.key !== key || m.version !== version || !Array.isArray(m.files)) return null
  const entries = (m.files as Entry[]).filter((e) => e && checkPath(e.path) === null && typeof e.sha256 === 'string' && Number.isInteger(e.size))
  if (entries.length !== m.files.length || !entries.length) return null
  const changed: string[] = []
  for (const e of entries) if (!(await holds(o.fs, `${folder}/${e.path}`, e))) changed.push(e.path)
  return changed.length ? { status: 'changed', folder, changed } : { status: 'ready', folder, entries, bytes: entries.reduce((n, e) => n + e.size, 0) }
}

export async function install(o: KitFilesOptions, key: string, version: string, files: readonly ServedFile[]): Promise<KitResult> {
  const set = checkSet(files)
  const done = await onDisk(o, key, version)
  if (done) return done
  const { folder, marker } = kitFolder(o.dir, key, version)
  for (const e of set.entries) {
    const path = `${folder}/${e.path}`
    const text = set.texts.get(e.path)!
    try {
      await o.fs.write(path, text)
    } catch {
      throw new KitFilesError('write_failed')
    }
    if (!(await holds(o.fs, path, e, text))) throw new KitFilesError('write_failed')
  }
  const mtext = JSON.stringify({ key, version, files: set.entries })
  try {
    await o.fs.write(marker, mtext)
  } catch {
    throw new KitFilesError('write_failed')
  }
  if ((await o.fs.read(marker).catch(() => null)) !== mtext) throw new KitFilesError('write_failed')
  return { status: 'saved', folder, entries: set.entries, bytes: set.bytes }
}

const jobs = new Map<string, Promise<KitResult>>()

export function kitJob(o: KitFilesOptions, key: string, version: string, start: () => Promise<KitResult>): Promise<KitResult> {
  const id = `${o.dir}\n${key}\n${version}`
  let p = jobs.get(id)
  if (!p) {
    p = start().finally(() => jobs.delete(id))
    p.catch(() => undefined)
    jobs.set(id, p)
  }
  return p
}

export function filesAnswer(r: KitResult, key: string): Record<string, unknown> {
  if (r.status === 'changed') {
    return {
      status: 'changed', folder: r.folder, changed: r.changed.slice(0, KIT_PATHS_SHOWN),
      hint: 'This pack version was saved before and these files were changed since; nothing was overwritten. Delete the folder (ask the user first) and call again for a fresh copy.',
    }
  }
  const paths = r.entries.map((e) => e.path)
  const out: Record<string, unknown> = {
    status: r.status, folder: r.folder, count: paths.length, bytes: r.bytes, paths: paths.slice(0, KIT_PATHS_SHOWN),
    hint: `Saved; nothing was run. Read a script before you run it, and run it only when the task needs it, by its absolute path under this folder with your own tools, as the items of toolbox pack ${key} say; ask the user before installing anything it needs.`,
  }
  if (paths.length > KIT_PATHS_SHOWN) out.more = paths.length - KIT_PATHS_SHOWN
  return out
}
