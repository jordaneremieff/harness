# agent

Create and control ordinary Pi sessions from another Pi session. Each session
uses Pi's public session services, `AgentSessionRuntime`, and `SessionManager`.
Pi owns resources, context, model requests, extension events, queues, and
compaction. The primary session stays available while the agent works.

Managed sessions load Pi's exported `codemode`, `tool-search`, and `mcp` built-in
extensions with the same names and replacement rules as the CLI. At the same
working directory, native project trust, `-builtin:<name>` settings, and
`defaultTools` govern them as they do for a primary. `codemode` and `tool_search`
register inactive unless settings or configured MCP servers activate them.
The MCP extension reads `mcp.json` from Pi's agent directory
(`PI_CODING_AGENT_DIR`) and starts connecting configured servers in the
background through the native session-start hook. Neither worker creation nor
the first prompt waits for a server with the default `codemode` exposure,
including one that never answers `initialize`. The first model request lists
such a server in the `mcp_servers` system-prompt section, and the configured
server has already activated `codemode`. Server tools are not declared to the
model. A `codemode` script calls them as `tools.mcp__<server>__<tool>`, where a
`-` in the server or tool name becomes `_` and tools whose names then collide
all get a hash suffix. `describeNamespace("<server>")` returns the server's
description, instructions, and tool names. Closing a worker stops the stdio
process of a connected server. A server still waiting for its `initialize`
answer at close is not stopped by Pi's MCP runtime; its process ends when the
server's request timeout expires (`timeout` in `mcp.json`, 60 seconds by
default). Without a configured server, no `mcp__` tools
register. `mcp-native.test.mts` covers these claims against a real stdio server
and a real managed session. Pi does not export the CLI's `llama.cpp` factory.
Managed sessions inherit the parent's registered providers instead of loading
that private factory.

This extension provides runtime tools and a native `/agent` board for session
supervision, readable conversations, messages, and explicit actions.
It also provides `/restart` for the current interactive Pi CLI process.
It does not provide a conversation editor or workspace.

## Runtime dependencies

The package installs `@earendil-works/pi-server`, `@earendil-works/pi-client`,
and `@earendil-works/chord` as runtime dependencies for detached controls.
Pi does not supply these packages through its extension loader. They must stay
in `dependencies`, not `peerDependencies`: managed Git installs and updates
suppress automatic peer installation. A development checkout with peers installed
does not verify this distribution boundary.

## Restart this Pi process

Use `/restart` without arguments to stop Pi gracefully and resume the exact saved
session in the same terminal. One native confirmation precedes shutdown. Cancel
leaves the process unchanged. Pi follows its ordinary `/quit` cleanup path before
Node replaces the process image, without a wrapper or another child process.

Restart preserves the saved conversation, current working directory, and current
process environment. Saved idle agent children and their nested associations
restore through the [saved-session recovery](#parent-reload-and-saved-session-recovery)
path. Current model, project-trust, and writer-claim checks still apply.
Detached runs survive independently and do not block restart.

Restart does not preserve:

- CLI-only launch options, such as `-e`, `--model`, or tool restrictions. Like
  Pi's printed resume command, restart does not replay the original command line.
  Configure required resources persistently before relying on their return.
- The editor draft or in-memory queues. The primary's active model work,
  compaction, and public steering/follow-up queues block restart. Active or
  queued work in every agent-owned host also blocks restart.
- Other extensions' live work. The confirmation covers this loss,
  not a claim that all extensions are idle.

Preflight requires an interactive standalone Pi CLI, an executable Node binary,
a readable Pi entrypoint, and a non-empty absolute session file. Pi first saves
a new session when a user or assistant message exists; setup-only sessions remain
unsaved and are refused. SDK and managed-child hosts are refused. Every
process-local agent manager participates, including nested hosts and owners
retained after reload. Incomplete opens, creations,
controls, cleanup, association saves, footer saves, pending delivery, and live-only
unsaved results block restart. The command checks identity and readiness again
after confirmation. Saved custom entries appended during confirmation do not
change session identity. A session switch or file replacement still refuses
restart. Only an accepted restart installs an exit listener.

A footer-save failure before the native session leaf changes remains retryable.
A later complete persistence check clears this refusal, including when the saved
checkpoint already matches. Reentrant or association-blocked checks do not clear
it. An append failure after the leaf changes marks native history uncertain:
a subsequent append could reference an entry absent from disk. The extension
stops footer appends and refuses restart for that primary, including after reload.
This state is separate from association failures. Pi's public extension API cannot
repair that native history; restarting is not a repair.

The primary readiness check has a public-API boundary in Pi 0.99.2.
`ExtensionContext.isIdle()` excludes user Bash activity, and
`hasPendingMessages()` excludes the TUI's private compaction queue. A failed
post-compaction submission can leave messages in that private queue while the
public context reports idle with no queued messages. Pi exposes no passive
Bash-completion event or complete TUI queue accessor to extensions. Refusal for
these two states is blocked at that API boundary. A running `!` or `!!` command
stops during ordinary quit cleanup; retained compaction messages are lost.
The confirmation states both losses. Finish Bash work and restore queued text
to the editor for external saving before restart. The extension does not
intercept Bash execution or inspect private host fields to claim full idleness.

The launch uses the current Node executable and Node arguments, Pi's installed
`bin.pi` entrypoint, `--session-dir`, and the exact absolute `--session` file.
It leaves cwd and environment unchanged. It does not refresh environment changes
made in another shell, and it cannot recover Pi after Pi stops accepting input.
A manager retained from a different agent protocol requires ordinary quit and
manual resume before `/restart` is available.

Node's `process.execve` is experimental. Restart is unsupported where that API
is absent, including Windows. A recovery command prints synchronously after
cleanup and before replacement. On Node versions below 26.1, a failed exec system
call aborts the process instead of throwing a JavaScript exception. Use the
printed command if Pi does not return. A JavaScript failure after shutdown also
exits unsuccessfully; it does not leave an open old session. File checks reduce
avoidable failures but do not make replacement atomic with those checks.
Nonzero process exits never restart.

## Start and control sessions

Choose the session lifetime from the task:

- `agent_spawn` creates a fresh session for a distinct task.
- `agent_place` resolves a durable area owner when its reasoning should accumulate
  across tasks. Reuse it when that context and ownership serve the work.
- `agent_detach` starts execution in a separate process when the work must outlive
  the current process. It does not transfer active execution.

Write each assignment as a contract with:

- **Objective:** the purpose, intended outcome, and operator benefit.
- **Output format:** the result the owner needs, acceptance evidence, and end condition.
- **Source guidance:** authoritative sources, instruction paths, known facts, and open questions.
- **Boundaries:** permitted work, exclusions, ownership, and restrictions carried from the operator.

Apply the universal AGENTS.md `Intent authority` section to assignments,
corrections, and relayed decisions. Distinguish binding operator decisions from
agent choices. Leave execution choices open where the contract permits judgment.

Work runs in the background. The ordinary terminal response is the result;
in-process settlement returns to the recorded owner automatically, with the
[owner-delivery boundaries](#collaborate-between-sessions) below. A managed
session sends interim reports, blocking questions, or corrections through
`agent_send` to the owner ID in its session-ownership section. An interim report
does not replace its terminal result. Detached settlements use primary notices.

Use `agent_status` for orientation and `agent_inspect` with `view:"activity"`
to check recent work and owner status together. Use the other inspection views
for exact transcript or result evidence, not for waiting. Never poll with sleeps
or repeated observation calls. Do independent work while useful agent work continues. Before a final conclusion,
integrate needed results and resolve live work: continue useful work, redirect
changed work, or abort superseded work. Settlement establishes execution, not
verification or task acceptance. Do not duplicate an assigned task while its
owner still works on it.

Enter `/agent` or press **Ctrl+Alt+G** for the dashboard. Use `/agent help` for actions.
The command and shortcut share one guarded opener. Repeated opens do not stack
overlays, and a failed open releases the guard. The shortcut leaves the editor
draft intact and does nothing outside a terminal UI. Dashboard actions use the
common extension context, not command-only session controls. Add a space to
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

### Structured observations in codemode

`agent_list`, `agent_status`, `agent_inspect`, and `agent_runs` declare native
`outputSchema` contracts and return matching `structuredContent`. Native
codemode scripts receive objects rather than display text. Tool cards retain
human-readable summaries and expansion:

- `agent_list` returns `rows`, `nextCursor`, and metadata `coverage`, together
  with its source, ordering, continuation, and authority qualifications.
- `agent_inspect` returns its existing bounded inspection: history entries,
  exact-entry fragments, selected ancestry evidence, identified saved results,
  or an `activity` digest with input-delimited turns. Activity includes `text`,
  `turns`, `coverage`, `nextCursor`, `observedAt`, and `metadata`. Metadata reports
  identity, configuration, entry count, last persisted time and age, owner state,
  current tools, exact running call IDs with start times and elapsed durations,
  current operation, last saved result, pending input, and available in-progress
  assistant text or last error. Unavailable
  owner state stays explicit. Saved results expose `entryId`, `operationId`, and
  `status`; fragmented native content remains in `text` with `nextOffset`. Unsaved results retain their
  live-owner persistence warning. Script access does not widen capture or search.
- `agent_status` returns `source`, `sessions`, and `coverage`. The source separates
  inventory, live owner, detached owner, read-only capture, and detached record.
  Live records include model, operation, tool names, entry count, and available
  `activity`: working or idle state, current tool, running call IDs and durations,
  current operation, last saved result, in-progress assistant text, pending input,
  and last persisted time. Without a session ID, status lists process-held
  workers first, with working workers before idle workers, then primaries and
  active detached runs. Its `inventory` counts stored sessions, held workers,
  primaries, and active detached runs; `agent_list` discovers stored sessions.
  Stored records contain capture availability and never invent live fields.
  A detached control failure retains the run record and an `unavailable` reason.
- `agent_runs` returns `runs`, `found`, and `coverage`. Records include identities,
  state, timestamps, process ID, bounded progress, errors, and summaries. They
  exclude request prompts and private store/configuration/log paths. `found:false`
  means the requested run produced no valid record, not that every source was read.

Status and run projections fit the `OBSERVATION_BYTES` budget in
[`observations.ts`](observations.ts). They retain whole records and report
`coverage.total`, `returned`, `omitted`, and `complete`; omitted identities are
not truncated into other identities. These counts describe the returned source
collection, not an audit of every file or owner. These projections add no cursor
or archive index. Discovery and inspection retain their own bounds and
continuations.

Every structured observation remains evidence, not approval or task acceptance.
Thrown refusals still reject script calls. Partial captures and incomplete
coverage remain explicit returned data. Native argument validation, `tool_call`,
`tool_result`, and cancellation still govern nested execution. A hook that redacts
text must also replace structured data under Pi's native result contract.

Reload retains live managers. If a retained owner does not supply structured
status or run data, the tool preserves its human text and returns an
`unavailable` reason with `coverage.complete:false`. Status uses
`source:"unavailable"`; runs uses `found:null`. Empty arrays in that response do
not establish an empty inventory. A fresh owner supplies the structured contract;
reload does not replace active owners or migrate their state.

`agent_compact` uses native `model-only` exposure. It remains directly declared,
including in codemode's `only` mode, but nested tool execution cannot call it.
Self-compaction binds to a direct tool result at the native turn boundary;
nested calls do not create those transcript results. Other agent controls retain
their existing exposure.

### Tool previews

Session tools place requested model and thinking configuration below the call
heading when those fields apply. Omitted values remain unresolved rather than
borrowing a model from the parent display. Result previews use structured
session snapshots for spawn, fork, rewind, attach, place, and status. Detach
labels its snapshot **Selected before transfer**; it does not establish the
child runtime's later model selection. Status snapshots show explicit activity,
current tool, pending input, in-progress assistant text, and last persisted time
when available. Running tools retain their call IDs, start times, and elapsed
durations. Saved result labels distinguish terminal outcomes from task acceptance.
The collapsed card shows up to four session records and four running tools per
record; expansion retains the full returned text. Missing metadata remains unknown.

`agent_compact` returns no session snapshot, so its card names the target and
the path instead. A call with `summary` is a self-compaction request: the card
marks it `self`, shows the target session ID and the summary's character count,
and describes the result as a native compaction entry carrying the
agent-authored summary at the end of the tool batch. The summary text itself
stays in the native tool-call arguments and appears only under expansion. A
call without `summary` names the session for native summarization and reports
whether summarizer instructions are present. Result cards label the self
receipt as a request that does not establish applied compaction, mark native
compaction results, and keep errors distinct. Rendering reads no sessions and
changes no execution behavior.

Discovery, inspection, and control tools carry their own cards. A collapsed
call card shows the tool name, the request, and the per-call values that exist:
the list query or directory filter with its page state, the steer target with
its message preview and reply reference, the command name with its arguments,
the inspect target with the selected view, entry, query, source, offset, or
continuation, and the run id or the whole run list. Activity calls show the
turn limit and any older-entry cursor. No card repeats a static
description of the tool. A call shows the expansion key only when it hides or
clips an argument. A collapsed result card summarizes the outcome instead of
showing JSON and repeats the request only when the result identifies something
else: sessions on the page against the inventory with skipped files, partial
metadata, and the next page, the inspect view with its entry or match count,
capture mode, coverage reason, continuation, and whether a shown operation
result is saved or held only by the live owner, command output with a
replacement session, and detached-run counts by state. Activity results show
turn and entry counts, owner state, age of persisted output, omitted entries,
partial turns, truncation, and older-page availability. A bounded or empty page
reports its coverage, so it cannot read as proof of absence. Queue admission and abort request keep
their exact claims. Expanded cards show the full arguments and returned text
with escaped controls and the display bound; the machine-readable result stays
intact in native tool history. Unexpected or malformed output falls back to a
bounded text preview instead of a guessed summary.

Native tool expansion reveals arguments, returned text, and snapshot identifiers.
Each expanded text block retains at most 32,000 source UTF-16 code units without
splitting a surrogate pair. Escaping terminal controls expands that prefix to at
most 256,000 code units, excluding the truncation notice and native layout.
These are per-block limits, not a total-view limit. Collapsed results keep a
short excerpt below the configuration. Full machine-readable results remain
intact. Terminal controls display as escaped text. Preview rendering neither
opens a session nor changes task admission, delivery, or lifecycle behavior.

### Observe sessions and runs

`agent_inspect({sessionId, view:"activity"})` returns recent readable work and
owner status in one observation. It does not require a separate status request.
The default page covers four recent turns; `limit` accepts up to twelve.
A user message starts a turn. A custom input starts a turn only when no prior
message exists or the prior message is an assistant response with a terminal
stop reason (`stop`, `length`, `error`, or `aborted`). Consecutive inputs and
mid-turn peer or steering inputs stay in the current turn. Rows within each
turn are chronological; recent turns appear first. Failed tool results and errors
have priority when the digest cannot retain every row. The header counts failed
entries omitted from the selected window. Consecutive identical custom entries
collapse into one row with a count and their source entry IDs.
The digest retains at most 16,000 UTF-8 bytes. Selection stops at 128 entries,
and rendered rows also stop at 128. The header retains at most 8,000 bytes.
Text excerpts retain a 400-UTF-16-unit escaped prefix; failed tool output retains
both its beginning and end within that budget. Input and result arrays inspect
up to twelve blocks with a 600-unit excerpt budget. Tool argument prefixes retain
240 units, and in-progress assistant text prefixes retain 600. Omission notices
sit outside prefix bounds.
Thinking is omitted with a count;
images appear as labels. Continue with the returned `nextCursor` as `cursor`
for older turns. A partial turn or omitted entry remains
explicit in `turns` and `coverage`; an empty page does not establish no work.
`coverage.truncated` means rows exceeded the digest byte budget. Header clipping,
excerpt clipping, the entry limit, and the row limit have separate coverage flags.
The text reports only active coverage flags. Tool calls without a selected result
use up to 128 later entries to find a matching result. A result outside the page
is labeled `result after this page` with its entry ID. Older-page calls never use
current time to imply an unresolved call age.

Activity metadata separates live owner state from persisted evidence. A stored
snapshot reports owner state as unavailable, not idle. The last persisted time
and its age measure persisted entries, not model thought or a stalled worker.
Running tools expose exact call IDs, start times, and elapsed durations. Tool
rows retain available persisted ages, running durations, and literal `isError`
values. Text durations use readable units; structured fields retain milliseconds. The worker supplies `lastText` only before the assistant message is
finalized. Age alone never classifies a stall. Status without a session ID shows
process-held workers,
primaries, and active detached runs, with stored-session counts and a pointer
to `agent_list`; it does not dump the stored transcript inventory.

Bare `/agent` and **Ctrl+Alt+G** open the session list with **Sessions** focused.
The heading identifies the focused area and its controls. Select a session with
Up/Down, then press Enter to read its conversation. Tab or Shift+Tab switches
between Sessions and Conversation. Wide terminals preview the selected
conversation beside the list; narrow terminals show the focused area. Resize
preserves focus and selection. The action bar keeps Find, Actions, Message, New,
Help, and Close visible by wrapping instead of dropping controls.
The header shows active work, attention, and total retained spend. The selected
conversation shows state, cost, current work, and configuration; taller views
also show observed duration and tool-call count. Detached runs share session
rows instead of a separate tab.

Working sessions come first, followed by Attention and date groups. Unavailable
sessions remain in Attention until their condition changes. Failed, Stopped and
Interrupted outcomes remain there for 24 hours; older outcomes keep their state
glyph and color in their date group. The attention count uses the same
observation time as the sections. The rail windows the full list without a
display-count cap. Selection follows the full session ID across refreshes and
list reordering. Colliding visible titles receive unique ID tails in the rail,
selector, and composer heading.

| Key outside input (defaults) | Action |
| --- | --- |
| Tab / Shift+Tab | Switch between Sessions and Conversation |
| `[` / `]` | Select the previous/next session from either area |
| Up/Down or `j/k` | Select a session in Sessions; scroll in Conversation or a result |
| Page Up/Down or `b` / Space | Move a page in the focused area |
| Home/End | Select the first/last session in Sessions; start/follow the conversation in Conversation |
| `/` | Focus Sessions and filter the full list by title, task, directory, model, state, or ID |
| Enter | Read the selected session in Sessions; open its message draft in Conversation |
| `m` | Open or resume the selected session's message draft from either area |
| `n` | Open or resume a task draft for a new agent |
| `a` | Open all native actions |
| `x` or Pi's tool-expansion key | Expand or collapse tools and summaries in Conversation |
| Pi's thinking-visibility key | Show or hide thinking in Conversation |
| `o` | Load earlier messages in Conversation |
| `r` | Refresh immediately |
| `?` | Read controls and observation boundaries |
| Escape | Return from help or a result; otherwise close the dashboard |

Session selection and confirmation use Pi's configured `tui.select.up`,
`tui.select.down`, and `tui.select.confirm` bindings. The Sessions heading and
help show configured controls; `j/k` remain selection alternatives. Tab still
opens the conversation when confirmation has no binding.

In the filter, Enter keeps the filter and leaves focus on its session matches.
Escape restores the previous filter, selection, and focused area. A no-match
view retains Find so the query remains editable. Message is absent when no
session is selected or its ownership refuses control. The conversation shows
read-only ownership guidance before an attempted message. In a message draft,
the native editor's configured submit and newline keys apply. The defaults include Enter to submit and Ctrl+J to insert a
newline. Escape hides the editor and saves the draft; a second Escape closes the
dashboard. Session selection is locked while an editor is open or a submission
is in progress. Brackets and navigation keys retain their native editing
behavior inside the editor.

Each visited session retains its entry anchor and within-entry scroll offset,
follow mode, loaded-message limit, tool/summary expansion, thinking visibility,
and draft for the current dashboard interaction. A switch reads the newly
selected transcript and restores that session's view; only one transcript stays
cached. Refresh, resize, and native action dialogs preserve these view settings
and the focused area.
If a bounded file capture no longer contains an anchored entry, the view stays in
browse mode at an available position. Closing the dashboard discards this
interaction state; it is not persisted to disk.

The conversation uses Pi's exported native user, assistant, tool, custom-message,
and summary components. Built-in tools use Pi's tool definitions; other tools
use Pi's generic renderer. No tool executes during rendering. Tools and thinking
start collapsed. The conversation follows new persisted output until the operator
scrolls up; End resumes tail-follow. Images appear as labels and provider
signatures are omitted. Text fields have a marked display bound.
`agent_inspect` remains the model-facing source inspection surface.

The multiline composer uses Pi's native editor and the same command actions as
`/agent send`, `/agent steer`, and `/agent new`. Each composition starts a fresh
editor with that recipient's draft, so undo and editor-local state do not cross
recipients. Large paste markers expand to their complete text before draft save
or submission. Native line-ending, tab, and submit whitespace normalization
apply. The dashboard reserves the editor's full rendered height. If the terminal
is too small, a resize notice replaces input and rejects hidden edits; Escape
still retains the draft.

Submission captures its recipient before any asynchronous work and rechecks
ownership to select send or steer from current state. Another Pi window receives
no message through this dashboard; a short refusal identifies its owner.
Detached steering uses the existing detached control path. Failed admission
retains the submitted draft. A receipt does not prove message delivery or
completed work. Native action dialogs close the board first, then restore its
selected session, focused area, and view state with a scrollable result. The action picker uses
Pi's native `SelectList` with a terminal-height bound. It keeps the selected
choice visible, shows its description, and retains that choice across resize.
Its controls follow Pi's configured selection and cancel bindings. At dimensions
that hide the choices, only cancel remains active. Action argument dialogs,
confirmation, trust, ownership checks, and execution use the same command path
as slash actions.

While open, the dashboard refreshes once per second. It stats native session files
and caches digests by file identity, size, and modification metadata. Only changed
files are parsed; the selected conversation has its own cache. Close disposes
the refresh clock. Each clock tick requests a render independently of source
reads. If Pi leaves that request unperformed for five seconds, the board pauses
the clock and further reads, without closing or disabling the component. A later
render or key resumes refresh. Slow reads do not expire a visible board. This
pause does not close any other overlay. Observation never claims a writer,
repairs a tail, opens a session for writing, or persists an index. Oversized files
split the bounded capture budget between a head window and a tail. Complete head
entries preserve the name, original task, and model/thinking configuration when
the tail lacks them; a task requires a captured branch root. Tail metadata takes
precedence. Activity, latest replies, tools, and conversation entries come from
the tail, without joining history across the gap. Missing ancestry and capture
limits remain partial, and `≥` marks incomplete spend. Spend includes retained
native usage from both windows across branches; tool counts and latest output
describe the captured current branch. Duration is absent when the latest turn
start is unknown. A head timestamp supplies the start only when captured ancestry
connects that user message to the tail; an unseen gap never implies zero time.

Local manager activity, detached records, and read-only writer claims supply
ownership. A same-host live PID plus a pending transcript turn identifies work
in another window. A same-host claim whose process no longer exists leaves the
transcript outcome and any detached-run result in force; the board reads that
claim and never removes it. Foreign-host, invalid, or unreadable claims show
Unavailable and refuse control. PID reuse limits liveness certainty. Transcript
observations include persisted messages, not uncommitted streaming tokens.
The help view holds these boundaries instead of repeated caveats on every row.

Slash actions and completion remain available without the board. RPC receives
a digest snapshot through a native notification. Print/JSON writes it to stderr,
leaving protocol stdout and model context unchanged.

### Footer activity and price

The `agent` status key reports `agents 2 · $0.37`, including `agents 0 · $0.00`
before work starts. The active count covers this process's manager for the
configured agent store, not only the current parent's children. Each primary
retains its own cumulative price from the intervals when it observes that manager. A positively identified
managed child is not registered as a primary. The manager checks its own
managed-host records before primary registration and restart, as defined by the
[host identity contract](../../docs/conventions/session-host-roles.md). This prevents
unrelated completion turns during child startup and cyclic manager lifetimes.
Each ordinary host
counts once, including ordinary agents created by other agents.
Active means pending host work through final settlement, including commands,
compaction, and queued input. Idle hosts do not count as active.

The price is reported native usage observed after ownership begins. It includes
assistant responses, reported tool usage, compaction, branch summaries, and
cache warming. It excludes inherited history on attach, fork, or replacement.
Reload and replacement of a worker retain already observed spend. Idle and
completion do not clear totals. Native custom entries save each primary's totals
under its exact session ID, outside model context. Same-process reload retains
in-memory checkpoints. Reopening restores checkpoints only from a native session
file Pi actually saved. Before the first user or assistant message, Pi buffers
custom and setup entries in memory without creating the file; that first
conversation message flushes those entries. Tree navigation does not undo
incurred costs. New sessions and copied forks start at zero. Multiple primaries have separate checkpoints and
attachment baselines, so a later primary does not inherit earlier manager spend.
Each departing primary clears its cell. A primary reload drops its old UI and
message callbacks, but retains its manager, live hosts, and price baseline.
Last-primary shutdown other than reload closes the manager after final observations. These are cumulative observed session costs,
not retrospective historical charges or provider invoices. Missing or malformed
usage adds `+?` to the known price rather than becoming zero.

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
status calls remain no-ops; the manager observes native session usage directly.
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
| `list` | List saved sessions and registered primaries. |
| `status [session]` | Show held work, primaries, and live detached records, or request one session's status. |
| `attach session [provider/model]` | Reopen a session without starting work; optionally repair its idle model choice. |
| `configure session name [text]`, `configure session model provider/model [level]`, `configure session thinking level` | Change an idle session's configuration without a task or replacement. |
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
`agent_steer`, `agent_abort`, `agent_fork`, `agent_attach`, and `agent_configure` expose discovery,
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

### Configure an idle session

`agent_configure` changes `name`, an exact `provider/model`, and/or the canonical
`thinkingLevel` on the same session. Supply at least one field. Empty or
whitespace-only `name` clears the name. Name and model inputs are bounded to 256
and 512 UTF-16 code units respectively; malformed Unicode, controls, multiline
text, fuzzy models, and unknown fields are refused. A session ID is exact, not a
name lookup. `trust` applies only when a closed session needs its ordinary
project-resource decision; configuration does not change trust on an open host.

```text
/agent configure <session-id> name Parser review
/agent configure <session-id> name
/agent configure <session-id> model provider/model
/agent configure <session-id> model provider/model high
/agent configure <session-id> thinking low
```

A model-only change preserves the session's prior effective reasoning level,
then lets Pi clamp it to the requested model. An explicit level takes priority.
Neither unrelated global defaults nor per-model defaults select the final
level. A stored session without a retained reasoning entry needs an explicit
level with a model change. Native setters update session history without
persisting global model or reasoning defaults. The session ID and existing
history stay intact, including when an explicit model repairs an unavailable
stored model. No prompt, follow-up message, automatic retry, or replacement
session accompanies configuration.

On the board, choose **configure** from the native actions menu. **Name**,
**Model**, and **Reasoning** edit an in-memory draft. **Apply** validates and
submits it; **Cancel** discards it without opening a worker or changing native
history. The displayed values are a snapshot, not an idle reservation. The owner
checks the current state again at Apply. The board restores selection and the
conversation after the dialogs, with a scrollable result after Apply.

Configuration refuses its caller, primary sessions, detached owners, another
live owner, active or queued work, input preflight, pending control/open/transfer,
and closing or unavailable hosts. Reservation precedes asynchronous admission;
configuration does not wait for work to finish or abort it to manufacture idle.
Native user, custom-message, steering, follow-up, and Bash admission stay closed
through native setters and awaited hooks. A shutdown that starts before mutation
refuses the change; shutdown after a native setter starts waits for that admitted
configuration before disposal and writer release.

Results include bounded `before`, `requested`, and actual `after` fields, their
live/retained source, and requested/effective reasoning with native clamp status.
`clamped: null` means that the reasoning setter did not finish, not that no clamp
occurred. Older native names and model identities that exceed the input bounds
are clipped with explicit field paths in `truncated`. The tool sets `isError` for
`outcome: "failed"` and retains the complete actual-state report in its text and
structured details. Setter failures report partial state and uncertain writes,
not rollback. Raw provider or hook exception text is not reflected in this report.

Native model-selection hooks are awaited. Pi does not await all asynchronous
name or reasoning hooks; reported hook errors cover only those observed by the
result snapshot, and later extension activity remains ordinary native behavior.
A successful setter or an existing file is not an independent disk verification.
Native append can advance in-memory history before a write fails. The native
[flush boundary](#footer-activity-and-price) still applies to unflushed sessions.
Inspect uncertain state before another explicit change; configuration does not
repair history or replay lost work.

### Find work and retrieve its evidence

`agent_list` searches retained session metadata without opening a writer. Use a
case-insensitive literal `query` in the native ID, directory, latest name, or first
nonempty user text. Empty or image-only user messages do not select that text;
later messages do not expand the query after the first text is selected. An
optional absolute `cwd` matches that directory exactly. Discovery does not search
every conversation message or establish live ownership.

```text
agent_list({query: "cache cleanup", limit: 5})
agent_list({query: "cache cleanup", limit: 5, cursor: "<nextCursor>"})
agent_inspect({sessionId: "<session>", view: "activity", limit: 4})
agent_inspect({sessionId: "<session>", view: "activity", cursor: 12})
agent_inspect({sessionId: "<session>", view: "result"})
agent_inspect({sessionId: "<session>", view: "result", entryId: "<result-entry>", offset: 12000})
agent_inspect({sessionId: "<session>", view: "search", query: "cleanup", source: "toolResult"})
agent_inspect({sessionId: "<session>", entryId: "<matched-entry>"})
```

Use the returned offset or cursor rather than assuming the example's value. Existing
`agent_attach`, `agent_send`, and `agent_fork` controls reuse a selected session;
observation starts no work and changes no ownership.

Discovery enumerates only the native directory. It stops after a directory bound
of 2,048 entries plus one overflow probe, rather than slicing a whole-store scan.
Each page visits at most 32 candidate files, captures at most 16 MiB in total,
and refuses files above the existing 8 MiB capture bound. The default result
limit is 10, the maximum is 20, and serialized output stays below 24,000 bytes.
A page searches at most 4,096 UTF-16 units of each text metadata field and shows
at most 512 units without splitting Unicode pairs. Partial metadata, shortened
previews, unreadable files, oversized files, and malformed input remain explicit.
Files with invalid header timestamps or non-string metadata text are skipped
with a reason. A metadata row that exceeds the output budget is also skipped,
not retried forever. A lack of matches in those sources does not prove absence.

Rows use descending filename order, not last-activity order. Discovery has no
index, cache, watcher, or model-generated summaries. A cursor binds the query,
exact directory filter, and bounded filename inventory. New or removed files
invalidate it. Each continuation captures file contents anew; the cursor is not
a frozen transcript snapshot. Continue even after an empty page when
`nextCursor` exists. A directory above the enumeration bound refuses discovery
instead of reporting a complete empty inventory.

`agent_inspect` has explicit evidence views:

- `activity` presents recent input-delimited turns as readable rows with native
  entry IDs, timestamps, kind, and text. Tool rows retain available call IDs,
  outcomes, durations, persisted ages, running durations, `isError`, and result
  entry IDs. Coverage reports considered, rendered, and omitted entries plus
  truncation and the count of omitted thinking blocks.
  Use the native entry ID with `history` for exact source evidence. This digest
  adds no summary model, store, watcher, or execution authority.
- `history`, the default, retains existing whole-history pages and exact-entry
  reads. History pages identify their saved result with `result.entryId`.
  `result.text` starts the same native-entry inspection representation as an
  exact-entry or `result` read. Continue with `entryId=result.entryId` and
  `offset=result.nextOffset`; the reconstructed JSON contains the outcome in
  `data`, including `data.text` and `data.status`.
- `branch` follows one known native parent chain, newest first. Omit `fromId`
  for the current leaf, or use a known entry ID. A branch summary exposes its
  abandoned tip as `fromId`; pass that ID to inspect the alternate ancestry.
  This does not enumerate unknown branches or navigate the session.
- `search` applies a case-sensitive literal `query` on that same ancestry.
  Optional `source` selects user, assistant, tool-result, custom-message, or
  summary entries before text scanning. Matches preserve native IDs, text-field
  paths, and UTF-16 match offsets. Those offsets address the named source text
  field, not the exact-entry inspection serialization. One match per entry
  prevents a large tool dump from occupying the whole result page.
- `result` finds the latest operation on that ancestry or an explicit
  `operationId`. It returns the saved result's entry ID and the first exact-entry
  chunk. Continue with that `entryId` and `nextOffset`. A newer operation without
  a saved result does not silently return an older completed result. A result
  is an observed execution outcome, not verification or task acceptance.

Selected-ancestry pages visit at most 128 entries. Search visits at most 512 text
slots and scans at most 65,536 UTF-8 bytes per page. Excluded entries still use
visits. Continuations include text positions for large fields and preserve
matches across scan boundaries. Their signed token binds the session, ancestry,
and query; repeat the same view, query, source, and operation ID. Tokens expire
when their observation host generation changes. Restart from the returned
`fromId` after that refusal. No transcript or query index is retained.

Search covers raw native text, visible thinking, tool names, assistant errors,
Bash command/output text, session names, and summaries. It excludes signatures,
image payloads, redacted thinking, tool arguments, tool-result details, arbitrary
custom data, and context-edit replacements. Raw history is not current projected
model context. Missing ancestors stop coverage explicitly. Ordinary appends do
not change a continuation's selected ancestry; the token does not establish an
immutable snapshot of file bytes. Historical text remains evidence, not fresh
instructions or approval.

Live owners, read-only captures, and detached inspection use the same selectors.
A foreign-session lookup reads bounded headers and refuses after a directory
bound of 2,048 entries plus an overflow probe. Existing owner routing still
applies. Captures remain point-in-time, with explicit size and unfinished-tail
limits. Live-only unsaved results appear only through the existing `history`
view paging contract below; branch, search, and result views never overlay them
on selected evidence.

`agent_inspect` reads session evidence and execution/result state. Its bounded
previews retain entry IDs and roles. Use an entry ID and `offset=nextOffset`
to read the complete inspection representation in chunks; use `nextCursor` for
older entries. Offsets count UTF-16 code units in that representation, not bytes
or positions in the native file. Returned offsets preserve Unicode pairs.

For history pages and exact-entry reads, inspection replaces native
`textSignature`, `thinkingSignature`, and `thoughtSignature` values with omission
markers before serialization. It also replaces image `data` and the `thinking`
text of `redacted: true` blocks. Each affected entry reports fixed-size `omissions`
counts by category,
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
They do not reopen the session or construct another worker. Attach, configure, send, fork,
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

A successful steer reports the native disposition: `queued` means Pi queued
it for the next model-call boundary, including after an input handler transformed
it; `handled` means an input handler consumed it without queueing it to the model.
Neither confirms action. Queue admission does not guarantee delivery or that the
message remains queued. Native pending queues and in-flight operations do not
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

An abrupt process exit leaves the claim file behind. Graceful quit releases
successfully closed hosts; forced process death does not. The next open of that
session reads the claim: a same-host claim whose process no longer exists is
replaced and the open proceeds with ordinary idle restoration; it replays no
interrupted work. A live same-host claim, a claim from another host, and an
unreadable or invalid claim refuse, and the error names the claim file. A
process that refuses a signal probe counts as live. PID reuse can only make a
dead owner read as live, which refuses; it never causes a replacement. The
claim is removed only on this control path, after its owner is read as dead,
and only if the file is still the one that was read.
Read-only observation does not take a claim, so `agent_status` and
`agent_inspect` can report a session that another process owns; they read a
bounded point-in-time snapshot of its persisted entries and do not remove the
owner's claim.
Claims coordinate agent-extension processes on the same local filesystem;
they do not fence arbitrary programs that bypass the store.

### Idle host release

After five idle minutes, the manager closes a managed host through its ordinary
cleanup path. The session file, directory binding, and saved ownership
associations remain intact. Cleanup releases the writer claim and retains
observed spend once. The timer uses no model calls and does not keep the process
alive. `PI_AGENT_IDLE_MINUTES` changes the window; `0` disables release.

Active operations, native queues, input preparation, pending controls, open
configuration, owner-addressed settlement notices, and any owned child host
still open in this manager prevent release. Children release before their owners;
the owner's full idle window starts only after its last child host closes.
A new idle window starts after other busy states clear. Primary sessions and detached
owners never receive an idle deadline. Unsaved results, uncertain association
history, and incomplete cleanup retain their hosts for inspection. Incomplete
cleanup keeps its unavailable host and retained claims; no automatic retry or
claim removal occurs. Completed cleanup retires the host even if another cleanup
step reports an error.

`agent_send`, `agent_attach`, `agent_place`, and dashboard controls reuse the
ordinary stored-session path when a host is closed. Stored steering still
refuses and names `agent_send` as the turn-start action. Reopening keeps saved
history without replaying a task; current trust, model, and claim checks apply.
An idle release during restart confirmation changes the host snapshot, so the
existing restart identity check requires another confirmation.

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

Received messages and completion notices keep Pi's violet custom-message
identity and native lowercase bracketed label. The primary header row shows
`[agent] <name or session ID> · <message or outcome>` in bold. Known
`provider/model` and `thinking: <level>` appear in a separate muted row directly
beneath it. That row is absent when no configuration fields are known. Both
rows wrap at the terminal width. Names and configuration values retain their
original case. An unnamed source uses its full valid session ID.

`agent_send` captures the sender's current session name, selected provider/model,
and thinking level at emission. Completion notices capture the worker's current
session selection at settlement, not its creation arguments or the physical
responder behind a virtual model. These optional display fields travel in the
existing notice metadata. Missing fields stay absent; rendering performs no
session lookup. The original content envelopes stay unchanged. Names and
configuration values are bounded, and terminal controls appear as visible escapes.

Both default and expanded cards show the message body as native Markdown, with
paragraph spacing, lists, links, code, and width-aware wrapping. The renderer
honors Pi's `outputPad` setting. Only a fully matching current envelope permits
removal of its technical preamble from the displayed body; an unmatched
notification stays visible. Detached-run batches use a `[agent] runs` headline
with outcome counts, not one shared session configuration. They show every
report with its source instead of selecting one excerpt. The producer sends
settled runs in batches of at most 32.

Applicable warnings precede the body: an unsaved result, a settlement reported
to primaries without a live owner, an unchecked source, or an unavailable source.
Oversized metadata reports an unknown outcome and an unchecked source.
The configured native tool-expansion key adds source details after the readable
body: exact valid message, reply, session, operation, and run IDs, plus the
capture boundary for any session configuration. A visible hint names that key.
Invalid IDs use bounded excerpts and point to full metadata in native history. Large batches show at most 32 run metadata rows with an
omission notice. Expansion ends with the universal AGENTS.md `Intent authority`
reference for messages, or the reported-data and task-acceptance boundary for
operation and detached-run results. It does not duplicate the body as raw text.

Each body displays at most 32,000 source UTF-16 code units without splitting a
surrogate pair. Controls are escaped before Markdown rendering. An explicit
display-limit notice points to the complete notification in native history;
expansion does not bypass that limit. `agent_inspect` retains the operation
outcome and `agent_runs` retains run outcomes. Long reports use native transcript
scrolling rather than a clipped preview, so successive reports occupy more
transcript space. The renderer does not pin the primary answer or guarantee
its visibility after arbitrary arrivals. Rendering changes neither provider
content nor delivery timing.

Native reload refreshes the renderer. Existing live managers and workers retain
their producer methods across reload; a process restart applies the changed
metadata producers to those owners. Notices without metadata do not gain it
retroactively. Notices without a name still show their source ID.

Admission means the message entered the recipient's execution path. It does
not mean that the recipient replied, understood the message, or acted on it.
The universal AGENTS.md `Intent authority` section governs agent-carried
assignments, corrections, and relayed decisions. The sender applies that rule
before sending; the recipient applies it to the message in its task context.
The message envelope identifies the sender and references that rule, without
classifying every statement in the message as either authority or evidence.

The extension does not infer delegated intent from a session association.
Associations record ownership for spawn, attach, and control operations; they
do not distinguish a delegating owner from every other sender. The message
transport therefore does not certify a sender as the operator or as a delegate.
This is a limit of the recorded relationship, not a reason to discard a task
assignment or correction from its established owner.

The host announces a settled in-process operation result to the sessions that
own the settled session, from the recorded associations. A registered primary
owner receives it through its own notification path; a managed owner receives
the ordinary `agent.peer` message, delivered as steering while it works. An
owner therefore learns that its own child finished without polling, and a
primary no longer receives results of sessions it did not create. When no
owning session is live in this process, because the owner closed, detached, is
unknown, or has a failed association write, the notice reaches the registered
primary sessions instead and says so in its content; its collapsed card marks
the same state. The notice names the settled session when it has a name: its
content opens with the name and ID. The card uses the source-first headline
described above, with `completed`, `failed`, or `aborted` as its status.
A notice that its owner cannot admit yet waits in memory and reaches that owner
later, or falls back when the owner retires. Detached-run summaries keep their
separate announcement to registered primaries.

These results and detached-run summaries carry an explicit
reported-data label in model-visible content. Settlement is an execution
outcome, not verification, operator approval, or coordinator acceptance of the
task. A normal terminal result does not impose a separate submission protocol.

Every managed session reads its owner's address in model-visible content. On
each model request, the extension adds a session-ownership section to the
session's leading system message: the owning session ID, that `agent_send` to
that ID carries an interim report, a blocking question, or a correction, and
that the ordinary terminal response remains the result. The section is built
from the current associations for each request, so it follows primary reload,
saved-session recovery, and fork or replacement updates. Unknown ownership is
stated as unknown rather than guessed. A session with no leading system message
receives no section. The section is request-time content: it changes no stored
entry and no operator task text.

Peer messages do not execute commands when their text starts with a slash command.
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
supply extension history and projection APIs. In a managed session, the
extension uses the ordinary full-transcript context hook to add its
[session-ownership section](#collaborate-between-sessions) to the leading system
message of each request.

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
a provider callback that depends on a resource its own owner closed. A result
of a primary-owned session that settles during the reload gap waits for the new
primary callback and is delivered once in that process. The native message API
supplies no crash-durable delivery acknowledgment.

The process reuses managers that match the current manager protocol. Refreshed
registration does not reconstruct these managers or existing workers: they
retain their class methods and closures from creation, including imported
helpers. A fresh host process loads method changes for those objects. Another
session in the same process does not replace the retained owners. Use
[`/restart`](#restart-this-pi-process) to replace the process and resume the saved
session when its preconditions hold.

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

This refusal is not native-history repair. Pi 0.99.2 advances its in-memory leaf
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
An unavailable model requires explicit repair. A live or foreign writer claim
still requires ownership resolution; a dead same-host claim is replaced.

A parent created before association records existed restores no inferred
children. Explicit `agent_attach` or `/agent attach` opens a known child without
a task and records the association for that parent. Save the native parent
before expecting later process recovery. Pi buffers custom and setup entries
until its first user or assistant message flushes the file. An in-memory session
or an unflushed parent therefore has same-process continuity only. This is not a record migration.

A rejected native reload before runtime replacement retains the old invalidated
runner. A later successful reload rebinds control, and its retained shutdown
handler still closes the children on true quit. Pi also permits a different
failure: its loader reports an extension factory error, omits that extension,
and completes reload. If it omits this extension, the parent loses agent tools
and shutdown handlers while retained children and writer claims remain live.
A later successful reload recovers control. True quit from the omitted-extension
runtime cannot call the lost cleanup handler. Pi 0.99.2 exposes no finalizer for
that discarded extension owner; this cleanup guarantee is blocked at the native
host. The extension adds no process hook or polling substitute. After process
exit, the next open replaces the dead claims under the rule described above;
while the process lives, its retained claims refuse.

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
| `PI_AGENT_IDLE_MINUTES` | Idle managed-host release window in minutes. Default: `5`; `0` disables release. Fractions are allowed. Values must be finite numbers from `0` through `35791`; invalid values refuse manager creation. |
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
editor tests cover command completion. Configuration tests cover shared input
validation, native setters and clamping, saved identity/history, idle admission
and shutdown races, hook and append failures, tool/slash output, and dialog drafts.
Native idle-release tests cover timer expiry, stored-session reuse, retained
history and associations, once-only spend, active and queued work, owner notices,
configuration, detached ownership, and disabled release. Synthetic inspection tests cover typed
omissions, unchanged native entries, and Unicode continuation through live-owner
and read-only projections. Presentation tests cover activity call limits and
cursors, turn and entry counts, persisted age, unavailable owner state,
coverage bounds, running call IDs and durations, saved result labels, and status
activity without inferred idleness. Received-message tests cover formatted
Markdown, source names and exact IDs, unchanged delivery content, narrow widths,
native expansion and output padding, terminal-control escaping, explicit display
limits, and completion/error states. Loader tests
verify the public inspection registration; they do not establish behavior in
an already-loaded host. Component tests cover
board filtering, uncapped paging, native chat components, message drafts,
refresh, disposal, source failures, and read-only digest boundaries. Native TUI changes
also require an isolated interactive or PTY check for keys, focus, resize, and
tool expansion; component snapshots alone do not establish those behaviors.

The detached child abort-cleanup test retains its temporary directory on failure
or timeout. Its diagnostic names the directory and includes the last awaited step,
child state, file markers, and bounded tails of the child log and run records.
The same snapshot is saved as `failure-evidence.json` before child cleanup.
Successful runs remove the directory. The synthetic provider publishes abort
readiness only after its release watcher observes the initial missing-file state,
so the parent cannot create the release file before the watcher establishes its
baseline. A focused regression checks this handshake.

Repository gates are `npm test`, `npm run lint`, `npm run typecheck`, and
`npm run check`.
