# Agent

Agent controls run each new agent on Pi Durable. A storage has one independent
host process and one SQLite database. Quitting the primary Pi process closes
its client connection, not the agent's work. Reopening the primary reconnects
to its agents and recovers unfinished work when their hosts died.

The ordinary primary still owns its terminal, `/restart`, and primary
self-compaction. `/agent` and `ctrl+alt+g` open the agent dashboard. That board
reads Durable conversations; it is not the upstream equal-peer terminal client.
The published coding-agent package does not expose that client integration.

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
| `agent_send` | Admit a task, report, or correction. Busy recipients receive Durable steering. |
| `agent_steer` | Admit steering through the recipient's storage owner. |
| `agent_abort` | Abort the selected conversation without deleting its retained evidence. |
| `agent_attach` | Connect to the owner without a new prompt; retained unfinished work resumes. An explicit model is applied first; a failed configuration returns its failure instead of a status snapshot. |
| `agent_configure` | Change an idle conversation's name, exact model, or reasoning level. |
| `agent_fork` | Create an idle native fork at an entry or current leaf. |
| `agent_rewind` | Fork before a mistaken entry and submit a correction. Files remain current. |
| `agent_compact` | Abort another conversation's active work, then run native compaction. Self-compaction uses its completed tool boundary. |
| `agent_command` | Invoke a contributed command, reload host registrations while idle, or fork to a tree entry. |
| `agent_place` | Resolve the longest directory binding, or create one, with optional work. |
| `agent_list` | Page through stored identities and conversation metadata. |
| `agent_status` | Read conversation and host state, including capability limits. |
| `agent_inspect` | Read bounded native entries, activity, branches, literal search, or retained results. |

All agents have independent process lifetimes. There is no separate detach
operation or detached-run registry.

`/agent` exposes `new`, `list`, `status`, `send`, `steer`, `abort`, `attach`,
`fork`, `compact`, `inspect`, `rewind`, `configure`, `command`, `place`, `places`,
and `unbind`. `help` shows action syntax. Tab completes actions and session
identities without executing them. The dashboard supports selection, direct
messages, steering, a new task, and a configuration dialog.

`/agent unbind <area>` removes only the directory binding. It does not delete
storage or abort work.

A blank configure name clears the stored name. An exact `provider/model` is
validated against the configured catalog, and the requested reasoning level is
clamped by Pi. Configuration requires an idle conversation, starts no task, and
changes no global defaults. Fork, rewind, and configure results carry a bounded
status snapshot; if that read fails after the mutation, the result carries
`snapshotError` and the successful receipt stays.

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
notice details retain each submission's request, operation, input entry, and owner.
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
board's Attention group. Inspect the error, then use `agent_attach` to clear the
stop and retry. Intentional disconnects and unmarked storage do not relaunch.

## Observation and dashboard

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
execution evidence, not acceptance.

The dashboard receives host-published conversation metadata through
`dashboard-types.ts`. It does not parse ordinary JSONL. Each Durable host
publishes one bounded view beside its catalog record: rows, `updatedAt`,
`coverage.complete`, `coverage.omitted`, and an optional `unavailable` reason.
The board reads only those views. It does not bootstrap services, copy a
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

Attention means a row needs operator action: an unavailable or claim-conflicted
storage, a host's last error or failed compaction, a failed run that carries an
error, or a provider retry whose attempts are exhausted. A stopped session and
an interrupted turn keep their state glyph in their date group; a terminal
outcome without an error is a record, not a request.

Board detail selection uses a deep read. The cold path opens a cached public
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

The actual primary Pi conversation remains an ordinary terminal session. The
board does not display a fabricated Durable copy as that primary. Equal-peer
navigation of the real primary and agents requires a published upstream client
integration beyond the current extension surface.

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
