// The local request log (A21 item 2; plan 3.7; contract x-outbox), harness-neutral: file
// access and the clock are passed in.
//
// - Every request to the service is logged before it is sent (the line is filled in when the answer comes):
//   body_text is the exact inner body sent (UTF-8), never the Authorization header, with REQUEST_SECRET fields
//   redacted (as host/services.py _redact_request); plus method, route, status, error, preview, and the outer facts
//   (outer_path, outer_bytes: the outer path and the length of the sealed body as sent).
// - Previews are logged with preview true; each tool call of the model (name and arguments) as kind "tool"; each
//   dashboard publish attempt as kind "artifact_publish".
// - Every text field also goes through redact() (redact.ts).
// - Storage: one file per session and UTC day, <dir>/<day>-<session 8 hex>.jsonl, where dir is
//   <data dir>/services/outbox. There is no append API, so the lines are kept in memory and the file is rewritten
//   whole at most every FLUSH_EVERY_MS and at session end (flush), capped at FILE_CAP_BYTES. sweep() (at session
//   start) clears the files older than OUTBOX_KEEP_DAYS: removed when the file access can remove, else emptied
//   (the engine's $.fs has no delete).
import { OUTBOX_KEEP_DAYS } from './contract'
import { sha256Hex, utf8 } from './e2e'
import { redact } from './redact'

export const FLUSH_EVERY_MS = 5000
export const FILE_CAP_BYTES = 2 * 1048576
export const TEXT_LIMIT = 65536
export const ROUTE_LIMIT = 120
export const ERROR_LIMIT = 300
export const PUBLISH_REASON_LIMIT = 200 // a denied dashboard publish: the reason kept
/** Top-level request fields never written to the outbox (the sign-in code and anything token-like). */
export const REQUEST_SECRET = ['code', 'token', 'token_hash', 'new_token_hash', 'device_key', 'password', 'secret']
const NAME_RX = /^(\d{4}-\d{2}-\d{2})-[0-9a-f]{8}\.jsonl$/
const DAY_MS = 86400000

export type OutboxFs = {
  read(path: string): Promise<string> // rejects when the file is missing
  write(path: string, text: string): Promise<void>
  list(path: string): Promise<readonly { name: string; size?: number }[]>
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

/** ISO time with milliseconds and Z, as host/services.py _iso. */
export const isoTime = (ms: number): string => new Date(ms).toISOString()

/** The first 8 hex of the session id (a UUID); a session id without 8 hex digits is hashed first. */
export function session8(session: string): string {
  const h = String(session ?? '')
    .toLowerCase()
    .replace(/[^0-9a-f]/g, '')
  return h.length >= 8 ? h.slice(0, 8) : sha256Hex(utf8(String(session ?? ''))).slice(0, 8)
}

const cut = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s)
const clean = (s: string | null | undefined, n: number): string | null => (s == null ? null : cut(redact(String(s)), n))

/** The outbox copy of a request body: top-level REQUEST_SECRET fields become "[redacted]"; a body that is not a
 * JSON object is kept as sent. */
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

  constructor(opts: { fs: OutboxFs; dir: string; session: string; now: () => number }) {
    this.fs = opts.fs
    this.dir = opts.dir.replace(/[\\/]+$/, '')
    this.session = session8(opts.session)
    this.now = opts.now
  }

  /** The file a line written now goes to. */
  path(ms: number = this.now()): string {
    return `${this.dir}/${isoTime(ms).slice(0, 10)}-${this.session}.jsonl`
  }

  private add(line: Line): Line {
    const p = this.path()
    let f = this.files.get(p)
    if (!f) this.files.set(p, (f = { base: null, lines: [], dropped: 0 }))
    if (f.dropped > 0) f.dropped++
    else f.lines.push(line)
    this.touch()
    return line
  }

  /** A request about to be sent. The returned line is filled in later (status, response_text, error); call
   * touch() after. */
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

  /** Fill in a request line with its outcome (texts redacted and capped here). */
  answer(line: RequestLine, status: number | null, responseText: string | null, error: string | null): void {
    line.status = status
    line.response_text = clean(responseText, TEXT_LIMIT)
    line.error = clean(error, ERROR_LIMIT)
    this.touch()
  }

  /** A preview: the body as it would be sent; nothing is sent. */
  preview(service: string, method: string, route: string, body: string | null): RequestLine {
    return this.request({ service, method, route, body, preview: true })
  }

  /** A call the model made to one of our tools. */
  tool(name: string, args: unknown): void {
    let text: string
    try {
      text = JSON.stringify(args ?? null)
    } catch {
      text = 'null'
    }
    this.add({ ts: isoTime(this.now()), kind: 'tool', name: cut(String(name), ROUTE_LIMIT), arguments_text: clean(text, TEXT_LIMIT) })
  }

  /** A dashboard publish attempt: the Artifact input fields, the page's sha256 and size, the outcome, and a denied
   * call's reason (cut to PUBLISH_REASON_LIMIT) when the tool gave one. */
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

  /** Something changed: write when the last write is at least FLUSH_EVERY_MS old. */
  touch(): void {
    this.dirty = true
    if (this.now() - this.lastFlush >= FLUSH_EVERY_MS) void this.flush().catch(() => undefined)
  }

  /** The lines held for the current file (tests and the outbox subcommand). */
  lines(ms: number = this.now()): Line[] {
    return (this.files.get(this.path(ms))?.lines ?? []).map((l) => ({ ...l }))
  }

  /** Rewrite every held file whole (serialized: one write at a time). */
  flush(): Promise<void> {
    this.chain = this.chain.then(() => this.write()).catch(() => undefined)
    return this.chain
  }

  private async write(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    this.lastFlush = this.now()
    for (const [p, f] of this.files) {
      if (f.base === null) {
        // an earlier copy of this module (hot reload) may have written this session's file already
        try {
          const old = String((await this.fs.read(p)) ?? '')
          f.base = utf8(old).length <= FILE_CAP_BYTES ? old : ''
        } catch {
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
        f.lines = keep // the rest never fits: kept only as a count
        f.dropped += over
      }
      if (f.dropped > 0) text += JSON.stringify({ ts: isoTime(this.now()), kind: 'cap', dropped: f.dropped }) + '\n'
      await this.fs.write(p, text)
    }
    // files of earlier days are complete: drop them from memory once written
    const cur = this.path()
    for (const p of [...this.files.keys()]) if (p !== cur) this.files.delete(p)
  }

  /** Clear the files older than OUTBOX_KEEP_DAYS (any session). Returns how many were cleared. */
  async sweep(): Promise<number> {
    let entries: readonly { name: string; size?: number }[]
    try {
      entries = await this.fs.list(this.dir)
    } catch {
      return 0
    }
    const cutoff = isoTime(this.now() - OUTBOX_KEEP_DAYS * DAY_MS).slice(0, 10)
    let n = 0
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
        // best effort: again at the next session start
      }
    }
    return n
  }
}
