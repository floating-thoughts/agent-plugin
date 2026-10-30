"""A small JSON Schema subset, standard library only: check a value against a schema (check_schema) and check a
schema itself (schema_problems). Request and response bodies of host/service_api.json are validated with it."""
from __future__ import annotations

import json
from pathlib import Path

SCHEMA_KEYWORDS = frozenset({
    "$ref", "type", "properties", "required", "additionalProperties", "items", "enum", "const",
    "pattern", "maxLength", "minLength", "minimum", "maximum", "anyOf", "description",
    "maxItems", "minItems", "uniqueItems",
    "x-served",   # svc/1: marks a response property as served content (outbox keeps only sha256 hashes)
})
_TYPES = {
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "string": lambda v: isinstance(v, str),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
    "null": lambda v: v is None,
}


def _resolve(schema: dict, root: dict) -> dict:
    while "$ref" in schema:
        ref = schema["$ref"]
        if not ref.startswith("#/"):
            raise ValueError(f"只支持文件内引用：{ref}")
        node = root
        for part in ref[2:].split("/"):
            node = node[part]
        schema = node
    return schema


def _anchor_end(pattern: str) -> str:
    r"""结尾的 $ 换成 \Z：Python 的 $ 允许值末尾多一个换行（"demo\n" 会过 ^[a-z]+$）。"""
    if pattern.endswith("$") and not pattern.endswith(r"\$"):
        return pattern[:-1] + r"\Z"
    return pattern


def check_schema(value, schema: dict, root: dict | None = None, where: str = "$") -> list[str]:
    """按 SCHEMA_KEYWORDS 这个子集校验 value，返回问题列表（空 = 通过）。root 用来解析 $ref。"""
    import re
    root = root if root is not None else schema
    s = _resolve(schema, root)
    if "anyOf" in s:
        branches = [check_schema(value, b, root, where) for b in s["anyOf"]]
        if not any(not b for b in branches):
            return [f"{where}: 不符合 anyOf 任何一支（{branches[0][0] if branches[0] else ''}）"]
    t = s.get("type")
    if t is not None:
        ts = t if isinstance(t, list) else [t]
        if not any(_TYPES[x](value) for x in ts):
            return [f"{where}: 类型应为 {t}，实际 {type(value).__name__}"]
    out = []
    if "const" in s and value != s["const"]:
        out.append(f"{where}: 应为 {s['const']!r}")
    if "enum" in s and value not in s["enum"]:
        out.append(f"{where}: {value!r} 不在 {s['enum']}")
    if isinstance(value, str):
        if "pattern" in s and not re.search(_anchor_end(s["pattern"]), value):
            out.append(f"{where}: {value[:60]!r} 不匹配 {s['pattern']}")
        if "maxLength" in s and len(value) > s["maxLength"]:
            out.append(f"{where}: 长度 {len(value)} > {s['maxLength']}")
        if "minLength" in s and len(value) < s["minLength"]:
            out.append(f"{where}: 长度 {len(value)} < {s['minLength']}")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in s and value < s["minimum"]:
            out.append(f"{where}: {value} < {s['minimum']}")
        if "maximum" in s and value > s["maximum"]:
            out.append(f"{where}: {value} > {s['maximum']}")
    if isinstance(value, dict):
        props = s.get("properties", {})
        for k in s.get("required", ()):
            if k not in value:
                out.append(f"{where}: 缺字段 {k}")
        for k, v in value.items():
            if k in props:
                out.extend(check_schema(v, props[k], root, f"{where}.{k}"))
            elif s.get("additionalProperties") is False:
                out.append(f"{where}: 多了字段 {k}")
    if isinstance(value, list):
        if "maxItems" in s and len(value) > s["maxItems"]:
            out.append(f"{where}: {len(value)} 项 > {s['maxItems']}")
        if "minItems" in s and len(value) < s["minItems"]:
            out.append(f"{where}: {len(value)} 项 < {s['minItems']}")
        if s.get("uniqueItems") and len({json.dumps(v, sort_keys=True) for v in value}) < len(value):
            out.append(f"{where}: 有重复项")
    if isinstance(value, list) and "items" in s:
        for i, v in enumerate(value):
            out.extend(check_schema(v, s["items"], root, f"{where}[{i}]"))
    return out


def schema_problems(schema, root: dict | None = None, where: str = "$") -> list[str]:
    """自检 schema 本身：只用 SCHEMA_KEYWORDS、type 取值合法、$ref 能解析。"""
    root = root if root is not None else schema
    out = []
    if not isinstance(schema, dict):
        return [f"{where}: schema 应为对象"]
    for k in schema:
        if k not in SCHEMA_KEYWORDS:
            out.append(f"{where}: 不支持的关键字 {k}")
    if "$ref" in schema:
        try:
            _resolve(schema, root)
        except (KeyError, ValueError) as e:
            out.append(f"{where}: $ref 解析不了（{e}）")
    t = schema.get("type")
    for x in (t if isinstance(t, list) else [t] if t else []):
        if x not in _TYPES:
            out.append(f"{where}: 未知类型 {x}")
    for k, v in schema.get("properties", {}).items():
        out.extend(schema_problems(v, root, f"{where}.{k}"))
    if isinstance(schema.get("items"), dict):
        out.extend(schema_problems(schema["items"], root, f"{where}[]"))
    for i, b in enumerate(schema.get("anyOf", ())):
        out.extend(schema_problems(b, root, f"{where}|{i}"))
    for k in schema.get("required", ()):
        if "properties" in schema and k not in schema["properties"]:
            out.append(f"{where}: required 里的 {k} 没在 properties 里")
    return out


def load_contract(path) -> dict:
    """The contract JSON at `path`. An optional companion `<name>_private.json` next to it, when present, adds
    definitions (replacing same-named ones), routes, enum values ("Definition.property": [values]), route
    inventory texts ("METHOD /path": {...}) and client tables (kept as "x-private-client"); without a companion
    the file loads unchanged."""
    p = Path(path)
    api = json.loads(p.read_text(encoding="utf-8"))
    ext_file = p.with_name(p.stem + "_private" + p.suffix)
    if not ext_file.is_file():
        return api
    ext = json.loads(ext_file.read_text(encoding="utf-8"))
    api["definitions"].update(ext.get("x-private-definitions") or {})
    api["routes"].extend((ext.get("x-private-routes") or {}).get("routes") or [])
    for key, values in (ext.get("x-private-enums") or {}).items():
        name, prop = key.split(".", 1)
        enum = api["definitions"][name]["properties"][prop]["enum"]
        enum.extend(v for v in values if v not in enum)
    inv = {k: v for k, v in (ext.get("x-private-inventory") or {}).items() if k != "note"}
    for r in api["routes"]:
        k = f"{r['method']} {r['path']}"
        if k in inv:
            r["x-inventory"] = inv[k]
    if ext.get("x-private-client"):
        api["x-private-client"] = {k: v for k, v in ext["x-private-client"].items() if k != "note"}
    return api
