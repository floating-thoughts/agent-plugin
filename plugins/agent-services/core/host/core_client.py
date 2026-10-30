"""The client helper for the local core.

`send_event` and `ask` talk to the running daemon's POST /core/event and POST /core/ask with the local token from
connector.json. They never start the daemon, never raise and never print; any failure gives the open default
(`FALLBACK`, or `host.core.open_answer`).

CLI for command-type hooks: `python -m host.core_client event [--data-dir D] [--timeout S]` reads one JSON event on
stdin and writes the answer as one line of ASCII JSON on stdout; exit 0 always.
"""
from __future__ import annotations

import http.client
import json
import sys
import threading
from pathlib import Path

from host.core import ANSWER_KEYS, open_answer

FALLBACK = {"action": "allow", "reason": None, "set": None, "context": None, "notice": None,
            "fallback": "core_down"}


def _data_dir(data_dir) -> Path:
    if data_dir is not None:
        return Path(data_dir)
    from host.services import default_data_dir
    return default_data_dir()


def _post(data_dir, path: str, body: dict, timeout: float):
    """(status, parsed JSON) or None; the whole exchange within `timeout` seconds."""
    out: list = []

    def run():
        try:
            info = json.loads((_data_dir(data_dir) / "services" / "connector.json").read_text(encoding="utf-8"))
            port, token = int(info["port"]), info["token"]
            if not isinstance(token, str):
                return
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=max(timeout, 0.01))
            try:
                conn.request("POST", path, body=data, headers={"Content-Type": "application/json",
                                                               "X-Connector-Token": token})
                r = conn.getresponse()
                raw = r.read()
                out.append((r.status, json.loads(raw.decode("utf-8"))))
            finally:
                conn.close()
        except Exception:  # noqa: BLE001 — any failure is the open default
            pass

    try:
        t = threading.Thread(target=run, daemon=True)
        t.start()
        t.join(max(float(timeout), 0.0))
    except Exception:  # noqa: BLE001
        return None
    if t.is_alive() or not out:
        return None
    return out[0]


def send_event(event, *, data_dir=None, timeout=3.0) -> dict:
    try:
        r = _post(data_dir, "/core/event", event, timeout)
    except Exception:  # noqa: BLE001
        r = None
    if r is None:
        return dict(FALLBACK)
    status, ans = r
    if status != 200 or not isinstance(ans, dict) or set(ans) != set(ANSWER_KEYS) or len(ans) != len(ANSWER_KEYS):
        return dict(FALLBACK)
    return ans


def ask(tool, args, *, session, harness="other", cwd=None, data_dir=None, timeout=10.0) -> dict:
    try:
        r = _post(data_dir, "/core/ask", {"tool": tool, "args": args, "session": session, "harness": harness,
                                         "cwd": cwd}, timeout)
    except Exception:  # noqa: BLE001
        r = None
    if r is not None and r[0] == 200 and isinstance(r[1], dict):
        return r[1]
    return open_answer(tool, args)


def gate(*, data_dir=None, refresh=False, timeout=3.0) -> dict:
    """POST /core/gate of the running daemon -> {"open", "reason", "notice"}. Never starts the daemon, never
    raises: no daemon or any failure -> {"open": False, "reason": "core_down", "notice": None}."""
    down = {"open": False, "reason": "core_down", "notice": None}
    try:
        r = _post(data_dir, "/core/gate", {"refresh": bool(refresh)}, timeout)
    except Exception:  # noqa: BLE001
        r = None
    if r is None or r[0] != 200 or not isinstance(r[1], dict) or not isinstance(r[1].get("open"), bool):
        return down
    d = r[1]
    return {"open": d["open"], "reason": d.get("reason"), "notice": d.get("notice")}


def main(argv=None) -> int:
    try:
        import argparse
        ap = argparse.ArgumentParser(prog="python -m host.core_client", add_help=False)
        ap.add_argument("cmd")
        ap.add_argument("--data-dir")
        ap.add_argument("--timeout", type=float, default=3.0)
        try:
            a, _ = ap.parse_known_args(argv)
        except SystemExit:
            a = None
        ans = dict(FALLBACK)
        if a is not None and a.cmd == "event":
            try:
                event = json.loads(sys.stdin.buffer.read().decode("utf-8"))
            except Exception:  # noqa: BLE001
                event = None
            if isinstance(event, dict):
                ans = send_event(event, data_dir=a.data_dir, timeout=a.timeout)
        sys.stdout.write(json.dumps(ans, ensure_ascii=True) + "\n")
        sys.stdout.flush()
    except Exception:  # noqa: BLE001
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
