# clipboard: macOS clipboard tools and history

This extension provides agent clipboard I/O and an operator-facing history browser. It intentionally targets macOS `pbcopy` and `pbpaste`.

The ordinary extension publishes its registered tool renderers at factory time and
on display requests through the [tool display contract](../../docs/conventions/tool-display.md);
the payload contains no execution functions.

## Surfaces

| Surface | Kind | Purpose |
|---|---|---|
| `clipboard_copy` | tool | Write via stdin-fed `pbcopy` and archive the write. |
| `clipboard_paste` | tool | Read the current clipboard in bounded pages. |
| `clipboard_list` | tool | List recent entries or search full archived text, with bounded continuation and stable ids. |
| `clipboard_get` | tool | Read one archived entry by stable id, in bounded pages. |
| `clipboard_restore` | tool | Copy one archived entry back to the clipboard; the restore is archived as a new entry. |
| `/clipboard` | command | Filter, preview, and restore history in an overlay. |

Each tool is one operation; there is no action multiplexer, and the model-facing
API has no transient index addressing — stable ids are the only entry handle.
`clipboard_paste` and `clipboard_get` return at most 8,000 Unicode characters per page, subject to the stricter 50 KiB and 2000-line output bounds. A `nextOffset` tells the caller how to continue.

## Use

Call `clipboard_copy` with the text to write:

```json
{"content":"Rollback instructions: restore the saved revision.","label":"rollback instructions"}
```

Call `clipboard_paste` only when you need the current clipboard:

```json
{"max_chars":8000}
```

If a read returns `nextOffset`, pass it as `offset` to continue. Use
`clipboard_list` to find archived text, then `clipboard_get` to inspect it
or `clipboard_restore` to write it back. Archive search alone does not
access the clipboard.

## Configuration

The `clipboard` section of `<agentDir>/harness.json` selects the archive directory.
A present environment override takes precedence over the document field, then the
default. An invalid selected path uses the default and produces a diagnostic;
it does not fall back to an underlying document value.

<!-- harness:settings:start -->
| Key | Environment | Type | Default | Constraints | Description |
|---|---|---|---|---|---|
| dir | `PI_CLIPBOARD_DIR` | path | &lt;agentDir&gt;/clipboard | none | Private clipboard archive directory. |
<!-- harness:settings:end -->

Relative paths resolve against the host's agent directory. Paths do not expand
`~` or environment variables. Both entrypoints read settings for each archive
operation; the native entrypoint uses its explicit host directory, while the
ordinary entrypoint uses Pi's `getAgentDir()`.

The ordinary factory publishes settings at setup and on versioned requests through
the [settings contract](../../docs/conventions/extension-config.md#inspection-events).
Each publication is a fresh configured snapshot, not proof that an existing runtime
applied it. The ordinary publisher unsubscribes at session shutdown. A native host
replaces that publisher on the same factory event bus, binds it to `host.agentDir`,
and disposes it through `host.onClose`. Only one publisher remains active.

See the [configuration convention](../../docs/conventions/extension-config.md),
[Storage](#storage) for file handling, and [Retention and deletion](#retention-and-deletion)
for removal limits.

## Find text from a remembered phrase

Use `clipboard_list` with `query` when the date and id are unknown. Without
`query`, the tool lists recent entries: default `limit: 10`, maximum
50, and optional `date`.

For example: “Recover the rollback instructions I copied; I remember the phrase
but not the date.” A recent list does not expose a draft behind newer copies,
and its preview does not expose a phrase deep in the body. Query the archive:

```json
{"query":"rollback instructions"}
```

The query response is JSON with `matches`, `scan`, `limits`, `stop`, `hasMore`,
and `nextCursor`. An empty `matches` array with a cursor is an incomplete page,
not archive-wide absence. Repeat the exact query and optional date with that
cursor, even after an empty page:

```json
{"query":"rollback instructions","cursor":"<nextCursor>"}
```

A match includes its stable `id`, the actual archive `date`, metadata, and
`match.field`, `match.offset`, and `match.excerpt`. An illustrative result is:

```json
{
  "id": "rollback-draft",
  "date": "2026-01-02",
  "match": {
    "field": "content",
    "offset": 40000,
    "excerpt": "…context rollback instructions: restore the saved revision"
  }
}
```

Read or restore through the existing tools, preserving the returned date:

```json
{"id":"rollback-draft","date":"2026-01-02"}
```

Use `clipboard_get` to inspect the full text in pages. Its continuation advice
preserves the date. Use `clipboard_restore` when a clipboard write is intended.
Search and get do not read or write the system clipboard.

### Query semantics

- Matching is case-sensitive literal substring matching on raw validated full
  content or the stored label, not preview text or escaped display text. There
  is no regex, fuzzy ranking, case folding, or Unicode normalization. Queries
  contain 1–256 UTF-16 units, must be well-formed Unicode, and must contain a
  non-whitespace character. Whitespace inside a query remains literal.
- Content wins when both fields match. The excerpt surrounds the first match;
  terminal and bidi controls are escaped. Offsets count Unicode characters in
  the matched raw field. A content-match offset also works with `clipboard_get`,
  including when astral characters precede the match. Labels retain the archive
  reader's 200-character limit; content has no preview-prefix ceiling.
- Order follows descending local-date filenames, then reverse physical records
  within each file. Stored timestamps do not determine archive order or date.
- Before returning a candidate, search checks from the newest record for the
  same id in the selected date scope. A newer valid nonmatching duplicate hides
  an older match, including across pages and files. Malformed records do not
  mask valid records. This preserves get/restore resolution rather than
  presenting an old duplicate that those tools cannot select.
- The optional `date` restricts both discovery and duplicate resolution to that
  local-date archive. It must be a valid calendar date. The result's date comes
  from the filename, not the UTC timestamp. A later append can change what
  get/restore selects; search results are observations, not immutable handles.
- Repeat `query` and `date` on continuation. `limit` may change between pages.
  A cursor without a query, a changed query/date, or an invalid cursor is an
  error. Cursors are opaque, validated positions, not authenticated snapshots.

### Bounds and continuation

These limits apply only to the query path. Each call stops at the first reached
bound; `stop` names it. A page can finish duplicate verification rather than
produce a match. A final empty continuation page is possible.

| Work | Per-call bound |
|---|---|
| Directory discovery | 4,096 direct entries, plus one overflow sentinel; directory reads buffer 32 entries. No recursive traversal. |
| Archive metadata | At most one metadata read per selected daily archive during discovery; descriptor/path checks also bracket each content-file visit. |
| Content-file visits | 32, including repeat visits for candidate verification and empty files. |
| Physical records | 1,000, including blank, malformed, discarded, and repeated verification records. |
| Content bytes read | 128 MiB, including repeated reads and cursor-boundary checks. |
| Individual record | 64 MiB; larger records are skipped without retaining their remaining body. |
| Match data | 16 KiB of serialized match objects, with at most `limit` results (default 10, maximum 50). |
| Cursor | 1,024 characters; it carries positions and one pending candidate id, never record bodies. |
| Complete tool output | Below 50 KiB and 2,000 lines, including complete ids, evidence, limits, and continuation. |

A directory above the discovery cap fails explicitly and requires an exact
`date`, which bypasses directory enumeration. Unknown-date discovery does not
cover larger directories. Missing stores and dates produce a completed empty
page. Symlinked stores are rejected, symlinked archives are ignored, and
nonregular archive opens fail without waiting for a peer.

Memory does not grow with the total archive: the reader retains the bounded
catalog, at most a page of seen ids, a chunk cache, one record, and bounded match
summaries. The record's decoding, JSON parsing, and normalization also allocate
memory; the record cap is not a 64 MiB process-memory guarantee. Eligible records
cut by a byte boundary restart on the next page. Oversized records continue in
discard mode, so even a very large damaged record does not stall discovery.
Output-boundary matches remain available on continuation instead of disappearing.

`scan` reports work in this call, including repeat verification reads, not unique
archive totals. `malformed`, `oversized`, and `duplicates` report exclusions or
suppression observed during that work. An oversized record is counted when first
detected, not again on each discard continuation. Keep earlier pages' exclusions
when assessing a completed scan. Neither an empty page nor completion establishes
absence in skipped, unavailable, newly appended, or changed data.

Each cursor binds the query/date/store and a bounded metadata fingerprint of
selected archive names, file identities, sizes, and modification times. Normal
appends, rewrites, replacements, deletions, and new daily archives invalidate
continuation; restart without the cursor. Files read within a call receive
before/after identity and metadata checks. This is not an atomic filesystem
snapshot or a content checksum; concurrent changes after an observation and
changes that preserve all checked metadata are outside that guarantee.

Cancellation throws and closes open descriptors. No partial cursor or separate
search state is saved. A caller can reuse its previous cursor while the archive
remains unchanged. Archive bytes are read-only; normal private-mode enforcement
still applies.

Search scans the archive on demand. There is
no index, watcher, background work, new state store, archive migration, or runtime
dependency. Each page repeats bounded directory/metadata discovery. Candidate
checks can revisit a large prefix once per candidate, so broad queries and older
hits cost more reads and pages than narrow queries. All those reads share the
same per-call budgets. This cost buys correct duplicate resolution without an
unbounded id set or persistent index. Search is separate from browser filtering and clipboard I/O.

## Storage

History is one append-only JSONL file per local calendar day in the configured
archive directory, default `<agentDir>/clipboard/YYYY-MM-DD.jsonl`.

- Each entry requires a valid stored id. Records without one are skipped, never assigned a synthetic identity. For duplicate ids, only the newest record is visible.
- Directory and file modes are re-enforced as `0700` and `0600` on use.
- Appends use one bounded `O_APPEND` write per record, with leading and trailing newline separators. Concurrent large appends do not interleave chunks. Short writes return an archive warning; a later append remains readable after a torn record without rewriting prior bytes.
- Archive opens use `O_NOFOLLOW` and `O_NONBLOCK`, then verify the descriptor is a regular file before changing its mode or accessing content. A pipe at an archive path is refused without waiting for a peer.
- Reads reject a symlinked store, ignore symlinked archives, skip blank or malformed records, and recompute derived metadata from validated content.
- Readers scan files and records newest-first in bounded chunks and check cancellation between reads and records. Lists stop after the requested page and retain no body content; the browser retains at most 32,768 characters per entry. Stable-id lookup refetches the full selected record without materializing a whole daily archive.
- Individual JSONL records are capped at 64 MiB. This contains malformed or unexpectedly large historical data while accommodating the tool's string-length input limit of 8 × 1024 × 1024 and JSON escaping.
- Restores append a new `(restored)` entry because they are real clipboard writes.

A successful `pbcopy` followed by an archive failure is reported as a successful copy or restore with a warning. A `pbcopy` failure remains an error and does not append a false history event. Archival continues after a confirmed copy even if cancellation arrives afterward.

Clipboard subprocesses use asynchronous, shell-free I/O with a 30-second timeout and caller cancellation. Early stdin closure rejects the copy instead of raising an unhandled stream error. Pi's native `copyToClipboard(text)` helper has no cancellation parameter and emits OSC 52 in remote sessions. This extension retains its subprocess adapter to preserve cancellation, confirmed local-copy outcomes, and clean RPC output.

## Retention and deletion

History is retained until the operator removes it; there is no silent age-based pruning. Physical deletion is intentionally daily-file granular. A closed day's `<agentDir>/clipboard/YYYY-MM-DD.jsonl` can be removed directly on an explicit operator request. The current day's file should not be removed while sessions may be appending to it.

The extension provides no entry-level deletion. Daily-file removal avoids rewriting an archive while other processes append to it.

## Browser behavior

The overlay is available in TUI mode. RPC receives a notification that directs the caller to `clipboard_list`, rather than attempting a terminal-only custom component.

The overlay loads the newest 200 entries and marks the count with `+` when older history exists. It supports live filtering across labels, ids, and loaded body prefixes. Up/Down selects entries, Left/Right scrolls the preview by a page, Enter restores, and Escape clears or closes. Escape cancels an active restore. Disposal also cancels active work and suppresses late component callbacks. A completed copy remains a success if cancellation arrives only during archival. A truncated preview is labeled. Restore resolves the selected stable id again and writes the full archived content, so preview bounds never truncate the clipboard result.

The component is the sole height authority. It reads the host TUI row count and the overlay host does not impose `maxHeight`, which prevents Pi from slicing away the footer. Every rendered row paints the full width inside a background-backed frame. The footer is always the final row, including `40x10` and `50x12` terminals. Labels, previews, content, and error text have terminal and bidi controls escaped before custom rendering.

## Durable agents

Durable agent sessions receive their tools from native Pi Durable
contributions, not from ordinary Pi extensions. The ordinary factory emits a
contribution from `index.ts`; `durable.ts` builds the native extension from it.
Both entrypoints call the same operations, parameter schemas, and archive
functions, so the archive stays the external store and the contribution holds
no Durable documents.

| Tool | Replay class | Reason |
|---|---|---|
| `clipboard_copy` | unsafe | A rerun overwrites newer clipboard content and appends a duplicate archive record. |
| `clipboard_paste` | safe | A rerun only reads the clipboard. |
| `clipboard_list` | safe | A rerun only reads the archive. |
| `clipboard_get` | safe | A rerun only reads the archive. |
| `clipboard_restore` | unsafe | A rerun overwrites newer clipboard content and appends a duplicate archive record. |

An interrupted unsafe call returns an interrupted result instead of rerunning.
Model-facing guidance renders as the prompt section `clipboard`, composed from
the same snippets and guidelines the ordinary registration exposes. The native
tools return the same result text and details object as the ordinary tools; the
ordinary tool cards do not apply because a Durable session renders its own
transcript. The `/clipboard` overlay is a TUI operator surface and has no
Durable form.

## Tool cards

Each tool draws a compact TUI card. A collapsed card never shows copied, pasted, or
archived content; it shows the label, size, id, and outcome instead. Expansion reveals the
full arguments or result text with a display bound, and terminal controls escape to text
in every collapsed value.

- `clipboard_copy` names the label and reports the content size in UTF-16 code units
  (or that the content is still streaming), then the copied size and any archive warning.
- `clipboard_paste` names only the requested page bounds, then the page size, any
  continuation offset, the escaped-control note, and the empty state.
- `clipboard_list` names the query or date and its bounds, then the entry or match count,
  whether more is available, and whether a continuation exists.
- `clipboard_get` names the entry id and page bounds, then the entry size, any
  continuation offset, and the escaped-control note.
- `clipboard_restore` names the entry id, then the restored size and any archive warning.

A result that hides content carries the expansion hint; a restore result, which repeats no
hidden content, carries none.

## Files

- `index.ts`: the ordinary tool registrations, the Durable contribution emission, and the `/clipboard` host.
- `operations.ts`: the shared parameter schemas, tool text, usage guidance, and tool operations.
- `durable.ts`: the native Pi Durable contribution.
- `settings.ts`: passive archive directory declaration and local reader/publisher.
- `store.ts`: local settings read, private append-only archive, and stable-id resolution.
- `search.ts`: bounded literal discovery, candidate validation, and stateless continuation.
- `pb.ts`: no-shell `pbcopy` and `pbpaste` wrappers.
- `panel.ts`: browser state and rendering.
- `text.ts`: terminal-safe text and output bounds local to this extension.
- `*.test.mts`: unit and entrypoint drive tests.

## Verification

```bash
node --test extensions/clipboard/*.test.mts
npm test
```

`native.test.mts` and `durable.test.mts` exercise tool execution through ordinary
Pi and Durable hosts with controlled providers, synthetic archives, and replacement
clipboard executables. Their evidence concerns exercised execution, not live-model
search judgment or storage-layer crash recovery.
