"""The local savings event log writer: what the plugin hooks call (through the daemon's
POST /session/savings) to append the events host.metrics reads (the local savings event log).

Only raw counts are written; the amounts are worked out on the server. File text and session ids never reach disk:
an open compaction count is kept in `savings_sessions.json` under the first 32 hex of sha256(session).
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import secrets
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from host.metrics import EVENTS_KEEP_DAYS, events_path

_LOCK = threading.Lock()   # one log per data dir; the daemon is threaded


def estimate_tokens(text: str) -> int:
    """Token estimate: CJK characters count one each, the rest a quarter (length in UTF-16 code units)."""
    if not isinstance(text, str):
        raise ValueError("text")
    cjk = sum(1 for ch in text if "　" <= ch <= "鿿" or "＀" <= ch <= "￯")
    n = len(text.encode("utf-16-le")) // 2
    return math.floor(cjk + (n - cjk) / 4 + 0.5)


def _count(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and v >= 0


def _need_count(v, name):
    if not _count(v):
        raise ValueError(name)


def _need_opt_count(v, name):
    if v is not None and not _count(v):
        raise ValueError(name)


def _need_str(v, name):
    if not isinstance(v, str) or not v:
        raise ValueError(name)


def _iso(t: float) -> str:
    return datetime.fromtimestamp(t, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _parse(ts) -> float | None:
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except (AttributeError, ValueError, TypeError):
        return None


def _key(session: str) -> str:
    return hashlib.sha256(session.encode("utf-8")).hexdigest()[:32]


class _SystemClock:
    @staticmethod
    def now() -> float:
        return time.time()


class SavingsEvents:
    def __init__(self, data_dir, *, clock=None):
        self.data_dir = Path(data_dir)
        self.clock = clock or _SystemClock()
        self.path = events_path(self.data_dir)
        self.state_path = self.path.parent / "savings_sessions.json"

    # ---------------------------------------------------------------- state
    def _load(self) -> dict:
        try:
            d = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return d if isinstance(d, dict) else {}

    def _store(self, state: dict, now: float) -> None:
        cutoff = now - EVENTS_KEEP_DAYS * 86400
        keep = {}
        for k, v in state.items():
            t = _parse(v.get("ts")) if isinstance(v, dict) else None
            if t is not None and t >= cutoff:
                keep[k] = v
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.state_path.with_name(self.state_path.name + f".{os.getpid()}.tmp")
        tmp.write_text(json.dumps(keep, sort_keys=True), encoding="utf-8")
        os.replace(tmp, self.state_path)

    def _append(self, kind: str, now: float, fields: dict) -> None:
        line = json.dumps({"kind": kind, "ts": _iso(now), **fields}, ensure_ascii=False, separators=(",", ":"))
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.path, "a", encoding="utf-8", newline="\n") as f:
            f.write(line + "\n")

    # ---------------------------------------------------------------- events
    def route(self, model, *, input, output, cache_read, cache_write) -> None:
        _need_str(model, "model")
        for name, v in (("input", input), ("output", output), ("cache_read", cache_read),
                        ("cache_write", cache_write)):
            _need_count(v, name)
        with _LOCK:
            self._append("route", self.clock.now(), {"model": model, "input": input, "output": output,
                                                      "cache_read": cache_read, "cache_write": cache_write})

    def index(self, model, *, file_tokens=None, text=None) -> None:
        _need_str(model, "model")
        if (file_tokens is None) == (text is None):
            raise ValueError("file_tokens or text")
        if text is not None:
            if not isinstance(text, str):
                raise ValueError("text")
            file_tokens = estimate_tokens(text)
        _need_count(file_tokens, "file_tokens")
        with _LOCK:
            self._append("index", self.clock.now(), {"model": model, "file_tokens": file_tokens})

    def compaction(self, session, *, model, before, after, window, threshold=None, compact_usd=None):
        _need_str(session, "session")
        _need_str(model, "model")
        _need_opt_count(before, "before")
        _need_opt_count(after, "after")
        _need_count(window, "window")
        _need_opt_count(threshold, "threshold")
        if compact_usd is not None and not (isinstance(compact_usd, (int, float)) and not isinstance(compact_usd, bool)
                                            and math.isfinite(compact_usd) and compact_usd >= 0):
            raise ValueError("compact_usd")
        if before is None:
            self.stop(session)
            return None
        ref = secrets.token_hex(8)
        with _LOCK:
            now = self.clock.now()
            state = self._load()
            state[_key(session)] = {"ref": ref, "ts": _iso(now)}
            self._store(state, now)
            self._append("compact_start", now, {
                "ref": ref, "model": model, "before": before,
                "after": after if after is not None and after < before else None,
                "window": window, "threshold": threshold,
                "compact_usd": compact_usd if compact_usd is not None and compact_usd > 0 else None})
        return ref

    def stop(self, session) -> None:
        _need_str(session, "session")
        with _LOCK:
            now = self.clock.now()
            state = self._load()
            state.pop(_key(session), None)
            self._store(state, now)

    def request(self, session, *, model, input, cache_read, cache_write) -> bool:
        _need_str(session, "session")
        _need_str(model, "model")
        for name, v in (("input", input), ("cache_read", cache_read), ("cache_write", cache_write)):
            _need_count(v, name)
        with _LOCK:
            entry = self._load().get(_key(session))
            ref = entry.get("ref") if isinstance(entry, dict) else None
            if not isinstance(ref, str):
                return False
            self._append("compact_step", self.clock.now(),
                         {"ref": ref, "model": model, "context": input + cache_read + cache_write})
        return True


# ------------------------------------------------------------------ POST /session/savings

_MISSING = object()
_ARGS = {
    "route": (("model",), ("input", "output", "cache_read", "cache_write"), ()),
    "index": (("model",), ("file_tokens",), ()),
    "compaction": (("session",), ("model", "before", "after", "window"), ("threshold", "compact_usd")),
    "stop": (("session",), (), ()),
    "request": (("session",), ("model", "input", "cache_read", "cache_write"), ()),
}


def local_route(writer: SavingsEvents, body: dict) -> tuple[int, dict]:
    bad = (400, {"error": "bad_request"})
    if not isinstance(body, dict) or not isinstance(body.get("kind"), str) or body["kind"] not in _ARGS:
        return bad
    kind = body["kind"]
    positional, required, optional = _ARGS[kind]
    args, kwargs = [], {}
    for name in positional + required:
        v = body.get(name, _MISSING)
        if v is _MISSING:
            return bad
        if name in positional:
            args.append(v)
        else:
            kwargs[name] = v
    for name in optional:
        if name in body:
            kwargs[name] = body[name]
    try:
        out = getattr(writer, kind)(*args, **kwargs)
    except (ValueError, TypeError):
        return bad
    if kind == "compaction":
        written = out is not None
    elif kind == "request":
        written = bool(out)
    else:
        written = kind != "stop"
    return 200, {"ok": True, "written": written}
