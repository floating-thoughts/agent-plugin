# agent-services: what it sends, keeps and does

This note ships with the plugin: `/agent-services info data` shows a short summary with the section names,
`/agent-services info data full` this whole note (the setup tool answers the same two words).
`/agent-services info hooks` lists the hooks the plugin registers (`info hooks full` with what each does), and
`/agent-services info log` shows the request log on this computer: each request as sent, with its answer (written to
disk every few seconds, so the last seconds before Claude Code stops can be missing).

## In short

- agent-services is a paid service and needs a sign-in. Signed out, or when the sign-in fails, the plugin sends
  nothing (except a sign-in you start), holds no edit, changes no subagent, gives the model no notes and loads only
  the setup and undo tools; only a sign-in hint shows; Claude Code works as usual.
- Signed in, it sends small, fixed-format requests: counts, flags, ids and hashes, never your prompts, code, file
  contents, paths or tool output. The service answers and then discards them. It keeps counts, ids, your account,
  the daily usage summaries (only after you turn them on) and IP addresses (hashed in its request log; in clear for
  about 15 minutes in its anti-abuse records).
- The company brain and ledger (encrypted lessons and an audit ledger shared within a company) are off unless your
  company set them up and you typed `/agent-services brain setup` here; then the service gets only encrypted
  objects, public keys and signed records; section 7 (`DATA-sealed.md` beside this note, shown after it by
  `info data full`) says what is sent, kept and seen.
- How the service makes its advice is a business secret; its answers come back in a fixed format (section 5), each
  copied into the request log here.

## 1. What is sent, and when

Every request goes to one fixed address built into the plugin, sealed end to end (X25519 and AES-256-GCM) inside the
TLS connection; every answer must carry the service's Ed25519 signature or it is not used. The network edge in front
of the service sees your IP address, the time and the size of each request, not its content. The plugin calls no
other address except this computer itself, once after an upgrade from an older version, and your own MCP servers'
URLs for the MCP server check (below). The service itself refuses an unsealed request only when it comes through its
network edge, the way the plugin's requests come.

**Every signed request** carries your account id, this device's id (`dev_` and 16 hex digits), a SHA-256 hash of
your Claude account id (read from `~/.claude.json`), a time stamp, a random nonce and a device signature.

**Signing in** (`/agent-services login`): your email address; then the one-time code, a hash of a new random token,
the device's public key, the device id, the Claude account hash, the harness (`claude-code`) and the terms version
you accepted. When many sign-ins were started from your network or overall, a browser check comes first; its
one-time token is sent with your email address again.

**Automatically, while signed in:**

| When | What is sent |
|---|---|
| Session start, and when the sign-in check is due | the plugin version and the contract version |
| 7 days before the sign-in expires | a hash of the next token |
| Once per signed-in session | the update channel (stable or beta) and a flag asking for the support address, to fetch the local engines' rule tables |
| Each subagent start (forks and teammates skipped; nothing at `routing off`) | the first word of the task description (at most 32 characters; the rest is never sent), its length, the subagent type, the requested model and effort, the harness, the dispatch number, a hashed project id (an HMAC of the project folder with a key kept only here, 16 hex digits), a random per-session id, the main session's model id, whether your latest message asked for a review; at `routing strict` also the flag strict and, only when yes, that your latest message contains the word override (decided here; the message is never sent); the models and efforts you allowed with `models set` and your `models use` pick, once chosen; only when they hold: plan_done (every plan step in the project's `agent-state.md` is checked done; read here, only the flag is sent), for a top-level final review, and prior_failures (the main conversation's subagents only: how often the same failure came back in this stretch, counted from a salted hash of the error lines kept in memory; no text is sent), to raise a check-type subagent's level |
| After each turn of the main agent | counters only: context use, turns, tool calls, finished todos, commits, minutes, the per-session id; except at methods level `off`, also that turn's non-zero counts (reads, searches, web calls, the longest read run, the largest result sizes, refused calls, the count of its most repeated failure, how many plan steps are ready to start together, subagents dispatched, the longest foreground call in seconds, which advice cases came earlier). No tool name, input, output, path or text |
| The first foreground Bash or PowerShell call with a given command head (main agent, not at methods level `off`), once per head and session | the per-session id and the program's name, only when it is on the plugin's public list of common developer commands; nothing else of the command |
| Session start, after `/clear` or a compaction, and when a project's `agent-state.md` turns `phase: running` (methods level `suggest`; at `on` once per phase at session start) | the per-session id, the role `auto`, the work phase, the version pinned, the channel and the flag `jit`, to fetch the working methods |
| A just-in-time moment of the main agent (a resumed session, a new module, the first edit of a UI file, delivery), once per moment and session, not at methods level `off` | the per-session id, the role, a phase, the version, the channel and the event name |
| The first prompt of a session (again after `/clear` or a compaction), and when the model calls the `toolbox` tool | the per-session id, the pack key and, for one pack, a topic name |
| When the model calls the `toolbox` tool with `files` true, for a pack whose answer says it has files | the per-session id, the pack key and the pack version, to download its files |
| A file change of the main agent, or a prompt at methods level `suggest`, when these facts differ from every set already asked this session | about the project's `agent-state.md` only: whether it exists, says `phase: running` and has a goal, how many plan steps it lists, and the methods level; never its text or path |
| Session start, and once a day, only after you chose to upload | the daily usage summary (below), one per day not uploaded yet, never from before your choice allows |
| When you change the upload choice, and once before an upload the service has not confirmed | your choice as a consent record: purpose `usage_upload`, yes or no |
| The band, the status line and your savings page refresh; a company admin's board (at most every 15 minutes) | nothing but the signed request |

The just-in-time event names are `resume`, `module_start`, `ui`, `index_request` or `delivery`; `index_request` comes only when the model calls the `lesson_lookup` tool with that event.

The **daily usage summary** holds: the day and the plugin version; per model, token counts and cost; per task type
(a word from a fixed list), model and hashed project, a count; session counts by kind and harness; the savings
figures (token counts, the main model next to each routed subagent's model, compaction and file-read sizes, random
compaction ids); optionally `overhead`: per model, the input tokens the plugin added to its routed runs that day, to
show savings net of its own cost; and the day's time figures (bytes you typed, seconds an agent was working, turns).
It holds no prompt text, file contents, file paths or session ids. `/agent-services sharing preview` shows exactly
what one upload sends.

**Only when you run a command:** `sharing refresh_time` (the past days' time figures again); the weekly-email and
company-email switches; and for a company admin `members`, `members add <email>` and `members remove <email>`, typed
by the admin and confirmed in the plugin's dialog (the member's email address and, for an add, the admin's
confirmation that the company told its staff). Asked what your admin sees, the setup tool's `company view` sends
only the signed request.

**Not our service:** the update check runs `claude plugin list --json` and
`claude plugin marketplace update agent-plugin` at most once an hour on this computer (a check that fails counts
too), which contact the plugin marketplace. Automatic updates, only if you turned them on, run
`claude plugin update` against the same marketplace at most once a day. Your savings page (a company admin's board)
is published to your own claude.ai account with Claude Code's Artifact and ArtifactData tools, only after you
allowed it. Mail (sign-in codes, weekly emails) is sent through an email delivery service.

**Your own MCP servers (the MCP server check):** about 20 seconds after a session starts, in the background (30
seconds at most), the plugin asks Claude Code the state of each MCP server in `~/.claude.json` (yours and the
project's entry) and the project root's `.mcp.json` (not a parent folder's), and checks only those reported as
waiting on a sign-in or failed: a remote (http) server gets one MCP `initialize` request at its configured URL only,
with its configured headers and those of its `headersHelper` command (run for at most 10 seconds); a local (stdio)
command is looked up (`where.exe` or `command -v`) and run with its configured arguments and environment for at most
5 seconds, sending one `initialize` on standard input (`.cmd` and `.bat` via `cmd /d /s /c`). Nothing goes to our
service. A server Claude Code has not approved, that an organization MCP policy blocks, or that it does not list or
report is never run; connected or turned-off servers, plugin servers and claude.ai connectors are never checked.
`/agent-services mcp check [<server>]` runs the same check on demand, listing skipped servers as "not run (not
approved in Claude Code)". Its output and the note to the model mask header and environment values, the helper's
header values, query parameters named like a secret (`key`, `token`, `access_token`, `sig` and the like) and
secret-looking stdio arguments (after a `--token` or `--api-key` style flag, `NAME_KEY=value` pairs, long random
tokens). The result (masked lines, failure count, names of servers seen connected) stays in the plugin store; a
failure becomes one note to the model on your next prompt.

## 2. What the service keeps, and for how long

| What | Kept | For how long |
|---|---|---|
| Request log: time, route, status, error code, account id, device id, a token hash prefix, keyed hashes of IP addresses, the rate limit hit (IP addresses taken out), whether the request was sealed, latency | yes | 90 days (also capped at about 20 MiB plus one older copy) |
| Mail log: time, kind of mail, the recipient's address masked, whether it was sent | yes | 90 days (about 5 MiB plus one older copy) |
| Your account: email, company, plan, status, role | yes | while the account exists; a deleted account is signed out at once and erased 7 days later |
| Account links (the sha256 of an earlier account id merged into yours, time, reason) | yes | while the kept account exists |
| Each sign-in: device id and public key, Claude account hash, harness, a token check value, plugin version, times | yes | while active, then 30 days |
| Sign-in code | a check value and the code encrypted with a server key | until used or replaced by the next code request |
| Sign-in IP addresses and lockout counts | keyed hashes only | from 1 hour to 30 days after use, deleted at the next sign-in activity after that (lockouts: 24 hours after the last count) |
| Anti-abuse records: failed signed requests and lockouts, per IP address (not hashed) and per account | yes | about 10 to 15 minutes |
| Daily usage summaries | as sent, one set per computer (a keyed hash of its install id) | 395 days; dropped once an account uploads nothing for 30 days |
| Subagent, checkpoint and run-limit requests | not kept; one count per day, account, route and outcome | while the account exists |
| Working-methods sessions and toolbox packs delivered | per-session id, role, device id, phase or pack key, item versions and ids, when; no text from you | 395 days |
| Weekly-email setting and sends; your methods channel | yes | while the account exists |
| Consent records (weekly email, company summary, savings record, terms, privacy policy, the business-use and 18+ declaration) | yes, with your account id, never your email | current answer while the account exists; older answers 3 years; after an erase kept under a random id |
| Audit log of administrative actions (random ids, no email or IP address), chained by hashes | yes | 3 years |
| Audit and alert records (sign-ins, sign-outs, rotations, setting changes, limits hit; a masked email at most; IP addresses and email hashes are taken out of alerts before they are stored) | yes | audit 13 months, alerts 90 days |
| Backups of the database (everything above except the logs) | encrypted daily copies on and off the server (once the operator has set up the backup key) | 14 days on it, about 30 days off it |

## 3. What a company admin sees about you

Your company's view is set by our operator: **totals only** (the company's weekly savings estimate, seats, settings,
and its totals of sessions, helper agent runs and AI usage at list prices; nothing per member) or **each member**
(also each member's email address, device count and weekly savings estimate, never ranked). The admin never sees
your token counts, costs, task types, project ids, times of use, IP addresses, prompts or code. The plugin tells you
which view applies, and when it changes. Ask Claude what your admin sees: the setup tool's `company view` shows your
own row exactly as the admin's board does.

`/agent-services company` and `members` are for the company admin only (the company board, the email switch, the member list); anyone else gets one line saying so and nothing is sent. The admin can add a member by email address within the paid seats and remove one (signed out everywhere; the account and its figures stay). The company can pause agent-services and set the savings record on or off for everyone; set on, nothing of yours is uploaded until you answer the upload question.

## 4. What stays on this computer

None of this is sent, except as listed in section 1.

| Where | What |
|---|---|
| Claude Code's plugin store (a JSON file under `~/.claude`) | the sign-in credential in plain text (token, next token during a rotation, device key; any program running as you can read it), account and device id, plan; your choices and switches (the savings record, setup done, the methods and routing levels, allowed models, the band's explanations, automatic updates, automatic methods approval with its last five approvals: time, version, text hashes, by whom; and a "Don't ask again" to either offer); the last copy of the two served reliability tables (deleted at sign-out); the key for the project hash; day and checkpoint counters, cached savings figures; session ids and times to tell a resumed or ended session; the alert gate; the key and last mac of the local refusal log; each choice is kept for each account that signed in here (an autonomy choice an earlier version kept is no longer read) |
| `~/.agent-services/services/device.json` | this computer's device id (not a sign-in on its own); a reinstall of the plugin keeps it |
| `~/.agent-services/services/outbox/<day>-<session>.jsonl` | the request log: each request as sent (codes, tokens and member emails blanked) and its answer, and each call the model made to this plugin's tools; 90 days, at most 2 MiB a file |
| `~/.agent-services/dashboard/`, `boss/`, `services/*.json` | your savings page (an admin's board) and its publish state; `plugin-update.json` (the update check and the automatic update's last try and failures; in the plugin's data folder if Claude Code gives one); `asked.json` (when a setup question was last asked); `time-days.json` (per-day usage figures) |
| `~/.agent-services/methods.md` and its sibling files | the working-methods text, the pending, last seen and previous texts, and up to five earlier approved texts (`methods.approved.1.md` to `.5.md`) |
| `~/.agent-services/kits/<key>/<version>/` | the files of a toolbox pack version, downloaded only when the model calls the `toolbox` tool with `files` true. Each file's path, size and SHA-256 is checked before writing; one failure stops the download. `<version>.complete.json`, written last, marks a finished folder; a saved version is never overwritten. The plugin never runs or installs these files; Claude runs a script only with its own tools, under your permissions. The request log keeps paths, sizes and SHA-256, not its content. `/agent-services remove` empties these files (plugins cannot delete files or folders); files more than three folders deep are not opened |
| `~/.claude/CLAUDE.md` | one marked line importing `methods.md`, only at `methods on` |
| `.agent/` in a project | written by the plugin: `task-state.json` and `.md` (tasks, side effects by key, placeholders, your open questions), `jobs.json` (background jobs: id, kind, first 120 characters of the description, status, times), `evidence.json` (test and build runs: program name, pass or fail, times, a hash of the command), `audit.jsonl` (one hashed line per refusal of the plugin's rules, no command or text), `handover.md`, and a `.gitignore` listing these files (only when `.agent/` has none). Appended only by the `task_state` tool: `lessons.md` (op `lesson`) and `pending.md` (op `ask` adds a line; op `answer` ticks it and adds the answer). Read only: `test-lock.json` and `steps.json`; for the `task_state` op `deliver` draft the plugin runs `git rev-parse`, `git cat-file -e`, `git diff --stat` and `git ls-files --others`. Nothing of it is sent |
| `agent-state.md` in a project | read: the plan (a line per step with its dependencies and optional `owns:` file globs) and the phase; written only by the `task_state` plan ops (`plan_goal` the goal, `plan_add` and `plan_set` one step line, `plan_run` the first line), every other line kept |
| `decisions.md` in a project (`notes.md` when only that exists) | one line appended each time Claude calls `task_state` op `decide`; never rewritten |
| `refs/agent-services/snap/<id>` in a project's git repository | working-tree snapshots taken when a prompt of yours starts (labelled in the undo list by the prompt's first 60 characters, secrets masked), before background subagents start and after turns that changed state; the newest 50 kept; never pushed by a normal branch push (a `git push --mirror` would send them) |
| `agent-reports/<session>/` in the plugin's data folder | a subagent report longer than the served cap, kept whole until you delete it |

**Your sign-in is stored unencrypted.** The plugin store is an ordinary file that is not encrypted: anyone using
your account on this computer, and any software under it, including other plugins you install, can read the token
and device key, and a copy works as your sign-in until the token is next replaced or you sign out. Keeping this
computer and what you install safe is your responsibility. `/agent-services logout` ends the sign-in on the service
and deletes the token, so a copy stops working; do that on a shared or retired computer, or if you think someone
read it. The device key stays until `/agent-services remove`.

The plugin also reads, and does not send: your Claude Code transcripts (to count tokens and time for the summary),
the plan fields of `~/.claude.json` (for the weekly usage line), the text of your messages (only for the words
review and override), and the marketplace list. The local engines' rule tables (command guard, secret masking,
subagent gates, shell watch, stuck-work watch) stay in memory for the session; without them those engines are off.
Secrets the masking finds stay in memory only, emptied at sign-out. When a tool call fails, the plugin matches the
masked error text against the project's `.agent/lessons.md` and the toolbox index it holds for the session and may
add one hint to that call's result; nothing is sent. Lessons there are graded `[E0]` (a guess) to `[E3]`
(confirmed). A `no-tools: <tool>, <tool>(<pattern>)` line in a subagent's brief is kept in memory, and that
subagent's calls of those tools are refused: a guard against slips, not a security boundary.

Masking does not change a tool's input. Where a served rule allows putting the real value back (off in Claude Code), it goes only into shell commands and file writes (Bash, PowerShell, Write, Edit, MultiEdit, NotebookEdit), never web, browser, MCP or subagent calls.

The planning gate holds file edits (Edit, Write, MultiEdit, NotebookEdit) only at `methods on`, and an Edit of at most the number of changed lines that verdict names passes. It does not cover Bash: a file written through Bash is never held.

The concurrency plan check (`concurrency.ts`, sends nothing) stops a main-conversation subagent dispatch (an Agent call, or a SendMessage adding work) once when no concurrency plan is written; sent again, it runs. "single use:" at the start of a description, prompt or message skips it. Asking for a report, status or summary, or to stop, adds no work; subagents' own dispatches are never checked.

Earlier versions (0.10.8, 0.10.9) could leave `telegram.json`, `telegram-state.json`, `telegram-lease.json`, `telegram-pushed.json` and `telegram-inbox.jsonl` in `~/.agent-services`; this version does not use them, and you can delete them.

## 5. What comes back

Every answer has a fixed shape: the sign-in check (accepted, plan, routes, your company's settings and view);
subagent routing (route, pass or deny, model and effort, reason code, hint, short rules, a routing line and, when
asked, the routing table as text); checkpoint timing and turn advice (short lines labelled
`agent-services suggestion`); run limits for a command head; the planning-gate verdict; the working methods and
just-in-time items (text, each checked against its SHA-256 and cleaned of invisible characters); toolbox packs;
savings, report and activity figures; the company summary for admins; the rule tables with the support address (only
for a signed-in account with an active license; held in memory, shown by `/agent-services`); and switches.
Served methods are plain text you can read and quote; the request log keeps each item's id and SHA-256 but not its text. At level `on`, served text that differs from the approved text waits in `methods.pending.md`; once per session the model is told to sum up the change for you and say that `/agent-services methods approve` takes it; until then the approved text stays in use. The plugin no longer asks or keeps an autonomy choice; one an earlier version kept is ignored, and fully automatic work is the default. Advice the service writes for one turn is not part of the approved methods text.

## 6. What you can turn off

| To stop | Run |
|---|---|
| everything sent to the service, and every local engine that needs the served tables | `/agent-services logout` |
| the savings record (its daily upload), the weekly email and the savings page | `/agent-services sharing off` (each part alone: `sharing page off`, `sharing mail off`) |
| the working methods, the just-in-time items, the turn advice and the planning gate | ask Claude to turn the working methods off (the setup tool's `methods off`) |
| subagent routing, the weekly usage line and the spawn-time gates | `/agent-services routing off` (back: `routing suggest`, the default, or `routing strict`) |
| automatic updates; automatic methods approval | `/agent-services update auto off`; `/agent-services methods auto off` (both off by default; only you turn them on) |
| the band's hover explanations | `/agent-services explain off` (back: `explain on`; nothing is sent either way) |
| everything on this computer | `/agent-services remove`, then `claude plugin uninstall agent-services@agent-plugin` |

`/agent-services remove` signs out, takes the agent-services line out of your CLAUDE.md, empties the session's
secret vault, deletes every value in the plugin store and empties every file in `~/.agent-services` and the plugin's
data folder (Claude Code gives plugins no way to delete a file). It leaves `~/.agent-services/REMOVED` so other open
sessions stop too. It does not delete your savings page on claude.ai or what the service keeps for your account.
Only you can run it; the setup tool cannot.
