"""scan(): the facts, in process only. Tokens and dollars come from the usage module (IMPL.collect, IMPL.cost_of);
a second light pass over the same files reads row timestamps, compact_boundary rows and Agent dispatches."""
import json
import os
import re
import statistics

from .seam import IMPL

MODEL_ID = re.compile(r'^claude-[a-z0-9.-]{1,60}$')

# public: common task words (one constant)
TYPE_WORDS = (
    '审查', '评审', '复审', '审阅', '重新规划', '规划', '计划', '验收', '默认', '实现', '修复', '测试', '调研', '搜索', '查',
    '写', '重构', '调试', '文档', '构建', '部署', '检查', '分析',
    'review', 'code-review', 'plan', 'replan', 'acceptance', 'default', 'implement', 'fix', 'test', 'research',
    'search', 'explore', 'write', 'refactor', 'debug', 'docs', 'build', 'deploy', 'check', 'analyze', 'investigate',
    'find', 'verify',
)
_BY_LENGTH = sorted(TYPE_WORDS, key=len, reverse=True)
SUBAGENT_TYPES = ('general-purpose', 'Explore', 'Plan', 'claude', 'fork', 'statusline-setup', 'claude-code-guide')
MODEL_WORDS = ('haiku', 'sonnet', 'opus', 'fable', 'inherit')
EFFORTS = ('low', 'medium', 'high', 'xhigh', 'max')
DISPATCH_TOOLS = ('Agent', 'Task')


# ---------- normalisation ----------

def norm_model(model):
    name = IMPL._bare(model) if isinstance(model, str) else ''
    return name if MODEL_ID.match(name) else 'other'


def type_word(description):
    text = description.strip().casefold() if isinstance(description, str) else ''
    for word in _BY_LENGTH:
        if not text.startswith(word):
            continue
        if word.isascii():
            rest = text[len(word):]
            if rest and (rest[0].isalnum() or rest[0] in '-_'):
                continue
        return word
    return 'other'


def _subagent_type(value):
    if value is None or value == '':
        return 'general-purpose'
    return value if value in SUBAGENT_TYPES else 'custom'


def _requested_model(value):
    if value is None or value == '':
        return 'none'
    if value in MODEL_WORDS:
        return value
    if isinstance(value, str) and value.startswith('claude-'):
        name = norm_model(value)
        if name != 'other':
            return name
    return 'other'


def _effort(value):
    if value is None or value == '':
        return 'none'
    return value if value in EFFORTS else 'other'


# ---------- buckets ----------

def _model_bucket():
    return {'input_tokens': 0, 'output_tokens': 0, 'cache_read_tokens': 0, 'cache_write_tokens': 0, 'tokens': 0,
            'api_usd': 0.0, 'responses': 0}


def _part():
    return {'tokens': 0, 'api_usd': 0.0, 'responses': 0}


def _bucket():
    return {'tokens': 0, 'cache_read_tokens': 0, 'api_usd': 0.0, 'responses': 0, 'main': _part(), 'subagents': _part()}


def _day():
    return {'by_model': {}, 'dispatches_by_type': {}, 'dispatches_by_model': {}, 'compactions': 0,
            'compactions_manual': 0, 'compactions_auto': 0}


def _add_model(bucket, c, tokens, usd):
    bucket['input_tokens'] += c['input']
    bucket['output_tokens'] += c['output']
    bucket['cache_read_tokens'] += c['cacheRead']
    bucket['cache_write_tokens'] += c['cacheWrite5m'] + c['cacheWrite1h']
    bucket['tokens'] += tokens
    bucket['api_usd'] += usd
    bucket['responses'] += 1


def _add_bucket(bucket, c, tokens, usd, side):
    bucket['tokens'] += tokens
    bucket['cache_read_tokens'] += c['cacheRead']
    bucket['api_usd'] += usd
    bucket['responses'] += 1
    part = bucket[side]
    part['tokens'] += tokens
    part['api_usd'] += usd
    part['responses'] += 1


# ---------- files ----------

def _place(path, root):
    """(project, session_id, is_subagent) of one transcript file."""
    parts = os.path.relpath(path, root).split(os.sep)
    project = parts[0] if len(parts) > 1 else ''
    if 'subagents' in parts[:-1]:
        at = parts.index('subagents')
        session = parts[at - 1] if at >= 1 else ''
        return project, session, True
    return project, parts[-1][:-len('.jsonl')], False


def _moment(row):
    stamp = row.get('timestamp')
    if not isinstance(stamp, str) or not stamp:
        return None
    try:
        return IMPL.parse_iso(stamp)
    except (ValueError, TypeError):
        return None


def _read(path, is_sub):
    """One light pass: (row moments [main files only], compactions, dispatch blocks)."""
    moments, compactions, dispatches = [], [], []
    try:
        handle = open(path, 'rb')
    except OSError:
        return moments, compactions, dispatches
    with handle:
        for order, raw in enumerate(handle):
            wanted = (not is_sub) or b'compact_boundary' in raw or b'tool_use' in raw
            if not wanted:
                continue
            try:
                row = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(row, dict):
                continue
            moment = _moment(row)
            if moment is not None and not is_sub:
                moments.append(moment)
            if row.get('type') == 'system' and row.get('subtype') == 'compact_boundary':
                meta = row.get('compactMetadata')
                trigger = meta.get('trigger') if isinstance(meta, dict) else None
                compactions.append((moment, trigger))
            if row.get('type') == 'assistant':
                message = row.get('message')
                content = message.get('content') if isinstance(message, dict) else None
                if isinstance(content, list):
                    for block in content:
                        if (isinstance(block, dict) and block.get('type') == 'tool_use'
                                and block.get('name') in DISPATCH_TOOLS):
                            dispatches.append((moment, order, block))
    return moments, compactions, dispatches


# ---------- scan ----------

def scan(projects_root, prices=None):
    if prices is None:
        prices = IMPL.load_prices()
    root = projects_root
    seen = IMPL.collect(root)

    totals, months, by_model, by_day = _bucket(), {}, {}, {}
    unpriced = set()
    days = []
    sub_files = {}

    def day_of(day):
        if day not in by_day:
            by_day[day] = _day()
        return by_day[day]

    place_cache = {}

    def place(path):
        if path not in place_cache:
            place_cache[path] = _place(path, root)
        return place_cache[path]

    main_responses = {}
    for entry in seen.values():
        model = norm_model(entry['model'])
        c = entry['counts']
        tokens = c['input'] + c['cacheWrite5m'] + c['cacheWrite1h'] + c['output']
        cost = IMPL.cost_of(entry, prices)
        if cost is None:
            unpriced.add(model)
            usd = 0.0
        else:
            usd = sum(cost.values())
        project, session, is_sub = place(entry['file'])
        side = 'subagents' if is_sub else 'main'
        moment = entry['moment']
        day, month = moment.date().isoformat(), moment.strftime('%Y-%m')
        days.append(day)
        _add_bucket(totals, c, tokens, usd, side)
        if month not in months:
            months[month] = dict(_bucket(), by_model={})
        _add_bucket(months[month], c, tokens, usd, side)
        _add_model(months[month]['by_model'].setdefault(model, _model_bucket()), c, tokens, usd)
        _add_model(by_model.setdefault(model, _model_bucket()), c, tokens, usd)
        daily = day_of(day)['by_model'].setdefault(model, dict(_model_bucket(), main_responses=0, subagent_responses=0))
        _add_model(daily, c, tokens, usd)
        daily['subagent_responses' if is_sub else 'main_responses'] += 1
        if not is_sub:
            main_responses[(project, session)] = main_responses.get((project, session), 0) + 1

    files = list(IMPL._transcripts(root))
    compactions = {'total': 0, 'manual': 0, 'auto': 0, 'by_month': {}}
    session_rows, session_compactions = {}, {}
    raw_dispatches, seen_blocks = [], set()
    subagent_count = 0
    for path in files:
        project, session, is_sub = place(path)
        key = (project, session)
        moments, comps, disp = _read(path, is_sub)
        if is_sub:
            subagent_count += 1
            sub_files[key] = sub_files.get(key, 0) + 1
        else:
            first = min(moments) if moments else None
            minutes = 0
            if len(moments) >= 2:
                minutes = round((max(moments) - first).total_seconds() / 60, 1)
            session_rows[key] = {'session_id': session, 'project': project,
                                 'month': first.strftime('%Y-%m') if first else None, 'minutes': minutes,
                                 'responses': main_responses.get(key, 0)}
        for moment, trigger in comps:
            compactions['total'] += 1
            session_compactions[key] = session_compactions.get(key, 0) + 1
            kind = trigger if trigger in ('manual', 'auto') else None
            if kind:
                compactions[kind] += 1
            if moment is not None:
                month = moment.strftime('%Y-%m')
                compactions['by_month'][month] = compactions['by_month'].get(month, 0) + 1
                daily = day_of(moment.date().isoformat())
                daily['compactions'] += 1
                if kind:
                    daily['compactions_' + kind] += 1
        for moment, order, block in disp:
            block_id = block.get('id')
            if block_id is not None:
                if block_id in seen_blocks:
                    continue
                seen_blocks.add(block_id)
            if moment is None:
                continue
            raw_dispatches.append((moment, path, order, project, session, block))

    rows = []
    for key, row in session_rows.items():
        row['subagents'] = sub_files.get(key, 0)
        row['compactions'] = session_compactions.get(key, 0)
        rows.append(row)
    rows.sort(key=lambda r: (r['month'] or '', r['project'], r['session_id']))
    lengths = [r['minutes'] for r in rows]

    raw_dispatches.sort(key=lambda d: (d[0], d[1], d[2]))
    dispatches, numbers = [], {}
    for moment, _, _, project, session, block in raw_dispatches:
        data = block.get('input') if isinstance(block.get('input'), dict) else {}
        desc = data.get('description')
        numbers[(project, session)] = numbers.get((project, session), 0) + 1
        row = {'session_id': session, 'project': project, 'day': moment.date().isoformat(),
               'type_word': type_word(desc), 'subagent_type': _subagent_type(data.get('subagent_type')),
               'requested_model': _requested_model(data.get('model')),
               'requested_effort': _effort(data.get('effort')),
               'desc_len': len(desc) if isinstance(desc, str) else 0, 'dispatch_no': numbers[(project, session)]}
        dispatches.append(row)
        daily = day_of(row['day'])
        daily['dispatches_by_type'][row['type_word']] = daily['dispatches_by_type'].get(row['type_word'], 0) + 1
        daily['dispatches_by_model'][row['requested_model']] = (
            daily['dispatches_by_model'].get(row['requested_model'], 0) + 1)

    return {
        'transcripts': len(files),
        'first_day': min(days) if days else None,
        'last_day': max(days) if days else None,
        'totals': totals,
        'months': dict(sorted(months.items())),
        'by_model': dict(sorted(by_model.items())),
        'by_day': dict(sorted(by_day.items())),
        'compactions': dict(compactions, by_month=dict(sorted(compactions['by_month'].items()))),
        'sessions': {'count': len(rows), 'median_minutes': statistics.median(lengths) if lengths else 0,
                     'max_minutes': max(lengths) if lengths else 0, 'subagents': subagent_count, 'rows': rows},
        'dispatches': dispatches,
        'unpriced': sorted(unpriced),
    }
