---
name: agent-services
description: Sign in to agent-services in Codex, trust its hooks, check its status and read or change the methods choice. Use when the user asks about agent-services, when its tools are missing, or when they want to see what its hooks send.
---

# agent-services in Codex

agent-services adds working methods to each Codex thread and advises which model and reasoning effort a
`spawn_agent` call should use. It runs on the agent-services server through a remote MCP connection; nothing runs
on this machine. All of it is an agent-services suggestion, not the user's own instruction.

## Sign in

- CLI: the user runs `codex mcp login agent-services`. A browser page asks for the account email and a one-time
  code. A signed-out `codex exec` shows no hint, so suggest this command whenever the agent-services tools are
  not available.
- Desktop app: the sign-in page opens when the plugin is installed or enabled.
- One account has one seat, shared by Codex and the Claude Code plugin: signing in from Codex ends the Claude Code
  plugin's session on that account, and signing in there ends the Codex sign-in. The newest sign-in wins.
- Sign out: `codex mcp logout agent-services` removes the sign-in from this computer only. On the server it ends
  when the account signs in from the Claude Code plugin or another Codex, when the company admin ends it, or
  after 30 days unused (90 days after sign-in at the latest).
- Old local set-up: if `codex mcp list` shows agent-services as a local command or as disabled, an
  `[mcp_servers.agent-services]` entry in the user's `~/.codex/config.toml` hides the plugin's server (even when
  disabled). Ask the user to remove it (`codex mcp remove agent-services`), then sign in again.

## Trust the hooks

Codex skips plugin hooks that the user has not reviewed and trusted, without any warning. Until they are trusted,
no methods arrive and no spawn advice is given. Ask the user to review and trust the agent-services hooks when
Codex offers it. Call `setup` with `info hooks` to show exactly what each hook sends. If trust is set by hand
in config.toml: Codex 0.167 shows a hook's current hash as two parts joined by "/"; only the first part is
accepted as the trusted hash.

## Tools

- `status`: whether the sign-in, the license and the company setting allow the service, and the methods choice.
- `lesson_lookup`: the methods for one work phase (plan, implement, test, review, deliver, checkpoint).
- `router_advice`: the advised model and effort for a `task_name` that starts with a task word.
- `checkpoint_advice`: whether now is a good moment to compact the conversation.
- `setup`: read only; `methods preview` shows the methods text, `info hooks` the hooks.
- `setup_methods`: changes the stored methods choice (`methods suggest`, `methods on`, `methods off`,
  `methods accept`, `methods keep`). Call it only with the user's own answer; Codex asks the user to approve it.
- `setup_sharing`: Codex usage sharing (token counts per model per day, sent after each model request). It turns
  on only with Yes on the sign-in page (No turns it off); `sharing off` turns it off, `sharing preview` shows what is
  sent and kept. Call it only with the user's own answer.

When the server cannot be reached, the hooks fail open and Codex goes on unchanged.
