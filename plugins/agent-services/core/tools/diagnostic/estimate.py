"""build_request(): the one aggregate the free diagnostic sends for its estimate (POST /diagnostic/estimate).

Offline and standard library only, like the rest of tools/diagnostic: it only reshapes the scan() facts into counts
and dollar totals. No session or project hashes, no per-day rows, no paths, names or text. The estimate itself is
computed on our server; the online send is host/diagnostic.py (through the connector), not this package.
"""
from .payload import CLIENT_VERSION

SCHEMA = 'diag-est-1'
HARNESS = 'claude-code'
MAX_MODELS = 40
BUCKETS = 14
TOKEN_FIELDS = ('input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens')


class NoData(ValueError):
    """The facts hold no model response, so there is nothing to estimate."""


def _side():
    return {'input_tokens': 0, 'output_tokens': 0, 'cache_read_tokens': 0, 'cache_write_tokens': 0,
            'api_usd': 0.0, 'responses': 0}


def _add(into, side):
    for k in TOKEN_FIELDS + ('api_usd', 'responses'):
        into[k] += side[k]


def _by_model(facts):
    models = {}
    for day in sorted(facts['by_day']):
        for model, b in facts['by_day'][day]['by_model'].items():
            r, mr = b['responses'], b['main_responses']
            row = models.setdefault(model, {'main': _side(), 'subagents': _side()})
            main, sub = row['main'], row['subagents']
            for k in TOKEN_FIELDS:
                part = b[k] * mr // r if r else 0
                main[k] += part
                sub[k] += b[k] - part
            usd = b['api_usd'] * mr / r if r else 0.0
            main['api_usd'] += usd
            sub['api_usd'] += b['api_usd'] - usd
            main['responses'] += mr
            sub['responses'] += b['subagent_responses']
    if len(models) > MAX_MODELS:
        ranked = sorted(models, key=lambda m: (-(models[m]['main']['api_usd'] + models[m]['subagents']['api_usd']), m))
        keep = [m for m in ranked[:MAX_MODELS - 1] if m != 'other']
        merged = {'main': _side(), 'subagents': _side()}
        for m in models:
            if m not in keep:
                _add(merged['main'], models[m]['main'])
                _add(merged['subagents'], models[m]['subagents'])
        models = {m: models[m] for m in keep}
        models['other'] = merged
    out = []
    for model in sorted(models):
        row = models[model]
        for side in (row['main'], row['subagents']):
            side['api_usd'] = round(side['api_usd'], 6) + 0.0
        out.append({'model': model, 'main': row['main'], 'subagents': row['subagents']})
    return out


def _dispatches(facts):
    counts = {}
    for data in facts['by_day'].values():
        for word, n in data['dispatches_by_type'].items():
            counts[word] = counts.get(word, 0) + n
    rows = [(word, n) for word, n in counts.items() if n >= 1]
    rows.sort(key=lambda x: (-x[1], x[0]))
    return [{'type_word': word, 'count': n} for word, n in rows]


def _sessions(facts):
    rows = facts['sessions']['rows']
    hist = [0] * BUCKETS
    for row in rows:
        r = row['responses']
        if r >= 1:
            hist[min(BUCKETS - 1, r.bit_length() - 1)] += 1
    return {'count': facts['sessions']['count'], 'minutes_total': round(sum(r['minutes'] for r in rows), 1),
            'by_responses': hist}


def build_request(facts, client_version=CLIENT_VERSION):
    """The POST /diagnostic/estimate body for scan() facts (pure). NoData when there is no response at all."""
    if facts.get('first_day') is None:
        raise NoData('no model responses were found')
    comp = facts['compactions']
    return {'schema': SCHEMA, 'client_version': client_version, 'harness': HARNESS,
            'window': {'first_day': facts['first_day'], 'last_day': facts['last_day']},
            'by_model': _by_model(facts),
            'dispatches': _dispatches(facts),
            'compactions': {'total': comp['total'], 'manual': comp['manual'], 'auto': comp['auto']},
            'sessions': _sessions(facts)}
