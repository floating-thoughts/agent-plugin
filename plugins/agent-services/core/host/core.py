"""The local core behind every harness adapter.

One neutral event (core/1) in, one answer out. The core keeps per-session state in memory only (router dispatches,
checkpoint counters, pending context, the models seen) and talks to the services through the conclusion client
(host/conclusions.py), the savings writer (host/savings_events.py) and the metrics client (host/metrics.py).
Nothing from an event is logged or written except what SavingsEvents writes.

Also the four MCP tools (`TOOLS`, `check_args`, `ask`, `open_answer`) that host/mcp_server.py serves.
"""
from __future__ import annotations

import json
import math
import os
import re
import threading
import time
from collections import OrderedDict
from pathlib import Path

HARNESSES = ("claude-code", "opencode", "codex", "cursor", "gemini", "other")
KINDS = ("session_start", "dispatch", "dispatched", "step", "step_end", "pre_tool", "post_tool", "turn_end",
         "prompt", "compaction", "clear", "session_end")
INJECT_POINTS = ("prompt", "pre_tool", "post_tool")
GATE_RETRY_SECONDS = 300   # an unreachable server is tried again after this long (and at every session start)
ANSWER_KEYS = ("action", "reason", "set", "context", "notice", "fallback")

CHECKPOINT_MARK = "Checkpoint reached:"
CHECKPOINT_NOW = "The server suggests a checkpoint now: once this stretch is done, call the checkpoint tool and keep the items below in the summary."
DENY_TEXT = "This subagent dispatch did not pass the routing check. Rewrite it as the hint says, then dispatch again."

COMMIT_RX = re.compile(
    r"""(?:^|[\s;&|(])git(?:\s+-[cC]\s+(?:[^\s"']|"[^"]*"|'[^']*')+|\s+--?[A-Za-z][\w-]*"""
    r"""(?:=(?:[^\s"']|"[^"]*"|'[^']*')+)?)*\s+commit(?![\w-])""")
_SED_RX = re.compile(r"""\bsed\s+-n\s+['"]?\d+,\d+p['"]?\s+("[^"]+"|'[^']+'|[^\s|;&>]+)""")


def _served_enum(name: str) -> tuple:
    api = json.loads((Path(__file__).resolve().parent / "service_api.json").read_text(encoding="utf-8"))
    return tuple(api["definitions"][name]["enum"])


SERVED_ROLES = _served_enum("ServedRole")
SERVED_PHASES = _served_enum("ServedPhase")

TOOLS: "OrderedDict[str, dict]" = OrderedDict([
    ("router_advice", {
        "description": "Ask the routing service which model and effort a subagent dispatch should use. Returns the "
                       "decision (route, pass or deny), the model, the effort and a hint; pass_through when the "
                       "service cannot be reached.",
        "input_schema": {
            "type": "object",
            "properties": {
                "subagent_type": {"type": "string", "minLength": 1, "maxLength": 64},
                "description": {"type": "string", "maxLength": 100000},
                "model": {"type": ["string", "null"]},
                "effort": {"type": ["string", "null"]},
            },
            "required": ["subagent_type", "description"],
            "additionalProperties": False,
        },
    }),
    ("lesson_lookup", {
        "description": "Fetch the served lessons for a role and a work phase (plan, implement, test, review, "
                       "deliver, checkpoint). Returns the version, the catalog line, the items and the rule for "
                       "using them; an empty list when nothing is served.",
        "input_schema": {
            "type": "object",
            "properties": {
                "role": {"type": "string", "enum": list(SERVED_ROLES)},
                "phase": {"type": "string", "enum": list(SERVED_PHASES)},
            },
            "required": ["role", "phase"],
            "additionalProperties": False,
        },
    }),
    ("savings", {
        "description": "Show what the agent services saved so far, as worked out by the service from the local "
                       "savings log. Returns local_only when the service cannot be reached.",
        "input_schema": {"type": "object", "properties": {}, "required": [], "additionalProperties": False},
    }),
    ("checkpoint_advice", {
        "description": "Ask whether now is a good moment for a checkpoint, given how full the context is and what "
                       "was done since the last one. Returns now (true or false) and the lines to keep in the "
                       "summary.",
        "input_schema": {
            "type": "object",
            "properties": {
                "context_pct": {"type": "number", "minimum": 0, "maximum": 100},
                "turns": {"type": "integer", "minimum": 0},
                "tool_calls": {"type": "integer", "minimum": 0},
                "todos_done": {"type": "integer", "minimum": 0},
                "commits": {"type": "integer", "minimum": 0},
                "minutes": {"type": "integer", "minimum": 0},
            },
            "required": ["context_pct"],
            "additionalProperties": False,
        },
    }),
])

_COUNTER_ARGS = ("turns", "tool_calls", "todos_done", "commits", "minutes")


# ------------------------------------------------------------------ small checks

def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and not (isinstance(v, float) and
                                                                             not math.isfinite(v))


def _bad(name: str):
    raise ValueError(name)


def _req(e: dict, k: str):
    if k not in e:
        _bad(k)
    return e[k]


def _str_n(v, name, lo=1, hi=200):
    if not isinstance(v, str) or not lo <= len(v) <= hi:
        _bad(name)


def _str_or_null(e: dict, k: str):
    v = _req(e, k)
    if v is not None and not isinstance(v, str):
        _bad(k)


def _opt_str(e: dict, k: str):
    v = e.get(k)
    if v is not None and not isinstance(v, str):
        _bad(k)


def _int_or_null(e: dict, k: str):
    v = _req(e, k)
    if v is not None and not _is_int(v):
        _bad(k)


def _num_or_null(e: dict, k: str):
    v = _req(e, k)
    if v is not None and not _is_num(v):
        _bad(k)


def _bool(e: dict, k: str):
    if not isinstance(_req(e, k), bool):
        _bad(k)


def _opt_bool(e: dict, k: str):
    v = e.get(k)
    if v is not None and not isinstance(v, bool):
        _bad(k)


def _usage(e: dict, k: str = "usage"):
    u = _req(e, k)
    if u is None:
        return
    if not isinstance(u, dict):
        _bad(k)
    for f in ("input", "output", "cache_read", "cache_write"):
        if not _is_int(u.get(f)) or u[f] < 0:
            _bad(k)


def _tool_fields(e: dict):
    _str_n(_req(e, "tool"), "tool")
    if not isinstance(_req(e, "input"), dict):
        _bad("input")
    _str_or_null(e, "call")


def validate(event) -> None:
    """Raise ValueError unless `event` is a valid core/1 event."""
    if not isinstance(event, dict):
        _bad("event")
    v = _req(event, "v")
    if not _is_int(v) or v != 1:
        _bad("v")
    if _req(event, "harness") not in HARNESSES:
        _bad("harness")
    kind = _req(event, "kind")
    if kind not in KINDS:
        _bad("kind")
    _str_n(_req(event, "session"), "session")
    agent = _req(event, "agent")
    if agent is not None:
        _str_n(agent, "agent")
    e = event
    if kind == "session_start":
        _str_or_null(e, "cwd")
        _opt_str(e, "transcript")
        io = e.get("inject_on")
        if io is not None and (not isinstance(io, list) or any(x not in INJECT_POINTS for x in io)):
            _bad("inject_on")
    elif kind == "dispatch":
        if not isinstance(_req(e, "subagent_type"), str):
            _bad("subagent_type")
        if not isinstance(_req(e, "description"), str):
            _bad("description")
        for k in ("model", "effort", "call"):
            _str_or_null(e, k)
        _opt_bool(e, "fork")
        _opt_bool(e, "teammate")
    elif kind == "dispatched":
        _str_or_null(e, "call")
        _str_n(_req(e, "child"), "child")
    elif kind == "step":
        _str_or_null(e, "model")
    elif kind == "step_end":
        _str_or_null(e, "model")
        _usage(e)
    elif kind == "pre_tool":
        _tool_fields(e)
    elif kind == "post_tool":
        _tool_fields(e)
        _bool(e, "ok")
    elif kind == "turn_end":
        _str_or_null(e, "reason")
        _str_or_null(e, "model")
        _usage(e)
        _int_or_null(e, "context_tokens")
        _int_or_null(e, "context_window")
    elif kind == "prompt":
        _opt_str(e, "origin")
    elif kind == "compaction":
        _str_or_null(e, "trigger")
        _str_or_null(e, "instructions")
        _bool(e, "done")
        for k in ("before", "after", "window", "threshold"):
            _int_or_null(e, k)
        for k in ("cost_before", "cost_after"):
            _num_or_null(e, k)


def answer(action="allow", *, reason=None, set=None, context=None, notice=None, fallback=None) -> dict:  # noqa: A002
    return {"action": action, "reason": reason, "set": set, "context": context, "notice": notice,
            "fallback": fallback}


# ------------------------------------------------------------------ MCP tool arguments

def check_args(tool, args) -> None:
    if tool not in TOOLS:
        _bad("unknown tool")
    if not isinstance(args, dict):
        _bad("arguments must be an object")
    schema = TOOLS[tool]["input_schema"]
    for k in args:
        if k not in schema["properties"]:
            _bad(f"unknown argument {k}")
    for k in schema["required"]:
        if k not in args:
            _bad(f"missing {k}")
    if tool == "router_advice":
        st, d = args["subagent_type"], args["description"]
        if not isinstance(st, str) or not 1 <= len(st) <= 64:
            _bad("subagent_type")
        if not isinstance(d, str) or len(d) > 100000:
            _bad("description")
        for k in ("model", "effort"):
            if args.get(k) is not None and not isinstance(args[k], str):
                _bad(k)
    elif tool == "lesson_lookup":
        if args["role"] not in SERVED_ROLES or not isinstance(args["role"], str):
            _bad("role")
        if args["phase"] not in SERVED_PHASES or not isinstance(args["phase"], str):
            _bad("phase")
    elif tool == "checkpoint_advice":
        p = args["context_pct"]
        if not _is_num(p) or not 0 <= p <= 100:
            _bad("context_pct")
        for k in _COUNTER_ARGS:
            if k in args and (not _is_int(args[k]) or args[k] < 0):
                _bad(k)


def open_answer(tool, args) -> dict:
    """What a client answers when the core cannot be reached (`args` already checked)."""
    a = args if isinstance(args, dict) else {}
    if tool == "router_advice":
        return {"decision": "pass", "model": None, "effort": None, "reason": None, "hint": None,
                "fallback": "pass_through"}
    if tool == "lesson_lookup":
        return {"role": a.get("role"), "phase": a.get("phase"), "version": None, "catalog": "", "items": [],
                "fallback": "no_served"}
    if tool == "savings":
        return {"saved": None, "fallback": "local_only", "reason": "core_down"}
    if tool == "checkpoint_advice":
        return {"now": False, "keep_lines": [], "fallback": "no_suggestion"}
    raise ValueError("unknown tool")


# ------------------------------------------------------------------ paths for indexed reads

def _norm(path: str) -> str:
    s = path.replace("\\", "/")
    m = re.match(r"^/([a-zA-Z])/", s)
    if m:
        s = m.group(1) + ":/" + s[3:]
    if re.match(r"^[a-z]:", s):
        s = s[0].upper() + s[1:]
    return s


def _is_abs(p: str) -> bool:
    return bool(re.match(r"^[A-Za-z]:/", p)) or p.startswith("/")


def _indexed(file: str) -> bool:
    parts = file.split("/")
    for i in range(len(parts) - 1, 0, -1):
        d = "/".join(parts[:i])
        if not d or d.endswith(":"):
            dd = d + "/"
        else:
            dd = d
        rel = file[len(d) + 1:]
        try:
            text = Path(dd, "DOCINDEX.md").read_text(encoding="utf-8", errors="replace").replace("\\", "/")
        except OSError:
            text = None
        if text is not None and (rel in text or file in text):
            return True
        if Path(dd, "codeindex", "files", rel.replace("/", "__") + ".md").is_file():
            return True
    return False


# ------------------------------------------------------------------ the core

class _SystemClock:
    @staticmethod
    def now() -> float:
        return time.time()


class _Session:
    def __init__(self, harness, cwd=None, transcript=None, inject_on=None, now=0.0):
        self.harness = harness
        self.cwd = cwd
        self.transcript = transcript
        self.inject_on = list(inject_on) if inject_on is not None else ["prompt"]
        self.turns = self.tool_calls = self.todos_done = self.commits = 0
        self.todos_last = 0
        self.base = now
        self.pending_context = None
        self.inflight = False
        self.main_model = None
        self.models: dict = {}        # agent id -> last step model
        self.routed: dict = {}        # child agent id -> effort
        self.dispatches: list = []    # [(call, effort)] routed, not yet linked

    def reset(self, now):
        self.turns = self.tool_calls = self.todos_done = self.commits = 0
        self.todos_last = 0
        self.base = now
        self.pending_context = None


class Core:
    def __init__(self, connector, data_dir, *, conclusions=None, savings=None, metrics=None, clock=None,
                 sync=False, guard=None):
        self.connector = connector
        self.guard = guard   # the served-content guard (host.confidential.Guard); the daemon always passes one
        self._guard_sessions: dict[tuple[str, str], dict] = {}   # (session, role) -> the guard's open() answer
        self.data_dir = Path(data_dir)
        if conclusions is None:
            from host.conclusions import Conclusions
            conclusions = Conclusions(connector)
        if savings is None:
            from host.savings_events import SavingsEvents
            savings = SavingsEvents(data_dir)
        if metrics is None:
            from host import metrics as metrics_mod
            metrics = metrics_mod.Metrics(connector, data_dir, projects_root=metrics_mod.default_projects_root())
        self.conclusions = conclusions
        self.savings = savings
        self.metrics = metrics
        self.clock = clock or _SystemClock()
        self.sync = sync
        self._lock = threading.RLock()
        self._sessions: dict[str, _Session] = {}
        self._noticed: set[str] = set()     # sessions whose one notice was already given
        self._hello_at: float | None = None   # clock time of the last handshake attempt

    # ---------------- the shell gate (read through the connector)
    def _gated(self) -> bool:
        return hasattr(self.connector, "gate_state") and getattr(self.connector, "gate", True) is not False

    def _gate_state(self) -> dict:
        if not self._gated():
            return {"open": True, "reason": None, "min_shell": None}
        try:
            st = self.connector.gate_state()
            if isinstance(st, dict) and isinstance(st.get("open"), bool):
                return st
        except Exception:  # noqa: BLE001
            pass
        return {"open": False, "reason": "core_down", "min_shell": None}   # fail closed, as the MCP server does

    def _handshake(self):
        self._hello_at = self._now()
        try:
            return self.connector.handshake()
        except Exception:  # noqa: BLE001
            return None

    def _maybe_handshake(self) -> None:
        """A daemon restarted mid-session (unknown), or the server was unreachable a while ago: try once."""
        if not self._gated() or not hasattr(self.connector, "handshake"):
            return
        st = self._gate_state()
        if st["open"]:
            return
        if st.get("reason") in ("unknown", "dependency") or (
                st.get("reason") == "unavailable"
                and (self._hello_at is None or self._now() - self._hello_at >= GATE_RETRY_SECONDS)):
            self._handshake()

    def _notice_once(self, session: str, notice):
        if notice is None:
            return None
        with self._lock:
            if session in self._noticed:
                return None
            self._noticed.add(session)
        return notice

    def _closed_answer(self, session: str, st: dict) -> dict:
        from host.services import gate_notice
        return answer(fallback="inactive", notice=self._notice_once(session, gate_notice(st)))

    def gate(self, refresh=False) -> dict:
        """{"open", "reason", "notice"}; refresh=True runs a handshake first. Ungated -> open."""
        if not self._gated():
            return {"open": True, "reason": None, "notice": None}
        if refresh and hasattr(self.connector, "handshake"):
            self._handshake()
        else:
            self._maybe_handshake()   # unknown (no handshake yet) or a retry that is due
        st = self._gate_state()
        from host.services import gate_notice
        return {"open": bool(st["open"]), "reason": st.get("reason"), "notice": gate_notice(st)}

    # ---------------- registry
    def sessions(self) -> list:
        with self._lock:
            return [{"session": k, "harness": s.harness, "cwd": s.cwd, "transcript": s.transcript}
                    for k, s in self._sessions.items()]

    def _state(self, event) -> _Session:
        sid = event["session"]
        s = self._sessions.get(sid)
        if s is None:
            s = self._sessions[sid] = _Session(event["harness"], now=self._now())
        return s

    def _now(self) -> float:
        try:
            return float(self.clock.now())
        except Exception:  # noqa: BLE001
            return time.time()

    # ---------------- events
    def handle(self, event) -> dict:
        validate(event)
        kind = event["kind"]
        sid = event["session"]
        if not self._gated():
            return self._run(kind, event)
        hello = None
        if kind == "session_start":
            if hasattr(self.connector, "handshake"):
                hello = self._handshake()
        else:
            self._maybe_handshake()
        st = self._gate_state()
        if not st["open"]:
            out = self._closed_answer(sid, st)
            if kind == "session_end":
                self._drop_session(sid)
            return out
        out = self._run(kind, event)
        st = self._gate_state()
        if not st["open"]:   # the gate closed during the event (a 401 mid-call): the closed answer replaces it
            out = self._closed_answer(sid, st)
        if kind == "session_end":
            self._drop_session(sid)
        if not st["open"]:
            return out
        if kind == "session_start" and hello is not None and getattr(hello, "ok", False) \
                and isinstance(hello.body, dict):
            from host.services import plan_notice
            out["notice"] = self._notice_once(sid, plan_notice(hello.body.get("plan")))
        return out

    def _run(self, kind, event) -> dict:
        try:
            return getattr(self, "_on_" + kind)(event)
        except Exception:  # noqa: BLE001 — a service or writer error never escapes
            if kind == "dispatch":
                return answer(fallback="pass_through")
            return answer()

    def _drop_session(self, sid: str) -> None:
        """session_end while closed: local cleanup only."""
        with self._lock:
            self._sessions.pop(sid, None)
            self._noticed.discard(sid)
        self._close_guard(sid)

    def _close_guard(self, sid: str) -> None:
        with self._lock:
            keys = [k for k in self._guard_sessions if k[0] == sid]
            opened = [self._guard_sessions.pop(k) for k in keys]
        for g in opened:
            self._quiet(self.guard.close, g["session_token"])

    def _guard_session(self, sid: str, role: str) -> dict:
        with self._lock:
            g = self._guard_sessions.get((sid, role))
        if g is None:
            g = self.guard.open(role)
            with self._lock:
                old = self._guard_sessions.setdefault((sid, role), g)
            if old is not g:   # another thread opened one first
                self._quiet(self.guard.close, g["session_token"])
                g = old
        return g

    def _quiet(self, fn, *a, **kw):
        try:
            return fn(*a, **kw)
        except Exception:  # noqa: BLE001
            return None

    def _deliver(self, s: _Session, event) -> dict | None:
        if event["agent"] is not None or event["kind"] not in s.inject_on:
            return None
        with self._lock:
            ctx, s.pending_context = s.pending_context, None
        return answer("inject", context=list(ctx)) if ctx else None

    def _on_session_start(self, e):
        with self._lock:
            io = e.get("inject_on")
            self._sessions[e["session"]] = _Session(e["harness"], e["cwd"], e.get("transcript"),
                                                    io if io is not None else None, self._now())
        return answer()

    def _on_dispatch(self, e):
        if e.get("fork") is True or e.get("teammate") is True:
            return answer()
        with self._lock:
            s = self._state(e)
            cwd = s.cwd
        try:
            r = self.conclusions.route(e["session"], e["subagent_type"], e["description"], e["model"],
                                       e["effort"], project_dir=cwd, harness=e["harness"])
        except Exception:  # noqa: BLE001
            return answer(fallback="pass_through")
        notice, fb = r.get("notice"), r.get("fallback")
        if r.get("decision") == "route":
            with self._lock:
                s.dispatches.append((e["call"], r.get("effort")))
            return answer("rewrite", set={"model": r.get("model"), "effort": r.get("effort")}, notice=notice,
                          fallback=fb)
        if r.get("decision") == "deny":
            return answer("deny", reason=r.get("hint") or DENY_TEXT, notice=notice, fallback=fb)
        return answer(notice=notice, fallback=fb)

    def _on_dispatched(self, e):
        with self._lock:
            s = self._state(e)
            call = e["call"]
            for i, (c, effort) in enumerate(s.dispatches):
                if c == call:
                    del s.dispatches[i]
                    s.routed[e["child"]] = effort
                    break
        return answer()

    def _on_step(self, e):
        agent, model = e["agent"], e["model"]
        with self._lock:
            s = self._state(e)
            if isinstance(model, str):
                if agent is None:
                    s.main_model = model
                else:
                    s.models[agent] = model
            effort = s.routed.get(agent) if agent is not None else None
        if effort is not None:
            return answer("rewrite", set={"effort": effort})
        return answer()

    def _on_step_end(self, e):
        with self._lock:
            self._state(e)
        u = e["usage"]
        if e["agent"] is None and isinstance(e["model"], str) and u is not None:
            self._quiet(self.savings.request, e["session"], model=e["model"], input=u["input"],
                        cache_read=u["cache_read"], cache_write=u["cache_write"])
        return answer()

    def _on_pre_tool(self, e):
        with self._lock:
            s = self._state(e)
            s.tool_calls += 1
        return self._deliver(s, e) or answer()

    def _on_post_tool(self, e):
        with self._lock:
            s = self._state(e)
        if e["ok"] is True:
            tool, inp = e["tool"], e["input"]
            with self._lock:
                cmd = inp.get("command")
                if tool in ("Bash", "PowerShell") and isinstance(cmd, str) and COMMIT_RX.search(cmd):
                    s.commits += 1
                todos = inp.get("todos")
                if tool == "TodoWrite" and isinstance(todos, list):
                    n = sum(1 for t in todos if isinstance(t, dict) and t.get("status") == "completed")
                    s.todos_done += max(0, n - s.todos_last)
                    s.todos_last = n
            self._quiet(self._index_read, s, e)
        return self._deliver(s, e) or answer()

    def _index_read(self, s: _Session, e) -> None:
        tool, inp = e["tool"], e["input"]
        path = None
        if tool == "Read" and isinstance(inp.get("file_path"), str) \
                and (inp.get("offset") is not None or inp.get("limit") is not None):
            path = inp["file_path"]
        elif tool == "Bash" and isinstance(inp.get("command"), str):
            m = _SED_RX.search(inp["command"])
            if m:
                path = re.sub(r"""^["']|["']$""", "", m.group(1))
        if not path:
            return
        file = _norm(path)
        if not _is_abs(file):
            if not isinstance(s.cwd, str):
                return
            file = _norm(os.path.normpath(os.path.join(s.cwd, path)))
        else:
            file = _norm(os.path.normpath(file)) if re.match(r"^[A-Za-z]:/", file) else file
        with self._lock:
            model = s.models.get(e["agent"]) if e["agent"] is not None else None
            model = model or s.main_model
        if not model or not _indexed(file):
            return
        try:
            with open(file, "r", encoding="utf-8", errors="replace", newline=None) as f:
                text = f.read()
        except OSError:
            return
        self.savings.index(model, text=text)

    def _on_turn_end(self, e):
        agent, u = e["agent"], e["usage"]
        with self._lock:
            s = self._state(e)
            routed = agent is not None and agent in s.routed
        if routed:
            if isinstance(e["model"], str) and u is not None:
                self._quiet(self.savings.route, e["model"], input=u["input"], output=u["output"],
                            cache_read=u["cache_read"], cache_write=u["cache_write"])
            return answer()
        if agent is not None:
            return answer()
        ct, cw = e["context_tokens"], e["context_window"]
        pct = 100 * ct / cw if _is_int(ct) and _is_int(cw) and cw > 0 else 0
        with self._lock:
            s.turns += 1
            if s.inflight:
                return answer()
            s.inflight = True
            counts = {"context_pct": pct, "turns": s.turns, "tool_calls": s.tool_calls,
                      "todos_done": s.todos_done, "commits": s.commits,
                      "minutes": max(0, math.floor((self._now() - s.base) / 60))}
        if self.sync:
            self._checkpoint(s, e["session"], counts)
        else:
            threading.Thread(target=self._checkpoint, args=(s, e["session"], counts), daemon=True).start()
        return answer()

    def _checkpoint(self, s: _Session, session: str, counts: dict) -> None:
        try:
            r = self.conclusions.checkpoint(session, **counts)
            if isinstance(r, dict) and r.get("now") is True and not r.get("fallback"):
                lines = [x for x in (r.get("keep_lines") or []) if isinstance(x, str)]
                with self._lock:
                    s.pending_context = [CHECKPOINT_NOW, *lines]
        except Exception:  # noqa: BLE001
            pass
        finally:
            with self._lock:
                s.inflight = False

    def _on_prompt(self, e):
        with self._lock:
            s = self._state(e)
        return self._deliver(s, e) or answer()

    def _on_compaction(self, e):
        with self._lock:
            s = self._state(e)
            main_model = s.main_model
        if e["agent"] is not None or e["trigger"] == "precompute" or e["done"] is not True:
            return answer()
        ins, before, window = e["instructions"], e["before"], e["window"]
        if isinstance(ins, str) and ins.startswith(CHECKPOINT_MARK) and _is_int(before) and _is_int(window) \
                and isinstance(main_model, str):
            cb, ca = e["cost_before"], e["cost_after"]
            usd = ca - cb if _is_num(cb) and _is_num(ca) else None
            self._quiet(self.savings.compaction, e["session"], model=main_model, before=before, after=e["after"],
                        window=window, threshold=e["threshold"], compact_usd=usd)
        else:
            self._quiet(self.savings.stop, e["session"])
        with self._lock:
            s.reset(self._now())
        return answer()

    def _on_clear(self, e):
        with self._lock:
            s = self._state(e)
        self._quiet(self.savings.stop, e["session"])
        with self._lock:
            s.reset(self._now())
        return answer()

    def _on_session_end(self, e):
        try:
            self.connector.end_served_session(self.conclusions.session_ref(e["session"]))
        finally:
            with self._lock:
                self._sessions.pop(e["session"], None)
            self._close_guard(e["session"])
        return answer()

    # ---------------- MCP tools
    def ask(self, tool, args, *, session, harness="other", cwd=None) -> dict:
        check_args(tool, args)
        if not isinstance(session, str) or not 1 <= len(session) <= 200:
            _bad("session")
        if harness not in HARNESSES:
            _bad("harness")
        if cwd is not None and not isinstance(cwd, str):
            _bad("cwd")
        if self._gated():
            self._maybe_handshake()
            st = self._gate_state()
            if not st["open"]:
                return {"fallback": "inactive", "reason": st.get("reason")}
        try:
            return self._ask(tool, args, session, harness, cwd)
        except Exception:  # noqa: BLE001
            return open_answer(tool, args)

    def _ask(self, tool, args, session, harness, cwd) -> dict:
        if tool == "router_advice":
            r = self.conclusions.route(session, args["subagent_type"], args["description"], args.get("model"),
                                       args.get("effort"), project_dir=cwd, harness=harness)
            return {k: r.get(k) for k in ("decision", "model", "effort", "reason", "hint", "fallback")}
        if tool == "lesson_lookup":
            role, phase = args["role"], args["phase"]
            if self.guard is not None:   # served items reach the agent only wrapped by the guard, with its rule
                g = self._guard_session(session, role)
                b = self.guard.fetch(g["session_token"], phase)
                return {"role": role, "phase": phase, "version": b.get("version"), "catalog": b.get("catalog", ""),
                        "items": [{"id": i["id"], "text": i["text"]} for i in b.get("items", [])],
                        "rule": g["rule"], "fallback": None}
            res = self.connector.fetch_served(self.conclusions.session_ref(session), role, phase)
            if not res.ok or not isinstance(res.body, dict):
                return open_answer(tool, args)
            b = res.body
            return {"role": role, "phase": phase, "version": b.get("version"), "catalog": b.get("catalog", ""),
                    "items": [{"id": i["id"], "text": i["text"]} for i in b.get("items", [])], "fallback": None}
        if tool == "savings":
            res = self.metrics.savings()
            if res.ok:
                return {"saved": res.body, "fallback": None, "reason": None}
            return {"saved": None, "fallback": "local_only", "reason": res.error or "failed"}
        r = self.conclusions.checkpoint(session, context_pct=args["context_pct"],
                                        **{k: args.get(k, 0) for k in _COUNTER_ARGS})
        return {"now": r.get("now"), "keep_lines": r.get("keep_lines"), "fallback": r.get("fallback")}
