"""The status line the plugin shows under the prompt: one line in <data dir>/services/status.txt.

The core rewrites it on session_start and turn_end (host/core.py). The dollar figure comes only from the server
(GET /metrics/savings through host.metrics.Metrics.savings(): its `usd`, `pct` and `first_day`), fetched at most once
per REFRESH_SECONDS off the hook path, cached in memory and kept when a fetch fails. Today's counts are read from the
local savings event log (host.savings_events), tailed by offset. While the shell gate is closed nothing is fetched,
read or written (no file on disk changes); the plugin then shows its own signed-out line. No model names, tokens,
ids, emails or paths go in.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from host.metrics import events_path

NAME = "agent-services"
SEP = " \u00b7 "
MAX_LEN = 110
REFRESH_SECONDS = 1800
COMMAND = "/agent-services:agent-services"
HINT_OFF = f"run {COMMAND} savings on to see dollars saved"
HINT_OFF_SHORT = f"dollars saved: {COMMAND} savings on"
HINT_WAIT = "savings show after the first daily upload"
HINT_WAIT_SHORT = "savings after the first upload"
COUNTED = (("route", "routed"), ("compact_start", "compacted"), ("index", "indexed reads"))
_DAY = re.compile(r"^\d{4}-(\d{2}-\d{2})$")


def status_path(data_dir) -> Path:
    return events_path(data_dir).parent / "status.txt"


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and abs(v) != float("inf")


def today_text(counts: dict) -> str | None:
    parts = [f"{counts.get(k, 0)} {label}" for k, label in COUNTED if counts.get(k, 0)]
    return "today: " + ", ".join(parts) if parts else None


def render(metrics_on: bool, saved, counts: dict) -> str:
    """The line for the metrics opt-in, the last server figure (or None) and today's counts (an open gate)."""
    today = today_text(counts)
    head = [NAME]
    tail = None
    usd = saved.get("usd") if isinstance(saved, dict) else None
    if not metrics_on:
        head.append("on")
        tail = HINT_OFF
    elif _num(usd) and usd > 0:
        s = f"saved ${usd:,.2f}"
        pct = saved.get("pct")
        if _num(pct) and pct >= 0:
            s += f" ({pct * 100:.1f}%)"
        m = _DAY.match(saved.get("first_day") or "") if isinstance(saved.get("first_day"), str) else None
        if m:
            s += f" since {m.group(1)}"
        head.append(s)
    else:
        head.append("on")
        tail = HINT_WAIT
    short = {HINT_OFF: HINT_OFF_SHORT, HINT_WAIT: HINT_WAIT_SHORT}.get(tail)
    lean = today_text({k: v for k, v in counts.items() if k != "index"})
    # longest first: the full line, a shorter hint, without indexed reads, without today's counts
    for t, end in ((today, tail), (today, short), (lean, short), (None, short), (None, tail)):
        text = SEP.join(head + [x for x in (t, end) if x])
        if len(text) <= MAX_LEN:
            return text
    return text[:MAX_LEN]


class _Clock:
    @staticmethod
    def now() -> float:
        return time.time()


class StatusLine:
    def __init__(self, data_dir, metrics, *, gate, clock=None, sync=False):
        self.path = status_path(data_dir)
        self.events = events_path(data_dir)
        self.metrics = metrics
        self.gate = gate          # () -> {"open", "reason", ...}
        self.clock = clock or _Clock()
        self.sync = sync
        self._lock = threading.RLock()
        self.saved = None          # the last good server figure
        self._tried_at = None      # clock time of the last fetch start
        self._fetching = False
        self._day = None
        self._offset = 0
        self._counts: dict = {}
        self._written = None

    def _now(self) -> float:
        try:
            return float(self.clock.now())
        except Exception:  # noqa: BLE001
            return time.time()

    def _metrics_on(self) -> bool:
        try:
            return self.metrics.status().get("on") is True
        except Exception:  # noqa: BLE001
            return False

    def _gate(self) -> dict:
        try:
            st = self.gate()
            return st if isinstance(st, dict) else {"open": False, "reason": "core_down"}
        except Exception:  # noqa: BLE001
            return {"open": False, "reason": "core_down"}

    # ---- today's counts: tail the event log, re-read from the start on a new day or a shorter file
    def counts(self) -> dict:
        day = datetime.fromtimestamp(self._now(), timezone.utc).date().isoformat()
        with self._lock:
            try:
                size = self.events.stat().st_size
            except OSError:
                size = 0
            if day != self._day or size < self._offset:
                self._day, self._offset, self._counts = day, 0, {}
            if size > self._offset:
                try:
                    with open(self.events, "rb") as f:
                        f.seek(self._offset)
                        chunk = f.read(size - self._offset)
                except OSError:
                    chunk = b""
                end = chunk.rfind(b"\n") + 1      # whole lines only; a half-written one waits
                for raw in chunk[:end].splitlines():
                    try:
                        e = json.loads(raw)
                    except ValueError:
                        continue
                    if isinstance(e, dict) and isinstance(e.get("ts"), str) and e["ts"][:10] == day:
                        k = e.get("kind")
                        if any(k == c for c, _ in COUNTED):
                            self._counts[k] = self._counts.get(k, 0) + 1
                self._offset += end
            return dict(self._counts)

    # ---- the server figure
    def _fetch(self) -> None:
        try:
            res = self.metrics.savings()
            if getattr(res, "ok", False) and isinstance(res.body, dict):
                with self._lock:
                    self.saved = res.body
        except Exception:  # noqa: BLE001 — keep the last figure
            pass
        finally:
            with self._lock:
                self._fetching = False
        self._write()

    def _maybe_fetch(self, on: bool) -> None:
        if not on:
            return
        now = self._now()
        with self._lock:
            if self._fetching or (self._tried_at is not None and now - self._tried_at < REFRESH_SECONDS):
                return
            self._fetching, self._tried_at = True, now
        if self.sync:
            self._fetch()
        else:
            threading.Thread(target=self._fetch, name="status-line", daemon=True).start()

    # ---- the file
    def text(self) -> str:
        with self._lock:
            saved = self.saved
        return render(self._metrics_on(), saved, self.counts())

    def _write(self) -> str | None:
        try:
            if self._gate().get("open") is not True:   # a closed gate writes nothing (the plugin shows signed out)
                return None
            text = self.text()
            with self._lock:
                if text == self._written and self.path.exists():
                    return text
                self.path.parent.mkdir(parents=True, exist_ok=True)
                tmp = self.path.with_name(self.path.name + f".{os.getpid()}.{threading.get_ident()}.tmp")
                tmp.write_text(text + "\n", encoding="utf-8", newline="\n")
                os.replace(tmp, self.path)
                self._written = text
            return text
        except Exception:  # noqa: BLE001 — the status line is best effort
            return None

    def update(self) -> str | None:
        """Rewrite the file now and start a server fetch when one is due (never waits for it unless sync).
        While the gate is closed nothing is fetched, read or written."""
        if self._gate().get("open") is not True:
            return None
        self._maybe_fetch(self._metrics_on())
        return self._write()
