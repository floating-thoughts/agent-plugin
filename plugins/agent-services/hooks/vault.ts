// Secret masking on the served "vault" table: secrets in a prompt become
// {{secret:NAME}} placeholders before the model reads them; a tool call gets the real values back on this machine just
// for that call and its output is masked again; every row the conversation keeps is masked as it is stored.
//
// The vault (placeholder name -> real value) lives in this module's memory only: never written to the store, a file or
// a log, never sent anywhere, and gone when the session ends. No table (signed out) -> every helper returns null and the
// event passes through untouched. register.ts calls these helpers from its own hooks.
import type { EngineInterface } from 'claude-code'
import { onRulesClear, RULES_OFF_LINE, RULES_PENDING_LINE, rulesState, rulesTable } from './rules'

type Obj = Record<string, any>
type Pat = { kind: string; re: RegExp; group: number; mixed: boolean }
type Table = { note: string; pats: Pat[]; unmask: boolean }

let vault: Record<string, string> = {}
let foreign = new Set<string>() // placeholder names this vault does not hold (another masker's), never handed out here
let compiled: { src: unknown; table: Table | null } | null = null
let pendingSkipped = false
let pendingTold = false

// a sign-out, an expired sign-in or another account empties the vault with the tables (rules.ts clearRules)
onRulesClear(() => {
  vault = {}
  foreign = new Set<string>()
  compiled = null
})

function placeholder(name: string): string {
  return '{{secret:' + name + '}}'
}

/** The compiled served table, or null (signed out, not served, or malformed). Compiled once per table object. */
function table(): Table | null {
  const src = rulesTable<Obj>('vault')
  if (!src) return null
  if (compiled && compiled.src === src) return compiled.table
  let t: Table | null = null
  try {
    const pats: Pat[] = []
    for (const p of Array.isArray(src.patterns) ? src.patterns : []) {
      if (typeof p?.kind !== 'string' || !/^[a-z0-9_]+$/.test(p.kind) || typeof p.re !== 'string') continue
      const flags = typeof p.flags === 'string' ? p.flags : 'u'
      pats.push({
        kind: p.kind,
        re: new RegExp(p.re, flags.includes('g') ? flags : flags + 'g'),
        group: Number.isInteger(p.group) && p.group > 0 ? p.group : 0,
        mixed: p.mixed === true,
      })
    }
    if (typeof src.note === 'string' && pats.length) t = { note: src.note, pats, unmask: src.unmask === true }
  } catch {
    t = null
  }
  compiled = { src, table: t }
  return t
}

function nameFor(secret: string, kind: string, found: string[]): string {
  for (const [n, v] of Object.entries(vault)) if (v === secret) return n
  let i = 1
  while (vault[`${kind}_${i}`] !== undefined || foreign.has(`${kind}_${i}`)) i++
  const n = `${kind}_${i}`
  vault[n] = secret
  found.push(n)
  return n
}

/** Mask one text: the values the vault knows first (longest first), then each pattern; a placeholder is never touched.
 * A pattern with a group masks only that group, which is the end of its match. */
function maskText(text: string, t: Table, found: string[]): string {
  for (const m of text.matchAll(/\{\{secret:([a-z0-9_]+)\}\}/g)) if (!Object.hasOwn(vault, m[1])) foreign.add(m[1])
  let out = text
  for (const [name, value] of Object.entries(vault).sort((a, b) => b[1].length - a[1].length)) {
    if (!value || !out.includes(value)) continue
    // a long, high-entropy value is masked wherever it appears (SECRET_suffix, prefixSECRET); a short or low-entropy
    // one (the pattern loop never stores one, but the vault may hold older entries) only as a whole token, so it
    // does not corrupt ordinary words
    const weak = value.length < 8 || new Set(value).size < 5
    const head = weak && /^[A-Za-z0-9_]/.test(value) ? '(?<![A-Za-z0-9_])' : ''
    const tail = weak && /[A-Za-z0-9_]$/.test(value) ? '(?![A-Za-z0-9_])' : ''
    const re = new RegExp(head + value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + tail, 'g')
    out = out.replace(re, () => placeholder(name))
  }
  for (const p of t.pats) {
    const spans = [...out.matchAll(/\{\{secret:[a-z0-9_]+\}\}/g)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length])
    p.re.lastIndex = 0
    let res = ''
    let last = 0
    for (const m of out.matchAll(p.re)) {
      const secret = p.group ? m[p.group] : m[0]
      const end = (m.index ?? 0) + m[0].length
      if (!secret || !m[0].endsWith(secret)) continue
      const start = end - secret.length
      if (spans.some(([a, b]) => start < b && end > a)) continue
      if (p.mixed && !(/[A-Za-z]/.test(secret) && /\d/.test(secret))) continue
      // a short or low-entropy value never enters the vault: replacing it later would corrupt ordinary text
      if (secret.length < 8 || new Set(secret).size < 5) continue
      res += out.slice(last, start) + placeholder(nameFor(secret, p.kind, found))
      last = end
    }
    out = res + out.slice(last)
  }
  return out
}

function reveal(text: string): string {
  return text.replace(/\{\{secret:([a-z0-9_]+)\}\}/g, (whole: string, name: string) => (Object.hasOwn(vault, name) ? vault[name] : whole))
}

/** Apply fn to every string inside a JSON-like value, keeping its shape. */
function mapStrings(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === 'string') return fn(value)
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, fn)]))
  }
  return value
}

function kinds(names: string[]): string {
  return [...new Set(names.map((n) => n.replace(/_\d+$/, '')))].join(', ')
}

function count(n: number): string {
  return n === 1 ? '1 secret' : `${n} secrets`
}

function log($: EngineInterface, line: string): void {
  try {
    $.ui.log(line)
  } catch {}
}

/** A text with every secret masked (values this vault knows, then the patterns), for a text this plugin shows the
 * model itself (a deny reason that quotes a command); the text unchanged without a table. */
export function vaultMask(text: string): string {
  try {
    const t = table()
    return t && typeof text === 'string' ? maskText(text, t, []) : text
  } catch {
    return text
  }
}

/** prompt.submit: the event with the prompt's secrets masked and the table's note added to its context, or null when
 * nothing changed (also while signed out; while the tables are pending, see vaultPendingLine). */
export function vaultPrompt($: EngineInterface, e: Obj): Obj | null {
  try {
    const t = table()
    if (!t) {
      if (rulesState() === 'pending') pendingSkipped = true
      return null
    }
    const text = e?.text
    if (typeof text !== 'string' || !text) return null
    const found: string[] = []
    const out = maskText(text, t, found)
    if (out === text) return null
    if (found.length) {
      log($, `Secret masking: ${count(found.length)} masked (${kinds(found)}); Claude sees only ${found.map(placeholder).join(', ')}.`)
    }
    return { ...e, text: out, context: [...(Array.isArray(e.context) ? e.context : []), t.note] }
  } catch {
    return null
  }
}

/** Once per session: the line to show the user when a prompt went unmasked because the tables had not arrived yet. */
export function vaultPendingLine(): string | null {
  if (!pendingSkipped || pendingTold) return null
  pendingTold = true
  return RULES_PENDING_LINE
}

/** tool.call, before the call: the event to run with this vault's placeholders swapped for the real values (only for
 * the call itself, locally), or null when there is nothing to swap. The fields tool, tool_use_id and agentId stay.
 * Only shell commands and file writes get real values; every other tool (web, browser, MCP, Agent) keeps placeholders. */
export function vaultToolIn(e: Obj): Obj | null {
  try {
    if (table()?.unmask !== true || !Object.keys(vault).length || !e || typeof e !== 'object') return null // served per account
    if (!['Bash', 'PowerShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(String(e.tool))) return null
    const out: Obj = { ...e }
    let changed = false
    for (const [k, v] of Object.entries(e)) {
      if (k === 'tool' || k === 'tool_use_id' || k === 'agentId') continue
      const r = mapStrings(v, reveal)
      if (JSON.stringify(r) !== JSON.stringify(v)) {
        out[k] = r
        changed = true
      }
    }
    return changed ? out : null
  } catch {
    return null
  }
}

/** tool.call, after the call: the answer with secrets in its result masked again ({ result, isError, context }), or
 * null when nothing changed, the call was denied or has no result. A failed call's output is masked too. */
export function vaultToolOut($: EngineInterface, done: Obj): Obj | null {
  try {
    const t = table()
    if (!t || !done || done.deny !== undefined || done.result === undefined) return null
    const found: string[] = []
    const result = mapStrings(done.result, (s) => maskText(s, t, found))
    if (JSON.stringify(result) === JSON.stringify(done.result)) return null
    if (found.length) log($, `Secret masking: ${count(found.length)} in a tool's output masked (${kinds(found)}).`)
    return { result, ...(done.isError ? { isError: done.isError } : {}), ...(done.context ? { context: done.context } : {}) }
  } catch {
    return null
  }
}

/** session.append: the event with secrets masked in the kept row's text and tool_result blocks (tool_use and thinking
 * blocks stay exactly as they were), or null when nothing changed. */
export function vaultAppend($: EngineInterface, e: Obj): Obj | null {
  try {
    const t = table()
    const content = e?.message?.content
    if (!t || content === undefined) return null
    const found: string[] = []
    let next: unknown
    if (typeof content === 'string') {
      next = maskText(content, t, found)
      if (next === content) return null
    } else if (Array.isArray(content)) {
      let changed = false
      next = content.map((block: Obj) => {
        if (block?.type !== 'text' && block?.type !== 'tool_result') return block
        const v = mapStrings(block, (s) => maskText(s, t, found))
        if (JSON.stringify(v) === JSON.stringify(block)) return block
        changed = true
        return v
      })
      if (!changed) return null
    } else {
      return null
    }
    if (found.length) log($, `Secret masking: ${count(found.length)} masked in the conversation record (${kinds(found)}).`)
    return { ...e, message: { ...e.message, content: next } }
  } catch {
    return null
  }
}

/** /agent-services secrets [forget]: the answer lines (placeholder names only, never a value); forget empties the
 * vault, so earlier placeholders can no longer be swapped back. */
export function vaultSecrets(args: string = ''): string[] {
  if (!table()) return [rulesState() === 'pending' ? RULES_PENDING_LINE : RULES_OFF_LINE]
  if (String(args).trim() === 'forget') {
    foreign = new Set<string>([...foreign, ...Object.keys(vault)]) // names handed out before are never reused
    vault = {}
    return ["The session's secret vault is now empty; earlier placeholders can no longer be swapped back."]
  }
  const names = Object.keys(vault)
  if (!names.length) return ['No secret has been masked in this session.']
  return [
    'Secrets masked in this session (the real values stay in memory only and are gone when the session ends):',
    ...names.map((n) => '  ' + placeholder(n)),
  ]
}
