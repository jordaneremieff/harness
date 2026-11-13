# Markdown Reader (native Mac app)

A native reader for Markdown documents that the Markdown extension saves: agent responses,
published documents and file snapshots. It also opens plain `.md` files in place. The app reads
the document store and never writes documents; its only change inside a store is the removal of
an open request it accepted. Its own reading state (positions, recent documents, known store
folders, text size) lives in `~/Library/Application Support/Markdown Reader/` and is bounded;
trimming it never touches a stored document. The application and every [pane mode](#pane-mode)
reader share that state: each process records the entries it changed since its last save, a
save takes an exclusive lock on `reading-state.lock`, applies only those changes to the file's
current state and replaces the file, and an opening reads the file again before it restores a
position. A changed position yields only to one in the file saved at least a second later,
because the file keeps whole seconds.

Requirements: macOS 26 or later and Swift 6.2 (the Command Line Tools are enough). SwiftUI's
`WebView` and `WebKit.WebPage` need macOS 26.

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
{"contract": 1, "pane": 1, "sourceDigest": "sha256:…", "builtAt": "…", "swift": "…",
 "store": "/…/markdown", "terminalOrigin": {"helper": "terminal-origin.ts", "node": "/opt/homebrew/bin/node"}}
```

Openers compare `contract` with the version they expect and name this command as the remedy for
a missing or incompatible build. `contract` covers open requests, the store format and the
parser output. `pane` is the version of [pane mode](#pane-mode); the publication tool offers a
pane command only when it matches, and otherwise names this build command. Programs that only
open documents ignore it, so Pi processes that started before a rebuild keep opening documents
with the new build. An unknown `--` option ends the app with a usage error, so a caller that
expects a newer mode never starts the library application instead. `store` is the value of the `markdown.dir` setting at build
time (`PI_MARKDOWN_DIR`, else `markdown.dir` in `harness.json`, else `<agent dir>/markdown`): the
store folder that the library shows by default. Rebuild after you change that setting.
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
digest, the reference inventory), `MacPlatformTests` (the pane helper runner against fake helper
scripts: each outcome, a timeout, malformed output, refusal, an oversized origin and a helper that
closes its input; the pane reader's coordinate conversion, window matching and printable
placeholder text) and `ReaderFeatureTests` (the bounds of the reading-state file and the merging
of saves from several reader processes). Under the Command Line Tools
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
  documents, the published documents of each known store folder, and a bounded listing of saved
  responses and file snapshots that says when its scan stopped. The known store folders are the
  `store` folder recorded in `build.json` and the stores of accepted open requests, which the app
  remembers. Everything stays openable after every producer exited.
- One window per document. A repeated open brings that window forward without rendering again
  unless a load is pending. The last explicit open supersedes pending loads, even when it names
  the revision already on screen. A reopen after closing returns to the saved reading position.

## Reading

Outline (sidebar, hidden below 680 points width), find with next and previous and a not-found
state, text size, code wrapping, Copy for each code block (the parsed code without its
final line break), Copy Markdown (the exact source), Show Source, a revision menu, a compact
provenance line with details on demand (both name the newest revision the window knows), and
labels for partial responses (length limit,
stopped, error) and for text written before tool calls. A response's title comes from its
content (the heading that opens it, else the first text line of its first block); its stored
title is a provenance label and appears in the provenance line.

Code copy keeps CRLF between lines when every line ending in the document source is CRLF.
Sources with mixed line endings copy with LF. Markdown container indentation is not part of the
copied code.

A table cell that holds a sentence keeps a minimum width, and inline code in a cell stays
whole. A table that these rules make wider than the page scrolls sideways in its own region;
every other table shares the page width between its columns. Short cells stay compact, and a
row copies as one line.

The app watches the open document's pointer (or a plain file's folder) and shows "Revision n is
available" without rendering by itself, so a selection or the scroll position never changes
under the reader. Show Latest Revision restores the same block and the offset inside it; when
that block changed it falls back to the start of its section, then to the same relative position,
and says so. A load takes effect only after its page displayed: when an update fails to read or to
display, the window keeps the last good revision, its state and its page (shown again when the web
view lost it) and says that the update failed; a window whose first load fails says why. When the
page's web content process ends, the app reloads the shown revision at the saved position.

The revision menu offers revisions from the document's pointer, at most the newest 50, and says
when older revisions are not listed.

Find uses an app-owned find bar over `window.find` in the app's content world. SwiftUI's find
navigator does work on `WebView` on macOS 26.2, but the menu's Find Next and Find Previous cannot
reach it (the hosted web view does not handle `performTextFinderAction:`), so menu, key and click
would not share one function.

| Action | Menu | Key |
| --- | --- | --- |
| Open file, Library | File | ⌘O, ⇧⌘L |
| Show in Finder | File | ⌥⌘R |
| Copy, Copy Markdown, Select All | Edit | ⌘C, ⇧⌘C, ⌘A |
| Find, Find Next, Find Previous | Edit > Find | ⌘F, ⌘G, ⇧⌘G |
| Show Outline, Show Source, Wrap Code Lines | View | ⌃⌘S, ⌥⌘U, ⌥⌘L |
| Bigger, Smaller, Actual Size text | View | ⌘=, ⌘-, ⌘0 |
| Show Latest, Older, Newer Revision | Document | ⌘R, ⌥⌘[, ⌥⌘] |
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
"$APP" --export-image --out page.png [--width 900] [--max-height 6000] [--appearance light|dark] <file.md | open request>
"$APP" --verify [--out report.json]
"$APP" --measure [--sizes 51200,512000,2097152] [--out report.json] <corpus.md>...
"$APP" --present [--width 960] [--height 900] [--appearance light|dark] [--find text] [--source yes] [--outline no] <file.md | open request>
"$APP" --return-check <open request>
```

- `--export-image` renders the page with the real stylesheet and writes a PNG of its top part.
- `--verify` runs a fixed list of WebKit checks on this Mac and exits nonzero on a failure:
  content scripts do not run; nothing reaches a loopback listener from remote images,
  stylesheets, frames or media (a control request proves the listener); the asset scheme serves
  a retained image and refuses traversal, unknown tokens, other hosts and a file swapped for a
  symlink; find moves the selection, including across inline formatting; code copy puts the
  literal on the pasteboard and a forged action copies nothing; web links ask for confirmation; a pinned open
  request shows its revision with the update notice; the folder watcher reports a new revision
  and the position survives the refresh; the position survives a reopen through a reading-state
  file that a second state store reads from disk; each explicit open sets or clears the window's
  origin and supersedes pending loads; pure-CRLF code copy retains its internal line endings;
  a table that scrolls keeps its sentence width, its compact short cells and its one-line
  rows, and a table that fits uses the page width; the page recovers after its web content
  process is killed.
- `--measure` builds documents of the given sizes from the corpus and reports read, render and
  display times for two opens (each taken right after its open, so the second is a warm open),
  refresh and find latency, and app plus web content memory.
- `--present` opens one visible window in a prepared state for screen capture and keeps running.
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

The process uses accessory activation: no Dock icon and no visible menu bar. Its menu supplies
the key equivalents of the reader (copy, select all, find, text size, outline, source, code
wrapping, revisions, details and close) for its one document; it opens no other document, no
library and no other window, and it ignores open events.

The terminal shows a placeholder on the alternate screen with the hidden cursor: the title, the
reader's state and the keys. Document text reaches the terminal only through
`TerminalText.printable`, which removes control, format and separator characters. The first
line holds a random marker in concealed text. `TerminalAnchor` searches the accessibility text
areas of running applications for the text area whose visible text contains the marker, first
in the frontmost application, then in every application with a window on screen, and after the
first match in that application only. It skips the subtrees of web areas, tables, outlines,
lists, browsers and menus, visits at most 2500 nodes of an application per search and runs the
search off the main thread. It names no terminal application. Accessibility access is required;
a process that a trusted terminal starts inherits that access, and without it the placeholder
says so and no window opens.

The reader window is a borderless, non-activating panel without a shadow that takes the text
area's frame. It moves to the active Space, joins full-screen spaces and stays out of window
cycling. A click on it gives it the keyboard without activating the reader, so the host stays
the active application, and the first click already acts on the page. While the host or the
reader is active, the window floats; otherwise it sits at the normal level directly above the
host's window, so other applications cover both. While another window of the host below the
floating level lies over the pane, such as its command palette, the reader orders itself below
that window. Drawing inside the host's own window, such as one of its floating panes over a
tiled reader pane or another reader pane, stays under the reader: accessibility reports no
stacking order inside a window. All accessibility and window-server
requests run on one background queue, one step at a time, so a slow host never stalls the
reader's window; a search stops after 0.4 seconds. The anchor reads the frame
ten times a second and sixty times a second for a moment after a change or a terminal resize.
The window hides when the text area disappears (for example, the host shows another tab), when
the host's window is minimised, hidden, on another Space or not on screen, and behind a locked
screen. A changed title of the host window or of the frontmost window starts the next search at
once; otherwise searches repeat four times a second at first, then every second while the host
runs and every three seconds while no host is known.

The window shows `ReaderView` with embedded chrome: a compact header with the outline control,
title, provenance line, revision menu, view options, find, Copy Markdown, details, a control
that returns the keyboard to the host and a close control. Escape outside a text field also
returns the keyboard to the host. Pane mode follows new revisions: the model's `followsLatest`
loads a revision as soon as the pointer watcher sees it, with the reader's block, heading and
ratio restoration, and a failed load keeps the shown revision with a warning. While text is
selected or the find bar is open, the update notice waits for the reader's choice instead.

Keys typed into the pane's terminal: `q`, Ctrl-C or Ctrl-D close the reader; any other key
gives the reader window the keyboard. Closing the reader by key, close control, Command-W, a
termination signal or an interruption signal saves the reading position, restores the terminal
and ends with status 0. A hang-up signal or the end of input ends it the same way without
writing to the terminal. The final position capture gets one second; after that the last saved
position stands. The placeholder places each line by row and stops at the last row, so a short
pane keeps the marker on screen. The document, its revisions and
the reading position never depend on the process: opening the document again restores the
saved position.

## Headless core tool

`Contents/MacOS/markdown-core references` reads UTF-8 Markdown on standard input (at most the
2 MiB source limit) and prints `{"version":1,"images":[…],"links":[…],"truncated":false}`: the
image and link destinations exactly as cmark reports them, in document order, without
duplicates, at most 4096 per list. It uses only `MarkdownCore`. Publication uses it to build the
reference inventory, so there is one Markdown parser.

## Structure

| Target | Responsibility | Frameworks |
| --- | --- | --- |
| `MarkdownCore` | store records and reading, identities, open requests, asset resolution, rendering through cmark-gfm, page template and stylesheet | Foundation, CryptoKit, cmark |
| `ReaderFeature` | the reader view and per-window reading state, reading-state store, library view | SwiftUI, WebKit |
| `MacPlatform` | pasteboard, browser hand-off, Finder reveal, pane helper runner, Rex activation, terminal anchor and printable terminal text | AppKit, Accessibility |
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
  without following a symbolic link that must be a regular file.
- The store reader requires the document directory, the revision directory and its `assets/`
  directory to be the expected paths under the canonical store root, with no symbolic link below
  the root. It reads `document.json`, `revision.json`, `source.md` and assets without following a
  symbolic link and accepts only regular files. These checks bind the checked paths and the
  opened files, not a concurrent replacement of a parent folder: a process of the same user that
  replaces a parent folder between the path check and the open is outside this guarantee.
- Every navigation is decided: the document load and in-page anchors pass; web links open in
  the browser only after confirmation; app actions (code copy) carry a per-rendering nonce;
  everything else is cancelled. App DOM helpers run only through `callJavaScript` in the
  `markdown-reader` content world with data arguments. There is no script message handler.
- Limits: source 2 MiB; store records 256 KiB; image 8 MiB; reading-state file 1 MiB (a larger
  or undecodable file is ignored and left in place); listings read at most 2000 directory entries
  per collection and say when they stopped.

## Licences

`Licenses/swift-cmark-COPYING` is the notice of swiftlang/swift-cmark 0.9.0 (the only package
dependency). The build copies it into `Contents/Resources/Licenses/`.
