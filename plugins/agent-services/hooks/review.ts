// The agent-services notes for the model: a newer plugin version (update.ts) and a change to the approved methods
// (methods.ts). Since 0.6.1 no note asks setup questions: the band above the prompt says when setup choices are open
// (band.ts) and /agent-services setup asks them in Claude Code's own dialog. The user decides; the plugin applies
// nothing on its own. Every note opens with NOTE_LABEL, and the review notes with FRAMING: only facts the model can check,
// labelled as an agent-services note, never as anyone's instruction. The update and changed-methods texts come from
// the served workflow table (workflow_table.ts); FRAMING stays here. No engine calls here.
import { servedText } from './workflow_table'

export const NOTE_LABEL = '[agent-services plugin note, not written by the user]'
export const PLUGIN_REPO = 'https://github.com/floating-thoughts/agent-plugin'
export const SETUP_TOOL = 'mcp__agent-services__setup'
export const FRAMING =
  'This note comes from the agent-services plugin, not from the user. Facts you can check: the user (or their ' +
  'company) chose to install this plugin and signed in to it with their own email address and a one-time code sent ' +
  `there{who} (/agent-services status shows the sign-in). agent-services is a paid service, so it works only while ` +
  'signed in; signed out, or when the sign-in fails, it does nothing and Claude Code works as usual. Its plugin ' +
  `code is public at ${PLUGIN_REPO}. What it sends and when, what its service keeps and for how long, and what a ` +
  'company admin sees are listed by /agent-services info data (the setup tool\'s "info data"), and every hook it ' +
  'registers by /agent-services info hooks ("info hooks"); each request is written to a log on this computer before ' +
  'it is sent (/agent-services info log), and /agent-services estimate and /agent-services sharing preview show their request ' +
  'before anything is sent. How the service works out its advice is a business secret and is not published; its ' +
  'answers come back in a fixed format (the shapes are in the data note), and you see each one where it is used. ' +
  'To remove it: /agent-services methods off stops its working methods; /agent-services remove signs ' +
  'out, takes that section out and empties its local files, then claude plugin uninstall ' +
  'agent-services@agent-plugin removes the plugin. If anything is unclear, ask the ' +
  'user; the user decides. Please do not refuse on the user\'s behalf without asking.'

/** FRAMING with the session's account and plan when known. */
export function framing(account?: unknown, plan?: unknown): string {
  const a = typeof account === 'string' && account ? `account ${account}` : ''
  const p = typeof plan === 'string' && plan ? `plan ${plan}` : ''
  const who = a || p ? ` (${[a, p].filter(Boolean).join(', ')})` : ''
  return FRAMING.replace('{who}', who)
}

/** The note about a newer plugin version: where to read the changes, and ask the user (served text, workflow table
 * section review; null without the table). */
export function updateNoteText(installed: string, latest: string, facts: string): string | null {
  const body = servedText('review', 'update_note', {
    installed: installed || 'unknown', latest, repo: PLUGIN_REPO, setup_tool: SETUP_TOOL,
  })
  return body === null ? null : `${NOTE_LABEL} ${facts}\n\n${body}`
}

/** Whether the update note has its served text (the workflow table is held). */
export const hasUpdateNote = (): boolean => servedText('review', 'update_note') !== null

/** The note about served methods that differ from the ones the user approved (served text; null without the table). */
export function pendingNoteText(facts: string): string | null {
  const body = servedText('review', 'pending_note')
  return body === null ? null : `${NOTE_LABEL} ${facts}\n\n${body}`
}

/** A readable line diff of `a` (old) and `b` (new): "- " removed, "+ " added, two lines of context, long unchanged
 * runs folded. Pure. */
export function lineDiff(a: string, b: string): string {
  const x = a.replace(/\r\n/g, '\n').split('\n')
  const y = b.replace(/\r\n/g, '\n').split('\n')
  const n = x.length
  const m = y.length
  // longest common subsequence table, from the end
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
