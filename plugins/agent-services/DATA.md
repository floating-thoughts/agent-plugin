# agent-services: what it sends, keeps and does

This note ships with the plugin. `/agent-services data` shows it, and so does the setup tool's `data` command.
`/agent-services hooks` lists every hook the plugin registers. `/agent-services outbox` shows the request log on
this computer: each request is recorded there as it is sent, with the answer that came back. The log is written to
disk every few seconds, so a request made in the last seconds before Claude Code stops can be missing from it.

## In short

- agent-services is a paid service, so it needs a sign-in. Signed out, or when the sign-in fails, the plugin does
  nothing: it sends nothing to the service (except a sign-in you start), holds no edit, changes no subagent and gives the model no notes. Claude
  Code works as usual. Only a sign-in hint shows in the status line and above the prompt.
- Signed in, it sends small, fixed-format requests. The service does not keep your work: what it receives is used to
  answer and then discarded. It does keep counts, ids, the daily usage summaries (only once you turn them on), your
  account, and IP addresses (in its request log, and for about 15 minutes in its anti-abuse records). The details
  are below.
- How the service processes what it receives and how its advice is made is a business secret and is not published.
  Its answers come back in a fixed format, listed below. You and the model see each answer where it is used, and
  the request log on this computer keeps a copy.

## 1. What each request sends, and when

Every request goes to one fixed service address built into the plugin. Except for a plain health check, every
request the plugin sends is sealed end to end (X25519 and AES-256-GCM) inside the TLS connection. (The service
itself refuses an unsealed request only when it comes through its network edge, which is the way the plugin's
requests come.) Every answer must carry the
service's Ed25519 signature; an answer without one is not used. The network edge in front of the service sees
your IP address, the time and the size of each request, but not its content.

**Every signed request** carries your account id, this device's id (`dev_` and 16 hex digits), a SHA-256 hash of
your Claude account id (read from `~/.claude.json`), a time stamp, a random nonce and a device signature.

**Signing in** (`/agent-services login`): your email address. Then the one-time code, a hash of a new random token,
the device's public key, the device id, the Claude account hash, and the harness (`claude-code`).

**Automatically, while you are signed in:**

| When | What is sent |
|---|---|
| Each session start, and when the sign-in check is due | the plugin version and the contract version |
| 7 days before the sign-in expires | a hash of the next token |
| Every subagent start (forks and teammates are skipped) | the first word of the task description (whitespace-separated, at most 32 characters; the rest of the description is never sent), its length in characters, the subagent type (at most 64 characters), the requested model and effort, the harness, the dispatch number in this session, a hashed project id (an HMAC of the project folder with a key kept only on this computer, 16 hex digits), and a random per-session id |
| After every turn of the main agent | counters only: context use in percent, turns, tool calls, finished todos, commits, minutes, and the per-session id |
| Session start, the first prompt after a project's `agent-state.md` says `phase: running`, and after `/clear` or a compaction | the per-session id, the role `auto`, the work phase, the version pinned, the channel (to fetch the working methods) |
| Session start, while your CLAUDE.md has the agent-services section | the same, once for each of the six phases |
| Session start, only after you turned the savings record on | the daily usage summary, one per active day not uploaded yet, never a day more than 30 days before you said yes (so the first upload also sends up to 30 earlier days) |
| The band, the status line and your savings page refresh | nothing (asks for your savings and report lines) |
| After a turn, for a company admin only | nothing (asks for the company summary, at most every 30 minutes) |

The **daily usage summary** holds: the day and the plugin version; per model, input, output and cache token counts
and the cost; per task type (the plugin sends a word from a fixed list, or `other`; the service itself accepts any
short word), model and hashed project, a count; session counts
by kind and harness; and the savings figures (token counts, compaction sizes, file-read sizes, random ids for
compactions). It holds no prompt text, file contents, file paths or session ids. `/agent-services savings preview`
shows exactly what one upload sends.

**Only when you run a command:** the weekly-email switch (`savings mail on|off`, `sharing on|not_now`); the
company-email switch (company admins); and the one-time savings estimate (`estimate send`, only exactly what
`estimate preview` showed you: token and cost totals per model, dispatch counts per task type from a fixed list,
compaction counts and a session-length histogram).

**Not our service:** the update check runs `claude plugin list --json` and `claude plugin marketplace update
agent-plugin` at most once an hour on this computer (a check that fails counts too), which contact the plugin
marketplace, not our service. It never updates the plugin; `/agent-services update` does, when you choose. If you
turn on Claude Code's own auto-update for agent-plugin, Claude Code updates the plugin by itself, without asking you;
the model then gets no note about new versions. Your private savings page is published to your own
claude.ai account with Claude Code's Artifact tool, only after you allowed it. A company admin's board (member
emails and savings) goes to the admin's own claude.ai account the same way.

## 2. What the service keeps, and for how long

| What | Kept | For how long |
|---|---|---|
| Request log: time, route, status, error code (for a failed sign-in, the reason), account id, device id, a token hash prefix, IP addresses (the connecting address and your address as the network edge reports it), the rate limit hit (IP addresses taken out), whether the request was sealed, latency | yes | no time limit: the log is capped only by size (about 20 MiB, plus one older copy), so how long a line stays depends on traffic |
| Mail log: time, kind of mail, the recipient's address masked, whether it was sent | yes | no time limit: capped by size (about 5 MiB, plus one older copy) |
| Your account: email, company, plan, status, role | yes | while the account exists (deleting an account only marks it deleted) |
| Each sign-in: device id, device public key, Claude account hash, harness, a token check value, plugin version, times | yes | while the account exists (ended sign-ins are kept) |
| Sign-in code | a check value, and the code encrypted with a server key (so the same code can be mailed again) | deleted when used; an unused or expired code stays until the next code request for that account replaces it |
| Sign-in IP addresses | as keyed hashes only, for rate limits and known-address checks | from 1 hour to 30 days after use, deleted at the next sign-in activity after that (known addresses: at that account's next successful sign-in), so a row can stay longer |
| Anti-abuse records: failed signed requests and lockouts, per IP address (not hashed) and per account | yes | about 10 to 15 minutes, deleted at the next failed request after that |
| Daily usage summaries | the whole summary as sent | 395 days; all of an account's days are dropped once it uploads nothing for 30 days |
| Subagent and checkpoint requests | the request is not kept; one count per day, account, route and outcome | while the account exists |
| Working-methods sessions | per-session id, role, device id, phase, the item versions delivered and when, and the service's own marks to trace a leaked copy (a watermark and fingerprints); no text from you | 395 days |
| The working-methods channel you fetch (stable or beta) | one row per account | while the account exists |
| The one-time estimate | not kept; one count per account per day | 30 days |
| Weekly-email setting and sends | yes | while the account exists |
| Audit and alert records (sign-ins, sign-outs, rotations, setting changes, limits hit; they can name account, device and session ids and a masked email address; IP addresses and email hashes are taken out of alerts before they are stored) | yes | the newest 100,000 audit and 50,000 alert records |
| Backups of the database (everything above except the request and mail logs) | daily copies on the server itself, not encrypted and readable only by its administrator; encrypted copies off the server | 14 days on the server and up to about 30 days off it, so deleted data can survive that long in a backup |

Mail (sign-in codes, the weekly savings email, a company's weekly summary to its admin) is sent through an email
delivery service.

## 3. What a company admin sees about each member

If your account belongs to a company account, its admin sees, in the admin's private board and weekly email: each
member's email address, how many devices each member is signed in on, and each member's weekly savings figure ("no
data yet" while a member uploads nothing), plus the company totals, the seats, and the company's settings. The admin
does not see token counts, costs, task types, project ids, session counts, times of use, IP addresses, prompts or
code.

The company can also pause agent-services for everyone, and can set the savings record on or off for everyone. Set
on, your daily upload and your private savings page are turned on without asking you, and only the admin can turn
them off. Where the company lets each person decide, `/agent-services sharing not_now` stops your upload (the admin
then sees "no data yet" for you). Your email address and device count stay visible to the admin while you are a
member.

## 4. Files on this computer

| Where | What |
|---|---|
| Claude Code's plugin store, a JSON file in your Claude Code folder (`~/.claude`) | the sign-in credential in plain text (the token, the next token during a rotation, the device key), plus account id, device id, plan, your choices and switches, a local key for the project hash, and day counters. Any other plugin and any program running as you can read it; a copy works as your sign-in until the next rotation or sign-out. |
| `~/.agent-services/services/outbox/<day>-<session>.jsonl` | the request log: every request as sent (secrets such as the code and the token blanked) and its answer, previews, every call the model made to this plugin's tools with its full arguments (for one, a whole subagent description given to `router_advice`), and savings-page publish attempts. Kept 90 days, at most 2 MiB a file. |
| `~/.agent-services/dashboard/`, `~/.agent-services/boss/`, `~/.agent-services/services/*.json` | your savings page (a company admin's board, with member emails) and their publish state |
| `~/.agent-services/methods.md`, `methods.approved.md`, `methods.pending.md` | the working-methods text |
| `plugin-update.json` (in Claude Code's data folder for this plugin, else `~/.agent-services/services/`) | the update check's state |
| `~/.agent-services/MIGRATED` | what the one-time move from an older version did |
| `~/.agent-services/REMOVED` | left by `/agent-services remove`; while it holds text, the plugin does nothing in any session; a sign-in empties it |
| `~/.claude/CLAUDE.md` | one marked section importing `~/.agent-services/methods.md`, only after you said yes (`trust on`) |

`~/.agent-services` is `AGENT_SVC_DATA_DIR` when that is set. The plugin reads, and does not send: your Claude
account id (only its hash leaves), your Claude Code transcripts (to count tokens for the summary and the estimate),
files read in parts (to count their size), a project's `agent-state.md`, and the marketplace list.

## 5. What comes back

Every answer has a fixed shape:

- Sign-in check: accepted, the plan, the routes open to you, and for a company account the company's savings
  setting (and whether you are its admin).
- Subagent routing: route, pass or deny; a model and effort or none; a reason code; a hint and two short rules
  (text, at most 2,000 characters each). A deny gives the hint and rules to the model as the reason.
- Checkpoint timing: now or not, and short lines to keep in a summary (at most 300 characters each), given to the
  model at the next prompt.
- Working methods: a version and items of text (at most 20,000 characters each, each checked against its SHA-256),
  given to the model with a prompt or written to `methods.md`. When the model calls the `lesson_lookup` tool, it
  gets the text served now, even while you keep an older approved text in `methods.md`.
- Savings and report: dollar and token figures by day, and short report lines (at most 300 characters each) for the
  band and the savings page.
- Company summary (admins): the table of section 3.
- Estimate: dollar and hour ranges for each kind of saving.
- Switches: on or off.

## 6. What you can turn off

| To stop | Run |
|---|---|
| everything sent to the service | `/agent-services offline on` (back: `offline off`), or `/agent-services logout` |
| the daily upload, the weekly email and the savings page | `/agent-services sharing not_now` (each part alone: `savings off`, `savings mail off`, `dashboard not_now`) |
| the working methods in your CLAUDE.md | `/agent-services trust off` |
| everything on this computer | `/agent-services remove`, then `claude plugin uninstall agent-services@agent-plugin` |

Subagent routing, checkpoint timing and the planning gate have no switch of their own: they stop when you sign out
or uninstall (offline mode stops the routing and the timing, not the planning gate). Where your company set the
savings record for everyone, only its admin can change it.

`/agent-services remove` signs out (the service ends the sign-in), takes the agent-services section out of your
CLAUDE.md (with the same checks as `trust off`), deletes every value in the plugin store (the sign-in credential
included), and empties every file in `~/.agent-services` and in the plugin's data folder. Claude Code gives plugins
no way to delete a file, so the files are left empty and you can delete the folders yourself. It leaves one file,
`~/.agent-services/REMOVED`: other open Claude Code sessions see it within a few seconds and stop too (close them
before you uninstall). It does not delete your private savings page on claude.ai or what the service keeps for your
account. The setup tool the model can call cannot run it; you type it. It then prints the uninstall command.
