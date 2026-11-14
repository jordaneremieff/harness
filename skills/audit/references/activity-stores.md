# Retained Pi activity stores

Read this reference when an audit needs cross-session tool, model, token, cost,
error, or repetition evidence. Public `agent_inspect` and history readers remain
preferable for one conversation or a selected ancestry. They do not provide a
cross-store windowed aggregate. The collector below closes that boundary without
creating an index or a second activity database.

## Select a collection

Resolve the authorised roots and explicit start-inclusive, end-exclusive instants
first. The defaults are `<agentDir>/sessions`, `<agentSessionsDir>/durable`, and
`<agentSessionsDir>/native`. `PI_AGENT_DIR` selects the agent directory (otherwise
the home directory's `.pi/agent`); `PI_AGENT_SESSIONS_DIR` selects agent storage
(otherwise `<agentDir>/agent-sessions`). Flags override those values. Never infer
that a root exists or contains all work on another machine.

Run from this skill's directory, replacing the example window:

```bash
node scripts/activity.mts --help
node scripts/activity.mts --from 2026-10-20T00:00:00Z --to 2026-10-21T00:00:00Z > out.json
node scripts/activity.mts --resume out.json > next.json
```

Choose the selection that fits the question:

- `--store primary,durable,native` limits discovery to named stores.
- `--source FILE,...` names exact `.jsonl` session files or Durable
  `<storageId>.sqlite` files instead of discovering stores. A `.sqlite` file is
  read as Durable; a `.jsonl` file under `<agentSessionsDir>/native` as native;
  any other `.jsonl` file as primary.
- `--tool NAME,...` limits the tool rows, tool units, nested call counts, and
  repetition section. It does not change response, model, or usage sections.
  Durable `pi.tool` tasks do not name their tool, so `topLevelToolCalls` and
  `nestedToolTasks` for Durable stores stay unfiltered.
- `--model PROVIDER/MODEL,...` limits model rows, response units, and usage
  carriers that name a model. Carriers without a model (tool results, compaction,
  branch summaries, the ledger's tool bucket) are excluded under a model filter.
  Keys use the message `provider` and requested `model`; the ordinary session
  breakdown in Pi keys responses by `responseModel` when present.
- `--groups N` bounds each table of rows; the remainder is one `other` row.
  `--refs N` bounds the references kept per row.

The dependency-free TypeScript collector needs Node with `node:sqlite` and direct
TypeScript execution. It prints bounded JSON to stdout and never writes a report,
registry record, index, or storage record. It has no Pi host import, network
access, recorder, or repair path. A script is necessary here: `jq` does not read
SQLite, and SQLite queries alone do not bound JSONL discovery, partial lines,
memory, and per-store coverage.

## Order, bounds, and continuation

Discovery visits the root and one directory level for JSONL, and only the root
for Durable SQLite. It does not follow symlinks or enter hidden subdirectories.
Each candidate file is examined with `lstat`. A file last modified before the
window cannot hold a record written within it and is counted in
`filesBeforeWindow` without being read. For SQLite, a non-empty `-wal` file also
dates the database; an empty one holds no records. Remaining files are read
newest modification first.

JSONL reads from the end of the file toward its start, so a recent record is
reached before older history consumes the budget. Pi appends session entries in
time order. The read of one file stops at the first activity record older than
the window (`olderRecordStops`). `outOfOrderRecords` counts records whose time is
later than the next record in the file; a non-zero value qualifies that stop rule.
The read covers bytes up to the size seen when the file was first opened.

Durable SQLite is read from a private copy (see the source contract below). The
copied database and WAL bytes count against the byte budget. The copy is read
`tasks` and then `entries`, newest identifier first. SQLite selects candidate
kinds; the collector checks each row's time before retrieving the record. Only
in-window records consume the record budget. A storage whose copy exceeds the
per-run byte bound is `oversized` and unread; raise `--bytes` to read it. A copy
that does not fit the remaining budget waits for a resumed run.
`rowsScanned` counts the rows examined. Window selection is not indexed, so a
large storage still costs a scan of its rows within the time bound.

Bounds apply to each store in each run. `--help` lists defaults and maximum
multipliers for `--visits`, `--files`, `--bytes`, `--records`, `--recordBytes`,
`--seconds`, `--groups`, and `--refs`. `visits` and `files` bound discovery,
which must stat every candidate to order them. The clock is checked between file
and record operations, not as a hard operating system deadline.

A non-null `continuation` means the collection stopped at a cap. Pass the saved
output file to `--resume` with any new per-run bounds. The continuation binds the
window, filters, reference count, ordered source list, and each source's
identity and position. Window and filter flags are refused with `--resume`.
Each resumed output is cumulative, so the final output equals one complete pass
over the same unchanged sources. Repeat until `continuation` is `null`. The token
holds pending call pairings and repeated-call groups; its size grows with them.

A resumed collection does not count a source twice. `changes` lists sources whose
state moved after the collection first used them:

- a finished source modified afterwards keeps its earlier counts;
- a JSONL file appended after its snapshot excludes the appended records;
- a Durable storage with rows added after its snapshot excludes those rows;
- a JSONL file replaced or truncated keeps earlier counts and stops reading;
- a Durable storage that changed during each of three copies is `changed`, and
  no record from those copies is counted. Counts from a consistent copy in an
  earlier run remain.

Durable task records change state in place. A task that had no `startedAt` when
its storage was read is counted as a missing timestamp, not as a later start.

## Source and unit contract

Verify these contracts against the active installed packages before interpreting
new shapes. Do not add retired-schema readers to make old records appear current.

| Store | Current defining source | Collection |
| --- | --- | --- |
| Primary JSONL | Coding-agent `dist/core/session-manager.js` and `dist/core/usage-totals.js` | `message`, `usage`, `compaction`, `branch_summary` entries by envelope `timestamp` |
| Native JSONL | Same ordinary session format under the agent storage root | Same fields as primary; reported as a separate store |
| Durable | `pi-durable/dist/storage/sqlite/migrations.js`, `dist/harness/generation.js`, `dist/harness/tool.js`, `dist/harness/compaction.js`, `dist/harness/usage.js`, `dist/entries.js` | `<storageId>.sqlite`: `tasks`, `entries`, and `pi.usage` documents; companion `<storageId>.json` catalog is metadata |

The harness catalog layout is defined in `extensions/agent/catalog.ts` in the
owning package. Catalog absence or invalid identity is reported separately and
does not suppress a readable database. Never open the Durable writer factory to
inspect activity: it performs initialisation.

The collector never opens a source database through SQLite. Even a read-only
SQLite open of a WAL database writes beside it: it creates empty `-wal` and
`-shm` files when none exist and updates read marks in `-shm`. Instead, for
each storage the collector:

1. records the identity (device, inode, size, modification and change times) of
   the database, `-wal`, and `-journal` files, opened read-only without
   following links;
2. refuses a non-empty `-journal`, an unfinished rollback;
3. copies the database and a non-empty `-wal` into a new private directory
   under the operating system's temporary directory, outside the source
   directory, and checks the SQLite header of the copied database;
4. compares every identity after the copy, and discards a copy whose source
   changed;
5. opens only the copy with `readOnly`, `query_only`, and a deferred read
   transaction, then removes the private directory.

The `-shm` file is not copied; SQLite rebuilds its index from the copied WAL.
A copy is a consistent snapshot of committed data at that moment. Copies of
different storages are not one atomic machine-wide snapshot. A missing,
truncated, unsupported, or journaled database is unreadable, not an empty store.

Keep these units separate in both per-store rows and totals:

- `topLevelToolCalls`: JSONL assistant `toolCall` blocks; Durable `pi.tool`
  tasks with `input.kind: model`, selected by task `startedAt`. These are calls
  or started tasks, not proof of successful execution.
- `responseToolCalls`: `toolCall` blocks in retained responses of either store.
  Tool rows count `calls` this way, so Durable rows can name the tool.
- `toolResults` and `errorToolResults`: retained tool result messages and those
  with `isError: true`. A result records completion. A non-error result is not
  acceptance of the work, and an error result can be a correct denial.
- `nestedCodemodeCalls` and `nestedErrorCalls`: distinct IDs within each codemode
  result's `details.calls`, and rows with `status: error`. The ordinary host uses
  string IDs; Durable uses numeric IDs. The installed ordinary
  `dist/extensions/codemode/execute.js` and Durable `dist/codemode/codemode.js`
  define those rows. Selected by the parent result timestamp. Missing details,
  malformed rows, and duplicate IDs are separate counters.
- `nestedToolTasks`: Durable `pi.tool` tasks with `input.kind: nested`, selected
  by `startedAt`. This is a cross-check, not another term to add to codemode
  calls. Other tools also use nested tasks; window edges differ.
- `generationStarts` and `compactionStarts`: Durable `pi.generation` and
  `pi.compaction` tasks selected by `startedAt`. They are not provider request
  counters. JSONL does not retain equivalent task starts.
- `modelResponses`, `errorResponses`, `abortedResponses`: retained assistant
  messages, with `stopReason` `error` and `aborted` counted separately. Durable
  uses `model[0]` and its `timestamp`; JSONL uses `message` and the envelope
  timestamp. This is response evidence, not all provider attempts.
- `modelRequests.exactProviderAttempts`: unavailable (`null`). These stores lack
  a complete provider-attempt ledger. Never rename generation starts or response
  records as exact model requests.

Totals add the same unit across stores, never top-level plus nested calls.
They count retained records, not unique execution across copied, converted, or
forked histories. They cover every retained branch in an accepted file, not one
selected ancestry.

## Usage and cost

Every usage figure sums present, finite, non-negative `usage` token fields and
`usage.cost.total`, with `records`, `missing`, `missingTokenFields`, and
`missingCost` beside the sums. Missing is unknown, not zero. `totalTokens` is the
provider's recorded total; reasoning tokens need not be additional tokens.
Recorded cost is nominal model metadata, not an invoice or subscription charge.
Printed costs are rounded to nine decimal places.

The `usage` section keeps categories apart:

- `responseOnly`: assistant message usage in the window. Model rows use it.
- `otherCarriers`: other windowed carriers. `toolResults` is tool result message
  usage in either store. JSONL adds `usage:<kind>` entries (for example
  `usage:cache_warm`), `compaction`, and `branchSummary` entry usage.
- `withoutUsage`: compaction or branch summary entries that record no usage.
- `windowedRecorded`: the sum of the categories above.
- `unavailableInWindow`: Durable compaction usage and Durable nested tool usage.
  Their writers add them only to the conversation `pi.usage` ledger and, for
  nested calls, a task document that retires with its task.
- `ledger`: the current `pi.usage` document of each conversation in storages
  that had windowed records, grouped by model and by tool. It is a lifetime total,
  not windowed, and never part of `windowedRecorded`. A ledger whose newest
  revision is a delta is counted in `ledgerUnsupported` instead of being applied.

The categories are disjoint by their defining writers. Ordinary
`getUsageCostBreakdown` in `usage-totals.js` sums assistant messages, `usage`
entries, tool result usage, and compaction or branch summary usage without
overlap. Durable `recordUsage` adds each response, tool result, nested call, and
compaction summary once, in the commit that writes it. A forked Durable
conversation starts with an empty ledger (`fork: initial`). Copied JSONL history
can still repeat records across files; do not present totals as unique spend.

## Rows, references, and repetition

`sessions.rows` gives per JSONL session file or Durable conversation its model
responses, top-level tool calls, error results, nested calls, `responseCost` and
`otherCost` (recorded nominal cost from responses and from other windowed
carriers, with counts of records with and without cost), first and last record
instants, `firstRef`, and the newest `refs`. Rows are ordered by response cost.
Use them to find the sessions that consumed work, then follow `firstRef` or a
reference into the sequence. Cost is never divided among tools.

`tools.rows` gives per tool `calls`, `results`, `errorResults`, `nestedCalls`,
`nestedErrors`, `repeatedCalls`, and `callsAfterError`, with `errorRefs` and
`callRefs`. `models.rows` gives per model response counts, response usage,
`errorRefs`, and `refs`. Each list keeps the newest references by record time.
A reference is a route to one exact record:

- JSONL: `{ file, byte, entryId, at }`. Find the line with
  `rg -n -m 1 -F '"id":"<entryId>"' <file>`, then read that line. `byte` is the
  line's start offset. An entry without `id` has `entryId: null`.
- Durable: `{ sessionId, entryId, at }`, where `sessionId` is
  `<storageId>:<conversationId>`. Read it with `agent_inspect` using that
  `sessionId`, `view: exact`, `entryId`, and `offset: 0`. The root conversation
  also accepts the bare storage ID.

`repetition` is observed repetition, not waste. Within one session (one JSONL
file, or one Durable conversation), it groups top-level calls by a fingerprint of
the tool name and canonical arguments. The fingerprint is a truncated SHA-256
digest; arguments are never printed. `repeatedCalls` is calls beyond the first
per group. `callsAfterError` counts identical calls made after an identical call
whose result was an error. Calls from one response share a time, so they are not
counted as after each other. Nested codemode calls are excluded because their
rows keep only truncated argument previews. `callsWithoutResult` and
`resultsWithoutCall` report pairs split by the window or by unfinished work.

A repeated read can be justified, a retry can be correct, and an error can be a
designed denial or timeout. Decide waste, timing, or cause only from the exact
records and their own evidence. The collector does not attribute response usage
to the tools those responses called.

## Coverage and reconciliation

Each store reports directories and candidate files visited, files before the
window, files read, skipped or unreadable, ignored directory entries, skipped
directories, companion catalog reads and failures, bytes, records, rows scanned,
malformed and unsupported records, missing timestamps, outside-window records,
older-record stops, out-of-order records, files changed during a read, trailing
fragments, ledger documents, runs, and caps reached in the latest run. `sources`
counts the frozen source list by state: `done`, `partial`, `pending`,
`unreadable`, `changed`, `oversized`. A failed read can retain an already-read
prefix; its aggregate remains partial. SQLite bytes are copied database, WAL, and
catalog bytes, including copies discarded after a change. An oversized record is
skipped after its length is known. `discoveryComplete` covers the declared depth only; a discovery cap
leaves the undiscovered remainder unknown, never zero. `complete` is true only
when discovery finished and no source is pending or partial.

When the audit's verification rule calls for a second pass on a collector
figure, reconcile against an independent read of the same records:

- Open one exact reference from the row that carries the figure and confirm the
  record's kind, tool or model, error state, and time.
- For a Durable count, run a bounded read-only query on the named storage with
  the same window, for example:

```sql
SELECT count(*) AS model_tool_tasks
FROM (SELECT record FROM tasks ORDER BY id DESC LIMIT 100000)
WHERE json_extract(record, '$.kind') = 'pi.tool'
  AND json_extract(record, '$.input.kind') = 'model'
  AND json_extract(record, '$.startedAt') >= :from_ms
  AND json_extract(record, '$.startedAt') < :to_ms;
```

- For a JSONL count, rerun the collector with `--source` naming that file and
  compare it with one `jq` count over the same file and window, for example
  `jq -n '[inputs | select(.type == "message" and .message.role == "toolResult"
  and .timestamp >= "FROM" and .timestamp < "TO")] | length' FILE`. Pi writes
  envelope timestamps with `toISOString`, so equal-format instants compare as text.

A direct query corroborates extraction and arithmetic, not independent event
instrumentation. Preserve sample limits. Report unavailable dimensions instead
of repairing live stores or requiring registry writes.
