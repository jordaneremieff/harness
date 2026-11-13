# Rex

Operate interactive applications and persistent terminal work through the installed
Rex CLI. Ordinary Pi and native Durable expose the same tools and domain results.
Rex owns terminals and their programs. This extension owns exact target resolution,
bounded observations, caller-specific ownership claims and uncertain-effect records.
It does not replace Bash, Jobs, Agent, Policy, Rex configuration or Rex's skill.

## Tools

| Tool | Operations | Contract |
|---|---|---|
| `rex_environment` | `environment`, `resolve` | Discover the selected server, sessions and clients; resolve session, window, block or client selectors. Return full IDs and server identity. |
| `rex_terminal` | `create`, `inspect`, `input` | Establish persistent sessions, windows, splits or floating panes, optionally shown to the operator; inspect structure, the most recent output, process or program status; deliver application text and keys. |
| `rex_wait` | `wait` | Observe direct child exit with its exit status and most recent output, literal text in the most recent output, or a reported status. Combine bounded live events with current snapshots. |
| `rex_native` | `native` | Retrieve the installed method catalogue or one method's schema; call an API, execute Lua or invoke an existing action. |
| `rex_owned` | `owned`, `observe`, `reconcile`, `cleanup` | Read stored claims or current child evidence and output for selected claims; reconcile uncertainty, close only recorded owned blocks, or forget closed records. |
| `rex_status` | `snapshot`, `bind`, `unbind` | Inspect cooperating programs' reports beside actual current host activity. Optionally retain one verified inspection target per caller. |

Each request includes a visible `op`. Native execution also exposes `kind`,
`method`, `args`, `code` and `action` in the tool arguments. These are the real
ordinary and native policy boundaries. No arbitrary API or Lua operation receives
a read-only annotation. Policy remains the decision owner; terminal content and
program reports never grant permission. The ownership classification of verified
read-only methods changes only this extension's effect admission; policy sees the
same arguments and supplies no read-only permission.

Each tool's provider declaration is one plain object root whose `op` (and `kind`
or `condition`) field enumerates the accepted values and whose other fields are
the union of every operation's fields. Google's validated function-calling mode,
which Pi selects for the whole request whenever one strict built-in tool such as
`read` is present on a Gemini 3+ model, rejects a declaration whose root is a
schema union; a flat root keeps all six Rex tools loadable beside Pi's built-ins.
The per-operation shapes in `schema.ts` remain the request contract. Both hosts
validate the received arguments against the selected shape before any Rex,
ownership or status access: a wrong `op` for the tool, a missing `kind`, `label`,
`recordId`, `method`, `code`, `action`, condition argument or input text/keys, an
unknown or operation-incompatible field, a wrong type, an out-of-range value or an
invalid nested target returns `outcome: "invalid_request"` with
`effects.state: "none"`. `cleanup` never selects a claim without its exact
`recordId`. The rejected arguments are the same arguments policy saw.

Results share `ok`, `outcome`, optional `target`/`data`/`error`, `effects` and
`coverage`. Inspect `ok` and `effects.state` in program callers. Ordinary results
use `structuredContent`; native results use `structuredOutput` with the same
schema. One canonical result serves model text and program callers in both hosts.
The core and final adapters apply the same semantic result bound. The final bound
also covers status and host activity added after core execution. If the envelope
exceeds its budget, the bound replaces bulk `data` with an explicit omission and
marks `coverage.dataOmitted` and `coverage.truncated`. It remeasures JSON-encoded
bytes after each reduction. If necessary, it also shortens human diagnostic text
and removes whole trailing record-reference entries. It never clips machine IDs,
changes `ok`, `outcome` or `effects.state`, or removes `effects.recordId`.

`coverage.truncatedFields` names shortened diagnostics: `error`, `effects.note`
and/or `coverage.note`. These fields are no longer complete literal diagnostics.
During diagnostic reduction, the encoded JSON limits are 4096 bytes for `error`
and 1024 bytes for each affected note.
Source status and outer-CLI-success qualifications still apply when text is
shortened; an omission never establishes application success or permission.

`coverage.emittedRecordRefs` and `coverage.omittedRecordRefs` count references
retained or removed by the envelope bound. `coverage.omittedRecordIds` contains
the full omitted record IDs. These fields do not redefine the fetched-page
`totalRecords`, `returnedRecords` or `omittedRecords` counts. When references are
omitted, `nextOffset` is the earlier of the existing observation continuation
(when present) and `pageOffset + emittedRecordRefs`. Zero remains a valid
continuation, not an absent value. `nextPageOffset` preserves the original
continuation when one exists.
Repeated bounds retain earlier omitted IDs without duplication. Use
`rex_owned` with `op: "reconcile"` and one omitted `recordId` to inspect that claim,
without `recover` or `release`; alternatively, resume at `nextOffset` with
`limit: 1`. Never replay an effect to recover omitted output. Mandatory defined
metadata outside its validated limits fails explicitly instead of returning
oversized JSON.

The native tools declare `outputLimits.maxBytes` equal to that shared result
budget instead of Pi's smaller default 50KiB limit. Compact JSON remains one line,
so the default 2000-line limit does not cut a JSON envelope. Model text and
structured output contain the same canonical omission and qualifications. Native
direct model calls do not retain a separate larger structured value for later
inspection; request a smaller view instead of replaying an effect. Presentation
details contain only a short outcome and effect state, not a second machine-result
channel.

## Ordinary tool cards

A collapsed card leads with one line: the human subject and the precise outcome
(`build pane · created`, `block · input delivered`, `wait for child exit ·
timeout`). The subject is the resolved label when the result or request carries
one, otherwise the plain resource kind (`new session`, `block`, `window`,
`observation`, `status`), never an identifier. `UNKNOWN EFFECTS` stays on that
line; a confirmed or absent effect is routine and waits in Details. `rex_status`
then leads with host activity, the program states reported inside the payload,
and whether the caller is bound (`Binding: block bound` or `Binding: none`).
`rex_owned observe` rows lead with the stored phase and the current child
evidence (`#1 · stored confirmed · present · child exited · exit 7`), numbered
when there is more than one; a call that names a record says `one record`. The
expanded view adds a Details block with the exact target (block, window, session
or client identity, target source and server endpoint), the effect record, the
bound target with its verification time and owner, each observed record
identity, and the effect state before the complete bounded result. Full IDs wrap when needed rather than receive fixed short forms. Pi's default tool shell supplies padding, background and expansion.
The expansion hint uses your configured Pi key, read through the `keyText`
function that the host passes in the tool render context. An unbound key, or a
render context without keybinding hints, produces no hint and no invented mouse
instruction.

Collapsed cards keep these distinctions visible:

- **UNKNOWN EFFECTS** remains meaningful even when other facts are absent.
- Input delivery does not establish application execution.
- An observer deadline or end does not stop independent terminal work.
- Capture is bounded, not a complete transcript.
- Bulk omission, shortened diagnostics, omitted references and page continuation
  remain explicit, including a continuation offset of zero.
- CLI success does not establish an inner application outcome. Stored phase and
  reported program status grant neither permission nor task acceptance.

Expansion exposes the request and complete bounded canonical result as JSON.
It does not recover source data already omitted by the semantic result bound.
Labels, request text, captures and errors escape terminal controls and directional
format controls in both views. Previews clip safely without cancelling Pi's row
background. These renderers do not change model text, structured output, native
results or the small presentation metadata.

The factory publishes the same registered renderer references through the public
[tool display contract](../../docs/conventions/tool-display.md). It emits during
factory setup, answers versioned requests and removes its request listener at
shutdown. Consumers receive display fields only, never tool execution functions
or schemas. Pi also owns subscription invalidation when it replaces the runtime.
The records come from `display.ts`, a presentation-only module over
`presentation.ts`; the Durable contribution advertises it as its display
descriptor (`{ version: 1, entry: "./display.ts", export: "toolDisplay" }`) so
the standalone Agent terminal renders Rex cards locally. Importing it registers
nothing, emits nothing, and touches no terminal.

## Select the right work

A target accepts `server`, `session`, `window`, `block`, `client` and `source`.
These represent different facts:

- An explicit selector expresses requested intent. A label must resolve uniquely.
- `source: "inherited"` uses the verified launch context, not operator focus or ownership.
- `source: "focus"` explicitly asks for current focus, optionally within a named session.
- A resolved target carries the selected server endpoint, host and instance IDs,
  plus full resource IDs. Retain those IDs for later work.

Explicit resource selectors do not acquire other IDs from the inherited launch
context. A configured or explicit different server must not consume inherited
IDs from another server. Conflicting session/window/block selectors fail instead
of selecting another resource. Mutable labels and focus never transfer ownership.

Start with `rex_environment {"op":"environment"}`. Resolve the intended resource
before an ambiguous action. For work on an existing session, pass its server and
full session ID. For input or capture, also pass the full block ID. Do not send
input to the terminal that hosts the agent.

## Establish, interact and revisit

For an owned interactive application, use `rex_terminal` with `op: "create"`,
`kind: "session"`, a useful `label`, and a command array such as
`["node", "--interactive"]`. New windows and splits use an explicit existing
session or anchor block. `kind: "float"` opens a floating pane in front of the
anchor block's window (`session.new_layer`); `bounds` sets its rectangle as
`[x, y, width, height]` fractions of that window and defaults to a centred pane
that leaves the layout around it visible. A created pane stays open after its
program exits, so completed output stays readable. `keepOpen: false` closes the
pane when its program exits successfully, for interactive programs such as
viewers that the operator closes from inside; Rex keeps the pane open after a
failure, so the error stays readable. A new window, split or floating pane does
not take focus unless the request sets `focus: true`; use that when the operator
asked to see the work, such as a diff tab, a test run or a document. A new
session cannot be shown this way; `focus` is refused there, and a client action
such as `session.select` displays it. Save the returned target and effect record
ID. Cleanup of a floating pane closes its block, and Rex removes the emptied
floating layer.

A pane program can also show its own Mac window over its pane; Rex does not
embed it. Programs in Rex panes run under
the Rex server, so they receive the accessibility and screen recording access
that the operator granted to it (`server.apple.privacy_status` reports it), and
the Mac client exposes each terminal as an accessibility text area with its
screen text and frame. A program that places its own window over its pane
through accessibility, such as a document reader, therefore runs like any other
pane program: Rex owns the pane's place in the workspace, the program owns its
window, and closing the pane ends the program. Content that Rex draws over the
pane, such as a floating pane, is drawn inside Rex's window; such a program
learns about it from the pane stacking feed below and from accessibility.

Use `inspect` before application input. Deliver text with `input`; add keys such
as `enter` when the application needs them. `observe: true` returns a subsequent
bounded observation. The agent interprets prompts, modes, errors and results.
Queued input is not application completion. Control-C is application input, not
an observer cancellation or proof that the program stopped.

For parallel work, create separate resources and retain their returned IDs. Leave
services available after a bounded readiness observation. Use a literal startup
message, a cooperating program's status, or an independent service request as
appropriate evidence. Inspect the same IDs after an interruption. Start dependent
work only after the prerequisite's relevant outcome is observed; unrelated work
need not stop.

## Pane stacking feed

Every pane created with a `command` receives `PI_PANE_STACKING` through an
`/usr/bin/env` command wrapper. Panes without a command remain unchanged. The
value is a JSON argument array `[absoluteNodeExecutable, absoluteHelperPath]`,
using the running Node executable and this slice's `pane-stacking.mts` helper.
This implements the package-level
[pane stacking contract](../../docs/conventions/pane-stacking.md).

A consumer starts the helper without a shell, with the pane's environment and
piped standard input and output. The helper reads `REX_SESSION`, `REX_BLOCK`
and `REX_SERVER`, and uses `REX_BIN_DIR/rex` when available, otherwise `rex`.
It writes only JSON report lines: the pane rectangle and intersecting layers
above it, or a null pane when the block is absent. Reports use window fractions,
account for zoom, and change only when the geometry changes.

Each consumer costs one Rex events stream and one initial `session.view` call.
A newer layout revision requests another `session.view`; concurrent events
coalesce and revisions already covered by the current view require no call.
The helper bounds event lines and snapshot output. It exits and terminates its
children on standard-input EOF, event-source exit, signal or transport failure.
It performs no layout changes and stores no state.

## Read the most recent output

`inspect` with `view: "capture"` (and the capture inside `view: "summary"`)
returns the end of the terminal's screen and retained scrollback, up to
`maxBytes` including JSON string quotes. Rex's `max_bytes` measures encoded
content without those quotes, so each request reserves their two bytes.
Rex itself returns the first part of long output. The extension uses that
snapshot's continuation ID and searches only its final bounded byte window
for the earliest suffix that reaches EOF within the request budget. The search
takes one read when the initial suffix fits, otherwise a bounded binary search.
It never scans from the beginning to find a tail.

An arbitrary byte offset can start inside a UTF-8 character. Rex replaces those
leading continuation bytes in JSON and exposes no raw next-position field.
The extension therefore uses EOF and the snapshot total to establish the raw
range, not decoded text length to advance a cursor. It removes only the leading
replacement bytes established by that range; genuine replacement characters
remain. Inconsistent continuation identity, totals or text fail the capture.
The data reports `content`, the byte `total` of the whole output, and the
`start` and `end` byte offsets the content covers. Local trimming selects whole
Unicode characters by their actual JSON-encoded byte cost and drops a partial
leading line when later nonblank lines remain. Escaped text does not discard a
fitting final marker. `coverage.truncated` is true when earlier output was left
out or the end was not reached. The beginning of
long output remains reachable through `rex_native` with the `format` and
`blob_read` block methods.

The `text` wait condition matches against the same most recent output, so a
readiness line printed after a long build log still matches. A `child_exit`
completion result carries the exit status beside a best-effort `capture` of the
most recent output, or `captureError` when that read failed; one wait therefore
answers both whether a test run ended and what it printed last.

`child_exit` observes the program Rex launched as the terminal's direct child.
For a command array whose own exit status matters, set `shell: "none"`.
This disables both the shell and login wrapper. `shell: "auto"` or an omitted
shell retains the installed shell/login behaviour, so the reported direct-child
exit can describe a wrapper rather than the intended inner command.
Every tool call uses one monotonic deadline from argument validation through target
resolution, nested CLI calls, observation and cleanup. `timeoutMs` defaults to 30 seconds
or the configured `maxWaitMs` cap, whichever is lower. A larger request uses the cap and
reports the effective duration. The same deadline applies to nested status checks and
capture continuations; a new subprocess does not restart it. The operation reserves
part of that allowance for process termination and state finalisation. Ownership store reads
use the `resolve` phase in both hosts; they do not perform an effect.

At the deadline, Rex stops its CLI or observer process, not the independent terminal
program. `timeout` means the deadline ended; `cancelled` means the caller or host
cancelled the operation. Neither establishes child failure, child exit or service
shutdown. `observation_failed` retains the CLI or event-source cause. A normal event-source
end without the condition is `observer_ended`. An evidence cap is `snapshot_limit`.

Text and status observations resume on relevant events, event-process exit, cancellation
or the deadline. Text observations also refresh the current output snapshot on a bounded
cadence because Rex publishes no output-change event. The interval starts at 250 ms and
doubles after each snapshot, so quick readiness shows quickly. The even spread of the
remaining snapshots across the remaining work window caps it, so the last snapshot
reaches the deadline. `maxSnapshots` still bounds the total; after the last allowed
snapshot no refresh runs. Status observations remain event-driven.
The event source remains available through the work window; the same operation allowance
includes its teardown. A budget-caused stop retains timeout or cancelled, not an event-source failure.
A failed or interrupted capture, or an unverified end, does not match text. A valid EOF
tail remains matchable when only its older prefix is omitted. Live events have no replay
guarantee. A bounded timeout does not establish that the condition never occurred.

An already observed child exit remains visible if its optional tail fails or times out.
The tail then carries its own error. After a mutation dispatch, incomplete acknowledgement
or state settlement retains unknown effects and an exact claim ID. Inspect and reconcile
that claim; do not replay the effect. A queued state update checks the deadline before
admission. An atomic append or commit already admitted finishes before the tool returns;
deadline metadata reports any overrun. The deadline is not a hard real-time guarantee for
synchronous JavaScript or disk operations.

It does not observe an inner command typed into a live shell. A wait deadline is
not a child exit, application failure or service shutdown. Child nonzero exit,
observer timeout, observer cancellation and missing completion evidence remain
separate outcomes.

## Broad native capability

Use `rex_native` with `kind: "catalog"` for the installed method names. An optional
`query` selects a case-sensitive literal substring, not a regular expression.
`offset` starts within the matched list; `limit` defaults to 50 and accepts 1–100.
For example, `{"op":"native","kind":"catalog","query":"session.","limit":10}`
returns complete names in installed order. The result reports total installed,
matched, returned and omitted method counts, plus `nextOffset` when another page
exists. Omitted counts include matches before the current page. Follow that offset
with the same query. Each call reads the current catalogue; pages are not a frozen
snapshot. Filtering limits emitted method names, not CLI discovery bytes. CLI failure
or truncated discovery remains a failure, not an empty match. Other native kinds
reject `query`, `offset` and `limit` rather than ignore them.

Use `kind: "describe"` with an exact `method` for its current schemas and validation
notes. `catalog` and `describe` always address the selected server and never
receive inherited context.

Use `kind: "api"` with the exact method and JSON arguments. The API receives
`args` directly and byte-for-byte; target fields do not rewrite arbitrary native
arguments. This preserves JSON nulls and empty objects without a Lua conversion.
An explicit target with IDs, `source: "inherited"` or `source: "focus"` is resolved
for conflict detection only. The method's required target IDs remain explicit JSON
arguments; the extension never injects them.

Use `kind: "lua"` with `code` and JSON `args` for composed native workflows.
Use `kind: "action"` for an existing configured action, not an arbitrary script
path. For these two kinds, `source: "inherited"` and `source: "focus"` resolve even
when the request names no IDs. The CLI then receives `-s`, `-b` and `--client` for
the resolved session, block and client. Inherited context uses the launch
environment and fails when it names no session; it never falls back to focus.
Explicit IDs stay authoritative, and no arbitrary block is selected. A focused
block resolves the same way as other focus requests. The extension does not freeze
Rex's full API into handwritten wrappers.

### Verified read-only methods

`api describe` carries no read-only marker for any installed method. The extension
keeps a small exact list of methods whose installed contracts only return current
server, session, client or terminal state:

- discovery: `block_creator.list`, `help.all`, `session.help`, `session.list`,
  `session.view`, `session.list_blocks`, `session.describe_block`,
  `session.list_clients`, `target.resolve`, `target.complete`, `client.list`,
  `client.inspect`, `server.version`, `server.whoami`, `server.status`,
  `hosts.list`;
- terminal readback: `com.superlogical.terminal.process`,
  `com.superlogical.terminal.program_status`, `com.superlogical.terminal.modes`,
  `com.superlogical.terminal.input_mode`, `com.superlogical.terminal.size`,
  `com.superlogical.terminal.title`, `com.superlogical.terminal.pwd`;
- filesystem and onboarding state: `com.superlogical.terminal.list_dir`,
  `com.superlogical.onboarding.state`.

Calls to these methods write no ownership record on success, CLI failure, timeout
or cancellation, so a full ownership store does not refuse them. They keep target
checks, the configured output limit and the deadline cap. A failed read keeps its
real CLI outcome and does not become an unknown mutation. Every other API method,
Lua script and action keeps effect admission, replay protection and uncertainty
semantics. Generic invokers, methods that produce snapshots or blobs, retained
clipboard or blob reads, and methods that change focus, labels or input are not
in the list.
The installed Rex skill supplies broader application guidance through Pi's normal
resource discovery. No extra skill loader or copied guide exists here.

Server APIs address the selected Rex server. Lua helpers and `rex.exec` execute
on the CLI machine unless their own documented operation explicitly selects a
server. Paths and programs for terminal creation belong to the selected server's
machine. Client actions address an explicit connected client where needed. An
existing second Mac is a separate server/client target, not a matching label or
local path. This extension does not configure remote access or expose a server.

Outer CLI success is not every inner operation's success. Lua nil/error pairs,
returned failure tables and local child exit codes remain visible application
data. Multi-step workflows are not atomic. Earlier resources and detached local
work may survive a later failure or CLI cancellation.

## Ownership, interruption and cleanup

Before an effect, the core awaits a retained `pending` record. It then records
acknowledged resources or an unknown outcome. A repeated call ID never blindly
repeats the effect. A fresh call ID is not proof that a retry is safe. Verified
read-only native API methods are not effects: they read no ownership state and
write no record. Other native API methods, Lua scripts and actions keep this
admission.

Ordinary Pi stores claims in `rex.ownership` custom session entries, outside model
context. Updates serialise the entire read/change/append operation. Persistent
sessions require an admitted user or assistant message before a pending effect;
Pi then appends the entry synchronously. In-memory SDK sessions retain claims only
for that session's lifetime. No power-loss durability claim follows from a
synchronous file append. Branch movement retains the same session-wide ownership,
because external terminal resources survive transcript navigation. A fork uses a
new session identity and ignores copied claims from the source session.
Ordinary state updates and live-call checks serialise within one Pi process.
The supported ordinary ownership boundary is one host per session header ID.
Separate processes that open the same header ID do not share a transaction line
or live-call tracker; this extension does not claim safe concurrent mutation in
that arrangement.

Durable stores conversation claims in the `rex.ownership` document. Updates use
its serial transaction line and commit before the effect. Documents use latest
history, initial state on fork, explicit owner identity and bounded checkpoint
intervals. A native fork or an ordinary new session ID does not inherit cleanup permission.
A byte-for-byte ordinary file copy with the same session header ID remains the
same logical owner; this extension does not distinguish those copies. No external ownership database mirrors these documents.

Use `owned` and `reconcile` after uncertainty. `owned` accepts an optional exact
`recordId` and a stored `phase`: `pending`, `confirmed`, `unknown`, `closed` or
`released`. Filters apply within this caller's claims before pagination. For example,
`{"op":"owned","phase":"unknown","limit":1}` selects the first unknown claim;
`{"op":"owned","recordId":"<full retained call ID>"}` retrieves one claim without
contacting Rex or changing storage. An absent ID returns an empty page, not an error.
A stored phase establishes neither current presence nor cleanup permission.

### Observe retained work

`{"op":"observe","recordId":"<full retained call ID>"}` reads current evidence
for that claim. Omit `recordId` to observe a page, with the same `phase`, `offset`
and `limit` filters as `owned`. An absent or foreign record ID returns an empty
page. Observation selects the retained server and exact resource IDs; it rejects
a `target` override rather than observe a different resource under the old claim.

Each `data.reports` entry retains the exact `recordId` and unchanged stored
`phase`, an `observedAt` timestamp, `complete`, and resource `observations`:

- `presence` is `present`, `absent` or `unknown`, from exact-ID resolution on the
  retained server instance. A changed or unavailable server is unknown, not absent.
- `childState` is `running` when the process snapshot identifies a direct child,
  `exited` when it reports `last_exit.exit_code`, `unknown` when neither fact is
  available, or `unavailable` when the read cannot complete. The `process` field
  carries the source snapshot, including exit evidence. A nonzero exit is a
  successful observation, not an observation error. Use `shell: "none"` when the
  launched command's own exit matters, rather than a shell or login wrapper.
- `status` contains untrusted program-status readback. `capture` contains the
  bounded recent output with raw-byte offsets. Neither establishes task success.
- `processError`, `statusError` and `captureError` identify unavailable fields
  without removing successful fields. A resource-level `error` explains absent
  or unknown presence; process, status and capture are unavailable in that case.
  A report-level `error` explains unresolved claims or server-read failure.

A record with no acknowledged resources remains unresolved, including a pending
claim. Observation never resolves that claim or changes its phase. It performs
no ownership writes, resource creation, application input, waits for child exit,
cleanup or automatic polling. `complete` means that the requested current
observations succeeded, not that the work completed. The page returns `observed`
when every report is complete, `observation_incomplete` for partial evidence,
`timeout` for its deadline and `cancelled` for caller cancellation. All observation
and reconciliation results identify the operation and phase separately from effect certainty. Completed fields survive interruption; remaining resources report
unknown/unavailable. Reports on one unavailable server do not suppress the other
reports. Timestamps identify independent reads, not an atomic snapshot.

The page accepts at most four records and uses one overall observation deadline:
`timeoutMs` defaults to the lower of 30 seconds and `rex.maxWaitMs`. A request
above that configured cap uses the cap and reports it. Native reads run
sequentially, with at most one CLI process active for the observation. Cancellation
stops those reads, not retained terminal programs; CLI shutdown retains the
transport's bounded drain. Use an exact record to retry partial evidence.

`maxBytes` requests JSON-encoded bytes per tail (256–16384). The core reduces it
to its configured default capture cap and the remaining page budget. Process,
status and capture fields share `rex.maxOutputBytes` across the page; each process
or status field also has a 16 KiB limit. Oversized fields become explicit errors,
not clipped JSON or successful empty values. The aggregate result bound still
covers references, metadata and diagnostics. When that bound omits bulk data,
follow its exact-record or smaller-page guidance. No observer state persists.

### Reconcile and clean up

These record lists accept `offset` and a bounded `limit`; coverage describes the
filtered list for `owned` and distinguishes fetched-page counts from references
removed by the result bound. Follow `nextOffset` with the same filters to avoid
skipping omitted references.
Default reconciliation reports current state without resolving uncertainty.
For one `recordId`, `recover: true` deliberately adopts conclusive current
presence or absence of every retained full resource ID on the verified server.
It preserves present resources for a new cleanup call or marks the claim closed
when none remain. Any uncertain lookup refuses recovery. A retained cleanup
producer link prevents recovery while that producer's invocation remains active.
The host tracks live calls across its per-tool core instances until their final
cleanup, not merely until cancellation is requested. Process loss removes the
host's live-call evidence, while the pending producer link remains available for
exact-ID recovery. External Rex work or an in-flight native effect can outlive the
host; current-state recovery does not establish that the earlier effect stopped. Recovery never replays
the old operation, recovers missed history or proves application success. Raw API/Lua/action effects do not automatically acquire ownership
of arbitrary resources they touch. Creation owns only acknowledged created blocks.
For a deliberately handled uncertain effect, `reconcile` with one `recordId`,
`release: true` and a nonempty `note` releases only the bookkeeping claim after
a current-state inspection attempt. It does not undo effects or prove their absence.
A released record is eligible for explicit forgetting without replay.

`cleanup` requires a retained record ID owned by this caller and the same server
instance. Its preflight resolves each exact retained session/block ID without
fetching the block's full API description. An absent, ambiguous or unavailable
target stops cleanup before effect admission; reconcile the record before retrying.
It closes exact owned blocks, not unrelated blocks in their parent session.
Empty parent sessions/windows are not automatically closed. Unknown
cleanup outcomes require inspection before another close. `forget: true` removes
a closed record. Ownership storage is bounded; a full store rejects new effects
before execution rather than silently discarding open claims. Regular effect
admission reserves capacity for owned cleanup.

Tool cancellation, ordinary session change, shutdown or native host shutdown
aborts the extension's active CLI work. Ordinary shutdown/reload and native host
close await owned invocation drain before their cleanup returns. A replacement
factory therefore does not lose live-call evidence while an older owned call
still drains. This does not silently stop retained
terminals, their programs or the Rex server. Explicit detached local Lua work
has its own lifetime. Native tools declare `replay: "unsafe"`; process recovery
returns interruption rather than repeating creation, input, scripts or closure.

## Status truth and its installed boundary

`rex_status snapshot` returns public current host activity. An optional explicit
target also returns the block's `program_status` records. In ordinary Pi,
`ExtensionContext.isIdle()` supplies current host activity. In native Durable,
`Harness.inspect()` supplies this conversation's live tasks and scheduler states.
A scheduler block is not a permission request. No live task does not establish
successful task completion. Other conversations remain outside that snapshot.

For repeated inspection, `bind` requires an explicit server, full session ID and
full block ID. The extension resolves the IDs and verifies status readback before
retaining the binding. Later snapshots recheck the server host and instance.
The binding persists for this caller until `unbind`; forks start without it.
The binding grants neither resource ownership nor attachment. `unbind` removes
only that inspection binding and clears no terminal records. Successful binding writes report
`effects.state: "confirmed"` for that local state change, not a terminal effect. A commit that
finishes after the cutoff retains its confirmed outcome and reports deadline coverage.
No background watcher exists for this capability.

Pi 1.4.0's ordinary interactive `ProgramStatusReporter` already owns real OSC 7501
run, compaction, dialog and settled-state reports. This extension does not emit a
second ordinary projection. RPC and headless sessions do not gain an attached
terminal through this extension.

The inspected installed Rex catalogue and terminal schemas expose
`program_status` readback but no terminal-output or status setter. Terminal
`write` sends application input. The native host has no verified attached PTY
output route. Native emission is therefore unavailable at that transport layer.
The extension does not fake it with OSC stdin, shell injection or inherited
`REX_*` values. It emits and clears no native terminal records. Structured status
inspection and ordinary Pi's real projection remain available.

Program records are untrusted reported data. A blocked permission report cannot
approve anything. A done report cannot accept a harness task. Capture covers only
bounded current screen/retained scrollback, not a full transcript. Alternate
screens expose the application's current display. Events provide no replay
promise; reconciliation restores current facts, not lost events.

## Tab names

Ordinary interactive Pi projects its canonical session name into the Rex tab that contains its own
terminal. The current working directory basename supplies the fallback when the session has no name.
The projection never changes the canonical Pi name, the Rex workspace label, or Pi's terminal status
reporter. Durable, RPC, JSON and print sessions do not project a label.

Each update requires inherited `REX_SESSION` and `REX_BLOCK` values, the launch `REX_SERVER` when set,
and a terminal process snapshot whose foreground PID is the Pi process. `session.view` locates the
containing tab across all layers. A missing block, a different foreground process, or a tab with
multiple blocks makes the update ineligible without a diagnostic. Display labels lose control and
format characters, collapse whitespace, cut to at most 128 Unicode code points, and trim the cut
result. Every recorded label and pending value meets the same rule, so a cut that lands on whitespace
leaves no trailing space.

The projector writes only a verified default label (`Window ` plus the final eight window ID
characters) or the exact automatic label recorded for the same host, server instance, workspace,
tab and block. It does not adopt an arbitrary existing label, even when that label equals the desired
name. Manual divergence removes the automation record. Management resumes after the label returns
to the verified default. On Pi exit, the last label remains in place.

Records live in `<agentDir>/rex/tab-labels/`, outside Rex terminal ownership and the Pi session.
Each SHA-256-named JSON file contains `version`, the five resource key fields, the last confirmed
automatic `label`, an optional `pending` label, an optional `attempt` identifier, and `updatedAt`.
A record without `attempt` remains valid. Writes use a temporary file and an atomic rename. The
store retains at most 256 records and prunes the oldest on write, subject to the record locks
described below. Invalid or mismatched records count as absent.

Before dispatching a label write, the store records a claim: the prior automatic `label` when the
tab was already managed, the desired `pending` value, a new `attempt` identifier, and `updatedAt`.
A result that proves the write never began withdraws only that attempt. This covers a run replaced
or cancelled after the claim and before dispatch, a failed claim write, and a setter result whose
process never started, such as a spawn error, a concurrency refusal or cancellation before spawn.
The withdrawal rereads the record and acts only when it still carries the same `attempt`; it restores
the prior label, or removes the record when the claim held no label. The original failure keeps the
existing single warning while the run is current. If the withdrawal itself fails, that warning
reports the store failure instead, because the claim then remains. A replaced run warns nothing.
Shutdown reports retained cleanup uncertainty through the same bounded warning.

Every other outcome after dispatch is uncertain: a timeout after the process started, cancellation
after start, a nonzero exit, an output limit, incomplete JSON or a transport error. The claim stays,
and a later read reconciles a label that matches `pending` without repeating the write. An
acknowledged write records the confirmed label and clears `pending` and `attempt` when its record
step succeeds. A contended confirmation leaves the claim pending for a later readback.

Before a label setter starts, the projector rechecks the desired name, current runtime, foreground
process, containing window and observed label. It checks host identity before the record step,
checks the exact stored claim under the record lock, and rechecks the current request after file
I/O. A stale request withdraws its own unstarted claim. A /name or RPC name change never grants
authority over a manual Rex label. Rex supplies no conditional setter, so a concurrent edit after
the final observation still has a race with the automatic write.

A session switch aborts the old transport and advances its generation; the new session starts
from fresh eligibility checks. Lost route or foreground preserves the label and withdraws only
unstarted claims. Already dispatched effects remain uncertain.

Session start and every interactive input request a fresh serialized update. A session name change
requests an update only when its sanitised label differs from the label already requested, so an
unchanged name event runs no Rex process. Each update rechecks the server identity, the foreground
process, the containing tab and its current label, so a tab reset to its default label or changed to
a manual label is observed by the next request without a preceding name change. A pass covers the
input revision it started with. When it writes, it also covers the name revision it read
immediately before writing; when it finds nothing to apply, it covers the name revision it started
with. A later input, or a name change after that point, therefore receives exactly one necessary
follow-up pass, and coincident start and input requests share one pass. Session changes invalidate
older runs and abort their CLI work; shutdown awaits a bounded drain. No polling, background
service, focus watcher, or OSC output participates. A single warning notification per extension
runtime reports real errors without adding persistent status chrome.

Every claim write, confirmation, manual-divergence removal, withdrawal (restoration or removal) and
pruning removal holds the lock of the one record it changes. A record's lock path is
`<sha256>.lock` beside its `<sha256>.json` record in the same store, and an open file description
holds the lock. Its scope is the local file step, so this extension never holds a record lock across
a Rex CLI call. The same lock coordinates replacement instances in one process and separate
processes that use the same store. Inside the lock the step reads the record, compares it, and
performs its single mutation, so no other holder can change the record between the comparison and
its write. A withdrawal therefore acts only while the record still carries its own `attempt`, a
confirmation writes only while the record still carries the claim's `attempt`, and a pruning removal
acts on the state it reads under that lock.

The kernel grants the lock atomically with the open and ties it to that open file description, so
elapsed time never transfers it. A holder
that stops, suspends or loses its event loop keeps the lock until it resumes and finishes its step.
When the holder process dies, the kernel releases the lock at once and the record becomes available
immediately. A lock file exists only while a step holds it: the release removes the path while the
open description still holds the lock, then closes the description. A crash can leave an unlocked
lock file, which the next step on that record locks, reuses and removes.

Each local record step makes one nonblocking kernel-lock attempt. Contention skips that projection
request without a timer retry or a self-generated update. The next real session-start, input or
name-change request tries again. Lock contention never counts as an absent record. A path/inode
mismatch also skips the step. Other file errors retain the bounded warning. A required cleanup that
fails remains uncertain; later genuine demand retries that exact cleanup once before projection.

After an attempt opens the lock file, the step compares the opened file's device and inode with the
file now at the lock path. A removed or replaced path is a mismatch: the step closes its description
and skips the step, so it never acts under a successor's lock. Any other failure to open or identify the lock path refuses that record. Record locks use the
macOS `O_EXLOCK` open flag; on another platform the step fails with an error. Pruning runs after the
writer's own lock is released, takes one victim's lock with a single attempt, and skips a victim
that another step holds. Inside that lock it removes the record only when the record's
modification time still equals the time listed before locking. The store keeps at most 256 records.

Shutdown waits at most two seconds for the active run. A lock stays held while its step's file
operation can still complete; shutdown never releases it. A step that belongs to a run makes no
mutation once that run is cancelled, including a step that acquires the lock after cancellation: it
releases the lock and changes nothing. Withdrawal of a claim whose write never began is cleanup. It
makes one nonblocking lock attempt even after cancellation and changes only a record that still
carries its own `attempt`. A contended withdrawal stays pending until the next real demand or the
single shutdown attempt.

One limit remains. Rex exposes no conditional label setter, so a simultaneous manual edit between
the final `session.view` read and `session.set_window_label` can receive the automatic label.

## Return from a local reader

The standalone `terminal-origin.ts` helper implements the package-level
[terminal origin contract](../../docs/conventions/terminal-origin.md). A local
opener runs `node <fixed helper path> capture` in its own environment and keeps
the resulting origin with the open request and reader window, never document
metadata. Capture confirms the inherited server, session and terminal block;
missing confirmation preserves only the Rex application identity.

`node <fixed helper path> focus` reads that origin from stdin. It revalidates
the server host and instance, session and placed block before the server
selects the exact block. It reports `focused`, `stale` or `unavailable` and
never guesses, sends input, creates resources or calls a client action. The
helper uses only the fixed installed Rex executable under the OS account's
home directory, bounded subprocesses and no retained state. Importing it does
nothing; native builds may embed the single file at build time.

The server selects a terminal block and its Rex tab, not a verified client or
Mac workspace window. A reader's application-level action therefore stays
**Return to Rex**. A failed or stale exact return must not prevent reading.
The helper is separate from tool configuration and caller ownership records.

## Configuration and loading

Load `extensions/rex/index.ts` through Pi's normal extension configuration.
The factory registers ordinary tools and synchronously emits its native
`durable:contribution`. Native hosts install that contribution without an ordinary
shadow session. Active worktree routing belongs to the normal
[worktree procedure](../../docs/conventions/worktrees.md).

Settings use the `rex` section of `<agentDir>/harness.json`, with per-field
environment overrides and the
[extension configuration contract](../../docs/conventions/extension-config.md).
Settings apply at extension or native host creation. Registry publications are
fresh configuration snapshots, not proof of runtime application.

<!-- harness:settings:start -->
| Key | Environment | Type | Default | Constraints | Description |
|---|---|---|---|---|---|
| executable | `PI_REX_EXECUTABLE` | string | "rex" | minLength 1; maxLength 4096 | Installed Rex executable name or path. The extension uses the supported CLI without a shell. |
| maxOutputBytes | `PI_REX_MAX_OUTPUT_BYTES` | integer | 65536 | min 4096; max 1048576 | Maximum combined stdout/stderr bytes retained from one Rex CLI process. Core results have a separate aggregate bound. Capture is not a complete transcript. |
| maxWaitMs | `PI_REX_MAX_WAIT_MS` | integer | 120000 | min 1000; max 300000 | Deadline cap for a complete Rex tool operation, including nested calls and cleanup. Background label CLI calls also use this cap. A larger request uses the cap and reports it. Deadline cancellation does not stop persistent terminal work. |
| maxRecords | `PI_REX_MAX_RECORDS` | integer | 128 | min 2; max 256 | Maximum retained ownership and operation records per caller. |
<!-- harness:settings:end -->

Combined CLI stdout/stderr retention is bounded per subprocess, with one shared
default of 65536 bytes for the settings declaration and the core. Core results
also bound the JSON-encoded aggregate envelope. Every emitted resource ID remains
whole.
Coverage reports data omission, diagnostic truncation and whole-reference omission;
record pagination and full omitted record IDs preserve access to later claims.
Capture and nested results can add framing. The request itself has a byte limit. Each wait bounds its
observer lifetime, snapshots and retained event sample. No heartbeat, second
scheduler, model loop or independent terminal store runs in the background.

## Defining host contracts

The adapter targets the installed Pi 1.4.0 contracts:

- Coding-agent `docs/extensions.md`, `docs/tui.md` and
  `dist/core/extensions/types.d.ts`: tool registration, ordinary renderers,
  cancellation, structured results, `appendEntry` and session lifecycle.
- Coding-agent `dist/core/session-manager.js`: custom-entry retention and
  synchronous persistence after conversation admission.
- Coding-agent `dist/core/package-manager.js` and `docs/skills.md`: normal shared
  Agent Skills discovery, including the installed Rex skill.
- Coding-agent `dist/modes/interactive/program-status-reporter.js`: ordinary
  interactive lifecycle projection and terminal ownership.
- Durable `dist/harness/types.d.ts` and `dist/types.d.ts`: unsafe replay, result
  channels, serial commits, public inspection and conversation documents.

The package-level [native contribution contract](../../docs/conventions/durable-contributions.md)
defines native installation. Focused colocated tests protect shared results,
caller identity, state serialisation, fork isolation, cancellation and status
binding. A passing source or mock check alone does not prove installed resource
loading or a live Rex application outcome.
