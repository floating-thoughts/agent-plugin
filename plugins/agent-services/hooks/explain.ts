
export const EXPLAIN: Readonly<Record<string, string>> = {
  'band-token': 'Tokens used, cache reads included, and their cost at API prices: last 7 days, this month, all time.',
  'band-quota': 'Week and 5-hour limits used, time to reset. Context: how full this conversation is. Saved: total estimated savings.',
  'band-time': 'Your typing time, clock time with an agent working, and time saved by agents running side by side. Totals so far.',
  'band-stats': 'Counted on this computer, last 7 days: replies from subagents on cheaper models, compactions, reads through the index.',
  'band-top': 'Shown only when there is news: open "- [ ]" lines in .agent/pending.md (decisions for you), edits with no test run since, background jobs, and the connection when not online.',
  'band-setup': `Setup choices you have not made yet: uploading usage for your savings figures, the working methods level or subagent routing. Ask Claude to finish the agent-services setup to answer them.`,
}

export const EXPLAIN_KEY = 'band_explain'
export const EXPLAIN_POLL_MS = 5000

export function explainOn(value: unknown): boolean {
  return !(typeof value === 'object' && value !== null && (value as Record<string, unknown>).on === false)
}

export function explainKeyOf(title: unknown): string | null {
  const t = typeof title === 'string' ? title : ''
  if (/^Token /.test(t)) return 'band-token'
  if (/^Quota/.test(t)) return 'band-quota'
  if (/^Time/.test(t)) return 'band-time'
  if (t === 'Weekly Stats') return 'band-stats'
  return null
}
