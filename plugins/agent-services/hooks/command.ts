import type { EngineInterface } from 'claude-code'
import { countsOf } from './day_counts'
import { BodyTooLarge, DAILY_ROUTE } from './metrics'
import { count as whole, money, plusDays } from './pyfmt'
import type { Outbox } from './outbox'
import { redact } from './redact'
import { updateCommand } from './status'
import { applyUpdate, AUTO_UPDATE_KEY, autoSwitchOn, probeProcess, takeUpdateNote, updatesLine } from './update'
import { safeSet } from './store'
import type { KV } from './store'
import { gateNotice, LOCKED_LINE, NOTICE_TEXT, PAUSED_LINE, PLAN_NOTICE, SERVED_CHANNELS, SERVED_ROLES } from './svc'
import type { Svc } from './svc'
import { accountSwitched, ASKED_FILE, askDue, askedFrom, canAsk, dashboardUrl, markSetupDone, readEntry, readSetupDone,
  recordConsent, recordState, savingsOpen, uploadOn, writeEntry } from './choice'
import { dataDir, engineDirs, envOf, readTextOf } from './engine_env'
import { localDay } from './counters'
import { companyCommand, memberView, NOT_ADMIN_TEXT } from './boss'
import { membersCommand } from './members'
import { hasTrust, type TrustFile, unbalancedTrust, withoutTrust, withTrust } from './trust'
import { approvedStored, approveMethods, importLine, lastChangeDiff, LEVEL_KEY, type Level, levelOf, methodsAutoOn, methodsDiff,
  methodsNoted, methodsNotes, pendingUnseen, previewMethods, readLevel, revertMethods, seenDiff, setMethodsAuto,
  settlePending, syncMethodsNow } from './methods'
import { AUTONOMY_LINE } from './autonomy'
import { autoTakenNoteText, framing, hasUpdateNote, lineDiff, NOTE_LABEL, pendingNoteText, setupNoteText,
  updateNoteText } from './review'
import { bandSetup, setBandExplain } from './band'
import { EXPLAIN_KEY, explainOn } from './explain'
import { ORG_PAUSED_LINE, ORG_SAVINGS_TEXT, ORG_SET_TEXT, orgAdmin, orgChoice, orgNotice, sharingQuestion } from './org'
import { hooksStatusLine, hooksSummary, hooksText } from './hooks_list'
import { dataDirAllowed, removeAll, removedMarker, resetRemoved, type RemoveDeps } from './remove'
import { levelOf as routingLevelOf, MODELS_KEY, parseModels, parseUse, pickOutside, ROUTER_EFFORTS, ROUTER_MODELS, ROUTING_KEY, ROUTING_LEVELS,
  routingLevel, routingModels, routingRecord, sessionPick, setSessionPick, type RoutingLevel, type SessionPick } from './routing_level'
import { routingTable } from './flow_state'
import { engineCommand, registerSignedIn } from './engines'
import { jobsCommand } from './jobs_view'
import { inboxCommand } from './inbox'
import { auditCommand } from './audit_log'
import { mcpCommand } from './mcp_check'
import { sealedCommand } from './sealed_wire'
import { clearRules, supportContact } from './rules'

export { denyReason, spawnLine } from './hooks_list'
export { isRemoved } from './remove'
export { dashboardUrl, recordState } from './choice'
export { claudeHashOf, dataDir, engineClaudeHash, engineDirs } from './engine_env'


export const COMMAND_NAME = 'agent-services'
export const COMMAND = '/' + COMMAND_NAME
export const HINT_HEAD = '[login [<email>] | logout | sharing [on_backfill | on_from_now | off | not_now | preview | ' +
  'page on|off | mail on|off] | methods [approve | auto on|off | revert] | routing [off | suggest | strict] | ' +
  'models [set models=<list> efforts=<list> top=<model>:<effort> | clear | use [<model>] [<effort>] | use off | table] | ' +
  'update [auto on|off] | info [data | ' +
  'hooks | log [<day>]] | explain on|off | remove'
export const HINT_ADMIN = ' | company [mail on|off] | members [add <email> | remove <email>]'
export const HINT_TAIL = ' | inbox | audit]'
export const ASK_CLAUDE = ' For status, setup, savings, background jobs, a self-check or a rewind of files, ask Claude.'
export const COMMAND_SPEC = {
  name: COMMAND_NAME,
  description: 'Sign in to or out of agent-services and change its settings',
  argumentHint: HINT_HEAD + HINT_ADMIN + HINT_TAIL,
} as const

export const KNOWN_COMMANDS = ['login', 'logout', 'sharing', 'methods', 'routing', 'models', 'update', 'info', 'remove',
  'company', 'members', 'inbox', 'audit', 'explain', 'code', 'served']
export const TOOL_WORDS = ['status', 'setup', 'check', 'jobs', 'auto']
export const AUTH_FAIL_COMMANDS = ['status', 'login', 'code', 'logout', 'update', 'info', 'remove', 'check', 'audit', 'undo', 'explain']
export const MOVED: Readonly<Record<string, string>> = {
  status: 'There is no status command any more: ask Claude for the agent-services status and it reads it for you.',
  setup: 'There is no setup command any more: ask Claude to finish the agent-services setup; you answer in the ' +
    'plugin\'s own dialogs.',
  savings: 'There is no savings command any more: ask Claude what agent-services saved you.',
  check: 'There is no check command any more: ask Claude to run the agent-services self-check.',
  jobs: 'There is no jobs command any more: ask Claude to list the background jobs.',
  undo: 'There is no undo command any more: ask Claude to rewind your files to a snapshot; it shows what would ' +
    'change first.',
  autonomy: 'There is no autonomy setting any more: agent-services works fully automatically. Tell Claude how you want ' +
    'it to work and that wins.',
  offline: `Offline mode was removed. To stop everything agent-services sends, run ${COMMAND} logout.`,
  estimate: 'The estimate command was removed. Your real savings are on the status line; ask Claude for the total.',
  secrets: 'The secrets command was removed. Masked secrets stay in memory for this session only and are gone when it ends.',
  trim: 'The trim command was removed, and row trimming after a compaction with it.',
}
export const METHODS_MOVED = `Only ${COMMAND} methods approve, methods revert and methods auto on|off are typed now. ` +
  'For anything else ask Claude: it can show ' +
  'what changed, show the full text, or change the mode (suggestions, your own instructions, off) after your yes.'
export const ASK_HEADER = 'Sign-in'
export const EMAIL_QUESTION = "What's the email address of your agent-services account? We'll email a sign-in code to it."
export const EMAIL_CANCEL = ['Cancel sign-in', 'Not now']
export const CODE_OPTIONS = ['Enter the code', 'Enter it later']
export const STATUS_HELLO_MS = 4000
export const OUTBOX_SHOW = 10
export const OUTBOX_LINE_CHARS = 300
export { ROUTING_KEY } from './routing_level'

export const SHARING_QUESTION =
  'Would you like to keep track of what agent-services saves you? You get a private savings page in your ' +
  'claude.ai account (only you can see it) and a weekly email with your total. For this, the plugin uploads one ' +
  'small usage summary a day: token counts and costs per model, counts per task type and per hashed project, and ' +
  'your savings. Your prompts, file contents, paths and code are never sent. Nothing is uploaded before you ' +
  'choose. "Upload, including the past 30 days" also sends the summaries of up to 30 earlier days with the first ' +
  'upload. "Upload from now on only" sends only the days after today, nothing from before. "Don\'t upload" means ' +
  'no uploads, no page and no email, and you won\'t be asked again.'
export const SHARING_OPTIONS = ['Upload, including the past 30 days', 'Upload from now on only', "Don't upload",
  'Show me what is sent']
export const SHARING_HEADER = 'Savings'
export const PAGE_QUESTION = 'Your company turned the savings record on. Show your savings on a private page in ' +
  'your claude.ai account too (only you can see it)?'
export const METHODS_QUESTION = 'agent-services serves working methods (planning, delegating to subagents, testing, ' +
  'review, delivery, checkpoints). How should Claude use them?'
export const METHODS_HEADER = 'Methods'
export const ROUTING_QUESTION = 'How should agent-services route your subagents? "Suggest (the default, recommended)": ' +
  'a subagent whose description does not start with a task type word runs unchanged and gets no routing savings. ' +
  '"Strict": a subagent whose description does not start with a task type word is refused until it is relabelled, ' +
  'so every subagent is routed, and the routing table, not the model and effort the agent names, sets them. "Not now": ' +
  'nothing changes and you are asked again in 7 days at the earliest.'
export const ROUTING_OPTIONS = ['Suggest (the default, recommended)', 'Strict', 'Not now']
export const ROUTING_HEADER = 'Routing'
export const NOT_ANSWERED = 'Not answered; it comes up again in 7 days at the earliest.'
export type Question = 'savings'
export const AUTO_HEADER = 'Automatic updates'
export const AUTO_OFFER_UPDATE = 'Update agent-services automatically from now on?'
export const AUTO_OFFER_METHODS = 'Take future methods changes automatically?'
export const AUTO_OFFER_OPTIONS = ['Yes, from now on', 'Not now', "Don't ask again"]
export const AUTO_UPDATE_DECLINED_KEY = 'auto_update_declined'
export const METHODS_AUTO_DECLINED_KEY = 'methods_auto_declined'
export const AUTO_UPDATE_ON_TEXT = 'Automatic updates are on for this computer: when a newer agent-services version ' +
  'of your channel is listed, the plugin installs it, at most once a day, and tells you. It is used from your next ' +
  `session (or after /reload-plugins). ${COMMAND} update auto off turns it off.`
export const METHODS_AUTO_ON_TEXT = 'Changed working methods are now taken into methods.md automatically for this ' +
  'account on this computer, after a size and shape check; you get a short notice each time, the earlier text is ' +
  `kept, and ${COMMAND} methods revert goes back. ${COMMAND} methods auto off turns it off.`
export const AUTO_OFF_TEXT = 'Automatic {what} off; changes wait for you again.'
export const METHODS_LINE: Readonly<Record<string, string>> = {
  suggest: 'Working methods: suggestions (the default). The served methods come with your prompts as agent-services ' +
    'suggestions, and the planning gate only reminds. Ask Claude to change the mode.',
  on: 'Working methods: your own instructions. Your CLAUDE.md loads the text you approved, and the planning gate holds ' +
    'larger file edits until agent-state.md has a plan. Ask Claude to change the mode.',
  off: 'Working methods: off. Nothing of them reaches Claude and the planning gate does nothing. Ask Claude to turn ' +
    'them back on.',
}
export const SETUP_COMMANDS = [
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
  'routing off',
  'routing suggest',
  'routing strict',
  'models set',
  'models clear',
  'models use',
  'models table',
  'update',
  'info data',
  'info data full',
  'info hooks',
  'info hooks full',
  'setup',
  'status',
  'check',
  'jobs',
  'jobs all',
  'company view',
  'update auto off',
  'methods auto off',
  'methods revert',
  'auto status',
]
export const CONFIRMED_WORDS = ['methods on', 'methods accept', 'models set', 'models clear', 'models use']
export const AUTO_ON_WORDS = ['update auto on', 'methods auto on']
export const ROUTING_STATUS: Readonly<Record<RoutingLevel, string>> = {
  off: 'Subagent routing: off. Subagents start as dispatched, nothing is asked of the service, and the weekly usage ' +
    `line does not stop new subagents either. ${COMMAND} routing suggest turns it back on.`,
  suggest: 'Subagent routing: suggest (the default). Each subagent dispatch asks the service for advice on its model ' +
    `and effort; a model and effort the agent names itself are used (within the main model and your allowed set), and ` +
    `a dispatch without a task type word still runs. ${COMMAND} routing strict refuses those and uses the table only, ` +
    `${COMMAND} routing off turns routing off.`,
  strict: 'Subagent routing: strict. Each subagent dispatch asks the service for advice, and the service\'s table sets ' +
    'its model and effort (a model or effort the agent names is not used); the service refuses a dispatch whose ' +
    `description does not start with a task type word. ${COMMAND} routing suggest or ${COMMAND} routing off changes it.`,
}
export const ROUTING_SET: Readonly<Record<RoutingLevel, string>> = {
  off: 'Subagent routing is off: agent-services sends no routing request, changes no model, adds nothing to ' +
    'subagent prompts and no longer stops new subagents at the weekly usage line. ' +
    `${COMMAND} routing suggest turns it back on.`,
  suggest: 'Subagent routing is set to suggest (the default): each subagent dispatch asks the service for advice on ' +
    `its model and effort; a model and effort the agent names are used, and a dispatch without a task type word runs ` +
    `as written. ${COMMAND} routing strict uses the table only and refuses those; ${COMMAND} routing off turns routing off.`,
  strict: 'Subagent routing is set to strict: each subagent dispatch asks the service for advice, and the service\'s table ' +
    'sets its model and effort (a model or effort the agent names is not used); the service refuses a dispatch whose ' +
    `description does not start with a task type word. ${COMMAND} routing suggest goes back to advice only; ` +
    `${COMMAND} routing off turns routing off.`,
}
export const SETUP_ALIASES = ['savings preview', 'savings not_now', 'dashboard not_now',
  'trust on', 'trust not_now', 'trust off', 'trust preview', 'trust diff', 'trust accept', 'trust keep', 'data', 'hooks',
  'routing on']
export const UPLOAD_ON_WORDS = ['sharing on_backfill', 'sharing on_from_now', 'sharing on', 'savings on', 'dashboard allow']
export const SETUP_SPEC = {
  name: 'setup',
  description:
    "Apply the user's answer to an agent-services setup question, or read what the plugin does. The savings " +
    "record is a private Artifact page on the user's own claude.ai account (only they see it unless they share it), " +
    'a weekly savings email, and one small daily usage summary (token counts and costs per model, counts per task ' +
    'type and hashed project, savings; no prompt text, file contents or paths). This tool cannot turn the upload ' +
    'on: the user turns uploads on themselves, in the plugin\'s dialog ("setup") or with /agent-services sharing ' +
    'on_backfill|on_from_now. "sharing off" (the user chose "Don\'t upload": off for good) and "sharing not_now" ' +
    '(leaves it off and asks again in 7 days at the earliest) apply the user\'s answer; "sharing preview" shows what ' +
    'one upload sends and changes nothing. "methods suggest" (the default) gives Claude the served working ' +
    'methods (planning, delegating to subagents, testing, review, delivery, checkpoints) as agent-services ' +
    'suggestions; "methods on" makes them the user\'s own instructions through one marked section in the user\'s ' +
    'CLAUDE.md and lets the planning gate hold larger file edits until there is a plan (read "methods preview" with ' +
    'the user first); "methods off" turns them off. "methods diff" shows how changed methods differ from the approved ' +
    'ones; "methods accept" takes the new text, "methods keep" keeps the approved one. Before "methods on" or ' +
    '"methods accept", show the user the text ("methods preview") or the change ("methods diff"), ask them with your ' +
    'question tool (AskUserQuestion in Claude Code) whether to apply it, and call with user_confirmed true only when ' +
    'they answered yes in that question; without it nothing changes. "routing off" stops the subagent routing ' +
    'advice and the weekly usage line (no request, no refusal, no model change, nothing added to subagent prompts); ' +
    '"routing suggest" (the default) asks for advice on each subagent and never refuses one for a missing task type ' +
    'word; "routing strict" lets the service refuse a dispatch whose description does not start with a task type ' +
    'word; at strict the table sets each subagent\'s model and effort. "models set" limits which models and efforts ' +
    'subagents may use: call it without models, efforts, top_model and top_effort first; it answers how to ask the ' +
    'user and changes nothing. "models clear" (with user_confirmed true) goes back to the default tiers. "models use" (also with ' +
    'user_confirmed true, only after the user said yes in your question tool) sets the user\'s pick for this session\'s ' +
    'subagents from pick_model and/or pick_effort, for this session only; with neither it clears the pick. "models ' +
    'table" only reads: the routing table as it holds for this session. "update" updates the plugin to ' +
    'the newest listed version. "info data" returns a short summary of the plugin\'s data note and its section names, "info data full" ' +
    'the whole note (every request it sends and when, what the service keeps and for how long, what a company admin ' +
    'sees, the local files, and what can be turned off); "info hooks" lists the hooks the plugin registers, "info ' +
    'hooks full" also what each does. "setup" opens the plugin\'s own dialog for ' +
    'the one setup question, the savings record (methods and routing start at suggest); "status" is the full report (sign-in, ' +
    'plan, service, updates, savings record, methods mode, routing, usage); "check" runs the self-check of the local ' +
    'engines; "jobs" and "jobs all" list the background jobs; "company view" shows what the user\'s company admin sees ' +
    'about them. When the served methods changed, read "methods diff", sum the change up for the user in a few ' +
    'sentences, and tell them /agent-services methods approve takes it. "update auto off" and "methods auto off" turn ' +
    'the automatic plugin update and the automatic methods approval off, "methods revert" goes back to the methods ' +
    'text approved before, and "auto status" reads both switches; this tool cannot turn either on: only the user does, ' +
    'by typing /agent-services update auto on or /agent-services methods auto on, or in the plugin\'s own dialog after an update or a methods approval. ' +
    'Only call it with an answer the user gave, ' +
    'except "setup", which opens the user\'s own dialog, and "info data", "info data full", "info hooks", "info hooks full", "sharing preview", "methods preview", "methods diff", "models table", ' +
    '"status", "check", "jobs", "jobs all", "company view" and "auto status", which only read.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', enum: SETUP_COMMANDS },
      user_confirmed: { type: 'boolean', description: 'true only when the user answered yes in your question tool just before this call' },
      models: { type: 'array', items: { type: 'string', enum: ROUTER_MODELS }, minItems: 1, maxItems: 4, uniqueItems: true },
      efforts: { type: 'array', items: { type: 'string', enum: ROUTER_EFFORTS }, minItems: 1, maxItems: 5, uniqueItems: true },
      top_model: { type: 'string', enum: ROUTER_MODELS },
      top_effort: { type: 'string', enum: ROUTER_EFFORTS },
      pick_model: { type: 'string', enum: ROUTER_MODELS, description: '"models use": the model of the user\'s pick' },
      pick_effort: { type: 'string', enum: ROUTER_EFFORTS, description: '"models use": the effort of the user\'s pick' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  isDeferred: true,
} as const

export const MARKETPLACE = 'agent-plugin'
export const AUTO_UPDATE_OFF_VARS = ['DISABLE_UPDATES', 'DISABLE_AUTOUPDATER', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']
export const AUTO_UPDATE_FORCE_VAR = 'FORCE_AUTOUPDATE_PLUGINS'
export const AUTO_UPDATE_HOW =
  '/plugin, then Marketplaces, select agent-plugin, then Enable auto-update; or set "autoUpdate": true on the ' +
  'agent-plugin entry under extraKnownMarketplaces in your settings'
export const AUTO_UPDATE_SOURCES: readonly (readonly [string, string])[] = [
  ['policy', 'managed'],
  ['local', 'local'],
  ['project', 'project'],
  ['user', 'user'],
]

const UNVERIFIED = NOTICE_TEXT.server_unverified!
export const ERROR_TEXT: Record<string, string> = {
  offline: 'Offline mode is on, so nothing was sent; try again, or ask Claude for the agent-services status.',
  rate_limited: 'agent-services is busy and is slowing requests down; try again in a few minutes.',
  inactive: 'The service is not available to this session right now; try again, or ask Claude for the agent-services ' +
    'status to see why.',
  not_in_plan: "This account's plan does not include this service; ask your company admin or the account owner to add " +
    'it. Claude Code works as usual meanwhile.',
  no_license: 'This account has no active license (company seat or paid plan), so this service is not available; ask ' +
    'your company admin for a seat, or the company that gave you access. Claude Code works as usual meanwhile.',
  service_off: 'This service is switched off on this machine.',
  account_locked: NOTICE_TEXT.account_locked!,
  org_paused: ORG_PAUSED_LINE,
  locked_out: NOTICE_TEXT.locked_out!,
  clock_skew: NOTICE_TEXT.clock_skew!,
  claude_unreadable: "Claude Code's .claude.json could not be read just now, so nothing was sent; try again in a moment.",
  unsigned_response: UNVERIFIED,
  bad_signature: UNVERIFIED,
  stale_response: UNVERIFIED,
  undecryptable_response: UNVERIFIED,
  bad_envelope: NOTICE_TEXT.bad_envelope!,
  bad_response: 'The service sent an answer this plugin cannot use; nothing in it was used. Try again later; if it ' +
    'keeps happening, ask Claude to check for a plugin update.',
  store_unavailable: "Claude Code's plugin store refused a write, so nothing was kept; try again.",
  timeout: 'The service did not answer in time; try again later.',
  server_unreachable: 'The service could not be reached; try again later.',
  connection_failed: 'The service could not be reached; try again later.',
  unavailable: 'The service could not be reached; try again later.',
  failed: 'The request failed; try again in a few minutes, and if it keeps failing, ask Claude for the agent-services ' +
    'status.',
  auth_failed: PAUSED_LINE,
  not_logged_in: PAUSED_LINE,
  bad_code: 'That code was not accepted: it is wrong, expired, or this network may not use it now. Ask for a new one with ' +
    `${COMMAND} login.`,
  license_inactive: 'This account has no active license, so the sign-in was refused; ask your company admin for a ' +
    'seat, or the company that gave you access.',
  bad_request: `The service refused the sign-in request; start again with ${COMMAND} login.`,
  invalid_body: `That input is not valid; nothing was changed. ${COMMAND} alone lists the words it takes; correct it and ` +
    'run it again.',
  check_required: `agent-services asks for a quick browser check before it mails a code; run ${COMMAND} login again and open the link it shows.`,
}

export const USAGE = `Usage: ${COMMAND} ${HINT_HEAD}${HINT_TAIL}` + ASK_CLAUDE
export const USAGE_ADMIN = `Usage: ${COMMAND} ${HINT_HEAD}${HINT_ADMIN}${HINT_TAIL}` + ASK_CLAUDE

export const RENAMED: readonly (readonly [string, string])[] = [
  ['data', 'info data'],
  ['hooks', 'info hooks'],
  ['outbox *', 'info log *'],
  ['trust', 'methods'],
  ['trust status', 'methods'],
  ['trust not_now', 'methods suggest'],
  ['trust *', 'methods *'],
  ['savings preview', 'sharing preview'],
  ['savings off', 'sharing off'],
  ['savings not_now', 'sharing not_now'],
  ['savings mail *', 'sharing mail *'],
  ['dashboard allow', 'sharing page on'],
  ['dashboard not_now', 'sharing page off'],
  ['routing on', 'routing suggest'],
]

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


export type Ask = (question: string, options: { options: string[]; header?: string }) => Promise<string>
export type AutoUpdate = { on: boolean; source: string; how: string }
export type ListedFile = { name: string; kind?: string; size?: number }
export type ReadFs = {
  list(path: string): Promise<readonly ListedFile[]>
  read(path: string): Promise<string>
}

export type CommandDeps = {
  svc: Svc
  engines?: (sub: string, rest: string[]) => Promise<string>
  jobs?: (rest: string[]) => Promise<string>
  inbox?: (rest: string[]) => Promise<string>
  audit?: () => Promise<string>
  mcp?: (rest: string[]) => Promise<string>
  sealed?: (sub: string, rest: string[]) => Promise<string>
  store: KV
  now: () => number
  ask?: Ask | null
  autoUpdate?: () => Promise<AutoUpdate | null>
  updateLine?: () => Promise<string | null>
  updateNow?: () => Promise<string>
  dailyBody?: (day: string) => Promise<Record<string, unknown>>
  previewNote?: () => string | null
  refreshTime?: () => Promise<string>
  panel?: () => Promise<string[]>
  outbox?: Outbox | null
  outboxFs?: ReadFs | null
  sleep?: (ms: number) => Promise<unknown>
  dashboardUrl?: () => Promise<string | null>
  bossUrl?: () => Promise<string | null>
  trustFile?: TrustFile | null
  canAsk?: () => boolean
  asked?: { get(): Promise<number | null>; set(ms: number): Promise<void> } | null
  dataText?: () => Promise<string>
  removeDeps?: Pick<RemoveDeps, 'fs' | 'dirs' | 'stopLog' | 'allowed'> | null
}

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

const isoDay = (unixSeconds: number): string => new Date(unixSeconds * 1000).toISOString().slice(0, 10)

function pausedOf(svc: Svc): string {
  return typeof svc.pausedLine === 'function' ? svc.pausedLine() : ORG_PAUSED_LINE
}

export function usd(x: unknown): string {
  return money(x)
}

export function dailySummary(body: Record<string, unknown>): string {
  const rows = (k: string): Record<string, any>[] => {
    const v = k === 'compact' ? (isObj(body.savings) ? body.savings.compact : null) : body[k]
    return Array.isArray(v) ? v.filter(isObj) : []
  }
  const sum = (list: Record<string, any>[], f: (r: Record<string, any>) => unknown): number =>
    list.reduce((n, r) => n + (num(f(r)) ?? 0), 0)
  const count = (n: number, one: string, many: string): string =>
    `${whole(n)} ${n === 1 ? one : many}`
  const models = rows('by_model')
  const tokens = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'].reduce(
    (n, k) => n + sum(models, (r) => r[k]),
    0,
  )
  return (
    `in plain words, on ${String(body.day ?? '?')} this machine had ` +
    `${count(sum(rows('sessions'), (r) => r.count), 'session', 'sessions')}, ` +
    `${count(sum(rows('by_task'), (r) => r.count), 'subagent run', 'subagent runs')} and ` +
    `${count(countsOf({ route: [], index: [], compact: rows('compact') } as any).compact_start ?? 0, 'compaction', 'compactions')}, using ${count(tokens, 'token', 'tokens')} in total ` +
    `(about ${usd(sum(models, (r) => r.api_usd))} at API prices). Only these numbers are sent: no prompts, file ` +
    'contents or file paths. The exact data, for anyone who wants to check:'
  )
}

export const pct = (x: unknown): string => {
  const v = num(x)
  return v === null ? '?%' : `${(v * 100).toFixed(1)}%`
}

export const errorText = (code: string | null | undefined): string =>
  Object.hasOwn(ERROR_TEXT, code ?? 'failed') ? ERROR_TEXT[code ?? 'failed']! : `The request failed (${code}).`

const EMAIL_RX = /^[^@\s,;<>"\x00-\x1f\x7f]{1,128}@[^@\s,;<>"\x00-\x1f\x7f]{1,253}$/
export const validEmail = (s: unknown): s is string => typeof s === 'string' && EMAIL_RX.test(s)

export const cleanCode = (s: string): string => s.replace(/[\s-]+/g, '')
export const PASTED_CODE_RX = /^[0-9]{8}$/
export const pastedForm = (s: string): string => s.trim().replace(/ +/g, '')
export const PASTED_WAIT_MS = 6_000
export const PASTED_SLOW = 'The sign-in is still being checked. In a moment, ask Claude for the agent-services status ' +
  'to see whether it finished.'
export const PASTED_TAKEN = 'agent-services took the sign-in code; it was not sent to the model.'
export const PASTED_FAILED = `The sign-in did not finish. Enter the code with ${COMMAND} code.`
export const PASTE_CODE_LINE =
  'Paste the 8-digit code from that email here as your next message. It goes to agent-services only, not to ' +
  `Claude, and works for 10 minutes. (Or run ${COMMAND} code.)`


export type AutoUpdateSources = {
  env: (name: string) => Promise<string | undefined | null>
  settings: (source: string) => Promise<unknown>
  readText: (path: string) => Promise<string | null>
  configDir: string
  marketplace?: string
}

export function marketplaceOf(root: unknown): string | null {
  const m = typeof root === 'string' ? /[\\/]plugins[\\/]cache[\\/]([^\\/]+)[\\/]/.exec(root) : null
  return m && m[1] ? m[1] : null
}

const flag = (entry: unknown): boolean | null => {
  const v = isObj(entry) ? entry.autoUpdate : undefined
  return typeof v === 'boolean' ? v : null
}

export async function autoUpdateState(src: AutoUpdateSources): Promise<AutoUpdate> {
  const env = async (n: string) => {
    try {
      return /^\s*(1|true|yes|on)\s*$/i.test(String((await src.env(n)) ?? ''))
    } catch {
      return false
    }
  }
  const market = src.marketplace || MARKETPLACE
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
    const v = isObj(markets) ? flag(markets[market]) : null
    if (v !== null) return { on: v, source: name, how: AUTO_UPDATE_HOW }
  }
  let known: unknown = null
  try {
    const t = await src.readText(`${src.configDir.replace(/[\\/]+$/, '')}/plugins/known_marketplaces.json`)
    known = t === null ? null : JSON.parse(t)
  } catch {
    known = null
  }
  const v = isObj(known) ? flag(known[market]) : null
  if (v !== null) return { on: v, source: 'plugin_menu', how: AUTO_UPDATE_HOW }
  return { on: false, source: 'default', how: AUTO_UPDATE_HOW }
}

export function autoUpdateText(a: AutoUpdate | null, updateLine: string | null = null): string | null {
  if (!a) return null
  if (a.on) {
    return "Auto-update: on. Claude Code's own auto-update is on for agent-plugin, so Claude Code updates this plugin " +
      'by itself, without asking you. To be asked first, turn it off: /plugin, Marketplaces, agent-plugin, Disable ' +
      'auto-update.'
  }
  if (a.source === 'env') {
    return updateLine === null
      ? "Auto-update: Claude Code's own plugin updates are off here (an environment variable). This plugin checks " +
          `for new versions and updates itself only if you typed ${COMMAND} update auto on; otherwise ${COMMAND} ` +
          'update updates it when you choose.'
      : "Auto-update: Claude Code's own plugin updates are off here (an environment variable). To update the " +
          `plugin, run this in a terminal: ${updateLine}`
  }
  return (
    `Auto-update: off. The plugin updates itself only if you typed ${COMMAND} update auto on; otherwise it checks ` +
    `for a newer version, Claude tells you about it, and ${COMMAND} update updates it when you choose. (Claude ` +
    "Code's own auto-update would update it without asking you; this plugin never changes your settings.)"
  )
}

function signedInLine(st: { account_id?: unknown; plan?: unknown; expires_at?: unknown }): string {
  const until = num(st.expires_at)
  return `signed in (account ${st.account_id ?? '?'}, plan ${st.plan ?? 'unknown'}` +
    (until !== null ? `; the sign-in is valid until ${isoDay(until)}` : '') + ').'
}


export class Command {
  private d: CommandDeps
  private askedMem: number | null = null
  private userPreviewed = false
  private confirmed = false
  private usage: string = USAGE

  constructor(deps: CommandDeps) {
    this.d = deps
  }

  async run(args: string, byTool = false, confirmed = false): Promise<string> {
    let text: string
    try {
      const words = String(args ?? '').trim().split(/\s+/).filter(Boolean)
      const renamed = renameOf(words)
      this.confirmed = byTool && confirmed
      text = await this.dispatch(renamed ? renamed.words : words, byTool)
      if (renamed) text += `\n${renamed.line}`
    } catch {
      text = 'the command failed; try again, or ask Claude for the agent-services status.'
    }
    return redact(text)
  }

  private async dispatch(words: string[], byTool = false): Promise<string> {
    const store = this.d.store
    this.usage = (await orgAdmin(store).catch(() => false)) ? USAGE_ADMIN : USAGE
    if (words[0] === undefined) return `${await this.signLine()}\n${this.usage}`
    const sub = words[0].toLowerCase()
    const rest = words.slice(1)
    const svc = this.d.svc
    if (!byTool && Object.hasOwn(MOVED, sub)) return MOVED[sub]!
    if (!byTool && sub === 'mcp' && this.d.mcp) return this.d.mcp(rest)
    const sealedWord = (sub === 'brain' || sub === 'ledger' || sub === 'kit') && !byTool && !!this.d.sealed
    if (!sealedWord && !KNOWN_COMMANDS.includes(sub) && !(byTool && TOOL_WORDS.includes(sub))) {
      return `Unknown subcommand "${sub.slice(0, 40)}". ${this.usage}`
    }
    const signedOutOk = AUTH_FAIL_COMMANDS.includes(sub) || sub === 'routing' || sub === 'models' ||
      (sub === 'methods' && (rest.length === 0 || (rest.length === 1 && rest[0]!.toLowerCase() === 'off'))) ||
      (sealedWord && sub === 'ledger' && rest[0]?.toLowerCase() === 'verify')
    if (!signedOutOk) {
      const st = await svc.authState(true)
      const grace = st === 'paused' && sealedWord && sub === 'kit' && ['export', 'status'].includes(rest[0]?.toLowerCase() ?? '') &&
        typeof svc.graceUntil === 'function' && (await svc.graceUntil()) !== null
      if (st !== 'ok' && !grace) return st === 'locked' ? LOCKED_LINE : st === 'paused' ? pausedOf(svc) : PAUSED_LINE
    }
    if (sealedWord) return this.d.sealed!(sub, rest)
    switch (sub) {
      case 'status':
        return rest.length ? this.usage : this.status()
      case 'login':
        return this.login(rest)
      case 'code':
        return this.code(rest)
      case 'logout':
        return rest.length ? this.usage : this.logout()
      case 'setup':
        return rest.length ? this.usage : this.setup()
      case 'sharing':
        return this.sharing(rest)
      case 'methods':
        if (!byTool && rest.length && !['approve', 'revert', 'auto'].includes(rest[0]!.toLowerCase())) return METHODS_MOVED
        return this.methods(rest, byTool)
      case 'routing':
        return this.routing(rest)
      case 'models':
        return this.models(rest, byTool)
      case 'auto':
        return rest.length === 1 && rest[0]!.toLowerCase() === 'status' ? this.autoStatus() : this.usage
      case 'update':
        if (rest.length === 2 && rest[0]!.toLowerCase() === 'auto' && ['on', 'off'].includes(rest[1]!.toLowerCase())) {
          return this.updateAuto(rest[1]!.toLowerCase() === 'on', byTool)
        }
        return rest.length ? this.usage : this.update()
      case 'info':
        return this.info(rest)
      case 'remove':
        return rest.length ? this.usage : this.remove()
      case 'company': {
        const admin = await orgAdmin(store).catch(() => false)
        const d = { svc, store, url: () => this.d.bossUrl?.() ?? Promise.resolve(null) }
        if (byTool && rest.length === 1 && rest[0]!.toLowerCase() === 'view') return admin ? companyCommand(d, []) : memberView({ svc })
        if (!admin) return NOT_ADMIN_TEXT
        return companyCommand(d, rest)
      }
      case 'members':
        if (!(await orgAdmin(store).catch(() => false))) return NOT_ADMIN_TEXT
        return membersCommand({ svc, ask: this.d.ask ?? null, canAsk: () => this.canAsk(), byTool, validEmail }, rest)
      case 'check':
        return this.d.engines ? this.d.engines('check', []) : this.usage
      case 'jobs':
        return this.d.jobs ? this.d.jobs(rest) : this.usage
      case 'inbox':
        return this.d.inbox ? this.d.inbox(rest) : this.usage
      case 'audit':
        return this.d.audit ? this.d.audit() : this.usage
      case 'explain':
        return this.explain(rest)
      default:
        return this.served(rest)
    }
  }

  private async signLine(): Promise<string> {
    const svc = this.d.svc
    const auth = await svc.authState(true)
    if (auth === 'locked') return LOCKED_LINE
    if (auth === 'paused') return pausedOf(svc)
    if (auth !== 'ok') return PAUSED_LINE
    return signedInLine(await svc.status())
  }

  private async status(): Promise<string> {
    const svc = this.d.svc
    const auth = await svc.authState(true)
    const lines: string[] = []
    let st = await svc.status()
    if (auth === 'ok' && (st.gate as any)?.reason === 'unknown') {
      const hello = svc.handshake('tool')
      await (this.d.sleep ? Promise.race([hello, this.d.sleep(STATUS_HELLO_MS)]) : hello)
      st = await svc.status()
    }
    if (auth === 'locked') lines.push(LOCKED_LINE)
    else if (auth === 'paused') lines.push(pausedOf(svc))
    else if (auth !== 'ok') lines.push(PAUSED_LINE)
    else {
      lines.push(signedInLine(st))
      const gate = st.gate as { open: boolean; reason: string | null; min_shell: string | null }
      if (gate?.open) lines.push('Service: connected.')
      else if (gate?.reason === 'unknown') lines.push('Service: not checked yet in this session.')
      else if (gate?.reason !== 'offline') {
        const n = typeof svc.gateText === 'function' ? svc.gateText() : gateNotice(gate)
        if (n) lines.push(n)
      }
      if (st.plan === 'guard') lines.push(PLAN_NOTICE)
      const org = await orgChoice(this.d.store)
      if (org) lines.push(ORG_SAVINGS_TEXT[org]!)
    }
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
    const ul = updatesLine(await this.safe(async () => autoSwitchOn(await this.d.store.get(AUTO_UPDATE_KEY)), false))
    if (ul) lines.push(ul)
    if (auth === 'ok') {
      lines.push(await this.recordLine(), await this.methodsLine(), await this.routingLine(), AUTONOMY_LINE,
        hooksStatusLine(`${COMMAND} info hooks`))
      lines.push(...(await this.safe(() => this.d.panel?.() ?? Promise.resolve([] as string[]), [] as string[])))
      const n = (await this.safe(() => this.openQuestions(), [] as Question[])).length
      if (n) lines.push(`${n} setup choice${n === 1 ? '' : 's'} open: ask Claude to finish the agent-services setup.`)
      const contact = supportContact()
      if (contact) lines.push(`Support (for subscribers): write to ${contact}.`)
    }
    return lines.join('\n')
  }

  private async recordLine(): Promise<string> {
    const s = await recordState(this.d.store)
    const recommended = s.org === 'on' ? " Your company's admin turned it on and recommends it." : ''
    const head = s.org === 'off'
      ? 'Savings record: off, set by your company for everyone.'
      : s.own === 'on'
        ? `Savings record: on (${(await this.backfill()) ? 'uploads include the past 30 days' : 'upload from now on only'}).`
        : s.own === 'off'
          ? `Savings record: off (don't upload; not asked again; ${COMMAND} sharing on_backfill or sharing ` +
            `on_from_now turns it on).${recommended}`
          : `Savings record: not answered yet, nothing is uploaded (${COMMAND} sharing on asks).${recommended}`
    if (!s.page) return `${head} Private savings page: off.`
    const url = await this.safe(() => this.d.dashboardUrl?.() ?? Promise.resolve(null), null)
    return `${head} Private savings page: ` + (url ? `published at ${url}.` : 'on, published when Claude finishes its next reply.')
  }

  private async backfill(): Promise<boolean> {
    const { entry } = await readEntry(this.d.store)
    return entry.backfill !== false
  }


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

  private async openQuestions(): Promise<Question[]> {
    return savingsOpen(await recordState(this.d.store)) ? ['savings'] : []
  }

  private async offerAuto(kind: 'update' | 'methods'): Promise<string | null> {
    try {
      if (!this.canAsk()) return null
      const declinedKey = kind === 'update' ? AUTO_UPDATE_DECLINED_KEY : METHODS_AUTO_DECLINED_KEY
      const declined = await this.d.store.get(declinedKey)
      if (declined !== undefined && declined !== null) return null
      if (kind === 'update' ? autoSwitchOn(await this.d.store.get(AUTO_UPDATE_KEY))
        : (await this.level()) !== 'on' || (await methodsAutoOn(this.d.store))) return null
      const pick = await this.dialog(kind === 'update' ? AUTO_OFFER_UPDATE : AUTO_OFFER_METHODS, AUTO_OFFER_OPTIONS,
        kind === 'update' ? AUTO_HEADER : METHODS_HEADER)
      if (pick === AUTO_OFFER_OPTIONS[0]) return kind === 'update' ? this.updateAuto(true, false) : this.methodsAuto(true, false)
      const on = `${COMMAND} ${kind} auto on`
      if (pick === AUTO_OFFER_OPTIONS[2]) {
        await safeSet(this.d.store, declinedKey, { at: this.d.now() })
        return `This is not asked again; ${on} still turns it on.`
      }
      return `Automatic ${kind === 'update' ? 'updates stay' : 'methods approval stays'} off; you are asked again next ` +
        `time (${on} turns it on).`
    } catch {
      return null
    }
  }

  private async autoStatus(): Promise<string> {
    const up = await this.safe(async () => autoSwitchOn(await this.d.store.get(AUTO_UPDATE_KEY)), false)
    const m = await this.safe(() => methodsAutoOn(this.d.store), false)
    const log = await this.safe(() => this.d.store.get('methods_auto_log'), null)
    const last = Array.isArray(log) && log.length ? log[log.length - 1] : null
    return `Automatic updates on this computer: ${up ? 'on' : 'off'} (only the user turns them on, with ${COMMAND} ` +
      `update auto on).\nAutomatic methods approval: ${m ? 'on for the account signed in now' : 'off'} (only the ` +
      `user turns it on, with ${COMMAND} methods auto on; it acts at methods level on only).` +
      (isObj(last) ? `\nLast methods change: ${new Date(Number(last.at) || 0).toISOString().slice(0, 16)} UTC by ` +
        `${String(last.by)}${last.version ? `, version ${String(last.version)}` : ''}.` : '')
  }

  private async updateAuto(on: boolean, byTool: boolean): Promise<string> {
    if (on && byTool) return `Only the user can turn this on: they type ${COMMAND} update auto on (or methods auto on).`
    const ok = on ? await safeSet(this.d.store, AUTO_UPDATE_KEY, { on: true, at: this.d.now() })
      : await this.safe(async () => (await this.d.store.delete(AUTO_UPDATE_KEY), true), false)
    if (!ok) return errorText('store_unavailable')
    return on ? AUTO_UPDATE_ON_TEXT : AUTO_OFF_TEXT.replace('{what}', 'updates are')
  }

  private async methodsAuto(on: boolean, byTool: boolean): Promise<string> {
    if (on && byTool) return `Only the user can turn this on: they type ${COMMAND} methods auto on (or update auto on).`
    if (!(await setMethodsAuto(this.d.store, on, this.d.now()))) {
      return on ? `Nothing was changed: sign in first (${COMMAND} login).` : errorText('store_unavailable')
    }
    if (!on) return AUTO_OFF_TEXT.replace('{what}', 'methods approval is')
    const level = await this.safe(() => this.level(), 'suggest' as Level)
    return METHODS_AUTO_ON_TEXT + (level === 'on' ? '' : ` It acts only while the working methods are your own ` +
      `instructions (methods level on); they are at ${level} now.`)
  }

  private async storeDefaults(): Promise<void> {
    const now = this.d.now()
    const unset = async (key: string): Promise<boolean> => {
      try {
        const v = await this.d.store.get(key)
        return v === undefined || v === null
      } catch {
        return false
      }
    }
    try {
      if ((await readLevel(this.d.store, now)) === null && (await unset(LEVEL_KEY))) {
        await safeSet(this.d.store, LEVEL_KEY, { level: 'suggest', at: now })
      }
      if (await unset(ROUTING_KEY)) await safeSet(this.d.store, ROUTING_KEY, routingRecord('suggest', now))
    } catch {
    }
  }

  async questionsDue(): Promise<Question[]> {
    if (!(this.d.canAsk ? this.d.canAsk() : false)) return []
    if (!askDue(await this.askedAt(), this.d.now())) return []
    return this.safe(() => this.openQuestions(), [])
  }

  async setupDue(): Promise<number> {
    try {
      if (!(await this.signedIn())) return 0
      if (!askDue(await this.askedAt(), this.d.now())) return 0
      return (await this.openQuestions()).length
    } catch {
      return 0
    }
  }

  async settle(): Promise<number> {
    try {
      if (await this.signedIn()) {
        await this.storeDefaults()
        if (!(await this.openQuestions()).length) await markSetupDone(this.d.store, this.d.now())
      }
    } catch {
    }
    return this.setupDue()
  }

  private async setup(): Promise<string> {
    const open = await this.openQuestions()
    if (!open.length) {
      return `Nothing to set up: every question is answered.\n${await this.recordLine()}\n${await this.methodsLine()}`
    }
    if (!this.canAsk()) return this.questionsText(open)
    const text = await this.setupRound(open.slice(0, 1))
    if (text === NOT_ANSWERED) return text
    const after = await this.safe(() => this.openQuestions(), [] as Question[])
    const left = after.length
    if (!left) return text
    if (after[0] === open[0]) return `${text}\n${left} still open; the user's answer left this one open, so call setup again only when the user asks.`
    return `${text}\n${left} more open: call setup again.`
  }

  private async questionsText(open: Question[]): Promise<string> {
    const out = ['Nobody can be asked in a dialog here. The open setup questions, to ask the user with your question ' +
      'tool and apply only with their answer:']
    if (open.includes('savings')) {
      out.push(`- Savings: "${await sharingQuestion(this.d.store, SHARING_QUESTION)}" Options: ` +
        `${SHARING_OPTIONS.slice(0, 3).join('; ')}. Only the user turns the upload on, by typing ${COMMAND} sharing ` +
        `on_backfill or ${COMMAND} sharing on_from_now (${COMMAND} sharing on asks in a dialog); "sharing off" ` +
        'applies "Don\'t upload", "sharing not_now" asks again in 7 days.')
    }
    return out.join('\n')
  }

  private async setupRound(open: Question[]): Promise<string> {
    await this.stampAsked()
    const out: string[] = []
    for (const q of open) {
      const a = await this.askOne(q)
      if (a === null) {
        out.push(NOT_ANSWERED)
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
      return null
    }
  }

  private async askOne(_q: Question): Promise<string | null> {
    const a = await this.dialog(await sharingQuestion(this.d.store, SHARING_QUESTION), SHARING_OPTIONS, SHARING_HEADER)
    if (a === null) return null
    const i = SHARING_OPTIONS.indexOf(a)
    return i === 3 ? this.sharingPreview() : this.setRecord((['backfill', 'from_now', 'off'] as const)[i]!)
  }

  async promptNote(first: boolean, update: () => Promise<{ installed: string; latest: string } | null>,
    pending: () => Promise<boolean>, auto?: () => Promise<{ taken: string | null; refused: string | null }>):
    Promise<{ text: string; which: 'org' | 'setup' | 'update' | 'pending' | 'auto_taken' } | null> {
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
    if (first && (this.d.canAsk ? this.d.canAsk() : false) && !(await readSetupDone(this.d.store)) &&
      askDue(await this.askedAt(), this.d.now())) {
      const open = await this.safe(() => this.openQuestions(), [] as Question[])
      if (open.length) {
        const label: Record<Question, string> = { savings: 'the savings record' }
        await this.stampAsked()
        return { text: setupNoteText(open.length, open.map((q) => label[q]), await facts()), which: 'setup' }
      }
    }
    if (first) return null
    const u = (await this.autoUpdateOn()) || !hasUpdateNote() ? null : await this.safe(update, null)
    const up = u ? updateNoteText(u.installed, u.latest, await facts()) : null
    if (up) return { text: up, which: 'update' }
    const a = auto ? await this.safe(auto, { taken: null, refused: null }) : { taken: null, refused: null }
    if (a.taken !== null) return { text: autoTakenNoteText(await facts(), a.taken), which: 'auto_taken' }
    const changed = (await this.safe(pending, false)) ? pendingNoteText(await facts(), a.refused) : null
    if (changed) return { text: changed, which: 'pending' }
    return null
  }

  private async data(): Promise<string> {
    const text = await this.safe(async () => (this.d.dataText ? String(await this.d.dataText()) : ''), '')
    return text.trim()
      ? text.trim()
      : 'The data note (DATA.md in the plugin folder) could not be read here; it is also in the plugin\'s public ' +
          'repository. Nothing was changed.'
  }

  private async info(rest: string[]): Promise<string> {
    const w = (rest[0] ?? '').toLowerCase()
    const full = rest.length === 2 && (rest[1] ?? '').toLowerCase() === 'full'
    if (w === 'data' && (rest.length === 1 || full)) {
      const text = await this.data()
      return full ? text : dataSummary(text, `${COMMAND} info data full`)
    }
    if (w === 'hooks' && rest.length === 1) return hooksSummary(`${COMMAND} info hooks full`)
    if (w === 'hooks' && full) return hooksText()
    if (w === 'log' && rest.length <= 2) return this.outbox(rest.slice(1))
    return `Usage: ${COMMAND} info data [full] | info hooks [full] | info log [<YYYY-MM-DD>]`
  }

  private async remove(): Promise<string> {
    const rd = this.d.removeDeps
    await this.safe(async () => this.d.engines?.('secrets', ['forget']), undefined)
    return removeAll({
      logout: async () => 'Sign-out: ' + (await this.logout()),
      trustOff: async () => {
        const f = this.d.trustFile
        if (!f) return 'CLAUDE.md: it cannot be reached from here; nothing was changed.'
        const text = await f.read()
        if (!hasTrust(text) && !unbalancedTrust(text)) return 'CLAUDE.md: it has no agent-services section; nothing was changed.'
        return 'CLAUDE.md: ' + (await this.takeSectionOut(f))
      },
      store: this.d.store,
      fs: rd?.fs ?? null,
      dirs: rd?.dirs ?? (async () => []),
      stopLog: rd?.stopLog,
      allowed: rd?.allowed,
    })
  }

  private async update(): Promise<string> {
    if (!this.d.updateNow) return `This plugin cannot run commands here. To update it, run this in a terminal: ` +
      `${updateCommand(MARKETPLACE)}`
    const run = this.d.updateNow()
    const slow = 'The update is running (it can take a minute or two). Try again later, or ask Claude for the ' +
      'agent-services status: its Updates: line shows the result.'
    const text = await (this.d.sleep ? Promise.race([run, Promise.resolve(this.d.sleep(8000)).then(() => slow)]) : run)
    if (!text.startsWith('Updated agent-services to')) return text
    const offer = await this.offerAuto('update')
    return offer ? `${text}\n${offer}` : text
  }

  private async clearRemoved(): Promise<void> {
    const rd = this.d.removeDeps
    if (!rd?.fs) return
    let dir: string | undefined
    for (const x of await rd.dirs()) {
      if (x && (!rd.allowed || (await rd.allowed(x).catch(() => false)))) {
        dir = x
        break
      }
    }
    if (!dir) return
    const there = (await rd.fs.list(dir).catch(() => [])).some((e) => e.name === 'REMOVED')
    if (there) await rd.fs.write(removedMarker(dir), '')
    resetRemoved()
  }

  async signedIn(): Promise<boolean> {
    return (await this.safe(() => this.d.svc.authState(), 'unknown')) === 'ok'
  }

  async autoUpdateOn(): Promise<boolean> {
    const a = await this.safe(() => this.d.autoUpdate?.() ?? Promise.resolve(null), null)
    return a?.on === true
  }


  private async level(): Promise<Level> {
    const stored = await readLevel(this.d.store, this.d.now())
    const f = this.d.trustFile
    const there = stored?.level === 'on' && f ? await f.read().then(hasTrust, () => true) : false
    return levelOf(stored, there)
  }

  private async methodsLine(): Promise<string> {
    const level = await this.safe(() => this.level(), 'suggest' as Level)
    const pending = level === 'on' && (await this.safe(() => methodsDiff(lineDiff), null)) !== null
    return METHODS_LINE[level]! + (pending ? ` The served text changed since you approved it: ask Claude what changed, then ${COMMAND} ` +
      'methods approve.' : '')
  }

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
    const again: unknown = await f.read().then((t) => t, () => Symbol('unreadable'))
    if (again !== text) return `Your CLAUDE.md (${f.path}) changed just now; nothing was changed in it. Run this again.`
    await f.write(next)
    return `Removed the agent-services section from ${f.path}.`
  }

  private async methods(rest: string[], byTool = false): Promise<string> {
    const sub = (rest[0] ?? '').toLowerCase()
    const f = this.d.trustFile
    if (sub === 'auto' && rest.length === 2 && ['on', 'off'].includes(rest[1]!.toLowerCase())) {
      return this.methodsAuto(rest[1]!.toLowerCase() === 'on', byTool)
    }
    if (rest.length > 1) return this.usage
    if (sub === '') {
      const auto = await this.safe(() => methodsAutoOn(this.d.store), false)
      return (await this.methodsLine()) + (auto ? ` Changed methods are taken automatically (${COMMAND} methods auto ` +
        'off stops it).' : '')
    }
    if (sub === 'revert') {
      const r = await revertMethods()
      if (r === null) return 'There is no earlier approved text to go back to; nothing was changed.'
      return `The working methods went back one step${r.version ? ` (now version ${r.version})` : ' to the text approved before'}; ` +
        'your CLAUDE.md loads it from the next session on. The text reverted from is not taken automatically again.'
    }
    if (sub === 'approve') {
      if (byTool) return this.usage
      if (await this.safe(() => pendingUnseen(true), false)) {
        return 'Ask Claude what changed in the working methods first (it reads the change and sums it up), then run ' +
          `${COMMAND} methods approve.`
      }
      if (!(await settlePending(true, true))) return 'There is no changed text to approve; nothing was changed.'
      const offer = await this.offerAuto('methods')
      return 'The new working methods replace the approved ones; your CLAUDE.md loads them from the next session on.' +
        (offer ? `\n${offer}` : '')
    }
    if (byTool && (sub === 'on' || sub === 'accept') && !this.confirmed) {
      return `Nothing was changed: "methods ${sub}" needs the user's yes. Show the user ` +
        `${sub === 'on' ? 'the text ("methods preview")' : 'the change ("methods diff")'}, ask them with your question ` +
        `tool (AskUserQuestion in Claude Code) whether to ${sub === 'on' ? 'make the working methods their own ' +
        'instructions' : 'take the changed text'}, and call again with user_confirmed true only if they said yes.` +
        (sub === 'accept' ? ` The user can also type ${COMMAND} methods approve themselves.` : '')
    }
    if (byTool && sub === 'keep' && !this.confirmed) {
      const yes = 'Keep the approved text'
      const a = this.canAsk()
        ? await this.dialog('Claude asks to keep the agent-services working methods you approved and not ask about this ' +
          'change again (Claude can show you the change first). Keep the approved text?', [yes, 'Not now'], METHODS_HEADER)
        : null
      if (a !== yes) {
        return 'Nothing was changed: "methods keep" needs the user\'s own answer in the plugin\'s dialog; call it ' +
          'again when the user asks to keep the approved text.'
      }
    }
    if (sub === 'preview') {
      if (!byTool) this.userPreviewed = true
      const full = await previewMethods(!byTool)
      const line = f ? await f.importLine() : null
      return (line ? 'With the working methods as your own instructions (the setup tool\'s "methods on"), this line ' +
        `is added to the end of your CLAUDE.md (${f!.path}):\n\n${line}\n\n` +
        'It loads a file this plugin keeps renewed while you are signed in; a later change to the text is summed up ' +
        `for you first, and ${COMMAND} methods approve takes it. ` : '') +
        (full === null
          ? 'The full text cannot be fetched right now (signed out or the service unreachable); try again later.'
          : `The full text now:\n\n----- begin -----\n${full.trim()}\n----- end -----`)
    }
    if (sub === 'diff') {
      const d = await methodsDiff(lineDiff, !byTool, byTool)
      if (d !== null && !(await this.safe(() => approvedStored(), true))) {
        return 'No approved version is stored; showing the full text. (agent-services keeps no methods text while ' +
          'signed out, so there is no earlier approved text to compare with.)\n\n' +
          `----- begin -----\n${d.trim()}\n----- end -----\n\nThe user approves it with ${COMMAND} methods approve; ` +
          'the setup tool\'s "methods keep" leaves it unapproved.'
      }
      const seen = d === null && (await this.safe(() => this.level(), 'suggest' as Level)) !== 'on'
        ? await seenDiff(this.d.store, lineDiff) : null
      if (seen) {
        return `The served working methods changed from ${seen.from} to ${seen.to} ("- " ${seen.from}, "+ " ` +
          `${seen.to}):\n\n${seen.text}\n\nThe new version already applies; nothing needs to be accepted.`
      }
      const last = d === null ? await lastChangeDiff(lineDiff) : null
      if (last !== null) {
        return `Nothing is waiting for review. The last change of the approved working methods ("- " before, "+ " ` +
          `now):\n\n${last}\n\n${COMMAND} methods revert goes back to the text before.`
      }
      return d === null
        ? 'The served working methods are the ones you approved; there is nothing to review.'
        : `The served working methods differ from the ones you approved ("- " approved, "+ " new):\n\n${d}\n\n` +
            `The user approves it with ${COMMAND} methods approve; the setup tool's "methods keep" keeps the approved text.`
    }
    if (sub === 'accept' || sub === 'keep') {
      const byModel = byTool && this.confirmed
      if (sub === 'accept' && (await this.safe(() => pendingUnseen(byModel), false))) {
        return 'The changed text was not shown in this session, or it changed since: call the setup tool with "methods ' +
          'diff" first, show the user the change, then call "methods accept" with user_confirmed true.'
      }
      const done = await settlePending(sub === 'accept', byModel)
      if (!done) return 'There is no changed text to review; nothing was changed.'
      const offer = sub === 'accept' ? await this.offerAuto('methods') : null
      return sub === 'accept'
        ? 'The new working methods replace the approved ones; your CLAUDE.md loads them from the next session on.' +
          (offer ? `\n${offer}` : '')
        : 'The approved working methods stay; this change is not asked about again.'
    }
    if (sub !== 'on' && sub !== 'off' && sub !== 'suggest') return this.usage
    const now = this.d.now()
    if (sub !== 'on') {
      const out = f ? await this.takeSectionOut(f) : 'Your CLAUDE.md cannot be reached from here.'
      if (!(await safeSet(this.d.store, LEVEL_KEY, { level: sub, at: now }))) return errorText('store_unavailable')
      await setMethodsAuto(this.d.store, false, now)
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
      await safeSet(this.d.store, LEVEL_KEY, { level: 'on', at: now })
      return `Your CLAUDE.md (${f.path}) already has the agent-services section; the approved working methods stay and ` +
        'nothing was changed. If the text changed since you approved it, ask Claude what changed; ' +
        `${COMMAND} methods approve takes it.`
    }
    const line = await f.importLine()
    if (/\s/.test(line.slice(1))) {
      return `The methods file path has a space in it (${line.slice(1)}), which a CLAUDE.md import cannot load; nothing ` +
        'was changed.'
    }
    const next = withTrust(text, line)
    const again: unknown = await f.read().then((t) => t, () => Symbol('unreadable'))
    if (again !== text) return `Your CLAUDE.md (${f.path}) changed just now; nothing was changed. Run this again.`
    await f.write(next)
    await safeSet(this.d.store, LEVEL_KEY, { level: 'on', at: now })
    const ok = await approveMethods()
    const none = ok.text === null
      ? ' No text could be fetched now (signed out or the service unreachable), so nothing new was approved; ' +
        'ask Claude to show the text once it can be reached.'
      : ''
    return `Added the agent-services section to ${f.path}: from the next session on, the working methods you approved ` +
      `count as your own instructions, and the planning gate holds larger file edits until agent-state.md has a plan; ` +
      'a change to the methods is summed up for you first. Ask Claude to change the mode to take the section out ' +
      'again.' + none +
      (ok.text !== null && !(ok.shown && this.userPreviewed)
        ? ` No preview was shown in this session, so this is the text approved:\n\n----- begin -----\n` +
            `${ok.text.trim()}\n----- end -----`
        : '')
  }

  private async sharing(rest: string[]): Promise<string> {
    const w = rest.map((x) => x.toLowerCase())
    if (!w.length) return this.recordLine()
    if (w.length === 1 && (w[0] === 'off' || w[0] === 'not_now')) return this.setRecord(w[0])
    if (w.length === 1 && (w[0] === 'on_backfill' || w[0] === 'on_from_now')) {
      return this.setRecord(w[0] === 'on_backfill' ? 'backfill' : 'from_now')
    }
    if (w.length === 1 && w[0] === 'preview') return this.sharingPreview()
    if (w.length === 1 && w[0] === 'refresh_time') {
      return this.d.refreshTime ? this.d.refreshTime() : 'The time figures cannot be sent from here.'
    }
    if (w.length === 1 && w[0] === 'on') return this.sharingChoice()
    if (w.length === 2 && w[0] === 'page' && (w[1] === 'on' || w[1] === 'off')) return this.setPage(w[1] === 'on')
    if (w.length === 2 && w[0] === 'mail' && (w[1] === 'on' || w[1] === 'off')) return this.setMail(w[1] === 'on')
    return this.usage
  }

  private async sharingChoice(): Promise<string> {
    const choose = `Choose one: ${COMMAND} sharing on_backfill (upload, including the past 30 days), ${COMMAND} sharing ` +
      `on_from_now (upload from now on only) or ${COMMAND} sharing off (don't upload).`
    if ((await recordState(this.d.store)).org === 'off') return `${ORG_SET_TEXT} Nothing was changed.`
    if (!this.canAsk()) return `Nothing was turned on. ${choose}`
    const a = await this.askOne('savings')
    return a ?? `Not answered; nothing was turned on. ${choose}`
  }

  private async mail(on: boolean): Promise<string | null> {
    const r = await this.d.svc.call('POST', '/metrics/weekly-mail', { on })
    return r.ok ? null : errorText(r.error)
  }

  private async setRecord(sub: 'backfill' | 'from_now' | 'off' | 'not_now'): Promise<string> {
    const s = await recordState(this.d.store)
    const on = sub === 'backfill' || sub === 'from_now'
    if (s.org === 'off' && on) return `${ORG_SET_TEXT} Nothing was changed.`
    if (sub === 'not_now' && s.own !== 'unanswered') {
      return `Nothing was changed: the savings record is ${s.own === 'on' ? 'on' : "off (don't upload)"} by your own ` +
        `choice. ${s.own === 'on' ? `${COMMAND} sharing off turns it off.` : `${COMMAND} sharing on_backfill or ` +
          `sharing on_from_now turns it on.`}`
    }
    if (sub === 'not_now') {
      await this.stampAsked()
      return 'Savings record is not on: nothing is uploaded. You are asked again in 7 days at the earliest; ' +
        `${COMMAND} sharing on asks now, ${COMMAND} sharing off stops the question.`
    }
    const { entry } = await readEntry(this.d.store)
    const at = on && entry.record === 'on' && (entry.backfill !== false) === (sub === 'backfill') && typeof entry.at === 'number'
      ? entry.at
      : this.d.now()
    let mailError: string | null = null
    if (!on) mailError = await this.mail(false)
    const kept = on
      ? (await this.d.svc.setService('metrics', true)) &&
        (await writeEntry(this.d.store, { record: 'on', at, backfill: sub === 'backfill', page: 'on', page_at: this.d.now() }))
      : await writeEntry(this.d.store, { record: 'off', at, backfill: undefined, page: 'off', page_at: at })
    if (!kept) return errorText('store_unavailable')
    await recordConsent(this.d.store, on, (b) => this.d.svc.call('POST', '/privacy/consent', b))
    let mailAsk = ''
    if (on && this.canAsk()) {
      const yes = 'Send the weekly email'
      const a = await this.dialog('Also send you a weekly email that sums up your estimated savings? You can stop it ' +
        'from any email with one click.', [yes, 'No email'], 'Weekly email')
      if (a === yes || a === 'No email') mailError = await this.mail(a === yes)
      mailAsk = a === yes && !mailError ? ' The weekly email is on.'
        : a === 'No email' ? ` No weekly email is sent (${COMMAND} sharing mail on turns it on).`
          : ` The weekly email setting was left as it was (${COMMAND} sharing mail on or off changes it).`
    } else if (on) {
      mailAsk = ` No weekly email is sent unless you turn it on: ${COMMAND} sharing mail on.`
    }
    const mailLine = mailError
      ? `\nThe weekly email setting was not changed: ${mailError} Run ${COMMAND} sharing mail ${on ? 'on' : 'off'} ` +
        'later to change it.'
      : ''
    if (on) {
      const how = sub === 'backfill' && (await accountSwitched(this.d.store))
        ? 'from today on: the earlier days stay with the account that uploaded them (the account you were signed in ' +
          'with before), so nothing from before today is sent and only days from today on go to this account'
        : sub === 'backfill'
        ? 'including the past 30 days: the first upload also sends the summaries of up to 30 earlier days'
        : `from now on only: the first upload sends only the days after ${localDay(at)}, nothing from before`
      return `Savings record is on (upload, ${how}). Your private savings page is published to your claude.ai ` +
        'account when Claude finishes this reply, and a small daily usage summary is uploaded.' + mailAsk +
        ` To turn one part off: ${COMMAND} sharing page off (the page), ${COMMAND} sharing mail off (the ` +
        `email); ${COMMAND} sharing off turns it all off.` + mailLine
    }
    return 'Savings record is off (don\'t upload): no page is published, no weekly email is sent and nothing more is ' +
      `uploaded. You are not asked again; turn it on any time with ${COMMAND} sharing on_backfill (including the ` +
      `past 30 days) or ${COMMAND} sharing on_from_now (from now on only).` + mailLine
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
          ? ' Your company turned the savings record off, so the page shows no new savings until its admin turns it on.'
          : ` It shows savings only while the savings record is on (${COMMAND} sharing on asks).`)
  }

  private async setMail(on: boolean): Promise<string> {
    const r = await this.d.svc.call('POST', '/metrics/weekly-mail', { on })
    if (!r.ok) return `The weekly savings email setting was not changed: ${errorText(r.error)}`
    const now = isObj(r.body) && typeof r.body.on === 'boolean' ? r.body.on : on
    return now
      ? 'The weekly savings email will be sent. (This changes only the email, not the savings record.)'
      : 'The weekly savings email is stopped. (This changes only the email, not the savings record.)'
  }

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
        if (text !== null) {
          upload = `Exactly what one daily upload sends (for ${day}): ${dailySummary(body)}\n${text}`
          const note = this.d.previewNote?.()
          if (note) upload += ` ${note}`
        }
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
      `Nothing of it is uploaded before you choose. "Upload, including the past 30 days" (${COMMAND} sharing ` +
      `on_backfill): the first upload also sends up to 30 earlier days. "Upload from now on only" (${COMMAND} sharing ` +
      `on_from_now): only the days after the day you choose are sent. "Don't upload" (${COMMAND} sharing off): ` +
      `nothing is uploaded and you are not asked again; ${COMMAND} sharing not_now asks again in 7 days. ` +
      `Every other request the plugin sends (routing advice on subagents, for one) is listed by ${COMMAND} info data.`
    )
  }

  private async safe<T>(f: () => Promise<T>, dflt: T): Promise<T> {
    try {
      return await f()
    } catch {
      return dflt
    }
  }

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
    if (rest.length > 1) return `${COMMAND} login takes only an email address. ${this.usage}`
    let email: string | null = rest[0] ?? null
    if (email === null) {
      email = await this.ask(EMAIL_QUESTION, EMAIL_CANCEL)
      if (email === null) return `Sign-in not started. Run ${COMMAND} login <email> to start it.`
    }
    if (!validEmail(email)) return `"${email.slice(0, 80)}" is not an email address; nothing was sent.`
    let r = await this.d.svc.loginStart(email)
    const cb = isObj(r.body) ? r.body : {}
    if (!r.ok && r.error === 'check_required' && typeof cb.check_url === 'string' && /^https:\/\/[^\s"<>]{1,300}$/.test(cb.check_url)) {
      const done = 'I passed the check'
      const a = this.d.ask
        ? await this.dialog(`Before we email your sign-in code, we need a quick check in your browser. Open ${cb.check_url}, ` +
          `complete the check, then choose "${done}".`, [done, 'Cancel'], 'Check')
        : null
      if (a !== done) {
        return `No code was mailed yet. Open ${cb.check_url} in your browser, pass the check, then run ${COMMAND} login ` +
          `${email} again within 10 minutes.`
      }
      r = await this.d.svc.loginStart(email)
    }
    if (!r.ok) {
      return `No code was mailed: ${errorText(r.error)}`
    }
    const tb = isObj(r.body) ? r.body : {}
    let termsLine = ''
    const termsShape = (u: string): boolean => u.length <= 500 && /^https:\/\/[^\s"<>]+$/.test(u)
    if (typeof tb.terms_version === 'string' && typeof tb.terms_url === 'string' && tb.terms_version && tb.terms_url && !termsShape(tb.terms_url)) {
      await this.d.svc.noteTerms(null)
      termsLine = '\nThe service sent a terms link that does not look right, so the terms were not shown or accepted and ' +
        `the service may refuse the sign-in; run ${COMMAND} login again later.`
    } else if (typeof tb.terms_version === 'string' && typeof tb.terms_url === 'string' && tb.terms_version && tb.terms_url) {
      const yes = 'I accept'
      const a = this.canAsk()
        ? await this.dialog('agent-services is for business use only. Please confirm that you use it for your work, ' +
          `that you're 18 or older, and that you accept the customer terms (version ${tb.terms_version.slice(0, 32)}): ` +
          `${tb.terms_url}`, [yes, 'I do not accept'], 'Terms')
        : null
      await this.d.svc.noteTerms(a === yes ? tb.terms_version : null)
      termsLine = a === yes ? '' : '\nThe terms were not accepted, so the service may refuse the sign-in; run ' +
        `${COMMAND} login again to accept them.`
    }
    const mailed = `A sign-in code was mailed to ${email} if it belongs to an agent-services account.`
    if (termsLine) return `${mailed}\n${PASTE_CODE_LINE}${termsLine}`
    return this.loginCode(email, mailed)
  }

  private async code(rest: string[]): Promise<string> {
    let email: string | null = null
    let refused = false
    for (const w of rest) {
      if (email === null && validEmail(w)) email = w
      else refused = true
    }
    email = email ?? (await this.d.svc.pendingEmail())
    if (!email) return `No sign-in is waiting for a code. Start one with ${COMMAND} login.`
    const note = refused
      ? 'The command line was not used for the code: typed commands are kept in prompt history. Enter the code in the dialog instead.'
      : ''
    return this.finish(email, note)
  }

  private async codeDialog(email: string): Promise<{ typed: string | null; pick: string | null }> {
    let pick: string | null = null
    try {
      pick = this.d.ask ? String(await this.d.ask(`Enter the sign-in code mailed to ${email}?`,
        { options: CODE_OPTIONS, header: ASK_HEADER })).trim() : null
    } catch {
      pick = null
    }
    return { typed: pick && !CODE_OPTIONS.includes(pick) ? pick : null, pick }
  }

  private async loginCode(email: string, mailed: string): Promise<string> {
    const { typed } = await this.codeDialog(email)
    const code = typed === null ? '' : cleanCode(typed)
    if (!PASTED_CODE_RX.test(code)) return `${mailed}\n${PASTE_CODE_LINE}`
    return this.complete(email, code, '')
  }

  private async finish(email: string, before: string): Promise<string> {
    const head = before ? before + '\n' : ''
    const { typed, pick } = await this.codeDialog(email)
    if (typed === null) {
      return head + (pick === CODE_OPTIONS[0]
        ? PASTE_CODE_LINE
        : `Sign-in not finished. Enter the code with ${COMMAND} code within 10 minutes (any session).`)
    }
    const code = cleanCode(typed)
    if (!PASTED_CODE_RX.test(code)) return head + `That is not a sign-in code. Try again with ${COMMAND} code.`
    return this.complete(email, code, head)
  }

  async pasted(text: string, signedIn?: () => void): Promise<string | null> {
    const code = pastedForm(String(text ?? ''))
    if (!PASTED_CODE_RX.test(code)) return null
    const email = await this.safe(() => this.d.svc.pendingEmail(), null)
    if (!email) return null
    const done = this.complete(email, code, '', false).catch(() => PASTED_FAILED)
    if (signedIn) void done.then((a) => (a.startsWith('Signed in') ? signedIn() : undefined)).catch(() => undefined)
    let slow: Promise<string> | null = null
    try {
      if (this.d.sleep) slow = Promise.resolve(this.d.sleep(PASTED_WAIT_MS)).then(() => PASTED_SLOW, () => done)
    } catch {
      slow = null
    }
    return slow ? Promise.race([done, slow]) : done
  }

  private async complete(email: string, code: string, head: string, ask = true): Promise<string> {
    const r = await this.d.svc.loginFinish(email, code)
    if (!r.ok) return head + `Sign-in failed: ${errorText(r.error)}`
    clearRules()
    await this.safe(() => this.clearRemoved(), undefined)
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
      if (n) lines.push(`${n} setup choice${n === 1 ? '' : 's'} open: Claude brings ${n === 1 ? 'it' : 'them'} up, or ask Claude to finish ` +
        'the agent-services setup.')
    }
    return lines.filter(Boolean).join('\n')
  }

  private async logout(): Promise<string> {
    const svc = this.d.svc
    const before = await svc.authState(true)
    await this.safe(async () => svc.cancelLogin(), undefined)
    const r = await svc.logout()
    if (r.error !== 'offline') clearRules()
    if (r.ok) return 'Signed out: the server ended this sign-in and it was deleted from this machine.'
    if (r.error === 'store_unavailable') {
      return (
        "Sign-out did not finish: Claude Code's plugin store refused to delete the stored sign-in, so it may still " +
        `be on this machine. Try ${COMMAND} logout again.`
      )
    }
    if (r.error === 'offline') {
      return 'Offline mode is on, so nothing was sent and the sign-in stays; try again, or ask Claude for the ' +
        'agent-services status.'
    }
    if (before !== 'ok' || r.error === 'not_logged_in') {
      return 'Signed out on this machine (nothing was sent: there was no valid sign-in to end).'
    }
    return (
      `Signed out on this machine, but the server could not be told (${errorText(r.error)}); that server session ` +
      'ends when it expires or when this account signs in again.'
    )
  }

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
      } else if (!(sub === 'status' && rest.length <= 1)) return this.usage
    } catch {
      return `Not changed: roles are ${SERVED_ROLES.join(', ')}; channels are ${SERVED_CHANNELS.join(', ')}; a version is like 1.2.0.`
    }
    const s = (await svc.settings()).served
    const pins = Object.entries(s.pins)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k} ${v}`)
    return `Served items: channel ${s.channel}; ${pins.length ? 'pinned: ' + pins.join(', ') : 'no pins'}.`
  }

  private async routingLine(): Promise<string> {
    const level = await routingLevel(this.d.store)
    const chosen = await routingModels(this.d.store)
    return ROUTING_STATUS[level] + (chosen ? ` ${await this.modelsLine()}` : '')
  }

  private async modelsLine(): Promise<string> {
    const a = await routingModels(this.d.store)
    const cap = (w: string) => w[0]!.toUpperCase() + w.slice(1)
    if (!a) {
      return 'Subagent models: the default tiers (no choice saved). ' +
        `${COMMAND} models set models=<list> efforts=<list> top=<model>:<effort> limits them, or ask Claude to set ` +
        'them up with you.'
    }
    return `Subagent models: your choice. Subagents use only ${a.models.map(cap).join(', ')} at ${a.efforts.join(', ')} ` +
      `effort; plan, replan and acceptance use ${cap(a.top.model)} ${a.top.effort}. A subagent never runs above your ` +
      `main model unless you allowed nothing at or below it. ${COMMAND} models clear goes back to the default tiers.`
  }

  private async models(rest: string[], byTool = false): Promise<string> {
    const w = (rest[0] ?? '').toLowerCase()
    if (rest.length === 0) return this.modelsLine()
    if (w === 'use') return this.modelsUse(rest.slice(1), byTool)
    if (w === 'table' && rest.length === 1) return this.modelsTable()
    if (w === 'set' && rest.length === 1 && byTool) {
      return 'Nothing was changed. To limit the models and efforts subagents may use, ask the user with your question ' +
        'tool in two calls. First call, three multi-select questions: which models (Fable, Opus, Sonnet, Haiku), which ' +
        'lower efforts (low, medium, high) and which higher efforts (xhigh, max); at least one model and one effort in ' +
        'all. Second call: which model and effort the top tier (plan, replan, acceptance, an asked-for deep review) uses, ' +
        'with up to 4 combinations of the allowed ones as options. Then call "models set" with models, efforts, ' +
        'top_model, top_effort and user_confirmed true. The service then routes only inside that set and never above ' +
        'the main conversation\'s model unless the user allowed nothing at or below it (the top-tier pick applies as ' +
        'chosen).'
    }
    if (!(w === 'clear' && rest.length === 1) && !(w === 'set' && rest.length === 4)) return this.usage
    if (byTool && !this.confirmed) {
      return `Nothing was changed: "models ${w}" applies the user's own answer. Ask the user with your question tool ` +
        `first, then call again with user_confirmed true; or the user types ${COMMAND} models ${w === 'set' ? 'set ...' : 'clear'} themselves.`
    }
    if (w === 'clear') {
      try {
        await this.d.store.delete(MODELS_KEY)
      } catch {
        return errorText('store_unavailable')
      }
      return 'Subagent models: back to the default tiers; no choice is saved or sent.'
    }
    const a = parseModels(rest.slice(1))
    if (!a) {
      return `That choice is not valid; nothing was changed. Write ${COMMAND} models set models=<list> efforts=<list> ` +
        `top=<model>:<effort>, with models from ${ROUTER_MODELS.join(', ')}, efforts from ${ROUTER_EFFORTS.join(', ')}, ` +
        'and a top pick among the allowed ones (for example models=opus,haiku efforts=medium,high top=opus:high).'
    }
    if (!(await safeSet(this.d.store, MODELS_KEY, { ...a, at: this.d.now() }))) return errorText('store_unavailable')
    return `Saved. ${await this.modelsLine()}`
  }

  private async modelsUse(rest: string[], byTool = false): Promise<string> {
    if (rest.length === 0) {
      return `Usage: ${COMMAND} models use <model> [<effort>] sets your pick for this session's subagents (models from ` +
        `${ROUTER_MODELS.join(', ')}; efforts from ${ROUTER_EFFORTS.join(', ')}); ${COMMAND} models use off clears it.`
    }
    if (byTool && !this.confirmed) {
      return 'Nothing was changed: "models use" applies the user\'s own answer. Ask the user with your question tool ' +
        `first, then call again with user_confirmed true; or the user types ${COMMAND} models use <model> <effort> themselves.`
    }
    if (rest.length === 1 && rest[0]!.toLowerCase() === 'off') {
      setSessionPick(null)
      return 'Session pick cleared: this session\'s subagents follow the routing table and your saved models again.'
    }
    const p = parseUse(rest)
    if (!p) {
      return `That pick is not valid; nothing was changed. Write ${COMMAND} models use <model> <effort>, with models from ` +
        `${ROUTER_MODELS.join(', ')} and efforts from ${ROUTER_EFFORTS.join(', ')}; either part may be left out.`
    }
    const why = pickOutside(p, await routingModels(this.d.store))
    if (why) return `Nothing was changed: ${why}. ${COMMAND} models table shows what is allowed.`
    setSessionPick(p)
    return `Session pick: ${pickText(p)} for this session's subagents; it ends with the session. ${COMMAND} models use off clears it.`
  }

  private pickLine(): string {
    const p = sessionPick()
    return p ? `Session pick: ${pickText(p)} for this session's subagents.` : 'Session pick: none.'
  }

  private async modelsTable(): Promise<string> {
    const local = `${await this.routingLine()}\n${this.pickLine()}`
    const table = await routingTable()
    return table ? `${local}\n\n${table}` : `${local}\n\nThe routing table is not available right now (the service did not answer).`
  }

  private async explain(rest: string[]): Promise<string> {
    const w = (rest[0] ?? '').toLowerCase()
    if (rest.length === 0) {
      let stored: unknown
      try {
        stored = await this.d.store.get(EXPLAIN_KEY)
      } catch {
        return errorText('store_unavailable')
      }
      const on = explainOn(stored)
      return `The band's explanations are ${on ? 'on' : 'off'} on this computer. ${COMMAND} explain ${on ? 'off' : 'on'} ` +
        `turns them ${on ? 'off' : 'on'}.`
    }
    if (rest.length !== 1 || (w !== 'on' && w !== 'off')) return this.usage
    if (!(await safeSet(this.d.store, EXPLAIN_KEY, { on: w === 'on', at: this.d.now() }))) return errorText('store_unavailable')
    setBandExplain(w === 'on')
    return w === 'on'
      ? 'The band shows its explanations again on this computer when the pointer rests on a part of it.'
      : `The band's explanations are off on this computer. ${COMMAND} explain on turns them on again.`
  }

  private async routing(rest: string[]): Promise<string> {
    const w = (rest[0] ?? '').toLowerCase() as RoutingLevel
    if (rest.length === 0) return this.routingLine()
    if (rest.length !== 1 || !ROUTING_LEVELS.includes(w)) return this.usage
    if (!(await safeSet(this.d.store, ROUTING_KEY, routingRecord(w, this.d.now())))) return errorText('store_unavailable')
    return ROUTING_SET[w]
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
            }
          }
        } catch {
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

export function dataSummary(text: string, fullCommand: string): string {
  const parts = text.split(/\n(?=## )/)
  const short = parts.find((p) => /^## In short\b/.test(p))
  if (!short) return text
  const names = parts.slice(1).filter((p) => p !== short).map((p) => p.split('\n')[0]!.replace(/^## /, '').trim())
  return `${short.replace(/^## In short\s*/, 'What agent-services sends, keeps and does, in short:\n').trim()}\n\n` +
    `The whole note has these sections: ${names.join('; ')}. ${fullCommand} shows it.`
}

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


export async function declareCommand($: EngineInterface): Promise<void> {
  await $.command.register({ ...COMMAND_SPEC })
  try {
    await $.tool.register(JSON.parse(JSON.stringify(SETUP_SPEC)))
  } catch {
  }
}

export type EngineOptions = {
  svc: Svc
  outbox?: Outbox | null
  dailyBody?: (day: string) => Promise<Record<string, unknown>>
  previewNote?: () => string | null
  refreshTime?: () => Promise<string>
  panel?: () => Promise<string[]>
  clientVersion?: string
  marketplace?: string
  now?: () => number
  selfUpdates?: () => boolean
}

export function engineDeps($: EngineInterface, o: EngineOptions): CommandDeps {
  const readText = readTextOf($)
  const fs: ReadFs = {
    list: async (p) => (await $.fs.list(p)).map((e: any) => ({ name: String(e.name), kind: e.kind, size: e.size })),
    read: async (p) => String(await $.fs.read(p)),
  }
  const trustFile: TrustFile = {
    path: '~/.claude/CLAUDE.md',
    read: async () => {
      const dir = (await engineDirs($)).configDir
      trustFile.path = `${dir}/CLAUDE.md`
      try {
        return String(await $.fs.read(`${dir}/CLAUDE.md`))
      } catch {
        const names = await Promise.resolve($.fs.list(dir)).then((l: any[]) => l.map((e) => String(e.name)), () => null)
        if (names === null || names.includes('CLAUDE.md')) throw new Error('CLAUDE.md cannot be read')
        return null
      }
    },
    write: async (text) => {
      const dir = (await engineDirs($)).configDir
      trustFile.path = `${dir}/CLAUDE.md`
      await $.fs.write(`${dir}/CLAUDE.md`, text)
    },
    importLine: async () => {
      const dirs = await engineDirs($)
      trustFile.path = `${dirs.configDir}/CLAUDE.md`
      return importLine(await dataDir($), dirs.home)
    },
  }
  return {
    svc: o.svc,
    engines: (sub, rest) => engineCommand($, sub, rest),
    jobs: (rest) => jobsCommand($, rest),
    inbox: (rest) => inboxCommand($, rest),
    audit: () => auditCommand($),
    mcp: (rest) => mcpCommand($, rest),
    sealed: (sub, rest) => sealedCommand($, o.svc, sub, rest),
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
        marketplace: marketplaceOf($.plugin.root) ?? undefined,
      })
    },
    updateLine: async () =>
      ((o.selfUpdates ? o.selfUpdates() : await probeProcess($)) ? null : updateCommand(o.marketplace ?? MARKETPLACE)),
    updateNow: () => applyUpdate($, o.marketplace ?? MARKETPLACE),
    dailyBody: o.dailyBody,
    refreshTime: o.refreshTime,
    panel: o.panel,
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
    trustFile,
    dataText: async () => {
      const note = String(await $.fs.read(`${$.plugin.root}/DATA.md`))
      try { return `${note.trimEnd()}\n\n${String(await $.fs.read(`${$.plugin.root}/DATA-sealed.md`)).trim()}\n` } catch { return note }
    },
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
      allowed: async (dir) => dataDirAllowed(dir, (await engineDirs($)).configDir),
    },
  }
}

type On = (event: any, matcher: any, hook: any) => { catch(h: any): unknown }

export function serveCommand(
  on: On,
  options: () => EngineOptions | Promise<EngineOptions>,
  after?: (sub: string) => unknown,
): void {
  servedOptions = options
  servedAfter = after ?? null
  servedCmd = null
  on('tool.describe', { tool: `mcp__${COMMAND_NAME}__${SETUP_SPEC.name}` }, async ($: EngineInterface, e: any, next: any) => ({
    ...(await next(e)),
    isDeferred: true,
  })).catch(($: EngineInterface, e: any, next: any) => next(e))
  on('tool.call', { tool: `mcp__${COMMAND_NAME}__${SETUP_SPEC.name}` }, async ($: EngineInterface, e: {
    command?: unknown; agentId?: unknown; user_confirmed?: unknown; models?: unknown; efforts?: unknown;
    top_model?: unknown; top_effort?: unknown; pick_model?: unknown; pick_effort?: unknown }) => {
    const c = String(e?.command ?? '')
    if (UPLOAD_ON_WORDS.includes(c.trim().toLowerCase())) {
      return { result: 'The setup tool cannot turn the savings upload or its page on: that is the user\'s own choice. The user ' +
        `turns it on in the plugin's dialog ("setup", which asks the user) or with ${COMMAND} sharing on_backfill|` +
        'on_from_now; nothing was changed.' }
    }
    if (AUTO_ON_WORDS.includes(c.trim().toLowerCase())) {
      return { result: `Only the user can turn this on: they type ${COMMAND} update auto on (or methods auto on). ` +
        'Nothing was changed.' }
    }
    if (!SETUP_COMMANDS.includes(c) && !SETUP_ALIASES.includes(c)) {
      return { result: `Unknown setup command; use one of: ${SETUP_COMMANDS.join(', ')}.` }
    }
    if (!['sharing preview', 'methods preview', 'methods diff', 'info data', 'info data full', 'info hooks', 'info hooks full', 'savings preview',
      'trust preview', 'trust diff', 'data', 'hooks', 'models table', 'status', 'check', 'jobs', 'jobs all',
      'company view', 'auto status'].includes(c) && setupArgs(c, e) !== 'models set' &&
      (e?.agentId || !canAsk())) {
      const w = renameOf(c.split(' '))?.words ?? c.split(' ')
      const typed = KNOWN_COMMANDS.includes(w[0]!) && w[0] !== 'methods' ? ` The user can type ${COMMAND} ${c} themselves.` : ''
      return { result: `"${c}" ${c === 'setup' ? 'opens a dialog for the user' : 'applies the user\'s own answer'}, so it ` +
        `runs only in the main conversation of a session the user is at; nothing was changed.${typed}` }
    }
    const cmd = await servedCommand($)
    const text = await cmd.run(setupArgs(c, e), true, e?.user_confirmed === true && CONFIRMED_WORDS.includes(c))
    void cmd.settle().then(bandSetup, () => undefined)
    void Promise.resolve(after?.(c.split(' ')[0]!)).catch(() => undefined)
    return { result: text }
  }).catch(($: EngineInterface, e: any, next: any) => ({
    result:
      next?.error?.kind === 'timeout'
        ? 'The setup took too long; try again, or ask Claude for the agent-services status.'
        : 'The setup failed; try again, or ask Claude for the agent-services status.',
  }))
  on('command.run', { command: COMMAND_NAME }, async ($: EngineInterface, e: { args?: string }) => {
    const args = String(e?.args ?? '')
    const cmd = await servedCommand($)
    const text = await cmd.run(args)
    void cmd.settle().then(bandSetup, () => undefined)
    try {
      void Promise.resolve(after?.(args.trim().split(/\s+/)[0]?.toLowerCase() || 'status')).catch(() => undefined)
    } catch {
    }
    if (/^(login|code|logout)\b/i.test(args.trim())) void syncMethodsNow()
    if (/^(login|code)\b/i.test(args.trim()) && (await cmd.signedIn())) await registerSignedIn($)
    return { text: text.replace(/^agent-services: /, '') }
  }).catch(() => ({ text: 'the command failed; try again, or ask Claude for the agent-services status.' }))
}

let servedOptions: (() => EngineOptions | Promise<EngineOptions>) | null = null
let servedCmd: Command | null = null
let servedAfter: ((sub: string) => unknown) | null = null
let prompted: string | null = null

async function servedCommand($: EngineInterface): Promise<Command> {
  if (!servedOptions) throw new Error('the command is not served')
  if (!servedCmd) servedCmd = new Command(engineDeps($, await servedOptions()))
  return servedCmd
}

export function setupArgs(c: string, e: { models?: unknown; efforts?: unknown; top_model?: unknown; top_effort?: unknown;
  pick_model?: unknown; pick_effort?: unknown }): string {
  const word = (v: unknown) => (typeof v === 'string' && /^[a-z]{1,16}$/i.test(v) ? v : '')
  if (c === 'models use') {
    const pick = [word(e?.pick_model), word(e?.pick_effort)].filter(Boolean).join(' ')
    return pick ? `models use ${pick}` : 'models use off'
  }
  if (c !== 'models set') return c
  if ([e?.models, e?.efforts, e?.top_model, e?.top_effort].every((v) => v === undefined)) return c
  const list = (v: unknown) => (Array.isArray(v) ? v.map(word).join(',') : '')
  return `models set models=${list(e?.models)} efforts=${list(e?.efforts)} top=${word(e?.top_model)}:${word(e?.top_effort)}`
}

function pickText(p: SessionPick): string {
  const model = p.model ? `${p.model[0]!.toUpperCase()}${p.model.slice(1)}` : 'the table\'s model'
  return p.effort ? `${model} at ${p.effort} effort` : `${model}, effort from the table`
}

export async function routingOff($: EngineInterface): Promise<boolean> {
  try {
    return routingLevelOf(await $.store.get(ROUTING_KEY)) === 'off'
  } catch {
    return true
  }
}

function tookCode($: EngineInterface): void {
  try {
    $.ui.toast(PASTED_TAKEN)
  } catch {
  }
}

export async function pastedCode(
  $: EngineInterface,
  e: { text?: unknown; agentId?: unknown; origin?: { kind?: unknown } | null; attachments?: unknown },
): Promise<string | null> {
  const kind = e?.origin?.kind
  if (e?.agentId || (kind !== 'composer' && kind !== 'bridge' && kind !== 'sdk') ||
    (Array.isArray(e?.attachments) && e.attachments.length)) return null
  const text = e?.text
  if (!servedOptions || typeof text !== 'string' || text.length > 40) return null
  if (!PASTED_CODE_RX.test(pastedForm(text))) return null
  try {
    const answer = await (await servedCommand($)).pasted(text, () => {
      void Promise.resolve(servedAfter?.('login')).catch(() => undefined)
      void syncMethodsNow()
      void registerSignedIn($)
    })
    if (answer === null) return null
    tookCode($)
    return `${PASTED_TAKEN}
${answer.replace(/^agent-services: /, '')}`
  } catch {
    tookCode($)
    return `${PASTED_TAKEN}
${PASTED_FAILED}`
  }
}

export async function onboardingNote($: EngineInterface): Promise<string | null> {
  try {
    if (!servedOptions) return null
    const cmd = await servedCommand($)
    const session = String(await $.session.id())
    const first = prompted !== session
    prompted = session
    bandSetup(await cmd.settle())
    const note = await cmd.promptNote(first, () => takeUpdateNote($), async () => (await methodsNotes($)).pending,
      async () => methodsNotes($))
    if (note?.which === 'pending') methodsNoted()
    if (note?.which === 'auto_taken') methodsNoted('taken')
    return note?.text ?? null
  } catch {
    return null
  }
}
