# Local extension telemetry collection

The [Audit skill](../SKILL.md) owns the audit entrypoint, question,
general collection discipline, and report. Read this reference only when the
selected scope includes extension telemetry. It defines extension-specific
source contracts, windowed collection, and reconciliation. Complete collection
before applying the dispositions in
`../../harness/references/extension-audit.md`.
Counts describe observations, not usefulness, correct application, or reasons
to retain an extension.

## Contents

- [Collection boundary](#establish-the-collection-boundary)
- [Defining sources](#choose-defining-sources)
- [Bounded reads](#read-within-explicit-bounds)
- [Units and aggregation](#aggregate-without-changing-the-unit)
- [Second-pass reconciliation](#reconcile-on-a-second-pass)
- [Delivery](#deliver-collection-then-audit)

## Establish the collection boundary

1. Convert the request to explicit start-inclusive, end-exclusive instants and
   a timezone. For inclusive UTC dates, end at midnight after the last date.
   Select records by their documented event timestamp, not filename or mtime.
2. Establish the extension population from current resource configuration and
   live registration. Use `registry` for tools and commands, following cursors;
   use the configured entrypoints and their source for hook-only extensions.
   Separate configured, registered, active, provisional, and historical status.
   Current activation is not evidence of activation throughout the window.
3. Read each selected extension's README and the source that defines its
   observations. Resolve the actual loaded entrypoint, configuration overrides,
   store root, writer, reader, and retention. A checkout or package manifest
   alone does not establish what the session loaded. Do not import another
   machine's counts, store layout, or collection capabilities.
4. Assign every selected extension a row, including those with no retained
   events. Record its callable tools, commands/hooks, available evidence, and
   missing dimensions. Separate evidence with zero accepted records from
   unavailable evidence and behavior that the source never records.

Use the existing public readers first. Inspect their current contracts rather
than assuming that a successful call covers the requested population or period.
Collect independent sources in parallel when useful, but keep one owner for
each tally. Do not require a worker fleet for a small collection.

**Complete when:** the window and population are explicit, and every selected
extension has a source or a named coverage gap.

## Choose defining sources

Keep these evidence classes separate:

| Class | What it establishes | Boundary |
| --- | --- | --- |
| Instrumented | Events or aggregates the extension actually recorded | Lost writes, absent observers, retention, and unrecorded actions remain unknown |
| Reconstructed | Calls or facts derived from retained native transcripts | Branch scope, fork duplication, incomplete files, and unrecorded internal work limit the result |
| Snapshot | Current configuration, rules, registrations, bindings, or run state | Not historical frequency or proof of availability throughout the window |

Start with these local public surfaces where present; verify their current
README and defining source under the owning repository's `extensions/<name>/`
(`../../../extensions/` relative to this reference):

- **Policy:** `/policy telemetry FROM TO` summarizes retained writer-local day
  files. Its calendar is not a UTC timestamp filter. Read `policy/telemetry.ts`
  for reader caps, and `policy/record.ts`, `policy/runtime.ts`, and
  `policy/store.ts` for fields and writer boundaries. Check whether observation
  includes unmatched calls, disabled modes, nested calls, unfinished calls,
  correlation limits, and failed writes. Do not assume a universal call log.
  `policy_rules` health and rules are current state, not historical coverage.
- **Pillars:** `pillars_usage` exposes retained read observations. For a fixed
  window, use the revisions view over a containing supported interval, follow
  every cursor, then filter UTC days. Request and result stages are separate
  observations. Preserve folded dimensions and capture/retention limits.
  Corrupt or unavailable storage is not zero use. Counts do not prove application.
- **Agent and native history:** `agent_list` discovers metadata;
  `agent_inspect` reads bounded retained evidence without opening a writer.
  `history_search` and `history_read` cover the current session's selected
  ancestry. None is a complete cross-session time-window counter. Run state and
  bindings are snapshots; dispatch calls, sessions, and outcomes are different
  units. Follow continuations, including empty pages, and preserve omissions.
- **Other extensions:** inspect their documented stores and public readers.
  A clipboard archive or handover store records artifacts, not every invocation.
  Provider access, commands, UI, hooks, and internal work are not automatically
  counted by tool-call records. Use native evidence only for the missing fact.

Avoid collecting private content just because a store exists. For collection,
retain only the fields required by the question: timestamps, counts, units,
status classes, source references, and coverage. Keep exact identifiers local
only when needed for reconciliation. Do not copy prompts, captured commands,
credentials, private paths, or raw transcript bodies into the report or repository.
This procedure creates no export, recurring store, retention change, or index.

## Read within explicit bounds

If a public reader meets the window and coverage requirement, use it. If it
hits a cap or returns a different calendar, use an authorized documented store
with existing read tools or bounded `jq`. Name the failed reader boundary first.
Do not create a gatherer or new counters until a demonstrated omission defeats
those lower layers and the change has authority.

For a direct read:

1. Resolve the exact documented directory. Inventory hidden stores explicitly;
   hidden-file inclusion alone does not override ignore rules. Apply any ignore
   override only to that known root. Bound depth and producer results. A capped
   listing is partial discovery, not proof of absence.
2. Select explicit files. For local-calendar shards and a UTC request, include
   neighboring days that cover the writer's timezone, then filter event instants.
   Verify the mapping; do not label a local-day aggregate UTC. Record missing
   dates and files outside retention separately from zero records.
3. Measure file type, size, and modification identity before reading. Set total
   byte, file, record, and output bounds appropriate to the request. Avoid an
   unbounded glob, raw JSONL dump, or whole-corpus slurp. For growing files, use
   an existing bounded capture or a stable closed subset and state the exclusion.
4. Project only required scalar fields. Count malformed records, invalid or
   missing timestamps, unsupported shapes, duplicate identities, and skipped
   bytes separately. Never turn a parse error into a silent empty record.
   Validate the current shape; do not normalize retired schemas speculatively.
5. Recheck source identity after reading. Restart the affected read or label it
   unstable if the files changed. Keep only compact aggregates and the exact
   query/source scope in working state, outside tracked paths.

**Complete when:** each result states files/bytes/records examined, omissions,
source stability, accepted units, timezone filtering, and remaining unknowns.

## Aggregate without changing the unit

Report per-extension and per-tool volume, observed error classes, text-output
bytes, and duration only where defined. Name each rate's numerator and eligible
denominator. Missing duration is not zero latency. Policy error text classes
are inferences, not root causes. Text-output bytes are not total output or tokens.

Keep calls, returned results, sessions, dispatched workers, artifacts, and log
events in separate totals. Separate parent-call model attribution from requested
worker models and observed worker models. A spawn argument is not proof of the
model that later ran. Inspect payload-level errors only through the owning
public result contract; report them apart from error envelopes and state the
inspected denominator. Unknown payload failures are not zero failures.

Separate policy denials, input changes, result error changes, guidance, and
observations using recorded decisions. A matching rule is not proof that its
action ran. Multiple rule attributions may refer to one call; do not add them
as distinct interventions. Do not count an outer composition call and its
nested calls as one interchangeable unit.

## Reconcile on a second pass

Use the same window and accepted source set. Check:

- Source file/byte identities and coverage agree between passes. Reconcile
  discovered, read, missing, malformed, skipped, and changed inputs.
- Daily totals and per-tool totals agree with the total accepted records.
  Reconcile error/outcome partitions and show unknown fields explicitly.
- Duplicate call identities are accounted for. Within a transcript, distinguish
  raw retained entries from one selected ancestry; forks may repeat history.
- A bounded fidelity sample reaches the defining source: join retained call
  evidence to native tool-call/result entries, where available. State the sample
  selection, matched and unmatched counts, omitted cases, and differing units.
  Do not generalize sample agreement to the whole corpus.

A repeated aggregation checks arithmetic, not independent instrumentation.
Name the second facet when one exists; otherwise mark the figure single-source.
Resolve discrepancies or keep the affected figure provisional. Do not force
agreement across different windows, units, branches, or retention policies.

## Deliver collection, then audit

Return a compact local result in chat unless the operator requests a file:

- exact window, extension population, source boundaries, and collection time;
- per-extension evidence class, counts with units, and explicit unavailable or
  unrecorded dimensions;
- second-pass reconciliations, source-fidelity evidence, and unresolved gaps.

Cite defining paths or public results beside load-bearing claims. State whether
coverage is complete only for the retained accepted scope, partial, or
unavailable. Never describe retained observations as all actual activity.
Keep collection facts separate from the audit's causal judgment and recommended
action. If an unavailable layer blocks judgment, name that layer without
inventing a figure, repairing a store, or expanding collection infrastructure.
