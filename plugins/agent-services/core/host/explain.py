"""显示用的小工具：密钥脱敏（redact）；description 脱敏、压成一行、截断。

用它的是要把文字显示出来或发出去之前先去掉密钥的地方。
"""
from __future__ import annotations

import re

DESC_LIMIT = 200
RAW_LIMIT = 4000
TASK_LIMIT = 80

_SECRET_RES = [
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----"),
    # ASCII word edges, not \b: Python's \b counts CJK as word characters, so "令牌ghp_…" would slip past
    re.compile(r"(?<![A-Za-z0-9_])sk-ant-[A-Za-z0-9_-]{16,}"),
    re.compile(r"(?<![A-Za-z0-9_])sk-(?:proj-)?[A-Za-z0-9_-]{16,}"),
    re.compile(r"(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})"),
    re.compile(r"(?<![A-Za-z0-9_])bot\d{6,}:[A-Za-z0-9_-]{20,}"),
    # 聊天机器人令牌的裸格式（无 bot 前缀）：<数字>:<长串>
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
    """遮住文本里像密钥的部分（私钥块、各家 API 令牌、Authorization 头、key=…、--token …）。"""
    if not text:
        return text
    out = text
    for rx in _SECRET_RES:
        if rx.groups >= 1:
            out = rx.sub(lambda m: m.group(1) + "<redacted>", out)
        else:
            out = rx.sub("<redacted>", out)
    return out


TOKEN_MASK = "[令牌已隐去]"
_HEX64 = re.compile(r"(?<![0-9A-Fa-f])[0-9A-Fa-f]{64}(?![0-9A-Fa-f])")


def scrub(text: str, known_tokens=()) -> str:
    """同一套脱敏（redact，含聊天机器人令牌）+ 令牌遮挡：已知令牌原样替换，
    任何 64 位十六进制串一律遮挡（会话令牌就是这个形状；不查 store，宁可多遮）。"""
    if not text:
        return text or ""
    for t in known_tokens or ():
        if isinstance(t, str) and len(t) >= 16:
            text = text.replace(t, TOKEN_MASK)
    text = redact(text)
    return _HEX64.sub(TOKEN_MASK, text)


def clean_description(raw, limit: int = DESC_LIMIT):
    """工具调用的 description → 脱敏、压成一行、截断；不是非空字符串返回 None。先脱敏再截断，截断不会留下半截密钥。"""
    if not isinstance(raw, str):
        return None
    # 先按 RAW_LIMIT 粗截（防超长输入拖慢脱敏），再脱敏、再按 limit 截：粗截处若切断密钥也远在显示范围之外
    text = " ".join(redact(raw[:RAW_LIMIT]).split())
    if not text:
        return None
    if len(text) > limit:
        text = text[:limit] + "…"
    return text
