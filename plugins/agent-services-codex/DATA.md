# agent-services for Codex: what it sends, keeps and does

This note ships with the agent-services plugin for OpenAI Codex. The Claude Code plugin has its own note; this one
covers only the Codex path.

## In short

- The Codex plugin installs no program. It is a set of files that tell Codex to use the agent-services MCP server
  at `https://<service host>/mcp` and to call three of its tools from Codex hooks. Everything runs on our server.
- **How it is protected in transit.** Codex traffic is protected by standard TLS (HTTPS) through Cloudflare, our
  network provider. It is not protected by the end-to-end encryption and the answer signatures the Claude Code
  plugin uses, because Codex cannot speak them. Cloudflare can therefore see the Codex requests (including the sign-in
  email address, the sign-in code and the access tokens) and the working-methods text the service sends to Codex
  users. The Claude Code path keeps its end-to-end encryption and signatures unchanged.
- agent-services is a paid service and needs a sign-in. Signed out, Codex works as usual: every `/mcp` request is refused
  (401) and the hooks fail open (Codex goes on as if they were not there). The same happens
  when the service cannot be reached. Codex waits for each hook's answer, so a slow or unreachable service can add
  up to 2 seconds to a model request and up to 5 seconds to a session start, a prompt or a subagent start.
- Your prompts, your code and the text of the briefs Codex writes for its subagents never leave your machine. The
  hooks send only a fixed event name, the task name of a subagent (v2) or the turn id (v1), and, after each model
  request (Codex 0.167 or later), the model name, the request status and the token counts. Codex adds its thread
  id to each call; the service keeps it only as a hash.
- The sign-in page can use Cloudflare Turnstile, a bot check with no puzzle in most cases, before it mails a sign-in
  code. Turnstile runs in your browser and Cloudflare processes browser and device signals for it; the service keeps
  none of them. To slow down code guessing, the service also counts sign-in attempts per IP address, IP range,
  email address and a keyed hash of your browser's User-Agent and language headers with the IP range; it keeps these
  counts only as keyed hashes and only for 24 hours.
- The service does not keep your work. It keeps your account, your sign-ins, counts, ids and versions, and IP
  addresses (in its request log only as keyed hashes). The token counts are kept, as daily sums per model, only if
  you turn on Codex usage sharing (Yes on the sign-in page; neither answer is preselected); otherwise they are discarded unread. The
  details are below.
- How the service makes its advice is a business secret and is not published. Its answers come back in a fixed
  format, listed in section 5.

## 1. What each request sends, and when

Every request goes over HTTPS through Cloudflare to our server and carries what any HTTPS request carries (your IP
address as Cloudflare and our server see it, and the headers Codex sends). Every request to `/mcp` carries your
access token.

| When | Request | What it sends |
|---|---|---|
| You run `codex mcp login agent-services` (or Codex asks you to sign in) | `GET /.well-known/oauth-protected-resource/mcp`, `GET /.well-known/oauth-authorization-server` | nothing beyond the request itself |
| The same, in your browser | `GET /oauth/authorize` | the Codex client id, the loopback address Codex listens on (`http://127.0.0.1:<port>/...`), a PKCE code challenge, a random state value, the `/mcp` address and the scope Codex asks for |
| You open the sign-in page while the bot check is on | your browser loads Cloudflare Turnstile from `challenges.cloudflare.com` | Turnstile runs in your browser and sends Cloudflare signals about the browser and the device (such as your IP address, the browser's headers and how the page is used) to decide whether a person is signing in; we receive only its pass or fail token. No cookie of ours; no Google service |
| You enter your email on the sign-in page | `POST /oauth/authorize` (step email) | the same values, your email address and, while the bot check is on, the Turnstile token (our server sends that token with our Turnstile key to Cloudflare to check it, nothing else); the service mails a sign-in code to it |
| You enter the code and press "Allow" | `POST /oauth/authorize` (step code) | the same values, your email address, the code, when terms are shown the terms version you accepted, and your answer, Yes or No, to "Upload my Codex usage counts?"; your browser is then sent back to Codex on your own computer with a one-time authorization code |
| Codex finishes the sign-in | `POST /oauth/token` | the client id, the authorization code, the PKCE verifier, the loopback address and the `/mcp` address |
| About once an hour while Codex uses the service | `POST /oauth/token` (refresh) | the client id and the refresh token |
| You sign out in Codex | nothing: `codex mcp logout` (checked on Codex 0.167) removes the tokens from your computer and sends no request; the service offers `POST /oauth/revoke` should a later Codex use it | (if sent) the client id and a token |
| Each Codex start | `/mcp` `initialize` and `tools/list` | protocol version and client name and version, as Codex sends them |
| Each new session and each prompt you send (hooks SessionStart and UserPromptSubmit) | `/mcp` tool `hook_session` | the word `SessionStart` or `UserPromptSubmit`, and the thread id Codex adds. Never the prompt |
| Each time Codex starts a subagent (hook PreToolUse on `spawn_agent`) | `/mcp` tool `hook_spawn` | v2: the subagent's task name (lowercase letters, digits and underscores, at most 64 characters); v1: the turn id; and the thread id. Never the brief |
| After each model request (hook PostModelRequest, Codex 0.167 or later; an older Codex ignores it) | `/mcp` tool `hook_usage` | the model name, the request status and the token counts of that request (input, cached input, cache write, output, reasoning and total tokens), and the thread id Codex adds. Never the prompt or the answer. They are sent whether or not Codex usage sharing is on; while it is off the service discards them unread and does not log them (the request log keeps only the path, as for every request) |
| When the model calls a listed tool | `/mcp` tools `router_advice`, `lesson_lookup`, `checkpoint_advice`, `status`, `setup`, `setup_methods`, `setup_sharing` | only the tool's arguments: a task name; a work phase; context-use percentage and counts of turns, tool calls, finished to-dos, commits and minutes; a fixed setup word; plus the thread id Codex adds |

Codex asks you before `setup_methods` and `setup_sharing` run, because they change a stored setting. The other listed tools are marked
read-only.

## 2. What the service keeps, and for how long

| What | Kept | For how long |
|---|---|---|
| Request log: time, path (never the query or the body), status, error code, account id, a sign-in id, keyed hashes of IP addresses, the rate limit hit (IP addresses taken out), latency | yes | 90 days (also capped by size) |
| Your account: email, company, plan, status, role | yes | while the account exists; a deleted account is erased for good 7 days later |
| Each Codex sign-in: a random id `codex_<16 hex>`, harness `codex`, status and times; no device key | yes | while the sign-in is active, then 30 days after it ended |
| Sign-in codes, rate limits and lockouts | as for the Claude Code plugin: check values, keyed hashes of IP addresses, IP ranges and of a light fingerprint of the sign-in page's browser (User-Agent, Accept-Language, IP range; no cookie), clear IPs only in short-lived anti-abuse records | see the Claude Code plugin's data note |
| Authorization codes | only a sha256 of each, with the loopback address and the PKCE challenge | used once within 60 seconds; the retention pass deletes the row a day after it expired |
| Access and refresh tokens | only a sha256 of each, with times and how they follow each other | access tokens are valid 1 hour, refresh tokens until the sign-in ends; the retention pass deletes an access token row a day after it expired, and every token row a day after it was revoked or its sign-in ended |
| Your methods choice (on, off or suggest) and the checksum of methods text you accepted | yes | while the account exists |
| Delivery records of working methods (which item ids and versions reached a thread, under a hash of the thread id; no text) | yes | 13 months |
| Codex usage counts, only while Codex usage sharing is on | per account, UTC day and model: the number of model requests and the sums of input, cached input, output and reasoning tokens (the model name at most 64 characters); held in the server's memory for up to a minute before they are added | 13 months; removed with your account |
| Subagent advice and spawn decisions | not the request; one count per day, account and outcome (advised, followed, allowed) | while the account exists |
| Thread state (methods already sent, spawns already advised) | in memory only, under a hash of the thread id | 2 hours, or until the server restarts |
| Consent records, audit and alert records, backups | as for the Claude Code plugin | see the Claude Code plugin's data note |

Sign-in alerts: the same sign-in mails as for the Claude Code plugin apply. The service alerts its operator when an
authorization code is used twice, or a refresh token is used again more than 30 seconds after its first use (a sign
that it was copied); that sign-in is then ended and Codex asks you to sign in again.

One seat per account: an account has one seat, shared by the Claude Code plugin and Codex. The newest sign-in wins:
signing in from Codex ends the account's Claude Code plugin session, and signing in from the Claude Code plugin ends
the account's Codex sign-in. A Codex sign-in counts only once Codex has finished it (the authorization code was
exchanged); a sign-in page you leave unfinished ends nothing.

## 3. What a company admin sees

The same as for the Claude Code plugin (see its data note, section 3), plus a Codex part in the weekly company
summary email. It holds company totals for the week, never a figure for one person, from the members who turned on
Codex usage sharing: the number of model requests and the tokens per model, an estimated cost at OpenAI's public list
prices (a model without a public price is shown in tokens only), and how many times subagent advice was given and
followed. It claims no saving for Codex, and Codex use adds nothing to the savings figures. The Codex part is left
out of the email and the company board while fewer than 3 members with Codex use that week share it, because the
totals would then be one or two people's own figures. While the company's savings record is off, the Codex part is
empty too. The company can pause agent-services for everyone; while it is
paused, Codex gets no methods and no advice, and the token counts are discarded.

## 4. Files on your computer

agent-services writes no file on your computer. Codex itself keeps:

| Where | What |
|---|---|
| Codex's plugin folder (`~/.codex/plugins/cache/...`) | the plugin files: `.codex-plugin/plugin.json`, `.mcp.json`, `hooks/hooks.json`, the skill, this note and the licence |
| Codex's credential store | the access and refresh tokens from the sign-in, kept and removed by Codex (`codex mcp logout agent-services`) |
| `~/.codex/config.toml` | the plugin's enabled state and whether you trusted its hooks, written by Codex |
| A temporary folder | Codex may write a long hook answer to a file there; the service keeps the methods text short (at most 8,000 characters) so this does not normally happen |

## 5. What comes back

- `hook_session`: once per thread, the working-methods text, which Codex adds to the model's context; otherwise an
  empty answer. The server remembers a thread for 2 hours: a thread still in use after that, or after a server
  restart, gets the text once more.
- `hook_usage`: always an empty answer, at once (Codex waits for it before the next model request).
- `hook_spawn`: for the first spawn of a task name (v2) or of a turn (v1), a refusal whose reason names the model and
  reasoning effort to use; the repeat goes through. Otherwise an empty answer (no decision: Codex applies its own
  rules).
- Listed tools: a short JSON answer (advice, a lesson text, checkpoint timing, your status, the methods text or your
  choice; `router_advice` may add `brief_rule`, a short served rule the model copies into the subagent's brief), or an error code such as `org_paused`, `license_inactive`, `no_license` or `rate_limited`.

## 6. What you can turn off

- Working methods: `setup_methods` with `methods off` (back with `methods on` or `methods suggest`).
- Codex usage sharing is off unless you answer Yes to "Upload your Codex usage counts?" on the sign-in page; No turns
  it off. To change it later, sign in again (`codex mcp logout agent-services`, then `codex mcp login agent-services`)
  and answer again. Your answer counts once you entered the right code, even if Codex then does not finish the
  sign-in.
  To turn it off, ask Codex to call `setup_sharing` with `sharing off`; `sharing preview` shows what is sent and kept.
  Your company admin can turn it off for everyone by turning the savings record off. There is no backfill: counts
  start when sharing is on, and only Codex 0.167 or later sends them.
- Subagent routing has no separate switch on Codex: disable the plugin's hooks in Codex, or the plugin.
- The hooks run only if you trust them in Codex; untrusted plugin hooks are skipped.
- Sign out: `codex mcp logout agent-services` removes the sign-in from this computer only. On our server it ends
  when you sign in from the Claude Code plugin or another Codex (one seat: the newest sign-in wins), when your
  company admin or we end it, or after 30 days unused (90 days after sign-in at the latest).
- Remove the plugin in Codex; nothing of agent-services stays on your computer except what Codex keeps (section 4).
