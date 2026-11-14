# History

In ordinary Pi sessions, `history_search` and `history_read` retrieve raw
evidence through the current session's read-only session manager. They do not
rebuild model context, edit entries, open session files, or search other sessions.

The ordinary extension publishes its registered tool renderers at factory time and
on display requests through the [tool display contract](../../docs/conventions/tool-display.md);
the payload contains no execution functions. The same records come from
`display.ts`, a presentation-only module over `presentation.ts` that the Durable
contribution advertises as its display descriptor
(`{ version: 1, entry: "./display.ts", export: "toolDisplay" }`), so the standalone
Agent terminal renders history cards locally without the ordinary runtime.
Importing it registers no tools and emits no events.

## Use

The examples below use ordinary Pi session records. For native Pi Durable
sessions, see [Durable agents](#durable-agents) for committed ancestry, entry
schemas, and visibility differences.

1. Call `history_search` with a literal, case-sensitive `query`. Omit `query`
   for a bounded entry listing, including summary navigation IDs. Add
   `mode: "arguments"` to find earlier tool calls by an argument such as a
   file path or command; see [Argument search](#argument-search).
2. Read a result with `history_read`, its `entryId`, and a `pointer`.
   Omit `pointer` for a manifest of standard fields.
3. If a response has a continuation in `next`, copy those fields into the next
   call, including the returned `filter`. Retain the original query, filter,
   and limit choices for a search. Read
   continuations retain the same source field. Include the returned `sessionId`
   to reject a continuation after session replacement.

For example, a search result's `entry.id` and `pointer` select an exact text
field. A user message often has `/message/content`; a text block has
`/message/content/0/text`. A compaction entry has `/summary`.
`/message/content/0/arguments/query` selects a known tool argument.
`/message/details/result` selects a known tool result detail.
System-message manifests expose `sections`, `toolsAdded`, and `toolsRemoved`.
A compaction entry exposes its stored prompt and tool checkpoint at
`/systemMessage`; for example, `/systemMessage/sections/rules` reads a known
section. Sections and tool definitions remain structured fields, excluded from
literal search. These reads report stored changes and checkpoints, not a replay
of the current effective prompt or new instruction authority.

A context-edit entry exposes `/targetId` and `/replacement`. A null replacement
records an omission from model context. Otherwise, `/replacement/content`
selects the stored replacement string or content blocks; for example,
`/replacement/content/0/text`. These reads expose the edit itself, not the
current effective message. Literal search does not search replacement content.
JSON pointers escape `~` as `~0` and `/` as `~1` in property names.

A string read returns exact stored text, `offset`, exclusive `endOffset`,
`totalCodeUnits`, and a continuation when text remains. String offsets use
**UTF-16 code units**, not bytes or Unicode character counts. The tools reject
an offset inside a surrogate pair and never split a pair at a page boundary.
Array and standard-field manifest offsets use item indexes. A manifest's
indexes refer to the fixed standard-field list, including absent fields;
follow `next` rather than adding the number of returned descriptors.

## Source filters

Use the optional `filter` on `history_search` to select stored sources before
text scanning or listing. Omission preserves unfiltered search.

```json
{ "query": "release", "filter": { "source": "user" } }
```

This selects only raw `message` entries whose stored `message.role` is `user`.
It excludes assistant and tool-result echoes, `custom_message` entries, and
messages with other roles such as `custom` or `bashExecution`. Pi's conversion
of those sources to provider-facing user text does not change their stored
source. A stored user role does **not** prove human authorship or current authority.

```json
{ "filter": { "source": "toolResult", "toolName": "bash", "errorsOnly": true } }
```

This lists stored results from the exact, case-sensitive tool name `bash` with
`isError === true`. Add a `query` to search their supported text fields instead.
It does not select assistant tool calls or `bashExecution` records.
Omit `toolName` to select results from any tool. `errorsOnly: false` or omission
accepts any stored error flag, including an absent flag; `true` accepts only the
boolean `true`, not text that describes failure or a nonzero exit code.
`toolName` and `errorsOnly` require `source: "toolResult"`.

```json
{ "filter": { "source": "summary" } }
```

This lists raw `compaction` and `branch_summary` entries with their navigation
IDs. Add a query to search their summaries. It does not select custom messages
that quote summaries or expand the summaries into their underlying transcript.

Filtered responses echo `filter` and report `excluded`, the number of visited
entries rejected by that filter in this call. Rejected entries consume visits
but no text-slot, scan-byte, or match budget. Selection does not read rejected
entries' content or unrelated metadata. Identity and parent validation still
apply. A filtered empty page with `visit_limit` is not absence; follow `next`.
The `coverage` exclusions below remain unchanged for selected entries.

Every filtered continuation includes the same filter, even at entry boundaries.
Copy `next` intact and repeat the query and limits. There is no stored query or
cursor state: changing or dropping the filter starts different selection at
that position, not continuation of the original search. A text continuation
that selects an excluded entry is rejected. Session and entry pinning remain
unchanged.

## Argument search

Text search does not read tool-call arguments, so an earlier `edit`, `read`, or
`bash` call is invisible to it when its result text does not repeat the path or
command. Argument search is the explicit mode for that question:

```json
{ "query": "extensions/history/core.ts", "mode": "arguments" }
```

The walk, entry pinning, and session checks are those of text search. Inside each
entry, the search examines `toolCall` content blocks and literally matches the
query against the string values in their `arguments`, newest entry first and in
stored order within an entry. A match carries the entry metadata, a `call` with
the stored tool `name` and `id`, and the exact `pointer` of the matching string,
for example `/message/content/2/arguments/edits/0/newText`. Pass that entry ID
and pointer to `history_read` to read the complete value. Offsets, excerpts,
match, scan and output bounds behave as in text search.

To see every argument of the matched call, read the match's pointer up to
`arguments`, for example `/message/content/2/arguments`. That read lists the
call's argument keys in stored order, as described under
[Tool-call arguments](#tool-call-arguments).

Argument search requires a `query` and takes no `filter`: every filter source
selects entries that hold no tool calls. When `mode` is omitted or `"text"`,
text search keeps its results and response shape. It refuses an argument-search
`position` (in native sessions, a `position` with a `path`), so a continuation
that lost its `mode` cannot silently restart as a different search.

The executing `history_search` call is left out, so a search does not report its
own `query`. Earlier search calls, and calls such as a script that embeds the
query in its own arguments, remain ordinary matches.

Only string values match; numbers, booleans and object keys do not. The walk
reads the `type` of each content block and the `id`, `name` and `arguments` of
tool calls, nothing else. It never reads text or thinking content, tool result
text, `details`, custom `data`, signatures or image payloads, so it exposes
nothing that `history_read` withholds. A returned pointer names only the keys
on the path to its match; `history_read` lists the other keys.

Traversal bounds are explicit:

- Each call examines at most `LIMITS.argumentNodes` nodes: content blocks and
  argument values, plus messages in native sessions. `node_limit` returns a
  continuation at the next node.
- Containers `LIMITS.argumentDepth` levels below `arguments` are not entered.
- A value whose pointer would exceed the reader's `LIMITS.pointerUnits` limit is
  not read.

The response reports `nodesVisited` in place of `slotsVisited` and a `skipped`
object with `depth` and `pointerLength` counts for the values that the last two
rules left unexamined in this call. A nonzero count makes the page partial even
when the walk reaches `ancestry_exhausted`; `coverage` states the mode's scope.
Skipped values have no continuation.

A continuation carries `mode` and a `position`: the content block index and the
child indexes below `arguments`, with object children in stored key order.
Copy `next` intact and repeat the query and limits. A resumed call descends
directly to that position; it does not walk the values before it.

## Terminal cards

Both history tools render their own cards in the interactive transcript. A
collapsed card shows the request on its heading row and at most one qualifier
row, then one or two outcome rows. The argument and result expansion hints
appear only when the collapsed view hides or clips content, and each rides the
row it belongs to. An expanded card shows the full arguments, or readable
evidence first: for a search, the shown matches with entry kind, role or tool,
time, error flag, excerpt, pointer, and offsets, then the walked scope, then the
retained payload under a `Raw payload (retained)` heading; for a read, the
exact stored page text, then scope, then the raw payload. A collapsed error
shows one clipped line and the expanded card keeps the full retained
diagnostic. Expansion hints use the host-injected key binding and name no key
without one. Terminal controls are escaped and long values are clipped.

- `history_search` names the literal query, or the bounded listing when the
  query is omitted, with argument mode, filter, start entry, and continuation
  qualifiers. Argument matches add the called tool's name to their identity
  row, and the scope row counts skipped argument values. The
  outcome states matches returned, entries visited, and the walk status, plus
  the returned entry types; a bounded type list marks each omitted type. Each
  count agrees with its noun. An exhausted empty page reads as absence only
  within the walked scope; a limit status keeps the continuation visible, so a
  bounded page never reads as the end of the ancestry.
- `history_read` names the requested entry and pointer, with an offset
  qualifier. The outcome states the read status and the returned page versus the
  field total (UTF-16 code units for strings, item counts for lists), and shows
  the returned text with a continuation when more remains. A withheld result
  shows its reason. Each count agrees with its noun, and the text preview stays
  one row.

Both cards tolerate partial arguments and malformed payloads, and escape
terminal controls before display. The full result remains in native tool
history.

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
It is not a whole-session absence claim. Text search covers summaries,
string content, text and non-redacted thinking blocks, bash command and output,
message errors, entry names, and labels. It does not search structured details,
custom data, tool arguments, images, signatures, or arbitrary fields;
[argument search](#argument-search) covers tool-call argument strings. The
response states each mode's exclusions even when it has no matches.

`unknown_entry`, `missing_parent`, and `cycle` describe separate boundaries.
They return `next: null` and `gap` metadata with the affected ID and action,
not a search continuation.
A limit status returns a continuation for the same tool. A missing field
returns `field_absent`. Malformed arguments or entries cause a bounded error.

## Structured content and upstream limits

Root, message, replacement, and content-block manifests expose a fixed set of standard
fields. Arrays return bounded child descriptors. String descriptors give their
length and an exact pointer rather than copying text into metadata. The tools
never serialize a complete source object, and they enumerate object keys only
for tool-call arguments.

Opaque objects such as tool `details`, custom `data`, and system-message
`sections` return `structured_omitted` with their pointer. Read a known child
key directly; key discovery is not provided for them. This boundary preserves
bounded work regardless of an opaque object's size.

### Tool-call arguments

A tool call's `arguments` object is the model's own input, and each value is
already readable by pointer. A read at a `toolCall` block's `arguments`, or at
an object nested in it, lists its keys in stored order with the item paging
of arrays (`offset`, `maxItems` and the output limit). Each item carries the
`key` and its exact `pointer`, with `~` and `/` escaped. A string of at most 256
UTF-16 code units appears inline as `text` with `totalCodeUnits`. A longer
string, an array or a scalar has its usual descriptor. A nested object gives a
pointer whose read lists its own keys. Array items inside arguments use the
same item form. Listings reach the depth that argument search enters: an object
`LIMITS.argumentDepth` levels below `arguments` keeps the opaque descriptor. A
key whose pointer would exceed `LIMITS.pointerUnits` appears as
`{ "kind": "skipped", "reason": "pointerLength" }` with the key's length. Every
other opaque object keeps the behaviour above. Ordinary fields named `data` inside
those objects remain readable. Provider signatures, image payloads, and
redacted thinking are withheld at typed content-block locations, including
compaction checkpoints and context-edit replacements. Direct pointers retain
the same exclusions. Redaction flags remain visible as metadata.

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

`reading.ts` owns the shared hard bounds in `LIMITS`; the ordinary and Durable
entrypoints share those primitives. `durable.ts` also bounds physical search
candidates. Tool schemas and descriptions expose their defaults and maxima.
The controls bound independent resources:

- Search entry visits through `getEntry`, text-slot visits, source UTF-8 bytes,
  matches, and individual excerpts. Argument search replaces text slots with
  examined nodes and also bounds argument depth and pointer length.
- Read string bytes, array or standard-field descriptors, and pointer depth.
- The complete serialized tool result, including JSON escaping and the outer
  content wrapper. A smaller read page preserves an actionable continuation.

Literal search retains overlap at a scan boundary so a query across that
boundary remains discoverable. Every resumed call has fresh per-call limits.
Cycle detection covers entries visited in that call; separate bounded calls
do not retain a global cycle detector. Every call checks its abort signal.

The ordinary adapter takes `ctx.sessionManager` at invocation. It holds no session
state, index, cache, archive, ledger, listeners, or background resources. Import
and registration perform no I/O. There are no hooks, commands, environment
variables, or activation changes. The tools return the same bounded text
contract in TUI, RPC, JSON, and print modes without UI dependencies.

## Durable agents

A Durable agent receives its history capability from
`extensions/history/durable.ts`. The ordinary factory in `index.ts` emits that
contribution on the `durable:contribution` channel with the absolute entrypoint
path as its source. The [agent extension](../agent/README.md) owns contribution
discovery and host installation. The contribution takes every pi-durable runtime
value from the host's module.

The native form registers the same tool names and shared bounds, with a
physical search cursor and an additional candidate bound. Both declare
`replay: "safe"`: each call reads committed entries
only and repeats no external effect, so a rerun after process loss returns the
same bounded page for the same pinned position. The native extension also
installs one prompt section with the usage guidance, because Durable renders
model guidance through sections rather than tool prompt fields.

Semantic differences from the ordinary tools, all named in the tool results:

- **Entry IDs are native Durable IDs (numbers).** `entryId`, `fromId`,
  `startId`, `currentLeafId`, and continuation `fromId` use the Durable entry
  ID; `id` and `conversationId` in entry metadata are numbers as stored.
- **The walk is the conversation's fork-aware entry sequence.** Entries are
  compared by ID and scanned newest to oldest, including entries inherited
  through forks. There is no `parentId` chain, so `missing_parent` and `cycle`
  do not occur; `ancestry_exhausted` means the walk reached the oldest visible
  entry. An explicit `fromId` selects any visible entry, not only a tip.
- **`sessionId` is the host's Durable storage ID.** A continuation carries it
  and is rejected when it comes from another storage.
- **`currentLeafId` is the newest entry visible in the calling conversation**
  at the time of the call; it advances as the conversation grows and is not
  part of the pinned continuation.
- **Reads check conversation visibility.** `history_read` returns an entry
  only when the calling conversation's fork-aware ancestry contains it, and
  reports `membership: "checked_visible"`. The ordinary tools read the current
  session without a branch-membership check.
- **Search cursors use physical positions, not text-slot indexes.** Copy the
  returned `position` (`message` and `block`) with `fromId` and `offset`.
  `block: -1` selects the message content field, array indexes select content
  blocks, and the content-array length selects the message error field (zero
  for string or absent content). Each call counts examined message content
  fields, all content blocks including skipped non-text/redacted blocks, and
  error fields in `candidatesVisited`. The physical-candidate cap is independent
  of the text-slot, entry, byte, match and output caps; `candidate_limit` returns
  the next physical position. Cancellation is checked at each candidate. Resume
  starts directly at that position without enumerating earlier messages or
  blocks. A supplied retired `slot` coordinate is explicitly refused with a
  restart instruction, even when zero. Restart without `slot`, `position` or
  `offset`; an offset without a physical position is also refused. Ordinary
  cursors remain unchanged. These bounds apply to extension traversal, not
  upstream storage decoding of complete entry records.
- **Search selects Durable source kinds.** `filter.source` `user`, `summary`,
  and `toolResult` select `pi.user`, `pi.compaction`, and `pi.tool-result`
  entries. Search text is the committed model messages
  (`/model/<i>/content/...`), tool result content, and message errors; entry
  `data` and context-edit messages are not searched, as structured fields.
- **Argument search walks committed model messages.** Matches point at
  `/model/<i>/content/<b>/arguments/...`. Its `position` adds `path` to the
  physical `message` and `block` coordinates, with `block` starting at 0. Each
  examined message also counts as a node. The calling call is identified by the
  tool execution's `callId`. Context-edit messages are not searched.
- **Pointers address Durable entry records.** The root manifest exposes `id`,
  `conversationId`, `kind`, `model`, `data`, `head`, `edits`, and `byTaskId`;
  a message is `/model/<i>`, a content block `/model/<i>/content/<b>`, and a
  context edit `/edits/<e>` with its replacement messages below it.

There are no terminal renderer functions in the native form: Durable has no Pi
TUI renderer surface. The same withholding rules apply at Durable content-block
locations: image payloads, provider signatures, and redacted thinking are not
exposed. The native adapter holds no session state: each call takes the tool
API at invocation, commits its reads on the session line, and returns the same
bounded JSON text contract through pi-durable's `output` channel. Neither tool
has a structured output schema: the Harness derives a nested call's
`structuredOutput` from its bounded text, and native codemode receives that
JSON text as a string. Scripts parse the string to use page fields. Failed
calls reject in codemode; history page statuses such as `unknown_entry` remain
successful JSON results. The ordinary adapter retains its `content` result
and empty `details` without a structured schema.

## Verification

Run the focused tests from the repository root:

```sh
node --test extensions/history/*.test.mts
```

The colocated tests exercise real `SessionManager.inMemory()` entries and
synthetic malformed sources, including compaction, alternate ancestry,
continuations, Unicode, output bounds, structured omissions, cancellation,
argument validation, context-edit replacement manifests and withholding, and
the adapter's invocation-owned session context. Mixed-source tests cover raw
source selection, strictly true error flags, exact tool names, and composition
of filters with every search bound. The ordinary-session regression loads the
extension through Pi's resource loader, checks the emitted Durable
contribution's name and source, and drives its registered tools with a
scripted provider. Its synthetic comparison shows irrelevant tool output using
the unfiltered scan budget while the user filter reaches the stored user text.
That test establishes deterministic selection under its fixture, not aggregate
utility or model choice quality. The Durable regression runs the contribution
in a real Harness over `MemoryStorage` with pi-ai's faux provider, drives a
model-issued call for each tool, checks the declared replay class and
schema-less output, and compares repeated pinned pages across growing entries.
Proxy-counted native fixtures verify bounded candidate work, direct resume after
large text/non-text prefixes, cancellation within skipped content, and physical
cursor composition with filters, Unicode, query overlap and output limits.
Argument-search tests in both adapters cover a value that only an `edit`
argument holds, exact follow-up reads, match, scan and node continuations with
proxy-counted direct resume, depth and pointer-length skips, exclusion of the
calling call and withheld fields, and cursor validation. A real ordinary session
and a real Durable Harness each run a model-issued edit, an argument search and
a read of the returned pointer.
Native codemode regressions use the public pi-durable codemode extension and a
QuickJS sandbox against the same in-memory Harness. They check JSON text
strings, exact escapes, read continuations, manifests, and rejection of
validation and execution errors, both caught and uncaught. These tests use no
live stores or external providers. Repository gates remain a separate evidence
layer.

The ordinary adapter uses the public `ExtensionAPI` and `ExtensionContext` contracts.
Its session-manager access uses only `getSessionId`, `getLeafId`, and `getEntry`.
Current installed Pi declarations and implementation define the entry shape
and lookup behavior; the extension does not read raw session JSONL or implement
another session format.
