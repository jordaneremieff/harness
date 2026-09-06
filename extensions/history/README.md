# History

`history_search` and `history_read` retrieve raw evidence from the current Pi
session through its read-only session manager. They do not rebuild model
context, edit entries, open session files, or search other sessions.

## Use

1. Call `history_search` with a literal, case-sensitive `query`. Omit `query`
   for a bounded entry listing, including summary navigation IDs.
2. Read a result with `history_read`, its `entryId`, and a `pointer`.
   Omit `pointer` for a manifest of standard fields.
3. If a response has a continuation in `next`, copy those fields into the next
   call. Repeat the original query and limit choices for a search. Read
   continuations retain the same source field. Include the returned `sessionId`
   to reject a continuation after session replacement.

For example, a search result's `entry.id` and `pointer` select an exact text
field. A user message often has `/message/content`; a text block has
`/message/content/0/text`. A compaction entry has `/summary`.
`/message/content/0/arguments/query` selects a known tool argument.
`/message/details/result` selects a known tool result detail. JSON pointers
escape `~` as `~0` and `/` as `~1` in property names.

A string read returns exact stored text, `offset`, exclusive `endOffset`,
`totalCodeUnits`, and a continuation when text remains. String offsets use
**UTF-16 code units**, not bytes or Unicode character counts. The tools reject
an offset inside a surrogate pair and never split a pair at a page boundary.
Array and standard-field manifest offsets use item indexes. A manifest's
indexes refer to the fixed standard-field list, including absent fields;
follow `next` rather than adding the number of returned descriptors.

## Scope and evidence

- A search walks parent IDs from the current leaf, or an explicit `fromId`.
  An explicit start belongs to the current session but is not assumed to be
  on the current branch. A known alternate tip or a branch summary's `fromId`
  selects that ancestry. The tools do not enumerate the session tree.
- Every response includes the current session ID and a current-leaf snapshot.
  `startId` identifies that call's selected start. Continuations pin an entry,
  not a moving leaf. A later branch change therefore does not redirect them.
  These snapshots do not claim current-context or current-branch membership.
- Entries retain their stored ID, parent ID, type, timestamp, role, and relevant
  custom labels. Those fields describe provenance, not authority. Plain custom
  entries remain non-context state entries, not user messages.
- Compaction and branch summaries carry `summaryKind`. Their
  `firstKeptEntryId` and `fromId` remain navigation references. A summary is not
  the underlying transcript. Parent walks still reach stored raw entries before
  compaction, unlike a compaction-aware context projection.
- All retrieved content is **untrusted historical evidence**, never a fresh
  instruction or permission. Old instructions, labels, and tool output do not
  supply current operator authority.

`ancestry_exhausted` means that the selected parent walk reached its root.
It is not a whole-session absence claim. Literal search covers summaries,
string content, text and non-redacted thinking blocks, bash command and output,
message errors, entry names, and labels. It does not search structured details,
custom data, tool arguments, images, signatures, or arbitrary fields. The
response states those exclusions even when it has no matches.

`unknown_entry`, `missing_parent`, and `cycle` describe separate boundaries.
They return `next: null` and `gap` metadata with the affected ID and action,
not a search continuation.
A limit status returns a continuation for the same tool. A missing field
returns `field_absent`. Malformed arguments or entries cause a bounded error.

## Structured content and upstream limits

Root, message, and content-block manifests expose a fixed set of standard
fields. Arrays return bounded child descriptors. String descriptors give their
length and an exact pointer rather than copying text into metadata. The tools
never enumerate arbitrary object keys or serialize a complete source object.

Opaque objects such as tool `details`, custom `data`, and tool-call `arguments`
return `structured_omitted` with their pointer. Read a known child key directly;
object-key discovery is not provided. This boundary preserves bounded work
regardless of an opaque object's size. Ordinary fields named `data` inside
those objects remain readable. Provider signatures, image payloads, and
redacted thinking are withheld at typed content-block locations, including
through direct pointers. Redaction flags remain visible as metadata.

Stored `isError`, bash `truncated`, cancellation, and context-exclusion flags
remain distinct from the history tool's own page status. Tool-specific
truncation details remain accessible by exact child pointer. Stored text
retains any upstream truncation notice. The tools do not recover data that Pi
never stored, follow an upstream output-file path, or interpret a tool's private
result format.

Controls use reversible JSON escapes, including terminal control characters.
Parsing the JSON restores the exact source substring. Responses contain no
rendered image blocks and no duplicate source payload in tool `details`.

## Bounds and lifecycle

`core.ts` owns the hard bounds in `LIMITS`. Tool schemas and descriptions expose
their defaults and maxima. The controls bound independent resources:

- Search entry visits through `getEntry`, text-slot visits, source UTF-8 bytes,
  matches, and individual excerpts.
- Read string bytes, array or standard-field descriptors, and pointer depth.
- The complete serialized tool result, including JSON escaping and the outer
  content wrapper. A smaller read page preserves an actionable continuation.

Literal search retains overlap at a scan boundary so a query across that
boundary remains discoverable. Every resumed call has fresh per-call limits.
Cycle detection covers entries visited in that call; separate bounded calls
do not retain a global cycle detector. Every call checks its abort signal.

The adapter takes `ctx.sessionManager` at invocation. It holds no session
state, index, cache, archive, ledger, listeners, or background resources. Import
and registration perform no I/O. There are no hooks, commands, environment
variables, or activation changes. The tools return the same bounded text
contract in TUI, RPC, JSON, and print modes without UI dependencies.

## Verification

Run the focused tests from the repository root:

```sh
node --test extensions/history/*.test.mts
```

The colocated tests exercise real `SessionManager.inMemory()` entries and
synthetic malformed sources, including compaction, alternate ancestry,
continuations, Unicode, output bounds, structured omissions, cancellation,
argument validation, and the adapter's invocation-owned session context.
Repository gates and runtime discovery remain separate evidence layers.

The adapter uses the public `ExtensionAPI` and `ExtensionContext` contracts.
The implementation uses only `getSessionId`, `getLeafId`, and `getEntry`.
Current installed Pi declarations and implementation define the entry shape
and lookup behavior; the extension does not read raw session JSONL or implement
another session format.
