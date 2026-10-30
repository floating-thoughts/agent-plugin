"""agent-services plugin entry: `agent_core.py mcp <args>` runs the stdio MCP server;
any other arguments go to `host.services` (so `agent_core.py ensure` starts the daemon). The core's root is env
AGENT_CORE_ROOT, else `<plugin root>/core` when it holds `host/`, else the folder above the plugin. Exits with their
code."""
import os
import sys
from pathlib import Path


def core_root():
    if os.environ.get("AGENT_CORE_ROOT"):
        return os.environ["AGENT_CORE_ROOT"]
    plugin = Path(__file__).resolve().parent.parent
    if (plugin / "core" / "host").is_dir():
        return str(plugin / "core")
    return str(plugin.parent)


def main(argv):
    sys.path.insert(0, core_root())
    if argv[:1] == ["mcp"]:
        from host.mcp_server import main as run
        return run(argv[1:])
    from host.services import main as run
    return run(argv)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
