"""Small helpers shared by the local HTTP services: a port-exclusive server, reading the request body by Content-Length,
file permissions readable only by the current user (private folders, atomic secret files, private append files), and
the local daemon's answer proof (`daemon_proof`)."""
from __future__ import annotations

import hashlib
import hmac
import logging
import os
import socket
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DRAIN_MAX = 4 << 20  # bodies larger than this are not drained; the connection is closed instead


class ExclusiveHTTPServer(ThreadingHTTPServer):
    """Port-exclusive: no SO_REUSEADDR (on Windows it lets a second process bind the same port); Windows also sets SO_EXCLUSIVEADDRUSE.
    A client that disconnects early (ConnectionReset / BrokenPipe / ConnectionAborted) logs one debug line and no traceback.
    `max_handlers` (None = no cap) caps the concurrent handler threads: a connection over the cap is closed unanswered."""

    allow_reuse_address = False
    daemon_threads = True
    max_handlers: int | None = None

    def server_bind(self):
        if os.name == "nt":
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

    def process_request(self, request, client_address):
        if self.max_handlers is None:
            return super().process_request(request, client_address)
        slots = self.__dict__.get("_slots")
        if slots is None:
            slots = self.__dict__.setdefault("_slots", threading.BoundedSemaphore(self.max_handlers))
        if not slots.acquire(blocking=False):
            self.shutdown_request(request)
            return None
        try:
            threading.Thread(target=self._capped, args=(slots, request, client_address), daemon=True).start()
        except Exception:  # noqa: BLE001 - no thread: the connection is dropped, the slot freed
            slots.release()
            self.shutdown_request(request)
        return None

    def _capped(self, slots, request, client_address):
        try:
            self.process_request_thread(request, client_address)
        finally:
            slots.release()

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


class NotPrivate(OSError):
    """A file could not be made private to the current user."""


def current_sid() -> str | None:
    """The current user's SID as a string (S-1-5-...), read from the process token; None when it cannot be read or
    this is not Windows."""
    if os.name != "nt":
        return None
    try:
        import ctypes
        from ctypes import wintypes
        advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        advapi32.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
        advapi32.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
                                                 ctypes.POINTER(wintypes.DWORD)]
        advapi32.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.LPWSTR)]
        tok = wintypes.HANDLE()
        if not advapi32.OpenProcessToken(kernel32.GetCurrentProcess(), 0x0008, ctypes.byref(tok)):  # TOKEN_QUERY
            return None
        try:
            need = wintypes.DWORD(0)
            advapi32.GetTokenInformation(tok, 1, None, 0, ctypes.byref(need))   # 1 = TokenUser
            if not need.value:
                return None
            buf = ctypes.create_string_buffer(need.value)
            if not advapi32.GetTokenInformation(tok, 1, buf, need, ctypes.byref(need)):
                return None
            psid = ctypes.c_void_p.from_buffer(buf).value   # TOKEN_USER.User.Sid
            out = wintypes.LPWSTR()
            if not advapi32.ConvertSidToStringSidW(psid, ctypes.byref(out)):
                return None
            try:
                sid = out.value
            finally:
                kernel32.LocalFree(out)
            return sid if sid and sid.startswith("S-") else None
        finally:
            kernel32.CloseHandle(tok)
    except (OSError, AttributeError, ValueError):
        return None


def _icacls() -> str:
    """Absolute path of icacls.exe under %SystemRoot%/System32, so a planted icacls in the working directory or PATH never runs."""
    root = os.environ.get("SystemRoot") or os.environ.get("windir") or r"C:\Windows"
    return os.path.join(root, "System32", "icacls.exe")


def restrict_file(path: Path, *, required: bool = False) -> bool:
    """Make the file readable by the current user only: POSIX chmod 600; on Windows, drop inherited permissions and
    grant full access to the current user's SID only (icacls; its exit status is checked). True on success. A failure
    returns False, or raises NotPrivate with required=True (secret files are never left with inherited access)."""
    why = None
    try:
        if os.name == "nt":
            sid = current_sid()
            if not sid:
                why = "current user SID unknown"
            else:
                r = subprocess.run(
                    [_icacls(), str(path), "/inheritance:r", "/grant:r", f"*{sid}:F"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10, check=False,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
                if r.returncode != 0:
                    why = f"icacls failed ({r.returncode})"
        else:
            os.chmod(path, 0o600)
    except (OSError, subprocess.SubprocessError) as e:
        why = type(e).__name__
    if why is None:
        return True
    if required:
        raise NotPrivate(f"could not make {Path(path).name} private: {why}")
    return False


def private_dir(path: Path) -> Path:
    """Create the folder (and missing parents) with POSIX mode 0o700; an existing folder of ours is narrowed to 0o700.
    On Windows the folder keeps its inherited permissions (the user profile is private to the user)."""
    path = Path(path)
    if not path.is_dir():
        if path.parent != path and not path.parent.is_dir():
            private_dir(path.parent)
        try:
            path.mkdir(mode=0o700)
        except FileExistsError:
            pass
    if os.name != "nt":
        try:
            st = os.stat(path)
            if st.st_uid == os.getuid() and st.st_mode & 0o077:
                os.chmod(path, 0o700)
        except OSError:
            pass
    return path


def write_secret(path: Path, data: bytes) -> None:
    """Write a secret file atomically: a fresh `<name>.tmp` is created with O_CREAT|O_EXCL and mode 0o600 (on Windows
    its ACL is narrowed to the current user before any byte is written), then renamed over `path`. Raises OSError
    (NotPrivate when the file cannot be made private): a secret is never readable by others, not even briefly."""
    path = Path(path)
    tmp = path.with_name(path.name + ".tmp")
    try:
        tmp.unlink()
    except FileNotFoundError:
        pass
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(tmp, flags, 0o600)
    try:
        try:
            if os.name == "nt":
                restrict_file(tmp, required=True)
            else:
                os.fchmod(fd, 0o600)
            view = memoryview(data)
            while view:
                view = view[os.write(fd, view):]
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp, path)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def open_private(path: Path, mode: str = "a"):
    """Open a UTF-8 text file (newline "\\n") to append ("a") or rewrite ("w"); a new file is created with mode 0o600
    and an existing one is narrowed to 0o600 on POSIX."""
    if mode not in ("a", "w"):
        raise ValueError("mode must be a or w")
    flags = os.O_WRONLY | os.O_CREAT | (os.O_APPEND if mode == "a" else os.O_TRUNC) | getattr(os, "O_BINARY", 0)
    fd = os.open(path, flags, 0o600)
    if os.name != "nt":
        try:
            os.fchmod(fd, 0o600)
        except OSError:
            pass
    return os.fdopen(fd, mode, encoding="utf-8", newline="\n")


# ---------------------------------------------------------------- the local daemon's answer proof
NONCE_HEADER = "X-Connector-Nonce"
PROOF_HEADER = "X-Connector-Proof"


def valid_nonce(nonce) -> bool:
    return isinstance(nonce, str) and 16 <= len(nonce) <= 128 and all(c in "0123456789abcdef" for c in nonce)


def daemon_proof(token: str, nonce: str, status: int, method: str, path: str, body: bytes) -> str:
    """Hex HMAC-SHA256 under the local token of "<nonce>\\n<status>\\n<method>\\n<path>\\n" + the answer body. The
    daemon sends it as X-Connector-Proof; a client accepts an answer only with it, so a process squatting the port of a
    stale connector.json (which does not hold the token) is never taken for the daemon."""
    msg = f"{nonce}\n{int(status)}\n{method}\n{path}\n".encode("utf-8") + bytes(body)
    return hmac.new(token.encode("utf-8"), msg, hashlib.sha256).hexdigest()


def proof_ok(token: str, nonce: str, status: int, method: str, path: str, body: bytes, proof) -> bool:
    if not isinstance(proof, str) or len(proof) != 64:
        return False
    want = daemon_proof(token, nonce, status, method, path, body)
    return hmac.compare_digest(proof.encode("ascii", "replace"), want.encode("ascii"))


def pid_alive(pid) -> bool:
    """Whether a process with this pid runs now (connector.json left by a daemon that died names a dead pid). A pid
    that cannot be checked counts as alive (the answer proof still decides)."""
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    if os.name == "nt":
        try:
            import ctypes
            from ctypes import wintypes
            k = ctypes.WinDLL("kernel32", use_last_error=True)
            k.OpenProcess.restype = wintypes.HANDLE
            k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            k.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
            k.CloseHandle.argtypes = [wintypes.HANDLE]
            h = k.OpenProcess(0x1000, False, pid)   # PROCESS_QUERY_LIMITED_INFORMATION
            if not h:
                return ctypes.get_last_error() == 5   # access denied: it exists
            try:
                code = wintypes.DWORD()
                if not k.GetExitCodeProcess(h, ctypes.byref(code)):
                    return True
                return code.value == 259   # STILL_ACTIVE
            finally:
                k.CloseHandle(h)
        except (OSError, AttributeError):
            return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True
    return True
