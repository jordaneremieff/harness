# Explorer native app

Explorer is a macOS app with a WKWebView page and a local Swift package for pane placement. The terminal placeholder shows the folder, file and build. Press `q` in the terminal to close, or another key to focus the Explorer window. Use `:open --root <folder> [--path <file>] [--line <line>]` to navigate in the same pane. An argument with spaces or quotes uses JSON double-quote syntax.

## Host and bridge

`ExplorerHost` follows the terminal pane and connects the page to the workspace, notes helper and live Pi route. The main frame sends versioned requests to the reply-capable `explorer` message handler. The host sends events to `explorer.receive`. A root change includes the new root metadata in the `open` event.

The app scheme serves installed HTML, scripts, styles and supporting files. The page content policy disables network requests, frames and inline scripts. The asset scheme accepts opaque image references from the current workspace. It serves supported image types with a separate restricted policy. Navigation outside the bundled page is refused. File reads reject absolute paths, traversal and links that leave the workspace. Git runs without a shell, with optional locks, external diff drivers and repository hooks disabled.

`Workspace` reads files and computes Git reviews. Text reads return at most 4 MiB, with a notice on truncated previews. Image reads stop at 32 MiB. A file list is limited to 200,000 paths. Search returns at most 2,000 results and uses a bounded scan for paths not covered by Git. `ExplorerWatch` coalesces file and repository changes through FSEvents.

`NotesHelper` runs the bundled Node writer with a 1 MiB request limit, a 16 MiB response limit and a ten-second deadline. The writer owns note, review and recent-root records. The host saves page preferences, positions and unsent card drafts as private records. A draft belongs to one root and file. A normal close gives the page a brief opportunity to finish pending draft writes. `LiveClient` consumes a one-use private file and sends authenticated requests only to its loopback endpoint. It does not follow redirects. A pane without a live connection still reads and saves notes.

## Build and checks

From the repository root, run `node extensions/explorer/native/build.mts` to build and install the app. Use `PI_EXPLORER_APP` to select a private install path instead of the configured app location. Run `node extensions/explorer/native/build.mts test` for the Swift tests. The app bundle contains its web page, notes helper and build manifest.

Run the binary inside the bundle with `--pane --store <directory> --root <folder>`. Pass `--path <relative-path>` and `--line <line>` to select a location. Pane mode requires a terminal.

Run the same binary with `--verify` to drive the bundled page through its real bridge, a disposable Git repository, a notes store and a local test endpoint. Run it with `--export-image --out <png> --width <points> --height <points> --root <folder>` to export a WebKit image. Add `--appearance dark|light`, `--path <relative-path>`, `--line <line>` or `--script <file.js>` as needed. Both checks use a transparent window without app activation or keyboard focus.
