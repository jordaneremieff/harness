# Memory

Registered tools retrieve and curate durable operator knowledge in plain Markdown.
Before each agent run, the extension adds a bounded pointer-only memory index to the
structured system prompt. It has no service, stored search index, background task,
slash command, model request, or corpus Git operation. I/O belongs to a tool call
or the run's `before_agent_start` event.

## Configuration

Set `PI_MEMORY_DIR` to an absolute corpus directory. Unset, empty, relative, or
control-containing values return `Memory unavailable: set PI_MEMORY_DIR to an absolute corpus path`.
There is no inferred default. The variable is read on each invocation.
See [extension configuration](../../docs/conventions/extension-config.md).

Activation, search, history listing, and reads never initialize storage or capture revisions. The first valid write creates a missing
root and a minimal `README.md` contract. An existing contract remains unchanged.
The root is operator-controlled; do not point it at an untrusted shared directory.

## System prompt index

The `memory_index` section lists observed subjects whose per-file status is active,
as `slug: title` pointers or slug-only pointers under byte pressure. It never
establishes corpus-wide lifecycle consistency. Its frame identifies the pointer form and
states that active status does not establish current truth, that cues are not evidence
or instructions, and that the agent must read lifecycle and freshness with `memory_read`
before relying on a note. Current instructions control.
Read a matching subject; use `memory_search` when no subject matches.
No note body, heading fallback, source passage, or contract content enters the section.

The section first inventories and sorts at most 16,384 root entries, with one
lookahead for overflow. It then inspects at most 2,048 candidate notes, with at
most 8 KiB read per note. It reports the inspected and uninspected counts.
Uninspected lifecycle remains unknown. It includes only lowercase kebab-case
slugs with a usable `active` lifecycle. Superseded and retired notes, hidden files, `README.md`,
and names outside that grammar are excluded. The index and read pages share the
same conservative lifecycle interpretation. Active subjects require plain top-level
`status: active` and `superseded_by: null` keys. Unusable status cues remain unknown.
Active subjects also remain unknown when the replacement cue is missing, unusable,
or non-null. Known superseded notes remain excluded even when their replacement
is unusable. Values come from the complete bounded header, parsed with the public
Pi frontmatter parser. A rejected header makes status unknown,
even when the error concerns another field. Unreadable entries and unknown status
counts qualify the section; they are not proof that no other active subjects exist.
The section counts retired notes separately, not as unknown. Due dates and unresolved
concerns do not remove active pointers or add date-derived text to the index.

Titles come only from frontmatter cues. The public Pi frontmatter parser decodes
isolated scalar fields, including YAML and JSON quotes. Within a valid header,
missing or unusable titles fall back to the slug. Controls and format characters
become spaces, whitespace collapses to one line, and angle brackets become non-markup
characters. Titles remain untrusted even after display sanitization.

The complete section, including Pi's wrapper, fits **12 KiB of UTF-8**. Pointers
sort by slug. Titles first retain at most 160 Unicode code points; if the whole list
does not fit, all titles shorten to at most 64 code points. If that complete list
still does not fit, the section uses slugs only. If the complete slug list exceeds
the cap, the section retains the longest alphabetical slug prefix and reports the
exact number of observed active notes omitted by the byte limit. The omission
clause appears only when notes are omitted. It always points to `memory_search`.
This preserves subject coverage before retaining title detail. Byte accounting
includes every slug, optional title, separator, newline, frame, coverage notice,
footer, and wrapper. Token cost varies by language and model. Every session and
worker pays for its section in model context, even when the text is unchanged.

A complete sorted filename inventory makes the metadata subset deterministic,
even when the metadata budget excludes later notes. Useful cues survive that
boundary; omission counts describe only observed active cues, not all active notes.
If the filename inventory itself exceeds its hard capacity, the section reports
that exact boundary without pointers or an invented subject count. Search reports
the same inventory refusal. Direct source reads remain available by known slug.

The hook rebuilds from disk at each `before_agent_start`, not each model request
within that run. It has no cache, timestamp, persistent state, or write side effect.
Identical cues produce identical section bytes; body-only or date-only changes
produce no index delta. A change to visible cues or membership updates the next
run's section. Title changes that leave the same compact pointer list and form
produce no index delta.
If configuration, the root, the contract, or the scan is unavailable, the hook adds
no section and never blocks the run. A later unavailable run removes a prior section.

Pi clones base prompt options for each `before_agent_start`, compares the
resulting sections with the transcript, and records changed text or a `null` removal.
An unchanged section adds no transcript delta. The extension edits only
`event.systemPromptOptions.sections.memory_index`; it does not replace the whole
prompt. A different extension that forces an opaque system prompt owns that separate
projection. Controlled native-session tests verify ordinary provider delivery of
title and compact pointers, metadata-budget qualifications, unchanged suppression,
changed cues, removal, and restoration. These tests establish delivery and coverage, not model comprehension
or improved answer quality.

## Tools

### `memory_search`

Omit `query` to browse compact alphabetical cues. Set `query` to a string or an
array of up to three alternative formulations. Prefer two or three short formulations
using the operator's likely vocabulary and synonyms, not pasted full questions.
Blank strings are refused; only an omitted query selects browse.
If a query exceeds its limits, shorten it to keywords. Query pages default to 10
records and accept `limit` from 1 through 25. Browse returns all cues that fit the
48 KiB output bound; its optional `limit` from 1 through 512 reduces the page.
Retired notes are excluded unless `includeRetired: true` is explicit. Active,
superseded, and unknown notes remain eligible, including due or unclassified notes.
No recency boost applies. Pass the returned `nextCursor` as `cursor`, with the same
query and `includeRetired` filter. One cursor drains
result pages in a source window, then advances to the next window. **Continue after
empty pages too.** There is no separate numeric result-page workflow. A cursor
binds the original normalized query, retired-note filter, corpus path, complete filename
inventory, and source evidence while paging within one window. A changed query, filter, inventory, or
same-window source refuses instead of silently skipping or duplicating results.
Changing only `limit` is permitted. Earlier windows are not reread, so a completed
cursor chain establishes traversal coverage, not a frozen whole-corpus snapshot.

Unquoted words match exact lowercase Unicode tokens. Common function words are
ignored. Hyphen, underscore, dot and slash compounds match adjacent tokens.
Double-quoted phrases require case-insensitive literal matches with flexible
whitespace. No stemming, camelCase splitting, fuzzy matching, automatic synonyms,
regex, or Unicode normalization applies. A formulation supports 200 characters and
16 distinct terms. After a miss, try alternate inflections (`setting` versus
`settings`), exact identifier forms (`accessToken`), or quoted fragments (`"Token"`).
A zero-match query returns this guidance alongside its coverage boundaries.

Each formulation uses lexical rarity, frequency saturation, field weights and
length normalization. Unfenced Markdown headings receive title weight; fenced
comments and examples remain body evidence. Alternative formulations order notes by
their best per-formulation rank first. Ties use reciprocal rank fusion,
`sum(1 / (60 + rank))`, then slug order. Within each source window, this keeps each alternative's first match
among the first three results even when another formulation matches many weakly
related notes. The score stays internal. Ordinal rank describes retrieval order,
never truth, confidence, freshness, or a comparable value across calls.
Per-formulation matched and missing terms explain the evidence. The calling agent
supplies reformulations; the extension makes no model calls.

When title metadata is absent, browse cues use the first level 1–6 ATX heading
outside backtick or tilde fences, then the filename if no heading exists.
Cues preserve raw metadata values. Missing or malformed fields remain unknown;
`cueProblem` marks clipped, multiline, duplicate, empty, unclosed, invalid, or
ambiguous frontmatter. The complete bounded header must parse at its physical
closing delimiter. Otherwise raw cues remain visible with a qualification, metadata
receives no title weight, and the prompt index counts status as unknown. Unicode
line and paragraph separators do not create Markdown delimiter lines.
Each note includes parsed `lifecycle` and `freshness` evidence from the same source.
Prefer applicable active sources and inspect supersession pointers before applying
a claim. Active status does not establish truth. Digests identify exact source bytes.
Each matched note has at most one source passage. A body match takes priority over
a frontmatter-only match for both string and array queries. For fused results, the
best-ranked matching formulation selects the passage within that category.
Per-formulation records retain rank and matched/missing terms without repeating
passages. Selected excerpts retain half-open Unicode code-point offsets in original source.
They are discovery evidence, not complete support. Slug-only hits have no source
passage. A later qualification can lie outside the selected excerpt.

Each call inventories all root names before source work, sorts them, and refuses
above 16,384 entries plus one overflow lookahead. Hidden entries count toward that
capacity but do not become note candidates. Each source window examines at most
4,096 candidate notes and reads at most 32 MiB. Before a read, the scanner reserves
room for its maximum supported size, so the byte limit can stop a window early.
Browse reads at most 8 KiB per candidate. Query reads support complete sources up
to 64 KiB, with a one-byte oversize check included in the window byte budget.

`scan` reports complete filename inventory, candidate count, window boundaries,
bytes read, unavailable notes, and bounded issues. `retiredNotes` and `excludedRetired`
count retired notes observed and omitted in that source window. The result also returns
`includeRetired` and `excludedRetired`; omitted retired notes do not become unknown gaps. `scan.complete` means that this
one window covers all candidates; it does not imply source availability.
`search.complete` also requires every candidate to be available. `totalNotes`,
`totalMatches`, ranks, term frequencies, and result offsets are **window-local**.
`coverage` separately reports how far the cursor chain traversed, explicitly without
a frozen snapshot guarantee. Inspect every window's gaps before a negative claim.
Unreadable, unsupported, or oversized notes remain unknown. Each serialized result
fits 48 KiB; record selection uses cumulative byte accounting, not repeated
serialization of progressively shorter full pages.

`memory_search` declares an explicit output schema and returns that same public
page as `structuredContent`. Native codemode scripts receive an object, not a JSON
string. Model-facing text and native-card `details` retain the existing page.
No scanner buffers, ranking scores, store handles, or additional source fields
enter the structured result. Its serialized page keeps the same 48 KiB bound.
Browse notes omit `digest` and `rank`; query hits include them. Raw cues remain
strings, separate from parsed `lifecycle` and `freshness`. Unavailable sources,
unknown metadata, and nullable `corpusEmpty` retain their existing meaning.
Invalid requests, changed cursors, unavailable corpora, and cancellation still
fail the call; codemode receives a rejected promise, not an empty success page.

For example, a bounded script collects candidates without parsing nested text:

```javascript
const query = ["editor choice", "editing preference"];
const candidates = [];
const coverage = [];
let cursor;
for (let pageNumber = 0; pageNumber < 8; pageNumber++) {
  const page = await tools.memory_search({ query, limit: 5, ...(cursor ? { cursor } : {}) });
  candidates.push(...page.notes
    .filter(note => note.lifecycle.status === "active")
    .map(note => ({ slug: note.slug, digest: note.digest, freshness: note.freshness })));
  coverage.push({ scan: page.scan, coverage: page.coverage });
  cursor = page.nextCursor;
  if (cursor === null) break;
}
return { candidates, coverage, nextCursor: cursor };
```

The script preserves a remaining cursor if its own page limit stops traversal.
Window counts and ranks are not corpus-wide totals. Keep every page's coverage
gaps; selected candidates still require source reads and freshness checks.

### `memory_read`

Pass a `slug`, or `README` for the corpus contract. Pass the search result's `digest`
on the first read. A page returns at most 12,000 Unicode code points within the
48 KiB serialized result bound. Escaping overhead can shorten the page;
pass its returned `nextOffset` and unchanged lowercase SHA-256 `digest` to continue.
Nonzero offsets require the digest. A changed source refuses instead of mixing
revisions. Search again for the current digest and restart from offset 0. For a
changed `README`, restart its read at offset 0 without the old digest to obtain the
current contract and digest. A missing note points back to search for its current
slug. Read scope, qualifications, source dates and lifecycle before relying on a
note. Sources above 64 KiB require bounded ordinary file reads; the tool refuses
them explicitly.

Every note page includes a `lifecycle` record from the same complete bounded header
interpretation used by retrieval. `status` is `active`, `superseded`, `retired`, or `unknown`;
`supersededBy` is a validated replacement subject slug or null. Unknown or unusable
metadata carries a `problem`. A valid plain status key and null replacement are
required for `active`. A known `superseded` status remains visible even when its
replacement is missing or invalid; that replacement stays null with a problem.
Malformed or ambiguous headers remain unknown. The record does not validate note
claims or repair metadata. Retired notes remain directly readable and require a null
replacement. Retirement never implies a successor. `README` pages have `lifecycle: null`
and `freshness: null` because the contract has no note lifecycle. Original source
content remains unchanged on every page.

Every note page also returns `freshness`: the UTC `evaluatedOn` date, declared
`verified` and `verifiedDate`, `policy`, `reviewAfter`, `deadline`, `concern`,
`lastReview`, `retirement`, and `problems`. Unknown verification fields are null.
Deadline states are `due`, `not-due`, `unscheduled`, and `unknown`; no state labels
a note simply fresh. Malformed fields remain readable with a problem instead of
normalization. Historical pages interpret those old declarations, not the current note.

- `on-change` applies to standing preferences, decisions, and explicitly version-scoped
  facts. Contrary evidence or changed scope requires review.
- `before-use` requires a current defining-source check when a decision depends on current
  environment or external behavior. Today's verification date does not bypass it.
  That check does not require a memory write. Persist a review only when durable renewal,
  concern resolution, or a policy adjustment has value.
- An absent policy is `unclassified`; an invalid policy is `unknown`. Neither means false.
- A subject-specific `review_after` requires a concrete reason. No universal interval or
  automatic renewal applies. A due date retains the note and does not revoke a decision.
- An unresolved concern qualifies only the disputed claim. Undisputed operator authority
  and fresh independent evidence still apply within their scope.
- Read times, search rank, capture times, and writer-touch dates do not renew verification.

### `memory_history`

Pass one lowercase subject `slug`. The tool lists prior writer captures, newest
capture time first, with revision ID, UTC capture time, SHA-256 source digest, and
byte size. `limit` examines 1–100 revision entries per page, default 25. Repeat the
slug with `nextCursor` until null, including empty pages with unavailable entries.
The subject inventory has the same 16,384-entry hard capacity and overflow lookahead.
New or removed entries invalidate the cursor. Listing reads names and file metadata,
not historical bodies; digest validation occurs during `memory_read`.

Pass an exact `revision` from this list to `memory_read`. The read returns those
prior bytes, never the current note as a substitute. The revision ID remains visible
in model output and native cards. Later Unicode pages repeat the revision and its
digest. A digest mismatch refuses a corrupt or changed capture. Historical lifecycle
and verification fields describe that old source only, not the current subject.

For a correction:

1. Read the chosen revision and all relevant qualifications.
2. Read the current subject, its current digest, and replacement links.
3. Use `memory_edit` for a targeted correction, or `memory_write` for an intentional
   complete rewrite, with the **current** digest and explicit whole-result `verified`.
4. Reassess all resulting content. Old verification never renews automatically;
   `verified: false` clears its date. A superseded current subject still refuses.

There is no raw restore, merge engine, automatic lifecycle reversal, or graph rollback.

An optional `plan: { capturedBefore, keepNewest }` adds a read-only maintenance plan.
Both fields are required: the cutoff is an exact UTC timestamp with milliseconds,
and the retention floor is an integer from 0 through the inventory capacity. There
is no retention default. Repeat the complete plan with `nextCursor`; changed plans
or inventories refuse continuation.

Each available revision receives `selection: keep | candidate` and a reason:
`newest-retention-floor`, `at-or-after-cutoff`, or `before-cutoff-outside-floor`.
Selection uses capture time and deterministic revision-ID order, not inferred causality.
The `keepNewest` floor counts revision names, including unavailable entries. It does
not promise a recoverable floor. The result's `meaning` states these limits.
The `plan` result names its `metadata-page` scope and reports `availableBytes`,
`keepBytes`, `candidateBytes`, `kept`, `candidates`, and `unavailable`. These totals
cover only available records on that page; gaps remain unknown. `digestsVerified: false`
and `coverage.bodiesRead: false` make the source boundary explicit. The plan opens no
historical bodies, writes no plan state, and grants no deletion authority.

A plan does not bound retained disk use, reclaim bytes, or create a quota. After a
separate explicit instruction selects a backup destination and exact removal scope:

1. Stop other corpus writers and recheck the complete selected inventory.
2. Verify every selected source against its revision digest.
3. Archive the complete selected files with a manifest of subject, revision, digest,
   and byte length.
4. Read the archive independently and verify every selected byte digest.
5. Remove only approved captures. Preserve live notes and all unselected files.
6. Report successful and remaining removals separately. Preserve the verified archive
   after partial failure.

Use ordinary file tools for that authorized procedure. There is no archive format,
cleanup service, deletion tool, or automatic pruning. Full indefinite recovery and a
fixed total-byte ceiling are incompatible for arbitrary new data. An explicit forget
request separately accounts for live notes, retained captures, and external archives.

### `memory_write`

Required fields are `slug`, `title`, `tags`, `summary`, `details`, `sources`, and
`verified`. Separate sections prevent malformed model-authored frontmatter. The
writer generates the title heading, section headings, dates and lifecycle fields.
A lowercase kebab-case subject slug is stable across updates; `readme` is reserved.
Tags are bounded descriptive subject cues, not query filters. All content sections
must be nonblank. Titles and tags must be single-line, including no Unicode line
or paragraph separators. Sources contain the evidence and dates needed to assess
the claim.

Omit `expectedDigest` to create; an existing slug refuses. Supply the current source
digest to update; a missing or changed source refuses. Updates preserve `created`
and existing `supersedes` links. Retired and superseded notes refuse ordinary updates.
Read a superseded note's replacement; use explicit confirmed reactivation for a retired note.
Updates replace the complete note body, so use `memory_edit` for targeted changes.
Reserve `memory_write` updates for genuine whole-note rewrites and preserve useful
rationale and qualifications in the supplied fields. Stored `verified: true` means the caller attests to a current
operator statement or authoritative source; the extension does not verify facts.
`verified_date` becomes today's UTC date when true and null when false. Do not carry
true forward from prior metadata without a whole-result check now. A wording-only
change without a new authoritative check uses false.

Optional `reviewPolicy` selects `on-change` or `before-use`; `reviewAfter` selects a
subject-specific UTC date or null. Explain any deadline in the source evidence.
A whole-note rewrite reselects both fields: omission removes the old policy/deadline.
It omits the old digest-bound `last_review`, which remains in prior history. A rewrite
with false preserves an unresolved concern; true clears it. Neither content edits
nor confirmation automatically move a deadline.

`supersedes` adds up to 16 `{slug, digest}` targets. The writer validates all target
sources before publication, then writes the destination and marks replaced notes
`status: superseded` with `superseded_by` in the same call. Existing target bodies
remain byte-for-byte unchanged, including introductory prose, fenced headings and
tails. A retired target accepts explicit supersession at its current supplied digest,
without confirmation or reactivation. The writer preserves its historical verification,
removes its current retirement metadata after prior capture, and marks it superseded.
Retry accepts an already-superseded target only when it names this same destination.
If B supersedes A and B is later retired, A remains superseded and points to B. No
predecessor revival or supersession reversal occurs. A bounded transitive check refuses supersession cycles, including cycles through
partial publications. It accepts at most 512 linked notes totaling 8 MiB. The byte
check follows each bounded source read, so refusal can inspect one additional
source of at most 64 KiB. Unavailable ancestors or exhausted bounds refuse the write
before publication.

Preserved lifecycle metadata must be valid and unambiguous: `created` and `updated`
are calendar dates; `supersedes` is a list of at most 16 unique subject slugs without
self-links. `active` and `retired` require `superseded_by: null`; `superseded` requires a different
subject slug. Scalar `supersedes`, duplicate links, and contradictory states refuse
rather than normalize. Mutation requires exact `---` delimiter lines. Tolerant
retrieval also accepts whitespace-padded delimiter lines, but does not repair them.
Ambiguous delimiter prefixes refuse mutation. A complete rewrite intentionally
replaces old title, tags, body, and verification fields; it does not require those
old authoring fields to match the newly supplied ones. No silent schema migration
occurs.

Search before every mutation. Update the existing subject instead of creating a near
duplicate. The writer refuses identical slugs, not semantic duplicates. Search is
the overlap preview; no second implicit search inflates write results.

Successful calls report `Memory updated: <file>` for each changed note. Errors name
`written` and `notWritten` files, whether initialization occurred, and the destination
digest when published. `notWritten` lists the unpublished files once the complete
publication plan is known; a planning refusal can leave that list empty with
`written: []` and an explicit error. These fields describe file publication, not a
corpus transaction. Separate `captured` records identify successfully published prior
copies, with revision, timestamp, digest, and size. `historyOmitted` names a source
and `credential-policy` reason without its content. Neither list counts as a live
note publication or proves that the requested mutation succeeded.

### `memory_edit`

Required fields are `slug`, `expectedDigest`, `verified`, and `edits`. Each edit has
`oldText` and `newText`. Supply between 1 and 32 edits; each text is at most 24,000
UTF-16 code units. `oldText` must be nonempty; empty `newText` deletes the match.
Every `oldText` must match exactly once in the original body after frontmatter.
All matches use that original body, not earlier replacements in the same call.
Missing, ambiguous, overlapping, nested, and collectively unchanged edits refuse.
Adjacent disjoint matches are valid. No fuzzy matching, whitespace normalization,
or line-ending conversion occurs. Include the source's exact line endings.

**An existing matching `# Title` heading is required.** The first level-one ATX title
heading outside backtick or tilde fences must match the frontmatter `title` and
remain unchanged. A missing or divergent heading refuses with an actionable error;
the editor never invents a title or treats frontmatter as its body replacement.
Use `memory_write` only when a complete rewrite is intentional. Fenced examples do
not count as title headings.
Edits that hide that heading or introduce an earlier title also refuse. Changes to
introductory prose preserve the original heading's identity despite offset shifts.
Title, tags, and other frontmatter are not editable through this tool. The writer updates
`updated`, `verified`, and `verified_date` frontmatter lines. Verified edits also remove
`review_flag`; unverified edits preserve it. Policy, deadline, and digest-bound prior
review evidence remain unchanged. All other bytes survive, including comments, unknown
metadata, introductory prose, extra sections, and unchanged body text. `updated`, `verified`, and `verified_date` must already
exist as independent plain top-level keys. Missing generated keys and YAML aliases
that would alter other metadata refuse. Supersession applies the same preservation
check to its generated lifecycle fields.

`verified` describes the whole resulting note, not just the replacement. True sets
`verified_date` to today's UTC date; false clears it to null. A current digest is
mandatory. Missing, changed, inactive, malformed, or unsafe sources refuse. The
complete result must fit the 64 KiB source limit. Mutation tools refuse C0
controls other than tab, LF, and CR, plus DEL and unpaired surrogates. C1 controls
and Unicode format characters are accepted, including emoji joiners and soft
hyphens. Recognizable credentials refuse without echoing note text. A leading
source BOM is preserved. Both replacement text and the complete result pass the
credential guard. An unavailable corpus root returns an explicit memory error
without exposing its path or creating files.

Edits use the same queue, writer lock, prior capture, staging, sync, digest recheck,
atomic rename, cleanup, and receipt as writes. They do not initialize or replace `README.md`;
`initialized` remains false. Success reports `Memory updated: <file>`. Publication
and cleanup failures use the same `written` and `notWritten` receipt fields; input
or lock refusals occur before publication and report a content-free error.

### `memory_review`

Required fields are `slug`, `expectedDigest`, `outcome`, and nonblank `sources`.
This metadata-only operation preserves body bytes and uses the same queue, lock,
prior capture, digest recheck, cancellation, atomic publication, and receipt as other
mutations. Every successful review advances `updated` to today's UTC date. That is
writer-touch metadata, not evidence of a content change or claim freshness.

- `confirmed` attests to the whole current note against named sources inspected now.
  It sets `verified: true`, sets today's `verified_date`, records `last_review` with
  the exact pre-change source digest, and removes `review_flag`. A supplied `reason` refuses;
  omit it for confirmation.
- `unresolved` requires a nonblank `reason` and sources. It records `review_flag` and
  preserves old verification fields as historical attestations. An unavailable source
  is not confirmation. Report the exact source gap; persist only a durable concern.
- Omitted `reviewPolicy` or `reviewAfter` preserves the field. Explicit null removes it.
  A review never automatically advances a deadline.
- A retired note requires `outcome: confirmed` plus `reactivate: true`. New evidence and
  task authority justify that action; the argument itself proves no operator approval.
  Reactivation removes retirement and restores active status. Active notes reject
  `reactivate: true`. Superseded notes reject review and reactivation; follow the replacement.

### `memory_retire`

Required fields are `slug`, `expectedDigest`, `reason`, and `sources`. Retirement
withdraws an active note after settled loss of applicability without requiring a
successor. Age or an unresolved contradiction alone does not justify retirement.

The operation preserves body bytes, historical verification, and outgoing supersession
links. It sets `status: retired`, retains `superseded_by: null`, records the withdrawal
in `retirement`, and updates the writer-touch date. Retirement date is the withdrawal
date, not an inferred date when a fact became false. Direct reads and exact history
remain available; ordinary search and next-run prompt pointers omit the note.

Retirement shares the writer queue, lock, prior capture, digest recheck, cancellation,
atomic publication, and receipt. It does not delete a note or reactivate predecessors.
Ordinary write/edit calls never reactivate inactive notes.

## Technical examples and credential refusals

Ordinary configuration examples are valid note content: `api_key=api_key`,
`password=process.env.PASSWORD`, JSON parameter names, descriptive placeholders,
and prose such as `secret: configuration value`. Their punctuation, quoting, or
placement in a code fence does not turn them into credentials.

The guard refuses private-key markers and the selected recognizable token-prefix
formats implemented in `checkCredentials`. It does not classify generic assignments,
measure entropy, or exempt code fences. Never supply real secrets: an unrecognized
password or token remains forbidden knowledge even if the narrow guard accepts it.

Validation checks authored fields, subject and supersession slugs, replacement
text, and every complete note planned for publication. This includes inherited
links and retained supersession bodies. An error names only the input location or
resulting-note category and pattern family, never the matched text. Replace a
credential value with a descriptive placeholder. `oldText` is not independently
rejected, so a targeted edit can remove an existing credential; the complete
result must pass. Insertion or deletion that assembles a recognizable token refuses.
The same narrow guard applies to prior bytes. If an authorized correction removes
forbidden prior material, the mutation skips that capture, reports a content-free
`historyOmitted` entry, and preserves the correction. This policy omission differs
from an ordinary archive I/O failure, which stops live publication.

## Prospective prior copies

Every later authorized writer overwrite automatically captures safe prior bytes.
There is no opt-in switch. Creation has no prior source. Reads and activation write
zero corpus bytes; there is no backfill, import, migration, Git initialization, or
capture of ordinary external edits. Current root Markdown files remain authoritative.

Captures live at `.memory-history/<slug>/<revision>.md`. A revision contains a UTC
wall-clock timestamp with milliseconds, a unique random suffix, and the prior source
digest. Exact Markdown bytes, including BOM and line endings, are preserved in a
separate inode. The live note inode is never hard-linked into history. Capture time
is independent of frontmatter dates and filesystem mtime; clock skew or rollback
means list order does not prove causality or successful mutation order. Same-time
captures remain distinct.

All planned note results validate and stage first. Every required safe prior copy
then stages, syncs, and publishes exclusively inside the current writer lock, before
**any** live publication. Archive directory entries are synced too. A history write,
flush, close, or publication failure stops all live publication. Previously published
captures remain valid after cancellation, later failure, or an unsuccessful mutation.
They are source captures, not a complete operation log. Failed attempts consume history
space too. The normal receipt keeps captures separate from live `written`/`notWritten`.

No automatic pruning runs. Retained byte growth equals the saved prior bytes plus
filesystem overhead, including captures from failed attempts. This is not a disk-loss
backup, remote synchronization, secure purge, automatic deletion recovery, or a promise
of power-loss durability. A deleted current source has no guaranteed final capture.

## Concurrency and failure

Storage requires hard-link support and atomic same-directory rename on the corpus
filesystem. Unsupported filesystems fail explicitly; no fallback weakens the lock.
Pi's file mutation queue serializes same-process calls for the corpus lock path.
A cross-process exclusive hard link publishes complete lock metadata only after its
private candidate file is written and synced. No partially written lock is published.
Contention refuses immediately rather than waiting or stealing an owner's lock.

A crash can leave `.memory-write.lock` and private `.memory-*.tmp` files. Read the lock,
confirm its owner and all writers are absent, then remove the stale lock and temporary
files manually. A PID alone does not prove stale ownership. Malformed or empty locks
also refuse with this recovery instruction; no hidden unrecoverable state exists.
Search ignores these hidden artifacts. The extension never reclaims locks by age.

Each file is staged and synced before atomic publication. Creation uses an exclusive
hard link; updates use rename after a digest recheck. All live files are prepared and
all safe required prior copies are published before live publication starts. A failed later replacement does not undo earlier publications.
Read every reported file before repair; retry an update with the current destination
digest and remaining targets' current digests. Existing supersession links survive
that retry. Do not blindly repeat a create after partial success.

Cancellation is checked before work and between bounded operations. A started
synchronous filesystem operation finishes; cancellation does not undo a publication.
The writer attempts temporary-file and lock cleanup on success and failure. Cleanup
failure is explicit, including when all note publications succeeded. Staging errors
preserve the initial filesystem error code, report close and cleanup failures
separately, and name any retained private temporary file without exposing corpus
paths or note content. Process loss cannot return a receipt: inspect source files
and links before recovery. File sync and rename do not establish whole-corpus
atomicity or power-loss durability.

Writers that use this extension share the lock. Ordinary editors do not. Digest
rechecks detect edits before publication, but no filesystem compare-and-swap prevents
an uncooperative editor from racing the final check and rename. Stop other corpus
writers for manual repairs. Leaf symlinks, special files, and multiply linked note
inodes are refused for mutation. Search and read refuse leaf symlinks and special
files, but permit regular hard-linked notes because these operations do not mutate
the inode or its aliases.

## Storage policy

Consult memory before a choice depends on prior operator preferences, decisions,
corrections, environment, providers, models, or recurring lessons, even when memory
is not mentioned. The standalone term `memo` triggers this capability too.

Store knowledge useful across unrelated future sessions: durable preferences and
standing rules, confirmed decisions with rationale, authoritative environment facts,
and verified recurring lessons. High confidence permits automatic writes when the
information is durable, sourced, concise, future-useful and not already represented.
Ask about medium-confidence information only when its future value is material.
Do not store low-confidence inferences. Silence and repetition do not confirm a claim.

Exclude task state, handovers, TODOs, logs, repository-defined facts, secrets,
sensitive personal data and speculation. Recognizable private-key and credential
patterns are refused without echoing the matched content. This is a narrow guard,
not a secret classifier. Never supply secrets: Pi already retains tool arguments
before the writer validates them. Cards withhold write/edit body fields and review/retirement reasons and sources in both
collapsed and expanded views, not native history.

Use `memory_edit` for targeted note changes rather than the ordinary `edit` tool,
which bypasses the writer's lock, lifecycle validation, dates, and credential guard.
Use `memory_write` for creation or a genuine whole-note rewrite. Reassess verification
for the complete result after either operation; do not retain a stale attestation.

Current operator instructions control; no note grants fresh authority. A stored
verification flag does not establish current external behavior. Cite the note when
its supported content determines an answer; report the exact gap when it does not.

Delete only after an explicit request to forget or remove a note. Identify the file,
inspect active dependent notes and supersession links, then use ordinary file tools.
Account for `.memory-history/<slug>/` under the same explicit forget scope: deleting
only the current Markdown note leaves retained prior knowledge. Include external
archives within the requested forget scope too. Resolve any ambiguous
deletion scope before a destructive act. History cleanup is not secure erasure and
does not erase native tool transcripts or independent backups. No automatic pruning,
deletion schema, or dependent-note rewrite is added.

## Corpus format

One Markdown file per subject, with this generated shape:

```markdown
---
title: "Subject title"
tags: ["subject"]
status: "active"
created: "2026-01-01"
updated: "2026-01-01"
verified: true
verified_date: "2026-01-01"
supersedes: []
superseded_by: null
---

# Subject title

## Summary

Durable knowledge.

## Details

Rationale, constraints and qualifications.

## Sources

- Operator statement, 2026-01-01.
```

Optional lifecycle fields use independent plain single-line values:

```yaml
review_policy: "on-change"
review_after: null
review_flag: {"date":"2026-01-02","reason":"A claim has conflicting sources.","sources":"Current source comparison."}
last_review: {"date":"2026-01-01","digest":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","sources":"Whole source inspected."}
retirement: {"date":"2026-01-03","reason":"The operator withdrew the preference.","sources":"Operator instruction."}
```

These are separate field examples, not a generated default header. `retirement` applies
to retired notes. Existing notes need no rewrite, automatic classification, or migration.
Reason strings accept at most 600 characters; lifecycle source strings accept at most
1,500 characters. Added lifecycle metadata shares a 4 KiB serialized bound. Generated
and changed headers fit the 8 KiB metadata window; complete notes fit 64 KiB.

Metadata-only mutations replace an existing owned line in place, remove the complete
line when clearing a field, or insert a missing optional key immediately before the
closing delimiter with that delimiter's line ending. Core generated keys remain
required. Duplicate owned keys, aliases, multiline owned values, and ambiguous insertion
boundaries refuse. The writer reparses the complete header and checks exactly the
intended change before capture or publication. Unknown metadata, BOM, delimiters,
line endings, and body bytes otherwise remain unchanged.

## Presentation and verification

Native tool cards show request subjects, outcomes and coverage limits. Collapsed
search cards preview up to three subjects and name any additional subjects on the
returned page. Expanded search cards label raw cues, cue problems, digests,
per-formulation matches and missing terms, source excerpt ranges, scan issues and
continuation instructions. Zero-match guidance appears without expansion. Raw cues
remain untrusted source evidence, not attestations.

Expanded read cards show the actual source text, digest and half-open code-point
range instead of a serialized JSON string. Lifecycle status, replacement subjects,
review policy, deadline state, concerns, and problem counts remain visible in both
views. Expanded evidence includes verification declarations, review dates, exact
review digests, concern sources, and retirement metadata without treating them as truth. Historical reads label prior lifecycle,
revision identity, capture time, and the separate current-authority boundary.
History cards show capture identities, metadata coverage, read-only plan selections,
reasons, and page-local byte totals. Mutation cards distinguish
live changes, captures, and credential-policy omissions. Terminal controls are escaped, and the
expanded evidence body is limited to 32,000 UTF-16 units after escaping, including
its explicit clipping notice. Write/edit payloads and review/retirement reasons and
sources stay withheld in both call views. Presentation never changes model-visible evidence or retained native history.
Semantic tool behavior is identical in TUI and headless modes.

Run focused tests with `node --test extensions/memory/*.test.mts`. Run the native
loader with `node scripts/extension-load-check.mts extensions/memory/index.ts`.
The native lifecycle regression loads the extension in an isolated ordinary Pi
session and drives its registered tools with a controlled provider. It checks
technical-note creation, empty-window cursor continuation, Unicode current and
historical paging, edit, current-digest correction, digest refusal, credential refusal,
unresolved review, whole-note confirmation, retirement, explicit reactivation,
retired-target supersession, history plans, and the next prompt's qualified pointers. This establishes the
host/tool contract, not live-model judgment or general retrieval quality.
The same native regression uses Pi's public codemode factory to verify object
results, declared fields, candidate filtering, digest and freshness access, thrown
refusals, and continuation through an empty source window. Retrieval regressions
validate cue, lexical, fused, partial, malformed-metadata, and byte-limited pages
against the declared output schema. Adapter tests check that text, details, and
structured data contain the same public page.
Repository gates cover type compatibility, lint, slice boundaries and the complete suite.
