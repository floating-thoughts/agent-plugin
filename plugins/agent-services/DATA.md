# agent-services: what it sends, keeps and does

This note ships with the plugin. `/agent-services info data` shows it, and so does the setup tool's `info data`
command. The setup tool changes a choice (`sharing on`, `methods on` and the like) only in the main conversation of a
session you are at, to apply your answer; elsewhere it refuses and changes nothing.
`/agent-services info hooks` lists every hook the plugin registers. `/agent-services info log` shows the request log on
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
| Every subagent start (forks and teammates are skipped; nothing while `routing off`) | the first word of the task description (whitespace-separated, at most 32 characters; the rest of the description is never sent), its length in characters, the subagent type (at most 64 characters), the requested model and effort, the harness, the dispatch number in this session, a hashed project id (an HMAC of the project folder with a key kept only on this computer, 16 hex digits), a random per-session id, the main session's model id (so the subagent never runs on a larger model), and yes or no for whether your latest message asked for a review (decided on this computer; your message is never sent) |
| After every turn of the main agent | counters only: context use in percent, turns, tool calls, finished todos, commits, minutes, and the per-session id |
| Session start, the first prompt after a project's `agent-state.md` says `phase: running`, and after `/clear` or a compaction, only at methods level `suggest` (the default) | the per-session id, the role `auto`, the work phase, the version pinned, the channel (to fetch the working methods) |
| Session start, only at methods level `on` (your CLAUDE.md has the agent-services section) | the same, once for each of the six phases |
| Session start, and once a day in a session left open, only while the savings record is on for the account signed in | the daily usage summary, one per active day not uploaded yet, never a day more than 30 days before the yes (so the first upload also sends up to 30 earlier days); after a switch to another account on this computer, nothing from before that account's yes |
| The band, the status line and your savings page refresh | nothing (asks for your savings and report lines) |
| After a turn, for a company admin only | nothing (asks for the company summary, at most every 30 minutes) |

The **daily usage summary** holds: the day and the plugin version; per model, input, output and cache token counts
and the cost; per task type (the plugin sends a word from a fixed list, or `other`; the service itself accepts any
short word), model and hashed project, a count; session counts
by kind and harness; and the savings figures (token counts, compaction sizes, file-read sizes, random ids for
compactions). It holds no prompt text, file contents, file paths or session ids. `/agent-services sharing preview`
shows exactly what one upload sends.

**Only when you run a command:** the weekly-email switch (`sharing mail on|off`, `sharing on|off|not_now`); the
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
| Working-methods sessions | per-session id, role, device id, phase, the item versions delivered and when; no text from you | 395 days |
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

The company can also pause agent-services for everyone, and can set the daily upload on or off for everyone. Set
on, your daily upload is turned on without asking you, and only the admin can turn it off; your private savings
page stays your own choice (`/agent-services sharing page on|off`), for an admin too. Where the company lets each
person decide, `/agent-services sharing off` stops your upload (the admin then sees "no data yet" for you). Your
email address and device count stay visible to the admin while you are a member.

## 4. Files on this computer

| Where | What |
|---|---|
| Claude Code's plugin store, a JSON file in your Claude Code folder (`~/.claude`) | the sign-in credential in plain text (the token, the next token during a rotation, the device key), plus account id, device id, plan, your choices (the savings record, kept for each account that signed in here, and the methods level) and switches, a local key for the project hash, and day counters. Any other plugin and any program running as you can read it; a copy works as your sign-in until the next rotation or sign-out. |
| `~/.agent-services/services/outbox/<day>-<session>.jsonl` | the request log: every request as sent (secrets such as the code and the token blanked) and its answer, previews, every call the model made to this plugin's tools with its full arguments (for one, a whole subagent description given to `router_advice`), and savings-page publish attempts. Kept 90 days, at most 2 MiB a file. |
| `~/.agent-services/dashboard/`, `~/.agent-services/boss/`, `~/.agent-services/services/*.json` | your savings page (a company admin's board, with member emails) and their publish state |
| `~/.agent-services/methods.md`, `methods.approved.md`, `methods.pending.md` | the working-methods text |
| `~/.agent-services/services/asked.json` | when a setup question was last asked, by any session (an unanswered question waits 7 days) |
| `plugin-update.json` (in Claude Code's data folder for this plugin, else `~/.agent-services/services/`) | the update check's state |
| `~/.agent-services/MIGRATED` | what the one-time move from an older version did |
| `~/.agent-services/REMOVED` | left by `/agent-services remove`; while it holds text, the plugin does nothing in any session; a sign-in empties it |
| `~/.claude/CLAUDE.md` | one marked section importing `~/.agent-services/methods.md`, only after you chose `methods on` |
| `.agent/test-lock.json`, `.agent/pending.md`, `.agent/steps.json` in a project | read only, never written or sent by the plugin; you or the model write them (see "Local helpers" below) |

`~/.agent-services` is `AGENT_SVC_DATA_DIR` when that is set. The plugin reads, and does not send: your Claude
account id (only its hash leaves), your Claude Code transcripts (to count tokens for the summary and the estimate),
files read in parts (to count their size), a project's `agent-state.md` and the three `.agent/` files above, the
text of your messages (only to see whether one asks for a review), and the marketplace list.

**Local helpers** (they send nothing of their own):

- The checkpoint tool (`checkpoint`: milestone, keep, next), registered only when no other plugin in the session has a
  tool named `checkpoint`. After the reply in which the model called it, the plugin compacts the conversation keeping
  what the model listed, then sends the model's next step back as a message from this plugin (not after an
  interrupted turn, and not once you wrote a message yourself). A short conversation is not compacted.
- The test lock: a subagent's Edit, Write, MultiEdit or NotebookEdit of a file matching a glob in
  `.agent/test-lock.json` (`{"locked": ["tests/**"]}`) is denied; the main conversation may edit those files. Changes
  made through Bash or other tools are not checked.
- The status line shows how many `- [ ]` lines `.agent/pending.md` has (decisions waiting for you).
- Notes for the model at the next prompt, labelled as agent-services notes: when a foreground Bash, PowerShell or
  subagent call of the main conversation ran longer than 60 seconds (at most 3 per session), and when
  `.agent/steps.json` lists more steps ready to start than the last turn dispatched subagents.
- The speed-up suggestion the routing service sends is added once to the end of each routed subagent's prompt.
- The suggestion and the notes stop while the working methods are switched off; the suggestion also stops while
  subagent routing is off (`/agent-services routing off`).

## 5. What comes back

Every answer has a fixed shape:

- Sign-in check: accepted, the plan, the routes open to you, and for a company account the company's savings
  setting (and whether you are its admin).
- Subagent routing: route, pass or deny; a model and effort or none; a reason code; a hint and two short rules
  (text, at most 2,000 characters each). A deny gives the hint and rules to the model as the reason; a route or pass
  adds the speed-up rule to the subagent's prompt. For a main session on a Haiku, Sonnet or Opus model the routed
  model is never a larger one of these (another main model sets no cap, and neither does a plugin older than
  0.6.0), and the configuration for a deep review comes only when your latest message asked for a review.
- Checkpoint timing: now or not, and short lines to keep in a summary (at most 300 characters each), given to the
  model at the next prompt.
- Working methods: a version and items of text (at most 20,000 characters each, each checked against its SHA-256),
  given to the model with a prompt (level `suggest`) or written to `methods.md` (level `on`). Served methods are
  plain text you can read and quote. As a safeguard the plugin also strips any invisible characters (zero-width,
  direction-control, variation-selector and tag characters) from served text before the model sees it or
  `methods.md` holds it. The request log keeps each item's id and SHA-256 but not its text.
  When the model calls the `lesson_lookup` tool, at level `suggest` it gets the text served now; at `on` it is
  pointed to the approved text your CLAUDE.md loads; at `off` it gets no items.
- Savings and report: dollar and token figures by day, and short report lines (at most 300 characters each) for the
  band and the savings page.
- Company summary (admins): the table of section 3.
- Estimate: dollar and hour ranges for each kind of saving.
- Switches: on or off.

## 6. What you can turn off

| To stop | Run |
|---|---|
| everything sent to the service | `/agent-services offline on` (back: `offline off`), or `/agent-services logout` |
| the daily upload, the weekly email and the savings page | `/agent-services sharing off` (never asked again; `sharing not_now` asks again in 7 days; each part alone: `sharing page off`, `sharing mail off`) |
| the working methods and the planning gate | `/agent-services methods off` (works signed out too; `methods suggest` keeps them as suggestions without the CLAUDE.md line) |
| subagent routing (the routing request, its deny or model change, and the suggestion added to subagent prompts) | `/agent-services routing off` (back: `routing on`; works signed out too) |
| everything on this computer | `/agent-services remove`, then `claude plugin uninstall agent-services@agent-plugin` |

Checkpoint timing has no switch of its own: it stops when you sign out or uninstall, and offline mode stops it;
those stop subagent routing too. The planning gate follows the methods level: only at `methods on` does it hold file edits
(Edit, Write, MultiEdit, NotebookEdit) until a project's `agent-state.md` has a plan, and an Edit of at most 10
changed lines passes (so do writes to `agent-state.md` and to files under `.agent/`); at `suggest` it holds nothing and adds one reminder to the next prompt; at `off`, in a session
nobody can be asked in (such as `claude -p`) and for subagents it does nothing. It does not cover Bash: a file
written through a Bash command is never held. Where your company set the daily upload for everyone, only its admin
can change it.

The plugin asks its setup questions (the savings record and the methods level) together, only in the dialog of
`/agent-services setup` (or right after a sign-in through that dialog); the model is never told to ask them. While
one is open, the line above the prompt says how many and names `/agent-services setup`; after the command ran,
answered or not, that line comes back at most once every 7 days across all sessions. `/agent-services status` only
says how many wait.

`/agent-services remove` signs out (the service ends the sign-in), takes the agent-services section out of your
CLAUDE.md (with the same checks as `methods off`), deletes every value in the plugin store (the sign-in credential
included), and empties every file in `~/.agent-services` and in the plugin's data folder. Claude Code gives plugins
no way to delete a file, so the files are left empty and you can delete the folders yourself. It leaves one file,
`~/.agent-services/REMOVED`: other open Claude Code sessions see it within a few seconds and stop too (close them
before you uninstall). It does not delete your private savings page on claude.ai or what the service keeps for your
account. The setup tool the model can call cannot run it; you type it. It then prints the uninstall command.
