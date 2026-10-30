---
description: Sign in to agent-services, show its status, or sign out
argument-hint: "[status | login <email> | code <email> <code> | logout]"
allowed-tools: Bash(python:*)
---

Run the agent-services command line for the user. The entry point is
`python "${CLAUDE_PLUGIN_ROOT}/hooks/agent_core.py"`; it starts the local service when needed and prints one JSON answer.

The user's arguments: `$ARGUMENTS`

- No arguments or `status`: run `python "${CLAUDE_PLUGIN_ROOT}/hooks/agent_core.py" status` and report whether the
  account is signed in, its plan and any notice, in one or two sentences.
- `login <email>`: run `python "${CLAUDE_PLUGIN_ROOT}/hooks/agent_core.py" login start --email <email>`. A sign-in code
  is mailed to that address; ask the user for it, then continue as for `code`.
- `code <email> <code>`: run `python "${CLAUDE_PLUGIN_ROOT}/hooks/agent_core.py" login finish --email <email> --code <code>`
  and report whether the sign-in worked. The plugin turns on once the service accepts the sign-in.
- `logout`: run `python "${CLAUDE_PLUGIN_ROOT}/hooks/agent_core.py" logout` and confirm.

Never print or repeat a token; the command line keeps tokens in the system key store and never shows them. If a command
fails, show its error code and suggest `status`.
