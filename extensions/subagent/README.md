# Subagent extension

Dispatch isolated Pi worker sessions for independent work: verification,
investigation, review, research, drafting, or bounded implementation. A worker
is a real pi session built inside the dispatching session — same models, same
tools, same transcript format — so it can be prompted, steered, and aborted
directly. Every worker runs in the background and writes a standard pi session
file. A terminal worker can continue in-process as a new linked worker, or
reopen as a primary session with `pi --session <file>`. Stored results (up to
50KB, with larger submissions marked `[truncated]`) persist in a private store
that any later session can read.

No gates, no enterprise controls, no supervisor, no daemon. The store is the
application's persistence authority; the parent's own tools manage workers.

## Version boundary

Pi's loader binds this extension's imports of `@earendil-works/pi-coding-agent`,
`@earendil-works/pi-agent-core`, `@earendil-works/pi-tui`,
`@earendil-works/pi-ai` and its `/compat`, `/oauth`, and `/providers/all`
subpaths, and `typebox` to the running installation. The extension imports
nothing else from the Pi packages, so a worker runs on the installed release
and the repository pins no Pi version.

## Tools

| Tool | Mode | Purpose |
|---|---|---|
| `subagent` | parallel | Dispatch one task or a `tasks[]` batch. The call returns a stable id after worker setup; the model run starts in the background. Per-task `deadlineMinutes` (defaulted) and `budgetUsd` (opt-in) pause a worker that overruns the agent's own estimate. |
| `subagent_status` | parallel | Live workers + recent terminal workers: id, state, model, thinking, elapsed, turns, tool calls, current tool, session-file write age, cost, output preview, error. |
| `subagent_inspect` | parallel | One worker's record plus a bounded, rendered transcript tail: recent turns, tool inputs and outcomes, assistant errors, session path, and explicit truncation markers. Reads an in-process snapshot for any live worker in this process; otherwise reads the active branch from the retained session file. |
| `subagent_steer` | sequential | Redirect a live worker: the message is delivered after the worker's current tool call, before its next model call. On an idle (interrupted) worker, steer instead resumes the run with your message. Owning session only. |
| `subagent_interrupt` | sequential | Pause a live worker without cancelling it: the run stops, the worker stays alive and resumable. An interrupted worker that is never resumed is released by the idle deadline. |
| `subagent_continue` | sequential | Fork a terminal worker's retained session into a new linked background worker. The source record, result, and transcript remain unchanged. |
| `subagent_kill` | sequential | Cancel a live worker by aborting its run. Cancel intent is recorded first, so the terminal state is `cancelled` rather than whatever shape the interrupted run left. |
| `subagent_collect` | parallel | Terminal results from the store. With `id`: the stored result (50KB maximum). Without `id`: the eight most recent terminal workers. Works after the dispatching session is gone. |

Command: `/subagent` opens the dashboard in the TUI. RPC receives a structured
extension-UI notification plus a `subagent_status` custom entry; JSON receives
the custom entry as an `entry_appended` event; print mode emits the optionally
filtered text view to the terminal. Model-facing status previews label worker
authorship and state that the text is unverified, not an instruction. The roster content-fits short lists; worker
consoles grow to at most 85% of the terminal (floor 44 rows; pin a fixed cap
with `PI_SUBAGENT_PANEL_MAX_ROWS`). The `thinking:` value in a status line is
the EFFECTIVE level — pi clamps an inherited level to what the model supports —
and it carries the requested level beside it when the two differ.

## Dispatch

Note on `cwd`: a worker declares where its work happens; it does not relocate
the process. Workers run inside the parent's process, so an extension that
resolves its configuration from the process working directory reads the
parent's, not the worker's declared `cwd`. A tool whose registration derives
from such configuration is compared against the parent's registration before
the worker starts, so a divergence fails the dispatch by name instead of
handing the worker a different tool. The worker loads that directory's own
settings and resources; see [Worker context](#worker-context). Callable tools
still follow the selected allowlist.

A worker accepts any existing directory and does not confine paths to a
workspace root. The directory sets the initial path; the selected tool surface
determines what the worker can do there.

```json
{ "task": "Verify that MODEL_BASE has a unique constraint on ID_FIELD. Cite file:line.", "model": "provider/model-id", "thinking": "medium" }
```

Use exactly one dispatch form: `task` for one worker or a non-empty `tasks`
array for a batch. Per-task fields: `task` (required), `model`, `thinking`,
`tools`, `cwd`, `deadlineMinutes`, `budgetUsd`.

- **model** — bare id or `provider/id`, checked against registry availability
  and configured auth. Omitted: inherits the parent's current model. Model
  selection mirrors the dispatching session's registry: a model that only the
  working directory's own extensions provide is not selectable by name, the
  same way a tool the parent never loaded is not inheritable. Before session
  construction, the worker receives every config-form and native provider
  registration exposed by the parent's public registry facade. After extension
  binding, the worker checks the selected model against its actual runtime and
  fails before provider work if resolution or auth changed. An extension may
  switch the session model during `session_start`; the worker record then names
  the model the run actually uses. The record also keeps the parent-resolvable
  bootstrap model. A continuation uses that bootstrap model to construct its
  target session. It keeps the source's active thinking level when the bootstrap
  model supports it, or uses Pi's closest supported level when it does not.
  Target `session_start` hooks can then select the actual model and thinking
  level again. Persisted and environment credentials resolve in workers. A
  parent-only runtime API-key override remains local to the parent's runtime.
- **thinking** — `off|minimal|low|medium|high|xhigh|max`. Declared: checked
  against the levels the model supports (pi's own
  `getSupportedThinkingLevels`); an unsupported level fails that task and names
  the supported set, because pi would otherwise clamp it silently and a model
  without reasoning support lands on `off`. Omitted: inherits the parent's
  current level, default `medium`, and pi clamps it. The record keeps both
  values — `thinking` is what ran, `thinkingRequested` is what was asked for —
  and every roster, dispatch, and result line shows the requested level when it
  differs.
- **tools** — omitted: the worker snapshots the dispatching session's current
  active tool surface. The dispatching session's live registry wins, and its
  session-keyed recorded surface is the fallback for a fresh module instance.
  A real session with neither source fails before worker creation; it never
  broadens to another session's registry. Reproduction is by registration
  source, so it covers built-ins and file-backed extension
  registrations, including a tool an extension registers from its
  `session_start` handler — the worker runs that handler too (see
  [Worker lifecycle](#worker-lifecycle)). Built-ins are rebuilt for the worker
  cwd, and extension registration files are reloaded from their registered
  source paths. Provided: exactly the
  declared set plus the disclosed `submit_result` protocol tool. A declared
  tool that is not in the current registry fails the dispatch with its name. A
  registration without a loadable source fails before worker creation. The
  worker's active names, registration sources, and public tool metadata are
  compared with the parent snapshot before any prompt token is spent. A
  mismatch names each changed metadata field and lists active tool names as a
  separate fact. If an extension source changed after the parent session loaded
  it, run `/reload` and retry. If no source changed, keep public registration
  metadata independent of the worker cwd and configuration.
- **cwd** — worker working directory. Omitted: session cwd.
- **deadlineMinutes** — how long this task should take, judged by the
  dispatching agent from the task it just wrote. Omitted: the
  `PI_SUBAGENT_DEADLINE_MINUTES` setting (default 30). `0` removes the deadline
  for a task expected to run long. Breaching it PAUSES the worker; see
  [Run-leg limits](#run-leg-limits).
- **budgetUsd** — optional dollar allowance for this task. Omitted: the
  `PI_SUBAGENT_BUDGET_USD` setting, which is unset by default — a budget applies
  only when the task or the operator asks for one. `0` removes it.

There is no foreground run mode. The dispatch call completes worker setup
trust resolution, resource loading, session construction, and extension start
and then returns the worker's id; the model run happens in the background.
Setup is awaited, so an extension whose start handlers never settle delays the
dispatch call, as it would delay any session start. An accepted worker remains
steerable and reports completion through a `subagent_result` follow-up.

An omitted `tools` array and an empty one are different: `tools: []` is a
declared, empty allowlist, so the worker gets `submit_result` and nothing else.
Omit the field entirely to inherit the parent's surface.

The subagent extension's own registration file is loaded into a worker whenever
its source resolves — it carries an internal post-submit compaction veto — but
it never expands the worker's active allowlist: pi filters registered
definitions down to exactly the declared surface, so a restricted worker sees
no subagent tools as callable. If the source cannot be resolved, the worker
runs without the veto and the dispatch reports that under `worker setup:`.

## Worker context

A worker's context is a session's context at its working directory. Pointed at
directory X, a worker loads what a session started in X loads: X's settings,
extensions, skills, prompt templates, and context files (AGENTS.md), plus the
global ones under the Pi agent directory (the agent directory itself and the
standard user roots pi reads, such as `$HOME/.agents/skills`). There is no
worker-specific context rule and no resource suppression; the worker does pass
two additions of its own, its registration file and the protocol prompt it
appends, which every session with those paths would carry.

Input uses pi's normal session methods. Dispatch and an idle resume use
`AgentSession.prompt` with its defaults: registered extension commands run,
loaded skill commands and prompt templates expand, and unmatched text passes
through unchanged. Registered commands receive print-mode UI behavior and real
`AgentSessionRuntime` actions for reload, new session, fork, tree navigation,
and session switch. A replacement session rebinds the worker's commands,
worker runtime, record, usage tracking, and lifecycle ownership. When a
command starts a turn through `pi.sendUserMessage()`, the worker waits for that
active turn before settlement. Active steering uses `AgentSession.steer`: skill
commands and prompt templates expand, while pi refuses an extension command
because that command cannot enter the steer queue.

Parity scope: a worker reproduces the working directory's own resources plus
the resources the dispatch carries (the parent's tool-registration files and
the worker protocol prompt). Process CLI inputs do not transfer to SDK-built
sessions: `--approve`/`--no-approve` trust overrides, `--no-*` resource flags,
CLI-only skill, prompt, theme, and extension paths, inline extension
factories, and the process trust cache are not exposed to extensions. For the
dispatching session's own directory the session's live trust decision does
transfer, session-only answers and overrides included. Any other directory
resolves trust from scratch, the way a session started there does.

Pi does not expose a parent SDK session's `agentDir` through
`ExtensionContext`, through the installed release. An SDK host that passes a custom `agentDir` must set
`PI_CODING_AGENT_DIR` to the same directory before it loads this extension.
Without that process setting, workers use Pi's process agent directory instead
of the SDK-only value. Normal Pi CLI sessions already use the process value.

Extension files the parent's tool surface inherits are loaded the way CLI
`--extension` paths load in any session: they run in the pre-trust bootstrap,
so their `project_trust` handlers participate in the target directory's trust
decision, exactly as they would if that session had been started with those
paths on the command line.

Project trust is resolved the way Pi resolves it. A directory with no
trust-requiring project resources is trusted outright. Any other directory
starts untrusted, and the decision is made while its resources load, in Pi's
order: the `project_trust` extension handlers, then the saved decision in the
project trust store, then the global `defaultProjectTrust` setting. `ask` needs
an operator and a background worker has none, so its trust context reports no
UI and an otherwise undecided directory stays untrusted — the same answer Pi's
non-interactive modes reach. Trusting a directory once, from any session,
trusts it for workers there too.

An untrusted directory withholds exactly what Pi withholds from any session
there: project extensions, project skills, project prompt templates and themes,
and project settings. Context files are not trust-gated, so they still load.

Pi reports non-fatal setup problems instead of printing them, and a worker has
no startup surface of its own, so the dispatch reports them: unreadable
settings, an extension that failed to load, and a provider registration that
threw are listed as `worker setup:` on that worker's dispatch line, repeated on
a continuation's result line, and kept in its record as `setupDiagnostics`.
The retained list has entry and UTF-8 byte bounds. The record keeps the number
of diagnostics omitted beyond those bounds as `setupDiagnosticsDropped`.

## Worker lifecycle

- Dispatch returns a stable `bg-*` worker id once worker setup completes; the
  model run never blocks the parent tool call.
- A worker runs the extension lifecycle a primary session runs. pi emits
  `session_start` from `AgentSession.bindExtensions`, which only the
  interactive, print, and rpc modes call, so a session built through the SDK
  alone never starts its extensions: an extension that opens session-scoped
  resources in the documented `session_start` hook would hand the worker a
  registered tool with nothing behind it (a gateway tool whose pool never
  opened). The dispatcher binds the worker's extensions after construction and
  emits `session_shutdown` before disposal, so those resources open and close
  with the worker. Workers have no operator UI, so extensions see Pi's no-op UI
  context and `print` mode. Registered commands use Pi's real
  `AgentSessionRuntime` session-control actions.
- Each worker is an `AgentSession` constructed in this process. Live status
  (turns, usage, cost, current tool, output) comes from the worker session's own
  events; steering and abort are direct calls on it. Nothing is scraped. Every
  terminal path shuts down the worker runtime and disposes the underlying
  `AgentSession` through one exact-once owner, so Pi's per-session resources are
  released after terminal evidence is persisted.
- The worker's deliverable is written by its `submit_result` tool to
  `result.txt` through an atomic first-writer claim, and the tool then ends the
  worker's run. A second submission fails without replacing the accepted result,
  and every temporary write is removed.
  The write is capped at 50KB of UTF-8 including a `[truncated]` marker. The
  parent never extracts results heuristically.
- The worker system prompt states the deliverable protocol and three disclosure
  rules. A tool that fails with an environment, authorization, or initialization
  error must be named with its exact error. An alternative must already be
  authorized by the task and environment; another account, credential, or
  privileged path is prohibited. The worker states the non-secret alternative
  it used. Cached or exported evidence carries its age rather than standing in
  for current state. A worker that cannot finish submits what it established and
  names the blocker. The extension captures the friction signal (`toolErrors`)
  and leaves the judgment call with the operator.
- A worker should call `submit_result` alone in its final turn. If it is
  batched with a sequential tool such as `subagent_steer`/`subagent_kill`, the
  sibling call can be dropped on abort, leaving an unanswered toolCall in the
  worker's session file.
- Completion is persisted before any notification. While the owning session is
  alive, a natural completion or failure delivers a `subagent_result` message
  to that session (follow-up; triggers a turn when idle). For a grandchild, the
  owning worker receives the message, resumes, and can collect the result.
  Explicit cancellation returns its outcome through
  the cancel action and does not enqueue a duplicate follow-up.
  `notificationCallReturnedAt` records only that the owning session's
  synchronous `sendMessage()` call returned. Pi observes asynchronous
  delivery failures internally, so the marker proves neither queue acceptance
  nor later processing. A top-level owner displays the message when it goes
  idle. A worker owner processes it as a follow-up turn when it goes idle.
  `subagent_status` and `subagent_collect` do not cancel the delivery attempt.
  If Pi processes it later, the result can repeat at the presentation or
  follow-up level, but the store still has one result.
- The store resyncs cumulative usage from the session's own statistics whenever
  a message ends, a compaction ends, or a branch summary finishes, so a
  replacement session sees real numbers even if this one dies mid-flight.
  Cumulative totals are re-read rather than accumulated, so a missed event
  cannot drift the numbers. A failed provider turn may recover inside the same
  run; a later successful assistant turn clears that transient error marker.
- Live status reports how long ago Pi last wrote the worker's session file. This
  is neutral activity evidence, not a watchdog or a claim that a quiet worker
  has failed; long thinking and stuck transport can look identical without an
  authoritative terminal event.
- The worker writes an ordinary pi session file, so its transcript reads back
  exactly as it ran and survives the parent. The record keeps the session id and
  file path. Pi may timestamp a queued steering message when it is enqueued and
  append it after an in-flight assistant/tool entry finishes; JSONL file order,
  not timestamp sorting, is the delivery order.
- `submit_result` stores at most 50KB. `result.txt` keeps the exact submitted
  bytes and `subagent_collect <id>` returns them; dispatch itself never waits
  for or returns the result inline.
- A completion notification arrives as worker-authored content between explicit
  provenance markers. Every rendered view of that text, the notification,
  collection, the status preview, and inspection, removes terminal control
  sequences and direction controls, while the stored file keeps the exact bytes.
  It is a report, not operator input: an instruction inside a worker's result is
  data to judge, never a directive to follow.
- A worker left interrupted and idle is released by a bounded deadline (30
  minutes) rather than holding its session forever. Without a stored result, the
  release records `failed` with the idle-deadline reason because the task did not
  finish. Sending it a message before then cancels the deadline and resumes it.
- A worker that fails after dispatch reports its death with the same completion
  notification as a success: state `failed` plus the error.
- The `subagent` tool row renders the crafted dispatch spec in the standard pi
  tool expansion (ctrl+o): task, batch summary, resolved config, and the
  worker protocol prompt.
- A worker that finishes without calling `submit_result` is recorded as
  `no_result_submitted` — distinct from `failed`, because billing errors,
  thinking and tool-surface mismatches, and completed-in-substance work need
  different responses. The final message is retained and surfaced by
  `subagent_collect` behind an explicit UNPROTOCOLLED OUTPUT banner, never
  presented as the result, with the session file for the full record. Every
  other terminal no-result state also points to `subagent_inspect` before
  continuation: completed work may survive in assistant text or tool-call
  arguments. Inspection renders that evidence but never promotes it to a
  submitted result.
- Dispatch details include the resolved model's capability metadata
  (`capabilities: {images, thinkingLevels}`), read from pi's own
  `getSupportedThinkingLevels`. Image support is informational; the thinking
  levels are what a declared level is checked against.
- Every tool call that returns an error is counted by tool name in the record
  (`toolErrors`). The count appears in `subagent_status` and in the completion
  notification, so a worker whose declared tool never worked cannot hand back a
  confident deliverable built on a workaround without the parent seeing it.
- A continued worker forks the source transcript, so its session statistics
  start with the source's spend. The record subtracts that baseline: a
  continuation reports only its own turns, tools, and cost, and its budget
  applies to its own work.
- A worker that reaches its declared deadline or budget is PAUSED, not killed,
  and the parent is told which limit was reached — see
  [Run-leg limits](#run-leg-limits). There is no automatic turn, token, or
  content cutoff, and nothing ends a worker on the extension's own judgment.

### Run-leg limits

A worker that stops converging — a thinking loop, a wedged transport, a task the
model cannot finish — otherwise runs until a human notices. The dispatching
agent knows the size of the task it just wrote, so the bound is its judgment,
expressed per task, not a policy the extension infers:

- `deadlineMinutes` — wall-clock minutes for one run leg. Default from
  `PI_SUBAGENT_DEADLINE_MINUTES` (30). `0` disables it.
- `budgetUsd` — dollars for one run leg. Opt-in: default from
  `PI_SUBAGENT_BUDGET_USD`, which is unset, so no worker carries a budget unless
  the task or the operator declares one.

Both are per **run leg**, not per worker lifetime. A leg opens when the worker
starts and when a paused worker is resumed: the deadline counts from that
moment and the budget from the spend already on the record, so resuming grants a
fresh allowance instead of re-breaching immediately.

On breach the worker takes the ordinary interrupt path — the run stops, the
session stays alive, resumable, with its transcript intact — and the parent
receives a `subagent_paused` message naming the limit, the elapsed time, the
spend, and the last tool. The record shows `interrupted (deadline 30m reached)`
in status. The parent then decides: inspect it with `subagent_inspect`, resume
it with `subagent_steer` (a fresh allowance), or end it with `subagent_kill`. A
pause left unresumed is released by the interrupted-idle deadline like any
other paused worker.

On Pi 0.85.0, threshold compaction can run inside one run leg before the next
assistant response. Its summary cost counts toward that leg's budget.

The budget is evaluated when the worker's usage lands (message end, compaction
end), which is the only moment spend is knowable; the deadline runs on its own
timer. Neither samples a clock in a loop, and neither ends a worker.

### Nested dispatch (a worker dispatching its own workers)

A worker whose active surface includes `subagent` can dispatch its own workers.
The same contracts apply at every depth:

- Omitted `tools` inherits the dispatching worker's current active surface,
  exactly, plus `submit_result`. It never broadens to the root surface. The
  worker's session-keyed recorded surface lets a fresh per-CWD module instance
  reproduce the registry when its live API is unavailable.
- The dispatching worker session owns its nested timers, delivery API, and
  workers. Its `session_shutdown` aborts and finalizes unfinished
  grandchildren and removes its recorded surface. One worker
  session cannot close another worker session's resources, even when both use
  the same module instance.
- A completed grandchild sends `subagent_result` to the worker that dispatched
  it. That worker receives a follow-up turn and can call `subagent_collect`.
  Owner shutdown removes the delivery API before aborting grandchildren, so an
  `owner_lost` settlement never starts a new turn in a session being disposed.

## Continuing a terminal worker

`subagent_continue` and the dashboard's `r continue` action create a new worker
from a terminal worker's retained Pi session. Continuation is supported for
`done`, `cancelled`, `failed`, `no_result_submitted`, and `owner_lost` records
when `sessionFile` still exists.

The continuation contract is evidence-preserving:

- the source worker remains terminal and its `worker.json`, `result.txt`, and
  session file are not rewritten;
- `SessionManager.forkFrom(...)` creates a new session id and file containing the
  preserved history, with Pi's `parentSession` link to the source file;
- the new worker gets a new `bg-*` id, result file, ownership metadata, and
  `continuedFrom` link;
- the parent-resolvable bootstrap model, tool surface, cwd, and run limits carry
  from the source and are revalidated against the current session before
  provider work starts;
- the source's active thinking level carries when the bootstrap model supports
  it; otherwise Pi's closest supported level starts the session;
- target `session_start` hooks can select the source's actual target-only model
  and thinking level again;
- the continuation message is the new worker's task, and normal notification,
  collection, cancellation, and provenance rules apply.

A running worker is not continued: steer it while active, or interrupt it and
resume by typing. Copying the shell-safe `pi --session '<file>'` command remains
the portable fallback for a terminal worker.

## Inspecting a worker

Use `subagent_inspect {"id":"bg-..."}` to check a worker's actual work. The
result includes record state, the session path, and the most recent transcript
items in human-readable form; the extension converts the session's messages to
its own transcript items. It shows thinking, tool-call inputs,
tool outcomes, and assistant errors. The transcript tail is capped at 24KB and
32 items; older or oversized content produces an explicit truncation marker.
Retained inspection follows the session file's active branch and excludes
abandoned branches. Whenever the worker is not live in this process, including a
live worker owned by another session, the extension reads that session file
directly. Pi's `SessionManager` parses every entry of that file before it
selects a branch, so the caps above bound the rendered tail, not the read: a
large retained session costs its full parse, and Pi publishes no bounded
session read. Pi 0.85.0 also appends a missing final newline during such a
read. If the owning process appends a record at that moment, the added newline
splits that record, and later parsers skip it. The newline does not change the
displayed transcript: the session format stays version 3 and `getBranch()`
selection is unchanged. Every worker-controlled line has a visible quote prefix, and
direction controls are removed, so worker text cannot imitate the renderer's
record headings. Redacted reasoning carries an explicit `REDACTED` label.
Worker-authored content remains marked as unverified data, not instructions.

A worker runs as a real `AgentSession` inside the dispatching session's process.
It writes an ordinary pi session file (`worker.json` records `sessionFile` and
`sessionId`). Reopen a finished worker as a real session:

```bash
pi --session ~/.pi/agent/sessions/.../<worker-session-id>.jsonl
```

While a worker is still running it belongs to this session's process: steer it
with `subagent_steer` and abort it with `subagent_kill`. The extension tool and
panel paths refuse mutation from another session. Another session may inspect
the persisted transcript through its `/subagent` dashboard. There is no separate live second terminal for a running
worker — pi runs one interactive session at a time. Live
control stays through the owning parent's tools and dashboard.

Before continuing a terminal worker that has no submitted result, use
`subagent_inspect` first. Reopen the session when the bounded tail omits needed
evidence. A completed draft can survive inside assistant text or a tool call
used for final QA even when the subsequent `submit_result` turn never landed.
Recovery is an operator judgment over transcript evidence; inspection never
guesses which model-authored content was the deliverable.

The subagent extension also publishes one ambient footer status through Pi's
public `subagent` status key. It shows this parent session's local active count
and cumulative observed worker spend, for example
`subagents: 2 active · $0.37`. After the workers stop, their retained spend
remains visible as `subagents: 0 active · $0.37`; the key clears when the
session has neither active workers nor observed spend, and on session shutdown.
Pi's default footer and the custom statusline consume the same status map
generically; the statusline does not inspect worker files or parse this key.

`/subagent` opens the console. The content-fit roster shows live workers first.
Each row leads with stable scan fields: state, model, elapsed time, cost, and the
current tool when present. Elapsed time changes from seconds to compact `XmYs`
after one minute. The flexible right side shows the submitted-result preview,
latest worker-authored output, or failure; it never repeats the static dispatch
instruction. Selection is tracked by worker id, so a live→terminal reorder
cannot move the operator onto another worker. Pick one with enter and it opens
as a **live console over that worker's conversation** — the task as a
full-width user band, complete thinking text, assistant prose, and each tool
call as a status-coloured box (`$ bash …`, `read`, `submit_result`, …) with its
full transcript output. Terminal submitted results also appear as a compact
`worker report · unverified` block; collect remains the full result authority.

For a worker this session still owns, there is an input line at the bottom:
type and press enter to steer it while it runs — and when the worker is idle,
enter starts a fresh background prompt, so an interrupted worker resumes by
typing without blocking the parent. `ctrl+c` interrupts an active run; a
`ctrl+c` while an owned worker is already idle cancels it. The console
subscribes to live events and auto-follows the tail. `↑↓` / page / home / end
scroll the transcript. Transcript content is always complete; there is no
verbose/details mode or toggle. Escape alone returns to the list and closes the
roster; `q` is inert as a navigation key.

For a terminal worker, `c copy` writes the exact shell-safe reopen command to
the clipboard via `pbcopy` (macOS only). The transient notice shows the full
command when it fits and
preserves its shell-quoted tail at narrow widths. `r continue`
opens an inline prompt; Enter starts a new linked background worker and repoints
the console to it, while Escape cancels the prompt. Scroll controls stay at the
far left of every console footer and Escape stays last. At narrow widths,
optional middle actions and transient notice text shed before the sole Escape
back/close/cancel hint. A worker running in
another session says so plainly and offers no local steer/cancel hint.

`k` appears only for a selected running worker owned by this session. It cancels
through the same path the tool uses and displays the actual outcome, never an
optimistic request notice. Foreign-worker rows do not advertise or invoke it.
The panel is a view over the store and live sessions — it holds no separate
control plane.

## Parent-death contract

Workers live in the dispatching session's process. Therefore:

- A worker that already submitted keeps its persisted result and remains
  collectable by any session.
- A worker still in flight when the parent dies is recorded as `owner_lost` by
  the next session that reads the store. Liveness is decided by the owner's
  process, not by guesswork, so a worker owned by another *live* session is
  never mistaken for an abandoned one.
- A worker running in another live session shows as `running (other session)`.
  Any session can inspect its persisted transcript and status; only its owner
  can steer, interrupt, or cancel it, and collection remains terminal-only.

This cut deliberately has no keeper process: `owner_lost` is the honest state
for in-flight work after parent death.

Known boundary: Node exposes PID liveness, not process birth identity. If the
OS recycles an owner's PID, a dead owner can temporarily look alive and remain
`running`. The current Node process layer cannot distinguish that recycled PID.

## Store

```
~/.pi/agent/subagent/workers/<id>/        (0700)
  worker.json   spec + state (rewritten atomically on each transition)   (0600)
  prompt.md     the worker protocol prompt appended to the system prompt  (0600)
  result.txt    submitted deliverable (50KB maximum, marked if truncated)(0600)
```

The store is owner-only against other OS users. Workers and other same-UID
processes share the operator's filesystem authority; this extension does not
claim tamper resistance against them. Worker prompts, transcripts, and results
carry whatever the operator's work carries. The extension reasserts the store
permission invariant when it loads. Atomic writes go through process-unique
temp files (not a fixed `.tmp` name), so two writers racing one worker record
during a crash cannot tear each other's write.

A worker's full transcript is pi's own session file under
`~/.pi/agent/sessions`, which pi writes at its default mode (0644). At dispatch
the extension chmods the worker's own session file to owner-only (0600), retries
after early session events because pi creates the file lazily, and reasserts the
invariant on each load. Pi's PRIMARY session files remain at pi's default mode.
The owner-only guarantee covers the store and dispatched-worker transcripts,
not pi's baseline.

A terminal worker is pruned 30 days after it exits (set `PI_SUBAGENT_PRUNE_DAYS`
to change the window, or `0` to disable). A worker still recorded `running` is
never pruned, even when old — another live session may own it.

An interrupted idle worker is released after 30 minutes by default (set
`PI_SUBAGENT_IDLE_MINUTES` to change the window in minutes, or `0` to disable
the deadline so an interrupted idle worker is never auto-released).

A dispatch that declares no `deadlineMinutes` takes it from
`PI_SUBAGENT_DEADLINE_MINUTES` (default 30 minutes; `0` means such dispatches
run unbounded). A dispatch that declares no `budgetUsd` takes it from
`PI_SUBAGENT_BUDGET_USD`, which is unset by default and therefore applies no
budget. Both bound a run leg and pause the worker; see
[Run-leg limits](#run-leg-limits).

The worker's transcript is its own pi session file, referenced by
`worker.json` (`sessionId`, `sessionFile`) rather than copied. The panel
transcript view intentionally omits `custom`, `bashExecution`, `branchSummary`,
and `compactionSummary` events, plus orphan tool results.
