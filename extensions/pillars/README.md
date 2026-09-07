# Pillars access

The extension makes the existing Pillars corpus directly accessible to agents
and the operator. It also records bounded read-callback evidence. It does not
replace the [Pillars skill](../../skills/pillars/SKILL.md) or
[corpus governance](../../pillars/GOVERNANCE.md).

## Read the corpus

Agents use `pillars` with no arguments to read the inventory and discover
resource identifiers. Read `resource:"governance"` for the consultation
procedure, then read the relevant full entries. `resource:"skill"` returns the
loaded skill. The tool returns current source text and its SHA-256 digest, not
a generated summary or a compliance verdict.

```json
{}
{"resource":"governance"}
{"resource":"heuristic-verification-reach"}
```

The tool returns at most 32 KiB. If it returns `nextOffset`, continue with that
UTF-8 byte offset and `referenceBodyDigest`. A changed reference fails rather
than silently combining revisions. Invalid input, unavailable source, and a
changed source produce fixed tool errors. A source body is limited to 1 MiB.

Operator commands:

```text
/pillars
/pillars read governance
/pillars read heuristic-verification-reach
/pillars read <resource> <nextOffset> <referenceBodyDigest>
```

`/pillars` displays the actual inventory. Source output uses Pi's Markdown
renderer in the terminal. Operator command output stays outside model context:
TUI, JSON, and RPC use a custom session entry, while text-print mode writes to
stdout. JSON/RPC consumers receive the host's `entry_appended` event. Command
output remains in the ordinary session record where that record persists;
it is not stored in the aggregate telemetry directory.

## Discovery and activation

The harness package distributes the skill and corpus together. The extension
resolves the **actually loaded** skill through public Pi resource metadata and
its documented `../../pillars` relation. It does not depend on the registry
extension, guess a corpus directory, or scan session history. It loads the
bounded inventory and canonical targets, with no full-corpus body cache.

The skill remains the portable consultation entry point. It defines when to
consult the corpus and points to governance. The `pillars` tool removes manual
path navigation; it does not add another doctrine procedure. Registry, when
available, discovers both resources through normal Pi metadata.

The extension has a persistent worktree and an explicit local entrypoint.
Follow [the worktree procedure](../../docs/conventions/worktrees.md) for local
activation. Local activation does not promote the branch or push changes.
New sessions load the configured entrypoint; an existing session requires
`/reload`. Corpus distribution still follows the package's skill/corpus source,
not an independent copy inside this extension.

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

Operator command reads, `/skill:pillars` expansion, registry excerpts, shell
reads, and unobserved callbacks do not enter this metric. These are scope
boundaries, not proof of non-use. Per-turn deduplication admits at most 4,096
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
The store does not repair or migrate corrupt state. Storage unavailability
does not prevent corpus retrieval.

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
| `PI_PILLARS_COLLECT` | `1` or unset enables collection; `0` disables collection but preserves source access and retained-data readback. Other values disable collection with a local diagnostic. |
| `PI_PILLARS_TEST_HOST_ROOT` | Test-only coding-agent package root for the SDK integration regression; unset uses checkout dependencies. |

## Verification

Run the focused tests with:

```sh
node --test extensions/pillars/*.test.mts
```

The suite is Node-only. It covers cooperative lock exclusion and stale-lock
breaking, crash-leftover reconciliation, atomic publication, retention,
corruption, quotas, full-capacity pagination, memory refusal, export
publication, and actual Pi discovery/callback/command/shutdown integration with
a synthetic provider. It uses no paid model calls or real telemetry exports.
Full repository gates remain defined in
[repository instructions](../../AGENTS.md).

Synthetic callback tests establish the tested host behavior. They do not
establish natural model discovery rates, doctrine application, or effectiveness.
