import { OUTBOX_KEEP_DAYS } from './contract'
import { sha256Hex, utf8 } from './e2e'
import { redact } from './redact'
import { markRemoved, removedMarker } from './remove'

export const FLUSH_EVERY_MS = 5000
export const FILE_CAP_BYTES = 2 * 1048576
export const TEXT_LIMIT = 65536
export const ROUTE_LIMIT = 120
export const ERROR_LIMIT = 300
export const PUBLISH_REASON_LIMIT = 200
export const REQUEST_SECRET = ['code', 'token', 'token_hash', 'new_token_hash', 'device_key', 'password', 'secret', 'check']
const NAME_RX = /^(\d{4}-\d{2}-\d{2})-[0-9a-f]{8}\.jsonl$/
const DAY_MS = 86400000

export type OutboxFs = {
  read(path: string): Promise<string>
  write(path: string, text: string): Promise<void>
  list(path: string): Promise<readonly { name: string; size?: number; mtime?: number }[]>
  remove?(path: string): Promise<void>
}

export type RequestLine = {
  ts: string
  service: string
  method: string
  route: string
  preview: boolean
  body_text: string | null
  status: number | null
  response_text: string | null
  error: string | null
  outer_path?: string
  outer_bytes?: number
}

type Line = Record<string, unknown>
type FileBuf = { base: string | null; lines: Line[]; dropped: number }

export const isoTime = (ms: number): string => new Date(ms).toISOString()

export function session8(session: string): string {
  const h = String(session ?? '')
    .toLowerCase()
    .replace(/[^0-9a-f]/g, '')
  return h.length >= 8 ? h.slice(0, 8) : sha256Hex(utf8(String(session ?? ''))).slice(0, 8)
}

const cut = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s)
const clean = (s: string | null | undefined, n: number): string | null => (s == null ? null : cut(redact(String(s)), n))

export function redactRequest(text: string | null | undefined): string | null {
  if (text == null) return null
  if (!text) return text
  let obj: unknown
  try {
    obj = JSON.parse(text)
  } catch {
    return text
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return text
  const o = obj as Record<string, unknown>
  if (!REQUEST_SECRET.some((k) => k in o)) return text
  for (const k of REQUEST_SECRET) if (k in o) o[k] = '[redacted]'
  return JSON.stringify(o)
}

export class Outbox {
  readonly dir: string
  readonly session: string
  private fs: OutboxFs
  private now: () => number
  private files = new Map<string, FileBuf>()
  private lastFlush = 0
  private chain: Promise<void> = Promise.resolve()
  private dirty = false
  private stopped = false
  private readonly marker: string | null

  constructor(opts: { fs: OutboxFs; dir: string; session: string; now: () => number; marker?: string | null }) {
    this.fs = opts.fs
    this.dir = opts.dir.replace(/[\\/]+$/, '')
    this.session = session8(opts.session)
    this.now = opts.now
    const data = this.dir.endsWith('/services/outbox') ? this.dir.slice(0, -'/services/outbox'.length) : null
    this.marker = opts.marker !== undefined ? opts.marker : data === null ? null : removedMarker(data)
  }

  path(ms: number = this.now()): string {
    return `${this.dir}/${isoTime(ms).slice(0, 10)}-${this.session}.jsonl`
  }

  private add(line: Line): Line {
    if (this.stopped) return line
    const p = this.path()
    let f = this.files.get(p)
    if (!f) this.files.set(p, (f = { base: null, lines: [], dropped: 0 }))
    if (f.dropped > 0) f.dropped++
    else f.lines.push(line)
    this.touch()
    return line
  }

  request(r: {
    service: string
    method: string
    route: string
    body: string | null
    outerPath?: string
    outerBytes?: number
    preview?: boolean
  }): RequestLine {
    const line: RequestLine = {
      ts: isoTime(this.now()),
      service: r.service,
      method: r.method,
      route: cut(r.route, ROUTE_LIMIT),
      preview: Boolean(r.preview),
      body_text: clean(redactRequest(r.body), TEXT_LIMIT),
      status: null,
      response_text: null,
      error: null,
    }
    if (r.outerPath !== undefined) line.outer_path = r.outerPath
    if (r.outerBytes !== undefined) line.outer_bytes = r.outerBytes
    return this.add(line) as RequestLine
  }

  answer(line: RequestLine, status: number | null, responseText: string | null, error: string | null): void {
    line.status = status
    line.response_text = clean(responseText, TEXT_LIMIT)
    line.error = clean(error, ERROR_LIMIT)
    this.touch()
  }

  preview(service: string, method: string, route: string, body: string | null): RequestLine {
    return this.request({ service, method, route, body, preview: true })
  }

  tool(name: string, args: unknown): void {
    let text: string
    try {
      text = JSON.stringify(args ?? null)
    } catch {
      text = 'null'
    }
    this.add({ ts: isoTime(this.now()), kind: 'tool', name: cut(String(name), ROUTE_LIMIT), arguments_text: clean(text, TEXT_LIMIT) })
  }

  publish(input: Record<string, string>, pageSha256: string, pageSize: number, outcome: string, reason?: string): void {
    const fields: Record<string, string> = {}
    for (const [k, v] of Object.entries(input ?? {})) fields[k] = clean(String(v), 1000) ?? ''
    this.add({
      ts: isoTime(this.now()),
      kind: 'artifact_publish',
      input: fields,
      sha256: String(pageSha256),
      size: Number(pageSize) || 0,
      outcome: clean(String(outcome), ERROR_LIMIT),
      ...(typeof reason === 'string' ? { reason: clean(reason, PUBLISH_REASON_LIMIT) } : {}),
    })
  }

  touch(): void {
    this.dirty = true
    if (this.now() - this.lastFlush >= FLUSH_EVERY_MS) void this.flush().catch(() => undefined)
  }

  lines(ms: number = this.now()): Line[] {
    return (this.files.get(this.path(ms))?.lines ?? []).map((l) => ({ ...l }))
  }

  stop(): void {
    this.stopped = true
    this.dirty = false
    this.files.clear()
  }

  flush(): Promise<void> {
    this.chain = this.chain.then(() => this.write()).catch(() => undefined)
    return this.chain
  }

  private async write(): Promise<void> {
    if (this.stopped) return
    if (this.marker && (await this.removedHere())) {
      markRemoved()
      this.stop()
      return
    }
    if (!this.dirty) return
    this.dirty = false
    this.lastFlush = this.now()
    try {
      await this.writeFiles()
    } catch (err) {
      if (!this.stopped) this.dirty = true
      throw err
    }
  }

  private async writeFiles(): Promise<void> {
    let skipped = false
    for (const [p, f] of this.files) {
      if (f.base === null) {
        try {
          const old = String((await this.fs.read(p)) ?? '')
          f.base = utf8(old).length <= FILE_CAP_BYTES ? old : ''
        } catch {
          const name = p.slice(p.lastIndexOf('/') + 1)
          const absent = await this.fs.list(this.dir).then((l) => !l.some((x) => x.name === name), () => true)
          if (!absent) {
            skipped = true
            continue
          }
          f.base = ''
        }
        if (f.base && !f.base.endsWith('\n')) f.base += '\n'
      }
      let text = f.base
      let size = utf8(text).length
      let over = 0
      const keep: Line[] = []
      for (const l of f.lines) {
        const s = JSON.stringify(l) + '\n'
        const n = utf8(s).length
        if (over === 0 && size + n <= FILE_CAP_BYTES - 256) {
          text += s
          size += n
          keep.push(l)
        } else over++
      }
      if (over > 0) {
        f.lines = keep
        f.dropped += over
      }
      if (f.dropped > 0) text += JSON.stringify({ ts: isoTime(this.now()), kind: 'cap', dropped: f.dropped }) + '\n'
      if (this.stopped) return
      await this.fs.write(p, text)
    }
    if (skipped) {
      this.dirty = true
      return
    }
    const cur = this.path()
    for (const p of [...this.files.keys()]) if (p !== cur) this.files.delete(p)
  }

  private async removedHere(): Promise<boolean> {
    try {
      return String((await this.fs.read(this.marker!)) ?? '').trim() !== ''
    } catch {
      return false
    }
  }

  async sweep(): Promise<number> {
    let n = await this.sweepLegacy()
    let entries: readonly { name: string; size?: number }[]
    try {
      entries = await this.fs.list(this.dir)
    } catch {
      return n
    }
    const cutoff = isoTime(this.now() - OUTBOX_KEEP_DAYS * DAY_MS).slice(0, 10)
    for (const e of entries) {
      const m = NAME_RX.exec(e.name)
      if (!m || m[1] >= cutoff) continue
      const p = `${this.dir}/${e.name}`
      try {
        if (this.fs.remove) await this.fs.remove(p)
        else if (e.size === 0) continue
        else await this.fs.write(p, '')
        n++
      } catch {
      }
    }
    return n
  }

  private async sweepLegacy(): Promise<number> {
    if (!this.dir.endsWith('/services/outbox')) return 0
    const parent = this.dir.slice(0, -'/outbox'.length)
    const p = `${parent}/outbox.jsonl`
    try {
      const e = (await this.fs.list(parent)).find((x) => x.name === 'outbox.jsonl')
      if (!e || e.size === 0) return 0
      if (typeof e.mtime === 'number' && e.mtime > 0 && e.mtime < this.now() - OUTBOX_KEEP_DAYS * DAY_MS) {
        await this.fs.write(p, '')
        return 1
      }
      const old = String((await this.fs.read(p)) ?? '')
      const lines = old.split('\n').map((l) => {
        let o: unknown
        try {
          o = JSON.parse(l)
        } catch {
          return l
        }
        if (!o || typeof o !== 'object' || Array.isArray(o) || typeof (o as any).body_text !== 'string') return l
        const b = redactRequest((o as any).body_text)
        return b === (o as any).body_text ? l : JSON.stringify({ ...(o as any), body_text: b })
      })
      const text = lines.join('\n')
      if (text === old) return 0
      await this.fs.write(p, text)
      return 1
    } catch {
      return 0
    }
  }
}
