# Agent

Agent controls run each new agent on Pi Durable. A storage has one independent
host process and one SQLite database. Quitting the primary Pi process closes
its client connection, not the agent's work. Reopening the primary reconnects
to its agents and recovers unfinished work when their hosts died.

The ordinary primary still owns its terminal, `/restart`, and primary
self-compaction. `/agent` and `ctrl+alt+g` open the peer window: the real
primary conversation and a Durable agent side by side, each with its own
transcript, editor, and footer. The primary pane is a projection of the actual
ordinary session, not a second session; its native InteractiveMode stays
underneath and Escape returns to it.

## Runtime and identity

- A root agent's external ID is its storage ID. A fork or child has the ID
  `<storageId>:<conversationId>`.
- A native fork stays in its source storage. A child at the same cwd is a
  conversation owned by a background task in that storage. A child at a
  different cwd gets new storage and its own cwd-bound services and host.
  Native documents retain the owner association; results return as deduplicated
  follow-up submissions to the parent's host. A separate root gets new storage.
- Each storage has one writer claim. The process takes it before it opens
  SQLite or resumes the Durable scheduler. A live or unverified claim refuses
  a second writer. A dead local owner permits a replacement.
- The primary talks to the host through the public `pi-server`/`pi-client`
  Unix transport (the Pi service protocol). A private 0700 directory, an
  owner-only 0600 socket, and the exact `serverId` handshake are the boundary;
  no token crosses it. Closing a client or canceling an observation does not
  cancel admitted work.
- The primary registers one channel over the same public transport. That channel
  returns peer messages and answers the host's project-trust prompts.
- Host retirement requires no clients and no active work. `PI_AGENT_IDLE_MINUTES`
  controls the idle interval; zero disables retirement.

`durable-runner.ts` starts the process, `durable-runtime.ts` assembles its
capabilities, and `durable-host.ts` uses public Durable operations. Pi Durable
owns generation, task checkpoints, submissions, replay decisions, native
entries, documents, compaction, and outcomes. The extension owns process
exclusivity, discovery, controls, delivery, and presentation. It does not run an
ordinary `AgentSession` behind a Durable transcript.

The package declares Pi Durable, Codemode, MCP, and Chord as runtime dependencies.
Core coding-agent services come from the primary's selected public Pi package
entrypoint. No private upstream implementation is imported or copied.

## Capabilities and project resources

The host calls public `createAgentSessionServices()` at the selected cwd with
its own EventBus. This preserves settings, configured package routing, resource
loading, project trust, and configured provider registrations. `ModelRuntime`
supplies Durable's public model interface directly.

Trust uses the explicit decision when supplied, then the loaded extension
handlers, saved decision, and settings default. A headless unresolved `ask`
decision does not grant trust. Project-local resources remain subject to that
selection.

Configured extension factories emit native contributions through the
[Durable contribution contract](../../docs/conventions/durable-contributions.md).
The host matches each contribution's source to the loaded extension entrypoint.
It opens the Harness without scheduling, supplies that Harness to contribution
factories, installs built-ins and contributions in load order, then resumes.
A configured extension without a contribution is named in status and the prompt. The host
does not substitute ordinary execution for that missing capability.

The host supplies:

- Native `write`, `edit`, and `bash`, with unsafe replay classifications.
- A native `read` around Pi's public stateless reader, including image blocks.
- Prompt sections for the coding task, context files, skills, appended system
  prompts, cwd, date, and capability limits.
- Agent controls as a native contribution. Child ownership and reports use
  native tasks, documents, and submission request IDs.
- Codemode through public `CodemodeSandbox`, and MCP through public `McpClient`.
  Nested calls are Durable tasks with committed intent, validation, hooks, and
  retained results. Scripts remain unsafe after interruption.

Structured tool objects use `details.structuredContent` and an `outputSchema`
registration. Direct image reads retain image blocks. Script discovery uses
`searchTools`, `describeTool`, `describeNamespace`, and `ALL_TOOLS`. Tool
selection and MCP server configuration follow the current Pi settings.

## Controls

| Tool | Effect |
|---|---|
| `agent_spawn` | Create a root storage. Inside a Durable agent, the same cwd uses a native child; a different cwd uses a new storage host. An optional prompt starts work. |
| `agent_send` | Admit a task, report, or correction. Busy recipients receive Durable steering. With `deliverAt` (an absolute ISO 8601 time) and an optional `mode` (`followUp` by default, or `steer`), schedule the input as a durable timer instead. |
| `agent_steer` | Admit steering through the recipient's storage owner. |
| `agent_abort` | Abort the selected conversation without deleting its retained evidence. With `timerId`, cancel only that scheduled input. |
| `agent_reset` | Start a new context for the selected conversation with an optional handoff note. History, identity, files, settings, and timers stay; no model turn starts. |
| `agent_attach` | Connect to the owner without a new prompt; retained unfinished work resumes. An explicit model is applied first; a failed configuration returns its failure instead of a status snapshot. |
| `agent_configure` | Change an idle conversation's name, exact model, or reasoning level. |
| `agent_fork` | Create an idle native fork at an entry or current leaf. |
| `agent_rewind` | Fork before a mistaken entry and submit a correction. Files remain current. |
| `agent_compact` | Abort another conversation's active work, then run native compaction. Self-compaction uses its completed tool boundary. |
| `agent_command` | Invoke a contributed command, reload host registrations while idle, or fork to a tree entry. |
| `agent_place` | Resolve the longest directory binding, or create one, with optional work. |
| `agent_list` | Page through stored identities and conversation metadata. |
| `agent_status` | Read conversation and host state, including capability limits. A selected session lists its pending timers, nearest deadline first. |
| `agent_inspect` | Read bounded native entries, activity, branches, literal search, or retained results. |

All agents have independent process lifetimes. There is no separate detach
operation or detached-run registry.

`/agent` exposes `new`, `list`, `status`, `send`, `steer`, `abort`, `attach`,
`fork`, `compact`, `inspect`, `rewind`, `configure`, `command`, `place`, `places`,
`unbind`, `reset`, `schedule`, `timers`, and `timer-cancel`. `help` shows action
syntax. Tab completes actions and session identities without executing them.
Without an action, `/agent` opens the peer window.

`/agent unbind <area>` removes only the directory binding. It does not delete
storage or abort work.

A blank configure name clears the stored name. An exact `provider/model` is
validated against the configured catalog, and the requested reasoning level is
clamped by Pi. Configuration requires an idle conversation, starts no task, and
changes no global defaults. A mutation result carries a compact status:
identity, conversation, name, cwd, busy state, model, and the capability limits
that matter. The full status stays available through `agent_status`. If the
post-mutation status read fails, the result carries `snapshotError` and the
successful receipt stays.

The `/agent` control actions return short human text and, when an action creates
or selects an agent, that agent's identity. Observation actions (`list`,
`status`, `inspect`, `places`) keep their retained evidence. The status card
labels its newest text by state: an active conversation shows `Working on the
task`, and an idle conversation shows `Latest message`. The status contract
carries no author role, so the card does not present that text as a pending
assistant reply.

## Recovery and delivery

An admitted input has a stable Durable request ID. Reconnecting or retrying the
same admission reuses that identity. A pending delivery intent precedes input
admission, so a crash between those operations does not lose the owner link.

Model requests resume from native checkpoints after process loss. Unsafe tools
that started but did not commit a result are not executed again automatically;
Durable records an interrupted result for the next model step. This does not
promise general exactly-once external effects, power-loss durability, or
termination of an uncooperative shell descendant.

Retained outcomes include submission and answer entry IDs. The source storage's
durable-delivery watcher is the sole retained-output delivery owner: after every
native commit it settles intents atomically and groups receipts by native answer
entry. A result notice lists every submission that shares that answer. Primary
notice details retain each submission's request, operation, input entry, owner,
and admission origin.
Each recipient receives one notice for that answer,
including when owner routes overlap. Distinct answers and unanswered submissions
stay separate. The watcher acknowledges every receipt in the answer group in one
commit only after all required recipients accept it. Reports remain separate. A catalog owner receives an untrusted
follow-up in its own host. A noncatalog owner is an ordinary primary reached
through its registered primary channel. Only an absent or proven-dead owner
endpoint permits fallback: the watcher broadcasts to every live primary within
one bounded discovery of registered endpoints, and each delivery is labeled
`no live owning session` while the original owner identity stays in the message
details. It acknowledges the row only after discovery and every delivery
complete; a partial or unavailable scan leaves the row pending and reports that
coverage explicitly. A live or unknown owner endpoint refuses fallback and
retries. The primary does not poll receipts. Delivery is at-least-once; stable
answer-based request and source IDs let each receiver deduplicate retries and
host restarts. A primary process loss after display but before acknowledgement
can repeat a notice if its in-memory deduplication was lost. Transmitted peer bodies have a
text bound and an explicit truncation marker; `agent_inspect` retains access to
the full source. A delivery receipt never proves task acceptance or that an
agent acted on a correction.

Each admission records its origin before the submission: `operator` for the
peer-window composers and `/agent` actions, `model` for agent tools. The delivery
intent stores that origin, so it survives a host crash and relaunch; an intent
from before the field existed reads as `model`. An operator-only answer group
displays and retains its notice with no primary turn and no steering. When any
submission in the answer group came from a model, the notice keeps the wake
behavior. A fallback broadcast never wakes a recipient's model. The notice
names the agent by stored name, first-task excerpt, or short identity; full
identities and submission rows stay in the details. The notice card shows the
agent label, the outcome (finished, failed, or stopped), the answer body, and
how to open the peer window; the model-facing caveats stay in the message
content, not the card. Catalog follow-ups between Durable hosts keep their
existing form.

A scheduled input is a native `agent.timer` background task in the target's
storage. Its input persists the absolute deadline, target conversation,
message, mode, admission origin, and a deterministic request ID before it
waits on Durable's task-context `sleep(until)`. Replay never recomputes the
deadline. On fire it admits the input once through request-ID deduplication,
and the answer follows the notice and wake rule of its origin. A timer that
was due while its host was down fires once after the host reopens and records
that it ran overdue. A pending timer is live work, so the host does not retire
while it waits. A timer fires only while its storage host runs; Pi starts no
operating-system alarm, and a reset never cancels a timer.

A reset admits a native `pi.reset` write with an optional handoff message. It
places at the next boundary when the conversation is busy, starts no model
turn, and leaves history inspectable.

A registered primary refreshes its recorded model, reasoning level, and session
name when the ordinary session changes them, so `agent_status` and endpoint
discovery report the identity the operator runs.

The host sets a top-level `recoveryDue` marker before it admits work, and when
opening finds pending native work or pending delivery. Startup recovery reads
only that marker from bounded catalog pages; it does not open, copy, or
status-probe every storage. Recovery acquisitions run at most two at a time. A
transient recovery link closes when the internal `recovery-state` check reports
no pending native work and no unsettled or unacknowledged delivery; host change
notifications trigger that check, not polling. The marker clears only on a clean
close with nothing pending.

While a primary remains registered, an unexpected host connection loss rereads
that marker and queues recovery through the same bounded pool. The manager owns
these relaunches; managed connections do not independently relaunch on request
retries. Three automatic replacements are permitted per storage within sixty
seconds. Further losses stop automatic recovery and put a host error in the
All view's Attention group. Inspect the error, then use `agent_attach` to clear the
stop and retry. Intentional disconnects and unmarked storage do not relaunch.

## Observation and the peer window

Observation uses public Durable entries, documents, submissions, task outcomes,
and views. The roster needs no storage read; a deep read of an inactive storage
uses a cached public snapshot and never `resume()`s the Harness. The copy is
disposable and inspected only through public reads; it never decodes private SQL
or becomes a source writer.

History, exact entries, branch reads, searches, and results have explicit bounds
and continuation fields. Continue an incomplete page even when it has no
matches. An activity digest, including live metadata and coverage, is at most
16,000 UTF-8 bytes. Error rows take priority. Coverage reports dropped rows,
truncated metadata, scan limits, and the exact serialized size. Its cursor
continues an unfinished scan, not rows dropped by the digest bound. A no-target status is byte-bounded: it reports the measured byte figure
and separate omitted counts for sessions, primaries, and failures, then points
to `agent_list` for paged discovery. Provider signatures, image payloads, and
redacted thinking are omitted with markers and counts. Task outcomes are
execution evidence, not acceptance. Hidden native kinds such as `pi.system`
never consume the transcript bound, and a snapshot page continues to earlier
entries through its `before` anchor. A status carries the author role of its
newest text, so the card says `Latest reply` or `Latest input`.

### Peer window

The window is one full-screen overlay: a strip with the All count and key hints,
then two equal panes. The left pane is the real primary; the right pane is the
selected Durable agent. Each pane has a transcript viewport, its own editor and
draft, and a footer with model, reasoning level, retained cost, and state. The
editor and footer sit on the pane's bottom rows. F2 and F3 focus the primary
and agent panes, F4 expands or restores the focused pane, F5 closes it without
aborting work, F6 opens All, F7 starts a new agent, F8 opens Tasks, and
PageUp/PageDown scroll. The editors accept the same actions as slash commands:
`/all`, `/new`, `/view`, `/focus`, `/expand`, `/restore`, `/close`, `/tasks`,
`/fork`, `/repair`, `/scroll`, `/mode`, `/steer`, `/send`, `/followup`,
`/auto`, `/refresh`, `/pi`, `/continue`, and `/help`. Escape returns to native
Pi without aborting either peer. Drafts, reading positions, and follow state
survive focus changes, Expand, Close, and reopening within the Pi process.

The primary pane projects the actual ordinary session from
`ctx.sessionManager` and public message, tool, and run events. Plain text goes
to that session through `pi.sendUserMessage`, as steering or a follow-up while
it is busy. Any other slash text moves to the native editor through
`ctx.ui.setEditorText` and returns focus to Pi, so Pi owns command expansion,
completion, attachments, and submission; the window never submits slash text.
An existing native draft is kept for restore. The primary's fork and tree
navigation stay native Pi actions.

The agent pane renders Pi's published chat components: user inputs, assistant
text, thinking collapsed as the primary chat shows it, tool calls with their
stored arguments and the built-in presentation when one exists, and each
result attached to its call. A contributed tool without a built-in
presentation shows its name and arguments as readable text. The host publishes
live frames from Durable views over the same transport: committed partial
assistant text, thinking, and running tool output arrive before the turn
ends, and the committed entry replaces its partial. Frames carry a revision
and coverage, one watch serves every observer of a scope, and the last close
stops it. Observation attaches to a running host; it never launches one.
Two Pi windows on one store follow and steer the same agent through its single
host; closing one window aborts nothing. The agent composer admits operator
input as a follow-up or steering. Fork and Repair act on a committed entry and
place the new conversation beside its source; files do not roll back.

Tasks shows the selected storage's live task graph from Durable's
`watchTaskGraph`: kind, state, phase, background boundary, abort request, and
owned conversations. Selecting a conversation opens it. Terminal tasks leave
the graph; their results stay in the transcript. A storage without a running
host reports `no live host`, because Durable publishes no cold task-graph read.

The window does not embed InteractiveMode. The published extension API exposes
no live InteractiveMode view, editor state, dialog, widget, or renderer
registry to mount in a pane, and `getAllTools()` returns tool metadata without
renderers. Those layers, and upstream's experimental coding-agent client and
services (`packages/coding-agent/src/experimental`), are source-only.

### All view

The All view receives host-published conversation metadata through
`dashboard-types.ts`. It does not parse ordinary JSONL. Each Durable host
publishes one bounded view beside its catalog record: rows, `updatedAt`,
`coverage.complete`, `coverage.omitted`, and an optional `unavailable` reason.
The All view reads only those views. It does not bootstrap services, copy a
database, or launch a host for the roster. Missing or unavailable metadata is an
explicit `unavailable` row, not proof of absence.

Its roster is one bounded page: rows plus coverage (`complete`,
`storagesVisited`, `skipped`, `omitted`, `nextCursor`). Coverage names skipped
stores and rows not loaded; a continuation cursor means more inventory to
inspect and may end at an empty page, so a bounded or empty page is not proof of
absence. A row whose writer claim is absent or dead is metadata from a stopped
host: owner `unknown`, and a previously `working` state shows as `interrupted`.
`ownerLabel` names the host metadata timestamp and any unreadable-claim error.
Host health fields are retained at the view's publication time, not a fresh
check; a later view can clear them. The manager adds its current recovery errors,
including crash-loop stops, without changing the host's published view.

A transcript page can omit the oldest entries. The agent pane then shows the
first task from the session summary above the retained entries and labels the
transcript partial; scrolling above the first loaded entry reads the earlier
page through its `before` anchor. Blank-line runs between blocks are reduced to
one line.

View → Agent actions opens the native action list for the agent in the pane.
A native prompt or dialog takes the screen while it is open, and the window
returns afterward. A result shows its display text and names the affected
agent; a result that carries a new agent identity opens that agent. Prompts
name an agent by its stored name, else a first-task excerpt, else a short
identity. An active All filter stays visible with its match count; Escape
clears the filter before a later Escape closes All.

Attention means a row needs operator action: an unavailable or claim-conflicted
storage, a host's last error or failed compaction, a failed run that carries an
error, or a provider retry whose attempts are exhausted. A stopped session and
an interrupted turn keep their state glyph in their date group; a terminal
outcome without an error is a record, not a request.

Opening a stopped agent uses a deep read. The cold path opens a cached public
snapshot of the storage database; the cache key includes the database and WAL
identity by device, inode, size, and nanosecond modification time, plus writer
claim state. An unchanged identity reuses the snapshot and its bounded per-method
result cache without services, model runtime, or extension bootstrap. A changed
identity requires another copy; a missing or unstable source refuses the read.
The snapshot writes no source content and resumes no Harness. The public SQLite
backup path can create source sidecars; an absent WAL becoming an empty WAL does
not invalidate that snapshot. Other identity changes during the copy refuse
caching. Cache operations serialize to protect snapshots during reads and
eviction. The footer formats
active conversations and retained native cost from the same published rows and
refreshes on host change notifications, not a receipt poll. `+?` marks
incomplete or unreadable cost. Repeated observations do not accumulate the same
usage twice.

## Primary restart and continuity

`/restart` performs the ordinary Pi shutdown and restarts the CLI with its saved
session. It refuses unsaved sessions, active primary work, and unsupported host
modes. Independent Durable hosts continue. Other extensions' process-local work
still ends with the primary process.

Primary `agent_compact` requires an agent-authored summary and retains the whole
requesting tool batch. It uses the ordinary `turn_end` boundary. A native Durable
agent uses Durable compaction and its own task boundary, not an ordinary
SessionManager.

## Configuration and storage

| Variable | Meaning |
|---|---|
| `PI_AGENT_DIR` | Pi configuration directory, otherwise public `getAgentDir()`. |
| `PI_AGENT_SESSIONS_DIR` | Agent store root, otherwise `<agentDir>/agent-sessions`. |
| `PI_AGENT_IDLE_MINUTES` | Idle host retirement interval. Default 5; zero disables; finite range 0 through 35791. |

Current storage lives under `<store>/durable/`: a bounded discovery metadata
record and a SQLite file for each storage, plus directory bindings. Metadata
locates a storage; native documents and entries remain authoritative for its
conversation state. The catalog record also carries the optional bounded `view`
published by its host and the host-local `recoveryDue` marker; neither is
storage identity, and host metadata strips both. Directory bindings live in one
`PlaceBook`; native and
primary controls resolve the same binding, and the longest bound directory wins.
Host endpoints and claims live under `<agentDir>/durable-hosts/`; primary channel
endpoints live under `<store>/.primaries/`. Long Unix socket paths use a short
disposable path under the system temporary directory.

Old ordinary agent files stay on disk untouched. The extension does not migrate
or read them through a compatibility path. A process with the old manager
protocol requires a Pi restart before the changed controls load.

## Checks

Run focused tests with `node --test "extensions/agent/*.test.mts"`. The normal
repository gates are `npm run lint`, `npm run typecheck`, `npm run check`, and
`npm test`. `node scripts/extension-load-check.mts extensions/agent/index.ts`
checks extension loading in a fresh process.

Native tests exercise real Harness instances and faux providers. Process tests
use SIGKILL during a model request and after an unsafe effect through the
production runner, then reopen and inspect retained admission and results.
Those tests cover their checkpoints, not arbitrary power failure or all models.
