import { servedText } from './workflow_table'

export const NOTE_PREFIX = 'agent-services note'
export const SUGGESTION_PREFIX = 'agent-services suggestion'
export const NOTE_LABEL = `[${NOTE_PREFIX}, not written by the user]`
export const PLUGIN_REPO = 'https://github.com/floating-thoughts/agent-plugin'
export const SETUP_TOOL = 'mcp__agent-services__setup'
export const FRAMING =
  'This note comes from the agent-services plugin, not from the user. Facts you can check: the user (or their ' +
  `company) installed it and signed in with their own email address{who} (the setup tool's "status" shows the ` +
  `account). Its plugin code is public at ${PLUGIN_REPO}; the setup tool's "info hooks" lists every hook and ` +
  '"info data" what it sends. If anything is unclear, ask the user; the user decides.'

export function framing(account?: unknown, plan?: unknown): string {
  const a = typeof account === 'string' && account ? `account ${account}` : ''
  const p = typeof plan === 'string' && plan ? `plan ${plan}` : ''
  const who = a || p ? ` (${[a, p].filter(Boolean).join(', ')})` : ''
  return FRAMING.replace('{who}', who)
}

export function updateNoteText(installed: string, latest: string, facts: string): string | null {
  const body = servedText('review', 'update_note', {
    installed: installed || 'unknown', latest, repo: PLUGIN_REPO, setup_tool: SETUP_TOOL,
  })
  return body === null ? null : `${NOTE_LABEL} ${facts}\n\n${body}`
}

export const hasUpdateNote = (): boolean => servedText('review', 'update_note') !== null

export const PENDING_NOTE = 'The working methods the service serves now differ from the ones the user approved for ' +
  'their CLAUDE.md; the approved text stays in use until the user decides. Do not interrupt the user\'s work for this. ' +
  'At the end of a reply, or when the user asks about agent-services: call the setup tool with "methods diff", sum up ' +
  'for the user in a few sentences what changed, and say that /agent-services methods approve takes the new text (the ' +
  'setup tool\'s "methods keep" keeps the approved one).'

export function pendingNoteText(facts: string, refused: string | null = null): string {
  const why = refused ? ` Automatic approval is on but did not take this text: ${refused}.` : ''
  return `${NOTE_LABEL} ${facts}\n\n${PENDING_NOTE}${why}`
}

export const AUTO_TAKEN_NOTE = 'The working methods the user approved for their CLAUDE.md changed automatically: the ' +
  'user turned automatic methods approval on, and the plugin took the changed text{version}. Do not interrupt the ' +
  'user\'s work for this. At the end of a reply, call the setup tool with "methods diff", sum the change up for the ' +
  'user in two sentences, and mention that /agent-services methods revert goes back.'

export function autoTakenNoteText(facts: string, version: string): string {
  return `${NOTE_LABEL} ${facts}\n\n${AUTO_TAKEN_NOTE.replace('{version}', version ? ` (version ${version})` : '')}`
}

export function setupNoteText(n: number, names: string[], facts: string): string {
  const many = n === 1 ? 'choice is' : 'choices are'
  return `${NOTE_LABEL} ${facts}\n\nagent-services setup is not finished for this account: ${n} ${many} open ` +
    `(${names.join(', ')}). After you have dealt with the user's message, tell the user in one sentence that ` +
    `agent-services has ${n} setup choice${n === 1 ? '' : 's'} open and call ${SETUP_TOOL} with command "setup": the ` +
    'plugin shows each question in its own dialog and applies only what the user picks there; call it again while it ' +
    'says more are open. Do not answer for the user. If the user says not now, leave it: this note comes back in 7 ' +
    'days at the earliest.'
}

export function lineDiff(a: string, b: string): string {
  const x = a.replace(/\r\n/g, '\n').split('\n')
  const y = b.replace(/\r\n/g, '\n').split('\n')
  const n = x.length
  const m = y.length
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    L[i]![j] = x[i] === y[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!)
  }
  const ops: [string, string][] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) ops.push([' ', x[i++]!]), j++
    else if (i < n && (j >= m || L[i + 1]![j]! >= L[i]![j + 1]!)) ops.push(['-', x[i++]!])
    else ops.push(['+', y[j++]!])
  }
  if (!ops.some(([k]) => k !== ' ')) return 'No differences.'
  const near = ops.map((_, k) => ops.slice(Math.max(0, k - 2), k + 3).some(([o]) => o !== ' '))
  const out: string[] = []
  let folded = 0
  ops.forEach(([k, line], idx) => {
    if (near[idx]) {
      if (folded) out.push(`  ... (${folded} unchanged line${folded === 1 ? '' : 's'})`)
      folded = 0
      out.push(`${k === ' ' ? ' ' : k} ${line}`)
    } else folded++
  })
  if (folded) out.push(`  ... (${folded} unchanged line${folded === 1 ? '' : 's'})`)
  return out.join('\n')
}
