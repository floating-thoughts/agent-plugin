// The company board: the company admin's second private board.
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

export const NO_DATA_LINE = 'Figures show here after your people have used Claude Code with agent-services for a day.'

/** The company board page from a GET /org/summary answer (escaped; no script, no clock time). */
export function bossHtml(s: Obj): string {
  const people: Obj[] = Array.isArray(s.people) ? s.people : []
  const top = Math.max(0, ...people.map((p) => (typeof p.usd === 'number' ? p.usd : 0)))
  const rows = people.length
    ? people
        .map((p) => {
          const usd = typeof p.usd === 'number' ? money(p.usd) : 'no data yet'
          const dev = p.devices === 0 ? 'not signed in' : p.devices === 1 ? '1 device' : `${p.devices} devices`
          const cls = typeof p.usd === 'number' ? '' : ' class="none"'
          const pct = typeof p.usd === 'number' && top > 0 ? Math.max(0, Math.round((p.usd / top) * 100)) : 0
          return `<tr><td>${esc(p.email)}</td><td${cls}>${esc(usd)}</td><td>${esc(dev)}</td>` +
            `<td class="bar" aria-hidden="true"><span style="width:${pct}%"></span></td></tr>`
        })
        .join('\n')
    : '<tr><td colspan="4" class="none">Nobody is set up yet.</td></tr>'
  const savings = s.savings === 'on' ? 'On for everyone.' : s.savings === 'off' ? 'Off for everyone: nothing is uploaded.' : 'Each person decides.'
  const paused = s.paused ? 'Paused for everyone in your company.' : 'Running.'
  const total = typeof s.total_usd === 'number' ? s.total_usd : 0
  const prev = typeof s.prev_usd === 'number' ? s.prev_usd : null
  const week = isObj(s.week) ? span(String(s.week.first_day), String(s.week.last_day)) : ''
  // the change pill: green up, red down, neutral when equal or nothing to compare with
  const trend = prev === null ? 'flat' : Math.round(total * 100) > Math.round(prev * 100) ? 'up'
    : Math.round(total * 100) < Math.round(prev * 100) ? 'down' : 'flat'
  const used = Number(s.seats_used) || 0
  const paid = typeof s.seats_paid === 'number' ? s.seats_paid : null
  const measured = people.filter((p) => typeof p.usd === 'number').length
  // nobody has a figure and the total is zero: a new company, so say so instead of a big $0.00
  const noData = measured === 0 && Math.round(total * 100) === 0
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Company savings board</title>
<style>
:root { --bg: #f7f7fb; --surface: #ffffff; --border: #e7e6ef; --text: #0e0d16; --muted: #636175; --accent: #5b3df5; --accent-soft: #eeeaff; --up: #127a4b; --up-soft: #e3f5ec; --down: #b4372f; --down-soft: #fbe9e7; --none: #8e8ca0; color-scheme: light; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --bg: #0d0c14; --surface: #16151f; --border: #2a2838; --text: #f3f2f8; --muted: #a3a1b5; --accent: #9d8cff; --accent-soft: #241f45; --up: #4fd394; --up-soft: #13301f; --down: #ff8a80; --down-soft: #3a1714; --none: #77758a; color-scheme: dark; }
}
:root[data-theme="dark"] { --bg: #0d0c14; --surface: #16151f; --border: #2a2838; --text: #f3f2f8; --muted: #a3a1b5; --accent: #9d8cff; --accent-soft: #241f45; --up: #4fd394; --up-soft: #13301f; --down: #ff8a80; --down-soft: #3a1714; --none: #77758a; color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 Inter, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 960px; margin: 0 auto; padding: 0 16px 56px; }
.top { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 18px 0; border-bottom: 1px solid var(--border); }
.brand { font-weight: 800; letter-spacing: -0.02em; white-space: nowrap; }
.brand i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; background: var(--accent); margin-right: 8px; }
.pill { padding: 4px 12px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-size: 14px; font-weight: 600; overflow-wrap: anywhere; text-align: right; }
.hero { padding: 40px 0 8px; }
.eyebrow { color: var(--muted); font-size: 13px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; margin: 0; }
h1 { font-size: clamp(32px, 6vw, 52px); line-height: 1.08; font-weight: 800; letter-spacing: -0.035em; margin: 10px 0 12px; }
h1 b { color: var(--accent); }
.muted, .note { color: var(--muted); }
.change { display: inline-block; padding: 6px 14px; border-radius: 999px; font-weight: 600; font-size: 15px; background: var(--accent-soft); margin: 4px 0 0; }
.change.up { background: var(--up-soft); color: var(--up); }
.change.down { background: var(--down-soft); color: var(--down); }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 16px; margin-top: 28px; }
.kpi { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 18px 20px; }
.kpi span { display: block; color: var(--muted); font-size: 14px; font-weight: 600; }
.kpi strong { display: block; font-size: 30px; font-weight: 800; letter-spacing: -0.03em; margin-top: 6px; font-variant-numeric: tabular-nums; }
h2 { font-size: 20px; font-weight: 800; letter-spacing: -0.02em; margin: 0 0 14px; }
section { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 22px 20px; margin-top: 20px; }
.note { font-size: 14px; margin-bottom: 0; }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 12px 8px; border-bottom: 1px solid var(--border); overflow-wrap: anywhere; }
tbody tr:last-child td { border-bottom: 0; }
th { color: var(--muted); font-weight: 700; font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; }
td:nth-child(2), th:nth-child(2) { text-align: right; white-space: nowrap; font-weight: 700; font-variant-numeric: tabular-nums; }
td:nth-child(3) { color: var(--muted); font-size: 14px; }
.bar { width: 28%; min-width: 80px; }
td.bar span { display: block; height: 8px; border-radius: 999px; background: var(--accent); }
td.none { color: var(--none); font-weight: 400; }
dl { margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
dl div { border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; }
dt { font-size: 13px; font-weight: 700; color: var(--muted); }
dd { margin: 4px 0 0; font-weight: 600; }
code { font-size: 13px; background: var(--accent-soft); color: var(--accent); padding: 1px 6px; border-radius: 6px; }
footer { color: var(--muted); font-size: 13px; margin-top: 24px; }
@media (max-width: 560px) { .bar { display: none; } }
</style>
</head>
<body>
<main>
<header class="top"><span class="brand"><i></i>agent-services</span><span class="pill">${esc(s.org ?? 'your company')}</span></header>
<div class="hero">
<p class="eyebrow">agent-services for ${esc(s.org ?? 'your company')}</p>
<h1>${noData ? 'No figures yet' : `Saved last week: <b>${esc(money(total))}</b>`}</h1>
<p class="muted">The week of ${esc(week)}.</p>
<p class="change ${noData ? 'flat' : trend}">${esc(noData ? NO_DATA_LINE : changeLine(total, prev))}</p>
</div>
<div class="kpis">
<div class="kpi"><span>Saved last week</span><strong>${esc(noData ? '-' : money(total))}</strong></div>
<div class="kpi"><span>The week before</span><strong>${esc(prev === null ? '-' : money(prev))}</strong></div>
<div class="kpi"><span>People with figures</span><strong>${esc(`${measured} of ${people.length}`)}</strong></div>
<div class="kpi"><span>Seats used</span><strong>${esc(paid === null ? `${used}` : `${used} / ${paid}`)}</strong></div>
</div>
<section>
<h2>Saved by each person</h2>
<div class="scroll">
<table>
<thead><tr><th>Person</th><th>Saved last week</th><th>Signed in on</th><th class="bar"></th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</div>
<p class="note">A saving is what the same work would have cost without agent-services. "No data yet" means we have no usage figures from that person for the week: they may not have used Claude Code, or they may have chosen not to share their figures. Each person is told that you see their figure.</p>
</section>
<section>
<h2>Your company's settings</h2>
<dl>
<div><dt>People set up</dt><dd>${esc(seatsText(used, paid))}</dd></div>
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
