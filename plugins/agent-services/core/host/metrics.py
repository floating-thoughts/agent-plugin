"""Metrics upload, client side: the daily body builder, the uploader and its CLI.

  python -m host.metrics <preview [--day D]|on|off|tick|status|report|savings|delete> --data-dir D
                         [--keystore os|memory] [--allow-plain-loopback]

The body holds numbers, normalised model ids and salted hashes only. Usage figures come from the usage module
(through tools.diagnostic, the same numbers as usage.json); the `savings` part is raw counters read from the local
event log that the plugin writes. The amounts are worked out by the server; this file only counts.
"""
from __future__ import annotations

import contextlib
import json
import os
import re
import sys
import threading
import time
from datetime import date, datetime, timedelta
from pathlib import Path

from host.services import Result, services_dir
from tools.diagnostic.facts import _place, norm_model, scan
from tools.diagnostic.payload import load_salt, ref
from tools.diagnostic.seam import IMPL

CLIENT_VERSION = "0.1.0"
BACKFILL_DAYS = 30
EVENTS_KEEP_DAYS = 60
TICK_SECONDS = 3600
HARNESS = "claude-code"
BODY_BYTES = 65536
MAX_TASK_ROWS = 500
# the contract's array caps (host/service_api.json): rows past them are left out rather than failing the day
MAX_ROUTE_ROWS, MAX_INDEX_ROWS, MAX_COMPACT_ROWS, MAX_STEPS, MAX_STEP_MODELS = 100, 500, 50, 4000, 10
KINDS = {"auto": "auto", "orchestrator": "auto", "direct": "direct"}
_REF = re.compile(r"^[0-9a-f]{16}$")
_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class BodyTooLarge(ValueError):
    """The day's body does not fit the 65 536-byte limit even without by_task rows."""


def events_path(data_dir) -> Path:
    return services_dir(data_dir) / "savings-events.jsonl"


def salt_path(data_dir) -> Path:
    return services_dir(data_dir) / "metrics_salt"


def state_path(data_dir) -> Path:
    return services_dir(data_dir) / "metrics_state.json"


def default_projects_root() -> Path:
    env = os.environ.get("AGENT_SVC_PROJECTS_DIR")
    if env:
        return Path(env)
    cfg = os.environ.get("CLAUDE_CONFIG_DIR")
    if cfg:
        return Path(cfg) / "projects"
    return Path.home() / ".claude" / "projects"


def _salt(data_dir) -> bytes:
    p = salt_path(data_dir)
    fresh = not p.exists()
    salt = load_salt(str(p))
    if fresh:
        try:
            from host.httpbase import restrict_file
            restrict_file(p)
        except Exception:  # noqa: BLE001 — best effort, as for the other secrets
            pass
    return salt


# ------------------------------------------------------------------ event log

def _count(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and v >= 0


def _opt_count(v) -> bool:
    return v is None or _count(v)


def _opt_amount(v) -> bool:
    return v is None or (isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0)


_FIELDS = {
    "route": {"model": str, "input": _count, "output": _count, "cache_read": _count, "cache_write": _count},
    "index": {"model": str, "file_tokens": _count},
    "compact_start": {"ref": "ref", "model": str, "before": _count, "after": _opt_count, "window": _count,
                      "threshold": _opt_count, "compact_usd": _opt_amount},
    "compact_step": {"ref": "ref", "model": str, "context": _count},
}


def _event(line: bytes):
    """-> (moment, event dict) or None when the line is to be skipped."""
    try:
        e = json.loads(line)
    except ValueError:
        return None
    if not isinstance(e, dict):
        return None
    fields = _FIELDS.get(e.get("kind"))
    ts = e.get("ts")
    if fields is None or not isinstance(ts, str):
        return None
    try:
        moment = IMPL.parse_iso(ts)
    except (ValueError, TypeError):
        return None
    for name, check in fields.items():
        if name not in e:
            return None
        v = e[name]
        if check is str:
            ok = isinstance(v, str)
        elif check == "ref":
            ok = isinstance(v, str) and bool(_REF.match(v))
        else:
            ok = check(v)
        if not ok:
            return None
    out = {k: e[k] for k in fields}
    out["kind"] = e["kind"]
    out["model"] = norm_model(e["model"])
    return moment, out


def read_events(path) -> list[tuple[str, dict]]:
    """[(local day, moment, event)] in file order; bad lines skipped."""
    out = []
    try:
        handle = open(path, "rb")
    except OSError:
        return out
    with handle:
        for raw in handle:
            ev = _event(raw)
            if ev is not None:
                out.append((ev[0].date().isoformat(), ev[0], ev[1]))
    return out


@contextlib.contextmanager
def events_lock(path, timeout: float = 10.0):
    """Cross-process lock on <events file>.lock, shared by the pruner and every writer, so a prune never drops a line appended
    while it ran, and on Windows never replaces a file another writer holds open (review chunk 6 L4)."""
    lp = Path(str(path) + ".lock")
    lp.parent.mkdir(parents=True, exist_ok=True)
    f = open(lp, "a+b")
    deadline = time.monotonic() + timeout
    try:
        while True:
            try:
                if os.name == "nt":
                    import msvcrt
                    f.seek(0)
                    msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() > deadline:
                    raise TimeoutError(f"{lp} busy") from None
                time.sleep(0.02)
        try:
            yield
        finally:
            if os.name == "nt":
                import msvcrt
                f.seek(0)
                msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(f.fileno(), fcntl.LOCK_UN)
    finally:
        f.close()


def prune_events(path, cutoff: float) -> int:
    """Drop lines whose ts is older than `cutoff` (unix seconds); other lines stay as they are. Holds events_lock; a failure to
    lock or replace is logged and returns 0, so the caller's upload still runs."""
    try:
        with events_lock(path):
            return _prune_events(Path(path), cutoff)
    except (OSError, TimeoutError) as e:
        sys.stderr.write(f"metrics: pruning {path} skipped: {type(e).__name__}\n")
        return 0


def _prune_events(p: Path, cutoff: float) -> int:
    try:
        lines = p.read_bytes().splitlines(keepends=True)
    except OSError:
        return 0
    keep, dropped = [], 0
    for raw in lines:
        try:
            e = json.loads(raw)
            moment = IMPL.parse_iso(e["ts"]) if isinstance(e, dict) and isinstance(e.get("ts"), str) else None
        except (ValueError, TypeError, KeyError):
            moment = None
        if moment is not None and moment.timestamp() < cutoff:
            dropped += 1
            continue
        keep.append(raw)
    if dropped:
        tmp = p.with_suffix(".tmp")
        tmp.write_bytes(b"".join(keep))
        os.replace(tmp, p)
    return dropped


def _long(model: str, prompt: int, prices: dict) -> bool:
    name = IMPL._bare(model)
    return any(IMPL._matches(name, t["prefix"]) and prompt > t["over"] for t in prices.get("long_prompt", []))


def _counters(events, day: str, prices: dict) -> dict:
    route: dict[tuple, dict] = {}
    index: dict[tuple, int] = {}
    compact: dict[str, dict] = {}
    todays = [(m, i, e) for i, (d, m, e) in enumerate(events) if d == day]
    for _, _, e in todays:
        k = e["kind"]
        if k == "route":
            prompt = e["input"] + e["cache_read"] + e["cache_write"]
            key = (e["model"], _long(e["model"], prompt, prices))
            r = route.setdefault(key, {"model": key[0], "long": key[1], "turns": 0, "input_tokens": 0,
                                       "output_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0})
            r["turns"] += 1
            r["input_tokens"] += e["input"]
            r["output_tokens"] += e["output"]
            r["cache_read_tokens"] += e["cache_read"]
            r["cache_write_tokens"] += e["cache_write"]
        elif k == "index":
            key = (e["model"], e["file_tokens"])
            index[key] = index.get(key, 0) + 1
        elif k == "compact_start":
            c = compact.setdefault(e["ref"], {"start": None, "steps": []})
            if c["start"] is None:
                c["start"] = {"model": e["model"], "before_tokens": e["before"], "after_tokens": e["after"],
                              "window_tokens": e["window"], "threshold_tokens": e["threshold"],
                              "compact_usd": e["compact_usd"]}
        else:
            compact.setdefault(e["ref"], {"start": None, "steps": []})
    steps = sorted(((m, i, e) for m, i, e in todays if e["kind"] == "compact_step"), key=lambda x: (x[0], x[1]))
    for _, _, e in steps:
        compact[e["ref"]]["steps"].append((e["context"], e["model"]))
    rows = []
    for r in sorted(compact):
        c = compact[r]
        models: list[str] = []
        pairs = []
        for context, model in c["steps"]:
            if len(pairs) >= MAX_STEPS:
                break
            if model not in models:
                if len(models) >= MAX_STEP_MODELS:
                    continue
                models.append(model)
            pairs.append([context, models.index(model)])
        rows.append({"ref": r, "start": c["start"], "models": models, "steps": pairs})
    return {"route": [route[k] for k in sorted(route)][:MAX_ROUTE_ROWS],
            "index": [{"model": m, "file_tokens": t, "reads": n}
                      for (m, t), n in sorted(index.items())][:MAX_INDEX_ROWS],
            "compact": rows[:MAX_COMPACT_ROWS]}


# ------------------------------------------------------------------ transcripts

class _Sources:
    """One read of the transcripts and the event log, shared by every day of a build or a tick."""

    def __init__(self, projects_root, events_file, prices):
        self.root = str(projects_root)
        self.prices = prices if prices is not None else IMPL.load_prices()
        self.facts = scan(self.root, self.prices)
        self.events = read_events(events_file) if events_file else []
        self.main_days: dict[str, set] = {}
        for entry in IMPL.collect(self.root).values():
            _, session, is_sub = _place(entry["file"], self.root)
            if not is_sub:
                self.main_days.setdefault(entry["moment"].date().isoformat(), set()).add(session)

    def active(self, day: str) -> bool:
        d = self.facts["by_day"].get(day)
        if d and d["by_model"]:
            return True
        if any(x["day"] == day for x in self.facts["dispatches"]):
            return True
        return any(e[0] == day for e in self.events)

    def body(self, day, salt, kinds, client_version) -> dict:
        by_model = []
        for model, b in sorted((self.facts["by_day"].get(day) or {"by_model": {}})["by_model"].items()):
            by_model.append({"model": model, "input_tokens": b["input_tokens"], "output_tokens": b["output_tokens"],
                             "cache_read_tokens": b["cache_read_tokens"],
                             "cache_write_tokens": b["cache_write_tokens"], "api_usd": round(b["api_usd"], 6)})
        groups: dict[tuple, int] = {}
        for d in self.facts["dispatches"]:
            if d["day"] == day:
                key = (d["type_word"], d["requested_model"], ref(salt, "project", d["project"]))
                groups[key] = groups.get(key, 0) + 1
        by_task = [{"task_type": t, "model": m, "project_hash": h, "count": n, "success": None, "fail": None,
                    "retry": None, "median_seconds": None}
                   for (t, m, h), n in sorted(groups.items(), key=lambda kv: (-kv[1], kv[0]))][:MAX_TASK_ROWS]
        per_kind: dict[str, int] = {}
        for session in self.main_days.get(day, ()):
            kind = KINDS.get((kinds or {}).get(session), "direct")
            per_kind[kind] = per_kind.get(kind, 0) + 1
        sessions = [{"kind": k, "harness": HARNESS, "count": n} for k, n in sorted(per_kind.items())]
        body = {"day": day, "client_version": client_version, "by_model": by_model, "by_task": by_task,
                "sessions": sessions, "savings": _counters(self.events, day, self.prices)}
        return _fit(body)


def _size(body) -> int:
    return len(json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def _fit(body: dict) -> dict:
    while _size(body) > BODY_BYTES:
        if not body["by_task"]:
            raise BodyTooLarge(f"metrics body for {body['day']} is over {BODY_BYTES} bytes")
        body["by_task"].pop()
    return body


def build_daily(day, *, projects_root, events_file=None, salt, prices=None, kinds=None,
                client_version=CLIENT_VERSION) -> dict:
    """The POST /metrics/daily body for one local day."""
    return _Sources(projects_root, events_file, prices).body(str(day), salt, kinds, client_version)


# ------------------------------------------------------------------ uploader

class _Clock:
    def now(self) -> float:
        import time
        return time.time()


def _plus(day: str, n: int) -> str:
    return (date.fromisoformat(day) + timedelta(days=n)).isoformat()


class Metrics:
    def __init__(self, connector, data_dir, *, projects_root, clock=None, prices=None, kinds=None,
                 client_version=CLIENT_VERSION, events_file=None):
        self.conn = connector
        self.data_dir = Path(data_dir)
        self.projects_root = projects_root
        self.clock = clock or getattr(connector, "clock", None) or _Clock()
        self.prices = prices
        self.kinds = kinds
        self.client_version = client_version
        self.events_file = Path(events_file) if events_file else events_path(self.data_dir)
        self._lock = threading.RLock()

    # ---- state
    def _today(self) -> str:
        return datetime.fromtimestamp(self.clock.now()).date().isoformat()

    def _yesterday(self) -> str:
        return _plus(self._today(), -1)

    def _state(self) -> dict:
        try:
            s = json.loads(state_path(self.data_dir).read_text(encoding="utf-8"))
            if isinstance(s, dict):
                return {k: s.get(k) for k in ("previewed_day", "enabled_day", "last_uploaded_day")}
        except (OSError, ValueError):
            pass
        return {"previewed_day": None, "enabled_day": None, "last_uploaded_day": None}

    def _save(self, **changes) -> None:
        s = self._state()
        s.update(changes)
        p = state_path(self.data_dir)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(s), encoding="utf-8")
        os.replace(tmp, p)

    def _sources(self) -> _Sources:
        return _Sources(self.projects_root, self.events_file, self.prices)

    def _on(self) -> bool:
        return self.conn.service_on("metrics")

    # ---- public
    def build(self, day: str, sources: _Sources | None = None) -> dict:
        return (sources or self._sources()).body(day, _salt(self.data_dir), self.kinds, self.client_version)

    def preview(self, day=None) -> str | None:
        with self._lock:
            day = str(day) if day else self._yesterday()
            text = self.conn.preview("POST", "/metrics/daily", self.build(day))
            if text is not None:
                self._save(previewed_day=day)
            return text

    def opt_in(self) -> dict:
        with self._lock:
            if not self._state()["previewed_day"]:
                return {"ok": False, "error": "preview_first"}
            self.conn.set_service("metrics", True)
            self._save(enabled_day=self._today())
            return {"ok": True, "error": None}

    def opt_out(self) -> dict:
        with self._lock:
            self.conn.set_service("metrics", False)
            return {"ok": True, "error": None}

    def status(self) -> dict:
        return {"on": self._on(), **self._state()}

    def tick(self) -> dict:
        if _gate_closed(self.conn):   # the shell gate is closed: read no source, write no state
            return {"skipped": "inactive"}
        with self._lock:
            prune_events(self.events_file, self.clock.now() - EVENTS_KEEP_DAYS * 86400)
            if not self._on():
                return {"sent": [], "error": "service_off"}
            if self.conn.offline:
                return {"sent": [], "error": "offline"}
            st = self._state()
            yesterday = self._yesterday()
            if st["last_uploaded_day"]:
                day = _plus(st["last_uploaded_day"], 1)
            else:
                day = _plus(st["enabled_day"] or self._today(), -BACKFILL_DAYS)
            sent: list[str] = []
            if day > yesterday:
                return {"sent": sent, "error": None}
            src = self._sources()
            skipped = None
            while day <= yesterday:
                if src.active(day):
                    if not self._on():
                        return {"sent": sent, "error": "service_off"}
                    try:
                        body = self.build(day, src)
                    except BodyTooLarge:
                        # would fail the same way every tick: leave the day out and go on
                        skipped = "too_large"
                        day = _plus(day, 1)
                        continue
                    res = self.conn.call("POST", "/metrics/daily", body)
                    if not res.ok:
                        return {"sent": sent, "error": res.error or "failed"}
                    sent.append(day)
                    self._save(last_uploaded_day=day)
                day = _plus(day, 1)
            self._save(last_uploaded_day=yesterday)
            return {"sent": sent, "error": skipped}

    def report(self) -> Result:
        return self.conn.call("GET", "/report")

    def savings(self) -> Result:
        if not self._on():
            return Result(ok=False, error="service_off")
        return self.conn.call("GET", "/metrics/savings")

    def delete(self) -> Result:
        with self._lock:
            res = self.conn.call("DELETE", "/metrics")
            if res.ok:
                self._save(last_uploaded_day=self._yesterday())
            return res


def _gate_closed(conn) -> bool:
    """A gated connector whose gate is closed; connectors without a gate count as open."""
    if not getattr(conn, "gate", False) or not hasattr(conn, "gate_state"):
        return False
    try:
        return not conn.gate_state()["open"]
    except Exception:  # noqa: BLE001
        return False


# ------------------------------------------------------------------ daemon routes and CLI

def _answer(r: Result) -> tuple[int, dict]:
    if r.ok:
        return 200, r.body if isinstance(r.body, dict) else {}
    return 200, {"error": r.error or "failed"}


def local_route(m: Metrics, method: str, path: str, body: dict) -> tuple[int, dict]:
    """The daemon's /local/metrics/... routes (connector token checked by the daemon)."""
    key = (method, path)
    if key == ("POST", "/local/metrics/preview"):
        day = body.get("day")
        if day is not None and not (isinstance(day, str) and _DAY.match(day)):
            return 400, {"error": "bad_request"}
        try:
            return 200, {"body_text": m.preview(day)}
        except BodyTooLarge:
            return 200, {"error": "too_large"}
    if key == ("POST", "/local/metrics/on"):
        return 200, m.opt_in()
    if key == ("POST", "/local/metrics/off"):
        return 200, m.opt_out()
    if key == ("POST", "/local/metrics/tick"):
        return 200, m.tick()
    if key == ("GET", "/local/metrics/status"):
        return 200, m.status()
    if key == ("GET", "/local/metrics/report"):
        return _answer(m.report())
    if key == ("GET", "/local/metrics/savings"):
        return _answer(m.savings())
    if key == ("POST", "/local/metrics/delete"):
        return _answer(m.delete())
    return 404, {"error": "not_found"}


def tick_loop(m: Metrics, stop: threading.Event, every: float = TICK_SECONDS) -> None:
    while not stop.wait(every):
        try:
            m.tick()
        except Exception:  # noqa: BLE001 — the next tick rebuilds from the sources
            pass


_CLI = {"preview": "POST", "on": "POST", "off": "POST", "tick": "POST", "status": "GET", "report": "GET",
        "savings": "GET", "delete": "POST"}


def main(argv=None) -> int:
    import argparse
    import http.client

    from host import services

    ap = argparse.ArgumentParser(prog="python -m host.metrics")
    ap.add_argument("cmd", choices=sorted(_CLI))
    ap.add_argument("--day")
    ap.add_argument("--data-dir")
    ap.add_argument("--keystore", choices=("os", "memory"), default="os")
    ap.add_argument("--allow-plain-loopback", action="store_true")
    a = ap.parse_args(argv)
    data_dir = Path(a.data_dir) if a.data_dir else services.default_data_dir()

    def out(obj, rc=0):
        print(json.dumps(obj, ensure_ascii=True))
        return rc

    try:
        services.ensure(data_dir, a.keystore, a.allow_plain_loopback)
    except RuntimeError as e:
        return out({"error": str(e)}, 1)
    body = None
    if _CLI[a.cmd] == "POST":
        body = {"day": a.day} if a.cmd == "preview" and a.day else {}
    try:
        st, ans = services._local(data_dir, _CLI[a.cmd], "/local/metrics/" + a.cmd, body)
    except (OSError, ValueError, KeyError, http.client.HTTPException):
        return out({"error": "connector_unreachable"}, 1)
    if st != 200 or not isinstance(ans, dict) or ans.get("error") is not None:
        err = ans.get("error") if isinstance(ans, dict) else None
        return out({"error": err or f"http_{st}"}, 1)
    return out(ans)


if __name__ == "__main__":
    sys.exit(main())
