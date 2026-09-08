# Pillars access

The extension makes the existing Pillars corpus directly accessible to agents
and the operator. It also records bounded read-callback evidence. The `pillars`
tool is the single consultation surface: it carries the WHEN triggers that tell
the model when to consult the corpus, and it reads the
[corpus governance](../../pillars/GOVERNANCE.md) directly.

## Check work, derive candidates, or review guidance

```text
/pillars check
/pillars check the proposed error handling
/pillars derive
/pillars derive what we learned from this design change
/pillars review
/pillars review agents keep asking permission despite Committed Contribution
```

`check` asks the agent to assess Pillars alignment. `derive` asks it to identify
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
history to choose a target. `check` requests an assessment rather than automatic
edits. `derive` and `review` keep proposals provisional in chat and grant no
corpus-change approval. These actions do not compute an alignment score.

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

The tool returns at most 32 KiB. If it returns `nextOffset`, continue with that
UTF-8 byte offset and `referenceBodyDigest`. A changed reference fails rather
than silently combining revisions. Invalid input, unavailable source, and a
changed source produce fixed tool errors. A source body is limited to 1 MiB.

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
`/pillars help` shows just the guide, even if the corpus is unavailable;
`/pillars browse` shows just the inventory. Argument autocomplete offers actions
with descriptions and current resource identifiers after `read `. It does not
complete free-text hints or invent continuation values. Source output uses Pi's
Markdown renderer in the terminal. Help, browse, read, and access-evidence
output stay outside model context: TUI, JSON, and RPC use a custom session
entry, while text-print mode writes to stdout. JSON/RPC consumers receive the
host's `entry_appended` event. Command output remains in the ordinary session record where that record persists;
it is not stored in the aggregate telemetry directory.

## Discovery and activation

The extension and the corpus ship together in one package. At session start the
extension resolves the corpus root as the sibling `../../pillars` directory
relative to its own module location. `PI_PILLARS_CORPUS` overrides that root
with an absolute path; a relative value fails closed rather than resolving
against the session directory. The extension does not guess a corpus directory,
depend on the registry extension, or scan session history. It loads the bounded
inventory and canonical targets, with no full-corpus body cache.

The `pillars` tool is the single consultation surface. It carries the WHEN
triggers in its description and prompt guidelines, and it points to governance.
It removes manual path navigation; it does not add another doctrine procedure.

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

Concurrent instances serialize writes through a cooperative `store.lock` file
created with exclusive semantics. A writer that cannot create the lock waits
at most 100 milliseconds; lock contention is an error, not zero use. A stale
lock older than 30 seconds is broken by the next writer. A crashed writer can
leave a stale lock that briefly blocks or delays the next commit. Reads are
lock-free and reject unresolved temporary state instead of blocking.

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
also confirms directory synchronization after an uncertain prior publication.
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

The collector attempts publication after its first eligible observation,
coalesces later result/turn triggers, limits ordinary attempts to one per
second, and makes a final shutdown attempt. Each new extension instance uses
a fresh private owner key. Forks do not replay history. Abrupt termination,
failed final publication, and a stalled filesystem still leave unknown tails.
The lock wait is limited to 100 milliseconds; contention is a reported error.

## Privacy and configuration

The aggregate store contains UTC dates, resource/model/reasoning/version
identities, reference digests, counters, and private random receipts. These are
linkable private metadata, not anonymity. It contains no prompts, result text,
raw paths, call/session identifiers, PID, exact event timestamps, or returned
mismatched-body hashes. Public evidence and exports exclude receipt identities.

| Variable | Meaning |
| --- | --- |
| `PI_PILLARS_DIR` | Absolute aggregate directory; default `<agentDir>/pillars`. |
| `PI_PILLARS_CORPUS` | Absolute corpus root override; unset resolves the sibling `../../pillars` package directory. |
| `PI_PILLARS_COLLECT` | `1` or unset enables collection; `0` disables collection but preserves source access and retained-data readback. Other values disable collection with a local diagnostic. |
| `PI_PILLARS_TEST_HOST_ROOT` | Test-only coding-agent package root for the SDK integration regression; unset uses checkout dependencies. |

## Behavioral evaluations

The maintained [`commands.eval.mts`](commands.eval.mts) suite exercises the real
`/pillars check`, `/pillars derive`, and `/pillars review` commands against
synthetic conversations and the live package corpus. It covers hint selection, inferred and absent
subjects, supported alignment, unsupported claims, candidate exploration,
existing-entry overlap, type choice, no-candidate outcomes, and quoted authority.
Review cases distinguish delivery gaps, application gaps, recognition scope,
operator expectations, sparse evidence, defective drafts, routine maintenance,
and absent context.

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
No exact response wording, alignment score, or candidate quota is required.

The evaluation-only [`evaluation.ts`](evaluation.ts) wrapper calls the real
extension factory and admits only `check`, `derive`, and `review` invocations.
It waits for Pi's `agent_settled` event before command return
because this SDK evaluation adapter does not bind command-context `waitForIdle`
actions. The production command and prompt are unchanged. Synthetic SDK tests
cover completed and aborted command turns, source approval, and cleanup.

The variant's `pillars-eval-source` flag binds a digest of the corpus and local
extension TypeScript sources into the approved plan. The wrapper checks this
value before command execution against the sources read at fixture startup.
A different digest requires a fresh plan. This guard does not freeze the
filesystem during a run; individual source results retain their body digests. The adapter excludes custom
request messages from its normalized transcript; the command input and pinned
source define that scaffold, not an assistant-text check.

Collection is disabled, its directory is isolated, and fixture shutdown restores
the prior environment and removes that directory. The model has `pillars` for
source access plus `edit` and `write` to expose attempted mutation. A hook blocks
all calls except `pillars`; attempted edits still fail the suite's checks.
This controlled tool set is not full-session parity. The suite does not compare
against a baseline, test terminal autocomplete, or submit a command during an
existing turn; deterministic command and integration tests own those mechanics.

## Verification

Run the focused tests with:

```sh
node --test extensions/pillars/*.test.mts
```

The suite is Node-only. It covers cooperative lock exclusion and stale-lock
breaking, crash-leftover reconciliation, atomic publication, retention,
corruption, quotas, full-capacity pagination, memory refusal, export
publication, free-text command parsing, native argument-completion insertion,
help rendering at narrow widths, and actual Pi discovery/callback/command/shutdown
integration with a synthetic provider. Command integration covers operator-only
help, model-visible check/derive/review requests, and delivery during an active turn.
It uses no paid model calls or real telemetry exports.
Full repository gates remain defined in
[repository instructions](../../AGENTS.md).

Synthetic callback tests establish the tested host behavior. They do not
establish natural model discovery rates, doctrine application, or effectiveness.
