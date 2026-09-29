# Memory

Registered tools retrieve and curate durable operator knowledge in plain Markdown.
The extension has no service, stored search index, background injection, slash command,
model request, or corpus Git operation. All I/O belongs to an explicit tool call.

## Configuration

Set `PI_MEMORY_DIR` to an absolute corpus directory. Unset, empty, relative, or
control-containing values return `Memory unavailable: set PI_MEMORY_DIR to an absolute corpus path`.
There is no inferred default. The variable is read on each invocation.
See [extension configuration](../../docs/conventions/extension-config.md).

Search and read never initialize storage. The first valid write creates a missing
root and a minimal `README.md` contract. An existing contract remains unchanged.
The root is operator-controlled; do not point it at an untrusted shared directory.

## Tools

### `memory_search`

Omit `query` to browse compact alphabetical cues. Set `query` to a string or an
array of up to three alternative formulations. Prefer two or three short formulations
using the operator's likely vocabulary and synonyms, not pasted full questions.
Blank strings are refused; only an omitted query selects browse.
If a query exceeds its limits, shorten it to keywords. Query pages default to 10
records and accept `limit` from 1 through 25. Browse returns all cues that fit the
48 KiB output bound; its optional `limit` from 1 through 512 reduces the page.
`index` takes the returned `nextIndex`; repeat the original query. Each page rescans current sources, not a frozen corpus snapshot.

Unquoted words match exact lowercase Unicode tokens. Common function words are
ignored. Hyphen, underscore, dot and slash compounds match adjacent tokens.
Double-quoted phrases require case-insensitive literal matches with flexible
whitespace. No stemming, fuzzy matching, automatic synonyms, regex, or Unicode
normalization applies. A formulation supports 200 characters and 16 distinct terms.

Each formulation uses lexical rarity, frequency saturation, field weights and
length normalization. Alternative formulations combine ranks with reciprocal rank
fusion, using `1 / (60 + rank)` for each match. The score stays internal. Ordinal
rank describes retrieval order, never truth, confidence, freshness, or a comparable
value across calls. Per-formulation matched and missing terms explain the evidence.
The calling agent supplies reformulations; the extension makes no model calls.

Cues preserve raw metadata values. Missing or malformed fields remain unknown;
`cueProblem` marks clipped, multiline, duplicate, empty, or unclosed extraction.
Status never suppresses search results. Prefer current active sources and inspect
supersession pointers before applying a claim. Digests identify exact source bytes.
Each matched note has at most one source passage. For fused results, a body match
takes priority over a frontmatter-only match; the best-ranked matching formulation
selects the passage within that category. Per-formulation records retain rank and
matched/missing terms without repeating passages. Selected excerpts retain
half-open Unicode code-point offsets in original source.
They are discovery evidence, not complete support. Slug-only hits have no source
passage. A later qualification can lie outside the selected excerpt.

The scan inspects at most 512 directory entries plus one lookahead entry to detect
an incomplete directory scan. `scan.complete` describes traversal only, not note
availability. Browse reads bounded cue windows; inspect `scan.unavailableNotes`
and issue totals even when traversal is complete. Queries read complete supported
sources up to 64 KiB each. Unreadable, unsupported, or oversized notes keep
`search.complete` false. Cards distinguish directory scan status from query coverage. Result output is bounded; follow the
returned page position. No scan result establishes absence outside its covered scope.

### `memory_read`

Pass a `slug`, or `README` for the corpus contract. Pass the search result's `digest`
on the first read. A page returns at most 4000 Unicode code points; pass its
`nextOffset` and unchanged `digest` to continue. Nonzero offsets require the digest.
A changed source refuses instead of mixing revisions. Read scope, qualifications,
source dates and lifecycle before relying on a note. Sources above 64 KiB require
bounded ordinary file reads; the tool refuses them explicitly.

### `memory_write`

Required fields are `slug`, `title`, `tags`, `summary`, `details`, `sources`, and
`verified`. Separate sections prevent malformed model-authored frontmatter. The
writer generates the title heading, section headings, dates and lifecycle fields.
A lowercase kebab-case subject slug is stable across updates; `readme` is reserved.
Tags are bounded descriptive subject cues, not query filters. All content sections
must be nonblank. Sources contain the evidence and dates needed to assess the claim.

Omit `expectedDigest` to create; an existing slug refuses. Supply the current source
digest to update; a missing or changed source refuses. Updates preserve `created`
and existing `supersedes` links. A superseded note refuses updates. Read its replacement.
Updates replace the complete note body, so use `memory_edit` for targeted changes.
Reserve `memory_write` updates for genuine whole-note rewrites and preserve useful
rationale and qualifications in the supplied fields. Stored `verified: true` means the caller attests to a current
operator statement or authoritative source; the extension does not verify facts.
`verified_date` becomes today's UTC date when true and null when false.

`supersedes` adds up to 16 `{slug, digest}` targets. The writer validates all target
sources before publication, then writes the destination and marks replaced notes
`status: superseded` with `superseded_by` in the same call. Existing target bodies
remain byte-for-byte unchanged, including introductory prose, fenced headings and
tails. A bounded transitive check refuses supersession cycles, including cycles through
partial publications. It inspects at most 512 linked notes and 8 MiB; unavailable
ancestors or exhausted bounds refuse the write before publication.
Mutation requires valid unambiguous lifecycle metadata; tolerant retrieval
still exposes malformed notes for explicit repair. No silent schema migration occurs.

Search before every mutation. Update the existing subject instead of creating a near
duplicate. The writer refuses identical slugs, not semantic duplicates. Search is
the overlap preview; no second implicit search inflates write results.

Successful calls report `Memory updated: <file>` for each changed note. Errors name
`written` and `notWritten` files, whether initialization occurred, and the destination
digest when published. These fields describe file publication, not a corpus transaction.

### `memory_edit`

Required fields are `slug`, `expectedDigest`, `verified`, and `edits`. Each edit has
`oldText` and `newText`. Supply between 1 and 32 edits; each text is at most 24,000
UTF-16 code units. `oldText` must be nonempty; empty `newText` deletes the match.
Every `oldText` must match exactly once in the original body after frontmatter.
All matches use that original body, not earlier replacements in the same call.
Missing, ambiguous, overlapping, nested, and collectively unchanged edits refuse.
Adjacent disjoint matches are valid. No fuzzy matching, whitespace normalization,
or line-ending conversion occurs. Include the source's exact line endings.

The first level-one ATX title heading outside backtick or tilde fences must match
frontmatter and remain unchanged. Fenced examples do not count as title headings.
Edits that hide that heading or introduce an earlier title also refuse. Changes to
introductory prose preserve the original heading's identity despite offset shifts.
Title, tags, and other frontmatter are not editable through this tool. The writer updates
only `updated`, `verified`, and `verified_date` frontmatter lines; all other bytes
survive, including comments, unknown metadata, introductory prose, extra sections,
and unchanged body text. Generated fields require independent plain top-level keys;
unsupported YAML forms refuse instead of silently altering other metadata.

`verified` describes the whole resulting note, not just the replacement. True sets
`verified_date` to today's UTC date; false clears it to null. A current digest is
mandatory. Missing, changed, superseded, malformed, or unsafe sources refuse. The
complete result must fit the 64 KiB source limit. Both mutation tools refuse C0
controls other than tab, LF, and CR, plus DEL and unpaired surrogates. C1 controls
and Unicode format characters are accepted, including emoji joiners and soft
hyphens. Recognizable credentials refuse without echoing note text. A leading
source BOM is preserved. Both replacement text and the complete result pass the
credential guard. An unavailable corpus root returns an explicit memory error
without exposing its path or creating files.

Edits use the same queue, writer lock, staging, sync, digest recheck, atomic rename,
cleanup, and receipt as writes. They do not initialize or replace `README.md`;
`initialized` remains false. Success reports `Memory updated: <file>`. Publication
and cleanup failures use the same `written` and `notWritten` receipt fields; input
or lock refusals occur before publication and report a content-free error.

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
hard link; updates use rename after a digest recheck. All files are prepared before
publication starts. A failed later replacement does not undo earlier publications.
Read every reported file before repair; retry an update with the current destination
digest and remaining targets' current digests. Existing supersession links survive
that retry. Do not blindly repeat a create after partial success.

Cancellation is checked before work and between bounded operations. A started
synchronous filesystem operation finishes; cancellation does not undo a publication.
The writer attempts temporary-file and lock cleanup on success and failure. Cleanup
failure is explicit, including when all note publications succeeded. Process loss
cannot return a receipt: inspect source files and links before recovery. File sync
and rename do not establish whole-corpus atomicity or power-loss durability.

Writers that use this extension share the lock. Ordinary editors do not. Digest
rechecks detect edits before publication, but no filesystem compare-and-swap prevents
an uncooperative editor from racing the final check and rename. Stop other corpus
writers for manual repairs. Leaf symlinks, special files, and multiply linked note
inodes are refused for mutation. Search and read also refuse unsafe leaf paths.

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
before the writer validates them. Cards withhold write and edit body fields in both
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
No always-on deletion schema or automatic dependent-note rewrite is added.

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

## Presentation and verification

Native tool cards show request subjects, outcomes and coverage limits. Expansion
reveals bounded escaped evidence. Presentation never changes model-visible evidence
or retained native history. Semantic tool behavior is identical in TUI and headless modes.

Run focused tests with `node --test extensions/memory/*.test.mts`. Run the native
loader with `node scripts/extension-load-check.mts extensions/memory/index.ts`.
Repository gates cover type compatibility, lint, slice boundaries and the complete suite.
