import type { EngineInterface } from 'claude-code'
import { BOSS_BOARD, pageParts, publishDashboard } from './dashboard'
import type { Report } from './dashboard'
import { orgAdmin } from './org'
import { encode, render } from './render'
import { count, money } from './pyfmt'
import { COMMAND } from './status'
import { safeDelete, safeGet, safeSet } from './store'
import type { KV } from './store'

export const BOSS_CACHE_KEY = 'org_summary_cache'
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
  now: () => number
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export { money }

const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)

export function span(first: string, last: string): string {
  const [ay, am, ad] = first.split('-').map(Number)
  const [by, bm, bd] = last.split('-').map(Number)
  const m = (n: number) => BOSS_MONTHS[n - 1] ?? '?'
  if (ay !== by) return `${ad} ${m(am!)} ${ay} to ${bd} ${m(bm!)} ${by}`
  if (am !== bm) return `${ad} ${m(am!)} to ${bd} ${m(bm!)} ${by}`
  return `${ad} to ${bd} ${m(bm!)} ${by}`
}

export function changeLine(total: number, prev: number | null): string {
  if (prev === null) return 'There is no figure for the week before to compare with.'
  const a = Math.round(total * 100)
  const b = Math.round(prev * 100)
  if (a > b) return `That is ${money((a - b) / 100)} more than the week before (${money(prev)}).`
  if (a < b) return `That is ${money((b - a) / 100)} less than the week before (${money(prev)}).`
  return `That is the same as the week before (${money(prev)}).`
}

function seatsText(used: number, paid: number | null): string {
  return paid === null ? count(used) : `${count(used)} of the ${count(paid)} your plan covers`
}

function mailText(s: Obj): string {
  if (!s.summary_mail) return 'Off. Nothing is sent.'
  if (!s.mail_to) return 'On, but no address is set yet: ask your agent-services contact to add one.'
  return `On, sent every Monday to ${s.mail_to}.`
}

export const NO_DATA_LINE = 'Figures show here after your people have used Claude Code with agent-services for a day.'

export function bossActivity(s: Obj): Obj[] {
  const rows: [string, string, (n: unknown) => string][] = [
    ['sessions', 'Claude Code sessions', count],
    ['subagent_runs', 'Helper agent runs', count],
    ['api_usd', 'AI usage at list prices', money],
  ]
  const out: Obj[] = []
  for (const [key, label, fmt] of rows) {
    const cur = s[key]
    if (typeof cur !== 'number') continue
    out.push({ label, last: fmt(cur), prev: fmt(s[`prev_${key}`]) })
  }
  return out
}

export function bossCodex(s: Obj): string[] {
  const cx = s.codex
  if (!isObj(cx) || typeof cx.requests !== 'number' || !cx.requests) return []
  const models: Obj[] = Array.isArray(cx.models) ? cx.models.filter(isObj) : []
  const n = (v: unknown): number => (typeof v === 'number' ? v : 0)
  const tokens = typeof cx.tokens === 'number' ? cx.tokens : models.reduce((t, m) => t + n(m.input_tokens) + n(m.output_tokens), 0)
  const people = n(cx.people)
  const lines = [`Codex use: ${count(cx.requests)} model requests and ${count(tokens)} tokens (input and output) from ${count(people)} ${people === 1 ? 'person' : 'people'} who share their Codex usage.`]
  if (typeof cx.usd === 'number') lines.push(`Estimated cost at OpenAI's public list prices (read ${cx.prices_checked}): ${money(cx.usd)}.`)
  if (models.some((m) => typeof m.usd !== 'number')) lines.push('Models without a public price are counted in tokens only.')
  const sp: Obj = isObj(cx.spawn) ? cx.spawn : {}
  if (n(sp.advised) || n(sp.followed)) lines.push(`Codex subagent advice: given ${count(n(sp.advised))} times, followed ${count(n(sp.followed))} times.`)
  return lines
}

export function bossView(s: Obj, at: string | null = null): Obj {
  const totals = s.view === 'totals'
  const people: Obj[] = !totals && Array.isArray(s.people) ? s.people : []
  const savings = s.savings === 'on' ? 'On for everyone.' : s.savings === 'off' ? 'Off for everyone: nothing is uploaded.' : 'Each person decides.'
  const paused = s.paused ? 'Paused for everyone in your company.' : 'Running.'
  const withheld = s.total_usd === null
  const total = typeof s.total_usd === 'number' ? s.total_usd : 0
  const prev = typeof s.prev_usd === 'number' ? s.prev_usd : null
  const missing = s.people_withheld === true ? 'withheld' : 'no data yet'
  const trend = prev === null ? 'flat' : Math.round(total * 100) > Math.round(prev * 100) ? 'up'
    : Math.round(total * 100) < Math.round(prev * 100) ? 'down' : 'flat'
  const used = Number(s.seats_used) || 0
  const paid = typeof s.seats_paid === 'number' ? s.seats_paid : null
  const measured = totals ? Number(s.with_data) || 0 : people.filter((p) => typeof p.usd === 'number').length
  const inWeek = typeof s.in_week === 'number' ? s.in_week : totals ? null : people.length
  const withFigures = withheld ? 'withheld' : inWeek === null ? count(measured) : `${count(measured)} of ${count(inWeek)}`
  const noData = !withheld && measured === 0 && Math.round(total * 100) === 0
  return {
    v: 1,
    ...(at === null ? {} : { at }),
    org: String(s.org ?? 'your company'),
    week: isObj(s.week) && isDay(s.week.first_day) && isDay(s.week.last_day) ? span(s.week.first_day, s.week.last_day) : '',
    no_data: noData,
    total: withheld ? 'withheld' : money(total),
    trend: noData || withheld ? 'flat' : trend,
    change: withheld ? "The company's savings total for this week is withheld, so that no one person's figures can be worked out from it." : noData ? NO_DATA_LINE : changeLine(total, prev),
    kpis: [withheld ? 'withheld' : money(noData ? null : total), money(prev), withFigures, paid === null ? count(used) : `${count(used)} / ${count(paid)}`],
    activity: bossActivity(s),
    codex: bossCodex(s),
    totals,
    people: people.map((p) => ({
      email: typeof p.email === 'string' && p.email ? p.email : '-',
      usd: typeof p.usd === 'number' ? money(p.usd) : missing,
      none: typeof p.usd !== 'number',
      devices: typeof p.devices !== 'number' ? count(null) : p.devices === 0 ? 'not signed in' : p.devices === 1 ? '1 device' : `${count(p.devices)} devices`,
    })),
    settings: [seatsText(used, paid), paused, savings, mailText(s)],
  }
}

export const BOSS_TEMPLATE = `<!doctype html>
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
td.none { color: var(--none); font-weight: 400; }
dl { margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
dl div { border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; }
dt { font-size: 13px; font-weight: 700; color: var(--muted); }
dd { margin: 4px 0 0; font-weight: 600; }
code { font-size: 13px; background: var(--accent-soft); color: var(--accent); padding: 1px 6px; border-radius: 6px; }
footer { color: var(--muted); font-size: 13px; margin-top: 24px; }
</style>
</head>
<body>
<main>
<header class="top"><span class="brand"><i></i>agent-services</span><span class="pill" id="org"></span></header>
<div class="hero">
<p class="eyebrow" id="eyebrow"></p>
<h1 id="headline"></h1>
<p class="muted" id="week"></p>
<p class="change flat" id="change"></p>
</div>
<div class="kpis">
<div class="kpi"><span>Saved last week (est.)</span><strong id="k0"></strong></div>
<div class="kpi"><span>The week before</span><strong id="k1"></strong></div>
<div class="kpi"><span>People with figures</span><strong id="k2"></strong></div>
<div class="kpi"><span>Seats used</span><strong id="k3"></strong></div>
</div>
<p class="note">These figures are estimates of AI cost savings, not a measure of anyone's work, time or performance. A saving is an estimate: what the same work would have cost without agent-services, with every subagent on a top-tier model (Opus). "No data yet" means we have no usage figures from that person for the week. It is not evidence that they did not use Claude Code or did not work: they may have chosen not to share their figures.</p>
<section id="people">
<h2>Saved by each person (est.)</h2>
<div class="scroll">
<table>
<thead><tr><th>Person (by email)</th><th>Saved last week (est.)</th><th>Devices signed in when this page was made</th></tr></thead>
<tbody id="rows">
</tbody>
</table>
</div>
<p class="note">People are listed by email address, not by figure. Each person's plugin tells them what you see about them.</p>
</section>
<section id="totals" hidden>
<h2>Totals only</h2>
<p class="note">Your company chose totals only: this board shows the company total and how many people have figures, not any one person's figure or devices.</p>
</section>
<section id="activity" hidden>
<h2>Company activity, last week</h2>
<div class="scroll">
<table>
<thead><tr><th>Company total</th><th>Last week</th><th>The week before</th></tr></thead>
<tbody id="act">
</tbody>
</table>
</div>
<p class="note">Company totals only, never per person. The AI usage figure is at list prices; it is not a bill.</p>
</section>
<section id="codex" hidden>
<h2>Codex use, last week</h2>
<div id="cx"></div>
<p class="note">Company totals only, never per person, from the people who share their Codex usage. The cost is an estimate at list prices, not a bill; no saving is claimed for Codex.</p>
</section>
<section>
<h2>Your company's settings</h2>
<dl>
<div><dt>People set up</dt><dd id="s0"></dd></div>
<div><dt>agent-services</dt><dd id="s1"></dd></div>
<div><dt>Savings record</dt><dd id="s2"></dd></div>
<div><dt>Weekly email summary</dt><dd id="s3"></dd></div>
</dl>
<p class="note">To stop the weekly email, type <code>${COMMAND} company mail off</code> in Claude Code; <code>${COMMAND} company mail on</code> starts it again. People are added and removed with <code>${COMMAND} members</code> (within the paid seats); seats, the license period and the plan are changed by the agent-services contact.</p>
</section>
<footer>This page is private to your claude.ai account. Its figures are updated from time to time while you use Claude Code.</footer>
</main>
<script type="application/json" id="data">null</script>
<script>
(function () {
  "use strict";
  function byId(id) { return document.getElementById(id); }
  function put(id, v) { var n = byId(id); if (n) { n.textContent = v === null || v === undefined ? "" : String(v); } }
  function cell(tr, text, cls) { var td = document.createElement("td"); td.textContent = String(text); if (cls) { td.className = cls; } tr.appendChild(td); return td; }
  function draw(D) {
    if (!D || typeof D !== "object" || D.v !== 1) { return false; }
    var org = typeof D.org === "string" ? D.org : "your company";
    put("org", org);
    put("eyebrow", "agent-services for " + org);
    var h = byId("headline");
    h.textContent = "";
    if (D.no_data) { h.textContent = "No figures yet"; } else {
      h.appendChild(document.createTextNode("Saved last week (est.): "));
      var b = document.createElement("b"); b.textContent = String(D.total); h.appendChild(b);
    }
    put("week", "The week of " + (D.week || "") + ".");
    var c = byId("change");
    c.className = "change " + (D.trend === "up" || D.trend === "down" ? D.trend : "flat");
    c.textContent = String(D.change || "");
    var k = Array.isArray(D.kpis) ? D.kpis : [];
    for (var i = 0; i < 4; i++) { put("k" + i, k[i] === undefined ? "--" : k[i]); }
    byId("people").hidden = D.totals === true;
    byId("totals").hidden = D.totals !== true;
    var act = Array.isArray(D.activity) ? D.activity : [];
    byId("activity").hidden = act.length === 0;
    var actRows = byId("act");
    actRows.textContent = "";
    act.forEach(function (a) { var tr = document.createElement("tr"); cell(tr, a.label || ""); cell(tr, a.last || "--"); cell(tr, a.prev || "--"); actRows.appendChild(tr); });
    var cx = Array.isArray(D.codex) ? D.codex : [];
    byId("codex").hidden = cx.length === 0;
    var cxBox = byId("cx");
    cxBox.textContent = "";
    cx.forEach(function (t) { var p = document.createElement("p"); p.textContent = String(t); cxBox.appendChild(p); });
    var rows = byId("rows");
    rows.textContent = "";
    var people = D.totals === true || !Array.isArray(D.people) ? [] : D.people;
    if (!people.length) { var tr0 = document.createElement("tr"); cell(tr0, "Nobody is set up yet.", "none").colSpan = 3; rows.appendChild(tr0); }
    people.forEach(function (p) {
      var tr = document.createElement("tr");
      cell(tr, p.email || "");
      cell(tr, p.usd, p.none ? "none" : "");
      cell(tr, p.devices);
      rows.appendChild(tr);
    });
    var st = Array.isArray(D.settings) ? D.settings : [];
    for (var j = 0; j < 4; j++) { put("s" + j, st[j] === undefined ? "" : st[j]); }
    return true;
  }
  // The figures baked into the page first; then the artifact's data document (board/figures), which the plugin
  // updates without publishing the page again, when its figures are newer. Without db the baked figures stay.
  var shown = null;
  try { shown = JSON.parse(byId("data").textContent || "null"); } catch (e) { shown = null; }
  draw(shown);
  function stamp(d) { var t = d && (d.generated_at || d.at); return typeof t === "string" ? t : ""; }
  var newest = stamp(shown); // only newer figures replace the ones shown
  try {
    var cl = window.claude;
    if (cl && typeof cl.use === "function") {
      cl.use("db").then(function (db) {
        if (!db) { return; }
        db.doc("board/figures").onSnapshot(function (snap) {
          var d = snap && snap.exists ? snap.data() : null;
          if (!d || typeof d !== "object" || stamp(d) <= newest) { return; }
          if (draw(d)) { newest = stamp(d); }
        }, function () { /* the figures shown stay */ });
      }, function () { /* the figures shown stay */ });
    }
  } catch (e) { /* the figures shown stay */ }
})();
</script>
</body>
</html>
`

export function bossHtml(s: Obj, at: string | null = null): string {
  return render(bossView(s, at), BOSS_TEMPLATE)
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

  private fresh(c: unknown, now: number): Obj | null {
    if (!isObj(c) || !isObj(c.body) || typeof c.fetched_at !== 'number') return null
    return now - c.fetched_at <= BOSS_TTL_MS ? c.body : null
  }

  async purge(): Promise<boolean> {
    let did = false
    try {
      const c = await safeGet(this.d.store, BOSS_CACHE_KEY)
      if (c !== undefined && c !== null) did = (await safeDelete(this.d.store, BOSS_CACHE_KEY)) || did
    } catch {
    }
    try {
      const page = this.path(BOSS_BOARD.page)
      if (String(await this.d.fs.read(page)) !== '') {
        await this.d.fs.write(page, '')
        did = true
      }
    } catch {
    }
    return did
  }

  async sweep(): Promise<string> {
    try {
      let drop = !(await this.isAdmin()) || (await this.d.svc.authState()) !== 'ok'
      if (!drop) {
        const c = await safeGet(this.d.store, BOSS_CACHE_KEY)
        drop = c !== undefined && c !== null && this.fresh(c, this.d.now()) === null
      }
      if (!drop) return 'kept'
      return (await this.purge()) ? 'purged' : 'clean'
    } catch {
      return 'clean'
    }
  }

  async summary(): Promise<Obj | null> {
    const c = await safeGet(this.d.store, BOSS_CACHE_KEY)
    const now = this.d.now()
    const body = this.fresh(c, now)
    const fetched = body !== null && isObj(c) ? (c.fetched_at as number) : null
    const tried = isObj(c) && typeof c.tried_at === 'number' ? c.tried_at : null
    if (this.fetching || (tried !== null && now - tried < BOSS_TTL_MS / 2)) return body
    this.fetching = true
    try {
      await safeSet(this.d.store, BOSS_CACHE_KEY, body === null ? { tried_at: now } : { tried_at: now, fetched_at: fetched, body })
      const r = await this.d.svc.call('GET', '/org/summary', undefined, { kind: 'daily', hook: 'background' })
      if (r.ok && isObj(r.body)) {
        await safeSet(this.d.store, BOSS_CACHE_KEY, { tried_at: now, fetched_at: now, body: r.body })
        return r.body
      }
      if (r.error === 'not_org_admin') {
        await this.purge()
        return null
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
    }
  }

  async render(): Promise<string> {
    try {
      if (!(await this.isAdmin())) {
        await this.purge()
        return 'not_admin'
      }
      if ((await this.d.svc.authState()) !== 'ok') {
        await this.purge()
        return 'auth_failed'
      }
      const s = await this.summary()
      if (!s) {
        await this.purge()
        return 'no_summary'
      }
      let old: string | null = null
      try {
        old = String(await this.d.fs.read(this.path(BOSS_BOARD.page)))
      } catch {
        old = null
      }
      const was = old === null ? null : pageParts(old)
      const now = pageParts(bossHtml(s))
      if (was && was.data && was.format === now.format) {
        const { at: _at, ...figures } = was.data
        if (encode(figures) === encode(now.data)) return 'unchanged'
      }
      const html = bossHtml(s, new Date(this.d.now()).toISOString().slice(0, 19) + 'Z')
      await this.d.fs.write(this.path(BOSS_BOARD.page), html)
      await this.setState({ changed_at: this.d.now() / 1000 })
      return 'changed'
    } catch {
      return 'failed'
    }
  }

  readonly report: Report = async (_session, kind, fields = {}) => {
    if (kind === 'dashboard_published' && typeof fields.url === 'string') {
      await this.setState({ url: fields.url, published_at: this.d.now() / 1000, denied: false })
    } else if (kind === 'dashboard_denied') {
      await this.setState({ denied: true })
    }
  }

  async url(): Promise<string | null> {
    const u = (await this.state()).url
    return typeof u === 'string' && /^https:\/\/claude\.ai\//.test(u) ? u : null
  }
}

type Boards = {
  publish(run: (note: (d: { reason?: string; tool?: string }) => void) => Promise<string>, board?: typeof BOSS_BOARD): Promise<string>
  boss: BossBoard
}
const ATTEMPTS = ['published', 'updated', 'denied', 'failed']

export async function publishBoards($: EngineInterface, w: Boards, report: Report, interactive: boolean): Promise<string> {
  const main = await w.publish((note) => publishDashboard($, report, { interactive, note }))
  if (ATTEMPTS.includes(main) || !(await w.boss.isAdmin())) return main
  return w.publish((note) => publishDashboard($, w.boss.report, { interactive, note, board: BOSS_BOARD }), BOSS_BOARD)
}

export const MEMBER_HEAD = 'What your company admin sees about you'
export const MEMBER_NOT_SEEN = 'About you personally, the admin does not see token counts, costs, session counts, ' +
  'helper agent runs, task types, project ids, times of use, IP addresses, prompts or code; the company totals it ' +
  'sees are never split by person.'
export const NOT_IN_COMPANY_TEXT = 'You are not in a company account, so no company admin sees anything about you.'

export function memberText(m: Obj): string {
  if (m.in_org !== true) return NOT_IN_COMPANY_TEXT
  const week = isObj(m.week) && isDay(m.week.first_day) && isDay(m.week.last_day) ? ` for the week of ${span(m.week.first_day, m.week.last_day)}` : ''
  const lines = [MEMBER_HEAD, `Your admin's private board for ${String(m.org ?? 'your company')} shows this about you${week}:`]
  const you = isObj(m.you) ? m.you : null
  if (m.view === 'totals') {
    lines.push("Nothing about you alone: your company chose totals only, so the board and the weekly company email " +
      'show the company total and how many people have figures, not your email address, figure or devices.')
  } else if (you) {
    lines.push(
      `Your email address: ${String(you.email)}.`,
      `Devices you are signed in on (when the board was made): ${Number(you.devices)}.`,
      typeof you.usd === 'number'
        ? `Your savings figure: ${money(you.usd)}.`
        : m.people_withheld === true
          ? "Your savings figure: withheld (the board shows no one's figure for that week)."
          : 'Your savings figure: no data yet (the service has no usage figures of yours for that week).',
    )
  } else {
    lines.push("Your admin's board has no row for you for that week: it lists the people who were members of the company during it.")
  }
  lines.push(
    "Your company's settings that apply to you:",
    m.paused === true ? 'agent-services is paused for everyone in your company.' : 'agent-services is not paused for your company.',
    m.savings === 'on'
      ? 'Savings record: your admin turned it on for the company and recommends it; nothing of yours is uploaded until you choose.'
      : m.savings === 'off'
        ? 'Savings record: your company turned it off for everyone, so nothing of yours is uploaded.'
        : `Savings record: your company leaves it to each person, so your own choice applies (${COMMAND} sharing on asks).`,
    m.view === 'totals'
      ? 'The weekly company email to your admin, when one is sent, shows the same totals.'
      : 'The weekly company email to your admin, when one is sent, shows your email address and savings figure (not the device count).',
    'The figures are estimates of AI cost savings, not a measure of your work.',
    "The admin also sees the company totals, the seats and the company's settings.",
    MEMBER_NOT_SEEN,
  )
  return lines.join('\n')
}

export async function memberView(d: { svc: { call: Call } }): Promise<string> {
  const r = await d.svc.call('GET', '/org/me')
  if (r.error === 'not_in_plan') return 'Your plan does not include this view. Your company admin still sees your email address and device count; ask your agent-services contact for the details.'
  if (!r.ok || !isObj(r.body)) return `Could not get what your company admin sees about you (${r.error ?? 'failed'}). Try again later.`
  return memberText(r.body)
}

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
