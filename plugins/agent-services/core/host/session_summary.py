"""Per-session summary line for the core's session_end and clear answers.

The core already sees what agent-services did in a session: dispatches it rewrote onto a cheaper model, compactions
of the main conversation, and pre_tool calls it denied. This module counts those in memory, keyed by session id,
and on `clear` or `session_end` hands back one line for the answer's notice, then forgets the session:

    agent-services this session: 3 subagents on cheaper models, 1 compaction, 2 risky commands blocked

Zero parts are left out; with every count zero there is no line. No dollar figures and no model names are shown.
Nothing here ever raises into the core.
"""
from __future__ import annotations

import threading

PREFIX = "agent-services this session: "
END_KINDS = ("clear", "session_end")

# Model families from cheapest to dearest; a name outside them has no known tier and is never called cheaper.
_TIERS = ("haiku", "sonnet", "opus")


def tier(model) -> int | None:
    if not isinstance(model, str):
        return None
    m = model.lower()
    for i, name in enumerate(_TIERS):
        if name in m:
            return i
    return None


def cheaper(routed, requested, main_model) -> bool:
    """True when the routed model is a cheaper tier than the one the subagent would have run without the rewrite
    (the dispatch's own model, else the main conversation's)."""
    new, old = tier(routed), tier(requested if requested is not None else main_model)
    return new is not None and old is not None and new < old


def _part(n: int, one: str, many: str) -> str | None:
    return f"{n} {one if n == 1 else many}" if n > 0 else None


def summary_line(subagents: int, compactions: int, blocked: int) -> str | None:
    parts = [p for p in (_part(subagents, "subagent on a cheaper model", "subagents on cheaper models"),
                         _part(compactions, "compaction", "compactions"),
                         _part(blocked, "risky command blocked", "risky commands blocked")) if p]
    return PREFIX + ", ".join(parts) if parts else None


class SessionSummary:
    def __init__(self):
        self._lock = threading.Lock()
        self._counts: dict[str, list[int]] = {}   # session id -> [subagents, compactions, blocked]

    def _bump(self, sid: str, i: int) -> None:
        with self._lock:
            self._counts.setdefault(sid, [0, 0, 0])[i] += 1

    def counts(self, sid: str) -> tuple:
        with self._lock:
            return tuple(self._counts.get(sid, (0, 0, 0)))

    def drop(self, sid: str) -> None:
        with self._lock:
            self._counts.pop(sid, None)

    def take(self, sid: str) -> str | None:
        """The session's line (or None), and its counters cleared."""
        with self._lock:
            c = self._counts.pop(sid, None)
        return summary_line(*c) if c else None

    def observe(self, kind: str, event: dict, out: dict, main_model=None) -> None:
        sid = event["session"]
        action = out.get("action")
        if kind == "dispatch" and action == "rewrite":
            s = out.get("set") or {}
            if cheaper(s.get("model"), event.get("model"), main_model):
                self._bump(sid, 0)
        elif kind == "compaction" and event.get("agent") is None and event.get("done") is True \
                and event.get("trigger") != "precompute":
            self._bump(sid, 1)
        elif kind == "pre_tool" and action == "deny":
            self._bump(sid, 2)

    def after(self, core, kind: str, event: dict, out: dict) -> dict:
        """Count the event, and on clear or session_end put the session's line in the answer's notice."""
        try:
            main_model = None
            if kind == "dispatch":
                with core._lock:
                    s = core._sessions.get(event["session"])
                    main_model = s.main_model if s is not None else None
            self.observe(kind, event, out, main_model)
            if kind in END_KINDS:
                line = self.take(event["session"])
                if line:
                    old = out.get("notice")
                    out["notice"] = f"{old}\n{line}" if isinstance(old, str) and old else line
        except Exception:  # noqa: BLE001 — the summary never breaks an answer
            pass
        return out
