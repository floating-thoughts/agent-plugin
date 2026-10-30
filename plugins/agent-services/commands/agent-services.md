---
description: Sign in to agent-services, show its status, or sign out
argument-hint: "[status | login <email> | code <email> <code> | logout | connect <endpoint> <server key> [<next key>] e2e:<key> [e2e:<next key>]]"
allowed-tools: Bash(python:*), Bash(python -m pip install --user cryptography)
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
- `connect <endpoint> <server key> [<next key>] e2e:<key> [e2e:<next key>]`: run
  `python "${CLAUDE_PLUGIN_ROOT}/hooks/agent_core.py" connect --endpoint <endpoint> --server-key <server key>
  --e2e-key <key>` (one `--server-key` per plain key and one `--e2e-key` per key given with the `e2e:` prefix, the
  prefix removed; two of a kind only while the server rotates that key). It writes the service address, the server's
  public signing keys and its public encryption keys to `client.json`; the operator gives all of them. An
  `https://<host name>` endpoint needs both kinds: every answer must be signed by a signing key, or the plugin pauses
  instead of using it, and every request is encrypted to the encryption key, so a proxy in between sees no
  credentials or content. A new endpoint signs this machine out; report the answer, then suggest `login`.

Requires Python 3.8 or newer with the `cryptography` package (`python -m pip install --user cryptography`).

If any step answers `missing_dependency`, tell the user the one command in its `detail`,
`python -m pip install --user cryptography`, and ask before running it. Once the user agrees, run it yourself, then retry
the failed step once. Never install anything without the user's yes.

Never print or repeat a token; the command line keeps tokens in the system key store and never shows them. If a command
fails, show its error code and suggest `status`.
