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
The page uses the [Catppuccin](https://github.com/catppuccin/catppuccin) palette, with colours
assigned by its style guide: Latte in the light appearance and, in the dark appearance, the
flavour chosen under Text and appearance: Frappé (the default), Macchiato or Mocha. The palette
comes from the harness's shared theme assets (`assets/themes/`): the build copies
`catppuccin.css` into the page and `catppuccin.json` (the base colours) beside it, and
`web/styles/tokens.css` maps the page's own tokens to the palette's roles, including the
legibility-adjusted text colours. The choice of appearance (System, Light or Dark) and of dark
flavour is the machine's shared pane appearance, one file, `<agentDir>/pane-appearance.json`, that
[the pane appearance convention](../../../docs/conventions/pane-appearance.md) defines. The install
records its path as `paneAppearance` in `build.json`; the app watches the file, so a choice made in
another reader window or another app that follows the convention reaches every open page within
about a second. Check modes keep the choice in memory. The appearance in force also sets the
application's appearance, so the web view's colour scheme and the native paper behind the page
agree with the page's choice; the paper takes the base colour of the flavour in force.
The chrome shares one scale in `tokens.css`: control heights (`--ctl`, `--ctl-s`), spacing
(`--sp-*`), nested radii (`--r-s`, `--r`, `--r-l`, `--r-xl`) and one icon line weight
(`--icon-stroke`, drawn at the same width at every icon size).
An agent's answer in an Ask card is Markdown rendered with the document's renderer, as text that
belongs to no file: no raw HTML, and images as placeholders. A long answer also opens as a page of
its own in the document's type and measure.
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

A live host requires `paneProtocol: 4` in the app manifest. Its private, one-use
file uses `version: 1` and `live: 4`. The reader consumes the file and confirms its
reservation with the host before it opens the document. A live pane confirms the
first rendered view before it joins the connected inventory. A failed start exits
nonzero and prints the diagnostic in the terminal. The workspace and live document
UUID identify the buffer; neither is a stored document ID.

The reported `view` describes the displayed page, not a background editor. It includes
Reading or Writing, the kind of document, its dirty and conflict flags and the stored
identity when applicable. `follows` describes eligibility to follow future revisions,
not confirmation that a particular revision arrived. A dirty editor's stored revision
is a base, not its current text; a private copy is not its source publication. Read
returns the visible buffer. Apply validates its
base generation and digest, then sends `agentApply` to the page. The page returns `edits`
with the same operation identity. Native answers `applied` only after the mirror and
recovery contain that change. Replays retain the operation identity and input digest;
a different edit never reuses an accepted identity. Stale, busy, closed, error and
uncertain outcomes remain distinct.

When a published draft is clean, the reader installs an external revision as a
complete snapshot, not an agent edit. The page checks the previous presentation
and source generation before accepting the new text and its image resolver.
This also restores a clean draft whose previous update left an autosave conflict.
For a dirty draft, the reader checks the merge against the page's edit count,
source and encoded message limits. If the merge overlaps another change or exceeds
a limit, the reader retains the local draft, identifies the external revision and
pauses autosave. Save retries the merge; Save As keeps the draft separately.

The page sends a `prompt` with `requestId`, `threadId`, `documentKey`, `presentation`,
`generation` and either `text`
with an optional `quote` and `quoteRange`, or `annotations`. A batch contains one to fifty
annotations with nonblank `text` and optional `quote` and `quoteRange`, and an optional
`overall`: the person's nonblank comment on the whole batch, at most 64 KiB UTF-8. A single
comment never carries `overall`. Ranges use UTF-16. The page envelope limit is 256 KiB. The
batch message gives the overall comment exactly, after its instructions and before the
numbered comments; the instructions say that it applies to every comment and ask for a reply
to it before the numbered replies. A new prompt must match the installed presentation,
logical document and generation. Native uses the displayed source, including a Reading
page with no active draft, rather than a hidden editor's source. An optional authored
revision names the revision where the person wrote the comment. For a located
`quoteRange` (`PassageExcerpt`), the message names the passage's lines
(CR LF, CR and LF each end a line), the headings above it and its UTF-16 offsets at that
generation, and shows a fenced excerpt of its source lines, at most 120 characters on each
side, with the selected text between marks that the excerpt does not otherwise contain. When
the excerpts contain a mark of every candidate pair, each excerpt is followed by its selected
text instead. A quote without a located range appears exactly in a fenced block, never as
JSON. Each quote permits 8 KiB UTF-8 and each located selection 16 KiB. The composed body
permits 32 KiB for a single comment or follow-up and 128 KiB for a batch.

Native posts `workspace`, `document`, `operationId`, `text` and optional `follows` to the
live bridge at `/prompt`. The body carries the question and its specific context, not the
bridge's standing guidance. A follow-up links to the first confirmed request that supplied
its context and does not repeat the passage or batch. Before a request with the passage
is confirmed, the next comment in that thread gives the passage again and omits `follows`.
A batch must reach the conversation before a follow-up can refer to it. The page's text,
quote, range and authored revision of each comment, and a batch's overall comment and its
authored revision, identify a request. The same request ID with other inputs is refused.
A retry repeats the body and link of its first submission, even after the document changes.
The live bridge accepts up to the batch limit.

The running pane keeps unsent Ask text, threads, pending comments and the overall
comment with the logical document across revision changes, switching away and back,
and transient disconnection. It maps surviving ranges through edits. On refresh it
relocates a passage only when the quote, surrounding context and heading identify the
same passage. A replaced or ambiguous passage keeps its quote and authored revision
when known, not a highlight on matching words elsewhere. A batch sends the rendered quote
for a passage it cannot locate. Open review items and pending
comments can keep marks even after the person dismisses their cards.
A plain click on a mark in Reading, or the mark's item in the page menu, opens its card
again; where marks overlap, each further click opens the next card. In a short pane the
card scrolls its contents without scrolling the composer out of view. If a batch is
pending, the card stays above the tray so both Send buttons remain accessible.
A send that does not leave the page always says why. The reason appears in the open card,
in the batch list when it is open, or in a notice. The text stays where the person wrote it.
The page names the reason, such as an earlier message that is still on its way, a batch without
a comment on a passage, a document that has not finished showing, or a batch that changed while the
reader saved it. A message that never left the page returns to its composer. The Send button of a
follow-up stays enabled while an earlier message waits, so a click explains the wait.
A definite refusal restores the batch with its overall comment. For an unconfirmed request, native returns
`accepted: false`, `uncertain: true` and a `retryable` boolean. The page shows Retry only
when `retryable` is true. Retry sends the original request ID and contents so the bridge
can reconcile the receipt without repeating an accepted submission. A batch follow-up uses
the single shape and identifies the batch, with its overall comment when it had one, as
context.
Only definitely unsent batch comments and their overall comment have private recovery
when the same stored document reopens in the same conversation. Send and Remove all
clear active items from recovery and leave parked items intact. Reopening never sends a prompt, restores a delivered batch,
or treats an uncertain send as new. Recovery does not require a connection token in the
saved draft. Standalone Ask text and follow-up drafts do not have this reopen guarantee.

Confirmed delivery creates separate review items for the initial question, or for the
numbered annotations and optional overall comment. Their stable IDs and open or closed
state belong to the document and conversation across revisions. Closing an item does
not remove its text or submit a follow-up. A private copy does not inherit its source's
review items. Agent access is limited to delivered items on an exact handle; it excludes
pending batches, draft text and follow-up messages. See the [live tool contract](../README.md#live-collaboration)
for list and item versions.

Each thread keeps its first request identity, while follow-ups receive new request identities.
Native emits `promptState` with the question and thread identities and the route-reported answer text. A late send receipt cannot hide an answer already in the card. If a running host cannot identify the question, the card does not quote unscoped chat activity as an answer. An agent edit
names a thread only when one document thread is admitted or active. The page draws the comment
interface and timeline. The quote is context, not an edit range or instruction.

### Review comment state

Card visibility, delivery and review status are independent. Closing an unsent annotation or overall comment parks it in its document's private Ask state. Send uses only the active batch. Closing a delivered item removes its mark but never cancels, retries, deletes or interrupts the original thread. Each numbered annotation and the overall comment has its own state.

For a stored document opened from a stable conversation, a separate private recovery file holds the definitely unsent batch, overall text and parked items. It contains no request token, submitted review or reply. Reopening that document from the same conversation restores its pending items without dispatch. Every write checks the previous recovery version. Before first dispatch the reader removes the active batch from that file, retaining only parked items. A definite refusal can return items to the batch; an uncertain delivery cannot restore them as new. Clearing a batch keeps a version marker, not a second copy of its text. Other documents and older hosts without a stable conversation keep pane-only pending state.

After confirmed delivery, the reader retains the submitted comment, quote, authored revision and private passage anchor under `Reviews/` in the reader state directory. It stores no reply transcript, follow-up draft or unconfirmed request there. The stable conversation scope and document identity select one sheet, including across stored revisions and separately launched panes. Local files use their canonical reference. A scratchpad or private copy uses its private draft branch, not the source document's identity. A running host without a stable conversation scope has only the pane's private state. Files and locks have private permissions; sheet writes are atomic. A sheet has a 4 MiB limit and allows up to 16,384 items. A full or unreadable sheet does not evict comments or turn a delivered message into a failed send.

`markdown_live` lists sent items with `comments` and changes an individual item with `setComment` on its exact live handle. Each list continuation checks the same sheet version; each change checks the item's version. A stale write leaves the current state intact. Agents see only the delivered comment and rendered quote, never a private draft or the source anchor used to locate its mark. Status changes notify other reader panes to reload their own matching sheet. The original conversation owns the full reply after a pane closes.

## Recovery, saving and reading state

Edit sessions retain immutable snapshots under the application state's `Drafts/` directory,
separate from disposable reading positions. Drafts do not expire or publish automatically.
Reopening a draft creates an independent recovery branch. A draft or copy with a stored base
supports a read-only comparison against that exact base. The comparison never replaces the
draft. Undo and the page history own edit reversal. Closing requires a current recovery
snapshot; failed recovery leaves the document open.

Edits to a local file or a published document coalesce into automatic saves to that destination.
Scratchpads and copies remain private until an explicit Save. Closing first retains the draft
and tries to finish a pending destination save within the close deadline. A conflict stops destination autosave. It
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
MarkdownReader --export-image --out page.png [--width 900] [--max-height 6000] [--appearance light|dark]
               [--dark-theme frappe|macchiato|mocha] [--text-size n] [--click <selector>] [--answer <answer.md>] <input>
MarkdownReader --measure [--sizes 51200,512000,2097152] [--out report.json] [<corpus.md>...]
MarkdownReader --return-check <open request>
MarkdownReader --ask-check --store <store directory> --text <question> [--seconds 90] [--out report.json]
               --live <configuration> <document ID>
```

`--verify` exercises the real page offscreen under its CSP, asset refusal, bridge-driven
find, code copy, lock, edits and page recovery. Checks that send real key and mouse events use a
panel that WebKit treats as the key window but that never becomes the system's key window, and
they deliver the events to it directly. A check run never activates the app or takes a person's
typing, and typing elsewhere never reaches a check. Missing bundled page assets are a failure,
not a substituted interface. `--export-image` snapshots the same page. `--click` clicks one
control, named by CSS selector, before the capture, to show a menu or panel such as `#b-view`
(Text and appearance) or `#b-title` (the document menu). `--answer` asks about the document and
shows the given Markdown file as the agent's answer in the Ask card. `--measure` reports
read, render, display, find and process observations with their evidence limits.
`--return-check` performs the explicit terminal-return operation with the request's origin.
`--ask-check` takes the arguments of a pane launch that `markdown_live show` offered, with
`--ask-check` in place of `--pane`. It consumes the launch's live configuration, reports startup
and connects to that Pi conversation as the pane would, then opens the document offscreen inside
the same live workspace. It presses Command-Option-M, types the question with key events,
presses Command-Return and reports what the Ask card shows until the conversation answers or the
seconds pass. The offscreen panel is never the system's key window, so the menu bar cannot
validate Command-Option-M against it; the check then sends the menu item's own command and says
so in its report.
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
The reader checks the digest before it changes the terminal. `:open <document ID>` is a
person's terminal control for the current revision. Agents request navigation through
`markdown_live` on an agent-origin pane in their conversation. The reader checks the
store and pin, respects a busy or conflicted draft, and waits for the target WebKit page
to acknowledge its load. Only then does `navigated` identify the new live handle and
stored revision. An uncertain receipt is not a reason to open a replacement. The placeholder names the displayed
document, revision and build. A malformed request leaves the current document intact.
Closing restores the terminal and retains the reading position within the shutdown deadline.

## Licences

`Licenses/swift-cmark-COPYING` contains the required notice for swiftlang/swift-cmark 0.9.0.
The build copies it into `Contents/Resources/Licenses/`.
