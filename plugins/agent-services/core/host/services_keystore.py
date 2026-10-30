"""Key store: where the connector keeps its service token, device key and account data.

Backends: Windows Credential Manager (advapi32 generic credentials), macOS Keychain (`security`), Linux libsecret
(`secret-tool`). Secrets never go on a command line and never into a plain file; there is no file fallback.
`MemoryKeyStore` is the test fake (values only in this process's memory).
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import threading

__all__ = ["KeyStore", "MemoryKeyStore", "KeyStoreUnavailable", "default_keystore"]


class KeyStoreUnavailable(Exception):
    """No usable OS key store on this machine (or it refused the operation)."""


class KeyStore:
    """Base: names map to str values. Subclasses implement _get/_set/_delete."""

    def get(self, name: str) -> str | None:
        _check_name(name)
        return self._get(name)

    def set(self, name: str, value: str) -> None:
        _check_name(name)
        if not isinstance(value, str):
            raise TypeError("key store values must be str")
        self._set(name, value)

    def delete(self, name: str) -> None:
        _check_name(name)
        self._delete(name)

    def _get(self, name: str) -> str | None:  # pragma: no cover - abstract
        raise NotImplementedError

    def _set(self, name: str, value: str) -> None:  # pragma: no cover - abstract
        raise NotImplementedError

    def _delete(self, name: str) -> None:  # pragma: no cover - abstract
        raise NotImplementedError

    def __repr__(self) -> str:  # never show values
        return f"<{type(self).__name__}>"


def _check_name(name) -> None:
    if not isinstance(name, str) or not name or len(name) > 200:
        raise ValueError("bad key store name")


class MemoryKeyStore(KeyStore):
    def __init__(self):
        self._d: dict[str, str] = {}
        self._lock = threading.Lock()

    def _get(self, name):
        with self._lock:
            return self._d.get(name)

    def _set(self, name, value):
        with self._lock:
            self._d[name] = value

    def _delete(self, name):
        with self._lock:
            self._d.pop(name, None)


# ------------------------------------------------------------------ Windows Credential Manager

class WindowsKeyStore(KeyStore):
    CRED_TYPE_GENERIC = 1
    CRED_PERSIST_LOCAL_MACHINE = 2
    ERROR_NOT_FOUND = 1168

    def __init__(self, service: str):
        import ctypes
        from ctypes import wintypes
        try:
            advapi = ctypes.WinDLL("advapi32", use_last_error=True)
        except (OSError, AttributeError) as e:
            raise KeyStoreUnavailable("Windows Credential Manager not available") from None

        class FILETIME(ctypes.Structure):
            _fields_ = [("dwLowDateTime", wintypes.DWORD), ("dwHighDateTime", wintypes.DWORD)]

        class CREDENTIALW(ctypes.Structure):
            _fields_ = [("Flags", wintypes.DWORD), ("Type", wintypes.DWORD), ("TargetName", wintypes.LPWSTR),
                        ("Comment", wintypes.LPWSTR), ("LastWritten", FILETIME),
                        ("CredentialBlobSize", wintypes.DWORD), ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)),
                        ("Persist", wintypes.DWORD), ("AttributeCount", wintypes.DWORD),
                        ("Attributes", ctypes.c_void_p), ("TargetAlias", wintypes.LPWSTR),
                        ("UserName", wintypes.LPWSTR)]

        PCRED = ctypes.POINTER(CREDENTIALW)
        self._ct, self._CRED, self._service = ctypes, CREDENTIALW, service
        self._write = advapi.CredWriteW
        self._write.argtypes = [PCRED, wintypes.DWORD]
        self._write.restype = wintypes.BOOL
        self._read = advapi.CredReadW
        self._read.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(PCRED)]
        self._read.restype = wintypes.BOOL
        self._del = advapi.CredDeleteW
        self._del.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD]
        self._del.restype = wintypes.BOOL
        self._free = advapi.CredFree
        self._free.argtypes = [ctypes.c_void_p]
        self._free.restype = None
        self._PCRED = PCRED

    def _target(self, name: str) -> str:
        return f"{self._service}/{name}"

    def _get(self, name):
        ct = self._ct
        p = self._PCRED()
        if not self._read(self._target(name), self.CRED_TYPE_GENERIC, 0, ct.byref(p)):
            err = ct.get_last_error()
            if err == self.ERROR_NOT_FOUND:
                return None
            raise KeyStoreUnavailable(f"CredReadW failed ({err})")
        try:
            c = p.contents
            raw = ct.string_at(c.CredentialBlob, c.CredentialBlobSize) if c.CredentialBlobSize else b""
        finally:
            self._free(p)
        return raw.decode("utf-8")

    def _set(self, name, value):
        ct = self._ct
        data = value.encode("utf-8")
        if len(data) > 2560:
            raise ValueError("value too large for the credential store")
        buf = (ct.c_ubyte * max(len(data), 1)).from_buffer_copy(data or b"\0")
        cred = self._CRED()
        cred.Type = self.CRED_TYPE_GENERIC
        cred.TargetName = self._target(name)
        cred.CredentialBlobSize = len(data)
        cred.CredentialBlob = ct.cast(buf, ct.POINTER(ct.c_ubyte))
        cred.Persist = self.CRED_PERSIST_LOCAL_MACHINE
        cred.UserName = name
        if not self._write(ct.byref(cred), 0):
            raise KeyStoreUnavailable(f"CredWriteW failed ({ct.get_last_error()})")

    def _delete(self, name):
        ct = self._ct
        if not self._del(self._target(name), self.CRED_TYPE_GENERIC, 0):
            err = ct.get_last_error()
            if err != self.ERROR_NOT_FOUND:
                raise KeyStoreUnavailable(f"CredDeleteW failed ({err})")


# ------------------------------------------------------------------ macOS Keychain

def _run(argv: list[str], stdin: str | None = None) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(argv, input=stdin, capture_output=True, text=True, timeout=30, check=False)
    except (OSError, subprocess.SubprocessError):
        raise KeyStoreUnavailable(f"{argv[0]} failed to run") from None


class MacKeyStore(KeyStore):
    def __init__(self, service: str, binary: str):
        self._service, self._bin = service, binary

    def _get(self, name):
        r = _run([self._bin, "find-generic-password", "-s", self._service, "-a", name, "-w"])
        if r.returncode == 44:  # errSecItemNotFound
            return None
        if r.returncode != 0:
            raise KeyStoreUnavailable(f"security find-generic-password failed ({r.returncode})")
        return r.stdout[:-1] if r.stdout.endswith("\n") else r.stdout

    def _set(self, name, value):
        # The secret goes on stdin of `security -i` (interactive mode), never on a command line.
        if any(ch in value for ch in "\r\n\"\\"):
            raise ValueError("value not storable in the keychain command stream")
        cmd = f'add-generic-password -U -s "{self._service}" -a "{name}" -w "{value}"\n'
        r = _run([self._bin, "-i"], stdin=cmd)
        if r.returncode != 0:
            raise KeyStoreUnavailable(f"security add-generic-password failed ({r.returncode})")

    def _delete(self, name):
        r = _run([self._bin, "delete-generic-password", "-s", self._service, "-a", name])
        if r.returncode not in (0, 44):
            raise KeyStoreUnavailable(f"security delete-generic-password failed ({r.returncode})")


# ------------------------------------------------------------------ Linux libsecret

class SecretToolKeyStore(KeyStore):
    def __init__(self, service: str, binary: str):
        self._service, self._bin = service, binary

    def _attrs(self, name):
        return ["service", self._service, "name", name]

    def _get(self, name):
        r = _run([self._bin, "lookup", *self._attrs(name)])
        if r.returncode != 0:
            return None if not r.stderr.strip() else _raise(f"secret-tool lookup failed ({r.returncode})")
        return r.stdout[:-1] if r.stdout.endswith("\n") else r.stdout

    def _set(self, name, value):
        r = _run([self._bin, "store", f"--label={self._service}/{name}", *self._attrs(name)], stdin=value)
        if r.returncode != 0:
            raise KeyStoreUnavailable(f"secret-tool store failed ({r.returncode})")

    def _delete(self, name):
        _run([self._bin, "clear", *self._attrs(name)])


def _raise(msg):
    raise KeyStoreUnavailable(msg)


def default_keystore(service: str = "agent-services", platform: str | None = None) -> KeyStore:
    """The OS key store for this platform; KeyStoreUnavailable when there is none (never a file fallback)."""
    plat = platform or sys.platform
    if plat.startswith("win"):
        if sys.platform != "win32":
            raise KeyStoreUnavailable("Windows Credential Manager only on Windows")
        return WindowsKeyStore(service)
    if plat == "darwin":
        b = shutil.which("security")
        if not b:
            raise KeyStoreUnavailable("macOS keychain tool `security` not found")
        return MacKeyStore(service, b)
    if plat.startswith("linux"):
        b = shutil.which("secret-tool")
        if not b:
            raise KeyStoreUnavailable("libsecret `secret-tool` not found")
        return SecretToolKeyStore(service, b)
    raise KeyStoreUnavailable(f"no key store backend for {plat}")
