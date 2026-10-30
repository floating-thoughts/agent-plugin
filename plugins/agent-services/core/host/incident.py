"""Incident templating.

Open client code: the client sends only the templated first line of an error and a hash of it, never the raw line,
a path or a file name. The server imports the same `template` and applies it again (it is idempotent), so old or odd
clients still cluster together. Imports nothing from `services`.
"""
from __future__ import annotations

import hashlib
import re
from pathlib import Path

from host.explain import scrub

MAX_TEMPLATE = 300

_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(\.[\w-]+)+")
_URL = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*://[^\s\"'<>`]+")
_QUOTED = re.compile(r"\"[^\"\r\n]*\"|(?<!\w)'[^'\r\n]*'|`[^`\r\n]*`|“[^”\r\n]*”|‘[^’\r\n]*’|\u300c[^\u300d\r\n]*\u300d")  # also Chinese corner quotes
_LEAD = "([{<\"'"
_TRAIL = ")]}>,;:.!?\"'"
_KEEP = frozenset({"url", "str", "path", "hex", "n", "id", "email", "redacted"})
_DRIVE = re.compile(r"^[A-Za-z]:")
_NUMBER = re.compile(r"^[+-]?\d+([.,:]\d+)*(%|ms|s|kb|mb|gb|b)?$", re.IGNORECASE)
_HEXISH = re.compile(r"^[0-9a-fA-F-]{7,}$")
_DOTTED = re.compile(r"^[A-Za-z_$][\w$]*((\.|::)[\w$]+)+$")
_CAMEL = re.compile(r"[a-z][A-Z]")
_EXT = re.compile(r"^\.[a-z0-9]{1,10}$")
_LINE_SPLIT = re.compile(r"[\r\n]")

FIELDS = ("session_ref", "harness", "harness_version", "model", "tool", "error_class", "error_template",
          "error_sha256", "file_ext", "outcome")


def _first_line(line) -> str:
    text = scrub(line if isinstance(line, str) else ("" if line is None else str(line)))
    return _LINE_SPLIT.split(text, 1)[0]


def _core_class(core: str) -> str:
    if core in _KEEP:
        return core
    if "/" in core or "\\" in core or _DRIVE.match(core):
        return "<path>"
    if _NUMBER.match(core):
        return "<n>"
    if _HEXISH.match(core):
        hexd = sum(ch in "0123456789abcdefABCDEF" for ch in core)
        if hexd >= 7 and any(ch.isdigit() for ch in core):
            return "<hex>"
    if any(ch.isdigit() for ch in core):
        return "<id>"
    if _DOTTED.match(core) or "_" in core:
        return "<id>"
    if _CAMEL.search(core) and not core.endswith(("Error", "Exception", "Warning")):
        return "<id>"
    return core


def _token(tok: str) -> str:
    i = 0
    while i < len(tok) and tok[i] in _LEAD:
        i += 1
    j = len(tok)
    while j > i and tok[j - 1] in _TRAIL:
        j -= 1
    lead, core, trail = tok[:i], tok[i:j], tok[j:]
    if not core:
        return tok
    return lead + _core_class(core) + trail


def _once(text: str) -> str:
    text = _EMAIL.sub("<email>", text)
    text = _URL.sub("<url>", text)
    text = _QUOTED.sub("<str>", text)
    out = " ".join(_token(t) for t in text.split())
    return out[:MAX_TEMPLATE].rstrip(" ")


def template(line) -> str:
    """The templated first line (deterministic, idempotent, at most 300 chars)."""
    out = _once(_first_line(line))
    for _ in range(5):   # a cut at 300 chars can leave a fragment that templates again; settle on the fixed point
        again = _once(out)
        if again == out:
            break
        out = again
    return out


def error_hash(line) -> str:
    """Hex sha256 of the scrubbed first line (before step 2), UTF-8."""
    return hashlib.sha256(_first_line(line).encode("utf-8")).hexdigest()


def file_ext(path) -> str | None:
    if path is None:
        return None
    try:
        ext = Path(str(path)).suffix.lower()
    except (TypeError, ValueError):
        return None
    return ext if _EXT.match(ext) else None


def build(session_ref, *, harness, harness_version, model, tool, error_class, error_line, outcome,
          file_path=None) -> dict:
    """The POST /incidents body: exactly the contract fields; the raw line and the path never appear in it."""
    return {
        "session_ref": session_ref,
        "harness": harness,
        "harness_version": harness_version,
        "model": model,
        "tool": tool,
        "error_class": error_class,
        "error_template": template(error_line),
        "error_sha256": error_hash(error_line),
        "file_ext": file_ext(file_path),
        "outcome": outcome,
    }
