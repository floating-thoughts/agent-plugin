# agent-services: what it sends, keeps and does

This note ships with the plugin. `/agent-services info data` shows it, and so does the setup tool's `info data`
command. The setup tool changes a choice (`sharing off`, `methods on` and the like) only in the main conversation of a
session you are at, to apply your answer; elsewhere it refuses and changes nothing. It can never turn the savings
upload on: only you do, in the dialog of `/agent-services setup` or by typing `/agent-services sharing
on_backfill|on_from_now` (`/agent-services sharing on` asks you the same three-option question).
`/agent-services info hooks` lists every hook the plugin registers. `/agent-services info log` shows the request log on
this computer: each request is recorded there as it is sent, with the answer that came back. The log is written to
disk every few seconds, so a request made in the last seconds before Claude Code stops can be missing from it.

## In short

- agent-services is a paid service, so it needs a sign-in. Signed out, or when the sign-in fails, the plugin does
  nothing: it sends nothing to the service (except a sign-in you start), holds no edit, changes no subagent and gives the model no notes. Claude
  Code works as usual. Only a sign-in hint shows in the status line and above the prompt.
- Signed in, it sends small, fixed-format requests. The service does not keep your work: what it receives is used to
  answer and then discarded. It does keep counts, ids, the daily usage summaries (only once you turn them on), your
  account, and IP addresses (in its request log only as keyed hashes, and in clear for about 15 minutes in its
  anti-abuse records). The details
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
the device's public key, the device id, the Claude account hash, and the harness (`claude-code`). Only when many
sign-ins were started from your network or overall, the service first asks for a browser check: the plugin shows a
link to a page on the service that loads the network provider's bot check (its script runs in your browser, not in
Claude Code); once you passed it, the plugin sends the check's one-time token with your email address again.

**Automatically, while you are signed in:**

| When | What is sent |
|---|---|
| Each session start, and when the sign-in check is due | the plugin version and the contract version |
| 7 days before the sign-in expires | a hash of the next token |
| Every subagent start (forks and teammates are skipped; nothing while `routing off`) | at `routing strict` only, the flag strict (so the service refuses a subagent whose description does not start with a task type word); the first word of the task description (whitespace-separated, at most 32 characters; the rest of the description is never sent), its length in characters, the subagent type (at most 64 characters), the requested model and effort, the harness, the dispatch number in this session, a hashed project id (an HMAC of the project folder with a key kept only on this computer, 16 hex digits), a random per-session id, the main session's model id (so the subagent never runs on a larger model), and yes or no for whether your latest message asked for a review (decided on this computer; your message is never sent) |
| After every turn of the main agent | counters only: context use in percent and in tokens, turns, tool calls, finished todos, commits, minutes, and the per-session id. Except at methods level `off`, also the counts of that one turn that are not zero (for the turn advice): Read calls, Grep and Glob calls, web calls (WebFetch, WebSearch), the longest run of Read, Grep or Glob calls without an edit in between, the largest Bash or PowerShell result and the largest Read result in thousands of characters, refused tool calls, how often the most repeated failure of the turn has happened in this session (the last error lines of a failed call's result are compared on this computer as a salted hash kept in memory only; neither the lines nor the hash are sent), how many steps in `.agent/steps.json` are ready to start (only when that list changed; the step ids are not sent), subagents dispatched, the longest foreground Bash, PowerShell or subagent call in seconds, and which advice cases the service sent earlier in this session, how many turns ago and how often. No tool name, input, output, path or text is sent; a turn with nothing to count sends none of these |
| The first foreground Bash or PowerShell call of the main agent with a given command head (except at methods level `off`; not a subagent's call, not one run in the background), at most once per head in a session | the per-session id and the command head: the program's name only (path and extension removed; for `python -m <module>` the module), and only when it is on the public list of common developer commands in the plugin (records.ts KNOWN_HEADS); any other command sends nothing. The arguments, the rest of the command line, paths, the project and run durations are not sent (the project id and the durations go as empty). The plugin waits at most 1 second for the answer; without one it goes on as if none came |
| Session start (also a resumed session), the first prompt after a project's `agent-state.md` changes between planning and `phase: running`, and after `/clear` or a compaction, only at methods level `suggest` (the default) | the per-session id, the role `auto`, the work phase, the version pinned, the channel and the flag `jit` (this plugin takes the just-in-time items separately, see below) (to fetch the working methods; the full text goes to the model once per session and again only after `/clear`, a compaction, a phase change or a new served version) |
| Session start, only at methods level `on` (your CLAUDE.md has the agent-services section) | the same, once for each of the six phases |
| A just-in-time moment of the main agent, while signed in and not at methods level `off` (never for a subagent), at most once per moment in a session: a resumed session (its id was seen at an earlier session start on this computer); a new module (the project's `agent-state.md`, read at a prompt or just before and after the main agent writes it, turns `phase: running` or lists more plan steps than at the reading before); the first edit of a UI file (`.html`, `.htm`, `.css`, `.scss`, `.sass`, `.less`, `.jsx`, `.tsx`, `.vue`, `.svelte`); delivery (every plan step in `agent-state.md` is checked done, `- [x]`). Also when the model calls the `lesson_lookup` tool with an event | the per-session id, the role `auto`, a work phase, the version pinned, the channel and the event name (`resume`, `module_start`, `ui`, `index_request` or `delivery`). No text, file name, path or project is sent; the plugin waits at most 1 second for the answer and otherwise gives it later or not at all |
| A file change (Edit, Write, MultiEdit, NotebookEdit) of the main agent inside the project (not in a session nobody can be asked in, such as `claude -p`), and a prompt of the main agent at methods level `suggest`, while signed in and not at methods level `off` (never for a subagent; a change to `agent-state.md` or to files under `.agent/` sends nothing): only when the facts below differ from every set already asked in this session, so at most once per set of facts; after a failed request that set is asked again a minute later at the earliest, and after the service refused the field (an older service) never again in the session | the per-session id, the role `auto`, the phase `plan`, the version pinned, the channel, and about the project's `agent-state.md` only: whether it exists, whether its first line says `phase: running`, whether a goal is written (yes or no), how many plan steps it lists (a number, at most 1000), and the methods level (`on` or `suggest`). The file's text, its path and the project are not sent. The answer is the planning-gate verdict (section 5) and carries no working-methods text |
| Session start, and once a day in a session left open, only after you chose to upload for the account signed in | the daily usage summary, one per active day not uploaded yet. With "Upload, including the past 30 days" never a day more than 30 days before your choice (so the first upload also sends up to 30 earlier days); with "Upload from now on only" only the days after the day of your choice; after a switch to another account on this computer, nothing from before that account's choice |
| When you change the upload choice (`sharing on_backfill`, `sharing on_from_now` or `sharing off`, or the same answers in `/agent-services setup`; `sharing not_now` sends nothing), and once before an upload when the service has not confirmed your yes yet (for example a yes given before version 0.7.9) | your sharing choice, recorded on the service as a consent record: the purpose `usage_upload` and yes (granted) or no (withdrawn). The service refuses daily summaries from this plugin version on unless your newest record there is a yes, and from any version once it is a no. If recording a yes fails, nothing is uploaded that day and it is tried again at the next upload; a no the service did not confirm is sent again at the next session start |
| The band, the status line and your savings page refresh | nothing (asks for your savings and report lines) |
| After a turn, for a company admin only | nothing (asks for the company summary, at most every 15 minutes) |

The **daily usage summary** holds: the day and the plugin version; per model, input, output and cache token counts
and the cost; per task type (the plugin sends a word from a fixed list, or `other`; the service itself accepts any
short word), model and hashed project, a count; session counts
by kind and harness; the savings figures (token counts, compaction sizes, file-read sizes, random ids for
compactions); and the day's time figures, numbers only: how many bytes you typed in your own prompts, the seconds
when at least one agent was working on this computer, the same seconds added up over every session and subagent,
and the number of turns. It holds no prompt text, file contents, file paths or session ids. `/agent-services sharing preview`
shows exactly what one upload sends.

**Only when you run a command:** `sharing refresh_time` sends each past day's time figures again (the same daily
summary, marked as a time-only refresh: the service changes only the time figures of a day it already holds, and
stores nothing for a day it does not); the weekly-email switch (`sharing mail on|off`, `sharing on_backfill|on_from_now|off|not_now`); the
company-email switch (company admins); `company` for a member of a company account who is not its admin (nothing but the signed request: the service answers only your own row of the admin's board, the week and the company settings that apply to you, and stores nothing new); and the one-time savings estimate (`estimate send`, only exactly what
`estimate preview` showed you: token and cost totals per model, dispatch counts per task type from a fixed list,
compaction counts and a session-length histogram).

**Not our service:** the update check runs `claude plugin list --json` and `claude plugin marketplace update
agent-plugin` at most once an hour on this computer (a check that fails counts too), which contact the plugin
marketplace, not our service. It never updates the plugin; `/agent-services update` does, when you choose. If you
turn on Claude Code's own auto-update for agent-plugin, Claude Code updates the plugin by itself, without asking you;
the model then gets no note about new versions. Your private savings page is published to your own
claude.ai account with Claude Code's Artifact tool, only after you allowed it. A company admin's board (member
emails, savings and device counts, or only the company totals) goes to the admin's own claude.ai account the same way. Each board page is published once (and
again only when a new plugin version changes how the page looks; a board published by an earlier plugin version is
published once more to turn it into this kind of page). The page declares the artifact's own database (only you, its
owner, can write to it). After that, an update does not publish the page: the plugin writes the figures the page
shows, and nothing else, to one document of that database (`board/figures`) with Claude Code's ArtifactData tool, and
the page reads them from there when you open it. Where that tool is missing, the page is published again as before.

**Rule tables, once per signed-in session:** the plugin asks for the rule tables it runs on this computer (command
guard, secret masking, row trimming after a compaction, subagent gates and long reports, shell watch). The request
sends only the update channel (stable or beta); no command, prompt, tool input or output, file path or report text is
ever sent for these engines. The tables are kept in memory for that session only (never written to a file, the store or
a log), and stay until the session ends even if the service becomes unreachable. Without them (signed out, offline,
locked) every one of these engines is off; the band, the status line and one line at session start say so.
The same tables also carry the parameters and wording of some features that work without them: the idle gap and
typing speed of the time figures and their explanation, the review words the routing request's yes or no comes from,
the patterns that count a git commit or a file read in parts with `sed -n`, and the board's phrases and saved-day
threshold. Without the tables these use the plugin's built-in values (the review words then cover English only).

What the engines do on this computer, with the tables:

- Command guard (Bash and PowerShell): a search or recursive listing of a whole drive or the home folder and a
  `cat >` with no input are refused; a git command that takes every changed file is refused while other agents are
  running. Browser tools and WebFetch are refused on webmail sites and on a tab seen showing one. When a main turn
  ends on a promise of more of its own work with nothing running to wake it, it is sent back once. On accounts whose
  served rules turn it on (not product accounts), the main conversation's subagents start in the background.
- Secret masking: secrets in your prompt, in tool output and in kept conversation rows (API keys, tokens, private keys,
  passwords after `key=` or `--password`) are replaced by `{{secret:NAME}}` placeholders before the model sees them.
  The real values stay in memory for this session only. A tool's input is not changed: the value is not put back into
  tool calls, except on an account whose served rules turn that on, and there only into shell commands and file
  writes (Bash, PowerShell, Write, Edit, MultiEdit, NotebookEdit), never into web, browser, MCP or subagent calls. `/agent-services secrets` lists the placeholder
  names (never values); `secrets forget` empties the list. The outbound redaction of what this plugin itself sends is
  separate and works signed out too.
- Row trimming: after a compaction, the re-attached rows of skills invoked earlier, files read earlier and the
  deferred tool list are rewritten to one line each (instruction, memory, plan and task files stay whole). The daily
  summary (only when you turned it on) carries, per model, the estimated tokens removed and how many compactions were
  trimmed (`savings.trim`), numbers only.
- Subagents: which agent wrote each test file in this session is remembered in memory, and another subagent may not
  change that file. A subagent whose task names a step with `[step:ID]` waits until that step's dependencies in
  `.agent/steps.json` are done (`[override: reason]` lets it start). A subagent report longer than the served cap is
  saved whole in a file under the plugin's data folder (`agent-reports/<session>/`), and the conversation gets its
  opening and the file's path. Where the served rules include a weekly usage line, no new subagent starts once the
  weekly limit is past it; the line can depend on your subscription plan, which the plugin reads from the plan fields
  of `~/.claude.json` (the rate-limit tiers, the plan name and the organization type; they are not sent). A message
  that is only the word "override", sent once the line is reached, lets subagents start until the weekly reset.
  On accounts whose served rules include them (not product accounts): a requirements file the rules name, whose opening lines say it
  is locked, takes only an amendment appended at its end by the main conversation (a shell command never changes it),
  and a commit whose Co-Authored-By line names another model than the one the agent runs on is refused; the model
  is the one this computer saw the agent's last request run on. Nothing is sent.
- Shell watch: on accounts whose served rules turn it on (not product accounts), a foreground Bash or PowerShell
  command still running after the served time is moved to the background, and the model is told its task id;
  long-running background tasks are named to the main conversation; a
  turn that ended at the usage limit is told to carry on later; the `run_command` tool queues `/reload-plugins` or
  `/context` for the idle session and refuses every other command; past 80% of a usage limit the model is told once.
- Turn counts: the main conversation's tool calls in each turn are counted in memory on this computer (a
  subagent's calls never are) and sent as the counts listed in section 1 after the turn; the service decides
  whether they call for advice (section 5).

`/agent-services check` shows which engines are on in this session.

## 2. What the service keeps, and for how long

| What | Kept | For how long |
|---|---|---|
| Request log: time, route, status, error code (for a failed sign-in, the reason), account id, device id, a token hash prefix, keyed hashes of IP addresses (of the connecting address and of your address as the network edge reports it; the same address gives the same hash on this server, so abuse can be traced from line to line, but the log alone does not give the address back), the rate limit hit (IP addresses taken out), whether the request was sealed, latency | yes | 90 days (lines older are removed by a daily pass; the log is also capped by size, about 20 MiB plus one older copy) |
| Mail log: time, kind of mail, the recipient's address masked, whether it was sent | yes | 90 days (also capped by size, about 5 MiB plus one older copy) |
| Your account: email, company, plan, status, role | yes | while the account exists; a deleted account is signed out at once and erased for good 7 days later (every row linked to it) |
| Each sign-in: device id, device public key, Claude account hash, harness, a token check value, plugin version, times | yes | while the sign-in is active, then 30 days after it ended |
| Sign-in code | a check value, and the code encrypted with a server key (so the same code can be mailed again) | deleted when used; an unused or expired code stays until the next code request for that account replaces it |
| Sign-in IP addresses | as keyed hashes only (the address and its range: IPv4 /24, IPv6 /48), for rate limits and known-address checks | from 1 hour to 30 days after use, deleted at the next sign-in activity after that (known addresses: at that account's next successful sign-in), so a row can stay longer |
| Sign-in lockout counts: wrong codes and code requests per IP address, IP range, device id, email address and pairs of these, as keyed hashes only (no email address is ever locked) | yes | 24 hours after the last count or the end of its lock |
| Anti-abuse records: failed signed requests and lockouts, per IP address (not hashed) and per account | yes | about 10 to 15 minutes, deleted at the next failed request after that |
| Daily usage summaries | the whole summary as sent | 395 days; all of an account's days are dropped once it uploads nothing for 30 days |
| Subagent, checkpoint and run-limit requests | the request is not kept; one count per day, account, route and outcome | while the account exists |
| Working-methods sessions | per-session id, role, device id, phase, the item versions delivered and when; no text from you | 395 days |
| The working-methods channel you fetch (stable or beta) | one row per account | while the account exists |
| The one-time estimate | not kept; one count per account per day | 30 days |
| Weekly-email setting and sends | yes | while the account exists (the weekly email is off until you turn it on) |
| Consent records: what you agreed to or withdrew (weekly email, company summary, usage upload, terms, privacy policy, the business-use and 18+ declaration), when, how and the text version; your account id, never your email | yes | the current answer while the account exists; older answers 3 years; after an erase the rows stay as proof under a random id that no longer leads to you |
| Audit log of administrative actions (time, a random id for who and what, action, approval, outcome; no email or IP address), chained by hashes | yes | 3 years; the table that links the random ids to accounts is kept 13 months after the account is gone and deleted at once when an account is erased |
| Audit and alert records (sign-ins, sign-outs, rotations, setting changes, limits hit; they can name account, device and session ids and a masked email address; IP addresses and email hashes are taken out of alerts before they are stored) | yes | audit records 13 months, alert records 90 days |
| Backups of the database (everything above except the request and mail logs) | daily copies on the server itself, encrypted (once the operator has set up the backup key) and readable only by its administrator; encrypted copies off the server | 14 days on the server and up to about 30 days off it, so deleted data can survive that long in a backup |

Mail (sign-in codes, the weekly savings email, a company's weekly summary to its admin) is sent through an email
delivery service.

## 3. What a company admin sees about each member

A company account shows its admin one of two views, chosen for the company by our operator (a newly created company starts at totals only; companies created before this setting existed keep the
per-member view):

- **Totals only**: the admin's private board and the weekly company email show the company's total weekly savings
  estimate, the week before, how many members have figures, the seats and the company's settings. No member's email
  address, figure or device count is sent to the admin's computer or put in the email.
- **Each member**: the board also lists each member's email address, how many devices each member is signed in on
  (counted when the page was made), and each member's weekly savings estimate ("no data yet" while a member uploads nothing),
  listed by email address, never ranked by figure. The weekly email shows the same except the device count.

Both views say that the figures are estimates of AI cost savings, not a measure of anyone's work, and that "no data
yet" is not evidence that someone did not use Claude Code. The admin does not see token counts, costs, task types,
project ids, session counts, times of use, IP addresses, prompts or code.

From plugin 0.8.0, when your company has an admin (or a company summary address), the plugin tells you once what the
admin sees about you in your company's view, and again if the company changes the view; the upload question says the
same, so you know before anything of yours is uploaded. Before an account becomes a company's admin, our operator
records the date the company confirmed it told its members about the board.

The company can also pause agent-services for everyone, and can set the savings record on or off for everyone.
Set off, nothing of yours is uploaded and only the admin can change it. Set on, nothing is turned on for you: you
are asked the same three options as everyone ("Upload, including the past 30 days", "Upload from now on only",
"Don't upload"), told that your admin turned it on and recommends it, and nothing of yours is uploaded until you
answer (the admin sees "no data yet" for you meanwhile). Your private savings page stays your own choice
(`/agent-services sharing page on|off`), for an admin too. `/agent-services sharing off` stops your upload unless the
company set it off. Your
email address and device count stay visible to the admin while you are a member.

`/agent-services company` shows you exactly what the admin's private board shows about you: your email
address, your device count and your weekly savings figure (or "no data yet"), for the same week and with the same
values, or that your company shows totals only, plus whether the company paused agent-services and how it set the savings record. Only your own row is
fetched, never another member's. For the admin, the same command still shows the company board and the email switch.

## 4. Files on this computer

| Where | What |
|---|---|
| Claude Code's plugin store, a JSON file in your Claude Code folder (`~/.claude`) | the sign-in credential in plain text (the token, the next token during a rotation, the device key), plus account id, device id, plan, your choices (the savings record, the autonomy choice and the methods version you were last told about, each kept for each account that signed in here, and the methods level and the routing level) and switches, a local key for the project hash, and day counters. Any other plugin and any program running as you can read it; a copy works as your sign-in until the next rotation or sign-out. |
| `~/.agent-services/services/outbox/<day>-<session>.jsonl` | the request log: every request as sent (secrets such as the code and the token blanked) and its answer, previews, every call the model made to this plugin's tools with its full arguments (for one, a whole subagent description given to `router_advice`), and savings-page publish attempts. Kept 90 days, at most 2 MiB a file. |
| `~/.agent-services/dashboard/`, `~/.agent-services/boss/`, `~/.agent-services/services/*.json` | your savings page (a company admin's board, with member emails in the per-member view; the admin's computer empties the board page and deletes its cached company summary from the plugin store after sign-out, when the account is no longer the admin, and once the summary is more than 30 minutes old, checked when the board is refreshed after a turn and about every minute while Claude Code runs) and their publish state (`dashboard.json`, `boss.json`), and for each board the page format last published and the version of its figures document (`dashboard-live.json`, `boss-live.json`) |
| `~/.agent-services/methods.md`, `methods.approved.md`, `methods.pending.md` | the working-methods text |
| `~/.agent-services/methods.seen.md`, `methods.previous.md` | the served working-methods text of the version last seen and of the one before it, so `/agent-services methods diff` can show what changed |
| Claude Code's plugin store (see above), keys `checkpoint_counts`, `terms_accepted`, `redline_override`, `login_check` | checkpoint counters per hashed session id; the browser check token the service gave for a sign-in under signs of abuse (with the email, 10 minutes); the terms version you accepted at sign-in (sent with the code, with "business use, 18 or older"); the weekly reset until which you let your agent start subagents past the usage line |
| `~/.agent-services/services/asked.json` | when a setup question was last asked, by any session (an unanswered question waits 7 days) |
| `plugin-update.json` (in Claude Code's data folder for this plugin, else `~/.agent-services/services/`) | the update check's state |
| `~/.agent-services/MIGRATED` | what the one-time move from an older version did |
| `~/.agent-services/REMOVED` | left by `/agent-services remove`; while it holds text, the plugin does nothing in any session; a sign-in empties it |
| `~/.claude/CLAUDE.md` | one marked section importing `~/.agent-services/methods.md`, only after you chose `methods on` |
| Claude Code's plugin store (see above), key `jit_sessions` | the ids of the last 30 sessions started on this computer and when each started, so a resumed session is known; never sent |
| Claude Code's plugin store (see above), key `usage_days` | this computer's figures per day for the usage panel: tokens and their cost at API prices, typed bytes, agent seconds and turns; never sent as such |
| `~/.agent-services/tools/usage_scan.py` | not part of the plugin: a usage scan tool you may put there yourself; when it is there, the plugin runs it (see "Local helpers" below) |
| `~/.agent-services/services/time-days.json` | per-day figures of every transcript (tokens, cache reads, cost at API prices, typed bytes, agent seconds, turns) written by the usage scan tool, or by the plugin from that tool's answer; read for the usage panel and the daily summary's time figures |
| `.agent/test-lock.json`, `.agent/pending.md`, `.agent/steps.json` in a project | read only, never written or sent by the plugin; you or the model write them (see "Local helpers" below) |

`~/.agent-services` is `AGENT_SVC_DATA_DIR` when that is set. The plugin reads, and does not send: your Claude
account id (only its hash leaves), your Claude Code transcripts (to count tokens for the summary and the estimate,
and the time figures; Claude Code lets a plugin read files of up to 4 MiB, so larger transcripts are left out unless
`~/.agent-services/services/time-days.json` holds per-day figures written by a separate tool, which then take the
place of the plugin's own for the days it covers, today included while the file is under an hour old), your plan's usage and context figures as Claude Code reports them
(shown in the panel, never sent),
files read in parts (to count their size), a project's `agent-state.md` and the three `.agent/` files above, the
text of your messages (only to see whether one asks for a review), and the marketplace list.

**Local helpers** (they send nothing of their own):

- The usage scan tool: only when a file named `usage_scan.py` sits in `~/.agent-services/tools/` (the plugin ships
  none and never writes there) and its content is one of the tool versions the plugin lists by checksum
  (any other file there, edited or written by another program, is never run), the plugin runs it with Python, trying `py -3`, then `python3`, then `python` from
  your PATH, as a program with fixed arguments (`usage_scan.py --days`, no shell), in the background when the usage
  panel's figures are refreshed or the daily summary is built, at most once every 15 minutes across sessions, with
  a 5-minute time limit. It gets on its input your Claude Code projects folder, the start of the day the last
  `time-days.json` was written (it then reads only transcripts changed since) and the plugin's price table, and it
  reads your transcripts, larger ones included. Its answer must be per-day figures in the expected shape, at most
  8 MiB; anything else is ignored. A good answer is written to `~/.agent-services/services/time-days.json`; for every
  day it covers, today included, its figures then take the place of the plugin's own in the usage panel, and its
  time figures in the daily summary (the summary's token counts per model still come from the plugin's own scan). Nothing of it is sent as such; the time
  figures of a day go with that day's daily summary only while the savings record is on. Without the file, on a
  surface where the plugin cannot run programs, or when the tool fails, times out or answers anything else, the
  plugin's own scan is used as before. Removing the file stops it.

- The checkpoint tool (`checkpoint`: milestone, keep, next), registered only when no other plugin in the session has a
  tool named `checkpoint`. After the reply in which the model called it, the plugin compacts the conversation keeping
  what the model listed, then sends the model's next step back as a message from this plugin (not after an
  interrupted turn, and not once you wrote a message yourself). A short conversation is not compacted. The minimum
  size and the tool's answers come from the served rule tables; until they arrive, nothing is marked.
- The test lock: a subagent's Edit, Write, MultiEdit or NotebookEdit of a file matching a glob in
  `.agent/test-lock.json` (`{"locked": ["tests/**"]}`) is denied; the main conversation may edit those files. Changes
  made through Bash or other tools are not checked.
- The status line shows how many `- [ ]` lines `.agent/pending.md` has (decisions waiting for you).
- Notes for the model at the next prompt: the service's turn advice (section 5), and once per session the hint the
  routing service sent for a subagent that ran without routing advice (a description without a task type word),
  labelled as agent-services notes. The routing hint's text comes from the served rule tables; without them that
  note is not made.
- The speed-up suggestion the routing service sends is added once to the end of each routed subagent's prompt.
- The autonomy choice: when you answer the working methods' question with "Fully automatic (agent-services
  recommends this)" or "Check in with me as usual" (Claude Code's AskUserQuestion dialog, in the main conversation,
  while signed in), the plugin keeps that answer for your account in the plugin store only; nothing of it is sent.
  While one is kept, the working methods the plugin adds to a prompt (level `suggest`) end with one agent-services
  note saying which you chose. `/agent-services autonomy` shows it, `autonomy auto | ask` changes it and
  `autonomy clear` forgets it; `/agent-services status` shows it in one line.
- A new served version of the working methods (level `suggest`): the first time a prompt brings a version other
  than the one your account was last told about, a dim line and a toast say "agent-services working methods were
  updated to <version>. /agent-services methods diff shows what changed." once; the new version applies without an
  accept. The first version ever seen is recorded without a line.
- The suggestion and the notes stop while the working methods are switched off (the routing hint note does not: it
  follows the routing level); the suggestion and the routing hint note also stop while subagent routing is off
  (`/agent-services routing off`).

## 5. What comes back

Every answer has a fixed shape:

- Sign-in check: accepted, the plan, the routes open to you, and for a company account the company's savings
  setting (and whether you are its admin); from plugin 0.8.0 also the company's board view (totals only or each
  member) and whether anyone sees the company board or email.
- Subagent routing: route, pass or deny; a model and effort or none; a reason code; a hint and two short rules
  (text, at most 2,000 characters each). A deny gives the hint and rules to the model as the reason; a route or pass
  adds the speed-up rule to the subagent's prompt. For a main session on a Haiku, Sonnet or Opus model the routed
  model is never a larger one of these (another main model sets no cap, and neither does a plugin older than
  0.6.0), and the configuration for a deep review comes only when your latest message asked for a review.
- Checkpoint timing: now or not, and short lines to keep in a summary (at most 300 characters each), given to the
  model at the next prompt; when it says now, you also see a short notice. The counters are kept per session (under a
  hash of the session id, at most 50 sessions) in Claude Code's plugin store, so a plugin reload does not reset them.
  When the request carried the turn counts, it may also carry the turn advice: one short line per case (at most
  1,500 characters in all), each labelled `agent-services suggestion (<case>)`, and the case ids. The plugin gives it
  to the model at the next prompt, labelled as an agent-services server note (not at methods level `off`); the
  request log on this computer keeps each answer, advice included. It is advice the service writes for that turn,
  not working methods text you approved, so it is not part of `methods.md` or the methods diff.
- Run limits: how long a command with that head may go without new output, its total time limit, whether such commands are better started in the background, and if so a short note (at most 600 characters) labelled `agent-services suggestion (long-commands)`. The plugin keeps the answer in memory for the session and adds the note once to the result of a call with that head, for the model; the request log on this computer keeps the answer. It is advice the service writes, not working methods text you approved.
- Planning gate: whether the facts sent hold file changes, a reason (served text, at most 4,000 characters, in which
  the plugin fills in the path of the project's `agent-state.md` and its two fixed templates of that file) and how many
  changed lines still count as a small edit. The plugin keeps it in memory for the session, per set of facts. At
  `methods on` the reason is what the model is told when a file change is held; at `suggest` it is the one reminder
  of the session, given with the next prompt. A file change waits at most 2 seconds for the answer; without one
  (offline, late, an older service) nothing is held and no reminder is given.
- Working methods: a version and items of text (at most 20,000 characters each, each checked against its SHA-256),
  given to the model with a prompt (level `suggest`) or written to `methods.md` (level `on`). Served methods are
  plain text you can read and quote. As a safeguard the plugin also strips any invisible characters (zero-width,
  direction-control, variation-selector and tag characters) from served text before the model sees it or
  `methods.md` holds it. The request log keeps each item's id and SHA-256 but not its text.
  When the model calls the `lesson_lookup` tool, at level `suggest` it gets the text served now; at `on` it is
  pointed to the approved text your CLAUDE.md loads; at `off` it gets no items. With an event it gets that
  moment's items at `suggest` and at `on`.
- Just-in-time items: the items of one moment (section 1), served text checked and cleaned like the working
  methods. The plugin keeps them in memory for the session and gives them to the model once, labelled as
  agent-services advice, with the result of the tool call that brought the moment or with the next tool result or
  prompt, at `suggest` and at `on`. They are advice for that moment, not part of `methods.md` or the methods diff;
  the working methods name them and say when they come.
- Savings and report: dollar and token figures by day, and short report lines (at most 300 characters each) for the
  band and the savings page.
- Company summary (admins): the table of section 3.
- From Claude Code's Artifact and ArtifactData tools (not our service): the board's claude.ai address and the
  version number of its figures document, kept in the files of section 4; the request log notes each attempt.
- Estimate: dollar and hour ranges for each kind of saving.
- Switches: on or off.

## 6. What you can turn off

| To stop | Run |
|---|---|
| everything sent to the service | `/agent-services offline on` (back: `offline off`), or `/agent-services logout` |
| the daily upload, the weekly email and the savings page | `/agent-services sharing off` ("Don't upload"; never asked again; `sharing not_now` asks again in 7 days; each part alone: `sharing page off`, `sharing mail off`) |
| the working methods and the planning gate | `/agent-services methods off` (works signed out too; `methods suggest` keeps them as suggestions without the CLAUDE.md line) |
| subagent routing (the routing request, its deny or model change, and the suggestion added to subagent prompts) | `/agent-services routing off` (back: `routing suggest`, the default, or `routing strict`, which lets the service refuse a subagent without a task type word; works signed out too) |
| row trimming after a compaction | `/agent-services trim off` (back: `trim on`) |
| the command guard, secret masking, row trimming, subagent gates and shell watch at once | `/agent-services offline on` or `logout` (they need the served tables) |
| everything on this computer | `/agent-services remove`, then `claude plugin uninstall agent-services@agent-plugin` |

Checkpoint timing has no switch of its own: it stops when you sign out or uninstall, and offline mode stops it;
those stop subagent routing too. The planning gate follows the methods level: only at `methods on` does it hold file edits
(Edit, Write, MultiEdit, NotebookEdit) while the service's verdict on a project's `agent-state.md` holds them (section 1 lists
what is sent for it), and an Edit of at most the number of changed lines that verdict names passes (so do writes to
`agent-state.md` and to files under `.agent/`); without a verdict (offline, late or an older service) it holds nothing; at `suggest` it holds nothing and adds one reminder to the next prompt; at `off`, in a session
nobody can be asked in (such as `claude -p`) and for subagents it does nothing. It does not cover Bash: a file
written through a Bash command is never held. Where your company set the daily upload off for everyone, only its
admin can change it.

The plugin asks its setup questions (the savings record, the methods level and the subagent routing level) together, only in the dialog of
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
