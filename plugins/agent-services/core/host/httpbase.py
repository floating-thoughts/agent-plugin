"""本机 HTTP 服务共用的小件：独占端口的服务器、按 Content-Length 读请求体、
只让当前用户能读的文件权限。"""
from __future__ import annotations

import logging
import os
import socket
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DRAIN_MAX = 4 << 20  # 超过这么大的请求体不读完，直接关连接


class ExclusiveHTTPServer(ThreadingHTTPServer):
    """端口独占：不开 SO_REUSEADDR（Windows 上它允许第二个进程绑同一端口），Windows 另设 SO_EXCLUSIVEADDRUSE。
    客户端提前断开（ConnectionReset / BrokenPipe / ConnectionAborted）只记一行 debug，不打 traceback。"""

    allow_reuse_address = False
    daemon_threads = True

    def server_bind(self):
        if os.name == "nt":
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionError, TimeoutError)):
            logging.getLogger("host.httpbase").debug("客户端断开：%s", type(exc).__name__)
            return
        super().handle_error(request, client_address)


def read_body(handler: BaseHTTPRequestHandler, limit: int) -> tuple:
    """回包之前先把请求体按 Content-Length 读掉：没读完就回包关连接，Windows 客户端会收到 RST（WinError 10054/10053）。
    返回 ("ok", bytes) / ("bad", None)（Content-Length 不是非负整数）/ ("large", None)（超过 limit）。"""
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
    """尽量只让当前用户能读：POSIX chmod 600；Windows 去掉继承、只授权当前用户。失败不致命。"""
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
