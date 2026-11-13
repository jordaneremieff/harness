# Markdown reader

The Markdown slice retains exact agent responses, file snapshots and deliberately published documents in a private local store. Publication saves silently; the operator chooses when to open a document in the native Mac reader. Ordinary Pi and native Durable tools share the same publication operation and structured result.

<!-- harness:settings:start -->
| Key | Environment | Type | Default | Constraints | Description |
|---|---|---|---|---|---|
| app | `PI_MARKDOWN_APP` | path | &lt;agentDir&gt;/markdown-reader/Markdown Reader.app | none | Installed native reader application and headless parser tool. |
| dir | `PI_MARKDOWN_DIR` | path | &lt;agentDir&gt;/markdown | none | Private directory for Markdown documents. |
<!-- harness:settings:end -->

Relative setting paths resolve against the agent directory. Settings follow the [extension configuration contract](../../docs/conventions/extension-config.md).

## Store format

The store uses format version 1. Directories have mode `0700`; files have mode `0600`. The TypeScript store owns all document writes. Readers take no lock. `identity()` reads the store identity without creating a directory or taking the writer lock; an absent store returns no identity, and invalid metadata is a store error. The native application keeps reading state outside this store and removes accepted open requests only.

```text
store.json                                  {version:1, storeId:<32 hex>}
documents/<id>/document.json                 published document pointer
snapshots/<id>/document.json                 response or file snapshot pointer
documents/<id>/revisions/<n>/source.md        exact UTF-8 source
documents/<id>/revisions/<n>/revision.json    immutable revision metadata
documents/<id>/revisions/<n>/assets/<digest>.<ext>
sources/<sha256(sourceKey)>.json             snapshot source index
reuse/<sha256(reuseKey)>.json                explicit-reuse publication plan
opens/<uuid>.json                           transient pinned open request
```

Document IDs contain `md-` and 20 random lowercase hexadecimal digits. Titles, paths, host identities and app locations are not document identities. A complete document directory is portable to the same-named collection of another store with its identity, revisions and retained assets intact. Published documents live in `documents/`; response and file snapshots live in `snapshots/`. Both collections use the same revision layout. The source and reuse indexes are local to their store. The installed app is a separate program at `markdown.app`, never part of a document store.

`document.json` contains `version`, `id`, `kind` (`published`, `response` or `file`), `title`, `createdAt`, `updatedAt`, `revision`, `digest` (`sha256:<hex>`) and `bytes`. The pointer is replaced by rename only after a complete revision directory exists. Readers ignore revision directories above the pointer.

`revision.json` contains `version`, `document`, `revision`, `title`, `createdAt`, `digest`, `bytes`, `completeness`, `contentOrigin` and `references`. Published revisions also contain a random `publication` identity. `completeness` has `state` (`complete` or `partial`) and optional `reason` and `note`. `contentOrigin` records the source kind, capture time and available host/session/conversation/entry/model/path/working-directory/part-length provenance. Provenance does not control execution or identity.

`references` contains `state` (`inspected` or `uninspected`), `truncated`, `omitted` and `items`. Each item contains `kind` (`image` or `link`), the original `reference`, and `state` (`retained`, `embedded`, `external`, `unavailable` or `local-only`). Retained images include `file`, `mediaType`, `bytes` and `digest`; unavailable images include a fixed `reason`. Metadata keeps at most the first 512 characters of a reference, and an embedded data reference keeps only its first 64; the exact source keeps every whole destination. A retained image keeps its whole reference, because the reader finds a stored image's item by its whole reference. An image whose item holds a shortened reference therefore reads as unavailable. A shortened image reference that equals another image destination is not listed, so it never names that image's item.

Only inspected revisions contain `selfContained`. It is true only when every listed reference is retained or embedded, `omitted` is zero, and `truncated` is false. `omitted` is the exact count of known items that the metadata does not list: items beyond the item bound and shortened image references left out as described above. `truncated` separately indicates that the parser stopped at its destination bound, so further coverage is unknown. Uninspected records contain no reference items and make no self-containment claim. Response snapshots are uninspected.

A response source key names host kind, conversation/session and entry identity. A file source key names its real path. Equal source key and source digest return the existing snapshot. A changed source digest adds a revision to that snapshot. A snapshot directory can be removed by hand. The source index is a local hint: a dangling entry recreates the snapshot under its reserved ID. The index is published before the snapshot, so process termination between those writes does not create a duplicate. Explicit publication updates require the exact current revision; stale updates return a conflict with the current revision and digest.

All store mutations share one cross-process `proper-lockfile` lock at `<root>/.lock`. A writer reads and validates source and assets before it takes the lock. It writes new documents and revisions in private temporary directories and publishes them by rename. A writer adopts an unpublished orphan only when its publication identity matches its own plan; otherwise it replaces the orphan. A crashed, unpublished update conflicts if another writer published first. No acknowledged revision is replaced. A write that fails removes its own staging directory. Under the lock, each document write also removes `.tmp-*` staging directories older than one day from the first 2000 entries of both collections and from the revisions of the document it updates; committed documents and revisions never have that name. The writer refuses a revision whose `revision.json` would exceed 256 KiB, the reader's limit for a store record, with `too-large`. Atomicity covers process termination, not power loss: the store does not synchronise directory entries or perform a full device flush.

A publication plan contains `publicationId`, `documentId`, `revision` and `inputDigest`. The input digest identifies canonical invocation arguments, not later file or asset bytes. For native explicit reuse, the writer first selects or installs the reuse index plan. The tool then memoises that exact plan before any document write. A crash before the memo leaves only an index plan that the recovered task selects again. A replay returns the original published revision even after a later update. An explicit `reuseKey` persists the plan before the document write; equal arguments return or complete it, and different arguments return `replay-conflict`. Index records become visible complete, under the writer lock. Temporary index files are not records.

An open request contains `{version:1, storeId, document, revision, digest, requestedAt, launchOrigin}`. It pins one existing revision. Terminal return context belongs only to this request and the resulting window, never document metadata. The reader verifies the store identity and digest, then removes an accepted request. The writer prunes leftover requests older than one day, within a bounded scan.

## Publication tool

`markdown_publish` requires `title` and exactly one of `text` or `file`. A file path is explicit, absolute or relative to the working directory; the operation never modifies that file. Updates supply `document` and `expectedRevision` together. Optional `reuseKey` requests explicit reuse. Separate identical creates without a key remain separate documents.

Both hosts return the same structured outcome. Success includes `ok:true`, document ID, revision, source digest, byte count, title, kind, created/replayed flags, reference counts, provenance, `open` (the `/markdown <id>` command of an ordinary Pi session), and `selfContained` only after reference inspection. `replayed` is true only when a saved publication is returned again; a newly completed write, including the first keyed publication, reports false. Failure includes `ok:false` and a bounded error with code `invalid`, `too-large`, `not-found`, `conflict`, `replay-conflict`, `file-unreadable` or `store-failure`. Conflicts include the current revision and digest.

The text result and the tool card say that no window opened, that the operator opens the document from the Markdown view under Published (Owner views in the agent view), and that `/markdown <id>` opens it in an ordinary Pi session. An attached agent terminal sends that slash text to the conversation, so the view comes first. Ordinary tools return `structuredContent` and presentation details. Native tools return `structuredOutput` and presentation details. Native publication declares `replay: "safe"` and memoises its random publication plan in the Durable tool task before the document write. A recovered task returns a saved receipt before it reads the original file again. Publication performs no reveal, app launch or focus action.

## References and limits

The approved cmark parser is the only Markdown parser. The app's headless `Contents/MacOS/markdown-core references` command receives exact source on stdin. The TypeScript side checks `Contents/Resources/build.json` contract 1 first, limits execution to ten seconds, stdout to 4 MiB and stderr to 4096 bytes. Its versioned inventory has image and link destinations in document order, no duplicates, and at most 4096 destinations per list. A missing, incompatible or failed tool leaves the saved document uninspected. Build the tool with `node extensions/markdown/native/build.mts`.

HTTP, HTTPS and protocol-relative images are external. Data images are embedded. Other schemes are unavailable. Local images require a file source, a regular file with a real path inside the source directory, an allowed media type and bounded bytes. The containment check binds the opened descriptor's device and inode to the contained canonical path identities before and after the read. Absolute paths, traversal and symlink escapes are unavailable. Relative or `file:` links are local-only. Web, mail and in-document links require no local asset. Inspection and capture do not fetch network resources.

Limits: source 2 MiB UTF-8; title 200 Unicode code points on one line (joined emoji and combining marks are allowed); retained images 64 per revision, 8 MiB each and 32 MiB total; metadata 256 reference items and 256 KiB per revision record; listing 2000 documents. Allowed image types are PNG, JPEG, GIF, WebP and SVG. Over-limit source is refused, never truncated. Over-limit assets remain unavailable with a reason. `list()` defaults to published documents. Listing scans at most 2000 entries in the selected collection, filters and sorts by newest update, then applies the result limit. Prefix lookup reads names only in both collections, with a separate limit of 100000 names per collection. Listing and prefix lookup report coverage bounds instead of claiming a complete result. Retained documents do not expire as caches.

## Ordinary Pi

- `/markdown` or `ctrl+alt+r` reads the latest retained assistant response with text on the current branch.
- `/markdown recent` lists recent responses, newest first, with age and size (KB from 1024 bytes). A short acknowledgement does not hide the preceding response.
- `/markdown published` lists deliberately published documents, newest change first, with the short ID, revision and age.
- `/markdown <id or unique prefix>` opens a stored document. Prefixes require at least six characters.
- `/markdown file <path>` captures an explicit local file encoded as UTF-8 and opens its snapshot. Paths resolve against the session working directory; a leading `~` names the home directory. Double quotes around the whole path are optional.

The Markdown destination uses the shared operator frame. Enter or the Read control opens the selected item; `l` reads the latest response, `n` selects Recent responses, and `p` selects Published. `/` filters the list. The footer and More menu use the same actions as the keys. Selection and preview never reveal an app.

Stored snapshots remain openable by ID after the producer exits; the reader app owns snapshot browsing through its library and recents. The command offers completion for its subcommands. The shortcut appears in Pi's shortcut inventory. Print, JSON and RPC calls save but never launch the GUI. The outcome uses the host's notification channel when the host has one. The command writes no session message or stdout output.

## Attached Agent terminal

Open **Owner views** with `o`, then select **Markdown**: click its tab, or press Tab until the row of owner views has the focus, choose with Left or Right and press Enter. The same owner view is available from the `/agent` dashboard. It binds to the selected conversation and supplies Read latest, Recent responses and Published documents. Enter reads the selected item; `l`, `n` and `p` match the footer actions. The attached terminal does not interpret an ordinary `/markdown` slash command: use the owner view instead of sending that text to a conversation.

The native contribution advertises `operator-panel.ts` and the `markdown` owner command under the [operator views contract](../../docs/conventions/operator-panels.md). Its finite request union is:

```ts
{ op: "recent" }
{ op: "response", entryId: string, offset: number }
{ op: "published", cursor?: string }
```

With no structured data, the command returns bounded text previews and published IDs. Structured calls validate the operation and fields; malformed requests fail. `recent` returns response rows with message timestamps, a captured cutoff, visited-entry count and stop reason. `response` returns at most 256 KiB of text with entry identity, UTF-16 offset/continuation, total characters and bytes, SHA-256 digest, source-part lengths, response timestamp, completeness and provenance. Offsets must be code-point boundaries. The client validates every page and the complete reassembled digest before saving. `published` returns bounded rows and the host's store root. A present store supplies its store ID; an absent store returns no rows and no store ID. Rows always require a store ID. An optional decimal cursor skips that many rows of the newly read bounded list; it is not a frozen-list token.

All owner command routes read source data without submitting conversation input or starting model work, regardless of caller origin. Reading an absent store creates no directories and takes no writer lock. The headless host never launches the reader. Importing the panel module registers nothing, emits nothing and opens no store.

Both hosts retain text blocks in their original order, separated by one blank line. Whitespace inside each nonempty block stays exact; empty text, reasoning and tool calls are excluded. Metadata retains each source-part length and the source machine name. Response snapshots use the secondary label `Response · <working-directory base name> · <local YYYY-MM-DD HH:mm>`, from the message timestamp or, when absent, capture time. `stop` means a complete response, not accepted work; `toolUse` labels text before tool calls. Length, error, aborted, pending, deferred and unknown stops remain partial. The ordinary reader walks at most 2000 ancestors from one captured leaf and returns at most 30 responses. The native reader uses bounded public conversation pages with one captured cutoff and the same limits. Exact native reads verify visibility in that conversation. A preview is never the document; over-limit full source fails rather than becoming a truncated snapshot.

## Client-local reveal

Only an explicit local operator action lazily imports `reveal.ts`. It saves a response snapshot in this client's `markdown.dir`, or selects a stored document and its exact current revision. For a published document listed by a native host, the host names its store root and `storeId`. The adapter opens that root only when a store with that identity is readable there, and it opens the listed row's revision. If that revision's digest differs from the row's digest, the adapter refuses. A newer current revision is not an error: the reader shows its update notice. A remote or unavailable root is an error; no import or transfer is implied. The app path always comes from this client's `markdown.app`, never from a host root or document.

For a GUI action, the adapter captures terminal origin concurrently with saving through the fixed package-relative Rex helper. Its four-second timeout exceeds the helper's own child deadline plus process start, so a slow terminal still yields the helper's result. Both operations finish before the adapter writes the open request. A missing helper, failure or null result leaves the request without terminal origin and does not block reading. The [terminal-origin contract](../../docs/conventions/terminal-origin.md) owns that envelope. The helper runs in the opening process, not the producer.

After saving, the adapter writes a pinned open request and invokes exactly:

```text
/usr/bin/open -a <client markdown.app> <document-root>/opens/<uuid>.json
```

No caller supplies an executable. The adapter checks the installed app's `Contents/Resources/build.json` for contract 1. A missing or incompatible app names `node extensions/markdown/native/build.mts` as the remedy. The store removes leftover open requests older than one day within its scan bound.

Saved, accepted by the reader, not confirmed and reveal failed are distinct states. A notice says "Saved" only when the action wrote a new snapshot revision; for a document that already existed it says "Selected". After a successful launch, the adapter observes request removal for up to five seconds with an abortable wait. No removal or a failed acceptance watch means acceptance is unconfirmed; the saved document remains available. If no window appeared, the notice names the build command without diagnosing the app build. Acceptance does not establish rendering, focus or human comprehension. Launch failure also preserves the document.

The action captures target and entry identity before asynchronous work. A changed row, scope, query, conversation or closed view aborts acquisition, also for Read latest. A selection that moves because a list arrived is not a row change. Session switch, fork, tree navigation and shutdown also withdraw every ordinary action. Each new ordinary action captures the current lifecycle signal together with its view or command signal. The adapter checks that signal after acquisition, before materialization and immediately before reveal. A snapshot saved before withdrawal remains saved, but no stale action writes an open request or launches the reader. Headless publication, background updates and replay never change window return context.
