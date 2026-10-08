# stash: session continuity

The ordinary extension publishes its registered tool renderers at factory load and
on versioned requests through the [tool display contract](../../docs/conventions/tool-display.md).
The payload contains only tool names and renderer fields, never execution functions.

The agent distills an effort into a durable Markdown handover. The extension owns deterministic storage, discovery, and pickup. The active agent distills its own effort through `stash_write`; `/stash new <hint>` starts independent Durable work from a captured session snapshot, without a turn or status update in the caller.

## Surfaces

| Surface | Kind | Purpose |
|---|---|---|
| `stash_write` | tool | Persist a self-contained handover with project, branch, and session metadata; `checkpoint: true` saves a working synthesis outside handover discovery. |
| `stash_list` | tool | List recent artifacts, or find remembered content with `query` and stateless continuation; filter by tag or lifecycle state. |
| `stash_read` | tool | Read by exact id or unique prefix without changing lifecycle state. Returns a digest for edits. Results are capped at 50 KiB or 2000 lines and include the path when truncated. |
| `stash_edit` | tool | Correct or amend the saved body with revision-checked exact replacements; preserve the title, metadata, and lifecycle. |
| `stash_complete` | tool | Close an open or active effort with a required concrete outcome. |
| `stash_rotate` | tool | Archive a stale open or closed effort so it no longer appears in listings or pickup; the file moves to the store's dot-hidden `.trash` directory and remains recoverable. |
| `/stash` | command | Browse and pick up efforts (TUI overlay); bare invocation opens the browser. |
| `ctrl+alt+s` | shortcut | Open the same browser directly in TUI mode without submitting or replacing the editor draft. |
| `/stash new <hint>` | command | Admit independent Durable creation from the current context snapshot and hint; find the artifact through normal discovery. |
| `/stash get <id>` | command | Pick up a stash by full id or unique prefix. |
| `/stash get <id> <note>` | command | Pick up with an operator note: material recalled after the stash was written, delivered ahead of the artifact and authoritative on conflict. The artifact itself is never rewritten. |
| `/stash release <id>` | command | Return an active stash to open (dead-session cleanup). |
| `/stash capacity [reset]` | command | Inspect the last capacity observation and request latches, or explicitly start a new pressure episode. |

Pickup is one system action. The command reads the selected artifact and sends it as the next user message through `pi.sendUserMessage()`. The agent does not need to orchestrate a second `stash_read` call. The current working directory is never changed implicitly; the pickup message names both the current workspace and the recorded project, and calls out a mismatch before edits begin. An optional operator note (`/stash get <id> <note…>`, or the browser's `a` key) rides along in the same message as a distinct amendment block placed ahead of the artifact, marked newer than it and authoritative on conflict; the note is trusted operator input, terminal-sanitized, capped at 20,000 characters, and never persisted — the stashed core material stays byte-identical. `stash_write` emits the equivalent fresh-session shortcut:

```bash
pi "/stash get <id>"
```

## Use

A handover is a saved description of an effort for another session. A checkpoint
is a working synthesis saved outside normal handover discovery.

1. Save your current effort with `stash_write`, including its outcome so far,
   decisions, open questions, sources, and exact next actions. Saving does not
   complete the effort.
2. Find a handover with `stash_list`, then inspect it with `stash_read` and the
   returned id. Continue a truncated read through its file path.
3. For an authorized body correction, use [stash_edit](#edit-a-saved-handover)
   with the current digest and unique exact text. A pickup note accompanies a
   request without changing the saved body; an edit changes that body.
4. Close finished work with `stash_complete` and a concrete outcome. Use
   [Lifecycle](#lifecycle) for deliberate release, reopen, and archive actions.

For operator pickup, `/stash get <id>` activates the handover and delivers it as
one request. The browser requires Pi's interactive terminal (TUI) mode; direct
commands provide the non-browser path.

## Configuration

See [Storage](#storage) for `PI_STASH_DIR` and the default artifact location,
[Machine settings](#machine-settings) for checkpoint directories and
pressure thresholds, and [Distillation model and thinking](#distillation-model-and-thinking)
for model selection. The declaration owns defaults; each section describes its
domain constraints. The
[configuration convention](../../docs/conventions/extension-config.md) owns
environment setup.

## Terminal cards

The stash tools render their own cards in the interactive transcript. A collapsed
card shows the request on its heading row and one qualifier row, then the
outcome on one or two summary rows. The argument and result expansion hints
appear only when the collapsed view hides or clips content, and each rides the
row it belongs to. An expanded card shows the full arguments or result text.
Terminal controls are escaped and long values are clipped.

- `stash_write` names the title and the payload shape (checkpoint mode, summary
  length, list sizes). The outcome names the stored id and state; it reports a
  handover record and never claims the effort is complete. The artifact path
  stays in the expansion, except for a checkpoint, where the path is the only
  locator.
- `stash_list` names the remembered phrase or the recent list, with tag, state,
  limit, and continuation qualifiers. A search page states matches, skips, and
  whether coverage is complete or partial, plus the match states, so an empty
  partial page never reads as proof of absence; a recent list states the entry
  count by state and any truncation. Each count agrees with its noun, and a
  bounded state list marks each omitted state.
- `stash_read` names the requested id. The outcome leads with the artifact's
  frontmatter state and title and the returned line count, and falls back to the
  line count when the frontmatter is absent. The artifact path stays in the
  expansion.
- `stash_edit` names the artifact, replacement count, and any explicit active-edit
  acknowledgement. Its outcome separates changed content from an unchanged
  artifact and names the preserved lifecycle state. The digest stays in the
  expanded result.
- `stash_complete` previews the requested outcome on the call row. The outcome
  reports the closed state with the retained artifact; the recorded outcome
  stays in the expansion.
- `stash_rotate` names the id and reports the recoverable archive path.

All cards tolerate partial arguments and malformed details, and escape terminal
controls before display.

## Find remembered content

Use `stash_list({ query: "inode checks", limit: 5 })` when the remembered detail
is not in a title or tag. Search covers the metadata and full bodies of supported
handover artifacts, including older records outside the browser's preload and
text beyond its preview. Results contain stable IDs, bounded titles, lifecycle
states, the first matched field, and an excerpt. Then use `stash_read` with the
selected ID before resuming work. Search never picks up, closes, reopens, rotates,
or claims an effort. Artifact text remains evidence, not fresh authority.

Without `query`, the tool lists recent artifacts newest first with optional
filters and a result limit. `cursor` requires `query`. With a query:

- Matching is literal and case-insensitive through JavaScript Unicode `iu`
  simple case folding. Regular-expression punctuation is literal. There is no
  normalization, locale-specific folding, or full folding: Kelvin `K` matches
  `k`, an astral uppercase/lowercase pair matches, but `İ` does not match `i`,
  `ß` does not match `ss`, and composed `é` does not match decomposed `é`.
- The query is nonblank, at most 256 UTF-16 units, and contains no unpaired
  surrogates, control/format characters, or line separators. Leading and trailing
  spaces remain literal. Tag matching stays exact and case-sensitive; an empty
  tag retains the existing no-filter meaning. State filters accept only verified
  `open`, `active`, or `closed` values. Missing or unrecognized lifecycle values
  remain `unknown` in unfiltered search.
- Search checks filename ID, title, each tag, creation time, project, branch,
  session ID, state, lifecycle timestamps, outcome, then body. It returns the
  first matching field per artifact, in reverse filename order. Unknown
  frontmatter keys are not searchable metadata. The filename owns the ID.
- Each field is credential-redacted in full, then terminal-escaped before
  matching or excerpt selection. The body is the frontmatter parser's trimmed
  body. `start`/`end` and `excerptStart`/`excerptEnd` are half-open UTF-16 offsets
  in that transformed field, not raw Markdown or byte offsets. Excerpt bounds
  preserve surrogate pairs. Titles are display prefixes; offsets never refer
  to that shortened title. A credential-shaped filename produces a redacted
  skip report, never an altered ID presented as selectable.

### Search bounds and continuation

Each call enumerates at most 10,000 direct directory entries plus one overflow
sentinel. Iterative directory reads use a one-entry buffer and do not recurse.
An overflow refuses search before body reads; it does not sort or truncate an
incomplete inventory. The complete bounded inventory includes names and entry
kinds, including ignored entries. Candidate names use the same safe filename
shape as ordinary discovery. Nonregular candidate paths produce explicit skips.
Other names, hidden entries, checkpoint directories, and `.trash` contents are
outside the candidate scope.

A page visits at most 256 candidates, reads at most 4 MiB, and returns at most
10 matches and 16 KiB of JSON. `limit` lowers the match cap; values above 10 are
clamped for search only. Each artifact retains the 256 KiB supported-size cap.
Before a read, the page reserves room for a complete supported artifact plus one
size sentinel, so a byte-heavy page can stop below 4 MiB. Output admission checks
include skips and reserve the cursor and final counters. A result that does not
fit remains at the next cursor position; the next call rereads it. `deferred`
counts that read without counting it as consumed. No index, saved search state,
background task, or extra store exists.

Repeat the exact `query`, `tag`, and `state` with `nextCursor` until it is null,
including after an empty page. Changing `limit` is allowed. The cursor binds the
query, filters, directory path/device/inode, complete filename/kind inventory,
next position, and cumulative skipped count. A canonical checksum detects
cursor corruption; it is not authentication or a hostile-client security
boundary. Malformed cursors, changed membership, changed entry kinds, a replaced
store, or different query/filters require a restart without the cursor. Edits to
an artifact's bytes do not invalidate a filename inventory.

`coverage` reports the inventory size, candidate count, page range `[from,next)`,
visited count, actual bytes read, fully searched count, filter exclusions,
deferred count, and cumulative skips. `visited` equals searched + filtered +
page skips + deferred. `complete` means continuation reached the end without
skips; it does not mean a frozen archive snapshot or prove absence under other
wording. A zero-match page says nothing about unvisited or skipped artifacts.

Oversized, malformed-header, invalid UTF-8, vanished, unreadable, symlink,
nonregular, and changed-during-read candidates are explicit skips. Valid JSON
with a missing or unrecognized lifecycle value remains searchable as unknown.
Each read checks size and timestamps after its own permission hardening, reads
through a no-follow/nonblocking regular-file descriptor, then checks that
descriptor and the current path again. These are per-read observations, not a
transaction with external writers. A later body/filter edit can change results
on subsequent pages, and prior pages are not searched again automatically.
Cancellation stops between directory and file operations and closes open
handles; it does not undo permission hardening already performed.

Search enforces private directory mode on every call and private file mode on
each opened artifact. It does not run or mark complete the ordinary whole-store
permission sweep. Later ordinary list/read/write paths still perform that sweep.
Search leaves artifact bytes and lifecycle state unchanged.

## Native structured discovery

`stash_list` declares an explicit `outputSchema` and returns `structuredContent`
for native codemode callers. Direct calls retain their existing prose and render
metadata; scripts do not parse that prose.

Recent results use `kind: "recent"` and `records` containing only displayed
`id`, terminal-safe `title`, and `state` (`open`, `active`, `closed`, or `unknown`).
Only complete rows within the displayed text prefix enter the structured result.
The serialized object also stays within 50 KiB, including JSON escaping.
`selectedCount` counts the entries selected by the existing list operation;
`omittedRecords` counts selected entries excluded from the structured page.
`textTruncated` separately reports prose truncation. No body, path, project,
session metadata, or undisplayed record is added.

`limit` reports the requested limit. `limitReached` says only that selection
reached it, not that another record exists. Recent listing has no cursor and
measures no store-wide coverage: `nextCursor` and `coverage.complete` are null,
even for an empty result. Use content search for supported continuation.

Search results expose the existing page object unchanged, with `matches`,
`skipped`, `coverage`, `nextCursor`, `consistency`, and `representation`. Their
existing JSON bound, cumulative skips, and empty-page continuation rules apply.
Tool-owned validation and store failures return `isError: true` with their error
text and a structured `{ kind: "error", error, coverage: { complete: false },
nextCursor: null }` object. Its error string is a bounded terminal-safe prefix.
Scripts must check this variant; cancellation still throws. Host validation,
interception, and cancellation failures need not supply a structured object.

```javascript
const page = await tools.stash_list({ state: "open" });
if (page.kind === "error") throw new Error(page.error);
if (page.kind === "recent") {
  console.log({
    handovers: page.records.map(({ id, title, state }) => ({ id, title, state })),
    omitted: page.omittedRecords,
    limitReached: page.limitReached,
    coverage: page.coverage,
  });
}
```

## Edit a saved handover

Use `stash_read` before `stash_edit`. The read result includes a SHA-256 digest
of the complete raw file, including its frontmatter and lifecycle state. The
model-visible digest appears after a complete artifact or in its truncation
notice. It is also available in result details. The displayed text remains
terminal-safe; the digest binds the bytes on disk, not that escaped display.
Continue a truncated or control-escaped read through the returned file path
before selecting exact edit text.

`stash_edit` accepts `id`, `expectedDigest`, and an `edits` array of
`{ oldText, newText }` replacements. Every nonempty `oldText` must occur exactly
once in the original body. Edits must not overlap; later edits do not match
text introduced by earlier edits. Requests contain 1–32 replacements; each
`oldText` and `newText` is at most 100,000 UTF-16 code units and must contain no
unpaired surrogate. An empty `newText` deletes its matched text.
To append an amendment, replace a unique existing anchor with that anchor plus
the new information. Replacement text receives credential redaction. The tool
preserves the leading title heading and all frontmatter bytes, including
unknown metadata, creation provenance, and lifecycle fields. It does not rename
the artifact, edit tags, or reinterpret Markdown sections as structured fields.

The store applies all replacements or refuses the whole request. A stale digest,
missing or ambiguous match, overlap, invalid text, unsupported file, or oversized
result leaves the artifact unchanged. The complete result retains the store's
256 KiB limit. A no-op returns `changed: false` and the existing digest. Success
returns the exact id, state, new digest, and whether content changed. There is
no edit-history store or automatic rollback copy. If lock cleanup fails after
publication, the error states that the mutation completed and names the lock
path; read the artifact before another attempt.

Lifecycle gates are explicit:

- **Open:** a matching digest permits body edits.
- **Active:** edits refuse unless `allowActive: true` accompanies the matching
  digest. This acknowledges an authorized edit to an active effort; it neither
  grants permission nor claims exclusive ownership. Pickup records activity,
  not an owner lock. Do not add this flag merely to clear a refusal.
- **Closed:** edits always refuse. Deliberate, operator-authorized
  `/stash reopen <id>` precedes another read and edit. The edit tool never
  reopens an effort or clears its recorded outcome itself.
- **Unknown:** edits refuse until the artifact's state is resolved.

On a stale revision, read again and reassess the requested change. Do not
substitute the new digest into an old plan without reviewing the new content.

Editing, lifecycle transitions, and rotation share an exclusive private
`.<exact-id>.lock` file inside the store. Contention fails immediately instead
of queuing across processes. A crash can leave the lock file behind; no timer,
lease, or automatic deletion claims that the writer is gone. The refusal names
the lock path. Verify that no writer remains before an explicitly authorized
manual removal. Ordinary same-process lifecycle calls also retain Pi's file
mutation queue.

This lock protects cooperating current Stash writers across ordinary sessions
and Durable hosts. Direct file edits and already-loaded older implementations
do not honor it. Revision and identity checks detect observed external changes;
they do not supply an atomic compare-and-swap against arbitrary external file
writers. Restart or reload the relevant hosts before relying on the shared
writer contract. Reads remain nonmutating apart from existing permission
hardening. Locks do not appear in handover discovery.

## Lifecycle

New artifacts begin `open`. Pickup atomically changes an open artifact to `active`
before injecting its full handover; repeated pickup of an active artifact is
idempotent, and the pickup message then disowns the earlier activation: it names
the recorded activation time and states that any prior session's claim is
superseded, so a fresh session never wastes effort reconciling a phantom
predecessor. `release` returns an active artifact to `open` — the
operator-initiated inverse of pickup for a session that died or polluted its
context. It preserves the handover body and unrelated metadata, sets the state
to `open`, and removes the activation timestamp. The
pickup message names `stash_complete` and the exact id so the resumed
agent has a deterministic closure path. `stash_read` only reads; it does not activate
or claim an effort. `stash_complete` accepts open or active artifacts, requires an
outcome, and records `closed`, `closedAt`, and the outcome. Work resumed through
`stash_read` therefore closes without a separate pickup. Direct closure of an open
artifact does not invent an activation timestamp. Activation records pickup, not
proof of completion or an exclusive session lock.

A closed effort rejects repeated completion without changing its recorded outcome.
Read it with `stash_read` to inspect that outcome. Deliberately use `/stash reopen <id>`
before further pickup or replacement of the outcome. Unknown lifecycle state still
refuses completion; inspect and repair the artifact header before retrying.

Artifacts require an explicit JSON-encoded lifecycle state. Missing headers, missing states,
and malformed state values remain visible as unknown but cannot authorize pickup or lifecycle changes.
The extension never synthesizes missing metadata or interprets unquoted values as a second format.
Reopening returns a closed artifact to `open` and removes closure metadata
while retaining its prior activation timestamp. Artifacts never move or disappear as a
lifecycle side effect.

Command forms are:

```text
/stash                         browse & pick up (TUI overlay)
/stash new <hint>              distill the live session into a new stash
/stash get <id> [note]         pick up a stash, optionally with an operator note
/stash complete <id> <outcome> close an open or active stash with a concrete outcome
/stash release <id>            return an active stash to open
/stash reopen <id>             return a closed stash to open
/stash rotate <id>             archive a stale stash (recoverable)
/stash help                    show usage
```

Every `<id>` may be a full stash id or a unique prefix.

Writing a new handover never changes earlier artifacts. The write contract has no
predecessor id or explicit supersession field; matching titles, tags, session metadata,
or prose references do not authorize closure. Close a finished effort explicitly
with `stash_complete` and its outcome. Archive an obsolete handover through the
operator-initiated rotation path when that action is authorized.

The first token always selects an action. Creation therefore requires `new`, so
hints such as `abort the plan` and `help me` remain unambiguous as
`/stash new abort the plan` and `/stash new help me`. Unknown actions show
replacement guidance instead of silently starting a distiller. A bare token shaped
like a full stash id is rejected with `use /stash get <id>`. The `pickup` verb is hard-rejected
with its replacement syntax; it is not aliased. Typing `/stash ` autocompletes the
actions; after an id-bearing action it completes stash id prefixes.

Rotation is the operator-initiated archive path for stale efforts: an open or
closed artifact moves into the store's dot-hidden `.trash` directory
(see Storage), where it no longer appears in listings, pickup, or lifecycle
changes. Rotation refuses active artifacts until deliberate completion or release;
completion remains the only close path for an active effort, and release the
only way back to open. The file is retained byte-for-byte and restoring it is
a plain move back into the store.

## Capacity checkpoints

The `turn_end` hook reads Pi's context estimate once per enabled turn. At the
checkpoint threshold it adds a short model-visible request to preserve a working
synthesis with `stash_write({ checkpoint: true, ... })`. At the decision threshold
it requests an authorized continuity choice before further broad intake: checked
compaction for the same effort, or a discoverable handover for a fresh session.
The active agent decides the content and continuity path. The hook does not run
a separate distiller or call a model below threshold.

A pressure episode allows at most one checkpoint request and one decision
request. A jump past both thresholds combines them in one message. Each new
request returns `continue: true` through Pi's actionable boundary; a natural tool
continuation already satisfies that request. Ordinary turns never request extra
continuation. Falling usage does not re-arm a latch. Committed compaction, a new
session identity, or `/stash capacity reset` starts a new episode. Reload retains
latches; forks ignore the parent session's latches. The hook preserves earlier
boundary drafts and does not evaluate a pre-compaction percentage against an
earlier compaction draft.

The session owns compact custom state entries, not handover prose. Each state
records the session identity, source assistant entry, request latches, usage
availability, and text-intake estimate. Restoration walks at most 4096 active
ancestors to the nearest state or compaction. A malformed state, missing ancestor,
or exhausted scan reports an error instead of inventing an empty episode. Inspect
it, then use `/stash capacity reset` to establish a new starting point. Invalid
configuration disables the capacity action without disabling other stash tools;
the hook reports its first error through Pi, and the capacity command reports the
current error. No diagnostic writes to protocol stdout.

Requests precede their state entries and also retain their latch metadata, so a
partial append after a request does not automatically repeat it. Pi validates
boundary drafts but does not commit them transactionally. A persisted request is
not evidence that an agent read it, that the next provider call succeeded, or that
a checkpoint exists. The write tool's successful result establishes the saved
file. Aborted/error turns and an already-aborted signal do not request or latch
an intervention. An abort after dispatch can leave a retained notice without a
completed checkpoint; the next user prompt retains that notice unless compaction
or navigation removes it.

Unknown context usage stays unknown, including missing, invalid, or throwing
host telemetry. The optional intake budget is a separate trigger, never a
fabricated context percentage. It sums user, tool-result, and other custom-message
text since the episode boundary, estimates tokens as UTF-16 text length divided
by four (rounded up), and requests checkpoint plus decision when that budget is
reached while host usage is unknown. It excludes assistant text, the governor's
own notices, images, system prompts, and tool declarations. It is not a tokenizer
or a safe remaining budget. Without an explicit intake budget, unknown usage
produces no automatic request; governing manual checkpoint instructions still
apply.

### Machine settings

The `settings.ts` declaration and local reader/publisher use the
[settings contract](../../docs/conventions/extension-config.md): environment input, then the
`stash` section in `<agentDir>/harness.json`, then the declared default.
Invalid selected scalar input uses its safe default and reports the rejected
source. It never falls through to a file value beneath an invalid override.
Environment booleans accept `0`, `1`, `false`, and `true`; file values use JSON
booleans. Hooks and commands read fresh capacity values. The native host captures
its handover directory at creation; ordinary operations read the directory when
invoked. A fresh registry request publishes current configured values, not proof
that an existing runtime applied them.

<!-- harness:settings:start -->
| Key | Environment | Type | Default | Constraints | Description |
|---|---|---|---|---|---|
| dir | `PI_STASH_DIR` | path | &lt;agentDir&gt;/stash | none | Handover store directory. |
| capacity | `PI_STASH_CAPACITY` | boolean | true | none | Enable capacity observation and requests. |
| checkpointPercent | `PI_STASH_CHECKPOINT_PERCENT` | number | 85 | max 100 | Positive checkpoint threshold, strictly below the decision threshold. |
| decisionPercent | `PI_STASH_DECISION_PERCENT` | number | 90 | max 100 | Positive continuity-decision threshold, at most 100. |
| intakeTokenBudget | `PI_STASH_INTAKE_TOKEN_BUDGET` | integer | unset | min 1 | Positive token budget for the unknown-usage text-intake trigger. |
| checkpointDir | `PI_STASH_CHECKPOINT_DIR` | path | &lt;dir&gt;/checkpoints | none | Working-checkpoint directory, separate from the handover store. |
<!-- harness:settings:end -->

Both thresholds must be positive. When capacity is enabled, the effective
checkpoint threshold must be strictly below the decision threshold. A reversed
or equal pair stops capacity observation with a domain error and marks both
published fields invalid. Stash does not silently adjust either scalar value.
Other tools remain available. Disabling capacity skips this relation check.

All relative paths resolve against the host's agent directory, not the invoking
session's cwd. The checkpoint default derives from the effective handover
directory. Neither paths nor the machine document expand `~` or environment
variables. The settings document does not contain artifacts, capacity episodes,
distillation jobs, or provider/model selection.

A working checkpoint uses the same bounded Markdown format, redaction, private
permissions, and no-clobber publication as a handover. It lives in a separate
directory and returns a file path, not a pickup id. Read that path to recover the
synthesis. `stash_list`, the browser, and lifecycle commands operate only on the
handover store. Keep the checkpoint directory separate from that store. No
checkpoint is automatically pruned or converted into a handover. Omit
`checkpoint` when a future session needs normal discovery and pickup.

`/stash capacity` labels its usage value as the last boundary observation, not a
live reading. Reset appends state without deleting history. Reset deliberately
allows another request even if usage remains high; ordinary checkpoint writes do
not reset the latches. In TUI/RPC the command notifies; in print/JSON it returns
its text through the existing command-error channel because those modes have no
command-result notification surface.

This is a request mechanism, not a hard stop at any percentage.
Ordinary boundary results do not suppress natural tool work or queued messages.
The decision notice refers to governing stop instructions, but this extension
does not abort the agent, compact automatically, replace sessions, cancel
workers, or omit tool results. Those semantic and authority decisions remain
with the agent and operator. A later stop-threshold crossing does not produce an
additional notice after the decision request was already latched.

The stash slice owns this mechanism. Evaluate it with the focused boundary and
SDK tests below and observed checkpoint outcomes, not invocation counts alone.
Disable it if it fails to reduce missed checkpoints; remove it when Pi supplies
the same checkpoint-and-decision contract. Synthetic provider tests establish
bounded dispatch and persistence, not real-model compliance or long-term utility.

## Background distillation

`/stash new <hint>` materializes Pi's canonical persisted-context projection
with `sessionManager.buildSessionProjection()` before the first asynchronous
boundary. It captures the source metadata and target store, then admits an
independent Durable root through the documented
[independent-command host contract](../../docs/conventions/durable-contributions.md).
Exactly one synchronous launch provider must be available. Its receipt confirms
native admission; it is not a model task with a reply destination. The worker
has no tools or extension instructions beyond the distillation prompt.

The distiller receives the explicit system
instructions plus a single user message: the operator hint
first as the sole effort the artifact may cover, then the bounded transcript
(first quarter and last three quarters, marked at the cut). Concurrent or prior
mainline work in the same live session is out of scope for a hinted stash even
when it is longer, more recent, or more urgent-looking. A bounded reference
section retains deduplicated paths, work-item keys, and URLs observed in projected
tool results, including references outside the retained transcript window; those
references are candidates for the hinted effort only. The prompt ends with the
output contract and an instruction not to continue or answer the transcript.
It returns one JSON payload (optionally fenced) that the extension validates
against the same shape and caps as `stash_write` before writing through the atomic store with project,
branch, and session metadata. Before parsing, raw control characters inside
JSON string literals (literal newlines, tabs, and other control characters
that strict JSON requires escaped, which some models emit and `JSON.parse`
rejects as "Bad control character in string literal") are escaped
deterministically; a raw control character directly after a literal backslash
is repaired the same way, emitting an escaped backslash plus the escaped
control so the parsed value keeps both. The rewrite only touches characters
inside string literals, so a payload that would parse is unchanged and the
parsed value keeps the literal character. A `SKIP_STASH` reply writes nothing.

Capture honors compaction, the active branch, and its latest context edits.
Omitted messages contribute neither transcript text nor tool-result references.
Replacements apply to user, assistant, tool-result, and custom messages. These
messages contribute their replacement content with their role and tool-result
name/error metadata preserved. Shell executions and summaries are not
content-replacement targets. Compaction and branch summaries,
custom messages, and user/assistant/tool-result text remain available. Only the
current compaction contributes a summary, even when an older compaction entry
lies within its retained range. Shell executions use Pi's public text conversion,
which excludes executions marked out of context. Shell output is not relabeled
as a tool result or included in the tool-result reference section.

System prompts (including compaction checkpoints), non-context state, thinking,
provider signatures, and image payloads are excluded. Images retain a text
placeholder. Raw history stays unchanged. The
[history extension](../history/README.md) owns raw evidence retrieval. This is a
persisted-context snapshot, not a promise of parity with later transient context
hooks or the final provider input. A synchronous projection
failure reports a capture error before a job starts; it never falls back to raw
entries.

### Distillation model and thinking

The independent host selects fresh Pi configuration defaults for the invocation
workspace, with the host's resolved project trust. It does not inherit the
caller's selected model or thinking level. Configured model scope, saved defaults,
per-model thinking, global thinking, authentication, and capability clamping
follow Pi's ordinary fresh-session selection. The host persists that pair before
admission, so a restart does not reselect it. Stash has no separate model or
thinking override. Selection does not change the caller or settings files.

Generation uses native Durable conversation submissions with stable request IDs.
The native host owns provider execution, retries, usage, and restart recovery;
Stash adds no model loop or wall-clock job timeout. A completed response that
fails parsing or validation gets one format-correction submission against the
same captured source and hint in the worker's context. A second invalid payload,
a skip response, or a generation failure writes no artifact. Only a complete
text answer reaches publication.

The command returns after durable admission, not after generation or publication.
Ordinary success is silent in TUI, RPC, print, JSON, and native Durable callers:
no model acknowledgment, completion message, check-in, status key, or timer.
A nonzero input redaction report produces a one-time safety notice, not status.
Ordinary callers retain a displayed custom message without a model turn;
non-UI callers also receive the notice on stderr because text print ignores
custom messages. Native callers receive the notice in the command result. Each invocation
owns separate work. The caller neither tracks it nor cancels it on shutdown.
Admission errors still use the command's normal error channel. The independent
agent remains discoverable through the host's existing agent controls; use those
controls for explicit inspection or cancellation, including background work.
The artifact appears through `stash_list` discovery without a follow-up caller turn.

Only TUI mode constructs the custom browser. Headless callers can use `stash_list`
to discover ids; the explicit `get` and lifecycle verbs remain usable without the
browser. RPC receives actionable notifications; bare JSON/print browser
invocations fail with directions to the direct commands and model-facing tools rather
than silently returning or writing to Pi-owned stdout. In JSON/print, a successful
direct verb is silent because fire-and-forget UI is a no-op in those modes,
except for a one-time completion redaction notice; failures still throw. `stash_complete` remains the feedback-bearing closure surface for
headless callers. A state filter matches only artifacts whose header was actually
read; an artifact that vanishes or fails mid-listing, or whose lifecycle value is not
a recognized state, is excluded from state-filtered results instead of being reported
as open. Unrecognized values stay visible in unfiltered listings and read as
`unknown (<value>)`; every lifecycle action refuses them.

## Durable agents

Agents that run on Pi Durable (`@earendil-works/pi-durable`) receive the same
stash capability as a primary session. The ordinary factory emits one
`durable:contribution` event carrying the extension's absolute entrypoint path
(`source`). The [agent extension](../agent/README.md) owns contribution
discovery and host installation.

The native extension supplies `stash_write`, `stash_list`, `stash_read`,
`stash_edit`, `stash_complete`, and `stash_rotate` with the same parameter schemas,
tool descriptions, and model guidance as the ordinary tools. Artifacts remain
files in the external store; Durable documents hold capacity and distillation
control/outcome state. Each tool declares its replay class explicitly:

| Tool | Replay | Why |
|---|---|---|
| `stash_write` | `safe` | The call records its creation timestamp in a durable memo before the effect, and writes through the store's replayable publication. A rerun with the same memo and input reuses its byte-identical artifact instead of allocating a suffixed duplicate. |
| `stash_list` | `safe` | Read-only; a rerun repeats no external effect. |
| `stash_read` | `safe` | Read-only; a rerun repeats no external effect. |
| `stash_edit` | `unsafe` | Body publication is not automatically replayed after interruption. Read the current artifact before another attempt. |
| `stash_complete` | `unsafe` | A lifecycle mutation. An interrupted call leaves the model an interrupted result and is never rerun; the store's own identity checks protect the artifact. |
| `stash_rotate` | `unsafe` | A lifecycle mutation with the same boundary as completion. |

`stash_list` carries the native structured result that the ordinary tool
returns as `structuredContent` on `details.structuredContent`, and declares the
same `outputSchema` for nested-call consumers. `stash_edit`, `stash_complete`,
and `stash_rotate` use sequential execution. An edit error does not always mean
no write: lock cleanup can fail after publication. Read the current artifact
before repair or retry; the [edit contract](#edit-a-saved-handover) owns revision
checks and the cooperating-writer limit.

### Capacity guidance

The contribution ports the ordinary capacity monitor to two native generation
hooks. `beforeRequest` observes the request's model context, scans it for
Durable capacity notices, and, when a threshold crossing is due, records the
notice in a task memo before the request. `onYield` delivers a recorded notice
by continuing the run with it as a user message. Because the notice becomes a
committed user entry, the next generation recognizes it and does not repeat it:
a crossing produces at most one checkpoint request and one decision request,
and a replay of the deciding generation reads its own memo instead of
re-deciding.

The conversation document `stash.capacity` holds one episode counter. Ordinary
notices carry `[stash-capacity e=<episode> c=<conversation> ...]`; the scan
matches the current episode and conversation, so a fork never inherits its
parent's latches. `/stash capacity reset` increments the counter, which re-arms
both requests while the old notices remain in the context. Compaction removes
the notices and re-arms the crossing in the ordinary way.

The context observation follows Pi's host method: the newest accepted assistant
message's reported usage (total tokens, or input plus output plus cache reads
and writes) plus a text estimate for the messages after it, against the
context window from `host.services.modelRuntime` for that usage's model, the
stored agent model, or the newest assistant's model. The notice says the
estimate came from reported assistant usage. Without accepted usage, the whole
request text (UTF-16 characters / 4) is the estimate and the notice says so.
Neither form is a safe remaining budget. When the context window is unknown,
the optional `PI_STASH_INTAKE_TOKEN_BUDGET` trigger applies instead; without a
budget, unknown use produces no automatic request. Thresholds, the budget, and
capacity enablement use the same settings declaration as the ordinary hook,
with the native host's agent directory. Native creation replaces the factory's
settings publisher on the captured service-load event bus and releases it through
`host.onClose`; only one publisher remains active for the slice.

### Command and distillation

The contribution registers one `stash` command for agent controls. A native
caller captures its committed model context and source identity before launch,
then uses the same independent-host contract as the ordinary command. The
conversation-scoped `stash.launch` document family retains the first snapshot
under its invocation ID, including after an uncertain admission response. A
retry reuses that input despite later caller progress; a changed hint with the
same ID refuses. The captured hint is credential-redacted; a digest of its
original bytes binds retries without retaining removed values. This retained
input is not job monitoring. Neither entrypoint
creates a distillation task in the caller.

The worker receives validated structured command data with the captured source,
hint, project, branch, source session, and target store. In one native commit it
sets tool-free distillation instructions and records a background
`stash.distill` task in the `stash.distill` conversation document. Repeated
admission with the same invocation ID returns that task; another invocation
cannot replace its input. Generation and publication use the captured values,
not the worker's live workspace or a model-selected destination.

The task commits its validated payload and publication timestamp before the
external write. The replayable writer reuses a byte-identical artifact after a
restart between publication and receipt. The task stores its terminal outcome
in the document and a passive `stash.creation` entry with status and any artifact
id, path, title, or failure message. It also retains the combined input, generated
payload, and published metadata redaction report and safety notice. A completed
artifact includes that notice in its body, even if generation omits input markers.
This entry has no model message and starts no follow-up turn. Native generation retains its normal usage evidence.

The remaining command verbs operate directly on the external store: `get`
activates an artifact and queues the pickup message as the next user input,
`complete`, `release`, `reopen`, and `rotate` run the same lifecycle transitions
as the ordinary command, `capacity [reset]` reports the observation and
manages the episode counter, and `help` prints the Durable usage. A pickup
submission is keyed by the command invocation identity, so a retry of one
invocation reuses its submission while a distinct invocation is a distinct
request.

Durable differences from the ordinary entrypoint:

- There is no TUI browser and no `ctrl+alt+s` shortcut. Discovery is
  `stash_list` and the explicit `get` and lifecycle verbs.
- The source snapshot is committed Durable model context rather than Pi's
  persisted-session projection. Both paths publish through an independent
  native worker with the same silence and ownership contract.
- Capacity notices are delivered through the generation run's `onYield`
  continuation and re-armed by compaction or an explicit reset.

## Storage

Artifacts live at the effective `stash.dir`, default `<agentDir>/stash/`. Set
`dir` in the machine document or use `PI_STASH_DIR` to override it. Relative
values resolve against the host's agent directory. `PI_SESSION_ID` is host
context, not a machine setting; it supplies a fallback when the session manager
has no session id.

Flat files keep handovers independent of session lifetimes and project checkouts,
with plain-text content available for direct inspection.

Each artifact is `<utcTimestamp>-<slug>[-<collision>].md` with JSON-valued frontmatter and a Markdown body. The store provides these guarantees:

- Recognized credentials are replaced with `[REDACTED]` before distillation and at artifact publication, including payload strings and project, branch, and session metadata. Recognized shapes include prefixed provider tokens, JWTs, Bearer and Basic credentials, private key blocks, URL userinfo passwords, and labeled assignments. Wrapped token continuations must occupy token-only lines; a next line with ordinary words is preserved. Assignment separators use horizontal whitespace and never consume the next line. Existing artifacts receive no automatic scrub.
- Strong labels such as password, secret, and API key protect whole-line YAML/env assignments and quoted JSON members, including spaced passphrases. Inline bare values protect only the first token when it meets the existing minimum value length and contains a digit or is at least 20 characters long; trailing prose survives. Inline quoted single-token values retain the minimum length rule. Inline multi-word prose survives. Weak labels such as token and cookie retain the digit/length test, not the spaced-passphrase rule. A complete UUID-shaped value in an unquoted, bare inline weak-label colon reference remains intact; equals assignments, whole-line assignments, strong labels, and larger token values retain credential protection. This exception applies to all weak labels, not a particular reference protocol. A true UUID secret in the identical bare inline colon form is indistinguishable from a reference and also remains intact. HTTP URL values remain intact apart from userinfo passwords. A whole-line assignment and prose with the same form are inherently ambiguous; Stash protects that form. A token-only continuation line is also ambiguous and remains protected. This is not a general secret classifier, and values outside the patterns pass through unchanged.
- Writes, checkpoints, body edits, and completion outcomes return a redaction notice when content changes under this policy. The notice reports removed credential spans by count and class, plus bounded surrounding context from fully redacted text with terminal controls escaped. Existing markers do not count as new redactions, and nested matches count once. Collapsed mutation cards show the count and classes; expanded results include the context. Distillation retains input reports independently of the generated artifact, so an omitted marker does not erase the input notice. These safety notices are not progress status.

- Directory mode is enforced as `0700`. Ordinary discovery sweeps regular artifacts to `0600` once per process; reads enforce `0600` per open. Bounded search hardens only the artifacts it opens and leaves any pending whole-store sweep pending.
- Completed temporary files are hard-linked into place. Existing names are never replaced; concurrent same-second writes receive numeric suffixes.
- Lifecycle changes run through Pi's per-file mutation queue, reread the exact regular file with `O_NOFOLLOW | O_NONBLOCK`, preserve unknown frontmatter, write a private dot-hidden temporary file, recheck file identity, and atomically rename the completed revision into place.
- Artifact opens use `O_NONBLOCK` and reject non-regular descriptors before reads or permission changes. A pipe that replaces an artifact after directory discovery is refused without waiting for a peer, including during the initial permission sweep.
- Symlinks are ignored during discovery and reads. Mutation rechecks reject a selected target that is no longer the same regular file. Ordinary Node APIs cannot make the entire ancestor path descriptor-relative, so this is a private same-user local store rather than a claim of immunity to a hostile process replacing directory ancestors.
- New artifacts and reads are capped at 256 KiB. Oversized historical files are rejected without being loaded wholesale.
- Rotation validates the `.trash` subdirectory as a real directory before enforcing `0700`; a symlink is rejected without changing its target. The bounded header read captures the file identity. Rotation first pins that inode with an exclusive hard link at a private, randomly named temporary path inside `.trash`, then verifies its identity before publishing the final archive name. A source replacement at the first link is refused without occupying the archive name; cleanup removes only the temporary link this call created. An exclusive same-filesystem link from the verified temporary path publishes the archive without replacing an existing archive, including concurrent publication. Rotation rechecks the source and archive identities before removing the source. A source replacement after temporary verification leaves the verified archive and replacement source intact when the recheck detects it. A source-removal failure retains the archive and reports its path; no rollback unlinks the final archive name, even if another process replaced it. An interruption or failed temporary cleanup can leave a private dot-hidden temporary link; cleanup failure after publication does not reverse the publication result. Rotation reads only the bounded header through every tool, command, and browser path, so the 256 KiB read limit does not prevent archival. The header must close inside the 16 KiB scan window; an unreadable header refuses rotation with the state unverified.
- Malformed frontmatter falls back to filename metadata instead of hiding other artifacts.

Artifacts are retained until the operator explicitly removes their exact `.md`
files, or rotates them into `.trash`. There is no automatic pruning: continuity
data should not disappear because of an age default or an accidental keypress.
Rotation moves an artifact out of the discoverable store; it is operator-initiated, requires
confirmation in the browser, and is recoverable — archived files stay in place
at 0600 under the store's `.trash` directory until the operator moves them back
or removes them. Rotated artifacts are invisible to discovery, listing, pickup,
and lifecycle changes; nothing ever deletes continuity data automatically.

## Browser behavior

Press `ctrl+alt+s` to open the same browser as bare `/stash`, including while the
agent works. The shortcut leaves the editor draft in place and does not stop the
agent. Opening or closing the browser does not pick up, create, close, release,
reopen, or rotate an artifact. Those actions still require an explicit choice.
Repeated shortcut or bare command invocations do nothing while this browser or
one of its action dialogs is open. Closing the workflow or an error releases the
guard. The shortcut does nothing outside TUI mode; direct commands keep their
existing mode behavior.

The overlay loads the newest 200 artifacts and marks the count with `+` when older stashes exist. It is a framed, side-by-side browser: the left pane keeps the newest-first stash list visible while the right pane renders the selected handover as Markdown. The top border carries the supplied title and live position. Rows use `›` for selection plus a colored lifecycle glyph, date, and title: `○` open, `◐` active, `●` closed, and `◈` unknown (an unrecognized lifecycle value or an unreadable header). The preview includes state, creation and lifecycle timestamps, outcome, tags, session, project, branch, and artifact path above the body.

`/` enters filter mode. Typing filters across id, title, tags, project, branch, lifecycle state/timestamps/outcome, and preview text; Up/Down still selects matches, and Enter or Escape returns to browsing with the query intact. The browser preserves the query and selected stash across outcome or action-dialog round trips.

Up/Down selects artifacts, `b`/Space pages the preview, Enter picks up, `a` picks up with an operator note collected in the host (an empty note degrades to a plain pickup), `c` copies the resume command with an in-footer success or failure flash, and `o` closes an active effort after the operator supplies its required outcome. `h` opens a self-contained explanation of the browser, its lifecycle effects, and the safe-close contract; Up/Down and `b`/Space scroll it, and `h` or Escape returns. Tab remains the discovery and uncommon-action path. Its dialog offers pick up or rotate (open), close with outcome or release back to open (active), and reopen or rotate (closed); rotation asks for explicit confirmation and notes that the artifact remains recoverable.

The browser does not provide mechanical state cycling. Copy is the only safe lifecycle-independent mutation that can remain inside the overlay. Pickup must inject the handover (plain or with a note — the note needs the host's input dialog), completion must collect an outcome, and reopen or rotation requires deliberate confirmation; release is reachable only through the actions dialog, where it sits behind an explicit choice and retains the handover body, so those paths resolve to the host and reopen with refreshed store data.

The component derives its row budget from the host TUI and the overlay's height margin. Every framed line paints the full overlay width, the key footer sits above a closing border, and very narrow or short terminals fall back to a bounded list with an explicit close line. The fallback list scrolls with the selected row, including after a resize, whenever a row fits above the footer. Stored terminal and bidi controls are rendered as inert escape text.

## Files

- `index.ts`: tool registrations, `/stash` and shortcut host, capacity hook, silent independent creation admission, and the Durable contribution emission.
- `durable.ts`: the native Durable extension: contribution, tools, capacity hooks and episode document, distillation task and receipt document, and agent commands.
- `params.ts`: shared parameter schemas for both entrypoints.
- `guidance.ts`: shared tool descriptions and model guidance for both entrypoints.
- `capacity.ts`: bounded session-state restoration, context observations, configuration, and latched continuity requests.
- `store.ts`: private filesystem store, revision-checked body edits, shared mutation locks, lifecycle transitions, and the rotation archive.
- `search.ts`: bounded content discovery, stateless inventory-bound continuation, and transformed-field excerpts.
- `list-result.ts`: explicit native output schema and byte-bounded recent records derived from displayed rows.
- `read-result.ts`: bounded terminal-safe artifact text with its complete-file digest on both tool entrypoints.
- `format.ts`: record shape, lifecycle metadata, and Markdown/frontmatter codec.
- `panel.ts`: interactive browser state and rendering.
- `pickup.ts`: self-contained pickup message, operator amendment block, and already-active ownership handoff.
- `distill.ts`: projection serialization, bounded redacted snapshots, prompt building, and payload validation.
- `launch.ts`: structural independent-host contract, provider discovery, captured input validation, and launch requests.
- `redact.ts`: deterministic credential redaction for transcript, references, payloads, and lifecycle outcomes.
- `text.ts`: terminal-safe text and output bounds local to this extension.
- `test-fixtures.mts`: typed model and transcript fixtures, registration capture, and the partial host context for entrypoint tests.
- `durable-fixture.mts`: child-process crash fixture for the Durable replay tests.
- `*.test.mts`: unit, entrypoint, and Durable Harness drive tests.

## Verification

```bash
node --test extensions/stash/*.test.mts
npm test

npm run typecheck

printf '%s\n' '{"id":"commands","type":"get_commands"}' \
  | pi -e . --mode rpc --no-session --offline
```

Native faux-provider tests cover tool-free requests, captured publication
metadata, correction limits, skip and failure receipts, replay-safe admission,
and burst creation without cross-contaminated snapshots. The crash fixture
kills native creation after publication and reopens the SQLite storage; recovery
must preserve the exact artifact without a second generation or publication.
Existing native tool, lifecycle, and capacity tests cover the unchanged paths.

Ordinary entrypoint tests cover silent admission in each mode, provider-discovery
failures, snapshot immutability across an asynchronous boundary, independent
concurrent calls, and absence of caller model selection, timers, or shutdown
hooks. Native SessionManager tests exercise omissions and replacements, branch
navigation, summaries, redaction, bounded references, and unchanged raw history.
These controlled checks do not establish real provider quality, fresh host
default selection, or independent host survival after a real caller exits.
Those claims require the host's own checks and an integrated runtime drive.

`npm run typecheck` checks TypeScript against the installed Pi declarations;
it does not establish lifecycle execution. The runtime layer is declared by
the peer dependencies in
`package.json`; verify the installed package versions with `npm ls` before
repeating any version-specific claim.

## Deliberate omission

There is no automatic stash on shutdown or compaction. Capacity thresholds request
agent-authored checkpoints; the hook itself never writes a synthesis or chooses a
continuity path. Context omission and hard-stop control are not part of this slice.
