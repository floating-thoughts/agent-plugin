# agent-services

agent-services is a Claude Code plugin. It connects Claude Code's hook events (subagent dispatch, tool calls,
checkpoints and usage) to our service. Everything runs inside Claude Code itself, in the plugin's hooks module.

Every service needs a signed-in account; accounts are created by us, so send us your email address first (sign-in
codes are mailed only to addresses we have set up). Until you sign in, or whenever the sign-in is no longer valid, the plugin is
paused: hooks pass through unchanged, every one of its tools answers only with the sign-in line, and nothing is sent
except the sign-in itself and a health check.

## Requirements

Claude Code: the terminal (CLI) or the desktop app. Nothing else: no Python, no packages, no background process.

## Install

Pick one of the three ways below. Each has two required steps after installing: turn on auto-update, then sign in.
Auto-update is off by default for marketplaces outside Anthropic's own, and Claude Code offers no way for a plugin to
turn it on for you; without it you only get fixes and new services by updating by hand.
The plugin also keeps itself up to date in the background: at most every 6 hours a session runs Claude Code's own
plugin update for agent-services and reloads its plugins (in the desktop app, the next new session uses the update).
Auto-update stays required: it is Claude Code's own path and also works when the plugin cannot run.

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

Turn on auto-update (required): inside Claude Code run `/plugin`, open **Marketplaces**, select `agent-plugin` and
choose **Enable auto-update**.

Then sign in inside Claude Code:

```
/agent-services login <email>
```

A one-time code is mailed to you. Claude Code then asks for it in its own question dialog; type it there, not on the
command line. (Typed command lines are kept in the prompt history; the code is single use and expires after 10
minutes, but the dialog keeps it out of the history altogether.) If you close the dialog, finish later in any session
within 10 minutes with `/agent-services code`.

### 2. A team working in one project

Add these keys to the project's `.claude/settings.json` (create the file if it does not exist; merge the keys into
it if it does) and commit it. Everyone who opens the project and trusts the folder is offered the plugin.

```json
{
  "extraKnownMarketplaces": {
    "agent-plugin": {
      "source": { "source": "github", "repo": "floating-thoughts/agent-plugin" },
      "autoUpdate": true
    }
  },
  "enabledPlugins": { "agent-services@agent-plugin": true }
}
```

Each member then signs in once with `/agent-services login <email>`.

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
      "source": { "source": "github", "repo": "floating-thoughts/agent-plugin" },
      "autoUpdate": true
    }
  },
  "enabledPlugins": { "agent-services@agent-plugin": true }
}
```

Each user then signs in once with `/agent-services login <email>`.

## Commands

`/agent-services` (or `/agent-services status`) shows the sign-in, the plan, the service state and the auto-update
setup. The others: `login [<email>]`, `code`, `logout`, `savings [preview | on | off | status | mail on | mail off]`,
`estimate [preview | send]`, `served [status | pin <role> <version> | unpin <role> | channel <name>]`,
`dashboard [allow | not_now]`, `offline on | off` and `outbox [<day>]`. While the plugin is paused only `status`, `login`, `code` and `logout` work.
The command answers by itself: no model reads the code or the answers.

The tools the model can call are `mcp__agent-services__router_advice`, `lesson_lookup`, `savings`,
`checkpoint_advice`, `status` and `setup` (it applies your answers to the setup questions below, and only those). Earlier versions named them `mcp__plugin_agent-services_agent-services__<name>`;
permission rules you wrote for the old names do nothing now and can be removed from your settings by hand. The
plugin never writes your settings or permission rules.

## Setup questions

With the first message of a session, while the dashboard or the savings report is not set up yet, Claude asks you
about them once, in its question dialog: whether to publish your dashboard (Allow or Not now), and, after showing you
exactly what one daily upload contains, whether to turn on the daily savings report (Turn on or Not now). "Not now"
is asked again after 7 days. You can change either answer at any time with `/agent-services dashboard allow`,
`/agent-services dashboard not_now`, `/agent-services savings on` or `/agent-services savings off`.

## What you see

Under the prompt, the plugin keeps one status line, refreshed when a session starts and after each turn:

```
agent-services · saved $12.40 (8.1%) since 10-30 · today: 5 routed, 1 compacted
```

The dollar figure and percentage come from the service (from the daily usage summaries, see below) and are refreshed
at most every 10 minutes. Today's counts are local: subagents routed to a cheaper model, checkpoint compactions and
indexed file reads. Before savings are turned on the line says `on` and shows the command that turns them on; before
the first daily upload it says `savings show after the first daily upload`; when you are not signed in it shows the
sign-in command. The line never shows model names, token counts, account details or file paths.

## See what you saved

```
/agent-services savings preview
/agent-services savings on
/agent-services savings
```

Savings are worked out by the service from a small daily usage summary. Nothing is uploaded until you turn it on:
`savings preview` shows you exactly what one daily upload contains, and `savings on` works only after that. After a
day or more has been uploaded, `savings` shows what the services saved so far; `savings off` stops the uploads.
`estimate preview` shows the summary a one-time savings estimate would send, and `estimate send` sends exactly that,
once.

## What is sent, and where it is kept

- **To our service.** Every request goes to the service's built-in address encrypted end to end (X25519,
  AES-256-GCM) inside the TLS connection, and every answer must carry our server's Ed25519 signature; an answer that
  does not is never used, and the plugin pauses with a notice instead. A proxy or CDN in between sees no email, code,
  token or content. The only unencrypted request is a health check. What a request carries is minimized: a subagent
  dispatch sends the first word and the length of its description, never the text; a daily summary carries counts
  and token totals, never prompts, file contents or paths.
- **The request log.** Every request is written, before it is sent, to
  `~/.agent-services/services/outbox/<day>-<session>.jsonl` (secrets such as the code and the token redacted), with
  previews and each call the model made to the plugin's tools. `/agent-services outbox` shows where it is and its
  last lines. Files older than 90 days are cleared.
- **The dashboard.** After a turn, at most every 10 minutes and only when it changed, the plugin asks Claude Code's
  own Artifact tool to publish a dashboard page to your claude.ai account. That is the one thing that goes anywhere
  but our service. The page holds only numbers (savings, counts, plan, service on or off), never text from a session,
  a path or a host name. It is published only after you chose Allow (see Setup questions); the plugin then answers
  Claude Code's permission check for that one call of its own, its dashboard page, and for nothing else. It never
  writes your settings or permission rules. Without your Allow nothing is published. Each attempt is logged in the
  request log.
- **Your sign-in.** The token and the device key are kept in Claude Code's plugin store, a plain file in your Claude
  Code configuration folder (`~/.claude/plugins/store/`), protected only by your user account's file permissions.
  Other plugins you install, and any program running as you, can read that file; a copy of it works as your sign-in
  until the next rotation or sign-out. `/agent-services logout` ends the sign-in on the server and deletes it here.
  Each new sign-in mails you a notice, and an administrator can end any sign-in.

## Updating

The plugin updates itself in the terminal and in the desktop app (see Install). Where Claude Code cannot run a
command (a surface without it), the plugin runs nothing and instead shows, at most once a week in the status line and
always in `/agent-services status`, the one terminal command that updates it:

```
claude plugin marketplace update agent-plugin && claude plugin update agent-services@agent-plugin
```

## Moving from the Python version

Versions before 0.2.0 ran a local Python process. On its first start this version stops that process through its
own stop request (it signs out on the server first), imports its savings counters once, and writes
`~/.agent-services/MIGRATED` with what it did. It never starts or kills any other process. The old files stay where
they are; they are yours. Then sign in again with `/agent-services login`. If the old process was not running, its
sign-in may stay valid on the server until it expires after 30 days unused; the status line says so once after you
sign in.

## License

All rights reserved; see `LICENSE`. The terms of use are in the end-user license agreement shipped by the installer.
The vendored cryptography (`hooks/noble.js`: @noble/curves, @noble/hashes, @noble/ciphers) is MIT licensed; its
notices are in that file.
