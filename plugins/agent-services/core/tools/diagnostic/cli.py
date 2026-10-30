"""python -m tools.diagnostic report | payload --consent | send  (main(argv) is the same in process)."""
import argparse
import json
import os
import sys

from .facts import scan
from .payload import build_payload, load_salt
from .report import num, render_html, usd
from .seam import IMPL


def _projects_root(arg):
    if arg:
        return arg
    config = os.environ.get('CLAUDE_CONFIG_DIR')
    return os.path.join(config, 'projects') if config else os.path.join(os.path.expanduser('~'), '.claude', 'projects')


def _prices(arg):
    return IMPL.load_prices(arg) if arg else IMPL.load_prices()


def _parser():
    parser = argparse.ArgumentParser(prog='python -m tools.diagnostic',
                                     description='Offline Claude Code usage diagnostic (nothing is sent).')
    sub = parser.add_subparsers(dest='command', required=True)
    report = sub.add_parser('report', help='write the one-page HTML report')
    report.add_argument('--projects')
    report.add_argument('--prices')
    report.add_argument('--out', default='claude-usage-report.html')
    payload = sub.add_parser('payload', help='build the consented payload (printed and written, never sent)')
    payload.add_argument('--consent', action='store_true')
    payload.add_argument('--projects')
    payload.add_argument('--prices')
    payload.add_argument('--salt-file', default=None)
    payload.add_argument('--out', default='claude-usage-payload.json')
    send = sub.add_parser('send', help='not available yet')
    send.add_argument('--payload')
    return parser


def _missing(root):
    if not os.path.isdir(root):
        print('The Claude Code projects folder was not found; pass --projects DIR.', file=sys.stderr)
        return True
    return False


def _summary(facts, out):
    t = facts['totals']
    lines = [f"Period: {facts['first_day'] or 'no data'} to {facts['last_day'] or 'no data'}",
             f"Total: {num(t['tokens'])} tokens, {usd(t['api_usd'])} API-equivalent, {num(t['responses'])} responses "
             f"(main {num(t['main']['tokens'])} tokens / {usd(t['main']['api_usd'])}; "
             f"subagents {num(t['subagents']['tokens'])} tokens / {usd(t['subagents']['api_usd'])})"]
    for month, b in facts['months'].items():
        lines.append(f"{month}: {num(b['tokens'])} tokens, {usd(b['api_usd'])} "
                     f"(main {usd(b['main']['api_usd'])}, subagents {usd(b['subagents']['api_usd'])})")
    if not t['responses']:
        lines.append('No data: no model responses were found.')
    lines.append(f'Report: {out}')
    return '\n'.join(lines)


def main(argv=None):
    args = _parser().parse_args(sys.argv[1:] if argv is None else argv)
    if args.command == 'send':
        print('Sending is not available yet; nothing was sent.', file=sys.stderr)
        return 3
    if args.command == 'payload' and not args.consent:
        print('Would build the usage payload (daily token and cost counts, dispatch records, session lengths; '
              'hashed ids, no transcript text); --consent is needed. Nothing was written.', file=sys.stderr)
        return 2
    root = _projects_root(args.projects)
    if _missing(root):
        return 1
    facts = scan(root, _prices(args.prices))
    if args.command == 'report':
        with open(args.out, 'w', encoding='utf-8', newline='\n') as handle:
            handle.write(render_html(facts))
        print(_summary(facts, args.out))
        return 0
    salt = load_salt(args.salt_file)
    text = json.dumps(build_payload(facts, salt), indent=2, ensure_ascii=False)
    with open(args.out, 'w', encoding='utf-8', newline='\n') as handle:
        handle.write(text + '\n')
    print(text)
    return 0
