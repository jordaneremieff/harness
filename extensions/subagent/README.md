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
| `subagent_profiles` | sequential | List, read, create, replace, remove, enable, or disable managed dispatch profiles. Updates, removal, and toggles require the digest from a prior read. |
| `subagent_report` | parallel | Send a bounded, nonterminal report to the immediate parent. Worker-only; a returned call reports `sent_unconfirmed`, not acknowledged receipt. |
| `subagent_peers` | parallel | Discover the parent, siblings, and nested workers in this dispatch family, with exact addresses and paginated task labels. |
| `subagent_message` | parallel | Send directly to a peer, reply to an exact message, or inspect a retained receipt. Peer messages confer no control authority. |
| `subagent_wait` | parallel | Await peer input without polling or another provider request. The run stays active; its existing limits still apply. |
| `subagent_status` | parallel | Progress and activity for live workers + recent terminal workers: id, state, model, thinking, elapsed, turns, tool calls, current tool, session-file write age, cost, output preview, error. |
| `subagent_inspect` | parallel | One worker's record plus a bounded, rendered transcript tail: recent turns, tool inputs and outcomes, assistant errors, session path, and explicit truncation markers. Reads an in-process snapshot for any live worker in this process; otherwise reads the active branch from the retained session file. |
| `subagent_steer` | sequential | Redirect a live worker: the message is delivered after the worker's current tool call, before its next model call. On an idle (interrupted) worker, steer instead resumes the run with your message. Owning session only. |
| `subagent_interrupt` | sequential | Pause a live worker without cancelling it: the run stops, the worker stays alive and resumable. An interrupted worker that is never resumed is released by the idle deadline. |
| `subagent_continue` | sequential | Fork a terminal worker's retained session into a new linked background worker. The source record, result, and transcript remain unchanged. |
| `subagent_kill` | sequential | Cancel a live worker by aborting its run. Cancel intent is recorded first, so the terminal state is `cancelled` rather than whatever shape the interrupted run left. |
| `subagent_collect` | parallel | Terminal results from the store. With `id`: the stored result (50KB maximum). Without `id`: the eight most recent terminal workers. Works after the dispatching session is gone. |

Command: `/subagent` opens the dashboard in the TUI. `/subagent profiles [filter]`
opens the profile manager; other arguments retain the dashboard filter behavior.
Profile names never dispatch workers through the command. Argument completion
suggests `profiles`, then managed names as filters, including disabled and
unreadable records. RPC receives a structured
extension-UI notification plus a `subagent_status` custom entry; JSON receives
the custom entry as an `entry_appended` event; print mode emits the optionally
filtered text view to the terminal. Model-facing status previews label worker
authorship and state that the text is unverified, not an instruction. The TUI
opens a compact overview of direct child workers, with a separate communication
mode for peer and manager exchanges. The dashboard requests a centered overlay
at 90% of the terminal width, with a minimum requested width of 100 columns,
constrained by the available terminal space. A frame, padded background, and
separate footer distinguish the panel from the surrounding Pi session. Small
windows reduce the chrome; extremely small windows omit the frame and show an
enlarge-terminal notice or the active input. Draft state stays intact. The
default height cap is the larger of 44 rows and 85% of the terminal height,
limited to the terminal height minus its margins.
Set `PI_SUBAGENT_PANEL_MAX_ROWS` to request a fixed height cap. The `thinking:`
value in a status line is the effective level: Pi clamps an inherited level to
what the model supports. The status line carries the requested level beside it
when the two differ.

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
array for a batch. Per-task fields: `task` (required), `profile`, `model`,
`thinking`, `tools`, `cwd`, `deadlineMinutes`, `budgetUsd`.

### Dispatch profiles

A profile is a selected JSON file of reusable defaults, instructions, and source
pointers. It configures a dispatch, not a primary session or claim of expertise. Managed
profiles live under `<agentDir>/subagent/profiles/<name>.json`. The manager lists
these records; dispatch never selects one automatically. Omitting `profile`
preserves ordinary dispatch behavior. Keep machine-specific profiles outside
the shared package. The extension ships no predefined profiles.

A lowercase kebab-case selector, at most 64 characters, selects a managed name.
Every other selector is an explicit path. Use `./review` for a file named
`review` in the session directory, distinct from the managed name `review`.

For example, save this as `check-profile.json` at a checkout root:

```json
{
  "name": "review-check",
  "cwd": ".",
  "instructions": "Trace each finding to current source.\nState the evidence and consequence.",
  "grounding": [
    { "name": "Repository instructions", "path": "AGENTS.md" }
  ]
}
```

Select the same file for independent tasks without repeating those pointers:

```json
{
  "profile": "check-profile.json",
  "tasks": [
    { "task": "Review the parser. Cite checked source and submit all findings and limits." },
    { "task": "Review the tests. Cite uncovered behavior and submit the complete result.", "cwd": "./extensions/subagent" }
  ]
}
```

Each real task still needs its objective, output contract, source guidance, and
boundaries. Customize optional `model` and `thinking` using a model and level
available in the current session. Model availability, authentication, and level
checks remain unchanged.

The file accepts `name`, `model`, `thinking`, `cwd`, `grounding`, `instructions`,
and `enabled`. Each grounding item accepts only `name` and `path`. Tool,
system-prompt, permission,
environment, resource-loader, inheritance, and arbitrary settings fields are
rejected. The file and resolved snapshot each have a 16 KiB UTF-8 limit;
grounding accepts at most 16 pointers. A profile `name` is an optional display
label: one word or a short kebab phrase, at most 64 characters, matching
`^[a-z0-9]+(?:-[a-z0-9]+)*$` case-insensitively. It is stored on the snapshot only,
never applied as a dispatch default. Source names have a 160-character limit;
paths have a 4096-character limit. Single-line fields reject controls.
Instructions allow line breaks and tabs, but reject terminal and format controls.
Invalid UTF-8, JSON, fields, and nonregular files fail explicitly. Optional
`instructions` holds reusable multiline guidance for an operating mode. Blank text omits it;
the complete file and resolved snapshot still obey the same size limit. Current
task-specific directions override reusable defaults. A profile never replaces
the system prompt or narrows the session's capabilities.

Resolution order is explicit task field, explicit top-level field, selected
profile default, then ordinary session default. A task profile replaces the
top-level profile entirely; it does not merge files. Only selected files are
read. All selected profiles resolve before any worker in the batch starts; each
resolved path is read once per dispatch. No persistent cache exists.

An explicit profile path is relative to the dispatching session's cwd. Cwd and
source paths inside the file are relative to the file's directory. Explicit dispatch
cwd retains its existing path semantics. No shell, environment, or tilde
expansion occurs in profile paths. Referenced sources are not opened, checked
for existence, or treated as authority. Workers read relevant sources through
their ordinary tools. A missing source remains a worker-visible knowledge gap.

Profile instructions and pointers enter the worker transcript through a Pi
custom message before `session_start` hooks, not through the system prompt or a
resource-loader override. Pi presents that message as user-context content;
source names and paths remain untrusted data. Instructions are separate from
the current task, so slash commands, skills, and prompt templates still work.
Ordinary cwd resources, project trust, tool inheritance, and explicit
`tools: []` remain unchanged. Profiles confer no authority or tool restrictions.

Dispatch details and the worker record retain `profile`: the selected absolute
path, SHA-256 of the file bytes, resolved defaults, instructions, and source
pointers. The record's existing model, thinking, cwd, and tool fields describe effective
settings. The digest identifies input bytes; it does not snapshot referenced
source contents or guarantee identical future outputs. Inspection names the
file and digest. Keep credentials out of profile files and source names.

`enabled` defaults to true. A disabled profile refuses dispatch by managed name
or explicit file path before any batch worker starts. Updates, removal, and
disable actions never alter already-dispatched snapshots or stop workers.
A continuation keeps effective configuration and the selected profile snapshot;
it never rereads the profile, including its current enabled state. Every worker
session construction, including replacement and continuation, inserts that
snapshot before startup when identical profile context is absent. Reload keeps
normal history. If compaction or navigation removes the exact profile message
from effective model context, the worker's context hook restores it before the
current task. Ordinary turns retain one copy. This context repair uses the
worker record, not mutable profile files, and does not affect primary sessions.
Profile instructions remain reusable guidance, not independent authority.

### Manage profiles

Use `subagent_profiles` with one action:

- `list`: return bounded summaries, unreadable records, and a truncation flag.
  Summaries omit full source-pointer arrays; `read` retrieves one complete record.
- `read`: supply an exact `name`; retain its `sha256` for a later mutation.
- `create`: supply a new `name` and a complete `definition`; existing names fail.
- `update`: supply `name`, complete replacement `definition`, and `expectedSha256`.
  Omitted defaults disappear rather than merge with the old definition.
- `remove`, `enable`, or `disable`: supply `name` and `expectedSha256`.

Managed names use lowercase letters or digits, with single hyphens between
segments, and at most 64 characters. A definition's optional `name` must equal
the target name. Managed identity and dispatch labels use the filename stem,
including selection by explicit path. Display names in other explicit files
retain their case-insensitive validation.

The store is one shared capability of the machine's agent directory. Every
session that holds the tool, including dispatched workers, may read and manage
it; there is no worker-specific restriction. Profiles still confer no tools,
resources, or authority on any session.

Create and update resolve relative definition paths against the invoking
session's cwd, then store absolute paths. A stale digest refuses the mutation
without replacing the file. The store uses owner-only directories and files,
atomic replacement, and a short exclusive lock per profile. It serializes
cooperating writers across processes; Pi's native file queue also coordinates
the tool with ordinary file tools. An interrupted writer's lock is not removed
automatically. Inspect that lock before a deliberate manual removal. Read again
before a deliberate retry. Unreadable records expose a digest only when the
store reads their complete bounded bytes;
oversized or nonregular files require repair outside the manager. Definitions
supply no tool selection or authority.

`/subagent profiles [filter]` presents enabled, disabled, and unreadable records.
In the TUI, Up/Down selects a record, Enter or `e` edits, `n` creates, `t` toggles,
`d` opens removal confirmation, `r` refreshes, `/` filters, `?` opens help, and
Escape closes the manager. Removal initially selects Cancel; Tab selects Remove
and Enter confirms. In the editor, Tab/Down advances and Shift+Tab/Up returns.
Left/Right or Space changes Thinking and Enabled. Ctrl+S saves; Enter advances
or activates Save/Cancel; Escape cancels without a write. In the multiline
Instructions editor, Enter inserts a newline, Up/Down moves the text cursor,
and Tab/Shift+Tab changes fields. Ctrl+S still saves. Untouched instructions
retain exact text. An edit uses the native editor's text format: CR/CRLF becomes
LF, and tabs become spaces. A stale save retains the draft.

RPC sends a bounded textual notification and a `subagent_profiles` custom
entry. JSON sends the same entry without a UI call. Print emits the bounded
text list. Custom entries do not enter later model context. No non-TUI profile
command opens a terminal panel or silently dispatches a selected name.

### Worker labels

Every worker carries a presentation `label`. A profile `name` becomes the
label without an ordinal suffix (duplicates share the label; exact ids stay in
details). A profile-less dispatch derives a task-based label from the first
three normalized task tokens, joined and capped, plus a per-owner-session
dispatch ordinal, for example `review-parser#2`. A derived label skips ordinals
that the owner session's recorded workers already hold, so labels stay distinct
within one dispatch and against stored records; dispatch calls that run at the
same time can still derive one label, and a swept record frees its ordinal. A
label is presentation only, so exact ids remain the identity. A shared profile
`name` repeats by design. The label appears in the
dashboard overview identity column, thread labels, dispatch result lines, and
`subagent_status`, and the overview search and `/subagent <filter>` match it;
exact worker ids stay in details, inspection, and control
surfaces.

Optional top-level `sharedContext` supplies one text snapshot to the whole
dispatch. Every worker receives the exact supplied bytes ahead of its own task.
The limit is 16 KiB of UTF-8; oversize input rejects the whole dispatch before
worker setup. Worker records and dispatch details retain a digest identifier
(`sharedContextId`) and byte size (`sharedContextBytes`). The extension does not
parse the content or replace the worker's objective, output contract, source
guide, or task boundary. Cwd resources, tool selection, provider resolution,
project trust, and task permissions remain unchanged.

- **model** — bare id or `provider/id`, checked against registry availability
  and configured auth. Without an explicit or profile value: inherits the
  parent's current model. Model
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
  without reasoning support lands on `off`. Without an explicit or profile
  value: inherits the parent's current level, default `medium`, and pi clamps
  it. The record keeps both
  values — `thinking` is what ran, `thinkingRequested` is what was asked for —
  and every roster, dispatch, and result line shows the requested level when it
  differs. A profile value is a declared level, not an inherited level.
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
- **cwd** — worker working directory. Without an explicit or profile value:
  session cwd.
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
steerable and reports completion through a `subagent_result` steering message.

An omitted `tools` array and an empty one are different: `tools: []` is a
declared, empty allowlist, so the worker gets `submit_result` and nothing else.
Omit the field entirely to inherit the parent's surface.

The subagent extension's own registration file is loaded into a worker whenever
its source resolves — it carries an internal post-submit compaction veto — but
it never expands the worker's active allowlist: pi filters registered
definitions down to exactly the declared surface, so a restricted worker sees
no subagent tools as callable. If the source cannot be resolved, the worker
runs without the veto and the dispatch reports that under `worker setup:`.

### Useful delegation and closure

A dispatch names an unresolved question, how its result affects the parent's
decision, and what ends the task. The parent keeps its own work distinct from
that question unless independent verification or different evidence requires
overlap. Each submitted result remains self-contained.

When evidence settles a task or changes its premise, the parent immediately
cancels work with no remaining use through `subagent_kill`, or redirects it to
a specific remaining question through `subagent_steer`. Uncertain work needs
inspection before that decision. Before a final conclusion, the parent
integrates useful results and resolves every live worker. An interim reply
does not close the task.

These are model-facing operating instructions, not automatic task judgments.
The extension does not infer completion from parent prose, cancel on parent
idle, or use a deadline as a substitute for the parent's decision. Controlled
session tests establish that the controls stop active work; they do not
establish that every model follows the instructions.

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

## Interim reports

A worker calls `subagent_report({message})` for a consequential fact, question,
or correction that its immediate parent needs before completion. The message
accepts at most 8 KiB of UTF-8. A larger message fails without sending anything.
Reports do not end the worker, replace `submit_result`, or grant authority. The
final submission must remain self-contained for later collection.

The report envelope names the worker, worker session, immediate parent session,
report number, time, model, and worker-authored provenance. The full payload,
including structured details and JSON escaping, stays within 50 KiB and 2,000
lines. Visible text truncation carries a marker. Oversized metadata fails
explicitly instead of removing provenance. Terminal and direction controls are
removed from the displayed worker text.

The owning session receives a public Pi custom message with `deliverAs: "steer"`
and `triggerTurn: true`. It steers an active parent or starts a turn in an idle
parent. The synchronous send returning proves only `sent_unconfirmed`, not
receipt, processing, or action. Pi reports later asynchronous failures through
its own extension error path. A missing parent, a nonworker caller, and a
synchronous delivery error produce explicit tool failures.

The reporter is a normal file-backed registration. Normal inheritance carries
it when active in the parent. An explicit allowlist carries it only when
`subagent_report` is named; `tools: []` still yields only `submit_result`.
Process-local owner links and report sinks follow session startup and shutdown.
Reloaded module instances initialize absent slots without replacing existing
live maps. This state is not a persisted store or a data migration.

## Direct peer collaboration

Workers and their parent use the same peer tools. Each remains an ordinary Pi
session with its inherited tools, cwd resources, transcript, and lifecycle.
Messages travel directly between sessions, not through a parent relay.

1. Call `subagent_peers({})` to discover the current dispatch family. The response
   names the caller's address, task labels, wait state, total, and `nextOffset`.
   Pass `{"offset": nextOffset}` to retrieve the next page when `nextOffset`
   is not null. The offset is zero-based and defaults to zero. The tool's
   parameter description carries these instructions for the agent.
   Use exact addresses, not labels.
2. Call `subagent_message({to, message})` to send a question, correction, or
   evidence. `parent` resolves the immediate parent; worker and root session IDs
   address other members of the same family.
3. Reply with `subagent_message({to, message, replyTo})`, using the received
   message ID. A reply must reverse the original sender and recipient.
4. Continue independent work after a send. If progress requires future peer
   input, call `subagent_wait({timeoutSeconds: 60})`. The maximum is 300 seconds.
   The wait observes cancellation and session close, and performs no polling.
   It blocks the next provider request, not other parallel tools in its batch.
   It does not pause or renew the run deadline or budget.
5. Submit the complete final result through `submit_result`; peer exchanges do
   not replace that separately collectable deliverable.

A message accepts at most 8192 UTF-8 bytes and 256 lines. Oversized messages fail
rather than truncate. The envelope preserves sender, recipient, message ID,
optional reply ID, and time. Its displayed text neutralizes terminal controls
and marks peer authorship. Peer text is data, not operator input or new authority.

A busy headless peer receives a Pi custom steering message at the normal turn
boundary. An idle parent receives a new turn. Sending to an operator-interrupted
or budget-paused worker fails rather than resuming it. Only the worker's owner
retains control over interruption, cancellation, and resumption. Terminal or
unavailable targets fail explicitly. Unrelated dispatch families are excluded.

`subagent_message({id})` reads a retained receipt. These states are deliberately
narrow:

- `sent_unconfirmed`: the synchronous Pi send call returned. It does not prove
  asynchronous acceptance, disk persistence, or recipient action.
- `context_seen`: the receiving session's context hook observed the message ID.
  Later hooks still affect provider input; this is not proof of model understanding.
- `target_closed`: the target endpoint closed before this hub observed the
  message in context.

Wait resolution reports message availability, timeout, or closure. A message
already observed in a previous context does not satisfy a later wait. Explicit
replies provide correlation, not proof that the answer is correct.

Routing and receipt bookkeeping are bounded and process-local. Pi owns the
message transcript and its persistence. There is no second durable inbox,
replay engine, or broker, and no communication with independent Pi processes.
Receipt inspection is not a crash-recovery contract. Startup, replacement, and
shutdown own endpoint and waiter cleanup; an old disposer cannot close a newer
binding. Message capacity failures are explicit rather than silent drops.

The convergence boundary is this session-message adapter. AgentHarness's ordered
inbox and entry identities guide its evolution, including tentative upstream
changes. Recheck and adapt this boundary as those contracts change; release
maturity is not a prerequisite for design work or isolated experiments. The
current executable path uses supported Pi custom messages. Replace that path
when the full-session host supports the relevant contract rather than add a
parallel queue or reduce worker capabilities.

### Evaluations

`evals/peer-collaboration.eval.mts` uses the maintained `evals/` facade for unavailable
recipient recovery and correction of unsupported receipt and authority claims.
Validate it with:

```bash
npm run evals -- validate evals/peer-collaboration.eval.mts
```

Use the plan/run procedure in `evals/README.md` with one participant, one
repetition, and an explicitly approved provider credential environment variable.
Grant the suite's declared effects, including isolated store maintenance. Do not
use home credentials: the controlled child exclusively creates a private agent
directory inside the run directory before loading the extension. It does not
copy authentication into that directory.

The suite exposes only discovery and message tools. The current adapter neither
awaits a worker family nor accounts for its delegated usage, so these cases do
not dispatch workers. Structural checks require real tool evidence and have
negative controls; semantic quality requires human adjudication. Controlled
full-session collaboration belongs to `peer-delivery.test.mts`. Neither layer
alone establishes general autonomous task reliability.

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
  alive, a natural completion or failure delivers a `subagent_result` steering
  message after the current tool batch and before the next model call. An idle
  owner receives a new turn. The same delivery contract applies to nested
  owners. Explicit cancellation returns its outcome through the cancel action
  without a duplicate completion message.
  `notificationCallReturnedAt` records only that the owning session's
  synchronous `sendMessage()` call returned. It proves neither asynchronous
  acceptance nor later processing.
- Exact-id `subagent_collect` results carry a `collectedId` read receipt. The
  context hook omits matching completion text when that successful tool result
  is present in the same model context, regardless of their order. No-id lists,
  previews, missing workers, running workers, and tool errors do not acknowledge
  a terminal read. This is model-context deduplication, not model understanding or
  result acceptance. Pi retains the original notification and tool result in
  session history; the extension neither retracts Pi queue entries nor creates
  a separate receipt store. If branch navigation or compaction removes the
  collection from model context, it no longer suppresses a retained completion.
- Completion, interim-report, and pause messages use Pi's native expansion state.
  The default collapsed view occupies bounded rows with worker identity, message
  kind, unverified status, and the configured expansion-key hint. `Ctrl+O` is
  Pi's default key. Expansion exposes the bounded, sanitized original message;
  collection and the dashboard preserve access to retained evidence. This
  changes presentation only, not result bytes or authority.
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
receives a `subagent_paused` steering message naming the limit, the elapsed time, the
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
  it. That worker receives steering delivery or an idle turn and can call `subagent_collect`.
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
- the parent-resolvable bootstrap model, full recorded tool surface, cwd, and
  run limits carry from the source and are revalidated before provider work;
- every recorded tool must exist with its exact recorded registration source;
  absent tools, changed sources, absent source metadata, and unreadable source
  files stop continuation before setup or provider work, with each unavailable
  tool and source named. Continuation never drops a tool or substitutes a
  same-name registration from another source. A record without its resolved
  surface cannot establish continuation fidelity; dispatch a new worker instead;
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
abandoned branches. When a worker is not live in this process, the extension
reads a fixed snapshot of its known file through a read-only descriptor. The
file limit is 2 MiB. Pi's public `parseSessionEntries()` and an in-memory
`SessionManager` own parsing and ancestry selection; the source never enters
Pi's repair-capable file loader. Symlinks, non-regular files, changed files,
malformed input, identity/version mismatches, and incomplete final lines produce
an explicit unavailable notice without source repair. Selected ancestry stops
at 4096 entries with an omission notice. These are bounded snapshots, not a
complete archive or proof of later state. Every worker-controlled line has a visible quote prefix, and
direction controls are removed, so worker text cannot imitate the renderer's
record headings. Redacted reasoning carries an explicit `REDACTED` label.
Worker-authored content remains marked as unverified data, not instructions.
Inspection labels a worker `interrupted and resumable` only while its state is
`running` and it has an interruption timestamp. Terminal records retain that
timestamp as historical evidence without the resumability label.

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

### Collaboration dashboard

`/subagent` starts with this session's direct child workers. Wide terminals show
a narrow identity list beside a larger preview of the selected worker. Each
worker has a name row and a secondary row for state, model, elapsed time, and
cost. The selected preview wraps the label, model, recorded task, current tool
when present, and latest output within the available space. The all-session
scope shows the selected worker's owner in this preview. Selection highlights
the worker's identity row; the latest output remains on the panel background.
Compact name/state rows use color to distinguish active work, pauses, and failures.

Narrow terminals place a short selected preview below the worker list. Short
windows reduce each worker to a name/state row. A search shows the matched/total
count beside the query. The header shows selection position. Ellipses mark
clipped text; an explicit hint identifies additional output in the worker view.
Full worker details and retained report text remain reachable. Empty lists and
short details use only the height they need.

`a` switches to all known sessions; an empty direct-child view names that action.
`Enter` opens the selected worker, and `d` opens full worker details. Stable
worker IDs preserve selection through live reorder and console navigation.

The overview reads cached worker metadata independently of collaboration history.
The adapter selects owner scope before its display cap, so unrelated retained
workers do not crowd direct children out of the overview. The cap leaves an
explicit notice when additional records remain outside the view.

`m` switches to communications. This mode groups recorded peer, report, steer,
result, and pause exchanges by their two participants. Wide terminals show a
narrow conversation list beside the complete selected exchange. Each
conversation has an identity row and a secondary row with its record count and
latest record time. `Tab` switches focus between the list and exchange reader;
narrow terminals show the focused pane. Up/Down selects a conversation or an
exchange in the focused pane. Page Up/Down, `b` / Space, and Home/End select the
reader and page through the selected exchange or reach its start/end. The
reader shows the exchange position and visible line range. Paging holds the
selected exchange instead of following new events; it does not pause workers.
New text for the same exchange and terminal resize keep the line offset within
its current bounds. Selecting another exchange starts its text at the top.

Management-tool calls do not enter the conversation list. Send attempts and
received records remain distinct; record counts do not claim distinct delivered
messages. The selected exchange identifies its participants, record time,
direction, record kind, and unverified status. Conflicting envelope evidence
remains flagged. A pending family snapshot shows a loading notice, not an empty
family. Recorded prose wraps through Pi's native Markdown component at a bounded
reading width, including lists, links, tables, and fenced code. Short windows
reduce the chrome to leave room for source labels and readable content.

`Enter` opens exact event details with original source text and receipt evidence.
Display-only removal of this extension's own worker text wrapper never changes
stored evidence or grants authority.

`e` selects raw evidence within communications. Its timeline and ownership tree
retain nested ownership and separate continuation links. Short participant IDs
serve display only; worker controls always use full identities. Footers and
help are mode-specific: raw evidence labels its exit `e conversations` and
holds the exchange filter and tail-follow keys; conversations list only its own
actions.

The timeline projects dispatch records, terminal outcomes, collaboration tool
calls/results, and received peer messages, reports, pause notices, and result
notifications. Ordinary tool output stays in the worker console. Selecting a
participant marks its exchanges with `*`; other exchanges keep normal text
contrast. Filtering is a separate explicit action. Event details pin the participant identity and scroll
position in the header and put recorded content before source session/entry
identities, receipt evidence, reply links, and recorded task/context text. The dashboard does not infer task criteria,
intent, model understanding, or result acceptance from prose. Footers show
grouped primary actions for the current view; secondary actions stay listed in
`?` help.

| Key | Action |
| --- | --- |
| `m` | Switch between the worker overview and communications |
| `a` in overview | Switch between direct children and all known sessions |
| `Enter` in overview / `v` | Open the selected worker's console |
| `d` in overview | Open full worker details |
| `Tab` / `Shift+Tab` in communications | Select the conversation list or exchange pane; raw evidence cycles timeline, ownership, and details |
| Up/Down in conversations | Select a conversation or exchange in the focused pane |
| Page Up/Down or `b` / Space in conversations | Focus the exchange reader and page through its text |
| Home/End in conversations | Focus the exchange reader and reach its start/end |
| `Enter` in communications | Open the selected exchange's exact source details |
| `e` in communications | Switch between grouped conversations and raw evidence |
| `/` | Search workers in overview or events in communications; Enter keeps the filter, Escape clears it |
| `f` in raw evidence | Toggle the selected participant's exchange filter |
| `h` in communications | Load or refresh history for the selected family; show the result in the header bar |
| `n` in communications | Open the scrollable history/source report, including all retained notices |
| `?` | Open keyboard help; arrows or `b` / Space scroll help and the source report |
| `F` in communications | Select another known family; Enter loads its history |
| `l` / timeline End in raw evidence | Follow the live tail; `BROWSE` stops only automatic scrolling |
| `[` / `]` in details | Follow the parent message or a reply |
| `i` / `k` | Interrupt / cancel a selected owned worker |
| `Escape` | Return from details, help, source report, or console; otherwise close the dashboard |

The refresh timer reads cached worker metadata. Communication queries start only
in communication mode and read live session handles, not session files. History
reads occur only after an explicit request. Each known
file is capped at 2 MiB, with a 16 MiB family-query budget. Live ancestry stops
at 512 entries per session; selected file ancestry stops at 4096. The adapter
bounds records, family members, event count, and event bytes; omissions remain
visible. The view caches only bounded family snapshots. A history refresh
replaces that family's prior snapshot. A live record update does not discard
previously loaded message evidence. The header distinguishes `FOLLOW TAIL` from
`BROWSE`; neither pauses workers or memory refresh. A separate history row shows
pending reads, failures, or the returned event count and identity additions/removals
relative to the prior view. An unchanged result remains visible as `+0/-0`, not
silence. Repeated keys do not start duplicate pending history reads.

The source report preserves the history capture time and full wrapped notices.
History omissions remain visible across live memory refreshes until the next
successful history read replaces them. Failed history reads preserve prior data
and an explicit error with a retry action. Counts describe the bounded view, not
complete archive coverage. A source limit can leave history unchanged; the report
states the omission rather than claiming that no older collaboration exists.

Source order and explicit reply links remain distinct from display timestamps.
Repeated peer envelopes appear once with separate source occurrences; conflicting
envelopes remain visible. An envelope stored in a recipient transcript is not a
context acknowledgement. A live `context_seen` receipt establishes only that
this extension's hook observed the message. Neither fact proves final provider
input, understanding, or action. Missing manager files, pruned records, omitted
ancestry, and past receipt/control transitions remain unavailable. No receipt
journal, second transcript store, or new worker control authority exists.

### Worker console

The worker view separates **Chat**, **Report**, and **Details**. `Tab` selects the
next view; `Shift+Tab` selects the previous view. Each view keeps its scroll
position. Chat starts in read focus. Chat contains user messages, assistant prose, generic custom messages,
reasoning, and tool calls from the selected snapshot. Report displays the retained
worker report separately rather than appending a duplicate to Chat. The report
keeps its source label and unverified status; collection remains the full
submitted-result authority. Details contains exact identities, model, task,
owner, session path, and recorded metadata.

Pi's native Markdown component renders prose and reports at a bounded reading
width. Roles have visible headers. Reasoning starts collapsed. Tools show their
state and a short output preview, with an explicit expansion hint for hidden
input or output. `Alt+Up` and `Alt+Down` move between blocks; `x` expands or folds
the selected block, marked with `›`. `Ctrl+O` expands all tool inputs and outputs;
`Ctrl+T` expands reasoning. These defaults follow Pi's injected `app.tools.expand` and
`app.thinking.toggle` bindings, including custom keys shown in the hints.
Expansion never changes source text. Source-message caches survive theme changes
and resizing. A terminal state transition refreshes the report without requiring
another live callback or repeated file reads.

Native Pi input handles Unicode and paste. The Chat composer labels its action
as Steer, Resume, or Continue. Enter or typing opens the composer. Enter from
the composer steers an active owned worker or starts a new prompt on an idle
owned worker. Escape returns to read focus without sending; the draft remains. Report and Details never submit a draft;
the draft remains when returning to Chat. Failed sends preserve the draft;
pending requests reject duplicate submission. `Ctrl+C` only interrupts;
`Ctrl+K` explicitly cancels. Foreign worker controls remain unavailable.

In read focus, arrows and Page Up/Down scroll. Home moves to the start; End
returns to the tail and follows new output. In the composer, arrows and Home/End
control the input; Page Up/Down still scroll the reader. `Ctrl+A` and `Ctrl+E`
retain native input-line navigation. In read focus, `b` and Space also page. The header shows Tail or Browse
and the visible line range. Browsing stops automatic scrolling, not the worker.
Resizing and expansion preserve the current message position; new output does
not move a reader away from earlier text. `q` is not a navigation key.

For a terminal worker, `c` copies the shell-safe reopen command through `pbcopy`
(macOS only). `r` opens a continuation draft; Enter creates a linked worker and
opens its console. Escape cancels an unsent draft. After submission, Escape
closes only the view and explicitly states that continuation remains active.
Escape remains visible when narrow footers drop optional actions. Closing the
overlay returns focus to the original Pi editor.

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
transcript view includes generic custom messages but intentionally omits
`bashExecution`, `branchSummary`, and `compactionSummary` messages, plus orphan
tool results. Collaboration history uses source entries rather than treating the
model's compacted context as a complete archive.
