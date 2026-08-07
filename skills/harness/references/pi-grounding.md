# Grounding in the active Pi installation

Use this reference when an extension decision depends on Pi APIs, lifecycle,
mode behavior, discovery, packaging, SDK/RPC behavior, or TUI contracts.

## Keep truth facets separate

| Facet | Suitable source | What it can establish |
|---|---|---|
| Operator intent | Request, corrections, approved plan | Desired outcome and fixed constraints |
| Documented support | README and matching installed docs | The contract the installed release documents |
| Public code shape | Exported declarations and package exports | Names, types, signatures, and public reachability in that release |
| Runtime mechanism | Closest relevant implementation | Dispatch, awaiting, fallback, cleanup, and mode mechanics in that code state |
| Package state | Manifest, archive listing, installed copy | What is declared and actually shipped |
| Observed behavior | Controlled run with recorded setup | What happened in that setup, not universal behavior |

Do not flatten these into one generic “verified” label.

## Locate current truth

1. Identify the executable/package actually used by the task and record its
   version. Do not infer it from a stale lockfile or a different global install.
2. Locate that package's README, `docs/`, `examples/`, public declarations,
   manifest/exports, and runtime files.
3. Read the one installed documentation file matching the task. Follow its
   relevant cross-references completely—for example, an extension-owned custom
   UI claim may require both extension and TUI documentation.
4. Inspect the closest official example for composition, not as proof of every
   runtime detail.
5. Search declarations for exact context, event, registration, or component
   types. If awaiting, ordering, shutdown, RPC transport, or print behavior is
   load-bearing, inspect the nearest dispatcher/runner implementation or run a
   controlled reproduction.

Use package-relative source paths in durable notes unless an absolute path is
itself required to reproduce a local setup. Never copy credentials or private
operator paths into shipped skill/package prose.

## Bounded source-reaching method

The initial pass is a hard workflow boundary: choose at most three questions,
with at most one public declaration/documented contract and one nearest
implementation excerpt per question before editing. A task may require more
eventually, but only a concrete compile, test, or runtime contradiction opens a
second pass.

For each selected question:

1. Write the claim in one sentence.
2. Find the public symbol or documented contract.
3. Inspect one nearest mechanism only when the public surface cannot reach the
   claim.
4. Record package version, relative source path, symbol, and implication.
5. State the remaining gap and its narrowest runtime check.
6. Stop. Do not map sibling dispatchers/runners “for completeness.”

Typical high-value questions include:

- Which callback context owns cwd, session, model, or UI state?
- Is the event handler awaited, and what event denotes actual session teardown?
- Which modes provide a TUI, protocol-backed UI, or no UI?
- How does an abort signal reach tool work or a child process?
- Which package field discovers extensions and which files enter the archive?
- Does an SDK or RPC path load the same resources as an interactive session?

## Version and support discipline

Treat source-level internals as observations about the named version, not as a
new public API. Prefer exported extension surfaces over imports from internal
paths. When upgrading, compare the active old/new declarations, release notes,
package exports, and the extension's own assumptions; do not preserve a stale
workaround merely because it once matched an implementation.

Never edit the installed Pi package to validate an extension. If a supported
surface is insufficient, report that boundary and propose an upstream issue or
a contained extension-side alternative.
