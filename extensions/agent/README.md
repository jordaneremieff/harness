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
- The primary talks to the host through a local authenticated socket. Closing
  a client or canceling an observation does not cancel admitted work.
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
| `agent_attach` | Connect to the owner without a new prompt; retained unfinished work resumes. |
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

## Recovery and delivery

An admitted input has a stable Durable request ID. Reconnecting or retrying the
same admission reuses that identity. A pending delivery intent precedes input
admission, so a crash between those operations does not lose the owner link.

Model requests resume from native checkpoints after process loss. Unsafe tools
that started but did not commit a result are not executed again automatically;
Durable records an interrupted result for the next model step. This does not
promise general exactly-once external effects, power-loss durability, or
termination of an uncooperative shell descendant.

Retained outcomes include submission and answer entry IDs. Reports and results
wait in Durable documents for the addressed owner. An ordinary primary sends
its native message before it acknowledges that source. A Durable owner receives
a native follow-up with a stable request ID before the source is acknowledged.
Cross-host delivery has no shared transaction. The native request ID deduplicates
retries to Durable owners; a crash after ordinary-primary message delivery but
before acknowledgement can repeat that notice. Source IDs identify repetitions. A delivery
receipt never proves task acceptance or that an agent acted on a correction.

## Observation and dashboard

Observation uses public Durable entries, documents, submissions, task outcomes,
and views. An inactive storage is copied with Node's SQLite backup API and read
without `resume()`. The bounded copy is disposable; inspection never decodes
private SQL or becomes a source writer.

History, exact entries, branch reads, searches, and results have explicit bounds
and continuation fields. Continue an incomplete page even when it has no
matches. Provider signatures, image payloads, and redacted thinking are omitted
with markers and counts. Task outcomes are execution evidence, not acceptance.

The dashboard receives native conversation records through `dashboard-types.ts`.
It does not parse ordinary JSONL. The footer shows active conversations and
retained native cost. `+?` marks incomplete or unreadable cost. Repeated
observations do not accumulate the same usage twice.

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
conversation state. Host endpoints and claims live under
`<agentDir>/durable-hosts/`. Long Unix socket paths use a short disposable path
under the system temporary directory.

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
