"""The customer dashboard's local state, kept by the core.

On a main-agent turn_end the core asks `on_turn_end()`, which returns at once: at most once per INTERVAL seconds it
starts a background thread that renders `<data dir>/dashboard/index.html` through host/dashboard.py
(`collect(data_dir, status=, savings=, report=)`, then `write(data_dir, template_path, data) -> (path, changed)`) and,
when the page changed, records `changed_at`. `facts` (given by the daemon, host/services.py dashboard_facts) returns
(status, savings, report): the bodies of GET /local/status, /local/metrics/savings and /local/metrics/report. It is
called on the render thread only; when it is missing or raises, those parts are None and the page still renders.
The plugin publishes the page as an Artifact and reports back with the core events `dashboard_published` {url} and
`dashboard_denied`. Everything is kept in `<data dir>/services/dashboard.json`:
{"changed_at", "url", "published_at", "denied"}, written atomically (temp file, then os.replace). Times are Unix
seconds. Nothing here raises into the caller.
"""
from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

INTERVAL = 600   # seconds between two renders (and between two publishes, on the plugin side)
KINDS = ("dashboard_published", "dashboard_denied")
STATE_KEYS = ("changed_at", "url", "published_at", "denied")
URL_MAX = 500


def default_state() -> dict:
    return {"changed_at": None, "url": None, "published_at": None, "denied": False}


def template_path() -> Path | None:
    """plugin/dashboard/index.html in the repository; <plugin>/dashboard/index.html in the shipped shell."""
    here = Path(__file__).resolve().parent
    for p in (here.parent / "plugin" / "dashboard" / "index.html", here.parent.parent / "dashboard" / "index.html"):
        if p.is_file():
            return p
    return None


def _default_writer():
    try:
        from host import dashboard
    except ImportError:
        return None
    return getattr(dashboard, "write", None)


def _default_collect():
    try:
        from host import dashboard
    except ImportError:
        return None
    return getattr(dashboard, "collect", None)


def _atomic_write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    try:
        tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass


class DashboardState:
    def __init__(self, data_dir, *, clock=None, sync=False, writer=None, template=None, facts=None, collector=None):
        self.data_dir = Path(data_dir)
        self.path = self.data_dir / "services" / "dashboard.json"
        self._clock = clock or time.time
        self.sync = sync
        self._writer = writer
        self._template = template
        self._facts = facts
        self._collector = collector
        self._lock = threading.RLock()
        self._last_render: float | None = None
        self._busy = False

    def _now(self) -> float:
        try:
            return float(self._clock())
        except Exception:  # noqa: BLE001
            return time.time()

    # ---------------- the state file
    def read(self) -> dict:
        out = default_state()
        try:
            got = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return out
        if isinstance(got, dict):
            for k in STATE_KEYS:
                if k in got:
                    out[k] = got[k]
        return out

    def _update(self, **fields) -> None:
        with self._lock:
            st = self.read()
            st.update(fields)
            try:
                _atomic_write_json(self.path, st)
            except OSError:
                pass

    # ---------------- render, off the hook path
    def on_turn_end(self) -> bool:
        """Start a render when none ran in the last INTERVAL seconds; True when one was started."""
        now = self._now()
        with self._lock:
            if self._busy or (self._last_render is not None and now - self._last_render < INTERVAL):
                return False
            self._last_render = now
            self._busy = True
        if self.sync:
            self._render()
        else:
            threading.Thread(target=self._render, daemon=True).start()
        return True

    def _render(self) -> None:
        try:
            write = self._writer if self._writer is not None else _default_writer()
            template = self._template if self._template is not None else template_path()
            if write is None or template is None:
                return
            data = self._data()
            got = write(self.data_dir, template) if data is None else write(self.data_dir, template, data)
            changed = bool(got[1]) if isinstance(got, (tuple, list)) and len(got) == 2 else False
            if changed:
                self._update(changed_at=self._now())
        except Exception:  # noqa: BLE001 — a render error never escapes
            pass
        finally:
            with self._lock:
                self._busy = False

    def _data(self):
        """collect()'s result with the daemon's facts, or None (write then collects without them)."""
        if self._facts is None:
            return None
        status = savings = report = None
        try:
            got = self._facts()
            if isinstance(got, (tuple, list)) and len(got) == 3:
                status, savings, report = got
        except Exception:  # noqa: BLE001 — a failing fact source leaves its parts None
            pass
        collect = self._collector if self._collector is not None else _default_collect()
        if collect is None:
            return None
        try:
            return collect(self.data_dir, status=status, savings=savings, report=report)
        except Exception:  # noqa: BLE001
            return None

    # ---------------- the plugin's reports
    def published(self, url) -> None:
        if not isinstance(url, str) or not url.startswith("https://") or len(url) > URL_MAX:
            raise ValueError("url")
        self._update(url=url, published_at=self._now(), denied=False)

    def denied(self) -> None:
        self._update(denied=True)
