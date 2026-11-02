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
| `rex_terminal` | `create`, `inspect`, `input` | Establish persistent sessions, windows or splits; inspect structure, capture, process or program status; deliver application text and keys. |
| `rex_wait` | `wait` | Observe direct child exit, literal text or a reported status. Combine bounded live events with current snapshots. |
| `rex_native` | `native` | Retrieve the installed method catalogue or one method's schema; call an API, execute Lua or invoke an existing action. |
| `rex_owned` | `owned`, `reconcile`, `cleanup` | Revisit this caller's effects and resources, inspect current state after interruption, close only recorded owned blocks, or forget closed records. |
| `rex_status` | `snapshot`, `bind`, `unbind` | Inspect cooperating programs' reports beside actual current host activity. Optionally retain one verified inspection target per caller. |

Each request includes a visible `op`. Native execution also exposes `kind`,
`method`, `args`, `code` and `action` in the tool arguments. These are the real
ordinary and native policy boundaries. No arbitrary API or Lua operation receives
a read-only annotation. Policy remains the decision owner; terminal content and
program reports never grant permission.

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

Ordinary Pi cards show the action and known target facts separately, followed by
an outcome and effect state. Full IDs wrap when needed rather than receive fixed
short forms. Pi's default tool shell supplies padding, background and expansion.
The expansion hint uses your configured Pi key; an unbound key produces no
invented mouse instruction.

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
session or anchor block. Creation preserves completed output and does not request
focus for new windows or splits. Save the returned target and effect record ID.

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

`child_exit` observes the program Rex launched as the terminal's direct child.
For a command array whose own exit status matters, set `shell: "none"`.
This disables both the shell and login wrapper. `shell: "auto"` or an omitted
shell retains the installed shell/login behaviour, so the reported direct-child
exit can describe a wrapper rather than the intended inner command.
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
notes. Use `kind: "api"` with the exact method and JSON arguments. The API receives
`args` directly; target fields do not rewrite arbitrary native arguments. This
preserves JSON nulls and empty objects without a Lua conversion.

Use `kind: "lua"` with `code` and JSON `args` for composed native workflows.
Use `kind: "action"` for an existing configured action, not an arbitrary script
path. The extension does not freeze Rex's full API into handwritten wrappers.
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
repeats the effect. A fresh call ID is not proof that a retry is safe.

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
instance. It closes exact owned blocks, not unrelated blocks in their parent
session. Empty parent sessions/windows are not automatically closed. Unknown
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
only that inspection binding and clears no terminal records. No background
watcher exists for this capability.

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
| maxOutputBytes | `PI_REX_MAX_OUTPUT_BYTES` | integer | 32768 | min 4096; max 1048576 | Maximum combined stdout/stderr bytes retained from one Rex CLI process. Core results have a separate aggregate bound. Capture is not a complete transcript. |
| maxWaitMs | `PI_REX_MAX_WAIT_MS` | integer | 30000 | min 1000; max 300000 | Deadline cap for each Rex CLI process, in milliseconds. An operation can use several processes. Deadline cancellation does not stop persistent terminal work. |
| maxRecords | `PI_REX_MAX_RECORDS` | integer | 128 | min 2; max 256 | Maximum retained ownership and operation records per caller. |
<!-- harness:settings:end -->

Combined CLI stdout/stderr retention is bounded per subprocess. Core results also
bound the JSON-encoded aggregate envelope. Every emitted resource ID remains whole.
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
