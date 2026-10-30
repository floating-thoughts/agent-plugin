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
            raise ValueError(f"only same-file references are supported: {ref}")
        node = root
        for part in ref[2:].split("/"):
            node = node[part]
        schema = node
    return schema


def _anchor_end(pattern: str) -> str:
    r"""Turn a trailing $ into \Z: Python's $ also matches before a final newline ("demo\n" would pass ^[a-z]+$)."""
    if pattern.endswith("$") and not pattern.endswith(r"\$"):
        return pattern[:-1] + r"\Z"
    return pattern


def check_schema(value, schema: dict, root: dict | None = None, where: str = "$") -> list[str]:
    """Validate value against this SCHEMA_KEYWORDS subset; return the list of problems (empty = pass). root resolves $ref."""
    import re
    root = root if root is not None else schema
    s = _resolve(schema, root)
    if "anyOf" in s:
        branches = [check_schema(value, b, root, where) for b in s["anyOf"]]
        if not any(not b for b in branches):
            return [f"{where}: does not match any anyOf branch ({branches[0][0] if branches[0] else ''})"]
    t = s.get("type")
    if t is not None:
        ts = t if isinstance(t, list) else [t]
        if not any(_TYPES[x](value) for x in ts):
            return [f"{where}: type should be {t}, got {type(value).__name__}"]
    out = []
    if "const" in s and value != s["const"]:
        out.append(f"{where}: should be {s['const']!r}")
    if "enum" in s and value not in s["enum"]:
        out.append(f"{where}: {value!r} is not in {s['enum']}")
    if isinstance(value, str):
        if "pattern" in s and not re.search(_anchor_end(s["pattern"]), value):
            out.append(f"{where}: {value[:60]!r} does not match {s['pattern']}")
        if "maxLength" in s and len(value) > s["maxLength"]:
            out.append(f"{where}: length {len(value)} > {s['maxLength']}")
        if "minLength" in s and len(value) < s["minLength"]:
            out.append(f"{where}: length {len(value)} < {s['minLength']}")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in s and value < s["minimum"]:
            out.append(f"{where}: {value} < {s['minimum']}")
        if "maximum" in s and value > s["maximum"]:
            out.append(f"{where}: {value} > {s['maximum']}")
    if isinstance(value, dict):
        props = s.get("properties", {})
        for k in s.get("required", ()):
            if k not in value:
                out.append(f"{where}: missing field {k}")
        for k, v in value.items():
            if k in props:
                out.extend(check_schema(v, props[k], root, f"{where}.{k}"))
            elif s.get("additionalProperties") is False:
                out.append(f"{where}: unexpected field {k}")
    if isinstance(value, list):
        if "maxItems" in s and len(value) > s["maxItems"]:
            out.append(f"{where}: {len(value)} items > {s['maxItems']}")
        if "minItems" in s and len(value) < s["minItems"]:
            out.append(f"{where}: {len(value)} items < {s['minItems']}")
        if s.get("uniqueItems") and len({json.dumps(v, sort_keys=True) for v in value}) < len(value):
            out.append(f"{where}: has duplicate items")
    if isinstance(value, list) and "items" in s:
        for i, v in enumerate(value):
            out.extend(check_schema(v, s["items"], root, f"{where}[{i}]"))
    return out


def schema_problems(schema, root: dict | None = None, where: str = "$") -> list[str]:
    """Check the schema itself: only SCHEMA_KEYWORDS, valid type values, and a $ref that resolves."""
    root = root if root is not None else schema
    out = []
    if not isinstance(schema, dict):
        return [f"{where}: schema should be an object"]
    for k in schema:
        if k not in SCHEMA_KEYWORDS:
            out.append(f"{where}: unsupported keyword {k}")
    if "$ref" in schema:
        try:
            _resolve(schema, root)
        except (KeyError, ValueError) as e:
            out.append(f"{where}: $ref does not resolve ({e})")
    t = schema.get("type")
    for x in (t if isinstance(t, list) else [t] if t else []):
        if x not in _TYPES:
            out.append(f"{where}: unknown type {x}")
    for k, v in schema.get("properties", {}).items():
        out.extend(schema_problems(v, root, f"{where}.{k}"))
    if isinstance(schema.get("items"), dict):
        out.extend(schema_problems(schema["items"], root, f"{where}[]"))
    for i, b in enumerate(schema.get("anyOf", ())):
        out.extend(schema_problems(b, root, f"{where}|{i}"))
    for k in schema.get("required", ()):
        if "properties" in schema and k not in schema["properties"]:
            out.append(f"{where}: required field {k} is not in properties")
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
