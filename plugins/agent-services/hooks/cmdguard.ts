// Command guard: a generic matcher run locally on the served cmdguard table.
// - Bash and PowerShell: each command of a line (split at ; && || and newlines, heredoc bodies left out) or each pipe stage is matched
//   against the table's patterns; a match is refused with the table's reason, some only while other agents run.
// - Browser tools and WebFetch: a URL of a webmail site in the input is refused, and so is a later call on a tab seen
//   showing one (navigating that tab away or closing it stays allowed).
// - The main conversation's subagents run in the background when the table says so.
// - Stop: a main turn that ends on a promise of more of its own work, with nothing in flight to wake it, is sent back
//   once; a second stop (stop_hook_active) goes through.
// No table (signed out) means every helper here passes its event through untouched. Nothing is ever sent anywhere.
import type { EngineInterface } from 'claude-code'
import { onRulesClear, rulesLive, rulesTable } from './rules'
import { vaultMask } from './vault'

type Obj = Record<string, any>
type CommandRule = { id: string; scope?: 'command' | 'stage'; unquote?: boolean; pattern: string; flags?: string; when?: string; reason: string }
type UrlRule = { host?: string; port?: string; path?: string; else?: string }
type Table = {
  commands?: CommandRule[]
  mail?: { tools?: string; url_keys?: string; hosts?: string[]; urls?: UrlRule[]; tab_free?: string; tab_reset?: string; reason?: string }
  spawn_background?: boolean
  promise?: { patterns?: string[]; for_user?: string[]; ends?: string[]; reason?: string }
}

let mailTabs = new Set<number>()
onRulesClear(() => {
  mailTabs = new Set<number>()
})

function table(): Table | null {
  const t = rulesTable<Table>('cmdguard')
  return t && typeof t === 'object' ? t : null
}

function rx(source: string | undefined, flags = ''): RegExp | null {
  if (typeof source !== 'string') return null
  try {
    return new RegExp(source, flags)
  } catch {
    return null
  }
}

function fill(text: string, key: string, value: string): string {
  return text.split(`{${key}}`).join(value)
}

// ---------------------------------------------------------------- Bash

/** The commands of a line: heredoc bodies (data, not commands) left out, split at newlines, ; && || and a single &
 * (not a redirection such as 2>&1), and where a subshell, $( ) or backticks open or close. */
export function commandsOf(command: string): string[] {
  return command
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, '<<HEREDOC')
    .split(/\n|;|&&|\|\||(?<![>&])&(?![&>])|\$\(|[()`]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function ruleMatch(rule: CommandRule, one: string): string | null {
  const re = rx(rule.pattern, rule.flags ?? '')
  if (!re) return null
  const parts = rule.scope === 'stage' ? one.split('|').map((s) => s.trim()) : [one]
  for (const part of parts) {
    // a quoted single option or path ("-A", '.', ":/") is read as written; other quoted text is data
    const bare = (m: string, a?: string, b?: string): string => (/^[-.:]/.test(a ?? b ?? '') ? (a ?? b)! : 'Q')
    const text = rule.unquote ? part.replace(/"([^"\s]*)"|'([^'\s]*)'/g, bare).replace(/"[^"]*"|'[^']*'/g, 'Q') : part
    if (re.test(text)) return part
  }
  return null
}

function matches(command: string): { rule: CommandRule; command: string }[] {
  const rules = table()?.commands
  if (!Array.isArray(rules)) return []
  const out: { rule: CommandRule; command: string }[] = []
  for (const rule of rules) {
    for (const one of commandsOf(command)) {
      const hit = ruleMatch(rule, one)
      if (hit !== null) {
        out.push({ rule, command: hit })
        break
      }
    }
  }
  return out
}

/** The first table rule a command line matches (whatever its condition), or null. */
export function commandRule(command: string): { id: string; command: string; when: string } | null {
  const m = matches(String(command ?? ''))[0]
  return m ? { id: m.rule.id, command: m.command, when: m.rule.when ?? 'always' } : null
}

/** The Bash and PowerShell tool.call hook: a matching command is refused with the table's reason; a rule with when
 * "others_running" refuses only while another agent of this session is running. A failed check never stops it. The
 * command quoted in the reason is masked first, so a secret put back into the call is never shown to the model. */
export async function cmdguardBash($: EngineInterface, e: Obj, next: (e: Obj) => Promise<any>): Promise<any> {
  await rulesLive()
  const command = String(e?.command ?? '')
  let others: boolean | null = null
  for (const { rule, command: hit } of matches(command)) {
    if (rule.when === 'others_running') {
      if (others === null) {
        const list: Obj[] = await Promise.resolve($.agent.list()).catch(() => [])
        others = (Array.isArray(list) ? list : []).some((a) => a?.status === 'running' && a?.id !== e?.agentId)
      }
      if (!others) continue
    }
    return { deny: fill(String(rule.reason ?? ''), 'command', vaultMask(hit)) }
  }
  return next(e)
}

export function installCmdguard(on: any): void {
  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($: EngineInterface, e: Obj, next: any) => cmdguardBash($, e, next))
    .catch(($: EngineInterface, e: Obj, next: any) => next(e))
}

// ---------------------------------------------------------------- webmail

function hostOf(raw: string): { host: string; path: string; port: string } | null {
  const s = raw.trim()
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : /^[\w-]+(\.[\w-]+)+([:/?#]|$)/.test(s) ? `https://${s}` : null
  if (withScheme === null) return null
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/:?#]+)(?::(\d+))?([^?#]*)/i.exec(withScheme)
  return m ? { host: m[1]!.toLowerCase().replace(/\.$/, ''), port: m[2] ?? '', path: m[3] ?? '' } : null
}

/** Whether one URL (with or without a scheme) is a webmail page by the table's hosts and URL rules. */
export function isMailUrl(raw: string): boolean {
  const mail = table()?.mail
  const u = typeof raw === 'string' ? hostOf(raw) : null
  if (!mail || u === null) return false
  if ((mail.hosts ?? []).some((h) => u.host === h || u.host.endsWith(`.${h}`))) return true
  for (const r of mail.urls ?? []) {
    const hostOk = r.host === undefined || (rx(r.host, 'i')?.test(u.host) ?? false)
    const portOk = r.port === undefined || (rx(r.port)?.test(u.port) ?? false)
    if (!hostOk || !portOk) continue
    if (r.path === undefined || (rx(r.path, 'i')?.test(u.path) ?? false)) return true
    if (r.else !== 'next') return false
  }
  return false
}

/** The URLs in a tool input: url-like fields as they are (scheme optional), and any http(s) URL inside other text. */
export function urlsIn(input: unknown): string[] {
  const keys = rx(table()?.mail?.url_keys, 'i')
  const out: string[] = []
  const walk = (v: unknown, key: string, depth: number): void => {
    if (depth > 6) return
    if (typeof v === 'string') {
      if (keys?.test(key)) out.push(v)
      for (const m of v.matchAll(/https?:\/\/[^\s"'`<>)\]}]+/gi)) out.push(m[0])
    } else if (Array.isArray(v)) {
      v.forEach((x) => walk(x, key, depth + 1))
    } else if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, k, depth + 1)
    }
  }
  walk(input, '', 0)
  return out
}

/** Tabs a tool result shows on a webmail site ("tabId": 12 ... "url": "https://mail..."), also in JSON-escaped text. */
export function mailTabsIn(text: string): number[] {
  const tabs: number[] = []
  const hits = [...String(text ?? '').matchAll(/tab\s*_?id[\\"']*\s*[:=]\s*[\\"']*(\d+)/gi)]
  hits.forEach((m, i) => {
    const end = i + 1 < hits.length ? hits[i + 1]!.index! : Math.min(text.length, m.index! + 600)
    if (urlsIn(text.slice(m.index!, end)).some(isMailUrl)) tabs.push(Number(m[1]))
  })
  return tabs
}

function tabIdOf(e: Obj): number | null {
  const v = e?.tabId ?? e?.tab_id
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

function mailTool(e: Obj): boolean {
  return typeof e?.tool === 'string' && (rx(table()?.mail?.tools)?.test(e.tool) ?? false)
}

/** Before a tool call (tool name plus its input fields): the deny reason for a browser tool or WebFetch call that
 * opens a webmail URL or acts on a tab remembered as showing one; null to let it run. */
export function mailDeny(e: Obj): string | null {
  try {
    const mail = table()?.mail
    if (!mail || !mailTool(e)) return null
    const reason = (what: string) => fill(String(mail.reason ?? ''), 'what', what)
    const { tool: _tool, agentId: _agent, tool_use_id: _call, ...input } = e
    const url = urlsIn(input).find(isMailUrl)
    if (url !== undefined) return reason(url)
    const tab = tabIdOf(e)
    if (tab !== null && mailTabs.has(tab) && !(rx(mail.tab_free, 'i')?.test(e.tool) ?? false)) return reason(`tab ${tab}`)
    return null
  } catch {
    return null
  }
}

/** After a tool call: remember the tabs its result shows on a webmail site; a tab navigated elsewhere is forgotten. */
export function mailAfter(e: Obj, done: unknown): void {
  try {
    const mail = table()?.mail
    if (!mail || !mailTool(e)) return
    const tab = tabIdOf(e)
    if (tab !== null && (rx(mail.tab_reset, 'i')?.test(e.tool) ?? false)) mailTabs.delete(tab)
    mailTabsIn(JSON.stringify(done) ?? '').forEach((t) => mailTabs.add(t))
  } catch {}
}

/** Forget every remembered tab (tests; a new session). */
export function mailReset(): void {
  mailTabs = new Set<number>()
}

// ---------------------------------------------------------------- background spawns

/** agent.spawn, before next(): the main conversation's foreground spawn (not a teammate) runs in the background
 * when the table's spawn_background flag is on; any other spawn is returned as it is. */
export function spawnBackground(e: Obj): Obj {
  if (table()?.spawn_background !== true || !e || e.parentAgentId !== undefined || e.isTeammate || e.background) return e
  return { ...e, background: true }
}

// ---------------------------------------------------------------- Stop send-back

function joined(list: string[] | undefined, flags: string): RegExp | null {
  const parts = (list ?? []).filter((p) => typeof p === 'string' && rx(p, flags) !== null)
  return parts.length ? rx(parts.join('|'), flags) : null
}

/** The sentence of a reply that promises more of its own work, cut to a short quote; null when it promises none or
 * leaves the next move to the user. */
export function promisedWork(text: string): string | null {
  const p = table()?.promise
  const body = String(text ?? '').trim()
  const promise = joined(p?.patterns, 'i')
  if (!p || !promise || body === '' || joined(p.for_user, 'i')?.test(body)) return null
  const m = promise.exec(body)
  if (!m) return null
  const ends = (p.ends ?? []).filter((x) => typeof x === 'string' && x !== '')
  let start = 0
  for (const x of ends) {
    const i = m.index > 0 ? body.lastIndexOf(x, m.index - 1) : -1
    if (i >= 0) start = Math.max(start, i + x.length)
  }
  const stops = ends.map((x) => body.indexOf(x, m.index)).filter((i) => i >= 0)
  const end = stops.length ? Math.min(...stops) + 1 : body.length
  const quote = body.slice(start, end).trim()
  return quote.length > 120 ? `${quote.slice(0, 120)}...` : quote
}

/** classic.Stop, after next(): the answer with a block that sends the turn back once when the reply promises more
 * of its own work and no background task is in flight; otherwise the answer as it is. */
export function stopSendBack(e: Obj, done: Obj): Obj {
  try {
    const reason = table()?.promise?.reason
    if (!reason || !done || done.block !== undefined || e?.stop_hook_active) return done
    const tasks: Obj[] = Array.isArray(e?.background_tasks) ? e.background_tasks : []
    if (tasks.some((t) => /running|pending/i.test(String(t?.status ?? '')))) return done
    const quote = promisedWork(String(e?.last_assistant_message ?? ''))
    return quote === null ? done : { ...done, block: fill(reason, 'quote', quote) }
  } catch {
    return done
  }
}
