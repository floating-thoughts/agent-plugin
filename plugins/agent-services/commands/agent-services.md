---
description: Sign in to agent-services, show its status, or sign out
argument-hint: "[status | login <email> | code <email> <code> | logout | savings [preview | on | off | status] | connect <endpoint> <server key> [<next key>] e2e:<key> [e2e:<next key>]]"
allowed-tools: Bash("${CLAUDE_PLUGIN_ROOT}/hooks/agent-core" *)
---

Run the agent-services command line for the user. The entry point is
`"${CLAUDE_PLUGIN_ROOT}/hooks/agent-core"` (a launcher that runs `hooks/agent_core.py` with the first Python 3.8+ it finds: `python`, then
`python3`, then `py -3`); it starts the local service when needed and prints one JSON answer.

The user's arguments: `$ARGUMENTS`

- No arguments or `status`: run `"${CLAUDE_PLUGIN_ROOT}/hooks/agent-core" status` and report whether the
  account is signed in, its plan and any notice, in one or two sentences.
- `login <email>`: run `"${CLAUDE_PLUGIN_ROOT}/hooks/agent-core" login start --email <email>`. A sign-in code
  is mailed to that address; ask the user for it, then continue as for `code`.
- `code <email> <code>`: run `"${CLAUDE_PLUGIN_ROOT}/hooks/agent-core" login finish --email <email> --code <code>`
  and report whether the sign-in worked. The plugin turns on once the service accepts the sign-in.
- `logout`: run `"${CLAUDE_PLUGIN_ROOT}/hooks/agent-core" logout` and confirm.
- `savings`: run `"${CLAUDE_PLUGIN_ROOT}/hooks/agent-core" savings` and report what the services saved so
  far in one or two sentences. If it answers `service_off`, say that savings are worked out by the service from a daily
  usage summary this machine uploads only after the user turns it on, and offer `savings on`.
- `savings on`: first run `"${CLAUDE_PLUGIN_ROOT}/hooks/agent-core" savings preview` and show the user the
  `body_text` it returns: that is exactly what one daily upload sends. Ask whether to turn the upload on; only on the
  user's yes run `"${CLAUDE_PLUGIN_ROOT}/hooks/agent-core" savings on` and confirm. Savings appear once a day
  or more has been uploaded.
- `savings off`: run `"${CLAUDE_PLUGIN_ROOT}/hooks/agent-core" savings off` and confirm that nothing more is
  uploaded. `savings status`: run `"${CLAUDE_PLUGIN_ROOT}/hooks/agent-core" savings status` and report it.
- `connect <endpoint> <server key> [<next key>] e2e:<key> [e2e:<next key>]`: run
  `"${CLAUDE_PLUGIN_ROOT}/hooks/agent-core" connect --endpoint <endpoint> --server-key <server key>
  --e2e-key <key>` (one `--server-key` per plain key and one `--e2e-key` per key given with the `e2e:` prefix, the
  prefix removed; two of a kind only while the server rotates that key). It writes the service address, the server's
  public signing keys and its public encryption keys to `client.json`; the operator gives all of them. Without
  `client.json` the plugin uses its built-in production service, so `connect` is only needed to use another one. An
  `https://<host name>` endpoint needs both kinds: every answer must be signed by a signing key, or the plugin pauses
  instead of using it, and every request is encrypted to the encryption key, so a proxy in between sees no
  credentials or content. A new endpoint, pin or key (a key rotation included) signs this machine out; the answer
  then says `"signed_out": true` with a notice: report it, then suggest `login`.

Requires Python 3.8 or newer (as `python`, `python3` or `py -3`) with the `cryptography` package.

If any step answers `missing_dependency`, tell the user that the `cryptography` package is missing and that
`"${CLAUDE_PLUGIN_ROOT}/hooks/agent-core" --install-cryptography` installs it into the same Python (the `detail` gives the
equivalent pip command), and ask before running it. Once the user agrees, run it yourself, then retry
the failed step once. Never install anything without the user's yes.

Never print or repeat a token; the command line keeps tokens in the system key store and never shows them. If a command
fails, show its error code and suggest `status`.
