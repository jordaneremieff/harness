# agent

Create and control ordinary Pi sessions from another Pi session. Each session
uses Pi's public session services, `AgentSessionRuntime`, and `SessionManager`.
Pi owns resources, context, model requests, extension events, queues, and
compaction. The primary session stays available while the agent works. The
separate `subagent` extension remains independent.

This extension provides runtime tools and a native `/agent` command with a
session and detached-run dashboard with read-only inspection and explicit actions.
It does not provide a conversation editor or workspace.

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

### Tool previews

Session tools place requested model and thinking configuration below the call
heading when those fields apply. Omitted values remain unresolved rather than
borrowing a model from the parent display. Result previews use structured
session snapshots for spawn, fork, rewind, attach, place, and status. Detach
labels its snapshot **Selected before transfer**; it does not establish the
child runtime's later model selection. Missing metadata remains unknown.

Native tool expansion reveals arguments, returned text, and snapshot identifiers.
Each expanded text block retains at most 32,000 source UTF-16 code units without
splitting a surrogate pair. Escaping terminal controls expands that prefix to at
most 256,000 code units, excluding the truncation notice and native layout.
These are per-block limits, not a total-view limit. Collapsed results keep a
short excerpt below the configuration. Full machine-readable results remain
intact. Terminal controls display as escaped text. Preview rendering neither
opens a session nor changes task admission, delivery, or lifecycle behavior.

### Observe sessions and runs

Bare `/agent` reads the existing session inventory and detached-run records
without opening stored sessions for writing or starting work. Its native overlay
stays independent of editor widgets and footer height. The framed browser puts
session names first, then the first message or directory when no name exists.
A second row shows execution state, modification age (`mod`, not run time), and
available model/thinking information. Duplicate titles receive a short directory
or distinguishing ID suffix, with space reserved even for long titles.
Active work precedes recent records. Selection follows the exact ID across
refreshes. Wide terminals put the selected session's latest message text before
its task, configuration, parents, and identity. Narrow terminals prioritize the
task and latest text below the list. The footer shows Escape for back or close.

Use **/** to filter by name, first message, task, directory, ID, displayed state,
or known provider/model/thinking values, including selected configuration already read. **Enter** keeps
the filter; **Escape** clears it while the filter input has focus. The filter
searches the entire returned inventory before the display cap.
The heading separates total, matching, shown, and omitted records. Stored sessions
have no live owner status; detached progress is a recorded observation, not a live
status query. Empty and unavailable sources appear separately. Open an unavailable
source to read its complete error rather than a clipped list preview.

- **Tab** changes sections. **j/k**, configured selection keys, and page keys move
  the selected row. **Home/End** jumps to the first/last displayed record.
  **Enter** opens its evidence.
- A session reader puts readable message text before serialized source. Its header
  identifies the session and the owner-state boundary. **[ / ]** selects an entry;
  **Enter** opens its serialized inspection representation, not raw storage.
  The reader reports omission counts for provider signatures, image payloads,
  and redacted thinking. Non-text entries without a readable preview explicitly
  direct the reader to the inspection source. The scrollable detail also
  includes capture limits, current operation when known, retained result source,
  owner errors, configuration, and known parents. **o** reads an
  older page and **n** reads the next source chunk. Each request uses the inspection
  service's exact cursor or offset. A final chunk does not include earlier chunks.
- A run reader shows recorded error, result summary, and progress independently,
  with timestamps and the current native session ID. **s** inspects that session.
  Run summaries are not complete session results. Result previews and source
  chunks retain their partial labels; a truncated owner error has no continuation
  endpoint. Read source entries for retained evidence, not an invented full result.
- **j/k** and page keys scroll readers and help. **b** or the configured cancel key
  returns to the previous view. **Escape** closes the list. **?** shows key help.
- **r** refreshes the inventory or requests the newest session inspection and
  selected configuration. It returns a run reader to a refreshed inventory.
  There is no poller.
- **a** opens the native action menu. The dashboard closes its overlay before a
  native dialog and restores the selected view afterward. Each completed, cancelled,
  or failed action refreshes both inventories while preserving the filter and
  selected ID. A failed inventory read replaces stale rows with an unavailable
  source and its error. Action text never supplies inventory state. The same command table,
  validator, and action closures serve slash input and dashboard actions. Only a
  correctly typed session or run argument receives a selected ID; directory and
  creation actions prompt for their own arguments. Interruptive actions require
  confirmation. Cancel leaves work untouched. Results and refusals appear in a
  scrollable reader. Without a selected target, the footer labels the chooser
  **all actions**, and target-dependent actions prompt for an ID. A returned
  receipt is not proof of task completion.

Selection reads configuration through the manager's read-only description path.
It also reads one bounded recent inspection page from only the selected session.
The latest nonempty assistant, user, or tool-result text receives a role, entry ID,
and partial-text label when applicable. No text in that page does not establish
an empty transcript; Enter and older-page navigation remain available. Selection
changes, empty selection, and disposal cancel the preview request and reject late
responses. Refresh requests new evidence. No background transcript scan or poller
reads other sessions for previews or search.
A live model/thinking pair comes from the local owner. A stored pair appears only
when the retained session contains both model and thinking-level records; it does
not imply a live owner. Unread stored rows say **select for model**. The selected
description supplies the row and detail without a scan of every session file.
Known parents come only from association sources available to the manager,
not from directory or name guesses.
An empty parent list does not establish that the session has no parent elsewhere.

Inspection never takes a writer claim on a stored session. Explicit actions keep
all existing trust, ownership, cancellation, and refusal rules. Status action text
is displayed as returned; the dashboard does not parse it into execution state.
Use `/agent help` for the same actions outside the dashboard.

RPC receives a text snapshot through a native notification. Print/JSON mode
writes the snapshot to stderr, leaving protocol stdout and model context
unchanged. This fallback applies to the bare dashboard command; action output
retains the native notification behavior described above.

### Footer activity and price

The `agent` status key reports `agents 2 · $0.37`, including `agents 0 · $0.00`
before work starts. The active count covers this process's manager for the
configured agent store, not only the current parent's children. Each primary
retains its own cumulative price from the intervals when it observes that manager. A positively identified
managed child is not registered as a primary; the package's
[host identity contract](../../docs/conventions/session-host-roles.md) prevents
unrelated completion turns during child startup and cyclic manager lifetimes.
Each ordinary host
counts once, including ordinary agents created by other agents or subagents.
Active means pending host work through final settlement, including commands,
compaction, and queued input. Idle hosts do not count as active.

The price is reported native usage observed after ownership begins. It includes
assistant responses, reported tool usage, compaction, branch summaries, and
cache warming. It excludes inherited history on attach, fork, or replacement.
Reload and replacement of a worker retain already observed spend. Idle and
completion do not clear totals. Native custom entries save each primary's totals
under its exact session ID, outside model context. Same-process reload retains
in-memory checkpoints. Reopening restores checkpoints only from a native session
file Pi actually saved. Before the first assistant message, Pi buffers custom
entries in memory without creating the file; the first assistant message flushes
those entries. Tree navigation does not undo incurred costs. New sessions
and copied forks start at zero. Multiple primaries have separate checkpoints and
attachment baselines, so a later primary does not inherit earlier manager spend.
Each departing primary clears its cell. A primary reload drops its old UI and
message callbacks, but retains its manager, live hosts, and price baseline.
Last-primary shutdown other than reload closes the manager after final observations. These are cumulative observed session costs,
not retrospective historical charges or provider invoices. Missing or malformed
usage adds `+?` to the known price rather than becoming zero.

The package's [snapshot contract](../../docs/conventions/status-keys.md#nested-work-snapshots)
exports the ordinary hosts' subagent observations separately from their own
price. The subagent extension adds this disjoint contribution to its `subagents`
cell. Its raw publication still excludes ordinary-host roots, preventing feedback
or duplicate costs at mixed nesting depths. Missing observation remains explicit.
A clean close after complete observations does not create an unknown charge.
Subagent prices use an initial observation baseline, so retained historical
worker spend is not charged again on attach.

Detached work does not enter local active counts or prices. A separate
`detached N/$?` suffix counts launching/running records; `M lost`
counts abandoned records. These are recorded states, not live activity queries.
Detached spend remains unavailable, including after a run finishes. Existing
run-directory notifications and explicit run queries refresh this projection;
there is no extra poller or telemetry store. An absent run directory means no
recorded runs, so the known-empty suffix is omitted. Other directory read errors leave counts unknown and make the
run query fail explicitly. A watch error stops automatic refresh; recorded
state remains at its last observation until an explicit run query or primary
registration refreshes it.

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
| `steer session message` | Queue a redirection in the running session. A stored session with no live owner and no open worker refuses and names `send` as the turn-start action. |
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

`agent_inspect` reads session evidence and execution/result state. Its bounded
previews retain entry IDs and roles. Use an entry ID and `offset=nextOffset`
to read the complete inspection representation in chunks; use `nextCursor` for
older entries. Offsets count UTF-16 code units in that representation, not bytes
or positions in the native file. Returned offsets preserve Unicode pairs.

Before serialization, inspection replaces native `textSignature`,
`thinkingSignature`, and `thoughtSignature` values with omission markers.
It also replaces image `data` and the `thinking` text of `redacted: true`
blocks. Each affected entry reports fixed-size `omissions` counts by category,
including fields beyond the current preview or chunk. Markers retain the field
locations in the reconstructed JSON. Visible text and non-redacted thinking,
tool calls/results, identity, provenance, errors, and other metadata remain.

The projection follows declared Pi content containers: ordinary messages,
custom messages, context-edit replacements, and compaction system checkpoints.
It does not recursively filter tool arguments, tool-result details, custom
entry data, or other arbitrary objects by key name. Those fields remain evidence,
not typed native content. This is not a general secret or binary-data scrubber.
Native entries remain unchanged, and no raw-payload bypass or second store exists.

For a session this process already holds, inspection reads ordinary Pi session
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
queue or start another operation automatically. The host also reports every
hosted session that had active or queued work at shutdown, with the affected
total, so that work stays visible in the run result; the host does not wait for
it and does not claim a terminal outcome for each session. Endpoint and worker cleanup
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
Failed switch cleanup keeps its target reservation under the same cleanup owner;
the switch's finalizer does not release that reservation independently.
A host becomes terminal only after native cleanup and every held writer release
complete. The manager then retires its live session, association source, and
owner registration, retaining its observed spend exactly once. This also applies
to failed native replacements and worker-requested shutdown, not only detach.
Saved parent associations remain available for ordinary idle restoration.
Later observation reads the stored session through the read-only capture path;
a later control opens a fresh host under the normal writer-claim rules. Neither
path replays a task.

A stopping host or a host with incomplete cleanup refuses targeted live
observations and controls. The error identifies the session and observed host
state and states that the requested operation did not run. A stopping-host refusal
asks the caller to wait for cleanup. An incomplete-cleanup refusal reports retained
claims without recommending a reopen or claim removal.

Session inventory instead retains the row's stored metadata and reports the
observed host state separately. Completion and dashboard rows preserve other
sessions without reporting a closed host as open or active.

An abrupt process exit retains the claim, so reopening then fails closed.
Graceful quit releases successfully closed hosts; forced process death does not.
The error names the claim file. Idle restoration after verified-dead claim removal
is not automatic crash recovery. Confirm that no writer survives before manual
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

Received peer messages use Pi's native custom-message expansion. The collapsed
view shows the message kind, source session ID, literal excerpt, provenance,
and configured expansion hint. Peer-operation outcomes come from execution
metadata; they do not describe primary-session state or task acceptance.
Detached-run batches identify their aggregate outcomes and expose individual
run/session IDs on expansion. Identity and failure information precede optional
text and are not width-truncated. Malformed identity metadata is labeled
unavailable rather than presented as a shortened source.

Expansion exposes the sanitized notification and its message/reply references.
An explicit display-limit notice preserves access through native history;
`agent_inspect` retains the stored operation outcome and `agent_runs` retains
run outcomes. The renderer changes neither provider content nor delivery timing.
Global expansion intentionally permits full blocks. Compact defaults reduce
late-message footprint, but do not pin the primary answer or guarantee its
visibility after arbitrary arrivals.

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

### Parent reload and saved-session recovery

A same-process primary `/reload` refreshes extension registration and replaces
the primary's generation-bound callbacks. It retains the existing ordinary
hosts, active operations, native queues, resources, and writer claims. Existing
children keep their own native provider and resource runtimes; changed resources
load for the reloaded primary and newly created children. This does not preserve
a provider callback that depends on a resource its own owner closed. Results
that settle during the reload gap wait for the new primary callback and are
delivered once in that process. The native message API supplies no crash-durable
delivery acknowledgment.

The process reuses managers that match the current manager protocol. Refreshed
registration does not reconstruct these managers or existing workers: they
retain their class methods and closures from creation, including imported
helpers. A fresh host process loads method changes for those objects. Another
session in the same process does not replace the retained owners.

Explicit creation and ownership controls record parent-child associations in
native custom entries outside model context before a task starts. Read-only
list, status, inspection, and dashboard views do not establish associations.
Session replacement updates the association; detach removes it. Entries identify
the exact native parent and configured store. Copied forks and new sessions do
not inherit another parent's ownership. Associations cover all native branches;
tree navigation does not undo ownership. There is no inference from session
names, transcript text, the store inventory, or historical records without an
association. Existing self and ancestor send/steer controls do not add ownership
backedges. Explicit attachment still rejects cycles; owner-wait controls still
reject self-targets.

An association append exception blocks further association and task admission
for that parent in its retained owner, including across reload. An in-memory
entry left by Pi is not proof of a successful save. Deferred replacement and
detach updates remain pending; reload does not replay them after a write failure.
Agent-owned primary footer persistence and message delivery pause, while visible
totals and pending results remain in memory. Replacement or detach refused before
mutation leaves ownership intact. If its association write fails after the native
transition, the error reports the completed replacement or closed child rather
than claiming rollback or starting a detached run.

If the affected parent is itself a managed worker, the host refuses a new
operation start and does not append its operation result through the uncertain
history. The settled result remains available only from that live owner;
`agent_inspect` labels it unsaved and pages it with `offset=result.nextOffset`
without `entryId`. It is lost when that owner closes. Native entries remain
separately readable by their entry IDs.

This refusal is not native-history repair. Pi 0.87.1 advances its in-memory leaf
before persistence and exposes no rollback through a tool context. A failed tool
can still be followed by native tool-result and assistant writes that refer to
an entry absent from disk. Those later writes can break the saved context chain.
With no intervening native writes, reopening reads the prior saved context;
a new process does not repair a file whose later writes already broke that chain.
Resolve the native history and ownership boundary before further work. The
extension neither patches Pi nor edits its private history state.

Reopening the exact saved primary through `--session <UUID>` or `-r` opens its
associated ordinary children idle, including their saved nested associations.
Shared children open once; cycles are refused. Each unavailable child reports
its own failure without preventing independent children from opening. Current
model, project-trust, and exclusive-claim checks still apply. A denied project
trust decision excludes project resources rather than replaying prior trust.
An unavailable model requires explicit repair. A foreign or retained writer
claim still requires ownership resolution.

A parent created before association records existed restores no inferred
children. Explicit `agent_attach` or `/agent attach` opens a known child without
a task and records the association for that parent. Save the native parent
before expecting later process recovery. Pi buffers custom entries until its
first assistant message flushes the file. An in-memory session or an unflushed
parent therefore has same-process continuity only. This is not a record migration.

A rejected native reload before runtime replacement retains the old invalidated
runner. A later successful reload rebinds control, and its retained shutdown
handler still closes the children on true quit. Pi also permits a different
failure: its loader reports an extension factory error, omits that extension,
and completes reload. If it omits this extension, the parent loses agent tools
and shutdown handlers while retained children and writer claims remain live.
A later successful reload recovers control. True quit from the omitted-extension
runtime cannot call the lost cleanup handler. Pi 0.87.1 exposes no finalizer for
that discarded extension owner; this cleanup guarantee is blocked at the native
host. The extension adds no process hook or polling substitute. After process
exit, retained claims still fail closed and require the ownership check described
above before manual removal.

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
editor tests cover command completion. Synthetic inspection tests cover typed
omissions, unchanged native entries, and Unicode continuation through live-owner
and read-only projections. Loader tests verify the public inspection registration;
they do not establish behavior in an already-loaded host. Component tests cover
dashboard paging, omission labels, refresh, disposal, source failures, and send-call expansion. Native TUI changes
also require an isolated interactive or PTY check for keys, focus, resize, and
tool expansion; component snapshots alone do not establish those behaviors.

Repository gates are `npm test`, `npm run lint`, `npm run typecheck`, and
`npm run check`.
