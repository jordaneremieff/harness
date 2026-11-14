# clipboard: macOS clipboard tools and history

This extension provides agent clipboard I/O and an operator-facing history browser. It intentionally targets macOS `pbcopy` and `pbpaste`.

The ordinary extension publishes its registered tool renderers at factory time and
on display requests through the [tool display contract](../../docs/conventions/tool-display.md);
the payload contains no execution functions. The renderers live in `display.ts`, a presentation-only module with no registration, store, or settings access. The durable contribution advertises that module as its `display` descriptor (`./display.ts`, export `toolDisplay`), and the ordinary publication is derived from the same records.

## Surfaces

| Surface | Kind | Purpose |
|---|---|---|
| `clipboard_copy` | tool | Write via stdin-fed `pbcopy` and archive the write, unless `archive` is `false`. |
| `clipboard_paste` | tool | Read the current clipboard in bounded pages. |
| `clipboard_list` | tool | List recent entries or search full archived text, with bounded continuation and stable ids. |
| `clipboard_get` | tool | Read one archived entry by stable id, in bounded pages. |
| `clipboard_restore` | tool | Copy one archived entry back to the clipboard; it adds no archive entry. |
| `/clipboard` | command | Browse recent entries or search the archive, preview, and restore in the shared browsing frame. |

Each tool is one operation; there is no action multiplexer, and the model-facing
API has no transient index addressing — stable ids are the only entry handle.
`clipboard_paste` and `clipboard_get` return at most 8,000 Unicode characters per page, subject to the stricter 50 KiB and 2000-line output bounds. A `nextOffset` tells the caller how to continue.

## Use

Call `clipboard_copy` with the text to write:

```json
{"content":"Rollback instructions: restore the saved revision.","label":"rollback instructions"}
```

When the operator asks that a copy stay out of clipboard history, set
`archive` to `false`:

```json
{"content":"Reset link for the shared account.","archive":false}
```

The tool then writes the clipboard only. The result says that the copy was not
added to history and carries `archived: false` instead of a stable id, so the
copy cannot be listed, read, or restored later. The default, `true`, archives
the write. The option changes only the archive: the content still reaches the
system clipboard, where other applications and clipboard managers can read it.

Call `clipboard_paste` only when you need the current clipboard:

```json
{"max_chars":8000}
```

If a read returns `nextOffset`, pass it as `offset` to continue. Use
`clipboard_list` to find archived text, then `clipboard_get` to inspect it
or `clipboard_restore` to write it back. Restore writes the clipboard only and
adds no archive entry. Archive search alone does not
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
- Readers scan files and records newest-first in bounded chunks and check cancellation between reads and records. Lists stop after the requested page and retain no body content; the browser reads no body content for list rows and at most 32,768 characters for a selected preview. Stable-id lookup refetches the full selected record without materializing a whole daily archive.
- Individual JSONL records are capped at 64 MiB. This contains malformed or unexpectedly large historical data while accommodating the tool's string-length input limit of 8 × 1024 × 1024 and JSON escaping.
- Restores add no archive entry: a restore writes the clipboard from an existing record and changes the archive only by that read.
- A copy with `archive: false` opens no archive file and adds no record.

A successful `pbcopy` followed by an archive failure is reported as a successful copy with a warning. A `pbcopy` failure remains an error and does not append a false history event. Archival continues after a confirmed copy even if cancellation arrives afterward.

Clipboard subprocesses use asynchronous, shell-free I/O with a 30-second timeout and caller cancellation. Early stdin closure rejects the copy instead of raising an unhandled stream error. Pi's native `copyToClipboard(text)` helper has no cancellation parameter and emits OSC 52 in remote sessions. This extension retains its subprocess adapter to preserve cancellation, confirmed local-copy outcomes, and clean RPC output.

## Retention and deletion

History is retained until the operator removes it; there is no silent age-based pruning. Physical deletion is intentionally daily-file granular. A closed day's `<agentDir>/clipboard/YYYY-MM-DD.jsonl` can be removed directly on an explicit operator request. The current day's file should not be removed while sessions may be appending to it.

The extension provides no entry-level deletion. Daily-file removal avoids rewriting an archive while other processes append to it.

## Browser behavior

`/clipboard` opens the Clipboard view in the shared browsing frame below the
native transcript (`docs/conventions/operator-panels.md`), in TUI mode. RPC
receives a notification that directs the caller to `clipboard_list`, rather
than attempting a terminal-only component. The command shows Clipboard on its
own. Because this extension publishes it as an operator view, `/dashboard` also
shows it as a tab. The view module loads when the destination opens; until it
is ready the frame shows a reading placeholder.

The footer at the bottom lists each control as its key and its short label. A
click on a control runs the same action as its key. The keys of this view are
`enter` to restore and `r` to refresh. `/` focuses the search field. `x` opens
the list of every other action, such as Search archive and Continue. Escape
closes the browser or goes back from a nested view.

The view has two scopes. **Recent** lists the newest 200 entries; the search
field filters them by label, id, and excerpt. **Archive** runs the same literal
search as `clipboard_list` over full archived text, one page at a time: type the
text, then press Enter in the search field; **Continue** reads the next
page while the scan has one. A page that is empty can still have a
continuation, and the status line shows whether the scan is partial. Recent
rows read metadata only; a selected entry's preview is read on demand, bounded
to 32,768 characters. Preview reads are cancelled when the selection moves, and
late results are discarded. A query change invalidates the archive state from
either scope, and a late result for the old query never marks the new one
fresh.

Selecting a row reads it and never restores it. **Restore** is the one effect:
it stays unavailable, with its reason, until the exact record has been read,
while another restore runs, and while archive results are stale after a query
change or a read failure. Restore resolves the selected stable id again and
writes the full archived content, so preview bounds never truncate the
clipboard result; a truncated preview says so. **Refresh** reads recent entries
again or reruns the search and never changes a record; it also retries the
selected record's failed read, and Restore stays unavailable until that read
succeeds. Restore adds no archive entry: it writes the clipboard and leaves the
history unchanged. Leaving the view cancels active reads and drops late answers.
The query, scope, and selection survive leaving and reopening the view within
the session. Labels, previews, content, and error text have terminal and bidi
controls escaped before rendering.

The same view serves two hosts. Ordinary Pi binds its reads and Restore to the
archive directly. The attached Agent terminal opens it through
`operator-panel.ts`, a presentation-only module that routes every read and the
restore through the host's `clipboard` contribution command.

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
| `clipboard_restore` | unsafe | A rerun overwrites newer clipboard content. An interrupted unsafe call returns an interrupted result instead of rerunning. |

An interrupted unsafe call returns an interrupted result instead of rerunning.
Model-facing guidance renders as the prompt section `clipboard`, composed from
the same snippets and guidelines the ordinary registration exposes. The native
tools map ordinary `content` to native `output` and retain the same details
object. They declare no structured output schema. Pi Durable supplies bounded
text as `NestedToolExecutionResult.structuredOutput`, so native codemode calls
resolve to strings, including JSON text from archive search. Failed calls reject
in the script rather than resolve to presentation details. The ordinary tool
cards do not apply because a Durable session renders its own transcript.

The contribution also registers the `clipboard` command and advertises the
browser module as its `panel` descriptor (`./operator-panel.ts`, export
`operatorPanel`, command `clipboard`). Without structured data the command
answers a bounded recent listing as text, for `agent_command` and
`/agent command`. With `data` it validates one request of the finite union in
`panel-protocol.ts` and answers `{ text, data }`:

| Request | Effect |
|---|---|
| `{ op: "recent" }` | Reads the newest 200 entries, metadata only. |
| `{ op: "search", query, cursor? }` | One bounded literal archive page, the same search as `clipboard_list`. |
| `{ op: "preview", id, archiveDate? }` | The exact record with a 32,768-character content prefix. |
| `{ op: "restore", id, archiveDate? }` | Rereads the exact record in full and writes the host's clipboard; it adds no archive record. It answers `ok`, or `ok: false` with the error. |

Browsing, searching and previewing start no model work and change no record.
Restore is the only effect, and only its footer control or the `enter` key
sends it. A malformed request is an error, never an empty history; a malformed
answer is reported by the browser as a read failure.

Until the host answers, the Recent list and its status line say the entries are
being read. A failed read says the history could not be read, with the reason
and that Refresh retries, never an empty history. Refresh and the way out stay
usable.

## Tool cards

Each tool draws a compact TUI card. A collapsed card never shows copied, pasted, or
archived content; it shows the label, size, id, and outcome instead. Expansion reveals the
full arguments or result text with a display bound, and terminal controls escape to text
in every collapsed value.

- `clipboard_copy` names the label and reports the content size in UTF-16 code units
  (or that the content is still streaming), then the copied size, the id, and any archive
  warning, or `not archived` for a copy with `archive: false`.
- `clipboard_paste` names only the requested page bounds, then the page size, any
  continuation offset, the escaped-control note, and the empty state.
- `clipboard_list` names the query or date and its bounds, then the entry or match count,
  whether more is available, and whether a continuation exists.
- `clipboard_get` names the entry id and page bounds, then the entry size, any
  continuation offset, and the escaped-control note.
- `clipboard_restore` names the entry id, then the restored size.

A result that hides content carries the expansion hint; a restore result, which repeats no
hidden content, carries none. An error card shows the first diagnostic line when collapsed and
reveals the full retained diagnostic text when expanded; the expansion hint appears only when
the diagnostic has more than one line.

## Files

- `index.ts`: the ordinary tool registrations, the Durable contribution emission, and the `/clipboard` host.
- `operations.ts`: the shared parameter schemas, tool text, usage guidance, and tool operations.
- `durable.ts`: the native Pi Durable contribution.
- `settings.ts`: passive archive directory declaration and local reader/publisher.
- `store.ts`: local settings read, private append-only archive, and stable-id resolution.
- `search.ts`: bounded literal discovery, candidate validation, and stateless continuation.
- `pb.ts`: no-shell `pbcopy` and `pbpaste` wrappers.
- `operator-view.ts`: the Clipboard view in the shared browsing frame, over the operations it is given.
- `browser-operations.ts`: the archive reads and the restore behind the view, shared by both hosts.
- `panel-protocol.ts`: the native route's request union and answer readers.
- `operator-panel.ts`: the attached-terminal module over `operator-view.ts` and the request route.
- `display.ts`: presentation-only tool renderer records returned by `toolDisplay()`; it imports only `presentation.ts` and public types.
- `text.ts`: terminal-safe text and output bounds local to this extension.
- `*.test.mts`: unit and entrypoint drive tests.

## Verification

```bash
node --test extensions/clipboard/*.test.mts
npm test
```

`native.test.mts` and `durable.test.mts` exercise tool execution through ordinary
Pi and Durable hosts with controlled providers, synthetic archives, and replacement
clipboard executables. The Durable test also uses public native codemode to
check text results, search JSON, page continuation, and error rejection. Their
evidence concerns exercised execution, not live-model search judgment or
storage-layer crash recovery.
