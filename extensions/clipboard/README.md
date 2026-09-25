# clipboard: macOS clipboard tools and history

This extension provides agent clipboard I/O and an operator-facing history browser. It intentionally targets macOS `pbcopy` and `pbpaste`.

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

## Find text from a remembered phrase

Use `clipboard_list` with `query` when the date and id are unknown. Without
`query`, the tool retains its recent-list behavior: default `limit: 10`, maximum
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

The implementation adds only on-demand scanning inside this extension. There is
no index, watcher, background work, new state store, archive migration, or runtime
dependency. Each page repeats bounded directory/metadata discovery. Candidate
checks can revisit a large prefix once per candidate, so broad queries and older
hits cost more reads and pages than narrow queries. All those reads share the
same per-call budgets. This cost buys correct duplicate resolution without an
unbounded id set or persistent index. The browser and copy/paste behavior remain
unchanged.

## Storage

History is one append-only JSONL file per local calendar day at `<agentDir>/clipboard/YYYY-MM-DD.jsonl`. `PI_CLIPBOARD_DIR` overrides the location.

- Each entry requires a valid stored id. Records without one are skipped, never assigned a synthetic identity. For duplicate ids, only the newest record is visible.
- Directory and file modes are re-enforced as `0700` and `0600` on use.
- Appends use one bounded `O_APPEND` write per record, with leading and trailing newline separators. Concurrent large appends do not interleave chunks. Short writes return an archive warning; a later append remains readable after a torn record without rewriting prior bytes.
- Archive opens use `O_NOFOLLOW` and `O_NONBLOCK`, then verify the descriptor is a regular file before changing its mode or accessing content. A pipe at an archive path is refused without waiting for a peer.
- Reads reject a symlinked store, ignore symlinked archives, skip blank or malformed records, and recompute derived metadata from validated content.
- Readers scan files and records newest-first in bounded chunks and check cancellation between reads and records. Lists stop after the requested page and retain no body content; the browser retains at most 32,768 characters per entry. Stable-id lookup refetches the full selected record without materializing a whole daily archive.
- Individual JSONL records are capped at 64 MiB. This contains malformed or unexpectedly large historical data while accommodating the tool's 8 MiB input limit and JSON escaping.
- Restores append a new `(restored)` entry because they are real clipboard writes.

A successful `pbcopy` followed by an archive failure is reported as a successful copy or restore with a warning. A `pbcopy` failure remains an error and does not append a false history event. Archival continues after a confirmed copy even if cancellation arrives afterward.

Clipboard subprocesses use asynchronous, shell-free I/O with a 30-second timeout and caller cancellation. Early stdin closure rejects the copy instead of raising an unhandled stream error. Pi's native `copyToClipboard(text)` helper has no cancellation parameter and emits OSC 52 in remote sessions. This extension retains its subprocess adapter to preserve cancellation, confirmed local-copy outcomes, and clean RPC output.

## Retention and deletion

History is retained until the operator removes it; there is no silent age-based pruning. Physical deletion is intentionally daily-file granular. A closed day's `<agentDir>/clipboard/YYYY-MM-DD.jsonl` can be removed directly on an explicit operator request. The current day's file should not be removed while sessions may be appending to it.

Entry-level deletion would require coordinated rewrites or tombstones across processes. That machinery is deferred until an observed need justifies it; an unsafe rewrite would reintroduce the cross-session data-loss race this store removed.

## Browser behavior

The overlay is available in TUI mode. RPC receives a notification that directs the caller to `clipboard_list`, rather than attempting a terminal-only custom component.

The overlay loads the newest 200 entries and marks the count with `+` when older history exists. It supports live filtering across labels, ids, and loaded body prefixes. Up/Down selects entries, Left/Right scrolls the preview by a page, Enter restores, and Escape clears or closes. Escape cancels an active restore. Disposal also cancels active work and suppresses late component callbacks. A completed copy remains a success if cancellation arrives only during archival. A truncated preview is labeled. Restore resolves the selected stable id again and writes the full archived content, so preview bounds never truncate the clipboard result.

The component is the sole height authority. It reads the host TUI row count and the overlay host does not impose `maxHeight`, which prevents Pi from slicing away the footer. Every rendered row paints the full width inside a background-backed frame. The footer is always the final row, including `40x10` and `50x12` terminals. Labels, previews, content, and error text have terminal and bidi controls escaped before custom rendering.

## Files

- `index.ts`: the clipboard tools and the `/clipboard` host.
- `store.ts`: private append-only archive and stable-id resolution.
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

The focused suite covers synthetic subprocess copy and restore, cancellation,
early stdin closure, stable-id recovery, bounded pages, concurrent large appends,
torn-record isolation, nonregular-file refusal, private storage, RPC command
routing, and browser behavior. Query tests cover phrase recovery beyond recent
lists and body prefixes, duplicate resolution across pages and files, malformed
and oversized records, byte/record/file/directory/output bounds, changed archives,
Unicode, control escaping, invalid input, cancellation, and empty pages.

The native test loads the actual extension entrypoint in an isolated ordinary Pi
session. A controlled provider drives list, query continuation, get, restore,
and error results through native tool execution. Synthetic archive files and
replacement clipboard executables keep the test off the operator's archive and
system clipboard. This establishes exercised execution, not live-model search
judgment. Browser tests drive keyboard input, narrow layouts, disposal, and late
results with controlled I/O; the query change does not alter that interface.
