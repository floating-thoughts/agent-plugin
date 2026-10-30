"""The open client shell for the conclusion services.

The routing table, the checkpoint rule and the run-limit table live on the server; this file only builds the
minimal records, sends them through the connector (host/services.py) and falls back to open defaults when
the service is unavailable. What leaves the machine: the first word of a subagent description, its length, a per-
session dispatch number, a salted project hash, the command head (only from the public KNOWN_HEADS list) and run
durations. The rest of the description, argv beyond the head, paths and the local session id never leave, are
never logged and never reach the outbox.
"""
from __future__ import annotations

import hashlib
import hmac
import math
import re
import secrets
import threading
from pathlib import Path

from host.httpbase import restrict_file

OPEN_DEFAULTS = {"idle_seconds": 180, "max_seconds": 3600}

# Public list of common developer commands. A privacy filter: any other name is sent as "other",
# so a customer's own script or module name never leaves the machine.
KNOWN_HEADS = frozenset({
    "python", "node", "deno", "bun", "npm", "npx", "pnpm", "yarn", "pytest", "pip", "pip3", "uv", "uvx", "poetry",
    "cargo", "rustc", "go", "gradle", "gradlew", "mvn", "java", "javac", "dotnet", "msbuild", "make", "cmake",
    "ninja", "docker", "kubectl", "git", "gh", "bash", "sh", "zsh", "pwsh", "powershell", "cmd", "mypy", "ruff",
    "tox", "nox", "black", "flake8", "pylint", "eslint", "tsc", "jest", "vitest", "playwright", "terraform",
})
_PYTHONS = re.compile(r"^(python|python3|python3\.\d+|py|pythonw)$")
_SUFFIXES = (".exe", ".cmd", ".bat", ".ps1", ".sh", ".py")

ROUTER_NOTICE = "The routing service is temporarily unavailable; this subagent dispatch runs as written, with the model and effort the caller set."

_EFFORTS = ("low", "medium", "high", "xhigh", "max")
_MODEL_RX = re.compile(r"^[A-Za-z0-9.\[\]_:-]+$")
_SUBTYPE_RX = re.compile(r"^[A-Za-z0-9 _.:-]+$")
_CAP = 1000000
_DUR_CAP = 604800


def type_word(description) -> str:
    parts = description.split() if isinstance(description, str) else []
    return parts[0][:32] if parts else ""


def _base(word: str) -> str:
    b = re.split(r"[\\/]", word)[-1].lower()
    for suf in _SUFFIXES:
        if b.endswith(suf):
            b = b[: -len(suf)]
            break
    return b


def head_word(argv) -> str:
    if not argv:
        return "other"
    b = _base(str(argv[0]))
    if _PYTHONS.match(b):
        args = [str(a) for a in argv[1:]]
        for i, a in enumerate(args[:-1]):
            if a == "-m":
                mod = args[i + 1].split(".")[0].lower()
                return mod if mod in KNOWN_HEADS else "python"
        return "python"
    return b if b in KNOWN_HEADS else "other"


def project_hash(salt: bytes, project_dir) -> str:
    key = str(project_dir).replace("\\", "/").rstrip("/").lower()
    return hmac.new(salt, ("project:" + key).encode("utf-8"), hashlib.sha256).hexdigest()[:16]


def _int(v) -> int:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return 0
    if math.isnan(x):
        return 0
    return int(min(max(x, 0), _CAP))


def _pct(v) -> float:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return 0.0
    if math.isnan(x):
        return 0.0
    return min(max(x, 0.0), 100.0)


def _durations(values) -> list:
    out = []
    for v in list(values or ())[-5:]:
        try:
            x = float(v)
        except (TypeError, ValueError):
            continue
        if math.isnan(x):
            continue
        x = min(max(x, 0.0), float(_DUR_CAP))
        out.append(int(x) if x.is_integer() else x)
    return out


class Conclusions:
    def __init__(self, connector, *, harness: str = "claude-code"):
        self.conn = connector
        self.harness = harness if harness in ("claude-code", "opencode", "codex", "other") else "other"
        self._lock = threading.Lock()
        self._refs: dict = {}
        self._dispatch: dict = {}
        self._notified: set = set()
        self.salt = self._load_salt()

    # ---------------- local state
    def _load_salt(self) -> bytes:
        p = Path(self.conn.data_dir) / "services" / "salt"
        try:
            text = p.read_text(encoding="ascii").strip()
            if re.fullmatch(r"[0-9a-f]{64}", text):
                return bytes.fromhex(text)
        except (OSError, ValueError):
            pass
        p.parent.mkdir(parents=True, exist_ok=True)
        raw = secrets.token_bytes(32)
        tmp = p.with_name("salt.tmp")
        tmp.write_text(raw.hex(), encoding="ascii")
        restrict_file(tmp)
        tmp.replace(p)
        restrict_file(p)
        return raw

    def _ref(self, session) -> str:
        key = session if isinstance(session, str) else None
        with self._lock:
            ref = self._refs.get(key)
            if ref is None:
                ref = self._refs[key] = secrets.token_hex(16)
            return ref

    def session_ref(self, session) -> str:
        """The ref the conclusion calls send for `session` (the same one as route and checkpoint use)."""
        return self._ref(session)

    def _phash(self, project_dir):
        return None if project_dir is None else project_hash(self.salt, project_dir)

    def _call(self, path: str, body: dict, kind: str, errors: list | None = None):
        try:
            r = self.conn.call("POST", path, body, kind=kind)
        except Exception:  # noqa: BLE001 — a conclusion never breaks the caller
            return None
        if not r.ok or not isinstance(r.body, dict):
            if errors is not None:
                errors.append(r.error)
            return None
        return r.body

    # ---------------- router
    def route(self, session, subagent_type, description, model=None, effort=None, project_dir=None,
              harness=None) -> dict:
        key = session if isinstance(session, str) else None
        ref = self._ref(session)
        with self._lock:
            n = self._dispatch[key] = self._dispatch.get(key, 0) + 1
        desc = description if isinstance(description, str) else ""
        st = subagent_type if isinstance(subagent_type, str) else ""
        body = {
            "session_ref": ref,
            "type_word": type_word(desc),
            "subagent_type": st[:64],
            "requested_model": model if isinstance(model, str) and model else None,
            "requested_effort": effort if effort in _EFFORTS else None,
            "harness": self.harness if harness is None else (
                harness if harness in ("claude-code", "opencode", "codex", "other") else "other"),
            "desc_len": min(len(desc), 100000),
            "dispatch_no": min(n, _CAP),
            "project_hash": self._phash(project_dir),
        }
        ans, errors = None, []
        if _SUBTYPE_RX.match(body["subagent_type"]) and (body["requested_model"] is None
                                                          or (len(body["requested_model"]) <= 64
                                                              and _MODEL_RX.match(body["requested_model"]))):
            ans = self._call("/router/decide", body, "router", errors)
        if ans is not None and ans.get("decision") in ("route", "pass", "deny"):
            return {"decision": ans["decision"], "model": ans.get("model"), "effort": ans.get("effort"),
                    "reason": ans.get("reason"), "hint": ans.get("hint"), "fallback": None, "notice": None}
        if errors == ["not_in_plan"]:   # not in the plan is not "temporarily unavailable"; no notice
            return {"decision": "pass", "model": None, "effort": None, "reason": None, "hint": None,
                    "fallback": "pass_through", "notice": None}
        with self._lock:
            first = key not in self._notified
            self._notified.add(key)
        return {"decision": "pass", "model": None, "effort": None, "reason": None, "hint": None,
                "fallback": "pass_through", "notice": ROUTER_NOTICE if first else None}

    # ---------------- checkpoint
    def checkpoint(self, session, *, context_pct, turns, tool_calls, todos_done, commits, minutes) -> dict:
        body = {"session_ref": self._ref(session), "context_pct": _pct(context_pct), "turns": _int(turns),
                "tool_calls": _int(tool_calls), "todos_done": _int(todos_done), "commits": _int(commits),
                "minutes": _int(minutes)}
        ans = self._call("/checkpoint/timing", body, "checkpoint")
        if ans is not None and isinstance(ans.get("now"), bool) and isinstance(ans.get("keep_lines"), list):
            return {"now": ans["now"], "keep_lines": [x for x in ans["keep_lines"] if isinstance(x, str)],
                    "fallback": None}
        return {"now": False, "keep_lines": [], "fallback": "no_suggestion"}

    # ---------------- run limits
    def limits(self, argv, *, session=None, project_dir=None, prior_durations=()) -> dict:
        body = {"session_ref": self._ref(session), "head": head_word(list(argv or ())),
                "project_hash": self._phash(project_dir), "prior_durations": _durations(prior_durations)}
        ans = self._call("/limits/run", body, "run_limits")
        if ans is not None:
            idle, mx = ans.get("idle_seconds"), ans.get("max_seconds")
            if isinstance(idle, (int, float)) and isinstance(mx, (int, float)) \
                    and not isinstance(idle, bool) and not isinstance(mx, bool) and idle >= 1 and mx >= 0:
                return {"idle_seconds": idle, "max_seconds": mx, "source": "service", "fallback": None}
        return {**OPEN_DEFAULTS, "source": "default", "fallback": "open_defaults"}
