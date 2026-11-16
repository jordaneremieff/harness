# Markdown Reader (native Mac app)

A native reader for Markdown documents that the Markdown extension saves: agent responses,
published documents and file snapshots. It also opens plain `.md` files in place. Reading never
changes document source; its only store mutation is removal of an accepted open request.
The editor coalesces edits into automatic saves and delegates library saves to the bundled store writer.
Read is the default; Edit uses the same pane and document buffer.
Its own reading state (positions, recent documents, known store
folders, text size) lives in `~/Library/Application Support/Markdown Reader/` and is bounded;
trimming it never touches a stored document. The application and every [pane mode](#pane-mode)
reader share that state: each process records the entries it changed since its last save, and
an opening reads the file again before it restores a position. A save runs on a background
queue, never on the main thread: it takes an exclusive lock on `reading-state.lock` within
250 milliseconds or does not write, applies only this process's changes to the file's current
state and replaces the file atomically. Only a successful write clears the changes it covered;
a change made while a save runs, and every change of a failed save, stays pending, and a failed
save is logged and tried again after one second, then after twice the last wait, up to 30
seconds. The file keeps fractional seconds, so for one document the position captured later
wins, whichever process saves first.

A save writes only over a file it could read. A missing file is created. A file that cannot be
read (an I/O or permission error, or not a regular file) and a file with another `version` stay
as they are, and the changes stay pending. A file that is not valid state (not JSON, the wrong
shape, or over the 1 MiB limit) is corrupt: the save keeps it beside the state file as
`reading-state.json.unreadable-<UTC time>-<UUID>`, never over an existing file, logs that name,
and then writes this process's state; `ReadingStateStore.lastRecovery` names the kept file.
A save with a deadline (`flush(timeout:)`) reports what it knows when the deadline passes:
*saved* once the new file is in place, *not saved* when the write did not start (the save is
then abandoned and never writes), and *unconfirmed* while the write is under way.

Requirements: macOS 26 or later and Swift 6.2 (the Command Line Tools are enough). SwiftUI's
`WebView` and `WebKit.WebPage` need macOS 26.

## Scratchpads and private recovery

**File > New Scratchpad** opens the native editing workspace. Each open document retains one
TextKit 2 controller and undo history. Switching documents does not replace source storage.
**Recoverable Drafts** lists private snapshots, including empty scratchpads. Reopening creates
an independent recovery branch, so two processes never replace one another's draft.

Drafts live under `Drafts/` in the app state directory, separate from disposable reading
positions. They do not expire or enter the publication store automatically. Recovery writes
immutable snapshots in the background and exposes pending, current and failed state.
Closing a document or workspace requires a current recovery snapshot; a failure keeps it open.
The workspace freezes input during its final recovery write, then restores input if closing fails.

Edits save automatically to an opened file or through the bundled library writer. Captured responses
and file snapshots start a separate editable copy. **Save** remains available for an explicit save;
**Save As** chooses a local file. A file save checks the original file identity and content;
external replacements leave the buffer intact and report a conflict. A no-op file save preserves
its bytes and inode, including a UTF-8 BOM and mixed line endings. A save acknowledgement marks
only the submitted source as saved; text typed later stays dirty. An unconfirmed library save
retains its exact invocation for reconciliation before another publication starts. The pending
invocation must reach recovery storage before the writer starts; subsequent typing need not stop.

Read and Edit retain the same source controller, selection and native Undo history. Edit opens
in Visual mode. Its compact toolbar contains Format and View; View holds Source mode, Find,
appearance and zoom. Visual mode uses cmark source ranges to show editable headings, prose,
emphasis, links and exact inline code without their delimiters. Unsupported blocks remain editable
source, and front matter keeps the document in source form. A visual edit across hidden syntax
refuses rather than rewriting unrelated markup; Source mode handles such changes. Zoom changes
presentation, not source or selection.

Select a passage in Read or Edit, then use **Comment on Selection** to comment directly to the
pane's Pi conversation. The small comment box stays inside the pane window, so using it neither
activates the application nor opens another window; it retains the displayed quote as context,
not an edit range. Hover exposes the margin controls without changing focus. **Ask about Document** is a
secondary action; there is no permanent prompt or idle status strip. See
[live collaboration](../README.md#live-collaboration) for keyboard actions and delivery boundaries.

Mode changes defer while native text composition is active; document changes, saves and close
actions explain that composition must finish first. Preview uses the reader's safe rendering path
without a fabricated file or revision identity. Hidden previews stop pending work. The workspace
also contains its library browser and read view.

External updates merge only when the local and remote source changes do not overlap. Conflicting
passages or image replacements preserve the local draft and report the conflict. Secondary
**Review / Revert to Saved Version** controls distinguish the pinned base, live draft and saved
source. Explicit replacement first retains the old draft as an independent recovery version;
failed recovery leaves the live source and Undo intact.

The **Format** menu provides headings, emphasis, code, quotes, lists, tasks, links, table insertion,
indentation and line movement/duplication. Commands recognise CR, LF and CRLF as line breaks and
preserve their original endings. Bold, italic and strikethrough keep selection-edge whitespace
outside their markers; inline code keeps the selected literal's spaces. Native formatting shortcuts
operate only when the source text view is the first responder: Command-B, Command-I, Command-K and
Command-[ / Command-].
Command-F opens literal source search with next/previous, case and whole-word controls, replacement
and an explicit selection scope. Command-G and Shift-Command-G step through matches. A source edit
outside a scoped replacement invalidates that scope instead of broadening Replace All. In rendered
preview, or when the preview has focus in Split, reader Find remains the active action. Go to Line
uses one-based source lines; the status shows source position and counts. Source search and
replacement preparation run off the main actor with one explicit operation in flight. Changed
source, selection, query, composition or a closed view prevents a late operation from applying.
Counts use one worker with the latest pending request, not a new detached scan for each change.
Applying a replacement remains one native undo transaction.

**Insert Image**, image paste and file drop copy admitted images into private `EditorAssets/`
storage before inserting Markdown. The source receives one native undo transaction. If typing,
selection or composition changes during staging, the image remains recoverable and **Insert Retained
Images** lets the operator choose its insertion point. File/draft copies and Save As carry referenced
local images without rewriting Markdown. An existing image destination with different bytes causes
refusal, not overwrite. Private image storage refuses additional assets at its capacity rather than
evicting older work. Unavailable and external image references remain explicit; insertion does not
fetch remote content. Library saves pass exact staged identities to the existing writer before
publication. Revert clears the live draft's staged admissions only after retaining its old recovery
branch.

Save As captures an existing destination's identity when the file dialog completes. The later write
must match that identity; a destination that appears or changes during the save is not silently
replaced. Native file coordination does not exclude uncooperative external writers.

The explicit editor launch is:

```text
MarkdownReader --editor --surface pane|window --store <absolute directory> --intent scratchpad|file|edit|copy [--origin <JSON>] [absolute input path]
```

Scratchpad takes no input. File takes a local Markdown path. Edit and Copy take a validated pinned
open request belonging to the selected store; its origin remains navigation context, not write
authority. Scratchpad and File optionally accept the bounded origin JSON. Callers require the
`editorOpen: 1` build capability independently of the bundled writer capability. A pane uses the
existing terminal anchor and retains drafts before it exits. Failed recovery keeps an available
pane open; terminal loss makes one bounded recovery attempt before exit.

## Build and install

```sh
node extensions/markdown/native/build.mts
```

The script runs `swift build -c release`, assembles `Markdown Reader.app` (bundle ID
`local.harness.markdown-reader`), signs it ad hoc and installs it by rename at the path of the
`markdown.app` setting (`PI_MARKDOWN_APP`, else `markdown.app` in `<agent dir>/harness.json`,
else `<agent dir>/markdown-reader/Markdown Reader.app`; the agent directory is
`PI_CODING_AGENT_DIR` or `~/.pi/agent`). The app is a program, not document data: it never lives
inside a store root. If an interrupted install left the destination absent, the installer first
restores the newest adjacent `.old-*` bundle. A failed final rename restores the previous bundle;
if that restoration also fails, the error reports both failures and the previous bundle's path.

The bundle carries `Contents/Resources/build.json`:

```json
{"contract": 1, "pane": 1, "paneOpen": 1, "paneOpenRequest": 1, "editorOpen": 1, "live": 1, "sourceDigest": "sha256:…", "builtAt": "…", "swift": "…",
 "store": "/…/markdown", "terminalOrigin": {"helper": "terminal-origin.ts", "node": "/opt/homebrew/bin/node"}}
```

Openers compare `contract` with the version they expect and name this command as the remedy for
a missing or incompatible build. `contract` covers open requests, the store format and the
parser output. `pane` is the version of [pane mode](#pane-mode); the publication tool offers a
pane command only when it matches, and otherwise names this build command. `paneOpen` is the
version of the pane's `:open` input; the publication tool names that input only when it
matches. `paneOpenRequest` is the version of the pane's pinned open-request input. An opener
must require `paneOpenRequest` 1, `pane` 1 and `contract` 1 before it uses that input; a missing or
incompatible marker means unavailable, never an unpinned document open. Programs that only
open documents ignore it, so Pi processes that started before a rebuild keep opening documents
with the new build. An unknown `--` option ends the app with a usage error, so a caller that
expects a newer mode never starts the library application instead. `store` is the value of the `markdown.dir` setting at build
time (`PI_MARKDOWN_DIR`, else `markdown.dir` in `harness.json`, else `<agent dir>/markdown`): the
installation seed for the library, not a locked default. **File > Open Store Folder…** selects
another validated store without a rebuild. The library remembers the explicit selection in its
separate reading state; that selection takes precedence over the build seed.
`sourceDigest` covers the manifest, lockfile, sources, licence
notices and the embedded helper. A running instance keeps its old code until you quit it; the
script says so when one runs. `terminalOrigin` is present when the checkout has
`extensions/rex/terminal-origin.ts`: the build copies that file into the bundle (the
terminal-origin contract permits this embedding, and every build refreshes the copy) and records
the Node executable that runs it, the first of `/opt/homebrew/bin/node`, `/usr/local/bin/node`
and the Node that ran the build.

The first build fetches swift-cmark from GitHub at the version pinned in `Package.resolved`.
Build output stays in `.build/` (ignored by Git).

## Tests

```sh
node extensions/markdown/native/build.mts test
```

This runs the swift-testing suites: `MarkdownCoreTests` (GFM rendering and heading anchors, raw
HTML and unsafe links, images and asset containment, store reading against a fixture in the store
format including symbolic links and scan bounds, open requests and their removal, the pinned
digest, the reference inventory, the blocks and line ranges of a source, the bounded comparison
of two revisions' blocks, lines, words and recorded images, stepping to revisions outside the
listed choices, the source lines of a selected passage with their basis, and the list of a
source's images with the actions that open them), `MacPlatformTests` (the pane helper runner against fake helper
scripts: each outcome, a timeout, malformed output, refusal, an oversized origin and a helper that
closes its input; the pane reader's coordinate conversion, window matching, printable
placeholder text and bounded error lines; search rounds against a model screen with a slow
application, a large tree, long text, copies of the marker, a later window beyond one round's
budget and many unanswered window lists; covering content found by hit test and by stacking
report, with reported areas that match no drawn content, reach past the layout edge or reach
the screen through an unusable container, nearly equal candidates, a pairing that the closest
pairs alone would lose, a small pane and several covers that hide a frame together; an element
that its window no longer shows; stacking report parsing, an oversized report line dropped
whole, and a stacking command that ends with its input; output to a pipe and a
pseudo-terminal that stop reading), `ReaderFeatureTests` (the bounds of the reading-state file;
saves from several stores in reverse order within one second; a lock that a second process
holds, a failed write, unreadable, unsupported and corrupt state files, a change during a save
and flush receipts before, during and after the write; revision following with a held
preparation: a publication during the first load and during a manual refresh, a newer revision
during a failing attempt, scrolling during preparation and a text selection; the comparison
page of two revisions, an image-only revision, a comparison that prepares or fails over the
document, revisions older than the listed choices, and a passage copied with its source from
the rendering and from the source view; image inspection: the facts of retained, local,
embedded, external and unavailable images, zoom steps and Fit, a wide SVG at Fit and at actual
size in a narrow window, images without a shown form, and a retained image that changed on
disk; a burst of refreshes; the preparation queue's bound of
one running and one waiting request; update observation with an unreadable pointer, a removed
and restored document folder and a removed plain file) and
`MarkdownReaderTests` (the built binary in pane mode on a pseudo-terminal, with its own store and
home folder: `q`, termination, interruption, hang-up and a closed terminal; a held state lock;
standard error and a terminal that stop reading; store text with terminal controls; the key
parser of the pane's command line and `:open` of another document of the store, including
refused identities and an unknown command). Under the
Command Line Tools
the Testing framework is outside the default search path, so the script passes its directory.
The tools also ship the `_Testing_Foundation` overlay without a module, so a test file imports
`Testing` first and then the core with `@testable` (which re-exports Foundation), never
Foundation directly.

## Opening documents

- Open request (what the Markdown extension writes):
  `/usr/bin/open -a "<app>" "<root>/opens/<id>.json"` with
  `{version:1, storeId, document, revision, digest, requestedAt, launchOrigin|null}`. The app
  accepts it only as `<root>/opens/<name>.json` of a directory whose `store.json` carries the
  same `storeId`, checks the pinned revision's digest, then removes the request file (the
  opener's acceptance signal) and shows exactly that revision. The removal unlinks only the
  regular file that the app read (same device and inode) and never removes a directory; when
  something else replaced the request, it stays and the open fails with that reason. The window's
  first load of the accepted request checks the digest again and shows nothing of a revision that
  changed since acceptance. When the pointer is already newer, the window says that a newer
  revision is available. A request that fails stays in place and the app shows why.
- Plain Markdown file: `/usr/bin/open -a "<app>" notes.md`. It opens in place, unsaved, without
  a terminal origin. A symbolic link opens the file that it names.
- Library (File > Library, shown when the app starts without a document): recently read
  documents and bounded collections from one selected store. The store picker offers known
  folders from reading state and the build seed; **Open Store Folder…** validates another folder.
  Selection does not merge stores, alter a store, or create a document recent. Opening a document
  from another store adds its folder to the choices but does not change an explicit selection. Everything stays openable after every producer exited. An absent collection is
  separate from an unavailable collection. Permission, I/O and malformed-record failures appear
  in the library; usable rows remain visible with bounded omission details, never a claim that
  an unavailable collection has no documents. Bounded results are newest among scanned rows.
- One window per document. A repeated open brings that window forward without rendering again
  unless a load is pending. The last explicit open supersedes pending loads, even when it names
  the revision already on screen. A reopen after closing returns to the saved reading position.

## Library retrieval

The library reads a bounded page from each collection and offers **Read Next Documents** while
entries remain. It keeps one directory cursor per collection until reload. Rows are newest among
scanned rows, not a promise of the newest documents in the store. Directory changes do not form a
frozen snapshot; reload starts a new scan. Scans retain usable rows and name record omissions and
read failures before the rows. The library reloads shared recents, known store folders and the
selected store before each scan. It reports pending reading-state saves and state-file recovery.
An unavailable selected store remains selected with its error; it never falls back silently to
the build seed. Invalid folder selections leave the previous choice intact.

Metadata selection filters scanned title/ID, kind, source path or workspace, and the UTC update
date. Missing source metadata does not remove an otherwise usable row; those rows report that
qualification. Date fields accept `YYYY-MM-DD` and reject invalid ranges.

Source-content search is a separate explicit action over loaded rows under the metadata selection.
Each action checks up to 20 exact retained sources and reads at most 8 MiB. Repeated actions continue
through unchecked sources. Its checked, matched and unavailable totals do not claim coverage of
unscanned documents; read more directory entries to reach them. Reload clears source-search
results. No derived index or document mutation is involved.

## Export

**Document > Export Revision Archive…** and **Export Sharing Copy…** export the selected retained
revision, not an implicit refresh to the latest revision. The same actions appear in the Details
**Export** menu. Each action creates a new folder outside the document store, never overwrites an
existing destination, and publishes the folder only after every required copy succeeds.

- **Archive** copies exact `source.md`, original `revision.json` and the document pointer's
  `document.json`, plus recorded retained assets. Unknown record members remain intact. Original
  records include private provenance. The pointer is the exact pointer at export time and can
  name a later revision; this selected-revision archive is not a complete store.
- **Sharing copy** uses the existing cmark parser to write derived `document.md`. It rewrites
  retained Markdown image destinations to relative asset paths and copies those assets. Markdown
  formatting is normalised; YAML front matter stays byte-exact. Store records and their private
  provenance are excluded. Raw HTML, links, non-retained images and source content stay unsanitised.
  The source itself can contain private information. `EXPORT.md` states these transformations and
  the limits of copied references; it never claims a fully self-contained or sanitised document.
- **Current Page PDF** uses WebKit's PDF export for the document page, including source view when
  selected. It is unavailable over a comparison or image-inspection view. A page change during
  PDF preparation cancels that result. PDF is a rendering, not exact source or archival identity.

Retained assets must still match their recorded byte count and digest. A mismatch, read failure
or export bound stops the copy and removes its staging folder; no project-file repair occurs.
Exports retain the reader's source and image limits, bound copied assets and derived output,
and never modify the original document, records, reading position or history.

## Reading

The contents outline uses a proportional sidebar from 640 points width and a native popover below
it. Drag the divider to change its width, double-click to reset it, or use its accessibility
adjustment. The layout keeps room for the document and retains the chosen proportion through
resizes. Contents shows or hides the outline. The same heading list and filter field serve both
presentations. The current section has an indicator;
a heading or footnote jump records the previous reading position. Go Back After Jump restores
that position, with a window-local history bounded to 20 entries and cleared on revision loads.
The embedded header keeps the title, Contents, Edit and Close visible. More Actions holds Find,
back navigation, revision selection, Review Changes, view options, copying, details and terminal
return. Revision and source details do not occupy a permanent status row.

Find has next and previous actions and a not-found state. Other controls include text size,
code wrapping, Copy for each code block (the parsed code without its
final line break), Copy Markdown (the exact source), Show Source, a revision menu, a compact
provenance line with details on demand (both name the newest revision the window knows), and
labels for partial responses (length limit,
stopped, error) and for text written before tool calls. A response's title comes from its
content (the heading that opens it, else the first text line of its first block); its stored
title is a provenance label and appears in the provenance line.

**Copy Passage with Source** copies the selected text followed by a reference for a correction
request: the document ID (the path for a plain file), the shown revision and whether a newer
one is known, the source digest, the headings above the passage, the numbers of its top-level
blocks and its source lines. Source lines are stated only on a basis that the source
establishes. A passage selected in the source view names its own lines, after the reader found
the text on them. A passage selected in the rendering names exact lines when its text occurs
verbatim, exactly once, in the Markdown of its enclosing blocks; otherwise the copy labels it
rendered text and names the lines of the enclosing blocks, which come from the parser's block
positions. When the page's blocks do not correspond one to one to the source's blocks, the copy
names no lines. The copy goes to the pasteboard only; the reader sends it nowhere.

Code copy keeps CRLF between lines when every line ending in the document source is CRLF.
Sources with mixed line endings copy with LF. Markdown container indentation is not part of the
copied code.

Tables share the available page width between their columns. Sentences, long links and inline
code wrap inside their cells instead of forcing horizontal scrolling. Narrow panes use smaller
cell padding, not smaller text or hidden columns. Rows grow in height as needed and copy as one line.

A normal window watches the open document's pointer (or a plain file's folder) and shows
"Revision n is available" without rendering by itself, so a selection or the scroll position never changes
under the reader. Pane mode follows updates only while rendered reading is idle: scrolling,
selection, find and source view defer automatic replacement. Show Source remains selected after
a manual revision change or refresh. A manual refresh explicitly replaces a selection; automatic
updates do not. Choosing an older revision suspends following in that window only, not on a later
reopen. No persistent revision pin is implied. Show Latest Revision restores the same block and
the offset inside it; when
that block changed it falls back to the start of its section, then to the same relative position,
and says so. A load takes effect only after its page displayed: when an update fails to read or to
display, the window keeps the last good revision, its state and its page (shown again when the web
view lost it) and says that the update failed; a window whose first load fails says why. When the
page's web content process ends, the app reloads the shown revision at the saved position.

When the window cannot tell whether a newer revision exists, it says so: "Updates not observed:
<reason>. Refresh to check." with a Refresh button, while the shown revision stays readable.
This happens when the watcher cannot start (for example, the document's folder is gone) or the
current pointer or plain file cannot be read. A removed or renamed folder starts the watcher
again on its path. A refresh (Show Latest Revision, ⌘R) starts a missing watcher and reads the
pointer again; the message goes away once both work. The app logs each such failure once per
change of reason.

A window prepares one revision at a time. Reading and rendering run to completion once started,
so a load that starts while another prepares waits, and a newer load replaces the waiting one
before it reads anything. Repeated refreshes and opens therefore prepare at most the revision
under way and the newest one requested. A new load or display also ends the previous display's
wait from the model side. A replaced WebKit navigation need not finish before its caller releases
the obsolete prepared revision. Only the current display controls the expected-navigation state.

The revision menu offers revisions from the document's pointer, at most the newest 50, and says
when older revisions are not listed. The list does not grow: **Go to Revision…** shows any
existing revision by its number, and Older Revision and Newer Revision continue outside the
listed choices to the nearest existing revision, probing at most 50 numbers for each step.

## Reviewing changes

**Review Changes** compares two retained revisions of the open document. The reader computes
the comparison itself from the two stored revisions. No model takes part, and the page carries
no explanation by an author: it shows what differs, not why, and not whether the change is
accepted. When the window knows a newer revision than the one on screen, the comparison runs
from the shown revision to the newest; otherwise from the nearest earlier revision to the shown
one. The earlier revision is always the base. The bar above the comparison names both
revisions and offers another revision to compare with, from the listed choices or by number.

The comparison is one column at every width:

- The document ID and, for each revision, its number, date, byte count, line count and source
  digest.
- Retained images. Each revision's reference inventory records a state, a byte count and a
  digest for every image reference. A reference whose records differ appears with both records
  and both images, and with the sections that use it, so a revision that changes only an image
  never reads as unchanged. Images that only one revision retains are listed too. When an
  inventory is uninspected or incomplete, the page says that images were not compared, or not
  completely.
- Each changed part, under the headings above it and with its source line numbers in both
  revisions: the blocks of both revisions in rendered form between their unchanged neighbours,
  then the exact source difference, line by line, with the changed words of replaced lines
  marked and long unchanged runs folded. When both revisions render a part alike, the page says
  that the difference is in the source only. A changed line that ends with a carriage return
  shows it. When the final line break changes, the page states each revision's ending, even
  when other source lines changed. Unicode-normalisation changes remain source differences.

The work is bounded. The comparison aligns top-level blocks, then the lines of each changed run
of blocks, then the words of replaced lines, each through the platform's collection difference
after the common start and end are set aside, and each only up to an element bound (2500 blocks,
2500 lines for one part, 1200 words for one replaced run), because that difference keeps state
that grows with the square of the number of differences. Above a bound the level reports a
coarser result: one replaced region, or lines listed as removed and added without alignment.
The page shows at most 200 changed parts, 400 difference lines for one part and 6000
altogether, rendered blocks only for parts up to 12 blocks and 80 lines for each side, and 40
image changes. Every bound that took effect is stated at the top of the page or at the part as a
partial comparison, with its counts.

The comparison has its own page above the document. Both revisions are read, rendered and
compared off the main thread. While that runs, and when it fails (for example, a revision whose
source no longer matches its digest), the document stays on screen as it was, with its
position and selection, and a line says what happens or why it failed; a failure while another
comparison is on screen keeps that comparison. Find and Copy act on the comparison while it is
on screen. The reader does not replace the document below with a newer revision by itself
during a comparison; closing the comparison checks for one again.

## Inspecting images

A click on an image opens its inspection over the document; so do **Inspect Image** in the
image's context menu and in the View menu, which opens the image in view. A placeholder for an
image that is not shown carries a **Details** control that opens the same view. An image inside
a Markdown link keeps the link's click and opens from the menu. The inspection has its own page,
where WebKit renders the image under the reader's content policy (an SVG image runs no script);
the document's page stays loaded below with its position and selection, and the reader does not
replace it with a newer revision by itself meanwhile.

- **Fit** shows the whole image inside the view. **Actual Size** (1:1) shows one image pixel
  for each point, or an SVG at the size it declares; the view then scrolls both ways, so a wide
  diagram is readable in a narrow window. Zoom In and Zoom Out step through 10, 25, 50, 75,
  100, 150, 200, 300, 400, 600 and 800 percent, from the scale that Fit gives when they start
  at Fit. The middle of the view stays in the middle.
- Below the image: its alternative text (or a line that the source gives none), its title, the
  reference exactly as the Markdown source has it, and its state: retained with the revision
  (media type, byte count and digest from the revision's reference inventory), a local file
  beside a plain Markdown file, embedded in the source, external and not loaded, or unavailable
  with the reason. "In the document" says what the document page observed for the image:
  served and displayed, served only, or the failure. The image itself carries the same
  alternative text and title for assistive technology, and an image without alternative text
  is announced as such with its reference.
- **Copy Reference**, for a retained image, copies the reference with the document ID, the
  revision, the media type, the byte count and the asset digest.
- A retained image is served only when its bytes match the recorded identity. When they do
  not, the inspection shows no image and gives the reason.
- Previous and next move through the revision's images. Escape or Done closes the inspection.

Find uses an app-owned find bar over `window.find` in the app's content world. SwiftUI's find
navigator does work on `WebView` on macOS 26.2, but the menu's Find Next and Find Previous cannot
reach it (the hosted web view does not handle `performTextFinderAction:`), so menu, key and click
would not share one function.

| Action | Menu | Key |
| --- | --- | --- |
| Open file, Library | File | ⌘O, ⇧⌘L |
| Show in Finder | File | ⌥⌘R |
| Copy, Copy Passage with Source, Copy Markdown, Select All | Edit | ⌘C, ⌥⌘C, ⇧⌘C, ⌘A |
| Find, Find Next, Find Previous | Edit > Find | ⌘F, ⌘G, ⇧⌘G |
| Show Outline, Show Source, Wrap Code Lines | View | ⌃⌘S, ⌥⌘U, ⌥⌘L |
| Bigger, Smaller, Actual Size text | View | ⌘=, ⌘-, ⌘0 |
| Inspect Image | View | ⇧⌘I |
| Zoom In, Zoom Out, Actual Size, Zoom to Fit (image inspection) | View | ⌘=, ⌘-, ⌘0, ⌘9 |
| Go Back After Jump | Document | ⌘[ |
| Show Latest, Older, Newer Revision | Document | ⌘R, ⌥⌘[, ⌥⌘] |
| Go to Revision, Review Changes | Document | ⌥⌘G, ⌘D |
| Document Details | Document | ⌘I |
| Return to Rex | Document | ⇧⌘R |

Toolbar buttons and context menu items call the same actions.

## Return to Rex

A window remembers the launch origin of the open request that opened it, as defined by
`docs/conventions/terminal-origin.md`. A later explicit open replaces it; Finder and recents
opens clear it; document content never sets it. Only a window with an origin offers
**Return to Rex**. The action runs once, without retry:

1. When the origin has `exact` and the bundle has the helper, it runs
   `<node> <Resources>/terminal-origin.ts focus` with the origin record on standard input,
   bounded by 8 seconds including the input transfer. Both paths come from the bundle and
   `build.json` only. An origin record larger than the helper's 16384-byte input limit is refused
   before any process starts. A helper that exits or closes its input early does not end the app.
2. It brings the running Rex application to the front. It does not launch Rex.
3. It reports the outcome in the window: the pane was selected; the original pane no longer
   exists (with the helper's detail); or pane selection was not available (with the reason).
   A selected pane says nothing about which Mac window shows it.

## Check modes

The app binary has non-interactive modes. They print JSON, use a private pasteboard and keep
their reading state in memory.

```sh
APP="<app>/Contents/MacOS/MarkdownReader"
"$APP" --export-image --out page.png [--width 900] [--max-height 6000] [--appearance light|dark] [--review previous|n] <file.md | open request>
"$APP" --verify [--out report.json]
"$APP" --measure [--sizes 51200,512000,2097152] [--shapes all|sections,table,code,images,revisions,windows] [--out report.json] [<corpus.md>...]
"$APP" --present [--width 960] [--height 900] [--appearance light|dark] [--find text] [--source yes] [--outline no] [--embedded yes] [--text-size n] [--review previous|n] [--inspect n[:actual]] <file.md | open request>
"$APP" --return-check <open request>
```

- `--export-image` renders the page with the real stylesheet and writes a PNG of its top part.
  With `--review` it writes the comparison of the document's revision with revision `n`, or
  with the revision before it (`previous`); `--present` shows that comparison in its window.
  `--present --inspect n` opens the inspection of the document's image `n`, counted from 1, at
  Fit, and `n:actual` at actual size.
- `--verify` runs a fixed list of WebKit checks on this Mac and exits nonzero on a failure.
  Each check has a 30-second deadline. If a check exceeds it, the report includes its exact name,
  its last stage and the completed checks; the process then exits nonzero without starting another
  check over unfinished effects. The checks cover:
  content scripts do not run; nothing reaches a loopback listener from remote images,
  stylesheets, frames or media (a control request proves the listener); the asset scheme serves
  a retained image and refuses traversal, unknown tokens, other hosts, modified retained bytes
  (with a qualified page failure) and a file swapped for a symlink; find moves the selection, including across inline formatting; code copy puts the
  literal on the pasteboard and a forged action copies nothing; web links ask for confirmation; a pinned open
  request shows its revision with the update notice; the folder watcher reports a new revision
  and the position survives the refresh; the position survives a reopen through a reading-state
  file that a second state store reads from disk; each explicit open sets or clears the window's
  origin and supersedes pending loads; pure-CRLF code copy retains its internal line endings;
  tables and their cells fit the page width at narrow and wide sizes, with long inline code
  wrapped without changing its text or the table's font size; the page recovers after its web content
  process is killed.
- `--measure` builds documents of the given sizes from the corpus and reports read, render and
  display times for two opens (each taken right after its open, so the second is a warm open),
  refresh and find latency, and app plus web content memory. `--shapes` adds generated
  documents: many sections, a wide table, long code, many retained images, and for each the
  same opens, refresh and find with the CPU time of the app and of its web content processes
  and their idle CPU in consecutive periods; successive revisions (one refresh, a burst of
  refreshes, publications that a following window loads, with the number of preparations
  that ran); and several reader windows (memory, idle CPU shown and half hidden, CPU while
  resizing above and across the outline width). Check-mode windows lie outside the visible
  screen area, where WebKit can do less work than for a visible window. Idle percentages use
  the actual monotonic elapsed time for each interval, not the requested delay. CPU and memory
  results state complete, partial or unavailable coverage. A failed probe is never zero usage;
  CPU intervals with changed process IDs report only explicitly qualified comparable evidence.
- `--present` opens one visible window in a prepared state for screen capture and keeps running.
  A store folder as its input presents the library on private in-memory reading state.
  `--embedded yes` uses the pane header without terminal placement; `--text-size` selects an index
  in `PageSettings.textSizes`. At compact widths the requested outline opens as a popover;
  presentation waits for its native did-show event before it prints the capture window numbers.
- `--return-check` reads an open request without accepting it, opens its document offscreen with
  the request's origin and runs Return to Rex once with the real platform operations.
- An open request given to `--export-image` or `--present` is read, not accepted.

The app logs open, render, update, recovery and return events under the subsystem
`local.harness.markdown-reader` (`log show --predicate 'subsystem == "local.harness.markdown-reader"'`).

## Pane mode

`Contents/MacOS/MarkdownReader --pane --store <store directory> <document ID>` shows one stored
document in a reader window over the terminal pane that runs the program. It is the program of
that pane for as long as the reader stays open. Standard input and output must be a terminal.
The process checks the store and the document first; a wrong argument ends it with one line on
standard error and a nonzero status, before the terminal changes.

`Contents/MacOS/MarkdownReader --pane <open request.json>` accepts the same existing request
envelope as an ordinary open: `<store>/opens/<name>.json`. It validates the store identity,
document, exact revision and digest through the ordinary intake, then removes only the request
file that it read. A refused request stays in place. The model checks the pinned digest again
when it loads the page, and receives the request's launch origin. A request for an older revision
shows that revision and announces a newer pointer; it does not automatically follow it. An
explicit `:open <document ID>` selects latest and follows revisions, as with the store/document
input. Neither input creates or selects a terminal pane or tab; the caller owns that placement.

The process uses accessory activation: no Dock icon and no visible menu bar. Its menu supplies
the key equivalents of the reader (copy, select all, find, text size, outline, source, code
wrapping, revisions, details and close) for its one document; it opens no other document, no
library and no other window, and it ignores open events.

The terminal shows a placeholder on the alternate screen with the hidden cursor: the title, a
line with the shown document ID, its revision (and a newer revision when one is available) and
the first twelve digits of the bundle's `sourceDigest`, the reader's state, the keys and an open
command line. Document text and error lines reach the terminal only through
`TerminalText`, which removes control, format and separator characters and bounds an error line.
The first row holds a random marker in concealed text; the placeholder replaces its rows in
place, so the first row shows a marker at every moment. `TerminalAnchor` searches the
accessibility text areas of running applications for one whose visible text starts with the
marker in its first row. It reads at most the first 512 characters of a text area's visible
character range, never the rest of its text; a text area without a visible character range does
not qualify. A search runs in rounds: over the application that last showed the marker while it
runs (every eighth round over all of them), otherwise over the frontmost application and then
every application with a window on screen. A round keeps its place between steps, leaves an
application after 2500 nodes or two unanswered requests, and skips the subtrees of web areas,
tables, outlines, lists, browsers and menus, so a slow or large application delays a round but
never keeps it from the others. When the node budget ends an application's walk before its last
window, the next round continues that walk where it stopped (for up to eight applications), so
every window of a large application is reached in turn. When a text area shows the marker, the process prints a new
marker and accepts the element only if it shows the new one within 0.6 seconds; a copy of the
screen elsewhere, such as captured output in another pane, never does, and the round continues
behind it. While following, an element that misses the marker on three consecutive reads counts
as gone. The anchor names no terminal application. Accessibility access is required; a process
that a trusted terminal starts inherits that access, and without it the placeholder says so and
no window opens.

The reader window is a borderless, non-activating panel without a shadow that takes the text
area's frame. It moves to the active Space, joins full-screen spaces and stays out of window
cycling. A click on it gives it the keyboard without activating the reader, so the host stays
the active application, and the first click already acts on the page. While the host or the
reader is active, the window floats; otherwise it sits at the normal level directly above the
host's window, so other applications cover both. While another window of the host below the
floating level lies over the pane, such as its command palette, the reader orders itself below
that window. Content of the host's own window that lies over the pane, such as a floating pane
over a tiled reader pane or another reader's pane, leaves a hole in the reader window: the hole
is transparent, shows that content and passes clicks to the host. The anchor finds such content
among the window's accessibility elements that overlap the pane outside the pane's own
ancestors, and a hole takes the bounds of the element's children. When the pane's environment
offers a stacking command (`docs/conventions/pane-stacking.md`), its reports decide which of
those elements lie above the pane. The reported areas, fractions of the window's layout, reach
the screen through the pane's own container: the highest ancestor of the text area with its
left, right and bottom edges and at most a 64-point title row more above it. Each area is
clipped to the layout and then pairs with at most one element, and each element with at most
one area, when all four edges agree within 6 points or 1.5 % of the layout's size, whichever is
larger; closer pairs win, and an area that they leave out still pairs when another area can
move to a different matching element. An area that matches no drawn element, such as content
that the layout keeps but does not draw, makes no hole, and content below the pane that
overlaps an area makes none either. When no area pairs although drawn content overlaps the
pane, the container does not place the areas where the window draws them, and the hit test
described below decides that scan. The command's output lines follow the contract's size limit:
a longer line is dropped whole, up to and including its newline. A report
that lags behind the screen, for example during a drag, can leave a hole out until it catches
up. Without a stacking command the host's accessibility hit test decides, which is right for
content over a tiled pane but can order two overlapping floating panes wrongly: a host's hit
test can return the first of two overlapping elements rather than the front one. When the holes
together leave nothing of the pane, or the host keeps the pane's element but no longer lists it
among its window's children (for example while another pane fills the window), the window
hides; the mask and that decision use one computation of the visible region.

All accessibility and window-server requests run on one background queue, one step at a time,
so a slow host never stalls the reader's window. Deadlines use the monotonic clock. A search
step starts no new unit of work, one window list or one element visit of at most two requests,
once 0.1 seconds have passed since the step began; the title reads before the search count
towards that time, and the first unit always runs, so every step moves the search forward. A
scan for covering content starts no request after 0.3 seconds or 400 requests, and an
unfinished scan keeps the last holes. A request already waiting can take up to the 0.25-second
messaging timeout. The anchor reads the
frame ten times a second and sixty times a second for a moment after a change or a terminal
resize, and looks for covering content four times a second, after a frame change and after each
stacking report. The window hides when the text area disappears (for example, the host shows
another tab), when the host's window is minimised, hidden, on another Space or not on screen,
and behind a locked screen. A changed title of the host window or of the frontmost window starts
the next round at once; otherwise rounds repeat four times a second at first, then every second
while the host runs and every three seconds while no host is known.

The window starts with `ReaderView` and a compact title, Contents, Edit and Close header.
More Actions holds secondary controls; revision details stay out of the normal reading view.
The outline opens in a popover in narrow panes. More Actions includes a control that returns
the keyboard to the host. Escape outside a text field first ends an image inspection or a
comparison that lies over the document, and otherwise returns the keyboard to the host. Pane
mode follows new revisions for the store/document input or after an explicit `:open`; a pinned
request stays at its selected revision. The model's `followsLatest`
loads a revision as soon as the pointer watcher sees it, with the reader's block, heading and
ratio restoration, and a failed load keeps the shown revision with a warning. The watcher
starts before the first read, and after every load that settles, whether it opened, refreshed,
chose or followed a revision and whether it succeeded or failed, the pointer is checked again,
so a revision published meanwhile is followed or announced without another publication. An
automatic load asks for the exact revision it follows, and a failure stops automatic attempts
at that revision only. The reading position
for the new revision is taken from the page at the moment of replacement, not before the
revision was prepared. While the page scrolls, replacement waits until scrolling has been still
for half a second; while text is selected, the find bar is open or source view is selected,
the update notice waits for
the reader's choice instead. A revision that the reader chooses in the revision menu stays until
the reader returns to the latest one, and a revision whose automatic load failed is not tried
again by itself until the pointer names another revision.

Keys typed into the pane's terminal: `q`, Ctrl-C or Ctrl-D close the reader; `:` starts a
command line; any other key gives the reader window the keyboard. A command line takes
printable ASCII only, at most 64 characters; Backspace edits it, Escape cancels it, and Enter
(carriage return or line feed) runs it. Ctrl-C and Ctrl-D still close the reader inside it.
`:open <document ID>` names a full document ID of the pane's store: the reader captures the
shown document's position and queues its save, then opens the other document in the same
window at its saved position and follows its revisions. A malformed ID, a document that cannot
be read and an unknown command leave the shown document in place with a line that says why.
`:open` with the shown document's ID shows its latest revision. `build.json` declares this
input as `paneOpen` 1. Closing the reader by key, close control, Command-W,
Command-Q, a quit request, a termination signal or an interruption signal captures the reading
position, saves the pending reading state, restores the terminal and ends. A hang-up signal or
the end of input ends it the same way without writing to the terminal. Each wait has a bound on
the monotonic clock: the capture half a second, capture and save together one second, and each
write at the end a fifth of a second. Terminal output and standard error go through writers on
their own threads that never change the descriptors' flags, which other processes of the pane
can share; a terminal or pipe that stops reading loses output but never holds the process, and
the process ends without exit handlers that could wait for such output. The exit status is 0
when the state was saved or had nothing to save. Otherwise it is 1, and one line on standard
error, after the restored screen, says that the reading position was not saved (the save
failed or never started) or may not have been saved (the deadline passed during the write, or
the final capture did not finish); a pane that closes only on success keeps that line, and the
last saved position stands. The placeholder places each line by row
and stops at the last row, so a short pane keeps the marker on screen. The document, its
revisions and the saved reading position never depend on the process: opening the document
again restores the saved position.

## Headless core tool

`Contents/MacOS/markdown-core references` reads UTF-8 Markdown on standard input (at most the
2 MiB source limit) and prints `{"version":1,"images":[…],"links":[…],"truncated":false}`: the
image and link destinations exactly as cmark reports them, in document order, without
duplicates, at most 4096 per list. It uses only `MarkdownCore`. Publication uses it to build the
reference inventory, so there is one Markdown parser.

## Structure

| Target | Responsibility | Frameworks |
| --- | --- | --- |
| `MarkdownCore` | store records and reading, identities, open requests, asset resolution, rendering through cmark-gfm, source blocks and revision comparison, page template and stylesheet | Foundation, CryptoKit, cmark |
| `ReaderFeature` | the reader view and per-window reading state, reading-state store, library view | SwiftUI, WebKit |
| `MacPlatform` | pasteboard, browser hand-off, Finder reveal, pane helper runner, Rex activation, terminal anchor, pane stacking feed and printable terminal text | AppKit, Accessibility |
| `MarkdownReader` | application entry: windows, menus, open intake, pane mode, check modes | AppKit, SwiftUI |
| `markdown-core` | headless reference inventory | MarkdownCore only |

The reader feature receives platform effects as a small `ReaderPlatform` value and does not
assume it is the only screen of the app. Each window owns one model and one `WebPage`.

## Content safety

- Markdown is the record; HTML is derived. cmark renders in its safe mode, and the core replaces
  raw HTML with escaped literal text, links outside `http`, `https` and in-page anchors with inert
  text, and every image with a served local address, an inline `data:` image (PNG, JPEG, GIF,
  WebP up to 1 MiB) or a visible placeholder (remote images are never loaded; their address
  stays visible). Unknown fences and front matter show as labelled code.
- The web view uses a nonpersistent data store, disables content JavaScript and loads a page
  with `default-src 'none'`. Only the app's own `reader-asset:` scheme serves the stylesheet and
  the images of the current rendering, by token. A stored revision's images resolve only through
  its `retained` inventory entries under its own `assets/` directory; a plain file's images
  resolve under its folder by canonical path. Each image is checked again when served: canonical
  path inside that root, allowed media type, at most 8 MiB, read through a descriptor opened
  without following a symbolic link that must be a regular file. Retained images must match the
  revision's recorded SHA-256 digest and byte count. A cached hash is reused only for the same
  opened file's device, inode, size, and nanosecond modification and change times; the evidence
  must agree before and after the read. Plain-file images continue to use the file's folder.
  Resolved, served and decoded images are separate facts. App-owned decode inspection adds a
  visible qualified placeholder when serving or decoding fails; the original is never repaired
  from a project file. Image inspection runs separately after the page is ready and its position
  is restored, with a two-second evidence deadline. It never holds installation. Its results and
  DOM effects belong to that rendering only. The app retains its named WebKit content world so
  decode evidence survives separate DOM calls, including a later Details inspection. Each page
  keeps its own evidence, and navigation clears it. Decode results use rendering and asset tokens,
  not the lifetime of JavaScript wrappers for DOM elements. A decode that has not settled stays unconfirmed,
  not failed, and opening Details reads the evidence again.
  Details retain capture inspection, partial coverage and per-image states.
- The store reader requires the document directory, the revision directory and its `assets/`
  directory to be the expected paths under the canonical store root, with no symbolic link below
  the root. It reads `document.json`, `revision.json`, `source.md` and assets without following a
  symbolic link and accepts only regular files. These checks bind the checked paths and the
  opened files, not a concurrent replacement of a parent folder: a process of the same user that
  replaces a parent folder between the path check and the open is outside this guarantee.
- Every navigation is decided: the document load passes; in-page anchors use the reader's
  position-aware jump action; web links open in
  the browser only after confirmation; code-copy and image-inspection actions carry a
  per-rendering nonce;
  everything else is cancelled. App DOM helpers run only through `callJavaScript` in the
  `markdown-reader` content world with data arguments. There is no script message handler.
- Limits: source 2 MiB; store records 256 KiB; image 8 MiB; reading-state file 1 MiB (a larger
  or undecodable file is ignored and left in place); listings read at most 2000 directory entries
  per collection and say when they stopped.

## Licences

`Licenses/swift-cmark-COPYING` is the notice of swiftlang/swift-cmark 0.9.0 (the only package
dependency). The build copies it into `Contents/Resources/Licenses/`.
