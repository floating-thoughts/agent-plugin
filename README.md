# agent-services

agent-services is a Claude Code plugin. It connects Claude Code's hook events (subagent dispatch, tool calls,
checkpoints and usage) to our service. Everything runs inside Claude Code itself, in the plugin's hooks module.

Every service needs a signed-in account; accounts are created by us, so send us your email address first (sign-in
codes are mailed only to addresses we have set up). Until you sign in, or whenever the sign-in is no longer valid, the plugin is
signed out: hooks pass through unchanged, every one of its tools answers only with the sign-in line, and nothing is sent
except the sign-in itself and a health check.

What it sends and when, what the service keeps and for how long, what a company admin sees, the files it writes on
this computer and what you can turn off are all in [DATA.md](plugins/agent-services/DATA.md), shipped with the
plugin; `/agent-services info data` shows it, and `/agent-services info hooks` lists every hook it registers.

## Without sign-in

agent-services is a paid service, so it needs a sign-in. Signed out, or when the sign-in fails, the plugin does
nothing: it sends nothing to the service (except a sign-in you start), holds no edit, changes no subagent and gives
the model no notes. Claude Code works as usual; only a sign-in hint shows in the status line and above the prompt.

## Requirements

Claude Code: the terminal (CLI) or the desktop app. Nothing else: no Python, no packages, no background process.

## Install

Pick one of the three ways below; after installing, sign in.
The plugin never updates itself. At most once an hour on each computer (a check that fails counts too) it refreshes
the marketplace listing and compares versions; when a newer one is listed, Claude tells you, with a link to the
changes, and asks whether to update. Then your answer (or `/agent-services update`) runs the update.
Claude Code's own auto-update for a marketplace is a different thing: it is off by default for marketplaces outside
Anthropic's own, and if you (or your organisation) turn it on for agent-plugin, Claude Code updates the plugin by
itself, without asking you; the plugin then gives Claude no note about new versions. `/agent-services status` shows
which way applies.

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

Then sign in inside Claude Code:

```
/agent-services login <email>
```

A one-time code is mailed to you. Paste it as your next message: the plugin takes it before it reaches Claude and
finishes the sign-in, and the code works for 10 minutes in any session. Never type it on the command line (typed
command lines are kept in the prompt history). Then `/agent-services setup` asks the setup questions below.

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

Each member then signs in once with `/agent-services login <email>`. Adding `"autoUpdate": true` to the
`agent-plugin` entry turns on Claude Code's own auto-update: Claude Code then updates the plugin for everyone without
asking each person.

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

Each user then signs in once with `/agent-services login <email>`. With `"autoUpdate": true` on the `agent-plugin`
entry, Claude Code updates the plugin on these machines without asking the users.

## Commands

`/agent-services` (or `/agent-services status`) shows the sign-in, the plan, the service state, how updates arrive,
the savings record, the methods level and how many setup questions wait; it never asks anything. The others:

- `login [<email>]` and `logout`.
- `setup` asks every open setup question in one go (the savings record, the methods level and the routing level),
  nothing else.
- `sharing on_backfill | on_from_now | off | not_now | preview`: the savings record (`on_backfill`: upload, including
  the past 30 days; `on_from_now`: upload from now on only; `off`: don't upload; `sharing on` asks the same three-option
  question in the dialog, or lists the three commands, and turns nothing on by itself); `sharing page on | off` and
  `sharing mail on | off` change one part. Only you turn the upload on: the setup tool the model can call cannot.
- `savings` shows what agent-services saved so far.
- `methods off | suggest | on | preview | diff | accept | keep`: the working methods (see below).
- `routing off | suggest | strict`: the subagent routing level (default `suggest`). At `off` the subagent start hook
  does nothing at all: no request, no deny, no model change, nothing added to a subagent's prompt. At `suggest` each
  subagent gets routing advice, and one whose description does not start with a task type word still runs (the
  service's hint for it reaches the model once per session as an agent-services note). At `strict` the service
  refuses such a subagent. `routing on`, the 0.6.1 spelling, still works and says its new name, `routing suggest`.
- `autonomy [auto | ask | clear]`: the autonomy choice you gave the working methods' question ("Fully automatic" or
  "Check in with me as usual"), kept on this computer for your account and never sent; with it, the methods the
  plugin adds to a prompt end with one note saying which you chose. Bare `autonomy` shows it.
- `update`, `offline on | off`, `estimate [preview | send]`, `remove`, and `company [mail on | off]` for a company's
  admin.
- `info data` shows [DATA.md](plugins/agent-services/DATA.md): every request and when, what the service keeps, what
  a company admin sees, the local files, what can be turned off. `info log [<day>]` shows the request log's folder
  and last lines.
- `info hooks` lists every hook the plugin registers in Claude Code and what each may do (add context for
  the model, drop a pasted sign-in code, deny a tool call or a subagent, change a subagent's model, show a line).
  When it drops a pasted code, it says so; every deny carries its reason; a changed subagent model is said each time.
- `/agent-services remove` signs out, takes the agent-services section out of your CLAUDE.md, deletes the plugin's
  stored values (the sign-in credential included) and empties its files in `~/.agent-services` and in its data folder
  (Claude Code gives plugins no way to delete a file, so they are left empty), then prints the uninstall command
  `claude plugin uninstall agent-services@agent-plugin`. It leaves `~/.agent-services/REMOVED`, so other open
  sessions stop within a few seconds; a sign-in clears it. You type it: the setup tool the model can call cannot run
  it.

While signed out only `status`, `login`, `logout`, `update`, `info`, `remove`, `routing` and `methods off` work. The 0.5.0
spellings (`data`, `hooks`, `outbox`, `trust ...`, `savings preview | on | off | mail ...`, `dashboard ...`) still
work in this version and say their new name. The command answers by itself: no model reads the code or the answers.

The tools the model can call are `mcp__agent-services__router_advice`, `lesson_lookup`, `savings`,
`checkpoint_advice`, `status` and `setup` (it applies a choice you gave it, such as `routing off`, and only in the
main conversation of a session you are at),
plus `checkpoint` when no other plugin in the session has a tool by that name (see "Project helpers"). Earlier versions named them `mcp__plugin_agent-services_agent-services__<name>`;
permission rules you wrote for the old names do nothing now and can be removed from your settings by hand. The
plugin never writes your settings or permission rules.

## Setup questions

There are three, asked together, only when you run `/agent-services setup` (in Claude Code's own dialog). Claude is
never told to ask them. While one is open, the line above the prompt says so, for example `agent-services: 2 setup
choices open - /agent-services setup`; after you run the command (answered or not) that line comes back at most once
every 7 days, across all your sessions.

The savings record: whether to keep a record of what agent-services saves you (a private savings page on your
claude.ai account, a weekly email, and a small daily usage summary). It is kept for each account that signs in, so a
yes never carries over to another account. It has three answers: "Upload, including the past 30 days" (the first
upload also sends up to 30 earlier days), "Upload from now on only" (only the days after the day you chose) and
"Don't upload" (`sharing off`, never asked again). Nothing is uploaded before you answer; a question left
unanswered is asked again after 7 days. `/agent-services sharing preview` shows exactly what one upload sends.
Where your company's admin turned the savings record on, you are asked the same question, told that the admin
recommends it, and nothing of yours is uploaded until you answer; where the company turned it off, you are not asked.

The working methods (planning, delegating to subagents, testing, review, delivery, checkpoints) have one switch:

- `methods suggest` (the default): they come with your prompts as agent-services suggestions, in full once per
  session (again after `/clear`, a compaction, a phase change or a new served version, never on every prompt); the
  planning gate only reminds.
- `methods on`: they become your own instructions through one marked import line in your user-level CLAUDE.md, and
  the planning gate holds larger file edits until the project's `agent-state.md` has a plan (an edit of at most 10
  lines passes; Bash is never held). Before you choose it, Claude reads the data note, the hooks list and the full
  text (`/agent-services methods preview` shows it to you too) and tells you what they are. When the served text
  later changes, the approved text stays in use until you decide: `methods diff` shows the differences, `methods
  accept` takes them, `methods keep` keeps the old text.
- `methods off`: nothing of them reaches Claude and the planning gate does nothing (this works signed out too).

At `methods suggest`, when the served methods change version, a line and a toast tell you once (the new version applies
without an accept), and `methods diff` shows what changed.

The routing level: "Suggest (the default, recommended)" lets a subagent whose description does not start with a task
type word run unchanged, without routing savings; "Strict" refuses such a subagent until it is relabelled, so every
subagent is routed; "Not now" changes nothing and asks again after 7 days. `/agent-services routing` changes it later.

## What you see

Under the prompt, the plugin keeps one status line, refreshed when a session starts and after each turn:

```
agent-services · saved you $12.40 since Oct 30 · today: 5 jobs on a cheaper model
```

Above the prompt, in the terminal and in the desktop app, a band says the same in full:

```
agent-services saved you $3.10 in the last 7 days · today: 5 jobs on a cheaper model
```

The dollar figure comes from the service (from the daily usage summaries, see below) and is refreshed at most every
10 minutes. Today's counts are local. Both always show something: before the first full day of use they say the
plugin is on and that savings show from the next day; while the savings record is not on they show
`/agent-services sharing on`; when you are not signed in they show `/agent-services login`; they also say when your company paused the
plugin, when offline mode is on and when the server cannot be reached. They never show model names, token counts,
account details or file paths. When the project has open lines in `.agent/pending.md`, the status line ends with
their count ("2 decisions wait for you").

## Project helpers

These work on this computer and send nothing of their own; the ones that read a project file act only when that file
exists (the plugin never writes it).

- **Checkpoint tool.** The model calls `checkpoint` (milestone, keep, next) after a finished piece of work; once the
  reply ends the conversation is compacted, keeping what the model listed, and its next step comes back as a message
  from the plugin. If another plugin already offers a `checkpoint` tool, agent-services registers none and its notes name that one.
- **Test lock.** `.agent/test-lock.json` holds globs (`{"locked": ["tests/**"]}`); a subagent's Edit, Write,
  MultiEdit or NotebookEdit of a matching file is denied, the main conversation may still edit it. Bash is not
  checked.
- **Pending decisions.** `.agent/pending.md`, one `- [ ] ...` line per decision waiting for you; the working methods
  say when the model writes there, and the status line shows the open count.
- **Steps.** `.agent/steps.json` (`{"steps": [{"id": "a", "deps": [], "status": "todo"}]}`, status `todo`, `running`
  or `done`): when more steps are ready to start than the last turn dispatched subagents, the model gets a one-line
  note naming them.
- **Background reminder.** A foreground Bash, PowerShell or subagent call that ran longer than 60 seconds gets a
  one-line note suggesting a background run (at most 3 per session).
- **Subagent brief.** The routing service's speed-up suggestion is added to the end of each routed subagent's prompt,
  labelled as an agent-services suggestion; the model is told not to copy it there itself.

The notes and the brief suggestion stop while the working methods are switched off.

## See what you saved

```
/agent-services sharing preview
/agent-services setup
/agent-services savings
```

Savings are worked out by the service from a small daily usage summary. Nothing is uploaded until you choose to
upload (`setup` asks; `sharing preview` shows you exactly what one daily upload contains): "Upload, including the
past 30 days" (`sharing on_backfill`) also sends up to 30 earlier days with the first upload, "Upload from now on
only" (`sharing on_from_now`) sends only the days after the day you chose. A session left open uploads each new day once a day. After a day or
more has been uploaded, `savings` shows what the services saved so far; `sharing off` stops the uploads.
`estimate preview` shows the summary a one-time savings estimate would send, and `estimate send` sends exactly that,
once.

## What is sent, and where it is kept

- **To our service.** Every request goes to the service's built-in address encrypted end to end (X25519,
  AES-256-GCM) inside the TLS connection, and every answer must carry our server's Ed25519 signature; an answer that
  does not is never used, and the plugin pauses with a notice instead. A proxy or CDN in between sees no email, code,
  token or content. The only unencrypted request is a health check. What a request carries is minimized: a subagent
  dispatch sends the first word of its description (at most 32 characters) and its length, never the rest; a daily
  summary carries token counts, costs, task-type counts per hashed project and savings, never prompt text, file
  contents or paths. Every signed request also carries your account id, a device id and a hash of your Claude
  account id. The full list, and what the service keeps (its request log keeps keyed hashes of IP addresses for 90 days), is
  in [DATA.md](plugins/agent-services/DATA.md).
- **The request log.** Every request is written, before it is sent, to
  `~/.agent-services/services/outbox/<day>-<session>.jsonl` (secrets such as the code and the token redacted), with
  previews and each call the model made to the plugin's tools. `/agent-services info log` shows where it is and its
  last lines. Files older than 90 days are cleared.
- **The dashboard.** The plugin asks Claude Code's own Artifact tool to publish a dashboard page to your claude.ai
  account once, and again only when a new plugin version changes the page itself. After that, at most every 10
  minutes after a turn and only when they changed, it writes the page's figures to the page's own data with Claude
  Code's ArtifactData tool instead of publishing the page again, so the page is not meant to open by itself: open it
  yourself when you want to look, and it shows the latest figures. Apart from the update check (its
  `claude plugin` commands contact the plugin marketplace), that is the one thing that goes anywhere but our service. The page holds only numbers (savings, counts, plan, service on or off), never text from a session,
  a path or a host name. It is published only after you said yes to the private page (`sharing on`, or `sharing
  page on`; see Setup questions); the plugin then answers Claude Code's permission check for those calls of its
  own, its dashboard page and its figures, and for nothing else. It never writes your settings or permission rules.
  Without that yes nothing is published. Each attempt is logged in the request log.
- **Your sign-in.** The token and the device key are kept in Claude Code's plugin store, a plain file in your Claude
  Code configuration folder (`~/.claude/plugins/store/`), protected only by your user account's file permissions.
  Other plugins you install, and any program running as you, can read that file; a copy of it works as your sign-in
  until the next rotation or sign-out. `/agent-services logout` ends the sign-in on the server and deletes it here;
  `/agent-services remove` does that and clears the rest.

## Updating

The plugin never updates itself. When a newer version is listed, Claude tells you and asks; `/agent-services update`
runs the update (unless you turned on Claude Code's own auto-update for agent-plugin: Claude Code then updates it
without asking) (the changes are in this repository's stable branch history). `/agent-services status` shows the
last check in its Updates: line. Where Claude Code cannot run a command (a surface without it), the plugin runs
nothing and instead shows, at most once a week in the status line and always in `/agent-services status`, the one
terminal command that updates it:

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
