"""The client connector, the single egress point to our services.

`Connector` builds every request from `host/service_api.json` (schema allowlist), signs it with the device key,
applies the per-kind total deadline, retries and fallbacks, writes one outbox line per request sent, and keeps the
token, device key and account data in the OS key store (host/services_keystore.py).

CLI: `python -m host.services <serve|ensure|login start|login finish|logout|status|offline on|off|stop|
served status|pin|unpin|channel> --data-dir D [--keystore os|memory] [--allow-plain-loopback]`. Every command but `serve` runs `ensure` first and
talks to the per-user daemon over loopback with the local token from connector.json. `connect --endpoint URL
--server-key K [--server-key K2] [--e2e-key E [--e2e-key E2]] [--pin-sha256 HEX ...]` writes client.json (checked first) and stops a running
daemon so the next command starts one with the new config. Without client.json the shipped production config
host/client_defaults.json is used (`connect` overrides it).

One daemon serves every shell that uses the same data dir. connector.json and GET /local/status name the daemon's
shell version and code root; `ensure` replaces a running daemon only as `replace_daemon` says (a release shell
replaces a dev, unknown or older daemon; a dev shell never replaces a release one).

Never written anywhere (outbox, connector.log, connector.json, settings, notices, errors, CLI output): the token,
the device private key, the raw Claude accountUuid, the plugin update token (`dist_token()` keeps it in this
process's memory only; the outbox line has it as "[redacted]"; the daemon hands it out only on the local route
POST /local/dist/token, to the plugin updater's read-only credential helper).

client.json (<data dir>/services/client.json; `connect` writes it; absent, host/client_defaults.json) has one of two forms:
  direct:  {"endpoint": "https://<IPv4>:<port>", "pin": {"kind": "cert_sha256", "sha256": [1-2 hex]}}
           (the server's own self-signed certificate is pinned; "server_keys" and "e2e_keys" optional)
  tunnel:  {"endpoint": "https://<hostname>[:<port>]", "pin": {"kind": "ca"}, "server_keys": [1-2 base64],
            "e2e_keys": [1-2 base64]}
           (system CA store plus hostname check; a TLS-terminating edge such as a Cloudflare Tunnel sits in between,
           so every answer must carry a valid server signature, see `_verify_response`, and every request but
           GET /health travels in an end-to-end envelope, see host/e2e.py)
With "server_keys" set, an answer that is unsigned, signed by another key, bound to another request (a replay) or
stale is never used: the request fails and the gate closes with reason "unverified" (an unsigned 5xx, 403 or 429, the
edge's own page, counts as an unreachable server and is backed off). Nothing ever falls back to an unverified answer.
With "e2e_keys" set (it needs "server_keys"), the token, the device signature, the request and the answer are sealed
to the first listed key, so the edge sees only the outer path category and ciphertext; there is no plaintext fallback.
The sign-in is bound to the endpoint, pins, server keys and e2e keys it was made with (client_fingerprint): a
client.json that changes any of them drops it with the device binding (sign in again); `connect` says so.
The daemon proves each answer to its local clients (httpbase.daemon_proof over the client's nonce); a client
never uses an answer without it, so a process on the port of a stale connector.json is never the daemon.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import http.client
import json
import os
import random
import re
import secrets
import socket
import ssl
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from host import e2e, httpbase
from host.jsonschema_lite import check_schema, load_contract
from host.services_keystore import KeyStore, KeyStoreUnavailable, MemoryKeyStore, default_keystore

ROOT = Path(__file__).resolve().parents[1]
API = load_contract(Path(__file__).resolve().parent / "service_api.json")
PREFIX = API["prefix"]
_EXT = API.get("x-private-client") or {}   # extra kinds and services from an optional companion contract

TIMEOUTS = {"router": 1, "checkpoint": 5, "served": 5, "run_limits": 2,
            "dist_token": 10, "daily": 30, "auth": 10, "health": 5, **_EXT.get("timeouts", {})}
FALLBACKS = {"router": "pass_through", "checkpoint": "no_suggestion",
             "served": "keep_fetched", "run_limits": "open_defaults",
             "dist_token": "no_update", "daily": "retry_next_day", "auth": None, "health": None,
             **_EXT.get("fallbacks", {})}
ROTATE_MARGIN = 7 * 86400
DIST_RENEW_BEFORE = 600
DIST_TOKEN_RX = re.compile(r"^ghs_[A-Za-z0-9_]{16,251}$")
MAX_ATTEMPTS = 3
BLOCK_SECONDS = {"locked_out": 900, "account_locked": 3600}
THROTTLE_MAX_SECONDS = 300      # the longest Retry-After the connector honors (429 rate_limited, 503 busy)
THROTTLE_NOTICE_AFTER = 120     # a notice only when throttling has lasted this long without one success
NOTICE_EVERY = 3600
OUTBOX_KEEP_DAYS = 90
BODY_LIMIT = API.get("limits", {}).get("body_bytes", 65536)
TEXT_LIMIT = 65536
CORE_BODY_LIMIT = 1048576   # POST /core/event carries whole tool inputs; every other local route keeps 64 KB

SERVICES = ("health", "updates", "incidents", "metrics", "router", "checkpoint", "limits") \
    + tuple(_EXT.get("services", ()))
SERVICE_DEFAULTS = {"health": True, "updates": True, "incidents": False, "metrics": False,
                    "router": True, "checkpoint": True, "limits": True, **_EXT.get("service_defaults", {})}
_EXT_KINDS = _EXT.get("kinds", {})   # path prefix -> kind
RETRY_STATUS = {500, 502, 503, 504}
SERVED_ROLES = tuple(API["definitions"]["ServedRole"]["enum"])
SERVED_CHANNELS = ("stable", "beta")
SERVED_ROUTE = "/served/fetch"
_VERSION = re.compile(API["definitions"]["Version"]["pattern"].rstrip("$") + r"\Z")
KS_NAMES = ("token", "token_next", "device_key", "device_id", "account_id", "plan", "expires_at", "endpoint")

PLAN_PATH = "/auth/plan"   # which plan and routes this account has (an auth route, not in service_api.json)
_PLAN_VALUES = ("diagnostic", "guard", "full")
_ROUTE_KEY = re.compile(r"^(GET|POST|PUT|DELETE) /\S+$")


HELLO_PATH = "/auth/hello"   # the shell handshake (an auth route, not in service_api.json)
CONTRACT = API["api"]
SHELL_STAMP = Path(__file__).with_name("shell_stamp.json")
_RELEASE = re.compile(r"^\d+\.\d+\.\d+$")


def _shell_version() -> str:
    """The stamp's shell version when the file is {"shell": "X.Y.Z"}, else "dev" (the source repository)."""
    try:
        d = json.loads(SHELL_STAMP.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return "dev"
    v = d.get("shell") if isinstance(d, dict) else None
    return v if isinstance(v, str) and _RELEASE.match(v) else "dev"


SHELL_VERSION = _shell_version()
GATE_NOTICES = {
    "login": "agent-services is paused: sign in with /agent-services:agent-services to use this plugin.",
    "locked": "agent-services is paused: this account is locked; contact support.",
    "upgrade": "agent-services is paused: this plugin version is no longer accepted; update the plugin "
               "(minimum {min_shell}).",
    "offline": "agent-services is paused: offline mode is on.",
    "unavailable": "agent-services is paused: the server could not be reached; it tries again at the next session.",
}
# Gate reason "unverified" (an answer failed the server signature check); like "dependency", outside GATE_NOTICES.
UNVERIFIED_NOTICE = ("agent-services is paused: an answer claiming to come from the server was not signed by the "
                     "server's key (a proxy or a fake server may be in the way); nothing it said was used. It tries "
                     "again at the next session; if this keeps happening, check server_keys in client.json.")
_OPEN_STATE = {"open": True, "reason": None, "min_shell": None}

# The one package outside the standard library the shell needs at run time (Ed25519 device keys: sign-in and signed requests).
# Without it the gate stays closed with reason "dependency" and sign-in answers missing_dependency at once.
DEPENDENCY_FIX = "python -m pip install --user cryptography"
DEPENDENCY_NOTICE = ("agent-services is paused: the Python package 'cryptography' is missing; run `"
                     + DEPENDENCY_FIX + "`, then sign in again with /agent-services.")


def missing_dependency() -> str | None:
    """"cryptography" when it cannot be imported, else None. Not cached: a later `pip install` takes effect."""
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey  # noqa: F401
        from cryptography.hazmat.primitives import serialization  # noqa: F401
    except ImportError:
        import importlib
        importlib.invalidate_caches()
        return "cryptography"
    return None


def dependency_error() -> dict:
    return {"error": "missing_dependency", "detail": DEPENDENCY_FIX}


def gate_notice(state) -> str | None:
    """The one notice for a closed gate; None when open or the reason is unknown."""
    if not isinstance(state, dict) or state.get("open"):
        return None
    if state.get("reason") == "dependency":
        return DEPENDENCY_NOTICE
    if state.get("reason") == "unverified":
        return UNVERIFIED_NOTICE
    text = GATE_NOTICES.get(state.get("reason"))
    if text is None:
        return None
    return text.format(min_shell=state.get("min_shell") or "unknown") if "{min_shell}" in text else text


def plan_notice(plan) -> str | None:
    """The one notice per session for a guard plan (shown by the SessionStart hook); None otherwise."""
    if plan != "guard":
        return None
    return ("agent-services: this account's plan does not include every service; the others run on their open "
            "defaults. Plan changes happen on the account, with no reinstall.")


_IP_ENDPOINT = re.compile(r"^https://((\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})):(\d{1,5})$")
# A DNS name whose last label starts with a letter (so never an IPv4 address), optional port, nothing after it.
_HOST_ENDPOINT = re.compile(r"^https://((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?)"
                            r"(?::(\d{1,5}))?\Z")
_SERVER_KEY = re.compile(r"^[A-Za-z0-9+/]{43}=\Z")   # base64 of a raw 32-byte Ed25519 public key
SIG_HEADER = "x-agent-server-signature"            # lowercase, as the response headers are kept
CHALLENGE_HEADER = "X-Agent-Challenge"
SIG_DOMAIN = "agent-svc-response/1"
SIG_SKEW_SECONDS = 300                              # a signed answer older or newer than this is stale
_SIG_FIELDS = re.compile(r"^v=1; kid=([0-9a-f]{16}); ts=(\d{1,12}); sig=([A-Za-z0-9+/]{86}==)\Z")
UNVERIFIED_ERRORS = ("unsigned_response", "bad_signature", "stale_response")
E2E_RESPONSE_ERRORS = ("undecryptable_response",)  # signed, but the sealed answer does not open: never used
EDGE_STATUS = (403, 429)          # an unsigned 403 / 429 is the edge's own refusal (WAF, rate rule): back off
UNSIGNED_RETRY_MAX = 60           # the longest unsigned Retry-After honored while server_keys is set
EDGE_COOL_SECONDS = 30            # backoff after an edge refusal without a usable Retry-After
MAX_RESPONSE_BYTES = 4 * 1048576  # a longer answer is refused (response_too_large), never buffered
_LOOPBACK_ENDPOINT = re.compile(r"^http://(127\.0\.0\.1):(\d{1,5})$")
_HEX64 = re.compile(r"^[0-9a-f]{64}$")
_CODE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")

NOTICE_TEXT = {
    "login_expired": "Your agent-services login expired; sign in again with /agent-services.",
    "session_replaced": "Your account signed in on another device; sign in again here to continue.",
    "claude_account_mismatch": "The Claude account changed since login; sign in again to re-pair this device.",
    "account_locked": "Your agent-services account is locked; contact support.",
    "locked_out": "Too many failed requests; agent-services paused for 15 minutes.",
    "rate_limited": "agent-services is busy and is slowing requests down; the plugin keeps working on its defaults "
                    "and retries on its own.",
    "server_unverified": "agent-services stopped: an answer was not signed by the server's key, so it was not used "
                         "(a proxy or a fake server may be in the way). It tries again at the next session.",
    "endpoint_changed": "The agent-services address or server keys in client.json changed, so this machine was "
                        "signed out; sign in again with /agent-services.",
}

# Dropped when the sign-in no longer belongs to client.json (its fingerprint changed): the sign-in and the device
# binding (a new sign-in registers a fresh device key with whichever server client.json now names).
SIGN_OUT_NAMES = ("token", "token_next", "account_id", "plan", "expires_at", "device_key", "device_id", "endpoint")
# Top-level request fields never written to the outbox (the sign-in code and anything token-like)
REQUEST_SECRET = ("code", "token", "token_hash", "new_token_hash", "device_key", "password", "secret")


def client_fingerprint(c: dict) -> str | None:
    """The identity a sign-in is bound to: a hash of a parsed client.json's endpoint, certificate pins, server signing
    keys and end-to-end keys (key store name "endpoint"). None for the plain loopback form (tests only)."""
    if c.get("scheme") != "https":
        return None
    doc = {"endpoint": f"{c['scheme']}://{c['host']}:{c['port']}", "ca": bool(c.get("ca")),
           "pins": sorted(str(x).lower() for x in c.get("pins") or []),
           "server_keys": sorted(base64.b64encode(r).decode("ascii") for r in (c.get("server_keys") or {}).values()),
           "e2e_keys": [base64.b64encode(r).decode("ascii") for r in (c.get("e2e_keys") or {}).values()]}
    return "fp1:" + hashlib.sha256(json.dumps(doc, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def sign_out_keystore(ks: KeyStore) -> bool:
    """Drop the sign-in and the device binding (SIGN_OUT_NAMES). True when a token was stored. Best effort per name."""
    try:
        had = bool(ks.get("token"))
    except KeyStoreUnavailable:
        had = True
    for n in SIGN_OUT_NAMES:
        try:
            ks.delete(n)
        except KeyStoreUnavailable:
            pass
    return had


def _private_dirs(data_dir) -> Path:
    """<data dir> and <data dir>/services, created (or narrowed) readable by the current user only."""
    httpbase.private_dir(Path(data_dir))
    return httpbase.private_dir(services_dir(data_dir))


def claude_hash(path=None) -> str:
    """sha256 hex of oauthAccount.accountUuid from ~/.claude.json (or `path`); "" when there is none.

    The raw id never leaves this function."""
    p = path or os.environ.get("AGENT_SVC_CLAUDE_JSON") or (Path.home() / ".claude.json")
    try:
        data = json.loads(Path(p).read_text(encoding="utf-8"))
        uid = data.get("oauthAccount", {}).get("accountUuid")
    except Exception:
        return ""
    if not isinstance(uid, str) or not uid:
        return ""
    return hashlib.sha256(uid.encode("utf-8")).hexdigest()


def services_dir(data_dir) -> Path:
    return Path(data_dir) / "services"


def outbox_path(data_dir) -> Path:
    return services_dir(data_dir) / "outbox.jsonl"


def default_data_dir() -> Path:
    env = os.environ.get("AGENT_SVC_DATA_DIR")
    return Path(env) if env else Path.home() / ".agent-services"


def _iso(ts: float) -> str:
    d = datetime.fromtimestamp(ts, timezone.utc)
    return d.strftime("%Y-%m-%dT%H:%M:%S.") + f"{d.microsecond // 1000:03d}Z"


def _parse_iso(text: str) -> float | None:
    try:
        return datetime.strptime(text.rstrip("Z").split(".")[0], "%Y-%m-%dT%H:%M:%S").replace(
            tzinfo=timezone.utc).timestamp()
    except (ValueError, AttributeError):
        return None


def _dumps(body) -> bytes:
    return json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


class _RealClock:
    def now(self) -> float:
        return time.time()


@dataclass
class Result:
    ok: bool
    status: int | None = None
    body: Any = None
    error: str | None = None
    fallback: str | None = None
    attempts: int = 0

    def to_dict(self) -> dict:
        return {"ok": self.ok, "status": self.status, "body": self.body, "error": self.error,
                "fallback": self.fallback, "attempts": self.attempts}


class _PinError(Exception):
    pass


class _PinnedHTTPS(http.client.HTTPSConnection):
    """HTTPS that trusts only the pinned certificate SHA-256 (no system trust store, no hostname check)."""

    def __init__(self, host, port, pins, timeout):
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        super().__init__(host, port, timeout=timeout, context=ctx)
        self._pins = pins

    def connect(self):
        super().connect()
        der = self.sock.getpeercert(binary_form=True) or b""
        fp = hashlib.sha256(der).hexdigest()
        if not any(hmac.compare_digest(fp, p) for p in self._pins):
            self.sock.close()
            self.sock = None
            raise _PinError("certificate does not match the pin")


class _CAHTTPS(http.client.HTTPSConnection):
    """HTTPS verified the normal way: the system CA store (or `ca_file` alone, tests) and the hostname."""

    def __init__(self, host, port, ca_file, timeout):
        ctx = ssl.create_default_context(cafile=ca_file)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        super().__init__(host, port, timeout=timeout, context=ctx)


def _key_id(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()[:16]


def _server_keys(config: dict, required: bool) -> dict:
    """{kid: raw 32-byte public key} from config["server_keys"] (one or two base64 Ed25519 keys; two while rotating)."""
    keys = config.get("server_keys")
    if keys is None and not required:
        return {}
    if not isinstance(keys, list) or not 1 <= len(keys) <= 2 or len(set(map(str, keys))) != len(keys) \
            or not all(isinstance(k, str) and _SERVER_KEY.match(k) for k in keys):
        raise ValueError("config server_keys must be one or two base64 Ed25519 public keys")
    raws = [base64.b64decode(k) for k in keys]
    if any(len(r) != 32 for r in raws):
        raise ValueError("config server_keys must be one or two base64 Ed25519 public keys")
    return {_key_id(r): r for r in raws}


def _with_e2e(config: dict, out: dict, required: bool) -> dict:
    """Adds "e2e_keys" ({kid: raw 32-byte X25519 public key}, in client.json order) and "e2e_send" (the raw key
    requests are sealed to: the first listed; None = no envelope). Required for a hostname endpoint (fail closed);
    an envelope always needs server_keys, so every sealed answer is also signature-checked."""
    keys = config.get("e2e_keys")
    if keys is None:
        if required:
            raise ValueError("a hostname endpoint needs e2e_keys (the server's end-to-end encryption keys)")
        out["e2e_keys"], out["e2e_send"] = {}, None
        return out
    if not isinstance(keys, list) or not 1 <= len(keys) <= 2 or len(set(map(str, keys))) != len(keys) \
            or not all(isinstance(k, str) and e2e.KEY_RX.match(k) for k in keys):
        raise ValueError("config e2e_keys must be one or two base64 X25519 public keys")
    if not out["server_keys"]:
        raise ValueError("config e2e_keys needs server_keys (sealed answers must also be signed)")
    raws = [base64.b64decode(k) for k in keys]
    if any(len(r) != 32 for r in raws):
        raise ValueError("config e2e_keys must be one or two base64 X25519 public keys")
    out["e2e_keys"] = {e2e.key_id(r): r for r in raws}
    out["e2e_send"] = raws[0]
    return out


def parse_client_config(config, allow_plain: bool = False) -> dict:
    """client.json -> {"scheme", "host", "port", "pins", "ca", "server_keys", "e2e_keys", "e2e_send"}; ValueError
    when it is not one of the
    accepted forms (module docstring). Unknown fields are refused, so a typo never silently drops a setting."""
    if not isinstance(config, dict):
        raise ValueError("config must be an object")
    extra = set(config) - {"endpoint", "pin", "server_keys", "e2e_keys", "client_id"}
    if extra:
        raise ValueError(f"config has unknown fields: {', '.join(sorted(extra))}")
    ep = config.get("endpoint")
    if not isinstance(ep, str):
        raise ValueError("config endpoint missing")
    pin = config.get("pin")
    m = _IP_ENDPOINT.match(ep)
    if m:
        if any(int(m.group(i)) > 255 for i in range(2, 6)) or not 0 < int(m.group(6)) < 65536:
            raise ValueError("config endpoint is not a valid IPv4 endpoint")
        if not isinstance(pin, dict):
            raise ValueError("config pin missing")
        if pin.get("kind") == "ca":
            raise ValueError("pin kind ca needs a hostname endpoint (https://<hostname>[:<port>])")
        shas = pin.get("sha256")
        if pin.get("kind") != "cert_sha256" or not isinstance(shas, list) or not 1 <= len(shas) <= 2 \
                or not all(isinstance(x, str) and _HEX64.match(x) for x in shas):
            raise ValueError("config pin must be cert_sha256 with one or two sha256 fingerprints")
        return _with_e2e(config, {"scheme": "https", "host": m.group(1), "port": int(m.group(6)), "pins": list(shas),
                                  "ca": False, "server_keys": _server_keys(config, False)}, False)
    m = _HOST_ENDPOINT.match(ep)
    if m and len(m.group(1)) <= 253:
        port = int(m.group(2)) if m.group(2) else 443
        if not 0 < port < 65536:
            raise ValueError("config endpoint port is out of range")
        if pin != {"kind": "ca"}:
            raise ValueError('a hostname endpoint needs pin {"kind": "ca"} (system CA store and hostname check)')
        return _with_e2e(config, {"scheme": "https", "host": m.group(1), "port": port, "pins": [], "ca": True,
                                  "server_keys": _server_keys(config, True)}, True)
    m = _LOOPBACK_ENDPOINT.match(ep)
    if m and allow_plain:
        if isinstance(pin, dict) and pin.get("kind") == "ca":
            raise ValueError("pin kind ca needs a hostname endpoint (https://<hostname>[:<port>])")
        return _with_e2e(config, {"scheme": "http", "host": m.group(1), "port": int(m.group(2)), "pins": [],
                                  "ca": False, "server_keys": _server_keys(config, False)}, False)
    raise ValueError("config endpoint must be https://<IPv4>:<port> or https://<hostname>[:<port>]")


def _verify_response(keys: dict, method: str, wire_path: str, challenge: str, status: int, headers: dict,
                     body: bytes, now: float) -> str | None:
    """None when the answer is signed by one of `keys` for exactly this request (method, path, challenge), with this
    status and body, and a timestamp within SIG_SKEW_SECONDS; else the error code (UNVERIFIED_ERRORS).
    The server builds the same message (wire format: service_api.json x-transport response_signature)."""
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    hv = headers.get(SIG_HEADER)
    if not hv:
        return "unsigned_response"
    m = _SIG_FIELDS.match(hv.strip())
    if not m or m.group(1) not in keys:
        return "bad_signature"
    ts = int(m.group(2))
    msg = "\n".join((SIG_DOMAIN, str(int(status)), method.upper(), wire_path.split("?", 1)[0], challenge, str(ts),
                     hashlib.sha256(body).hexdigest())).encode("utf-8")
    try:
        Ed25519PublicKey.from_public_bytes(keys[m.group(1)]).verify(base64.b64decode(m.group(3)), msg)
    except (InvalidSignature, ValueError):
        return "bad_signature"
    if abs(now - ts) > SIG_SKEW_SECONDS:
        return "stale_response"
    return None


# ------------------------------------------------------------------ routes from the contract

def _resolve(s, root=API):
    while isinstance(s, dict) and "$ref" in s:
        node = root
        for part in s["$ref"][2:].split("/"):
            node = node[part]
        s = node
    return s


def _filter(value, schema):
    """Drop properties not in the schema (recursively, objects with additionalProperties false)."""
    s = _resolve(schema)
    if not isinstance(s, dict):
        return value
    if isinstance(value, dict) and s.get("type") == "object":
        props = s.get("properties", {})
        out = {}
        for k, v in value.items():
            if k in props:
                out[k] = _filter(v, props[k])
            elif s.get("additionalProperties") is not False:
                out[k] = v
        return out
    if isinstance(value, list) and s.get("type") == "array" and "items" in s:
        return [_filter(v, s["items"]) for v in value]
    return value


def _limit_problems(route: dict, body) -> list[str]:
    lim = route.get("x-limits") or {}
    out = []
    if "external_excerpts_total_chars" in lim and isinstance(body, dict):
        ex = body.get("external_excerpts") or []
        total = sum(len(x) for x in ex if isinstance(x, str))
        if total > lim["external_excerpts_total_chars"]:
            out.append("external_excerpts total too long")
    if "excerpt_total_chars" in lim and isinstance(body, dict):
        items = body.get("items") or []
        total = sum(len(i.get("excerpt") or "") for i in items if isinstance(i, dict)
                    and isinstance(i.get("excerpt"), str))
        if total > lim["excerpt_total_chars"]:
            out.append("excerpt total too long")
    return out


def _route_regex(r: dict) -> re.Pattern:
    params = r.get("x-params") or {}
    pat = ""
    for part in re.split(r"(\{[a-z_]+\})", r["path"]):
        if part.startswith("{") and part.endswith("}"):
            p = params.get(part[1:-1], "^[^/]+$")
            pat += "(" + p.lstrip("^").rstrip("$") + ")"
        else:
            pat += re.escape(part)
    return re.compile("^" + pat + "$")


_ROUTES = [(r, _route_regex(r)) for r in API["routes"]]
_SERVED_RESPONSE = next(r for r in API["routes"] if r["path"] == SERVED_ROUTE)["responses"]["200"]


def _match_route(method: str, path: str) -> dict | None:
    for r, rx in _ROUTES:
        if r["method"] == method and rx.match(path):
            return r
    return None


def _default_kind(path: str) -> str:
    if path == "/health":
        return "health"
    for prefix, kind in _EXT_KINDS.items():
        if path.startswith(prefix):
            return kind
    if path == "/updates/check" or path.startswith("/packs/") or path == "/incidents" \
            or path.startswith("/metrics") or path == "/report":
        return "daily"
    if path.startswith("/auth/"):
        return "auth"
    if path.startswith("/router/"):
        return "router"
    if path.startswith("/checkpoint/"):
        return "checkpoint"
    if path.startswith("/limits/"):
        return "run_limits"
    if path == "/dist/token":
        return "dist_token"
    if path.startswith("/served/"):
        return "served"
    return "daily"


def _served_props(route: dict) -> tuple[str, ...]:
    """Properties of the 200 response marked "x-served": true (served content, never logged as text)."""
    s = _resolve((route.get("responses") or {}).get("200") or {})
    props = s.get("properties", {}) if isinstance(s, dict) else {}
    return tuple(k for k, v in props.items() if isinstance(v, dict) and v.get("x-served") is True)


def _hash_strings(v):
    if isinstance(v, str):
        return "sha256:" + hashlib.sha256(v.encode("utf-8")).hexdigest()
    if isinstance(v, list):
        return [_hash_strings(x) for x in v]
    if isinstance(v, dict):
        return {k: _hash_strings(x) for k, x in v.items()}
    return v


def _redact_served(text: str, parsed, served: tuple[str, ...]) -> str:
    if not isinstance(parsed, dict):
        return text
    return json.dumps({k: _hash_strings(v) if k in served else v for k, v in parsed.items()}, ensure_ascii=False)


def _valid_version(v) -> bool:
    return isinstance(v, str) and len(v) <= API["definitions"]["Version"].get("maxLength", 40) \
        and bool(_VERSION.match(v))


def _served_summary(text: str):
    """Outbox form of a 2xx served answer: ids, versions and hashes only, never the texts or the catalog."""
    try:
        b = json.loads(text)
    except ValueError:
        return None
    if not isinstance(b, dict):
        return None
    items = b.get("items") if isinstance(b.get("items"), list) else []
    return json.dumps({"role": b.get("role"), "phase": b.get("phase"), "version": b.get("version"),
                       "channel": b.get("channel"), "pinned": b.get("pinned"),
                       "items": [{"id": i.get("id"), "sha256": i.get("sha256")} for i in items
                                 if isinstance(i, dict)]}, ensure_ascii=False)


class _Deadline:
    """Total budget: real monotonic time (minus time really spent sleeping) plus every second handed to sleep."""

    def __init__(self, seconds: float, sleep):
        self.total = float(seconds)
        self._t0 = time.monotonic()
        self._virtual = 0.0
        self._real_slept = 0.0
        self._sleep = sleep

    def elapsed(self) -> float:
        return time.monotonic() - self._t0 - self._real_slept + self._virtual

    def remaining(self) -> float:
        return self.total - self.elapsed()

    def sleep(self, secs: float) -> None:
        t = time.monotonic()
        self._sleep(secs)
        self._real_slept += time.monotonic() - t
        self._virtual += secs


# ------------------------------------------------------------------ connector

class Connector:
    def __init__(self, data_dir, keystore: KeyStore, config: dict, *, clock=None, sleep=None, claude_json=None,
                 timeouts=None, allow_plain_loopback=False, harness="claude-code", client_version=None,
                 gate=False, shell_version=None, ca_file=None):
        if not isinstance(keystore, KeyStore):
            raise TypeError("keystore must be a KeyStore")
        self.data_dir = Path(data_dir)
        self.ks = keystore
        self.clock = clock or _RealClock()
        self._sleep = sleep or time.sleep
        self._claude_json = claude_json
        self.timeouts = dict(TIMEOUTS)
        if timeouts:
            for k, v in timeouts.items():
                if k not in TIMEOUTS:
                    raise ValueError(f"unknown kind {k}")
                self.timeouts[k] = float(v)
        self.harness = harness
        self.client_version = client_version or "0.0.0"
        self._ca_file = ca_file   # tests only: trust this CA file instead of the system store (hostname endpoints)
        self._parse_config(config, allow_plain_loopback)
        self._dir = _private_dirs(self.data_dir)
        self._io_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._rot_lock = threading.Lock()
        self._rot_gen = 0
        self._block: tuple[str, float | None] | None = None
        self._notices: list[dict] = []
        self._last_notice: dict[str, float] = {}
        self._dist_lock = threading.Lock()
        self._dist_cache: dict | None = None   # memory only: never the key store, settings, outbox or a file
        self._settings = self._load_settings()
        self._served_lock = threading.Lock()
        self._served_bind: dict[tuple[str, str], str] = {}   # (session_ref, role) -> version; memory only
        self._plan_routes: frozenset | None = None   # route keys from GET /auth/plan; None = unknown
        self._refused: set[str] = set()              # route keys the server answered 403 not_in_plan
        self.gate = bool(gate)                       # the shell gate (only the daemon turns it on)
        self.shell_version = shell_version or SHELL_VERSION
        self._gs = {"open": False, "reason": "unknown", "min_shell": None}   # memory only
        self._hello_lock = threading.Lock()
        self._cool_until: float | None = None        # server said 429 rate_limited / 503 busy: no sends until then
        self._throttled_since: float | None = None   # first throttled answer since the last success
        self._bind_endpoint()
        self._prune_outbox()

    def _bind_endpoint(self) -> None:
        """The sign-in belongs to the server that issued it: client.json's endpoint, pins, signing keys and end-to-end
        keys (client_fingerprint, key store name "endpoint"). A stored sign-in bound to another fingerprint (client.json
        was changed by hand; `connect` signs out itself) is dropped with the device binding before anything is sent,
        so it never reaches a different server or keys. A sign-in stored before bindings were recorded, or bound by an
        older shell to the bare endpoint that is still the current one, is adopted for the current fingerprint."""
        if self._bind_id is None:
            return
        try:
            tok, bound = self.ks.get("token"), self.ks.get("endpoint")
            if not tok:
                return
            if bound is None or bound == self._endpoint_id:
                self.ks.set("endpoint", self._bind_id)
                return
        except KeyStoreUnavailable:
            return
        if bound != self._bind_id:
            sign_out_keystore(self.ks)
            self._notice("endpoint_changed")

    # ---------------- config and settings
    def _parse_config(self, config, allow_plain):
        c = parse_client_config(config, allow_plain)
        self._scheme, self._host, self._port, self._pins = c["scheme"], c["host"], c["port"], c["pins"]
        self._ca = c["ca"]
        self._server_keys = c["server_keys"]   # {kid: raw public key}; empty = answers are not signature-checked
        self._e2e_send = c["e2e_send"]         # raw X25519 key requests are sealed to; None = no envelope
        # the token is bound to this; the plain loopback form (tests only) is not bound
        self._endpoint_id = f"{c['scheme']}://{c['host']}:{c['port']}" if c["scheme"] == "https" else None
        self._bind_id = client_fingerprint(c)   # endpoint + pins + server keys + e2e keys

    def _settings_path(self) -> Path:
        return self._dir / "settings.json"

    def _load_settings(self) -> dict:
        s = {"offline": False, "services": dict(SERVICE_DEFAULTS),
             "served": {"channel": "stable", "pins": {r: None for r in SERVED_ROLES}}}
        try:
            d = json.loads(self._settings_path().read_text(encoding="utf-8"))
            if isinstance(d.get("offline"), bool):
                s["offline"] = d["offline"]
            for k, v in (d.get("services") or {}).items():
                if k in SERVICE_DEFAULTS and isinstance(v, bool):
                    s["services"][k] = v
            sv = d.get("served") or {}
            if sv.get("channel") in SERVED_CHANNELS:
                s["served"]["channel"] = sv["channel"]
            for k, v in (sv.get("pins") or {}).items():
                if k in SERVED_ROLES and _valid_version(v):
                    s["served"]["pins"][k] = v
        except (OSError, ValueError, AttributeError):
            pass
        return s

    def _save_settings(self) -> None:
        p = self._settings_path()
        tmp = p.with_suffix(".tmp")
        with httpbase.open_private(tmp, "w") as f:
            f.write(json.dumps(self._settings, indent=1))
        os.replace(tmp, p)

    @property
    def offline(self) -> bool:
        return bool(self._settings["offline"])

    def set_offline(self, on: bool) -> None:
        with self._state_lock:
            self._settings["offline"] = bool(on)
            self._save_settings()
        self._set_gate("offline" if on else "unknown")

    # ---------------- the shell gate (handshake with the server)
    def _set_gate(self, reason: str | None, min_shell: str | None = None) -> None:
        with self._state_lock:
            self._gs = {"open": reason is None, "reason": reason, "min_shell": min_shell}

    def gate_state(self) -> dict:
        """{"open", "reason", "min_shell"}; an ungated connector is always open."""
        if not self.gate:
            return dict(_OPEN_STATE)
        with self._state_lock:
            return dict(self._gs)

    def _closed(self) -> bool:
        if not self.gate:
            return False
        with self._state_lock:
            return not self._gs["open"]

    def handshake(self) -> Result:
        """One signed POST /auth/hello; opens or closes the gate. Never raises; one in flight at a time."""
        if not self._hello_lock.acquire(blocking=False):
            return Result(False, body=self.gate_state(), error="busy")
        try:
            try:
                return self._handshake()
            except Exception:  # noqa: BLE001 — never raises
                self._set_gate("unavailable")
                return Result(False, error="failed")
        finally:
            self._hello_lock.release()

    def _handshake(self) -> Result:
        if self.offline:
            self._set_gate("offline")
            return Result(False, error="offline")
        if missing_dependency():
            self._set_gate("dependency")
            return Result(False, body=dependency_error(), error="missing_dependency")
        if not self._ks_get("token") or not self._ks_get("account_id"):
            self._set_gate("login")
            return Result(False, error="not_logged_in")
        blk = self._blocked()
        if blk:
            self._set_gate("locked" if blk in ("account_locked", "locked_out") else "login")
            return Result(False, error=blk)
        if self._cooling():
            return Result(False, error="rate_limited")   # the gate stays as it is; nothing is sent
        d = _Deadline(self.timeouts["auth"], self._sleep)
        err = self._ensure_fresh(d)
        if err:
            self._set_gate("locked" if err in ("account_locked", "locked_out") else "login")
            return Result(False, error=err)
        if not self._ks_get("token"):
            self._set_gate("login")
            return Result(False, error="not_logged_in")
        res = self._exchange("POST", PREFIX + HELLO_PATH,
                             _dumps({"shell": self.shell_version, "contract": CONTRACT}), "auth", d,
                             signed=True, retry=False)
        b = res.body
        if res.ok:
            routes = b.get("routes") if isinstance(b, dict) else None
            if (res.status == 200 and isinstance(b, dict) and set(b) == {"accept", "plan", "routes"}
                    and b["accept"] is True and b.get("plan") in _PLAN_VALUES and isinstance(routes, list)
                    and all(isinstance(r, str) and _ROUTE_KEY.match(r) for r in routes)):
                self.ks.set("plan", b["plan"])
                with self._state_lock:
                    self._plan_routes = frozenset(routes)
                    self._refused.clear()
                self._set_gate(None)
                return res
            self._set_gate("unavailable")
            return Result(False, res.status, None, "bad_response", None, res.attempts)
        if res.status == 426 and res.error == "upgrade_required":
            pass   # _exchange closed the gate with the minimum
        elif res.status == 401:
            self._set_gate("login")
        elif res.status == 423 or (res.status == 429 and res.error == "locked_out"):
            self._set_gate("locked")
        elif _throttled(res.status, res.error):
            pass   # rate limited or busy: the server is up; the gate keeps its state and the connector backs off
        elif res.error in UNVERIFIED_ERRORS or res.error in E2E_RESPONSE_ERRORS:
            self._set_gate("unverified")
        else:
            self._set_gate("unavailable")
        return res

    def set_service(self, name: str, on: bool) -> None:
        if name not in SERVICE_DEFAULTS:
            raise ValueError(f"unknown service {name}")
        with self._state_lock:
            self._settings["services"][name] = bool(on)
            self._save_settings()

    def service_on(self, name: str) -> bool:
        if name == "auth":
            return True
        if name not in SERVICE_DEFAULTS:
            raise ValueError(f"unknown service {name}")
        return bool(self._settings["services"][name])

    # ---------------- served content: channel and pins (settings), session binding (memory)
    def served_pins(self) -> dict:
        with self._state_lock:
            return {r: self._settings["served"]["pins"].get(r) for r in SERVED_ROLES}

    @property
    def served_channel(self) -> str:
        return self._settings["served"]["channel"]

    def set_served_pin(self, role: str, version) -> None:
        if role not in SERVED_ROLES:
            raise ValueError("bad role")
        if version is not None and not _valid_version(version):
            raise ValueError("bad version")
        with self._state_lock:
            self._settings["served"]["pins"][role] = version
            self._save_settings()

    def set_served_channel(self, channel: str) -> None:
        if channel not in SERVED_CHANNELS:
            raise ValueError("bad channel")
        with self._state_lock:
            self._settings["served"]["channel"] = channel
            self._save_settings()

    def served_settings(self) -> dict:
        return {"channel": self.served_channel, "pins": self.served_pins()}

    def session_version(self, session_ref: str, role: str) -> str | None:
        with self._served_lock:
            return self._served_bind.get((session_ref, role))

    def end_served_session(self, session_ref: str) -> None:
        with self._served_lock:
            for k in [k for k in self._served_bind if k[0] == session_ref]:
                del self._served_bind[k]

    def fetch_served(self, session_ref: str, role: str, phase: str) -> Result:
        """One phase of a role's served items. The first successful fetch of (session_ref, role) binds the session
        to the version served; later fetches send it as the pin. The texts stay in memory (Result.body) only."""
        key = (session_ref, role)
        with self._served_lock:
            bound = self._served_bind.get(key) if isinstance(session_ref, str) and isinstance(role, str) else None
        pin = bound if bound is not None else (self.served_pins().get(role) if role in SERVED_ROLES else None)
        body = {"session_ref": session_ref, "role": role, "phase": phase, "pinned_version": pin,
                "channel": self.served_channel}
        res = self.call("POST", SERVED_ROUTE, body)
        if not res.ok and res.status == 409 and res.error == "session_required":
            # a caller without the guard (which opens it first): open the server session, which answers the same
            # on a repeat, then fetch once more; the session material in the answer is not kept here
            opened = self.call("POST", "/served/session", {"session_ref": session_ref, "role": role})
            if opened.ok:
                res = self.call("POST", SERVED_ROUTE, body)
        if not res.ok:
            return res
        b = res.body
        if check_schema(b, _SERVED_RESPONSE, API) or b.get("role") != role or b.get("phase") != phase \
                or (pin is not None and b.get("version") != pin) \
                or any(hashlib.sha256(i["text"].encode("utf-8")).hexdigest() != i["sha256"] for i in b["items"]):
            return Result(False, res.status, None, "bad_response", FALLBACKS["served"], res.attempts)
        with self._served_lock:
            first = key not in self._served_bind
            if first:
                self._served_bind[key] = b["version"]
        self._log({"event": "served_fetch", "session_ref": session_ref, "role": role, "phase": phase,
                   "version": b["version"], "pinned": pin is not None, "first": first, "items": len(b["items"])})
        return res

    def report_incident(self, session_ref, *, harness, harness_version, model, tool, error_class, error_line,
                        outcome, file_path=None) -> Result:
        """Send one incident as a template and a hash (host/incident.py); the raw line and the
        path never leave this function. Switch `incidents` (default off). Nothing is queued or kept: on any
        failure the Result's fallback is "drop"."""
        if self._closed():   # before the incident is built: nothing is scrubbed or kept
            return Result(False, error="inactive", fallback="drop")
        from host import incident
        try:
            body = incident.build(session_ref, harness=harness, harness_version=harness_version, model=model,
                                  tool=tool, error_class=error_class, error_line=error_line, outcome=outcome,
                                  file_path=file_path)
        except Exception:  # noqa: BLE001 — never raise into the caller's error path
            return Result(False, error="invalid_body", fallback="drop")
        res = self.call("POST", "/incidents", body)
        if not res.ok:
            res.fallback = "drop"
        return res

    # ---------------- notices and blocks
    def _notice(self, code: str) -> None:
        now = self.clock.now()
        with self._state_lock:
            last = self._last_notice.get(code)
            if last is not None and now - last < NOTICE_EVERY:
                return
            self._last_notice[code] = now
            self._notices.append({"ts": _iso(now), "code": code,
                                  "text": NOTICE_TEXT.get(code, f"agent-services stopped: {code}")})
        self._log({"event": "notice", "code": code})

    def _distrust(self) -> None:
        """An answer failed verification: close the gate (fail closed) until the next handshake."""
        self._notice("server_unverified")
        if self.gate:
            self._set_gate("unverified")

    def notices(self) -> list[dict]:
        with self._state_lock:
            return [dict(n) for n in self._notices]

    def _blocked(self) -> str | None:
        with self._state_lock:
            if self._block is None:
                return None
            code, until = self._block
            if until is not None and self.clock.now() >= until:
                self._block = None  # one probe allowed; a new failure blocks again
                return None
            return code

    def _set_block(self, code: str, until: float | None) -> None:
        with self._state_lock:
            self._block = (code, until)

    # ---------------- server throttling (429 rate_limited, 503 busy): back off, never block or close the gate
    def _cooling(self) -> bool:
        with self._state_lock:
            return self._cool_until is not None and self.clock.now() < self._cool_until

    def _throttle(self, retry_after) -> None:
        try:
            secs = float(retry_after) if retry_after is not None else 1.0
        except ValueError:
            secs = 1.0
        if secs != secs:
            secs = 1.0
        secs = min(max(secs, 1.0), THROTTLE_MAX_SECONDS)
        now = self.clock.now()
        with self._state_lock:
            self._cool_until = max(self._cool_until or 0.0, now + secs)
            if self._throttled_since is None:
                self._throttled_since = now
            lasting = now - self._throttled_since >= THROTTLE_NOTICE_AFTER
        if lasting:
            self._notice("rate_limited")

    def _unthrottle(self) -> None:
        with self._state_lock:
            self._cool_until = None
            self._throttled_since = None

    # ---------------- key store helpers
    def _ks_get(self, name):
        try:
            return self.ks.get(name)
        except KeyStoreUnavailable:
            return None

    def _drop_token(self) -> bool:
        """Delete the token and the next token; False when the key store refused a delete (it may still hold one)."""
        ok = True
        for n in ("token", "token_next"):
            try:
                self.ks.delete(n)
            except KeyStoreUnavailable:
                ok = False
        return ok

    def _promote_next(self) -> None:
        """The server accepted token_next (a rotation it committed but whose answer was lost): it becomes the token."""
        nxt = self._ks_get("token_next")
        if not nxt:
            return
        try:
            self.ks.set("token", nxt)
            self.ks.delete("token_next")
        except KeyStoreUnavailable:
            pass

    def _expires_at(self) -> float | None:
        v = self._ks_get("expires_at")
        try:
            return float(v) if v is not None else None
        except ValueError:
            return None

    def status(self) -> dict:
        tok, acc = self._ks_get("token"), self._ks_get("account_id")
        exp = self._expires_at()
        logged = bool(tok and acc) and (exp is None or self.clock.now() < exp)
        return {"logged_in": logged, "account_id": acc if logged else None,
                "plan": self._ks_get("plan") if logged else None,
                "expires_at": (int(exp) if exp is not None and exp == int(exp) else exp) if logged else None,
                "offline": self.offline, "blocked": self._blocked()}

    # ---------------- outbox and log
    def _append(self, path: Path, rec: dict) -> None:
        line = json.dumps(rec, ensure_ascii=False) + "\n"
        with self._io_lock:
            with httpbase.open_private(path, "a") as f:
                f.write(line)

    @staticmethod
    def _redact_request(text: str | None) -> str | None:
        """The outbox copy of a request body: top-level REQUEST_SECRET fields (the sign-in code, token hashes) become
        "[redacted]". A body that is not a JSON object is kept as sent."""
        if not text:
            return text
        try:
            obj = json.loads(text)
        except ValueError:
            return text
        if not isinstance(obj, dict) or not any(k in obj for k in REQUEST_SECRET):
            return text
        for k in REQUEST_SECRET:
            if k in obj:
                obj[k] = "[redacted]"
        return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))

    @staticmethod
    def _redact(text: str | None, fields) -> str | None:
        """x-response-secret: the listed top-level fields become "[redacted]" (compact JSON); a body that is not a
        JSON object is not written at all (response_text null), since it could not be checked."""
        if text is None or not fields:
            return text
        try:
            obj = json.loads(text)
        except ValueError:
            return None
        if not isinstance(obj, dict):
            return None
        for f in fields:
            if f in obj:
                obj[f] = "[redacted]"
        return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))

    def _outbox(self, *, service, method, route, body_text, status, response_text, error, preview=False):
        self._append(outbox_path(self.data_dir), {
            "ts": _iso(self.clock.now()), "service": service, "method": method, "route": route[:120],
            "preview": preview, "body_text": self._redact_request(body_text), "status": status,
            "response_text": None if response_text is None else response_text[:TEXT_LIMIT],
            "error": None if error is None else str(error)[:300]})

    def _log(self, rec: dict) -> None:
        rec = {"ts": _iso(self.clock.now()), **rec}
        try:
            self._append(self._dir / "connector.log", rec)
        except OSError:
            pass

    def _prune_outbox(self) -> None:
        p = outbox_path(self.data_dir)
        if not p.exists():
            return
        cutoff = self.clock.now() - OUTBOX_KEEP_DAYS * 86400
        with self._io_lock:
            lines = p.read_text(encoding="utf-8").splitlines(keepends=True)
            keep = []
            for ln in lines:
                try:
                    ts = _parse_iso(json.loads(ln).get("ts"))
                except (ValueError, AttributeError):
                    ts = None
                if ts is None or ts >= cutoff:
                    keep.append(ln if ln.endswith("\n") else ln + "\n")
            if len(keep) != len(lines):
                tmp = p.with_suffix(".tmp")
                with httpbase.open_private(tmp, "w") as f:
                    f.writelines(keep)
                os.replace(tmp, p)

    # ---------------- transport
    def _send_once(self, method: str, wire_path: str, body: bytes | None, headers: dict, timeout: float):
        """One request. Returns (status, headers, bytes) or raises _NetError(code).

        `timeout` bounds the whole exchange, not each read: a timer shuts the socket when it runs out, so a peer that
        trickles bytes cannot hold the call open. An answer longer than MAX_RESPONSE_BYTES is refused unread."""
        timeout = max(timeout, 0.001)
        if self._scheme == "https" and self._ca:
            conn = _CAHTTPS(self._host, self._port, self._ca_file, timeout)
        elif self._scheme == "https":
            conn = _PinnedHTTPS(self._host, self._port, self._pins, timeout)
        else:
            conn = http.client.HTTPConnection(self._host, self._port, timeout=timeout)
        expired = threading.Event()

        def _cut():
            expired.set()
            sock = conn.sock
            if sock is not None:
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

        timer = threading.Timer(timeout, _cut)
        timer.daemon = True
        timer.start()
        try:
            conn.request(method, wire_path, body=body, headers=headers)
            resp = conn.getresponse()
            n = resp.getheader("Content-Length")
            if n is not None and (not n.strip().isdigit() or int(n) > MAX_RESPONSE_BYTES):
                raise _NetError("response_too_large")
            data = resp.read(MAX_RESPONSE_BYTES + 1)
            if len(data) > MAX_RESPONSE_BYTES:
                raise _NetError("response_too_large")
            if expired.is_set():
                raise _NetError("timeout")
            return resp.status, {k.lower(): v for k, v in resp.getheaders()}, data
        except _NetError:
            raise
        except Exception as e:  # noqa: BLE001 — mapped below; a cut socket surfaces as any of them
            if expired.is_set():
                raise _NetError("timeout") from None
            self._net_error(e)
        finally:
            timer.cancel()
            try:
                conn.close()
            except Exception:
                pass

    @staticmethod
    def _net_error(e: BaseException):
        try:
            raise e
        except _PinError:
            raise _NetError("pin_mismatch") from None
        except (socket.timeout, TimeoutError):
            raise _NetError("timeout") from None
        except ConnectionRefusedError:
            raise _NetError("connection_refused") from None
        except (ConnectionResetError, ConnectionAbortedError, http.client.RemoteDisconnected, BrokenPipeError):
            raise _NetError("connection_reset") from None
        except ssl.SSLCertVerificationError:
            raise _NetError("cert_invalid") from None
        except ssl.SSLError:
            raise _NetError("tls_error") from None
        except (OSError, http.client.HTTPException):
            raise _NetError("connection_failed") from None

    def _signed_headers(self, method: str, wire_path: str, body: bytes, token: str) -> dict:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        seed = base64.b64decode(self._ks_get("device_key") or "")
        key = Ed25519PrivateKey.from_private_bytes(seed)
        ts = str(int(self.clock.now()))
        nonce = secrets.token_hex(16)
        msg = f"{method}\n{wire_path.split('?', 1)[0]}\n{hashlib.sha256(body).hexdigest()}\n{ts}\n{nonce}"
        sig = base64.b64encode(key.sign(msg.encode("utf-8"))).decode("ascii")
        return {"Authorization": f"Bearer {token}", "X-Agent-Account": self._ks_get("account_id") or "",
                "X-Agent-Device": self._ks_get("device_id") or "", "X-Agent-Claude": claude_hash(self._claude_json),
                "X-Agent-Timestamp": ts, "X-Agent-Nonce": nonce, "X-Agent-Signature": sig}

    def _exchange(self, method, wire_path, body: bytes | None, service: str, deadline: _Deadline, *,
                  signed: bool, retry: bool = True, served: tuple[str, ...] = (), secret=None) -> Result:
        """Send with retries inside the deadline; one outbox line per request sent. Handles 401/423/429 blocks."""
        attempts = 0
        last: Result | None = None
        t0 = time.monotonic()
        use_next = False   # after a 401 with the token: token_next once (a rotation whose answer was lost)
        while True:
            remaining = deadline.remaining()
            if remaining <= 0:
                last = Result(False, error="timeout", attempts=attempts)
                break
            headers = {"User-Agent": f"agent-services/{self.client_version}", "Accept": "application/json"}
            if method == "POST":
                headers["Content-Type"] = "application/json"
            if signed:
                token = self._ks_get("token_next" if use_next else "token")
                if not token:
                    last = Result(False, error="not_logged_in", attempts=attempts)
                    break
                if missing_dependency():
                    last = Result(False, body=dependency_error(), error="missing_dependency", attempts=attempts)
                    break
                headers.update(self._signed_headers(method, wire_path, body or b"", token))
            challenge = None
            if self._server_keys:
                if missing_dependency():   # an answer that cannot be verified is never used
                    last = Result(False, body=dependency_error(), error="missing_dependency", attempts=attempts)
                    break
                challenge = secrets.token_hex(16)
                headers[CHALLENGE_HEADER] = challenge
            # The end-to-end envelope (host/e2e.py): with e2e_keys set, everything but GET /health is sealed; the
            # outer request carries only the path category, the key id, the ephemeral key, a timestamp and the
            # challenge. There is no plaintext fallback: a request that cannot be sealed is not sent.
            ctx = None
            out_method, out_path, out_body, out_headers = method, wire_path, body, headers
            if self._e2e_send is not None and wire_path.split("?", 1)[0] != "/health":
                try:
                    out_path, sealed_hdrs, out_body, ctx = e2e.seal_request(
                        self._e2e_send, method, wire_path, headers, body, int(self.clock.now()), challenge)
                except e2e.EnvelopeError:
                    last = Result(False, error="e2e_failed", attempts=attempts)
                    break
                out_method = "POST"
                out_headers = {"User-Agent": headers["User-Agent"], "Accept": e2e.CONTENT_TYPE, **sealed_hdrs}
            attempts += 1
            body_text = body.decode("utf-8") if body is not None else None
            try:
                status, rh, data = self._send_once(out_method, out_path, out_body, out_headers, remaining)
            except _NetError as e:
                self._outbox(service=service, method=method, route=wire_path.split("?", 1)[0],
                             body_text=body_text, status=None, response_text=None, error=e.code)
                last = Result(False, error=e.code, attempts=attempts)
                if e.code in ("connection_refused", "connection_reset") and retry:
                    if self._backoff(attempts, None, deadline):
                        continue
                break
            if challenge is not None:
                bad = _verify_response(self._server_keys, out_method, out_path, challenge, status, rh, data,
                                       self.clock.now())
                if bad:
                    # Never used, never logged: only the error code reaches the outbox (status unknown).
                    self._outbox(service=service, method=method, route=wire_path.split("?", 1)[0],
                                 body_text=body_text, status=None, response_text=None, error=bad)
                    if bad == "unsigned_response" and status >= 500:
                        # the edge's own error page (origin down): an unreachable server, retried like one
                        last = Result(False, error="server_unreachable", attempts=attempts)
                        if retry and status in RETRY_STATUS and self._backoff(attempts, None, deadline):
                            continue
                        break
                    if bad == "unsigned_response" and status in EDGE_STATUS:
                        # the edge's own refusal (a WAF or rate rule): not a forgery, so the gate is not closed as
                        # unverified; the connector backs off (Retry-After capped, as it is unsigned) instead
                        last = Result(False, error="server_unreachable", attempts=attempts)
                        self._throttle(self._unsigned_retry(rh.get("retry-after"), EDGE_COOL_SECONDS))
                        break
                    last = Result(False, error=bad, attempts=attempts)
                    self._distrust()
                    break
                # the signature covers status and body, not headers: an outer Retry-After is capped (a sealed answer's
                # own headers replace these below and are authenticated)
                rh = dict(rh)
                if "retry-after" in rh:
                    rh["retry-after"] = str(self._unsigned_retry(rh["retry-after"], 1.0))
            if ctx is not None:
                if status == 200 and (rh.get("content-type") or "").split(";")[0].strip() == e2e.CONTENT_TYPE:
                    try:
                        status, ih, data = e2e.open_response(ctx, data)
                    except e2e.EnvelopeError:
                        self._outbox(service=service, method=method, route=wire_path.split("?", 1)[0],
                                     body_text=body_text, status=None, response_text=None,
                                     error="undecryptable_response")
                        last = Result(False, error="undecryptable_response", attempts=attempts)
                        self._distrust()
                        break
                    rh = {k.lower(): v for k, v in ih.items()}   # sealed: these headers are authenticated
                elif 200 <= status < 300:
                    # a signed success that is not sealed is never used for a sealed request
                    self._outbox(service=service, method=method, route=wire_path.split("?", 1)[0],
                                 body_text=body_text, status=None, response_text=None,
                                 error="undecryptable_response")
                    last = Result(False, error="undecryptable_response", attempts=attempts)
                    self._distrust()
                    break
            text = data.decode("utf-8", errors="replace")
            parsed = None
            if data:
                try:
                    parsed = json.loads(text)
                except ValueError:
                    parsed = None
            logged = _redact_served(text, parsed, served) if served and 200 <= status < 300 else text
            if 200 <= status < 300 and wire_path.split("?", 1)[0] == PREFIX + SERVED_ROUTE:
                logged = _served_summary(text)   # ids, versions and hashes only
            if secret:
                logged = self._redact(logged, secret)
            self._outbox(service=service, method=method, route=wire_path.split("?", 1)[0],
                         body_text=body_text, status=status, response_text=logged, error=None)
            if use_next and status != 401:
                self._promote_next()
            if 200 <= status < 300:
                last = Result(True, status, parsed, None, None, attempts)
                self._unthrottle()
                break
            code = _error_code(parsed, status)
            last = Result(False, status, parsed, code, None, attempts)
            if status == 401 and signed and not use_next and self._ks_get("token_next"):
                use_next = True
                continue
            if status == 401 and signed:
                self._dist_cache = None
                self._reset_plan()
                self._drop_token()
                self._set_block(code, None)
                self._notice(code)
                self._set_gate("login")
                break
            if status == 423:
                self._set_block(code, self.clock.now() + BLOCK_SECONDS["account_locked"])
                self._notice(code)
                if signed:
                    self._set_gate("locked")
                break
            if status == 429 and code == "locked_out":
                self._set_block(code, self.clock.now() + BLOCK_SECONDS["locked_out"])
                self._notice(code)
                if signed:
                    self._set_gate("locked")
                break
            if signed and status == 426 and code == "upgrade_required":
                ms = parsed.get("min_shell") if isinstance(parsed, dict) else None
                self._set_gate("upgrade", ms if isinstance(ms, str) and _RELEASE.match(ms) else None)
                break
            if signed and status == 428 and code == "hello_required":
                self._set_gate("unknown")
                break
            throttled = _throttled(status, code)
            if retry and (status in RETRY_STATUS or throttled):
                if self._backoff(attempts, rh.get("retry-after"), deadline):
                    continue
            if throttled:
                self._throttle(rh.get("retry-after"))
            break
        self._log({"route": wire_path.split("?", 1)[0], "status": last.status, "error": last.error,
                   "attempts": attempts, "latency_ms": int((time.monotonic() - t0) * 1000)})
        return last

    @staticmethod
    def _unsigned_retry(value, default: float) -> float:
        """A Retry-After nobody signed: honored, but never longer than UNSIGNED_RETRY_MAX seconds."""
        try:
            secs = float(value) if value is not None else default
        except ValueError:
            secs = default
        if secs != secs:
            secs = default
        return min(max(secs, 1.0), UNSIGNED_RETRY_MAX)

    def _backoff(self, attempts: int, retry_after, deadline: _Deadline) -> bool:
        if attempts >= MAX_ATTEMPTS:
            return False
        delay = 0.5 * 2 ** (attempts - 1) * (1 + random.uniform(0, 0.25))
        if retry_after is not None:
            try:
                delay = max(delay, float(retry_after))
            except ValueError:
                pass
        if delay >= deadline.remaining():
            return False
        deadline.sleep(delay)
        return True

    # ---------------- auth flow
    def _gate(self, kind: str) -> Result | None:
        if self.offline:
            return Result(False, error="offline", fallback=FALLBACKS[kind])
        return None

    def login_start(self, email: str) -> Result:
        g = self._gate("auth")
        if g:
            return g
        if missing_dependency():   # finishing needs a device key: say so before a code is mailed
            return Result(False, body=dependency_error(), error="missing_dependency")
        if not isinstance(email, str) or not 3 <= len(email) <= 254 or "@" not in email:
            return Result(False, error="invalid_body")
        blk = self._blocked()
        if blk == "account_locked":   # a locked_out block (failed signed requests) never stops a fresh sign-in
            return Result(False, error=blk)
        if self._cooling():
            return Result(False, error="rate_limited")
        d = _Deadline(self.timeouts["auth"], self._sleep)
        return self._exchange("POST", PREFIX + "/auth/login/start", _dumps({"email": email}), "auth", d,
                              signed=False)

    def _device(self) -> tuple[str, str]:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        from cryptography.hazmat.primitives import serialization
        dev = self._ks_get("device_id")
        if not dev:
            dev = "dev_" + secrets.token_hex(8)
            self.ks.set("device_id", dev)
        seed_b64 = self._ks_get("device_key")
        key = None
        if seed_b64:
            try:
                key = Ed25519PrivateKey.from_private_bytes(base64.b64decode(seed_b64))
            except Exception:
                key = None
        if key is None:
            key = Ed25519PrivateKey.generate()
            seed = key.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
                                     serialization.NoEncryption())
            self.ks.set("device_key", base64.b64encode(seed).decode("ascii"))
        pub = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        return dev, base64.b64encode(pub).decode("ascii")

    def login_finish(self, email: str, code: str) -> Result:
        g = self._gate("auth")
        if g:
            return g
        if missing_dependency():
            return Result(False, body=dependency_error(), error="missing_dependency")
        if not isinstance(email, str) or not 3 <= len(email) <= 254 or "@" not in email \
                or not isinstance(code, str) or not 1 <= len(code) <= 32:
            return Result(False, error="invalid_body")
        blk = self._blocked()
        if blk == "account_locked":   # a locked_out block (failed signed requests) never stops a fresh sign-in
            return Result(False, error=blk)
        if self._cooling():
            return Result(False, error="rate_limited")
        dev, pub = self._device()
        token = secrets.token_urlsafe(32)
        body = {"email": email, "code": code, "token_hash": hashlib.sha256(token.encode()).hexdigest(),
                "device_pubkey": pub, "device_id": dev}
        ch = claude_hash(self._claude_json)
        if ch:
            body["claude_hash"] = ch
        body["harness"] = self.harness
        d = _Deadline(self.timeouts["auth"], self._sleep)
        res = self._exchange("POST", PREFIX + "/auth/login/finish", _dumps(body), "auth", d, signed=False)
        if res.ok and isinstance(res.body, dict):
            b = res.body
            self.ks.set("token", token)
            if self._bind_id is not None:
                self.ks.set("endpoint", self._bind_id)
            self.ks.delete("token_next")
            for n in ("account_id", "plan", "expires_at"):
                if b.get(n) is not None:
                    self.ks.set(n, str(b[n]))
            with self._state_lock:
                self._block = None
            self._dist_cache = None
            self._reset_plan()
            self._set_gate("unknown")
            if self.gate:
                self.handshake()
        return res

    def logout(self) -> Result:
        g = self._gate("auth")
        if g is not None:
            return g  # offline: nothing sent, the local login stays
        tok = self._ks_get("token")
        if not tok:
            g = Result(False, error="not_logged_in")
        if g is None:
            blk = self._blocked()
            if blk:
                g = Result(False, error=blk)
        if g is None:
            d = _Deadline(self.timeouts["auth"], self._sleep)
            res = self._exchange("POST", PREFIX + "/auth/logout", _dumps({}), "auth", d, signed=True, retry=False)
        else:
            res = g
        self._dist_cache = None
        self._reset_plan()
        dropped = self._drop_token()
        for n in ("account_id", "plan", "expires_at"):
            try:
                self.ks.delete(n)
            except KeyStoreUnavailable:
                pass
        self._set_gate("login")
        if not dropped:   # the key store may still hold the token: never report a sign-out that did not happen
            return Result(False, error="keystore_unavailable")
        return res

    # ---------------- plan
    def _reset_plan(self) -> None:
        with self._state_lock:
            self._plan_routes = None
            self._refused.clear()

    def _plan_refused(self, key: str) -> bool:
        with self._state_lock:
            return key in self._refused or (self._plan_routes is not None and key not in self._plan_routes)

    def plan_info(self) -> Result:
        """GET /auth/plan: store the plan, keep the route set in memory and clear the refused set."""
        if self._closed():
            return Result(False, error="inactive")
        if self.offline:
            return Result(False, error="offline")
        if not self._ks_get("token") or not self._ks_get("account_id"):
            return Result(False, error="not_logged_in")
        blk = self._blocked()
        if blk:
            return Result(False, error=blk)
        d = _Deadline(self.timeouts["auth"], self._sleep)
        err = self._ensure_fresh(d)
        if err:
            return Result(False, error=err)
        if not self._ks_get("token"):
            return Result(False, error="not_logged_in")
        res = self._exchange("GET", PREFIX + PLAN_PATH, None, "auth", d, signed=True)
        if not res.ok:
            return res
        b = res.body
        routes = b.get("routes") if isinstance(b, dict) else None
        if (not isinstance(b, dict) or b.get("plan") not in _PLAN_VALUES or not isinstance(routes, list)
                or not all(isinstance(r, str) and _ROUTE_KEY.match(r) for r in routes)):
            return Result(False, res.status, None, "bad_response", None, res.attempts)
        self.ks.set("plan", b["plan"])
        with self._state_lock:
            self._plan_routes = frozenset(routes)
            self._refused.clear()
        return res

    def session_start(self) -> dict:
        """Refresh the plan at session start; the notice is shown once by the SessionStart hook.
        Gated: the handshake does it (the plan rides along), and a closed gate gives its notice."""
        if self.gate:
            r = self.handshake()
            st = self.gate_state()
            if st["open"]:
                p = r.body["plan"] if r.ok and isinstance(r.body, dict) else self._ks_get("plan")
                return {"plan": p, "notice": plan_notice(p), "gate": st}
            return {"plan": self.status()["plan"], "notice": gate_notice(st), "error": r.error or st["reason"],
                    "gate": st}
        r = self.plan_info()
        if r.ok:
            p = r.body["plan"]
            return {"plan": p, "notice": plan_notice(p)}
        return {"plan": self.status()["plan"], "notice": None, "error": r.error or "failed"}

    def _ensure_fresh(self, deadline: _Deadline) -> str | None:
        """Expiry and rotation before a signed request. Returns an error code or None."""
        exp = self._expires_at()
        if exp is None:
            return None
        now = self.clock.now()
        if now >= exp:
            self._drop_token()
            self._set_gate("login")   # close at once: no business tool stays listed until the next handshake
            self._notice("login_expired")
            return "login_expired"
        if exp - ROTATE_MARGIN > now:
            return None
        gen = self._rot_gen
        with self._rot_lock:
            if self._rot_gen != gen:
                return None  # another thread rotated (or tried); use its result
            exp = self._expires_at()
            if exp is None or exp - ROTATE_MARGIN > self.clock.now():
                return None
            try:
                # an earlier rotation the server may have committed (its answer lost) is offered again, not replaced
                new = self._ks_get("token_next") or secrets.token_urlsafe(32)
                self.ks.set("token_next", new)
                res = self._exchange("POST", PREFIX + "/auth/rotate",
                                     _dumps({"new_token_hash": hashlib.sha256(new.encode()).hexdigest()}),
                                     "auth", deadline, signed=True)
                if res.ok and isinstance(res.body, dict) and res.body.get("expires_at") is not None:
                    self.ks.set("token", new)
                    self.ks.set("expires_at", str(res.body["expires_at"]))
                    try:
                        self.ks.delete("token_next")
                    except KeyStoreUnavailable:
                        pass
                # not confirmed: token_next stays; a 401 with the token tries it once (_exchange) and promotes it
                if res.status == 401 or self._blocked():
                    return res.error
                return None
            finally:
                self._rot_gen += 1

    def health(self) -> Result:
        return self.call("GET", "/health")

    def _prepare(self, method: str, path: str, body):
        """-> (route, sub_path, wire_path, body_bytes) or a Result error."""
        method = (method or "").upper()
        p = path or ""
        if p.startswith(PREFIX + "/"):
            p = p[len(PREFIX):]
        sub, _, query = p.partition("?")
        route = _match_route(method, sub)
        if route is None:
            return Result(False, error="unknown_route")
        wire = sub if sub == "/health" else PREFIX + sub
        if query:
            wire += "?" + query
        data = None
        if method == "POST":
            schema = route.get("request")
            b = _filter(body if body is not None else {}, schema) if schema else (body or {})
            probs = (check_schema(b, schema, API) if schema else []) + _limit_problems(route, b)
            if probs:
                return Result(False, error="invalid_body")
            data = _dumps(b)
            if len(data) > BODY_LIMIT:
                return Result(False, error="invalid_body")
        return route, sub, wire, data

    def preview(self, method: str, path: str, body=None) -> str | None:
        prep = self._prepare(method, path, body)
        if isinstance(prep, Result):
            return None
        route, sub, wire, data = prep
        text = data.decode("utf-8") if data is not None else None
        self._outbox(service=route["x-inventory"]["service"], method=route["method"], route=wire.split("?", 1)[0],
                     body_text=text, status=None, response_text=None, error=None, preview=True)
        return text

    def call(self, method: str, path: str, body=None, *, kind=None) -> Result:
        p = path or ""
        sub0 = (p[len(PREFIX):] if p.startswith(PREFIX + "/") else p).partition("?")[0]
        if kind is None:
            kind = _default_kind(sub0)
        if kind not in TIMEOUTS:
            raise ValueError(f"unknown kind {kind}")
        fb = FALLBACKS[kind]

        def fail(code, **kw):
            return Result(False, error=code, fallback=fb, **kw)

        if self._closed() and not self._upgrade_route(method, sub0):
            return fail("inactive")   # nothing sent, no outbox line, no log line
        prep = self._prepare(method, path, body)
        if isinstance(prep, Result):
            return fail(prep.error)
        route, sub, wire, data = prep
        service = route["x-inventory"]["service"]
        if self.offline:
            return fail("offline")
        if not self.service_on(service) and not _ungated(route):
            return fail("service_off")
        signed = sub != "/health"
        key = f"{route['method']} {route['path']}"
        if signed and self._plan_refused(key):   # out of plan -> nothing sent, no outbox line
            return fail("not_in_plan")
        if self._cooling():
            return fail("rate_limited")   # honoring the server's Retry-After: nothing sent, the caller's fallback runs
        deadline = _Deadline(self.timeouts[kind], self._sleep)
        if signed:
            blk = self._blocked()
            if blk:
                return fail(blk)
            if not self._ks_get("token") or not self._ks_get("account_id"):
                return fail("not_logged_in")
            err = self._ensure_fresh(deadline)
            if err:
                return fail(err)
            if not self._ks_get("token"):
                return fail("not_logged_in")
        res = self._exchange(route["method"], wire, data, service, deadline, signed=signed,
                             served=_served_props(route), secret=route.get("x-response-secret"))
        if not res.ok:
            res.fallback = fb
            if res.status == 403 and res.error == "not_in_plan":
                with self._state_lock:
                    self._refused.add(key)
        return res

    def _upgrade_route(self, method: str, sub: str) -> bool:
        """While the gate is closed for an upgrade, the plugin update token still goes out (to update the plugin)."""
        if (method or "").upper() != "POST" or sub != "/dist/token":
            return False
        with self._state_lock:
            return self._gs["reason"] == "upgrade"

    def dist_token(self) -> Result:
        """The read-only plugin update token for the credential helper. Served from memory while more than
        DIST_RENEW_BEFORE seconds are left; offline or `updates` off -> nothing sent and the cache is not served."""
        fb = FALLBACKS["dist_token"]
        if self._closed() and self.gate_state()["reason"] == "unknown":
            self.handshake()   # the credential helper has no session start: shake hands here (e.g. after offline off)
        if self._closed() and not self._upgrade_route("POST", "/dist/token"):
            return Result(False, error="inactive", fallback=fb)
        if self.offline:
            return Result(False, error="offline", fallback=fb)
        if not self.service_on("updates"):
            return Result(False, error="service_off", fallback=fb)
        with self._dist_lock:
            c = self._dist_cache
            if c is not None and c["exp"] - self.clock.now() > DIST_RENEW_BEFORE:
                return Result(True, 200, {"token": c["token"], "expires_at": c["expires_at"]}, attempts=0)
            self._dist_cache = None
            res = self.call("POST", "/dist/token", {"client_version": self.client_version}, kind="dist_token")
            if not res.ok:
                return res
            b = res.body if isinstance(res.body, dict) else {}
            tok, exp_text = b.get("token"), b.get("expires_at")
            exp = _parse_iso(exp_text) if isinstance(exp_text, str) else None
            if not isinstance(tok, str) or not DIST_TOKEN_RX.match(tok) or exp is None:
                return Result(False, res.status, None, "bad_response", fb, res.attempts)
            self._dist_cache = {"token": tok, "expires_at": exp_text, "exp": exp}
            return Result(True, res.status, {"token": tok, "expires_at": exp_text}, None, None, res.attempts)


def _throttled(status, code) -> bool:
    """The server is up but asks for less traffic: back off; this is never a block and never closes the gate."""
    return (status == 429 and code == "rate_limited") or (status == 503 and code == "busy")


def _ungated(route: dict) -> bool:
    """Metrics routes that upload nothing stay usable with the metrics switch off: DELETE /metrics (the
    "delete now" button, x-inventory retention) and GET /report (sends no content)."""
    return route["x-inventory"]["service"] == "metrics" and route["method"] in ("GET", "DELETE")


class _NetError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def _error_code(parsed, status: int) -> str:
    if isinstance(parsed, dict):
        e = parsed.get("error")
        if isinstance(e, dict):
            e = e.get("code")
        if isinstance(e, str) and _CODE.match(e):
            return e
    return f"http_{status}"


# ------------------------------------------------------------------ daemon

def _connector_json(data_dir) -> Path:
    return services_dir(data_dir) / "connector.json"


def _load_client_config(data_dir, defaults: bool = False) -> dict:
    """<data dir>/services/client.json; with `defaults`, the shipped production config (client_defaults.json next to
    this file) when there is no client.json, so a fresh install signs in without `connect`. A client.json always wins
    (`connect` writes one to override), and one identical to the defaults has the same client_fingerprint, so the
    sign-in survives writing or removing it."""
    p = services_dir(data_dir) / "client.json"
    if defaults and not p.exists():
        p = Path(__file__).with_name("client_defaults.json")
    return json.loads(p.read_text(encoding="utf-8"))


def _make_keystore(kind: str) -> KeyStore:
    return MemoryKeyStore() if kind == "memory" else default_keystore()


_LOCK_OFFSET = 1 << 20


class _Lock:
    """Exclusive non-blocking lock on connector.lock (msvcrt / fcntl)."""

    def __init__(self, path: Path):
        self.path = path
        self.f = None

    def acquire(self) -> bool:
        httpbase.private_dir(self.path.parent)
        f = open(self.path, "a+b")
        try:
            if os.name == "nt":
                import msvcrt
                f.seek(_LOCK_OFFSET)  # a byte past the end, so readers of the file are not blocked
                msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            f.close()
            return False
        self.f = f
        return True

    def release(self) -> None:
        if self.f is None:
            return
        try:
            if os.name == "nt":
                import msvcrt
                self.f.seek(_LOCK_OFFSET)
                msvcrt.locking(self.f.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.f.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        self.f.close()
        self.f = None


_SESSION_ROUTES = ("/session/route", "/session/checkpoint", "/session/limits")
# local routes that still answer while the shell gate is closed; every other route answers 403 inactive
_GATE_OPEN_ROUTES = frozenset({
    ("GET", "/local/status"), ("POST", "/local/login/start"), ("POST", "/local/login/finish"),
    ("POST", "/local/logout"), ("PUT", "/local/offline"), ("POST", "/local/stop"), ("POST", "/core/event"),
    ("POST", "/core/ask"), ("POST", "/core/gate"), ("POST", "/session/start"), ("POST", "/local/dist/token"),
    ("GET", "/local/served"), ("PUT", "/local/served/pin"), ("PUT", "/local/served/channel"),
    ("GET", "/local/metrics/status"), ("POST", "/local/metrics/off")})
_CHECKPOINT_COUNTERS = ("turns", "tool_calls", "todos_done", "commits", "minutes")


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _opt_str(body: dict, k: str) -> bool:
    return body.get(k) is None or isinstance(body.get(k), str)


def _session_args(path: str, body: dict):
    """Local /session/* body -> (args, kwargs) for the matching host.conclusions.Conclusions method, or None."""
    if path == "/session/route":
        if not all(isinstance(body.get(k), str) for k in ("session", "subagent_type", "description")):
            return None
        if not (_opt_str(body, "model") and _opt_str(body, "effort") and _opt_str(body, "project_dir")):
            return None
        return ((body["session"], body["subagent_type"], body["description"]),
                {"model": body.get("model"), "effort": body.get("effort"), "project_dir": body.get("project_dir")})
    if path == "/session/checkpoint":
        if not isinstance(body.get("session"), str) or not _num(body.get("context_pct")):
            return None
        if not all(_num(body.get(k)) for k in _CHECKPOINT_COUNTERS):
            return None
        return ((body["session"],), {k: body[k] for k in ("context_pct",) + _CHECKPOINT_COUNTERS})
    argv = body.get("argv")
    if not isinstance(argv, list) or not argv or not all(isinstance(a, str) for a in argv):
        return None
    if not (_opt_str(body, "session") and _opt_str(body, "project_dir")):
        return None
    prior = body.get("prior_durations")
    if prior is None:
        prior = []
    if not isinstance(prior, list) or not all(_num(x) for x in prior):
        return None
    return ((argv,), {"session": body.get("session"), "project_dir": body.get("project_dir"),
                      "prior_durations": prior})


DAEMON_SOCKET_TIMEOUT = 5.0   # seconds a daemon connection may sit idle (reading a request, writing an answer)
DAEMON_MAX_HANDLERS = 32      # concurrent daemon connections; more are closed unanswered


class _DaemonServer(httpbase.ExclusiveHTTPServer):
    """The daemon's server: port-exclusive (no second bind on its port) with a cap on concurrent handlers."""
    max_handlers = DAEMON_MAX_HANDLERS


def serve(data_dir, keystore_kind="os", allow_plain_loopback=False) -> int:
    from http.server import BaseHTTPRequestHandler

    data_dir = Path(data_dir)
    _private_dirs(data_dir)
    lock = _Lock(services_dir(data_dir) / "connector.lock")
    if not lock.acquire():
        return 0
    try:
        try:
            ks = _make_keystore(keystore_kind)
            conn = Connector(data_dir, ks, _load_client_config(data_dir, defaults=True), allow_plain_loopback=allow_plain_loopback,
                             gate=True)
        except KeyStoreUnavailable:
            print(json.dumps({"error": "keystore_unavailable"}))
            return 1
        except (OSError, ValueError):
            print(json.dumps({"error": "bad_client_config"}))
            return 1
        local_token = secrets.token_hex(32)
        daemon_id = {"pid": os.getpid(), "shell": SHELL_VERSION, "root": str(ROOT)}
        from host.conclusions import Conclusions
        concl = Conclusions(conn, harness=conn.harness)
        from host import metrics as metrics_mod
        mtr = metrics_mod.Metrics(conn, data_dir, projects_root=metrics_mod.default_projects_root())
        from host import savings_events
        sav = savings_events.SavingsEvents(data_dir)
        from host import confidential
        guard = confidential.Guard(conn)
        from host.core import Core
        core = Core(conn, data_dir, conclusions=concl, savings=sav, metrics=mtr, guard=guard)
        tick_stop = threading.Event()
        threading.Thread(target=metrics_mod.tick_loop, args=(mtr, tick_stop), daemon=True).start()

        class H(BaseHTTPRequestHandler):
            server_version = "agent-connector"
            timeout = DAEMON_SOCKET_TIMEOUT   # an idle or trickling connection is dropped, never held
            _authed = False

            def log_message(self, *a):
                pass

            def _send(self, code, obj):
                data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                nonce = self.headers.get(httpbase.NONCE_HEADER) if self._authed else None
                if httpbase.valid_nonce(nonce):
                    # proves this answer comes from the holder of connector.json's token (httpbase.daemon_proof)
                    self.send_header(httpbase.PROOF_HEADER, httpbase.daemon_proof(local_token, nonce, code,
                                                                                  self.command, self.path, data))
                self.end_headers()
                self.wfile.write(data)

            def _handle(self, method):
                self._authed = False
                path = self.path.split("?", 1)[0]
                # the guard's session routes (all but open) carry X-Session-Token, not the owner token
                guarded = path.startswith("/session/served/") and path != "/session/served/open"
                tok = self.headers.get("X-Connector-Token") or ""
                authed = hmac.compare_digest(tok.encode(), local_token.encode())
                if not guarded and not authed:
                    return self._send(401, {"error": "auth_required"})
                self._authed = authed
                try:
                    n = int(self.headers.get("Content-Length") or 0)
                except ValueError:
                    n = -1
                limit = CORE_BODY_LIMIT if path == "/core/event" else \
                    confidential.CHECK_BODY_LIMIT if path == "/session/served/check" else 65536
                if n > limit:
                    return self._send(413, {"error": "too_large"})
                raw = self.rfile.read(n) if n > 0 else b""
                try:
                    if n < 0:
                        raise ValueError
                    body = json.loads(raw) if raw else {}
                    if not isinstance(body, dict):
                        raise ValueError
                except ValueError:
                    return self._send(400, {"error": "bad_request" if path.startswith(("/core/", "/session/served/"))
                                            else "bad_json"})
                if (method, path) not in _GATE_OPEN_ROUTES and conn._closed():
                    return self._send(403, {"error": "inactive"})
                if method == "POST" and path == "/core/gate":
                    refresh = body.get("refresh", False)
                    if not isinstance(refresh, bool):
                        return self._send(400, {"error": "bad_request"})
                    return self._send(200, core.gate(refresh))
                if path.startswith("/session/served/"):
                    return self._send(*confidential.local_route(guard, method, path, self.headers, body))
                if method == "POST" and path in ("/core/event", "/core/ask"):
                    return self._core(path, body)
                if method == "GET" and path == "/local/status":
                    dep = dependency_error() if missing_dependency() else {}
                    reason = conn.gate_state().get("reason")
                    if dep and reason != "offline":
                        conn._set_gate("dependency")
                    elif not dep and reason == "dependency":
                        conn._set_gate("unknown")   # installed since: the next gate check runs a handshake
                    st = {**conn.status(), "notices": conn.notices(),
                          "services": {k: conn.service_on(k) for k in SERVICE_DEFAULTS}, "gate": conn.gate_state(),
                          "daemon": daemon_id}
                    if dep:
                        st.update(dep, notice=DEPENDENCY_NOTICE)
                    return self._send(200, st)
                if method == "POST" and path == "/local/call":
                    kind = body.get("kind")
                    if not isinstance(body.get("method"), str) or not isinstance(body.get("path"), str) \
                            or (kind is not None and kind not in TIMEOUTS):
                        return self._send(400, {"error": "bad_request"})
                    return self._send(200, conn.call(body["method"], body["path"], body.get("body"),
                                                     kind=kind).to_dict())
                if method == "POST" and path == "/local/login/start":
                    return self._result(conn.login_start(body.get("email")))
                if method == "POST" and path == "/local/login/finish":
                    return self._result(conn.login_finish(body.get("email"), body.get("code")))
                if method == "POST" and path == "/local/logout":
                    return self._result(conn.logout())
                if method == "POST" and path == "/session/start":
                    return self._send(200, conn.session_start())
                if method == "POST" and path == "/local/dist/token":
                    r = conn.dist_token()
                    if r.ok:
                        return self._send(200, {"token": r.body["token"], "expires_at": r.body["expires_at"]})
                    return self._send(200, {"error": r.error or "failed"})
                if method == "PUT" and path == "/local/offline":
                    if not isinstance(body.get("offline"), bool):
                        return self._send(400, {"error": "bad_request"})
                    conn.set_offline(body["offline"])
                    return self._send(200, {"ok": True, "offline": conn.offline})
                if method == "POST" and path in _SESSION_ROUTES:
                    args = _session_args(path, body)
                    if args is None:
                        return self._send(400, {"error": "bad_request"})
                    fn = {"/session/route": concl.route, "/session/checkpoint": concl.checkpoint,
                          "/session/limits": concl.limits}[path]
                    return self._send(200, fn(*args[0], **args[1]))
                if method == "POST" and path == "/session/savings":
                    return self._send(*savings_events.local_route(sav, body))
                if path.startswith("/local/metrics/"):
                    return self._send(*metrics_mod.local_route(mtr, method, path, body))
                if path.startswith("/local/served"):
                    return self._served(method, path, body)
                if method == "POST" and path == "/local/stop":
                    self._send(200, {"ok": True})
                    threading.Thread(target=srv.shutdown, daemon=True).start()
                    return None
                return self._send(404, {"error": "not_found"})

            def _core(self, path, body):
                try:
                    if path == "/core/event":
                        return self._send(200, core.handle(body))
                    if not all(k in body for k in ("tool", "args", "session")):
                        raise ValueError("bad_request")
                    harness = body.get("harness")
                    return self._send(200, core.ask(body["tool"], body["args"], session=body["session"],
                                                    harness="other" if harness is None else harness,
                                                    cwd=body.get("cwd")))
                except (ValueError, TypeError):
                    return self._send(400, {"error": "bad_request"})

            def _served(self, method, path, body):
                try:
                    if method == "GET" and path == "/local/served":
                        pass
                    elif method == "PUT" and path == "/local/served/pin":
                        if set(body) != {"role", "version"}:
                            raise ValueError("bad_request")
                        conn.set_served_pin(body["role"], body["version"])
                    elif method == "PUT" and path == "/local/served/channel":
                        if set(body) != {"channel"}:
                            raise ValueError("bad_request")
                        conn.set_served_channel(body["channel"])
                    else:
                        return self._send(404, {"error": "not_found"})
                except (ValueError, TypeError):
                    return self._send(400, {"error": "bad_request"})
                return self._send(200, conn.served_settings())

            def _result(self, r: Result):
                if r.ok:
                    return self._send(200, r.body if isinstance(r.body, dict) and r.body else {"ok": True})
                if r.error == "missing_dependency":
                    return self._send(200, dependency_error())
                return self._send(200, {"error": r.error or "failed"})

            def _safe(self, method):
                """Every request gets an answer: an exception in a handler is 500 internal, never a dropped
                connection (the CLI would only say connector_unreachable)."""
                try:
                    self._handle(method)
                except Exception as e:  # noqa: BLE001
                    dep = isinstance(e, ImportError) and missing_dependency()
                    try:
                        self._send(500, dependency_error() if dep else {"error": "internal"})
                    except Exception:  # noqa: BLE001 - the client went away
                        pass

            def do_GET(self):
                self._safe("GET")

            def do_POST(self):
                self._safe("POST")

            def do_PUT(self):
                self._safe("PUT")

        srv = _DaemonServer(("127.0.0.1", 0), H)
        cj = _connector_json(data_dir)
        try:
            # O_EXCL tmp with mode 0o600 (Windows: ACL narrowed to this user's SID first), then renamed
            httpbase.write_secret(cj, json.dumps({"pid": os.getpid(), "port": srv.server_address[1],
                                                  "token": local_token, "shell": SHELL_VERSION,
                                                  "root": str(ROOT)}).encode("utf-8"))
        except OSError:
            srv.server_close()
            tick_stop.set()
            print(json.dumps({"error": "connector_file"}))
            return 1
        try:
            srv.serve_forever(poll_interval=0.2)
        finally:
            tick_stop.set()
            srv.server_close()
            try:
                d = json.loads(cj.read_text(encoding="utf-8"))
                if d.get("pid") == os.getpid():
                    cj.unlink()
            except (OSError, ValueError):
                pass
        return 0
    finally:
        lock.release()


class DaemonUnverified(OSError):
    """connector.json names a process that is gone, or the answer on its port carries no valid proof (httpbase.
    daemon_proof): a stale file whose port another process may hold. Callers treat it as no daemon."""


def _local(data_dir, method, path, body=None, timeout=60.0, info=None, *, verify=True):
    info = info or json.loads(_connector_json(data_dir).read_text(encoding="utf-8"))
    token = info["token"]
    if not isinstance(token, str):
        raise ValueError("bad connector.json")
    if verify and not httpbase.pid_alive(info.get("pid")):
        raise DaemonUnverified("daemon_gone")
    nonce = secrets.token_hex(16)
    conn = http.client.HTTPConnection("127.0.0.1", int(info["port"]), timeout=timeout)
    try:
        headers = {"X-Connector-Token": token, httpbase.NONCE_HEADER: nonce}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        conn.request(method, path, body=data, headers=headers)
        r = conn.getresponse()
        raw = r.read()
        if verify and not httpbase.proof_ok(token, nonce, r.status, method, path, raw,
                                            r.getheader(httpbase.PROOF_HEADER)):
            raise DaemonUnverified("unverified_answer")
        return r.status, json.loads(raw or b"{}")
    finally:
        conn.close()


def local_call(data_dir, method, path, body=None, *, kind=None, timeout=None) -> Result:
    """Call the service through the running daemon (POST /local/call). Never starts the daemon: no connector.json or
    no answer -> Result(False, error="connector_down"). Never raises."""
    p = path or ""
    if kind is None:
        kind = _default_kind((p[len(PREFIX):] if p.startswith(PREFIX + "/") else p).partition("?")[0])
    fb = FALLBACKS.get(kind)
    wait = timeout if timeout is not None else TIMEOUTS.get(kind, 30) + 5
    try:
        info = json.loads(_connector_json(data_dir).read_text(encoding="utf-8"))
        st, d = _local(data_dir, "POST", "/local/call", {"method": method, "path": path, "body": body, "kind": kind},
                       timeout=wait, info=info)
    except (OSError, ValueError, KeyError, TypeError, http.client.HTTPException):
        return Result(False, error="connector_down", fallback=fb)
    if st != 200 or not isinstance(d, dict) or not isinstance(d.get("ok"), bool):
        return Result(False, error="connector_down", fallback=fb)
    return Result(d["ok"], status=d.get("status"), body=d.get("body"), error=d.get("error"),
                  fallback=d.get("fallback") if not d["ok"] else None, attempts=int(d.get("attempts") or 0))


def local_session_start(data_dir, timeout=15.0) -> dict:
    """POST /session/start of the running daemon (plan refresh and notice). Never starts the daemon, never
    raises: not running -> {"plan": None, "notice": None, "error": "connector_down"}."""
    down = {"plan": None, "notice": None, "error": "connector_down"}
    try:
        info = json.loads(_connector_json(data_dir).read_text(encoding="utf-8"))
        st, d = _local(data_dir, "POST", "/session/start", {}, timeout=timeout, info=info)
    except (OSError, ValueError, KeyError, TypeError, http.client.HTTPException):
        return down
    return d if st == 200 and isinstance(d, dict) else down


def local_status(data_dir, timeout=5.0) -> dict | None:
    """GET /local/status of the running daemon (logged_in, offline, services, ...); not running -> None."""
    try:
        info = json.loads(_connector_json(data_dir).read_text(encoding="utf-8"))
        st, d = _local(data_dir, "GET", "/local/status", timeout=timeout, info=info)
    except (OSError, ValueError, KeyError, TypeError, http.client.HTTPException):
        return None
    return d if st == 200 and isinstance(d, dict) else None


def _probe(data_dir):
    """(connector.json, its /local/status answer) when the daemon it names answers with its token, else None."""
    try:
        info = json.loads(_connector_json(data_dir).read_text(encoding="utf-8"))
        st, body = _local(data_dir, "GET", "/local/status", timeout=5, info=info)
        if st == 200 and isinstance(info, dict):
            return info, body if isinstance(body, dict) else {}
    except (OSError, ValueError, KeyError, TypeError, http.client.HTTPException):
        pass
    return None


def _alive(data_dir):
    p = _probe(data_dir)
    return p[0] if p else None


def _release(v):
    """"X.Y.Z" -> (X, Y, Z); "dev", a missing field (a daemon from before the field) or anything else -> None."""
    return tuple(int(x) for x in v.split(".")) if isinstance(v, str) and _RELEASE.match(v) else None


def _same_path(a, b) -> bool:
    return os.path.normcase(os.path.normpath(str(a))) == os.path.normcase(os.path.normpath(str(b)))


def replace_daemon(info: dict, shell: str | None = None, root=None) -> bool:
    """Whether a caller of shell version `shell` with core root `root` (default: this code) stops the running daemon
    that `info` (its connector.json) describes and starts its own. In order:
    - it runs the caller's own shell version from the caller's own root: no (reuse);
    - its root no longer holds host/services.py (the install it ran from is gone): yes;
    - it runs from the caller's own root but under another shell version (updated in place): yes;
    - the caller is a release: yes when the daemon is dev, does not say its version (from before this rule) or is
      a lower release; no when it is a release at least as new (ties keep the running daemon, so two installs of one
      version never take turns);
    - the caller is dev: no (it talks to whatever runs; stop the daemon to test daemon code).
    The newest release wins and nothing alternates: a replacement is never undone by the caller it displaced."""
    shell = SHELL_VERSION if shell is None else shell
    root = ROOT if root is None else root
    d_shell, d_root = info.get("shell"), info.get("root")
    d_root = d_root if isinstance(d_root, str) and d_root else None
    if d_root is not None and _same_path(d_root, root):
        return d_shell != shell
    if d_root is not None and not (Path(d_root) / "host" / "services.py").is_file():
        return True
    mine = _release(shell)
    if mine is None:
        return False
    theirs = _release(d_shell)
    return theirs is None or theirs < mine


def _until(end: float, test) -> bool:
    while True:
        if test():
            return True
        if time.monotonic() >= end:
            return False
        time.sleep(0.05)


def _stop_daemon(data_dir, info: dict, status: dict, end: float) -> bool:
    """Stop the daemon of `info` the clean way (POST /local/stop with its own token) and wait until it has let go of
    connector.lock. Only our own daemon: the token answered /local/status, and when the daemon reports its pid
    (every daemon that writes "shell" does) it is the pid of connector.json. Never kills a process. True once gone."""
    d = status.get("daemon")
    pid = d.get("pid") if isinstance(d, dict) else None
    if ("shell" in info or pid is not None) and (pid is None or pid != info.get("pid")):
        return False
    try:
        st, _ = _local(data_dir, "POST", "/local/stop", {}, timeout=5, info=info)
    except (OSError, ValueError, KeyError, TypeError, http.client.HTTPException):
        return False
    if st != 200:
        return False
    lock = _Lock(services_dir(data_dir) / "connector.lock")

    def free() -> bool:
        if not lock.acquire():
            return False
        lock.release()
        return True
    return _until(end, free)


def _retire_unproven(data_dir, end: float) -> None:
    """No daemon proved itself (_probe), yet connector.json names a live pid and connector.lock is held: a daemon of
    an older shell that sends no answer proof. It is asked to stop (POST /local/stop with its token; the answer is not
    used) so this code can start one. A stale file (dead pid, lock free) needs nothing: the new daemon replaces it."""
    try:
        info = json.loads(_connector_json(data_dir).read_text(encoding="utf-8"))
        if not isinstance(info, dict) or not httpbase.pid_alive(info.get("pid")):
            return
    except (OSError, ValueError):
        return
    lock = _Lock(services_dir(data_dir) / "connector.lock")

    def free() -> bool:
        if not lock.acquire():
            return False
        lock.release()
        return True
    if free():
        return
    try:
        _local(data_dir, "POST", "/local/stop", {}, timeout=5, info=info, verify=False)
    except (OSError, ValueError, KeyError, TypeError, http.client.HTTPException):
        return
    _until(min(end, time.monotonic() + 10), free)


def ensure(data_dir, keystore_kind="os", allow_plain_loopback=False, wait=20.0, *, start=True) -> dict | None:
    """The running daemon of `data_dir` as {"pid", "port"}. One whose version `replace_daemon` says this caller
    replaces is stopped and one is started from this code; none running -> one is started from this code (with
    start=False -> None). Only a daemon that proves it holds connector.json's token counts as running (_local), so a
    process on the port of a stale connector.json is never reported. Callers take turns on ensure.lock, so two
    shells never stop or start a daemon at once."""
    end = time.monotonic() + wait
    _private_dirs(data_dir)
    turn = _Lock(services_dir(data_dir) / "ensure.lock")
    held = _until(end, turn.acquire)   # not had in time (a stuck caller): go on without it
    try:
        return _ensure(data_dir, keystore_kind, allow_plain_loopback, end, start)
    finally:
        if held:
            turn.release()


def reconcile(data_dir, keystore_kind="os", allow_plain_loopback=False, wait=10.0) -> dict | None:
    """A shell's start (the MCP server): replace the running daemon when its connector.json shows that
    `replace_daemon` says so; otherwise do nothing (no request, and no daemon is started: that stays lazy)."""
    try:
        info = json.loads(_connector_json(data_dir).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(info, dict) or not replace_daemon(info):
        return None
    return ensure(data_dir, keystore_kind, allow_plain_loopback, wait, start=False)


def _ensure(data_dir, keystore_kind, allow_plain_loopback, end: float, start: bool) -> dict | None:
    p = _probe(data_dir)
    if p and replace_daemon(p[0]):
        if not _stop_daemon(data_dir, p[0], p[1], end):
            info = _alive(data_dir)   # it would not stop: talk to it rather than fight it
            if info:
                return {"pid": info["pid"], "port": info["port"]}
            raise RuntimeError("daemon_timeout")
        p, start = None, True
    if p:
        return {"pid": p[0]["pid"], "port": p[0]["port"]}
    if not start:
        return None
    _retire_unproven(data_dir, end)
    argv = [sys.executable, "-m", "host.services", "serve", "--data-dir", str(data_dir),
            "--keystore", keystore_kind]
    if allow_plain_loopback:
        argv.append("--allow-plain-loopback")
    env = dict(os.environ)
    env["PYTHONPATH"] = str(ROOT) + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    kw: dict = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL,
                "cwd": str(ROOT), "env": env}
    if os.name == "nt":
        kw["creationflags"] = (subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
                               | getattr(subprocess, "CREATE_NO_WINDOW", 0))
    else:
        kw["start_new_session"] = True
    proc = subprocess.Popen(argv, **kw)
    while time.monotonic() < end:
        info = _alive(data_dir)
        if info:
            return {"pid": info["pid"], "port": info["port"]}
        rc = proc.poll()
        if rc not in (None, 0):
            raise RuntimeError("daemon_failed")
        time.sleep(0.1)
    raise RuntimeError("daemon_timeout")


def connect(data_dir, endpoint, server_keys, pins, e2e_keys=None, keystore=None) -> tuple[dict, int]:
    """Write <data dir>/services/client.json for `endpoint` (hostname: pin ca; IPv4: pin cert_sha256 with `pins`) and
    the server's public keys (signing: `server_keys`; end-to-end envelope: `e2e_keys`, or server_keys entries written
    "e2e:<key>"), after the same check the daemon applies; then stop a running daemon so the next command starts one
    with it. -> (answer, exit code). The keys are public; nothing secret is written. A sign-in belongs to the
    endpoint, pins and keys it was made with (client_fingerprint): when any of them changes, this machine is signed
    out (token and device binding dropped from `keystore` now, and by the daemon when it starts in any case) and the
    answer says so ("signed_out": true, "notice"), so a key rotation through `connect` needs a new sign-in."""
    if not isinstance(endpoint, str) or not endpoint:
        return {"error": "bad_client_config", "detail": "--endpoint is required"}, 1
    endpoint = endpoint.strip().rstrip("/").lower()   # host names are case-insensitive; the check wants lowercase
    cfg: dict = {"endpoint": endpoint}
    if _IP_ENDPOINT.match(endpoint):
        cfg["pin"] = {"kind": "cert_sha256", "sha256": [p.strip().lower() for p in pins or []]}
    else:
        cfg["pin"] = {"kind": "ca"}
    sig = [k.strip() for k in server_keys or [] if not k.strip().startswith("e2e:")]
    enc = [k.strip()[4:] for k in server_keys or [] if k.strip().startswith("e2e:")]
    enc += [k.strip()[4:] if k.strip().startswith("e2e:") else k.strip() for k in e2e_keys or []]
    if sig:
        cfg["server_keys"] = sig
    if enc:
        cfg["e2e_keys"] = enc
    try:
        parse_client_config(cfg)
    except ValueError as e:
        return {"error": "bad_client_config", "detail": str(e)}, 1
    d = _private_dirs(data_dir)
    path = d / "client.json"
    try:
        old = client_fingerprint(parse_client_config(json.loads(path.read_text(encoding="utf-8")), True))
    except (OSError, ValueError, TypeError, AttributeError):
        old = None
    new = client_fingerprint(parse_client_config(cfg))
    tmp = path.with_name("client.json.tmp")
    tmp.write_text(json.dumps(cfg, indent=1) + "\n", encoding="utf-8")
    os.replace(tmp, path)
    p = _probe(data_dir)
    stopped = bool(p) and _stop_daemon(data_dir, p[0], p[1], time.monotonic() + 10)
    signed_out = False
    if old is not None and old != new:
        signed_out = True   # the daemon's _bind_endpoint drops it at its start even without a key store here
        if keystore is not None:
            sign_out_keystore(keystore)
    elif old is None and keystore is not None:
        try:
            bound = keystore.get("endpoint") if keystore.get("token") else None
        except KeyStoreUnavailable:
            bound = None
        if bound is not None and bound != new:
            signed_out = sign_out_keystore(keystore)
    ans = {"ok": True, "endpoint": endpoint, "pin": cfg["pin"]["kind"],
           "server_keys": [_key_id(base64.b64decode(k)) for k in cfg.get("server_keys", [])],
           "e2e_keys": [e2e.key_id(base64.b64decode(k)) for k in cfg.get("e2e_keys", [])],
           "daemon_stopped": stopped, "signed_out": signed_out}
    if signed_out:
        ans["notice"] = NOTICE_TEXT["endpoint_changed"]
    return ans, 0


def main(argv=None) -> int:
    import argparse
    ap = argparse.ArgumentParser(prog="python -m host.services")
    ap.add_argument("cmd")
    ap.add_argument("arg", nargs="?")
    ap.add_argument("--data-dir")
    ap.add_argument("--keystore", choices=("os", "memory"), default="os")
    ap.add_argument("--allow-plain-loopback", action="store_true")
    ap.add_argument("--email")
    ap.add_argument("--code")
    ap.add_argument("--role")
    ap.add_argument("--version")
    ap.add_argument("--channel")
    ap.add_argument("--endpoint")
    ap.add_argument("--server-key", action="append", default=[])
    ap.add_argument("--e2e-key", action="append", default=[])
    ap.add_argument("--pin-sha256", action="append", default=[])
    a = ap.parse_args(argv)
    data_dir = Path(a.data_dir) if a.data_dir else default_data_dir()
    if a.keystore == "memory":
        print("warning: --keystore memory is for tests only; nothing is kept after the daemon stops",
              file=sys.stderr)
    if a.allow_plain_loopback:
        print("warning: --allow-plain-loopback is for tests only; traffic is not encrypted", file=sys.stderr)

    def out(obj, rc=0):
        print(json.dumps(obj, ensure_ascii=True))   # ASCII stdout: piped output on Chinese Windows (cp936) neither mangles nor raises
        return rc

    if a.cmd == "serve":
        return serve(data_dir, a.keystore, a.allow_plain_loopback)
    if a.cmd == "connect":
        ks = None
        if a.keystore == "os":   # memory: the daemon's sign-in ends with the daemon, which connect stops
            try:
                ks = default_keystore()
            except KeyStoreUnavailable:
                ks = None
        return out(*connect(data_dir, a.endpoint, a.server_key, a.pin_sha256, a.e2e_key, keystore=ks))
    try:
        info = ensure(data_dir, a.keystore, a.allow_plain_loopback)
    except RuntimeError as e:
        return out({"error": str(e)}, 1)
    if a.cmd == "ensure":
        return out(info)
    req = None
    if a.cmd == "login" and a.arg == "start" and a.email:
        req = ("POST", "/local/login/start", {"email": a.email})
    elif a.cmd == "login" and a.arg == "finish" and a.email and a.code:
        req = ("POST", "/local/login/finish", {"email": a.email, "code": a.code})
    elif a.cmd == "logout":
        req = ("POST", "/local/logout", {})
    elif a.cmd == "status":
        req = ("GET", "/local/status", None)
    elif a.cmd == "offline" and a.arg in ("on", "off"):
        req = ("PUT", "/local/offline", {"offline": a.arg == "on"})
    elif a.cmd == "stop":
        req = ("POST", "/local/stop", {})
    elif a.cmd == "served":
        if a.arg == "status":
            req = ("GET", "/local/served", None)
        elif a.arg == "pin":
            if not a.role or not a.version:
                return out({"error": "bad_request"}, 1)
            req = ("PUT", "/local/served/pin", {"role": a.role, "version": a.version})
        elif a.arg == "unpin":
            if not a.role:
                return out({"error": "bad_request"}, 1)
            req = ("PUT", "/local/served/pin", {"role": a.role, "version": None})
        elif a.arg == "channel":
            if not a.channel:
                return out({"error": "bad_request"}, 1)
            req = ("PUT", "/local/served/channel", {"channel": a.channel})
    if req is None:
        return out({"error": "bad_command"}, 1)
    try:
        st, body = _local(data_dir, *req)
    except (OSError, ValueError, KeyError, http.client.HTTPException):
        return out({"error": "connector_unreachable"}, 1)
    if st != 200 or "error" in body:
        err = {"error": body.get("error") or f"http_{st}"}
        if isinstance(body.get("detail"), str):
            err["detail"] = body["detail"]
        if a.cmd == "status" and isinstance(body.get("notice"), str):
            err["notice"] = body["notice"]
        return out(err, 1)
    return out(body)


if __name__ == "__main__":
    sys.exit(main())
