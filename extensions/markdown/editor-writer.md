# Native editor publication boundary

`editor-helper.ts` is a one-shot, Markdown-owned writer for the native editor.
It uses `MarkdownStore`, including its cross-process lock, immutable revisions,
expected-revision checks and replay index. It does not require a model or Agent
host. Private draft recovery and local-file saves belong to the native editor,
not this helper.

The installed bundle names the supported writer in
`Contents/Resources/build.json`:

```json
{"editorWriter":{"version":1,"node":"<absolute Node executable>","helper":"editor-writer/editor-helper.mjs"}}
```

The installer records the Node that runs it by the PATH link that resolves to it, such as a
package manager's stable link, rather than by a versioned installation directory.

The application selects those trusted installation paths, sends one UTF-8 JSON
value on stdin, and reads one JSON receipt on stdout. Requests never select an
executable, shell command or reference parser. The reference parser is the
bundle's existing `markdown-core`. The caller bounds process lifetime and
retains the pending save when the process fails or its response is lost.

## Requests

All requests carry `version: 1` and an absolute `storeRoot`. `operation:
"identity"` initialises that selected store and returns its `storeId`. Use this
operation when an explicit library save needs a store, not while browsing or
on each keystroke.

`save` and `reconcile` carry the same immutable save input:

| Field | Meaning |
| --- | --- |
| `storeId` | Exact selected store identity, checked again under the writer lock |
| `invocationId` | Unique save identity, retained with the pending draft |
| `generation` | Nonnegative native buffer generation captured for this save |
| `title`, `source` | One-line title and exact Unicode Markdown; empty source is valid |
| `base` | Optional `{document, revision, digest}` for an editable published document |
| `derivation` | Optional exact base for a new copy of any stored revision |
| `assetRoot` | Optional absolute draft-owned asset directory |
| `stagedAssets` | Optional `{reference, relativePath, digest, bytes}` image admissions |

`base` and `derivation` are mutually exclusive. Identities are complete, not
prefixes. Captured responses and file snapshots never accept an editor update.
A historical published base conflicts if a newer revision exists. The helper
never advances the expected revision on the caller's behalf.

A staged image's `relativePath` is
`assets/<sha256hex>.(png|jpg|gif|webp|svg)` beneath `assetRoot`. Its digest and byte
count must match the captured bytes. `reference` is the exact destination in
the source. Only admitted images and checked retained images from the selected
base are available. Other relative references never resolve against the
working directory or arbitrary adjacent files. Remote images are not fetched.
An unavailable admitted image or corrupt retained image refuses the save.

The native caller persists the complete request before launch. To reconcile,
change only `operation` to `reconcile`. Reconciliation reads the existing replay
index and committed revision; it does not run the parser, capture files, or
write a revision. A retry uses the original `save` request and invocation.
Different input with that invocation fails with `replay-conflict`.

## Receipts and recovery

Every receipt has `version: 1` and `ok`. A saved receipt includes
`status: "saved"`, `invocationId`, `generation`, `storeId`, `document`,
`revision`, `digest`, `bytes`, `title`, `created`, `replayed` and the full bounded
`references` inventory. A replay returns the original revision even when a
later publication is current. It does not mark later buffer generations clean.

An unsuccessful reconciliation returns `status: "unconfirmed"` and `recorded`,
which says whether a replay plan exists. Neither absence of a plan nor absence
of a visible revision excludes a concurrent commit. Preserve the pending
request and reconcile or retry that same invocation. Do not invent a new save
identity to recover an unknown result.

Errors include a bounded `error.code` and `error.message`, with the current
revision and digest on an expected-revision conflict. They carry `outcome:
"not-committed"` or `"unknown"`. Parsed save requests also return invocation,
generation and store identity. Malformed requests need not have those fields.
Missing output, a process error or an unsupported receipt is an unknown result.

New editor revisions have `contentOrigin.kind: "editor"`. A derived copy names
its exact source store, document, revision and digest. Later edits preserve that
derivation without inheriting the original response's model identity.

Source and asset limits remain those of `MarkdownStore`. The JSON input limit
allows the worst-case JSON escape expansion of a supported source, plus bounded
metadata. Parser failures refuse publication instead of claiming an inspected
reference inventory. None of these receipts establishes operator acceptance.
