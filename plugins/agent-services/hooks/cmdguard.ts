import type { EngineInterface } from 'claude-code'
import { onRulesClear, RX_INPUT_MAX, RX_SOURCE_MAX, rulesLive, rulesTable } from './rules'
import { vaultMask } from './vault'
import { auditRecord } from './audit_log'

type Obj = Record<string, any>
type CommandRule = { id: string; scope?: 'command' | 'stage'; unquote?: boolean; pattern: string; flags?: string; when?: string; reason: string }
type UrlRule = { host?: string; port?: string; path?: string; else?: string }
type Table = {
  commands?: CommandRule[]
  mail?: { tools?: string; url_keys?: string; hosts?: string[]; urls?: UrlRule[]; tab_free?: string; tab_reset?: string; reason?: string }
  spawn_background?: boolean
  promise?: { patterns?: string[]; for_user?: string[]; ends?: string[]; reason?: string }
}

let mailTabs = new Set<string>()
let mailEver = new Set<string>()
let fronted = new Map<string, string>()
onRulesClear(() => {
  mailTabs = new Set<string>()
  mailEver = new Set<string>()
  fronted = new Map<string, string>()
})

function table(): Table | null {
  const t = rulesTable<Table>('cmdguard')
  return t && typeof t === 'object' ? t : null
}

function rx(source: string | undefined, flags = ''): RegExp | null {
  if (typeof source !== 'string' || source.length > RX_SOURCE_MAX) return null
  try {
    return new RegExp(source, flags)
  } catch {
    return null
  }
}

function fill(text: string, key: string, value: string): string {
  return text.split(`{${key}}`).join(value)
}


export function commandsOf(command: string): string[] {
  const text = command
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, (s: string, _q: string, _w: string, at: number, all: string) =>
      /(?:^|[\s|;&(/])(?:(?:ba|da|z|k)?sh|pwsh|powershell)(?:\.exe)?(?:\s+-\S+)*\s*$/i.test(all.slice(all.lastIndexOf('\n', at - 1) + 1, at)) ||
      /^[^\n]*\|\s*(?:(?:ba|da|z|k)?sh|pwsh|powershell)\b/i.test(s)
        ? s
        : '<<HEREDOC')
    .replace(/@(['"])[ \t]*\r?\n[\s\S]*?\r?\n\1@/g, "'Q'")
    .replace(/"[^"]*"/g, (s) => (s.includes('\n') && !/\$\(|`/.test(s) ? '"Q"' : s))
    .replace(/((?:^|\s)(?:-m|--message)(?:\s+|=))'[^']*'/g, (s, head: string) => (s.includes('\n') ? `${head}'Q'` : s))
  return splitOutsideQuotes(text, /\n|;|&&|\|\||(?<![>&])&(?![&>])|\$\(|[()`]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function splitOutsideQuotes(text: string, sep: RegExp): string[] {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (c === '\\') {
      out += text.slice(i, i + 2)
      i++
      continue
    }
    const j = c === '"' || c === "'" ? text.indexOf(c, i + 1) : -1
    if (j < 0) {
      out += c
      continue
    }
    const span = text.slice(i, j + 1)
    out += c === '"' && /\$\(|`/.test(span) ? span : span.replace(/[;&|()]/g, (x) => String.fromCharCode(0xe000 + ';&|()'.indexOf(x)))
    i = j
  }
  return out.split(sep).map((s) => s.replace(/[\ue000-\ue004]/g, (x) => ';&|()'[x.charCodeAt(0) - 0xe000]!))
}

export function wordsOf(stage: string): string[] {
  const out: string[] = []
  for (const m of stage.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

export function programBase(token: string): string {
  const last = token.split(/[\\/]/).pop() ?? ''
  return last.toLowerCase().replace(/\.(?:exe|cmd|bat|ps1|sh|py|js|mjs)$/, '')
}

export function programWords(stage: string): string[] {
  let toks = wordsOf(stage.replace(/^\s*&\s*/, ''))
  while (toks.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0]!) || /^(?:sudo|env|time|nohup|command|exec|npx|bunx|call)$/i.test(toks[0]!))) toks = toks.slice(1)
  return toks
}

export function shellLine(words: string[]): string | null {
  const low = words.map((t) => t.toLowerCase())
  const prog = low.length ? programBase(low[0]!) : ''
  if (prog === 'cmd') {
    const i = low.findIndex((a, k) => k > 0 && /^\/[ck]$/.test(a))
    return i > 0 && i + 1 < words.length ? words.slice(i + 1).join(' ') : null
  }
  if (!/^(?:bash|sh|zsh|dash|ksh|pwsh|powershell)$/.test(prog)) return null
  for (let i = 1; i < low.length; i++) {
    const a = low[i]!
    if (/^-(?:c|command)$/.test(a) || (/^(?:bash|sh|zsh|dash|ksh)$/.test(prog) && /^-[a-z]*c[a-z]*$/.test(a))) return i + 1 < words.length ? words[i + 1]! : null
    if (!a.startsWith('-')) return null
  }
  return null
}

function ruleMatch(rule: CommandRule, one: string): string | null {
  const re = rx(rule.pattern, rule.flags ?? '')
  if (!re) return null
  const parts = rule.scope === 'stage' ? splitOutsideQuotes(one, /\|/).map((s) => s.trim()) : [one]
  for (const part of parts) {
    const bare = (m: string, a?: string, b?: string): string => (/^[-.:]/.test(a ?? b ?? '') ? (a ?? b)! : 'Q')
    const text = rule.unquote ? part.replace(/"([^"\s]*)"|'([^'\s]*)'/g, bare).replace(/"[^"]*"|'[^']*'/g, 'Q') : part
    if (re.test(text.slice(0, RX_INPUT_MAX))) return part
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

export function commandRule(command: string): { id: string; command: string; when: string } | null {
  const m = matches(String(command ?? ''))[0]
  return m ? { id: m.rule.id, command: m.command, when: m.rule.when ?? 'always' } : null
}

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
    await cmdguardAudit($, e)
    return { deny: fill(String(rule.reason ?? ''), 'command', vaultMask(hit)) }
  }
  return next(e)
}

async function cmdguardAudit($: EngineInterface, e: Obj): Promise<void> {
  try {
    const { tool, agentId, tool_use_id: _call, ...input } = e && typeof e === 'object' && !Array.isArray(e) ? e : ({} as Obj)
    let session = ''
    try {
      session = String((await $.session.id()) ?? '')
    } catch {}
    let at = Date.now()
    try {
      const n = Number(await $.clock.now())
      if (Number.isFinite(n)) at = n
    } catch {}
    await auditRecord($, { at, session, agent: typeof agentId === 'string' ? agentId : null, rule: 'command_guard', kind: 'refuse', tool: String(tool ?? ''), input })
  } catch {}
}

export function installCmdguard(on: any): void {
  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($: EngineInterface, e: Obj, next: any) => cmdguardBash($, e, next))
    .catch(($: EngineInterface, e: Obj, next: any) => next(e))
}


function hostOf(raw: string): { host: string; path: string; port: string } | null {
  const s = raw.trim()
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : /^[\w-]+(\.[\w-]+)+([:/?#]|$)/.test(s) ? `https://${s}` : null
  if (withScheme === null) return null
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/:?#]+)(?::(\d+))?([^?#]*)/i.exec(withScheme)
  return m ? { host: m[1]!.toLowerCase().replace(/\.$/, ''), port: m[2] ?? '', path: m[3] ?? '' } : null
}

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

export function urlsIn(input: unknown): string[] {
  const keys = rx(table()?.mail?.url_keys, 'i')
  const out: string[] = []
  const walk = (v: unknown, key: string, depth: number): void => {
    if (depth > 6) return
    if (typeof v === 'string') {
      if (keys?.test(key)) out.push(v)
      for (const m of v.matchAll(/https?:\/\/[^\s"'`<>)\]}\\]+/gi)) {
        out.push(m[0])
        let rest = m[0].slice(1)
        try {
          rest = decodeURIComponent(rest)
        } catch {}
        for (const n of rest.matchAll(/https?:\/\/[^\s"'`<>)\]}\\]+/gi)) out.push(n[0])
      }
    } else if (Array.isArray(v)) {
      v.forEach((x) => walk(x, key, depth + 1))
    } else if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, k, depth + 1)
    }
  }
  walk(input, '', 0)
  return out
}

function tabsShown(text: string): { id: number | string; mail: boolean; active: boolean }[] {
  const out: { id: number | string; mail: boolean; active: boolean }[] = []
  const s = String(text ?? '')
  const hits = [...s.matchAll(/tab\s*_?id[\\"']*\s*[:=]\s*[\\"']*([\w.-]+)/gi)].filter((m) => !/^(null|undefined|true|false)$/i.test(m[1]!))
  hits.forEach((m, i) => {
    const end = i + 1 < hits.length ? hits[i + 1]!.index! : Math.min(s.length, m.index! + 600)
    const part = s.slice(m.index!, end)
    out.push({
      id: /^\d+$/.test(m[1]!) ? Number(m[1]) : m[1]!,
      mail: urlsIn(part).some(isMailUrl),
      active: /\b(?:is_?active|active)[\\"']*\s*[:=]\s*true\b/i.test(part),
    })
  })
  return out
}

export function mailTabsIn(text: string): (number | string)[] {
  return tabsShown(text).filter((t) => t.mail).map((t) => t.id)
}

function tabIdOf(e: Obj): string | null {
  const v = e?.tabId ?? e?.tab_id
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
}

const familyOf = (tool: string): string => (tool.includes('__') ? tool.slice(0, tool.lastIndexOf('__')) : tool)

function stepsOf(e: Obj): { tool: string; tab: string | null; history: boolean }[] {
  const tool = String(e?.tool ?? '')
  const history = (x: Obj): boolean => /^\s*(?:back|forward)\s*$/i.test(String(x?.url ?? ''))
  if (!Array.isArray(e?.actions)) return [{ tool, tab: tabIdOf(e), history: history(e) }]
  return e.actions.map((a: Obj) => ({
    tool: `${familyOf(tool)}__${String(a?.name ?? a?.tool ?? '')}`,
    tab: tabIdOf(a?.input ?? a),
    history: history(a?.input ?? a),
  }))
}

const onFronted = (tool: string): boolean =>
  /Claude_Browser__/.test(tool) && !/__(?:tabs_\w+|preview_\w+|browser_batch|resize_window)$/.test(tool)

function mailTool(e: Obj): boolean {
  return typeof e?.tool === 'string' && (rx(table()?.mail?.tools)?.test(e.tool) ?? false)
}

export function mailDeny(e: Obj): string | null {
  try {
    const mail = table()?.mail
    if (!mail || !mailTool(e)) return null
    const reason = (what: string) => fill(String(mail.reason ?? ''), 'what', what)
    const { tool: _tool, agentId: _agent, tool_use_id: _call, ...input } = e
    const url = urlsIn(input).find(isMailUrl)
    if (url !== undefined) return reason(url)
    const free = rx(mail.tab_free, 'i')
    const reset = rx(mail.tab_reset, 'i')
    const seen = new Set(mailTabs)
    for (const s of stepsOf(e)) {
      const family = familyOf(s.tool)
      const key = s.tab !== null ? `${family}:${s.tab}` : onFronted(s.tool) ? fronted.get(family) ?? null : null
      if (free?.test(s.tool) ?? false) {
        if (key !== null && s.history && mailEver.has(key)) seen.add(key)
        else if (key !== null && ((reset?.test(s.tool) ?? false) || /tabs_close/i.test(s.tool))) seen.delete(key)
        continue
      }
      if (key !== null && seen.has(key)) return reason(`tab ${key.slice(family.length + 1)}`)
      if (s.tab === null && key === null && onFronted(s.tool) && [...seen].some((k) => k.startsWith(`${family}:`))) {
        return reason('the fronted tab')
      }
    }
    return null
  } catch {
    return null
  }
}

export function mailAfter(e: Obj, done: unknown): void {
  try {
    const mail = table()?.mail
    if (!mail || !mailTool(e)) return
    const family = familyOf(String(e.tool))
    for (const s of stepsOf(e)) {
      const key = s.tab !== null ? `${family}:${s.tab}` : onFronted(s.tool) ? fronted.get(family) ?? null : null
      if (key !== null && s.history && mailEver.has(key)) mailTabs.add(key)
      else if (key !== null && (rx(mail.tab_reset, 'i')?.test(s.tool) ?? false)) mailTabs.delete(key)
      if (/tabs_select|switch_to_tab/i.test(s.tool)) {
        if (s.tab !== null) fronted.set(family, `${family}:${s.tab}`)
        else fronted.delete(family)
      }
      if (/tabs_create/i.test(s.tool) && e.foreground === true) fronted.delete(family)
      if (/tabs_close/i.test(s.tool) && key !== null) {
        mailTabs.delete(key)
        mailEver.delete(key)
        if (fronted.get(family) === key) fronted.delete(family)
      }
    }
    for (const t of tabsShown(JSON.stringify(done) ?? '')) {
      if (t.mail) mailTabs.add(`${family}:${t.id}`)
      if (t.mail) mailEver.add(`${family}:${t.id}`)
      if (t.active) fronted.set(family, `${family}:${t.id}`)
    }
  } catch {}
}

export function mailReset(): void {
  mailTabs = new Set<string>()
  mailEver = new Set<string>()
  fronted = new Map<string, string>()
}


export function spawnBackground(e: Obj): Obj {
  if (table()?.spawn_background !== true || !e || e.parentAgentId !== undefined || e.isTeammate || e.background) return e
  return { ...e, background: true }
}


function joined(list: string[] | undefined, flags: string): RegExp | null {
  const parts = (list ?? []).filter((p) => typeof p === 'string' && rx(p, flags) !== null)
  if (!parts.length) return null
  try {
    return new RegExp(parts.join('|'), flags)
  } catch {
    return null
  }
}

export function promisedWork(text: string): string | null {
  const p = table()?.promise
  const body = String(text ?? '').trim().slice(-RX_INPUT_MAX)
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
