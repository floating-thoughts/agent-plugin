"""build_payload(): the consented structured records (daily aggregate, router record, sessions).
Only normalised values and salted hashes; it is never sent (send() refuses)."""
import datetime
import hashlib
import hmac
import os
import secrets

CLIENT_VERSION = '0.1.0'
SCHEMA = 'diag-1'
HARNESS = 'claude-code'


def default_salt():
    return os.path.join(os.path.expanduser('~'), '.agent-diagnostic', 'salt')


class SendDisabled(RuntimeError):
    """Sending is not available yet; this never touches the network."""


def send(payload):
    raise SendDisabled('sending is not available yet; nothing was sent')


def load_salt(path=None):
    path = path or default_salt()
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, 'w', encoding='ascii', newline='\n') as handle:
            handle.write(secrets.token_hex(32))
    with open(path, encoding='ascii') as handle:
        text = handle.read().strip()
    if len(text) != 64:
        raise ValueError('salt file must hold 64 hex characters')
    return bytes.fromhex(text)


def ref(salt, kind, value):
    return hmac.new(salt, f'{kind}:{value}'.encode(), hashlib.sha256).hexdigest()[:16]


def build_payload(facts, salt, today=None):
    today = today or datetime.date.today()
    today = today.isoformat() if hasattr(today, 'isoformat') else str(today)
    metrics = []
    for day, data in sorted(facts['by_day'].items()):
        by_model = [{'model': model, 'input_tokens': b['input_tokens'], 'output_tokens': b['output_tokens'],
                     'cache_read_tokens': b['cache_read_tokens'], 'cache_write_tokens': b['cache_write_tokens'],
                     'api_usd': round(b['api_usd'], 6), 'main_responses': b['main_responses'],
                     'subagent_responses': b['subagent_responses']}
                    for model, b in sorted(data['by_model'].items())]
        counters = {'dispatches_by_type': dict(sorted(data['dispatches_by_type'].items())),
                    'dispatches_by_model': dict(sorted(data['dispatches_by_model'].items())),
                    'compactions': data['compactions'], 'compactions_manual': data['compactions_manual'],
                    'compactions_auto': data['compactions_auto']}
        metrics.append({'day': day, 'by_model': by_model, 'counters': counters})
    router = [{'session_ref': ref(salt, 'session', d['session_id']), 'type_word': d['type_word'],
               'subagent_type': d['subagent_type'], 'requested_model': d['requested_model'],
               'requested_effort': d['requested_effort'], 'harness': HARNESS, 'desc_len': d['desc_len'],
               'dispatch_no': d['dispatch_no'], 'project_hash': ref(salt, 'project', d['project']), 'day': d['day']}
              for d in facts['dispatches']]
    sessions = [{'session_ref': ref(salt, 'session', s['session_id']), 'project_hash': ref(salt, 'project', s['project']),
                 'month': s['month'], 'minutes': s['minutes'], 'responses': s['responses'],
                 'subagents': s['subagents'], 'compactions': s['compactions']}
                for s in facts['sessions']['rows']]
    return {'schema': SCHEMA, 'client_version': CLIENT_VERSION, 'harness': HARNESS, 'generated_day': today,
            'window': {'first_day': facts['first_day'], 'last_day': facts['last_day']},
            'metrics': metrics, 'router': router, 'sessions': sessions}
