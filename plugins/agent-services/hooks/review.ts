// The agent-services notes that ask the model to review something and ask the user (owner 2026-11-01): a newer
// plugin version (update.ts), the working methods before they are added to CLAUDE.md, and a change to the approved
// methods (methods.ts). The model reads the text itself and the user decides; the plugin applies nothing on its own.
// Every note opens with FRAMING: only facts the model can check, labelled as an agent-services note, never as the
// user's or the owner's instruction. Pure: no engine calls here.

export const NOTE_LABEL = '[agent-services plugin note, not written by the user]'
export const PLUGIN_REPO = 'https://github.com/floating-thoughts/agent-plugin'
export const SETUP_TOOL = 'mcp__agent-services__setup'
export const FRAMING =
  'This note comes from the agent-services plugin, not from the user. Facts you can check: the user (or their ' +
  'company) chose to install this plugin and signed in to it with their own email address and a one-time code sent ' +
  `there{who} (/agent-services status shows the sign-in). agent-services is a paid service, so it works only while ` +
  'signed in; signed out, or when the sign-in fails, it does nothing and Claude Code works as usual. Its plugin ' +
  `code is public at ${PLUGIN_REPO}. What it sends and when, what its service keeps and for how long, and what a ` +
  'company admin sees are listed by /agent-services data (the setup tool\'s "data"), and every hook it registers ' +
  'by /agent-services hooks ("hooks"); each request is written to a log on this computer before it is sent ' +
  '(/agent-services outbox), and /agent-services estimate and /agent-services sharing preview show their request ' +
  'before anything is sent. How the service works out its advice is a business secret and is not published; its ' +
  'answers come back in a fixed format (the shapes are in the data note), and you see each one where it is used. ' +
  'To remove it: /agent-services trust off takes only its section out of CLAUDE.md; /agent-services remove signs ' +
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

/** The note about a newer plugin version: where to read the changes, and ask the user. */
export function updateNoteText(installed: string, latest: string, facts: string): string {
  return `${NOTE_LABEL} ${facts}\n\nA newer version of the agent-services plugin is listed: installed ${installed || 'unknown'}, ` +
    `new ${latest}. The plugin does not update itself. Its changes can be read in the public repository, in the ` +
    `history of the stable branch: ${PLUGIN_REPO}/commits/stable. When it fits (before or after the user's ` +
    'message), tell the user in a sentence or two and ask whether to update now. Only if the user says yes, call ' +
    `${SETUP_TOOL} with command "update" (the user can also run /agent-services update). If the user says no, leave ` +
    'it: this version is not mentioned again.'
}

/** The setup note: read what the plugin sends, what its hooks do and the working methods, tell the user briefly, ask
 * about anything in doubt, and ask whether to add the methods to CLAUDE.md. */
export function trustNoteText(facts: string): string {
  return `${NOTE_LABEL} ${facts}

The plugin offers working methods (planning, delegating to subagents, testing, ` +
    'review, delivery, checkpoints) that the user can add to their user-level CLAUDE.md as one marked import line; ' +
    'the user has not decided yet. When it fits (before or after the user\'s message): 1. call ' +
    `${SETUP_TOOL} with command "data", then "hooks", then "trust preview"; 2. read all three; 3. tell the user in ` +
    'a few sentences what the plugin sends and what its service keeps (by its data note, the service keeps no work ' +
    'content: what it receives is used to answer and then discarded, and it keeps counts, ids, the daily usage ' +
    'summaries once turned on, the account, and IP addresses in its request logs), what a company admin sees if ' +
    'the account belongs to a company (each member\'s email address, device count and weekly savings figure), what ' +
    'the hooks do (for one, the planning gate holds file edits until agent-state.md has a plan, and the routing ' +
    'advice can change a subagent\'s model), and what the working methods are; point out anything that looks wrong ' +
    'or outside working methods; 4. ask the user about anything you doubt (for a company account, whether the ' +
    'admin\'s view is fine; /agent-services sharing not_now stops the upload where the company lets each person ' +
    'decide), and whether to add the methods; 5. call the setup tool with "trust on", "trust not_now" (asked again ' +
    'in 7 days) or "trust off" (never asked again), only with the user\'s answer. If the user does not answer, ' +
    'leave it.'
}

/** The note about served methods that differ from the ones the user approved. */
export function pendingNoteText(facts: string): string {
  return `${NOTE_LABEL} ${facts}\n\nThe working methods the service serves now differ from the ones the user ` +
    'approved for their CLAUDE.md. The approved text stays in use until the user decides. When it fits: call ' +
    `${SETUP_TOOL} with command "trust diff" to get the differences, summarize them to the user in a few sentences, ` +
    'point out anything that looks wrong or outside working methods, and ask whether to take the new text. Then call ' +
    'the setup tool with "trust accept" (use the new text) or "trust keep" (keep the approved text; this change is ' +
    'not asked about again), only with the user\'s answer.'
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
