import type { EngineInterface } from 'claude-code'
import { engineDirs } from './engine_env'
import { redact } from './redact'
import { reportOpen } from './failure_report'
import { NOTE_LABEL } from './review'

type Obj = Record<string, any>

export const MCP_CHECK_KEY = 'mcp_check'
export const MCP_TIMEOUTS = { helper: 10_000, http: 10_000, stdio: 5_000, engine: 3_000, start: 20_000, overall: 30_000 }

export type McpServer = {
  name: string
  scope: string
  type: string
  url?: string
  headersHelper?: string
  headers?: Record<string, string>
  command?: string
  args?: string[]
  env?: Record<string, string>
}
export type RunProbe = { timedOut?: boolean; error?: string; exitCode?: number; stdout?: string; stderr?: string }
export type HttpProbe = { timedOut?: boolean; error?: string; status?: number; wwwAuthenticate?: string }
export type EngineState = { connected: boolean; reason?: string; message?: string } | null
export type McpProbe = { engine?: EngineState; helper?: RunProbe; headers?: Record<string, string>; http?: HttpProbe; found?: boolean; stdio?: RunProbe }
export type McpVerdict = { name: string; scope: string; type: string; ok: boolean; stage: string; cause: string; fix: string; skipped?: boolean }
export type McpIo = {
  run: (argv: string[], init: { timeoutMs: number; stdin?: string; env?: Record<string, string> }) => Promise<RunProbe>
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body?: string; timeoutMs: number }) => Promise<HttpProbe>
  exists: (path: string) => Promise<boolean>
  engine: (name: string) => Promise<EngineState>
  windows: boolean
}

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const strMap = (v: unknown): Record<string, string> =>
  isObj(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string')) as Record<string, string> : {}
const firstLine = (t: unknown): string => String(t ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean)?.slice(0, 160) ?? ''
const secs = (ms: number): string => `${Math.round(ms / 1000)} s`


export function serversOf(map: unknown, scope: string): McpServer[] {
  if (!isObj(map)) return []
  const out: McpServer[] = []
  for (const [name, c] of Object.entries(map)) {
    if (!isObj(c)) continue
    const type = typeof c.type === 'string' ? c.type : typeof c.url === 'string' ? 'http' : 'stdio'
    out.push({
      name, scope, type,
      ...(typeof c.url === 'string' ? { url: c.url } : {}),
      ...(typeof c.headersHelper === 'string' ? { headersHelper: c.headersHelper } : {}),
      ...(isObj(c.headers) ? { headers: strMap(c.headers) } : {}),
      ...(typeof c.command === 'string' ? { command: c.command } : {}),
      ...(Array.isArray(c.args) ? { args: c.args.map(String) } : {}),
      ...(isObj(c.env) ? { env: strMap(c.env) } : {}),
    })
  }
  return out
}

export function configuredServers(globalConfig: unknown, cwd: string | null, mcpJsons: unknown[]): McpServer[] {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const all: McpServer[] = []
  const g = isObj(globalConfig) ? globalConfig : {}
  all.push(...serversOf(g.mcpServers, 'user'))
  if (cwd && isObj(g.projects)) {
    for (const [k, p] of Object.entries(g.projects)) if (norm(k) === norm(cwd) && isObj(p)) all.push(...serversOf(p.mcpServers, 'local'))
  }
  for (const j of mcpJsons) if (isObj(j)) all.push(...serversOf(j.mcpServers, 'project'))
  const seen = new Set<string>()
  return all.filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true)))
}

export function knownCause(text: unknown, google = false): { cause: string; fix: string } | null {
  const t = String(text ?? '')
  const tokenFix = google
    ? 'retry the server; if the token stays empty or expired, run `gcloud auth application-default login`'
    : 'retry the server; if the token stays empty or expired, sign in again with the tool the header helper calls'
  if (/does not support dynamic client registration/i.test(t)) {
    return {
      cause: 'Claude Code fell back to OAuth because the static headers were missing or rejected at startup (the ' +
        'header helper timed out, or returned an empty or expired token), and this server offers no OAuth sign-in',
      fix: tokenFix,
    }
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(t)) return { cause: 'the host name does not resolve (DNS)', fix: 'check the URL and the network or VPN, then retry' }
  if (/ECONNREFUSED/i.test(t)) return { cause: 'nothing is listening at that address (connection refused)', fix: 'start the server or correct the URL, then retry' }
  if (/ECONNRESET|socket hang up/i.test(t)) return { cause: 'the connection was dropped', fix: 'retry; if it repeats, check a proxy or VPN' }
  if (/certificate|self[- ]signed|CERT_/i.test(t)) return { cause: 'the TLS certificate was not accepted', fix: 'check the URL, a proxy that inspects TLS, or NODE_EXTRA_CA_CERTS' }
  if (/ETIMEDOUT|timed? ?out/i.test(t)) return { cause: 'the request timed out', fix: 'check the network or VPN, then retry' }
  if (/ENOENT|is not recognized|command not found|not found/i.test(t)) return { cause: 'the command was not found', fix: 'install it, or put its full path in the config' }
  if (/application-default login|reauth|invalid_grant|refresh token/i.test(t)) {
    return { cause: 'the stored sign-in of the token source expired', fix: google ? 'run `gcloud auth application-default login`' : 'sign in again with the tool the header helper calls' }
  }
  return null
}

export function engineGate(s: Pick<McpServer, 'name' | 'scope' | 'type'>, e: EngineState): McpVerdict | null {
  const base = { name: s.name, scope: s.scope, type: s.type }
  const ok = (cause: string): McpVerdict => ({ ...base, ok: true, stage: 'ok', cause, fix: '' })
  const skip = (cause: string, fix: string): McpVerdict => ({ ...base, ok: true, skipped: true, stage: 'skipped', cause, fix })
  const notRun = 'not run (not approved in Claude Code)'
  if (!e) return skip('not run (Claude Code did not report its state)', 'check it with /mcp')
  if (e.connected) return ok('connected (Claude Code reports it connected)')
  if (e.reason === 'auth' || e.reason === 'failed') return null
  if (e.reason === 'disabled') return ok('turned off in this session')
  if (e.reason === 'unapproved') return skip(`${notRun}: this project server is not approved yet`, 'approve it with /mcp, then run the check again')
  if (e.reason === 'policy') return skip(`${notRun}: an organization MCP policy blocks it`, 'ask the administrator of that policy')
  if (e.reason === 'unlisted') return skip(`${notRun}: Claude Code does not list it in this session`, 'check it with /mcp')
  return skip(`${notRun}: ${String(e.reason ?? 'unknown state').slice(0, 40)}`, 'check it with /mcp')
}

export function managedName(name: string): boolean {
  return /^plugin:|^claude\.ai /i.test(name.trim())
}

export function classify(s: McpServer, p: McpProbe): McpVerdict {
  const base = { name: s.name, scope: s.scope, type: s.type }
  const fail = (stage: string, cause: string, fix: string): McpVerdict => ({ ...base, ok: false, stage, cause, fix })
  const ok = (cause = 'ok'): McpVerdict => ({ ...base, ok: true, stage: 'ok', cause, fix: '' })
  const google = /googleapis\.com|gcloud/i.test(`${s.url ?? ''} ${s.headersHelper ?? ''}`)
  if (p.engine !== undefined && p.engine !== null) {
    const gate = engineGate(s, p.engine)
    if (gate) return gate
  }
  let v = classifyProbe(s, p, google, fail, ok)
  const e = p.engine
  if (e && !e.connected) {
    const said = String(e.message ?? e.reason ?? '').slice(0, 200)
    const known = knownCause(said, google)
    if (e.reason === 'auth' || e.reason === 'failed') {
      if (v.ok) {
        v = fail('session', `it failed to connect in this session (${known ? known.cause : said || e.reason}), but the check passes ` +
          'now, so the cause was passing (most often the header helper or its token at startup)',
          'retry it: a ToolSearch query containing its name, or /mcp and reconnect')
      } else if (known && /dynamic client registration/i.test(said)) {
        v = { ...v, cause: `${v.cause}; Claude Code's "does not support dynamic client registration" comes from this` }
      }
    }
  }
  return v
}

function classifyProbe(s: McpServer, p: McpProbe, google: boolean,
  fail: (stage: string, cause: string, fix: string) => McpVerdict, ok: (cause?: string) => McpVerdict): McpVerdict {
  const tokenFix = google ? 'run `gcloud auth application-default login`, then retry the server'
    : 'refresh the token the header helper reads, then retry the server'
  if (s.type === 'stdio') {
    if (!s.command) return fail('config', 'no command is configured', 'add "command" to the server entry')
    if (p.found === false) return fail('command', `${s.command} was not found`, 'install it, or put its full path in the config')
    const r = p.stdio
    if (!r) return ok('found (not started)')
    if (r.timedOut) return ok('started and kept running')
    if (r.error) {
      const k = knownCause(r.error)
      return fail('start', k ? k.cause : `it could not start (${firstLine(r.error)})`, k ? k.fix : 'run the command by hand to see the error')
    }
    if (/"jsonrpc"/.test(r.stdout ?? '')) return ok()
    const why = firstLine(r.stderr) || firstLine(r.stdout)
    return fail('start', `it exited with code ${r.exitCode ?? '?'} before answering${why ? `: ${why}` : ''}`,
      knownCause(why)?.fix ?? 'run the command by hand to see the error')
  }
  if (s.type !== 'http' && s.type !== 'sse') return fail('config', `transport "${s.type}" is not checked`, 'check it with /mcp')
  if (!s.url) return fail('config', 'no url is configured', 'add "url" to the server entry')
  if (/\$\{/.test(s.url)) return fail('config', 'the url uses ${...} expansion, not checked here', 'check it with /mcp')
  const headers: Record<string, string> = { ...(s.headers ?? {}) }
  if (s.headersHelper) {
    const h = p.helper
    if (!h) return fail('header helper', 'the header helper was not run', 'run the check again')
    if (h.timedOut) {
      return fail('header helper', `the header helper did not finish within ${secs(MCP_TIMEOUTS.helper)}`,
        google ? 'run `gcloud auth application-default print-access-token` by hand; if it asks to sign in, run ' +
          '`gcloud auth application-default login`; then retry the server' : 'run the helper by hand to see why it hangs, then retry the server')
    }
    if (h.error) {
      const k = knownCause(h.error, google)
      return fail('header helper', k ? `the header helper could not start: ${k.cause}` : `the header helper could not start (${firstLine(h.error)})`,
        'check the command in headersHelper')
    }
    if (h.exitCode !== 0) {
      const why = firstLine(h.stderr)
      const k = knownCause(why, google)
      return fail('header helper', `the header helper exited with code ${h.exitCode ?? '?'}${why ? `: ${why}` : ''}`,
        k ? k.fix : 'run the helper by hand to see the error, then retry the server')
    }
    let out: unknown
    try {
      out = JSON.parse(String(h.stdout ?? '').trim())
    } catch {
      out = null
    }
    if (!isObj(out) || Object.values(out).some((x) => typeof x !== 'string')) {
      return fail('header helper output', 'the helper did not print one JSON object of string headers',
        'make it print only {"Header": "value"} on standard output')
    }
    Object.assign(headers, out)
  }
  const authKey = Object.keys(headers).find((k) => k.toLowerCase() === 'authorization')
  const auth = authKey === undefined ? null : headers[authKey]!.trim()
  if (auth !== null && (auth === '' || /^(bearer|basic|token)$/i.test(auth))) {
    return fail('token', 'the Authorization header is empty: the token source returned nothing', tokenFix)
  }
  const r = p.http
  if (!r) return fail('reach', 'the server was not asked', 'run the check again')
  if (r.timedOut) {
    if (s.type === 'sse') return ok('stream opened')
    return fail('reach', `no answer within ${secs(MCP_TIMEOUTS.http)}`, 'check the network or VPN, then retry')
  }
  if (r.error) {
    const k = knownCause(r.error, google)
    return fail('reach', k ? k.cause : `the request failed (${firstLine(r.error)})`, k ? k.fix : 'check the URL and the network, then retry')
  }
  const st = r.status ?? 0
  if (st >= 200 && st < 300) return auth ? ok('initialize answered; the server checks the token only when a tool runs') : ok()
  if (st === 401 || st === 403) {
    if (auth) {
      return fail('token rejected', `the server answered ${st}: the token was rejected (expired, revoked, or for the wrong ` +
        `account or project${google ? ', see x-goog-user-project' : ''})`, tokenFix)
    }
    return fail('sign-in', `the server answered ${st} and wants an OAuth sign-in; no static token is configured`,
      'run /mcp, pick the server and sign in')
  }
  if (st === 404) return fail('endpoint', 'the URL was not found (404)', 'correct the url in the config')
  if (st === 405 || st === 406 || st === 415) {
    return fail('initialize', `the server refused an MCP initialize request (${st})`, 'check the url and the type (http or sse)')
  }
  if (st >= 500) return fail('server', `the server failed (${st})`, 'retry later')
  return fail('initialize', `unexpected answer ${st}`, 'check the url, then retry')
}

export function argSecrets(args: readonly string[] = []): string[] {
  const named = /(token|key|secret|passw(?:or)?d|pwd|auth|credential)/i
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i] ?? '')
    const pair = /^(-{0,2}[\w.-]+)=(.+)$/.exec(a)
    if (pair && named.test(pair[1]!)) out.push(pair[2]!)
    else if (/^--?[\w.-]+$/.test(a) && named.test(a) && i + 1 < args.length && !String(args[i + 1]).startsWith('-')) out.push(String(args[++i]))
    else if (/^[A-Za-z0-9_+=-]{24,}$/.test(a) && /[A-Za-z]/.test(a) && /\d/.test(a)) out.push(a)
  }
  return out
}

export function secretsOf(servers: McpServer[], probes: McpProbe[]): string[] {
  const out = new Set<string>()
  const one = (v: unknown) => {
    const t = String(v ?? '').trim()
    if (t.length >= 4) {
      out.add(t)
      const bare = t.replace(/^(bearer|basic|token)\s+/i, '')
      if (bare.length >= 4) out.add(bare)
    }
  }
  const add = (m?: Record<string, string>) => {
    for (const v of Object.values(m ?? {})) one(v)
  }
  for (const s of servers) {
    add(s.headers)
    add(s.env)
    for (const a of argSecrets(s.args)) one(a)
    for (const m of String(s.url ?? '').matchAll(/[?&#]([^=&#\s]+)=([^&#\s]+)/g)) {
      if (/(key|token|secret|sig|passw|pwd|auth|code|credential)/i.test(m[1]!)) {
        one(m[2])
        try {
          one(decodeURIComponent(m[2]!))
        } catch {}
      }
    }
  }
  for (const p of probes) add(p.headers)
  return [...out].sort((a, b) => b.length - a.length)
}

export function maskText(text: string, secrets: readonly string[]): string {
  let out = text
  for (const s of secrets) if (s) out = out.split(s).join('***')
  out = out.replace(/([?&;][\w.-]*(?:key|token|secret|sig|signature|passw(?:or)?d|pwd|auth|code|credential)[\w.-]*=)[^&#\s'"<>)]+/gi, '$1***')
  return redact(out)
}

export function checkText(verdicts: McpVerdict[], secrets: readonly string[] = [], filter: string | null = null): string {
  if (!verdicts.length) {
    return filter ? `No MCP server named "${filter.slice(0, 60)}" is configured (user config, the project's entry, .mcp.json).`
      : 'No MCP servers are configured (user config, the project\'s entry, .mcp.json).'
  }
  const where = (v: McpVerdict) => `${v.name} (${v.scope}${v.type ? `, ${v.type}` : ''})`
  const lines = verdicts.map((v) => v.skipped
    ? `skip  ${where(v)}: ${v.cause}${v.fix ? `. To check it: ${v.fix}.` : '.'}`
    : v.ok
      ? `ok    ${where(v)}${v.cause !== 'ok' ? `: ${v.cause}` : ''}`
      : `FAIL  ${where(v)}: ${v.stage}: ${v.cause}. Fix: ${v.fix}.`)
  const bad = verdicts.filter((v) => !v.ok).length
  const skipped = verdicts.filter((v) => v.skipped).length
  const checked = verdicts.length - skipped
  const tail = skipped ? ` ${skipped} not checked.` : ''
  lines.push(bad ? `${bad} of ${checked} failed.${tail} After the fix, retry a server with /mcp or a ToolSearch query containing its name.`
    : checked ? `All ${checked} passed.${tail}` : `None checked.${tail}`)
  return maskText(lines.join('\n'), secrets)
}

export function noteText(verdicts: McpVerdict[], secrets: readonly string[] = [], adviceOnly: readonly string[] = []): string | null {
  const bad = verdicts.filter((v) => !v.ok)
  if (!bad.length) return null
  const held = bad.filter((v) => !adviceOnly.includes(v.name))
  const advice = bad.filter((v) => adviceOnly.includes(v.name))
  const each = (vs: McpVerdict[]) => vs.map((v) => `${v.name}: ${v.stage}: ${v.cause}. Fix: ${v.fix}.`).join(' ')
  let text = `${NOTE_LABEL} The plugin checked the MCP servers at session start because Claude Code reported them as not connected.`
  if (held.length) {
    text += ` These failed: ${each(held)} What to do: retry each server once with a ToolSearch query ` +
      'containing its name; if it still fails, apply the fix above or tell the user the cause and the fix, never only ' +
      'that it is down (the user can run /agent-services mcp check for the full check). Each of these failed servers also counts ' +
      'as an open failure, so the end of your turn is held until you close it with a block that starts with "Report:" ' +
      '(Report: MCP server <name> failed. Cause: <what caused it>. Evidence: <the check you ran>. Fix: <the fix>.) ending with ' +
      '"Fixed: <the retry that connected it>", "Skipped: <reason>" or "Needs user: <the exact step>", or with one ' +
      'line "Expected failure: <reason>" when the task does not need that server (at most 2 reminders per failure).'
  }
  if (advice.length) {
    text += ` Advice only, nothing to close: these wait for a sign-in that has never connected on this computer: ${each(advice)} ` +
      'If the task needs one of them, tell the user to run /mcp and sign in to it; otherwise ignore them.'
  }
  return maskText(`${text} This note itself is advice only and is given once per session.`, secrets)
}


const INIT_BODY = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent-services-mcp-check', version: '1' } } })

export function launchArgv(command: string, args: readonly string[], whereOut: string, windows: boolean): string[] {
  const direct = [command, ...args]
  if (!windows) return direct
  if (/[\\/]/.test(command)) {
    if (!/\.(cmd|bat)$/i.test(command)) return direct
  } else {
    const hit = String(whereOut ?? '').split(/\r?\n/).map((l) => l.trim()).find((l) => /\.(exe|com|cmd|bat)$/i.test(l))
    if (!hit || !/\.(cmd|bat)$/i.test(hit)) return direct
  }
  const call = /\s/.test(command)
  const esc = (a: string) => (/[\s"]/.test(a) ? a : a.replace(/[&|<>^()%!]/g, (c) => (call ? '^^^' : '^') + c))
  return ['cmd.exe', '/d', '/s', '/c', ...(call ? ['call', command] : [command]), ...args.map(esc)]
}

export async function probeServer(io: McpIo, s: McpServer, engine: EngineState = null): Promise<McpProbe> {
  const p: McpProbe = { engine }
  try {
    if (s.type === 'stdio') {
      if (!s.command) return p
      let whereOut = ''
      if (/[\\/]/.test(s.command)) p.found = await io.exists(s.command)
      else {
        const w = await io.run(io.windows ? ['where.exe', s.command] : ['/bin/sh', '-c', 'command -v "$1"', 'sh', s.command], { timeoutMs: MCP_TIMEOUTS.stdio })
        p.found = w.exitCode === 0
        whereOut = String(w.stdout ?? '')
      }
      if (p.found) {
        p.stdio = await io.run(launchArgv(s.command, s.args ?? [], whereOut, io.windows),
          { timeoutMs: MCP_TIMEOUTS.stdio, stdin: INIT_BODY + '\n', env: s.env ?? {} })
      }
      return p
    }
    if ((s.type !== 'http' && s.type !== 'sse') || !s.url || /\$\{/.test(s.url)) return p
    const headers: Record<string, string> = { ...(s.headers ?? {}) }
    if (s.headersHelper) {
      const env = { CLAUDE_CODE_MCP_SERVER_NAME: s.name, CLAUDE_CODE_MCP_SERVER_URL: s.url }
      p.helper = await io.run(io.windows ? ['cmd.exe', '/d', '/c', s.headersHelper] : ['/bin/sh', '-c', s.headersHelper],
        { timeoutMs: MCP_TIMEOUTS.helper, env })
      if (p.helper.timedOut || p.helper.error || p.helper.exitCode !== 0) return p
      try {
        const out = JSON.parse(String(p.helper.stdout ?? '').trim())
        if (isObj(out)) p.headers = strMap(out)
      } catch {}
      if (!p.headers) return p
      Object.assign(headers, p.headers)
      const a = Object.entries(headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1]
      if (a !== undefined && (a.trim() === '' || /^(bearer|basic|token)$/i.test(a.trim()))) return p
    }
    p.http = s.type === 'sse'
      ? await io.fetch(s.url, { method: 'GET', headers: { ...headers, accept: 'text/event-stream' }, timeoutMs: MCP_TIMEOUTS.http })
      : await io.fetch(s.url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: INIT_BODY, timeoutMs: MCP_TIMEOUTS.http })
  } catch (err) {
    p.http ??= { error: String((err as Error)?.message ?? err) }
  }
  return p
}

export async function checkServers(io: McpIo, servers: McpServer[], opts: { only?: (s: McpServer, e: EngineState) => boolean } = {}):
  Promise<{ verdicts: McpVerdict[]; secrets: string[]; connected: string[]; reasons: Record<string, string> }> {
  const connected: string[] = []
  const rows = await Promise.all(servers.map(async (s) => {
    const engine = await io.engine(s.name).catch(() => null)
    if (engine?.connected) connected.push(s.name)
    if (opts.only && !opts.only(s, engine)) return null
    const gate = engineGate(s, engine)
    if (gate) return { s, probe: { engine } as McpProbe, v: gate }
    const probe = await probeServer(io, s, engine)
    let v = classify(s, probe)
    if (!v.ok && v.stage === 'session') {
      const again = await io.engine(s.name).catch(() => null)
      if (again?.connected) v = { ...v, ok: true, stage: 'ok', cause: 'connected', fix: '' }
    }
    return { s, probe, v }
  }))
  const kept = rows.filter((r): r is NonNullable<typeof r> => r !== null)
  return { verdicts: kept.map((r) => r.v), secrets: secretsOf(kept.map((r) => r.s), kept.map((r) => r.probe)),
    connected: servers.map((s) => s.name).filter((n) => connected.includes(n)),
    reasons: Object.fromEntries(kept.map((r) => [r.s.name, String(r.probe.engine?.reason ?? '')])) }
}

export type McpSession = { note: string | null; entries: { step: string; sig: string }[]; lines: string[]; failed: number; connected: string[] }

export async function mcpSessionCheck(io: McpIo, servers: McpServer[], everConnected: readonly string[] = []): Promise<McpSession> {
  const { verdicts, secrets, connected, reasons } = await checkServers(io, servers, {
    only: (_s, e) => !!e && !e.connected && (e.reason === 'auth' || e.reason === 'failed'),
  })
  const known = new Set([...everConnected, ...connected])
  const adviceOnly = verdicts.filter((v) => !v.ok && reasons[v.name] === 'auth' && !known.has(v.name)).map((v) => v.name)
  const entries = verdicts.filter((v) => !v.ok && !adviceOnly.includes(v.name)).map((v) => ({ step: `MCP server ${v.name}`, sig: v.stage }))
  return { note: noteText(verdicts, secrets, adviceOnly), entries, lines: checkText(verdicts, secrets).split('\n'),
    failed: verdicts.filter((v) => !v.ok).length, connected }
}


async function capped<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const cap = new Promise<T>((res) => {
    timer = setTimeout(() => res(fallback), ms)
  })
  try {
    return await Promise.race([p.catch(() => fallback), cap])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function engineIo($: EngineInterface): Promise<McpIo> {
  let os = ''
  try {
    os = String((await $.env.get('OS')) ?? '')
  } catch {}
  return {
    windows: os === 'Windows_NT',
    run: async (argv, init) => {
      const t0 = Date.now()
      try {
        const r = await $.process.run(argv, { timeoutMs: init.timeoutMs, ...(init.stdin !== undefined ? { stdin: init.stdin } : {}), ...(init.env ? { env: init.env } : {}) })
        return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
      } catch (err) {
        const msg = String((err as Error)?.message ?? err)
        return Date.now() - t0 >= init.timeoutMs - 250 || /timed? ?out/i.test(msg) ? { timedOut: true } : { error: msg }
      }
    },
    fetch: async (url, init) => {
      const asked = $.http.fetch(url, { method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) })
        .then((r): HttpProbe => ({ status: r.status, ...(r.headers?.['www-authenticate'] ? { wwwAuthenticate: r.headers['www-authenticate'] } : {}) }))
        .catch((err): HttpProbe => ({ error: String((err as Error)?.message ?? err) }))
      return capped(asked, init.timeoutMs, { timedOut: true })
    },
    exists: async (path) => {
      try {
        return Boolean(await $.fs.exists(path))
      } catch {
        return false
      }
    },
    engine: async (name) => {
      const asked = $.mcp.connect(name)
        .then((r): EngineState => (r.isConnected ? { connected: true } : { connected: false, reason: r.reason, message: r.message }))
        .catch((): EngineState => null)
      return capped(asked, MCP_TIMEOUTS.engine, null)
    },
  }
}

export async function engineServers($: EngineInterface): Promise<McpServer[]> {
  const read = async (path: string): Promise<unknown> => {
    try {
      return JSON.parse(String(await $.fs.read(path)))
    } catch {
      return null
    }
  }
  const dirs = await engineDirs($)
  const global = await read(`${dirs.configSet ? dirs.configDir : dirs.home}/.claude.json`)
  let root: string | null = null
  try {
    root = String((await $.session.root()) ?? '') || null
  } catch {}
  if (!root) {
    try {
      root = String((await $.session.cwd()) ?? '') || null
    } catch {}
  }
  const jsons = root ? [await read(`${root.replace(/\\/g, '/').replace(/\/+$/, '')}/.mcp.json`)] : []
  return configuredServers(global, root, jsons)
}

export async function mcpCommand($: EngineInterface, rest: string[]): Promise<string> {
  if (rest[0]?.toLowerCase() !== 'check' || rest.length > 2) return 'Usage: /agent-services mcp check [<server>]'
  const want = rest[1] ?? null
  try {
    const all = await engineServers($)
    const servers = want ? all.filter((s) => s.name.toLowerCase() === want.toLowerCase()) : all
    const io = await engineIo($)
    if (want && !servers.length && managedName(want)) {
      const e = await io.engine(want).catch(() => null)
      const base = { name: want.slice(0, 80), scope: 'managed', type: '' }
      const v: McpVerdict = e?.connected ? { ...base, ok: true, stage: 'ok', cause: 'connected (Claude Code reports it connected)', fix: '' }
        : { ...base, ok: true, skipped: true, stage: 'skipped', cause: 'not checked (managed by Claude Code)', fix: 'see /mcp' }
      return checkText([v], [], want)
    }
    const { verdicts, secrets } = await checkServers(io, servers)
    return checkText(verdicts, secrets, want)
  } catch {
    return 'The MCP check failed to run; try again.'
  }
}

let pending: McpSession | null = null

export function mcpHold(r: McpSession | null): void {
  pending = r?.note ? r : null
}

export function mcpCheckStart($: EngineInterface): void {
  const t = setTimeout(() => {
    void capped((async () => {
      const io = await engineIo($)
      const servers = await engineServers($)
      let before: unknown = null
      try {
        before = await $.store.get(MCP_CHECK_KEY)
      } catch {}
      const ever = isObj(before) && Array.isArray(before.connected) ? before.connected.filter((x: unknown): x is string => typeof x === 'string') : []
      const r = await mcpSessionCheck(io, servers, ever)
      mcpHold(r)
      const connected = [...new Set([...r.connected, ...ever])].slice(0, 100)
      await $.store.set(MCP_CHECK_KEY, { at: Date.now(), failed: r.failed, lines: r.lines, connected })
    })(), MCP_TIMEOUTS.overall, undefined).catch(() => undefined)
  }, MCP_TIMEOUTS.start)
  ;(t as any)?.unref?.()
}

export function mcpPromptNote(e: Obj): string[] {
  if (e?.agentId || !pending?.note) return []
  const { note, entries } = pending
  pending = null
  for (const x of entries) reportOpen(x.step, x.sig)
  return [note]
}
