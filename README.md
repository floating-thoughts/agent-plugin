# agent-services

agent-services is a Claude Code plugin. It connects Claude Code's hook events (subagent dispatch, tool calls,
checkpoints and usage) to a small local core that runs on your own machine.

Every service needs a signed-in account. Until you sign in, the plugin stays off: hooks pass through unchanged,
its tools answer only with its status, and nothing is sent anywhere.

## Requirements

Python 3.9 or newer, as `python`, `python3` or (on Windows) `py -3`: the plugin uses the first one it finds. It also
needs the `cryptography` package. If that is missing, the sign-in command says so and offers to install it for you; to
install it yourself (use `python3` if that is your Python):

```
python -m pip install --user cryptography
```

## Install

Pick one of the three ways below. Each ends with signing in.

### 1. Just you

Inside Claude Code:

```
/plugin marketplace add floating-thoughts/agent-plugin
/plugin install agent-services@agent-plugin
```

Or the same from a terminal:

```
claude plugin marketplace add floating-thoughts/agent-plugin
claude plugin install agent-services@agent-plugin
```

Then sign in inside Claude Code (a code is mailed to you; give it when asked):

```
/agent-services:agent-services login <email>
```

### 2. A team working in one project

Add these keys to the project's `.claude/settings.json` (create the file if it does not exist; merge the keys into
it if it does) and commit it. Everyone who opens the project and trusts the folder is offered the plugin.

```json
{
  "extraKnownMarketplaces": {
    "agent-plugin": {
      "source": { "source": "github", "repo": "floating-thoughts/agent-plugin" }
    }
  },
  "enabledPlugins": { "agent-services@agent-plugin": true }
}
```

Each member then signs in once with `/agent-services:agent-services login <email>`.

### 3. Machines managed by an organisation

Put the same keys in Claude Code's managed settings file, which users cannot override. Create or merge into the file
at the path for the operating system:

```
Windows: C:\Program Files\ClaudeCode\managed-settings.json
macOS:   /Library/Application Support/ClaudeCode/managed-settings.json
Linux:   /etc/claude-code/managed-settings.json
```

```json
{
  "extraKnownMarketplaces": {
    "agent-plugin": {
      "source": { "source": "github", "repo": "floating-thoughts/agent-plugin" }
    }
  },
  "enabledPlugins": { "agent-services@agent-plugin": true }
}
```

Each user then signs in once with `/agent-services:agent-services login <email>`.

## See what you saved

```
/agent-services:agent-services savings on
/agent-services:agent-services savings
```

Savings are worked out by the service from a small daily usage summary. Nothing is uploaded until you turn it on:
`savings on` first shows you exactly what one daily upload contains and asks before turning it on. After a day or more
has been uploaded, `savings` shows what the services saved so far; `savings off` stops the uploads.

## Service address

The plugin ships with the address and public keys of our production service, so a fresh install signs in without
any setup. It talks to the service named in `client.json` (in `~/.agent-services/services/`) when that file exists.
If you were given another address and a server key, set them once before signing in:

```
/agent-services:agent-services connect https://<service host> <server key> e2e:<encryption key>
```

The connection is checked with your system's certificate store, and every answer must be signed with that server key;
an answer that is not is never used, and the plugin pauses with a notice instead. Every request and answer is also
encrypted end to end with the encryption key, so a proxy or CDN in between sees no sign-in code, token or content.

## License

All rights reserved; see `LICENSE`. The terms of use are in the end-user license agreement shipped by the installer.
