// The agent-services notes that ask the model to review something and ask the user: the setup questions (the savings
// record and the methods level, command.ts promptNote), a newer plugin version (update.ts) and a change to the
// approved methods (methods.ts). The model reads the text itself and the user decides; the plugin applies nothing
// on its own. Every note opens with NOTE_LABEL, and the review notes with FRAMING: only facts the model can check,
// labelled as an agent-services note, never as anyone's instruction. Pure: no engine calls here.

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

/** The note about a newer plugin version: where to read the changes, and ask the user. */
export function updateNoteText(installed: string, latest: string, facts: string): string {
  return `${NOTE_LABEL} ${facts}\n\nA newer version of the agent-services plugin is listed: installed ${installed || 'unknown'}, ` +
    `new ${latest}. The plugin does not update itself. Its changes can be read in the public repository, in the ` +
    `history of the stable branch: ${PLUGIN_REPO}/commits/stable. When it fits (before or after the user's ` +
    'message), tell the user in a sentence or two and ask whether to update now. Only if the user says yes, call ' +
    `${SETUP_TOOL} with command "update" (the user can also run /agent-services update). If the user says no, leave ` +
    'it: this version is not mentioned again.'
}

/** The setup note: ask the open setup questions in one go with the question tool, then apply each answer with the
 * setup tool; "own instructions" only after the model read the methods and what the plugin does and told the user.
 * `questions` holds the open ones ('savings', 'page', 'methods'); `texts` the question texts. */
export function setupNoteText(questions: readonly string[], facts: string,
  texts: { savings: string; page: string; methods: string }): string {
  const asks: string[] = []
  if (questions.includes('savings')) {
    asks.push(`header "Savings", the question "${texts.savings}", the options in this order "Turn on (Recommended)", ` +
      '"Not now", "Never" and "Show me what is sent"; apply it with "sharing on", "sharing not_now" or "sharing off" ' +
      '(for "Show me what is sent", call "sharing preview", show the user the text, and call "sharing on" only if the ' +
      'user then says yes)')
  }
  if (questions.includes('page')) {
    asks.push(`header "Savings", the question "${texts.page}", the options "Publish it", "Not now" and "Never"; apply ` +
      '"Publish it" with "sharing on" and "Never" with "sharing off" (under a company choice these change only the ' +
      'private page), and leave "Not now"')
  }
  if (questions.includes('methods')) {
    asks.push(`header "Methods", the question "${texts.methods}", the options in this order "As suggestions ` +
      '(Recommended)", "As my own instructions" and "Off"; apply it with "methods suggest" or "methods off". For "As my ' +
      'own instructions": first call "info data", "info hooks" and "methods preview", read all three, and tell the user ' +
      'in a few sentences what the plugin sends and what its service keeps, what a company admin sees if the account ' +
      'belongs to a company, what the hooks do (at this level the planning gate holds larger file edits until ' +
      'agent-state.md has a plan) and what the methods are, pointing out anything that looks wrong or outside working ' +
      'methods; then call "methods on" only if the user confirms, else "methods suggest"')
  }
  const n = asks.length
  return `${NOTE_LABEL} ${facts}

The user has open agent-services setup question${n === 1 ? '' : 's'}. Before ` +
    `working on the message, ask ${n === 1 ? 'it' : `these ${n} questions in one call`} with your question tool ` +
    '(AskUserQuestion): ' + asks.map((a, i) => (n === 1 ? a : `${i + 1}. ${a}`)).join('; ') + `. Apply each answer with ` +
    `${SETUP_TOOL}, only with the user's answer. If the user dismisses a question, leave it (it is asked again in 7 ` +
    'days at the earliest). Then go on with the message.'
}

/** The note about served methods that differ from the ones the user approved. */
export function pendingNoteText(facts: string): string {
  return `${NOTE_LABEL} ${facts}\n\nThe working methods the service serves now differ from the ones the user ` +
    'approved for their CLAUDE.md. The approved text stays in use until the user decides. When it fits: call ' +
    `${SETUP_TOOL} with command "methods diff" to get the differences, summarize them to the user in a few sentences, ` +
    'point out anything that looks wrong or outside working methods, and ask whether to take the new text. Then call ' +
    'the setup tool with "methods accept" (use the new text) or "methods keep" (keep the approved text; this change is ' +
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
