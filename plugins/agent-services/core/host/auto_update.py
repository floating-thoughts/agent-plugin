"""Whether Claude Code's background auto-update is on for the agent-plugin marketplace (a required setup step).

Read only: the plugin never writes the customer's settings. Claude Code decides it in this order (plugins loading
reference, "Which marketplaces and plugins auto-update"): `autoUpdate` on the marketplace's `extraKnownMarketplaces`
entry in a settings file (managed first, then local, project and user), then `autoUpdate` in
`<config dir>/plugins/known_marketplaces.json` (what the /plugin Marketplaces toggle writes), else off for a marketplace
outside Anthropic's own. DISABLE_UPDATES, DISABLE_AUTOUPDATER or CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC turn the whole
pass off unless FORCE_AUTOUPDATE_PLUGINS is set.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

MARKETPLACE = "agent-plugin"
OFF_VARS = ("DISABLE_UPDATES", "DISABLE_AUTOUPDATER", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC")
FORCE_VAR = "FORCE_AUTOUPDATE_PLUGINS"
HOW = ("/plugin, then Marketplaces, select agent-plugin, then Enable auto-update; or set \"autoUpdate\": true on the "
       "agent-plugin entry under extraKnownMarketplaces in your settings")


def _managed_settings() -> Path:
    if sys.platform == "win32":
        return Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "ClaudeCode" / "managed-settings.json"
    if sys.platform == "darwin":
        return Path("/Library/Application Support/ClaudeCode/managed-settings.json")
    return Path("/etc/claude-code/managed-settings.json")


def _config_dir() -> Path:
    d = os.environ.get("CLAUDE_CONFIG_DIR")
    return Path(d) if d else Path.home() / ".claude"


def _json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _flag(entry):
    v = entry.get("autoUpdate") if isinstance(entry, dict) else None
    return v if isinstance(v, bool) else None


def state(cwd=None, env=None, config_dir=None, managed=None) -> dict:
    """{"on": bool, "source": where the answer came from, "how": the steps to turn it on}."""
    env = os.environ if env is None else env
    if any(env.get(v) for v in OFF_VARS) and not env.get(FORCE_VAR):
        return {"on": False, "source": "env", "how": HOW}
    cwd = Path(cwd) if cwd else Path.cwd()
    config = Path(config_dir) if config_dir else _config_dir()
    files = [("managed", Path(managed) if managed else _managed_settings()),
             ("local", cwd / ".claude" / "settings.local.json"),
             ("project", cwd / ".claude" / "settings.json"),
             ("user", config / "settings.json")]
    for name, path in files:
        data = _json(path)
        markets = data.get("extraKnownMarketplaces") if isinstance(data, dict) else None
        v = _flag(markets.get(MARKETPLACE)) if isinstance(markets, dict) else None
        if v is not None:
            return {"on": v, "source": name, "how": HOW}
    known = _json(config / "plugins" / "known_marketplaces.json")
    v = _flag(known.get(MARKETPLACE)) if isinstance(known, dict) else None
    if v is not None:
        return {"on": v, "source": "plugin_menu", "how": HOW}
    return {"on": False, "source": "default", "how": HOW}
