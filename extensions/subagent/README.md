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

No gates, no enterprise controls, no supervisor, no daemon. The server lives in
the parent session; the store is the truth; the parent's own tools manage
workers.

## Tools

| Tool | Mode | Purpose |
|---|---|---|
| `subagent` | parallel | Dispatch one task or a `tasks[]` batch. Every worker starts in the background and returns a stable id immediately. Per-task `deadlineMinutes` (defaulted) and `budgetUsd` (opt-in) pause a worker that overruns the agent's own estimate. |
| `subagent_status` | parallel | Live workers + recent terminal workers: id, state, model, thinking, elapsed, turns, tool calls, current tool, session-file write age, cost, output preview, error. |
| `subagent_steer` | sequential | Redirect a live worker: the message is delivered after the worker's current tool call, before its next model call. On an idle (interrupted) worker, steer instead resumes the run with your message. Owning session only. |
| `subagent_interrupt` | sequential | Pause a live worker without cancelling it: the run stops, the worker stays alive and resumable. An interrupted worker that is never resumed is released by the idle deadline. |
| `subagent_continue` | sequential | Fork a terminal worker's retained session into a new linked background worker. The source record, result, and transcript remain unchanged. |
| `subagent_kill` | sequential | Cancel a live worker by aborting its run. Cancel intent is recorded first, so the terminal state is `cancelled` rather than whatever shape the interrupted run left. |
| `subagent_collect` | parallel | Terminal results from the store. With `id`: the stored result (50KB maximum). Without `id`: the eight most recent terminal workers. Works after the dispatching session is gone. |

Command: `/subagent` opens the dashboard in the TUI. RPC receives a structured
extension-UI notification plus a `subagent_status` custom entry; JSON receives
the custom entry as an `entry_appended` event; print mode emits the optionally
filtered text view to the terminal. The roster content-fits short lists; worker
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
handing the worker a different tool.

A worker accepts any existing directory — it is validated, not
constrained. This is not an escalation (the worker inherits the parent's exact
tool surface, so the parent already had that authority), but if you want a
policy (e.g. confine workers to a workspace root), that is a deliberate choice
to make, not a default.

```json
{ "task": "Verify that MODEL_BASE has a unique constraint on ID_FIELD. Cite file:line.", "model": "deepseek/deepseek-v4-flash", "thinking": "medium" }
```

Per-task fields: `task` (required), `model`, `thinking`, `tools`, `cwd`,
`deadlineMinutes`, `budgetUsd`.

- **model** — bare id or `provider/id`, checked only against registry
  availability and configured auth. Omitted: inherits the parent's current
  model.
- **thinking** — `off|minimal|low|medium|high|xhigh|max`. Declared: checked
  against the levels the model supports (pi's own
  `getSupportedThinkingLevels`); an unsupported level fails that task and names
  the supported set, because pi would otherwise clamp it silently and a model
  without reasoning support lands on `off`. Omitted: inherits the parent's
  current level, default `medium`, and pi clamps it. The record keeps both
  values — `thinking` is what ran, `thinkingRequested` is what was asked for —
  and every roster, dispatch, and result line shows the requested level when it
  differs.
- **tools** — omitted: the worker snapshots the parent session's active tool
  surface. Reproduction is by registration source, so it covers built-ins and
  file-backed extension registrations, including a tool an extension registers
  from its `session_start` handler — the worker runs that handler too (see
  [Worker lifecycle](#worker-lifecycle)). Built-ins are rebuilt for the worker cwd, and extension registration
  files are reloaded from their registered source paths. Provided: exactly the
  declared set plus the disclosed `submit_result` protocol tool. A declared
  tool that is not in the current registry fails the dispatch with its name. A
  registration without a loadable source fails before worker creation. The
  worker's active names, registration sources, and public tool metadata are
  compared with the parent snapshot before any prompt token is spent.
- **cwd** — worker working directory. Omitted: session cwd.
- **deadlineMinutes** — how long this task should take, judged by the
  dispatching agent from the task it just wrote. Omitted: the
  `PI_SUBAGENT_DEADLINE_MINUTES` setting (default 30). `0` removes the deadline
  for a task expected to run long. Breaching it PAUSES the worker; see
  [Run-leg limits](#run-leg-limits).
- **budgetUsd** — optional dollar allowance for this task. Omitted: the
  `PI_SUBAGENT_BUDGET_USD` setting, which is unset by default — a budget applies
  only when the task or the operator asks for one. `0` removes it.

There is no foreground or blocking dispatch mode. Every accepted worker returns
its id immediately, remains steerable, and reports completion through a
`subagent_result` follow-up.

An omitted `tools` array and an empty one are different: `tools: []` is a
declared, empty allowlist, so the worker gets `submit_result` and nothing else.
Omit the field entirely to inherit the parent's surface.

The subagent extension's own registration file is always loaded into a worker
regardless of surface — it carries an internal post-submit compaction veto — but
it never expands the worker's active allowlist: pi filters registered
definitions down to exactly the declared surface, so a restricted worker sees
no subagent tools as callable.

Workers are clean-context: project context files (AGENTS.md) and skills are not
loaded. That is a documented property of the worker, not a narrowing of tool
inheritance. It holds for the current extension set rather than by
construction: binding a worker's extensions also runs `resources_discover`, so
an extension that supplies skill, prompt, or theme paths from that handler
would add them to a worker built with `noSkills`.

## Worker lifecycle

- Dispatch returns immediately with a stable `bg-*` worker id; workers never
  block the parent tool call.
- A worker runs the extension lifecycle a primary session runs. pi emits
  `session_start` from `AgentSession.bindExtensions`, which only the
  interactive, print, and rpc modes call, so a session built through the SDK
  alone never starts its extensions: an extension that opens session-scoped
  resources in the documented `session_start` hook would hand the worker a
  registered tool with nothing behind it (a gateway tool whose pool never
  opened). The dispatcher binds the worker's extensions after construction and
  emits `session_shutdown` before disposal, so those resources open and close
  with the worker. Bindings are empty by design: a worker has no operator UI
  and no command surface, so extensions see pi's no-op UI context and `print`
  mode.
- Each worker is an `AgentSession` constructed in this process. Live status
  (turns, usage, cost, current tool, output) comes from the worker session's own
  events; steering and abort are direct calls on it. Nothing is scraped. Every
  terminal path shuts down the protocol runtime and disposes the underlying
  `AgentSession` through one exact-once owner, so Pi's per-session resources are
  released after terminal evidence is persisted.
- The worker's deliverable is written by its `submit_result` tool to
  `result.txt` (temp-write + rename), and the tool then ends the worker's run.
  The write is capped at 50KB of UTF-8 including a `[truncated]` marker. The
  parent never extracts results heuristically.
- The worker system prompt states the deliverable protocol and three disclosure
  rules. They report, they do not restrict: a tool that fails with an
  environment, authorization, or initialization error must be named with its
  exact error even when the worker found another way; a workaround is allowed
  without permission but must say which path it used instead; and cached or
  exported evidence must carry its age rather than stand in for current state.
  A worker that cannot finish submits what it established and names the blocker.
  Nothing here withholds capability from a worker — the extension captures the
  friction signal (`toolErrors`) and leaves the judgment call with the operator.
- A worker should call `submit_result` alone in its final turn. If it is
  batched with a sequential tool such as `subagent_steer`/`subagent_kill`, the
  sibling call can be dropped on abort, leaving an unanswered toolCall in the
  worker's session file.
- Completion is persisted before any notification. While the parent is alive, a
  natural completion or failure delivers a `subagent_result` message (follow-up;
  triggers a turn when idle). Explicit cancellation returns its outcome through
  the cancel action and does not enqueue a duplicate follow-up.
  `notificationQueuedAt` records when that follow-up was queued, not when the
  operator saw it. The notification is only PRESENTED the next time the parent
  goes idle, and a queued delivery is not consumed by
  `subagent_status`/`subagent_collect` — if you collected a result while its
  notification was still queued, the notification still arrives. That is a
  display-level duplicate, not a double write; the store has one result.
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
- `submit_result` stores at most 50KB. The stored bytes are available through
  `subagent_collect <id>` and in `result.txt`; dispatch itself never waits for or
  returns the result inline.
- A completion notification arrives as worker-authored content between explicit
  provenance markers. It is a report, not operator input: an instruction inside
  a worker's result is data to judge, never a directive to follow.
- A worker left interrupted and idle is released by a bounded deadline (30
  minutes) rather than holding its session forever. Sending it a message before
  then cancels the deadline and resumes it.
- A worker that fails after dispatch reports its death with the same completion
  notification as a success: state `failed` plus the error.
- The `subagent` tool row renders the crafted dispatch spec in the standard pi
  tool expansion (ctrl+o): task, batch summary, resolved config, and the
  resolved worker system prompt.
- A worker that finishes without calling `submit_result` is recorded as
  `no_result_submitted` — distinct from `failed`, because billing errors,
  thinking and tool-surface mismatches, and completed-in-substance work need
  different responses. The final message is retained and surfaced by
  `subagent_collect` behind an explicit UNPROTOCOLLED OUTPUT banner, never
  presented as the result, with the session file for the full record. Every
  other terminal no-result state also points to the transcript and tells the
  operator to inspect it before continuation: completed work may survive in
  assistant text or tool-call arguments, but the extension never scrapes that
  content or promotes it to a submitted result.
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
in status. The parent then decides: resume it with `subagent_steer` (a fresh
allowance), inspect it, or end it with `subagent_kill`. A pause left unresumed
is released by the interrupted-idle deadline like any other paused worker.

The budget is evaluated when the worker's usage lands (message end, compaction
end), which is the only moment spend is knowable; the deadline runs on its own
timer. Neither samples a clock in a loop, and neither ends a worker.

### Nested dispatch (a worker dispatching its own workers)

A worker session registers the same tools, so it can dispatch its own
subagents. Two behaviors to know before relying on that:

- The nested worker's tool surface resolves from the TOP-LEVEL parent's
  registration (the module-global API handle is fenced to the parent during
  worker construction), not from the dispatching worker's restricted surface.
  A tool-restricted worker's child therefore inherits more than the worker
  had. Dispatch children with an explicit `tools` list if the restriction
  matters.
- A nested worker's completion notification is delivered to the top-level
  parent session, not to the worker that dispatched it (the parent owns the
  message channel). The dispatching worker still gets the dispatch call's own
  return value; only the asynchronous completion notice routes to the parent.

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
- model, effective thinking level, tool surface, and cwd inherit from the source
  and are revalidated against the current session before provider work starts;
- the continuation message is the new worker's task, and normal notification,
  collection, cancellation, and provenance rules apply.

A running worker is not continued: steer it while active, or interrupt it and
resume by typing. Copying the shell-safe `pi --session '<file>'` command remains
the portable fallback for a terminal worker.

## Inspecting a worker

A worker runs as a real `AgentSession` inside the dispatching session's process.
It writes an ordinary pi session file (`worker.json` records `sessionFile` and
`sessionId`). Reopen a finished worker as a real session:

```bash
pi --session ~/.pi/agent/sessions/.../<worker-session-id>.jsonl
```

While a worker is still running it belongs to this session's process: steer it
with `subagent_steer` and abort it with `subagent_kill`. Another session may
inspect the persisted transcript through its `/subagent` dashboard, but cannot
mutate the live worker. There is no separate live second terminal for a running
worker — pi runs one interactive session at a time and ships no client-attach
command, so live control stays through the owning parent's tools and dashboard.

Before continuing a terminal worker that has no submitted result, inspect the
full transcript first. A completed draft can survive inside assistant text or a
tool call used for final QA even when the subsequent `submit_result` turn never
landed. Recovery is an operator judgment over transcript evidence; automatic
extraction would guess which model-authored content was the deliverable.

### The socket, and what it is for

Each parent session hosts a `PiServer` on a unix socket and registers every
worker it owns as a real protocol session. Nothing in the shipping pi CLI
consumes that socket today: the `pi server` / `pi client` commands exist
upstream as parser composition only, and the interactive TUI drives one local
session at a time. So the socket currently has **no operator-facing consumer**,
and no command in this extension prints it as an attach hint.

It is kept deliberately, not by accident. `PiServerService` + `PiSessionRuntime`
is the application boundary upstream designates for exactly this case, and it is
the single versioned seam through which the extension reads pi's session state
(see `runtime.ts`). When upstream's TUI learns to consume a remote session, the
work to open a worker as a real steerable console inline is already done. Until
then the socket is exercised by the colocated conformance test, which drives a
real protocol client across it.

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
the clipboard. The transient notice shows the full command when it fits and
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

Known boundary: liveness is probed with the owner's PID (`process.kill(pid, 0)`).
If the OS recycles that PID to an unrelated process, a dead owner can look alive
and the worker stays `running`; the interrupted-idle deadline does not apply to
an active record, running records are not pruned, and a non-owner kill is
correctly refused while that PID appears live. A session-token heartbeat would
close this; it has not been worth the machinery yet.

## Store

```
~/.pi/agent/subagent/workers/<id>/        (0700)
  worker.json   spec + state (rewritten atomically on each transition)   (0600)
  prompt.md     worker system prompt used for the run                    (0600)
  result.txt    submitted deliverable (50KB maximum, marked if truncated)(0600)

/tmp/pi-<uid>/a-<agent-dir-hash>/s-<parent-session-hash>.sock           (0600)
  the parent's bounded worker-server endpoint inside owner-only directories
```

The store is owner-only. Worker prompts, transcripts, and results carry whatever
the operator's work carries, and the socket is a full control channel over live
workers whose only authorization is its filesystem permissions. Its stable,
hashed runtime path stays below Unix socket limits regardless of
`PI_CODING_AGENT_DIR` length; the full session identity remains in
`worker.json`. PiServer owns identity-aware stale-endpoint cleanup, while the
extension only sweeps old socket-shaped entries in its current hashed namespace.
The extension reasserts the store permission invariant when it loads. Atomic writes go through
process-unique temp files (not a fixed `.tmp` name), so two writers racing one
worker record during a crash cannot tear each other's write.

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

The worker socket is exercised by the colocated conformance test, which
drives a real protocol client over a real unix socket. It is not part of
any operator workflow today.
