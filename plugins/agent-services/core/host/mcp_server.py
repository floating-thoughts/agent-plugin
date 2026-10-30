"""The stdio MCP server for the local core.

JSON-RPC 2.0, one message per line, UTF-8 both ways (`sys.stdin.buffer` / `sys.stdout.buffer`). Nothing but JSON-RPC
goes to stdout and nothing goes to stderr in normal operation. The four tools are `host.core.TOOLS`; a call is checked
with `host.core.check_args` and answered by the injected `ask` (in `main`: `host.core_client.ask` through the daemon's
POST /core/ask, whose failures already give `host.core.open_answer`).

With a gate (`main`: `host.core_client.gate`), the business tools are listed only while the shell gate is open;
closed, the one tool is `status`, and `initialize` carries the reason as `instructions`. A background thread polls
the gate and announces `notifications/tools/list_changed` when it opens or closes.

`python -m host.mcp_server [--data-dir D] [--harness H] [--keystore os|memory] [--allow-plain-loopback] [--no-start]
[--gate-poll SECONDS]`
"""
from __future__ import annotations

import json
import os
import secrets
import sys
import threading

from host.core import HARNESSES, TOOLS, check_args

PROTOCOL_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
SERVER_NAME = "agent-services"
SERVER_VERSION = "0.1.0"
GATE_POLL_SECONDS = 15
CORE_DOWN_TEXT = "agent-services is not running yet; call the status tool to start it."
STATUS_TOOL = {
    "name": "status",
    "description": "Whether agent-services is active in this session, and what to do if it is not (sign in, "
                   "update the plugin, or wait for the server). Starts the local service when it is not running.",
    "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
}

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603


def _valid_id(v) -> bool:
    return isinstance(v, str) or (isinstance(v, int) and not isinstance(v, bool))


def _error(rid, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}


def _ok(rid, res: dict) -> dict:
    return {"jsonrpc": "2.0", "id": rid, "result": res}


class McpServer:
    def __init__(self, ask, *, session=None, gate=None, start=None):
        """`gate(refresh=False) -> {"open", "reason", "notice"}`; None keeps the plain four-tool server.
        `start()` (optional) starts the local service when it is not running (the status tool and the first
        business call)."""
        self._ask = ask
        self._gate = gate
        self._start = start
        self.session = session if session is not None else "mcp-" + secrets.token_hex(8)
        self.write_lock = threading.Lock()
        self._listed: bool | None = None    # the open state the client last learned (list answer or announcement)
        self._started = False

    def _gate_now(self, refresh=False) -> dict:
        try:
            g = self._gate(refresh=refresh)
        except Exception:  # noqa: BLE001
            g = None
        if not isinstance(g, dict) or not isinstance(g.get("open"), bool):
            return {"open": False, "reason": "core_down", "notice": None}
        return g

    def _start_once(self) -> None:
        if self._started or self._start is None:
            return
        self._started = True
        try:
            self._start()
        except Exception:  # noqa: BLE001
            pass

    @staticmethod
    def _closed_text(g: dict) -> str:
        if g.get("notice"):
            return g["notice"]
        return CORE_DOWN_TEXT if g.get("reason") in ("core_down", "unknown", None) else str(g.get("reason"))

    def poll(self) -> dict | None:
        """One gate check; the list_changed notification when the open state changed since the client learned it."""
        if self._gate is None:
            return None
        g = self._gate_now()
        if self._listed is None or g["open"] == self._listed:
            return None
        self._listed = g["open"]
        return {"jsonrpc": "2.0", "method": "notifications/tools/list_changed"}

    def handle(self, message) -> dict | None:
        """One parsed JSON-RPC message in; the response, or None for a notification."""
        if not isinstance(message, dict):
            return _error(None, INVALID_REQUEST, "invalid request")
        has_id = "id" in message
        rid = message.get("id") if _valid_id(message.get("id")) else None
        if message.get("jsonrpc") != "2.0" or not isinstance(message.get("method"), str) \
                or (has_id and not _valid_id(message.get("id"))):
            return _error(rid, INVALID_REQUEST, "invalid request")
        if not has_id:
            return None                                       # notifications are never answered
        method, params = message["method"], message.get("params")
        try:
            if method == "initialize":
                return _ok(rid, self._initialize(params))
            if method == "ping":
                return _ok(rid, {})
            if method == "tools/list":
                return _ok(rid, {"tools": self._tools()})
            if method == "tools/call":
                return self._call(rid, params)
            return _error(rid, METHOD_NOT_FOUND, "method not found")
        except Exception:  # noqa: BLE001 — never let one request end the server
            return _error(rid, INTERNAL_ERROR, "internal error")

    def _tools(self) -> list:
        tools = [{"name": n, "description": t["description"], "inputSchema": t["input_schema"]}
                 for n, t in TOOLS.items()]
        if self._gate is None:
            return tools
        g = self._gate_now()
        self._listed = g["open"]
        return tools if g["open"] else [dict(STATUS_TOOL)]

    def _initialize(self, params) -> dict:
        want = params.get("protocolVersion") if isinstance(params, dict) else None
        version = want if want in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0]
        out = {"protocolVersion": version, "capabilities": {"tools": {"listChanged": self._gate is not None}},
               "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION}}
        if self._gate is not None:
            g = self._gate_now()
            self._listed = g["open"]
            if not g["open"]:
                out["instructions"] = self._closed_text(g)
        return out

    def _status(self, rid) -> dict:
        self._start_once()
        g = self._gate_now(refresh=True)
        ans = {"active": g["open"], "reason": g.get("reason"), "notice": g.get("notice")}
        return _ok(rid, {"content": [{"type": "text", "text": json.dumps(ans, ensure_ascii=False, sort_keys=True)}],
                         "structuredContent": ans, "isError": False})

    def _call(self, rid, params) -> dict:
        if self._gate is not None and isinstance(params, dict) and params.get("name") == STATUS_TOOL["name"]:
            return self._status(rid)
        if not isinstance(params, dict) or params.get("name") not in TOOLS:
            return _error(rid, INVALID_PARAMS, "unknown tool")
        name = params["name"]
        args = params.get("arguments")
        if args is None:
            args = {}
        if not isinstance(args, dict):
            return _error(rid, INVALID_PARAMS, "arguments must be an object")
        try:
            check_args(name, args)
        except ValueError as e:
            return _ok(rid, {"content": [{"type": "text", "text": f"bad_request: {e}"}], "isError": True})
        if self._gate is not None:
            self._start_once()
            g = self._gate_now()
            if not g["open"] and g.get("reason") in ("unknown", "core_down", "unavailable"):
                g = self._gate_now(refresh=True)
            if not g["open"]:
                text = f"inactive: {g.get('notice') or g.get('reason')}"
                return _ok(rid, {"content": [{"type": "text", "text": text}], "isError": True})
        ans = self._ask(name, args)
        return _ok(rid, {"content": [{"type": "text", "text": json.dumps(ans, ensure_ascii=False, sort_keys=True)}],
                         "structuredContent": ans, "isError": False})


def serve(server: McpServer, inp, out) -> None:
    """Read lines from the binary stream `inp` until end of input; write each response as one line to `out`."""
    while True:
        line = inp.readline()
        if not line:
            return
        if not line.strip():
            continue
        try:
            msg = json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            resp = _error(None, PARSE_ERROR, "parse error")
        else:
            resp = server.handle(msg)
        if resp is not None:
            _write(server, out, resp)


def _write(server: McpServer, out, msg: dict) -> None:
    data = json.dumps(msg, ensure_ascii=False).encode("utf-8") + b"\n"
    with server.write_lock:
        out.write(data)
        out.flush()


def _poll_loop(server: McpServer, out, every: float, stop: threading.Event) -> None:
    while not stop.wait(every):
        try:
            n = server.poll()
            if n is not None:
                _write(server, out, n)
        except Exception:  # noqa: BLE001 — a closed stdout ends the loop quietly
            return


def main(argv=None) -> int:
    import argparse
    ap = argparse.ArgumentParser(prog="python -m host.mcp_server")
    ap.add_argument("--data-dir")
    ap.add_argument("--harness", choices=HARNESSES, default="other")
    ap.add_argument("--keystore", choices=("os", "memory"), default="os")
    ap.add_argument("--allow-plain-loopback", action="store_true")
    ap.add_argument("--no-start", action="store_true")
    ap.add_argument("--gate-poll", type=float, default=GATE_POLL_SECONDS, metavar="SECONDS")
    a = ap.parse_args(argv)

    from host import core_client
    if a.data_dir:
        data_dir = a.data_dir
    else:
        from host.services import default_data_dir
        data_dir = str(default_data_dir())

    def start():                                               # the lazy start: the status tool or a business call
        if a.no_start:
            return
        from host import services
        if not services._alive(data_dir):
            services.ensure(data_dir, a.keystore, a.allow_plain_loopback)

    def ask(tool, args):
        return core_client.ask(tool, args, session=server.session, harness=a.harness, cwd=os.getcwd(),
                               data_dir=data_dir)

    def gate(refresh=False):
        return core_client.gate(data_dir=data_dir, refresh=refresh, timeout=15.0 if refresh else 3.0)

    server = McpServer(ask, gate=gate, start=start)
    stop = threading.Event()
    if a.gate_poll > 0:
        threading.Thread(target=_poll_loop, args=(server, sys.stdout.buffer, a.gate_poll, stop),
                         daemon=True).start()
    try:
        serve(server, sys.stdin.buffer, sys.stdout.buffer)
    except (BrokenPipeError, KeyboardInterrupt):
        pass
    finally:
        stop.set()
    return 0


if __name__ == "__main__":
    sys.exit(main())
