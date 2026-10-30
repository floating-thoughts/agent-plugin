"""Usage parsing and pricing: read Claude Code session logs, count tokens per reply and price them.

tools/diagnostic/seam.py loads this file. Prices: modules/usage/prices.json (public list prices).
Python 3.9+, standard library only.
"""
import datetime
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
PRICES = os.path.join(HERE, '..', 'modules', 'usage', 'prices.json')
FIELDS = ('input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h')


# ---------- prices ----------

def load_prices(path=None):
    with open(path or PRICES, encoding='utf-8') as handle:
        return json.load(handle)


def _bare(model):
    at = model.find('claude-')
    name = model[at:] if at >= 0 else model
    cut = name.find('[')
    return name[:cut] if cut >= 0 else name


def _matches(name, prefix):
    # claude-opus-5 is not claude-opus-5-5 (a digit or a one- or two-digit version part goes on);
    # claude-sonnet-4-20250514 is claude-sonnet-4 (a date goes on)
    if name == prefix:
        return True
    rest = name[len(prefix):] if name.startswith(prefix) else None
    return rest is not None and not rest[0].isdigit() and not re.match(r'-\d{1,2}(?!\d)', rest)


def price_of(model, prompt, prices):
    """$/MTok for each of the five fields, or None when the model is not in the table."""
    name = _bare(model or '')
    for row in prices.get('models', []):
        if _matches(name, row['prefix']):
            inp, out, read = row['input'], row['output'], row['cache_read']
            for tier in prices.get('long_prompt', []):
                if _matches(name, tier['prefix']) and prompt > tier['over']:
                    inp, out, read = tier['input'], tier['output'], tier['cache_read']
            return {'input': inp, 'output': out, 'cacheRead': read,
                    'cacheWrite5m': inp * prices.get('cache_write_5m', 1.25),
                    'cacheWrite1h': inp * prices.get('cache_write_1h', 2.0)}
    return None


def prompt_of(counts):
    return counts['input'] + counts['cacheRead'] + counts['cacheWrite5m'] + counts['cacheWrite1h']


def cost_of(entry, prices):
    """USD per field for one response, or None when unpriced."""
    price = price_of(entry['model'], prompt_of(entry['counts']), prices)
    if price is None:
        return None
    rate = prices.get('fast', {}).get('multiplier', 2.0) if entry.get('isFast') else 1.0
    return {f: entry['counts'][f] * price[f] / 1e6 * rate for f in FIELDS}


# ---------- transcripts ----------

def parse_iso(text):
    return datetime.datetime.fromisoformat(text.replace('Z', '+00:00')).astimezone()


def usage_of(usage):
    created = usage.get('cache_creation') or {}
    write_total = usage.get('cache_creation_input_tokens') or 0
    write_1h = created.get('ephemeral_1h_input_tokens') or 0
    write_5m = created.get('ephemeral_5m_input_tokens')
    if write_5m is None:
        write_5m = max(0, write_total - write_1h)
    return {'input': usage.get('input_tokens') or 0, 'output': usage.get('output_tokens') or 0,
            'cacheRead': usage.get('cache_read_input_tokens') or 0,
            'cacheWrite5m': write_5m, 'cacheWrite1h': write_1h}


def _transcripts(root, sessions=None):
    for folder, _, names in os.walk(root):
        for name in names:
            if name.endswith('.jsonl'):
                path = os.path.join(folder, name)
                # a session's transcript is <id>.jsonl, its subagents' sit under <id>/subagents/
                parts = os.path.relpath(path, root).split(os.sep)
                if sessions is None or name[:-len('.jsonl')] in sessions or sessions.intersection(parts[:-1]):
                    yield path


def collect(projects_root, sessions=None):
    """seen = {(message.id, requestId): {model, moment, isFast, counts, file}}."""
    seen = {}
    for path in _transcripts(projects_root, sessions):
        try:
            handle = open(path, 'rb')
        except OSError:
            continue
        with handle:
            for raw in handle:
                if b'"usage"' not in raw or b'"assistant"' not in raw:
                    continue
                try:
                    row = json.loads(raw)
                except ValueError:
                    continue
                if not isinstance(row, dict) or row.get('type') != 'assistant':
                    continue
                message = row.get('message') or {}
                usage = message.get('usage')
                model = message.get('model') or ''
                stamp = row.get('timestamp')
                if not isinstance(usage, dict) or not stamp or model.startswith('<'):
                    continue
                try:
                    moment = parse_iso(stamp)
                except ValueError:
                    continue
                key = (message.get('id'), row.get('requestId'))
                counts = usage_of(usage)
                held = seen.get(key)
                if held is None:
                    seen[key] = {'model': model, 'moment': moment, 'isFast': usage.get('speed') == 'fast', 'counts': counts,
                                 'file': path}
                else:
                    for f in FIELDS:
                        held['counts'][f] = max(held['counts'][f], counts[f])
    return seen
