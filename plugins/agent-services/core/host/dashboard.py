"""The customer dashboard: numbers-only facts about this customer's own use, and the page that shows them.

  collect(data_dir, *, status=None, savings=None, report=None, now=None) -> dict
  render(data, template_path) -> str
  write(data_dir, template_path, data=None) -> (path, changed)

collect reads only local files under the data dir (the savings event log, the connector settings and log, the cached
estimate). What only the daemon knows is passed in by the caller, as the daemon answered it:
`status` = GET /local/status, `savings` = GET /local/metrics/savings, `report` = GET /local/metrics/report.
Every part that cannot be worked out is None; nothing here raises on missing or malformed input.
No text from a session, no path, id or host name goes into the result. Standard library only.
Fixed: collect never raises and returns only numbers, dates and fixed names; render escapes <, > and & in the
data slot; write compares ignoring generated_at and replaces the page atomically.
"""
from __future__ import annotations

import json
import math
import os
import re
import tempfile
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

VERSION = 1
LOG_TAIL_BYTES = 262144   # how much of the end of connector.log is read for the latest served fetch
_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_SLOT = re.compile(r'(<script type="application/json" id="data">)(.*?)(</script>)', re.S)
_COUNT_KINDS = {"route": "routed", "compact_start": "compactions", "index": "indexed_reads"}
LEVERS = ("route", "compact", "index")


# ------------------------------------------------------------------ small readers

def _num(v):
    """A finite int or float (not bool), else None."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    if isinstance(v, float) and not math.isfinite(v):
        return None
    return v


def _count(v):
    v = _num(v)
    return int(v) if v is not None and v >= 0 and v == int(v) else None


def _day(v):
    return v if isinstance(v, str) and _DAY.match(v) else None


def _json_file(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeDecodeError):
        return None


def _local_day(ts) -> str | None:
    if not isinstance(ts, str):
        return None
    try:
        t = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    return t.astimezone().date().isoformat()


def _services_dir(data_dir) -> Path:
    return Path(data_dir) / "services"


# ------------------------------------------------------------------ parts

def _events(data_dir, today: str):
    """-> (counts, guard_blocks, active local days); counts/guard None when there is no readable log."""
    path = _services_dir(data_dir) / "savings-events.jsonl"
    try:
        handle = open(path, "rb")
    except OSError:
        return None, None, set()
    zero = {name: 0 for name in _COUNT_KINDS.values()}
    counts = {"today": dict(zero), "all_time": dict(zero)}
    guard = {"today": 0, "all_time": 0}
    guard_seen = False
    days: set[str] = set()
    with handle:
        for raw in handle:
            try:
                e = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(e, dict):
                continue
            day = _local_day(e.get("ts"))
            kind = e.get("kind")
            if day is None or not isinstance(kind, str):
                continue
            days.add(day)
            if kind in _COUNT_KINDS:
                name = _COUNT_KINDS[kind]
                counts["all_time"][name] += 1
                if day == today:
                    counts["today"][name] += 1
            elif kind == "guard_block":
                guard_seen = True
                guard["all_time"] += 1
                if day == today:
                    guard["today"] += 1
    return counts, (guard if guard_seen else None), days


def _settings(data_dir) -> dict | None:
    d = _json_file(_services_dir(data_dir) / "settings.json")
    return d if isinstance(d, dict) else None


def _account(status) -> dict | None:
    if not isinstance(status, dict):
        return None
    signed_in = status.get("logged_in")
    plan = status.get("plan")
    exp = _num(status.get("expires_at"))
    until = None
    if exp is not None:
        try:
            until = datetime.fromtimestamp(exp, timezone.utc).date().isoformat()
        except (OverflowError, OSError, ValueError):
            until = None
    return {"signed_in": signed_in if isinstance(signed_in, bool) else None,
            "plan": plan if plan in ("diagnostic", "guard", "full") else None,
            "license_until": until}


def _services(status, settings) -> dict | None:
    flags = None
    ok = None
    if isinstance(status, dict) and isinstance(status.get("services"), dict):
        flags = status["services"]
        gate = status.get("gate") if isinstance(status.get("gate"), dict) else {}
        ok = (status.get("logged_in") is True and gate.get("open") is not False
              and status.get("offline") is not True and not status.get("blocked"))
    elif settings and isinstance(settings.get("services"), dict):
        flags = settings["services"]
    if not flags:
        return None
    out = {}
    for name, on in sorted(flags.items()):
        if isinstance(name, str) and re.match(r"^[a-z][a-z0-9_]{0,31}$", name) and isinstance(on, bool):
            out[name] = {"on": on, "healthy": (on and ok) if ok is not None else None}
    return out or None


def _metrics_on(status, settings):
    for src in (status, settings):
        if isinstance(src, dict) and isinstance(src.get("services"), dict):
            v = src["services"].get("metrics")
            if isinstance(v, bool):
                return v
    return None


def _savings(savings) -> dict | None:
    if not isinstance(savings, dict) or "error" in savings or _num(savings.get("usd")) is None:
        return None
    levers = {}
    for name in LEVERS:
        lv = savings.get(name) if isinstance(savings.get(name), dict) else {}
        levers[name] = {"usd": _num(lv.get("usd")), "runs": _count(lv.get("runs"))}
    by_day = []
    for row in savings.get("by_day") or []:
        if not isinstance(row, dict) or _day(row.get("day")) is None:
            continue
        by_day.append({"day": row["day"], "usd": _num(row.get("usd")), "api_usd": _num(row.get("api_usd")),
                       **{f"{n}_usd": _num(row.get(f"{n}_usd")) for n in LEVERS}})
    by_day.sort(key=lambda r: r["day"])
    return {"usd": _num(savings.get("usd")), "pct": _num(savings.get("pct")), "api_usd": _num(savings.get("api_usd")),
            "first_day": _day(savings.get("first_day")), "last_day": _day(savings.get("last_day")),
            "days": _count(savings.get("days")), "levers": levers, "by_day": by_day}


def _peer(report):
    """-> (median pct, peers) from the report's peer_saved line, or (None, None)."""
    if not isinstance(report, dict) or not isinstance(report.get("lines"), list):
        return None, None
    for line in report["lines"]:
        if isinstance(line, dict) and line.get("id") == "peer_saved" and isinstance(line.get("values"), dict):
            return _num(line["values"].get("peer_pct")), _count(line["values"].get("peers"))
    return None, None


def _weeks(sav, today: str):
    """-> (this 7 days usd, the 7 before usd) from by_day, or (None, None)."""
    if not sav or not sav["by_day"]:
        return None, None
    t = date.fromisoformat(today)
    cut1 = (t - timedelta(days=6)).isoformat()
    cut2 = (t - timedelta(days=13)).isoformat()
    this = sum(r["usd"] or 0 for r in sav["by_day"] if cut1 <= r["day"] <= today)
    last = sum(r["usd"] or 0 for r in sav["by_day"] if cut2 <= r["day"] < cut1)
    if not any(cut2 <= r["day"] < cut1 for r in sav["by_day"]):
        last = None
    return round(this, 6), (round(last, 6) if last is not None else None)


def _comparison(sav, report, today: str) -> dict | None:
    peer_pct, peers = _peer(report)
    this, last = _weeks(sav, today)
    if peer_pct is None and this is None:
        return None
    change = None
    if this is not None and last not in (None, 0):
        change = round((this - last) / abs(last), 4)
    return {"your_pct": sav["pct"] if sav else None, "peer_median_pct": peer_pct, "peers": peers,
            "this_week_usd": this, "last_week_usd": last, "week_change": change}


_EST_KEYS = {"low_usd": ("low_usd", "usd_low", "low"), "high_usd": ("high_usd", "usd_high", "high"),
             "pct_low": ("pct_low", "low_pct"), "pct_high": ("pct_high", "high_pct"),
             "period_days": ("period_days", "days"), "basis_days": ("basis_days", "sample_days")}


def _estimate(data_dir) -> dict | None:
    d = _json_file(_services_dir(data_dir) / "estimate.json")
    if not isinstance(d, dict):
        return None
    src = d.get("estimate") if isinstance(d.get("estimate"), dict) else d
    out = {}
    for key, names in _EST_KEYS.items():
        out[key] = next((_num(src.get(n)) for n in names if _num(src.get(n)) is not None), None)
    made = src.get("made_at", d.get("made_at"))
    out["made_on"] = _local_day(made) if isinstance(made, str) else None
    if out["low_usd"] is None and out["high_usd"] is None and out["pct_low"] is None and out["pct_high"] is None:
        return None
    return out


def _guidance(data_dir, settings) -> dict | None:
    path = _services_dir(data_dir) / "connector.log"
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - LOG_TAIL_BYTES))
            tail = f.read()
    except OSError:
        return None
    found = None
    for raw in tail.splitlines():
        try:
            rec = json.loads(raw)
        except ValueError:
            continue
        if isinstance(rec, dict) and rec.get("event") == "served_fetch":
            found = rec
    if found is None:
        return None
    version = found.get("version")
    channel = (settings or {}).get("served", {}).get("channel") if isinstance((settings or {}).get("served"), dict) \
        else None
    return {"role": found.get("role") if found.get("role") in ("control", "auto", "plugin") else None,
            "version": version if isinstance(version, str) and re.match(r"^[0-9][0-9A-Za-z.+-]{0,31}$", version)
            else None,
            "items": _count(found.get("items")),
            "channel": channel if channel in ("stable", "beta") else None,
            "last_used": _local_day(found.get("ts"))}


def _activity(days: set, sav, today: str) -> dict | None:
    days = set(days)
    if sav:
        for r in sav["by_day"]:
            if (r["api_usd"] or 0) > 0 or (r["usd"] or 0) != 0:
                days.add(r["day"])
    first = min(days) if days else None
    if sav and sav["first_day"] and (first is None or sav["first_day"] < first):
        first = sav["first_day"]
    if first is None:
        return None
    t = date.fromisoformat(today)
    cur = t if today in days else t - timedelta(days=1)
    streak = 0
    while cur.isoformat() in days:
        streak += 1
        cur -= timedelta(days=1)
    return {"first_seen": first, "streak_days": streak, "active_days": len(days),
            "active_today": today in days}


# ------------------------------------------------------------------ public

def collect(data_dir, *, status=None, savings=None, report=None, now=None) -> dict:
    """Numbers-only facts about this customer's own use; each part that cannot be worked out is None."""
    t = now if _num(now) is not None else time.time()
    today = datetime.fromtimestamp(t).date().isoformat()
    out = {"v": VERSION,
           "generated_at": datetime.fromtimestamp(t, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
           "today": today}
    parts = {"account": None, "services": None, "metrics_on": None, "savings": None, "counts": None,
             "guard_blocks": None, "guidance": None, "comparison": None, "estimate": None, "activity": None}
    out.update(parts)
    if data_dir is None:
        return out

    def safe(fn, *a):
        try:
            return fn(*a)
        except Exception:  # noqa: BLE001 - one bad part leaves that part None, never the whole page
            return None

    settings = safe(_settings, data_dir)
    ev = safe(_events, data_dir, today) or (None, None, set())
    sav = safe(_savings, savings)
    out.update(account=safe(_account, status), services=safe(_services, status, settings),
               metrics_on=safe(_metrics_on, status, settings), savings=sav, counts=ev[0], guard_blocks=ev[1],
               guidance=safe(_guidance, data_dir, settings), comparison=safe(_comparison, sav, report, today),
               estimate=safe(_estimate, data_dir), activity=safe(_activity, ev[2], sav, today))
    return out


def _encode(data) -> str:
    """JSON that cannot leave a <script> element: <, >, & and the line separators become \\u escapes."""
    text = json.dumps(data, ensure_ascii=True, separators=(",", ":"), sort_keys=True, allow_nan=False)
    return text.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


def render(data, template_path) -> str:
    """The template with its data slot filled; raises ValueError when the template has no slot."""
    template = Path(template_path).read_text(encoding="utf-8")
    payload = _encode(data)
    html, n = _SLOT.subn(lambda m: m.group(1) + payload + m.group(3), template, count=1)
    if n != 1:
        raise ValueError("template has no data slot")
    return html


def _stable(html: str) -> str:
    """The page with generated_at taken out of its data, for comparing two renders."""
    def strip(m):
        try:
            d = json.loads(m.group(2))
        except ValueError:
            return m.group(0)
        if isinstance(d, dict):
            d.pop("generated_at", None)
        return m.group(1) + _encode(d) + m.group(3)
    return _SLOT.sub(strip, html, count=1)


def dashboard_path(data_dir) -> Path:
    return Path(data_dir) / "dashboard" / "index.html"


def write(data_dir, template_path, data=None) -> tuple[Path, bool]:
    """Render to <data dir>/dashboard/index.html atomically (temp file + replace). changed is False, and the file
    is left as it is, when the new page differs from the old one only in generated_at."""
    if data is None:
        data = collect(data_dir)
    html = render(data, template_path)
    path = dashboard_path(data_dir)
    try:
        old = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        old = None
    if old is not None and _stable(old) == _stable(html):
        return path, False
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".index.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(html)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return path, True
