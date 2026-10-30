"""render_html(): one self-contained offline page of facts. Optionally the estimate the server sent back, shown
as given; no estimate or savings figure is computed here."""
import datetime
import html

CSS = """
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:24px 16px;background:#fafaf8;color:#1d1d1b}
main{max-width:960px;margin:0 auto}
h1{font-size:1.5rem;margin:0 0 4px}h2{font-size:1.1rem;margin:28px 0 8px}
p.meta{color:#5c5c58;margin:0 0 16px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.tile{background:#fff;border:1px solid #e3e3de;border-radius:8px;padding:12px}
.tile b{display:block;font-size:1.3rem}.tile span{color:#5c5c58;font-size:.85rem}
.wrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;background:#fff;font-size:.9rem}
th,td{border-bottom:1px solid #e3e3de;padding:6px 8px;text-align:right;white-space:nowrap}
th:first-child,td:first-child{text-align:left}
th{background:#f1f1ec}
.note{margin-top:28px;color:#5c5c58;font-size:.85rem}
@media (prefers-color-scheme:dark){body{background:#1b1b1a;color:#ececea}.tile,table{background:#252524;border-color:#3a3a38}
th{background:#2f2f2d}th,td{border-color:#3a3a38}p.meta,.tile span,.note{color:#a8a8a3}}
"""


def usd(value):
    return '$' + f'{value:,.2f}'


def num(value):
    return f'{value:,}'


def _e(text):
    return html.escape(str(text))


def _table(head, rows):
    out = ['<div class="wrap"><table><thead><tr>']
    out += [f'<th>{_e(h)}</th>' for h in head]
    out.append('</tr></thead><tbody>')
    for row in rows:
        out.append('<tr>' + ''.join(f'<td>{_e(cell)}</td>' for cell in row) + '</tr>')
    out.append('</tbody></table></div>')
    return ''.join(out)


def _split_row(label, bucket):
    m, s = bucket['main'], bucket['subagents']
    return [label, num(bucket['tokens']), usd(bucket['api_usd']), num(bucket['responses']),
            num(m['tokens']), usd(m['api_usd']), num(s['tokens']), usd(s['api_usd'])]


SPLIT_HEAD = ['', 'Tokens', 'API-equivalent cost', 'Responses', 'Main conversation tokens', 'Main conversation cost',
              'Subagent tokens', 'Subagent cost']


# The reference line (our own measured saving) on the estimate page; set False to leave it out.
SHOW_REFERENCE = True

LEVERS = (('routing', 'Routing'), ('compaction', 'Compaction'), ('index', 'Index'),
          ('scripts', 'Scripts (separate estimate)'), ('total', 'Total'))

NOTE_OFFLINE = ('Costs are API-equivalent list prices from the public price table. '
                'No transcript content is in this page (no prompts, replies, file names or paths), '
                'and nothing was sent anywhere: this report was made offline on this machine.')
NOTE_ESTIMATE = ('Costs are API-equivalent list prices from the public price table. No transcript content is in this '
                 'page (no prompts, replies, file names or paths). The estimate was computed on our server from one '
                 'aggregate of counts, shown to you before it was sent once.')


def _pct(value):
    return f'{value * 100:.1f}%'


def _estimate_section(est):
    out = ['<h2>Estimated monthly saving</h2>']
    rows = []
    for key, label in LEVERS:
        money, hours = est[key]['usd'], est[key]['hours']
        rows.append([label, usd(money['value']), f"{usd(money['low'])} – {usd(money['high'])}",
                     f"{hours['value']:,.1f} h"])
    out.append(_table(['', 'Per month', 'Low – high', 'Hours per month'], rows))
    share = est['pct']
    out.append(f"<p>Share of API-equivalent spend: {_e(_pct(share['value']))} "
               f"({_e(_pct(share['low']))} – {_e(_pct(share['high']))})</p>")
    if SHOW_REFERENCE:
        ref = est['reference']
        out.append(f"<p>Reference: our own measured saving is {ref['pct'] * 100:.1f}% of API-equivalent cost since "
                   f"{_e(ref['since'])}.</p>")
    return ''.join(out)


def render_html(facts, today=None, estimate=None):
    today = (today or datetime.date.today())
    today = today.isoformat() if hasattr(today, 'isoformat') else str(today)
    totals, sessions, comp = facts['totals'], facts['sessions'], facts['compactions']
    first, last = facts.get('first_day'), facts.get('last_day')
    parts = ['<!doctype html><html lang="en"><head><meta charset="utf-8">',
             '<meta name="viewport" content="width=device-width,initial-scale=1">',
             '<title>Claude Code usage report</title><style>', CSS, '</style></head><body><main>',
             '<h1>Claude Code usage report</h1>']
    if first:
        parts.append(f'<p class="meta">Period: {_e(first)} to {_e(last)} &middot; generated {_e(today)}</p>')
    else:
        parts.append(f'<p class="meta">Period: no data &middot; generated {_e(today)}</p>')
    if not totals['responses']:
        parts.append('<p><b>No data:</b> no model responses were found in the transcripts.</p>')

    parts.append('<div class="tiles">')
    for value, label in ((num(totals['tokens']), 'tokens (input, cache writes, output)'),
                         (usd(totals['api_usd']), 'API-equivalent cost'),
                         (num(totals['responses']), 'responses'),
                         (num(totals['cache_read_tokens']), 'cache-read tokens')):
        parts.append(f'<div class="tile"><b>{_e(value)}</b><span>{_e(label)}</span></div>')
    parts.append('</div>')

    parts.append('<h2>Totals: main conversation vs subagents</h2>')
    parts.append(_table(SPLIT_HEAD, [_split_row('All', totals)]))

    parts.append('<h2>Per month</h2>')
    parts.append(_table(['Month'] + SPLIT_HEAD[1:], [_split_row(m, b) for m, b in facts['months'].items()]))

    parts.append('<h2>Per model</h2>')
    rows = [[model, num(b['tokens']), usd(b['api_usd']), num(b['responses']), num(b['input_tokens']),
             num(b['output_tokens']), num(b['cache_write_tokens']), num(b['cache_read_tokens'])]
            for model, b in facts['by_model'].items()]
    parts.append(_table(['Model', 'Tokens', 'API-equivalent cost', 'Responses', 'Input', 'Output', 'Cache write',
                         'Cache read'], rows))
    for month, bucket in facts['months'].items():
        rows = [[model, num(b['tokens']), usd(b['api_usd']), num(b['responses'])]
                for model, b in bucket['by_model'].items()]
        parts.append(f'<h2>Per model, {_e(month)}</h2>')
        parts.append(_table(['Model', 'Tokens', 'API-equivalent cost', 'Responses'], rows))

    parts.append('<h2>Compactions</h2>')
    parts.append(_table(['', 'Total', 'Manual', 'Auto'],
                        [['All', num(comp['total']), num(comp['manual']), num(comp['auto'])]]
                        + [[m, num(n), '', ''] for m, n in comp['by_month'].items()]))

    parts.append('<h2>Sessions</h2>')
    parts.append(_table(['Sessions', 'Median length (minutes)', 'Longest (minutes)', 'Subagents'],
                        [[num(sessions['count']), sessions['median_minutes'], sessions['max_minutes'],
                          num(sessions['subagents'])]]))

    if facts.get('unpriced'):
        parts.append('<h2>Unpriced models</h2><p>No price in the table, so their cost counts as $0.00: '
                     + ', '.join(_e(m) for m in facts['unpriced']) + '</p>')

    if estimate is not None:
        parts.append(_estimate_section(estimate))
    parts.append(f'<p class="note">{NOTE_OFFLINE if estimate is None else NOTE_ESTIMATE}</p>')
    parts.append('</main></body></html>\n')
    return ''.join(parts)
