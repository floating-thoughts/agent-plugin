// The explanations the band above the prompt shows when the pointer rests on one of its parts (band.ts installBand):
// one per panel column, one for the top row, one for the setup line. One map, keyed. Written from how panel.ts
// panelOf, wiring.ts panel(), day_counts.ts countsOf, flow.ts pendingCount and command.ts openQuestions compute what
// the band shows. The savings page keeps its own, longer texts (plugin/dashboard/index.html EXPLAIN); a key in both
// must have the same text (tests/test_band_explain.py). A column text is at most 120 characters (it fills a
// quarter-width box), the others at most 200.
//
//   explainKeyOf(title) -> string | null   (the key of a panel column, by its title)
import { COMMAND } from './status'

export const EXPLAIN: Readonly<Record<string, string>> = {
  'band-token': 'Tokens used, cache reads included, and their cost at API prices: last 7 days, this month, all time.',
  'band-quota': 'Week and 5-hour limits used, time to reset. Context: how full this conversation is. Saved: total estimated savings.',
  'band-time': 'Your typing time, clock time with an agent working, and time saved by agents running side by side. Totals so far.',
  'band-stats': 'Counted on this computer, last 7 days: replies from subagents on cheaper models, compactions, reads through the index.',
  'band-top': 'Left: open "- [ ]" lines in this project\'s .agent/pending.md, decisions waiting for you. Right: agent-services is signed in and can reach its service.',
  'band-setup': `Setup choices you have not made yet: uploading usage for your savings figures, the working methods level or subagent routing. Type ${COMMAND} setup to answer them.`,
}

/** The explanation key of a panel column, by its title; null for an unknown title. */
export function explainKeyOf(title: unknown): string | null {
  const t = typeof title === 'string' ? title : ''
  if (/^Token /.test(t)) return 'band-token'
  if (/^Quota/.test(t)) return 'band-quota'
  if (/^Time/.test(t)) return 'band-time'
  if (t === 'Weekly Stats') return 'band-stats'
  return null
}
