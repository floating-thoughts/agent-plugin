import { rulesTable } from './rules'
import { exitOf, stagesOf } from './evidence'

type Obj = Record<string, any>
type Texts = Record<string, string>
type FR = { failed?: string[]; neutral?: string[]; meta?: string[]; cause?: string[]; fix?: string[]; past?: string[]; earlier?: string[]; report_head?: string; side_effect?: string; deny?: string; texts?: Texts }
export type Entry = {
  key: string; agent: string; tool: string; step: string; sig: string; seq: number; match: string; prompt: number
  denied: boolean; sideEffect: boolean; expensive: boolean
  rounds: number; asked: number; state: 'open' | 'fixed' | 'skipped' | 'needs_user' | 'expected' | 'exhausted' | 'carried'; notified: boolean
}
type Call = { seq: number; agent: string; tool: string; ok: boolean; match: string; test: boolean; cmd: string; testWrite: string }
export type ReportBlock = { kind: 'report' | 'expected'; text: string; step: string; cause: string; evidence: string; fix: string; fixed: string; skipped: string; needsUser: string }

export const SUB_BLOCK_CAP = 4
let entries: Entry[] = []
let calls: Call[] = []
let seq = 0
let promptNo = 0
let subBlocks: Record<string, number> = {}
let handback: string[] = []
let gapSaid: string[] = []
let names: Record<string, string> = {}
let seenBlocks: string[] = []

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const fr = (): FR | null => {
  const t = rulesTable<Obj>('cmdguard')
  return isObj(t) && isObj(t.failure_report) ? (t.failure_report as FR) : null
}
const rxOf = (list: string[] | string | undefined, flags = 'i'): RegExp | null => {
  const parts = (Array.isArray(list) ? list : list ? [list] : []).filter((p) => typeof p === 'string' && p.length <= 512)
  if (!parts.length) return null
  try {
    return new RegExp(parts.join('|'), flags)
  } catch {
    return null
  }
}
const fill = (t: string, v: Record<string, string | number>): string =>
  Object.entries(v).reduce((s, [k, x]) => s.split(`{${k}}`).join(String(x)), t)
const words = (t: string): Set<string> => {
  const stop = new Set('the and for with from that this was were are not but has have had its into out via one all any then than when after before failed fail fails failing error errors cause evidence fix fixed tried report step'.split(' '))
  return new Set((t.toLowerCase().match(/[a-z0-9_.\-/]{3,}|[\u4e00-\u9fff]{2,}/g) ?? []).map((w) => w.replace(/[.\-/]+$/, '')).filter((w) => w.length >= 3 && !stop.has(w) || /[\u4e00-\u9fff]/.test(w)))
}
const label = (e: Entry): string => `${e.step}${e.sig ? ` (${e.sig})` : ''}`
const isShell = (tool: string): boolean => tool === 'Bash' || tool === 'PowerShell'
const sideEffectOf = (step: string): boolean => rxOf(fr()?.side_effect)?.test(step) ?? false
const sep = '\\s*[:\\uff1a\\-]'
const fieldNames = '(?:Cause|Evidence|Tried|Fix|Fixed|Skipped|Needs user)'


function textOf(result: unknown): string {
  if (typeof result === 'string') return result
  if (Array.isArray(result)) return result.map((p) => (isObj(p) && typeof p.text === 'string' ? p.text : typeof p === 'string' ? p : '')).join('\n')
  if (isObj(result)) return typeof result.text === 'string' ? result.text : [result.stdout, result.stderr].filter((x) => typeof x === 'string').join('\n')
  return ''
}

export function stepOf(e: Obj): string {
  const i = isObj(e.input) ? e.input : e
  const cmd = typeof i.command === 'string' ? i.command : ''
  const target = cmd || i.file_path || i.path || i.url || i.description || i.subagent_type || i.pattern || ''
  const s = String(target).replace(/\s+/g, ' ').trim()
  return (cmd ? s : `${e.tool ?? 'tool'}${s ? ` ${s}` : ''}`).slice(0, 80)
}

export function stepKey(tool: string, input: Obj): string {
  const i = isObj(input) ? input : {}
  if (isShell(tool)) {
    const stages = String(i.command ?? '').split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean)
    const stage = stages.find((s) => !/^(?:cd|set-location|pushd|popd|export|set|source)\b/i.test(s)) ?? stages[0] ?? ''
    const toks = stage.split(/\s+/).filter((t) => t && !/^\w+=/.test(t))
    const head = (toks[0] ?? '').replace(/^.*[\\/]/, '').toLowerCase()
    return `sh:${[head, ...toks.slice(1).filter((t) => !t.startsWith('-')).slice(0, 2)].join(' ')}`
  }
  if (['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    return `file:${tool}:${String(i.file_path ?? i.notebook_path ?? i.path ?? '').replace(/\\/g, '/').toLowerCase()}`
  }
  const mcp = /^mcp__(.+?)__/.exec(tool)
  if (mcp) return `mcp:${mcp[1]!.toLowerCase()}`
  if (tool === 'Agent' || tool === 'Task') return `agent:${String(i.description ?? i.subagent_type ?? '').toLowerCase()}`
  return `${tool}:${stepOf({ tool, input: i })}`
}

export function sigOf(text: string): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !/^exit code:? -?\d+$/i.test(l)) ?? (/exit code:? (-?\d+)/i.exec(text)?.[0] ?? '')
  return line.toLowerCase().replace(/0x[0-9a-f]+|[0-9a-f]{8,}|\d+/g, '#').slice(0, 60)
}

export function expectedFailure(e: Obj, done: Obj, testWrittenBefore: boolean): boolean {
  if (!isShell(e.tool)) return false
  const cmd = String((isObj(e.input) ? e.input.command : e.command) ?? '').trim()
  const text = textOf(done.result)
  const exit = exitOf(done, text)
  const rest = text.replace(/^\s*exit code:? -?\d+\s*/i, '').trim()
  const last = cmd.split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean).pop() ?? ''
  const head = last.split(/\s+/)[0]?.replace(/^.*[\\/]/, '').toLowerCase() ?? ''
  if (exit === 1 && ['diff', 'cmp', 'fc'].includes(head)) return true
  if (exit === 1 && /^git\s+diff\b/.test(last)) return true
  if (exit === 1 && rest === '' && ['grep', 'egrep', 'fgrep', 'rg', 'find', 'test', '[', 'findstr', 'where', 'where.exe', 'which', 'select-string', 'test-path', 'ls'].includes(head)) return true
  if (testWrittenBefore && stagesOf(cmd, e.tool).some((h) => h.kind === 'test')) return true
  return false
}

export function expensiveStep(step: string, tool = 'Bash'): boolean {
  if (/\b(?:deploy|render|remotion|make-bundle|install\.sh|release|docker build|--full)\b/i.test(step)) return true
  const hits = stagesOf(step, tool === 'PowerShell' ? 'PowerShell' : 'Bash')
  if (hits.some((h) => h.kind === 'build')) return true
  return hits.some((h) => h.kind === 'test') && !/(?:test_\w+\.|\.test\.|\.spec\.|::|\s-k\s|\s--grep\s|\s-t\s)/i.test(step)
}

export function reportBlocks(message: string): ReportBlock[] {
  const text = String(message ?? '')
  const starts: { at: number; kind: 'report' | 'expected' }[] = []
  const rx = new RegExp(`^[ \\t>*_#-]*(?:\\*\\*)?(Report|Expected failure)\\b(?:\\*\\*)?${sep}`, 'gim')
  for (let m = rx.exec(text); m; m = rx.exec(text)) starts.push({ at: m.index, kind: /^expected/i.test(m[1]!) ? 'expected' : 'report' })
  return starts.map((s, i) => {
    let body = text.slice(s.at, i + 1 < starts.length ? starts[i + 1]!.at : text.length)
    if (s.kind === 'expected') body = body.split(/\r?\n/)[0]!
    body = body.slice(0, 2000)
    const field = (name: string): string => {
      const m = new RegExp(`\\b${name}${sep}\\s*([\\s\\S]*?)(?=\\b${fieldNames}${sep}|$)`, 'i').exec(body)
      return m ? m[1]!.replace(/\s+/g, ' ').trim().replace(/[.;,\u3002\uff1b\uff0c]$/, '') : ''
    }
    const head = body.replace(/^[^:\uff1a\-]*[:\uff1a\-]\s*/, '')
    const step = (head.split(new RegExp(`\\b${fieldNames}${sep}`, 'i'))[0] ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)
    return {
      kind: s.kind, text: body, step,
      cause: field('Cause'), evidence: field('Evidence'), fix: field('Fix'),
      fixed: field('Fixed'), skipped: field('Skipped'), needsUser: field('Needs user'),
    }
  })
}

export function failureGap(text: string, closed: readonly string[] = []): string | null {
  const f = fr()
  const failed = rxOf(f?.failed)
  if (!f || !failed) return null
  let body = String(text ?? '').slice(-8192)
  for (const b of reportBlocks(body)) body = body.replace(b.text, ' ')
  const head = typeof f.report_head === 'string' && f.report_head.length <= 512 ? rxOf(f.report_head, 'im') : null
  const at = head ? body.search(head) : -1
  if (at >= 0) body = body.slice(0, at)
  const neutral = rxOf(f.neutral, 'gi')
  if (neutral) body = body.replace(neutral, ' ')
  const causeRx = rxOf(f.cause, 'im')
  const fixRx = rxOf(f.fix, 'im')
  const cause = causeRx?.test(body) ?? false
  const fix = fixRx?.test(body) ?? false
  if (cause && fix) return null
  const past = rxOf(f.past)
  const earlier = rxOf(f.earlier)
  const meta = rxOf(f.meta)
  const shut = closed.map((c) => words(c))
  const lines = body.replace(/```[\s\S]*?(?:```|$)/g, ' ').split(/\r?\n/).filter((l) => !/^\s*(?:>\s*)?(?:[-*+\u2022]|\d+[.)]|#{1,6})\s/.test(l))
  const bare = (q: string) => q.replace(/`[^`]*`|"[^"]*"|\u201c[^\u201d]*\u201d|\u300c[^\u300d]*\u300d|\u300e[^\u300f]*\u300f/g, ' ')
  for (const s of lines.flatMap((l) => l.split(/(?<=[.!?])\s+|(?<=[\u3002\uff01\uff1f])/))) {
    const quote = s.trim()
    if (!quote || !failed.test(bare(quote))) continue
    if (meta?.test(quote)) continue
    const w = words(quote)
    if (shut.some((c) => [...w].some((x) => c.has(x)))) continue
    if (fixRx?.test(quote)) continue
    if (causeRx?.test(quote) && past?.test(quote) && (earlier?.test(quote) || fix)) continue
    return quote.length > 120 ? `${quote.slice(0, 120)}...` : quote
  }
  return null
}

export function matchEntry(open: Entry[], b: ReportBlock): Entry | null {
  if (open.length === 1) return open[0]!
  const bs = words(b.step)
  const all = words(`${b.step} ${b.cause} ${b.evidence}`)
  const shared = (a: Set<string>, w: Set<string>) => [...a].filter((x) => w.has(x)).length
  let best: Entry | null = null
  let score: [number, number] = [0, 0]
  for (const e of open) {
    const s: [number, number] = [shared(words(e.step), bs), shared(words(`${e.step} ${e.sig}`), all)]
    if (s[0] > score[0] || (s[0] === score[0] && s[1] > score[1])) [best, score] = [e, s]
  }
  return best
}

export function turnTexts(messages: unknown, last: string): string[] {
  if (!Array.isArray(messages)) return []
  const out: string[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!isObj(m)) continue
    const t = typeof m.text === 'string' ? m.text : ''
    if (m.role === 'assistant') {
      if (t.trim()) out.push(t)
    } else if (m.role === 'user' && t.trim() && !(Array.isArray(m.toolResults) && m.toolResults.length) && !t.trim().startsWith('<')) break
  }
  out.reverse()
  if (out.length && out[out.length - 1]!.trim() === String(last ?? '').trim()) out.pop()
  return out.slice(-30)
}


function firstRunOfWrittenTest(agent: string, cmd: string): boolean {
  const mine = calls.filter((c) => c.agent === agent)
  const namesAny = (c: string) => /(?:^|[\s\\/'"])(?:test_[\w-]+|[\w-]+_test|[\w-]+\.(?:test|spec))(?:\.\w+)?\b/i.test(c)
  const latest: Record<string, number> = {}
  for (const c of mine) if (c.testWrite) latest[c.testWrite] = c.seq
  for (const [file, at] of Object.entries(latest)) {
    const stem = file.replace(/\.[^.]+$/, '')
    const covers = (c: string) => c.toLowerCase().includes(stem) || !namesAny(c)
    if (covers(cmd) && !mine.some((c) => c.seq > at && c.test && covers(c.cmd))) return true
  }
  return false
}

export function reportToolEnd(e: Obj, done: Obj): Obj {
  try {
    if (!isObj(e) || !isObj(done) || !fr()) return done
    const agent = typeof e.agentId === 'string' ? e.agentId : ''
    const tool = String(e.tool ?? '')
    const input = isObj(e.input) ? e.input : e
    const denied = done.deny !== undefined || done.denied === true || done.decision === 'deny' ||
      (isObj(done.permission) && (done.permission.decision === 'deny' || done.permission.behavior === 'deny'))
    const text = textOf(done.result) || (typeof done.deny === 'string' ? done.deny : '')
    const userDeny = denied || (rxOf(fr()!.deny)?.test(text.slice(0, 4000)) ?? false)
    const failed = done.isError === true || denied
    const path = String(input.file_path ?? input.path ?? '')
    const write = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)
    const testWrite = write && /(?:^|[\\/])(?:tests?|__tests__|spec)[\\/]|(?:^|[\\/_.])(?:test|spec)[_.]|_test\.|\.test\.|\.spec\./i.test(path)
      ? path.replace(/^.*[\\/]/, '').toLowerCase() : ''
    seq += 1
    const cmd = String(input.command ?? '')
    const step = stepOf({ ...e, input })
    const match = stepKey(tool, input)
    const isTest = isShell(tool) && stagesOf(cmd, tool).some((h) => h.kind === 'test')
    const firstRun = isTest && failed && firstRunOfWrittenTest(agent, cmd)
    calls.push({ seq, agent, tool, ok: !failed, match, test: isTest, cmd: cmd.slice(0, 300), testWrite: failed ? '' : testWrite })
    calls = calls.slice(-300)
    let out = done
    if (failed && !(!denied && expectedFailure({ ...e, input }, done, firstRun))) {
      const sig = sigOf(text) || (denied ? 'denied' : 'failed')
      const key = `${agent}|${step}|${sig}`
      const had = entries.find((x) => x.key === key)
      if (had && had.prompt < promptNo) {
        Object.assign(had, { state: 'open', rounds: 0, asked: 0, notified: false, denied: userDeny })
      } else if (had) {
        if (had.state !== 'exhausted' && had.state !== 'open') had.state = 'open'
      } else {
        entries.push({ key, agent, tool, step, sig, seq, match, prompt: promptNo, denied: userDeny, sideEffect: isShell(tool) && sideEffectOf(cmd),
          expensive: expensiveStep(step, tool), rounds: 0, asked: 0, state: 'open', notified: false })
        entries = entries.slice(-100)
      }
      if (had) [had.seq, had.prompt] = [seq, promptNo]
    } else if (!failed) {
      for (const x of entries) if (x.agent === agent && x.match === match && x.seq < seq && (x.state === 'open' || x.state === 'exhausted')) x.state = 'fixed'
    }
    if (!agent && (tool === 'Agent' || tool === 'Task')) {
      const id = [done.agentId, isObj(done.result) ? done.result.agentId : null, /agentId:\s*([\w-]+)/.exec(text)?.[1]].find((x) => typeof x === 'string' && x)
      const name = String(input.description ?? input.subagent_type ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
      if (id && name) {
        names[id] = name
        const keys = Object.keys(names)
        for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete names[k]
      }
      if (handback.length) {
        const t = fr()?.texts?.handback
        if (t) out = { ...out, context: [...(Array.isArray(out.context) ? out.context : []), fill(t, { list: handback.join('; ') })] }
        handback = []
      }
    }
    return out
  } catch {
    return done
  }
}

export function reportNotices(notices: readonly { id: string | null; call: string | null; status: string; summary: string }[]): void {
  try {
    if (!fr()) return
    for (const n of notices) {
      const task = n.id ?? n.call ?? ''
      const named = /"([^"]{1,80})"/.exec(n.summary)?.[1] ?? n.summary.slice(0, 60)
      const sub = /^\s*agent\b/i.test(n.summary)
      const step = `background ${sub ? 'subagent' : 'command'} "${named}"`.slice(0, 80)
      const sig = (/exit code[:\s]+-?\d+/i.exec(n.summary)?.[0] ?? (n.status || 'failed')).toLowerCase().replace(/\d+/g, '#')
      const key = `|${step}|${sig}|${task}`
      if (!task || entries.some((x) => x.key === key)) continue
      seq += 1
      entries.push({ key, agent: '', tool: 'background', step, sig, seq, match: sub ? stepKey('Agent', { description: named }) : stepKey('Bash', { command: named }),
        prompt: promptNo, denied: false, sideEffect: !sub && sideEffectOf(named), expensive: expensiveStep(named), rounds: 0, asked: 0, state: 'open', notified: false })
      entries = entries.slice(-100)
    }
  } catch {}
}

export function reportOpen(step: string, sig: string, agent = ''): void {
  const key = `${agent}|${step}|${sig}`
  if (entries.some((x) => x.key === key && x.state === 'open')) return
  seq += 1
  const server = /^MCP server (\S+)/.exec(step)?.[1]
  entries.push({ key, agent, tool: 'mcp', step: step.slice(0, 80), sig: sig.slice(0, 60), seq, match: server ? `mcp:${server.toLowerCase()}` : `mcp:${step}`,
    prompt: promptNo, denied: false, sideEffect: false, expensive: false, rounds: 0, asked: 0, state: 'open', notified: false })
}

export function reportPrompt(e: Obj): string | null {
  try {
    if (!isObj(e) || e.agentId || !['composer', 'sdk', 'bridge'].includes(e.origin?.kind)) return null
    promptNo += 1
    const left = entries.filter((x) => x.agent === '' && x.state === 'open')
    for (const x of left) x.state = 'carried'
    const t = fr()?.texts?.carried
    return left.length && t ? fill(t, { list: left.map(label).join('; ') }) : null
  } catch {
    return null
  }
}

export function reportHasOpen(agent: string): boolean {
  return entries.some((x) => x.agent === agent && x.state === 'open')
}


export function reportStop(agent: string, message: string, earlier: readonly string[] = []): string | null {
  try {
    const f = fr()
    const t = f?.texts
    if (!f || !t) return null
    const open = () => entries.filter((x) => x.agent === agent && x.state === 'open')
    const later = (x: Entry, ok?: boolean, match?: string) =>
      calls.some((c) => c.agent === agent && c.seq > x.seq && (ok === undefined || c.ok === ok) && (match === undefined || c.match === match))
    const guess = /\b(?:maybe|probably|perhaps|might be|i guess|possibly|likely|seems? to be)\b|\u53ef\u80fd|\u4e5f\u8bb8|\u5927\u6982|\u5e94\u8be5\u662f/i
    const notes: string[] = []
    const own = reportBlocks(message)
    const ownTexts = own.map((b) => b.text)
    const extra = earlier.flatMap((m) => reportBlocks(m)).filter((b) => !ownTexts.includes(b.text) && !seenBlocks.includes(b.text))
    const blocks = [...extra, ...own]
    seenBlocks = [...seenBlocks, ...blocks.map((b) => b.text)].slice(-50)
    for (const b of blocks) {
      const x = matchEntry(open(), b)
      if (!x) continue
      if (b.kind === 'expected') {
        if (b.text.replace(/^[^:\uff1a\-]*[:\uff1a\-]/, '').trim()) x.state = 'expected'
        continue
      }
      const s = { step: x.step }
      const concrete = /[`"'\d/\\:]/.test(b.evidence)
      if (b.fixed || b.skipped || b.needsUser) {
        let why = ''
        if (!x.denied && !later(x)) why = t.why_no_check ?? 'nothing was run to check the step after it failed'
        else if (!x.denied && (!b.evidence || (guess.test(`${b.cause} ${b.evidence}`) && !concrete))) why = t.why_guess ?? 'the Evidence is missing or a guess'
        else if (b.fixed && !b.skipped && !b.needsUser && !later(x, true, x.match)) why = t.why_no_pass ?? 'Fixed needs a passing run after the failure'
        if (why) {
          if (x.asked < 2 && t.reject) notes.push(fill(t.reject, { ...s, why }))
          x.asked += 1
          if (x.asked >= 3) x.state = 'exhausted'
          continue
        }
        x.state = b.needsUser ? 'needs_user' : b.skipped ? 'skipped' : 'fixed'
        if (x.state === 'needs_user' && !x.notified && t.notify) {
          x.notified = true
          if (!/^\W*(?:needs (?:you|the user)|action needed|\u9700\u8981\u4f60)/i.test(String(message).trimStart().split('\n')[0] ?? '')) notes.push(fill(t.notify, s))
        }
        continue
      }
      if (x.denied) {
        if (t.deny && x.rounds < 1) notes.push(fill(t.deny, s))
        x.rounds = Math.max(x.rounds, 1)
        x.state = 'exhausted'
        continue
      }
      if (x.rounds >= 2) {
        if (t.last && x.rounds === 2) notes.push(fill(t.last, s))
        x.rounds += 1
        if (x.rounds > 2) x.state = 'exhausted'
        continue
      }
      x.rounds += 1
      let line = fill((x.rounds === 1 ? t.retry : t.recheck) ?? '', { ...s, round: x.rounds })
      if (x.sideEffect && t.side_effect) line = fill(t.side_effect, s)
      else if (x.expensive && t.cheap) line = `${line} ${t.cheap}`
      if (line) notes.push(line)
    }
    if (notes.length) return notes.join('\n\n')
    const left = open().filter((x) => x.asked < 2)
    if (left.length && t.need_report) {
      for (const x of left) x.asked += 1
      const per = left.map((x) => {
        const s = { step: x.step }
        if (x.denied) return t.need_deny ? fill(t.need_deny, s) : ''
        if (x.sideEffect) return t.need_side_effect ? fill(t.need_side_effect, s) : ''
        const line = t.need_rerun ? fill(t.need_rerun, s) : ''
        return x.expensive && t.cheap && line ? `${line} ${t.cheap}` : line
      }).filter(Boolean)
      return fill(t.need_report, { list: left.map(label).join('; '), steps: per.join(' ') })
    }
    for (const x of open()) if (x.asked >= 2) x.state = 'exhausted'
    const mine = entries.filter((x) => x.agent === agent && x.prompt === promptNo)
    const closed = mine.filter((x) => x.state !== 'open').map((x) => `${x.step} ${x.sig}`)
    const quote = agent || !mine.length || blocks.some((b) => b.kind === 'expected') ? null : failureGap(message, closed)
    if (quote && !gapSaid.includes(quote) && t.need_report) {
      gapSaid = [...gapSaid, quote].slice(-20)
      return fill(t.need_report, { list: `"${quote}"`, steps: t.need_rerun ? fill(t.need_rerun, { step: quote }) : '' })
    }
    return null
  } catch {
    return null
  }
}

export function reportSubagentStop(agent: string, message: string): string | null {
  if (!agent) return null
  const n = subBlocks[agent] ?? 0
  const block = n < SUB_BLOCK_CAP ? reportStop(agent, message) : null
  if (block) {
    subBlocks[agent] = n + 1
    return block
  }
  const left = entries.filter((x) => x.agent === agent && (x.state === 'open' || x.state === 'exhausted'))
  if (left.length) handback = [...handback, ...left.map(label)].slice(-10)
  const name = names[agent] || agent
  for (const x of left) {
    x.state = 'skipped'
    const step = `subagent "${name}": ${x.step}`.slice(0, 140)
    const key = `|${step}|${x.sig}`
    if (entries.some((y) => y.key === key && y.state === 'open')) continue
    seq += 1
    entries.push({ ...x, key, agent: '', step, seq, prompt: promptNo, rounds: 0, asked: 0, state: 'open', notified: false })
  }
  entries = entries.slice(-100)
  return null
}

export function reportStateForTest(reset = false): { entries: Entry[]; calls: number; handback: string[] } {
  if (reset) {
    entries = []
    calls = []
    seq = 0
    promptNo = 0
    subBlocks = {}
    handback = []
    gapSaid = []
    names = {}
    seenBlocks = []
  }
  return { entries: entries.map((x) => ({ ...x })), calls: calls.length, handback: [...handback] }
}
