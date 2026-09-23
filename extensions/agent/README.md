# agent

Create and control ordinary Pi sessions from another Pi session. Each session
uses Pi's public session services, `AgentSessionRuntime`, and `SessionManager`.
Pi owns resources, context, model requests, extension events, queues, and
compaction. The primary session stays available while the agent works. The
separate `subagent` extension remains independent.

This extension provides runtime tools and a native `/agent` command with a
read-only session and detached-run dashboard. It does not provide a
conversation editor or workspace.

## Start and control sessions

Enter `/agent` for the dashboard or `/agent help` for actions. Add a space to
see actions in Pi's native completion menu. For separate work, describe the
task directly:

```text
/agent new Check the error handling
```

The session uses your current directory, model, and thinking level. Without a
prompt, the command creates a session without starting a task. Command output
uses native host notifications. RPC receives these notifications; Pi's
print/JSON no-UI context discards them. Model-facing tools return their output
as tool results instead.

### Observe sessions and runs

Bare `/agent` reads the existing session inventory and detached-run records
without opening sessions or starting work. The interactive dashboard uses a native overlay, independent of editor widgets
and footer height. It shows active work first, then recent records, with totals
and explicit omissions.
Each section displays at most 50 records. Stored sessions have no live owner
status; detached progress is a recorded observation, not a live status query.
Empty and unavailable sources appear separately.

Use **Tab** to switch sections, **j/k**, arrow keys, or page keys to change
pages, **r** to refresh, and **q** or the configured cancel key to close.
The dashboard does not poll. Use `/agent status <session>` for a live status
request or `/agent help` for actions.

RPC receives a text snapshot through a native notification. Print/JSON mode
writes the snapshot to stderr, leaving protocol stdout and model context
unchanged. This fallback applies to the bare dashboard command; action output
retains the native notification behavior described above.

### Footer activity and price

The `agent` status key reports `agents: 2 active · $0.37 local`. The scope is
this process's manager for the configured agent store, not the current parent's
children. Multiple primary sessions see the same totals. Each ordinary host
counts once, including ordinary agents created by other agents or subagents.
Active means pending host work through final settlement, including commands,
compaction, and queued input. Idle hosts do not count as active.

The price is reported native usage observed after ownership begins. It includes
assistant responses, reported tool usage, compaction, branch summaries, and
cache warming. It excludes inherited history on attach, fork, or replacement.
Reload and replacement of a worker retain already observed spend; idle or closed
hosts retain their observed spend until the manager closes. Primary shutdown or
reload closes that manager and clears the status. These are local observation
intervals, not session-lifetime totals or provider invoices. Missing or malformed
usage adds `+?` to the known price rather than becoming zero.

`subs 1/$0.12` reports those ordinary hosts' subagent subtrees separately. The
package's [snapshot contract](../../docs/conventions/status-keys.md#nested-work-snapshots)
follows only subagent ownership edges. It excludes ordinary hosts and their own
subagent roots from each subagent subtree. The primary's separate `subagents`
cell does not overlap these subtrees. An absent or stopped publisher produces
`+?`, not a claim of zero nested work. Subagent prices use an initial observation
baseline, so retained historical worker spend is not charged again on attach.

Detached work does not enter local active counts or prices. A separate
`detached N recorded/$?` suffix counts launching/running records; `M lost`
counts abandoned records. These are recorded states, not live activity queries.
Detached spend remains unavailable, including after a run finishes. Existing
run-directory notifications and explicit run queries refresh this projection;
there is no extra poller or telemetry store. A failed directory observation
leaves uncertainty explicit.

The publisher sends short status text through Pi's UI API. Headless worker
status calls remain no-ops; numeric snapshots use the session's event bus.
The statusline remains a generic consumer. A narrow terminal still applies the
footer's normal whole-cell truncation rules.

### Discover an action

- `/agent help` lists actions with plain outcome descriptions.
- `/agent help send` or `/agent send --help` shows that action's syntax and
  guidance. `-h` also requests help. Missing or extra arguments show the relevant
  help before any operation starts.
- Type part of an action or outcome, such as `/agent stop current`, then press Tab to
  choose **abort** without running it. Arrow keys select another suggestion.
  After native Tab completion closes the menu, type part of the next argument.
- For a session argument, type part of a known name, directory, or ID. Tab
  inserts the complete ID. Names come only from sessions already open in this
  process; unopened sessions use their directory and an ID suffix. Descriptions
  distinguish stored sessions, open sessions, active work, and detached runs.
- `/agent runs` offers run choices by task, directory, or run ID. Suggestions
  use run records, not reopened sessions.

Completion reads metadata without opening stored workers. Detached sessions
appear for **status**, **steer**, **abort**, **compact**, and **command**, which
contact the owning process.
Other operations enforce trust and ownership at invocation. Unavailable
metadata supplies no choices; an explicit command reports the underlying error.
Multiword outcome searches apply before a recognized action. After a recognized
action, completion retains that action's argument rules. Prompts and messages
remain free text, without placeholder or model-ID suggestions.

| Action | Result |
|---|---|
| `new [prompt]` | Create a separate session and optionally start work. |
| `list`, `status [session]` | List sessions or request one session's status. |
| `attach session [provider/model]` | Reopen a session without starting work; optionally repair its idle model choice. |
| `send session message` | Start the session's next task; active work refuses another task. |
| `steer session message` | Queue a redirection in the running session. |
| `abort session` | Stop the operation without deleting the session. |
| `compact session [instructions]` | Run native compaction; abort active work without resuming it. |
| `command session name [args]` | Invoke a registered extension command, or the host's `reload` or `tree` control. |
| `fork session` | Create a separate conversation and preserve its source. |
| `rewind session entry-id correction` | Redo work from a corrected decision in a fork. |
| `detach session prompt` | Start a task in a separate process from an idle session. |
| `runs [run-id]` | Read detached-run progress and results. |
| `place [dir] [prompt]` | Use or create the session assigned to a directory. |
| `places` | List directory assignments. |
| `unbind dir` | Remove an assignment without deleting its session. |

The `agent_spawn` tool accepts an explicit cwd, model, thinking level, name,
prompt, and project-trust decision. `agent_list`, `agent_status`, `agent_send`,
`agent_steer`, `agent_abort`, `agent_fork`, and `agent_attach` expose discovery,
communication, and control to models. `agent_compact` and `agent_command`
provide explicit compaction and command invocation through the session owner.
Pi's tool schemas define their parameters. An extension command that replaces
the session returns its new ID. The SDK does not interpret every interactive
built-in slash command; `agent_command` is not a terminal-input emulator.

The model-facing `agent_abort` and `agent_command` tools refuse their own
calling session, including its detached route alias. These controls wait for
native idle, so self-invocation would wait for the calling tool itself. Use
another session's controller for these operations.

`agent_compact` accepts the calling session's current native ID with `summary`
instead of `instructions`. Supply a complete continuity summary of at most
32,000 characters: objective, authority, explicit exclusions, source and brief
pointers, source qualifications, acceptance, owned sessions, open review
findings, and next action. Pi applies this
agent-authored text as a native compaction entry at the end of the successful
tool batch. Older context leaves the next model request; raw history remains.
The complete requesting batch remains, including sibling tool results. The
same native run continues without a terminal command, editor change, new
session, or separate summarizer. Summary quality remains the caller's
responsibility; the tool does not certify scope or task completion. The summary
appears both in the compaction entry and in the retained tool-call arguments.
Its length cap is not a bound on the complete model request.

The tool receipt confirms a request, not applied compaction. An aborted or
failed turn, failed tool result, or session change discards that request.
Pi suppresses continuation after an abort even when a later boundary handler
aborts after the compaction draft exists. The request is consumed once, never
retried automatically. The tool subscribes to `turn_end` only while its request
is pending and unsubscribes on consumption or lifecycle cleanup. It relies on
normal tool-result continuation and does not replace an earlier handler's
continuation flag. Earlier boundary drafts remain intact; if an earlier handler
already proposed compaction, the tool adds a visible conflict notice instead of
a second compaction. Later handlers retain Pi's ordinary draft-composition
control. Normal resource and instruction loading remains Pi-owned. A self request without `summary`, with `instructions`, or through a
detached route alias is refused. Use the current native session ID.

For another session, omit `summary`. The existing native summarizer uses
optional `instructions`, aborts active work, and does not resume it. The
`/agent compact` command retains that controller behavior.

`agent_inspect` reads actual session entries and execution/result state. Its
bounded previews retain entry IDs and roles. Use an entry ID and the returned
offset to read a complete entry in chunks; use the returned cursor for older
entries. For a session this process already holds, it reads ordinary Pi session
entries through the live owner. For any other session with no detached run, it
reads a bounded point-in-time snapshot of the persisted entries instead: no
writer claim is taken, `SessionManager.open` is not called, and the source file
is never repaired, rewritten, or truncated. A file above the capture bound, or
an unfinished tail, is reported explicitly. Live owner fields (the current
operation and last error) stay unavailable and are labeled that way. Host
operation and result entries record observed outcomes, not a second execution
engine or a crash-replay log.

## Repair at the cause

`agent_rewind` and `/agent rewind` take a session, the entry that carries the
wrong decision, and its replacement. Obtain the entry ID from `agent_inspect`.
The entry and everything after it are dropped in a fork. The fork receives the
correction and the instructions that followed the dropped entry, in order,
and redoes the work. The source session stays unchanged.

A rewind changes a new branch, not the file system. The fork runs against the
current working tree, not the tree as it was at that entry. An entry outside
the source's current branch is refused before a fork is created. Later user
instructions retain their complete text and actual images. Recorded custom
messages remain labeled as extension context, not fresh operator authority.

## Bind a session to an area

A place is a directory plus the session that owns the reasoning about it.
`agent_place` and `/agent place` resolve that session, create it on first use,
and optionally start work in it. The target must be an existing directory.
Resolution takes the longest bound directory that contains the target, so a
session bound to one extension answers for its subdirectories while the
repository session answers for the rest. The binding lives in `places.json`
beside the sessions and survives every primary session.

`/agent places` lists the bindings. `/agent unbind <dir>` removes one binding
and leaves the session in the store. When a bound session is missing from the
store, the next use binds a new session and reports the replacement. A binding
reuses session context; it does not verify old conclusions against changed
files or guarantee that compaction preserves every past decision.

## Runs that outlive this session

A session keeps its transcript on disk, but its execution belongs to the
process that owns it. `agent_detach` and `/agent detach` start a new
prompt on an idle session in a separate operating-system process. The primary
session releases its open worker before the child takes ownership. This
session can then exit without stopping the detached run. Active sessions refuse
transfer: detachment does not migrate an in-flight model request or tool call,
and it does not silently abort existing work.

The `agent_detach` tool also creates a session when no session ID is supplied;
it accepts cwd, model, thinking level, and trust for that new session.
Detachment separates the run from the launching terminal, not from its host
machine. It supplies no remote computer, wake-up scheduler, or execution during
host sleep.

The run process owns the session while it runs. Nothing else may open that
session for writing. Status, inspect, steer, abort, compact, and command reach
that existing owner through Pi's public client/server transport and Chord
service endpoints.
They do not reopen the session or construct another worker. Attach, send, fork,
rewind, place resolution that reopens the bound session, and a second detached
run remain refused. Those operations become available after the run closes its
session and releases its writer claim.

The control endpoint becomes ready after the worker opens and the socket
listener starts. A live process ID alone does not establish control readiness.
Steer remains unavailable until initial input preparation and admission finish.
An explicit abort also applies during input preparation; the run repeats the
abort after admission if necessary. A client disconnect or canceled control
request does not abort the run. Failed controls are never replayed automatically
or retried by opening a local writer. A lost response leaves admission unknown.

A successful steer confirms admission to the owner's in-memory queue, not
delivery or action. Native pending queues and in-flight operations do not
survive process loss. At finalization, the run seals controls, drains admitted
calls, checks idle again, and reads current session state. Remaining queued
input causes an explicit failure; the host does not promise to recover that
queue or start another operation automatically. Endpoint and worker cleanup
finish before the terminal result is published.

A detached run retains its original session ID as the transport route.
Progress and result records identify the current native session with
`currentSessionId`. After a command replaces the session, controls accept
either identity and reach the same owner. Inspection reports the actual
current session; a stable route does not rename the saved native conversation.

`agent_runs` and `/agent runs [run-id]` show each run's state. A pending launch
shows `launching`, not abandonment. The child waits until the launcher
atomically publishes its process identity before it opens the session.
While the run works, its view shows the entry count, any observed current
tool, latest text, and progress timestamp. No tool field means no tool was
observed; it does not establish that the model is thinking. Before the first
progress record, the view says that no progress record exists yet.

`agent_status` and `/agent status <session-id>` request live status from the
owning process. If that control is unavailable, they explicitly label the
run-record view as a recorded observation, not live status. `agent_inspect`
reads bounded entries and execution state from the owner. When this process
holds neither the worker nor a detached run, `agent_status` reports stored
metadata from a bounded read-only snapshot and both tools state that live owner
state is unavailable. They never open a writer or remove a claim to make an
observation succeed. After settlement,
the run view shows its summary or error when present. The last progress record
remains visible. Progress snapshots are throttled, not a complete event stream.

The primary session announces unacknowledged settled runs at session start and
when a filesystem watch observes a change in the runs directory. A `.seen`
marker suppresses later announcements for that run. The marker is a best-effort
duplicate guard, not an exactly-once delivery contract: a crash between send
and acknowledgement permits a repeated notice, and concurrent primary
processes can also repeat it. A delivery failure after acknowledgement can
lose the notice. A watch error stops live announcements without a polling
fallback; session-start reporting and explicit run queries remain available.

Run records live under `<store>/detached/`. The launcher writes `<run-id>.json`;
the run process writes `<run-id>.progress.json` and `<run-id>.result.json`. If
launch fails before execution begins, the launcher writes the failure result.
The primary session writes `<run-id>.seen` after an announcement. Output goes
to `<run-id>.log`, since a detached process has no terminal. The run also
publishes `<run-id>.json.control.json` with its ready endpoint identity. A short
private runtime directory holds the Unix socket. Normal close removes the
descriptor and socket resources. The descriptor does not contain execution
state and does not replace the writer claim. The client checks its run,
session, process, server identity, and private socket before use. The services
expose only this run's session, not general discovery or session creation.

Observation, steer, and abort requests have a 15-second deadline. Compact and
command requests have a five-minute deadline. A timeout or client cancellation
ends the wait, not accepted work; use explicit abort to stop the owner. Steering
text is limited to 128 KiB;
optional image data is limited to 2 MiB in total. Observation serialization is
limited to 1 MiB, while `agent_inspect` retains its page and text bounds. A limit
failure affects that control, not the run's execution. These local Unix
controls do not implement remote-user authentication or network access.

A run with no result whose recorded process ID no longer answers reads as
`abandoned`. The process check does not prove identity after PID reuse; the
progress timestamp remains the evidence of its last update. Completed work
stays in the session. Abandonment has no immediate announcement signal
because a dead process writes nothing. A later run query, session start, or
runs-directory change detects it.

Each open session holds an exclusive local-filesystem writer claim under
`<store>/native/.claims/`. Close and replacement reject new native user and
custom-message input before teardown. The host waits for outgoing native work
after shutdown hooks before releasing its claim. Failed disposal or incomplete
cleanup retains the claim; a failed close permits another cleanup attempt.
An abrupt process exit retains the claim, so reopening then fails closed.
The error names the claim file. Confirm that no writer survives before manual
removal; the extension never guesses that another process is safe to replace.
Read-only observation does not take a claim, so `agent_status` and
`agent_inspect` can report a session that another process owns; they read a
bounded point-in-time snapshot of its persisted entries and do not remove the
owner's claim.
Claims coordinate agent-extension processes on the same local filesystem;
they do not fence arbitrary programs that bypass the store.

## Collaborate between sessions

`agent_send` addresses a session by its full ID. A message from another session
retains the sender, recipient, message ID, and optional `replyTo` reference.
An idle recipient starts a turn; an active recipient receives the message
through its steering queue. A peer report also reaches a primary Pi session.

In the native TUI, a collapsed `agent_send` call shows its target, optional reply
reference, and a short message preview. The configured tool-expansion key shows
the submitted multiline message as literal text. Terminal controls appear as
visible escapes. Expansion displays at most 32,000 UTF-16 code units without
splitting a surrogate pair; an explicit notice reports any omitted text. The
full arguments remain in Pi's native tool call. Display bounds never change the
transmitted message. Results distinguish admission receipts from send errors.

Admission means the message entered the recipient's execution path. It does
not mean that the recipient replied, understood the message, or acted on it.
Peer content remains reported data, not operator authority. Ask a collaborating
session to send a report to the intended recipient. The host also announces
settled in-process operation results to registered primary sessions. Settlement
is an execution outcome, not coordinator acceptance of the task. A normal
terminal result does not impose a separate submission protocol.

Peer messages remain data even when their text starts with a slash command.
Use `agent_command` for explicit command execution. The native `/agent send`
action starts a new input on an idle session; the model-facing `agent_send`
preserves sender identity and uses steering for an active peer.

## Resources and continuity

Each session resolves tools, extensions, skills, prompt templates, instructions,
settings, and project trust at its own cwd and agent directory. Built-in tool
execution uses that cwd. Extension tools and provider registrations participate
through the ordinary public host APIs. Project resources use ordinary trust
decisions and hooks. The primary session supplies a native trust prompt when
available; an undecided trust-gated project remains untrusted otherwise.

Worker extensions use Pi's ordinary headless session context:
`mode: "print"` and `hasUI: false`, including after reload. Their notifications,
widgets, and editor writes have no terminal effect. Dialogs return the native
no-UI values, such as `false` for confirmation and `undefined` for selection or
input. A worker does not borrow its primary session's editor, dialogs, status,
shortcuts, or custom renderers. Runtime hooks and extension commands remain
available through the ordinary host execution paths.

Pi's ordinary session owns structured prompts, full-transcript context hooks,
context edits, tool declarations, actionable `turn_end` and
`agent_before_settle` boundaries, compaction, retries, and queues. The extension
does not reconstruct those semantics in an adapter. Native session entries
supply extension history and projection APIs.

Each in-process session has its own model runtime. It inherits provider
registrations through the primary's public model registry, then discovers
providers at its own cwd. One session's provider registration does not change
another session's runtime. Primary runtime-only API keys remain at their
owner and resolve at request time, including after key rotation; session and
run records contain no credential snapshot.

Detached processes rediscover their resources and configured authentication.
Function closures and runtime-only credentials from the launching process do
not cross that boundary. A detached provider therefore needs a discoverable
source and authentication available in the child process.

Model choice is explicit or inherited at creation, then retained in native
model entries. A requested or inherited thinking level is clamped to the
selected model's supported levels. Reopening does not substitute a fallback
model. If the stored model is unavailable, `agent_status` reports its exact
identity and directory without starting work. `agent_attach` accepts an
optional explicit `model` in `provider/model` form; `/agent attach` supplies
the same repair. Repair requires an available authenticated model and an idle
session with no pending input. Failed validation leaves the stored choice
unchanged.

Native tool selections persist through transcript declarations after a request.
An unsent in-memory `setActiveTools` change is not a saved selection. The next
request uses Pi's current resource and tool-selection rules.

Forks retain native context and rebuild cwd-bound resources. Setup uses a real
`SessionManager`, including ordinary context edits. Extension command actions
for new, fork, and switch use `AgentSessionRuntime`: outgoing shutdown and
context invalidation precede fresh services and bindings. Switch targets must
belong to this agent store so the host can reserve their writer claims.
Replacement failure after teardown does not restore the outgoing runtime.

Current native JSONL files live under `<store>/native/`. The host persists a
valid new header and setup entries before the first model response, so an idle
session remains reopenable and detachable. It does not invent assistant
messages to force persistence. Existing files outside this native directory
remain untouched; there is no migration or retired-format reader.

Reopening retains persisted conversation history. It does not replay an
interrupted model request, tool call, or pending queue. Inspection identifies
an interrupted host operation when its recorded start lacks a result. Continue
from the retained history with a new explicit task after resolving ownership.
Closed host objects retain readable identity and history; execution and live
status require an open owner.

## Configuration

| Variable | Purpose |
|---|---|
| `PI_AGENT_SESSIONS_DIR` | Store root, including `native/` sessions, `native/.claims/` writer claims, `places.json`, and `detached/` run records. Default: `<agentDir>/agent-sessions`. |
| `PI_AGENT_DIR` | Agent directory for session discovery, settings, and trust. Default: Pi's `getAgentDir()`. |
| `PI_AGENT_LIVE` | Set to `1` to run the opt-in real-provider tests. It is a test switch, not a runtime capability limit. |

The [worktree workflow](../../docs/conventions/worktrees.md) defines activation
and routing. Activate this extension's worktree entrypoint, not a second copy
from the main checkout.

## Checks

Run the focused tests from the repository root:

```bash
node --test "extensions/agent/*.test.mts"
```

`PI_AGENT_LIVE=1 node --test extensions/agent/setup.test.mts` enables the
opt-in real-provider setup, compaction, and reopen check with configured
authentication. The normal suite does not establish a live provider run.
It uses synthetic providers and isolated processes for native session
boundaries, persistence, ownership, detached controls, and cleanup. Native
editor tests cover command completion. Component tests cover dashboard paging,
refresh, disposal, source failures, and send-call expansion. Native TUI changes
also require an isolated interactive or PTY check for keys, focus, resize, and
tool expansion; component snapshots alone do not establish those behaviors.

Repository gates are `npm test`, `npm run lint`, `npm run typecheck`, and
`npm run check`.
