# Retained Pi activity stores

Read this reference when an audit needs cross-session tool, model, token, or cost
counts. Public `agent_inspect` and history readers remain preferable for one
conversation or a selected ancestry. They do not provide a cross-store windowed
aggregate. The collector below closes that boundary without creating an index.

## Collect a bounded window

Resolve the authorised roots and explicit start-inclusive, end-exclusive instants
first. The defaults are `<agentDir>/sessions`, `<agentSessionsDir>/durable`, and
`<agentSessionsDir>/native`. `PI_AGENT_DIR` selects the agent directory (otherwise
the home directory's `.pi/agent`); `PI_AGENT_SESSIONS_DIR` selects agent storage (otherwise
`<agentDir>/agent-sessions`). Flags override those values. Never infer that a root
exists or contains all work on another machine.

Run from this skill's directory, replacing the example window:

```bash
node scripts/activity.mts --help
node scripts/activity.mts --from 2026-10-20T00:00:00Z --to 2026-10-21T00:00:00Z
```

The dependency-free TypeScript collector needs Node with `node:sqlite` and direct
TypeScript execution. It prints bounded JSON aggregates to stdout. It never
writes a report, registry record, index, or storage record. It has no Pi host
import, network access, recorder, or repair path. A script is necessary here:
`jq` does not read SQLite, and SQLite queries alone do not bound JSONL discovery,
partial lines, memory, and per-store coverage. Keeping those controls in one
maintained reader avoids a new untested shell composition for every audit.

Use `--agent-dir PATH` and `--agent-sessions-dir PATH` only for the selected
roots. `--help` lists default per-store limits and their maximum multipliers.
Set `--visits`, `--files`, `--bytes`, `--records`, `--recordBytes`, and `--seconds`
explicitly when the question needs different bounds. Increasing a cap is a new
collection decision, not permission to claim the previous sample was complete.
The clock is checked between file and record operations, not a hard operating
system deadline for one filesystem or SQLite operation.

Discovery visits the root and one directory level for JSONL, and only the root
for Durable SQLite. It does not follow symlinks or enter hidden subdirectories.
Directory order is filesystem order, not a random sample or newest-first order.
The reader uses bounded directory iteration, not ignore-aware search. For manual
`fd` or `rg` discovery under these exact hidden roots, use `--no-ignore` as well
as explicit depth and output bounds; hidden inclusion alone does not defeat
ignore rules.

## Source and unit contract

Verify these contracts against the active installed packages before interpreting
new shapes. Do not add retired-schema readers to make old records appear current.

| Store | Current defining source | Collection |
| --- | --- | --- |
| Primary JSONL | Coding-agent `dist/core/session-manager.js` | `type: message`, envelope `timestamp`, `message` |
| Native JSONL | Same ordinary session format retained under the agent storage root | Same fields as primary; report as a separate store |
| Durable | `pi-durable/dist/storage/sqlite/migrations.js`, `dist/harness/generation.js`, `dist/harness/tool.js`, `dist/entries.js` | `<storageId>.sqlite`: `tasks` and `entries`; companion `<storageId>.json` catalog is metadata, not activity |

The harness catalog layout is defined in `extensions/agent/catalog.ts` in the
owning package. Catalog absence or invalid identity is reported separately and
does not suppress a readable database. Never open the Durable writer factory to
inspect activity: it performs initialisation. The collector uses
`new DatabaseSync(path, { readOnly: true })`, `query_only`, and a deferred read
transaction. This sees committed WAL data in a per-database snapshot. It does
not use `immutable`, checkpoint, vacuum, migrate, escalate to a write lock, or
change journal mode. A busy, inaccessible, or unsupported database is unreadable,
not an empty store. SQLite still uses normal read coordination with live writers.

JSONL reads a fixed byte prefix up to the initial file size. It checks file size
and modification time after reading. Changed files remain a qualified sample,
not a stable historical snapshot. Unfinished or oversized lines leave an explicit
partial-file count. SQLite snapshots across different files and JSONL captures
are not one atomic machine-wide snapshot.

Keep these units separate in both per-store rows and totals:

- `topLevelToolCalls`: JSONL assistant `toolCall` blocks; Durable `pi.tool`
  tasks with `input.kind: model`, selected by task `startedAt`. These are retained
  calls/tasks, not proof of successful execution. Unstarted model proposals have
  no started Durable task and are not counted there.
- `nestedCodemodeCalls`: distinct IDs within each codemode result's
  `details.calls`. The ordinary host uses string IDs; native Durable uses numeric
  IDs. The installed ordinary `dist/extensions/codemode/execute.js` and Durable
  `dist/codemode/codemode.js` define those two current contracts. Select by the
  parent result timestamp. Missing details, malformed rows, and duplicate IDs
  are separate counters. This does not include unfinished codemode results.
- `nestedToolTasks`: Durable `pi.tool` tasks with `input.kind: nested`, selected
  by `startedAt`. This is a separate cross-check, not another term to add to
  codemode calls. Other tools also use nested tasks; window edges differ.
- `generationStarts`: Durable `pi.generation` tasks selected by `startedAt`.
  This field is not a provider request counter. Preparation failures issue no
  request; retries issue several. JSONL does not retain equivalent task starts.
- `modelResponses`: retained assistant messages, including error responses.
  Durable uses `model[0]`, its `timestamp`, and `usage`. JSONL uses `message` and
  the envelope timestamp. This is response evidence, not all provider attempts.
- `modelRequests.exactProviderAttempts`: unavailable (`null`). These stores lack
  a complete provider-attempt ledger. Never rename generation starts or response
  records as exact model requests. Provider retries, unfinished requests,
  compaction requests, and internal model calls need separate defining evidence.
- Tokens and cost: sum present, finite, non-negative `usage` fields and
  `usage.cost.total`. Report missing usage, missing token fields, and missing cost
  beside sums. Missing is unknown, not zero. `totalTokens` is the provider's
  recorded total; reasoning tokens need not be additional tokens. Recorded cost
  is nominal model metadata, not an invoice or subscription charge.

Totals add the same unit across stores, never top-level plus nested calls.
They count retained records, not unique execution across copied, converted, or
forked histories. They cover every retained branch in an accepted file, not one
selected ancestry. Do not infer unique machine spend from these totals without
reconciling copied history and the cost source.

## Coverage and reconciliation

Each store reports directories and candidate activity files visited, files read,
skipped or unreadable, ignored directory entries, skipped directories, companion
catalog reads/failures, bytes, records, malformed/unsupported records, missing
timestamps, outside-window records, changed/partial files, and caps reached.
`filesRead` includes partial reads; `partialFiles` and `changedFiles` are qualifiers,
not additional members of the read/skipped/unreadable partition. A failed read
can retain an already-read prefix; its aggregate remains partial. SQLite bytes
are retrieved record/catalog bytes, not database file size or physical page I/O.
An oversized SQLite record is skipped after its byte length is checked, not decoded.
`discoveryComplete` covers the declared depth only. A cap leaves the undiscovered
remainder unknown; never report it as zero skipped files. Empty stores and absent
stores differ through `storesVisited` and `directoriesUnreadable`.

Before a load-bearing conclusion, reconcile a bounded accepted storage against
an independent query. Select one known database, fix its window, and use a
read-only SQLite connection. Bound rows before aggregation, for example:

```sql
SELECT count(*) AS started_model_tool_tasks
FROM (SELECT record FROM tasks ORDER BY id LIMIT 100000)
WHERE json_extract(record, '$.kind') = 'pi.tool'
  AND json_extract(record, '$.input.kind') = 'model'
  AND json_extract(record, '$.startedAt') >= :from_ms
  AND json_extract(record, '$.startedAt') < :to_ms;
```

Check the same sample with `collectStore` on an authorised isolated fixture or
compare an exact accepted database with the collector's counting functions.
A direct query corroborates extraction and arithmetic, not independent event
instrumentation. Preserve sample limits. Inspect exact entries through
`agent_inspect` when an outcome or causal claim needs more than aggregate data.
Report unavailable dimensions instead of repairing live stores or requiring
registry writes.
