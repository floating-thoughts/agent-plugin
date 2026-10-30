"""End-to-end request envelope: the client encrypts each request to the server's X25519 key and the server encrypts
its answer back, so a TLS-terminating edge in between (a Cloudflare Tunnel) sees only ciphertext.

Wire format (contract: service_api.json x-transport "e2e"; the client is host/services.py, the server opens and seals
with the same functions):

    outer request   POST /svc/v1/x                (every route except /health)
                    POST /svc/v1/auth/login/x     (login start and finish: the edge's per-IP login limit still applies)
                    X-Agent-E2E: v=1; kid=<16 hex>; epk=<base64 32-byte X25519 public key>; ts=<unix seconds>
                    X-Agent-Challenge: <32 hex>   (fresh per request; also bound by the response signature)
                    Content-Type: application/octet-stream
                    body = nonce (12 bytes) || AES-256-GCM(k_req, nonce, inner, aad_req)
    inner request   compact JSON {"method", "path", "headers"} + "\n" + the raw request body bytes
                    (headers: the bearer token, account, device, Claude hash, timestamp, nonce and device signature)
    outer answer    200, Content-Type application/octet-stream, body = nonce (12 bytes, random) ||
                    AES-256-GCM(k_resp, nonce, compact JSON {"status", "headers"} + "\n" + body bytes, aad_resp);
                    errors found before the envelope is opened (limits, a malformed envelope) are plain JSON
    keys            shared = X25519(client ephemeral, server static); HKDF-SHA256(shared, salt "agent-svc-e2e/1",
                    info "keys" + epk + server public key, 64 bytes) -> k_req (first 32), k_resp (last 32)
    aad_req         "agent-svc-e2e/1\nreq\nPOST\n<outer path>\n<kid>\n<epk>\n<ts>\n<challenge>"
    aad_resp        "agent-svc-e2e/1\nresp\nPOST\n<outer path>\n<kid>\n<epk>\n<ts>\n<challenge>"

A fresh ephemeral key per request makes k_req single-use; the answer key is used once per opened request, with a random
nonce, so even a replayed request that the server answers again never reuses a (key, nonce) pair. kid is
sha256(raw public key)[:16] and picks the server key, so the server never tries keys in turn.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re

DOMAIN = "agent-svc-e2e/1"
HEADER = "X-Agent-E2E"
CHALLENGE_HEADER = "X-Agent-Challenge"
CONTENT_TYPE = "application/octet-stream"
PREFIX = "/svc/v1"
OUTER_PATH = PREFIX + "/x"
OUTER_LOGIN_PATH = PREFIX + "/auth/login/x"
OUTER_PATHS = (OUTER_PATH, OUTER_LOGIN_PATH)
LOGIN_PATHS = (PREFIX + "/auth/login/start", PREFIX + "/auth/login/finish")
SKEW_SECONDS = 300
NONCE_BYTES = 12
HEADER_RX = re.compile(r"^v=1; kid=([0-9a-f]{16}); epk=([A-Za-z0-9+/]{43}=); ts=(\d{1,12})\Z")
KEY_RX = re.compile(r"^[A-Za-z0-9+/]{43}=\Z")         # base64 of a raw 32-byte X25519 public key
CHALLENGE_RX = re.compile(r"^[0-9a-f]{32}\Z")
INNER_HEADERS = ("Authorization", "X-Agent-Account", "X-Agent-Device", "X-Agent-Claude", "X-Agent-Timestamp",
                 "X-Agent-Nonce", "X-Agent-Signature", "Content-Type")
INNER_METHODS = ("GET", "POST", "PUT", "DELETE", "PATCH")
MAX_META = 4096                                         # the inner JSON line (method, path, headers)
_PATH_RX = re.compile(r"^/svc/v1/[\x21-\x7e]{1,2000}\Z")


class EnvelopeError(Exception):
    """The envelope could not be built or opened; str(e) is a short reason, never key material."""


def key_id(public_raw: bytes) -> str:
    return hashlib.sha256(public_raw).hexdigest()[:16]


def outer_path(inner_path: str) -> str:
    """The outer path category for an inner path: the login routes keep their own, everything else shares one."""
    return OUTER_LOGIN_PATH if inner_path.split("?", 1)[0] in LOGIN_PATHS else OUTER_PATH


def parse_header(value) -> tuple[str, str, int] | None:
    """X-Agent-E2E -> (kid, epk base64, ts) or None. Shape only: no key work."""
    if not isinstance(value, str):
        return None
    m = HEADER_RX.match(value.strip())
    if not m:
        return None
    return m.group(1), m.group(2), int(m.group(3))


def _aad(kind: str, outer: str, kid: str, epk_b64: str, ts: int, challenge: str) -> bytes:
    return "\n".join((DOMAIN, kind, "POST", outer, kid, epk_b64, str(int(ts)), challenge)).encode("utf-8")


def _derive(shared: bytes, epk_raw: bytes, server_pub_raw: bytes) -> tuple[bytes, bytes]:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    okm = HKDF(algorithm=hashes.SHA256(), length=64, salt=DOMAIN.encode("ascii"),
               info=b"keys" + epk_raw + server_pub_raw).derive(shared)
    return okm[:32], okm[32:]


def _seal(key: bytes, plain: bytes, aad: bytes) -> bytes:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    nonce = os.urandom(NONCE_BYTES)
    return nonce + AESGCM(key).encrypt(nonce, plain, aad)


def _open(key: bytes, data: bytes, aad: bytes) -> bytes:
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    if not isinstance(data, (bytes, bytearray)) or len(data) < NONCE_BYTES + 16:
        raise EnvelopeError("short")
    try:
        return AESGCM(key).decrypt(bytes(data[:NONCE_BYTES]), bytes(data[NONCE_BYTES:]), aad)
    except InvalidTag:
        raise EnvelopeError("tag") from None


def _frame(meta: dict, body: bytes) -> bytes:
    return json.dumps(meta, ensure_ascii=True, separators=(",", ":")).encode("ascii") + b"\n" + (body or b"")


def _unframe(plain: bytes) -> tuple[dict, bytes]:
    line, sep, body = plain.partition(b"\n")
    if not sep or len(line) > MAX_META:
        raise EnvelopeError("frame")
    try:
        meta = json.loads(line.decode("ascii"))
    except (ValueError, UnicodeDecodeError):
        raise EnvelopeError("frame") from None
    if not isinstance(meta, dict):
        raise EnvelopeError("frame")
    return meta, body


class Context:
    """What one request's answer is sealed or opened with (memory only, one request)."""
    __slots__ = ("k_resp", "aad_resp")

    def __init__(self, k_resp: bytes, aad_resp: bytes):
        self.k_resp, self.aad_resp = k_resp, aad_resp

    def __repr__(self) -> str:   # never the key
        return "Context()"


# ------------------------------------------------------------------ client side

def seal_request(server_pub_raw: bytes, method: str, path: str, headers: dict, body: bytes | None, ts: int,
                 challenge: str) -> tuple[str, dict, bytes, Context]:
    """-> (outer path, outer headers, outer body, context for the answer)."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
    if not CHALLENGE_RX.match(challenge or ""):
        raise EnvelopeError("challenge")
    eph = X25519PrivateKey.generate()
    epk_raw = eph.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    try:
        shared = eph.exchange(X25519PublicKey.from_public_bytes(server_pub_raw))
    except ValueError:
        raise EnvelopeError("server key") from None
    k_req, k_resp = _derive(shared, epk_raw, server_pub_raw)
    kid = key_id(server_pub_raw)
    epk = base64.b64encode(epk_raw).decode("ascii")
    outer = outer_path(path)
    inner_headers = {k: v for k, v in (headers or {}).items() if k in INNER_HEADERS}
    data = _seal(k_req, _frame({"method": method.upper(), "path": path, "headers": inner_headers}, body or b""),
                 _aad("req", outer, kid, epk, ts, challenge))
    hdrs = {HEADER: f"v=1; kid={kid}; epk={epk}; ts={int(ts)}", CHALLENGE_HEADER: challenge,
            "Content-Type": CONTENT_TYPE}
    return outer, hdrs, data, Context(k_resp, _aad("resp", outer, kid, epk, ts, challenge))


def open_response(ctx: Context, data: bytes) -> tuple[int, dict, bytes]:
    """-> (inner status, inner headers, inner body); EnvelopeError when it does not open."""
    meta, body = _unframe(_open(ctx.k_resp, data, ctx.aad_resp))
    status, headers = meta.get("status"), meta.get("headers")
    if not isinstance(status, int) or not 100 <= status <= 599 or not isinstance(headers, dict) \
            or not all(isinstance(k, str) and isinstance(v, str) for k, v in headers.items()):
        raise EnvelopeError("frame")
    return status, headers, body


# ------------------------------------------------------------------ server side

def open_request(private_key, public_raw: bytes, outer: str, kid: str, epk_b64: str, ts: int, challenge: str,
                 data: bytes) -> tuple[str, str, dict, bytes, Context]:
    """-> (method, path, headers, body, context for the answer). One X25519 exchange and one AEAD open, bounded by the
    body size; EnvelopeError on any problem (the caller counts it as a failed authentication)."""
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PublicKey
    if outer not in OUTER_PATHS or not CHALLENGE_RX.match(challenge or ""):
        raise EnvelopeError("outer")
    try:
        epk_raw = base64.b64decode(epk_b64, validate=True)
        shared = private_key.exchange(X25519PublicKey.from_public_bytes(epk_raw))
    except ValueError:   # binascii.Error is a ValueError; an all-zero shared secret raises ValueError too
        raise EnvelopeError("epk") from None
    k_req, k_resp = _derive(shared, epk_raw, public_raw)
    meta, body = _unframe(_open(k_req, data, _aad("req", outer, kid, epk_b64, ts, challenge)))
    method, path, headers = meta.get("method"), meta.get("path"), meta.get("headers")
    if method not in INNER_METHODS or not isinstance(path, str) or not _PATH_RX.match(path) \
            or not isinstance(headers, dict) or set(meta) != {"method", "path", "headers"}:
        raise EnvelopeError("inner")
    if any(k not in INNER_HEADERS or not isinstance(v, str) or len(v) > 1024 for k, v in headers.items()):
        raise EnvelopeError("inner")
    sub = path.split("?", 1)[0]
    if outer_path(path) != outer or sub in OUTER_PATHS:   # a login route only through the login outer path
        raise EnvelopeError("category")
    return method, path, headers, body, Context(k_resp, _aad("resp", outer, kid, epk_b64, ts, challenge))


def seal_response(ctx: Context, status: int, headers: dict, body: bytes) -> bytes:
    return _seal(ctx.k_resp, _frame({"status": int(status), "headers": dict(headers or {})}, body or b""),
                 ctx.aad_resp)


class Headers:
    """The inner request's headers with the case-insensitive get() of http.server's message objects."""

    def __init__(self, d: dict):
        self._d = {k.lower(): v for k, v in d.items()}

    def get(self, name: str, default=None):
        return self._d.get(name.lower(), default)

    def get_all(self, name: str, default=None):
        v = self._d.get(name.lower())
        return [v] if v is not None else default
