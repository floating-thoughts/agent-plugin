// The explanations the band above the prompt shows when the pointer rests on one of its items (band.ts installBand).
// One map, keyed. A key starting "usage-" names a figure the savings page explains too (plugin/dashboard/index.html
// EXPLAIN): its text is the page's, word for word (tests/test_band_explain.py checks it). A "band-" key is the band's
// own, written from how panel.ts panelOf, wiring.ts panel(), day_counts.ts countsOf, flow.ts pendingCount and
// command.ts openQuestions compute what the band shows. Each text is at most 200 characters.
//
//   explainKeyOf(title, label?) -> string | null   (the key of a panel column's title, or of one of its rows)
import { COMMAND } from './status'

export const EXPLAIN: Readonly<Record<string, string>> = {
  // shared with the savings page: the same text there
  'usage-tokens': 'Tokens your sessions used and what that use would cost at API prices, for the week, the month and all time. Covers all your devices when our service has their figures.',
  'usage-quota': 'Week and 5-hour: share of your Claude usage limit used, and when it resets (as Claude Code reports it). Context: how full the current conversation is. Saved (est.): total measured savings.',
  'usage-spent': 'Your own time at the keyboard so far, estimated from the bytes you typed at a fixed typing speed (200 bytes a minute by default). Total so far, not only this week.',
  'usage-agent': 'Clock time with at least one agent working, so far. Gaps longer than the idle limit (10 minutes by default) count as idle; agents running at once count once. Total so far.',
  'usage-concurrent': 'Time saved by running agents side by side: their combined run time minus the clock time they covered. Total so far.',
  // the band's own
  'band-token-week': 'Tokens used (cache reads included) and what they would cost at API prices, over the last 7 days, today included.',
  'band-token-month': 'Tokens used (cache reads included) and what they would cost at API prices, in this calendar month so far.',
  'band-token-all': 'Tokens used (cache reads included) and what they would cost at API prices, over every day on record.',
  'band-quota-week': "Share of your plan's weekly usage limit used, as Claude Code reports it, and the time left until it resets. Shows -- when it is not reported or the reset has passed.",
  'band-quota-5h': "Share of your plan's 5-hour usage limit used, as Claude Code reports it, and the time left until it resets. Shows -- when it is not reported or the reset has passed.",
  'band-saved': 'Total measured savings our service holds for you, estimated at API list prices against every subagent on a top-tier model (Opus). Not a bill. Shows off while the savings record is off.',
  'band-time': 'Three time figures from this computer, each a total over every day stored here, not only this week.',
  'band-stats': 'Counts recorded on this computer over the last 7 days, today included.',
  'band-cheaper': 'Model replies from subagents that ran on a model cheaper than the top tier (Opus), counted on this computer over the last 7 days. Replies, not tasks.',
  'band-cleanups': 'Compactions of a long conversation, counted when each one starts, on this computer over the last 7 days.',
  'band-index': 'Reads of part of a file found through the project index instead of the whole file, on this computer over the last 7 days.',
  'band-pending': 'Open lines ("- [ ]") in this project\'s .agent/pending.md: decisions waiting for your answer. A line marked "- [x]" no longer counts.',
  'band-online': 'agent-services is signed in and can reach its service, so the figures below can update.',
  'band-setup': `Setup choices you have not made yet: uploading usage for your savings figures, the working methods level or subagent routing. Type ${COMMAND} setup to answer them.`,
}

/** The explanation key of a panel column's title (no label) or of the row a label starts; null for anything else. */
export function explainKeyOf(title: unknown, label?: unknown): string | null {
  const t = typeof title === 'string' ? title : ''
  const rows: Record<string, string> | null = /^Token /.test(t)
    ? { '': 'usage-tokens', Week: 'band-token-week', Month: 'band-token-month', 'All time': 'band-token-all' }
    : /^Quota/.test(t)
      ? { '': 'usage-quota', Week: 'band-quota-week', '5-hour': 'band-quota-5h', 'Saved (est.)': 'band-saved' }
      : /^Time/.test(t)
        ? { '': 'band-time', Spent: 'usage-spent', 'Agent time': 'usage-agent', Concurrent: 'usage-concurrent' }
        : t === 'Weekly Stats'
          ? { '': 'band-stats', 'Cheaper jobs': 'band-cheaper', Cleanups: 'band-cleanups', 'Index reads': 'band-index' }
          : null
  const k = rows ? rows[typeof label === 'string' ? label : ''] : undefined
  return k && Object.prototype.hasOwnProperty.call(EXPLAIN, k) ? k : null
}
