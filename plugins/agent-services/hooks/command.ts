// The /agent-services slash command (plan 3.4, 3.6, 3.9): a port of the host/services.py CLI behind
// plugin/commands/agent-services.md, answered by the hooks module itself.
//
// - $.command.register declares the command; a command.run hook answers it with { text } only: no model, no Bash,
//   no Python and no `context` field, so neither the sign-in code nor an answer enters the model's context.
// - The sign-in code is never taken from the command line: typed command arguments are written to prompt history
//   (M0a). `login` asks for the email (unless given; an email is not a secret), mails the code, then asks for the
//   code in the engine's own question dialog ($.ui.ask). `code` finishes a sign-in started in any session within
//   10 minutes, again asking in the dialog; an argument that is not an email is refused, never used.
// - While auth has failed (3.9) only status, login, code and logout work; every other subcommand answers the one
//   sign-in line and sends nothing.
// - The shipped build has no staging subcommand to set an endpoint: the endpoint and keys are the svc channel's
//   built-in DEFAULT_CONFIG, and nothing here reads an endpoint or key from the store.
// - Nothing is written to $.ui.log; every answer goes through redact() (redact.ts).
// - estimate keeps preview-then-send: `estimate` (or `estimate preview`) shows the exact body and sends nothing;
//   `estimate send` sends exactly the body previewed in this session (kept in memory for 30 minutes), once.
// - status shows the auto-update setup state, read only (a port of host/auto_update.py; the plugin never writes the
//   user's settings), and the terminal update line where the engine has no $.process (plan 3.8).
// - One plain choice, the savings record (board, weekly email, daily upload together; SHARING_QUESTION), is asked at
//   most once per session: by the model at the first prompt (onboarding note and the setup tool), or in the engine's
//   dialog right after a sign-in or at status. "Not now" holds for 7 days. The board consent alone is asked only
//   when the record is on but the board was snoozed on its own. status shows where it stands.
//
// The Command class is harness-neutral (its deps are injected); the functions at the end are the Claude Code
// adapter over `$`.
import type { EngineInterface } from 'claude-code'
import { estimateRequest } from './estimate'
import { BodyTooLarge, DAILY_ROUTE, optIn, READ_LIMIT } from './metrics'
import type { MetricsState } from './metrics'
import { plusDays } from './pyfmt'
import { Scanner, walkOrder } from './transcripts'
import type { Facts, Prices, TranscriptFile } from './transcripts'
import type { Outbox } from './outbox'
import { redact } from './redact'
import { updateCommand } from './status'
import { probeProcess, selfUpdateLine } from './update'
import { KEYS, safeGet, safeSet } from './store'
import type { KV } from './store'
import { gateNotice, LOCKED_LINE, NOTICE_TEXT, PAUSED_LINE, PLAN_NOTICE, SERVED_CHANNELS, SERVED_ROLES } from './svc'
import type { Result, Svc } from './svc'
import { askConsent, claimAsk, CONSENT_KEY, CONSENT_SNOOZE_MS, consentState, dashboardUrl, readConsent, sharingState } from './consent'
import { dataDir, engineDirs, envOf, readTextOf } from './engine_env'
import { companyCommand } from './boss'
import { hasTrust, TRUST_HEADER, TRUST_KEY, TRUST_OPTIONS, TRUST_QUESTION, TRUST_TEXT, type TrustFile, withoutTrust,
  withTrust } from './trust'
import { ORG_PAUSED_LINE, ORG_SAVINGS_TEXT, ORG_SET_TEXT, orgChoice, orgNotice, sharingQuestion } from './org'

export {
  askConsent,
  CONSENT_HEADER,
  CONSENT_KEY,
  CONSENT_OPTIONS,
  CONSENT_QUESTION,
  CONSENT_SNOOZE_MS,
  consentState,
  dashboardUrl,
  readConsent,
  resetConsentAsk,
  sharingState,
} from './consent'
export type { Consent, ConsentState } from './consent'
export { claudeHashOf, dataDir, engineClaudeHash, engineDirs } from './engine_env'

// ------------------------------------------------------------------ constants

export const COMMAND_NAME = 'agent-services'
export const COMMAND = '/' + COMMAND_NAME
export const COMMAND_SPEC = {
  name: COMMAND_NAME,
  description: 'Sign in to agent-services, show its status, or sign out',
  argumentHint:
    '[status | login [<email>] | code | logout | sharing [on | not_now | preview] | savings [preview | on | off | ' +
    'status | mail on | mail off] | ' +
    'estimate [preview | send] | served [pin <role> <version> | unpin <role> | channel <name>] | offline on|off | ' +
    'trust [on | off | not_now | preview] | outbox [<day>]]',
} as const

/** The subcommands that work while auth has failed (plan 3.9 item 4). */
export const AUTH_FAIL_COMMANDS = ['status', 'login', 'code', 'logout']
export const ASK_HEADER = 'Sign-in'
export const EMAIL_QUESTION = 'Which email address is your agent-services account under?'
export const EMAIL_CANCEL = ['Cancel sign-in', 'Not now']
export const CODE_CANCEL = ['Enter it later', 'Cancel sign-in']
export const ESTIMATE_PREVIEW_MS = 30 * 60000 // a preview stays sendable this long, in this session only
export const STATUS_HELLO_MS = 4000 // status waits this long at most for a hello
export const OUTBOX_SHOW = 10 // outbox lines shown
export const OUTBOX_LINE_CHARS = 300
export const METRICS_STATE_KEY = 'metrics_state' // { previewed_day, enabled_day, last_uploaded_day } (host/metrics.py state)

export const SAVINGS_PROMPT_KEY = 'savings_prompt' // { answer: 'not_now', at }: the savings question's "Not now"
// The one plain choice (2026-10-31): the savings record is the board (a private Artifact),
// the weekly email and the daily numbers-only upload together. One answer sets all three (store key KEYS.sharing);
// each part keeps its own subcommand for finer control (savings off, savings mail off, dashboard not_now). "Not now"
// is asked again after CONSENT_SNOOZE_MS.
export const SHARING_QUESTION =
  'Keep a record of what agent-services saves you? It shows your savings on a private page in your claude.ai ' +
  'account (only you can see it), emails you a weekly total, and uploads a small daily summary of numbers only ' +
  '(never your prompts, files or code).'
export const SHARING_OPTIONS = ['Turn on (Recommended)', 'Not now', 'Show me what is sent']
export const SHARING_HEADER = 'Savings'
// The tool the model calls with the user's answer to the first-prompt setup question (onboarding below); it runs the
// same subcommands as the slash command, limited to these (the first three answer the one question).
export const SETUP_COMMANDS = [
  'sharing on',
  'sharing not_now',
  'sharing preview',
  'savings preview',
  'savings on',
  'savings not_now',
  'dashboard allow',
  'dashboard not_now',
  'trust on',
  'trust not_now',
  'trust preview',
]
export const SETUP_SPEC = {
  name: 'setup',
  description:
    "Apply the user's answer to the agent-services setup question. \"sharing on\" turns the savings record on: a " +
    "private Artifact page on the user's own claude.ai account (only they see it unless they share it), a weekly " +
    'savings email, and one small daily usage summary (counts and token totals, never prompts, file contents or ' +
    'paths). "sharing not_now" turns all three off; "sharing preview" shows what is sent and changes nothing. The ' +
    'other commands change one part only. "trust on" adds one short section to the user\'s CLAUDE.md that ' +
    'makes the served working methods their own instructions ("trust preview" shows it, "trust not_now" leaves ' +
    'it out). Only call it with an answer the user gave.',
  inputSchema: {
    type: 'object',
    properties: { command: { type: 'string', enum: SETUP_COMMANDS } },
    required: ['command'],
    additionalProperties: false,
  },
  isDeferred: false,
} as const

// host/auto_update.py
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

// host/services.py estimate_answer and ESTIMATE_DETAIL
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
  `Usage: ${COMMAND} [status | login [<email>] | code | logout | savings [preview | on | off | not_now | status | ` +
  'mail on | mail off] | sharing [on | not_now | preview] | dashboard [allow | not_now] | estimate [preview | send] | served [status | ' +
  'pin <role> <version> | unpin <role> | channel <name>] | offline on|off | trust [on | off | not_now | preview] | ' +
  'outbox [<day>]]'

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
  updateLine?: () => Promise<string | null> // the terminal update line, or null where self-update runs
  facts?: () => Promise<Facts | ScanProgress | null> // the estimate's scan of this machine's history (EstimateScan);
  // null when there is none
  dailyBody?: (day: string) => Promise<Record<string, unknown>> // one day's POST /metrics/daily body (may throw)
  clientVersion?: string // the plugin's release version (the export's shell stamp), for the estimate body
  outbox?: Outbox | null
  outboxFs?: ReadFs | null
  sleep?: (ms: number) => Promise<unknown> // bounds the status hello (the command hook has about 10 s in all)
  dashboardUrl?: () => Promise<string | null> // the published dashboard's artifact URL, for status
  bossUrl?: () => Promise<string | null> // O5: the published company board's artifact URL (company admins)
  trustFile?: TrustFile | null // the user-level CLAUDE.md (trust.ts)
}

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** The local calendar day of a ms time, as host/metrics.py _today. */
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
// The mailed sign-in code is 8 digits (6 to 8 taken). Owner 2026-11-01: after login the person pastes
// it as their next message (the dialog put typing last, under Other); prompt.submit catches it before the model.
export const PASTED_CODE_RX = /^[0-9]{6,8}$/
// prompt.submit has a time budget and forwards the message when a hook runs past it: the pasted path answers by then
export const PASTED_WAIT_MS = 6_000
export const PASTED_SLOW = `The sign-in is still being checked. Run ${COMMAND} status in a moment to see whether it finished.`
export const PASTED_FAILED = `The sign-in did not finish. Enter the code with ${COMMAND} code.`
export const PASTE_CODE_LINE =
  'Paste the 8-digit code from that email here as your next message. It goes to agent-services only, not to ' +
  `Claude, and works for 10 minutes. (Or run ${COMMAND} code.)`

// ------------------------------------------------------------------ auto-update (host/auto_update.py, read only)

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
 * sets one), the menu step cannot help: `updateLine` null means this plugin updates itself, else it is the manual
 * update command, given instead of the steps. */
export function autoUpdateText(a: AutoUpdate | null, updateLine: string | null = null): string | null {
  if (!a) return null
  if (a.on) return 'Auto-update: on.'
  if (a.source === 'env') {
    return updateLine === null
      ? "Auto-update: Claude Code's own plugin updates are off here (an environment variable); this plugin updates " +
          'itself instead.'
      : "Auto-update: Claude Code's own plugin updates are off here (an environment variable). To update the " +
          `plugin, run this in a terminal: ${updateLine}`
  }
  return (
    `Auto-update: off. One setup step is left: auto-update is how this plugin receives fixes and new services ` +
    'without a reinstall, from the next session on. 1. Run /plugin, open Marketplaces and select agent-plugin. ' +
    '2. Choose Enable auto-update. (Or set "autoUpdate": true on the agent-plugin entry under ' +
    'extraKnownMarketplaces in your settings.) This plugin never changes your settings itself.'
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

/** Every *.jsonl under `root`, read, in os.walk order (see listTranscripts and readTranscript). */
export async function collectTranscripts(fs: ReadFs, root: string): Promise<TranscriptFile[] | null> {
  const listed = await listTranscripts(fs, root)
  if (!listed) return null
  const base = root.replace(/[\\/]+$/, '')
  const out: TranscriptFile[] = []
  for (const f of listed) out.push(await readTranscript(fs, base, f))
  return out
}

export type ScanProgress = { progress: { done: number; total: number } } // bytes of readable transcripts

/**
 * The estimate's scan of every transcript, spread over runs of the command. A hook has 10 s of its own time, where
 * the reads are free and the parse is not; a long history takes longer (measured 11.8 s for 2.1 GB on the owner's
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

  constructor(deps: CommandDeps) {
    this.d = deps
  }

  /** One run of /agent-services <args>; always answers a text, already redacted. */
  async run(args: string): Promise<string> {
    let text: string
    try {
      text = await this.dispatch(String(args ?? '').trim())
    } catch {
      text = `agent-services: the command failed; try ${COMMAND} status.`
    }
    return redact(text)
  }

  private async dispatch(args: string): Promise<string> {
    const words = args ? args.split(/\s+/) : []
    const sub = (words[0] ?? 'status').toLowerCase()
    const rest = words.slice(1)
    const svc = this.d.svc
    const known = ['status', 'login', 'code', 'logout', 'sharing', 'savings', 'dashboard', 'estimate', 'served',
      'offline', 'outbox', 'company', 'trust']
    if (!known.includes(sub)) return `Unknown subcommand "${sub.slice(0, 40)}". ${USAGE}`
    if (!AUTH_FAIL_COMMANDS.includes(sub)) {
      const st = await svc.authState(true)
      // 3.9: nothing else works, nothing is sent
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
      case 'sharing':
        return this.sharing(rest)
      case 'savings':
        return this.savings(rest)
      case 'dashboard':
        return this.dashboard(rest)
      case 'estimate':
        return this.estimate(rest)
      case 'served':
        return this.served(rest)
      case 'offline':
        return this.offline(rest)
      case 'trust':
        return this.trust(rest)
      case 'company': // O5: the company admin's board and weekly summary email
        return companyCommand({ svc, store: this.d.store, url: () => this.d.bossUrl?.() ?? Promise.resolve(null) }, rest)
      default:
        return this.outbox(rest)
    }
  }

  // ---------------- status
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
      const org = await orgChoice(this.d.store) // O3: the company's choice, shown instead of the question
      if (org) {
        lines.push(ORG_SAVINGS_TEXT[org]!)
        await orgNotice(this.d.store) // said here, so the one-time line is not said again
      }
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
    const su = selfUpdateLine()
    if (su) lines.push(su)
    if (auth === 'ok') lines.push(await this.dashboardLine())
    return lines.join('\n')
  }

  private async dashboard(rest: string[]): Promise<string> {
    const sub = (rest[0] ?? '').toLowerCase()
    if (rest.length === 0) return this.dashboardLine()
    if (rest.length !== 1 || (sub !== 'allow' && sub !== 'not_now')) return USAGE
    if (await orgChoice(this.d.store)) return ORG_SET_TEXT
    await safeSet(this.d.store, CONSENT_KEY, { answer: sub, at: this.d.now() })
    return sub === 'allow'
      ? 'The dashboard is allowed: it is published as a private Artifact when Claude finishes this reply, and kept ' +
        'up to date.'
      : 'The dashboard stays unpublished; you are asked again in 7 days.'
  }

  /** Whether the one savings-record question is due: never answered (or its "Not now" has run out) and the board
   * not allowed or snoozed on its own. An earlier board "allow" means the record is already set up. */
  private async sharingDue(): Promise<boolean> {
    const now = this.d.now()
    if (await orgChoice(this.d.store)) return false // O3: the company chose for everyone
    if ((await sharingState(this.d.store, now)) !== 'ask') return false
    return consentState(await readConsent(this.d.store), now) === 'ask'
  }

  /** The note the model gets with the session's first prompt while the savings record is not set up: ask the user
   * the one question (the question tool), then apply the answer with the setup tool. null: nothing to ask. */
  async onboarding(): Promise<string | null> {
    if ((await this.d.svc.authState()) !== 'ok') return null
    const told = await orgNotice(this.d.store) // O3: the company's choice, said once
    if (told) {
      return (
        '[agent-services plugin note, not written by the user] Before working on the message, tell the user this ' +
        `one line from the agent-services plugin, in these words: "${told}" Then go on with the message.`
      )
    }
    const tool = 'mcp__agent-services__setup'
    if (!(await this.sharingDue())) {
      if (!(await this.safe(() => this.trustDue(), false))) return null
      const [add, later, show] = TRUST_OPTIONS
      return (
        '[agent-services plugin note, not written by the user] Before working on the message, ask the user this one ' +
        `question with your question tool (AskUserQuestion), header "${TRUST_HEADER}", in these words: ` +
        `"${TRUST_QUESTION}" with the options, in this order, "${add}", "${later}" and "${show}". Then call ${tool} ` +
        `with command "trust on", "trust not_now" or "trust preview" to match the answer; for "${show}" show the ` +
        'user the text it returns, and call it with "trust on" only if the user then says yes. Do not edit CLAUDE.md ' +
        'yourself. If the user dismisses the question, leave it. Then go on with the message.'
      )
    }
    const question = await sharingQuestion(this.d.store, SHARING_QUESTION)
    const [on, off, show] = SHARING_OPTIONS
    return (
      '[agent-services plugin note, not written by the user] The user has the agent-services plugin installed and ' +
      'its savings record is not set up yet. Before working on the message, ask the user this one question with ' +
      `your question tool (AskUserQuestion), header "${SHARING_HEADER}", in these words: "${question}" ` +
      `with the options, in this order, "${on}", "${off}" and "${show}". Then call ${tool} with command ` +
      `"sharing on", "sharing not_now" or "sharing preview" to match the answer; for "${show}" show the user the ` +
      'text it returns, and call it with "sharing on" only if the user then says yes. If the user dismisses the ' +
      'question, leave it. Then go on with the message.'
    )
  }

  // ---------------- the CLAUDE.md section (trust.ts)
  /** Due while the section is not there, never answered, or its "Not now" has run out; "off" is final. */
  private async trustDue(): Promise<boolean> {
    const f = this.d.trustFile
    if (!f) return false
    const c = (await this.d.store.get(TRUST_KEY)) as { answer?: unknown; at?: unknown } | null | undefined
    if (c?.answer === 'on' || c?.answer === 'off') return false
    if (c?.answer === 'not_now' && this.d.now() - Number(c.at ?? 0) < CONSENT_SNOOZE_MS) return false
    return !hasTrust(await f.read())
  }

  private async trust(rest: string[]): Promise<string> {
    const sub = (rest[0] ?? 'status').toLowerCase()
    const f = this.d.trustFile
    if (rest.length > 1) return USAGE
    if (sub === 'preview') return `This section would be added to the end of your CLAUDE.md:\n\n${TRUST_TEXT}`
    if (!f) return 'Your CLAUDE.md cannot be reached from here; nothing was changed.'
    const now = this.d.now()
    const text = await f.read()
    if (sub === 'status') {
      return hasTrust(text)
        ? `Your CLAUDE.md (${f.path}) makes the served working methods your own instructions. Remove it with ` +
            `${COMMAND} trust off.`
        : `Your CLAUDE.md has no agent-services section. Add it with ${COMMAND} trust on (${COMMAND} trust preview ` +
            'shows it).'
    }
    if (sub === 'not_now') {
      await safeSet(this.d.store, TRUST_KEY, { answer: 'not_now', at: now })
      return `Nothing was added to your CLAUDE.md. You are asked again in 7 days; add it any time with ${COMMAND} trust on.`
    }
    if (sub !== 'on' && sub !== 'off') return USAGE
    const next = sub === 'on' ? withTrust(text) : text === null ? null : withoutTrust(text)
    if (next !== null && next !== text) await f.write(next)
    await safeSet(this.d.store, TRUST_KEY, { answer: sub, at: now })
    return sub === 'on'
      ? `Added the agent-services section to ${f.path}: from the next session on, the served working methods count ` +
          `as your own instructions. Remove it with ${COMMAND} trust off.`
      : `Removed the agent-services section from ${f.path}; you are not asked again. Add it back with ${COMMAND} trust on.`
  }

  // ---------------- the one savings-record choice
  private async sharing(rest: string[]): Promise<string> {
    const sub = (rest[0] ?? '').toLowerCase()
    if (rest.length !== 1) return USAGE
    if (sub !== 'preview' && (await orgChoice(this.d.store))) return ORG_SET_TEXT
    if (sub === 'on') return this.setSharing(true)
    if (sub === 'not_now' || sub === 'off') return this.setSharing(false)
    if (sub === 'preview') return this.sharingPreview()
    return USAGE
  }

  /** One answer for the board, the weekly email and the daily upload. The email is a server setting, changed while
   * the upload is on (the route is a metrics route); a failed change is said, the other parts stand. */
  private async setSharing(on: boolean): Promise<string> {
    const svc = this.d.svc
    const at = this.d.now()
    const mail = async (): Promise<string | null> => {
      const r = await svc.call('POST', '/metrics/weekly-mail', { on })
      return r.ok ? null : errorText(r.error)
    }
    let mailError: string | null = null
    if (!on) mailError = await mail()
    const kept =
      (await safeSet(this.d.store, KEYS.sharing, { on, at })) &&
      (await svc.setService('metrics', on)) &&
      (await safeSet(this.d.store, CONSENT_KEY, { answer: on ? 'allow' : 'not_now', at }))
    if (!kept) return errorText('store_unavailable')
    if (on) mailError = await mail()
    const mailLine = mailError
      ? `\nThe weekly email setting was not changed: ${mailError} Run ${COMMAND} savings mail ${on ? 'on' : 'off'} ` +
        'later to change it.'
      : ''
    return on
      ? 'Savings record is on: your private savings page is published to your claude.ai account when Claude ' +
          'finishes this reply, a weekly email sums up the savings, and a small daily summary of numbers is uploaded. ' +
          `To turn one part off: ${COMMAND} dashboard not_now (the page), ${COMMAND} savings mail off (the email), ` +
          `${COMMAND} savings off (the upload).` +
          mailLine
      : 'Savings record is off: no page is published, no weekly email is sent and nothing more is uploaded. You are ' +
          `asked again in 7 days; turn it on any time with ${COMMAND} sharing on.` +
          mailLine
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
      } catch {
        // the description below stands
      }
    }
    return (
      'Nothing was turned on. The savings record has three parts:\n' +
      "- A private page on your own claude.ai account (only you can see it unless you share it): savings, counts, " +
      'plan and service state, numbers only.\n' +
      '- A weekly email to your account address with the week\'s savings.\n' +
      `- ${upload}\n` +
      `Turn it on with ${COMMAND} sharing on, or leave it off with ${COMMAND} sharing not_now.`
    )
  }

  /** Ask the one question in the engine's dialog (once per session, shared with askConsent); the answer is applied.
   * null when not asked or not answered. */
  private async askSharing(): Promise<string | null> {
    if (!this.d.ask || !claimAsk()) return null
    let a: string
    try {
      const q = await sharingQuestion(this.d.store, SHARING_QUESTION)
      a = String(await this.d.ask(q, { options: SHARING_OPTIONS, header: SHARING_HEADER })).trim()
    } catch {
      return null
    }
    if (a === SHARING_OPTIONS[0]) return this.setSharing(true)
    if (a === SHARING_OPTIONS[1]) return this.setSharing(false)
    if (a === SHARING_OPTIONS[2]) return this.sharingPreview()
    return null
  }

  private async dashboardLine(): Promise<string> {
    if ((await orgChoice(this.d.store)) === 'off') return 'Dashboard: off, set by your company.' // O3
    let state = consentState(await readConsent(this.d.store), this.d.now())
    let asked: string | null = null
    if (state === 'ask') {
      // the person is here (a command runs): ask now, once per session; the one question while it is due
      if (await this.sharingDue()) asked = await this.safe(() => this.askSharing(), null)
      else await this.safe(() => askConsent(this.d.store, this.d.ask, this.d.now), null)
      state = consentState(await readConsent(this.d.store), this.d.now())
    }
    const head = asked ? asked + '\n' : ''
    return head + (await this.dashboardState(state))
  }

  private async dashboardState(state: ConsentState): Promise<string> {
    if (state === 'not_now') return 'Dashboard: you chose Not now.'
    if (state === 'ask') return 'Dashboard: not allowed yet (run /agent-services status to be asked).'
    const url = await this.safe(() => this.d.dashboardUrl?.() ?? Promise.resolve(null), null)
    if (url) return `Dashboard: published at ${url}.`
    return 'Dashboard: allowed, not published yet (it is published when Claude finishes its next reply).'
  }

  private async safe<T>(f: () => Promise<T>, dflt: T): Promise<T> {
    try {
      return await f()
    } catch {
      return dflt
    }
  }

  // ---------------- sign-in (3.4)
  /** Asks in the dialog; null when dismissed, unanswerable or one of the cancel labels was picked. */
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

  /** Send the code and, once signed in, the after-sign-in lines and the one setup question. */
  private async complete(email: string, code: string, head: string, ask = true): Promise<string> {
    const r = await this.d.svc.loginFinish(email, code)
    if (!r.ok) return head + `Sign-in failed: ${errorText(r.error)}`
    const st = await this.d.svc.status()
    const lines = [head + `Signed in (account ${st.account_id ?? '?'}, plan ${st.plan ?? 'unknown'}). agent-services is on.`]
    const au = await this.safe(() => this.d.autoUpdate?.() ?? Promise.resolve(null), null)
    if (au && !au.on) {
      const up = au.source === 'env' ? await this.safe(() => this.d.updateLine?.() ?? Promise.resolve(null), null) : null
      lines.push(autoUpdateText(au, up)!)
    }
    lines.push(`To see what this plugin can save you, run ${COMMAND} estimate (it shows what it would send first).`)
    // the one savings-record question (or the board alone), while not answered yet (or "Not now" has run out)
    if (!ask) {
      if (await this.safe(() => this.sharingDue(), false)) lines.push(`Run ${COMMAND} status to answer the one setup question.`)
    } else if (await this.sharingDue()) {
      const asked = await this.safe(() => this.askSharing(), null)
      if (asked) lines.push(asked)
    } else if (consentState(await readConsent(this.d.store), this.d.now()) === 'ask') {
      await this.safe(() => askConsent(this.d.store, this.d.ask, this.d.now), null)
    }
    return lines.join('\n')
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

  // ---------------- savings (host/metrics.py local_route)
  private async metricsState(): Promise<MetricsState> {
    const s = await safeGet(this.d.store, METRICS_STATE_KEY)
    const day = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null)
    return {
      previewed_day: day(isObj(s) ? s.previewed_day : null),
      enabled_day: day(isObj(s) ? s.enabled_day : null),
      last_uploaded_day: day(isObj(s) ? s.last_uploaded_day : null),
    }
  }

  private async saveMetrics(changes: Partial<MetricsState>): Promise<boolean> {
    return safeSet(this.d.store, METRICS_STATE_KEY, { ...(await this.metricsState()), ...changes })
  }

  private async savings(rest: string[]): Promise<string> {
    const svc = this.d.svc
    const sub = (rest[0] ?? 'show').toLowerCase()
    const on = Boolean((await svc.settings()).services.metrics)
    if (['on', 'off', 'not_now', 'mail'].includes(sub) && (await orgChoice(this.d.store))) return ORG_SET_TEXT // O3
    if (sub === 'show' && rest.length <= 1) {
      if (!on) {
        return (
          'Savings are worked out by the service from a daily usage summary, and that upload is turned off on this ' +
          `machine. Run ${COMMAND} savings preview to see exactly what one upload sends, then ${COMMAND} ` +
          'savings on.'
        )
      }
      const r = await svc.call('GET', '/metrics/savings')
      return r.ok ? savingsText(r.body) : `Savings could not be read: ${errorText(r.error)}`
    }
    if (sub === 'status' && rest.length === 1) {
      const s = await this.metricsState()
      return (
        `Daily usage upload: ${on ? 'on' : 'off'}.` +
        (s.enabled_day ? ` Turned on ${s.enabled_day}.` : '') +
        (s.last_uploaded_day ? ` Uploaded through ${s.last_uploaded_day}.` : '') +
        (s.previewed_day ? ` Last preview: ${s.previewed_day}.` : ' No preview yet.')
      )
    }
    if (sub === 'preview' && rest.length === 1) {
      if (!this.d.dailyBody) return 'The daily usage summary is not available in this build.'
      const day = plusDays(localDay(this.d.now()), -1)
      let body: Record<string, unknown>
      try {
        body = await this.d.dailyBody(day)
      } catch (e) {
        return e instanceof BodyTooLarge
          ? `The summary for ${day} is too large to upload.`
          : 'The daily usage summary could not be built in time on this machine. It holds numbers only: token ' +
              'counts and costs per model, task types per hashed project, session counts and savings; never ' +
              'prompts, file contents or paths.'
      }
      const text = svc.preview('POST', DAILY_ROUTE, body)
      if (text === null) return 'The daily usage summary could not be built.'
      await this.saveMetrics({ previewed_day: day })
      return (
        `This is exactly what one daily upload sends (for ${day}); nothing was sent: ${dailySummary(body)}\n${text}\n` +
        `Turn the upload on with ${COMMAND} savings on.`
      )
    }
    if (sub === 'on' && rest.length === 1) {
      const r = optIn(await this.metricsState(), localDay(this.d.now()))
      if (!r.ok) return `First see what would be uploaded: run ${COMMAND} savings preview, then ${COMMAND} savings on.`
      if (!(await svc.setService('metrics', true))) return errorText('store_unavailable')
      await this.saveMetrics({ enabled_day: r.state.enabled_day })
      return 'The daily usage upload is on. Savings appear once a day or more has been uploaded.'
    }
    if (sub === 'not_now' && rest.length === 1) {
      await safeSet(this.d.store, SAVINGS_PROMPT_KEY, { answer: 'not_now', at: this.d.now() })
      if (!(await svc.setService('metrics', false))) return errorText('store_unavailable')
      return `The daily usage upload is off: nothing more is uploaded. Turn it back on with ${COMMAND} savings on.`
    }
    if (sub === 'off' && rest.length === 1) {
      if (!(await svc.setService('metrics', false))) return errorText('store_unavailable')
      return `The daily usage upload is off: nothing more is uploaded. Turn it back on with ${COMMAND} savings on.`
    }
    if (sub === 'mail' && rest.length === 2 && ['on', 'off'].includes(rest[1]!.toLowerCase())) {
      const want = rest[1]!.toLowerCase() === 'on'
      const r = await svc.call('POST', '/metrics/weekly-mail', { on: want })
      if (!r.ok) return `The weekly savings email setting was not changed: ${errorText(r.error)}`
      const now = isObj(r.body) && typeof r.body.on === 'boolean' ? r.body.on : want
      return now
        ? 'The weekly savings email will be sent again. (This changes only the email, not the usage upload.)'
        : 'The weekly savings email is stopped. (This changes only the email, not the usage upload.)'
    }
    return USAGE
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

  // ---------------- served, offline, outbox
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
      return `Usage: ${COMMAND} outbox [<YYYY-MM-DD>]`
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

/** The DiagEstimate answer in plain sentences (host/services.py estimate_answer: the server's figures, unchanged). */
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
  prices?: Prices | null // the shipped prices (modules/usage/prices.json); without them the estimate has no data
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
    bossUrl: async () => dashboardUrl(readText, await dataDir($), 'boss.json'),
    trustFile: {
      path: '~/.claude/CLAUDE.md',
      read: async () => readText(`${(await engineDirs($)).configDir}/CLAUDE.md`),
      write: async (text) => void (await $.fs.write(`${(await engineDirs($)).configDir}/CLAUDE.md`, text)),
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
  // the setup tool: the model applies the user's answers to the onboarding question (no other subcommand)
  on('tool.describe', { tool: `mcp__${COMMAND_NAME}__${SETUP_SPEC.name}` }, async ($: EngineInterface, e: any, next: any) => ({
    ...(await next(e)),
    isDeferred: false,
  })).catch(($: EngineInterface, e: any, next: any) => next(e))
  on('tool.call', { tool: `mcp__${COMMAND_NAME}__${SETUP_SPEC.name}` }, async ($: EngineInterface, e: { command?: unknown }) => {
    const c = String(e?.command ?? '')
    if (!SETUP_COMMANDS.includes(c)) return { result: `Unknown setup command; use one of: ${SETUP_COMMANDS.join(', ')}.` }
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
    // the engine already shows a hook's answer under the plugin's name: drop the answer's own leading label
    return { text: text.replace(/^agent-services: /, '') }
  }).catch(() => ({ text: `the command failed; try ${COMMAND} status.` }))
}

// serveCommand's one Command, shared with onboardingNote: the engine refuses a kept return value of a function that
// takes `on`, and lets `$` go only to functions declared at the top of a file
let servedOptions: (() => EngineOptions | Promise<EngineOptions>) | null = null
let servedCmd: Command | null = null
let servedAfter: ((sub: string) => unknown) | null = null
let onboarded: string | null = null // the session the onboarding note went to

async function servedCommand($: EngineInterface): Promise<Command> {
  if (!servedOptions) throw new Error('the command is not served')
  if (!servedCmd) servedCmd = new Command(engineDeps($, await servedOptions()))
  return servedCmd
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
    if (answer.startsWith('Signed in')) void Promise.resolve(servedAfter?.('login')).catch(() => undefined)
    return answer.replace(/^agent-services: /, '')
  } catch {
    return PASTED_FAILED // a code-shaped message is never forwarded once the sign-in path started
  }
}

/** The first prompt's onboarding note (Command.onboarding), once per session; null when there is none. */
export async function onboardingNote($: EngineInterface): Promise<string | null> {
  try {
    if (!servedOptions) return null
    const session = String(await $.session.id())
    if (onboarded === session) return null
    onboarded = session
    return await (await servedCommand($)).onboarding()
  } catch {
    return null
  }
}
