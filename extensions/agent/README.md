# agent

Create and control durable Pi sessions from another Pi session. Each session
uses AgentHarness, Pi's durable execution core, with the ordinary extension
loader and extension host. The primary session stays available while the agent
works. The separate `subagent` extension remains independent.

This extension provides runtime tools and a native `/agent` command. It does
not provide a session browser, conversation editor, workspace, or custom TUI.

## Start and control sessions

Enter `/agent` for help. Add a space to see actions in Pi's native completion
menu. For separate work, describe the task directly:

```text
/agent new Check the error handling
```

The session uses your current directory, model, and thinking level. Without a
prompt, the command creates a session without starting a task. Command output
uses native host notifications. RPC receives these notifications; Pi's
print/JSON no-UI context discards them. Model-facing tools return their output
as tool results instead.

### Discover an action

- `/agent help` lists actions with plain outcome descriptions.
- `/agent help send` or `/agent send --help` shows that action's syntax and
  guidance. `-h` also requests help. Missing or extra arguments show the relevant
  help before any operation starts.
- Type part of an action or outcome, such as `/agent stop`, then press Tab to
  choose **abort** without running it. Arrow keys select another suggestion.
  After native Tab completion closes the menu, type part of the next argument.
- For a session argument, type part of a known name, directory, or ID. Tab
  inserts the complete ID. Names come only from sessions already open in this
  process; unopened sessions use their directory and an ID suffix. Descriptions
  distinguish stored sessions, open sessions, active work, and detached runs.
- `/agent runs` offers run choices by task, directory, or run ID. Suggestions
  use run records, not reopened sessions.

Completion reads metadata without opening stored workers. Detached sessions
appear for **status**, **steer**, and **abort**, which contact the owning process.
Other operations enforce trust and ownership at invocation. Unavailable
metadata supplies no choices; an explicit command reports the underlying error.
Prompts and messages remain free text, without placeholder or model-ID suggestions.

| Action | Result |
|---|---|
| `new [prompt]` | Create a separate session and optionally start work. |
| `list`, `status [session]` | List sessions or request one session's status. |
| `attach session [provider/model]` | Reopen a session without starting work; optionally repair its idle model choice. |
| `send session message` | Start the session's next task; active work refuses another task. |
| `steer session message` | Redirect current work through its durable queue. |
| `abort session` | Stop the operation without deleting the session. |
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
communication, and control to models. Pi's tool schemas define their parameters.

`agent_inspect` reads actual session entries and execution/result state. Its
bounded previews retain entry IDs and roles. Use an entry ID and the returned
offset to read a complete entry in chunks; use the returned cursor for older
entries. This reads the harness's public session data, not raw files.

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

A durable session keeps its state on disk, but its execution belongs to the
process that owns the store. `agent_detach` and `/agent detach` start a new
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
session for writing. Status, inspect, steer, and abort reach that existing
owner through Pi's public client/server transport and Chord service endpoints.
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

A successful steer confirms durable queue admission, not delivery or action.
At finalization, the run seals controls, drains admitted calls, checks idle
again, and reads a fresh lane snapshot. If input remains queued, the result is
failed with an explanation; the entries remain durable for later inspection.
The run does not delete them or start another operation automatically. Endpoint
and worker cleanup finish before the terminal result is published.

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
reads bounded entries and execution state from the owner. After settlement,
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

Control requests have a 15-second deadline. Steering text is limited to 128 KiB;
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
`<store>/.claims/`. Normal close releases it only after session storage closes.
An abrupt process exit retains the claim, so reopening then fails closed.
The error names the claim file. Confirm that no writer survives before manual
removal; the extension never guesses that another process is safe to replace.
Claims coordinate agent-extension processes on the same local filesystem;
they do not fence arbitrary programs that bypass the store.

## Collaborate between sessions

`agent_send` addresses a session by its full ID. A message from another session
retains the sender, recipient, message ID, and optional `replyTo` reference.
An idle recipient starts a turn; an active recipient receives the message
through its steering queue. A peer report also reaches a primary Pi session.

Admission means the message entered the recipient's execution path. It does
not mean that the recipient replied, understood the message, or acted on it.
Peer content remains reported data, not operator authority. Ask a collaborating
session to send its result to the intended recipient. A normal terminal result
does not impose a separate submission protocol.

## Resources and continuity

Each session resolves tools, extensions, skills, prompt templates, instructions,
settings, and project trust at its own cwd and agent directory. Built-in tool
execution uses that cwd. Extension tools and provider registrations participate
through the ordinary public host APIs. Project resources use ordinary trust
decisions and hooks. The primary session supplies a native trust prompt when
available; an undecided trust-gated project remains untrusted otherwise.

Worker extensions use Pi's native headless `ExtensionRunner` context:
`mode: "print"` and `hasUI: false`, including after reload. Their notifications,
widgets, and editor writes have no terminal effect. Dialogs return the native
no-UI values, such as `false` for confirmation and `undefined` for selection or
input. A worker does not borrow its primary session's editor, dialogs, status,
shortcuts, or custom renderers. Runtime hooks and extension commands remain
available through the ordinary host execution paths.

The worker sends structured prompt options through Pi's ordinary
`before_agent_start` chain. Context files, skills, tool snippets, tool rules,
custom sections, and exact prompt replacements retain their native meanings.
The worker reads Pi's rendered event prompt after the complete handler chain;
it does not copy Pi's prompt renderer or import private modules. Changes to
selected tools also change the executable lane tools. Explicit structured
selection takes precedence over a simultaneous `setActiveTools()` call.
The stored tool selection survives reopen, including an empty selection.
A render-only public ExtensionRunner supplies the base and recovered prompts;
there is no separate local prompt renderer.

Each new run records its final structured prompt inputs with that operation's
ID in the session store. A recovered operation restores those inputs without
repeating extension hooks or their side effects. Current tools still come from
the durable lane configuration. Missing required recovery state causes an
explicit resume refusal; the host never guesses retired prompt state. The next
new run replaces the previous prompt record.

AgentHarness still accepts a rendered prompt string at its context hook.
This adapter does not claim the ordinary Agent's persisted section-patch or
prompt-cache behavior. The native lane remains the execution and storage owner.

Model choice is explicit or inherited at creation, then retained in the durable
session. A requested or inherited thinking level is clamped to the selected
model's supported levels, and a model switch clamps the retained level again.
Reopening does not substitute a fallback model. If the stored model is
unavailable, `agent_status` reports its exact identity and directory without
starting work. `agent_attach` accepts an optional explicit `model` value in
`provider/model` form; `/agent attach <session> [provider/model]` supplies the
same repair. The choice must exist in the current runtime and have configured
authentication. Repair preserves the conversation and changes only an idle
session with no queued input. An active operation retains its captured model;
repair does not abort it or replace that model. Restore that provider to resume
such an operation. Failed model validation leaves the stored choice unchanged.

Forks retain the source context and reconstruct cwd-bound resources. Setup
callbacks use Pi's real in-memory `SessionManager`. The final setup identity
and tree populate the durable session before AgentHarness takes ownership of
its execution state. The configured agent store determines the saved file
location; selecting an ordinary session file during setup imports its state
rather than relocating the durable store.

The synchronous extension view contains committed entries. An AgentHarness
append commits asynchronously, so an immediate read in the same callback does
not expose the pending entry. The host flushes pending actions at command and
model boundaries. It does not invent an entry ID, parent, or timestamp to
imitate a synchronous durable write.

`message_end` replacements apply to finalized assistant responses. Native
user, custom, and tool-result completion events are notification-only;
returning a replacement reports an extension error. Use the ordinary `input`
and `tool_result` hooks to transform user input and tool output before storage.
Structural hooks use complete replacement compaction or summary results.
Preparation-only mutations without a native result mapping are declined with
an extension error. These host boundaries differ from ordinary `AgentSession`
behavior; this extension does not claim exact API parity.

The harness owns the session tree, stored values, ordered inbox, model loop,
operation records, lane observation, and tool progress. The extension supplies
host integration and a synchronous view for ordinary extension APIs.

## Configuration

| Variable | Purpose |
|---|---|
| `PI_AGENT_SESSIONS_DIR` | Durable session store root, including `places.json`, `detached/` run records, and `.claims/` writer claims. Default: `<agentDir>/agent-sessions`. |
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

`PI_AGENT_LIVE=1 node --test extensions/agent/live.test.mts` exercises a real
provider with configured authentication, including the detached run process and
a rewind that re-derives work. The normal suite does not establish a live
provider run. It covers detached launch, ownership, and cleanup with isolated
processes and synthetic providers. Public Unix client/server tests cover
attachment, owner controls, cancellation, disconnection, route validation, and
cleanup. Separate-process recovery tests cover suspended operations, recorded
prompt restoration, and refusal of missing prompt state. Native editor tests
cover command completion; worker tests cover headless UI behavior through
reload. No custom interface or visual acceptance claim belongs to this surface.

Repository gates are `npm test`, `npm run lint`, `npm run typecheck`, and
`npm run check`.
