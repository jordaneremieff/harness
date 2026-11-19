# Markdown Reader (native Mac app)

The reader displays Markdown responses, published documents, captured file snapshots,
private drafts and explicitly opened local files. Its interface is one web page inside
an AppKit window. The native shell owns documents, cmark rendering, recovery, saves,
publication, terminal placement and system services. The page owns reading, writing,
selection, Undo, find, outline, menus, comments and overlays.

Captured responses and file snapshots never change. Their first edit creates a private
copy. Published documents and files explicitly opened for editing retain their destinations.
The page holds no durable state.

## Runtime and structure

The supported runtime is the system WebKit of macOS 26.2 or later, built with Swift 6.2.
The Command Line Tools are sufficient. There are no JavaScript packages or Swift UI packages.
The package's only external dependency is the pinned swift-cmark parser.

| Target | Responsibility |
| --- | --- |
| `MarkdownCore` | document store, identities, open requests, asset resolution, cmark rendering, source blocks, revision comparison, export and source transforms |
| `ReaderFeature` | `WKWebView` adapter, bridge codec, local page scheme, document preparation, reading state, library query and overlay data |
| `EditorFeature` | edit sessions, immutable recovery snapshots, local-file saves, publication client and staged assets |
| `MacPlatform` | pasteboard, browser hand-off, Finder reveal, terminal return |
| [`NativePane`](../../../native-pane/) | shared Rex pane placement, stacking, focus release, terminal input and size |
| `MarkdownReader` | application entry, AppKit windows, page-to-mirror integration, live protocol, menus and check modes |
| `markdown-core` | headless reference inventory |

The page assets live in `web/` and ship at `Contents/Resources/web/`.
The host uses `WKWebView` directly, not SwiftUI `WebView` or `WebPage`.
Its non-persistent data store retains no browsing session. Background drawing and
back/forward gestures are disabled. The native paper colour appears behind the page.
The page uses the [Catppuccin](https://github.com/catppuccin/catppuccin) palette: Macchiato in
dark appearance and Latte in light, with colours assigned by its style guide. Latte text colours
that fall below 4.5:1 on a page surface are darkened for legibility; `web/styles/tokens.css`
marks them. The native paper colour matches the base of each flavour.
Code blocks whose language label the page knows, such as TypeScript, Swift, JSON, shell, Python,
YAML, CSS, HTML, SQL, Rust, Go and diff, take the style guide's syntax colours by role: keywords,
strings with their escapes and interpolated code, numbers, comments, types, functions, parameters,
members, builtins, operators and delimiters. An unlabelled block that parses as JSON or reads as a
shell transcript is coloured as one. `web/app/ui/highlight.ts` wraps the existing text in spans, so
the visible text and its source offsets stay unchanged; other blocks stay plain.
The label of a block opens a menu of those syntaxes, kept by `web/app/ui/code-views.ts`. Like the
context menu, it takes no focus, so an open block keeps its caret; keys reach it while it is open. A
choice recolours that block in the page only and lasts while the block's text is unchanged. A block
coloured as Markdown also switches between its source and a rendered view. Native renders that view
with the document renderer as detached text, which has no folder: its images stay placeholders
without assets, actions or indexes. The page removes ids from the view, and its fragment links do
nothing. The controls and the view carry `data-reader-control`, so the text index, find and source
offsets cover the source alone; a find match in a rendered block shows the source again. The view
has no source positions, so editing it opens the block at the first character of its code.
A label that the reader adds to the document, such as a code block's language or an image
placeholder's state, is a `data-label` attribute that `web/styles/document.css` draws. It is not
document text, so find, selection, copy and the native text map skip it. Controls inside the
document cannot be selected, so a selection's copy and its Ask quote carry document text only; the
rendered view of a code block stays selectable.
Prose keeps a reading measure. A code block or table whose unwrapped width exceeds that measure
takes the whole width beside the prose, up to about 120 columns of code, so its lines scroll or
wrap only where the page runs out. In a window narrower than 1100 points the outline opens as a
sheet over the page instead of a docked column.
The first mouse click reaches the page without activating the application.
A standalone window uses the same page with transparent title-bar chrome.

The reader interface never runs in another browser. A platform feature is used when
this WebKit supports it, verified by check mode on the build machine. A feature that
this WebKit lacks, such as `EditContext`, interest invokers, `popover="hint"`,
`requestIdleCallback`, `scheduler.yield` or the HTML Sanitizer API, is not used, or is
feature-detected with an equivalent fallback. GoogleChrome's
[modern-web-guidance](https://github.com/GoogleChrome/modern-web-guidance) supplies
pattern guidance; compatibility is checked against this WebKit, not Chrome.

## Bridge and exact source

One reply-capable script handler named `reader` accepts versioned JSON envelopes:
`{v: 1, type, id?, ...}`. Native sends envelopes through `reader.receive` in the page
content world. Unknown versions, unknown types and oversized messages are refused.
The source limit is 2 MiB raw UTF-8. Document blocks and render replies have a separate
16 MiB compact-JSON limit; review HTML and the HTML of a `markdown` query, which renders a code
block's text, have a 16 MiB raw UTF-8 limit. Edits and agent edits
have a 5 MiB compact-JSON limit. Other fields have a 256 KiB compact-JSON limit; messages
without a large field have a 256 KiB total limit.

Native sends a `document` on open, revision change, recovery restore and resynchronisation.
It includes exact source, generation, metadata, headings, settings and rendered blocks.
Each block carries a stable key, its exact UTF-16 source range, safe HTML and a text-to-source
map. The map relates UTF-16 offsets in rendered text to absolute UTF-16 source offsets;
escapes and entities retain their differing lengths. Rendering uses the whole cmark document,
so reference links and footnotes retain their context.
A `render` reply omits HTML for keys already sent for the current document.
Wire text size is a multiplier of the 16-pixel base. Settings include the ordered size
multipliers; native stores the nearest size index. The CLI's text-size option remains an index.

The page sends ordered, non-overlapping `edits` with a base generation, next generation,
origin and exact expected text. Native checks every range and expected value before it
changes the mirror. A wrong base or expected value changes nothing; native sends `refused`
and a fresh `document`. An `ack` names the retained generation, digest and recovery state.
The first change to a captured source creates the copy before acknowledgement.

All offsets count UTF-16 code units of the exact source. Untouched source bytes, including
mixed line endings, remain exact. The page owns one edit history for person, agent and
history changes. Native Undo and Redo menu actions send page commands and use the page's
reported state for validation. Back and Forward menus mirror page-owned history through
page commands and the reported `canBack` and `canForward` flags. Native menus never send
the web view an Undo selector.

## Reading, writing and collaboration

One lock selects Reading or Writing. Reading clicks select, navigate or scroll; they never
edit. An edit open starts in Writing. A retained draft restores its lock, with Writing as the
default. Every plain document open, including published documents and captured sources,
starts in Reading. Native stores lock choices only for drafts. Changing the lock alone
creates no copy.

The page reports the passage the person currently holds. Native refuses an overlapping
agent apply or claim with `busy`, reason `held`, and a message that names the UTF-16 range.
A claim lasts at most 90 seconds and never blocks the person. Release removes it; an
applied operation removes the handle's claims.

Image insertion returns prepared edits from native without applying them. The page commits
those edits as person history. Captured sources acquire a copy only when the edits arrive.

The native live connection advertises `live: 2` at connect. Its private one-use launch
configuration retains `version: 1`. Read returns the native mirror. Apply validates its
base generation and digest, then sends `agentApply` to the page. The page returns `edits`
with the same operation identity. Native answers `applied` only after the mirror and
recovery contain that change. Replays retain the operation identity and input digest;
a different edit never reuses an accepted identity. Stale, busy, closed, error and
uncertain outcomes remain distinct.

Comments retain the existing request identity and retry rules. A retry uses the original
request, text and quote. Unknown ordinary admission never causes an automatic resubmission.
Each thread keeps its first request identity, while follow-ups receive new request identities.
Native emits `promptState` with the question and thread identities and the route-reported answer text. A late send receipt cannot hide an answer already in the card. If a running host cannot identify the question, the card does not quote unscoped chat activity as an answer. An agent edit
names a thread only when one document thread is admitted or active. The page draws the comment
interface and timeline. The quote is context, not an edit range or instruction.

## Recovery, saving and reading state

Edit sessions retain immutable snapshots under the application state's `Drafts/` directory,
separate from disposable reading positions. Drafts do not expire or publish automatically.
Reopening a draft creates an independent recovery branch. A draft or copy with a stored base
supports a read-only comparison against that exact base. The comparison never replaces the
draft. Undo and the page history own edit reversal. Closing requires a current recovery
snapshot; failed recovery leaves the document open.

Edits to a local file or a published document coalesce into automatic saves to that destination.
Scratchpads and copies remain private until an explicit Save. Closing first retains the draft
and tries to finish a pending destination save within the close deadline. An unresolved conflict
does not block close; Drafts retains the edits and the conflict. If a destination save still needs
confirmation, the reader keeps the window open and says that the edits are in Drafts.
A save acknowledges only its submitted source, not later typing. Local-file saves check the original file identity and content.
Outside replacements retain the buffer and report a conflict. A no-op file save preserves
bytes and inode, including a UTF-8 BOM and mixed endings. Library publication retains an
unconfirmed invocation for reconciliation before another publication starts.

Reading positions, recents, store folders and page settings use the separate bounded
`reading-state.json`. Each process saves only its changed entries under an exclusive lock
and atomically replaces the file. A failed write stays pending for retry. Unreadable or
unsupported state files remain untouched; corrupt files are retained beside the state file.
The page reports its scroll position through `state.scroll`; native restores it through
`document.position`. Closing saves the latest reported position without a browser round trip.
Position retention never changes a stored document.

## Content safety

The page loads only through `reader-app://app/`. Its scheme handler serves regular files
under the bundled `web/` root, refuses traversal and symbolic links, and returns explicit
MIME types. It sends this policy as a response header:

```text
default-src 'none'; script-src reader-app:; style-src reader-app:; img-src reader-asset: data:; font-src reader-app:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; require-trusted-types-for 'script'; trusted-types cmark
```

Page scripts are external classic scripts. There is no inline script or `eval`.
Document HTML comes only from cmark with raw HTML neutralised and enters the page through
the `cmark` Trusted Types policy. Document scripts, inline event handlers and `javascript:`
links do not execute. Remote images do not load. The navigation delegate refuses page
navigation after the initial application page; web links use an explicit native command
and confirmation before browser hand-off.

The `reader-asset:` handler serves only admitted tokens. Each local image retains its
containment, regular-file, size and media-type checks. Retained images also match their
recorded SHA-256 digest and byte count. Missing or changed assets never repair themselves
from another project file. The store reader refuses symbolic links below its canonical root.

## Build and checks

```sh
node extensions/markdown/native/build.mts
node extensions/markdown/native/build.mts test
```

The build assembles and ad-hoc signs `Markdown Reader.app`. `PI_MARKDOWN_APP` selects an
explicit install destination. The build manifest records protocol capabilities, a digest
of the bundled source and, in a Git checkout, the commit of that source with whether any
input has uncommitted or untracked changes (`source`). The editor writer's Node is the PATH
link that resolves to the Node running the build, such as a package manager's stable link,
so a Node upgrade keeps the writer available.

An install compiles in `build-cache` beside the destination; the checkout keeps no build
output. The cache serves one checkout at a time: SwiftPM can reuse stale objects when one
scratch directory serves several package roots, so an install from another checkout first
empties it. Installs from the same checkout build incrementally. The `test` command still
builds in the package's own `.build`. An install holds `install.lock` beside the
destination for its whole run. A second install meanwhile exits with status 75 and changes
nothing; a lock whose process ended, or that is older than an hour, passes to the next
install. Under the lock, an install removes staging folders and moved-aside bundles that an
interrupted install left beside the app. Building does not update a running process. The
Markdown extension runs this build by itself when the installed app is missing or older than
the loaded harness; see [Keeping the reader app current](../README.md#keeping-the-reader-app-current).

Check modes use private pasteboard and in-memory reading state:

```text
MarkdownReader --verify [--out report.json]
MarkdownReader --export-image --out page.png [--width 900] [--max-height 6000] <input>
MarkdownReader --measure [--sizes 51200,512000,2097152] [--out report.json] [<corpus.md>...]
MarkdownReader --return-check <open request>
```

`--verify` exercises the real page offscreen under its CSP, asset refusal, bridge-driven
find, code copy, lock, edits and page recovery. Checks that send real key and mouse events use a
panel that WebKit treats as the key window but that never becomes the system's key window, and
they deliver the events to it directly. A check run never activates the app or takes a person's
typing, and typing elsewhere never reaches a check. Missing bundled page assets are a failure,
not a substituted interface. `--export-image` snapshots the same page. `--measure` reports
read, render, display, find and process observations with their evidence limits.
`--return-check` performs the explicit terminal-return operation with the request's origin.
`--present` is a separate visible presentation mode, not an offscreen check.

Swift tests cover the bridge and bounds, exact mirror changes, copy-on-first-change,
lock persistence, live apply retention and claims, page scheme security and menu state.
The native page fixture tests the bridge, not the production interface. Page tests cover
history and interaction. A real-pane trial owns composition, VoiceOver,
first-click, focus return and visible typing latency; an offscreen result does not establish them.

## Pane mode

The reader runs as the program of its terminal pane and overlays a borderless non-activating
panel on that pane. Terminal anchoring, stacking, transparent holes, hidden-pane handling,
terminal loss and bounded shutdown remain native. The pane never activates the reader
application or claims keyboard focus on load. A person clicks the page to use the keyboard.
Top-level Escape sends `command returnFocus` and gives focus back to the terminal.

A pinned open request (`--pane <request path>`) displays its exact revision and digest.
To open an exact revision without a request file, use
`--pane --store <store root> <document ID> --revision <n> --digest <sha256:...>`.
The reader checks the digest before it changes the terminal. `:open <document ID>` in the
pane selects the current revision in the same window. The placeholder names the displayed
document, revision and build. A malformed request leaves the current document intact.
Closing restores the terminal and retains the reading position within the shutdown deadline.

## Licences

`Licenses/swift-cmark-COPYING` contains the required notice for swiftlang/swift-cmark 0.9.0.
The build copies it into `Contents/Resources/Licenses/`.
