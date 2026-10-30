"""Display helpers: secret redaction (redact), and description redaction, flattening to one line, and truncation.

Use them wherever text is about to be shown or sent out, to strip secrets first.
"""
from __future__ import annotations

import re

DESC_LIMIT = 200
RAW_LIMIT = 4000
TASK_LIMIT = 80

_SECRET_RES = [
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----"),
    # ASCII word edges, not \b: Python's \b counts CJK characters as word characters, so a token glued to CJK text would slip past
    re.compile(r"(?<![A-Za-z0-9_])sk-ant-[A-Za-z0-9_-]{16,}"),
    re.compile(r"(?<![A-Za-z0-9_])sk-(?:proj-)?[A-Za-z0-9_-]{16,}"),
    re.compile(r"(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})"),
    re.compile(r"(?<![A-Za-z0-9_])bot\d{6,}:[A-Za-z0-9_-]{20,}"),
    # bare chat-bot token format (no bot prefix): <digits>:<long string>
    re.compile(r"(?<![A-Za-z0-9_])\d{6,12}:[A-Za-z0-9_-]{30,}(?![A-Za-z0-9_-])"),
    re.compile(r"(?<![A-Za-z0-9_])xox[abprs]-[A-Za-z0-9-]{10,}"),
    re.compile(r"(?<![A-Za-z0-9_])AKIA[0-9A-Z]{16}(?![A-Za-z0-9_])"),
    re.compile(r"(?<![A-Za-z0-9_])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_])"),
    re.compile(r"(?i)(Authorization:\s*(?:Bearer|Basic)\s+)[A-Za-z0-9._\-+/=]{8,}"),
    re.compile(r"(?i)((?:api[_-]?key|secret|token|passw(?:or)?d|access[_-]?key)\s*[:=]\s*['\"]?)"
               r"([A-Za-z0-9_\-/+=.]{12,})"),
    # command-line flags: --password x, --token=x, -p is too ambiguous to touch
    re.compile(r"(?i)(--(?:password|passwd|pass|token|api-key|apikey|secret|access-key)(?:\s+|=)['\"]?)"
               r"([^\s'\"]{4,})"),
]


def redact(text: str) -> str:
    """Mask the parts of the text that look like secrets (private key blocks, API tokens from each vendor, Authorization headers, key=..., --token ...)."""
    if not text:
        return text
    out = text
    for rx in _SECRET_RES:
        if rx.groups >= 1:
            out = rx.sub(lambda m: m.group(1) + "<redacted>", out)
        else:
            out = rx.sub("<redacted>", out)
    return out


TOKEN_MASK = "[token hidden]"
_HEX64 = re.compile(r"(?<![0-9A-Fa-f])[0-9A-Fa-f]{64}(?![0-9A-Fa-f])")


def scrub(text: str, known_tokens=()) -> str:
    """The same redaction (redact, including chat-bot tokens) plus token masking: known tokens are replaced as they are,
    any 64-digit hex string is always masked (session tokens have this shape; the store is not consulted, so over-masking is preferred)."""
    if not text:
        return text or ""
    for t in known_tokens or ():
        if isinstance(t, str) and len(t) >= 16:
            text = text.replace(t, TOKEN_MASK)
    text = redact(text)
    return _HEX64.sub(TOKEN_MASK, text)


def clean_description(raw, limit: int = DESC_LIMIT):
    """Tool-call description → redact, flatten to one line, truncate; returns None unless it is a non-empty string. Redact before truncating, so truncation never leaves half a secret behind."""
    if not isinstance(raw, str):
        return None
    # Coarse-cut to RAW_LIMIT first (so oversized input cannot slow redaction), then redact, then cut to limit: a secret split by the coarse cut lies far beyond the displayed range
    text = " ".join(redact(raw[:RAW_LIMIT]).split())
    if not text:
        return None
    if len(text) > limit:
        text = text[:limit] + "…"
    return text
