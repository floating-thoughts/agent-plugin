// O5 boss board: the company admin's second private board.
//
// When the hello answer says the signed-in account is its company's admin (org.ts orgAdmin, shell 0.4.0 or later),
// the wiring renders <data dir>/boss/index.html from GET /org/summary after a turn (with the person's own board,
// at most every 10 minutes; the summary itself is fetched at most every BOSS_TTL_MS) and publishBoards publishes it
// through dashboard.ts with BOSS_BOARD: the same consent, grant and 10-minute throttle as the person's own board, and
// only in a turn where that board made no Artifact call (one call per turn). The page is plain HTML with no script
// and no clock time, so it changes only when the figures do. Everything here is best effort and never throws.
//
// The summary-mail switch: `/agent-services company mail on|off` (POST /org/summary-mail); `/agent-services company`
// tells where the board is and how the weekly email is set.
import type { EngineInterface } from 'claude-code'
import { BOSS_BOARD, publishDashboard } from './dashboard'
import type { Report } from './dashboard'
import { orgAdmin } from './org'
import { COMMAND } from './status'
import { safeDelete, safeGet, safeSet } from './store'
import type { KV } from './store'

export const BOSS_CACHE_KEY = 'org_summary_cache' // { tried_at, body }: the last GET /org/summary answer
export const BOSS_TTL_MS = 1_800_000
export const NOT_ADMIN_TEXT = "This is for your company's agent-services admin. Ask your agent-services contact if you should be one."
const BOSS_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

type Obj = Record<string, any>
type Call = (method: string, path: string, body?: unknown, opts?: Record<string, unknown>) => Promise<{ ok: boolean; body?: unknown; error?: string | null }>
export type BossDeps = {
  svc: { call: Call; authState: () => Promise<string> }
  store: KV
  fs: { read(path: string): Promise<string>; write(path: string, text: string): Promise<void> }
  dataDir: string
  now: () => number // ms since the epoch
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** $12.40 / -$0.40, as the weekly mail prints money. */
export function money(usd: number): string {
  const cents = Math.round(usd * 100)
  return cents < 0 ? `-$${(-cents / 100).toFixed(2)}` : `$${(cents / 100).toFixed(2)}`
}

/** '19 to 25 October 2026', '26 October to 1 November 2026', '28 December 2026 to 3 January 2027'. */
export function span(first: string, last: string): string {
  const [ay, am, ad] = first.split('-').map(Number)
  const [by, bm, bd] = last.split('-').map(Number)
  const m = (n: number) => BOSS_MONTHS[n - 1] ?? '?'
  if (ay !== by) return `${ad} ${m(am!)} ${ay} to ${bd} ${m(bm!)} ${by}`
  if (am !== bm) return `${ad} ${m(am!)} to ${bd} ${m(bm!)} ${by}`
  return `${ad} to ${bd} ${m(bm!)} ${by}`
}

/** The change against the week before, in the weekly mail's words. */
export function changeLine(total: number, prev: number | null): string {
  if (prev === null) return 'There is no figure for the week before to compare with.'
  const a = Math.round(total * 100)
  const b = Math.round(prev * 100)
  if (a > b) return `That is ${money((a - b) / 100)} more than the week before (${money(prev)}).`
  if (a < b) return `That is ${money((b - a) / 100)} less than the week before (${money(prev)}).`
  return `That is the same as the week before (${money(prev)}).`
}

function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

function seatsText(used: number, paid: number | null): string {
  return paid === null ? `${used}` : `${used} of the ${paid} your plan covers`
}

function mailText(s: Obj): string {
  if (!s.summary_mail) return 'Off. Nothing is sent.'
  if (!s.mail_to) return 'On, but no address is set yet: ask your agent-services contact to add one.'
  return `On, sent every Monday to ${s.mail_to}.`
}

/** The company board page from a GET /org/summary answer (escaped; no script, no clock time). */
export function bossHtml(s: Obj): string {
  const people: Obj[] = Array.isArray(s.people) ? s.people : []
  const rows = people.length
    ? people
        .map((p) => {
          const usd = typeof p.usd === 'number' ? money(p.usd) : 'no data yet'
          const dev = p.devices === 0 ? 'not signed in' : p.devices === 1 ? '1 device' : `${p.devices} devices`
          const cls = typeof p.usd === 'number' ? '' : ' class="none"'
          return `<tr><td>${esc(p.email)}</td><td${cls}>${esc(usd)}</td><td>${esc(dev)}</td></tr>`
        })
        .join('\n')
    : '<tr><td colspan="3" class="none">Nobody is set up yet.</td></tr>'
  const savings = s.savings === 'on' ? 'On for everyone.' : s.savings === 'off' ? 'Off for everyone: nothing is uploaded.' : 'Each person decides.'
  const paused = s.paused ? 'Paused for everyone in your company.' : 'Running.'
  const total = typeof s.total_usd === 'number' ? s.total_usd : 0
  const prev = typeof s.prev_usd === 'number' ? s.prev_usd : null
  const week = isObj(s.week) ? span(String(s.week.first_day), String(s.week.last_day)) : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Company savings board</title>
<style>
:root { --bg: #f6f5f1; --surface: #ffffff; --border: #e4e1d8; --text: #1d1c19; --muted: #6b675e; --accent: #1f7a5a; --none: #9a958a; color-scheme: light; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --bg: #141412; --surface: #1d1c1a; --border: #33312d; --text: #efede7; --muted: #a8a397; --accent: #4cc596; --none: #7a766c; color-scheme: dark; }
}
:root[data-theme="dark"] { --bg: #141412; --surface: #1d1c1a; --border: #33312d; --text: #efede7; --muted: #a8a397; --accent: #4cc596; --none: #7a766c; color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 24px 16px 48px; }
.eyebrow { color: var(--muted); font-size: 14px; margin: 0; }
h1 { font-size: 30px; margin: 4px 0; }
h1 b { color: var(--accent); }
h2 { font-size: 18px; margin: 0 0 12px; }
section { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 16px; margin-top: 16px; }
.muted, .note { color: var(--muted); }
.note { font-size: 14px; margin-bottom: 0; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--border); overflow-wrap: anywhere; }
th { color: var(--muted); font-weight: 600; font-size: 14px; }
td:nth-child(2), th:nth-child(2) { text-align: right; white-space: nowrap; }
.none { color: var(--none); }
dl { margin: 0; }
dl div { display: flex; flex-wrap: wrap; gap: 4px 16px; padding: 8px 0; border-bottom: 1px solid var(--border); }
dt { font-weight: 600; min-width: 190px; }
dd { margin: 0; }
code { font-size: 14px; }
footer { color: var(--muted); font-size: 13px; margin-top: 20px; }
</style>
</head>
<body>
<main>
<p class="eyebrow">agent-services for ${esc(s.org ?? 'your company')}</p>
<h1>Saved last week: <b>${esc(money(total))}</b></h1>
<p class="muted">The week of ${esc(week)}.</p>
<p>${esc(changeLine(total, prev))}</p>
<section>
<h2>Saved by each person</h2>
<table>
<thead><tr><th>Person</th><th>Saved last week</th><th>Signed in on</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<p class="note">A saving is what the same work would have cost without agent-services. "No data yet" means we have no usage figures from that person for the week: they may not have used Claude Code, or they may have chosen not to share their figures. Each person is told that you see their figure.</p>
</section>
<section>
<h2>Your company's settings</h2>
<dl>
<div><dt>People set up</dt><dd>${esc(seatsText(Number(s.seats_used) || 0, typeof s.seats_paid === 'number' ? s.seats_paid : null))}</dd></div>
<div><dt>agent-services</dt><dd>${esc(paused)}</dd></div>
<div><dt>Savings record</dt><dd>${esc(savings)}</dd></div>
<div><dt>Weekly email summary</dt><dd>${esc(mailText(s))}</dd></div>
</dl>
<p class="note">To stop the weekly email, type <code>${COMMAND} company mail off</code> in Claude Code; <code>${COMMAND} company mail on</code> starts it again. To add or remove people, pause agent-services or change the savings record, ask your agent-services contact.</p>
</section>
<footer>This page is private to your claude.ai account. It is updated from time to time while you use Claude Code.</footer>
</main>
</body>
</html>
`
}

/** Forget the cached summary, so the next render fetches it again (after a setting changed). */
export async function forgetSummary(kv: KV): Promise<void> {
  await safeDelete(kv, BOSS_CACHE_KEY)
}

export class BossBoard {
  private d: BossDeps
  private fetching = false

  constructor(deps: BossDeps) {
    this.d = deps
  }

  private path(rel: string): string {
    return `${this.d.dataDir.replace(/[\\/]+$/, '')}/${rel}`
  }

  async isAdmin(): Promise<boolean> {
    try {
      return await orgAdmin(this.d.store)
    } catch {
      return false
    }
  }

  /** The cached summary, fetched again when it is older than BOSS_TTL_MS (a failed fetch keeps the old one). */
  async summary(): Promise<Obj | null> {
    const c = await safeGet(this.d.store, BOSS_CACHE_KEY)
    const body = isObj(c) && isObj(c.body) ? c.body : null
    const tried = isObj(c) && typeof c.tried_at === 'number' ? c.tried_at : null
    const now = this.d.now()
    if (this.fetching || (tried !== null && now - tried < BOSS_TTL_MS)) return body
    this.fetching = true
    try {
      await safeSet(this.d.store, BOSS_CACHE_KEY, { tried_at: now, body })
      const r = await this.d.svc.call('GET', '/org/summary', undefined, { kind: 'daily', hook: 'background' })
      if (r.ok && isObj(r.body)) {
        await safeSet(this.d.store, BOSS_CACHE_KEY, { tried_at: now, body: r.body })
        return r.body
      }
      return body
    } catch {
      return body
    } finally {
      this.fetching = false
    }
  }

  private async state(): Promise<Obj> {
    try {
      const s = JSON.parse(String(await this.d.fs.read(this.path(BOSS_BOARD.state))))
      return isObj(s) ? s : {}
    } catch {
      return {}
    }
  }

  private async setState(fields: Obj): Promise<void> {
    try {
      const st = { changed_at: null, url: null, published_at: null, denied: false, ...(await this.state()), ...fields }
      await this.d.fs.write(this.path(BOSS_BOARD.state), JSON.stringify(st, null, 2))
    } catch {
      // best effort
    }
  }

  /** One render: the page is written (and changed_at recorded) only when it changed. */
  async render(): Promise<string> {
    try {
      if (!(await this.isAdmin())) return 'not_admin'
      if ((await this.d.svc.authState()) !== 'ok') return 'auth_failed'
      const s = await this.summary()
      if (!s) return 'no_summary'
      const html = bossHtml(s)
      let old: string | null = null
      try {
        old = String(await this.d.fs.read(this.path(BOSS_BOARD.page)))
      } catch {
        old = null
      }
      if (old === html) return 'unchanged'
      await this.d.fs.write(this.path(BOSS_BOARD.page), html)
      await this.setState({ changed_at: this.d.now() / 1000 })
      return 'changed'
    } catch {
      return 'failed'
    }
  }

  /** dashboard.ts publishDashboard's report for this board: remember the artifact, or the deny. */
  readonly report: Report = async (_session, kind, fields = {}) => {
    if (kind === 'dashboard_published' && typeof fields.url === 'string') {
      await this.setState({ url: fields.url, published_at: this.d.now() / 1000, denied: false })
    } else if (kind === 'dashboard_denied') {
      await this.setState({ denied: true })
    }
  }

  /** The published company board's URL, or null. */
  async url(): Promise<string | null> {
    const u = (await this.state()).url
    return typeof u === 'string' && /^https:\/\/claude\.ai\//.test(u) ? u : null
  }
}

type Boards = {
  publish(run: (note: (d: { reason?: string }) => void) => Promise<string>, board?: typeof BOSS_BOARD): Promise<string>
  boss: BossBoard
}
const ATTEMPTS = ['published', 'denied', 'failed']

/**
 * After a main-agent turn: the person's own board first (wiring.publish, logged), then the company board when this
 * account is its company's admin and the first made no Artifact call. Resolves to the last outcome.
 */
export async function publishBoards($: EngineInterface, w: Boards, report: Report, interactive: boolean): Promise<string> {
  const main = await w.publish((note) => publishDashboard($, report, { interactive, note }))
  if (ATTEMPTS.includes(main) || !(await w.boss.isAdmin())) return main
  return w.publish((note) => publishDashboard($, w.boss.report, { interactive, note, board: BOSS_BOARD }), BOSS_BOARD)
}

/** `/agent-services company [mail on|off]` for the company admin. */
export async function companyCommand(d: { svc: { call: Call }; store: KV; url: () => Promise<string | null> }, rest: string[]): Promise<string> {
  const admin = await orgAdmin(d.store).catch(() => false)
  if (!admin) return NOT_ADMIN_TEXT
  const sub = (rest[0] ?? '').toLowerCase()
  if (rest.length === 0) {
    const url = await d.url().catch(() => null)
    const c = await safeGet(d.store, BOSS_CACHE_KEY)
    const s = isObj(c) && isObj(c.body) ? c.body : null
    const board = url
      ? `Company board: ${url}`
      : 'Company board: not published yet (it is published after one of your next replies, once your board is allowed).'
    const mail = s ? `Weekly email summary: ${mailText(s)}` : 'Weekly email summary: not known yet.'
    return `${board}\n${mail}\nTo stop or restart the weekly email: ${COMMAND} company mail off, or ${COMMAND} company mail on.`
  }
  if (sub === 'mail' && rest.length === 2 && ['on', 'off'].includes(rest[1]!.toLowerCase())) {
    const want = rest[1]!.toLowerCase() === 'on'
    const r = await d.svc.call('POST', '/org/summary-mail', { on: want })
    if (!r.ok) return r.error === 'not_org_admin' ? NOT_ADMIN_TEXT : `The weekly company email was not changed (${r.error ?? 'failed'}). Try again later.`
    await forgetSummary(d.store)
    const on = isObj(r.body) && typeof r.body.on === 'boolean' ? r.body.on : want
    return on
      ? 'The weekly company email will be sent again, every Monday.'
      : 'The weekly company email is stopped. Your company board still shows the figures.'
  }
  return `Usage: ${COMMAND} company, or ${COMMAND} company mail on|off.`
}
