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
  the manager does not retry unprotected mutations after transport loss. Requests
  with a declared replay-safe contract reuse their retained deduplication key. Final catalog
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
  healthy connection usable. A failed runtime-contract attachment disposes its
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

## Efforts, presence, and intent

An **effort** is a session's intent-driven work with its agents. **Presence** is
host-observed process and location information. **Intent** is a session's claim
about its purpose and next shared acts. A **shared substrate** is a resource
that efforts use, such as a repository, cwd, or the machine for a full-gate run.
These observations expose opportunities for cooperation; they do not grant
control over another effort or authority to act outside the operator's direction.

The existing primary endpoint records publish host identity, process liveness,
canonical cwd, Git common directory, start time, and sampled last activity. Git
worktrees share their common-directory identity. Activity comes from input,
completed tool execution, and settled turns, with at most one activity write
per minute. It is not a heartbeat; an idle record's old timestamp does not prove
process death. Only the existing local PID and host checks classify liveness.
Dead records do not appear as live efforts. Unknown and incompatible ownership
remain explicit. Discovery never removes primary endpoint records.

A primary without declared intent still has an observed purpose: its Pi session
name, otherwise an excerpt of its first interactive input. The extension retains
its own attributed input projection in the session. Resume discovery walks a
chain of at most 256 entries from the public leaf ID, without first materializing
the branch or full session. It does not interpret
another extension's prompts or entry formats. RPC and extension-generated input
do not become an operator-typed purpose. A resumed session with no name or retained
projection has an unknown purpose. If the bounded branch scan is complete, the
next interactive input supplies the fallback. If the scan leaves entries unread,
the current view marks the purpose unavailable instead of calling a later input
the first. A session name or declared purpose still supplies useful context.

`agent_intent` is an ordinary-primary tool. Publish with `action: "publish"`,
`purpose`, `integration`, `authority`, `scope: { paths, branches, fullGate? }`, and
an optional `contactThread`. Clear with `action: "clear"` alone. The tool declares
one object schema so models receive the action and publish fields directly.
Execution rejects missing publish fields and any publish fields on clear.
The host supplies the
claim's update time. Repository-relative paths use exact or component-prefix
matching, not globs. `scope.fullGate` declares a planned full-gate run; it is not
a reservation or lock. The endpoint's total byte bound still applies to a claim.
Publishing returns the recorded host facts, the labeled claim, and current effort
awareness. Clearing removes the declared claim, not the observed purpose. Update
or clear intent when integration completes so a finished plan does not remain current.

The bounded view lists live efforts on this machine within the configured
`PI_AGENT_SESSIONS_DIR`, including efforts in other repositories. It shows
purpose-level claims for those without a shared repository or cwd, and full
intent for those with either shared location. Shared locations
and declared machine-gate use are marked. Agents judge purpose-level relevance;
the extension does not infer intent from file names or coordinate work for them.
Carried operator directions appear as quoted, scoped claims, never as permission
for the reader. Active peer-thread hints appear newest-first within the covered
store records. Missing hints and unvisited records leave global recency unknown.

Ordinary primaries and Durable agents read this view through untargeted
`agent_status`. Their model context receives a separate current-effort section
at natural run boundaries. The section contains no relative ages or render-time
clock, so unchanged source state gives unchanged text. If no other live effort
appears, one line reports the empty or partial view and points to `agent_status`
when thread hints or unknown sources need detail. Awareness is available only
through this per-run context, explicit tool reads, and the Related efforts view.
Registration, intent publication, and intent clearing do not append unsolicited
transcript entries or send automatic effort notices. Endpoint publication and
local roster refresh remain independent of transcript delivery. Direct messages,
check-ins, and thread notices retain their existing delivery behavior. There is
no presence polling, file watcher, automatic model wake, or new store. Every view
reports its finite coverage and omissions.

Fleet and selected-session status do not read caller identity. An ordinary
overview uses it only for the optional effort-awareness section. If identity
is unavailable, that section is omitted and the agent overview remains available.

`/agent` opens Related efforts with `b` or its mouse hint. The view shows observed
purpose, declared purpose and integration claims, quoted operator direction with
scope, and active threads. A contact-thread link opens the existing Threads view.
The operator sends a direct quiet message to a live effort's primary from this
view. `agent_send` already supports direct model contact with that primary.
Delivery proves admission, not action, agreement, or a Durable task result. Use
one peer thread for a real overlap or agreement. Threads remain in a participant's
existing agent storage. The dashboard marks agents created by another session;
that marker describes provenance, not their current requester or task owner.
At 100 columns or wider, a narrow list sits beside the selected effort's details.
Press `i` to toggle coarse ages and local dates. In this side-by-side view,
clicking a detail timestamp uses the same toggle. Ages stay fixed until the next
presence observation; they do not tick during inactivity.

The ordinary manager interface changes independently of the primary delivery
interface. A retained manager with a different interface requires a Pi restart.
Effort awareness is a tool-only status addition; native host observation response
contracts and the primary channel's delivery contract remain unchanged.

## Agent collaboration and placement

Agent controls reach native conversations whose effective selection includes
them, so an agent can run its own agents. Placement without a handle is
decided at spawn time and stated in the result. An omitted cwd selects the
caller's cwd. The same canonical directory (compared by real path, with a
lexical fallback if realpath resolution fails) creates a conversation in the
caller's storage. A different cwd creates a new storage with its own host.
A new conversation inherits its creator's stored agent configuration and a
fresh profile; there is no generation-depth gate in the creation paths.

A no-target `agent_status` inside an agent appends a bounded newest-first
`Created agents` section and structured `createdAgents.agents` read from the caller's retained
creation record, with each recorded agent's identity, creation label, and kind,
and an explicit omitted count. This includes native spawns, recorded forks
and rewinds, and foreign spawns, not handles resolved as independent roots.
It is absent when the caller has none. It is not a recursive creation tree
or a current task roster. Live state and current names come from selecting
that identity. The public snapshot reads the retained document before the
projection bounds its output; it is not a bounded storage scan.

Lifecycle boundaries stay with the creating conversation. Its reset or ordinary
abort does not reach background agent work or its reporters; a background abort
crosses those boundaries within the storage. Compacting another conversation
aborts the native agents it reaches first; self-compaction does not. Idle host
retirement cannot proceed while same-storage agents hold live work. An agent's
foreign detached host survives its creator's host retirement. Result delivery reacquires a retired owner host. Answers,
reports, and check-ins follow each task's retained request route; the
creating owner is provenance, not a substitute when request routing is
unavailable.

Agents are eligible for the operator's bounded roster without a depth-based
exclusion. Catalog, storage-scan, and display limits still apply. The operator
can steer, abort, or reset a retained agent by canonical identity without routing
through its creator.

An answer settles a request; it does not represent a pause for later work.
Use report mode for interim progress. Put the substantive result or exact
blocker in the terminal answer, not a waiting note or a closing message that
points to an earlier answer. Settlement alone does not establish task
acceptance. Native `agent_await` holds the original request open for exact peer
results. Creation records do not define dependencies or authorize cancellation.

### Await exact peer results

Dispatch work in the background, retain each `result`, then call
`agent_await({ results: [resultA, resultB] })` in a native Durable conversation.
The request remains placed while its generation waits on the live tool. The
same request resumes with accepted outcomes and eventually receives one final
answer. The wait retains a host process, tool invocation, native documents, and
bounded observers; it makes no provider calls merely to wait. Storage usage is
not the awaited request's cost.

The tool accepts a bounded unique batch of admitted references. Same-storage
outcomes use native submission settlement. Foreign results use native settlement
only when their normal reply route names this recipient. A result addressed to
another recipient returns `unavailable`; observation does not steal its receipt.
Creation-only calls, reports, scheduled inputs, names, and thread posts are not
result references. Ordinary primary sessions keep background delivery and never
block on this tool.

Explicit send or steer, direct operator input, and a report from an awaited
agent release the wait after input admission. The input reaches the original
post-tools boundary. Apply it and await unresolved references again on the same
request. Failed admission does not release the wait. A failed or aborted
producer returns a typed non-success outcome and releases parallel waits from
that tool round without canceling other producers. A real conversation abort
stops the original request. Late named results remain retained without starting
another model run; a new explicit request still reads them.

Named-result check-ins are suppressed at the waiting recipient. Other check-ins
and scheduled messages remain queued follow-ups, even if their original mode
was steer. Requester check-ins about the waiting agent remain active. Passive
writes, including reset, wait for their normal native boundary; they do not
release the wait. Each return includes `queuedInputCount` from a committed inbox
snapshot, excluding writes and suppressed check-ins. More inputs may arrive
later; queued follow-ups retain their normal later runs.

When `agent_await` returns, it withdraws only still-queued delivery inputs wholly
covered by its returned results. It matches actual receipt and Reporter request
IDs. Coverage includes the full receipt group, even results for other recipients.
A grouped input that also carries other results stays queued. Original
request replay does not release its own wait.

Normal delivery stays independent. A late or already-placed copy remains possible
and costs an additional model turn. There is no recipient consumption ledger or
exactly-once contextual-delivery guarantee. Capped answers include an exact
`agent_inspect` continuation. Follow its entry and each returned `nextOffset`
until the continuation is complete.

Local cycle admission uses one consistent native transaction, including named
request lookup and bare-reference live/inbox membership. It refuses self-waits
and cycles inside this storage. Foreign edges end that traversal; it does not
refuse or solve cross-storage cycles. Safe replay reacquires observers from
retained declarations and durable outcomes without redispatching work.

Status, the dashboard, and existing check-ins project semantic `awaiting`
separately from native task state. Facts name held requests, exact result
references and outcomes, committed queued-input counts, and one-hop producer
waits. Producer facts state their source and observation time. Known reverse
edges to held requests show a likely mutual wait, not a complete remote graph.
Vector and byte bounds report omitted requests, results, and producers.
Unchanged semantic observations do not write new durable facts. Existing commit
notifications refresh the projection; no extra timer or recursive watch exists.

The selected pane appends current dependency facts to its scrollable display,
not to retained history. PgUp/PgDn reveals long dependency lists. Native frames
update and remove these facts without retaining a stale roster field.
The dashboard shows Awaiting rather than Responding and offers Release await
for that selected run. A stale run selection does nothing. Release returns
partial results on the original request without a new input or producer cancel.
Real abort remains separate. Native agent tool cards use the shared display-only
renderers; transcript rendering never grants execution. Adapted status and list
rows expose `forkSource`; exact upstream records retain their native fields.

## Standing agents and expertise

`agent_spawn({handle, name, role, model?, thinkingLevel?, prompt?})` resolves or
creates one independent root in the selected store. Supply the lowercase slug
without `@` when creating it; subsequent controls use `@slug`. The storage address
includes the canonical catalog directory and handle. Separate stores with the
same handle, cwd, and agent directory therefore select separate hosts. Exclusive
atomic catalog publication prevents concurrent creators in one store from
claiming different agents. The result states `created`. Reuse
never applies creation defaults to name, role, model, or reasoning. An explicit
conflicting cwd refuses instead of changing the retained directory.

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
- Codemode through public `CodemodeSandbox`, and MCP through public `McpClient`.
  Nested calls are Durable tasks with committed intent, validation, hooks, and
  retained results. Scripts remain unsafe after interruption.

Structured tool objects use `details.structuredContent` and an `outputSchema`
registration. A tool with an output schema returns explicitly supplied structured
data to scripts even when its result marks an error. A failed call without that
data throws its diagnostic text to the script. Direct image reads retain image
blocks. Script discovery uses
`searchTools`, `describeTool`, `describeNamespace`, and `ALL_TOOLS`. Tool
selection and MCP server configuration follow the current Pi settings.

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
remains on Pi's interactive or shell MCP controls. Native agents use the stored
OAuth client identity and tokens, including token refresh. Required sign-in
returns guidance for Pi's MCP controls rather than an interactive agent prompt.

## Controls

Answer-bearing `agent_send`, `agent_steer`, and prompted `agent_spawn` return
`result: { sessionId, submissionId, requestId? }` after native admission. The
reference names the canonical conversation and its actual admitted submission,
not a Reporter task, creation record, name, or latest answer. A known request ID
is retained and must agree with the submission. Local, foreign, handle, and
ordinary-primary dispatch expose the same reference in text and structured
Codemode output. Dispatch stays in the background; admission is not settlement.

Creation-only spawn, reports, scheduled inputs, thread posts, and messages
between ordinary primary sessions do not produce native result references.
An ordinary primary remains responsive and receives normal routed results.

| Tool | Effect |
|---|---|
| `agent_spawn` | With `handle`, resolve or create one standing root and return `created`. Otherwise create a root storage; inside a Durable agent, the same cwd uses a native conversation and a different cwd uses a new storage host. An optional prompt starts work. Model tool tasks get automatic owner check-ins; `checkInMinutes` sets the interval and 0 disables it. |
| `agent_await` | Keep the original native request open for exact admitted results without model calls merely to wait. Explicit interaction releases the wait with partial outcomes. A real abort stops the original request without canceling its producers. Ordinary primaries refuse this native-only operation. |
| `agent_send` | Admit a task or correction. `mode: "report"` sends an explicit recipient a notice without an answer route or check-in task. Busy recipients receive steer at the next tool boundary by default; For Durable agents, `mode: "followUp"` and `mode: "report"` wait for the current run to end. Model-origin reports to ordinary primaries use steer. Report receipts state this boundary and point to steer for changes to busy work. Unanswered model tool tasks get automatic owner check-ins; `checkInMinutes` sets the interval and 0 disables it. With `deliverAt` (an absolute ISO 8601 time) and an optional `mode` (`followUp` by default, or `steer`), schedule the input as a durable timer instead. |
| `agent_steer` | Admit steering through the recipient's storage owner. |
| `agent_abort` | Abort the selected conversation without deleting its retained evidence. With `timerId`, cancel only that scheduled input. |
| `agent_reset` | Start a new context for the selected conversation with an optional handoff note. History, identity, files, settings, and timers stay; no model turn starts. |
| `agent_attach` | Connect to the owner without a new prompt; retained unfinished work resumes. An explicit model is applied first; a failed configuration returns its failure instead of a status snapshot. |
| `agent_configure` | Change an idle conversation's name, exact model, or reasoning level. |
| `agent_profile` | Read a complete bounded profile, or update role and expertise with `expectedRevision`. Reads start no host. A conflict returns the current profile without a change. |
| `agent_fork` | Create an idle native fork at an entry or current leaf. |
| `agent_rewind` | Fork before a mistaken entry and submit a correction. Files remain current. |
| `agent_compact` | Abort another conversation's active work, then run native compaction. Self-compaction uses its completed tool boundary. |
| `agent_command` | Invoke a contributed command, reload host registrations while idle, or fork to a tree entry. |
| `agent_place` | Resolve the longest directory binding, or create one, with optional work. Model prompts use the same check-in default on both paths; optional `checkInMinutes` overrides it and 0 disables it. |
| `agent_list` | Page through stored identities and conversation metadata. Search includes retained handles and role hints; profile coverage remains explicit. Reads start no host. |
| `agent_status` | Read conversation and host state, including capability limits. A selected session lists its pending timers, nearest deadline first. `view: "fleet"` reads sampled machine-local model evidence without a session target. |
| `agent_inspect` | Read bounded native entries, activity, branches, literal search, or retained results. |
| `agent_collaborate` | Discover, create, read, join, leave, post to, revise, or close a shared peer thread. Joining subscribes to passive notices; only explicit `notify` recipients get a model wake. |

Each `agent_list` call collects one bounded catalog batch before it observes
hosts. Continuations retain both the native page position and the last visited
catalog filename. Catalog discovery sorts filenames and resumes strictly after
that name, so view publications and record creation or removal do not invalidate
continuations or repeat records. Repeat the same query and cwd with a cursor;
a different query or cwd is refused explicitly. `agent_list` reports each
unreadable catalog record in `coverage.unavailable`, even when
`coverage.complete` is true.

Discovery is not a frozen snapshot. Each page lists the current directory names,
then bounds entry visits and record reads. Records created behind the cursor,
or changed to match a filter after their name was visited, appear on the next
fresh scan. Removed records are absent. Complete catalog coverage means the end
of that page's sorted directory listing was reached, not that all pages observed
one instant. Dashboard and cross-storage thread discovery use the same catalog
continuations.

Agent hosts have process lifetimes independent of the primary. There is no
separate detach operation or detached-run registry.

### Tool cards

All tool and peer cards use one layout. The first header line shows the tool
name or message kind and the target or sender label. The muted second line shows
known provider/model, thinking level, and other secondary facts. All card kinds
use the same `provider/model · xhigh` form, without redundant `Model:`,
`thinking`, or `reasoning` labels. Ambiguous values retain labels such as
`submission 2987` or `mode report`. Missing facts create no placeholders.
Targeted cards use the retained `@handle` or display name. Duplicate display names add the full identity when neither handles nor
model settings distinguish them. Unobserved targets use the full identity or
the supplied `@handle`; only the rendered width clips a collapsed line.
The synchronous lookup uses roster facts already observed by the primary footer;
it opens no storage and starts no host. Each native row retains its own result
observations so its header reflects applied settings without a discovery read.
Tool cards retain Pi's native padding. Peer cards supply the same inner top and
bottom padding, while Pi supplies their outer separator.
The manager contract is `manager/1.5.0`; a reload over an older retained manager
refuses agent controls and requires a Pi restart.
Expanded cards retain full IDs and the complete result within the display bound.

A collapsed card has at most one expansion hint across its call and result.
Before execution, the call owns the hint; after execution starts, the result
owns it. The native-style `... (ctrl+o to expand)` hint applies to the whole
card, not just its result. Expanded cards show no expansion hint. Expanded
messages use the plain `Message:` label.

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

A blank configure name clears the stored name. Spawn and configure accept
`thinkingLevel` values `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and
`max`. Native attach accepts the same levels alongside an explicit model.
An exact `provider/model` is validated against the configured catalog, and the
requested reasoning level is clamped by Pi to the model's supported levels.
Configuration requires an idle conversation, starts no task, and changes no
global defaults. A mutation result carries a compact status:
identity, conversation, name, cwd, busy state, model, and the capability limits
that matter. The full status stays available through `agent_status`. If the
post-mutation status read fails, the result carries `snapshotError` and the
successful receipt stays.

The `/agent` control actions return short human text and, when an action creates
or selects an agent, that agent's identity. Observation actions (`list`,
`status`, `inspect`, `profile`, `places`) keep their retained evidence. `/agent send`
admits a follow-up when the target is busy; `/agent steer` admits steering. The
model-facing `agent_send` tool keeps its documented steering disposition. The
status card labels its newest text by role and state: `Latest reply` or
`Latest input` when idle, and `Working on reply` or `Working on the task` while
active.

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

`create` needs `title`, `purpose`, `authority`, `source`, `restrictions`, and
`acceptance`; `integrator` defaults to the caller. An ordinary primary also
selects an existing participant with `sessionId`. Native agents default to
their own storage. `join` records a self-chosen `contribution`; another join
revises it. `post` accepts `message`, optional `replyTo` event sequence, `source`,
and explicit `notify` identities. `read` returns the current frame, members,
chronological events, pending notice count, and `nextBefore` for older pages.
Reads do not start a host or model. Events record their sender, origin, frame
revision, and reply reference.

A frame is an attributed statement, not authenticated authority. A
`carried-authority` post requires a source, but its label does not grant
permission. Preserve the original operator decision and restrictions; challenge
unsupported claims in a post. The creator, integrator, or operator can `revise`
the complete frame. Revisions remain in the exchange; compare an event's
revision with the current frame. The integrator is revisable, not a compulsory
role in a fixed plan. Participants can split work into another thread, leave,
or `close` with a retained conclusion. Closing ends mutations, not history.

Creating or joining opts into passive notices for later events. Each notice
contains a bounded excerpt and a thread/event reference. A native write places
it at an existing conversation boundary without starting a model turn. An idle
peer learns it on later work, not immediately. Only named `notify` recipients
receive steering and a model wake. No post or notice arms a check-in. Leaving
stops future subscription notices. Notification admission and acknowledgment
do not prove model awareness, understanding, or acceptance.

The event, mutation receipt, and notice intents commit together. Retries reuse
caller-qualified mutation IDs and recipient-qualified native request IDs;
changed content under the same mutation key refuses. Direct notices never
broadcast to unrelated primaries. An unavailable recipient leaves a visible
pending intent and delivery error. Pending delivery keeps the source host
alive. Source-host retirement or process loss does not delete the thread;
retained reads stay available and a later mutation or recovery opens its owner.
This has the same process-crash, not power-loss, guarantee as other native
state. A primary process restart can repeat a displayed notice after loss of
its in-memory deduplication.

Each call bounds visits, records, and bytes. A thread frame and membership fit
within 24 KiB, each event within 20 KiB, and a read page within 48 KiB. Global
hints are not an exhaustive search of retained history. Explicit coverage and
scoped continuation are part of the result, not a claim that absent matches
do not exist.

In `/agent`, press `t` for Threads. Select a thread or an omitted-source row
with arrows and Enter; `s` scopes discovery to the selected agent's storage.
Use `p` to write a post without a wake, or `n` to select notify peers. Tab moves
between recipient selection and the editor; Enter submits from the editor.
Use `b` for earlier events, `r` for the latest page, `f` for the frame, and `e`
for the exchange tail. At the exchange tail, new events stay visible. Frame
and earlier-page reads keep their position. Esc returns through Threads to the roster and native
primary. Drafts, agent selection, and focus stay intact. The view shows frame,
contributions, attributed chronological exchange, revisions, and coverage.
Thread event times share the [roster's time display](#roster-and-coverage).
Catalog publishers notify open roster subscribers, including readers with no
attached host. Those notifications refresh the open Threads view after an
external process publishes a change.
Observation starts no host or model turn and adds no polling loop. The observer
closes with its last subscriber. A refreshed thread list or peer list rejects
old mouse positions until the new rows render.

## Recovery and delivery

An admitted input has a stable Durable request ID. Reconnecting or retrying the
same admission reuses that identity. A pending delivery intent precedes input
admission, so a crash between those operations does not lose the reply route.

Task admission preserves the caller's original text and images in native user
messages. Host-authored routing evidence holds requester, reply recipient,
request ID, and origin separately. A native prompt section projects active routes
with bounded task previews, including after compaction, rather than treating the
last arriving caller as the requester. The dashboard shows the original task.
Profile shows a bounded view of unfinished routes on demand, with
`requestsOmitted` when further routes are retained. Routes outside the projection's
field limits are counted as omitted, never shortened. Prompt and Profile bounds
restrict presentation, not the accepted queue.

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
Base-only calls preserve
an absent origin and refuse an explicit alternate recipient rather than ignore it.

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
stay separate. The watcher acknowledges the receipts for accepted owner routes
in one commit. An offline owner stays pending while live owners receive their
normal notice and wake intent. Reports remain separate. A catalog owner receives an untrusted
follow-up in its own host. A conversation in the same storage as the source
receives the answer as an in-storage follow-up, never through a primary route. A
noncatalog owner is an ordinary primary reached
through its registered primary channel. Only an absent or proven-dead owner
endpoint permits fallback: the watcher broadcasts to every live primary within
one bounded discovery of registered endpoints, and each delivery is labeled
`no live owning session` while the original owner identity stays in the message
details. These copies are informational and never acknowledge the owner row.
Each accepted fallback recipient is recorded in the retained row, so subsequent
passes and host reopens do not repeat that copy. Other owners of the same answer
receive their normal delivery rather than a fallback substitute. A partial or
unavailable scan leaves the row pending and reports that coverage explicitly.
A live or unknown owner endpoint refuses fallback and retries. An owner endpoint carries the primary channel contract version. A host
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
primary does not poll receipts. Delivery is at-least-once; stable
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
A notice names an agent by its display name or handle, with its full identity
as the unnamed fallback. An ordinary session uses its session name, observed
purpose excerpt, or full session ID. Identity text is not shortened to a fixed
length; a headline clips only when it exceeds the rendered width. Direct messages carry the sender's
current name and published purpose. Foreign thread senders use their exact
retained agent row or published primary endpoint without a host launch or
discovery scan. A dead primary descriptor retains its parsed sender metadata;
its published configuration is not a live-state observation. Missing source
evidence does not classify a report sender as an agent. Thread notices show
the thread title and sender; their display
body comes from the defining event, while stored model content stays unchanged.
The first header line uses plain kinds: result, still working, report, thread
notice, or message from another session, followed by the sender label. The muted
second line contains known model, provider, thinking level, check-in elapsed
time, cost, and thread title. Missing optional facts produce no unknown or
unavailable header fields. Expected reports and direct messages omit the unsaved
result warning; genuine failure warnings remain in the body.
The collapsed answer uses a short visual-line preview, with one Pi expansion
hint only when text is hidden and no separate ellipsis row. The shared layout
adds the same inner top and bottom padding as Pi tool cards, with no collapsed
navigation instructions. Expanding the notice shows the full
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

### Current process contracts

`recovery-state/1.1.0` is the response contract for the separate `deliveriesActive`
field. `deliveriesPending` still reports all pending rows and governs marker
clearance. `manager/1.5.0` includes exact admitted result references and releases recovery links when
only parked delivery remains. Restart Pi windows to load that manager behavior.
The recovery-state request and primary-delivery contracts are unchanged.

`version-contract.ts` separates source release, actual loaded upstream releases,
and operation contracts. A host advertises its descriptor in readiness and
`runtime-contract`. Each operation names its current request and response
contract. Client and host compare those identities before dispatch; a mismatch
refuses that operation before a mutation or response decoding. Unchanged
operations remain usable across independently restarted Pi windows and hosts,
including mutations. Release ordering never grants or denies an operation.
Profile reads, revision-checked updates, enriched discovery, handle resolution,
and rich task admission have separate feature-scoped operations. Base wire rows
and top-level host metadata remain unchanged. Optional profile hints live inside
catalog `view`, outside those base schemas. An older host refuses only unsupported
features; ordinary base operations remain available in both process directions.

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

An open live observation reconnects only to a live host. It never relaunches a
lost host; it signals unavailable and leaves relaunch to bounded manager
recovery. A listener attached after a frame arrives receives that current
frame at once. Live status and dashboard tails expose only the declared
tool-call fields, including parsed arguments and optional namespace/signature
fields. Provider parsing buffers do not enter these live projections; raw native
state stays unchanged. A status schema error alone does not establish different
process versions.

When a model-error run ends with queued inputs, the host submits a passive
status write through Pi Durable's public conversation API. The write places
queued inputs at a final boundary and starts their next run. It tells the model
the previous error and identifies the notice as host status, not an operator
instruction. The failed original input remains unanswered. Native queue modes
still select one or all follow-ups.

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
opening finds pending native work or pending delivery. Startup recovery reads
only that marker from bounded catalog pages; it does not open, copy, or
status-probe every storage. Recovery acquisitions run at most two at a time. A
transient recovery link closes when the internal `recovery-state` check reports
no pending native work and no active delivery; host change notifications trigger
that check, not polling. A row addressed only to a proven-dead ordinary primary
waits in durable storage without a recovery link or a delivery retry timer. The
host retires normally and keeps `recoveryDue` set while that row remains pending,
with or without a live fallback recipient. Any primary registration runs the
existing bounded recovery scan; a resumed owner with the same session ID receives
its pending notice. A recovery-state read requests a delivery scan even if the
source host is still up, so owner registration before retirement also resumes
delivery. Other registrations never repeat a recorded fallback copy.
Live, unknown, incompatible, absent, and catalog owner routes remain active and
keep their existing retry and retirement behavior. No row expiry or new catalog
scan bound is introduced. The marker clears only on a clean
close with nothing pending, after final catalog publication. Clean retirement
closes cached manager and peer delivery links without a recovery acquisition or
crash-budget charge. Native shutdown releases the writer claim before the
transport closes. A retained delivery marker with a released claim does not
trigger automatic recovery. Busy native shutdown retains its claim until
process death, so unexpected loss still recovers native work. Footer totals
remain in the catalog; later reads use cold storage without a writer, and later
controls acquire a fresh host.

Cold `agent_status` returns retained conversation data with `live: false` and
`storageId`. It omits `pid` and `inventory`: the reader loads no host, so its
process identity and loaded capabilities are unknown, not empty. Live host status still
includes its process identity and actual loaded inventory. Cold inspect views,
transcript snapshots, and dashboard rows read the same retained storage without
starting a host or a model turn.

While a primary remains registered, an unexpected host connection loss rereads
that marker and queues recovery through the same bounded pool. The manager owns
these relaunches; managed connections do not independently relaunch on request
retries. Three automatic replacements are permitted per storage within sixty
seconds. Further losses stop automatic recovery and put a host error in the
dashboard roster. Inspect the error, then use `agent_attach` to clear the
stop and retry. Intentional disconnects and unmarked storage do not relaunch.

## Dashboard and agent console

The dashboard is one full-screen overlay. It observes agents and effort presence,
not primary conversations. It reads no primary draft and writes no primary editor
text. Selection, drafts, successful-message history, reading positions, and
Steer/Follow-up disposition and pane layout survive closing and reopening in
the same primary process. Different primary sessions have independent UI state.
Stable pane preferences also survive Pi restarts in the agent-owned
`agent-dashboard-layout.json` file under `PI_AGENT_DIR` or Pi's agent directory.
Only completed resize gestures, keyboard commits, and resets write this private
file through an adjacent temporary file and atomic rename. A failed save keeps
the local split and shows a restart-persistence notice. Fresh primaries load the
last completed save; existing windows keep their own split. A successful
admission clears only the submitted draft revision, including after the
dashboard reopens; newer text stays. Every truncated dashboard list keeps the
focused entry and nearby entries visible and states the hidden count.

Each view has a framed heading and one plain hint line at the bottom. Keys use
an accent color; action words and metadata use a quieter color. All key hints
use lowercase text, including subviews, and retain their click actions. Scroll
controls come first and `esc` comes last. Time format remains available through
`i`, a click on a time, and Help. The roster omits the time-format hint.

At side-by-side widths (100 columns or more), the roster occupies the full body
height. Drag its border or the blank gutter immediately to its left to exchange
width with the detail pane. The roster keeps at least 24 columns and the detail
keeps at least 60. The default roster remains narrow; an explicit split saves a
ratio. Narrow stacked windows suspend this handle and retain the ratio for a
wider window. Temporary clamps never replace the saved preference.

Where height permits, drag the small three-cell grip at the composer's top-right
corner upward for more draft rows or downward for more transcript rows. Explicit
height reserves at least five draft rows and six transcript rows, plus the
native frames and blank separator. Short windows bound the automatic draft
height without discarding the saved row preference. Optional transcript separators
disappear only when the height needs that space for warnings, the editor, the
status block, and the hint line. The useful caption and native editor remain intact. Double-click either handle to reset only that split.
Other rules and borders remain decorative.

From roster navigation, `r resize` enters keyboard resize mode. `tab` selects an
available divider. Left/right adjust roster columns; up/down adjust draft rows.
`0` resets the selected divider, `enter` commits, and `esc` restores the starting
split. Message fields keep `r` literal. Escape first returns from a full console
to the roster. Resize cancels on terminal dimensions or screen changes, hiding,
or disposal. After a lost release, subsequent input clears the local gesture.

The conversation header shows the selected agent's handle and name, with its
state mark on the right. An attention reason or conversation warning appears
under the identity. Model and usage facts appear only below the composer,
including in the full console. No status band separates the transcript from
the composer.

Heading counters describe the loaded selection or current thread page, not an
unknown global total. A `+` marks incomplete loaded coverage. A scrollbar shows
the position within loaded conversation content. The header rule stays blank
at the live tail; away from it, the rule states the distance below or the action
to load an earlier or newer range. Estimated heights say `about`. The transcript
keeps blank space above the composer, including at the tail.

Conversation content uses Pi's native renderer. Built-in tools retain native
cards. Other tools use an inert display definition owned by this extension,
with a single-line call summary and an output preview bounded by visual rows.
A quiet hidden-line count marks omitted output. Ctrl+O expands arguments and
output; Ctrl+T controls thinking. Stored tools never load another extension's
renderer or execute through the display definition.

The native editor caption contains only the delivery effect: `steer at next
step` or `follow-up after answer` for a busy target, and `send` otherwise. Native
hidden-row counts and the resize grip retain their space. The delivery receipt
uses the bottom border.

A two-line status block sits under the composer in roster preview, message view,
and full console. Its first line uses the primary footer's presentation: the
model registry display name, a colored `[level]` only for a reasoning-capable
model, a ten-cell `█░` context bar and percent, context tokens over model window,
`~$` recorded cost, and `● NN% hit`. Dim `│` separators divide the fields. The
bar uses success through 60%, warning through 80%, and error above; it fills at
100% but retains overflow percentages. These are display bands, not compaction
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
Cache-free or unavailable totals produce no cache field.

Elapsed, when available, means time since the agent's placed input started its
current run, not process attach age. The current host observation exposes no
placed-run start, so elapsed is omitted. The UI never substitutes overlay age,
last activity, or the latest user-turn duration. Unknown facts have no
placeholders. Narrow widths remove cache rate, cache dot, token count, then
cost; model and context bar stay to the end, with width clipping as a final
guard.

Line two shows the agent's home-relative cwd and its cached Git branch. It
shortens the path from the left before shortening or omitting the branch.
A `+1` cell marks a delegate segment hidden by width.
When loaded catalog rows identify that agent as their creating owner, a final
`agents: active/total active · ~$cost` segment counts only those delegates.
A `+` marks incomplete loaded coverage; unavailable child costs are absent.
An absent child observation is not a zero global count. These figures never
use the primary's own fleet total. Git reads use a bounded subprocess without
a shell, cache a bounded set of cwd values per overlay, and refresh only on
selection, cwd changes, or committed-entry events. In-flight events coalesce; disposal and
cache eviction abort pending reads. No Git polling or duration tick exists.

The frame preserves native keyboard input, text selection, caret placement,
and drafts. The status block reserves its own rows outside the editor's mouse
target. Below side-by-side widths, compact roster rows sit above the same
header, transcript, composer, and status block.

In Pi fullscreen mode, click a roster or task row to select it, then click the
`enter` hint to open it. In Threads, click a row to select it; click the selected
row or the `enter` hint to open it. Click action rows to select, then the `enter`
hint to run the action through its usual confirmation flow. Click a message
field to focus it and place its caret. A click in the conversation opens the
agent console. Visible hint labels retain their keyboard actions; arrow and
page hints have separate click targets for each direction. Click a thread's
notify checkbox row to change the recipient selection.

The wheel scrolls the pane under the pointer. Roster scroll does not change
the selected agent or the message recipient. Conversation and thread scroll
leave the editor focus and drafts intact. Outside the two-cell roster handle
and small composer grip, press, drag, release, modified clicks, and multiple
clicks remain available to Pi's native text selection. Handles capture only
unmodified left-button resize gestures, without changing editor focus.
Dashboard actions use completed unmodified single clicks. A drag does not activate a
row, timestamp, or hint. Pi retains control of copy-on-select and links.
Regular terminal mode leaves mouse input to the terminal. All actions retain
a keyboard path; no mouse setting or global shortcut is added.

The New agent field accepts a task in your own words and treats it literally,
including text such as `--help`. Enter starts the agent
with the primary's current directory and model, selects it, and keeps the
dashboard open. Its task, model, and reasoning appear immediately with a
Starting state in the flat roster, before the host is ready. The conversation
then follows the host's live output. A late startup completion never moves a
selection the operator has changed since. Esc keeps the unsent task. Configure
changes name, model, and reasoning afterwards; staged fields change nothing
before Apply. Model search uses available model metadata, not a typed model
identity. Esc in the model picker returns to its saved search, and the Model
and Reasoning pickers start on the completed values. An owner refusal returns
Configure to its staged fields; Cancel abandons that configuration.

Actions apply only to the selected agent. They expose Stop current work,
Configure, Tasks, Fork, Rewind, Reset context, Schedule message, Scheduled
messages, Compact, Reconnect, Run agent command, Profile, and Details. Disabled
actions state their reason. Profile remains available while an agent works. Stop, Reset, Rewind, and Compact confirm with Cancel selected.
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

Profile shows the canonical identity, optional immutable handle, display name,
role, actual model and reasoning, creator as provenance, directory, revision,
update evidence, and retained current request routes. Requester and reply
recipient remain separate. Cold profiles are labeled retained and reads start
no host. Saved expertise opens on demand with `v`; it is evidence, not fresh
authority. Arrows, PageUp/PageDown, Home/End, and the mouse wheel read the full
text at the available width. Click an action row to invoke it.

Use `r` to edit the role or `e` to edit expertise in Pi's native editor. A blank
submitted field clears it. `s` saves the staged draft; `u` reads the current
profile; `d` discards the draft; Esc returns to Actions. Native editor Cancel
leaves the completed draft unchanged. Save checks the revision from the read.
A conflict keeps the draft and requires a fresh read, followed by explicit
selection of the displayed current revision before another Save. Closing and
reopening Profile keeps staged fields within the current primary session and
process. These fields neither replace the message draft nor alter the primary
editor. `/agent profile <identity-or-@handle>` opens the same view and edits;
outside the interactive terminal it returns the full profile as text.

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
not every rendered line. A partial transcript also shows its first input from
the published summary, explicitly labeled historical rather than the current
role or task. Blank runs between chat blocks reduce to one blank line.
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

Agent model parameters carry shared selection guidance: apply current task
directions and the operator's route, budget, and role preferences, then verify
the exact model identity and its supported thinking level. Configured access
does not establish operator use. The extension carries no preferred provider
roster or model ranking.

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
Roster blocks show a bold name and state glyph with the last-change time at the
right. The model and thinking level appear on the second line with cost at the
right; activity or the latest text appears on the third line. Compact rows use
the same fact order on one line. The provider belongs in the selected header,
not in each roster block. A continuous marker identifies the selected block. Working activity uses normal text; finished excerpts use muted
text. State glyphs and written state words retain their state colors. Attention
reasons stay prominent and use the plain background for readable error text.
Working and Done labels do not repeat the glyph. A footer distinguishes
more loaded rows outside the viewport from the Load more agents catalog action.
Times default to `just now`, `15m ago`, `3h ago`, or `1d ago`, with no seconds
counter. These ages describe recorded changes, not current activity.
Press `i` in the roster or a thread, or click a visible time in fullscreen mode,
to switch every dashboard time to the absolute local date and time, such as
`Oct 4, 2026, 12:01 PM`. Neither form has an `Updated` label or a local suffix.
Exact time shares the activity line at the right of each wide roster block;
activity shortens to fit, and the name and model retain their own lines. Both
time modes keep three-line wide blocks and one-line compact rows. The same
choice applies to thread event times and survives close and reopen in the same
Pi session and process; it is not saved to disk. A retained
`@handle` leads the label, followed by the display name when it fits. A historical
first input is a labeled fallback, never a standing role. Duplicate labels receive unique
identity suffixes. Unknown cost shows `$?`; a known partial cost shows a trailing
`+`, such as `$1.00+`, in the selected-agent footer and roster rows. Roster totals
use the same marker, such as `$1.50+ retained`, for a known subtotal with incomplete
cost or inventory coverage. These totals keep their roster scope.

The roster is one flat list ordered by recent activity, with identity as the
tie-breaker. State glyphs replace group headers. Failure text uses the actual
retained error, without a `Work failed:` prefix. The host publishes the native
unanswered submission's error detail, or the last assistant error, in the
existing error field. A delivery receipt defines the outcome only while no
newer input supersedes it; an unowned report still changes the current outcome.
Attention names unavailable or conflicted storage, a host error, failed compaction, failed work with an error, or exhausted retries. Done
and deliberately stopped work do not require attention by themselves. The selected view shows the one concrete Attention
reason. Selection follows identity, not roster index, and roster order stays
fixed during an arrow sequence. Text entry locks its recipient even while
published metadata changes.

Coverage carries `complete`, `storagesVisited`, `skipped`, `omitted`, and
`nextCursor`. The roster footer shows short muted counts such as `18 unreadable`
or `2 omitted`; an incomplete page also keeps the title’s `+` marker. These are
roster facts, not selected-agent warnings. Unreadable or missing views remain
unknown, not absent. Load more agents continues the cursor; narrow footers
shorten the action to More. Find searches loaded
handle, role hint, name, historical first input, path, model, state, and identity,
not transcript text. Find
previews the selected match before the filter is committed; Esc restores the
previous filter and selection. A filter with no match is not an empty store:
Enter does nothing and Esc clears the filter. An empty page or missing view is
not proof of absence. A dead or absent writer claim marks
previously working retained metadata Interrupted. Claim errors remain explicit.
Host health belongs to the publication time; later publications clear it.
The manager adds current recovery errors without rewriting published views.

Profile hints are a separate retained catalog projection joined by canonical
identity, not added fields in base host observation rows. Missing hints mean
unknown profile coverage, not an empty role. `agent_list` reports
`coverage.profileHints` even on an empty match page: omitted hints and storages
with unknown hints qualify the search. Hints contain no expertise bodies and
may shorten a role. Use Profile for the complete bounded role and expertise.
Exact handle resolution does not depend on roster or list completeness.

Host notifications coalesce roster refreshes. A bounded metadata reconciliation
while the dashboard is visible discovers hosts created elsewhere and dead
claims. Neither path repeatedly reads transcripts. Streaming paints coalesce;
local input paints immediately. Closing releases observers and UI timers.
A failed refresh keeps the last good roster. A transient failure stays quiet
when rows remain available; repeated failures or an empty roster show a notice
on the roster’s last line. A successful refresh clears that notice.

The primary status line and dashboard heading use the same session scope:
agents created by the current primary session plus agents reached through
retained creation records. Other primary sessions and unrelated retained agents do not
contribute to these figures. The roster still lists discovered agents across
sessions. The status says `agents: <working>/<total> active · ~$<cost>`
and disappears when no session-scoped rows are found. The numerator counts only
`working` rows; the denominator includes all states in scope. Each registered
primary receives its own figures. The dashboard reuses its scanned roster page
for these figures without another catalog scan. Repeated reads never add the
same usage twice. These figures cover this session's readable agent data. The
`~` marks a recorded-pricing estimate, like the main session cost, not a billing
statement. Cost uses two decimals; the entire cost segment is hidden below half
a cent, leaving, for example, `agents: 0/1 active`. The dashboard shows unreadable
agents and partial costs.

## Primary restart and continuity

`/restart` performs the ordinary Pi shutdown and restarts the CLI with its saved
session. It refuses unsaved sessions, active primary work, and unsupported host
modes. Independent Durable hosts continue. Other extensions' process-local work
still ends with the primary process.

Primary `agent_compact` requires an agent-authored summary and retains the whole
requesting tool batch. It uses the ordinary `turn_end` boundary. A native Durable
agent uses Durable compaction and its own task boundary, not an ordinary
SessionManager.

Tool cards keep complete identities, including operation, thread, and revision
identifiers. Collapsed lines clip at the rendered width; expanded source wraps
and retains full identities within the explicit source-display safety bound.
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
storage identity, and host metadata strips both.

The view's optional `modelEvidence` envelope sits beside operational rows and
profile hints. Publication reuses each conversation's own `UsageDoc` and the
active entries already read for its operational row. Exact model buckets include
reported compaction-attempt costs; tool usage remains a separate total. A
conversation's current model never receives costs from earlier model selections.
Inherited entries do not count as a fork's own response or failure evidence.
Last-response times and failures come only from inspected assistant messages
with their own model identity and timestamp. Current row errors and recovery
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

## Checks

Run focused tests with `node --test "extensions/agent/*.test.mts"`. The normal
repository gates are `npm run lint`, `npm run typecheck`, `npm run check`, and
`npm test`. `node scripts/extension-load-check.mts extensions/agent/index.ts`
checks extension loading in a fresh process.

Native tests exercise real Harness instances and faux providers. Process tests
use SIGKILL during a model request and after an unsafe effect through the
production runner, then reopen and inspect retained admission and results.
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
