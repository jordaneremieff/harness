# Agent

Agent controls run each new agent on Pi Durable. A storage has one independent
host process and one SQLite database. Quitting the primary Pi process closes
its client connection, not the agent's work. Reopening the primary reconnects
to its agents and recovers unfinished work when their hosts died.

The ordinary primary owns its terminal, editor, transcript, `/restart`, and
self-compaction. `/agent` opens an agent dashboard over that workspace. The
existing `ctrl+alt+g` shortcut also opens it without changing your native draft.
The dashboard lists agents beside the selected live conversation on wide
terminals and above it on narrow terminals. Enter opens an agent console for
full-window conversation. Esc steps back to the untouched primary without
stopping work.

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
- Host retirement ignores passive clients and footer change subscriptions.
  `PI_AGENT_IDLE_MINUTES` controls the idle interval; zero disables retirement.
  Retirement requires no native live task or unsettled submission, no pending
  delivery row or in-flight delivery effect, no active request or host-local
  control, and no open conversation or
  task observation. Native check-in and timer tasks keep the host alive while
  they wait. Actual storage changes and completed requests start a new idle
  interval; passive connections and change subscriptions do not reset it.
  Closing the last observation starts a new interval. The open-to-subscribe
  gap counts as an observation, and close, abort, failed setup, and disconnect
  release its token. Concurrent token operations share one ownership line;
  failed initial frame construction rolls back only its new reference. A later
  frame failure reports the observation unavailable and releases its token,
  without closing the shared client.
- A process `close` request differs from a client disconnect. Idle shutdown
  finishes runtime cleanup, unpublishes the owned endpoint, releases the writer
  claim, then closes transport. Retirement rechecks native work and delivery
  against the admission generation, then seals both process and local controls
  without another asynchronous gap. The seal also stops new delivery effects.
  Delivery-pass completion starts a new idle interval, even if another caller
  acknowledged the row while its effect was in flight. Late controls receive a shutdown refusal;
  the manager does not retry mutations after transport loss. Final catalog
  publication precedes recovery-marker clearance. A failed final publication
  or marker write rejects shutdown and retains the writer claim until process
  death, rather than announce a clean retirement. Busy shutdown retains the recovery marker,
  attempts final catalog publication, seals native admission, and exits through
  the runner. It keeps the live claim until process death; the next host
  replaces the dead claim and resumes retained native work. Concurrent close
  paths share one shutdown. If reload fails after runtime teardown starts, the
  host returns the reload error and takes the same process shutdown path. It
  retains the recovery marker and writer claim until process death; the next
  acquisition starts a fresh host.
- Reload requires an idle storage and no live observation tokens. The runtime
  refuses reload before teardown while any observer remains, including native
  local command dispatch. Release the observers before reload; an attempted
  reload does not destroy an existing observation.
- Local protocol validation rejects only the malformed request and leaves its
  healthy connection usable. A failed runtime-version attachment disposes its
  client. Application or protocol errors from a live writer do not authorize a
  replacement process.

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
does not substitute ordinary execution for that missing capability. An extension
that fails to import or whose factory throws is named in the same places as
`failed`, with its path and a one-line error of at most 240 characters.

Model requests carry the storage identity as their session ID and the
configured transport, as an ordinary session's requests do. Providers that key
prompt caches by session, such as OpenAI Codex, therefore reuse cached context
across an agent's turns; forks in one storage share that key and their prefix.

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
| `agent_spawn` | Create a root storage. Inside a Durable agent, the same cwd uses a native child; a different cwd uses a new storage host. An optional prompt starts work. Model tool tasks get automatic owner check-ins; `checkInMinutes` sets the interval and 0 disables it. |
| `agent_send` | Admit a task, report, or correction. Busy recipients receive Durable steering. Unanswered model tool tasks get automatic owner check-ins; `checkInMinutes` sets the interval and 0 disables it. With `deliverAt` (an absolute ISO 8601 time) and an optional `mode` (`followUp` by default, or `steer`), schedule the input as a durable timer instead. |
| `agent_steer` | Admit steering through the recipient's storage owner. |
| `agent_abort` | Abort the selected conversation without deleting its retained evidence. With `timerId`, cancel only that scheduled input. |
| `agent_reset` | Start a new context for the selected conversation with an optional handoff note. History, identity, files, settings, and timers stay; no model turn starts. |
| `agent_attach` | Connect to the owner without a new prompt; retained unfinished work resumes. An explicit model is applied first; a failed configuration returns its failure instead of a status snapshot. |
| `agent_configure` | Change an idle conversation's name, exact model, or reasoning level. |
| `agent_fork` | Create an idle native fork at an entry or current leaf. |
| `agent_rewind` | Fork before a mistaken entry and submit a correction. Files remain current. |
| `agent_compact` | Abort another conversation's active work, then run native compaction. Self-compaction uses its completed tool boundary. |
| `agent_command` | Invoke a contributed command, reload host registrations while idle, or fork to a tree entry. |
| `agent_place` | Resolve the longest directory binding, or create one, with optional work. Model prompts use the same check-in default on both paths; optional `checkInMinutes` overrides it and 0 disables it. |
| `agent_list` | Page through stored identities and conversation metadata. |
| `agent_status` | Read conversation and host state, including capability limits. A selected session lists its pending timers, nearest deadline first. |
| `agent_inspect` | Read bounded native entries, activity, branches, literal search, or retained results. |

Each `agent_list` call collects one bounded catalog batch before it observes
hosts, so metadata rewrites during those observations do not invalidate that
fresh call. Continuations retain both the native page position and the catalog
revision. If the catalog changes before a supplied continuation resumes,
including a native continuation inside the final storage, restart discovery.

All agents have independent process lifetimes. There is no separate detach
operation or detached-run registry.

`/agent` exposes `new`, `list`, `status`, `send`, `steer`, `abort`, `attach`,
`fork`, `compact`, `inspect`, `rewind`, `configure`, `command`, `place`, `places`,
`unbind`, `reset`, `schedule`, `timers`, and `timer-cancel`. `help` shows action
syntax. Tab completes actions and session identities without executing them.
Without an action, `/agent` opens the dashboard. In the roster, Up/Down selects,
Enter opens the agent console, Tab or m focuses its message field, n starts an
agent, a opens contextual actions, / finds loaded agents, and ? shows help.
PageUp/PageDown reads the selected conversation. Ctrl+O expands tool output;
Ctrl+T toggles thinking. Esc clears a committed filter before closing the dashboard.

In a message field or agent console, letters are message text. Enter starts an
idle turn or steers working agents at the next step. Tab changes the current
draft to Follow-up after answer while the agent works. The field label names the
disposition. Ctrl+J adds a newline. Esc keeps the draft and returns to the roster.
There are no F-key controls, Alt controls, or typed dashboard commands.

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
`status`, `inspect`, `places`) keep their retained evidence. `/agent send`
admits a follow-up when the target is busy; `/agent steer` admits steering. The
model-facing `agent_send` tool keeps its documented steering disposition. The
status card labels its newest text by role and state: `Latest reply` or
`Latest input` when idle, and `Working on reply` or `Working on the task` while
active.

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
follow-up in its own host. A conversation in the same storage as the source
receives the answer as an in-storage follow-up, never through a primary route. A
noncatalog owner is an ordinary primary reached
through its registered primary channel. Only an absent or proven-dead owner
endpoint permits fallback: the watcher broadcasts to every live primary within
one bounded discovery of registered endpoints, and each delivery is labeled
`no live owning session` while the original owner identity stays in the message
details. It acknowledges the row only after discovery and every delivery
complete; a partial or unavailable scan leaves the row pending and reports that
coverage explicitly. A live or unknown owner endpoint refuses fallback and
retries. An owner endpoint carries the primary channel contract version. A host
that meets a live owner with another version holds that delivery pending and
reports the endpoint version and the restart that clears it; it never treats the
owner as dead and never falls back for it. A fallback broadcast checks every
registered primary before the first delivery, so one incompatible candidate
holds the whole fallback. The host keeps the latest routing failure in its
status as `deliveryError`, and the status card shows it. The primary does not poll receipts. Delivery is at-least-once; stable
answer-based request and source IDs let each receiver deduplicate retries and
host restarts. A primary process loss after display but before acknowledgement
can repeat a notice if its in-memory deduplication was lost. Transmitted peer bodies have a
text bound and an explicit truncation marker; `agent_inspect` retains access to
the full source. A delivery receipt never proves task acceptance or that an
agent acted on a correction.

Each admission records its origin before the submission: `operator` for the
dashboard and agent-console composers and `/agent` actions, `model` for agent tools. The delivery
intent requires that origin, so it survives a host crash and relaunch. An
operator-only answer group displays and retains its notice with no primary turn
and no steering. Wake follows the recipient's own admissions in the answer
group: one recipient's model-origin submission never wakes another recipient
whose submissions were operator-only. A fallback broadcast never wakes a
recipient's model. A receipt whose stored origin is missing or malformed is
reported and held pending; the watcher never defaults it to a model admission.
The notice
names the agent by stored name, first-task excerpt, or short identity. Its
single-line headline shows that label, the outcome, model, and reasoning level.
The collapsed answer uses a short visual-line preview, with Pi's expansion hint
only when text is hidden. It adds no navigation instructions or trailing blank
rows beyond native message spacing. Expanding the notice shows the full
received answer, source details including full identities and submission rows,
and `/agent opens the dashboard`. Model-facing caveats stay in the stored
message content rather than the answer preview. Catalog follow-ups between Durable hosts keep their
existing form.

Automatic owner check-ins do not depend on voluntary worker reports. Model
`agent_spawn` and `agent_place` prompts and `agent_send` tasks use `PI_AGENT_CHECK_IN_MINUTES`
(default 30); per-call `checkInMinutes` overrides it, including 0 to disable.
Operator admissions get no default. Native foreign admissions and local
Reporter admissions use the same interval and delivery contract. Scheduled
sends retain the selected interval before their deadline and start check-ins
when the input is admitted. Delivered reports, results, and check-ins never
arm another default check-in.

The host's `pi.host` built-in registers the check-in task independently of the
configured native agent contribution. Native Reporters arm check-ins only when
the host registry supplies that task. The runtime therefore owns availability.
A check-in is a native `agent.check-in` background task, armed atomically with
the delivery intent, or with the local Reporter's retained arming checkpoint.
The public admission API owns a separate commit. The task reacquires the input
by submitting its same request ID, then races its settlement wait against a
Durable deadline. Admission time and interval remain in the task input. The host supplies the
same configured Harness clock to intent admission and deadlines; native
Reporters and timers use their runtime clock. Production defaults to `Date.now`. A
notice row and the next interval checkpoint commit together. Stable source IDs
identify each watched request and interval. Reopening preserves that identity;
missed intervals collapse into one current notice, then the original cadence
continues. A newer notice replaces an older undelivered notice for that task
and owner. The report stores its digest only in `message`. Settlement ends the
deadline task promptly and removes all check-in rows for that request across
all owners, including acknowledged rows and fallback markers. Reset also ends them when its native boundary settles the input
unanswered; an idle background deadline never waits out its remaining interval.

Check-ins use the report owner route, version checks, deduplication, and
acknowledgement. A model-origin check-in wakes its live primary owner; an
explicit operator-origin interval stays quiet. An absent or dead owner gets at
most one quiet fallback broadcast per watched task and owner, recorded only
after every required receiver accepts it. Repeated intervals never broadcast
again for that owner. A failed or incomplete fallback stays pending.

The headline names the agent and says it is still working, not finished, with
elapsed time and retained conversation-total cost. The bounded body covers only
the watched task. Its retained-entry scan starts at the watched input's
transcript entry. It shows the task's tool call count, current tools, their call
age (not exact execution time), last tool lines, and a reply excerpt labeled as
unfinished. The count is exact when
the scan covers that range; a cut-off scan labels it as a lower bound. A current
tool stays visible when its call entry is outside the scan, with an unknown call
age. A queued input has no task activity yet. Before the task's first reply text,
the excerpt says "No reply text yet." Conversation cost includes earlier tasks
and excludes unreported in-flight usage. The coordinator assesses a check-in
and decides whether to report progress, let work continue, steer a wrap-up, or
abort a hung tool. Steering waits for a tool boundary and does not interrupt a
running tool.

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

The host runtime and the contribution code loaded in the same process share one
control binding. That binding carries a version: a native reload that pairs new
contribution code with a retained runtime of another version refuses with both
versions and a restart message, instead of dispatching across two contracts. An
open live observation reconnects to a live host only. The observation link
never relaunches a lost host; it signals its listeners unavailable and leaves
relaunch to the manager's bounded recovery pool. Separately, when any read
meets a host of another version, the manager applies the version check
described below. A listener that attaches after a frame arrives receives that
current frame at once.

The current host runtime contract is version 4. Version 4 permits retirement
with passive connections; version 3 still requires every client to disconnect.
Every host advertises a runtime version in its readiness line and answers a
`runtime-version` request. A host that reports no version predates the
handshake and reads as version 0. Process close requires runtime version 3. A
manager replaces only an older host with a supported close contract; it never
replaces a newer host. Compatible bounded reads from a newer host remain
available. Mutations and persistent observations of a newer host require a
restart of this Pi, and unsupported newer data receives an explicit version
error.

Versions 0 to 2 do not provide the current process-close contract, so their
automatic update is blocked. This manager disconnects from such a host after
the last concurrent bounded operation and refuses persistent observation of it.
Other Pi windows and live observations still prevent its idle retirement:
close every client, allow configured retirement after native work ends, then
use `agent_attach`. A manager loaded before the version-4 contract still retains
its ordinary clients after completion. A host whose Durable runtime already closed does not recover through idle
retirement.

An older host with a supported close contract is replaced when it is idle. The
manager first verifies that no native work or delivery remains, requests
process close, and checks the actual writer claim after close completion or
owned process exit before it acquires the replacement; neither a close response
nor socket loss alone authorizes replacement. While the host works, the window
keeps using the methods the host supports and marks the storage `Host runtime
version N; this Pi runs version M. It updates when idle.` Replacement never
interrupts active work and shares the three replacements per sixty seconds cap
with crash recovery; `agent_attach` clears a stopped update. A newer-only
method against an older host returns a clear refusal instead of a raw
unknown-method error. Local validation errors and live-writer application
errors never authorize another writer.

Owned launches supply readiness events. For a host launched elsewhere, this Pi
makes one bounded attach attempt and reports when no readiness event is
available.

The host sets a top-level `recoveryDue` marker before it admits work, and when
opening finds pending native work or pending delivery. Startup recovery reads
only that marker from bounded catalog pages; it does not open, copy, or
status-probe every storage. Recovery acquisitions run at most two at a time. A
transient recovery link closes when the internal `recovery-state` check reports
no pending native work and no unsettled or unacknowledged delivery; host change
notifications trigger that check, not polling. The marker clears only on a clean
close with nothing pending, after final catalog publication. Clean retirement
closes cached manager and peer delivery links without a recovery acquisition or
crash-budget charge. Footer totals remain in the catalog; later reads use cold
storage without a writer, and later controls acquire a fresh host.

While a primary remains registered, an unexpected host connection loss rereads
that marker and queues recovery through the same bounded pool. The manager owns
these relaunches; managed connections do not independently relaunch on request
retries. Three automatic replacements are permitted per storage within sixty
seconds. Further losses stop automatic recovery and put a host error in the
dashboard roster's Attention group. Inspect the error, then use `agent_attach` to clear the
stop and retry. Intentional disconnects and unmarked storage do not relaunch.

## Dashboard and agent console

The dashboard is one full-screen overlay. It observes agents only: it projects
no primary conversation, reads no primary draft, and writes no primary editor
text. Selection, drafts, successful-message history, reading positions, and
Steer/Follow-up disposition survive closing and reopening in the same primary
process. Different primary sessions have independent UI state. A successful
admission clears only the submitted draft revision, including after the
dashboard reopens; newer text stays. Every truncated dashboard list keeps the
focused entry and its neighbors visible and states the hidden count.

The New agent field accepts a task in your own words and treats it literally,
including text such as `--help`. Enter starts the agent
with the primary's current directory and model, selects it, and keeps the
dashboard open. Its task, model, and reasoning appear immediately with a
Starting state in the Working group, before the host is ready. The conversation
then follows the host's live output. A late startup completion never moves a
selection the operator has changed since. Esc keeps the unsent task. Configure
changes name, model, and reasoning afterwards; staged fields change nothing
before Apply. Model search uses available model metadata, not a typed model
identity. Esc in the model picker returns to its saved search, and the Model
and Reasoning pickers start on the completed values. An owner refusal returns
Configure to its staged fields; Cancel abandons that configuration.

Actions apply only to the selected agent. They expose Stop current work,
Configure, Tasks, Fork, Rewind, Reset context, Schedule message, Scheduled
messages, Compact, Reconnect, Run agent command, and Details. Disabled actions
state their reason. Stop, Reset, Rewind, and Compact confirm with Cancel selected.
A refusal appears on the restored Actions screen at once. Fork and Rewind open
the created branch's console while their action still has focus. Details and
command results wrap to the available width and keep all returned text.
Native dialogs temporarily hide the dashboard and restore it afterwards. Esc
returns one form step; Esc at the first step returns to Actions. Completed
editor fields return prefilled; completed input values appear above the field,
and blank Enter keeps them. Entry,
conversation, and timer pickers supply identities internally. Schedule accepts
HH:MM local or a relative time such as +30m, then confirms the exact deadline
and busy disposition. Completed schedule fields stay with their target after
Cancel or host refusal. Reopening prefills the message; a blank deadline keeps
the saved exact deadline. Native Cancel discards edits in the current unsubmitted
field. The storage host must run at the deadline.

The agent console uses the same conversation and message components as the
selected dashboard view. Its editor has focus; PageUp/PageDown reads without
changing the text destination. Reaching the transcript tail resumes follow.
Esc returns directly to the dashboard. Actions, Tasks, and help are on that
screen, not additional console modes. Slash and bang text are literal messages.
Native agent commands use Actions > Run agent command. Text paste works;
Pi's file and image attachment interface is not embedded.

## Live conversation and history

Observation uses public Durable entries, documents, submissions, task outcomes,
and views. The selected conversation renders Pi's published chat components,
built-in tool cards, arguments, thinking, and tool results paired with their
calls. Live partial text and running output update before the turn ends.
Committed output replaces its partial. Hidden native messages stay hidden.
Display limits remain explicit; missing content is not a fabricated answer.

One dashboard observes one selected conversation. Selection changes release the
previous watch. Tasks acquires a separate storage task-graph watch only while
its view is open. A task with several conversations offers a conversation
picker. Finished tasks leave the graph; their results stay in the conversation.
No live host means no live task graph, not proof of no retained work.

Observation attaches to an existing host and never starts one. If the same
manager already owns a host launch, observation joins that pending open and
attaches as soon as the host is ready, without a roster change. A storage file
that does not exist yet reads as an empty conversation, not a file error.
Retained or unavailable output stays labeled with its last observation time.
A selected conversation whose stopped host restarts through another action
attaches again and rereads when its roster row changes. Sending to an
idle agent with a retired host starts that host through the normal send path.
Reconnect is an explicit action for a host error. Independent dashboard clients
observe the same owner; closing any dashboard cancels no admitted work.

PageUp at the first loaded line reads one earlier bounded page and preserves
the reading anchor. The selected display-input cache retains at most 800 entries
and approximately 4 MiB. Distant pages lose their input but keep cursors for
reload. Only a contiguous loaded range appears; newer gaps load before the live
tail joins that range. Offscreen blocks retain height and anchor measurements,
not every rendered line. A partial transcript also shows its first task from the
published summary. Blank runs between chat blocks reduce to one blank line.
The primary's no-target `agent_status` is a compact fleet overview. Working
and starting rows without an attention reason come first, then attention rows,
then recent quiet rows. Independent host, recovery, or availability faults make
any state an attention row; a deliberate stop alone does not. Summary counts
are priority groups, not state totals: `working` counts the first group,
`attention` counts every attention row, and `quiet` counts the remaining rows. Each
priority group uses newest update first with a stable identity tie-breaker.
Excerpts have visible shortening markers. Working and attention rows retain
identity, cwd, ownership, model, update time, state, cost, partial-cost flag,
current tool, tool count, duration, latest reply, errors, and recovery health
when those fields exist. Quiet history, connected primaries, and failures have
bounded samples and explicit `summary` totals rather than silent row drops.

`coverage` states source visits, skipped views, excluded rows, byte omissions,
and the exact serialized byte size. Counts cover the supplied catalog page,
not unseen inventory. `complete` remains true for an intentional quiet summary
only when source coverage is complete; source gaps or byte exclusions make it
false. `coverage.reasons` names recovery paths and boundaries. The overview
returns `coverage.nextCursor: null` because `agent_status` accepts no cursor;
it never exposes the dashboard's catalog cursor. Call `agent_list` without a
cursor, then repeat its returned `nextCursor` to find other identities. Use
targeted `agent_status` for
full conversation state. Native agents without a status target read their own
storage's conversation state rather than the primary's fleet overview.

History and activity mark every page and entry row with `format: "compact"`,
including empty pages. Their schemas require this marker; raw branch and exact
reads do not carry it. Compact entry rows contain entry ID, kind, source, role,
readable text, named tool calls with argument summaries, and named tool result
excerpts with error flags and call IDs. Text and tool excerpts share a bounded
character budget, including inline truncation markers. An exhausted budget
leaves a shortened or empty excerpt with `truncated: true` rather than an
out-of-budget marker. Tool arrays have bounds; `omittedParts` counts excluded
parts. `truncated` and inline markers identify shortened text, arguments, results, or
names. Assistant text precedes visible thinking in the readable excerpt.
History is newest first; `nextCursor` continues older entries. Activity groups
recent entries by turn and retains live metadata, running tools, and coverage.
Failure rows take priority within the digest bound; they still lose rows when
their combined size exceeds it.
Its cursor continues older turns and unfinished scans, not rows excluded from
the digest; coverage states those exclusions. Use history to read excluded rows.

Use `agent_inspect` with `view: "exact"`, `entryId: row.id`, and `offset: 0`
for the full retained redacted entry JSON. Repeat with `nextOffset` until null.
Exact reports the actual `offset`; a requested offset inside a Unicode pair
moves to that pair's start.
Compact rows set `nextOffset` to null because their excerpts are not raw JSON
offsets. Branch remains a bounded raw JSON view. Exact and branch retain usage,
structured arguments, and other retained entry fields rather than compact
summaries. Search and result reads keep their existing evidence paths.
Continue incomplete pages even without matches. Provider signatures, image
payloads, and redacted thinking stay omitted with markers and counts on raw
reads. Observation and task outcomes grant no control or acceptance authority.

A stopped agent uses a cached public snapshot without services, model runtime,
extension bootstrap, or Harness resume. The cache tracks database and WAL
identity plus writer claim state. Changed or unstable source identity refuses
reuse. Snapshot operations serialize to protect reads and eviction. The public
SQLite backup path creates source sidecars where needed; an absent WAL becoming
an empty WAL does not invalidate the snapshot. An absent database has an empty
in-memory observation that is not cached, so a later read sees database creation.
The snapshot writes no source content and never becomes a writer.

The dashboard does not embed InteractiveMode. The published extension API has
no complete InteractiveMode view, editor state, dialog, widget, or renderer
registry to mount. The experimental coding-agent client and services remain
source-only. The dashboard composes public chat, editor, and scrolling primitives
instead.

## Roster and coverage

The roster reads bounded host-published metadata through `dashboard-types.ts`.
It parses no ordinary JSONL, opens no conversation database, and starts no host.
Rows show state, retained cost, and relative age. Names shorten before those
fields; duplicate names receive unique identity suffixes. The footer keeps the
selected model, reasoning, cost, and state separate from the single hint line.
Unknown cost stays unknown and partial cost stays a lower bound.

Working and Attention precede retained date groups. Attention names unavailable
or conflicted storage, a host error, failed compaction, failed work with an
error, or exhausted retries. Done and deliberately stopped work do not require
attention by themselves. The selected view shows the one concrete Attention
reason. Selection follows identity, not roster index, and roster order stays
fixed during an arrow sequence. Text entry locks its recipient even while
published metadata changes.

Coverage carries `complete`, `storagesVisited`, `skipped`, `omitted`, and
`nextCursor`. Load more agents continues that cursor. Find searches loaded
name, task, path, model, state, and identity, not transcript text. Find
previews the selected match before the filter is committed; Esc restores the
previous filter and selection. A filter with no match is not an empty store:
Enter does nothing and Esc clears the filter. An empty page or missing view is
not proof of absence. A dead or absent writer claim marks
previously working retained metadata Interrupted. Claim errors remain explicit.
Host health belongs to the publication time; later publications clear it.
The manager adds current recovery errors without rewriting published views.

Host notifications coalesce roster refreshes. A bounded metadata reconciliation
while the dashboard is visible discovers hosts created elsewhere and dead
claims. Neither path repeatedly reads transcripts. Streaming paints coalesce;
local input paints immediately. Closing releases observers and UI timers.
The primary's native agents status retains cumulative cost independently of
the dashboard. Repeated reads never add the same usage twice. Incomplete
inventory qualifies the retained cost with ≥.

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
| `PI_AGENT_IDLE_MINUTES` | Idle host retirement interval. Default 5; zero disables; finite range 0 through 35791 minutes, including fractions. Passive clients do not extend the interval. |
| `PI_AGENT_CHECK_IN_MINUTES` | Default automatic owner check-in interval for model `agent_spawn` and `agent_place` prompts and `agent_send` tasks. Default 30; zero disables; finite range 0 through 35791 minutes, including fractions. Blank and invalid values are rejected with the variable name and range. Per-call `checkInMinutes` overrides it. Operator admissions have no default. |

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
