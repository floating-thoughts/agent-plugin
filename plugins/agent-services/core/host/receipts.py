"""Per-action receipts: one short line in an answer's `notice` each time the core applies a saving or safety action.

Three kinds: a subagent dispatch routed to a cheaper model (a dispatch `rewrite`), a compaction saving the core
recorded, and a risky tool call the core denied (a pre_tool `deny`). The line carries no dollar figure (that formula is
server-side) and no model name. At most one receipt per kind per session every THROTTLE_SECONDS, and a notice the
answer already carries (plan or gate notices) is never replaced. The adapter logs every notice to the transcript.
"""
from __future__ import annotations

import threading

THROTTLE_SECONDS = 600
PREFIX = "agent-services: "
TEXTS = {
    "route": "ran this subagent on a cheaper model",
    "compaction": "compacted this session at a checkpoint and recorded the saving",
    "block": "blocked a risky command",
}
REASON_MAX = 160


def _reason(text) -> str | None:
    if not isinstance(text, str):
        return None
    line = next((x.strip() for x in text.splitlines() if x.strip()), "")
    if not line:
        return None
    return line if len(line) <= REASON_MAX else line[:REASON_MAX - 3].rstrip() + "..."


def receipt_text(kind: str, reason=None) -> str:
    text = PREFIX + TEXTS[kind]
    r = _reason(reason) if kind == "block" else None
    return text + ": " + r if r else text


class Receipts:
    def __init__(self, now):
        self._now = now                       # () -> seconds
        self._lock = threading.Lock()
        self._last: dict[tuple[str, str], float] = {}   # (session, kind) -> time of the last receipt
        self._pending: set[tuple[str, str]] = set()     # (session, kind) noted while handling, stamped after

    def note(self, session: str, kind: str) -> None:
        """An action the answer itself does not show (a recorded compaction saving)."""
        with self._lock:
            self._pending.add((session, kind))

    def drop(self, session: str) -> None:
        with self._lock:
            for k in [k for k in self._last if k[0] == session]:
                del self._last[k]
            self._pending = {k for k in self._pending if k[0] != session}

    def _kind(self, session: str, event_kind: str, out: dict) -> str | None:
        action = out.get("action")
        if event_kind == "dispatch" and action == "rewrite":
            return "route"
        if event_kind == "pre_tool" and action == "deny":
            return "block"
        if event_kind == "compaction":
            with self._lock:
                if (session, "compaction") in self._pending:
                    self._pending.discard((session, "compaction"))
                    return "compaction"
        return None

    def stamp(self, session: str, event_kind: str, out: dict) -> dict:
        """Add the receipt for this answer to its notice when one is due; returns `out`."""
        if not isinstance(out, dict):
            return out
        if event_kind == "session_end":
            self.drop(session)
            return out
        kind = self._kind(session, event_kind, out)
        if kind is None or out.get("notice"):   # an existing notice keeps priority
            return out
        now = self._now()
        with self._lock:
            last = self._last.get((session, kind))
            if last is not None and now - last < THROTTLE_SECONDS:
                return out
            self._last[(session, kind)] = now
        out["notice"] = receipt_text(kind, out.get("reason"))
        return out
