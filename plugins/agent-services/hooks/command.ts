// The /agent-services slash command, answered by the hooks module itself.
//
// - $.command.register declares the command; a command.run hook answers it with { text } only: no model, no Bash,
//   no Python and no `context` field, so neither the sign-in code nor an answer enters the model's context.
// - Thirteen words: status, login, logout, setup, sharing, savings, methods, update, offline, estimate, info, remove,
//   company (USAGE). `code` stays as a hidden sign-in fallback and `served` as a hidden owner tool. The 0.5.0
//   spellings (data, hooks, outbox, trust, savings <part>, dashboard) still work for one version: they answer as the
//   new word does, plus one line that names it (renameOf).
// - The sign-in code is never taken from the command line: typed command arguments are written to prompt history.
//   `login` asks for the email (unless given; an email is not a secret) and mails the code, which the person pastes
//   as the next message (pastedCode) or types in the dialog of `code`; an argument that is not an email is refused,
//   never used.
// - While signed out only status, login, code, logout, update, info, remove and `methods off` work; every other
//   subcommand answers the one sign-in line and sends nothing.
// - The shipped build has no staging subcommand to set an endpoint: the endpoint and keys are the svc channel's
//   built-in DEFAULT_CONFIG, and nothing here reads an endpoint or key from the store.
// - Nothing is written to $.ui.log; every answer goes through redact() (redact.ts).
// - estimate keeps preview-then-send: `estimate` (or `estimate preview`) shows the exact body and sends nothing;
//   `estimate send` sends exactly the body previewed in this session (kept in memory for 30 minutes), once, and keeps
//   the answer for the savings page.
// - status is read only: it never asks; it says how many setup questions wait. It also shows the auto-update setup
//   state (the plugin never writes the user's settings) and the terminal update line where the engine has no
//   $.process.
// - The setup questions (the savings record, choice.ts; the methods level, methods.ts) are asked together: by
//   `setup` in the engine's dialog (also right after a sign-in through the dialog), or by the model at a prompt
//   (promptNote) where someone can answer (choice.ts canAsk). An unanswered question is asked at most once per 7 days
//   across all sessions (the shared "last asked" time); `sharing off` is never asked again.
//
// The Command class is harness-neutral (its deps are injected); the functions at the end are the Claude Code
// adapter over `$`.
import type { EngineInterface } from 'claude-code'
import { estimateFacts, estimateRequest } from './estimate'
import { BodyTooLarge, DAILY_ROUTE, READ_LIMIT } from './metrics'
import { plusDays } from './pyfmt'
import { Scanner, walkOrder } from './transcripts'
import type { Facts, Prices, TranscriptFile } from './transcripts'
import type { Outbox } from './outbox'
import { redact } from './redact'
import { updateCommand } from './status'
import { applyUpdate, probeProcess, takeUpdateNote, updatesLine } from './update'
import { safeSet } from './store'
import type { KV } from './store'
import { gateNotice, LOCKED_LINE, NOTICE_TEXT, PAUSED_LINE, PLAN_NOTICE, SERVED_CHANNELS, SERVED_ROLES } from './svc'
import type { Result, Svc } from './svc'
import { ASKED_FILE, askDue, askedFrom, canAsk, dashboardUrl, pageOpen, recordState, savingsOpen, uploadOn,
  writeEntry } from './choice'
import { dataDir, engineDirs, envOf, readTextOf } from './engine_env'
import { companyCommand } from './boss'
import { hasTrust, type TrustFile, unbalancedTrust, withoutTrust, withTrust } from './trust'
import { approveMethods, importLine, LEVEL_KEY, type Level, levelOf, methodsDiff, methodsNoted, methodsNotes,
  previewMethods, readLevel, settlePending, syncMethodsNow } from './methods'
import { framing, lineDiff, NOTE_LABEL, pendingNoteText, setupNoteText, updateNoteText } from './review'
import { ORG_PAUSED_LINE, ORG_SAVINGS_TEXT, ORG_SET_TEXT, orgChoice, orgNotice, sharingQuestion } from './org'
import { hooksText } from './hooks_list'
import { removeAll, removedMarker, resetRemoved, type RemoveDeps } from './remove'

export { denyReason, spawnLine } from './hooks_list'
export { isRemoved } from './remove'
export { dashboardUrl, recordState } from './choice'
export { claudeHashOf, dataDir, engineClaudeHash, engineDirs } from './engine_env'

// ------------------------------------------------------------------ constants

export const COMMAND_NAME = 'agent-services'
export const COMMAND = '/' + COMMAND_NAME
export const COMMAND_SPEC = {
  name: COMMAND_NAME,
  description: 'Sign in to agent-services, show its status, or sign out',
  argumentHint:
    '[status | login [<email>] | logout | setup | sharing [on | off | not_now | preview | page on|off | mail on|off] | ' +
    'savings | methods [off | suggest | on | preview | diff | accept | keep] | update | offline on|off | ' +
    'estimate [preview | send] | info [data | hooks | log [<day>]] | remove | company [mail on|off]]',
} as const

// Every word the command answers: the thirteen of USAGE, then the hidden `code` (sign-in fallback) and `served`.
export const KNOWN_COMMANDS = ['status', 'login', 'logout', 'setup', 'sharing', 'savings', 'methods', 'update', 'offline',
  'estimate', 'info', 'remove', 'company', 'code', 'served']
/** The subcommands that work while signed out (`methods` alone and `methods off` too, see dispatch). */
export const AUTH_FAIL_COMMANDS = ['status', 'login', 'code', 'logout', 'update', 'info', 'remove']
export const ASK_HEADER = 'Sign-in'
export const EMAIL_QUESTION = 'Which email address is your agent-services account under?'
export const EMAIL_CANCEL = ['Cancel sign-in', 'Not now'] // the engine's dialog needs 2-4 options
export const CODE_CANCEL = ['Enter it later', 'Cancel sign-in']
export const ESTIMATE_PREVIEW_MS = 30 * 60000 // a preview stays sendable this long, in this session only
export const STATUS_HELLO_MS = 4000 // status waits this long at most for a hello
export const OUTBOX_SHOW = 10 // outbox lines shown
export const OUTBOX_LINE_CHARS = 300
export const ESTIMATE_KEY = 'estimate_answer' // { made_at, estimate }: the last estimate answer (wiring.ts reads it)

// The one savings record: the private page, the weekly email and the daily numbers-only upload together (choice.ts).
// One answer sets all three; the page and the email keep their own subcommands (sharing page|mail on|off).
export const SHARING_QUESTION =
  'Keep a record of what agent-services saves you? It shows your savings on a private page in your claude.ai ' +
  'account (only you can see it), emails you a weekly total, and uploads a small daily usage summary (token ' +
  'counts and costs per model, counts per task type and hashed project, savings; never your prompts, file ' +
  'contents, paths or code). Nothing of it is uploaded before you answer.'
export const SHARING_OPTIONS = ['Turn on (Recommended)', 'Not now', 'Never', 'Show me what is sent']
export const SHARING_HEADER = 'Savings'
// Where a company turned the daily upload on for everyone: the private page stays the person's own question.
export const PAGE_QUESTION = 'Your company turned the daily usage upload on. Show your savings on a private page in ' +
  'your claude.ai account too (only you can see it)?'
export const PAGE_OPTIONS = ['Publish it', 'Not now', 'Never']
export const METHODS_QUESTION = 'agent-services serves working methods (planning, delegating to subagents, testing, ' +
  'review, delivery, checkpoints). How should Claude use them?'
export const METHODS_OPTIONS = ['As suggestions (Recommended)', 'As my own instructions', 'Off']
export const METHODS_HEADER = 'Methods'
export type Question = 'savings' | 'page' | 'methods'
export const QUESTION_COMMANDS: Readonly<Record<Question, string>> = {
  savings: `${COMMAND} sharing on, sharing not_now or sharing off`,
  page: `${COMMAND} sharing page on or sharing page off`,
  methods: `${COMMAND} methods suggest, methods on (after methods preview) or methods off`,
}
export const METHODS_LINE: Readonly<Record<string, string>> = {
  suggest: 'Working methods: suggestions (the default). The served methods come with your prompts as agent-services ' +
    `suggestions, and the planning gate only reminds. ${COMMAND} methods on makes them your own instructions (read ` +
    `${COMMAND} methods preview first); ${COMMAND} methods off turns them off.`,
  on: 'Working methods: your own instructions. Your CLAUDE.md loads the text you approved, and the planning gate holds ' +
    `larger file edits until agent-state.md has a plan. ${COMMAND} methods suggest or ${COMMAND} methods off changes it.`,
  off: `Working methods: off. Nothing of them reaches Claude and the planning gate does nothing. ${COMMAND} methods ` +
    'suggest turns them back on.',
}
// The tool the model calls with the user's answers to the setup questions (promptNote); it runs the same subcommands
// as the slash command, limited to these. The 0.5.0 setup words still work for one version (SETUP_ALIASES).
export const SETUP_COMMANDS = [
  'sharing on',
  'sharing not_now',
  'sharing off',
  'sharing preview',
  'methods suggest',
  'methods on',
  'methods off',
  'methods preview',
  'methods diff',
  'methods accept',
  'methods keep',
  'update',
  'info data',
  'info hooks',
]
export const SETUP_ALIASES = ['savings preview', 'savings on', 'savings not_now', 'dashboard allow', 'dashboard not_now',
  'trust on', 'trust not_now', 'trust off', 'trust preview', 'trust diff', 'trust accept', 'trust keep', 'data', 'hooks']
export const SETUP_SPEC = {
  name: 'setup',
  description:
    "Apply the user's answer to an agent-services setup question, or read what the plugin does. \"sharing on\" turns " +
    "the savings record on: a private Artifact page on the user's own claude.ai account (only they see it unless " +
    'they share it), a weekly savings email, and one small daily usage summary (token counts and costs per model, ' +
    'counts per task type and hashed project, savings; no prompt text, file contents or paths). "sharing not_now" ' +
    'leaves it off and asks again in 7 days at the earliest; "sharing off" leaves it off for good; "sharing preview" ' +
    'shows what one upload sends and changes nothing. "methods suggest" (the default) gives Claude the served working ' +
    'methods (planning, delegating to subagents, testing, review, delivery, checkpoints) as agent-services ' +
    'suggestions; "methods on" makes them the user\'s own instructions through one marked section in the user\'s ' +
    'CLAUDE.md and lets the planning gate hold larger file edits until there is a plan (read "methods preview" with ' +
    'the user first); "methods off" turns them off. "methods diff" shows how changed methods differ from the approved ' +
    'ones; "methods accept" takes the new text, "methods keep" keeps the approved one. "update" updates the plugin to ' +
    'the newest listed version. "info data" returns the plugin\'s data note (every request it sends and when, what ' +
    'the service keeps and for how long, what a company admin sees, the local files, and what can be turned off); ' +
    '"info hooks" lists every hook the plugin registers and what it does. Only call it with an answer the user gave, ' +
    'except "info data", "info hooks", "sharing preview", "methods preview" and "methods diff", which only read.',
  inputSchema: {
    type: 'object',
    properties: { command: { type: 'string', enum: SETUP_COMMANDS } },
    required: ['command'],
    additionalProperties: false,
  },
  isDeferred: false,
} as const

// auto-update (read only)
export const MARKETPLACE = 'agent-plugin'
export const AUTO_UPDATE_OFF_VARS = ['DISABLE_UPDATES', 'DISABLE_AUTOUPDATER', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']
export const AUTO_UPDATE_FORCE_VAR = 'FORCE_AUTOUPDATE_PLUGINS'
export const AUTO_UPDATE_HOW =
  '/plugin, then Marketplaces, select agent-plugin, then Enable auto-update; or set "autoUpdate": true on the ' +
  'agent-plugin entry under extraKnownMarketplaces in your settings'
/** The settings sources in the order Claude Code decides auto-update: [engine source, the name Python reports]. */
export const AUTO_UPDATE_SOURCES: readonly (readonly [string, string])[] = [
  ['policy', 'managed'],
  ['local', 'local'],
  ['project', 'project'],
  ['user', 'user'],
]

// the Python client's estimate_answer and ESTIMATE_DETAIL
export const ESTIMATE_LEVERS = ['routing', 'compaction', 'index'] as const
export const LEVER_TEXT: Record<string, string> = {
  routing: 'routing (sending lighter work to a cheaper model)',
  compaction: 'compaction (compacting long sessions at the right moment)',
  index: 'index reads (reading an index instead of whole files)',
}
export const ESTIMATE_DETAIL: Record<string, string> = {
  rate_limited: 'The service answers only a few estimates per account each day; try again tomorrow (after midnight UTC).',
  too_little_data: 'There is not enough Claude Code history yet: the estimate needs at least 7 days and 100 replies.',
  no_data: 'No Claude Code history was found on this machine.',
  not_logged_in: 'Sign in first; the estimate is for the signed-in account.',
}

const UNVERIFIED = NOTICE_TEXT.server_unverified!
/** One sentence per error code an answer can carry; anything else says its code. */
export const ERROR_TEXT: Record<string, string> = {
  offline: `Offline mode is on, so nothing was sent; ${COMMAND} offline off turns it off.`,
  rate_limited: 'agent-services is busy and is slowing requests down; try again in a few minutes.',
  inactive: `The service is not available to this session right now; ${COMMAND} status says why.`,
  not_in_plan: "This account's plan does not include this service.",
  service_off: 'This service is switched off on this machine.',
  account_locked: NOTICE_TEXT.account_locked!,
  org_paused: ORG_PAUSED_LINE,
  locked_out: NOTICE_TEXT.locked_out!,
  unsigned_response: UNVERIFIED,
  bad_signature: UNVERIFIED,
  stale_response: UNVERIFIED,
  undecryptable_response: UNVERIFIED,
  bad_envelope: NOTICE_TEXT.bad_envelope!,
  bad_response: 'The service sent an answer this plugin cannot use; nothing in it was used.',
  store_unavailable: "Claude Code's plugin store refused a write, so nothing was kept; try again.",
  timeout: 'The service did not answer in time; try again later.',
  server_unreachable: 'The service could not be reached; try again later.',
  connection_failed: 'The service could not be reached; try again later.',
  unavailable: 'The service could not be reached; try again later.',
  failed: 'The request failed; try again later.',
  auth_failed: PAUSED_LINE,
  not_logged_in: `Not signed in; sign in with ${COMMAND} login.`,
  bad_code: 'That code was not accepted: it is wrong, expired, or this network may not use it now. Ask for a new one with ' +
    `${COMMAND} login.`,
  license_inactive: 'This account has no active license, so the sign-in was refused; contact support.',
  bad_request: `The service refused the sign-in request; start again with ${COMMAND} login.`,
  invalid_body: 'That input is not valid.',
}

export const USAGE =
  `Usage: ${COMMAND} [status | login [<email>] | logout | setup | sharing [on | off | not_now | preview | page on|off | ` +
  'mail on|off] | savings | methods [off | suggest | on | preview | diff | accept | keep] | update | offline on|off | ' +
  'estimate [preview | send] | info [data | hooks | log [<day>]] | remove | company [mail on|off]]'

// The 0.5.0 spellings, kept for one version: [old words, new words] (a trailing '*' passes the rest on).
export const RENAMED: readonly (readonly [string, string])[] = [
  ['data', 'info data'],
  ['hooks', 'info hooks'],
  ['outbox *', 'info log *'],
  ['trust', 'methods'],
  ['trust status', 'methods'],
  ['trust not_now', 'methods suggest'],
  ['trust *', 'methods *'],
  ['savings preview', 'sharing preview'],
  ['savings on', 'sharing on'],
  ['savings off', 'sharing off'],
  ['savings not_now', 'sharing not_now'],
  ['savings status', 'status'],
  ['savings mail *', 'sharing mail *'],
  ['dashboard', 'status'],
  ['dashboard allow', 'sharing page on'],
  ['dashboard not_now', 'sharing page off'],
]

/** An old spelling as its new words, with the one line that names the new spelling; null for anything else. Pure. */
export function renameOf(words: string[]): { words: string[]; line: string } | null {
  const low = words.map((w) => w.toLowerCase())
  for (const [from, to] of RENAMED) {
    const f = from.split(' ')
    const star = f[f.length - 1] === '*'
    const head = star ? f.slice(0, -1) : f
    if (low.length < head.length || (!star && low.length !== head.length)) continue
    if (!head.every((w, i) => low[i] === w)) continue
    const rest = words.slice(head.length)
    const next = [...to.split(' ').filter((w) => w !== '*'), ...(to.endsWith('*') ? rest : [])]
    const shown = (ws: string[]) => [COMMAND, ...ws].join(' ')
    return { words: next, line: `${shown(words)} was renamed to ${shown(next)}.` }
  }
  return null
}

// ------------------------------------------------------------------ types

/** $.ui.ask: resolves to the label chosen or the text typed under "Other"; rejects when dismissed or nobody can be
 * asked (a -p run). */
export type Ask = (question: string, options: { options: string[]; header?: string }) => Promise<string>
export type AutoUpdate = { on: boolean; source: string; how: string }
export type ListedFile = { name: string; kind?: string; size?: number }
export type ReadFs = {
  list(path: string): Promise<readonly ListedFile[]>
  read(path: string): Promise<string>
}

export type CommandDeps = {
  svc: Svc
  store: KV
  now: () => number // ms since the epoch
  ask?: Ask | null
  autoUpdate?: () => Promise<AutoUpdate | null>
  updateLine?: () => Promise<string | null> // the terminal update line, or null where commands can run
  updateNow?: () => Promise<string> // update.ts applyUpdate: runs only on the user's answer
  facts?: () => Promise<Facts | ScanProgress | null> // the estimate's scan of this machine's history (EstimateScan);
  // null when there is none
  dailyBody?: (day: string) => Promise<Record<string, unknown>> // one day's POST /metrics/daily body (may throw)
  clientVersion?: string // the plugin's release version (the export's shell stamp), for the estimate body
  outbox?: Outbox | null
  outboxFs?: ReadFs | null
  sleep?: (ms: number) => Promise<unknown> // bounds the status hello (the command hook has about 10 s in all)
  dashboardUrl?: () => Promise<string | null> // the published dashboard's artifact URL, for status
  bossUrl?: () => Promise<string | null> // the published company board's artifact URL (company admins)
  trustFile?: TrustFile | null // the user-level CLAUDE.md (trust.ts)
  canAsk?: () => boolean // choice.ts canAsk: someone can be asked in this session
  asked?: { get(): Promise<number | null>; set(ms: number): Promise<void> } | null // the shared "last asked" time
  dataText?: () => Promise<string> // the plugin's DATA.md (may throw)
  removeDeps?: Pick<RemoveDeps, 'fs' | 'dirs' | 'stopLog'> | null // /agent-services remove (remove.ts)
}

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** The local calendar day of a ms time, as the Python client's _today. */
export function localDay(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const isoDay = (unixSeconds: number): string => new Date(unixSeconds * 1000).toISOString().slice(0, 10)

/** Dollars as $1,234.56 (negative as -$1.20). */
export function usd(x: unknown): string {
  const v = num(x)
  if (v === null) return '$?'
  const s = Math.abs(v)
    .toFixed(2)
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return (v < 0 ? '-$' : '$') + s
}

/** A plain-English summary of one POST /metrics/daily body, for a reader who will not read JSON: the day, the
 * sessions, subagent runs, compactions, total tokens and estimated API cost, all summed from the body itself. One
 * line: it follows the preview's lead-in on the same line, so the exact body stays alone on the next line. */
export function dailySummary(body: Record<string, unknown>): string {
  const rows = (k: string): Record<string, any>[] => {
    const v = k === 'compact' ? (isObj(body.savings) ? body.savings.compact : null) : body[k]
    return Array.isArray(v) ? v.filter(isObj) : []
  }
  const sum = (list: Record<string, any>[], f: (r: Record<string, any>) => unknown): number =>
    list.reduce((n, r) => n + (num(f(r)) ?? 0), 0)
  const count = (n: number, one: string, many: string): string =>
    `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} ${n === 1 ? one : many}`
  const models = rows('by_model')
  const tokens = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'].reduce(
    (n, k) => n + sum(models, (r) => r[k]),
    0,
  )
  return (
    `in plain words, on ${String(body.day ?? '?')} this machine had ` +
    `${count(sum(rows('sessions'), (r) => r.count), 'session', 'sessions')}, ` +
    `${count(sum(rows('by_task'), (r) => r.count), 'subagent run', 'subagent runs')} and ` +
    `${count(rows('compact').length, 'compaction', 'compactions')}, using ${count(tokens, 'token', 'tokens')} in total ` +
    `(about ${usd(sum(models, (r) => r.api_usd))} at API prices). Only these numbers are sent: no prompts, file ` +
    'contents or file paths. The exact data, for anyone who wants to check:'
  )
}

/** A 0-1 share as a percent with one decimal. */
export const pct = (x: unknown): string => {
  const v = num(x)
  return v === null ? '?%' : `${(v * 100).toFixed(1)}%`
}

export const errorText = (code: string | null | undefined): string =>
  ERROR_TEXT[code ?? 'failed'] ?? `The request failed (${code}).`

const EMAIL_RX = /^[^\s@]+@[^\s@]+$/
export const validEmail = (s: unknown): s is string =>
  typeof s === 'string' && s.length >= 3 && s.length <= 254 && EMAIL_RX.test(s)

/** The code as typed in the dialog: spaces and dashes people add between digits are dropped. */
export const cleanCode = (s: string): string => s.replace(/[\s-]+/g, '')
// The mailed sign-in code is 8 digits (6 to 8 taken). After login the person pastes
// it as their next message (the dialog put typing last, under Other); prompt.submit catches it before the model.
export const PASTED_CODE_RX = /^[0-9]{6,8}$/
// prompt.submit has a time budget and forwards the message when a hook runs past it: the pasted path answers by then
export const PASTED_WAIT_MS = 6_000
export const PASTED_SLOW = `The sign-in is still being checked. Run ${COMMAND} status in a moment to see whether it finished.`
// said whenever prompt.submit drops a pasted code: as a toast, and as the first line of the drop reason
export const PASTED_TAKEN = 'agent-services took the sign-in code; it was not sent to the model.'
export const PASTED_FAILED = `The sign-in did not finish. Enter the code with ${COMMAND} code.`
export const PASTE_CODE_LINE =
  'Paste the 8-digit code from that email here as your next message. It goes to agent-services only, not to ' +
  `Claude, and works for 10 minutes. (Or run ${COMMAND} code.)`

// ------------------------------------------------------------------ auto-update (the Python client, read only)

export type AutoUpdateSources = {
  env: (name: string) => Promise<string | undefined | null>
  settings: (source: string) => Promise<unknown> // one settings source as loaded ({} or null when none)
  readText: (path: string) => Promise<string | null> // null when missing or unreadable
  configDir: string // CLAUDE_CONFIG_DIR, else <home>/.claude
}

const flag = (entry: unknown): boolean | null => {
  const v = isObj(entry) ? entry.autoUpdate : undefined
  return typeof v === 'boolean' ? v : null
}

/** Whether Claude Code's background auto-update is on for the agent-plugin marketplace: env switches, then
 * extraKnownMarketplaces in the settings (managed, local, project, user), then known_marketplaces.json, else off. */
export async function autoUpdateState(src: AutoUpdateSources): Promise<AutoUpdate> {
  const env = async (n: string) => {
    try {
      return Boolean(await src.env(n))
    } catch {
      return false
    }
  }
  let off = false
  for (const v of AUTO_UPDATE_OFF_VARS) if (await env(v)) off = true
  if (off && !(await env(AUTO_UPDATE_FORCE_VAR))) return { on: false, source: 'env', how: AUTO_UPDATE_HOW }
  for (const [source, name] of AUTO_UPDATE_SOURCES) {
    let data: unknown = null
    try {
      data = await src.settings(source)
    } catch {
      data = null
    }
    const markets = isObj(data) ? data.extraKnownMarketplaces : undefined
    const v = isObj(markets) ? flag(markets[MARKETPLACE]) : null
    if (v !== null) return { on: v, source: name, how: AUTO_UPDATE_HOW }
  }
  let known: unknown = null
  try {
    const t = await src.readText(`${src.configDir.replace(/[\\/]+$/, '')}/plugins/known_marketplaces.json`)
    known = t === null ? null : JSON.parse(t)
  } catch {
    known = null
  }
  const v = isObj(known) ? flag(known[MARKETPLACE]) : null
  if (v !== null) return { on: v, source: 'plugin_menu', how: AUTO_UPDATE_HOW }
  return { on: false, source: 'default', how: AUTO_UPDATE_HOW }
}

/** The auto-update line. Where an environment variable turns Claude Code's own plugin updates off (the desktop app
 * sets one), the menu step cannot help: `updateLine` null means `/agent-services update` can run it, else it is the manual
 * update command, given instead of the steps. */
export function autoUpdateText(a: AutoUpdate | null, updateLine: string | null = null): string | null {
  if (!a) return null
  if (a.on) {
    return "Auto-update: on. Claude Code's own auto-update is on for agent-plugin, so Claude Code updates this plugin " +
      'by itself, without asking you; the plugin itself never updates. To be asked first, turn it off: /plugin, ' +
      'Marketplaces, agent-plugin, Disable auto-update.'
  }
  if (a.source === 'env') {
    return updateLine === null
      ? "Auto-update: Claude Code's own plugin updates are off here (an environment variable). This plugin checks " +
          `for new versions and never updates itself: ${COMMAND} update updates it when you choose.`
      : "Auto-update: Claude Code's own plugin updates are off here (an environment variable). To update the " +
          `plugin, run this in a terminal: ${updateLine}`
  }
  return (
    'Auto-update: off. The plugin never updates itself: it checks for a newer version, Claude tells you about it, ' +
    `and ${COMMAND} update updates it when you choose. (Claude Code's own auto-update would update it without ` +
    'asking you; this plugin never changes your settings.)'
  )
}

// ------------------------------------------------------------------ transcripts for the estimate

/** Every *.jsonl under `root` (relative paths with '/') with its listed size, in os.walk order; null when `root`
 * cannot be listed. Nothing is read. */
export async function listTranscripts(fs: ReadFs, root: string): Promise<{ rel: string; size: number }[] | null> {
  const base = root.replace(/[\\/]+$/, '')
  const out: { rel: string; size: number }[] = []
  let any = false
  const walk = async (rel: string, depth: number): Promise<void> => {
    let entries: readonly ListedFile[]
    try {
      entries = await fs.list(rel ? `${base}/${rel}` : base)
      any = true
    } catch {
      return
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.kind === 'dir') {
        if (depth < 8) await walk(r, depth + 1)
      } else if ((e.kind === undefined || e.kind === 'file') && e.name.endsWith('.jsonl')) {
        out.push({ rel: r, size: typeof e.size === 'number' ? e.size : 0 })
      }
    }
  }
  await walk('', 0)
  return any ? walkOrder(out) : null
}

/** One listed transcript as scan() takes it: a file over READ_LIMIT, or one that cannot be read, has text null
 * (estimate.ts scales it in by size). */
async function readTranscript(fs: ReadFs, base: string, f: { rel: string; size: number }): Promise<TranscriptFile> {
  let text: string | null = null
  if (f.size <= READ_LIMIT) {
    try {
      text = String(await fs.read(`${base}/${f.rel}`))
    } catch {
      text = null
    }
  }
  return { rel: f.rel, size: f.size, text }
}

export type ScanProgress = { progress: { done: number; total: number } } // bytes of readable transcripts

/**
 * The estimate's scan of every transcript, spread over runs of the command. A hook has 10 s of its own time, where
 * the reads are free and the parse is not; a long history takes longer (measured 11.8 s for 2.1 GB on a test
 * machine), so each step() parses for about `sliceMs` (5 s, leaving room for finish()) and answers its progress, and
 * the next run goes on where it stopped. The facts are scan() of the same files (transcripts.ts Scanner). A scan
 * left for more than `maxAgeMs` (30 minutes) starts again.
 */
export class EstimateScan {
  private job: { files: { rel: string; size: number }[]; next: number; scanner: Scanner; done: number; total: number; at: number } | null =
    null

  private readonly fs: ReadFs
  private readonly prices: Prices
  private readonly opt: { clock?: () => number; sliceMs?: number; maxAgeMs?: number }

  constructor(fs: ReadFs, prices: Prices, opt: { clock?: () => number; sliceMs?: number; maxAgeMs?: number } = {}) {
    this.fs = fs
    this.prices = prices
    this.opt = opt
  }

  async step(root: string): Promise<Facts | ScanProgress | null> {
    const clock = this.opt.clock ?? (() => Date.now())
    if (!this.job || clock() - this.job.at > (this.opt.maxAgeMs ?? 1_800_000)) {
      this.job = null
      const files = await listTranscripts(this.fs, root)
      if (!files) return null
      const total = files.reduce((n, f) => n + (f.size <= READ_LIMIT ? f.size : 0), 0)
      this.job = { files, next: 0, scanner: new Scanner(this.prices), done: 0, total, at: clock() }
    }
    const job = this.job
    const base = root.replace(/[\\/]+$/, '')
    const start = job.next
    let used = 0
    while (job.next < job.files.length) {
      if (job.next > start && used >= (this.opt.sliceMs ?? 5000)) return { progress: { done: job.done, total: job.total } }
      const f = job.files[job.next]!
      const file = await readTranscript(this.fs, base, f) // a read is the engine's time, not the hook's
      const t = clock()
      job.scanner.add(file)
      used += clock() - t
      job.next += 1
      if (f.size <= READ_LIMIT) job.done += f.size
    }
    this.job = null
    return job.scanner.finish()
  }
}

// ------------------------------------------------------------------ the command

export class Command {
  private d: CommandDeps
  private previewed: { body: Record<string, unknown>; text: string; at: number } | null = null
  private askedMem: number | null = null // the "last asked" time where no shared file is wired (tests)

  constructor(deps: CommandDeps) {
    this.d = deps
  }

  /** One run of /agent-services <args>; always answers a text, already redacted. */
  async run(args: string): Promise<string> {
    let text: string
    try {
      const words = String(args ?? '').trim().split(/\s+/).filter(Boolean)
      const renamed = renameOf(words)
      text = await this.dispatch(renamed ? renamed.words : words)
      if (renamed) text += `\n${renamed.line}`
    } catch {
      text = `agent-services: the command failed; try ${COMMAND} status.`
    }
    return redact(text)
  }

  private async dispatch(words: string[]): Promise<string> {
    const sub = (words[0] ?? 'status').toLowerCase()
    const rest = words.slice(1)
    const svc = this.d.svc
    if (!KNOWN_COMMANDS.includes(sub)) return `Unknown subcommand "${sub.slice(0, 40)}". ${USAGE}`
    const signedOutOk = AUTH_FAIL_COMMANDS.includes(sub) || (sub === 'methods' && (rest.length === 0 || (rest.length === 1 && rest[0]!.toLowerCase() === 'off')))
    if (!signedOutOk) {
      const st = await svc.authState(true)
      // nothing else works while signed out, and nothing is sent
      if (st !== 'ok') return st === 'locked' ? LOCKED_LINE : st === 'paused' ? ORG_PAUSED_LINE : PAUSED_LINE
    }
    switch (sub) {
      case 'status':
        return rest.length ? USAGE : this.status()
      case 'login':
        return this.login(rest)
      case 'code':
        return this.code(rest)
      case 'logout':
        return rest.length ? USAGE : this.logout()
      case 'setup':
        return rest.length ? USAGE : this.setup()
      case 'sharing':
        return this.sharing(rest)
      case 'savings':
        return rest.length ? USAGE : this.savings()
      case 'methods':
        return this.methods(rest)
      case 'update':
        return rest.length ? USAGE : this.update()
      case 'offline':
        return this.offline(rest)
      case 'estimate':
        return this.estimate(rest)
      case 'info':
        return this.info(rest)
      case 'remove':
        return rest.length ? USAGE : this.remove()
      case 'company': // the company admin's board and weekly summary email
        return companyCommand({ svc, store: this.d.store, url: () => this.d.bossUrl?.() ?? Promise.resolve(null) }, rest)
      default:
        return this.served(rest)
    }
  }

  // ---------------- status (read only: it never asks a question)
  private async status(): Promise<string> {
    const svc = this.d.svc
    const auth = await svc.authState(true)
    const lines: string[] = []
    let st = await svc.status()
    if (auth === 'ok' && !st.offline && (st.gate as any)?.reason === 'unknown') {
      // one hello, so the plan and the gate are current; never throws, and waits STATUS_HELLO_MS at most
      const hello = svc.handshake('tool')
      await (this.d.sleep ? Promise.race([hello, this.d.sleep(STATUS_HELLO_MS)]) : hello)
      st = await svc.status()
    }
    if (auth === 'locked') lines.push(LOCKED_LINE)
    else if (auth === 'paused') lines.push(ORG_PAUSED_LINE)
    else if (auth !== 'ok') lines.push(`agent-services: signed out. Sign in with ${COMMAND} login.`)
    else {
      const until = num(st.expires_at)
      lines.push(
        `agent-services: signed in (account ${st.account_id ?? '?'}, plan ${st.plan ?? 'unknown'}` +
          (until !== null ? `; the sign-in is valid until ${isoDay(until)}` : '') +
          ').',
      )
      const gate = st.gate as { open: boolean; reason: string | null; min_shell: string | null }
      if (gate?.open) lines.push('Service: connected.')
      else if (gate?.reason === 'unknown') lines.push('Service: not checked yet in this session.')
      else if (gate?.reason !== 'offline') {
        const n = gateNotice(gate)
        if (n) lines.push(n)
      }
      if (st.plan === 'guard') lines.push(PLAN_NOTICE)
      const org = await orgChoice(this.d.store)
      if (org) lines.push(ORG_SAVINGS_TEXT[org]!) // shown, not counted as the one-time company line
    }
    if (st.offline) lines.push(`Offline mode is on: nothing is sent; ${COMMAND} offline off turns it off.`)
    const seen = new Set<string>(lines)
    for (const n of svc.notices()) {
      if (!seen.has(n.text)) {
        seen.add(n.text)
        lines.push(n.text)
      }
    }
    const a = await this.safe(() => this.d.autoUpdate?.() ?? Promise.resolve(null), null)
    const up = await this.safe(() => this.d.updateLine?.() ?? Promise.resolve(null), null)
    const au = autoUpdateText(a, up)
    if (au) lines.push(au)
    if (up && !(a && !a.on && a.source === 'env')) lines.push(`To update the plugin, run this in a terminal: ${up}`)
    const ul = updatesLine()
    if (ul) lines.push(ul)
    if (auth === 'ok') {
      lines.push(await this.recordLine(), await this.methodsLine())
      const n = (await this.safe(() => this.openQuestions(), [] as Question[])).length
      if (n) lines.push(`${n} question${n === 1 ? '' : 's'} waiting: run ${COMMAND} setup.`)
    }
    return lines.join('\n')
  }

  /** The savings record and its page, in one line. */
  private async recordLine(): Promise<string> {
    const s = await recordState(this.d.store)
    const head = s.org
      ? `Savings record: ${s.org}, set by your company for everyone.`
      : s.own === 'on'
        ? 'Savings record: on.'
        : s.own === 'off'
          ? `Savings record: off (not asked again; ${COMMAND} sharing on turns it on).`
          : `Savings record: not answered yet (${COMMAND} sharing on turns it on).`
    if (!s.page) return `${head} Private savings page: off.`
    const url = await this.safe(() => this.d.dashboardUrl?.() ?? Promise.resolve(null), null)
    return `${head} Private savings page: ` + (url ? `published at ${url}.` : 'on, published when Claude finishes its next reply.')
  }

  // ---------------- the setup questions (the savings record, its page under a company, the methods level)

  private canAsk(): boolean {
    return !!this.d.ask && (this.d.canAsk ? this.d.canAsk() : false)
  }

  private async askedAt(): Promise<number | null> {
    return this.d.asked ? this.safe(() => this.d.asked!.get(), null) : this.askedMem
  }

  private async stampAsked(): Promise<void> {
    const now = this.d.now()
    this.askedMem = now
    if (this.d.asked) await this.safe(() => this.d.asked!.set(now), undefined)
  }

  /** The questions not answered yet (whenever they were last asked). */
  private async openQuestions(): Promise<Question[]> {
    const out: Question[] = []
    const s = await recordState(this.d.store)
    if (savingsOpen(s)) out.push('savings')
    else if (pageOpen(s)) out.push('page')
    if ((await readLevel(this.d.store, this.d.now())) === null) out.push('methods')
    return out
  }

  /** The open questions that may be asked now: someone can be asked, and none was asked in the last 7 days. */
  async questionsDue(): Promise<Question[]> {
    if (!(this.d.canAsk ? this.d.canAsk() : false)) return []
    if (!askDue(await this.askedAt(), this.d.now())) return []
    return this.safe(() => this.openQuestions(), [])
  }

  /** /agent-services setup: every open question in the dialog, one after the other; nothing else. */
  private async setup(): Promise<string> {
    const open = await this.openQuestions()
    if (!open.length) {
      return `Nothing to set up: every question is answered.\n${await this.recordLine()}\n${await this.methodsLine()}`
    }
    if (!this.canAsk()) {
      return 'Nobody can be asked in a dialog here. Answer with ' +
        open.map((q) => QUESTION_COMMANDS[q]).join('; ') + '.'
    }
    return this.setupRound(open)
  }

  /** Ask each question in the dialog and apply the answer; a dismissed dialog ends the round. */
  private async setupRound(open: Question[]): Promise<string> {
    await this.stampAsked()
    const out: string[] = []
    for (const q of open) {
      const a = await this.askOne(q)
      if (a === null) {
        out.push(`Not answered. ${COMMAND} setup asks again, or answer with ${QUESTION_COMMANDS[q]}.`)
        break
      }
      out.push(a)
    }
    return out.join('\n')
  }

  private async dialog(question: string, options: readonly string[], header: string): Promise<string | null> {
    try {
      const a = String(await this.d.ask!(question, { options: [...options], header })).trim()
      return options.includes(a) ? a : null
    } catch {
      return null // dismissed, or nobody can be asked
    }
  }

  private async askOne(q: Question): Promise<string | null> {
    if (q === 'savings') {
      const a = await this.dialog(await sharingQuestion(this.d.store, SHARING_QUESTION), SHARING_OPTIONS, SHARING_HEADER)
      if (a === null) return null
      const i = SHARING_OPTIONS.indexOf(a)
      return i === 3 ? this.sharingPreview() : this.setRecord((['on', 'not_now', 'off'] as const)[i]!)
    }
    if (q === 'page') {
      const a = await this.dialog(PAGE_QUESTION, PAGE_OPTIONS, SHARING_HEADER)
      if (a === null) return null
      if (a === PAGE_OPTIONS[1]) return `The private savings page stays off for now; ${COMMAND} sharing page on publishes it.`
      return this.setPage(a === PAGE_OPTIONS[0])
    }
    const a = await this.dialog(METHODS_QUESTION, METHODS_OPTIONS, METHODS_HEADER)
    if (a === null) return null
    if (a === METHODS_OPTIONS[2]) return this.methods(['off'])
    const kept = await this.methods(['suggest'])
    if (a === METHODS_OPTIONS[0]) return kept
    // "my own instructions": only after the user read the text, so it is shown here and confirmed with methods on
    return `${kept}\nTo make them your own instructions, read them first:\n${await this.methods(['preview'])}\n` +
      `Then run ${COMMAND} methods on.`
  }

  /** The note the model gets with a prompt (one at a time): the company's choice once; the open setup questions at
   * most once per 7 days and only where someone can answer; from the second prompt of a session on, a newer plugin
   * version or a changed methods text. null: nothing to say. */
  async promptNote(first: boolean, update: () => Promise<{ installed: string; latest: string } | null>,
    pending: () => Promise<boolean>): Promise<{ text: string; which: 'org' | 'setup' | 'update' | 'pending' } | null> {
    if (!(await this.signedIn())) return null
    const told = await orgNotice(this.d.store)
    if (told) {
      return {
        text: `${NOTE_LABEL} Before working on the message, tell the user this one line from the agent-services ` +
          `plugin, in these words: "${told}" Then go on with the message.`,
        which: 'org',
      }
    }
    const facts = async () => {
      const st = await this.safe(() => this.d.svc.status(), {} as any)
      return framing(st?.account_id, st?.plan)
    }
    const due = await this.questionsDue()
    if (due.length) {
      await this.stampAsked()
      const q = due.includes('savings') || due.includes('page') ? await sharingQuestion(this.d.store, SHARING_QUESTION) : ''
      return { text: setupNoteText(due, await facts(), { savings: q, page: PAGE_QUESTION, methods: METHODS_QUESTION }), which: 'setup' }
    }
    if (first) return null // the update notice waits until after the first turn of work
    const u = (await this.autoUpdateOn()) ? null : await this.safe(update, null)
    if (u) return { text: updateNoteText(u.installed, u.latest, await facts()), which: 'update' }
    if (await this.safe(pending, false)) return { text: pendingNoteText(await facts()), which: 'pending' }
    return null
  }

  /** The plugin's data note (DATA.md, shipped with the plugin), whole. */
  private async data(): Promise<string> {
    const text = await this.safe(async () => (this.d.dataText ? String(await this.d.dataText()) : ''), '')
    return text.trim()
      ? text.trim()
      : 'The data note (DATA.md in the plugin folder) could not be read here; it is also in the plugin\'s public ' +
          'repository. Nothing was changed.'
  }

  /** info data | hooks | log [<day>]: what the plugin sends, its hooks, and the request log. Read only. */
  private async info(rest: string[]): Promise<string> {
    const w = (rest[0] ?? '').toLowerCase()
    if (w === 'data' && rest.length === 1) return this.data()
    if (w === 'hooks' && rest.length === 1) return hooksText()
    if (w === 'log' && rest.length <= 2) return this.outbox(rest.slice(1))
    return `Usage: ${COMMAND} info data | info hooks | info log [<YYYY-MM-DD>]`
  }

  /** /agent-services remove (remove.ts): sign out, take the CLAUDE.md section out, empty the local files, delete the
   * stored values, then the uninstall command. Only the slash command runs it. */
  private async remove(): Promise<string> {
    const rd = this.d.removeDeps
    return removeAll({
      logout: async () => 'Sign-out: ' + (await this.logout()),
      trustOff: async () => {
        const f = this.d.trustFile
        if (!f) return 'CLAUDE.md: it cannot be reached from here; nothing was changed.'
        const text = await f.read() // throws when it exists but cannot be read: said by removeAll
        if (!hasTrust(text) && !unbalancedTrust(text)) return 'CLAUDE.md: it has no agent-services section; nothing was changed.'
        return 'CLAUDE.md: ' + (await this.takeSectionOut(f)) // the same checks as methods off
      },
      store: this.d.store,
      fs: rd?.fs ?? null,
      dirs: rd?.dirs ?? (async () => []),
      stopLog: rd?.stopLog,
    })
  }

  /** Updates the plugin now (update.ts applyUpdate), waiting UPDATE_WAIT_MS at most: a hook has about 10 s. */
  private async update(): Promise<string> {
    if (!this.d.updateNow) return `This plugin cannot run commands here. To update it, run this in a terminal: ` +
      `${updateCommand(MARKETPLACE)}`
    const run = this.d.updateNow()
    const slow = 'The update is running (it can take a minute or two). ' +
      `${COMMAND} status shows the result in its Updates: line.`
    return this.d.sleep ? Promise.race([run, Promise.resolve(this.d.sleep(8000)).then(() => slow)]) : run
  }

  /** Empties the marker /agent-services remove left (remove.ts removedMarker), so the plugin works again. */
  private async clearRemoved(): Promise<void> {
    const rd = this.d.removeDeps
    const dir = rd?.fs ? (await rd.dirs())[0] : undefined
    if (!rd?.fs || !dir) return
    const there = (await rd.fs.list(dir).catch(() => [])).some((e) => e.name === 'REMOVED')
    if (there) await rd.fs.write(removedMarker(dir), '')
    resetRemoved()
  }

  /** Signed in (auth state ok): only then does the model get any note. Never throws. */
  async signedIn(): Promise<boolean> {
    return (await this.safe(() => this.d.svc.authState(), 'unknown')) === 'ok'
  }

  /** Claude Code's own plugin auto-update is on for this marketplace. Never throws. */
  async autoUpdateOn(): Promise<boolean> {
    const a = await this.safe(() => this.d.autoUpdate?.() ?? Promise.resolve(null), null)
    return a?.on === true
  }

  // ---------------- the working methods: one three-level switch (methods.ts)

  private async level(): Promise<Level> {
    const stored = await readLevel(this.d.store, this.d.now())
    const f = this.d.trustFile
    const there = stored?.level === 'on' && f ? await f.read().then(hasTrust, () => true) : false
    return levelOf(stored, there)
  }

  private async methodsLine(): Promise<string> {
    const level = await this.safe(() => this.level(), 'suggest' as Level)
    const pending = level === 'on' && (await this.safe(() => methodsDiff(lineDiff), null)) !== null
    return METHODS_LINE[level]! + (pending ? ` The served text changed since you approved it: ${COMMAND} methods diff.` : '')
  }

  /** Take the CLAUDE.md section out, with the checks every write of the user's file has. The answer says what
   * happened (also when nothing was there). */
  private async takeSectionOut(f: TrustFile): Promise<string> {
    let text: string | null
    try {
      text = await f.read()
    } catch {
      return `Your CLAUDE.md (${f.path}) could not be read, so its agent-services section (if any) was not taken out.`
    }
    if (unbalancedTrust(text)) {
      return `Your CLAUDE.md (${f.path}) has an agent-services marker line without its pair; nothing was changed in ` +
        'it. Remove the leftover marker line, then run this again.'
    }
    if (!hasTrust(text)) return 'Your CLAUDE.md has no agent-services section.'
    const next = withoutTrust(text!)
    const again: unknown = await f.read().then((t) => t, () => Symbol('unreadable')) // read again just before
    if (again !== text) return `Your CLAUDE.md (${f.path}) changed just now; nothing was changed in it. Run this again.`
    await f.write(next)
    return `Removed the agent-services section from ${f.path}.`
  }

  private async methods(rest: string[]): Promise<string> {
    const sub = (rest[0] ?? '').toLowerCase()
    const f = this.d.trustFile
    if (rest.length > 1) return USAGE
    if (sub === '') return this.methodsLine()
    if (sub === 'preview') {
      const full = await previewMethods()
      const line = f ? await f.importLine() : null
      return (line ? `With ${COMMAND} methods on, this line is added to the end of your CLAUDE.md (${f!.path}):\n\n${line}\n\n` +
        'It loads a file this plugin keeps renewed while you are signed in; a later change to the text is shown ' +
        `to you first (${COMMAND} methods diff). ` : '') +
        (full === null
          ? 'The full text cannot be fetched right now (signed out or the service unreachable); try again later.'
          : `The full text now:\n\n----- begin -----\n${full.trim()}\n----- end -----`)
    }
    if (sub === 'diff') {
      const d = await methodsDiff(lineDiff)
      return d === null
        ? 'The served working methods are the ones you approved; there is nothing to review.'
        : `The served working methods differ from the ones you approved ("- " approved, "+ " new):\n\n${d}\n\n` +
            `${COMMAND} methods accept takes the new text; ${COMMAND} methods keep keeps the approved one.`
    }
    if (sub === 'accept' || sub === 'keep') {
      const done = await settlePending(sub === 'accept')
      if (!done) return 'There is no changed text to review; nothing was changed.'
      return sub === 'accept'
        ? 'The new working methods replace the approved ones; your CLAUDE.md loads them from the next session on.'
        : 'The approved working methods stay; this change is not asked about again.'
    }
    if (sub !== 'on' && sub !== 'off' && sub !== 'suggest') return USAGE
    const now = this.d.now()
    if (sub !== 'on') {
      const out = f ? await this.takeSectionOut(f) : 'Your CLAUDE.md cannot be reached from here.'
      if (!(await safeSet(this.d.store, LEVEL_KEY, { level: sub, at: now }))) return errorText('store_unavailable')
      await syncMethodsNow()
      return (out.startsWith('Removed') || out.startsWith('Your CLAUDE.md has no') ? '' : out + '\n') + METHODS_LINE[sub]!
    }
    if (!f) return 'Your CLAUDE.md cannot be reached from here; nothing was changed.'
    let text: string | null
    try {
      text = await f.read()
    } catch {
      return `Your CLAUDE.md (${f.path}) could not be read; nothing was changed.`
    }
    if (unbalancedTrust(text)) {
      return `Your CLAUDE.md (${f.path}) has an agent-services marker line without its pair; nothing was changed. ` +
        'Remove the leftover marker line, then run this again.'
    }
    if (hasTrust(text)) {
      // already there: the approved text stays; a changed text is reviewed with diff and accept, never approved here
      await safeSet(this.d.store, LEVEL_KEY, { level: 'on', at: now })
      return `Your CLAUDE.md (${f.path}) already has the agent-services section; the approved working methods stay and ` +
        `nothing was changed. If the text changed since you approved it, ${COMMAND} methods diff shows the change and ` +
        `${COMMAND} methods accept takes it.`
    }
    const line = await f.importLine()
    if (/\s/.test(line.slice(1))) {
      return `The methods file path has a space in it (${line.slice(1)}), which a CLAUDE.md import cannot load; nothing ` +
        'was changed.'
    }
    const next = withTrust(text, line)
    const again: unknown = await f.read().then((t) => t, () => Symbol('unreadable')) // read again just before
    if (again !== text) return `Your CLAUDE.md (${f.path}) changed just now; nothing was changed. Run this again.`
    await f.write(next)
    await safeSet(this.d.store, LEVEL_KEY, { level: 'on', at: now })
    const ok = await approveMethods() // the text previewed, then the file the line loads
    return `Added the agent-services section to ${f.path}: from the next session on, the working methods you approved ` +
      `count as your own instructions, and the planning gate holds larger file edits until agent-state.md has a plan; ` +
      `a change to the methods is shown to you first. ${COMMAND} methods suggest takes the section out again.` +
      (ok.text !== null && !ok.shown
        ? ` No preview was shown in this session, so this is the text approved:\n\n----- begin -----\n` +
            `${ok.text.trim()}\n----- end -----`
        : '')
  }

  // ---------------- the one savings record (choice.ts)
  private async sharing(rest: string[]): Promise<string> {
    const w = rest.map((x) => x.toLowerCase())
    if (!w.length) return this.recordLine()
    if (w.length === 1 && (w[0] === 'on' || w[0] === 'off' || w[0] === 'not_now')) return this.setRecord(w[0])
    if (w.length === 1 && w[0] === 'preview') return this.sharingPreview()
    if (w.length === 2 && w[0] === 'page' && (w[1] === 'on' || w[1] === 'off')) return this.setPage(w[1] === 'on')
    if (w.length === 2 && w[0] === 'mail' && (w[1] === 'on' || w[1] === 'off')) return this.setMail(w[1] === 'on')
    return USAGE
  }

  /** The weekly email (a server setting); null when it changed, else the reason. */
  private async mail(on: boolean): Promise<string | null> {
    const r = await this.d.svc.call('POST', '/metrics/weekly-mail', { on })
    return r.ok ? null : errorText(r.error)
  }

  /** One answer for the upload, the page and the weekly email. Under a company's choice it sets the page only. */
  private async setRecord(sub: 'on' | 'off' | 'not_now'): Promise<string> {
    const s = await recordState(this.d.store)
    if (s.org) {
      if (sub === 'not_now') {
        await this.stampAsked()
        return `${ORG_SET_TEXT} Your private page stays as it is.`
      }
      return `Your company decides the daily upload for everyone; this changed only your private page.\n` +
        (await this.setPage(sub === 'on'))
    }
    const at = this.d.now()
    let mailError: string | null = null
    if (sub !== 'on') mailError = await this.mail(false) // while the metrics routes are still open
    const kept = sub === 'on'
      ? (await this.d.svc.setService('metrics', true)) && (await writeEntry(this.d.store, { record: 'on', at, page: 'on', page_at: at }))
      : sub === 'off'
        ? await writeEntry(this.d.store, { record: 'off', at, page: 'off', page_at: at })
        : await writeEntry(this.d.store, { record: undefined, at: undefined, page: undefined, page_at: undefined })
    if (!kept) return errorText('store_unavailable')
    if (sub === 'not_now') await this.stampAsked()
    if (sub === 'on') mailError = await this.mail(true)
    const mailLine = mailError
      ? `\nThe weekly email setting was not changed: ${mailError} Run ${COMMAND} sharing mail ${sub === 'on' ? 'on' : 'off'} ` +
        'later to change it.'
      : ''
    if (sub === 'on') {
      return 'Savings record is on: your private savings page is published to your claude.ai account when Claude ' +
        'finishes this reply, a weekly email sums up the savings, and a small daily usage summary is uploaded ' +
        '(the first upload also sends up to 30 earlier days). ' +
        `To turn one part off: ${COMMAND} sharing page off (the page), ${COMMAND} sharing mail off (the email); ` +
        `${COMMAND} sharing off turns it all off.` + mailLine
    }
    if (sub === 'off') {
      return 'Savings record is off: no page is published, no weekly email is sent and nothing more is uploaded. You ' +
        `are not asked again; turn it on any time with ${COMMAND} sharing on.` + mailLine
    }
    return 'Savings record is not on: nothing is uploaded, no page is published and no weekly email is sent. You are ' +
      `asked again in 7 days at the earliest; ${COMMAND} sharing on turns it on, ${COMMAND} sharing off stops the ` +
      'question.' + mailLine
  }

  private async setPage(on: boolean): Promise<string> {
    if (!(await writeEntry(this.d.store, { page: on ? 'on' : 'off', page_at: this.d.now() }))) return errorText('store_unavailable')
    if (!on) {
      return 'Your private savings page is off: it is not published or updated any more. (A page published earlier ' +
        'stays in your claude.ai account until you delete it there.)'
    }
    return 'Your private savings page is on: it is published to your claude.ai account when Claude finishes this ' +
      'reply, and kept up to date.' +
      ((await uploadOn(this.d.store)) ? ''
        : (await recordState(this.d.store)).org === 'off'
          ? ' Your company turned the daily upload off, so the page shows no new savings until its admin turns it on.'
          : ` It shows savings only while the daily upload is on (${COMMAND} sharing on).`)
  }

  private async setMail(on: boolean): Promise<string> {
    const r = await this.d.svc.call('POST', '/metrics/weekly-mail', { on })
    if (!r.ok) return `The weekly savings email setting was not changed: ${errorText(r.error)}`
    const now = isObj(r.body) && typeof r.body.on === 'boolean' ? r.body.on : on
    return now
      ? 'The weekly savings email will be sent. (This changes only the email, not the usage upload.)'
      : 'The weekly savings email is stopped. (This changes only the email, not the usage upload.)'
  }

  /** What the savings record sends and shows; changes nothing. */
  private async sharingPreview(): Promise<string> {
    let upload =
      'A small daily summary of numbers is uploaded: token counts and costs per model, task types per hashed ' +
      'project, session counts and savings; never prompts, file contents or paths. (Its exact text could not be ' +
      'built in time on this machine.)'
    if (this.d.dailyBody) {
      const day = plusDays(localDay(this.d.now()), -1)
      try {
        const body = await this.d.dailyBody(day)
        const text = this.d.svc.preview('POST', DAILY_ROUTE, body)
        if (text !== null) upload = `Exactly what one daily upload sends (for ${day}): ${dailySummary(body)}\n${text}`
      } catch (e) {
        if (e instanceof BodyTooLarge) upload += ` (The summary for ${day} is too large to upload.)`
      }
    }
    return (
      'Nothing was turned on. The savings record has three parts:\n' +
      "- A private page on your own claude.ai account (only you can see it unless you share it): savings, counts, " +
      'plan and service state, numbers only.\n' +
      '- A weekly email to your account address with the week\'s savings.\n' +
      `- ${upload}\n` +
      `Nothing of it is uploaded before you turn it on; the first upload then also sends up to 30 earlier days. ` +
      `Every other request the plugin sends (routing advice on subagents, for one) is listed by ${COMMAND} info data.\n` +
      `Turn it on with ${COMMAND} sharing on, or leave it off with ${COMMAND} sharing not_now (asked again in 7 days) ` +
      `or ${COMMAND} sharing off (never asked again).`
    )
  }

  private async safe<T>(f: () => Promise<T>, dflt: T): Promise<T> {
    try {
      return await f()
    } catch {
      return dflt
    }
  }

  // ---------------- sign-in
  /** Asks in the dialog; null when dismissed, unanswerable or the cancel label was picked. */
  private async ask(question: string, cancel: string[]): Promise<string | null> {
    if (!this.d.ask) return null
    try {
      const a = String(await this.d.ask(question, { options: cancel, header: ASK_HEADER })).trim()
      return a && !cancel.includes(a) ? a : null
    } catch {
      return null
    }
  }

  private async login(rest: string[]): Promise<string> {
    if (rest.length > 1) return `${COMMAND} login takes only an email address. ${USAGE}`
    let email: string | null = rest[0] ?? null
    if (email === null) {
      email = await this.ask(EMAIL_QUESTION, EMAIL_CANCEL)
      if (email === null) return `Sign-in not started. Run ${COMMAND} login <email> to start it.`
    }
    if (!validEmail(email)) return `"${email.slice(0, 80)}" is not an email address; nothing was sent.`
    const r = await this.d.svc.loginStart(email)
    if (!r.ok) {
      return `No code was mailed: ${errorText(r.error)}`
    }
    return `A sign-in code was mailed to ${email} if it belongs to an agent-services account.\n${PASTE_CODE_LINE}`
  }

  private async code(rest: string[]): Promise<string> {
    let email: string | null = null
    let refused = false
    for (const w of rest) {
      if (email === null && validEmail(w)) email = w
      else refused = true // a code typed on the command line lands in prompt history: never used
    }
    email = email ?? (await this.d.svc.pendingEmail())
    if (!email) return `No sign-in is waiting for a code. Start one with ${COMMAND} login.`
    const note = refused
      ? 'The command line was not used for the code: typed commands are kept in prompt history. Enter the code in the dialog instead.'
      : ''
    return this.finish(email, note)
  }

  /** Ask for the mailed code in the dialog and finish the sign-in. */
  private async finish(email: string, before: string): Promise<string> {
    const head = before ? before + '\n' : ''
    const typed = await this.ask(`Type the sign-in code mailed to ${email} (under Other)?`, CODE_CANCEL)
    if (typed === null) {
      return head + `Sign-in not finished. Enter the code with ${COMMAND} code within 10 minutes (any session).`
    }
    const code = cleanCode(typed)
    if (code.length < 1 || code.length > 32) return head + `That is not a sign-in code. Try again with ${COMMAND} code.`
    return this.complete(email, code, head)
  }

  /** A message that is only a sign-in code while a sign-in waits for one: finish it (the answer), else null. */
  async pasted(text: string): Promise<string | null> {
    const code = cleanCode(String(text ?? ''))
    if (!PASTED_CODE_RX.test(code)) return null
    const email = await this.safe(() => this.d.svc.pendingEmail(), null)
    if (!email) return null
    // no dialog here: a question inside prompt.submit could run past its budget (any command asks it later)
    const done = this.complete(email, code, '', false).catch(() => PASTED_FAILED)
    let slow: Promise<string> | null = null
    try {
      // a timer that cannot start (or fails) never decides the answer: the sign-in's own answer does
      if (this.d.sleep) slow = Promise.resolve(this.d.sleep(PASTED_WAIT_MS)).then(() => PASTED_SLOW, () => done)
    } catch {
      slow = null
    }
    return slow ? Promise.race([done, slow]) : done
  }

  /** Send the code and, once signed in, the after-sign-in lines and one setup round (in the dialog, where there is
   * one and it may ask now; else the line that says questions wait). */
  private async complete(email: string, code: string, head: string, ask = true): Promise<string> {
    const r = await this.d.svc.loginFinish(email, code)
    if (!r.ok) return head + `Sign-in failed: ${errorText(r.error)}`
    await this.safe(() => this.clearRemoved(), undefined) // signed in again after /agent-services remove: work again
    const st = await this.d.svc.status()
    const lines = [head + `Signed in (account ${st.account_id ?? '?'}, plan ${st.plan ?? 'unknown'}). agent-services is on.`]
    const au = await this.safe(() => this.d.autoUpdate?.() ?? Promise.resolve(null), null)
    if (au && !au.on) {
      const up = au.source === 'env' ? await this.safe(() => this.d.updateLine?.() ?? Promise.resolve(null), null) : null
      lines.push(autoUpdateText(au, up)!)
    }
    const due = ask && this.canAsk() ? await this.questionsDue() : []
    if (due.length) lines.push(await this.safe(() => this.setupRound(due), ''))
    else {
      const n = (await this.safe(() => this.openQuestions(), [] as Question[])).length
      if (n) lines.push(`${n} setup question${n === 1 ? '' : 's'} waiting: run ${COMMAND} setup.`)
    }
    return lines.filter(Boolean).join('\n')
  }

  private async logout(): Promise<string> {
    const svc = this.d.svc
    const before = await svc.authState(true)
    const r = await svc.logout()
    if (r.ok) return 'Signed out: the server ended this sign-in and it was deleted from this machine.'
    if (r.error === 'store_unavailable') {
      return (
        "Sign-out did not finish: Claude Code's plugin store refused to delete the stored sign-in, so it may still " +
        `be on this machine. Try ${COMMAND} logout again.`
      )
    }
    if (r.error === 'offline') {
      return `Offline mode is on, so nothing was sent and the sign-in stays. Run ${COMMAND} offline off, then logout.`
    }
    if (before !== 'ok' || r.error === 'not_logged_in') {
      return 'Signed out on this machine (nothing was sent: there was no valid sign-in to end).'
    }
    return (
      `Signed out on this machine, but the server could not be told (${errorText(r.error)}); that server session ` +
      'ends when it expires or when this account signs in again.'
    )
  }

  // ---------------- savings: the figure only
  private async savings(): Promise<string> {
    if (!(await uploadOn(this.d.store))) {
      return 'Savings are worked out by the service from the daily usage summary, and the savings record is not on ' +
        `for this account. ${COMMAND} sharing preview shows exactly what it sends; ${COMMAND} sharing on turns it on.`
    }
    const r = await this.d.svc.call('GET', '/metrics/savings')
    return r.ok ? savingsText(r.body) : `Savings could not be read: ${errorText(r.error)}`
  }

  // ---------------- estimate (preview, then send only what was previewed)
  private async estimate(rest: string[]): Promise<string> {
    const sub = (rest[0] ?? 'preview').toLowerCase()
    if (rest.length > 1 || !['preview', 'send'].includes(sub)) return USAGE
    if (sub === 'send') {
      const p = this.previewed
      if (!p || this.d.now() - p.at > ESTIMATE_PREVIEW_MS) {
        return `Nothing was sent: first run ${COMMAND} estimate to see exactly what would be sent, then ${COMMAND} estimate send.`
      }
      this.previewed = null // one send per preview
      const r: Result = await this.d.svc.call('POST', '/diagnostic/estimate', p.body, { consent: true })
      if (!r.ok) return estimateError(r.error)
      const rec = estimateFacts(r.body, new Date(this.d.now()).toISOString())
      if (rec) await safeSet(this.d.store, ESTIMATE_KEY, rec) // the savings page shows it
      return estimateText(r.body)
    }
    const facts = this.d.facts ? await this.safe(() => this.d.facts!(), null) : null
    if (!facts) return estimateError('no_data')
    if ('progress' in facts) {
      const mib = (n: number) => (n / 1048576).toFixed(0)
      return (
        `Reading this machine's Claude Code history for the estimate: ${mib(facts.progress.done)} of ` +
        `${mib(facts.progress.total)} MiB so far. Nothing was sent. Run ${COMMAND} estimate again to go on; it ` +
        'continues where it stopped.'
      )
    }
    const prep = estimateRequest(facts, this.d.clientVersion)
    if ('error' in prep) return estimateError(prep.error)
    const text = this.d.svc.preview('POST', '/diagnostic/estimate', prep.body)
    if (text === null) return estimateError('invalid_body')
    this.previewed = { body: prep.body, text, at: this.d.now() }
    return (
      'This is exactly what the estimate sends: a numbers-only summary of this machine\'s Claude Code history ' +
      '(token and dollar totals per model, dispatch counts per task type, compaction counts, a session-length ' +
      `histogram; no text, paths, names or ids). Nothing was sent.\n${text}\n` +
      (prep.note ? prep.note + '\n' : '') +
      `To send exactly this once and get your savings estimate, run ${COMMAND} estimate send within 30 minutes.`
    )
  }

  // ---------------- served (hidden), offline, the request log
  private async served(rest: string[]): Promise<string> {
    const svc = this.d.svc
    const sub = (rest[0] ?? 'status').toLowerCase()
    try {
      if (sub === 'pin' && rest.length === 3) {
        if (!(await svc.setServedPin(rest[1]!, rest[2]!))) return errorText('store_unavailable')
      } else if (sub === 'unpin' && rest.length === 2) {
        if (!(await svc.setServedPin(rest[1]!, null))) return errorText('store_unavailable')
      } else if (sub === 'channel' && rest.length === 2) {
        if (!(await svc.setServedChannel(rest[1]!.toLowerCase()))) return errorText('store_unavailable')
      } else if (!(sub === 'status' && rest.length <= 1)) return USAGE
    } catch {
      return `Not changed: roles are ${SERVED_ROLES.join(', ')}; channels are ${SERVED_CHANNELS.join(', ')}; a version is like 1.2.0.`
    }
    const s = (await svc.settings()).served
    const pins = Object.entries(s.pins)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k} ${v}`)
    return `Served items: channel ${s.channel}; ${pins.length ? 'pinned: ' + pins.join(', ') : 'no pins'}.`
  }

  private async offline(rest: string[]): Promise<string> {
    const w = (rest[0] ?? '').toLowerCase()
    if (rest.length !== 1 || !['on', 'off'].includes(w)) return USAGE
    if (!(await this.d.svc.setOffline(w === 'on'))) return errorText('store_unavailable')
    return w === 'on'
      ? 'Offline mode is on: agent-services sends nothing and runs on its open defaults.'
      : 'Offline mode is off: agent-services connects again.'
  }

  private async outbox(rest: string[]): Promise<string> {
    const ob = this.d.outbox
    if (!ob) return 'The request log is not available in this session.'
    const day = rest[0] ?? new Date(this.d.now()).toISOString().slice(0, 10)
    const noon = Date.parse(day + 'T12:00:00Z')
    if (rest.length > 1 || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(noon) || new Date(noon).toISOString().slice(0, 10) !== day) {
      return `Usage: ${COMMAND} info log [<YYYY-MM-DD>]`
    }
    const lines: Record<string, unknown>[] = []
    const own = ob.path(noon)
    const fs = this.d.outboxFs
    if (fs) {
      let names: string[] = []
      try {
        names = (await fs.list(ob.dir)).map((e) => e.name).filter((n) => n.startsWith(day + '-') && n.endsWith('.jsonl'))
      } catch {
        names = []
      }
      for (const n of names.sort()) {
        const p = `${ob.dir}/${n}`
        if (p === own) continue
        try {
          for (const l of String(await fs.read(p)).split('\n')) {
            try {
              const v = JSON.parse(l)
              if (isObj(v)) lines.push(v)
            } catch {
              // a partial line
            }
          }
        } catch {
          // gone meanwhile
        }
      }
    }
    lines.push(...ob.lines(noon))
    lines.sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')))
    const head =
      `Request log folder: ${ob.dir} (one file per session and UTC day; every request is logged before it is sent).`
    if (!lines.length) return `${head}\nNo lines for ${day}.`
    const shown = lines.slice(-OUTBOX_SHOW).map(outboxLineText)
    return `${head}\nLast ${shown.length} of ${lines.length} lines for ${day}:\n${shown.join('\n')}`
  }
}

/** One outbox line in one row (already redacted when written; cut to OUTBOX_LINE_CHARS). */
export function outboxLineText(l: Record<string, unknown>): string {
  const parts: string[] = [String(l.ts ?? '')]
  if (l.kind === 'tool') parts.push('tool', String(l.name ?? ''))
  else if (l.kind === 'artifact_publish') parts.push('artifact_publish', String(l.outcome ?? ''))
  else {
    parts.push(String(l.method ?? ''), String(l.route ?? ''), l.status == null ? '-' : String(l.status))
    if (l.preview) parts.push('preview')
    if (l.error) parts.push(String(l.error))
    if (typeof l.body_text === 'string' && l.body_text) parts.push(l.body_text)
  }
  const t = parts.join(' ')
  return t.length > OUTBOX_LINE_CHARS ? t.slice(0, OUTBOX_LINE_CHARS) + '...' : t
}

/** GET /metrics/savings (Savings) as two sentences. */
export function savingsText(b: unknown): string {
  if (!isObj(b) || num(b.days) === null) return errorText('bad_response')
  if (!b.days) return 'No savings yet: they appear once a day or more has been uploaded.'
  const lever = (k: string) => (isObj(b[k]) ? usd(b[k].usd) : '$?')
  return (
    `agent-services saved about ${usd(b.usd)} (${pct(b.pct)} of ${usd(b.api_usd)} at API prices) over ${b.days} ` +
    `day${b.days === 1 ? '' : 's'}` +
    (b.first_day && b.last_day ? ` (${b.first_day} to ${b.last_day})` : '') +
    `: routing ${lever('route')}, compaction ${lever('compact')}, index reads ${lever('index')}.`
  )
}

export function estimateError(code: string | null): string {
  const c = code ?? 'failed'
  return `No estimate: ${ESTIMATE_DETAIL[c] ?? errorText(c)} A failed estimate never undoes the sign-in.`
}

/** The DiagEstimate answer in plain sentences (the Python client's estimate_answer: the server's figures, unchanged). */
export function estimateText(est: unknown): string {
  if (!isObj(est) || !isObj(est.total) || !isObj(est.total.usd)) return estimateError('bad_response')
  const t = est.total.usd
  let biggest: string | null = null
  for (const k of ESTIMATE_LEVERS) {
    const v = isObj(est[k]) && isObj(est[k].usd) ? num(est[k].usd.value) : null
    if (v !== null && (biggest === null || v > (num(est[biggest].usd.value) ?? -Infinity))) biggest = k
  }
  const share = isObj(est.pct) ? ` (about ${pct(est.pct.value)} of the bill)` : ''
  const lines = [
    `Expected monthly saving: ${usd(t.low)} to ${usd(t.high)}, about ${usd(t.value)}${share}.`,
  ]
  if (biggest) lines.push(`The biggest lever is ${LEVER_TEXT[biggest]}.`)
  if (isObj(est.scripts) && isObj(est.scripts.usd)) {
    lines.push(`Scripts are a separate estimate, not in the total: about ${usd(est.scripts.usd.value)} a month.`)
  }
  lines.push('The status line shows the real savings as they accrue.')
  return lines.join(' ')
}

// ------------------------------------------------------------------ the Claude Code adapter

/** Declare /agent-services for this session (call it in session.start, before any slow await). */
export async function declareCommand($: EngineInterface): Promise<void> {
  await $.command.register({ ...COMMAND_SPEC })
  try {
    await $.tool.register(JSON.parse(JSON.stringify(SETUP_SPEC)))
  } catch {
    // the command stands without the setup tool
  }
}

export type EngineOptions = {
  svc: Svc
  outbox?: Outbox | null
  prices?: Prices | null // the shipped price table; without it the estimate has no data
  dailyBody?: (day: string) => Promise<Record<string, unknown>>
  clientVersion?: string
  marketplace?: string
  now?: () => number
  selfUpdates?: () => boolean // false where the engine has no $.process: status then shows the terminal update line
}

/** The command's deps over `$`. */
export function engineDeps($: EngineInterface, o: EngineOptions): CommandDeps {
  const readText = readTextOf($)
  let estimateScan: EstimateScan | null = null
  const fs: ReadFs = {
    list: async (p) => (await $.fs.list(p)).map((e: any) => ({ name: String(e.name), kind: e.kind, size: e.size })),
    read: async (p) => String(await $.fs.read(p)),
  }
  return {
    svc: o.svc,
    store: {
      get: (k) => $.store.get(k),
      set: (k, v) => $.store.set(k, v as any),
      delete: (k) => $.store.delete(k),
      keys: () => $.store.keys(),
    },
    now: o.now ?? (() => Date.now()),
    ask: (question, options) => $.ui.ask(question, options),
    autoUpdate: async () => {
      const d = await engineDirs($)
      return autoUpdateState({
        env: (n) => envOf($, n),
        settings: (source) => ($.settings.read as any)({ source }),
        readText,
        configDir: d.configDir,
      })
    },
    updateLine: async () =>
      ((o.selfUpdates ? o.selfUpdates() : await probeProcess($)) ? null : updateCommand(o.marketplace ?? MARKETPLACE)),
    updateNow: () => applyUpdate($, o.marketplace ?? MARKETPLACE),
    facts: async () => {
      if (!o.prices) return null
      const d = await engineDirs($)
      estimateScan ??= new EstimateScan(fs, o.prices)
      return estimateScan.step(`${d.configDir}/projects`) // a part of a long history per run (fits the hook)
    },
    dailyBody: o.dailyBody,
    clientVersion: o.clientVersion,
    outbox: o.outbox ?? null,
    outboxFs: fs,
    sleep: (ms) => Promise.resolve($.clock.sleep(ms)),
    dashboardUrl: async () => dashboardUrl(readText, await dataDir($)),
    canAsk: () => canAsk(),
    asked: {
      get: async () => askedFrom(await readText(`${await dataDir($)}/services/${ASKED_FILE}`)),
      set: async (ms) => void (await $.fs.write(`${await dataDir($)}/services/${ASKED_FILE}`, JSON.stringify({ at: ms }))),
    },
    bossUrl: async () => dashboardUrl(readText, await dataDir($), 'boss.json'),
    trustFile: {
      path: '~/.claude/CLAUDE.md',
      read: async () => {
        // null only when the file is not there: a file that exists but cannot be read throws, and nothing is written
        const dir = (await engineDirs($)).configDir
        try {
          return String(await $.fs.read(`${dir}/CLAUDE.md`))
        } catch {
          const names = await Promise.resolve($.fs.list(dir)).then((l: any[]) => l.map((e) => String(e.name)), () => null)
          if (names === null || names.includes('CLAUDE.md')) throw new Error('CLAUDE.md cannot be read')
          return null
        }
      },
      write: async (text) => void (await $.fs.write(`${(await engineDirs($)).configDir}/CLAUDE.md`, text)),
      importLine: async () => importLine(await dataDir($), (await engineDirs($)).home),
    },
    dataText: async () => String(await $.fs.read(`${$.plugin.root}/DATA.md`)),
    removeDeps: {
      fs: {
        list: async (p) => (await $.fs.list(p)).map((e: any) => ({ name: String(e.name), kind: e.kind })),
        write: async (p, text) => void (await $.fs.write(p, text)),
      },
      dirs: async () => {
        const own = String((await Promise.resolve($.env.get('CLAUDE_PLUGIN_DATA')).catch(() => '')) ?? '').trim()
        return [await dataDir($), ...(own ? [own.replace(/[\\/]+$/, '')] : [])]
      },
      stopLog: () => o.outbox?.stop(),
    },
  }
}

type On = (event: any, matcher: any, hook: any) => { catch(h: any): unknown }

/** Serve /agent-services: one command.run hook that answers { text } only (no context, no model). `options` is
 * called once, at the first run (the engine lets `$` go only to this file's own functions, so it takes none).
 * `after` (not awaited) runs once the answer is made, with
 * the subcommand word, so the caller can refresh the status line after a sign-in or a sign-out. */
export function serveCommand(
  on: On,
  options: () => EngineOptions | Promise<EngineOptions>,
  after?: (sub: string) => unknown,
): void {
  servedOptions = options
  servedAfter = after ?? null
  servedCmd = null // a new registration (a reload) builds its own
  // the setup tool: the model applies the user's answers to the setup questions (no other subcommand)
  on('tool.describe', { tool: `mcp__${COMMAND_NAME}__${SETUP_SPEC.name}` }, async ($: EngineInterface, e: any, next: any) => ({
    ...(await next(e)),
    isDeferred: false,
  })).catch(($: EngineInterface, e: any, next: any) => next(e))
  on('tool.call', { tool: `mcp__${COMMAND_NAME}__${SETUP_SPEC.name}` }, async ($: EngineInterface, e: { command?: unknown; agentId?: unknown }) => {
    const c = String(e?.command ?? '')
    if (!SETUP_COMMANDS.includes(c) && !SETUP_ALIASES.includes(c)) {
      return { result: `Unknown setup command; use one of: ${SETUP_COMMANDS.join(', ')}.` }
    }
    // a change applies the user's own answer: only in the main conversation of a session someone can be asked in
    if (!['sharing preview', 'methods preview', 'methods diff', 'info data', 'info hooks', 'savings preview',
      'trust preview', 'trust diff', 'data', 'hooks'].includes(c) &&
      (e?.agentId || !canAsk())) {
      return { result: `"${c}" applies the user's own answer, so it runs only in the main conversation of a session ` +
        `the user is at; nothing was changed. The user can type ${COMMAND} ${c} themselves.` }
    }
    const text = await (await servedCommand($)).run(c)
    void Promise.resolve(after?.(c.split(' ')[0]!)).catch(() => undefined)
    return { result: text }
  }).catch(($: EngineInterface, e: any, next: any) => ({
    result:
      next?.error?.kind === 'timeout'
        ? `The setup took too long; try again, or run ${COMMAND} status.`
        : `The setup failed; try ${COMMAND} status.`,
  }))
  on('command.run', { command: COMMAND_NAME }, async ($: EngineInterface, e: { args?: string }) => {
    const args = String(e?.args ?? '')
    const text = await (await servedCommand($)).run(args)
    try {
      void Promise.resolve(after?.(args.trim().split(/\s+/)[0]?.toLowerCase() || 'status')).catch(() => undefined)
    } catch {
      // the answer stands
    }
    // a sign-in or a sign-out: the methods file follows it
    if (/^(login|code|logout)\b/i.test(args.trim())) void syncMethodsNow()
    // the engine already shows a hook's answer under the plugin's name: drop the answer's own leading label
    return { text: text.replace(/^agent-services: /, '') }
  }).catch(() => ({ text: `the command failed; try ${COMMAND} status.` }))
}

// serveCommand's one Command, shared with onboardingNote: the engine refuses a kept return value of a function that
// takes `on`, and lets `$` go only to functions declared at the top of a file
let servedOptions: (() => EngineOptions | Promise<EngineOptions>) | null = null
let servedCmd: Command | null = null
let servedAfter: ((sub: string) => unknown) | null = null
let prompted: string | null = null // the session whose first prompt has been seen

async function servedCommand($: EngineInterface): Promise<Command> {
  if (!servedOptions) throw new Error('the command is not served')
  if (!servedCmd) servedCmd = new Command(engineDeps($, await servedOptions()))
  return servedCmd
}

/** The toast that says a pasted code was taken (best effort; the drop reason says it too). */
function tookCode($: EngineInterface): void {
  try {
    $.ui.toast(PASTED_TAKEN)
  } catch {
    // the drop reason stands
  }
}

/** prompt.submit: the answer when the message is a pasted sign-in code (Command.pasted), else null. */
export async function pastedCode(
  $: EngineInterface,
  e: { text?: unknown; agentId?: unknown; origin?: { kind?: unknown } | null; attachments?: unknown },
): Promise<string | null> {
  // only what the person typed in the main conversation, with nothing attached; read here and never sent
  if (e?.agentId || e?.origin?.kind !== 'composer' || (Array.isArray(e?.attachments) && e.attachments.length)) return null
  const text = e?.text
  if (!servedOptions || typeof text !== 'string' || text.length > 40) return null
  if (!PASTED_CODE_RX.test(cleanCode(text))) return null // most messages: nothing is built or read
  try {
    const answer = await (await servedCommand($)).pasted(text)
    if (answer === null) return null // no sign-in waits: an ordinary message
    if (answer.startsWith('Signed in')) {
      void Promise.resolve(servedAfter?.('login')).catch(() => undefined)
      void syncMethodsNow() // the setup questions come with a later prompt (promptNote)
    }
    tookCode($)
    return `${PASTED_TAKEN}
${answer.replace(/^agent-services: /, '')}`
  } catch {
    tookCode($)
    return `${PASTED_TAKEN}
${PASTED_FAILED}` // a code-shaped message is never forwarded once the sign-in path started
  }
}

/** The note for this prompt (Command.promptNote): the company's choice once, the setup questions, and from the
 * session's second prompt on a newer version or changed methods; null when there is none. */
export async function onboardingNote($: EngineInterface): Promise<string | null> {
  try {
    if (!servedOptions) return null
    const cmd = await servedCommand($)
    const session = String(await $.session.id())
    const first = prompted !== session
    prompted = session
    const note = await cmd.promptNote(first, () => takeUpdateNote($), async () => (await methodsNotes($)).pending)
    if (note?.which === 'pending') methodsNoted()
    return note?.text ?? null
  } catch {
    return null
  }
}
