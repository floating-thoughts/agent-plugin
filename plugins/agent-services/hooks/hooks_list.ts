import { receiptText } from './receipts'

export type HookRow = {
  event: string
  matcher: string
  file: string
  does: string[]
  what: string
  shown: string
}

export const HOOK_EFFECTS: Readonly<Record<string, string>> = {
  context: 'adds context for the model',
  drop: 'drops a prompt',
  deny: 'denies a tool call or a subagent',
  rewrite: 'changes a request before it runs',
  ui: 'shows something on screen',
  process: 'runs a command on this computer',
  file: 'writes files',
  network: 'sends a request to the service',
  answer: 'answers a call itself',
  count: 'counts locally',
}

export const HOOKS: readonly HookRow[] = [
  {
    event: 'session.start', matcher: '', file: 'register.ts', does: ['network', 'file', 'process', 'ui', 'count'],
    what: 'Registers the slash command and the setup tool; once signed in (or right after you sign in) also the savings, toolbox, status and task_state tools. In the background: the sign-in check, whether this session id was seen at an earlier start (a resumed session; the id is kept in the plugin store and the service is asked once for the resume items, sending only the event name), the daily upload of the savings record ' +
      '(only after you chose to upload, never before your own answer, also when your company turned the savings ' +
      'record on; with "Upload from now on only" nothing from before the day you chose), the request-log cleanup (90 days), the working methods for the first ' +
      'prompt (only at methods level suggest) and the CLAUDE.md methods file (only at methods on), a one-time move ' +
      'from an older version, and the update check (`claude plugin list --json` and `claude plugin marketplace ' +
      'update agent-plugin`; it never updates the plugin; not in a session nobody can be asked in), and, only when a usage scan tool sits at ' +
      '~/.agent-services/tools/usage_scan.py, that tool with Python (`py -3`, `python3` or `python`; at most every 15 minutes; ' +
      'it reads your transcripts and writes services/time-days.json, nothing is sent). After the other plugins\' start hooks: registers the ' +
      'checkpoint tool, unless another plugin in the session already has a tool named checkpoint (then the notes ' +
      'name that one), and reads the open count of .agent/pending.md in the project. Signed in: rows of the ' +
      'project\'s job ledger (.agent/jobs.json) still running whose session has ended are marked stalled (an end this ' +
      'plugin recorded; no sign of that session or job for 6 hours; or this same session started again after 10 ' +
      'minutes without a sign of life while Claude Code no longer lists the agent), and this session\'s last-seen time ' +
      'is kept in the plugin store (key resume_live). Once the served rule tables ' +
      'arrived (signed in): choices kept for an earlier account of the same person may be moved to the signed-in ' +
      'account, and a one-line notice is shown once if a choice kept for another account was not moved.',
    shown: 'A dim line when the sign-in check has something to say.',
  },
  {
    event: 'agent.spawn', matcher: '', file: 'register.ts', does: ['network', 'deny', 'rewrite', 'ui', 'file', 'process'],
    what: 'While subagent routing is off (/agent-services routing off) it sends no request, changes no model, ' +
      'adds nothing to the subagent\'s prompt and denies nothing (neither the steps gate, the weekly usage line nor the depth check below); the local guards below marked "also while routing is off" still run. Otherwise it asks the service for routing advice on each subagent (forks and ' +
      'teammates are skipped). The advice can ' +
      'deny the subagent with a reason, or set its model and effort. At routing suggest (the default) a subagent ' +
      'whose description has no task type word is never denied for it; at routing strict the request says so and ' +
      'the service refuses it. At routing suggest the model and effort the agent wrote in its own Agent call are ' +
      'used (within the main session\'s model and the models you allow), and the service fills in what it did not ' +
      'write; at routing strict the service\'s table sets both and the agent\'s own choice is not used. The request ' +
      'also carries the main session\'s model id and whether your latest message asked for a review (yes or no; your ' +
      'text is not sent), and, once you chose them with /agent-services models set, the models and efforts you allow ' +
      'for subagents, and your session pick from /agent-services models use (kept in memory for this session only). ' +
      'The Agent call\'s result carries one line that says what was requested and used, and why. Unless the ' +
      'methods level is off, the service\'s speed-up suggestion is added once to the end of the subagent\'s prompt, ' +
      'labelled as an agent-services suggestion. ' +
      'With the served rule tables (signed in): a subagent whose task names a step with [step:ID] is denied while that step\'s dependencies in the plan are not done (the ## Plan step lines of agent-state.md; the old .agent/steps.json only when there are none) (a step counts as done only with its evidence written down; [override: reason] lets it start; not while routing is off); the weekly usage line that stops new subagents applies to every signed-in account with the served rules (a plan or replan dispatch of the main conversation stops a few points earlier), and not while routing is off; the main conversation\'s subagents are started in the background. A subagent whose task names a step that a running or waiting background job already claims (one that showed life in the last 2 hours), or that another subagent started a moment ago took, is denied ([override: reason] lets it start; not while routing is off). A background subagent gets a row in the project\'s .agent/jobs.json. These checks send nothing. ' +
      'Write ownership (signed in, also while routing is off): for a new background subagent the brief is checked for its goal, the command that checks success, the files it may change, what it must not touch and the form of its hand-back; the parts missing, owns: entries not taken as claims, and claims that overlap another open background job\'s are said in a note on the Agent call\'s result; its owns: and check: lines are written to the project\'s .agent/jobs.json. Nothing is sent. ' +
      'The globs on an "acceptance:" line of a subagent\'s brief (signed in, also while routing is off) are kept in the project\'s .agent/evidence.json for the acceptance lock. ' +
      'Signed in, not while routing is off: a subagent that would be the 4th level below the main conversation, or whose ' +
      'brief is the one an ancestor (or its dispatcher) was started with, is denied; workflow agents, teammates and ' +
      'resumes are exempt. Signed in, also while routing is off: before a new background subagent with an owns: line ' +
      'starts, the working tree is snapshotted with git (refs/agent-services/snap/, waiting at most 5 s; HEAD, the ' +
      'index, branches and the stash are never touched). A deny of these local checks is appended to the project\'s ' +
      '.agent/audit.jsonl (as for tool.call). Nothing of it is sent. The whole hook ends within 7.5 s and waits at ' +
      'most 2.5 s for any one step: a step cut that way is skipped and the subagent starts without it.',
    shown: 'A step cut for time is named in one dim line. A deny shows its reason, which starts with "agent-services routing", "agent-services steps gate" or ' +
      '"agent-services usage line" or "agent-services steps claim" or "agent-services dispatch depth" or ' +
      '"agent-services dispatch cycle". A changed model is said each ' +
      'time in a dim line naming the model. The added suggestion is in the subagent\'s prompt. When a subagent the ' +
      'main conversation started has finished (signed in, routing not off), one dim line gives its saving, for example ' +
      '"agent-services: haiku instead of opus: ~$0.04 saved (est.)": an estimate worked out on this computer from that ' +
      'subagent\'s transcript, net of the tokens this plugin adds to it; nothing of it is sent.',
  },
  {
    event: 'turn.step', matcher: '', file: 'register.ts', does: ['rewrite', 'count'],
    what: 'Counts token usage locally. For a subagent whose model agent-services set, it also sets the effort of ' +
      'its model requests to the advised effort. Signed in or not, it also notes in memory the token counts of each main request ' +
      '(for the cache-break line of cache_break.ts).',
    shown: 'The dim line at the subagent\'s start names it.',
  },
  {
    event: 'tool.call', matcher: '', file: 'register.ts', does: ['deny', 'file', 'count', 'network', 'context', 'process'],
    what: 'The planning gate, only at methods level on (methods on): while you are signed in, it denies Edit, Write, ' +
      'MultiEdit and NotebookEdit of the main agent when the project has no agent-state.md, or it is still in ' +
      'planning, or it has no goal and plan (the criteria, texts and small-edit size come from the served rule tables; without them nothing is held); an Edit or MultiEdit of at most the served number of changed lines passes, and writes to ' +
      'agent-state.md and to files under .agent/ always go through. Bash is never held, so a file written through Bash is not seen. At ' +
      'level suggest it only notes such a change for one reminder; at off it does nothing. It also counts tool ' +
      'calls, commits and finished todos locally, and the size of files read in parts. This hook never changes a tool\'s input, except on an account whose served rules turn it on (not product accounts): there it puts back, on this machine and for that call only, a secret of yours in place of a {{secret:NAME}} placeholder that this plugin\'s secret masking made.' +
      ' The test lock: it denies a subagent\'s Edit, Write, MultiEdit or NotebookEdit of a file that ' +
      'matches a glob in the project\'s .agent/test-lock.json (the main conversation may edit them; Bash is ' +
      'not checked). It times the main conversation\'s foreground Bash, PowerShell and subagent calls and ' +
      'counts its subagent dispatches, locally. ' +
      'With the served rule tables (signed in): browser tools and WebFetch are denied on webmail sites and on a tab seen showing one (navigating that tab away or closing it stays allowed); secrets in a tool\'s output are masked again; a subagent report longer than the served cap is saved whole in a file in the agent-services data folder and the conversation gets its opening and the file\'s path; the test-author lock denies another subagent\'s change to a test file an agent wrote in this session and, where the served rules hide test reads (product accounts: only in a project whose .agent/test-lock.json sets "hide_tests": true), another subagent\'s reads of it (a Glob, or a Grep over a folder, is not checked); a requirements file the served rules name (agent-requirements.md on product accounts), locked by a marker line among its opening lines that the served rules also give ("Status: locked" on product accounts; a file marked "Status: draft" is not locked), takes only an amendment appended at its end by the main conversation (never a shell command); on an account whose served rules include the commit check (not product accounts), a commit whose Co-Authored-By names another model than the agent runs on is denied; when the calls of the main conversation in one turn reach a count or a result size the served delegation table names, the result gets the note of that table suggesting a subagent for such work (counted in memory only). None of this sends anything.' +
      ' Run limits (signed in, not at methods level off): the first foreground Bash or PowerShell call of the main conversation with a command head from the public list asks the service about that head, once per head and session (only the head is sent; it waits at most 1 second, then goes on without an answer); when the answer says such commands are better run in the background, its note is added once to the result of a call with that head.' +
      ' Just-in-time items (signed in, not at methods level off, main conversation): the first edit of a UI file, or a write of agent-state.md that makes it running, adds plan steps or checks every step done, asks the service once per moment and session for that moment\'s items (only the event name is sent; agent-state.md is read on this computer before and after the write); the labelled note goes with this call\'s result when it comes within 1 second, else with a later one.' +
      ' Background jobs (signed in): a subagent, workflow or shell command started in the background gets a row in the project\'s .agent/jobs.json; TaskStop marks it cancelled, a SendMessage to a finished or stalled one marks it running again, and a subagent\'s tool calls count as its signs of life (written at most every 30 seconds). Nothing of it is sent.' +
      ' The acceptance lock: it denies a subagent\'s Edit, Write, MultiEdit or NotebookEdit of a file its own brief names on ' +
      'an "acceptance:" line. The evidence gate: after a Bash or PowerShell call it keeps, in the project\'s ' +
      '.agent/evidence.json, a receipt for each test, lint, type-check or build command (or a job\'s declared check): when ' +
      'it ran, which agent ran it, the program name, whether it passed, and a hash of the command; no arguments or output. ' +
      'After an edit tool call it keeps only the time of the last edit.' +
      ' Write ownership (signed in): a subagent\'s Edit, Write, MultiEdit or NotebookEdit of a file that an open background job of another agent claims in .agent/jobs.json (its brief\'s owns: line) is denied with that job\'s id and title; the main conversation\'s edit of such a file only gets a note. A closed job, a job of this session that Claude Code no longer shows at work, a job of another session quiet for 30 minutes, an agent the plugin cannot place, the claiming agent\'s own parent or child, and a path outside the project never deny. Bash is not checked. When the last of two or more writer jobs that ran together ends, its task notification gets a note to run the checks on the combined result first. Nothing is sent.' +
      ' The path (never the content) of each file an edit tool changed is kept in memory for the handover file.' +
      ' Stuck work (signed in): when a block of up to 3 calls with the same tool and arguments repeats 3 times in a row, ' +
      'the call\'s result gets a note (a stronger one at the next such pattern, then none); after an Agent call, when two ' +
      'runs of the same brief failed within 2 hours, a line after the routing line names the next model tier (no model is ' +
      'changed; not at routing off). While a model\'s circuit is open (two rate-limit or server failures of its ' +
      'subagents within 5 minutes), that line also names the tier to use instead and when one probe may go; no model ' +
      'is changed. Kept in memory; nothing is sent.' +
      ' Change budget (signed in): a subagent\'s Edit, Write, MultiEdit or NotebookEdit is denied once its turn has changed ' +
      '12 files, made 24 edits or written 256 KiB of new text. A file already changed this turn adds no file. A single ' +
      'call larger than a whole limit passes on a fresh turn. The main conversation is never refused; it gets one note per ' +
      'limit and turn, and one note when one of its subagents was stopped. At the 40th state-changing call of a turn ' +
      '(edits, shell commands that may write, tool calls that create, send or delete), one suggestion to checkpoint.' +
      ' Signed in, each deny or hold of this hook, of the command guard and of the agent.spawn checks of this plugin is ' +
      'appended to the project\'s .agent/audit.jsonl (rule, tool, ids and a keyed hash of the input; never the command, ' +
      'path or text). A background subagent\'s refusal by this hook or agent.spawn also tells it to write the request under "Deferred" in its report, ' +
      'and records a question for the user in the task state. Nothing is sent.',
    shown: 'The deny reason, which starts with "agent-services planning gate", "agent-services test lock", "agent-services acceptance lock", "agent-services write ownership", "agent-services change budget" or "agent-services requirements lock".',
  },
  {
    event: 'tool.call', matcher: 'tool: mcp__agent-services__<tool>', file: 'tools.ts', does: ['answer', 'network'],
    what: 'Answers this plugin\'s own tools: savings, toolbox and status (toolbox sends only the session id, the pack key and the optional topic).',
    shown: 'The tool call and its answer.',
  },
  {
    event: 'tool.describe', matcher: 'tool: mcp__agent-services__<tool>', file: 'tools.ts', does: ['answer'],
    what: 'Keeps this plugin\'s own tools savings, toolbox and status deferred: Claude loads them through tool search when needed.',
    shown: 'Nothing.',
  },
  {
    event: 'tool.describe', matcher: 'tool: mcp__agent-services__setup', file: 'command.ts', does: ['answer'],
    what: 'Keeps the setup tool deferred: Claude loads it through tool search when needed.',
    shown: 'Nothing.',
  },
  {
    event: 'tool.call', matcher: 'tool: mcp__agent-services__setup', file: 'command.ts', does: ['answer', 'network', 'file'],
    what: 'Runs one subcommand from a fixed list with the answer you gave (sharing, methods, routing, models set and models clear, update, info); ' +
      'a choice-changing one only in the main conversation of a session you are at. "setup" shows the next open setup ' +
      'question in Claude Code\'s own dialog (main conversation, a session you are at) and applies only what you pick ' +
      'there. It also answers what you ask Claude for: the status report, the self-check, the background jobs, and ' +
      'what your company admin sees about you. It never turns the savings upload on by itself: only your own pick ' +
      'in its dialog or your own command does.',
    shown: 'The tool call and its answer.',
  },
  {
    event: 'command.run', matcher: 'command: agent-services', file: 'command.ts', does: ['answer', 'network', 'file', 'ui', 'process'],
    what: 'The /agent-services slash command. inbox: what waits for you: decisions, results to confirm, failures and ' +
      'finished work, read on this machine. `audit` answers on this machine. company and members are for your ' +
      'company\'s admin only.',
    shown: 'Its answer.',
  },
  {
    event: 'turn.complete', matcher: '', file: 'register.ts', does: ['network', 'file', 'process', 'ui'],
    what: 'Asks the service whether this is a good moment to compact (counters only). Refreshes the usage panel\'s ' +
      'figures at most every 10 minutes, running the usage scan tool at ~/.agent-services/tools/usage_scan.py first ' +
      'when it is there (in the background, at most every 15 minutes, nothing sent). Keeps your private ' +
      'savings page (and a company admin\'s board) current, only when you allowed it: the page is published once ' +
      'with Claude Code\'s Artifact tool, then its figures are written to the page\'s own data with the ' +
      'ArtifactData tool, which does not publish the page again. ' +
      'Once a day, a session left open sends the daily usage summary of the new day (only while the savings record ' +
      'is on). ' +
      'After a main turn it also runs the compaction of a checkpoint marked in it, reads .agent/pending.md and ' +
      'the plan steps in the project (the ## Plan step lines of agent-state.md first, the old .agent/steps.json only when there are none), and keeps a note for the next turn when steps are ready to start but ' +
      'fewer subagents were dispatched, or when a foreground call ran longer than the served time.' +
      ' Signed in: a main turn whose first request read far less from the prompt cache than the previous request held ' +
      'gets one dim line with the tokens billed again, an estimated extra cost and the likely cause; a subagent run ' +
      'that answers closes its model\'s half-open circuit. Memory only.' +
      ' Signed in: after a turn that ran state-changing calls, a snapshot of the working tree (git, in the background).',
    shown: 'The Artifact or ArtifactData call. The open count on the status line.',
  },
  {
    event: 'tool.check', matcher: 'tool: Artifact, ArtifactData', file: 'register.ts', does: ['answer'],
    what: 'Allows this plugin\'s own savings-page publish and its writes of the page\'s figures without a ' +
      'permission prompt once you allowed it. A deny from your own rule or hook stands; every other Artifact or ' +
      'ArtifactData call goes on unchanged.',
    shown: 'The permission reason "agent-services savings page (user allowed)".',
  },
  {
    event: 'prompt.submit', matcher: '', file: 'register.ts', does: ['drop', 'context', 'rewrite', 'file', 'ui'],
    what: 'Drops a message that is only a sign-in code while a sign-in waits for one, and finishes the sign-in with ' +
      'it, so the code never reaches the model. Adds context blocks for the model, after your text and without ' +
      'changing it: the service\'s compaction advice, the working methods of the current phase (in full once per ' +
      'session, and again only after /clear, a compaction, a phase change or a new served version; nothing on ' +
      'other prompts), the toolbox index (the list of toolbox packs, fetched once per session with the first prompt, sending only the session id and the key index; in full once per ' +
      'session and again only after /clear or a compaction; not at methods level off), and the plugin ' +
      'notes (a newer version, changed methods to sum up for you, and unfinished setup once per 7 days), the ' +
      'fully-automatic default note (one line with the working methods), one ' +
      'planning reminder at methods level ' +
      'suggest and, unless the methods level is off, a reminder to run long work in the background and the steps ' +
      'of the plan ready to start (the ## Plan step lines of agent-state.md, or the old .agent/steps.json when there are none), the just-in-time items that are due (a resumed session, a new module or every plan step done in agent-state.md, read on this computer; the service gets only the event name, once per moment and session), and once per session the hint the routing service sent for a subagent ' +
      'without a task type word, each labelled as an agent-services note. It notes locally whether ' +
      'your message asks for a review (the routing request carries only yes or no). ' +
      'With the served rule tables (signed in): choices kept for an earlier account of the same person may be moved to the signed-in account, and a one-line notice is shown once if a choice kept for another account was not moved; secrets in your prompt (API keys, tokens, private keys, passwords after key= or --password) are replaced by {{secret:NAME}} placeholders before the model sees them; the real values stay in memory for this session only, never written or sent. A long background subagent report is shortened the same way as in tool.call, and the shell watch adds its usage-limit alerts for the main conversation. A task notification closes its background job in the project\'s .agent/jobs.json, and a main prompt gets a note naming the jobs of this session whose status changed since the last prompt (not for the notification\'s own job). Once per conversation (and again after a compaction): a note ' +
      'pointing at the project\'s .agent/handover.md when it lists open work, and naming the jobs stopped because ' +
      'their session ended. Signed in: notes when you last wrote (in the plugin store, key reach_gate) so no alert ' +
      'interrupts you while you are here. After you were away for 20 minutes or more, adds one note listing what waits ' +
      'for you (decisions, results to confirm, failures, finished work), the same list as /agent-services inbox. The ' +
      'main conversation\'s change-budget notes (tool.call) that have not reached it yet come with its next prompt.',
    shown: 'A dropped code: a toast and the sign-in answer in its place. A new served methods version: a line and ' +
      'a toast, once. The context blocks are not shown.',
  },
  {
    event: 'session.compact', matcher: '', file: 'register.ts', does: ['count', 'ui', 'file'],
    what: 'Counts the compaction and its token saving locally; after a real compaction of the main conversation ' +
      'the working methods are given again at the next prompt. Signed in, before a compaction of the main ' +
      'conversation: writes .agent/handover.md in the project (open jobs, open task-state items, the files changed ' +
      'this session and the next step, as ids, titles, statuses, paths and counts; no prompt text or file contents).',
    shown: 'A dim line now and then.',
  },
  {
    event: 'command.run', matcher: 'command: clear', file: 'register.ts', does: ['count', 'ui'],
    what: 'After /clear: starts the counters over and gives the working methods again at the next prompt.',
    shown: 'A dim line now and then.',
  },
  {
    event: 'classic.SessionEnd', matcher: '', file: 'register.ts', does: ['file', 'ui'],
    what: 'Writes the request log and the counters before the session ends. Signed in: records that this session ' +
      'ended (plugin store, key resume_live) and writes .agent/handover.md in the project when there is open work. ' +
      'Background shell commands of the session still open are listed (nothing is stopped).',
    shown: 'A session summary toast.',
  },
  {
    event: 'ui.render', matcher: 'component: AbovePrompt', file: 'band.ts', does: ['ui'],
    what: 'Draws above the prompt: a top row with the actions waiting for you (.agent/pending.md) and the ' +
      'connection state (with this session\'s check gate line and the background jobs line when there is one), one dim line (sign-in state, savings) and, while figures show, a usage panel (tokens, quota ' +
      'and context, time saved). While setup questions are open the line says how many and ' +
      'asks you to ask Claude to finish setup instead (at most once every 7 days after they were last asked); the ' +
      'questions are asked only in Claude Code\'s own dialog.',
    shown: 'The band itself.',
  },
  {
    event: 'tool.call', matcher: 'tool: mcp__agent-services__checkpoint', file: 'flow.ts', does: ['answer', 'ui', 'context'],
    what: 'Answers the checkpoint tool (main conversation only): once that reply ends, it compacts the conversation ' +
      'with instructions that keep what the model listed, then, when the model gave a next step, sends that step ' +
      'as a message from this plugin. Nothing is compacted after an interrupted turn, and nothing is sent once you ' +
      'wrote a message yourself.',
    shown: 'The tool call, a dim line after the compaction, and the plugin\'s message with the next step.',
  },
  {
    event: 'tool.call', matcher: 'tool: Agent, Task, SendMessage', file: 'concurrency.ts', does: ['deny'],
    what: 'Before the main conversation dispatches a subagent (or sends new work to a running one), looks for a ' +
      'concurrency plan in its recent replies or agent-state.md (Task | Depends on | Owns | How it runs). Without ' +
      'one it refuses that dispatch once, with the format and an example; a description or prompt starting with ' +
      '"single use:" skips the check, and read-only fetch or search helpers are not checked. Sends nothing.',
    shown: 'A refused dispatch with the plugin\'s note; sending the same call again goes through.',
  },
  {
    event: 'classic.Stop', matcher: '', file: 'register.ts', does: ['deny'],
    what: 'With the served rule tables (signed in): when a main turn ends on a promise of more of its own work and ' +
      'nothing is running in the background to wake it, it is sent back once to do that work. Runs locally; sends nothing.',
    shown: 'The reason the turn was sent back, as the model\'s next instruction.',
  },
  {
    event: 'session.append', matcher: '', file: 'register.ts', does: ['rewrite'],
    what: 'With the served rule tables (signed in): a secret in any kept conversation row is masked, and a task ' +
      'notification read mid-turn closes its background job. Nothing is kept or sent.',
    shown: 'Nothing; the transcript keeps the masked rows.',
  },
  {
    event: 'tool.call', matcher: 'tool: Bash, PowerShell', file: 'cmdguard.ts', does: ['deny', 'file'],
    what: 'With the served rule tables (signed in): a find, grep -r, rg or ls -R, or a PowerShell Get-ChildItem ' +
      '-Recurse (gci, dir, ls), whose path argument is a whole drive or the home folder, and a `cat >` with no input ' +
      'are denied (a drive reached through an earlier cd is not seen), and a git command that takes every changed file is denied ' +
      'while other agents are running; each denial says how to write the command instead, and is appended to the ' +
      'project\'s .agent/audit.jsonl (never the command). Runs locally; sends nothing.',
    shown: 'The denial reason.',
  },
  {
    event: 'tool.call', matcher: 'tool: mcp__agent-services__task_state', file: 'engines.ts', does: ['answer', 'file'],
    what: 'Answers the task_state tool: reads and writes this project\'s .agent/task-state.json and .agent/task-state.md ' +
      '(tasks, side effects recorded so they never run twice, questions waiting for you, placeholders, structured ' +
      'questions (options, the answer the agent prefers, why, whether it needs you), subjects the ' +
      'watchdog leaves alone). Its plan ops write the goal and steps of agent-state.md; decide, lesson and ask append ' +
      'one line to the decisions file, .agent/lessons.md and .agent/pending.md, never rewriting old lines; deliver ' +
      'also returns a draft report from git diff --stat and these records. Only the main conversation can change it; ' +
      'delivery is refused while a placeholder is open or its marker is still in a recorded file. Answered on this ' +
      'machine; nothing is sent.',
    shown: 'The tool call and its answer.',
  },
  {
    event: 'tool.call', matcher: 'tool: mcp__agent-services__undo', file: 'engines.ts', does: ['answer', 'file', 'process'],
    what: 'Answers the undo tool (main conversation only, signed in or not), for when you ask Claude to rewind files: ' +
      'lists the working-tree snapshots of this git repository, or shows what restoring one would change. Only a ' +
      'restore of a snapshot shown that way in this session changes files: the current state is saved as a snapshot ' +
      'first, files git tracks are never deleted, and files changed after the next snapshot stop it unless they are ' +
      'left as they are. It runs git on this machine; nothing is sent.',
    shown: 'The tool call and its answer.',
  },
  {
    event: 'tool.describe', matcher: 'tool: mcp__agent-services__undo', file: 'engines.ts', does: ['answer'],
    what: 'Keeps the undo tool deferred: Claude loads it through tool search when needed.',
    shown: 'Nothing.',
  },
  {
    event: 'turn.start', matcher: '', file: 'engines.ts', does: ['count'],
    what: 'Notes when the main conversation\'s turn started and its id, in memory only, so the watch tick can stop one ' +
      'tool call that runs past the served limit (20 minutes), and starts the watch tick (signed in) if it is not ' +
      'running yet. Starts the agent\'s change budget for the turn (in memory). Changes nothing and sends nothing.',
    shown: 'Nothing.',
  },
  {
    event: 'tool.check', matcher: '', file: 'engines.ts', does: ['count', 'file'],
    what: 'After the permission verdict of a tool call: a call that waits on your answer in the permission question ' +
      'is no longer timed by the stuck-work watch, in memory only. A background subagent\'s question is settled with nobody ' +
      'asked, so it never marks the job as waiting on you in the project\'s .agent/jobs.json. Changes no verdict and sends nothing.',
    shown: 'Nothing.',
  },
  {
    event: 'tool.call', matcher: 'tool: Bash, PowerShell, Monitor', file: 'watch.ts', does: ['context'],
    what: 'With the served rule tables (signed in): ' +
      'the call itself is never changed. When Claude Code moves a foreground Bash or PowerShell command to the ' +
      'background (at the timeout of that command), the model is told the task id and output file and the task is ' +
      'watched; this applies to the shell commands of a subagent too. ' +
      'A Bash or PowerShell command the agent starts ' +
      'with run_in_background is remembered too: when its output file has stood still for the served time, the model gets ' +
      'one reminder naming the task id and output file (repeated on the same schedule as for a moved command); it is never ' +
      'stopped. Sends nothing.',
    shown: 'A note to the model with the task id; for a command started with run_in_background, a reminder later.',
  },
  {
    event: 'classic.Stop', matcher: 'stop_hook_active: [true, false]', file: 'watch.ts', does: ['deny', 'context', 'file', 'ui'],
    what: 'With the served rule tables (signed in): when a turn stops with a moved command still running, the model ' +
      'is asked once whether it is stuck; background tasks still running past the served time are named to the main ' +
      'conversation so ones no longer needed get stopped. In fully automatic work (the default), when nothing ' +
      'earlier sent the stop back and the task state has open steps, the model is asked once whether everything that ' +
      'can be done without you is done (at most 3 times per prompt of yours, 10 per session; never on a stop already ' +
      'sent back). The watch tick also stops one tool call running past the served limit (never a command the agent started ' +
      'with run_in_background) and asks the agent whether it ' +
      'was stuck. Signed in, every automatic continuation (this stop\'s send-back and the idle one) is also capped at 5 per ' +
      'prompt of yours, never follows a turn you interrupted (until you write again) and the idle one never a turn ' +
      'that ended on an error. ' +
      'The watch tick also sends one notification when a background job, a question or a task has waited for you for ' +
      'more than 5 seconds and you have not written in the last 3 minutes. Every alert of the plugin goes through one ' +
      'gate: at most 20 a day, one per subject per 30 minutes, none while you are here, and never more than 120 ' +
      'characters of a question; a call the plugin stopped is always told (none of those three limits apply). The ' +
      'prompts the plugin submits itself never count as yours, so they do not reset the caps above. ' +
      'Sends nothing to the service.',
    shown: 'A note to the model; a notification when a call is stopped; a notification when something waits for you.',
  },
  {
    event: 'classic.SubagentStop', matcher: 'stop_hook_active: [true, false]', file: 'watch.ts', does: ['deny', 'context', 'file'],
    what: 'The same check as classic.Stop, for a subagent that stops with a moved command still running. A stop that is not ' +
      'sent back marks the subagent\'s background job done (not checked yet) in the project\'s .agent/jobs.json, then ' +
      'verified when the job\'s declared check passed after its last edit, and writes the ended agent\'s ' +
      'transcript path into its row. Sends nothing.',
    shown: 'A note to the subagent.',
  },
  {
    event: 'tool.describe', matcher: 'tool: /^mcp__/', file: 'cache_break.ts', does: ['count'],
    what: 'Notes the names of MCP and plugin tools as Claude Code first lists them in the prompt (not those behind ToolSearch), in memory only, so a tool that joins the list after the first request ' +
      'can be named as the likely cause of a prompt-cache break. Changes no description and sends nothing.',
    shown: 'Nothing.',
  },
  {
    event: 'classic.StopFailure', matcher: 'error: rate_limit', file: 'watch.ts', does: ['context'],
    what: 'With the served rule tables (signed in): a turn that ended at the usage limit is told to carry on later, ' +
      'on the served schedule. Sends nothing.',
    shown: 'A message to the model when it may carry on.',
  },
]

export const HOOKS_ALSO =
  'Not hooks, also used: the status line ($.ui.status; with the count of open lines in .agent/pending.md), timers (the request log is written every 5 seconds; the ' +
  'update check; with the served rule tables, a check every few seconds that asks the main conversation about ' +
  'background tasks running past the served time and carries on after a usage limit), and questions in Claude Code\'s own dialog (sign-in, the setup questions Claude starts).'

export const HOOKS_COUNT_NOTE =
  'These are function hooks in Claude Code\'s hooks module (hooks.json names register.ts under "modules"). ' +
  '/reload-plugins counts only command hooks, so it shows 0 hooks for agent-services: that is expected, not a fault. ' +
  'This list is answered by the loaded hooks module, so its hooks are registered in this session.'

export function hooksStatusLine(infoCommand: string): string {
  return `Hooks: ${HOOKS.length} active as function hooks in Claude Code's hooks module. /reload-plugins shows 0 hooks ` +
    `for agent-services because it counts only command hooks; that is expected. ${infoCommand} lists them.`
}

export function hooksText(): string {
  const rows = HOOKS.map((h) =>
    `- ${h.event}${h.matcher ? ` (${h.matcher})` : ''}: ${h.what} It ${h.does.map((d) => HOOK_EFFECTS[d] ?? d).join(', ')}. ` +
    `Shown: ${h.shown}`)
  return `The hooks this plugin registers in Claude Code (${HOOKS.length}):\n${rows.join('\n')}\n${HOOKS_ALSO}\n${HOOKS_COUNT_NOTE}`
}

export function hooksSummary(fullCommand: string): string {
  const rows = HOOKS.map((h) => `- ${h.event}${h.matcher ? ` (${h.matcher})` : ''}: ${h.does.join(', ')}`)
  const legend = Object.entries(HOOK_EFFECTS).map(([k, v]) => `${k} ${v}`).join('; ')
  return `The hooks this plugin registers in Claude Code (${HOOKS.length}), each with what it may do:\n${rows.join('\n')}\n` +
    `Key: ${legend}.\n${HOOKS_COUNT_NOTE}\n${fullCommand} shows what each hook does and what you see when it acts.`
}

export function spawnLine(a: { action?: unknown; set?: { model?: unknown; effort?: unknown } | null; notice?: unknown } | null): string | null {
  if (a?.notice === '') return null
  const notice = typeof a?.notice === 'string' && a.notice ? a.notice : null
  const model = a?.action === 'rewrite' && typeof a.set?.model === 'string' && a.set.model ? a.set.model : null
  if (!model) return notice
  const effort = typeof a?.set?.effort === 'string' && a.set.effort ? ` at ${a.set.effort} effort` : ''
  const line = `agent-services: this subagent runs on ${model}${effort}, set by agent-services routing.`
  return notice && notice !== receiptText('route') ? `${line}\n${notice}` : line
}

export function denyReason(reason: unknown, check = 'routing check'): string {
  const r = typeof reason === 'string' ? reason.trim() : ''
  if (r.startsWith('agent-services')) return r
  return r ? `agent-services ${check}: ${r}` : 'agent-services denied this call (no reason was given).'
}
