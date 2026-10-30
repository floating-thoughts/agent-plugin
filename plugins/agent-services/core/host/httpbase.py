"""Small helpers shared by the local HTTP services: a port-exclusive server, reading the request body by Content-Length,
and file permissions readable only by the current user."""
from __future__ import annotations

import logging
import os
import socket
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DRAIN_MAX = 4 << 20  # bodies larger than this are not drained; the connection is closed instead


class ExclusiveHTTPServer(ThreadingHTTPServer):
    """Port-exclusive: no SO_REUSEADDR (on Windows it lets a second process bind the same port); Windows also sets SO_EXCLUSIVEADDRUSE.
    A client that disconnects early (ConnectionReset / BrokenPipe / ConnectionAborted) logs one debug line and no traceback."""

    allow_reuse_address = False
    daemon_threads = True

    def server_bind(self):
        if os.name == "nt":
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionError, TimeoutError)):
            logging.getLogger("host.httpbase").debug("client disconnected: %s", type(exc).__name__)
            return
        super().handle_error(request, client_address)


def read_body(handler: BaseHTTPRequestHandler, limit: int) -> tuple:
    """Before replying, read the request body by Content-Length: replying and closing with the body unread makes Windows clients receive an RST (WinError 10054/10053).
    Returns ("ok", bytes) / ("bad", None) (Content-Length is not a non-negative integer) / ("large", None) (over the limit)."""
    raw = handler.headers.get("Content-Length")
    try:
        n = int(raw) if raw else 0
    except ValueError:
        n = -1
    if n < 0:
        handler.close_connection = True
        return "bad", None
    if n > limit:
        if n <= DRAIN_MAX:
            left = n
            while left > 0:
                chunk = handler.rfile.read(min(left, 64 * 1024))
                if not chunk:
                    break
                left -= len(chunk)
        else:
            handler.close_connection = True
        return "large", None
    return "ok", handler.rfile.read(n) if n else b""


def restrict_file(path: Path) -> None:
    """Make the file readable by the current user only: POSIX chmod 600; on Windows, drop inherited permissions and grant access to the current user only. Failure is not fatal."""
    try:
        if os.name == "nt":
            user = os.environ.get("USERNAME")
            if user:
                subprocess.run(
                    ["icacls", str(path), "/inheritance:r", "/grant:r", f"{user}:F"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10, check=False,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
        else:
            os.chmod(path, 0o600)
    except (OSError, subprocess.SubprocessError):
        pass
