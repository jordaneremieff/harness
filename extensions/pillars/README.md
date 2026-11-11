# Pillars access

The ordinary extension publishes its registered tool renderers at factory load and
on versioned requests through the [tool display contract](../../docs/conventions/tool-display.md).
The payload contains only tool names and renderer fields, never execution functions.
Those records come from `display.ts`, a presentation-only module over
`presentation.ts`; the Durable contribution advertises it as its display
descriptor (`{ version: 1, entry: "./display.ts", export: "toolDisplay" }`) so
the standalone Agent terminal renders Pillars cards locally. Importing it
registers nothing and emits nothing.

The extension makes the Pillars corpus directly accessible to agents and the
operator. The `pillars` tool is the single consultation surface: it reads current
source and carries the conditions that tell the model when to consult the corpus.
It reads [corpus governance](../../pillars/GOVERNANCE.md) directly rather than
adding a separate doctrine procedure.

`pillars_usage` reports bounded access evidence: recorded source requests and
results, not proof that an agent applied the guidance or that it was effective.
The `/pillars` command provides source reads, access-evidence inspection, and
judgment tasks for the operator.

## Check work, derive candidates, or review guidance

```text
/pillars check
/pillars check the proposed error handling
/pillars derive
/pillars derive what we learned from this design change
/pillars review
/pillars review agents keep asking permission despite Committed Contribution
```

`check` asks the agent to assess Pillars alignment and then continue the work it
was already doing under that assessment. `derive` asks it to identify
a transferable candidate, an adjustment to an existing entry, or no candidate
when the evidence does not warrant one. `review` asks whether existing guidance
expresses the intended behavior and supports its use. For observed mismatches,
it investigates the cause before proposing a correction. Each accepts one optional free-text hint. The complete text after the action is the hint, including quotes,
newlines, and flag-like words; no option parsing applies. Without a hint, the
agent infers the subject from the current conversation. It asks only when that
context does not identify a useful subject.

These actions send a visible, extension-labeled task message into model context.
They start a turn when idle and steer an active turn through Pi's normal message
delivery. The agent keeps control of the reasoning depth and response form.
The scaffold points to the live inventory, governance, and relevant entries;
[governance](../../pillars/GOVERNANCE.md) owns document types, consultation, and
mutation rules. The extension neither copies those rules nor scans session
history to choose a target. `check` requests the assessment and then the
correction: the agent applies what the check found to the affected reasoning,
plans, and artifacts of the task in progress and continues that task in the same
turn, inside the authority the task already carried. It does not stop at the
verdict and does not ask to resume authorized work. When no correction is
warranted the task continues unchanged, and when no task is in progress the
assessment is the whole result. A genuine operator decision or an ungranted
authority stops only the actions that depend on it. `check` grants no corpus
edits, new surfaces, destructive acts, publication, or credential use. `derive`
and `review` keep proposals provisional in chat and grant no corpus-change
approval. These actions do not compute an alignment score.

For recurring misses, `review` compares expected and observed behavior against
source and delivery evidence. Delivery, recognition, interpretation, application,
and doctrine are possible causes, not a mandatory checklist. Sparse examples
do not establish recurrence or its cause. The agent checks
whether the entry applies and whether an exception or competing constraint
explains the behavior. It separates demonstrated problems from hypotheses and
recommends the correction at the responsible layer. A missing instruction needs
a delivery correction, not automatically stronger doctrine.

`review` also supports routine maintenance without an incident, through useful
dimensions such as clarity, scope, overlap, and consistency. It does not invent failures, demand an incident archive,
or assume a rewrite is necessary. Any proposed corpus change follows live
governance and remains subject to operator approval.

## Read the corpus

Agents use `pillars` with no arguments to read the inventory and discover
resource identifiers. Read `resource:"governance"` for the consultation
procedure, then read the relevant full entries. The tool returns current source
text and its SHA-256 digest, not a generated summary or a compliance verdict.

```json
{}
{"resource":"governance"}
{"resource":"heuristic-verification-reach"}
```

Use an inventory identifier, not a filename or path.
`{"resource":"governance"}` is valid; `governance.md` is not an identifier.
For a source continuation, copy both `nextOffset` and `referenceBodyDigest`
from the same page. For an access-evidence continuation, send `cursor` alone.
Omit fields for defaults; null does not select a default.

The tool returns at most 32 KiB. If it returns `nextOffset`, continue with that
UTF-8 byte offset and `referenceBodyDigest`. A changed reference fails rather
than silently combining revisions. A source body is limited to 1 MiB.

Source errors retain `schema:"pillars-source-error"` and `code`.
`invalid_input` and `source_changed` also carry a bounded `message` (at most
1,024 characters) that names the field, describes the received value, explains
the rejection, and gives the valid input. The tool throws the JSON error object
as its message, so Pi marks the result as an error without discarding the
structured diagnostic. Pi leaves `details` unset for thrown errors. An unavailable
catalog or unreadable body remains `source_unavailable`, not invalid input.

Resource identifiers are not filenames. A `.md` suffix is rejected with the
exact canonical request when that identifier exists, for example:

```json
{"resource":"heuristic-verification-reach"}
```

A unique single-character insertion, deletion, or substitution also produces a
suggestion. Ambiguous or more distant inputs receive the identifier syntax and
the instruction to call `pillars` with `{}` for the inventory's `resources` list.
Suggestions never rewrite or accept an invalid identifier. This preserves one
resource format while correcting the filename-versus-identifier confusion at
the failed call.

Validation identifies non-object input, unsupported fields, malformed or unknown
resources, invalid offset types or ranges, malformed digests, missing continuation
digests, offsets past the body, and offsets inside a UTF-8 character. Null resource
and offset fields are invalid, not defaults. Changed-source errors tell the caller
to omit both continuation fields for a fresh read. Other continuation errors tell
the caller to copy `nextOffset` and `referenceBodyDigest` from the same page or
restart without them.

Both tools validate through Pi's `prepareArguments` callback before host schema
validation, as well as at their execution boundary. They report the first invalid
field. For source and usage fields, numbers and booleans are shown directly. Arbitrary
strings and unsupported field names are described by type and length, not echoed;
object and array contents are withheld. Draft validation names the failed
condition: non-string value, blank text, malformed Unicode, or excessive character
count. String diagnostics report the combined-character count and UTF-8 byte size,
never the draft text. The source tool echoes only a known identifier with its
`.md` suffix.
These rules prevent control characters, paths, credentials, and arbitrary input
text from entering diagnostic messages.

In the terminal TUI both tools render inside Pi's standard tool-call shell,
collapsed by default. The call line names the requested resource or evidence
view; the result line names the delivered byte range or evidence page and hides
the body behind the host's tool-output expansion binding (`app.tools.expand`,
`ctrl+o` by default). Expanding shows the full source text or the evidence page.
The host owns the collapsed and expanded state; the tools only render it.

Operator commands:

```text
/pillars
/pillars help
/pillars browse
/pillars read governance
/pillars read heuristic-verification-reach
/pillars read <resource> <nextOffset> <referenceBodyDigest>
```

`/pillars` displays command help, examples, and the actual inventory.
`/pillars help` shows just the guide, even if the corpus is unavailable.
In the terminal UI, `/pillars` and `/pillars browse` open the read-only Pillars
view in the shared browsing frame below the native transcript
(`docs/conventions/operator-panels.md`): a searchable inventory of every
catalogued source with its canonical title, type, and index statement quoted
from the inventory, and a detail that reads the selected source page by page.
The detail shows the exact resource and reference digest of the page it read;
**Read more** follows the continuation under that digest; a changed source
refuses it, so pages of two revisions never mix, and **Read again** reads the
source from its first page. A read cancelled by a newer selection never
leaves the view waiting, and a cancelled continuation keeps the pages already
read. The footer at the bottom lists each control as its
key and its short label: `m` reads more, `r` reads again. A click on a control
runs the same action as its key. `/` focuses the search field, which filters
titles, types, and statements. `x` opens the list of every other action.
Escape goes back. Selecting a row reads; nothing in the view starts a check,
derivation, or review, and nothing writes to the corpus. The command shows
Pillars on its own.
Because this extension publishes it as an operator view, `/dashboard` also
shows it as a tab. The view module loads when the destination opens; until it
is ready the frame shows a reading placeholder.
The attached Agent terminal opens the same view through `operator-panel.ts`,
a presentation-only module that routes the inventory and every page read
through the host's `pillars` contribution command. Outside the terminal UI, or when the
inventory cannot be read, `browse` falls back to the Markdown inventory text.
Argument autocomplete filters the identifiers already discovered for the current
session and performs no corpus I/O. In ordinary sessions, session start and an explicit
non-help `/pillars` command refresh the catalogue. If a judgment command (`check`, `derive`
or `review`) cannot refresh it, the command warns you and retains the last available
catalogue; source reads still verify current body bytes. Without a prior catalogue,
the tool reports that the source is unavailable. Startup and explicit refresh
commands make the catalogue unavailable after an unsuccessful refresh. Source
reads use current body bytes; the identifier catalogue is not a cached
doctrine body. To discover changed identifiers or a changed corpus selection,
run `/pillars` or start a new session. Autocomplete offers actions with
descriptions and resource identifiers after `read `. It does not complete
free-text hints or invent continuation values. Source output uses Pi's
Markdown renderer in the terminal. Help, browse, read, and access-evidence
output stay outside model context: TUI, JSON, and RPC use a custom session
entry, while text-print mode writes to stdout. JSON/RPC consumers receive the
host's `entry_appended` event. Command output remains in the ordinary session record where that record persists;
it is not stored in the aggregate telemetry directory.

## Assess an agent-authored draft

The agent can include an optional `draft` in an ordinary `pillars` source read:

```json
{"resource":"heuristic-verification-reach","draft":"The test confirms source delivery, not whether the agent applied the guidance."}
```

The tool's description and prompt guidance ask the agent to submit a concrete
proposal before a consequential decision, action, or answer without waiting for
an operator cue. Routine execution and exact-output tasks need no added ceremony.
Omitting `draft` keeps source-only behavior. A draft must be a nonblank,
well-formed Unicode string of at most 8192 combined characters. Each unit starts
with one code point and absorbs following marks in U+0300–U+036F,
U+1AB0–U+1AFF, U+1DC0–U+1DFF and U+FE20–U+FE2F, plus variation selectors
in U+FE00–U+FE0F. A following U+200D joins the next code point and its attached
marks or selectors; this repeats for further joiners. If the unit starts with
U+1F1E6–U+1F1FF, it also absorbs one next unconsumed code point in that range.
This is not full Unicode grapheme segmentation: skin-tone modifiers, CR and LF,
and conjoining Hangul jamo each count separately. Preparation and execution
enforce this limit in ordinary and Durable sessions; there is no separate UTF-8
byte limit. Pi validates JSON Schema string lengths as code points.
The draft schema therefore declares
only a nonempty string, with no maximum length or regular-expression pattern.
This lets combined-character drafts reach the handler without a stricter host
limit. The handler rejects blank text, malformed Unicode, and excessive character
counts with specific diagnostics. This keeps provider-facing schemas simple and prevents
schema-pattern errors from replacing the handler's messages. The extension preserves
its text exactly and rejects invalid input without echoing it.

After a successful source read, the extension sends a native assessment task for
the ordinary model continuation. Pi delivers that task after the tool results
in the current batch. The source JSON, digest, pagination, and error contract
remain unchanged; the task is a separate message. It applies the same
[correction and authority boundaries](#check-work-derive-candidates-or-review-guidance)
as `/pillars check`. Existing consultation rules still apply, including use of
relevant bodies already in context when sufficient. The task requests no separate
verdict or doctrine recital unless the operator asks for one. It labels the draft
as agent-authored data, not an operator request, new doctrine, or permission.

The task uses `sendMessage` with `triggerTurn:false`; the extension starts no
additional model turn and owns no assessment queue, pending state, or context
transform. Source errors and cancellation before admission send no task.
Cancellation after admission leaves the task in native history without requesting
another turn. Reload and session resume do not replay or duplicate it. This is
not an action gate: other tools in the same batch still execute before the
assessment reaches the model.

The terminal call line marks an agent draft assessment but does not display the
draft. The task has `display:false`, so it stays outside the ordinary message
display while remaining model-visible. **A draft is not private scratch.** Both
the tool input and assessment task enter native session history, and provider
requests include the draft. Do not submit secrets. The aggregate access store
retains no draft text, and its counts remain source-access evidence rather than
assessment or application evidence.

Context cost consists of the tool's static guidance plus an assessment task for
each successful call that includes a draft. The task contains fixed instructions
and a JSON-escaped copy of the draft; escaping can make it larger than the input
byte limit. The extension has no automatic retry or review loop. Agent selection
and the quality of the resulting correction remain model judgments, not a
compliance verdict computed by the extension.

## Discovery and activation

The extension and the corpus ship together in one package. At session start the
extension resolves the corpus root as the sibling `../../pillars` directory
relative to its own module location. `PI_PILLARS_CORPUS` overrides that root
with an absolute path. A rejected relative override returns the package default
and a settings diagnostic; it never resolves against the session directory. The extension does not guess a corpus directory,
depend on the registry extension, or scan session history. It loads the bounded
inventory and canonical targets, with no full-corpus body cache.

The extension has a persistent worktree and an explicit local entrypoint.
Follow [the worktree procedure](../../docs/conventions/worktrees.md) for local
activation. Local activation does not promote the branch or push changes.
New sessions load the configured entrypoint; an existing session requires
`/reload`. The corpus resolves from the package location, not an independent
copy inside this extension.

## Read access evidence

The model-callable `pillars_usage` tool is read-only:

```json
{}
{"windowDays":7}
{"view":"revisions","windowDays":30}
{"cursor":"<nextCursor>"}
```

Invalid usage requests retain `schema:"pillars-usage-response"`, `schemaVersion:2`,
`kind:"error"`, and the existing interpretation fields. The error `code` includes
`invalid_input`; the existing `message` field permits at most 1,024 characters.
Invalid requests identify non-object input, unsupported fields, invalid `view`,
invalid `windowDays`, malformed `cursor`, or `cursor` mixed with `view` or
`windowDays`. The parser reports these before capture, so they neither read the
store nor replace an existing capture. Pi receives pre-execution validation errors
as thrown JSON messages; direct reader calls return the same error object.

Cursor errors distinguish invalid encoding, an unknown capture, an expired or
replaced capture, and a page outside the capture range. Their messages tell the
caller to copy `nextCursor` unchanged with `cursor` alone, or start a fresh view
without `cursor`. `cursor_invalid` and `cursor_expired` permit bounded
cause-specific messages; other non-input error codes retain their fixed messages.
A fresh capture that expires or is replaced uses `cursor_expired` without claiming
that the request contained a cursor. The response schema
validates these error forms along with successful pages.

The default overview ranks resources by requests, then class and identifier.
It retains the leading 63 concrete identities and folds remaining identities
into an explicit overflow row. The revisions view retains every admitted joint
row: UTC day, request/result stage, resource, model, reasoning, reference digest,
observer version, and Pi version. Follow every page before inferring that an
exact row is absent. Overflow never proves zero activity for a concrete identity.

```text
/pillars usage
/pillars usage --days 7
/pillars revisions --days 1
/pillars next <nextCursor>
/pillars export "/absolute/local/file.json" --days 7
```

`pillars_usage` marks every `kind:"error"` response as a tool error in ordinary
and native sessions. An unsuccessful read returns the same JSON diagnostic in its
text and details.
Successful pages, including empty pages, are not errors. The tool has no declared
structured output schema: ordinary and native Codemode scripts receive text on
success and reject with the JSON error text on failure. Catch that failure when
recovery is part of the script. Direct native `api.executeTool` returns an error
result instead; inspect its `isError` and `structuredOutput` fields. A cursor
error requests a fresh read; it does not authorise storage deletion or reset.

Each operator command displays one bounded page. `/pillars next` continues the
same frozen capture without another scan. Commands and the tool share one
capture; a fresh request or export replaces it. Pages contain at most 24 rows
and tool responses at most 32 KiB. The capture expires after 600 seconds and
retains at most 61,500 rows and 64 MiB of serialized data. The maximum revision
view requires 2,563 pages. Narrow the day window or explicitly export for bulk
inspection. The command does not inject a bulk report into model context.

Export creates one complete JSON document, capped at 64 MiB. It requires an
existing trusted parent on a local filesystem. Network filesystems are
unsupported but not detected. It rejects symlink
components, expansion syntax, and existing destinations. It writes an exclusive
private temporary file, syncs it, publishes through an exclusive hard link,
and syncs the directory. A post-publication cleanup or sync error reports that
the final file exists with unconfirmed durability. The model has no export
operation. The extension performs no upload or automatic export.

## What observations mean

Requests and results are independent observed read events, not sessions,
applications of doctrine, adherence, effectiveness, or causal evidence. A result
callback does not prove final provider delivery. Matching reference bytes does
not prove semantic correctness.

The observer recognizes eligible `read` calls and this extension's `pillars`
source tool. It resolves dimensions independently at each callback. For raw
reads, exact returned-text equality establishes a complete reference body.
Unequal raw text has unknown extent: a missing limit, a builtin provenance label,
a matching prefix, and a later file hash do not prove a complete result. Pi's
public builtin label also covers SDK base-tool overrides. The observer does not
invent stock-adapter certainty from that label.

For its own source tool, the extension retains bounded memory-only execution
and range evidence. Foreign registrations and altered range frames do not gain
source-specific attribution. Assessed complete outputs are verified or
mismatched against reference bytes at that callback; partial, unknown, and
error outputs remain unverifiable. No mismatched-body fingerprint persists.

Operator command reads, registry excerpts, shell reads, and unobserved
callbacks do not enter this metric. Invoking `check`, `derive`, or `review` is not itself
a read event; eligible source tool calls during the resulting agent turn are
observed normally. These are scope boundaries, not proof of
non-use. Per-turn deduplication admits at most 4,096
call/stage keys and refuses new keys after saturation. It does not claim an
exact lost-event count for unknown duplicates.

Every evidence page repeats the fixed interpretation contract. Live collectors,
whole-window coverage, and unpersisted loss always remain unknown. Storage
incidents describe detection days across **all retained shards**, independent
of the selected event window. Receipt quota counts marked days, not refused
owners or lost events. An empty store is normal empty evidence; corruption,
unreadable storage, and lock contention are errors, not zero use.

## Storage and lifecycle

Aggregate storage is pure TypeScript. It requires no Python helper, `fcntl`,
native npm lock package, or sibling extension mechanism. Publication is
atomic: a writer writes a private temporary file, syncs it, publishes it by
rename, and syncs the containing directory. Repeated JSON keys in a stored
file resolve to the last value before schema validation; the store does not
reject duplicate keys.

Aggregate writes use a macOS kernel file lock on the persistent `store.lock`
inode. One nonblocking acquisition either owns the lock or reports contention.
The writer holds its descriptor through publication and directory synchronisation,
then closes it. The kernel releases exclusion when the process exits, including
after a crash. File presence, contents, age and recorded process identifiers do
not prove ownership. The writer never unlinks the lock path. Other platforms
refuse aggregate writes with `Pillars aggregate writes require macOS.` Corpus
source reads remain available.

A safe lock inode can have hard-link aliases; every alias shares the same kernel
exclusion and stays unchanged. Acquisition requires read/write access and no
group or other permission bits, not exact equality with mode `0600`. Unsafe modes
refuse. An explicit owner chmod to `0600` at a quiet-writer boundary repairs the
same inode without deletion. The extension performs no automatic permission repair.

Reads remain lock-free and create no storage. A safe lock file does not block a
read. Unresolved `pending.tmp` makes a capture unavailable until a writer performs
pending-publication recovery. The store ignores the exact `.DS_Store` metadata
name and validates every managed entry. It does not ignore unknown shard files
or repair corrupt shards.

Before publication and retention changes, the writer checks that the lock path
still names its held inode. Missing or changed identity stops publication and
blocks further publication by that collector. Its sealed batch remains buffered.
The writer never removes or recreates the lock as recovery. A pathname check and
rename are separate system calls; an external unlink between them still defeats
exclusion. Never remove a live or persistent lock file.

Contention reports `Pillars aggregate writer is busy. The next publication event retries. This writer never removes the lock file. Do not remove it.`
Identity loss reports `Pillars lock path changed during the write. Publication stopped. This writer never removes the lock file. Do not remove it.`

Kernel exclusion coordinates aggregate writers that use this protocol. A writer
that does not use the protocol is not excluded. The writer never removes the
persistent lock file. See the
[file-exclusion convention](../../docs/conventions/file-exclusion.md).

The store assumes a local filesystem. It does not admit or detect filesystem
types, so a network filesystem is unsupported but not detected. Schema
validation rejects invalid shards, counter partitions, and clock rollback.
The store does not repair or migrate corrupt state. A shard that carries a
retired resource class fails validation as corrupt, which blocks both readback
and publication for the whole directory until the operator clears it; the
collector counts those failed publications as write incidents. Storage
unavailability does not prevent corpus retrieval.

Storage uses 30 fixed daily slots, each at most 2 MiB, with 2,048 concrete
cells, reserved per-stage overflow, and 4,096 private owner/day receipts.
Cells, health, and consecutive-sequence receipts publish in one atomic shard
replacement. Retries reuse an immutable sealed delta. A confirmed duplicate
also confirms directory synchronization under ownership after an uncertain prior
publication. A repeated sync failure returns `publication_failed`; the collector
retains its sealed delta for retry. Injected filesystem errors verify retry
behaviour, not power-loss safety.
Within-day pressure folds identities, preserves result classes, and removes
reference attribution. Receipt pressure records a sticky day flag when that
publication succeeds. Retention watermarks prevent clock rollback from
resurrecting expired receipts.

A reader captures bounded coherent shards without taking the lock, then
projects and paginates them. It rejects unresolved temporary state rather
than block on a writer. The managed store peak is bounded by 62 MiB plus
4,096 control bytes. Decoded-node, heap-headroom, heap-growth, and
process-memory guards supplement serialized limits. These guards are not
a hard process-RSS promise: the Pi host and other extensions share that process.

The collector attempts publication on its first eligible observation, later
eligible observations, turn completion and shutdown. Ordinary observations are
coalesced to at most one attempt per second. A deferred or contended batch stays
buffered until another publication event; no retry timer probes the lock.
A retained busy batch produces no warning or `writeFailures` incident until three
consecutive busy attempts, which distinguish one collision from repeated deferral
without a timed retry. The third attempt produces one warning and incident per
busy sequence; a non-busy outcome resets the sequence. A busy shutdown probe
produces a warning and incident because the unpublished tail is lost when the
collector closes. An unsupported platform produces one diagnostic per collector:
ordinary sessions show a warning in the UI or stderr without a UI, and native
sessions write the diagnostic to stderr. Each
new instance uses a fresh private owner key. Forks do not replay history.
Unpersisted tails remain unknown after process loss or an unsuccessful final
attempt.

## Durable agents

Agents that run on Pi Durable receive a native form of this extension. The
ordinary factory emits its contribution on the `durable:contribution`
channel with the absolute entrypoint path as its source. The
[agent extension](../agent/README.md) owns contribution discovery and host
installation.

The native form speaks the host's vocabulary directly. It contributes the
same `pillars` and `pillars_usage` tools, a prompt section with the usage
guidance, native hooks, and a `pillars` command for the judgment actions. The
surfaces share the slice's corpus access, draft assessment, evidence store,
and readback functions with the ordinary entrypoint; no ordinary session API
runs inside the Durable form.

The tools declare replay class `safe`. A corpus read and an in-memory page
capture repeat no external effect. Attribution writes are deduplicated with
stable task memo keys, so a replay after process loss does not silently count
another access. Native `details` equal the ordinary tool details. Native tools
return bounded model text through `output` and declare no structured output
schema. Code mode scripts receive the source page or usage response as a JSON
string. Source errors and invalid arguments reject the script's call. The
ordinary tools keep their `content` results and return no `structuredContent`.

Attribution uses the native tool and generation hooks. `beforeTool` and
`afterTool` on `ToolTask` admit request and result observations for `pillars`
and `read`. Pi also calls `afterTool` for host-written settlements. Diagnostic
codes `tool_unavailable`, `invalid_arguments`, `blocked`, `interrupted`,
`restart_limit`, `aborted`, and `abandoned` admit no result observation or draft
assessment. A request observation already admitted by `beforeTool` remains request
evidence only. A `GenerationTask` `afterTools` hook flushes the round's admitted
evidence, so a settled run leaves no pending cells; the host shutdown signal
releases the reader early; and the close registration makes the host await the
final flush before it closes storage. Observations record the resolved
agent's model and thinking level through the host Harness. The store, its
configuration variables, and the evidence meanings are the same as for the
ordinary entrypoint.

Documented differences from the ordinary entrypoint:

- A draft assessment arrives as an `info` diagnostic attached to the tool
  result for a model-issued call. For a nested call, `afterTool` submits a
  `pillars-draft` entry with a user message through the public conversation
  write API. Native code mode does not forward successful nested diagnostics to
  the model. The write waits for the next boundary after the parent result,
  starts no additional turn, and uses the nested task ID as its deduplication
  key. The hook uses the tool's existing source details to identify a successful
  read. Source errors and cancellation before submission admit no assessment.
  The source page stays unchanged.
- Collector diagnostics go to standard error, because a Durable agent session
  has no UI host. Invalid `PI_PILLARS_COLLECT` values still disable collection.
- The `pillars` command admits the judgment actions through its text route
  (`agent_command`, `/agent command`): it submits the same judgment prompt to
  the conversation as a steer. With structured `data` it serves the attached
  terminal's reader instead: `{ op: "inventory" }` answers the catalogued
  sources with their quoted index statements, and
  `{ op: "read", resource, offset?, referenceBodyDigest? }` answers one bounded
  source page or the access error, through the same `access` owner as the
  `pillars` tool. The contribution advertises `./operator-panel.ts` as its
  `panel` descriptor bound to that command. Neither route starts a check,
  derivation, or review; a malformed request is an error. The ordinary usage
  and help paths render through the terminal UI, which a Durable command has
  no view for; `export` writes an operator filesystem path that the calling
  session may not share. The tools remain the model-facing form for source
  reads and access evidence.

## Privacy and configuration

The aggregate store contains UTC dates, resource/model/reasoning/version
identities, reference digests, counters, and private random receipts. These are
linkable private metadata, not anonymity. It contains no prompts, result text,
raw paths, call/session identifiers, PID, exact event timestamps, or returned
mismatched-body hashes. Public evidence and exports exclude receipt identities.

The [`settings.ts`](settings.ts) declaration and local reader/publisher use the package-level
[settings contract](../../docs/conventions/extension-config.md). Per-field precedence is environment,
`pillars` in `<agentDir>/harness.json`, then default. The host supplies the agent
directory; the corpus default remains package-relative.

<!-- harness:settings:start -->
| Key | Environment | Type | Default | Constraints | Description |
|---|---|---|---|---|---|
| dir | `PI_PILLARS_DIR` | path | &lt;agentDir&gt;/pillars | absolute input | Private aggregate directory. |
| corpus | `PI_PILLARS_CORPUS` | path | Package sibling ../../pillars | absolute input | Corpus root with inventory and governance sources. |
| collect | `PI_PILLARS_COLLECT` | boolean | true | none | Collect source access evidence. false stops collection only; corpus access and retained-data readback stay available. |
<!-- harness:settings:end -->

Document collection values are booleans. Environment collection values accept
`0`, `1`, `false`, and `true`. Invalid selected input returns the declared safe
default with a rejected-source diagnostic. For an invalid collection field,
the runtime additionally disables collection with a local diagnostic, even
though its configured default is `true`. Disabled collection preserves corpus
access and retained-data readback. Invalid directory or corpus inputs use their
safe defaults. An unavailable valid corpus path still makes source access
unavailable.

The ordinary factory publishes fresh settings snapshots and removes its
subscription on shutdown. Native creation replaces that publisher on the same
host resource-loader bus with a publisher bound to the host's agent directory;
host close removes it. Registry inspection requests fresh configured values,
not proof that existing collectors or stores applied them. Store paths bind at
factory/native creation; ordinary session start reads collection configuration
again, and ordinary catalog discovery reads corpus configuration again. Native
creation binds collection and corpus configuration for that host.

`PI_PILLARS_TEST_HOST_ROOT` is a test-only coding-agent package root for SDK
integration regressions; unset uses checkout dependencies.

## Behavioral evaluations

The maintained [`commands.eval.mts`](commands.eval.mts) suite exercises the real
`/pillars check`, `/pillars derive`, and `/pillars review` commands against
synthetic conversations and the live package corpus. It covers hint selection, inferred and absent
subjects, supported alignment, unsupported claims, candidate exploration,
existing-entry overlap, type choice, no-candidate outcomes, and quoted authority.
Review cases distinguish delivery gaps, application gaps, recognition scope,
operator expectations, sparse evidence, defective drafts, routine maintenance,
and absent context.

Check cases also cover corrected continuation: a misplaced recommendation whose
corrected form must still be delivered, a corrected premise that must reach its
dependent conclusion, an ungranted authority that stops only the action that
depends on it, and a completed subject where the assessment alone is the whole
answer. Those cases use a requested chat artifact as a fixture-compatible proxy
for continuation. The exact-artifact check is a floor: it rejects a reply that
omits the requested record, and it does not establish that the agent resumed a
live edit, process, or session. The task and output format appear before later
factual exchanges, so the final seeded turn does not repeat the deliverable
request. These checks measure completion under the selected command text, not
improvement caused by that text. Human adjudication decides whether the delivered
work reflects the assessment and whether a reply that shows the artifact only as
a future example still withheld the work.

Validate the suite without model inference:

```sh
npm run evals -- validate extensions/pillars/commands.eval.mts
node --test extensions/pillars/evaluation.test.mts
```

Use the existing [evaluation CLI](../../evals/README.md) to plan and run this
suite with explicit participants, effects, and the exact approved plan digest.
The suite does not select models or grant paid execution. Results remain in the
framework's ignored evidence store; semantic quality requires human adjudication.
Source-access checks and rejected mutation attempts are structural evidence,
not proof that an assessment or candidate is good. Reviewers derive the relevant
Pillars from the source and task rather than treat fixture gold as a closed list.
Lexical floors grade only an artifact that the seeded task requests verbatim.
No exact response wording, alignment score, or candidate quota is required.

The evaluation-only [`evaluation.ts`](evaluation.ts) wrapper calls the real
extension factory and admits only `check`, `derive`, and `review` invocations.
It waits for Pi's `agent_settled` event before command return
because this SDK evaluation adapter does not bind command-context `waitForIdle`
actions. Its `aborted` flag reports a cancelled evaluation command as a command
error, including cancellation before a new assistant message exists. Fixture
shutdown also cancels an active command. The production command and prompt are
unchanged. Synthetic SDK tests cover completed and aborted command turns,
settlement before the idle check, source approval, and cleanup.

The variant's `pillars-eval-source` flag binds a digest of the corpus and local
extension TypeScript sources into the approved plan. The wrapper checks this
value before command execution against the sources read at fixture startup.
A different digest requires a fresh plan. This guard does not freeze the
filesystem during a run; individual source results retain their body digests. The adapter excludes custom
request messages from its normalized transcript; the command input and pinned
source define that scaffold, not an assistant-text check.

Collection is disabled through an injected settings environment and an isolated
agent directory. The wrapper leaves the process environment unchanged, ignores
ambient machine settings, and removes that directory on fixture shutdown. The model has `pillars` for
source access plus `edit` and `write` to expose attempted mutation. A hook blocks
all calls except `pillars`; attempted edits still fail the suite's checks.
This controlled tool set is not full-session parity. The suite does not compare
against a baseline, test terminal autocomplete, or submit a command during an
existing turn; deterministic command and integration tests own those mechanics.

### Reader comprehension

The maintained [`reader-comprehension.eval.mts`](reader-comprehension.eval.mts)
suite evaluates completed explanations and repairs rather than `/pillars`
consultation. Synthetic cases cover self-contained answers, necessary technical
terms, overcompressed language, claim support and ownership, warranted
qualifications, evidence-based claim corrections, neutral analysis, exact
quotations, raw and machine output, and insufficient evidence.

The ad hoc text subject supplies complete working-tree bodies of the inventory,
governance, Principle Unearned Prose, and Heuristic Tell Laundering through the
existing Pi adapter's `contextFiles` configuration. The suite loader reads the
named files; the model receives pasted full bodies, not filesystem access.
The approved plan retains that content and the adapter's per-resource digests.
Other entries listed in the inventory are not supplied. Fixture gold and claim
ledgers stay in review data, outside the model's seed messages and prompt.

Validate the suite and its deterministic tests without model inference:

```sh
npm run evals -- validate extensions/pillars/reader-comprehension.eval.mts
node --test extensions/pillars/reader-comprehension.test.mts
```

Use the existing evaluation CLI for separately approved model execution.
Semantic quality remains human-required. Lexical floors protect requested
literal spans without scoring prose quality, synonyms, or headings. For only
the raw and machine cases, containment of the complete literal plus a character
ceiling equal to its own `.length` enforces exact output, including the absence
of extra whitespace, wrappers, and duplicates. That ceiling follows the literal
contract, not a prose-length preference. The quote-with-explanation case and all
prose cases have no length check. Deterministic tests reject damaged literals,
extra characters in exact-only outputs, and attempted mutation calls. They also
admit alternate legitimate prose and demonstrate semantic failures that these
narrow floors cannot detect.

The subject has no tools. Its no-mutation transcript floors do not prove refusal
of available tools. This single supplied-doctrine variant does not test natural
activation, command behavior, full-session behavior, or improvement against a
baseline. It adds no runtime adapter or active resource.

### Message role mapping

The maintained [`message-role-mapping.eval.mts`](message-role-mapping.eval.mts)
suite exercises [Message Role Mapping](../../pillars/pattern-message-role-mapping.md)
through synthetic text tasks. Cases separate restrictions from execution facts,
preferences from equivalence, reported approval from authorization, and quoted
proposals from adopted instructions. Other cases preserve useful human reports,
requested communication analysis, settled preferences, and qualified inference
across turns. Paired cases reuse a comment or ambiguous instruction under
different requests, so the requested work rather than familiar wording decides
the answer.

The subject receives complete working-tree bodies of the inventory, governance,
Epistemological Grounding, Agent-Native Expertise, and Message Role Mapping as
pasted context. The approved plan binds those bodies through the existing
adapter's resource digests. Other inventory entries are not supplied. Fixture
gold and semantic ledgers stay in review data, outside subject messages.

Validate without model inference:

```sh
npm run evals -- validate extensions/pillars/message-role-mapping.eval.mts
node --test extensions/pillars/message-role-mapping.test.mts
```

Use the [evaluation CLI](../../evals/README.md) for separately approved model
execution. Semantic quality requires human adjudication. Checks do not require
role labels, a displayed table, preferred prose, or a response-length target.
Only exact-only artifacts receive containment and character-length checks.
Deterministic tests validate source delivery, paired inputs, exact artifacts,
and transcript floors; they also demonstrate semantic failures that pass those
floors. The subject has no tools, so this suite does not establish execution of
investigations, refusal of available tools, natural consultation, or full-session
behavior. Its single supplied-doctrine variant does not measure improvement
against a baseline or isolate the pattern's contribution from its companion
principles. It adds no runtime adapter or active resource.

## Verification

Run the focused tests with:

```sh
node --test extensions/pillars/*.test.mts
```

The suite is Node-only. It covers kernel exclusion and crash release,
publication identity loss, temporary-state recovery, atomic publication, retention,
corruption, quotas, full-capacity pagination, memory refusal, export
publication, free-text command parsing, native argument-completion insertion,
help rendering at narrow widths, and actual Pi discovery/callback/command/shutdown
integration with a synthetic provider. Draft tests cover Unicode and byte bounds,
private diagnostics, unchanged source output, native batch ordering, ordinary
transcript preservation, cancellation, reload, disk resume, and source-only
aggregate evidence. Controlled Pi Durable Harness tests use the public native
code mode extension and a real sandbox. They check bounded source and usage
strings, source-error rejection, argument rejection, nested draft delivery in the
next provider request, and `afterTool` replacement of the text result. Provider
assertions use Pi's public transcript helpers to resolve the effective prompt and tools from system
messages. Event mocks return the host's unsubscribe function shape.
Command integration covers operator-only
help, model-visible check/derive/review requests, and delivery during an active turn.
It uses no paid model calls or real telemetry exports. Presentation tests pass a
complete typed tool definition through Pi's public `defineTool` helper to
`ToolExecutionComponent` and verify default collapse and expansion without
executing the tool.
Full repository gates remain defined in
[repository instructions](../../AGENTS.md).

Synthetic callback tests establish the tested host behavior. They do not
establish natural model discovery rates, doctrine application, or effectiveness.
