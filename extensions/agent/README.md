# Agent

Use Agent to delegate work to retained Pi Durable conversations, steer active
work, read its evidence, and reuse standing experts. A storage has one independent
host process and one SQLite database; native conversations in that storage share
its host. Quitting the primary Pi process closes its client connection, not the
agent's work. Reopening the primary reconnects to its agents. An acquiring control
resumes retained work after the previous writer exits and the new host takes its lease.

The ordinary primary owns its terminal, editor, transcript, `/restart`, and
self-compaction. `/agent` opens the agent work view over that workspace. The
existing `ctrl+alt+g` shortcut also opens it without changing your native draft.
The view lists agents beside the selected conversation on wide terminals and
above it on narrow terminals, with the conversation, its message field and the
agent's controls in one place. Esc steps back to the untouched primary without
stopping work. The view measures bounded rows before truncation and retains
fitting text with its terminal styling and padding.

Choose the surface that serves your task:

| Need | Start here |
|---|---|
| Start work or change its direction | [Controls](#controls); use the returned canonical identity or a retained `@handle`, not a display name. |
| Read and message an agent | [Agent work view](#agent-work-view), then [live conversation and history](#live-conversation-and-history). |
| Use an existing agent as the main terminal conversation | [Standalone terminal attachment](#standalone-terminal-attachment). |
| Delegate and receive an answer | [Agent collaboration and placement](#agent-collaboration-and-placement); [result reads](#read-peer-results) preserve the exact admitted reference. |
| Reuse an expert or develop a shared outcome | [Standing agents and expertise](#standing-agents-and-expertise) and [peer threads](#peer-threads). |
| Coordinate with another effort | [Efforts, presence, and intent](#efforts-presence-and-intent); intent is a claim, not authority or a lock. |
| Understand lifetime, delivery, or recovery | [Runtime and identity](#runtime-and-identity) and [recovery and delivery](#recovery-and-delivery). |

For task contracts, permission decisions, review, and acceptance, use
[Agent delivery](../../docs/agent-delivery.md). This README owns the controls and
their observable behavior. Admission, delivery, settlement, and acceptance are
different states; a receipt does not prove the requested outcome.

## Controls

Native input entries distinguish their author without changing the model message.
Explicit operator admissions use `pi.user`. Model-origin admissions use the
application kind `agent.input` with `data.author.role: "agent"` and the known
caller in `data.author.identity`. Unowned admissions without origin also use
`agent.input`, with `data.author.role: "unknown"`. An absent identity stays absent.
An `agent.input` entry also carries `data.class`, `data.requestId` and, when
known, `data.sender`. The class is one of `operator`, `steer`, `followUp`,
`report`, `result`, `check-in`, `timer` and `thread-notice`. It tells the
recipient how to treat the input and never selects the time of its placement.
An explicit operator admission keeps the `pi.user` kind without data and reads
as class `operator`. The route note of an input names the same class and sender.
Every input still contributes the same user-role model content. Local and foreign
requests, scheduled inputs, check-in recovery and delivery recovery preserve this
classification. Automated reports use application inputs, not operator inputs.
An admission retains its kind through queued placement and request-ID
deduplication. Source changes do not reclassify existing inputs or replace the
admission code in retained hosts. Drain existing runs before a host transition.

Agent history, search, activity and dashboards recognise both input kinds. Their
`source: "user"` selector includes both. Raw and exact reads retain the kind and
author data. Other extensions that need operator input use native placed input
submissions and `pi.user`, not Agent document names or entry formats. Native
repair continuations are user messages without new input submissions, so entry
kind alone does not establish new operator direction.

Answer-bearing `agent_send`, `agent_steer`, and prompted `agent_spawn` return
`result: { sessionId, submissionId, requestId? }` after native admission. The
reference names the canonical conversation and its actual admitted submission,
not a Reporter task, creation record, name, or latest answer. A known request ID
is retained and must agree with the submission. Local, foreign, handle, and
ordinary-primary dispatch expose the same reference in text and structured
Codemode output. Dispatch stays in the background; admission is not settlement.

A native admission also states its committed `placement`. `placed` means that
the input is in the recipient's transcript. `unplaced` means that the input
waits in the inbox of a busy recipient until its current tool round ends.
`withdrawn` means that it is in neither the inbox nor the transcript, including
when its submission is absent; it does not mean that the recipient read it.
Inside a Durable agent, the send and spawn results carry `placement` in their
details and as one text line. The recipient's host keeps each unplaced input in
the conversation document `agent.unplaced-inputs`, with its request, class,
sender and admission time, and drops the row when the input leaves the inbox.
A report through the host returns its current `delivery`: `pending`, `parked`,
`terminal` or `admitted`. A row that is not admitted states
`placement: "unplaced"`; its placement in the recipient appears in the
recipient's status. Source: `unplaced-inputs.ts` (`recordUnplacedInput`),
`durable-controls.ts` (`admitConversation`), and `durable-agents.ts`
(`admitLocal`).

Creation-only spawn, reports, scheduled inputs, thread posts, and messages
to ordinary primary sessions do not produce native result references. A Durable
sender receives a source receipt after the ordinary message is retained for
delivery; that receipt does not prove receiver action or task acceptance.
An ordinary primary remains responsive and receives normal routed results.

| Tool | Effect |
|---|---|
| `agent_spawn` | With `handle`, resolve or create one standing root and return `created`. Otherwise create a root storage; inside a Durable agent, the same cwd uses a native conversation and a different cwd uses a new storage host. An optional prompt starts work. Owner check-ins run only when `checkInMinutes` or the `agent.checkInMinutes` setting names an interval; the default is none. |
| `agent_work` | Inside a native agent, declare background work with `continue`, or close it with `complete` and one final report to its retained reply recipient. Both actions return at once. Results and native settlement do not complete declared work; see [declared background work](#declared-background-work). An ordinary session has its own contract: `continue` ends the turn with one state note for the operator and nothing else; see [state note of an ordinary session](#state-note-of-an-ordinary-session). |
| `agent_send` | Admit a task or correction. Omitted `mode` means `followUp`, new work, on every path. `mode: "steer"` corrects current work; both reach the same tool-round boundary. `mode: "report"` sends an explicit recipient a notice without an answer route or check-in task. A busy Durable recipient receives each active input at its next tool boundary, for `steer` and for `followUp`; no input waits for the end of the run. These inputs do not promise separate answers. See [input placement](#input-placement-and-unplaced-notices). Model-origin reports to ordinary primaries use steer. Report receipts describe this boundary and point to steer for changes to busy work. A successful report returns its identity and state facts (retention, acknowledgement, admission or queue placement) without the message body; these facts do not show that the recipient read the report. Inside a Durable agent, `passive: true` with `mode: "report"` sends progress that asks for no action: the report enters the recipient's context at its next result or normal boundary, starts no turn. `passive` is valid only for report mode. Owner check-ins run only when `checkInMinutes` or the `agent.checkInMinutes` setting names an interval; the default is none. With `deliverAt` (an absolute ISO 8601 time) and an optional `mode` (`followUp` by default, or `steer`), schedule the input as a durable timer instead. |
| `agent_steer` | Admit steering through the recipient's storage owner. |
| `agent_abort` | Abort the selected conversation without deleting its retained evidence. With `timerId`, cancel only that scheduled input. With `release: true`, abort and request host retirement; other work, timers and retained deliveries remain. Release never launches a cold host; an unavailable endpoint preserves the attachment error and proves no global host absence. `release` cannot be combined with `timerId` or `background: true`; abort with background first, then release. |
| `agent_reset` | Start a new context for the selected conversation with an optional handoff note. History, identity, files, settings, and timers stay; no model turn starts. |
| `agent_attach` | Connect to the owner without a new prompt; retained unfinished work resumes. An explicit model is applied first; a failed configuration returns its failure instead of a status snapshot. |
| `agent_configure` | Change an idle conversation's name, exact model, or reasoning level. |
| `agent_profile` | Read a complete bounded profile, or update role and expertise with `expectedRevision`. Reads start no host. A conflict returns the current profile without a change. |
| `agent_intent` | Publish or clear the invoking session's intent claim. Native conversations persist their own claim without an ordinary primary. Claims are not locks or authority. |
| `agent_fork` | Create an idle native fork at an entry or current leaf. |
| `agent_rewind` | Fork before a mistaken entry and submit a correction. Files remain current. |
| `agent_compact` | Run native compaction without stopping active work or withdrawing queued inputs. The summary applies at the next native boundary. Self-compaction uses its completed tool boundary. |
| `agent_command` | Invoke a contributed command, reload host registrations while idle, or fork to a tree entry. |
| `agent_place` | Resolve the longest directory binding, or create one, with optional work. Model prompts use the same check-in default on both paths, none unless configured; optional `checkInMinutes` sets an interval. |
| `agent_list` | Page through stored identities and conversation metadata. Search includes retained handles and role hints; profile coverage remains explicit. Reads start no host. |
| `agent_status` | Read conversation and host state, including capability limits. A selected read returns compact state with an exact full-detail call; `detail: true` with one explicit `sessionId` returns the full selected status and cannot be combined with `view`, `storageId`, `cursor`, or `limit`. The full status of a selected session lists its pending timers, nearest deadline first. `view: "storage-page"` continues one exact storage's bounded status scan. `view: "fleet"` reads sampled machine-local model evidence without a session target. |
| `agent_inspect` | Read bounded native entries, activity, branches, literal search, or retained results; ordinary targets support raw latest-retained activity/history. The result view returns the answer in pages with separate continuations for answer text and for recipient references; see [result pages](#result-pages). |
| `agent_collaborate` | Discover, create, read, join, leave, post to, revise, or close a shared peer thread. Joining subscribes to passive notices; only explicit `notify` recipients get a model wake. Keep `participation` within 256 characters and `message` within 8,000 characters; write longer content to a file and post its path. Handler length errors include this remedy because Pi's pre-handler schema errors omit field descriptions. |

### Default exposure and discovery

Both forms register every Agent control, but only the frequent ones are declared
by default. The Agent slice owns this table in `control-guidance.ts`; Pi's
exposure fields carry it.

- Direct controls are declared and callable: `agent_spawn`, `agent_send`,
  `agent_steer`, `agent_abort`, `agent_status`, `agent_intent` and
  `agent_collaborate`. `agent_work` is a direct control in both forms, with a
  separate contract in each.
- Model-only controls are declared while active and never callable from a
  script: `agent_compact`.
- Deferred controls stay registered and callable from other tools, and are not
  declared until tool discovery loads them: `agent_inspect`, `agent_list`,
  `agent_attach`, `agent_place`, `agent_fork`, `agent_rewind`, `agent_reset`,
  `agent_configure`, `agent_profile` and `agent_command`.

Discovery uses Pi's public `tool_search`. The recommended Pi setting adds it
without replacing other selections:

```json
{
  "defaultTools": ["+codemode", "+tool_search"]
}
```

The CLI supplies the built-in `tool_search` extension. An SDK host that does not
receive it adds the public `createToolSearchExtension()` factory to its resource
loader and enables it through the same `defaultTools` setting. An explicit
`-builtin:tool_search` removal stays authoritative; the harness does not
reactivate a disabled built-in. Discovery needs no MCP server, so Radius or
another server does not have to enable it.

Control guidance follows the offered tools. Ordinary sessions keep
`promptGuidelines` on each registration; native sections render only names in
`PromptInput.agent.tools`. A deferred control therefore adds its guidance when
discovery has loaded it. Policy enforcement and shell guidance do not depend on
whether these controls are offered.

An explicit spawn `role` is saved on the new agent's profile with or without
a `handle`, before its prompt starts. Later role changes use `agent_profile`.
A busy configuration refusal
names the canonical target identity and preserves a supplied handle. Repeat
`agent_configure` after that target's current work ends.

Live peer observations retain strict current schemas. Host list pages validate
native conversation summaries before the manager adds catalogue and profile
fields to tool results. If the peer declares a
different agent or Pi version, observation failures name the loaded versions
and the replacement steps. Wait for active work to finish, release the idle
host, then attach it from the current installation. Restart an ordinary
primary to replace its loaded code. No older observation shape is accepted.

Each `agent_list` call collects one bounded catalog batch before it observes
hosts. Continuations retain both the native page position and the last visited
catalog filename. Catalog discovery sorts filenames and resumes strictly after
that name, so view publications and record creation or removal do not invalidate
continuations or repeat records. Repeat the same query and cwd with a cursor;
a different query or cwd is refused explicitly. `agent_list` reports each
unreadable catalog record in `coverage.unavailable`, even when
`coverage.complete` is true.

Agent catalogue readers compile their projection schemas once per process.
They keep a bounded process-local cache of validated records: at most 512
records and 8 MiB of retained payload. Every read still opens the current file
without following symlinks and checks that it is a bounded regular file. The
opened descriptor's device, inode, size, modification time and change time
(nanosecond precision) form its revision. A matching revision returns an
isolated clone of the validated record without reading or parsing the payload.
A different revision reads and validates the bounded payload, and the result is
cached only if the descriptor still has that revision afterwards. A changed,
missing, unsafe or corrupt file evicts its entry, and a failed read is never
cached. The catalogue's own publication and removal evict the exact path. Each
caller receives an independent record, so caller edits never change later
observations. The cache holds parsed metadata only: it never stands in for a
writer-claim observation, an authority decision or the identity checks that
guard destructive discard, which read the record again.

Discovery is not a frozen snapshot. Each page lists the current directory names,
then bounds entry visits and record reads. Records created behind the cursor,
or changed to match a filter after their name was visited, appear on the next
fresh scan. Removed records are absent. Complete catalog coverage means the end
of that page's sorted directory listing was reached, not that all pages observed
one instant. Cross-storage thread discovery uses the same catalog continuations.

Dashboard, footer, and the no-target status roster share one manager-owned raw
inventory observation. Initial discovery lists catalog names and reads each
candidate's record and writer claim once. Each caller ranks those same facts
with its own ownership set and manager-local launch/recovery facts. The priority
projection retains its live-claim branch, but native diagnostic records never
establish live priority. Caller-created records and local active stores retain
their priority. A connected publication changes presentation, not catalogue rank. Catalog file
modification time orders each group, with identity as the tie-breaker. Creation
time is immutable; file modification time reflects published views and recovery
marker changes. It describes metadata recency, not proof of current work.
Individual record and writer-claim reads have byte limits. The initial directory
snapshot bounds the scan, and a separate output limit bounds returned records.
Coverage reports candidates, inspections, unreadable records, unknown writer
claims, output limits, remaining records and published rows, and live or
caller-owned exclusions. An unknown claim leaves live-host priority unestablished;
known creation ownership still supplies caller priority. Loaded pages count the
latest inventory scan once and each retained storage's latest view exclusions once.
Priority does not grant unlimited output when the priority set itself exceeds a
limit. The reader opens no conversation database and starts no host.

Fleet status and collaboration-awareness are distinct evidence views. Their
readers use separate bounded `AgentCatalog.page()` discovery and retain their
own coverage and evidence qualifications; they do not use the roster observation.

Each shared read lists the current directory snapshot and checks record file
stamps without following symlinks. Device, inode, size, modification time and
change time identify replacements and updates. Only changed or unreadable records
need payload reads; unchanged records retain their facts. A read after final host
publication therefore sees the retained costs without waiting for its notice.
The opened file supplies the retained stamp, not an earlier pathname check.

Namespace notices carry bounded changed storage identities. The manager combines
these with connected-host notices and refreshes the affected claim facts.
Concurrent changes accumulate; an unknown, identity-free or oversized notice
invalidates claims across the namespace. The next read also refreshes all claims
when the last full observation is two seconds old, without reopening unchanged
record payloads. The dashboard's existing reconciliation demand uses this same owner; no
extra polling service or persistent catalog copy exists. Reconciliation discovers
missed publications, deletions, unreadable records and silent process death.
Rows label claim observation time. A cached claim is not a fresh liveness check,
and a cached page keeps the inventory observation time rather than its render time.

Roster continuation uses the last priority, modification time, and identity,
bound to the caller's ownership set and local active stores. Each page ranks the
current shared observation. Activity or claim changes between pages can move
records across this position; refresh the
roster to rediscover them. Use `agent_list` for stable filename-based continuation.
Exact-target attachment and controls read their own current evidence regardless
of roster membership. Recovery still considers every source within its existing
bound: availability of one recipient can wake a parked delivery in another store.

Agent hosts have process lifetimes independent of the primary. There is no
separate detach operation or detached-run registry.

### Independent contributed work

An extension command also starts independent Durable work through the
[package contribution contract](../../docs/conventions/durable-contributions.md#independent-command-admission).
This is not an answer-bearing agent tool. Successful admission sends no message
to the primary and installs no parent status subscription, Reporter, or check-in.
The creator identity supplies provenance and trust routing, not a result
destination. Existing agent discovery, inspection, and cancellation controls
expose the independent root and its native evidence.

Each admission reads fresh Pi settings at the requested cwd after normal project
trust resolution. Without trust-requiring project resources, a saved refusal
still applies; only an absent saved decision defaults to trust. Explicit trust
retains priority. Startup prefers a saved default inside the resolved
`enabledModels` scope, then its first available scoped model. With no scope, Pi's
public SDK supplies its normal model fallback. Thinking uses the selected scope
suffix, per-model setting, default setting, then Pi's built-in default and
capability clamping. Caller model flags and current model/thinking do not enter
this path. An unprompted in-memory SDK session resolves these choices and is
disposed before launch; selection sends no generation request or settings write.
The chosen values remain fixed for replay of that invocation.

A retained ordinary manager must match the loaded manager contract. After that
contract changes, `/reload` does not replace the retained manager: agent controls
refuse it and require a new Pi process. Refusal is a compatibility backstop, not
permission to interrupt live work. Arrange an owner-agreed safe transition before
restarting Pi or changing live source. Starting a new primary does not restart
or cancel its independent Durable workers. A command request also requires the
current host contract so an older host cannot discard structured input silently.

Setup or command admission failures return to the command caller. After
admission, the contributed command owns durable work and inspectable terminal
evidence. Closing the caller's temporary connection does not cancel that work.

### Tool cards

Agent tool and peer cards use one two-tier layout. The first header line shows
the tool name or message kind and the target or sender label. Thread notices
use the thread title, or full thread identity when no title is known, as their
subject; their second line starts with `from <sender>` when known. The muted
second line shows known provider/model, thinking level, and other secondary
facts. All card kinds use the same `provider/model · xhigh` form, without
redundant `Model:`, `thinking`, or `reasoning` labels. Ambiguous values retain labels such as
`submission 2987` or `mode report`. Missing facts create no placeholders.
Targeted cards use the retained `@handle` or display name. Duplicate display names add the full identity when neither handles nor
model settings distinguish them. Unobserved targets use the full identity or
the supplied `@handle`; only the rendered width clips a collapsed line.
The synchronous lookup uses roster facts already observed by the primary footer;
it opens no storage and starts no host. Each native row retains its own result
observations so its header reflects applied settings without a discovery read.
Tool cards retain Pi's native padding. Peer cards supply the same inner top and
bottom padding, while Pi supplies their outer separator.
The manager contract is `manager/7.0.0`; a reload over an older retained manager
refuses agent controls and requires a Pi restart.
Expanded cards retain full IDs and the complete result within the display bound.
A result card shows `Answer continuation:` and `Receipt continuation:` as
separate exact calls when the result carries them. An expanded result notice
shows its receipt continuation call in its source details.

A collapsed card has at most one expansion hint across its call and result.
Before execution, the call owns the hint; after execution starts, the result
owns it. The native-style `... (ctrl+o to expand)` hint applies to the whole
card, not just its result. All card expansion hints use theme `muted`. Expanded
cards show no expansion hint. Expanded messages use the plain `Message:` label.

Peer notices in ordinary chat show `... (click or ctrl+o to expand)` whenever
the preview hides body text or the card holds source details, so a short notice
never hides its details silently. A plain left click on the card's header or on
that hint discloses that one card, and a click on the header collapses it again;
this is local reading state that sends nothing, starts no turn and changes no
retained content. Clicks on the body text, modified clicks and multi-clicks pass
through to text selection. Pi's global expansion (`ctrl+o`) rebuilds every card
and resets those local choices.

In ordinary chat, retained communications (reports, thread notices, results and
check-ins carried by a conversation's `communication` view) use the Agent card:
the first line names the kind (`Report`, `Thread notice`, `Result`,
`Result unanswered`, `Check-in`) and the thread or work it belongs to; the second
line names the sender and the recorded local time. The body renders as Markdown
with `Partial body` and `Redacted body` marks when they apply. Disclosure adds
the exact sender identity, the recorded timestamp and every retained metadata
field in full: a result lists each retained reference on its own line with its
submission, request, entry and answer entry identifiers. A communication retains
no authoring provider or model, and the card never shows the current roster
configuration as if it were.

The agent work view and the attached terminal show the same communications in
a compact form without a background. One header row holds a disclosure mark
(`▸` closed, `▾` open), the sender in bold and what it is (`<sender> in <thread
title>`, `Report from <sender>`, `Result from <sender>`, `Check-in from
<sender>`), then muted facts: the post number, `notified this agent` for a
notice that woke it, `unanswered` for an unanswered result, a check-in's elapsed
time, and the recorded local time (the clock time today, the date and time on
other days). Two rows of the Markdown body follow; a longer body ends its
second row with a muted `+N lines`. A plain click on the header row or on that
row opens the card; there is no repeated key hint, and Ctrl+O (the footer's
`expand all`) opens every card. The open card shows the complete retained body, then muted
notes, then every retained field in full: the sender identity, the recorded
time, the thread, event, request and source identifiers, and each retained
reference of a result. A notice copy that is not marked complete says
`Notice copy; the full post #N is in Threads.`; another incomplete copy says
`Retained copy; it may be shorter than the original.`; a redacted copy says so.
A collapsed preview never claims the copy is incomplete; the notes say it once.
The sender is the retained name, then a name the view already knows (a roster
name or handle, `This session` for the session that runs the view, a Pi session
name from effort presence), then `Session` or `Agent` with the first eight
characters of the identity. The thread title comes from the notice, then from a
thread the view has read.

Dashboard and attached-terminal agent cards resolve their targets through the
roster rows already observed by that view (the dashboard page, or the attached
row plus the roster the attached terminal reads again on each roster notice),
so the same target shows the same name and applied configuration as in ordinary
chat. In the agent work view an `agent_collaborate` card names its thread by
title when the view knows it; the view reads one thread frame for a title it
does not know, at most a fixed number per view, and the exact identity stays
until that read returns. Receipts number events as `#N`. A forward read card
shows its `after` and known-frame arguments, the frame revision, the open or
closed state, the returned range, the pending notice count, `Known frame not
repeated` when the page omits the frame, and the exact `Next events` call
when the page has one. A changed name or configuration repaints those cards; reads happen outside
paint, coalesce, and an answer for an earlier attachment is dropped. A card's
retained snapshot still takes precedence for the configuration it applied.

Pointer disclosure of a peer notice or retained communication is kept outside
the card renderer: ordinary notices keep it with the stored message, transcripts
keep it in the conversation's reading state under the entry id. It survives a
theme refresh, a rebuilt transcript and a return from the dashboard or a browser;
a global expansion change still sets every card.

Collapsed results use plain outcomes rather than raw JSON. Expanded results
retain the raw result within the display bound. Message receipts use `Admitted`
or `Steer admitted` and the submission number. A primary channel receipt after
successful delivery shows `Report delivered to` or `Message delivered to` and
the target label. Receipts omit target facts already visible in the call or snapshot. A different
conversation or a newly resolved target retains its label. Snapshots show changed
model facts without repeating unchanged header facts. Intent cards show
`Intent published` or `Intent cleared` from the returned primary endpoint,
with its full identity. Its known name and configuration update the header;
expanded results retain the intent claim and bounded awareness as raw data.
An intent claim is not verified authority or a reservation. Collaboration and
context reset use the same card layout. Scheduled inputs show their timer and deadline;
timer cancellation shows whether it changed the timer.

Admission does not establish delivery, action, or task completion. A primary
channel delivery receipt does not establish action or task acceptance. Model-visible
results remain unchanged. Status totals mark partial costs with a trailing `+`, such as
`$0.25+`: at least that amount is known; some data was not fully readable.

`/agent` exposes `new`, `list`, `status`, `send`, `steer`, `abort`, `attach`,
`fork`, `compact`, `inspect`, `rewind`, `configure`, `profile`, `command`, `place`, `places`,
`unbind`, `reset`, `schedule`, `timers`, and `timer-cancel`. `help` shows action
syntax. Tab completes actions, canonical identities, and retained `@handle`
addresses without executing them. Completion searches retained role hints too.
Without an action, `/agent` opens the work view. A TUI command that names a
target without its other arguments, such as `/agent configure @handle`, opens
that target's form there. In the list, Up/Down selects and Enter writes to the
selected agent. `/` moves to Find, where letters narrow the list; Enter or
Escape returns to the list. PageUp/PageDown reads the selected conversation.
Ctrl+O expands tool output; Ctrl+T toggles thinking. Esc clears Find before
closing the view.

In the message field, letters are message text. Enter starts an idle turn or
steers working agents at the next step; the field's top border names the
effect, and a click on it changes it while the agent works; `f` in the footer
does the same. Ctrl+J adds a newline. Esc keeps the draft and returns to the
list. Outside a text field, the keys shown in the footer run their actions.
There are no F-key controls, Alt controls or typed dashboard commands.

`/agent unbind <area>` removes only the directory binding. It does not delete
storage or abort work.

A blank configure name clears the stored name. Spawn and configure accept
`thinkingLevel` values `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and
`max`. Native attach accepts the same levels alongside an explicit model.
An exact `provider/model` is validated against the configured catalog, and the
requested reasoning level is clamped by Pi to the model's supported levels.
Configuration requires an idle conversation, starts no task, and changes no
global defaults. A mutation result carries a compact status:
identity, conversation, name, cwd, busy state, model, and the capability limits
that matter. The full status stays available through `agent_status` with
`detail: true`. If the
post-mutation status read fails, the result carries `snapshotError` and the
successful receipt stays.

The `/agent` control actions return short human text and, when an action creates
or selects an agent, that agent's identity. Observation actions (`list`,
`status`, `inspect`, `profile`, `places`) keep their retained evidence. `/agent send`
admits a follow-up when the target is busy; `/agent steer` admits steering. A
busy Durable target receives both at its next tool boundary. The
model-facing `agent_send` also defaults to follow-up/new work; `agent_steer`
marks a correction. The
status card labels its newest text by role and state: `Latest reply` or
`Latest input` when idle, and `Replying` or `Working on input` while active.
Text without a retained author role uses `Latest message` or `Working on the task`.

### Continuity tool declarations

After successful ordinary or native registration, Agent answers the package's
[continuity-tool request](../../docs/conventions/continuity-tools.md). It declares
`agent_compact` for whole-tool compaction, bounded forms of `agent_abort`,
`agent_steer` and `agent_send` for worker resolution, and, in a native
conversation, the closing form of `agent_work` for work completion. A finished
result can therefore close its declared work and send its final report at the
capacity stop.

The worker-resolution declarations accept only closed argument shapes. Targets
and optional steer reply targets use 1–256 UTF-16 code units; messages use
1–8000. These are the units counted by JavaScript's `string.length`. Abort accepts
`sessionId` and the current `background`, `release` and `timerId` combinations
shared by both runtimes, not ordinary-only `trust`. Steer accepts `sessionId`,
`message` and optional `replyTo`. Send accepts only `sessionId`, `message` and
`mode: "report"`. It refuses `passive`, `deliverAt`, `replyTo`, `checkInMinutes`
and other modes. Unknown fields are refused.

The work-completion declaration belongs to the native runtime. It accepts only
`action: "complete"` with `request` (1–1024), `status` (`done` or `failed`) and
`message` (1–100000). It refuses `continue`: that keeps work open in a full
context and can declare new dependencies. After compaction, `continue` runs
normally again. An ordinary session declares no work, so it declares no
work-completion tool: its `agent_work` only ends a turn with a state note.

A declaration checks argument shape, not authority, ownership or target state.
It does not prove that continuity succeeded or prevent an idle target from
starting work after a steer. Normal permissions, request routes and tool controls
remain in force.

## Standalone terminal attachment

From this checkout, start an interactive terminal with an existing identity or
retained handle:

```sh
node extensions/agent/terminal.ts --theme dark --session @handle
```

`--session` accepts a root storage identity, `storageId:conversationId` for an
exact nonroot conversation, or a retained `@handle`. The terminal resolves it
through the existing manager and selects it in the agent work view, the same
view `/agent` opens in ordinary Pi (see below). Selection reads passively: it
sends no prompt, changes no model, starts no host, and creates no ordinary Pi
session. A target need not appear in the bounded list. The work view fills the
window with the list, the selected conversation's transcript, tool cards, live
output, native pi-tui `Editor`, and its header and controls. The message field
caption names the selected conversation by its observed name, or by its exact
identity when it has none.

The same command shows an agent in any terminal pane beside the main
conversation, so the operator can watch its work and type to it directly. In a
Rex window, for example:

```sh
rex run --label "agent @handle" -c <package root> -- node extensions/agent/terminal.ts --session @handle
```

Text typed there is admitted to the same native conversation as any other
input, and closing the pane closes only that terminal, not the agent's work. A
pane started without an interactive shell can lack the managed `pi` launcher on
`PATH`; the entry then resolves the install under Pi's agent directory, so the
command needs no environment variable.

Without `--session`, the terminal reads the last selected identity from
`terminal-target.json` under `PI_AGENT_SESSIONS_DIR`, or its default store root.
With no remembered target, it opens New conversation, or states why creation is
unavailable here. This file remembers only
the identity; drafts, sent-message history, reading positions, and expanded
cards stay local to each terminal process, and selecting another conversation
and back keeps them while native work continues. Separate terminals have
independent local values and share operator input to the same native
conversation. There is no exclusive input lease; native admission determines
the result. The terminal leaves the outer fullscreen page bindings empty so
PageUp and PageDown reach the work view. While its screen is open the terminal
drops Node process warnings, as Pi's interactive CLI does: Node writes them
straight to the terminal, so a built-in loaded on first use (for example the
SQLite module behind Threads and stored conversations) would otherwise paint
its warning over the work view and the message field.

| Input | Effect |
|---|---|
| Enter in the message field | Admit the text to the selected conversation as operator input; its answer stays in that conversation. |
| Ctrl+J | Insert a native editor newline. |
| Esc | Leave the inspector, then the message field. Over the list it clears the error filter, returns to Threads, or clears Find; in the attached terminal it never detaches. |
| `ctrl+d` (footer), `/quit`, or Ctrl+D in an empty message field | Close this terminal and its observation links, not native work. |
| `/agent enter <identity-or-@handle>` | Select that exact conversation. |
| `/agent new` | Open New conversation. |
| `/agent browse` | Open the selected conversation's owner views. |
| `/agent recover` | Open Recover input for the selected conversation. |
| PageUp / PageDown | Read the conversation or the open thread; PageUp at the oldest loaded entry reads earlier entries. |
| Ctrl+O / Ctrl+T | Expand tool output / show thinking. |

All other slash and bang text stays literal. In particular, `/help`,
`/restart`, and shell text do not invoke ordinary Pi commands. Ctrl+D in a
nonempty message field keeps its native forward-delete behaviour. Receipts say
*admitted* or *already admitted*, name the exact target and submission, and
label the mode as *requested*. Admission does not prove placement, execution,
or an answer.

An uncertain delivery keeps the current draft and mode, and the receipt says
the delivery is not confirmed. The submitted text and requested mode also stay
in a target-local unconfirmed-input list, not sent-message history; each
failure adds a record. **Recover input (N)** in the agent's More menu, or
`/agent recover`, opens a form to choose a record and restore it to the draft.
Restore applies only while the captured target's draft and mode are unchanged
since the form opened; it never sends, and the record stays until the terminal
exits. Read the conversation before any resend, because a transport error does
not prove that admission failed. An unavailable stream shows a warning over the
last observed data; Reconnect in More starts the host.

Native actions run as the same staged forms ordinary Pi uses, in the inspector
beside the conversation (see [Agent work view](#agent-work-view)). The terminal
supplies their routes through its own caller: models come from the host's own
`models` read, which reports the last-known available snapshot and starts no
credential check or network request; a host that cannot answer names the
problem and offers no typed fallback. Contributed commands come from the host's
inventory, plus `reload`, each run with a fresh invocation identity. Each form
keeps the target captured when it opened, even if the selection changes.
Rewind corrections and scheduled inputs own their results in the conversation
that runs the work; the watcher acknowledges those results in place without a
follow-up input. The terminal remains the rewind fork's creating owner and the
scheduled input's requester.

New conversation works here when the terminal could load the configured model
catalogue; otherwise it states that reason and creates nothing. Purpose is the
first message, literal text; an empty purpose creates an idle conversation.
Preset lists the machine presets with their resolved model and reasoning, the
default first. Directory must exist; a directory with project resources and no
saved trust decision is refused with the reason. Start creates an independent
operator conversation through the existing manager with this process's model
catalogue, then admits the purpose through operator admission, so the new
conversation owns the answer and closing the terminal never strands it. One
request identity covers a form until creation succeeds, so a retry after a
refusal never creates a second conversation. If the first message is not
confirmed, the conversation stays, with the purpose in its message field and a
receipt that says so.

Pointer events reach the same conversation component as in ordinary Pi: a
click on a tool card or thinking run toggles it, other press, drag and release
gestures stay with Pi's text selection, and the wheel at the oldest loaded
entry requests earlier history. A click on the conversation's top rule reads
earlier history. Pointer geometry belongs to the last drawn layout; a click
reported for another size does nothing.

Selected cost, usage and model facts follow the observation already open for
the target. Each live frame refreshes the name, state, unplaced-input facts, model and
reasoning level without rescanning the store. Model name, reasoning support and
context window come from the host's `models` read once per selection; a model
the host did not list shows its identifier without a context bar. When the
observation is lost, the last facts stay on screen under a warning.

Owner tool cards come from a presentation-only module each owning extension
advertises through its admitted contribution (see
[tool display](../../docs/conventions/tool-display.md#presentation-modules-for-the-attached-terminal)).
When the operator selects a conversation, the client reads the live host's
inventory and imports those modules locally, without running any extension
factory or tool. A stored or stopped host advertises none. A module that is
missing, malformed or throws costs only its own cards, which fall back to Pi's
standard card. The renderer lookup is replaced as a unit when the selection
changes, and a late answer for an earlier selection is dropped. A replacement
lookup rebuilds the selected transcript from its retained entries at once, so
the reading position and each card's disclosure survive it. Builtin,
codemode and Agent cards keep their precedence. A host from another release
refuses the status read through the existing operation identity check; there
is no older reader. Owner views (clipboard, markdown, pillars, policy, stash) load the
same way and open from `o owner views` in the footer; see
[operator views](../../docs/conventions/operator-panels.md#attached-panels).

The terminal sets the window title to the observed conversation name and the
last segment of its working directory (`Parser review · harness`) through Pi's
public terminal API, and clears it when the target changes, the observation is
lost, and when the terminal closes. Control characters in a name never reach
the title sequence.

When the terminal supports Rex's program status protocol, the client reports
the selected conversation the same way. A live, busy conversation is `working`
and a live idle one is `idle`; both carry the observed conversation name as the
message and never the target identity. Waiting for another agent is `working`.
The status clears with the title. Idle does not mean done, and a lost
observation is not reported as a failure. An unchanged status is not sent
again; there is no heartbeat or polling, and ordinary Pi's own reporter is
unchanged. A terminal without the protocol is unaffected.

The standalone attachment supports explicit shipped `dark` and `light` themes.
It resolves public Pi packages from the managed install selected by
`PI_MANAGED_INSTALL_ROOT`, then the managed `pi` launcher on `PATH`, then the
install under Pi's agent directory (`PI_CODING_AGENT_DIR`, otherwise
`~/.pi/agent`), and rereads `current-version` on each process start.
Agent/Durable runtime dependencies stay checkout-local. It uses the existing
`PI_AGENT_DIR` and `PI_AGENT_SESSIONS_DIR` configuration.

This surface accepts text only. It has no image or file ingestion, image
clipboard action, external editor, shell runner, ordinary slash-command
palette, automatic/system theme selection, or ordinary extension UI context.
Related efforts and the Related list view require the ordinary extension
surface and are not offered here; Threads are, and posts are attributed to the
selected conversation. No retained ordinary archive is converted or edited.

## Agent work view

`/agent` opens the agent work view (also called the dashboard in this README)
over the ordinary session; the attached terminal shows the same view. It
observes agents and effort presence, not primary conversations: it reads no
primary draft and writes no primary editor text. Close leaves it; work
continues.

The view has a heading row, the list, and the selected agent's pane:

- **Heading.** The Agents, Threads and Efforts tabs on the left (Efforts in
  ordinary Pi only). On the Agents tab at 100 columns or more, the session's
  delegated figures sit at the right. New conversation, Help, the list
  controls and the way out are keys in the bottom footer; the heading holds no
  commands.
- **List.** A Find field, with Related, All (ordinary Pi only) and ‹ (hide the
  list) at its right end; then the agent rows and two count lines. Each agent
  takes three rows. Row 1 is the state glyph, one bold label and the relative
  time. The label is the display name, else the `@handle`, else the quoted
  first input, else the folder; duplicate labels add the shortest identity
  suffix that tells them apart. A label too long for row 1 continues on row 2
  instead of shortening. The next row is muted, aligned under the label: an
  agent with an error shows the first sentence of its reason (warning colour
  for a failed run, error colour for a current host or storage fault); a
  working agent shows its current tool, then its model; unplaced inputs show
  their count and the age of the oldest input; any other agent shows its model with its reasoning
  level and the cost. A blank row follows an agent
  whose label fits on row 1. The first count line counts loaded agents above
  and below the window (`↓ N more`, `↑ N more`, or `↑ A · ↓ B more`), then
  `N with errors`, which a click turns into the errors-only filter that lists
  only agents with an error reason; `e` or Escape lists every agent again.
  After three failed refreshes the line reads `List kept; refresh failed` in
  the warning colour. The second count line names the scope and the active
  filters and how many loaded agents they show, such as `Related + Find · 3 of
  329 loaded`, then Load more when the store has more agents and the row has
  room for both; one space always divides the two, and the facts keep their
  space when they do not both fit. A routine refresh of related work keeps the
  last count, its width and its controls until the new facts are ready; only a
  first read says `reading related work…`, and a failed read adds `· failed` in
  the warning colour until a later read succeeds. At 100 columns or more the
  list sits beside the pane at full height; narrower windows stack a strip
  above the pane whose first row holds Find, Related and All, and those facts
  together, with Load more at its end when the row has room for it.
- **Pane.** The selected agent's header of two lines, a third line while the
  agent owes a final report or has unplaced inputs, then one blank line.
  Line 1 holds the bold label and the project in muted text. Line 2 holds the
  state glyph and label, then at most one status:
  the first that applies of the sizes of a resize drag in progress, a notice
  from the last action, the agent's error reason with its supported way
  forward, or the conversation load status, connection or stored-history
  warning. A row without a stored error or host record shows its read status
  instead of a generic reason. The way forward is `Configure another model,
  then send a message` for a provider block the host published, `The host must
  repair a blocked task; Reconnect starts it` for a blocked task, `Reconnect
  starts the host when the storage is readable` for unavailable storage,
  `Reconnect starts the host; unfinished work resumes` for another host fault,
  and `A new message runs the work again` for a failed run. Details keeps the
  complete error. The conversation follows, then the message field,
  then the agent's two status lines (model, context, tokens, cost and cache;
  then cwd, branch and delegate figures) in the main session's footer layout.

The list starts in **Related** for the current session when it holds related
work; with none, it shows All, so the view never opens on an empty list. After
the operator chooses Related or All, the list keeps that choice. A native
terminal without an attached conversation starts with All. Find applies to the
selected view. An idle agent's message field names no delivery choice; a
working agent's field shows Correction at next step or New work at next step.
Both name the class of the message; the host places both at the working
agent's next tool boundary.

Related uses exact identities from existing evidence: the current conversation,
successful task admissions retained by the ordinary session, and creation
descendants in loaded rows. A storage's
creating owner qualifies only its root conversation. Nonroot creation owners and
fork parents come from bounded existing status summaries. Independent conversations
in the same storage stay excluded. Explicit root `:1` and the bare root share one
identity; nonroot identities remain distinct. Creation traversal stops at its
presentation bound. The caller's exact parent is related without adding its
independent siblings. A thread that contains one of those identities adds its
other members once. Peer membership does
not recursively add the peer's other threads, delegates, or task targets. A shared
cwd or repository, a name, and unknown ownership do not establish a relationship.

Lineage and membership reads use bounded public status, thread discovery and
seed-storage directories. Unchanged thread summary timestamps reuse already-read
frames within the view. Catalog notifications invalidate those caches even
when a publisher timestamp repeats. The list's periodic refresh does not repeat
unchanged membership reads. A failed read adds `· failed` to the second count
line, and scan bounds and incomplete list pages remain explicit. Unknown
relationships stay out of Related, not out of All.
Load more extends the list; All threads and selected-storage discovery expose
wider thread evidence. No relationship store or host protocol is added.

### Focus and input

Tab and Shift+Tab move between the list, the conversation, the message field
and an open form. In owner views, Tab passes the view's own regions and then
the row of owner views, where Left and Right choose one and Enter opens it.
Escape leaves an inspector form, then the message field,
then the view; it never stops work. `/` moves to Find, where letters narrow
the list: the selection follows the first match, and the pane previews it
without starting its host. Up and Down select, Home and End select the first
and last agent; Enter writes to the selected agent. Outside a text field, the
keys in the footer run their actions; `x` lists the actions the row does not
show, with their keys. In a text field every letter is text, so `ctrl+n` opens
and closes More there, and the row shows that chord instead of `x` when the row
has hidden entries. A key the
row's own hints claim stays with the view; an action with the same key lists in
More without one. A footer key with no terminal encoding shows
`The <key> key has no clickable form here.` instead of acting quietly. Escape
over the list clears the error filter first,
then Find, and keeps the chosen agent.

Selection reads passively: it never starts a host and never moves a draft
between agents. Sending a message starts a stopped host through the normal
send path. Selection, drafts, successful-message history, reading positions,
the delivery effect and pane layout survive closing and reopening in the same
primary process. Different primary sessions have independent UI state.

### Messages

Enter sends; Ctrl+J adds a new line. The message field's caption names the
recipient (`To Parser review`). An idle agent gets **Send**; a working agent
gets **Correction at next step** unless you choose **New work at next step**: click
the effect on the field's top border. In the list, `f` switches the effect too.
After
a send, the next message starts as steer again. In the message field, letters,
slash text and bang text are literal messages; outside a text field, the keys
in the footer run their actions. A
successful admission clears only the submitted draft revision, including after
the view reopens; newer text stays. A refused or uncertain admission keeps the
draft and the effect and states the reason in the receipt on the field's
bottom border. Text paste works; Pi's file and image attachment interface is
not embedded. Native hidden-row counts keep their space on the field's
borders.

### Controls and forms

The footer's controls act on the agent shown in the header:

- **Stop** (`s`, while the agent works), **Reconnect** (`r`, when it needs attention),
  **Work** (`w`, while the agent owes a final report),
  **Configure** (`c`, disabled with its reason while the agent works) and
  **Tasks** (`k`) show directly when they fit.
- **x more** (`ctrl+n` while a text field has focus) lists the rest with their
  keys: the delivery effect, Work when no work is open, Owner views
  (`o`), Fork, Rewind, Compact, Reset context, Schedule message, Scheduled
  messages, Run command, Profile, Details, Stop and release host, and host
  extras such as the terminal's Recover input (`u`).

Each action except the delivery effect opens a staged form or reader in the
inspector: beside the
conversation when the pane has 120 columns or more, otherwise in its place.
A form binds to the agent it opened for; selecting another agent closes it
without sending anything. Fields keep their values after a refusal; only the
effect-labelled action calls the owner, and Cancel or Escape sends nothing.

Owner views (`o`) read the selected host's advertised views. The answer opens
only while that agent and that view still own the screen: after another form
opens, another agent is selected, or the view is left, the late answer opens
nothing and states no failure.

- **Configure** stages Name, Model and Reasoning, then Apply. Models come from
  the host's model list, narrowed as you type; a current model the host does
  not list stays choosable. An unchanged form is refused before any request.
- **Fork** starts an idle branch from the latest committed entry or a chosen
  message; **Rewind** starts a corrected branch before a chosen message and
  needs the correction. Earlier messages pages back. The created branch opens
  while its form is still shown; after you leave the form, the branch appears in
  the list and nothing moves.
- **Compact** and **Reset context** take optional instructions or a handoff.
- **Run command** lists the native commands the target's live host advertises,
  or takes a typed name when the host lists none, plus arguments.
- **Schedule message** takes the message, a deadline as HH:MM local or a
  relative time such as `+30m`, and the busy effect. A Delivers line shows the
  exact instant the deadline names, or why it names none. The draft stays with
  its target until it is scheduled. The storage host must run at the deadline.
  **Scheduled messages** lists them by time and preview and cancels the chosen
  one.
- **Profile** shows the canonical identity, optional immutable handle, display
  name, role, actual model and reasoning, creator as provenance, directory,
  revision, update evidence, retained current request routes, and the saved
  expertise, which is evidence, not fresh authority. Requester and reply
  recipient remain separate. Cold profiles are labeled retained and reads start
  no host. Edit role or expertise stages a draft; Save checks the displayed
  revision. A conflict keeps the draft and requires reading the current profile
  and choosing its revision before another Save. Drafts survive closing and
  reopening within the primary process and never replace the message draft.
  `/agent profile <identity-or-@handle>` opens the same view; outside the
  interactive terminal it returns the full profile as text.
- **Details** reads the host status for the captured target and keeps all
  returned text.
- **Stop**, **Stop and release host** and **Reconnect**
  state the effect and run on their labelled action.
- **Tasks** shows the storage's live task graph. Open conversation selects the
  task's conversation, choosing among several when needed; Refresh retries an
  unavailable attachment. Closing Tasks releases only its task-graph watch.
- **Work** lists each request the agent declared
  [background work](#declared-background-work) for: open items first, oldest
  declaration first, then the retained closed items, newest close first. Under
  each request sit its dependencies and, once it closed, its final report. A
  click on the work count in the header opens it too. The detail shows the
  exact request, the input submission, requester, reply recipient and the
  declared note of what remains; each dependency's session, submission and request; and the final
  report's request, close status, delivery and exact read call. A dependency is
  `pending` while its input has not settled, `state note` when its producer
  answered with a state note and its own work stays open, `result arrived` when
  its result arrived, and `not established` with the host's reason when no
  committed fact or admitted delivery establishes its state. An arrived result
  and a delivered report are not task acceptance. Enter on a dependency reads
  its result page; Enter on a final report reads the complete retained report.
  Both follow each exact continuation the host returns, and every page must
  start where the previous one ended; after 64 pages the reader names the next
  exact call. A result whose request declared work offers `f`, which reads that
  request's final report. While the host is live, the list follows its live
  frame; otherwise one status read fills it and `r` reads again. Reads start no
  host, admit no input, acknowledge no delivery and change no work. Leaving a
  view or selecting another agent aborts its reads, and a pending live host
  request receives that abort. An ordinary session's `agent_work` note is not
  declared work; it stays a card in that session's transcript.

**New conversation** stages Purpose (the first message, literal text even when
it looks like a flag; empty creates an idle conversation), Preset (the machine
presets with resolved model and reasoning, the default first) and Directory.
Start creates the conversation and selects it with a Starting state before its
host is ready; the conversation then follows the host's live output. A late
completion never moves a selection the operator changed since: the created
conversation and its result stay in the list, and only its automatic selection
is given up. In ordinary Pi
the answer to the purpose comes back to this session; the attached terminal's
form is described above. The unsent purpose survives closing the form.

**Help** lists every key and pointer route, and starts with the machine
execution preferences: the file path, document status, digest, diagnostics,
enforcement setting, and every preset with its model.

### Layout and resizing

At side-by-side widths, drag the list's divider to exchange width with the
pane. The list takes 27% of the width, clamped to 32 to 60 columns; a saved
divider position is clamped to the same range. While a drag lasts, the list
keeps 32 to 60 columns and the pane keeps at least 60. Threads and Efforts use
the same list width. Drag the
small grip at the message field's top-right corner upward for more draft rows
or downward for more conversation rows; the conversation keeps at least four
rows, and a window too short for that shows no grip. Line 2 of the pane header
shows the sizes a drag sets (`List N · conversation N columns · release to
keep · esc restores`, or the message field rows); Escape restores the previous
size; double-click a handle to reset it. Hide list gives the pane the full
width. Stable pane preferences survive Pi
restarts in the agent-owned `agent-dashboard-layout.json` file under
`PI_AGENT_DIR` or Pi's agent directory. Only completed resize gestures and
resets write this private file, through an adjacent temporary file and atomic
rename. A failed save keeps the local split and shows a restart-persistence
notice. Pane resizing is mouse-only in fullscreen mode; keyboard-only and
regular-mode use keep the default or saved split. Resize cancels on terminal
dimension changes, hiding, or disposal.

Below 60 columns or 16 rows the view asks for a larger window.

### Header and fact lines

The header holds two lines, and a third line while the agent owes a final
report or has unplaced inputs: `work open: N, oldest: AGE` and `unplaced: N,
oldest: AGE`. A click on the work count opens Work, as `w` does. Line 1 shows the selected agent's bold
label and the project in muted text; a narrow pane drops the project, and only
then does the label shorten. The agent's actions are keys in the footer. Line 2
shows the state glyph and label, then at most one status: the first that
applies of the sizes of a resize
drag in progress, a notice from the last action, the error reason and its way
forward (see the list above), or the conversation load status (such as
`Partial history`), connection or stored-history warning. One blank line
follows the header. The agent's two status lines sit
under the message field, in the main session's footer layout. A line with
nothing known takes no row.

The first fact line uses the primary footer's presentation: the model registry
display name, a colored `[level]` only for a reasoning-capable model, a
ten-cell `█░` context bar and percent, context tokens over model window, `~$`
recorded cost, and `● NN% hit`. Dim `│` separators divide the fields. The bar
uses success through 60%, warning through 80%, and error above; it fills at 100%
but retains overflow percentages. These are display bands, not compaction
thresholds or a safe remaining budget. The current registry model is resolved
once per render. An unknown registry model retains its known model ID without
inventing a name or reasoning capability.

Context comes from the newest completed assistant usage and becomes unknown
after a newer compaction or reset until another assistant reports usage. An
unknown window leaves the known token count alone. Cost is the conversation's
recorded estimate across model and tool calls, including compaction; estimates
below half a cent are hidden. A `+` preserves a known incomplete cost. It is not
a billing statement. Cache hit is `cacheRead / (input + cacheRead + cacheWrite)`
across every model call in the agent's live `UsageState.models` totals,
**including compaction calls**, and excludes tool totals. The dot is green
when those totals contain cache reads and red for write-only cache use. It does
not establish a recent assistant cache result or a cache that is alive now.
Cache-free or unavailable totals produce no cache field. Unknown facts have no
placeholders. Narrow widths remove cache rate, cache dot, token count, then
cost; model and context bar stay to the end, with width clipping as a final
guard.

The second fact line shows the agent's home-relative cwd and its cached Git
branch. It shortens the path from the left before shortening or omitting the
branch. A `+1` cell marks a delegate segment hidden by width. When loaded
catalog rows identify that agent as their creating owner, a final
`agents: active/total active · ~$cost` segment counts only those delegates. A
`+` marks incomplete loaded coverage; unavailable child costs are absent. An
absent child observation is not a zero global count. These figures never use
the primary's own fleet total. Git reads use a bounded subprocess without a
shell, cache a bounded set of cwd values per view, and refresh only on
selection, cwd changes, or committed-entry events. In-flight events coalesce;
disposal and cache eviction abort pending reads. No Git polling or duration
tick exists.

Heading figures describe the loaded selection, not an unknown global total. A
`+` marks incomplete loaded coverage. A scrollbar shows the position within
loaded conversation content. The conversation's top rule shows only when there
is a scroll status to state: the distance below, or the action to load an
earlier or newer range. Estimated heights say `about`.

### Conversation and pointer

Conversation content uses Pi's native components after a two-column margin.
Prose, agent cards and communications are at most 100 columns wide; other tool
lines and their output use the pane's width, as in the main session. An
assistant message and the tool calls it issued form one step with no blank row
inside it. One blank row separates steps, and separates user, compaction and
custom-message blocks from their neighbours; consecutive steps that each show
only one-line tools join into one run without blank rows, so commentary and
open cards still start their own paragraph. A tool result belongs to its call.

Every tool other than an agent tool shows as one line by default: the bold tool
name, then one argument and an outcome in muted text, such as
`edit · src/index.ts → Successfully replaced 2 block(s)`. The argument is the
command for shell tools, the path for file tools, the pattern for search tools,
or the first useful string argument. A path inside the agent's cwd shows
relative to it, a path under the home directory starts with `~/`, and a leading
`cd <cwd> && ` is left out. The outcome is the first line of the result; a JSON
object result shows its `outcome`, `status`, `state` or `error` field; `read`
shows the line count, or `image`. A running tool ends in `→ pending`, and
partial output ends in `…`. A long line shortens the argument first and keeps
up to 40 columns of the outcome. A failed tool keeps the same line in the error
colour and always names the failure: a `message` field, including a nested one,
the first line of plain text, or the payload text itself; empty content reads
`failed`. Expansion still shows the full output. A click or Ctrl+O expands the
tool to its native call and result, without the outer coloured block of the
main transcript. Codemode, published
custom tools and unpublished tools follow the same rule. Agent tools keep the
shared agent card's two-line header and collapse only its body, without an
expansion hint line; the main transcript keeps its hint.

When expanded, codemode uses Pi's public codemode presentation, published custom
tools use their owning extension renderers through the
[tool-display contract](../../docs/conventions/tool-display.md), and unpublished
tools use Pi's standard named-argument card. Native built-ins, codemode, and
agent cards keep precedence. Display definitions never execute tools. The agent factory subscribes before it requests renderers.
Publishers subscribe before their initial publication. Pi reload replaces
subscriptions and the factory-local renderer registry; reopening the view
creates new component instances.

An unmodified single left click reaches the native component. Native handlers
toggle one tool card or thinking run, including its hidden label; custom child
controls keep their own actions. Unhandled clicks on pending cards and card
padding toggle the card through Pi's public expansion setter. The clicked item
stays in view and suspends tail-follow. Press, drag, release, modified clicks,
and multiple clicks stay available for Pi's native text selection. Ctrl+O sets
all tool cards and communications and clears individual choices; Ctrl+T does
the same for thinking. The footer lists both as Expand all and Show thinking.
Thinking starts hidden for every agent, whatever the primary's setting. A
message that also has text, a tool call or an error hides its thinking without
a row; a message with only thinking keeps one `▸ Thinking` row, which a click
opens. Ctrl+T here changes only this view and never writes primary settings.

In Pi fullscreen mode, click a list row to select it, a footer control to run
its key, the message field to focus it and place its caret, the header's work
count to open Work, and a
time to switch every time between relative age and local date and time. A
control drawn before a refresh or resize never runs a replaced action. The
wheel scrolls the pane under the pointer; list scroll does not change the
selected agent or the message recipient. Regular terminal mode leaves mouse
input to the terminal. Except for pane resizing, every action keeps a keyboard
path; no mouse setting or global shortcut is added.

The view does not embed InteractiveMode. The published extension API has no
complete InteractiveMode view, editor state, dialog, widget, or renderer
registry to mount. The view composes public chat, editor, and scrolling
primitives instead.

## Live conversation and history

Observation uses public Durable entries, documents, submissions, task outcomes,
and views. The selected conversation renders Pi's published chat components,
built-in tool cards, arguments, thinking, and tool results paired with their
calls. Live partial text and running output update before the turn ends.
The native generation state defines an assistant partial, including providers
that set a final stop reason before their text stream ends. Committed output
replaces its partial. Hidden native messages stay hidden.
Display limits remain explicit; missing content is not a fabricated answer.

Observation feeds deliver a full initial snapshot and Chord structural updates
thereafter. Reconnect delivers another complete snapshot. Chord reconstructs each
complete frame and retains unchanged subtree identities, so the client needs no
custom patch protocol. The work view reuses committed history and its snapshot
when the entries reference, completeness and history cursor stay unchanged. It
recomputes committed context usage only when the entries change, while live
output, status, current usage and notices still update on each applied frame.
Selection changes, reconnect, history navigation and disposal clear this local
reuse state. Disappeared live slots still finalise their partial cards.

Live frames are built and applied from the newest state, not once per change.
The host marks its observation scheduler dirty on every native publication, which
is cheap, and builds frames at most once per 100 ms; a change that arrives while
a frame is being built leaves one trailing pass, so the final state is always
published. Elapsed cadence uses monotonic time, so a wall-clock correction does
not delay or rush a pass. A new subscription gets its baseline frame at once and
then marks the scheduler once to cover a racing update; an unchanged revision
publishes nothing. The last closed subscription cancels the waiting pass, and host
shutdown stops the scheduler before the runtime closes. The work view marks the
selected conversation dirty on each frame notification and applies the newest
frame (history reconciliation, snapshot, usage, branch refresh and render) at
most once per 50 ms. The first frame of a new selection applies at once; a
selection change cancels pending work, and an application scheduled for an
earlier selection never updates the new one. After the baseline, presentation
lags a change by at most about 150 ms plus construction and transport. Control
responses, durable commits, catalogue publication, history persistence and
report delivery are not delayed by this scheduling.

One dashboard observes one selected conversation. Selection changes release the
previous watch. Tasks acquires a separate storage task-graph watch only while
its view is open. A task with several conversations offers a conversation
picker. Finished tasks leave the graph; their results stay in the conversation.
No live host means no live task graph, not proof of no retained work.
Refresh in Tasks retries an unavailable observation attachment. A pending or
live attachment stays unchanged. Subscription updates only read the selected
graph; they do not retry a declined attachment. An attached observer also accepts
live frames after a connection recovery. Refresh never starts a host or admits
input, and closing Tasks releases only its task-graph watch.

Observation attaches to an existing host and never starts one. If the same
manager already owns a host launch, observation joins that pending open and
attaches as soon as the host is ready, without a roster change. A storage file
that does not exist yet reads as an empty conversation, not a file error.
An unavailable observation shows one plain warning. Stored messages remain
readable without LIVE or RETAINED labels in the status block.
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
not every rendered line. A partial transcript also shows the first line of its
first input from the published summary, as `First task · <line>`; Details keeps
the whole text. It is history, not the current role or task. The view trims
blank rows at each component's edges and adds the step gaps itself. Native
assistant and tool instances stay stable
through content, argument, and result updates. When a missing call arrives, a
built-in fallback card rebuilds once to acquire its native renderer. Pi exposes
no renderer replacement setter. Tool expansion choices survive
history eviction and dashboard close/reopen by call ID in the same primary
process. Thinking choices belong only to the actual native assistant instance.
They survive live updates and the matching live-to-committed transition, but
reset after instance eviction, selection changes, or dashboard close/reopen.
Ctrl+T resets every retained assistant through Pi's thinking setter; Ctrl+O
sets every retained card and clears recorded tool choices. Reopened dashboards
create fresh components and use the current runtime's renderer definitions.
Native nested calls arrive through Durable's `pi.live.nestedTools`, separate
from model-issued calls. The dashboard shows their native arguments, parent call,
status, partial output, details, and recorded duration when present. Nested
slots do not become synthetic assistant messages or reconstructed codemode
result details. Native tool components retain their instances across slot updates.
Final codemode results use the public `details.calls` shape: numeric script call
IDs, names, bounded arguments, statuses, and optional `durationMs`, without a
fabricated cost field. The dashboard passes these details to Pi's codemode
renderer. Missing arguments stay absent. For nonpartial results, remaining
`running` rows display as `cancelled`; partial results stay unchanged. Stored
snapshots are never mutated.
The primary's no-target `agent_status` is a compact fleet overview. Live hosts
and records created by the caller come first, including idle conversations.
Other records follow catalog metadata recency. Independent host, recovery, or availability faults make
any state an attention row; a deliberate stop alone does not. Summary counts
are semantic groups, not state totals: `working` counts working or starting rows
without an attention reason, `attention` counts every attention row, and `quiet`
counts the remaining rows. Summary groups remain independent of roster priority.
Each overview row keeps the catalogue's optional `attention` hint
(`provider-blocked`, `task-blocked`, or `failed-turn`). Excerpts have visible shortening markers. Working and attention rows retain
identity, cwd, ownership, model, update time, state, cost, partial-cost flag,
current tool, tool count, duration, latest reply, errors, and recovery health
when those fields exist. Live or caller-owned quiet rows are not restricted to
the quiet-history sample, but all rows remain subject to the overview byte limit.
Other quiet history, connected primaries, and failures have bounded samples and
explicit `summary` totals rather than silent row drops.

`coverage` states source inspections, skipped views, excluded rows, byte omissions,
and the exact serialized byte size. Its `inventory` reports the priority scan
and source output limit. `omittedPriorityRows` counts live or caller-owned rows
excluded by the overview byte limit. `omittedPriorityRecords` counts distinct
records with at least one such excluded row, even when another row from that
record remains visible. Counts cover the supplied catalog page,
not unseen inventory. `complete` remains true for an intentional quiet summary
only when source coverage is complete; source gaps or byte exclusions make it
false. `coverage.reasons` names recovery paths and boundaries. The overview
returns `coverage.nextCursor: null` because `agent_status` accepts no cursor;
it never exposes the dashboard's catalog cursor. Call `agent_list` without a
cursor, then repeat its returned `nextCursor` to find other identities. Use
targeted `agent_status` with `detail: true` for
full conversation state. Native agents without a status target read their own
storage's conversation state rather than the primary's fleet overview.

A targeted `agent_status` without `detail: true` returns a compact status for
ordinary and Durable callers. It keeps the exact identity, busy state,
availability, queue and timer counts, the count of admitted inputs that are
not yet placed (`unplaced`) with the age of the oldest in milliseconds
(`oldest`, absent when none is unplaced), the known name, model and thinking level,
the current run, and a provider-block recovery call. It
names what it leaves out and carries the exact call for the full status. A
retained run failure (reason and detail) and a delivery error stay in the
compact status, with recognised credentials removed, byte bounds and explicit
truncation flags. The compact status fits 8,192 serialised bytes. Over that
bound the name goes first, then the delivery error, then the run failure; a
status that still exceeds the bound is refused with a pointer to
`detail: true`. `detail: false` is the same as no `detail`. Source:
`status-overview.ts` (`projectSelectedStatus`, `validateStatusDetail`).

`agent_status {view: "fleet"}` is a separate local observation on both ordinary
and native tools. It scans bounded catalog pages without opening hosts or
reading transcripts. Model rows sort by exact provider/model identity and show
reported model costs, sampled last-response times, current selections grouped
by thinking level, and active conversation counts. Active means a published
Starting or Working state, not a live host check. Tool costs stay separate.
The latest retained attributed failure per provider sorts newest first, with
stable identity tie-breakers. Warning samples describe observed conversation
state, not proven provider faults. The response bounds rows, samples, and
serialized text; coverage separates catalog limits, unknown publications,
source omissions, and output omissions. Each call starts a fresh scan. It
reports whether more catalog entries remain but exposes no unusable cursor.
Missing evidence is unknown, not zero. Reported costs are not invoices or
remaining allowance; past use is not preference. This view does not query
provider health, quotas, account balances, or billing services.

Use optional `model: "provider/model"` or `provider: "provider"` to select exact
published evidence. Both fields use intersection when supplied together; a
conflicting pair returns no match. Model identities preserve all text after the
first slash. Filters require `view: "fleet"` and refuse a `sessionId`.
Malformed, whitespace-containing, control-containing, or oversized selectors
are refused before the catalog scan. Model selectors have a UTF-8 byte limit of
512 and provider selectors have a limit of 200.

For a task such as "Compare recent machine-local evidence for these two
configured lead candidates; show relevant use/failure evidence and gaps":

1. Resolve the current presets and their exact model identities.
2. Read each model's current capability facts through the configured catalog.
3. Query `agent_status` with `view: "fleet"` and each exact `model` identity.
4. Compare the relevant published facts, source freshness, and unknown coverage.
5. Choose by task needs and operator preferences, not a fixed model ranking.

A filtered response adds `selection.filter`: `model`, `provider`, or
`model-and-provider`. It describes the filter kind, not a standalone replayable
query. Exact query identities remain in the tool arguments; returned model rows
retain their complete identities. The result does not repeat selector text.
`selection` also carries the match outcome and matching model/failure/warning
counts before output bounds. Its `scope` names the selected rows. Matching model rows take
output priority over failure details and provider summaries. An exact-model
provider subtotal includes only that model's samples, never sibling models.
Calls without filters retain their existing shape and failure-first order.

`selection.globalScope` names the unchanged machine-wide coverage, usage
coverage, conversation counts, tool cost, and caller-effort accounting. Those
fields are not selected-model spend. Unknown-model conversations and source
omissions remain visible. Output omissions count only matching candidates; rows
excluded by the selectors are not output omissions. Filters change neither the
catalog traversal bounds nor the published evidence producer.

A no-match result establishes only that covered publications contain no matching
evidence. It does not establish no use, provider health, quota, or catalog
absence. Source publications already reduce failure samples to the latest per
provider; filters cannot recover omitted failures, compacted history, or unread
publications. Registry capability facts and sampled usage do not establish
reasoning quality, invoice accuracy, or a provider cache lifetime.

`models[].usage` and `providers[].usage` expose `last5h` and `last7d` sample
sums: tokens, nominal reported cost, and response count. Each read filters
message timestamps against its own inclusive rolling cutoffs. These are lower
bounds from published, owned assistant responses, not complete window totals.
Compacted or inactive history, compaction calls, tools, ordinary primary
responses, and unpublished work are absent. `usageCoverage.status` is always
`partial`; sample spans, publication times, and omission counts qualify the
result. No samples does not mean no use.

`effort` separately totals lifetime reported cost for the caller and its
direct-created conversations. It includes earlier tasks and reused agents,
not only the current assignment or recursive descendants. Native callers use
creation records; ordinary callers use catalog owner records and bounded usage
from already-loaded session entries. Missing, partial, and omitted members stay
visible. The total does not include every conversation in a shared storage.

Before dispatch, use this view to compare observed recent activity, then check
publication freshness and missing members. It supplies neither remaining quota
nor a request-owned usage ceiling.

Agent model parameters carry shared selection guidance: apply current task
directions and the operator's route, budget, and role preferences, then verify
the exact model identity and its supported thinking level. Configured access
does not establish operator use. The extension carries no bundled provider
roster or model ranking; optional machine preferences supply local guidance.
`agent_spawn`, `agent_place`, and `agent_configure` accept a named `preset`.
Each field uses an explicit argument before its selected preset value, then its
operation default. Creation uses defaultPreset only with neither model nor preset;
parent model and thinking settings never supply creation defaults.
Configure uses the target's retained values, never the caller's model.
`agent_send` selects no model. See [execution presets and delegation preferences](#execution-presets-and-delegation-preferences)
for the machine document and receipt fields.

New agent creation refuses an exact model absent from the configured catalog
before creating the agent. When Pi clamps a thinking level, the dispatch result
includes `thinking: {requested, effective}`. Reusing a handle keeps its retained
configuration; supplied model, thinking, and role fields, including preset
values, are reported as unapplied rather than retuning it.

Committed snapshot and conversation frame entries carry a closed `communication`
view. Readable history and activity carry the same view on every compact row.
A ready view supplies the original native target, a separate record ID, checked
sender facts and a structured body. Pending or absent metadata is unresolved;
invalid or bounded-out metadata has an unavailable marker. The native terminal
uses this joined value without parsing transport text. Exact, branch and search
retain their original source paths. Result inspection accepts a native request ID
within the selected conversation, a submission ID or a separate retained
operation ID. Supplied selectors must agree. Missing native results return
unavailable without a fabricated submission or entry. Communication bookkeeping is hidden
only on display surfaces, with native pagination and hidden counts preserved.
Bodies and added views have separate UTF-8 bounds; native input bytes, order,
admission, cancellation and settlement remain unchanged. The existing post-native
classification commit captures trusted metadata before a successful host response,
including late suppression when native abort reports an already-placed or settled
input. A queued abort keeps its suppression response without a fabricated link.
Plain admissions retain their no-envelope decision in the existing provenance row
and the persisted `CommunicationIndexDoc` point-index family; eviction and stale
dedupe observations do not permit later backfill. This session-scoped family
retains lookup hints, not authoritative communication records. Each observation
verifies the immutable native target and companion before publishing their join. The
plain view stays unresolved without a companion or invalid marker.
The retained input collection watermark stays 128; it is not an admission cap.
Queued native inputs and live-run classifications whose native input is not yet
admitted retain their exact provenance and communication intent. This pending
backlog does not prevent later input admission. Placed inputs leave the
native inbox even while their run continues. Pruning prepares all native reads before companion writes and
materializes unlinked metadata or no-envelope decisions before row eviction in
the same transaction. Queued intent reconciliation uses the existing background
and reopen paths, not another queue. Native admission remains a separate commit;
a crash before owner capture leaves an unresolved association. See the
[Agent host contract](../../docs/agent-host-contract.md#native-communication-provenance)
for envelopes, exact fork visibility, public limits and operation identities.

Snapshot pages and conversation frames optionally expose `taskSenders`, keyed by
native input entry ID, with `{identity, name?}` for the structured task requester.
This hint is separate from `communication` and reply routing. Local and wire task
admission capture it; only checked same-storage metadata supplies a name. Missing
hints mean unknown. Model-less `agent.task-sender` companions retain first capture
and use the existing point index, native submission checks and fork-aware cutoff.
Display and compact reads hide those companions; raw exact and branch reads retain
them. Existing no-envelope records remain unresolved rather than backfilled. The
hint bound never removes native entries, and the native-admission crash boundary
above remains unchanged. See the [task input sender contract](../../docs/agent-host-contract.md#task-input-sender-hints)
for the public shape and bounds.

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

Native timing stays separate from elapsed activity. Compact tool-result excerpts
retain optional recorded `durationMs`, including zero, without deriving it from
entry age. Snapshot assistant and tool-result messages retain their native
recorded durations for existing Pi terminal components. Status task rows expose
optional native `startedAt` and `endedAt`: wall-clock first-running and terminal
timestamps whose span includes waits and recovery. These status rows contain
live tasks, so `endedAt` is absent there. Unavailable or interrupted tools need
not carry duration. Dashboard `durationMs` remains latest-user-turn wall-clock
elapsed; activity `elapsedMs` remains qualified tool-call-entry age. Neither
quantity replaces recorded execution time. See the
[host timing contract](../../docs/agent-host-contract.md#current-operation-identities)
for fields and current schema identities.

Search continuations require the complete returned `nextCursor` object unchanged,
including `cursor`, `skip`, and `scannedBytes`. An incomplete or malformed object
is refused rather than restarting the search.

Continue incomplete pages even without matches. Provider signatures, image
payloads, and redacted thinking stay omitted with markers and counts on raw
reads. Observation and task outcomes grant no control or acceptance authority.

Status, live message projections, nested tool summaries, and result inspection
expose only the public usage counters and cost fields, including optional boolean
`cost.totalFromProvider`. Absent or false denotes an estimate; true denotes a
provider-reported total. These projections preserve native totals without local
aggregation. Nested summaries follow this rule even without a generation message.
Tool calls retain optional string `argumentsError`; the terminal call card shows
that diagnostic on one line. Provider-private parsing buffers stay omitted.
Retained entries and usage documents keep provider metadata unchanged.

The manager's stopped-agent reads use a cached public snapshot without services,
model runtime, extension bootstrap, or task recovery. The manager owns its cache.
Registered primaries and roster subscribers retain it. The
last owner's departure seals the cache and drains borrowed reads before disposal.
A later owner acquires a fresh cache. Manager and standalone terminal closure await
all disposal, including releases started by roster unsubscription.
The cache tracks database and WAL identity plus writer claim state. Changed or
unstable source identity refuses reuse. All cache paths share a serial queue to
protect borrowed snapshots from eviction and teardown.
Filesystem-only capture never opens the source through SQLite and never creates
source sidecars; an absent WAL must remain absent for reuse. SQLite validation and
delivery preparation use only the private copy. A public Session performs that
preparation without a scheduler, then closes its Storage. The capture owner reopens
the same copy for a read-only Harness. Native tasks retain their committed status,
restart count, checkpoint, ownership and abort fields. Observation reads do not
create optional documents or settle deliveries; attempted writes reject. An absent database
has an empty in-memory internal observation that is not cached, so a later read
sees database creation.

The command loads the work view, its forms and the owner-view loader only when
the view opens. Control commands and completion stay available before that
load.

## Roster and coverage

The roster reads bounded host-published metadata through `dashboard-types.ts`.
It parses no ordinary JSONL, opens no conversation database, and starts no host.
Roster blocks show the state glyph and one bold label with the last-change time
at the right, then one muted fact line: the error reason for an agent with an
error, the current tool and model for a working agent, otherwise the model,
thinking level and cost. The wide list and the narrow strip use the same
blocks. The provider belongs in the selected header, not in each roster block.
A continuous marker and background identify the selected block. State glyphs
retain their state colors. Working and Done labels do not repeat the glyph. The
footer distinguishes loaded rows outside the window, the error filter, the
scope and Find filters, and the Load more agents catalog action.
Times default to `just now`, `15m ago`, `3h ago`, or `1d ago`, with no seconds
counter. These ages describe recorded changes, not current activity.
Press `i` in the roster or a thread, or click a visible time in fullscreen mode,
to switch every dashboard time to the absolute local date and time, such as
`Oct 4, 2026, 12:01 PM`. Neither form has an `Updated` label or a local suffix.
Exact time shares the fact line at the right of each roster block; the facts
shorten to fit, and the label keeps its own row. Both time modes keep
three-row blocks. The same
choice applies to thread event times and survives close and reopen in the same
Pi session and process; it is not saved to disk. The display name is the label;
a retained `@handle` labels an agent without one and stays searchable through
Find. A historical first input is a quoted fallback, never a standing role.
Duplicate labels receive unique identity suffixes. Unknown cost shows `$?`; a known partial cost shows a trailing
`+`, such as `$1.00+`, in the selected-agent footer and roster rows. Roster totals
use the same marker, such as `$1.50+ retained`, for a known subtotal with incomplete
cost or inventory coverage. These totals keep their roster scope.

The roster is one flat list. Live hosts and records created by the caller come
first, then other records. Each group uses catalog file modification time and
identity as the tie-breaker; displayed row times remain source-published facts. State glyphs replace group headers. Failure text uses the actual
retained error, without a `Work failed:` prefix. The host publishes the native
unanswered submission's error detail, the last assistant error, or the native
`pi.live.runFailure` reason and detail, in the existing error field. An idle
conversation whose newest run ended without an answer is `failed` (`stopped`
when the run was aborted) until a later run starts. A delivery receipt defines the outcome only while no
newer input supersedes it; an unowned report still changes the current outcome.
An error reason exists for unavailable or conflicted storage, a host error,
failed compaction, failed work with an error, or exhausted retries; the footer
counts these rows `with errors`. A failed run stays failed until a new input,
so an old failure keeps its reason and age instead of reading as a new alarm.
Done and deliberately stopped work have no error reason by themselves. The
manager joins the host-published intervention hint (`provider-blocked`,
`task-blocked` or `failed-turn`) to its row; an absent hint is unknown. The
selected agent's header shows the reason and its way forward. Selection follows identity, not roster index, and roster order stays
fixed during an arrow sequence. Text entry locks its recipient even while
published metadata changes.

Coverage carries `complete`, `storagesVisited`, `skipped`, `omitted`, and
`nextCursor`. The list shows only what the operator can act on: Load more when
the cursor continues, and a short note while related work is still read.
Storage counts such as unreadable or omitted records stay in Details and the
plain-text summary; they are not selected-agent warnings. Unreadable or missing
views remain unknown, not absent. Load more agents continues the cursor; a
short row puts lower-priority controls in `x more`, with their keys, and
`ctrl+n` opens the same menu while a text field has focus. Rows carry
no creating-session tag. A
provider error that ends in a JSON body reads as its message, for example
`429 Usage limit reached`. Find searches loaded
handle, role hint, name, historical first input, path, model, state, and identity,
not transcript text. Find
previews the selected match before the filter is committed; Esc restores the
previous filter and selection. A filter with no match is not an empty store:
Enter does nothing and Esc clears the filter. An empty page or missing view is
not proof of absence. Without verified current-link evidence, an absent or
ended recorded generation marks previously working retained metadata Interrupted.
A verified current link without a publication marks that state Unavailable.
A valid clean-end marker for that exact writer takes precedence.
Unknown ownership marks that state Unavailable and removes its stale current
tool. A negotiated, connected host with a successful bounded publication keeps
its published working state and current tool. Its timestamp qualifies the
snapshot; it is not an instantaneous query. Claim errors remain explicit.
Host health belongs to the publication time; later publications clear it.
The manager adds current recovery errors without rewriting published views.

A serialized catalog view stays within 24 KiB. Published `latestReply` and
`currentTool.argument` text stays within 2,000 UTF-16 code units, including the
` […]` truncation marker. Truncation does not split a surrogate pair. Trimmed
text makes the base view's coverage incomplete.

The host also publishes optional top-level `attention` hints, separate from
native observation rows. `attention.rows` joins to the base rows by `identity`.
Each hint has one `kind`:

- `provider-blocked`, with `blockId`: retained provider control requires explicit
  recovery.
- `task-blocked`, with `taskId` and `reason`: the host requires repair because the
  native scheduler reports `missing_task`, `task_too_old`, or `migration_failed`.
  This is not a question awaiting a user answer.
- `failed-turn`: the native summary reports a failed turn. This includes a run
  that Durable ended because host crashes cut it off at its restart limit
  (`pi.live.runFailure` reason `restart_limit` or `interrupted`). That outcome
  is terminal: the host never resubmits it, and a new input runs the work again.

For one identity, provider blocks take priority over blocked tasks, then failed
turns. Each publication recomputes the hints from owned facts. Explicit provider
recovery removes the provider block. A usable task definition or terminal task
removes the blocked-task hint. A later native turn state replaces failed-turn
attention. Automatic retries, compaction diagnostics alone, and reply prose do
not produce these hints.

`attention.coverage` records publication coverage through `complete` and
`omitted`. Hints use only the bytes left by operational rows and profile hints;
budget pressure drops attention hints before operational rows. Missing hints
remain unknown even when their publication coverage is complete. They do not
establish the absence of a human question or a need for intervention. Consumers
must read the top-level hints explicitly; native row shapes remain unchanged.

Profile hints are a separate retained catalog projection joined by canonical
identity, not added fields in base host observation rows. Missing hints mean
unknown profile coverage, not an empty role. `agent_list` reports
`coverage.profileHints` even on an empty match page: omitted hints and storages
with unknown hints qualify the search. Hints contain no expertise bodies and
may shorten a role. Use Profile for the complete bounded role and expertise.
Exact handle resolution does not depend on roster or list completeness.

Host notifications coalesce roster refreshes. A bounded metadata reconciliation
while the dashboard is visible discovers hosts created elsewhere and dead
claims. Neither path repeatedly reads transcripts. Streaming frames coalesce
before application and paint (see
[live conversation and history](#live-conversation-and-history)); local input
paints immediately. Closing the dashboard releases its listeners and
UI timers. A registered primary keeps the shared catalog observer active.
A failed refresh keeps the last good roster. A transient failure stays quiet
when rows remain available; repeated failures or an empty roster show a notice
on the roster’s last line. A successful refresh clears that notice.

The primary status line and dashboard heading use the same session scope:
agents created by the current primary session and their creation descendants,
plus exact conversations this session sent work to. Sent-work targets remain in
scope after settlement. Their creation descendants contribute only while
`working`, so old idle delegates do not enter the session count. When a sent-work
target is a storage root, its other same-storage conversations contribute only
while `working`. The roster lacks conversation-level creator evidence, so these
working conversations serve as practical root delegation scope. A non-root
target does not pull in its storage siblings.
Creation lineage remains in scope in every state. Other primary sessions and
unrelated retained agents do not contribute. The roster still lists discovered
agents across sessions.

Sent-work scope comes from successful native admissions in retained tool results
and `agent.sent-work` custom session entries. The extension reads all session
branches once at session start, then records targets incrementally through Pi's
public `appendEntry` API. Send, steer, spawn and place with a prompt, rewind
corrections, and scheduled inputs record exact targets. Reports, generic
`agent_command` calls, collaboration notifications, idle attachment, and failed
admissions are not task
admissions for this scope. Report exclusion follows the requester/task contract;
the scope does not count every input that wakes a provider. The scope is
session-wide, not selected-branch-wide.

Historical nested or codemode sends without markers cannot be reconstructed:
Pi's public `NestedToolCalls` records names, arguments and execution status, not
results or canonical admitted targets. Nested sends admitted through the
registered manager path persist markers. A failed marker write preserves
admission success and in-memory scope; the existing manager failure report names
the possible restart coverage gap.

It uses sent work rather than open requests because an alternate `replyTo`
routes settlement elsewhere; the primary's retained results cannot establish
that every request settled. No catalog schema or host protocol carries this scope.

The status says `agents: <working>/<total> active · ~$<cost>` and disappears when
no session-scoped rows are found. The numerator counts displayed `working` rows
with a verified current-host publication; the denominator includes every scoped
row. Each registered primary receives its own caller-prioritized page and
figures. A `+` after the denominator marks unresolved selected claims, unseen
records, unreadable records, or incomplete published projections. Connected
publications resolve selected claims for presentation only; raw catalogue
coverage, including `unknownClaims`, remains unchanged. The loaded count is not
a global total. Catalog publication notices refresh these figures even when the
dashboard is closed and the primary has no connection to the publishing host.
The primary and dashboard share one catalog observer; it closes after the last
primary and dashboard listener leave. This observation starts no host and adds no
polling timer. The dashboard reuses its scanned roster page for these figures
without another catalog scan or native profile read. Cost includes only creation
lineage. Sent-work-only targets and their delegates contribute no cost because
Durable lifetime usage is not attributable to this session's request. Repeated
reads never add the same usage twice. These figures cover this session's readable
agent data. The
`~` marks a recorded-pricing estimate, like the main session cost, not a billing
statement. Cost uses two decimals; the entire cost segment is hidden below half
a cent, leaving, for example, `agents: 0/1 active`. The dashboard shows unreadable
agents and partial costs.

## Agent collaboration and placement

Place mutations hold one exclusive book lock. Every existing lock refuses
mutation, including an orphan. Offline recovery requires all relevant writers
and launchers stopped. A proposed book must fit the reader's serialized UTF-8
byte cap before publication. Creating a place reserves those exact binding
fields under the lock before catalogue publication or host launch. Capacity
refusal preserves the original readable bytes and starts no host. Reads use
nonblocking, no-follow open, regular-file validation and one growth sentinel.

Agent controls reach native conversations whose effective selection includes
them, so an agent can run its own agents. Placement without a handle is
decided at spawn time and stated in the result. An omitted cwd selects the
caller's cwd. The same canonical directory (compared by real path, with a
lexical fallback if realpath resolution fails) creates a conversation in the
caller's storage. A different cwd creates a new storage with its own host.
A new spawn conversation stores the model and thinking values from the common
execution resolver, not its creator's execution settings, and has a fresh profile. There is
no generation-depth gate in the creation paths.

A no-target `agent_status` inside an agent returns compact rows for the
conversations of its storage, with the storage coverage unchanged. Each row has
an exact full-detail call. The result names what it leaves out: host inventory,
effort awareness, and created-agent detail. It carries no `Created agents`
section and no `createdAgents` field, and `detail: true` requires an explicit
`sessionId`, so no `agent_status` call inside a Durable agent returns the
caller's creation record or its effort awareness. The caller's retained creation
record covers native spawns, recorded forks and rewinds, and foreign spawns, not
handles resolved as independent roots. Fleet observations still use that record
for caller-effort accounting.

Lifecycle boundaries stay with the creating conversation. Its reset or ordinary
abort does not reach background agent work or its reporters; a background abort
crosses those boundaries within the storage. Compaction preserves active work and
queued inputs; its summary applies at a native boundary. Idle host
retirement cannot proceed while same-storage agents hold live work. An agent's
foreign detached host survives its creator's host retirement. Result delivery reacquires a retired owner host. Answers,
reports, and check-ins follow each task's retained request route; the
creating owner is provenance, not a substitute when request routing is
unavailable.

Agents are eligible for the operator's bounded roster without a depth-based
exclusion. Catalog, storage-scan, and display limits still apply. The operator
can steer, abort, or reset a retained agent by canonical identity without routing
through its creator.

A client stop request selects a native admitted-input group, not whichever generation is
current when the request arrives. It follows that group's generation handovers,
withdraws its exact queued delegations, and preserves unrelated work in a shared
agent. An answered child does not hide its surviving background descendants.
Stop follows their original input links without selecting a newer child group.
Prompted `agent_place` also records its initiating input group and exact admitted
result. Confirmed replay returns that retained response without another place
lookup, even after the area binding changes. An interrupted confirmation leaves
partial coverage. The area owner stays shared, not an exclusively owned child.
An empty or absent prompt only resolves the owner and records no delegated input;
nonempty prompt text passes verbatim.
Partial cancellation and unavailable ownership remain explicit. See the
[public control contract](../../docs/agent-host-contract.md#run-scope-and-run-stop)
for selectors, native ownership, cancellation races, and coverage limits.

Without declared background work, an answer settles the request; it does not
represent a pause for later work. Use report mode for interim progress. Put the
substantive result or exact blocker in that terminal answer, not a waiting note
or a closing message that points to an earlier answer. With declared work,
`agent_work complete` sends the final result as a separate report. Native
settlement and task acceptance remain separate. Creation records do not define
dependencies or authorize cancellation.

### Read peer results

Keep each exact admitted `result: {sessionId, submissionId, requestId?}`
reference from a spawn or send. Read it with `agent_inspect`, `view: "result"`,
and its exact submission or request selector. The read returns the currently
committed state at once: `queued`, `placed`, `done`, `unanswered`, or
`unavailable`. It does not hold a tool call open for later results. Creation
records, names, reports, timers and thread posts are not result references.
Ordinary primaries and native agents receive answers through normal delivery.

A result read neither acknowledges nor withdraws its normal delivery. The
recipient therefore still receives that delivery after an earlier inspection.
A retained receipt and a successful read establish result state, not acceptance
of the work. Do useful independent work while a peer works; do not poll result
reads or keep a tool call open just to await a peer.

### Declared background work

Inside a native agent, `agent_work` records work that outlives the current run.
The item belongs to one routed request and retains that request's requester,
reply recipient, input submission and exact dependency references in the
conversation document `agent.open-work`. It does not keep a generation or tool
call open. A fork starts without these items.

After delegation, finish the useful independent work first. When only the
background work remains, declare it and end the run with a short state note:

```ts
agent_work({
  action: "continue",
  request: "request-id-from-the-route-note",
  results: [resultA, resultB],
  note: "Combine the two results and report the conclusion.",
});
```

`continue` requires `results` and `note`. Omit `request` only when the run has
one routed input, or no routed inputs and one open item. With several requests,
name the one this work serves. A repeated declaration replaces its dependencies
and note without changing its original route. A new item requires a placed
input with a retained route. Self-dependencies and duplicate references refuse.

The state note starts with words that say it is not the result. Pi still
settles that native input as `done`; the declared item stays open. Incoming
results and reports use normal delivery and start another run when the
recipient is idle. A native `done` receipt therefore does not close the work.

For a routed task that remains blocked or deferred without a producer,
use `results: []` with its request and note. This retains open work without
dependencies; it withdraws nothing. No dependency event wakes that item.
It does not complete merely because the current run ends. If the declaring
input ends `unanswered` instead of a state note, the host omits the open item;
the original unanswered receipt supplies that outcome. A later `complete` for
that request refuses and names this cause.

Finish the work with its original request ID and the complete final report:

```ts
agent_work({
  action: "complete",
  request: "request-id-from-the-route-note",
  status: "done", // or "failed"
  message: "The complete result or exact blocker for the reply recipient.",
});
```

`complete` closes the item and retains one final report for its original reply
recipient in the same commit. If that recipient is the declaring conversation
itself, the report remains retained for reading and is never admitted to that
conversation as an input. Its close shows `delivery: "retained"`; the same rule
applies to the final reports from abort and reset. Otherwise normal report
delivery remains at least once. While the close remains retained, a repeated
completion returns it and creates no second report;
this is not an exactly-once context-delivery claim. An arrived dependency and a
settled input never invoke completion. Closed items do not reopen. The work
record does not cancel its producers.

Completion does not depend on the answer of the declaring input. A run can
complete its work and then stop or fail before it answers. The input then
settles `unanswered` and keeps that status; the closed item and its final
report stay, and the report is the result of the request. The host writes no
answer for that input and does not change its status.

The work document retains every open item and the newest 16 closed items.
For an older close or a request that never declared work, completion returns
an error that names both possible causes. It changes nothing and sends
no report. For an input of this conversation the error also names the exact
final-report read call. This bound does not remove the separately retained
final report.

The final report keeps its own identity: the report request ID
`work-final:<conversation>:<request>` and its reply recipient. The completion
result and each closed status item carry `close.read`, the exact call
`agent_inspect({view: "result", sessionId, submissionId, finalReport: true,
offset: 0})` on the declaring input. It returns the retained report text,
including its label line, in pages; see Result pages. The read stays
available after the recipient acknowledged the report and after the closed
item left the work document, because it reads the retained report row by its
fixed key. It does not depend on the status of the declaring input: the
report is readable while that input is still placed and after it ended
unanswered.

Read `agent_status({sessionId, detail: true})` for `openWork`. Each item names
its original route, note, state and dependencies. A dependency is `open` while
its input is unsettled, `state-note` when its input settled but its own work
remains open, or `arrived` when its settled input has no open work. For a
producer in another storage, an admitted labelled state-note receipt records
`state-note`; an admitted ordinary result or explicit final report records
`arrived`. The producer's delivery carries typed `dependencyMarks`, and the
recipient retains them for its own open work. An `arrived` mark never becomes
`state-note` again. The producer classifies a receipt as a state note when its
request has a retained work item or a retained final report row. A closed item
that left the bounded work document therefore keeps its receipt a state note,
in the receipt label, the delivery text and the mark, while the final report
is still pending; the size of the work document never changes what a settled
answer was.

Without a matching admitted mark, that remote dependency remains `open` with
`unavailable` and an exact inspection call, not a claimed pending outcome.
A result delivered to another conversation marks nothing here. Deliveries
admitted before this contract carry no mark; result inspection creates none.
A closed item carries its final-report identity and, when available, delivery state.
Compact and untargeted status retain `openWorkCount` and `openWorkOldest`,
while compact status omits the full item list. The count covers work that still
owes a final report; the oldest age is in milliseconds and is absent when the
count is zero. The dashboard roster and selected conversation show that count
and age even when the native input has settled. In the agent work view, `w` or
a click on the selected agent's count opens [Work](#controls-and-forms): each
item with its dependencies and its retained final report.

The text of each delivered receipt, which the receiving model reads, names the
state of every request that the answer covers, one line per request (at most
16, then a count of the rest):

- `native input completed; no declared work`: the answer is the result of the
  request, and its dependency arrived;
- `native input completed; declared work remains open`: the answer is a state
  note, and the final report arrives as a separate report;
- `native input completed; declared work completed (<status>) with final
  report <id>`: the answer is a state note, and the line names the exact
  final-report read call;
- `native input failed without an answer` or `native input stopped without an
  answer`: no result arrived;
- the same words followed by `declared work completed (<status>) with final
  report <id>`: the run closed its work before it ended without an answer. The
  final report is the result of the request, and the line names the exact
  final-report read call.

The ordinary-primary headline says `completed native input`, never that the
agent finished. A grouped answer with mixed states names each request with its
own state. The producer host derives each line from its committed work facts;
the producer's prose and the hidden structured details do not decide it.
Ordinary-primary details also carry `work` (`open` or `closed`) for the first
request, and `workLabel` when its receipt has an answer.

A delivered final report starts with `Work completed with a final report
(<status>) for request <id>` and says that the report is the result of that
request, so its dependency arrived. When the body exceeds the delivery bound,
the cut text ends with `Final report continues:` and the exact final-report
read call at the cut offset. The read returns the rest of the retained
report exactly.

Enabled check-ins continue after the native input
settles while declared work stays open; their note and dependency facts do not
complete it. A host abort or context reset closes open items with `stopped` or
`reset` and retains the fixed final report for each original reply recipient.
An abort closes work for every conversation in its stopped ownership scope,
with background boundaries honoured unless `background: true`. A final report
to a recipient stopped by the same abort remains terminal and starts no run.
Closure itself stops no producer. Stopping one input group does not invoke
this declared-work closure.

Sources: `open-work.ts` (`AgentWorkParams`, `declareOpenWork`,
`continueWork`, `completeOpenWork`, `finalReport`, `OpenWorkDoc`,
`openWorkStatus`, `requestWork`, `receiptDependencyMarks`, `closeOpenWork`),
`durable-agents.ts`
(`workTool`, `exposedControl`), `durable-observation.ts`
(`readConversationStatus`), `durable-delivery.ts` (`receiptFollowText`,
`receiptStateLine`, `finalReportLead`, `reportBody`),
`durable-checkins.ts` (`CheckInTask`), and `agent-work-view.ts` (`WorkView`,
`workRows`, `dependencyWords`, `deliveryWords`).

#### State note of an ordinary session

A session that a person types into registers its own `agent_work`. It ends a
turn that needs nothing from the operator with one state note. It has no
routed request, so it takes no request, no dependency reference and no reply
route, writes no final report, and calls no host. `continue` is its only
action.

```ts
agent_work({ action: "continue", note: "Two workers review the parser; nothing needs you until their results arrive." });
```

`continue` returns `terminate: true`. Pi sends no further model request when
that call is the only call of its tool batch, so a turn that needs nothing
from the operator ends without a chat line. A queued steer or follow-up still
starts the next request. The tool needs no UI.

Print and JSON runs (`pi -p`, `pi --mode json`) answer with their last text
message, and no person reads a card there. In those modes `continue` does not
end the turn: its result asks for a text message that states the complete final
answer again. Otherwise a follow-up that arrives after the answer, such as the
completion of a background job that the run started, would end the run with an
empty answer while the real answer stays only in the session file.

The card of the call in the transcript is the only display of the note. It
shows `agent_work`, then the note with collapsed white space, wrapped on at
most three lines; an expanded card shows the complete note. The tool stores
no state, sets no widget and writes no session entry. The note is true when
the session writes it. When an event or the operator starts the next run, the
card is history in the transcript, so no surface shows a state that ended. A
later turn that needs nothing from the operator ends with a new `continue`;
no call clears a note. A client of Pi's RPC mode reads the note from the
arguments of the tool call.

The note is text for the operator: what is open and what happens next, in
plain words and one or two short sentences (at most 1,200 characters). It
describes each agent and each piece of work by what it does and carries no
session, submission or request identifier. The session does not need the
note for its own continuity: the receipts of its spawn and send calls name
the result references, and after a compaction the
[continuity note](#ordinary-sessions) lists each admitted request that has no
delivered result. The tool description and the ordinary
guidance of `agent_spawn` and `agent_send` state this rule; the tool does not
inspect the note.

Sources: `ordinary-work.ts` (`registerOrdinaryWork`), `tool-cards.ts`
(`ordinaryWorkCard`), and `control-guidance.ts` (the ordinary guidance of
`agent_spawn` and `agent_send`).

### Input placement and unplaced notices

The host submits each active native input with the `steer` busy mode; `reject`
keeps its meaning. The native host fixes `steeringMode` to `all`, so the
boundary after the recipient's current tool round places every queued active
input. A tool round ends after all its tool calls end, not after one of its
parallel calls ends. An omitted send mode is `followUp`, new work, on every
path. Prompted spawn and fork admissions also carry the new-work class.
`steer` marks a correction. The class does not delay placement until the end
of the run. The same rule covers
operator and model admissions, reports, answer copies, check-ins, timers,
active thread notices and delivery replay. A running tool call, a provider
retry and a compaction supply no placement boundary inside their work.

An active input joins the current work at that boundary. Distinct request IDs
and requester/reply routes remain distinct even when several inputs share one
final answer. An automatic result stays an automatic result, and a report
stays a report; the class describes the input, not its placement time.
A passive report or thread notice is a write, not an active input. It starts
no turn and enters context at its normal write boundary. The same-storage
background `Reporter` admits delegated work and follows its settlement; the
delivery watcher supplies the answer copy.

Admissions and report receipts distinguish `placed`, `unplaced` and `withdrawn`.
Status and cards show `unplaced`, the count still in the native inbox, and
`oldest`, the age in milliseconds of the oldest such input. The oldest age
is absent when none is unplaced. The commit that admits an input also stores
its unplaced row and starts the conversation's watch when the native inbox
holds the input; a placed input gets no row. An exact-request replay of a
queued admission restores a missing row and watch without a second input. The
row keeps the class, sender and recipient of the original admission. When a
host resumes, it gives each queued native input without a row one row, with the
class and sender of its native input entry, and starts a missing watch. Such a
row counts its wait from that resume, because the native record keeps no
admission time. An operator input entry carries no label, so its row takes the
requester of the retained request route as sender. When reconciliation links a
retained intent to an input that is already queued, the row keeps the class and
sender of that input's native label; the class derived from the intent's origin
and busy mode applies only to an unlabelled entry. These are
committed placement facts, not proof that the model read or acted on an input. Retained report delivery also
states `pending`, `parked`, `terminal` or `admitted`; only an admitted
row is eligible for placement in the recipient. A receipt never proves task
acceptance.

After an explicit input stays unplaced for five minutes, the host retains one
notice for that sender and stuck recipient, not one notice per queued input.
The host also notifies reply recipients of the stuck recipient's current
routed requests and open declared work, without a duplicate for a sender
already notified. Automatic results,
check-ins and timers produce no notice to their producer. Active thread-notice
senders receive a passive notice when all their covered inputs are thread
notices. The notice counts inputs older than the five-minute threshold
separately from newer queued inputs. Inputs stay queued; the notice withdraws or
cancels nothing. Once the queued rows leave, a later stuck input is a new case.

The notice names the current step: running tools, a blocking compaction, a
provider retry, or a model step. A reported start is `TaskRecord.startedAt`,
the first start of that task, including later waits and recovery, not the
start of the current model attempt. Missing time means unknown. The notice
is not a progress heartbeat.

Sources: `durable-controls.ts` (`placementMode`, `admitConversation`),
`durable-services.ts` (fixed `steeringMode`, task registration),
`durable-runtime.ts` (`openHost`), `unplaced-inputs.ts`
(`prepareQueuedInputs`, `recordUnplacedInput`, `UnplacedWatchTask`,
`currentStep`, `noticeDue`),
and `durable-observation.ts` (`readConversationStatus`).

Normal delivered receipts retain a short answer excerpt and include a
`Full answer` exact-entry continuation. Ordinary primary delivery details also
include the structured `continuation`. Follow it with `agent_inspect`, then use
each returned `nextOffset` until the retained answer is complete.

A result notice names at most 16 references. When the recipient's receipt group
continues, the notice text adds `Receipt references continue:` and one
exact `agent_inspect` call with `receiptCursor`; ordinary primary details carry
the same call as `receiptContinuation`. The communication value carries it in
`metadata.receiptContinuation` whenever the group is incomplete.
`omittedReferences` counts only the references cut from the supplied chunk. It
does not count references on later pages.

#### Result pages

`agent_inspect` with `view: "result"` reads one retained native result in
pages. Two continuations exist, and neither advances the other:

- `answerContinuation` continues the answer text. An answer page holds at most
  4,096 UTF-16 code units and never splits a surrogate pair. `offset` and
  `nextOffset` count UTF-16 code units. The call repeats the selector with the
  next `offset`.
- `receiptGroup.next` continues the recipient's references. `receiptGroup` is
  `{recipient, results, complete, next}` with at most 16 references for the
  recipient of the selected receipt. A page read with `receiptCursor` returns
  the result identity and the next reference page, without the answer body.

When the request of the selected input declared work, its answer is a state
note, not the result. The page then carries `work`: `state` (`open` or
`closed`), `answer: "state-note"`, the state-note `label`, and for closed work
`finalReport` with the report request ID, reply recipient, close status,
delivery state and `read` call. The page never presents the state note as the
final report. An input without an answer (`queued`, `placed` or `unanswered`)
has no state note: its `work` carries `state` and `finalReport` only, and the
page keeps the status and the reason of the input. The work facts come from the retained work item, or, after that
item left the bounded work document, from the retained final report row.

- `finalReport: true` selects the final report instead of the answer. The
  page returns `finalReport` with `text`, `length`, `offset`, `nextOffset` and
  `truncated`, in pages of the same 4,096 UTF-16 code units, and
  `finalReportContinuation` while text remains. The pages join to the
  retained report text exactly. The retained report decides this page, not
  the settlement of the input: the report of closed work is readable while
  its input is still placed and after that input ended unanswered. `status`
  stays the status of the input, and the page carries no answer. The tool
  text of the page shows the report text first, then one identity line that
  names the status of the input as `inputStatus` and the close status of the
  work as `status`. A page for open work returns `reason` and no text; a
  request without closed declared work refuses. `finalReport` refuses outside
  the result view and with `receiptCursor`.

Execute each returned call unchanged. A complete result page, including its
identity, body and receipt metadata, fits 65,536 serialised UTF-8 bytes; a
larger page is refused. `receiptCursor` contains 1 to 2,048 characters, selects
only the result view, and requires a settled input with a retained receipt.
A cursor binds the storage, the recipient, the selected submission, the answer,
and the end of the receipt list at the first read. References appended later
never enter an older cursor; a cursor for another selection or recipient is
refused. A page without a reference for the recipient still returns its `next`.
An unanswered input has one reference and no cursor. Result inspection
acknowledges no delivery, and `view: "exact"` still returns the raw redacted
entry.

One reference page reads at most two retained page documents: the current page
and, when it differs, the page that holds the captured end. It examines at most
64 membership references of the current page and returns at most 16.

The `agent_inspect` input of ordinary primaries and of Durable agents accepts
`receiptCursor` and `finalReport` and refuses them outside the result view.
Both return the result view as readable text: the identity and page facts, the
answer page, and each continuation as an exact call. A state note starts with
its label, and the text names the final report and its read call.

Sources: `durable-observation.ts` (`readResult`, `finalReportPage`,
`RESULT_PAGE_UNITS`, `RESULT_PAGE_BYTES`), `open-work.ts` (`requestWork`,
`finalReportRead`), `delivery-store.ts` (`receiptReferencePage`), and
`durable-host.ts` (`selectedReceipt`).

Normal delivery stays independent. It keeps its recipient-scoped identity and
retained receipt. A late or already-placed copy remains possible and costs an
additional model turn. There is no exactly-once contextual-delivery guarantee.

### Provider content refusals

A native submission that ends on a provider error settles as `unanswered` with
`model_error` and keeps the original provider detail. That settlement does not
change, and the retained receipt keeps its own reason and detail. The result
notice (`No answer: <reason>`, also in ordinary primary details as `reason`)
and the `agent_inspect` result view present the retained detail. Each reads the exact
selected native submission:

- `model_error: <provider text>` for wording the host does not classify;
- `content_refusal: <provider text> <recovery>` for a recognised content
  refusal.

The host removes recognised credentials before it shortens the text. The
complete reason fits 1,024 UTF-8 bytes, including the recovery sentence and the
omission markers ` [credential redacted]` and ` [truncated]`, which precede the
recovery. A reason other than `model_error`, a missing or non-text detail, and
a submission with a retained quota block keep their original reason; quota
blocks keep their separate evidence, described below.

The classifier recognises one wording, from OpenAI Codex: `This content was
flagged for possible cybersecurity risk`. Other refusal wording stays
`model_error` with its provider text. The recovery sentence is:

> The provider refused this content. Repeating the same task on this provider fails. Choose another explicit provider/model under your existing authority, or change the form of the task. No automatic substitution or host retry.

A content refusal creates no retained provider block, changes no retry or
overflow classification, and selects no model. Source:
`provider-block-facts.ts` (`modelFailureText`, `isProviderContentRefusal`),
`durable-delivery.ts` (`prepareReceiptRow`, `receiptFailureText`),
`durable-controls.ts` (`readNativeOutcome`), `durable-host.ts`
(`resultOutcome`), and `durable-observation.ts` (`readResult`).

### Exhausted provider limits

The host distinguishes explicit quota, usage, balance, and billing exhaustion
from ordinary short-lived throttling. It retains bounded provider evidence,
including redaction and truncation flags, before returning a canonical host
error to Durable. That error prevents another native retry or an incorrect
context-compaction attempt. Native submissions settle as `unanswered` with
`model_error`, not as successful answers. Existing result delivery carries the
blocked cause; no second terminal result replaces the original reference.

Owner notices and expanded status and saved-result cards show the original
receive time in ISO UTC, or state that the time is unavailable. They distinguish
a provider call from a refusal that reused a retained block and keep the evidence's
redaction and truncation markers. Collapsed saved-result cards summarise the
refusal's source, receive time and recovery action. Expanded saved-result cards
put the full readable facts before the bounded source text; the inspection's
JSON text and structured result remain unchanged.

An active provider block survives host reopen. Further requests in that
conversation return an explicit host error without a provider call. Native
queue recovery retains each input and its own terminal outcome; it does not
silently reroute work. If no permitted route is available, the block remains
with its evidence and recovery instructions.

Explicit, validated model configuration clears the matching block. Naming or
reasoning-level changes do not clear it, and failed model selection leaves it
intact. Explicit configuration of the same model permits a deliberate retry
after capacity returns. Recovery text names the retained original result's target
and shows `agent_configure({sessionId:<target>,model:<explicit provider/model>})`,
followed by a new `agent_send` follow-up after successful configuration. It selects
no model and grants no authority. If the original target is unavailable, the text
states that limit instead of constructing a target. A subsequent send creates a
new result reference; the original failed request remains inspectable with its
original identity.

Unknown provider-limit wording does not depend on the exhaustion classifier.
For each observed native generation retry burst, the host retains attempt evidence
without sending start or per-attempt reports. Failure retains one ordinary end
summary per exact model-origin reply recipient; successful recovery uses the
normal result instead. Abort and interruption send no failure summary. Ordinary
primaries receive no automatic report between the first retry and the failure
summary or normal successful result. End summaries do not replace terminal
results.

The conversation-scoped burst retains its run identity, attempt evidence and
recipient routes. Failure report identities are stable across reopen, and those
summaries remain ordinary retained reports. A successful retention commit
preserves burst state; it is not atomic with the native retry commit. A crash before first observer capture can
leave no burst to recover after the native generation finishes. Latest-only
native state and terminal tasks retain no exact retry-decision history for that
gap. The extension does not infer a retry from error text. A retry notice is not
proof of exhaustion. Provider reset strings remain uninterpreted evidence;
missing timezones are not guessed, and reset text never schedules recovery.

The timing boundary starts when the provider adapter exposes its error or
Durable commits a native retry. Provider transport settings remain unchanged.
Retries hidden inside an SDK, gateway, or provider adapter before that boundary
are not a universal whole-request deadline supplied by this extension.

Native agent tool cards use the shared display-only renderers; transcript
rendering never grants execution. Adapted status and list rows expose
`forkSource`; exact upstream records retain their native fields.

## Standing agents and expertise

`agent_spawn({handle, name, role, model?, thinkingLevel?, preset?, prompt?})` resolves or
creates one independent root in the selected store. Supply the lowercase slug
without `@` when creating it; subsequent controls use `@slug`. The storage address
includes the canonical catalog directory and handle. Separate stores with the
same handle, cwd, and agent directory therefore select separate hosts. Exclusive
atomic catalog publication prevents concurrent creators in one store from
claiming different agents. The result states `created`. Reuse
never applies creation defaults to name, role, model, or reasoning. Supplied
model, thinking, and role fields, including preset values, are reported as
unapplied. A supplied name is ignored on reuse without an unapplied-name receipt.
An explicit conflicting cwd refuses instead of changing the retained directory.

Resolve without a prompt to inspect the agent before assigning work. Reuse reads
its retained profile without starting a host. During another caller's initial
creation it returns `availability: "initializing"`, `profile: null`, and the
creation defaults, not an invented native revision. An interrupted creation
remains addressable; `agent_attach` opens its retained seed. A prompt requires
successful host admission and uses follow-up disposition for handle reuse.

The native `agent.profile` document holds the role and bounded sourced expertise.
The role permits 2,000 Unicode characters; expertise permits 16,384 UTF-8 bytes.
`agent_profile` reads the profile or updates role/expertise with `expectedRevision`
from a current read. Conflicts return the current profile without writing.
Retried successful updates keep their request identity. Profile updates work at
busy tool boundaries and start no model turn. Name/model configuration remains
an idle-only operation. Native callers default the profile target to themselves;
ordinary primary callers supply an agent target.

One native instruction builder supplies exact identity, current display name,
handle, role, creator provenance, request-routing rules, and a pointer to saved
expertise. It does not load the expertise body into every prompt. Role and name
changes refresh these instructions in the same native commit. The profile
survives compaction, reset, and host retirement. Forks start with their own
identity and an empty profile, not an inherited handle or borrowed expertise.
Saved expertise remains evidence; fresh sources and task restrictions outrank it.

## Peer threads

A thread keeps shared purpose and evidence in an existing participant's native
Durable storage. It is not another agent, a transcript substitute, or a broker.
The primary seeds its purpose, authority and source, restrictions, acceptance,
and integration owner. Peers choose their contributions, join or leave, share
findings, and challenge decisions directly. No roster, rounds, roles, votes,
or automatic replies are prescribed.

Use `agent_collaborate` with `action: "list"` and an optional literal `query` to
find purpose across storages. Global discovery reads published hints, not hosts.
It visits a bounded catalog batch and returns `nextCursor`, explicit coverage,
and omitted or unavailable source storages. Follow the cursor even after an
empty page and repeat the same query. Use `sessionId` for a storage's retained
thread list. Catalog changes follow the filename continuation rules in
[Controls](#controls). A continuation within one storage's published thread
hints refuses if that storage's thread publication changed:
`Thread discovery changed; restart the query`. There is no background relevance
search or polling loop.

Catalog thread hints rank active threads before closed threads, then newest
update first with a stable thread-ID tie break. Selection reads the existing
bounded native index before the eight-summary and 4,000-UTF-8-byte limits.
`omitted` records indexed threads without a returned summary; missing hints
mean unknown coverage.
Hints preserve the existing `items`, `omitted`, and `updatedAt` shape. They are
not full thread frames or a complete native index.

A storage-scoped retained list reads its full native index in bounded pages,
including threads omitted from catalog hints. Its decimal offset cursor is not
bound to the query or index revision. Repeat the same query for an intended
continuation. Each request captures a new private snapshot, so appended threads
and changed query matches affect later pages. List completeness refers only to
the captured index, not global discovery. Thread pages preserve exact event
sequence continuation; member and pending-notice counts describe captured
state, not live presence or delivery progress. Cold observation serves these reads
without a live host.

`create` needs `title`, `purpose`, `authority`, `source`, `restrictions`, and
`acceptance`; `integrator` defaults to the caller. An ordinary primary also
selects an existing participant with `sessionId`. Native agents default to
their own storage. `create` and `join` accept `participation`, the member's
self-chosen declaration of at most 256 characters; another join revises it.
Omission keeps the stored declaration and an empty string clears it. A join
that changes nothing appends no event and creates no notice. `join` accepts no
`message`; discussion belongs in a post. `post` accepts `message`, optional
`replyTo` event sequence, `source`, and explicit `notify` identities.

Each action accepts only its own fields. The registered parameters stay one
object with every field optional, so the declaration survives provider schema
conversion; execution then validates the selected action's closed field set.
A field of another action refuses with `<field> is not valid for action
<action>`, and an invalid value or selector combination refuses with `Invalid
fields or selector combinations for action <action>`.

`read` has two directions. Without `after`, it returns the current frame,
members, the newest events in chronological order, the pending notice count,
and `nextBefore` for older pages; follow that cursor with `before`. With
`after`, it returns the events above that sequence, oldest first; `after: 0`
starts at the first event. A forward page has `direction: "forward"`, the
thread's current `frameRevision`, `sequence` and `closed` state, `coverage`
with its `after` and `through` sequences, and `next`: the exact
`agent_collaborate` call for the following page, or `null` when the page
reaches the newest event. `knownFrameRevision` is valid only with `after`. When
it equals the current revision, the page omits the unchanged frame and member
list. `after` and `before` are exclusive. An `after` above the retained
sequence or a `knownFrameRevision` above the retained revision refuses.

Each returned event carries its epoch `at` and a derived ISO UTC `atUtc`. The
epoch stays authoritative; `atUtc` is `null` when the epoch is outside the
date conversion range. A returned `create` event has an empty `message` and
`frameOmitted: "current-frame-returned-separately"`. The retained event keeps
its original frame text. Reads do not start a host or model, and a read
acknowledges no notice. Events record their sender, origin, frame revision,
and reply reference.

A frame is an attributed statement, not authenticated authority. A
`carried-authority` post requires a source, but its label does not grant
permission. Preserve the original operator decision and restrictions; challenge
unsupported claims in a post. The creator, integrator, or operator can `revise`
the complete frame. Revisions remain in the exchange; compare an event's
revision with the current frame. The integrator is revisable, not a compulsory
role in a fixed plan. Participants can split work into another thread, leave,
or `close` with a retained conclusion. Closing ends mutations, not history.

Recovery from a full or closed thread reads its frame before creating another
thread with all required fields. Because joining grants no permission to revise,
a nonmember without that permission joins and posts a proposal instead.

Creating or joining opts into passive notices for later events. A passive
notice is an event fact without message text: the thread, event sequence,
frame revision, event kind, sender, epoch time with its derived UTC time, and
the exact `agent_collaborate` read call for the retained event. A notice for a
named `notify` recipient states that attention was requested and adds an
excerpt of at most 512 UTF-16 code units. The excerpt ends at a word boundary
where one exists, a cut excerpt ends with `[cut]`, and the same read call
returns the full event. A native write places a passive notice
at an existing conversation boundary without starting a model turn. An idle
peer learns it on later work, not immediately. If a run ends with only writes
queued, the host places those writes at an idle boundary without starting a run.
Only named `notify` recipients
receive steering and a model wake. No post or notice arms a check-in. Leaving
stops future subscription notices. Notification admission and acknowledgment
do not prove model awareness, understanding, or acceptance.

A native model request shows passive thread notices as ranges. One range covers
one thread in one interval between two assistant messages. It states the event
range, frame revisions, event kinds, coverage, times, and the exact
`agent_collaborate` read call. The stored notices do not change. A range keeps
its text in later requests while its notices remain in the request; a notice
that arrives later forms a later range. A range is a read boundary, not
evidence that each enclosed event was passive. An addressed thread event stays
an active input with its bounded body.

At one request the host reads at most the 128 newest entries and 256 KiB of the
conversation, and associates at most 128 notices. A notice outside these
bounds, a notice without typed thread data, and a notice whose message is not
unique in the request each stay as their own message. A range frozen from an
incomplete read states partial coverage. After a host restart, the host reads a
history above the read bound again from its newest entries only. A range can
then return once with other coverage text, and older notices can return as
their own messages.

An ordinary session groups its passive notices in the same way at each provider
request: the verified passive notices of one thread for this session, between
two assistant messages, form one frozen range with the exact thread read call.
Later notices form another range. Active notices and notices that do not match
stay as they are, and the retained messages do not change. A range stays while
its notices are in the context, so a compaction that removes them removes it.
The session groups at most 128 passive notices and 256 KiB of one context,
oldest first; later notices stay single messages. Source: `ordinary-entry.ts`
(`ordinaryThreadSources`, the `context` handler) and
`thread-notice-projection.ts` (`associateThreadNotices`,
`projectThreadNotices`).

Thread notice text above the delivery bound ends at a word boundary with
` [cut]` and names the exact thread read once. When the event sequence is
unknown, the text names a bounded thread read without a selected event. A
thread notice does not add the `agent_inspect` sentence of other reports.
Source: `thread-notice-request.ts` (`threadNoticeRequestHooks`),
`thread-notice-projection.ts`, and `durable-delivery.ts`
(`boundedReportText`).

The event, mutation receipt, and notice intents commit together. Retries reuse
caller-qualified mutation IDs and recipient-qualified native request IDs;
changed content under the same mutation key refuses. Direct notices never
broadcast to unrelated primaries. An unavailable recipient leaves a visible
pending intent and delivery error. Active delivery prevents retirement; a notice
for a proven-dead ordinary primary remains pending without broadcast and does
not by itself require a live source host. Source-host retirement or process loss
does not delete the thread;
cold observation stays available and a later mutation or recovery opens its owner.
This has the same process-crash, not power-loss, guarantee as other native
state. A primary process restart can repeat a displayed notice after loss of
its in-memory deduplication.

Each call bounds visits, records, and bytes. A thread frame and membership fit
within 24 KiB, each event within 20 KiB, and a read page within 48 KiB. A page
stops before an event that exceeds that bound. A page that cannot hold its
metadata and one event refuses and claims no progress. Global
hints are not an exhaustive search of retained history. Explicit coverage and
scoped continuation are part of the result, not a claim that absent matches
do not exist.

In `/agent`, Agents, Threads and Efforts are tabs at the top left. Threads is a
two-pane view like the agents: every thread on the left, the selected thread on
the right. The view follows every discovery page and every storage that reports
omitted threads on its own, within a fixed bound per refresh, so the operator
never pages through storages. Open threads
come first, newest first; closed threads fold into one muted row, `▸ Closed ·
N`, after them. Enter or a click expands that row to `▾ Closed · N` and shows
the closed threads below it; opening a closed thread directly expands the
group. Each row takes three rows like the agent list: the state glyph, the bold
title and the last activity time, with a long title continuing on the second
row; then the purpose in muted text; then a blank row when the title fits on
one. The member count sits in the thread header. `/` moves to Find, whose
letters search open and closed threads and show every match; Enter keeps the
filter and returns to the list, Escape clears it, and clearing Find restores
the earlier choice. Over the list, letters are keys, never Find text. Up/Down,
PageUp/PageDown, Home and End select; the wheel scrolls the list. The list footer
reads `N threads`, or a read warning. A discovery that stops at its page bound,
meets a repeated cursor, or cannot read a source storage marks the row
`partial`, and the thread header marks it too. With no thread selected, the
thread pane names each unread or unavailable source and the omitted threads.
`ctrl+r` reads the list again: the control stays on the row while the list is
partial or a read failed, and the More menu lists it as `Read again` at other
times. A partial read never reads as an empty list, and
a routine refresh keeps the count row it already showed.
The newest thread is selected when the view opens. Selecting a thread reads its
newest page; reading is passive and starts no model turn.

The thread pane's header holds the bold title, then one muted line with Open
or Closed, the member count and how much of the exchange is loaded (`latest N
of M events` while earlier events exist), then the purpose in muted rows, then
a blank line. A long title wraps onto a second row instead of shortening. A
purpose longer than three rows ends with `… more in Details`. A read failure
replaces the counts in the error colour. The header holds no commands: `m`
shows the members, `d` the frame, as the key footer on the screen's last row
says.

The exchange follows. Each post starts with one header row: the sender's name
in bold, then in muted text the role the frame names (`integrator`), the post
number `#N`, `↳ name #N` when the post answers another, operator origin and
the event kind, and the time at the right of the reading column. The post text
renders as Markdown (paragraphs, lists, inline code and code blocks) at the
reading width, a two-column margin and at most 100 columns; the stored message
is unchanged. A post longer than 16 rows opens as a preview of 10 rows with
`▸ N more lines`; a click opens it in place, `▴ Show less` closes it, and
Ctrl+O opens or closes every long post. Opening or closing a post keeps the
rows above it where they are, and the top visible post stays in place through a
refresh, an earlier page and a resize; a window that already shows the newest
line keeps following it. A muted `notified` line lists the members a post
woke, and one blank line separates posts. A participant's name comes from the
roster (name, else handle), `This session` for the session that runs the view,
or a Pi session name from effort presence; without one it shows as `Session`
plus the first eight characters of its identity, in senders, reply targets,
event lines and `notified`. A thread's creation, frame revisions, joins and
leaves each show as one muted line, such as `Parser review created the thread ·
7m ago`; the frame stays in Details and member contributions in Members. A
close shows its muted line, then the close message as post text.

The newest message sits at the bottom. The first row reads `↑ N earlier events
· click or Home reads them` while earlier events exist, or `Start of the
thread`; scrolling to the top, Home or a click on that row reads the page
before and keeps newer messages in place. While the window sits above the
newest line, its last row reads `↓ N lines below · End shows the latest`, and
a click returns there. A window that starts inside a post names it on its
first row (`↑ <name> · #N, continued`); a click shows that post's header. All
thread text is plain text: terminal sequences are removed.

The message field at the bottom posts to the selected thread with origin
`operator`; a post wakes nobody unless members are ticked. Click a post's header
row, or press `r` and choose the post in the reply panel, to reply to that
message; Enter in the panel marks or clears the chosen post. The field's caption
shows the reply and the number of members it wakes, and the exchange marks the
chosen post `replying`. A retained post clears the draft and its reply target. A post
that is not confirmed keeps the draft, and sending the same content again
reuses its request identity. A closed thread takes no posts. Drafts stay per
thread for the session.

`m` (members) lists the members with their declared contributions. Up/Down
choose, Space ticks a member to wake on the next post, and Enter or a click
opens that member's conversation in the Agents tab; Escape there returns to the
thread. The pane shows one member per two rows and keeps the chosen member in
view, so End and the wheel reach the last member. `d` (details) shows the frame as attributed claims: purpose, the
carried operator direction, source, restrictions, acceptance, integrator,
creator and the member declarations; the same key returns to the exchange. `r`
(reply) lists the posts newest first and marks or clears the reply target.
The key footer lists the keys of the focused part: the list, Find, the
exchange, a panel or the message field, where `enter post` and the newline keys
apply and every letter is text. Tab moves through the list, the exchange and
the message field. A window narrower than 100 columns shows one pane: the list
while it has focus, the thread whenever the exchange, a panel or the message
field has focus. Escape steps back one level: from a panel to the exchange,
from the message field to the exchange, from the exchange to the list, and from
the list to where Threads opened from. A thread opened from Related efforts
returns there directly.
Catalog notices reread the selected thread at once and the thread list at most
every ten seconds. The standalone native terminal uses the same view and
attributes operator posts to its attached conversation.

## Efforts, presence, and intent

An **effort** is a session's intent-driven work with its agents. **Presence** is
host-observed process and location information. **Intent** is a session's claim
about its purpose and next shared acts. A **shared substrate** is a resource
that efforts use, such as a repository, cwd, or the machine for a full-gate run.
These observations expose opportunities for cooperation; they do not grant
control over another effort or authority to act outside the operator's direction.

Strict descriptor observation of an ordinary endpoint record (presence reads and
parked-wake availability) reuses the same revision rule: at most 512 parsed
descriptors and 4 MiB of retained payload, keyed by the opened file's revision,
with failures never cached. Process, host and delivery-contract classification
runs on every read, so a dead owner is never reported live from a cached parse.
Delivery, registration, replacement and removal read the endpoint file
directly and do not use this cache.

Each manager and each native contribution owns one catalogue reader and one
repository-location resolver, and passes both to every effort read. The
resolver keeps up to 32 completed locations and shares one in-flight resolution
per working directory. Git remains the authority on a miss, with its existing
timeout and output bound. A completed explicit `git` or `outside-git` result is
reused only while the canonical cwd, the sanitised Git environment and `PATH`,
the nearest `.git` marker (or its absence along the ancestors, and bare
repository markers), the common-directory pointer and the markers Git requires
before it accepts a directory as a repository keep their identities. For an
ordinary `.git` directory those markers are the exact bounded `HEAD` contents
and the `objects` and `refs` directories; Git decides whether that `HEAD` is
valid. A `commondir` target keeps its own `objects` and `refs`, its canonical
resolved path, and its directory device and inode. Inputs are captured before
and after Git runs, so a result whose inputs changed during discovery, or whose
common-directory resolution was uncertain, is not retained. A new nested
repository, `git init`, a replaced worktree pointer, a changed common directory
or a changed repository marker therefore produces a fresh Git read. An `unknown` result
(for example a missing directory or a Git timeout) is shared only while in
flight and is never retained. When a trustworthy marker identity cannot be
established the caller receives a fresh uncached result. One presence pass
observes each storage's writer claim once. Awareness answers are never cached,
so peer intent changes appear on the next read.

The existing primary endpoint records publish host identity, process liveness,
canonical cwd, Git common directory, start time, and sampled last activity. Git
worktrees share their common-directory identity. Activity comes from input,
completed tool execution, and settled turns, with at most one activity write
per minute. It is not a heartbeat; an idle record's old timestamp does not prove
process death. Only the existing local PID and host checks classify liveness.
Dead records do not appear as live efforts. Unknown and incompatible ownership
remain explicit. Discovery never removes primary endpoint records.

Declared intent leads presence and awareness. When it exists, those views omit
the observed-purpose fallback rather than show a competing description. Without
intent, the fallback is the Pi session name, otherwise an excerpt of the first
proven interactive input. Its origin stays labeled `session-name` or
`interactive-input`; it is not a declaration.

The extension retains its own attributed first-input projection in the session.
Resume discovery follows a bounded parent chain from the public leaf ID, without
materializing the branch or full session. A complete scan is not proof that the
next input is the first. Prior message, compaction or branch-summary history
without a valid earlier projection leaves purpose unknown. Explicit resume,
reload and fork do not reopen capture. A projection after earlier message history
is not a valid first-input source. Incomplete ancestry also leaves it unknown.
Only a fresh session with proven input-free history captures its first interactive
input; an empty first input closes capture without inventing a description.
RPC and extension-generated input do not supply the fallback. The extension does
not interpret another extension's prompts or entry formats. A session name or
declared purpose still supplies useful context.

### Automatic session names

Agent offers only genuine interactive input to the shared session-name lifecycle,
not RPC input, extension input, model responses or purpose updates. The lifecycle
writes an immediate fallback for useful input only when no name or name entry
exists. A receipt is an internal record of the session, exact name entry and
fallback or refined state. Only the current fallback with its matching receipt
accepts one valid generator refinement. An absent or failed generator leaves the
fallback; refined names remain unchanged. Automatic naming never replaces `/name`
or RPC names, names without a receipt, repeated explicit writes or deliberate
clears. Forks keep inherited names; forks, switches and reloads cancel pending
refinement without replaying generation.

The [session name convention](../../docs/conventions/session-names.md) defines
derivation and the shared lifecycle.

`agent_intent` publishes only the invoking ordinary primary or native
conversation. It takes no target identity. Native conversations retain claims in
their own conversation metadata; a native root or child needs no ordinary primary
or terminal. Forks do not inherit their parent's claim. Older replayed tool writes
do not replace a newer publish or clear.

Publish with `action: "publish"`,
`purpose`, `integration`, `authority`, `scope: { paths, branches, fullGate? }`, and
an optional `contactThread`. Clear with `action: "clear"` alone. The tool declares
one object schema so models receive the action and publish fields directly.
Execution rejects missing publish fields and any publish fields on clear.
The host supplies the
claim's update time. Repository-relative paths use exact or component-prefix
matching, not globs. `scope.fullGate` declares a planned full-gate run; it is not
a reservation or lock. The ordinary endpoint or native catalogue view's total
byte bound still applies to a claim. Stored claims and retained prompt claims keep
their authority and scope unchanged; a claim that does not fit is omitted as a
whole rather than weakened.
Publishing returns the recorded host facts, the labeled claim, and current effort
awareness. Clearing removes the declared claim, not the observed purpose. Update
or clear intent when integration completes, before the terminal report, so a
finished plan does not remain current. A settled model turn is not proof of
integration completion, so the host does not infer that transition.

Current-source readers discover native claims from catalogue views in their own
sessions root. The owning host publishes the
view through its coalesced native commit path; a commit is not immediate peer
visibility. Native diagnostic records never prove a live lease holder. A valid
same-host clean-end marker or same-host ESRCH ends only the recorded generation;
those efforts and their declarations no longer appear. Present or reused PIDs,
EPERM, foreign hosts, malformed markers and read failures remain unknown. A new
holder can acquire before it rewrites the previous record, so this display
evidence proves no global absence and grants no recovery, deletion or release
wait authority. Unknown ownership remains unknown. Readers running the unchanged
original Agent source read only ordinary `.primaries` descriptors and never see
native claims. Updating one writer does not update another reader.

The bounded view lists live efforts on this machine within the configured
`PI_AGENT_SESSIONS_DIR`, including efforts
in other repositories. It shows
purpose-level claims for those without a shared repository or cwd, and full
intent for those with either shared location. Shared locations
and declared machine-gate use are marked. Agents judge purpose-level relevance;
the extension does not infer intent from file names or coordinate work for them.
Carried operator directions appear as quoted, scoped claims, never as permission
for the reader. Active peer-thread hints appear newest-first within the covered
store records. Declared contact-thread owners receive priority catalog reads,
followed by current and live effort identities, before the directory sample.
These reads share one visit budget; duplicate and irrelevant directory entries
still consume visits without repeating hints. An absent optional priority record
does not mark the general sample unreadable. Missing hints and unvisited records
leave global recency unknown.

Ordinary primaries read this view through untargeted `agent_status`. Inside a
Durable agent the compact untargeted read omits it. Both receive a separate
current-effort section in their model context at natural run boundaries. Prompt rows use identity order and omit activity,
start, and update timestamps. Traversal counters stay in `agent_status`, not
the system prefix. Clock and counter changes alone leave section bytes unchanged;
material purpose, scope, presence, and thread changes still update the section.
If no other live effort appears, one line points to `agent_status` for current
coverage and thread hints. Awareness is available only
through this per-run context, explicit tool reads, and the Related efforts view.
Registration, intent publication, and intent clearing do not append unsolicited
transcript entries or send automatic effort notices. Endpoint publication and
local roster refresh remain independent of transcript delivery. Direct messages,
check-ins, and thread notices retain their existing delivery behavior. There is
no presence polling, file watcher, automatic model wake, or new store. Every view
reports its presentation omissions; tool observations also report finite traversal
coverage. Ordinary descriptors, native catalogue
entries and native claim rows share the visit, result and byte caps in the tool
result. Ordinary descriptors consume visits first, so a large ordinary sample
leaves fewer visits for native roots. A cut-off scan reports partial coverage.
Native producers without intent support count separately from omitted claims;
their absence is not a lost supported claim.

Fleet and selected-session status do not read caller identity. An ordinary
overview uses it only for the optional effort-awareness section. If identity
is unavailable, that section is omitted and the agent overview remains available.

`/agent` opens Related efforts with Efforts in its heading. The list uses the
same width and three-row blocks as the Agents list. An effort's title is its
Pi session name, else the first sentence of its declared purpose, else its
observed first input in quotes, else `Untitled session in <folder>`; a long
title continues on the second row. The muted fact line says whether Pi is
open and when the session last recorded activity: `Pi open` means its process
runs on this machine with a compatible endpoint, not that it is working;
`presence unknown` and `Pi open, other version` cover the other states.
Activity is the last input, finished tool or settled turn (`last activity 5m
ago`), or `started 6h ago, no activity recorded` when the record shows none after
registration; activity is sampled, so the first minute after a start leaves no
record. Active threads follow under their own label, with the same
blocks. The list footer reads `N efforts`, when presence was read, and the
scan's stop reasons in plain words (such as `scan limit hit`) with a Details
control when coverage is partial; the row opens Scan details. A routine refresh
keeps the last count row and the selected record's detail until the new read
arrives.

The selected effort's header shows the complete title, then a muted line with
the same presence and activity facts, then a blank line; it holds no commands.
A title longer than three rows ends with `…`, and the body then shows the whole
purpose. The key footer on the screen's last row lists the effort's keys:
`enter open thread`, `m message`, `o observe`, `d details` and `t threads`,
then `x more` for the other keys (`c` scan details, `r` refresh, `i` exact
times), with `esc back` last. While the message field has focus, every letter
is text and the footer shows `enter send` and the newline keys. The default detail
is complete and scrolls: the rest of the declared purpose (its first sentence
is the title; a named session shows the whole purpose under `Purpose`), then
`Integration · next shared acts, declared <age>` with the full integration
text, then `Contact thread` with its title, state and member count. A session
without intent shows its observed first input under a label that says it is
observed, not declared, or states that it declares no purpose or integration
plan. Details shows the full record in the same grouped form: purpose,
integration, the carried operator direction, scope, status with relation,
identity, session name, substrates, directory, start and activity times, member
declarations and the full contact frame. Scan details states, in sentences, how
many entries the presence scan visited, how many efforts it lists, what it
skipped and why it stopped, and the same for active threads; efforts the scan
did not reach are not listed, and Refresh (`r`) reads presence again within the
same bounds. Its heading stays on the first row and the sentences scroll, so
PgUp/PgDn and the wheel reach every line. A contact-thread
read displays its frame and current member
contributions as declarations, not agreement or permission; a routine refresh
keeps the declaration already read until its replacement arrives. Rejoin a thread to
replace your contribution with a current hold, release or continuing condition
and cite its source exchange. A release by one member does not clear another
member's hold. A contact-thread link opens the existing Threads view.

Press `o` for one read-only observation of the selected ordinary effort. This
reads retained evidence without a model turn or message. Selection changes and
closing the view discard late responses; there is no observation polling.
The operator sends a direct quiet message to a live effort's primary from this
view. `agent_send` already supports direct model contact with that primary.
Delivery proves admission, not action, agreement, or a Durable task result. Use
one peer thread for a real overlap or agreement. Threads remain in a participant's
existing agent storage. At 100 columns or wider, the list sits beside the
selected effort's details at the shared list width.
Press `i` to toggle coarse ages and local dates. In this side-by-side view,
clicking a detail timestamp uses the same toggle. Ages stay fixed until the next
presence observation; they do not tick during inactivity.

### Ordinary retained observation

Target an ordinary primary with `agent_status` and `detail: true`, or use
`agent_inspect` with `view: "activity"` or `view: "history"`. Without
`detail: true` the status is compact: presence facts and the exact full-detail
call, without the retained ancestry. Both ordinary and Durable callers use the
same bounded reader as Related efforts. The primary publishes the public Pi
session-file path in its existing endpoint record. Reading needs no peer socket,
host launch, message admission or control. Primary delivery stays independent.

The output is tagged `ordinary-primary`. It combines sampled endpoint presence
with entries from one **latest-retained ancestry**: the newest complete retained
entry and its parent chain in the public current session format. Entry IDs,
timestamps and byte offsets identify evidence. This is not proof of the live
selected leaf or effective model context. Live idle state, tasks, timers and
unretained activity remain unknown. A recorded error is evidence, not a diagnosed
cause. Native-only branch, search, exact and result views refuse ordinary targets.

The reader checks a regular, non-symlink file and matching session header. It
bounds bytes, lines, line size, parent visits, text scanning, items and output
before processing. `PRIMARY_OBSERVATION_LIMITS` in `primary-observation.ts` owns
those bounds; its output budget covers the compact projected observation, not
the enclosing Pi tool result. Coverage reports partial writes, corruption, missing ancestry,
unknown sources and budget stops. A returned cursor pins the file identity and
metadata; changed evidence requires a fresh read. It does not splice branches or
promise access beyond its retained byte window.

Only allowed text and locator fields appear. Thinking, signatures, images,
system prompts, arbitrary details and raw tool arguments stay omitted. Recognized
credentials are omitted with safe counts; ordinary prose and non-secret identity
references remain readable. Compaction and context-edit records remain raw
locators, not a reconstruction of the model's effective context.

For quiet coordination and composed delegated results, see
[agent delivery](../../docs/agent-delivery.md#coordinate-with-related-efforts).

The ordinary manager interface changes independently of the primary delivery
interface. A retained manager with a different interface requires a Pi restart.
Effort awareness is a tool-only status addition; native host observation response
contracts and the primary channel's delivery contract remain unchanged.

## Capabilities and project resources

The host calls public `createAgentSessionServices()` at the selected cwd with
its own EventBus. This preserves settings, configured package routing, resource
loading, project trust, and configured provider registrations. `ModelRuntime`
supplies Durable's public model interface directly.

Each native runner explicitly selects its sibling `extensions/agent/index.ts`
before configured extension factories run. Only configured local package or
extension references to an `extensions/agent/index.ts` entrypoint redirect to that
selected source. Other configured packages, extensions, skills and prompts keep
their settings and SDK project-trust scopes. The selected-source settings adapter
keeps SDK changes in the current process without rewriting global or project
settings files. Settings load errors retain their global or project scope and
source path in reports and returned SDK errors. Untrusted project settings stay
deferred until Pi grants project trust.

`extensions/agent/index.ts` is a thin asynchronous dispatcher. Before
`createDurableServices()` invokes Pi's resource loader, it registers a
synchronous `durable:agent-entry` handler on the service `EventBus`
(`entry-binding.ts`) and removes that handler after resource loading, including
on failure. The handler accepts only the canonical Agent entrypoint selected for
that host, supplies the native registration factory (`native-entry.ts`) for that
exact path, and explicitly rejects any other Agent entrypoint. Native host
reload goes through `DurableServices.reloadResources()`, which installs the
same handler around the resource loader's reload, keeps the loader's factory
cache refresh, removes the handler when the reload settles or fails, and fails
the reload when an unselected Agent entrypoint appears. Reload therefore never
evaluates the ordinary registration graph. The native
factory publishes settings and the Agent contribution with the original
`extensions/agent/index.ts` `source` path, without loading or constructing
ordinary managers, tool cards, commands, or `SelfCompaction`. When no
entry-binding handler is present in an ordinary launcher, `index.ts` awaits a
memoised import of `ordinary-entry.ts`. Ordinary registration synchronously
emits a lightweight contribution descriptor whose `source` remains
`extensions/agent/index.ts` and whose asynchronous `create()` loads
`durable-agents.ts` only if a host installs the contribution. Ordinary
registration keeps pure schemas, result formatters, check-in/timer validators,
and collaboration contracts in lightweight modules (`control-result.ts`,
`provider-block-facts.ts`, `result-schema.ts`, `native-identity.ts`,
`check-in-options.ts`, `timer-input.ts`, `profile-schema.ts`,
`collaboration-contract.ts`), defers cold-observation snapshot runtime
(`cold-observation.ts`), independent-launch default resolution
(`independent-launch.ts`), and native result/identity helpers until use, and
loads profile and dashboard dialog presentation (`profile-dialog.ts`,
`dashboard.ts`, `dashboard-state.ts`, `agent-git.ts`) at command time rather
than at registration.

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

Each conversation has its own persisted provider session ID, separate from the
storage identity. Durable supplies this UUID on model requests. It stays stable
across turns, tool rounds, host restarts, reset, compaction, and model changes.
A fork or newly created agent receives a fresh ID, so its first request does not
reuse its source conversation's provider session key. Providers such as OpenAI Codex derive prompt-cache
keys and session headers from this ID; cache reuse remains provider-dependent.

Requests also carry the configured transport and thinking level as `reasoning`,
with `reasoning` absent when the level is `off`. Pi AI resolves the model's
`samplingParamsByThinkingLevel` overrides for `openai-completions`,
`openai-responses`, and `azure-openai-responses` requests.

Provider request options match ordinary Pi sessions: `retry.provider.timeoutMs`
falls back to `httpIdleTimeoutMs`; `retry.provider.maxRetries` and
`retry.provider.maxRetryDelayMs` pass through unchanged. An idle timeout of zero
uses Pi's effectively unlimited value. Generation retries remain a separate
native policy and still use the operator's retry settings.

In Pi AI 1.0.2, the Codex idle timeout covers WebSocket reads
(`dist/api/openai-codex-responses.js:1087–1103,1205`). SSE responses are limited
only at headers (`:264–282`); SSE body reads use only the abort signal
(`:479,596–598`). An SSE body stall has no inactivity timeout from these options.
The shared stream path forwards events without an additional timeout
(`pi-ai/dist/api/lazy.js:24–29`).

The host supplies:

- Native `write`, `edit`, and `bash`, with unsafe replay classifications.
- A native `read` around Pi's public stateless reader, including image blocks.
- Prompt sections for the coding task, context files, skills, appended system
  prompts, cwd, date, and capability limits.
- Agent controls as a native contribution. Background ownership and reports use
  native tasks, documents, and submission request IDs.
- Codemode and tool search through Durable's public `createCodemodeExtension()`
  and `createToolSearchExtension()` factories, with public `CodemodeSandbox` and
  `McpClient`. Nested calls are native Durable tasks with validation, hooks,
  output limits, replay policy, and retained results. Codemode journals delivered
  results and replays deterministically after a restart. A changed sandbox
  fingerprint or module version, divergence, or an expired deadline refuses
  replay; each nested tool retains its own replay policy.

Native tools return model-facing `output` and declare `structuredOutputSchema`
for their `structuredOutput` values. Ordinary tools retain Pi's
`content`/`outputSchema`/`structuredContent` contract. These are separate host
contracts, not aliases stored in `details`. A schema tool's explicitly supplied
structured error value still resolves in a script; a failed call without such
a value rejects with diagnostic text. Native `bash` returns its structured
output and exit code on a nonzero exit. The native read adapter maps Pi's public
schema and result into the native contract while preserving truncation details.
Text reads resolve to strings; image reads resolve to an image block with its
note. Use `image(await tools.read({ path }))` in a script. Direct image reads
retain image blocks; missing-file errors still reject.

Script discovery uses `ALL_TOOLS`, `await searchTools(...)`,
`await describeTool(...)`, and `await describeNamespace(...)`. Multiple
non-console text items, including a returned value, start with
`==> text N/M <==`. Console lines follow other output in one
`<console_output>` block. Adjacent text joins on separate lines without moving
text across images, and full-text spill files retain that format. Native codemode
saves displayed images and adds their file paths to its output. Native namespace
discovery uses names and prefixes; Durable's public namespace contract has no
alias field. Tool selection and MCP server configuration follow the current Pi
settings.

Durable hosts start servers with `direct` tool exposure at host startup because
those tool schemas belong in the first model request. The startup wait is bounded;
a direct server that misses that wait adds its tools when it connects later.
Servers with only
`codemode` or `deferred` exposure start on first use, not on host creation or
recovery. A script naming `mcp__<server>` starts only that server; script
discovery helpers, `ALL_TOOLS`, `tool_search`, and resource tools start all
configured servers. Resource tool declarations do not depend on connection
progress. Indirect tool discovery alone does not change model declarations;
`tool_search` explicitly loads selected tools. Choose exposure per server in
`mcp.json`; any direct tool override keeps that server's startup eager.
Ordinary primaries retain Pi's own eager MCP startup.

MCP configuration is read at host startup or native host reload. In a trusted
project, an entry in `.pi/mcp.json` without `command`, `url`, or `type` overrides
only `enabled`, `exposure`, and `toolExposure` of the same-named user server.
The override keeps the user server's transport, environment, headers, and
provider authentication. A `toolExposure` map replaces the user map; it does
not merge individual entries. An empty override keeps the user configuration.
A project entry with a transport replaces the user entry instead. Project
entries never introduce provider authentication. Invalid overrides are reported
and leave the user entry unchanged; untrusted projects contribute no overrides.

A primary `/reload` does not reconfigure retained agent hosts. Use the idle
agent host's native reload after an MCP configuration change. OAuth sign-in,
including Client ID Metadata Documents (`oauth.clientRegistration: "cimd"`),
remains on Pi's interactive or shell MCP controls. Native agents refresh stored
grants through public MCP OAuth facilities, including document-based grants
with tokens and discovery but no stored client registration. The native owner
honours `clientRegistration` (`auto`, `cimd`, `dcr`), explicit client credentials,
client name, callback URL/port, scope, and the authorization-server metadata URL.
Required sign-in returns guidance for `pi mcp login` or `/mcp` rather than opening
an interactive sign-in prompt.

`mcp-auth.ts` owns native credential updates in `<agentDir>/mcp-auth.json`.
The key combines the server namespace and canonical URL. Native reads accept
Pi's URL-only entry without taking it over; ordinary Pi owns that takeover.
A short `proper-lockfile` lock on `mcp-auth.json` protects file reads and
conditional writes, never network I/O. The package creates `mcp-auth.json.lock`
and uses ordinary Pi's 10-second stale threshold. Acquisition retries at
100-millisecond intervals, up to 250 retries, then fails without an unlocked
callback.

Automatic refresh shares ordinary Pi's cross-process `proper-lockfile` lock.
Its target is `mcp-auth-refresh-<hash>` in the agent directory, where the hash
is the first 16 hex digits of SHA-256 over the server key. It uses a 20-second
stale threshold and the same bounded retries. Healthy lock ownership serialises
native and ordinary refresh exchanges for the same server key. The owner
rereads credentials after acquisition and reuses a committed replacement instead
of exchanging the old grant again. Lock compromise invalidates the owner's lease
and emits a warning. An owner whose reported loss precedes its token request
sends no token request and saves no staged sign-in state. The owner checks its
lease and closure after reread and immediately before token dispatch, not merely
on entry to the OAuth flow. An admitted rotation still reaches conditional
persistence under the separate file lock, even after reported loss or close.
Undetected loss is not excluded: proper-lockfile detects loss on its heartbeat,
which defaults to half the stale period (10 seconds for the refresh lock).
`RefreshLock.withRefreshLock(key, fn)` owns the exchange and persistence lifetime;
`CredentialFileLock.withFileLock(path, fn)` owns short file mutations.
After the remote exchange, a conditional save compares the server's starting
state with its current state under the file lock. A newer committed grant with
different tokens wins and is used instead of the native result. A committed
logout stays absent and requires sign-in. Other concurrent state changes fail
without a write. Ordinary sign-in and logout do not share the refresh transaction.
A later ordinary save of an older whole-file snapshot can still overwrite newer
state; native conditional persistence does not make those operations transactional.

Each OAuth network request has a 15-second deadline. An initiating request's
abort does not cancel an admitted refresh. Native close awaits in-flight refresh
persistence, independently of its transport shutdown deadline. A refresh still
waiting for ownership, the credential reread or OAuth discovery does not send
a token request after close.

## Runtime and identity

- A root agent's immutable external ID is its storage ID. Another conversation in that storage has
  the ID `<storageId>:<conversationId>`. An optional creation-time `@handle`
  addresses a standing concern separately from its mutable, nonunique display name.
  Controls accept canonical identities or `@handle`, never a bare display name.
- A native fork stays in its source storage. An agent created at the same cwd is
  a conversation owned by a background task in that storage. An agent created at
  a different cwd gets new storage and its own cwd-bound services and host.
  Native documents retain the creating owner as provenance. Each task's results
  return to its own reply recipient as deduplicated follow-ups. A separate root
  gets new storage; a handle always selects an independent root, even at the same cwd.
- Each host start uses the caller's running Pi installation, not the installation
  path retained when the catalog record was created. A primary supplies its
  running package directory; a Durable host supplies its own for foreign controls,
  delivery, and recovery. Existing records stay readable without rewriting their
  creation metadata. Repeating a spawn request after an installation change reuses
  the retained record when its other configuration fields match. A live host from
  another installation remains attachable under its advertised operation contracts;
  attachment does not restart it.
- The host process binds the extension's imports of the repository's peer
  packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`,
  `@earendil-works/pi-ai`, and `@earendil-works/pi-tui`, with their
  subpaths) to that caller installation before it loads any host module. A host
  therefore runs the same Pi packages as its caller, and the checkout's own
  `node_modules` does not need to contain them. Checkout-owned dependencies such as
  Pi Durable and pi-schema keep their ordinary resolution. A host whose installation cannot
  supply a peer package exits before it takes the writer claim.
- Each storage has one descriptor-held writer lease on a permanent inode. The
  runner takes one nonblocking Darwin lock before it opens SQLite or resumes the
  Durable scheduler. A busy lease prevents a second runtime from opening. Normal
  release closes the runtime, removes the owned socket and verifies that the
  claim pathname still names the held inode. It then writes the holder's complete
  diagnostic record with canonical `endedAt` through the held descriptor at byte
  offset zero and closes the descriptor. It never removes or replaces the inode.
  The end time must not precede `createdAt`, and the writer token must be a
  nonempty bounded identity. A runtime-close, named-path validation or end-record
  write failure leaves the descriptor held until actual process exit. The
  dedicated runner reports the shutdown failure and exits with status 1.
  Removing or replacing the permanent pathname breaks the same-inode premise:
  the old descriptor does not exclude a new inode at that pathname. A new
  holder rewrites the record without `endedAt`. The bounded JSON record is
  diagnostic metadata, not ownership or current process-liveness evidence. Its
  PID, hostname, age and continued existence grant no takeover. An unopened
  catalogue record remains retained for every present claim, including dead
  evidence for a previous generation; only absence reaches guarded cleanup.
  This contract supports cooperating processes on a private local macOS
  filesystem, not shared/network filesystems or uncooperative writers. The
  adapter rejects unsafe files and other platforms. A rejected runtime factory
  retains exclusion until the dedicated process exits because partial
  construction has no close handle. Validation failures before acquisition
  create no lease file.
  A host that relies on claim-file existence instead of this kernel lease is
  not excluded by the lease. Mixed operation is unsupported. Before a launcher
  with this lease protocol starts a host, every host and every Pi launcher
  that uses the claim-file protocol must stop. An unreachable socket does not
  establish that those processes stopped.
- The primary talks to the host through the package-level Chord transport at
  `transport/index.ts`, shared with other host clients. Its typed Endpoint
  contract is `pi.agent.endpoint/1`, separate from the manager and primary
  delivery contracts. A private 0700 directory, an owner-only 0600 socket, and
  the exact `serverId` handshake provide local admission. The hello and change
  feed carry a `writerId` for that host; observation feeds also carry their
  tokens. These identities are protocol data, not authentication credentials.
  Closing a client or canceling an observation does not cancel admitted work.
  Both connect and listen paths default to a 16 MiB encoded-frame limit and a
  64 MiB queue limit, with caller-configurable `maxFrameBytes` and `maxQueueBytes`.
- The primary registers one channel over the same public transport. That channel
  returns peer messages and answers the host's project-trust prompts.
- Host retirement ignores passive clients and footer change subscriptions.
  `PI_AGENT_IDLE_MINUTES` controls the idle interval; zero disables retirement.
  Retirement requires no native live task or unsettled submission, no active
  delivery or in-flight delivery effect, no active request or host-local control,
  and no open conversation or task observation. Parked and terminal delivery
  rows remain in storage without a recovery marker; those rows alone do not
  require a live host or recovery link. Native check-in and timer tasks keep the host alive while
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
  the manager does not retry unprotected mutations after transport loss. Requests
  with a declared replay-safe contract reuse their retained deduplication key. Final catalog
  publication and the final recovery-marker check precede writer release. A failed final publication
  or marker write rejects shutdown and retains the writer claim until process
  death, rather than announce a clean retirement. Busy shutdown retains the recovery marker,
  attempts final catalog publication, seals native admission, and exits through
  the runner. It keeps the descriptor until process death; a later acquiring
  control takes the released lease and resumes retained native work. Concurrent
  close paths share one shutdown. A terminal runtime-close or writer-end failure
  rejects the close invocation before transport cleanup joins it, so the owner
  receives the failure without a circular wait. The writer lease remains held;
  a failed close never announces writer release or replaces its generation.
  If reload fails after runtime teardown starts,
  the host returns the reload error and takes the same process shutdown path. It
  retains the recovery marker and writer lease until process death.
- The runtime's `requestRelease()` returns `{ retiring, blockers }` without a
  model turn. Native work in any conversation, a waiting timer or check-in task,
  an active delivery recipient, or another active request blocks release. Open
  observation tokens do not block it. An accepted release waits for requester
  disconnect or a 100 ms response grace, whichever comes first, then checks the
  normal retirement seal without the idle interval. Only a successful seal
  closes observations. A new admitting control, pending native work or an active
  delivery row cancels the release and restores normal idle retirement.
  A delivery scan, a read-only request or a generation-only race keeps the
  release pending; the next activity or quiescent event retries it without the
  normal idle interval.
  The transport exposes no per-response flush signal; the grace bounds the wait
  for a client that stays connected. Release never deletes delivery rows or
  cancels timers. The manager attaches for release without launching a host.
  An unavailable endpoint preserves the attachment error. Permanent metadata
  and an ended previous generation do not prove that no replacement holds the
  lease; clients do not probe it. Release does not return a not-running result
  from that evidence. Unrelated `live: false` results for cold reads retain
  their read-only meaning.
- Reload requires an idle storage and no live observation tokens. The runtime
  refuses reload before teardown while any observer remains, including native
  local command dispatch. Release the observers before reload; an attempted
  reload does not destroy an existing observation.
- Local protocol validation rejects only the malformed request and leaves its
  healthy connection usable. A failed runtime-contract attachment disposes its
  client. Application or protocol errors from a live writer do not authorize a
  replacement process. If the replacement transport closes before recovery
  finishes, the connection closes locally with an unavailable error, settles
  all pending calls, and notifies its close listeners once. This does not add
  a replay attempt or grant permission to replace another writer.

`durable-runner.ts` starts the process, `installation-binding.ts` binds its Pi
package imports, `durable-runtime.ts` assembles its
capabilities, and `durable-host.ts` uses public Durable operations. Pi Durable
owns generation, task checkpoints, submissions, replay decisions, native
entries, documents, compaction, and outcomes. The extension owns process
exclusivity, discovery, controls, delivery, and presentation. It does not run an
ordinary `AgentSession` behind a Durable transcript.

The package declares Pi Durable, Codemode, MCP, Chord, and pi-schema as runtime dependencies.
Core coding-agent services come from the primary's selected public Pi package
entrypoint. The host requires Pi and Durable 1.5: it observes stored commits
with `observeCommits()`, reads the task graph and conversation windows through
watches and synchronous observers, and validates stored and protocol JSON with
`@earendil-works/pi-schema`. Ordinary and native tool parameter and output schemas
use the same package. Every model-facing tool parameter schema declares an explicit
JSON Schema `type`, and each parameters root declares `type: "object"`; a bare
`enum`, `const` union, or `anyOf` is not sufficient for strict-schema providers.
Ordinary `execute` arguments use its `Static` type explicitly; renderers use
`unknown` with guards for raw or partial arguments.
Work that host crashes cut off at Durable's restart limit ends with a terminal
outcome (`runFailure`, `compactionFailure`, or a tool error result); the host
does not park or retry it. A model request in flight when a host died counts as
a failed attempt under the retry settings. Opaque native
operations still require the exact loaded Durable version. Agent documents declare their checkpoint policies explicitly: ordinary mutations
remain deltas unless that document declares a base checkpoint. No private
upstream implementation is imported or copied.

A Durable 1.4 SQLite open upgrades schema 1 to schema 2 before the Harness opens.
Old binaries do not reopen that schema. Keep retained old consumers on intact
old source and dependencies until their owner-agreed transition; a source update
alone does not replace their loaded classes or authorize a store migration.

Native Codemode admits two workers per process by default, with a 256 MiB
QuickJS heap limit per worker. `PI_CODEMODE_MAX_WORKERS` selects another positive
integer limit; missing, zero, negative, fractional and non-finite values use the
default. The queue reads the value at each admission. A lower limit does not
cancel existing workers; later calls wait for capacity. The setting affects
native hosts in that process, independently of the ordinary host's queue.
Its FIFO queue retains at most 64 waiting calls. A full
queue refuses the next call explicitly without displacing existing waiters.
Each native tool task persists a wait deadline on the Harness clock. An
unfinished wait expires after 60 seconds, including interruption; an admitted
script gets a fresh wait budget if replay needs another worker. The admission
wait is separate from the execution budget and ends at the earlier of the two.
Stable diagnostic codes `CODEMODE_QUEUE_FULL`, `CODEMODE_ADMISSION_TIMEOUT` and
`CODEMODE_CANCELLED` mark a full queue, an expired wait and a cancelled wait.

Every native script has a finite execution budget. The registration's
`prepareArguments` adds `timeout_ms: 300000` to the options line when the script
names none, keeping `max_output_tokens`, or prepends one options line; an
explicit valid `timeout_ms` stays as written and invalid or misplaced directives
stay errors. Preparation is idempotent. The tool retains an absolute deadline
once (`api.memo` on the Harness clock). MCP server discovery before worker
construction spends this same budget through a cancellable waiter that clears
its timer and listener when it settles; cancelling it never closes a shared MCP
connection. The tool rewrites the options line with the remaining budget before
Pi's codemode implementation runs, but that implementation prepares its agent
before it persists its own deadline, so the native deadline can be later than the
original one. The original absolute deadline therefore caps the running script
independently, across preparation and every replay. An expired budget or a
cancelled discovery wait refuses execution only when Pi requests a sandbox start;
a result Pi already retained is returned unchanged, even after the deadline. There is no
reader for calls admitted without a deadline before this behaviour: drain
active codemode work before replacing a release.

The queue converts the remaining Harness-clock duration to a live wall-clock
timer. It rechecks the native script budget after admission and immediately
before worker creation, including after asynchronous wasm loading. The worker
timeout uses the smallest of the Harness-clock native remainder, the wall-clock
remainder and the remainder of the original absolute deadline. Replay retains
both the native script deadline and the original deadline. The admission
diagnostic message carries the active, waiting and limit counts of the queue.
Cancellation and host close remove waiting
calls. The synchronous public `acquireWorker` callback fences a late launch after
cancellation or asynchronous wasm load. Capacity remains charged until actual
worker exit or construction failure, not result settlement. Close requests worker termination without waiting
for a non-interruptible operation to exit. The queue covers native hosts in one
process, not ordinary coding-agent workers or other processes.

Native MCP configuration accepts one leading UTF-8 byte-order mark in global
and trusted project files. The host does not read untrusted project files.

On macOS, a guardian sends SIGKILL to the process groups of stdio MCP
servers still open when the host dies. Other operating systems are outside the
supported scope. It does not cover a host SIGKILL between
the server spawn system call and the registration write. It also does not cover
descendants that outlive a normal transport close: Pi MCP stops escalation when
the direct child closes, and its public API exposes only the numeric group ID.
Guardian startup failures appear in host diagnostics.

## Context continuity

Native conversations of a Durable host and ordinary sessions each keep a
continuity note and a planning-budget notice. The first four subsections
describe the native behaviour. The last subsection describes ordinary sessions
and names the differences. Context-use reports to a recipient and task-scoped
host reports are native only.

### Continuity note

After a compaction or a reset, each model request of a native conversation
carries one note from the Agent extension directly after the head message.
After a reset without a handoff, the note follows the host's first system
message. The first line names the context head entry and states that the note
is not operator input and grants no authority. The note has no time. The host
fixes its sent-request section when the head is placed; later requests keep
that section unchanged, also after a host restart.

The sent-request section lists requests that this conversation sent and whose
answer routes to this conversation:

- admitted requests with no delivered result here, with session, submission
  and request ID;
- requests whose admission is unconfirmed;
- scheduled inputs, with their timer.

Each list has at most 32 rows and states how many more it does not list. One
line counts the requests whose answer routes to another identity. This section
does not cover messages to an ordinary primary or requests that another session
routed here, and it does not state that a target is alive. No status view lists
a session's outgoing requests; this note is the record.

The host records a request before its dispatch and again when the target's
receipt arrives. A dispatch error keeps the request under "Admission
unconfirmed", because the error does not show that the target admitted nothing.
A local admission that fails before a submission exists closes its request. A
prompt for an agent that the same call creates in another storage is recorded
only after the creation. A result delivery carries each settled result
reference; the receiving host checks the references before it admits the body
and marks each matching request as delivered, also for a replayed body. A
request whose answer routes to another identity never closes in the sender's
record.

A scheduled input stays in the note until its result is delivered or its timer
is cancelled before it fires. A cancellation closes the request only when the
host's receipt has the status `cancelled` and names the conversation that the
host resolved. The record closes the scheduled request with that exact identity
and timer ID. A receipt without an identity closes nothing, and a receipt with
the status `fired` closes nothing, so the request stays listed until its result
arrives.

The host loads the retained facts before it schedules work. A host with
malformed retained facts does not open and sends no provider request. If the
stored head message does not match the request, the host adds no note and
reports one diagnostic for that head.

The native note ends with this session's declared open work. Each row names
the request that owes a final report, its reply recipient and its exact
result dependencies. This list has at most 32 rows and states how many more
it omits. It carries neither the item's note nor current dependency states;
it names this session's exact `agent_status` call with `detail:true` for those.
An open item whose declaring input ended unanswered is omitted, as in status.
The ordinary continuity note has no declared-work section.

The host reads and retains that work in one commit at the first request after
each context head, not when the head is placed. This timing includes the host's
closure of declared work at a reset; a request after a completed host reset
lists none. Later requests of the head use the same retained rows, also after
a host restart. Later declarations and completions affect the note at the
next head.
A pre-existing head without a retained work snapshot gets one at its first
request after the host loads; no new compaction or reset is required.

If the read fails, the note states that open work was not read and names the
same detailed status call. That process does not retry the read for that head.
The first request waits for this one commit; later requests read memory only.
An arrived result closes no item. Explicit completion or host abort/reset
closes it with a final report.

Source: `continuity-facts.ts` (`continuityText`, `continuityWorkText`,
`nativeContinuityText`), `continuity-mirror.ts` (`ContinuityMirror.prepare`),
`continuity-request.ts` (`continuityRequestHooks`), `continuity-admission.ts`,
and `continuity-native.ts` (`freezeContinuityWork`).

### Compaction and reset guidance

Native compaction gives the summariser one fixed text first, then the caller's
instructions unchanged. This applies to compaction of another conversation and
to self-compaction. The fixed text names the current purpose, consequential
operator corrections and their effect, qualified evidence, and unresolved
questions. It states that results of requests routed to the session continue to
arrive there, and that the continuity note after the summary lists the sent
requests without a delivered result. The `agent_compact` description carries
the same text. The `agent_reset` guidance states the content of a handoff,
including the newest handover or checkpoint identifier. Source:
`control-guidance.ts` (`NATIVE_COMPACTION_SEED`) and `durable-controls.ts`.

### Context-use reports

A native child sends one report for each run when a completed response uses 90%
or more of the model window. The threshold belongs to this report. It is not
enforcement and not a Stash setting. The report does not stop or change the
child and carries no answer text.

- The report goes to each reply recipient of a model-origin request in that
  run. A run that only operator-origin requests started sends none.
- The report is an active report with an exact producer association. It enters
  the recipient's context at the next tool-round boundary.
- One run has one report for each recipient, across tool rounds and a host
  reopen. The first input of a run identifies the run.
- Usage first seen in the final answer of a run sends no report; the context
  lines of that result state it.
- When a planning budget exists for the child's exact model and is below the
  model window, the recipient gets one active report when usage crosses the
  budget inside one run. A run that starts above the budget sends none. The
  budget is a planning preference, not a limit.

Each result delivered to a Durable recipient states the child's newest context
use and model window when known, and the last compaction failure when one is
retained. An unknown window is stated as unavailable. For an unanswered result
or an empty answer, the result adds one fixed paragraph with the remedies
`agent_inspect`, `agent_compact` and `agent_reset`. Notices to ordinary
primaries do not carry these lines.

A native conversation gets one retained notice of kind `agent.planning-budget`
in its own conversation when its usage crosses its own planning budget, once
for each context episode. A compaction or reset starts a new episode. The notice
starts no model turn. Unknown usage gives no crossing, and a model without a
configured budget gets no notice.

Limits:

- A report is lost when the host stops between the response and the report. The
  context lines still arrive with the result.
- A failed report write stops this observer until the host opens again and
  appears as the host's `deliveryError`.
- The host finds an earlier usage sample at most 64 entries back; an older one
  is unknown and gives no crossing.
- A recipient whose input joins a run after the budget crossing gets no budget
  report.
- The own-budget notice is not written on an idle conversation that holds
  queued inputs. Its once-per-episode record is in process memory, so a second
  crossing in the same episode after a host reopen writes a second notice.

Source: `capacity-reports.ts` (`ChildCapacityReports`, `childContinuityFact`,
`continuityLines`) and `durable-delivery.ts`.

### Task-scoped host reports

When an extension hook, prompt section or tool output fails inside a task, the
host keeps the failure as a transcript entry of kind `agent.host-report` with
data format `agent.task-extension-error/1` in that task's conversation. The
entry has no model message: the model does not see it, and it does not change
the conversation's dashboard state. History, branch and exact views show it.

Only reports that name a task are kept. The entry data fits 4,096 bytes and the
message 2,048 bytes. At most 32 reports wait for storage at one time; later
ones are dropped. A close waits at most 250 ms for pending writes. One rejected
write stops retention until the host opens again. The report is not delivered
to an owner. Source: `task-hook-reports.ts` (`TaskHookReports`).

### Ordinary sessions

An ordinary session records each answer-bearing request that it sends as
session entries of kind `agent.admitted-request`: `requested` before the host
call, `admitted` with the submission ID, and `refused` only when the host
answers `invalid`. Each other failure leaves the request listed as unconfirmed.
Reports, messages to an ordinary primary, scheduled sends and rewinds are not
recorded. A scheduled send is therefore absent from the note, and the note says
`Scheduled inputs: none` also when one exists.

A result notice that the session file retains closes each request that its
`deliveredResults` references name, when the submission agrees. A notice
without that field closes nothing, and its request stays listed in later notes.

After a compaction, each provider request carries one note from the Agent
extension directly after the compaction summary. The note has the same text
form as the native note. It is fixed for its compaction entry, names the entry
ID, and has no time. Another `context` handler can change its absolute position
only. If a retained fact is invalid or the summary does not match the request,
the session adds no note, and the cause appears as a failure row in the
untargeted `agent_status` overview. A fact that the session could not save also
appears there, because the next note can omit or misstate that request. No note
exists before the first compaction.

A turn whose context use crosses the `contextBudgetTokens` preference for the
exact model, after a lower sample in the same context episode, retains one
`agent.planning-budget` notice as a displayed custom message. A compaction
starts a new episode. Unknown usage and a first sample above the budget give no
notice. The notice enforces nothing and changes no Stash gate.

Source: `ordinary-continuity.ts` (`recordAdmission`, `OrdinaryContinuity`),
`ordinary-entry.ts` (the `context` and `turn_end` handlers), `manager.ts`
(`admission`, `continuityNoteFailure`), and `continuity-facts.ts`
(`ordinaryContinuityText`).

## Storage status pages

An unselected native host status returns a bounded page and `coverage` with
`complete`, `returned`, `scanned` and `next`. These are page-local observations,
not a frozen membership snapshot or an invented total. A record with no status
still counts as scanned. Its scan continuation remains available even when no
status rows return.

Use `agent_status` with `view: "storage-page"`, the exact bare `storageId`, an
optional backend-owned JSON-record `cursor`, and `limit` from 1 to 50. The default
limit is 50. If `coverage.next` is non-null, call its named `agent_status` tool
with the remaining fields unchanged. The cursor continues the same unfiltered
native scan; callers do not interpret its fields. A conversation-qualified
identity, a string cursor, or mixed fleet/session selectors is invalid here.

A storage page returns compact rows with the backend coverage and `next`
unchanged, for ordinary and Durable callers. When the compact form of a page exceeds the
output byte limit, the tool reads again from the same cursor with half the
limit, rounded up, until the page fits or the limit is one row. A smaller page
returns fewer rows and its own backend `next`; no identity is cut and no
continuation is invented. A refusal at one row, a refusal for an unavailable
source identity or coverage, and a host error return unchanged. Source:
`durable-agents.ts` (`readStoragePage`), `ordinary-entry.ts` with
`storage-page-fit.ts` (`fitStorageStatusPage`), and `status-overview.ts`
(`projectStorageStatus`).

`agent_list` remains global discovery with its own string cursor. Its cursor is
not interchangeable with storage-status continuation. Selected-conversation
status and the ordinary manager overview keep their separate coverage meanings.

## Recovery and delivery

An acquiring control first attempts one verified endpoint attachment. If no
endpoint answers, it starts one runner contender; only the runner takes the
writer lease. A peer's contract refusal does not start another host.
A busy contender opens no runtime and reports a typed busy outcome. The caller
then attempts one attachment to the expected endpoint. A failed endpoint remains
unavailable; no poll, PID check or record age authorises replacement.

An owned launch has one monotonic budget across readiness, connection and
contract negotiation. Parse failure, wrong socket, timeout or caller cancellation
ends only that observation. The child remains independent, its pipes stay
drained, and its uncertain launch record remains until an actual exit. An
explicit attachment can verify its endpoint later. Concurrent callers reuse the
same attempt rather than start another uncertain writer.

A connection retains its initial acquire or attach-only policy. A safe read does
not grant launch authority. Recovery first attempts attachment; an automatic
replacement also requires retryable work and an exact owned failed-child exit.
A clean child exit or successful owner close does not trigger a replacement.
When a runner reports BUSY and no endpoint is verified, registration retains an
unavailable note without adding a recovery fault or clearing a genuine earlier
error. This proves neither a live owner nor that another startup will succeed.
Foreign transport loss without an exit source remains unavailable and names
`agent_attach` for an explicit endpoint check. A qualified clean-end marker for
that exact negotiated writer identifies expected retirement, not a recovery
fault. It never authorises automatic replacement. A marker for another writer
does not clear the current loss refusal. An uncertain launch without READY or
exit remains unavailable: explicit attachment does not bypass that launch, and
no failed endpoint check justifies a duplicate launch or PID kill. An actual
exit or an owner-close acknowledgement tied to the same validated launch
permits explicit reacquisition. Client close is final, including during
recovery or subscription setup, and releases only local resources. Writer-release
observation requires a child-exit event or a successful owner close, never a
persistent inode or end marker.

The `changes/2.0.0` operation carries `{revision,writerId,view?}` in its initial
and later frames. The server uses its immutable hello identity and the
runtime's latest successfully published bounded catalogue view. The client
consumes the initial subscription value and later values only for that exact
link and binding. A bare revision proves no publication. Loss, rebind, local
close and successful owner close clear the retained snapshot; old callbacks do
not restore it. The manager uses its regular connection when present, otherwise
its existing recovery connection. A current regular link without a publication
does not fall back to an older recovery snapshot. A valid current-host
publication restores connected working rows without a new socket probe, timer
or recurring status request. A valid clean-end marker for that same writer
overrides a still-connected retiring link. A changes-operation mismatch refuses
without a retired-shape fallback; the current diagnostic path retains the
unavailable publication reason.
After a known link loss, a peer can start a working host for that storage while
this session still shows it as unavailable with `+` and excludes it from the
working count until this session contacts that host.

A host that does not advertise `release` started on code without that operation,
regardless of its advertised release number. After active work and result
deliveries finish, stop that host process with SIGTERM, then use `agent_attach`
to start current code. Restarting the caller does not replace a retained host.

Each local call owns an independent waiter, even when durable request IDs match.
Abort, response and terminal failure settle only that local waiter. Client close
rejects every remaining local waiter independently.
Chord assigns a separate wire ID per transport attempt. Equal durable IDs do not
coalesce local calls or promise exactly-once execution for all methods.

An admitted input has a stable Durable request ID. Reconnecting or retrying the
same admission reuses that identity. One native commit admits the input through
Pi's transactional `Conversation.submit(tx, draft)` together with its delivery
intent (already linked to the submission), request route, admission metadata,
check-in and unplaced-input row. A refusal, such as `ConversationBusy` for
`whenBusy: "reject"`, throws inside that commit, so it stores none of them and
nothing remains that reconciliation, a check-in or a reopened host admits later.
An interruption leaves either the whole admission or nothing; a retry of the
same request ID returns the existing submission or admits it once.
The runtime validates each fresh control's delivery recipient before admission.
The recipient must be an exact storage or conversation identity, not a shortened
ID or display name. Rewind validates `ownerId` unless `selfOwned` is true;
a self-owned rewind derives its recipient from the new conversation.
Retained malformed routes become terminal during delivery;
that check does not reject admission replay of retained native work.

Task admission preserves the caller's original text and images in native user
messages. Host-authored routing evidence holds requester, reply recipient,
request ID, and origin separately. A generation hook places one frozen
`agent-request-route` user note immediately after the native input's last user
message. It finds that input through its native run submission and entry, not the
last user message in the request. Static system guidance explains these notes and
report routing. Notes never appear at the request tail merely to refresh routes.
The dashboard shows the original task. Profile shows a bounded view of unfinished
routes on demand, with `requestsOmitted` when further routes are retained. Routes
outside the field limits are omitted, never shortened.

Each saved note holds its native entry ID, the digest of the input message's JSON
with its timestamp, and its frozen text. A generation task's memo freezes this
set, not positions or ordinals. Every call resolves positions from the current
request, including retry after overflow compaction. The unique-digest fast path
requires an exact prefix match with the previous request's user-message keys,
through the last input that received a note. A rolling hash and count retain that
prefix inside the bounded conversation state; trailing guidance messages do not
affect it. The runtime clears a conversation's route state when a native head
marker or contribution edit commits. This covers reset, compaction and context
edits at placement, not while their writes remain queued.
Otherwise, every retained, memoised and new note uses native entry
identity, including the first request after host start or eviction and any
compaction. Duplicate digests also use native entry order. Notes bind to inputs
by content and native order, so a hook that inserts a byte-identical copy of an
input before it shifts the note to the copy.

Host memory retains notes across tool rounds, new runs and settlement while their
inputs remain in the request. Compaction drops notes for absent inputs. After a
host restart, only active routes create new notes; settled routes have no
reconstructed notes. An input without a note has no retained route evidence, so
read `agent_profile` before an explicit report. The route hook adds no changing
per-request bytes while its notes remain retained. This claim covers only the
route hook, not other hooks or a separate guidance tail. Internal hook errors
return the request unchanged; aborts still propagate.

A storage-scoped Durable document holds a random secret created once inside a
commit. HMAC-SHA256 of the conversation ID supplies a stable conversation tag.
Each note starts with `<agent-request-route host="TAG">`; the static system
section names the same tag. Blocks without that exact attribute, and blocks
quoted inside inputs or tool results, have no route or origin authority.

The tag marks host-written notes against route-like text inside inputs and tool
results. It is not a boundary against local agents or forks: Durable agents run
bash, local processes can read the secret in the storage SQLite file, and forks
already copy their parent's context.

Status and Profile omit the tag and secret. Every inspection view replaces tag
values inside the route guidance with `[withheld route tag]` and retains the
guidance. Inspection schemas and operation contracts remain unchanged. Searches
for the tag do not match. This route hook does not put the secret in model
messages or inspection results.
`REQUEST_NOTE_LIMIT` and `REQUEST_NOTE_BYTES` in `request-context.ts` bound retained
notes per conversation. At either bound, all current-run notes remain; the oldest
settled notes leave first. `REQUEST_NOTES_HOST_BYTES` in `request-route-state.ts`
bounds host memory by evicting the least recently used whole conversation.
The next request reconstructs that conversation's active notes. These bounded
evictions change a cached prefix but never refuse generation or input admission.

Base routes derive from retained delivery intents and native submission state.
An owner is the default requester and reply recipient without new wire fields or
route-recovery writes. New explicit-route admissions have a capacity bound;
retained inputs, Reporter tasks, and scheduled tasks recover outside that bound.
Recovery never truncates accepted work to fit a route projection. Reopen attempts
managed-instruction reconciliation for each retained conversation before
scheduling. Base, rich, local, and scheduled admissions refresh instructions too.
An optional profile repair failure is reported without blocking retained work
or other conversations' repairs.
Several requests can share one run; reports therefore require
an explicit recipient. `replyTo` changes the answer recipient without changing
the requester or creator. Report mode does not accept `replyTo`, scheduling, or
check-in controls. Scheduled tasks use their caller as requester and recipient.
Rich host admission requires explicit origin; high-level callers default to
operator origin unless the tool supplies model origin. Answer-bearing dispatch
requires the current `task-submit` response contract; it does not fall back to
an older base-only host. Local dispatch obtains the public native Submission
before returning its reference. The existing background Reporter reuses that
same request ID and a task-owned admission marker, so both paths create
one check-in and one input even under concurrent admission or safe replay.
The Reporter records the exact requester, reply recipient and request ID in the
delivery intent in the commit of the native admission, then waits for settlement. It
posts no answer input of its own; the delivery watcher delivers the answer to
the recorded recipient. A replay of a request ID with another recipient or
origin is refused, as is a replay with another request route.
Base-only calls preserve
an absent origin and refuse an explicit alternate recipient rather than ignore it.

Model requests resume from native checkpoints after process loss. Unsafe tools
that started but did not commit a result are not executed again automatically;
Durable records an interrupted result for the next model step. This does not
promise general exactly-once external effects, power-loss durability, or
termination of an uncooperative shell descendant.

Delivery intents, receipts and reports each have one keyed native document.
Bounded reference pages separate retained history from current work. Settlement
reads current intents, and each routing pass reads one pending page plus complete
native answer groups. Unresolved automatic notices have separate completion
references, independent of routing eligibility. The watcher continues those pages
even when a page changes no records. Terminal rows leave active routing pages but
remain available for owner acknowledgement, pending counts and retained diagnostics.
A settled watched input retires its automatic notice even when routing is terminal.
An explicit owner query also checks completion for its returned candidates. Acknowledged
outcomes remain available for request deduplication. Report requests deduplicate
by owner and request ID; source IDs independently identify acknowledgements.
Absent observation keys and unknown acknowledgement keys do not create records.

Each reference page records the list that owns it. Every page read and append
checks that identity and refuses a page that names no list or another list:
`Delivery reference page has no current owner-list identity or belongs to
another list`. The page document is `agent.delivery-page` version 2, with no
migration from version 1. These consequences apply to existing data:

- A storage that retains version 1 pages refuses each typed page read and
  append with Pi's `Document <id> (agent.delivery-page) requires migration from
  version 1`. Each operation that reads or appends such a page fails in that
  storage. The host does not normalise, backfill or rewrite those pages.
- A host from an earlier source release refuses a version 2 page as a newer
  version than its own.
- The `agent.reporter` task is version 2, with no migration from version 1.
  Pi blocks a retained version 1 Reporter task with `migration_failed` instead
  of running it. Let every Reporter task of the earlier release end, including
  a task that waits to post its report, before a host with this release opens
  the storage.

#### Version 1 page transition

A one-time manual command adopts retained version 1 pages:

```sh
node extensions/agent/adopt-delivery-pages.ts [--apply] [--storage <id>] [--agent-dir <dir>]
```

Run it from the harness release or checkout. It reads the catalogue that hosts
use: `<dir>/agent-sessions` with `--agent-dir`, otherwise `PI_AGENT_SESSIONS_DIR`,
otherwise `agent-sessions` under `PI_AGENT_DIR` or Pi's agent directory; the
records sit in its `durable` directory. `--agent-dir` selects the catalogue
only. Each record names its storage file and its agent directory by absolute
path, and those are the targets that the command changes: the storage file,
and the writer lease file under `durable-hosts` in the record's agent
directory, which may lie outside the catalogue. The catalogue refuses a record
whose storage file is not in its own directory, so a copied catalogue with
unchanged records stops the command before it reads or changes any storage. To
try the command on a copy, rewrite `storagePath` and `agentDir` in each copied
record; with `storagePath` alone, the lease file goes to the original agent
directory. The command never rewrites a record.

`--storage` selects one catalogued storage. For each storage it takes the
host's native writer lease (creating the lease file as a host does), so it never
reads or writes a storage beside a running host. It prints no message content.
The first line names the catalogue directory: `dry run of catalogue <dir>` or
`apply to catalogue <dir>`. Then one line names the storage file and agent
directory of each storage that the run adopts, would adopt, skips, or that
`--storage` names: `adopted <id>: <n> pages; storage <file>; agent directory
<dir>`, `skipped <id>: <state>; ...`, or `storage <id>: <state>; ...` (a dry
run, or a named storage that needs nothing; `no storage file` when the named
file is absent). Counts follow, by state: `version 2 only`, `no pages`,
`version 1`, `version 1 with active task` (a live version 1 Reporter task),
`older storage schema`, `writer busy` and `unreadable`, then one `storage
schema <n>: <count>` line for each SQLite schema version it read.

Every run classifies each storage through a read-only SQLite connection that
writes nothing to the storage file or its WAL. Without a WAL file it opens the
file with `immutable=1`, which creates no `-wal` or `-shm` file; a retained WAL
is read, not written. The queries read Durable's SQLite table layout of schema
version 2, the schema of the installed Durable release; under another installed
schema version every storage reads `unreadable` until the queries are checked.
A storage with an older schema is `older storage schema`: Pi's storage open
applies its schema migration, so the command never opens it. That storage waits
for the operator's schema migration decision, which a normal host open carries
out; run the command again afterwards.

The default is a dry run. `--apply` opens through Pi's storage only a storage
that the read-only pass classified as `version 1` at the current schema, still
under the same lease, and adopts it. It skips each active-task, older-schema,
busy or unreadable storage, and never opens or changes one. Rerun it after the
host ends or the task settles. A storage whose adoption refuses stops the run
with an error that names its ID and file; storages adopted before it stay
adopted.

`--apply` commits through a plain Durable Session over the opened storage
(`createSession`), not a Harness. A Harness open recovers retained tasks: it
commits each `running` task back to `pending` with one more restart and
schedules reconciliation, abort cascades included. The adoption loads no task
scheduler, starts no task, calls no model, and reads task records only to
report live version 1 Reporter tasks. Every task record stays as stored, also
when the adoption refuses; the next host open recovers retained tasks as usual.

Adoption runs `adoptDeliveryPages` in `delivery-store.ts` in one commit per
storage. It enumerates the current delivery lists once, walks each list from its
head, and gives every reachable version 1 page that list as its owner. The
version 1 incarnation is retired and stays in Pi's document history; a version
2 incarnation at the same address keeps the references and links. Rows,
pointers, lists, tasks and request deduplication stay unchanged. An
interruption therefore leaves a storage wholly unadopted or wholly adopted, and
a repeated run changes nothing. A page that two lists reach, or a list that
names an absent page, refuses that storage. Version 1 pages that no list
reaches stay unchanged. Opening a storage never runs the adoption.

Until adoption, an owned admission, a report append or a delivery read in a
version 1 storage refuses with Pi's migration error, followed by the cause and
the exact command for the running release. After adoption, a host of a release
older than the page format still opens the storage and reads its delivery rows,
pointers and lists, but refuses every page read and append, because the pages
are a newer version than its own. Restore a copy of the storage file, taken while
no host runs, to return to the earlier state. The command and
`adoptDeliveryPages` serve only this transition: remove them when a dry run
reports no `version 1` storage.

No read path accepts version 1 pages, and no migration exists for the Reporter
task.

The host completes a retained delivery transition before request admission,
output observers and native resume. Each bounded batch commits its copied rows
and cursor together; final validation and archive retirement share one commit.
An interruption resumes from the cursor. The transition enumerates its immutable
source once per call, not once per batch. All writers must use the same delivery
representation. After archive retirement, a source-only rollback does not restore
an older reader's data contract; preserve a storage restore point before adoption.

Retained outcomes include submission and answer entry IDs. The source storage's
durable-delivery watcher is the sole retained-output delivery owner: after every
native commit it settles intents atomically and groups receipts by native answer
entry and recipient. A result notice lists the recipient's submissions that
share that answer. Primary
notice details retain each submission's request, operation, input entry, owner,
and admission origin.
Each recipient outside the producing conversation receives one notice for that
answer, including when owner routes overlap. Distinct answers and unanswered
submissions stay separate. The watcher acknowledges the receipts for accepted owner routes
in one commit. An offline owner stays pending while live owners receive their
normal notice and wake intent. Reports remain separate. An owner in another
catalog storage receives an untrusted follow-up in its own host. Another
conversation in the same storage as the source
receives the answer as an in-storage follow-up, never through a primary route.
When the owner resolves to the producing conversation, the watcher acknowledges
that owner's receipts without a follow-up or a model turn. This applies to
operator and model admissions, including unanswered outcomes after abort or
failure. The conversation already retains its outcome. Other owners still
receive their own notice for that answer, with only their own submissions. Missing
or malformed admission origins become terminal with a retained reason, even for a self owner.
A noncatalog owner is an ordinary primary reached
through its registered primary channel. Only an absent or proven-dead owner
endpoint permits fallback: the watcher broadcasts to every live primary within
one bounded discovery of registered endpoints, and each delivery is labeled
`no live owning session` while the original owner identity stays in the message
details. These copies are informational and never acknowledge the owner row.
Each accepted fallback recipient is recorded in the retained row, so subsequent
passes and host reopens do not repeat that copy. Other owners of the same answer
receive their normal delivery rather than a fallback substitute. A partial scan still attempts the discovered recipients and reports its incomplete coverage.
Fallback discovery never makes an unavailable owner active.

One classification controls delivery, status and retirement:

- `active`: a live primary with a compatible contract, or a retained native target
  whose host is available. Transient transport and unavailable-host failures
  retry, including acquisition failures while a live writer starts or shuts down.
- `parked`: an absent, dead, unknown or incompatible primary, an unretained native
  target, or a native host with a persistent launch failure. The row stays retained without a
  retry timer and does not block retirement. A fresh watcher or explicit refresh
  permits another native acquisition attempt.
- `terminal`: a malformed recipient, corrupt admission origin, or linked intent
  whose native submission is absent. The delivery document retains the reason
  beside the row. The watcher never retries a terminal row.

An unlinked intent remains pending for admission replay. Current admissions
leave no unlinked intent; scheduled inputs and intents retained by earlier
releases can. A replay with an absent conversation becomes terminal; transient
replay failures leave it pending. An unlinked `whenBusy: "reject"` intent with
no native submission becomes terminal without a replay, because a refusal or
admission of that mode holds only at its original moment. A check-in task of
such an intent ends without an admission.
Elapsed time never changes eligibility. Status `deliveryError` names the state
and reason without changing the response shape. Only active rows and pending
intents keep delivery active. A live or unknown owner endpoint refuses fallback.
Active failed passes wait
for the configured retry delay, which doubles after each failure up to 30 seconds
and resets after a successful pass. A native commit or explicit refresh starts a
pass immediately, even during that wait. Commits during an active pass coalesce
into one immediate follow-up pass. Closing the watcher cancels its retry timer.
The timer alone is not an in-flight delivery effect; active rows still prevent
host retirement and retain recovery state. Parked and terminal rows do not.
An owner endpoint carries the primary channel contract version. A host
that meets a live owner with another version holds that delivery pending and
reports the endpoint version and the restart that clears it; it never treats the
owner as dead and never falls back for it. Endpoint identity and local process
ownership are checked before delivery compatibility. A new registration removes
a stored endpoint only for a proven dead local PID and an unchanged file
identity, regardless of the stored contract tag. Foreign or unverified ownership
stays protected. Ownership metadata never authorizes a retired delivery payload.
A fallback broadcast checks every registered primary before the first delivery,
so one incompatible candidate
holds the whole fallback. The host keeps the latest routing failure in its
status as `deliveryError`, and the status card shows it. The error names the
failed record and recipient; it does not imply that another result failed. A
missing catalog record does not authorize a noncanonical primary route. The
primary does not poll receipts. Delivery is at-least-once. A result's source ID
binds the producer storage, the answer (or the unanswered input) and the actual
recipient; its request ID derives from that source ID. Inputs with the same
recipient share one body. Different recipients have independent attempts and
acknowledgements, and a routing pass acknowledges only the recipient rows that
it visited. An informational fallback copy has a separate source ID for each
fallback recipient and carries no receipt association. These stable IDs let each
receiver deduplicate retries and host restarts. An accepted or queued delivery
does not show that the recipient read it. A primary process loss after display but before acknowledgement
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
A notice names an agent by its display name or handle, with its full identity
as the unnamed fallback. An ordinary session uses its session name, observed
purpose excerpt, or full session ID. Identity text is not shortened to a fixed
length; a headline clips only when it exceeds the rendered width. Direct messages carry the sender's
current name and published purpose. Foreign thread senders use their exact
retained agent row or published primary endpoint without a host launch or
discovery scan. A dead primary descriptor retains its parsed sender metadata;
its published configuration is not a live-state observation. Missing source
evidence does not classify a report sender as an agent. Thread notices put the
thread title, or full thread identity when no title is known, on the first line.
Their second line starts with `from <sender>` when known. Their display body
comes from the defining event, while stored model content stays unchanged.
Thread mutations, not only posts, produce these notices.
The first header line uses plain kinds: result, still working, report, thread
notice, or message from another session. Other kinds keep the sender label on
that line. The muted second line contains known provider/model, thinking level,
check-in elapsed time, and cost. A blank line separates the header from the body.
Peer kinds use bold theme text; their subjects and normal body use theme text.
Metadata and expansion hints stay muted. Warning colors and native Markdown
styles retain their meaning. Missing optional facts produce no unknown or
unavailable header fields. Expected reports and direct messages omit the unsaved
result warning; genuine failure warnings remain in the body.
The collapsed answer uses up to three visual lines, including any warning or
reason lines, with one Pi expansion hint only when text is hidden and no
separate ellipsis row. The shared layout adds the same inner top and bottom
padding as Pi tool cards, with no collapsed navigation instructions. Expanding the notice shows the full
received answer, source details including full identities and submission rows,
and `/agent opens the dashboard`. Model-facing caveats stay in the stored
message content rather than the answer preview. Catalog follow-ups between Durable hosts keep their
existing form.

Automatic owner check-ins do not depend on voluntary worker reports. Model
`agent_spawn` and `agent_place` prompts and `agent_send` tasks use the effective
`agent.checkInMinutes` setting; its default is 0, so a task arms a check-in only
when the setting or the per-call `checkInMinutes` names a positive interval.
Results, reports, and failures still arrive through normal delivery; a
check-in is a watchdog for work that needs one, not the way results return.
Operator admissions get no default. An admission creates no check-in when its
owner resolves to the conversation that runs the work, even with a positive
explicit interval. This applies to both origins and alternate root identity
spellings. Native foreign admissions and local Reporter admissions use the same
interval and delivery contract. Scheduled sends retain the selected interval
before their deadline and start eligible check-ins when the input is admitted. Delivered reports, results, and check-ins never
arm another default check-in.

The host's `pi.host` built-in registers the check-in task independently of the
configured native agent contribution. Native Reporters arm check-ins only when
the host registry supplies that task. The runtime therefore owns availability.
A check-in is a native `agent.check-in` background task, armed atomically with
the delivery intent, or with the local Reporter's retained arming checkpoint.
The public admission API owns a separate commit. The task reacquires the input
by submitting its same request ID, then waits for settlement while its owned
`agent.check-in-deadline` task commits durable sleeps. On recovery, the parent
reattaches to that owned task instead of creating another deadline. Settlement
aborts the owned task. The parent's existing task version and checkpoint remain
unchanged. Admission time and interval remain in the task input. The host supplies the
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
most one quiet fallback broadcast per watched task and owner. The accepted
broadcast marker is independent of owner acknowledgment and survives notice
replacement. Each accepted recipient is recorded before another receiver is
tried. Repeated intervals never broadcast again after a complete broadcast for
that owner. A failed or incomplete fallback stays pending.

The headline names the agent and says it is still working, not finished, with
elapsed time and retained conversation-total cost. The bounded body covers only
the watched task. Its retained-entry scan starts at the watched input's
transcript entry. It shows the task's tool call count, current tools, their call
age (not exact execution time), last tool lines, and a reply excerpt labeled as
unfinished. A direct producer check-in also puts a native retry ahead of those
generic lines, only when the watched submission belongs to the current run.
The count is exact when
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
waits on Durable's `sleepUntil`. Replay never recomputes the
deadline. On fire it admits the input once through request-ID deduplication,
and the answer follows the notice and wake rule of its origin. A timer that
was due while its host was down fires once after the host reopens and records
that it ran overdue. A pending timer is live work, so the host does not retire
while it waits. A timer fires only while its storage host runs; Pi starts no
operating-system alarm, and a reset never cancels a timer.

A keyed Durable document retains the native task ID and canonical payload
fingerprint in the same commit as timer creation. It does not copy task outcomes.
Reusing a schedule key returns that task's current native state after cancellation,
firing, listing pruning or reopen. Changed target, content, deadline, mode, origin,
recipient, request identity, check-in interval or request context refuses as a
conflict. Creation timestamps do not affect identity. If the key has no index
entry, a bounded storage-wide scan checks retained timer inputs first. A unique
match is adopted; ambiguity or incomplete lookup refuses new admission. The
bounded timer listing is not replay authority. Cancellation reads the native task
and never reports prevention when its input already entered the conversation.

A reset admits a native `pi.reset` write with an optional handoff message. It
places at the next boundary when the conversation is busy, starts no model
turn, and leaves history inspectable.

A registered primary refreshes its recorded model, reasoning level, and session
name when the ordinary session changes them, so `agent_status` and endpoint
discovery report the identity the operator runs.

### Current process contracts

The host socket protocol that separate processes consume (service name, request
envelope, operation identities, discovery publications, request-key rules, and
the fail-closed consumer rule) is documented at package level in
[`docs/agent-host-contract.md`](../../docs/agent-host-contract.md). That document
describes current behavior; this extension may change the protocol, and consumers
refuse operations whose identities they do not recognize.

The `rewind/2.0.0` and `timer-schedule/1.1.0` request contracts accept optional
`selfOwned: true`. A rewind correction then uses the new fork as its delivery
owner without changing the fork's creating owner. A scheduled input uses its
target conversation as owner and reply recipient while retaining the caller as
requester. Without the option, both operations retain caller-owned results.
The rewind response identity is `rewind/2.0.0`. It returns the correction's
admission without waiting for its answer. Its request contract has no `wait`
member and its response carries no `outcome`. Read the admitted result through
inspection or its normal receipt. The timer response identity is
`timer-schedule/2.0.0`: it distinguishes a new `scheduled` timer from a `retained`
task and exposes native `status` and optional terminal `outcome`. Place uses
`place/2.1.0` requests for empty-prompt resolution and exact prompted admission;
its `place/2.3.0` response includes the placement of a prompted input,
including `withdrawn`.
These operations refuse mismatched process contracts; restart the caller and host
to use them together. The manager passes the option through its existing control
interface, so its retained identity does not change.

`receipts/3.0.0` reads the currently committed receipts or the exact selected
input without waiting for settlement. A queued or placed input returns its
status without an answer. Result inspection is also immediate. Neither read
withdraws normal delivery or acknowledges it. The host does not advertise a
held-await operation. Status and dashboard schema identities cover their
unplaced-input facts separately from native task state.

`recovery-state/1.1.0` is the response contract for the separate `deliveriesActive`
field. `deliveriesPending` still reports all pending rows and governs marker
clearance. `manager/7.0.0` uses the package-level Chord transport and includes
recipient-scoped receipt associations, paged result inspection,
retained primary acceptance, joined communication display and awaited primary endpoint teardown,
preset-first creation resolution and machine
preference snapshots, alongside exact fleet model/provider selection, caller usage for fleet observations, effective
thinking from catalog validation, ordinary retained observation, first-input
origin, independent command admission, exact result references, and
parked-delivery recovery. Spawn and resolve-agent requests use 2.0.0 for creation without parent
inheritance. Their responses use 2.2.0 and include prompted-input placement
beside preset names and selection origins. Configure requests and responses use 1.3.0 for explicit
provider-block recovery alongside machine preference snapshots and selection
receipts; target retention remains unchanged. Task-submit requests use 1.1.0,
and submit requests use 1.7.0, for explicit input labels and dependency marks
alongside retained routes and delivered-result references. Both responses use 1.4.0 for committed
placement, including `withdrawn`, beside recovery links and the retained recipient. Timer-cancel responses use 1.1.0 for the resolved
conversation identity; the request identity remains at 1.0.0. Report requests
use 2.0.0 for passive reports and exact producer associations, and report
responses use 1.2.0 for the `delivery` and `placement` facts.
Passive-submit requests use 2.0.0. Receipts requests and responses use 3.0.0
for immediate state reads and recipient-scoped reference pages. Inspect requests use 1.2.0 for
`receiptCursor`; the inspect response identity is its schema hash.
`docs/agent-host-contract.md` lists every operation identity.
`native-controls/3.0.0` binds the native tool inputs and dispatch behavior to
the loaded Durable release. `primary-delivery/4.0.0` requires verified retained
primary acceptance and carries retry notices, blocked causes, receipt
associations and exact continuations. Delivered result references travel inside
the unchanged notice details, so they do not change this identity.
Older primary endpoints refuse delivery until their Pi process restarts. The
retained manager contract also changes because its primary callback carries the
transport source identity. Host operation identities are checked independently.
The Endpoint identity remains separate from both retained interfaces.

Restart Pi windows to load the changed manager and
start fresh Durable hosts for changed runtime modules and native contributions.
A primary `/reload` does not replace the retained manager or running host
modules. Do not mutate live stores as part of a source upgrade; store migration
requires separate authority. Keep active work intact.
The recovery-state request contract remains at 1.0.0.

`version-contract.ts` separates source release, actual loaded upstream releases,
and operation contracts. A host advertises its descriptor in readiness and
inside the `runtime-contract` hello envelope. The current hello format is
`pi.agent.host-hello/1`, with `writerId` and `contract` fields. A client that expects
a bare operation descriptor refuses this envelope, and the current client
refuses a bare descriptor. No operation works across that hello boundary in
either direction, including operations whose individual identities match.
Earlier-format clients and hosts must finish their work and stop before adoption
on their affected stores.

After compatible hello negotiation, each operation names its current request
and response contract. Client and host compare those identities before dispatch;
a mismatch refuses that operation before a mutation or response decoding.
Unchanged operations remain usable across independently restarted Pi windows
and hosts only when both sides accept the current hello. Release ordering never
grants or denies an operation. Profile reads, revision-checked updates, enriched
discovery, handle resolution and rich task admission have separate feature-scoped
operations. Optional profile hints live inside catalog `view`, outside the base
wire rows. An unsupported operation refuses without preventing other compatible
operations on that negotiated connection.

A live host with a different `recovery-state` contract is an expected state during
independent restarts. The manager retains the link without requesting an
unsupported response. It charges no crash budget and leaves automatic recovery
enabled. Fleet status and dashboard metadata put the exact contract difference
and the next host start in `ownerLabel`, not `health.lastError` or the failure
list. Active work stays intact. A compatible connection clears that neutral
fact and resumes ordinary recovery checks. Actual transport loss still uses the
writer claim and the bounded crash budget. No timer, polling, or older-response
reader waits for an upgrade.

An unavailable change feed leaves compatible reads and controls usable;
`agent_status` reports the live-update failure.

The caller's catalog scan owns roster rank, inventory coverage, and priority
omission counts. `ToolStatusSchema` adds these local overview facts to tool output;
`StatusOutputSchema` describes host responses and contains none of those facts.
Local roster fields do not belong in the host schema. If an actual host response
schema changes, its generated operation identity changes with it.

The tool status schema is a product of independent parts, not one closed object
per combination, so each large part (the conversation status, the effort
awareness, the overview row) appears once in the schema and in the declaration
that scripts read. The parts are: optional `awareness`, shared by every
result; an overview, or a selected status; and, for a selected status, a
single (`conversation`) or plural (`conversations`, with optional
`createdAgents`) payload combined with a live (`inventory`, `pid`,
`storageId`), cold (`live: false`, `storageId`) or absent envelope. A bare
`{conversation}` from the attach path is the single payload with no envelope
and permits only `conversation` and `awareness`. Component objects stay open
so they can coexist; a final property-name guard closes each complete result,
and properties declared `never` state the exclusions between components:
`conversation` with `conversations`, `createdAgents` on a single result, and
`live` with `inventory` or `pid`. Validation stays exact: unknown keys, missing
required fields, mixed envelopes and non-finite numbers are all refused.
`StatusOutputSchema` and `AgentConversationSummarySchema` keep their serialized
form, so their contract hashes do not change.

The overview row is `ToolOverviewRowSchema`: the native row plus the optional
catalogue `attention` hint (`provider-blocked`, `task-blocked`, or
`failed-turn`). The overview drops `profile`, `creatingOwnerId` and
`rosterOrder` from each row because the row schema does not declare them, and
keeps `attention`.

When a tool observation fails validation, `observationDiagnostic(schema, value,
limit)` returns the `variant` it compared against and at most five JSON Pointer
errors. For the tool status it selects the variant from the value's own
discriminators (`kind`, `view`, overview fields, single or plural payload, live
or cold envelope) and reports conflicting shapes directly, so a bad overview
`attention` value names `/sessions/0/attention` instead of missing fleet fields.
Other schemas keep the validator's own errors. A schema mismatch says nothing about
Pi or agent versions.

Typed observation results use schema hashes, so a changed published schema
changes its contract without a manual stamp. Opaque native results and native
ABI-dependent operations also require the same experimental Pi Durable release.
Normalized extension-owned operations do not require identical upstream
releases. The descriptor records actual coding-agent and Durable versions plus
minimum public API floors. Meeting a floor is necessary, not a guarantee for
unknown future upstream APIs. Wildcard dependency declarations remain unchanged.

The retained manager, native control binding, and primary delivery channel have
separate exact interface identities. The binding includes the loaded Durable
release. An incompatible manager or binding refuses reload with restart
instructions. An incompatible primary endpoint holds notices pending without
broadcast. Unrelated additions to host methods change none of those interfaces.

No descriptor means refusal, not a version-zero fallback. No reader translates
retired payloads or stored shapes. When an operation changes, update only its
request/response identity, or its schema, in the same change and test both sides
of refusal. Change a retained interface identity only when that interface
changes. Source release is diagnostic provenance, not a compatibility promise.

Mismatches name the affected contract and the available restart path. Active
work stays intact. Let an idle host retire, restart a stale caller when needed,
then use `agent_attach` and retry. The manager does not replace hosts based on
source ordering; ordinary idle retirement loads new code on the next control.
A newly added operation remains unavailable on a running host that lacks it.
A process predating the current descriptor needs a restart; there is no hidden
upgrade, migration, or interruption of active work. Application errors from a
live writer never authorize another writer.

Native conversation and task-watch publications wake the existing observation
feed directly, including streamed text, thinking and tool progress. Durable
shows that progress to watches at once and stores it later, so the stored-commit
changes feed (`observeCommits()`) and catalog publications see it only when it
is stored. A conversation frame reads a native view window over the fork-aware
history; when the window does not start the transcript, the frame reports
incomplete coverage and `nextBefore` pages older entries. Snapshot pages read
the same history, head markers included. The host coalesces those signals
without a catalog write or a polling timer. Committed
catalog notifications retain their separate source and consumers. A running
host retains its loaded notification code until a supported idle host restart;
a client release alone does not replace it.

An open live observation reconnects only to a live host. It never relaunches a
lost host; it signals unavailable and leaves relaunch to bounded manager
recovery. A listener attached after a frame arrives receives that current
frame at once. Live status and dashboard tails expose only the declared
tool-call fields, including parsed arguments and optional namespace/signature
fields. Provider parsing buffers do not enter these live projections; raw native
state stays unchanged. A status schema error alone does not establish different
process versions.

When a conversation has no live run and its inbox contains only queued writes,
the host places them at a boundary without starting a run. It checks after an
unanswered submission and when the host resumes. When a conversation has no
live run, has queued non-write inputs, and its latest retained assistant task
failed with `model_error`, the host submits a passive
status write through Pi Durable's public conversation API. The write places
queued inputs at a final boundary and starts their next run. It tells the model
the previous error and identifies the notice as host status, not an operator
instruction. The failed original input remains unanswered. The fixed steering
mode `all` places every queued input at that boundary.

Each ended generation supplies a deterministic recovery request ID. Native
request deduplication prevents duplicate recovery writes after replay. A host
also checks existing queued inputs once at startup. A paused host waits until
its caller installs contributions and request-context sections, then calls the
host's `resume()` method. Recovery adds no user input,
so repeated failures cannot create a self-sustaining recovery queue. An abort
withdraws queued inputs; a recovery write admitted after that abort starts no
run for those inputs. Commit notices drive recovery without timers or polling.

Owned launches supply readiness events. For a host launched elsewhere, this Pi
makes one bounded attach attempt and reports when no readiness event is
available.

The host sets a top-level `recoveryDue` marker before it admits work, and when
opening finds pending native work or an incomplete delivery observation. Native
commits, request completion and delivery-idle transitions reconcile the marker
from the delivery driver's summary, without reconstructing pending payloads.
The driver aggregates pending count, active routes and parked recipients across
its complete bounded traversal. Each classification carries the recipient facts
sampled for that decision through retention and aggregation. Conflicting samples
for one tracked parked recipient invalidate the pass, even if the final facts
match an earlier sample. Completion and retirement still recheck current facts.
Unfinished pages, scheduled work, relevant
commits, external invalidation and failed passes keep recovery conservatively
due and block retirement, even between pages when no delivery is in flight.
The marker clears only after a fresh complete observation finds no native work
or active delivery. An in-progress admission preserves the marker through its
pre-input gap. Marker writes occur only when its value changes. Parked and
terminal rows alone do not keep it true. Before clearing the marker, the source
writer atomically publishes its
parked recipients in `sessionsRoot/.delivery-wake/<storageId>.json`. Each source
owns one file outside the catalog directory. The file contains a bounded set of
exact recipient identities and an `omitted` count of excluded parked rows;
omitted rows remain retained and require explicit acquisition. Partial and
failed passes preserve the previous complete wake projection rather than
replace it with one page. `failedAvailability` records each recipient's
last failed native launch fingerprint, or null when no available target was
attempted. A fingerprint hashes launch metadata and the caller's Pi installation.
An unchanged recipient set and unchanged fingerprints cause no write. The writer
removes the file when no parked row remains. Terminal rows never enter this
projection. Publishing the sidecar first preserves wake discovery if the writer
crashes before the marker clears.

Startup recovery reads the marker and matching wake sidecars within existing
bounded catalog pages; it does not enumerate the wake directory or open, copy,
or status-probe every storage. Recovery acquisitions run at most two at a time. A
transient recovery link closes when the internal `recovery-state` check reports
no pending native work and no active delivery; host change notifications trigger
that check, not polling. A row addressed only to a proven-dead ordinary primary
waits in durable storage without a recovery link or a delivery retry timer. The
host retires normally with `recoveryDue` false while that row remains parked,
with or without a live fallback recipient. Source-ledger deliveries explicitly
set `requireRetained:true` for both owning and fallback primary routes. The
channel defaults to that strong acceptance mode: a live ordinary primary
acknowledges only after its actual session JSONL file contains the matching
`agent.peer` entry and transport source identity. Direct ordinary-primary
submit/report routes have no source ledger and explicitly use
`requireRetained:false`; their success means queued admission, not retention,
action, or task acceptance. Queued deduplication never satisfies a later retained
acceptance request. Pi's in-memory queue and `sendMessage`
return do not prove retention. Pending confirmation refuses transiently, leaving
the source ledger responsible for retry while other owners still receive their
rows. In-memory attempt markers prevent repeated steering while a notice is
queued; settled or failed attempts remain retryable. A new custom-only session
waits for Pi's first conversation flush. Verification reads at most one MiB per
scan with bounded continuation. It streams past unrelated records without
buffering or parsing their bodies, so large image/tool records impose no new
record-size limit. Only exact serialized candidate notice lines confirm
retention. Invalid header identity, incomplete tails, file replacement, and
truncation refuse confirmation. No second persistent delivery queue or
exactly-once historical ledger exists. A crash after retention but before source
acknowledgment still permits replay.
Any primary registration runs the existing bounded scan of runnable recovery
and wakes parked sources whose sidecar names that exact primary. Unrelated
registration leaves those sources cold. Catalogue-change scans also
wake a parked source when a named recipient has a native catalog record or a
live compatible primary endpoint, and its current fingerprint differs from the
source's recorded failure. This comparison survives manager restarts. A bounded
manager cache only coalesces attempts before the source records their outcome.
Explicit acquisition also reopens retained rows. Recovery-state and final
retirement checks validate the summary's bounded recipient facts against current
native availability and primary endpoints. Changed facts schedule the existing
driver and refuse retirement until it completes, even if the source has no new
native commit. Unrelated status completions do not read delivery payloads or
recipient facts. A recorded fallback copy never repeats. Active routes retry;
incomplete or stale observations also block retirement. No row expiry or new catalog scan
bound is introduced. A final marker check also runs during clean close. Clean retirement
closes cached manager and peer delivery links without a recovery acquisition or
crash-budget charge. Native shutdown stops native writes and unpublishes its
socket before releasing the kernel lease. Positive owner release does not trigger
automatic recovery from a retained delivery marker. Uncertain shutdown retains
exclusion until close succeeds or the dedicated process exits. Unexpected
connection loss preserves native work. Automatic replacement requires an exact
owned failed exit, and the replacement must acquire the kernel lease. Diagnostic
records remain after release and do not block acquisition. Footer totals remain
in the catalog; later reads use cold storage without a writer, and later controls
acquire a fresh host only when the kernel lease is free.

Cold `agent_status` returns retained conversation data with `live: false` and
`storageId`. It omits `pid` and `inventory`: the reader loads no host, so its
process identity and loaded capabilities are unknown, not empty. Live host status still
includes its process identity and actual loaded inventory. Cold inspect views,
transcript snapshots, and dashboard rows read the same retained storage without
starting a host or a model turn.

While a primary remains registered, an unexpected host connection loss rereads
that marker and queues recovery through the same bounded pool. The manager owns
these relaunches; managed connections do not independently relaunch on request
retries. Three automatic recovery attempts are permitted per storage within sixty
seconds; every attempt requires the kernel lease and never unlinks its inode. Further losses
stop automatic recovery and put a host error in the dashboard roster. Inspect
the error, then use `agent_attach` to reset the manager's retry budget and retry.
This reset does not remove diagnostic records or release another writer's lease.
Intentional disconnects and unmarked storage do not relaunch.

## Execution presets and delegation preferences

The agent section of the optional `<agentDir>/harness.json` machine document
contains execution presets and delegation preferences. The package-level
[settings contract](../../docs/conventions/extension-config.md) defines source evidence,
validation, and environment precedence. The extension implements its own reader.
Ordinary hosts use `PI_AGENT_DIR` or public `getAgentDir()`; native and standalone
hosts supply their own directory.
`PI_HARNESS_FILE` selects another machine document. The repository supplies
portable examples, not a machine roster. The reader discovers no project files
and follows no include chains. Pi settings, providers, credentials, and trust
remain host-owned.

An execution preset is a named bundle of creation or configuration values.
It is separate from an agent's durable role and sourced expertise, which remain
on `agent_profile` and the native `agent.profile` document.

### Machine document schema

The file is strict JSON with a `version: 1` envelope and an optional `agent`
section. Its fields are `idleMinutes`, `checkInMinutes`, `presets`, and
`preferences`. All fields are optional. Each field selects a present environment
value, then its document value, then its safe default. Structured environment
values use JSON. An invalid selected field uses its default, not a lower-priority
file value; other fields remain usable. Diagnostics identify rejected
sources and unknown fields. The local reader bounds the document and JSON
structure as specified in the settings contract.

The extension owns the closed structure of each preset and preference object.
The presets map contains at most 64 presets. Names have 1 through 64 characters
and match `[a-z][a-z0-9]*(-[a-z0-9]+)*`. Each preference array or map contains
at most 64 entries. Invalid names, unknown structured keys, wrong types, and
invalid numbers reject that structured field. Presets have no include,
inheritance, credentials, cwd, tools, or trust fields.

| Preset field | Meaning |
|---|---|
| `model` | Required exact `provider/model` identity. |
| `thinkingLevel` | Optional Pi level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `role` | Optional role text, at most 2,000 Unicode characters; applies only during handle creation. |
| `checkInMinutes` | Optional finite interval from 0 through 35791 minutes; 0 disables automatic check-ins. |
| `notes` | Optional explanatory text, at most 2,000 characters. |

Every field in `preferences` is optional:

| Preference field | Meaning |
|---|---|
| `defaultPreset` | Preset name used only for new spawn/place creation with neither `model` nor `preset`. No implicit default exists. |
| `enforceRoster` | Boolean, default false. When true, creation refuses explicit models outside all presets and any selected excluded model/provider. Configure and reuse are not creation. |
| `excludedModels` | Array of exact model identities that the operator prefers not to select. |
| `excludedProviders` | Array of provider identities that the operator prefers not to select. |
| `contextBudgetTokens` | Map from exact model identities to positive integer planning budgets. These are preferences, not enforced context caps. |
| `quotaSubstitutionOrder` | Ordered array of preset names for a model to consult after quota trouble. It causes no automatic substitution. |
| `reportingNotes` | Text for delegation and reporting guidance, at most 4,000 characters. |

Portable example; replace the illustrative identities with models in the
configured catalog:

```json
{
  "version": 1,
  "agent": {
    "presets": {
      "review": {
        "model": "acme/model-x",
        "thinkingLevel": "high",
        "role": "Review current source and report cited findings.",
        "checkInMinutes": 20,
        "notes": "Use for source review."
      },
      "economy": {
        "model": "acme/model-x",
        "thinkingLevel": "low"
      }
    },
    "preferences": {
      "defaultPreset": "review",
      "enforceRoster": false,
      "excludedModels": [],
      "excludedProviders": [],
      "contextBudgetTokens": { "acme/model-x": 16000 },
      "quotaSubstitutionOrder": ["review", "economy"],
      "reportingNotes": "Report catalog diagnostics and unapplied fields."
    }
  }
}
```

### Selection and unapplied fields

`agent_spawn`, `agent_place`, and `agent_configure` accept `preset` by name.
Precedence applies separately to each field:
**explicit argument > selected preset value > operation default**.
For creation, the selected preset is explicit `preset`, or `defaultPreset` only
when neither `model` nor `preset` is supplied. Explicit model selection does not
import any fields from `defaultPreset`.

- New spawn and place creation require a model from an explicit argument or
  selected preset. Without either or a machine `defaultPreset`, creation fails
  with the file path, preset names, and digest. Creation never inherits parent
  model, thinking level, role, or check-in settings. The cwd still defaults to
  the caller's directory. `/agent new` and the dashboard use the same resolver.
- Missing optional thinking defaults to `off`, then Pi clamps it to the selected
  model's capabilities. A missing role is empty for new handles and unapplied
  otherwise. A missing check-in interval uses the existing admission default:
  the effective `agent.checkInMinutes` setting for model tasks and no automatic interval for
  operator tasks. Check-ins apply only when a prompt starts work.
- Place accepts `model` and `thinkingLevel` for creation alongside `preset`.
  A reused place owner keeps its retained configuration; supplied model,
  thinking, and role fields are reported as unapplied.
- Handle reuse also preserves retained configuration and reports supplied
  model, thinking, and role fields as unapplied. A supplied name is ignored on
  reuse without an unapplied-name receipt. Preset selection is not a live link
  to an agent.
- A spawn preset's role applies only when creating a handle. Without a handle,
  the preset role is reported as unapplied.
- Configure uses explicit values, then preset values, then the target's
  retained values. It never inherits the caller's model. Name remains explicit.
  Role remains on the revision-checked `agent_profile` path; a preset role is
  reported as unapplied. Configure starts no task and remains idle-only.
- `agent_send` accepts no preset and selects no model.

### Refresh, errors, and catalog facts

Each new spawn, place, or configure admission reads one effective settings snapshot and
retains the resolved values and source digest for replay. Ordinary callers use
custom session entries. Native host-dispatched creation requests use caller-conversation
documents keyed by request identity; local children retain selections in native
child-creation state. Configure uses target-conversation documents. The manager
awaits selection retention before host dispatch or task admission. A retry reuses
that selection even after file edits or target configuration changes. A fresh
handle or place reuse reports current target evidence without retuning it.
Catalog records retain only host metadata and their existing bounded projections,
with a 32768-byte envelope; execution selections do not belong in that envelope.
No compatibility reader or migration interprets catalog selection fields.
A later call sees later file edits without a host restart. No file watcher or
resolver file-read cache outlives the call. Registered descriptions persist until
a refresh boundary or explicit reload. File edits never retune existing agents or
change busy work.

An explicit model remains usable with an absent, malformed, or unreadable file;
its receipt preserves load diagnostics. Creation with neither model nor preset
fails when no effective defaultPreset exists. Unknown presets, including an
unknown configured default, fail with the requested name, file path/problem,
all valid preset names, and file digest (or `none`). No preset request silently
falls back to parent settings. Configure without a preset retains target values
when the file is absent or malformed. Existing handle/place owners remain
reusable without a default; creation selectors remain unapplied on reuse.

At read time, the extension checks preset and preference entries against the
current local catalog. Diagnostics report unknown models or providers,
unsupported thinking levels, exclusion matches, unknown preset names in the
substitution order, and context budgets above catalog capacity. Valid entries
remain usable. At dispatch time, the effective choice receives the existing
catalog check; an unknown selected model fails before creation.

Catalog facts are diagnostics, not roster enforcement. Exclusions are advisory
unless the operator sets `preferences.enforceRoster` to true. With that setting,
new spawn/place creation refuses an explicit model outside all preset models or
any selected excluded model/provider. Refusals list preset names and digest.
The setting defaults to false; the extension never activates it automatically.
Configure and reuse preserve their existing target semantics. The extension
never intersects choices with `enabledModels` or silently substitutes a model.
`contextBudgetTokens` does not impose an execution limit.
`quotaSubstitutionOrder` is guidance for model judgment.

### Model guidance and receipts

Base tool guidance directs delegation through `preset`, omission for the machine
default, and explicit `model` only when a task or direction requires an override.
The preset parameter descriptions list names, file state, and digest at tool
registration. Ordinary Pi supports `registerTool` replacement: the extension
refreshes these declarations at session start, prompt start, fresh control reads,
and before peer-message delivery. Pi invokes `before_agent_start` for both user
prompts and idle custom-message runs started by peer delivery. Both receive fresh
agent preferences and effort awareness before the first model request; these
sections remain present after tool results in that run. Startup counts as busy,
so another delivery joins that run rather than starting a competing run. Base
tool guidelines and parameter descriptions also deliver preset-first guidance.
Refreshed parameter descriptions and dispatch receipts supply current names and
digest.
No watcher exists. Native declarations refresh on explicit
host reload; native prompt sections and fresh receipts read current file facts.
Direct file edits between these boundaries do not imply instant declaration
refresh. Fresh, bounded prompt sections supply exclusion facts, context budgets,
substitution order, reporting notes, and diagnostics. Equal document and diagnostic facts render
identical text; observation times remain in receipts, not prompt sections.
Ordinary callers receive them through `before_agent_start`; native Durable callers receive them through
`durable.section`. Read errors render source diagnostics and current safe-default or environment
values instead of leaving previous preferences apparently current. Environment
presets remain usable when the document is absent or invalid.

Every spawn/place creation receipt exposes all valid preset names and the source
digest. Spawn, place, and configure receipts also expose the selected preset when
used, requested/effective thinking, unapplied fields, and diagnostics. An explicit
model has origin `explicit` and an override diagnostic, including whether it
matches no preset. Per-field origins distinguish `explicit`, `preset`,
`defaultPreset`, `retained`, and `default` values. An unapplied field is not a successful change
to the target's configuration.

The `/agent` work view's Help always starts with the file path,
absent/loaded/invalid/unavailable document status, full digest, diagnostics, enforcement setting, and every
preset name with its model. Reopen or the existing roster refresh updates these
facts. No new command is required.

## Configuration and storage

| Variable | Meaning |
|---|---|
| `PI_AGENT_DIR` | Pi configuration directory, otherwise public `getAgentDir()`. |
| `PI_MANAGED_INSTALL_ROOT` | Standalone terminal managed-install directory. Otherwise locate the managed `pi` launcher on `PATH`, then the install under Pi's agent directory (`PI_CODING_AGENT_DIR` or `~/.pi/agent`); read its `current-version` afresh. |
| `PI_AGENT_SESSIONS_DIR` | Agent store root, otherwise `<agentDir>/agent-sessions`. |

<!-- harness:settings:start -->
| Key | Environment | Type | Default | Constraints | Description |
|---|---|---|---|---|---|
| idleMinutes | `PI_AGENT_IDLE_MINUTES` | number | 5 | min 0; max 35791 | Idle host retirement interval in minutes; zero disables. |
| checkInMinutes | `PI_AGENT_CHECK_IN_MINUTES` | number | 0 | min 0; max 35791 | Automatic owner check-in interval for model tasks in minutes; zero, the default, arms none. |
| presets | `PI_AGENT_PRESETS` | json | {} | none | Named execution presets with exact model identities and optional creation fields. |
| preferences | `PI_AGENT_PREFERENCES` | json | {} | none | Delegation preferences, default preset, exclusions, planning budgets, and reporting guidance. |
<!-- harness:settings:end -->

Passive clients do not extend the idle interval. Per-call `checkInMinutes`
overrides the configured interval; operator admissions have no default check-in.
Invalid machine values use the declared safe defaults with diagnostics. Explicit
invalid call arguments still fail admission.

The ordinary factory publishes current configured fields on the public settings
bus. Native creation replaces that publisher with one bound to the native host's
agent directory on the same resource-loader bus. Ordinary shutdown disposes only
its factory publisher; native host cleanup owns the native publisher. Registry refresh reads current configured values and sources; it does
not retune existing agents, admission receipts, or host idle windows.

For an isolated idle preset trial, write a synthetic machine document with
`agent.presets.standard.model` set to an available exact model identity. Load
this entrypoint in a fresh ordinary process with an explicit fixture agent
directory and `PI_HARNESS_FILE`, then call `agent_spawn({ preset: "standard" })`.
No prompt means no model work. Native hosts use the same call with their supplied
`agentDir`. Inspect the receipt's preset, model, origin, source path, and digest;
an idle admission does not establish model response behavior.

Current storage lives under `<store>/durable/`: a bounded discovery metadata
record and a SQLite file for each storage, plus directory bindings. Metadata
locates a storage; native documents and entries remain authoritative for its
conversation state. The catalog record also carries the optional bounded `view`
published by its host and the host-local `recoveryDue` marker; neither is
storage identity, and host metadata strips both.

The view's optional `modelEvidence` envelope sits beside operational rows and
profile hints. Publication reuses each conversation's own `UsageDoc` and the
active entries already read for its operational row. Exact model buckets include
reported compaction-attempt costs; tool usage remains a separate total. A
conversation's current model never receives costs from earlier model selections.
Inherited entries do not count as a fork's own response or failure evidence.
Last-response times, usage samples, and failures come only from inspected
assistant messages with their own model identity and timestamp. Usage sampling
bounds entry visits, messages per entry, retained responses, and serialized
bytes; it adds no transcript scan to fleet reads. Current row errors and recovery
warnings carry observation time and current selection, not provider attribution.

Evidence has its own byte bound inside the existing view budget and never
evicts operational rows or profile hints. Retained coverage counts visited
conversations, unavailable usage, incomplete history, and omitted samples. The
mounted active entries do not prove complete retained history, so history
coverage stays incomplete. If even the evidence header does not fit, the
publication omits the envelope and fleet discovery counts that storage as
unknown. The strict operational row schema remains unchanged; readers that
ignore unknown view fields continue to parse those rows.

Directory bindings live in one
`PlaceBook`; native and
primary controls resolve the same binding, and the longest bound directory wins.
Host endpoints and claims live under `<agentDir>/durable-hosts/`; primary channel
endpoints live under `<store>/.primaries/`. Long Unix socket paths use a short
disposable path under the system temporary directory.

Old ordinary agent files stay on disk untouched. The extension does not migrate
or read them through a compatibility path. A process with the old manager
protocol requires a Pi restart before the changed controls load.

## Primary restart and continuity

`/restart` performs the ordinary Pi shutdown and restarts the CLI with its saved
session. It refuses unsaved sessions, active primary work, and unsupported host
modes. Independent Durable hosts continue. Other extensions' process-local work
still ends with the primary process.

Ordinary session shutdown waits for its own primary channel and endpoint removal
before process replacement. A status-display error does not bypass that cleanup.
Reload refuses an older retained manager rather than mixing lifecycle interfaces.
If an earlier process replacement left an endpoint registered under the still-live
PID, another `/restart` does not recover it. Fully quit that Pi process, then start
a new process with the same saved session. Registration replaces only a proven-dead
local owner; a connection failure alone never permits endpoint replacement.

Primary `agent_compact` requires an agent-authored summary and retains the whole
requesting tool batch. It uses the ordinary `turn_end` boundary. A native Durable
agent uses Durable compaction and its own task boundary, not an ordinary
SessionManager.

Tool and peer cards keep complete identities, including operation, thread, and
revision identifiers. Collapsed lines clip at the rendered width with `…`,
matching content previews. The clipped text and ellipsis retain their foreground
where a styled prefix fits, while the whole row keeps Pi's selected tool or
custom-message background.
The native expansion hint stays unchanged. Expanded source wraps and retains full
identities within the explicit source-display safety bound.
Compaction cards use execution-specific facts. A self request copies the public
context estimate, session name, selected provider/model/thinking, and supplied
summary size before it queues the boundary request. Later redraws do not read
new context usage or turn cumulative usage/cost into context size. Its queued
receipt does not prove completed compaction or post-compaction size.

Another conversation's host returns its observed pre-compaction name and
configuration, plus the selected model's known context window. Native Durable
context has no numerical token estimate in its public context view, so the card
omits token counts and percentages rather than deriving them from lifetime
usage. After a completed task places its summary, the host reports the retained
wrapped summary text size in UTF-16 code units. An admitted or unplaced summary
has no observed retained size. Optional name or size read failures retain the
compaction outcome and appear as body diagnostics. No path adds a transcript message to measure
post-compaction context; the card makes no post-size claim.

## Checks

Run focused tests with `node --test "extensions/agent/*.test.mts"`. The normal
repository gates are `npm run lint`, `npm run typecheck`, `npm run check`, and
`npm test`. `node scripts/extension-load-check.mts extensions/agent/index.ts`
loads the requested entrypoint through Pi's public discovery API in isolated
directories and fails on a reported load error or an unresolved entrypoint.

Live tool-card tests register cleanup before they render. A standalone native
codemode card is finalised with a settled result, and its conversation is
disposed in nested cleanup after that finalisation. A bounded child process
deliberately fails an assertion while a card is live and must exit with status
1, so a failed run cannot leave a renderer timer alive.

MCP authentication tests inject a lock driver to control acquisition,
compromise, and release at exact gates. One real filesystem test reclaims a
stale lock directory and holds the lock during its mutation.

Native tests exercise real Harness instances and faux providers. Creation,
retry, awareness, and live-tool fixtures use explicit temporary agent directories
and isolate ambient preference-file overrides. Process tests use SIGKILL during
a model request and after an unsafe effect through the production runner, then reopen and inspect retained admission and results.
Those tests cover their checkpoints, not arbitrary power failure or all models.

The standing-profile process tests use independent requester processes and the
production host runner with a socket-controlled faux provider. They exercise
profile tool use, compaction/reset/retirement continuity, alternate recipients,
report disposition, concurrent handle creation, replay, and operation-scoped
compatibility with a base-only process. `profile-base-contract-fixture.mts`
keeps fixed base operation identities but reads the installed coding-agent and
Durable versions, so feature-contract checks do not depend on a pinned upstream
release. Their stale-source correction is a scripted mechanical path, not
evidence of autonomous model judgment. Test-only
`PROFILE_TEST_ROOT` selects the isolated fixture directory; its default is
the OS temporary directory. Each fixture creates and removes its own temporary
subdirectory. The fixtures set their own `PI_AGENT_DIR` and
`PI_AGENT_SESSIONS_DIR` beneath that root.

The queue-recovery regression extracts the pre-profile revision named in
`queue-recovery.test.mts` through `git archive`; that Git object and `tar` must be
available. It runs the archived host source in an isolated process, admits a base
queue larger than the explicit-route limit, kills the process, and reopens the
same store with current source. A controlled provider verifies every retained
input and its completed receipt. The test also checks bounded route omissions
and a live profile mutation before the queue drains. The source archive is
removed with the fixture; no archived implementation ships in the repository.

### Ordinary-caller continuity

`host-continuity.test.mts` drives separate ordinary SDK callers in print mode
through the production host runner. A socket-controlled synthetic tool remains
blocked until the first caller exits normally. The test checks the retained
answer before a fresh caller reads it, then checks a follow-up after idle host
retirement and relaunch from the fresh caller's installation. It verifies SDK
and loaded extension installation bindings, not interactive CLI or live-provider
behavior.

This regression skips by default. It runs only when both
`PI_AGENT_TEST_PACKAGE_A` and `PI_AGENT_TEST_PACKAGE_B` are nonempty.

| Test variable | Value |
|---|---|
| `PI_AGENT_TEST_PACKAGE_A` | Absolute directory of an existing `@earendil-works/pi-coding-agent` package for the first caller, containing its `package.json`. |
| `PI_AGENT_TEST_PACKAGE_B` | Absolute package directory for the fresh caller. Its real path must differ from A, and its package version must match A. |
| `PI_AGENT_TEST_EVIDENCE_DIR` | Optional output directory for `evidence.json`, `callers.json`, and `continuity.jsonl`. Use a fresh directory because a run overwrites these files. Without it, cleanup removes the temporary fixture trace. |

From the repository root, replace the placeholder paths with your existing
package directories and chosen evidence directory, then run:

```sh
PI_AGENT_TEST_PACKAGE_A="/path/to/pi-package-a" \
PI_AGENT_TEST_PACKAGE_B="/path/to/pi-package-b" \
PI_AGENT_TEST_EVIDENCE_DIR="/path/to/continuity-evidence" \
node --test extensions/agent/host-continuity.test.mts
```

The fixture sets isolated `PI_AGENT_DIR` and `PI_AGENT_SESSIONS_DIR` values and
removes its temporary stores. The command uses existing installations; it does
not install or copy a package.
