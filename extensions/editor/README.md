# Editor

From interactive Pi in a local Rex pane on macOS, run `/editor [folder or file]`. It connects this Pi session to an open Editor for that folder, even if the pane is hidden. It prefers a visible pane, then the last pane to become visible, then the most recently started pane. If no Editor is open for the folder, it opens a new split to the right. With no argument it uses the current directory. A file argument opens that file in the selected pane. Click in the source to edit; `cmd+S` writes the shared draft to disk.

To work with another agent, ask that ordinary Pi session or Durable conversation to join the same folder with the `editor` tool. No extra pane opens. Right-click a character, selection, file, folder, tab, pane or setting and choose its note action. Write a note, choose the recipient, then click **Send Request**. **Post Note** keeps the thread without sending it. To send a later reply to another participant, select their name in that thread. A receipt confirms delivery, not completion.

A participant can read the unsaved draft, edit an exact passage, annotate a different file, or put a new tab beside your files. For example, ask one agent for a map of a folder. Its tab can mix explanations, code and buttons that open particular lines. Ask another agent to change a passage from the map. You see the changed draft before you decide to save. A composed tab contains data, not executable code, and does not take focus when an agent publishes it.

## Look and settings

- Editor paints every surface from the shared Catppuccin palette and follows the machine's [pane appearance](../../docs/conventions/pane-appearance.md): System, Light or Dark, and Frappé, Macchiato or Mocha for the dark appearance. A choice in Editor reaches the Markdown reader and Explorer, and their choices reach Editor.
- **Settings** (`cmd+,`) shows the theme choice and every setting as a typed control: font family, size, line spacing, ligatures and interface size; caret style and width; line numbers, fold buttons, change marks, minimap, indent guides, rulers, whitespace and wrapping; tab width, spaces or tabs, indentation detection, automatic indentation and closing pairs; save cleanup; reopened tabs and previews. A change applies to every open pane at once. A language selector edits the values of one language, such as wrapping for Markdown.
- The settings live in `<agentDir>/editor/settings.json`, which holds only the values that differ from the defaults, with per-language values under `languages`. The file accepts comments and trailing commas. Editor applies a change to the file at once, whether Settings, a person or an agent made it, and Settings lists any value it ignored and why.
- `cmd+=`, `cmd+-` and `cmd+0` change the font size. The command palette (`cmd+shift+P`) lists every command with its shortcut, and toggles the view settings.

## Working with files

- The sidebar shows **Open Files** above **Folders**. Its header switches between project files (`cmd+O`), project search, local Git and conversations (`cmd+option+T`); `cmd+K cmd+B` or the button at the left of the status line hides it. File icons show the type, and badges show Git changes.
- A click in the tree previews a file in an italic tab that the next preview replaces; a double-click or an edit keeps it. The menu of a file or folder creates, renames (`F2`), duplicates, moves, copies the path of, reveals or deletes it. Deletion moves the entry to the macOS Trash after a confirmation that names any unsaved drafts, and keeps those drafts. Drag a file onto a folder to move it, or onto a tab strip or page edge to open it there. Open tabs and drafts follow a renamed or moved file.
- `cmd+N` starts an untitled scratch and `cmd+shift+N` a new file. New File, New Folder, Duplicate and Move ask for a project path; Tab completes folder names.
- Save (`cmd+S`) writes a named file in place. Save on an untitled tab, and Save As (`cmd+shift+S`), open the macOS save sheet in the file's folder, or in the workspace root for an untitled tab. Choose a destination inside the workspace. If you confirm Replace, Editor checks that the destination file has not changed and has no unsaved draft. A different path leaves the original file intact.
- Closing a tab with unsaved changes offers **Save**, **Keep as draft** and **Discard changes**. **Save** writes a named file in place and opens the same sheet for an untitled tab; Cancel keeps the tab open. A clean open draft adopts changes to its file on disk. If a writer changes its file while the draft has unsaved edits, Editor keeps the draft and offers **Reload from disk**, **Save as…** and **Keep my draft**.
- The status line shows the Git branch, the caret line and column, the selection, and the indentation, language, line endings and encoding of the file. Click the indentation or the language to change it. A save, a posted note or an accepted request shows there for a few seconds; a problem stays above the stage until you dismiss it.
- The local Git panel shows the branch, changed files and file diffs. Git reads disk, not unsaved drafts. Editor does not stage, commit or contact a remote.
- Text files must be valid UTF-8 and no larger than 2 MiB. Editor retains a file's mode and UTF-8 BOM. The draft uses LF; Save uses the first newline convention found in the original file. Symbolic links and version-control internals are not editable.

## Navigating and searching

- `cmd+P` finds a project file by fuzzy match and previews each result as you move through the list; Return keeps it and Escape returns to the tab you had. Add `:line`, `@symbol` or `#text` to go further inside the file. `control+G` goes to a line and `cmd+R` to a symbol of the current file.
- `cmd+F` opens Find at the bottom of the page and `cmd+option+F` adds Replace. Both take regular expressions, case, whole word, in-selection and wrap options and show the match count. `cmd+G` and `cmd+shift+G` move between matches, `cmd+E` uses the selection, Find All selects every match, and Replace All is one undo step.
- `cmd+shift+F` searches the project, including unsaved drafts. **Where** takes comma-separated folders and globs such as `src/, *.ts, -*.test.ts`. Results group by file with context; a click or `F4` opens a match. Replace All changes drafts only, so you review each file before you save it.

## Source editing

- The gutter shows line numbers, fold buttons and change marks against the last Git commit. The current line, indent guides, rulers, matching brackets in one colour per kind, and other occurrences of the selected word are marked as you move. The caret animates separately from the source. On a wide page the minimap shows the file with Find results and changes; click or drag it to scroll.
- `cmd+click` adds a caret, `option+drag` makes a column selection, `cmd+D` selects the word and then its next occurrence (`cmd+K cmd+D` skips one), `control+cmd+G` selects every occurrence, `cmd+shift+L` splits a selection into lines, and `control+shift+up` or `down` adds a caret. Typing, deleting, pasting and line commands apply to every selection as one undo step; Escape returns to one selection.
- Line and selection commands include toggle comment (`cmd+/`), indent (`cmd+]`, `cmd+[`), move lines (`control+cmd+up`, `down`), duplicate (`cmd+shift+D`), delete line (`control+shift+K`), join lines (`cmd+J`), select line (`cmd+L`), expand to brackets (`control+shift+M`), jump to the matching bracket (`control+M`), case conversion, sorting and more in the command palette. Return keeps the indentation and indents after an opening bracket; brackets and quotes close in pairs.
- Fold a block from the gutter or with `cmd+option+[`; folding never changes the draft. Editor detects the indentation of each file, and save cleanup (trailing spaces, a final line break) is one undoable edit before the save.
- Colours follow the language of the file, including multi-line comments and strings and the language named by a Markdown code fence. Unknown file types stay plain.

## Layout

You arrange a pane with the pointer. The arrangement belongs to that pane: it changes no draft, thread or file, and no other participant sees it.

- Drag the line between the sidebar and the stage to change the sidebar's width, or double-click it to fit the longest name. Editor keeps the width for later panes on this Mac; a narrow pane limits it, and the chosen width returns when there is room.
- The stage holds up to four tab groups: one to four columns (`cmd+option+1` to `4`), two or three rows (`cmd+option+shift+2`, `3`) or a grid of four (`cmd+option+5`). Drag a tab along its strip to reorder it, to another strip to move it, or to the edge of a page to split there; Escape cancels the drag. Drag a divider to resize groups, or double-click it to even them. `control+1` to `4` focuses a group, and `control+shift+1` to `4` moves the tab there.
- A tab closes with its control, the middle mouse button, `cmd+W` or its menu; `cmd+shift+T` reopens the last closed tab. A draft with unsaved changes shows a dot in place of the close control until the pointer is over the tab.
- A location button in a composed tab shows its file in another group, so the composed tab stays on show. A composed tab that an agent publishes joins the group that holds your other composed tabs.
- With **Reopen tabs** on, Editor keeps each folder's layout, tabs, sidebar, open folders, selections and scroll positions, and restores them when you open the folder again. A file named in `/editor` opens in front of the restored tabs.
- A pane narrower than 480 points shows the sidebar or the stage, not both.

## Shared drafts and threads

The same canonical folder and Pi agent directory identify a workspace. Sessions and tabs share draft revisions, discussion threads and composed views. Other folders get separate workspaces. Text anchors retain the quote and revision they refer to; old text never becomes a note about whatever now occupies its offsets. Non-text notes identify the selected object directly.

Typing updates the native text view immediately. After a pause, or before a dependent action, Editor sends a guarded edit to the shared draft. If another participant changed that revision first, **Keep both** puts your local text in a scratch and shows the shared revision in the original tab. If a writer outside Editor changed the file on disk, use **Save as…** to preserve the draft at a separate path.

Editor stores drafts and threads in a private SQLite workspace beneath `<agentDir>/editor/`, outside the project, with the arrangement of the folder beside them. The pane keeps working when its opening Pi session ends, until you close the Editor pane or its terminal tab. Use `/editor` in another session to connect it. The pane shows the session last selected or attached, if it is still connected. Reopen the same folder to recover shared revisions, request state and files changed during each thread's latest request.

The first open for a new set of app sources builds Editor with the macOS 26 Swift 6.2 toolchain and installs it in `<agentDir>/editor-apps/`. Other sessions with the same sources reuse it. Pi reports whether Editor opened, loaded in a hidden tab or connected to an existing pane. For a connection to a hidden pane the receipt says “in another tab”. If an open pane does not accept the connection, Pi reports the problem without opening a duplicate. A failed build names its log; a startup failure reports the problem in Pi. The native panel follows its split when it moves or resizes. If you switch tabs while it opens, the workspace stays in its original split until you return. If Editor reports an Accessibility permission error, grant the permission indicated and reopen Editor from the visible Rex tab.

## Agent tool

Ordinary and Durable sessions use the same `editor` tool. Each successful operation returns a structured object. `root` defaults to the caller's working directory; use the root from an invitation to join its exact workspace.

| Operation | Result or effect |
| --- | --- |
| `join`, `members` | Connect silently, or list live participants in this folder. Other tool operations also connect the caller. |
| `state` | List draft, view and thread headers. Continue a page with `nextOffset` as `offset` and the returned `seq`. |
| `tree`, `files`, `search`, `git` | Inspect a directory page, list the project's files (inside a Git work tree, the tracked and unignored ones), look for paths or text, or read local Git information. Text search reads unsaved drafts and takes `caseSensitive`, `wholeWord`, `regex`, `include`, `exclude` and `contextLines`. |
| `replace`, `revert` | Replace text across files as new draft revisions, never on disk, or return a draft to its disk text. |
| `read` | Read the current draft. Continue with `nextOffset` as `offset` and the same `rev`. Offsets count UTF-16 units. |
| `new`, `edit`, `patch`, `save` | Create a draft, replace a unique literal, splice a range or write to disk. Edits and saves require the exact document revision. |
| `note`, `thread`, `reply` | Start an anchored thread, read it or post to it. Text notes take `doc`, `rev`, `start` and exclusive `end`. Other notes take `target: {kind, key}`. |
| `compose`, `view` | Create or read a named tab. `blocks` contain `text`, `code` or `location` entries. A location has a relative `doc`, a positive `line` and a button label in `text`. Use both `id` and `rev` to update a tab. |
| `show` | Send `doc` and optional `line`, UTF-16 `start` and `end`, or `message` to open panes. Returns the number of panes that accepted it. It does not open a new pane. |

Only the person in the native pane sends a request; an edit, note, new view or `show` never wakes a model. Ordinary Pi receives an [application message](../../docs/conventions/application-messages.md); Durable receives an input on the selected conversation. A text request includes the file, original one-based range and quoted context. With unsaved changes in the draft, use `editor read` and change the draft through the Editor tool. If the draft is clean, ordinary file tools also work.

Editor posts the answering run's visible final text to the thread unless the session already used `editor reply` for that request. Answers over 4 KiB are cut at a character boundary and marked. Durable capture reads the exact submission's answer while that host is available. If that host stops before Editor sees the answer, the conversation can still post with `editor reply` after it reconnects.

## Pane service

The v2 one-use launch ticket names `node`, `program`, `root`, `agentDir`, `paneId` and the opening `participant`, plus optional `file`, `settings` and `layout`. The app runs `pane-program.ts` with that Node executable. It writes `{root, agentDir, paneId, participant, appPid}` as one JSON line on stdin. The service replies with one JSON line `{port, token}`. The app keeps stdin open and calls `POST /api` on `127.0.0.1` with the bearer token. EOF stops the service. If the child exits unexpectedly, Editor restarts it once and keeps the draft view open with an error if that also fails. Editor does not replay a write whose outcome is unknown.

Before the workspace loads, the app reports a fatal startup error as one bounded UTF-8 line in the private `<ticketPath>.failure` file. Pi reads and removes it. The app saves the child's stderr in `panes/<paneId>.stderr.log` under the private workspace, with mode `0600`. It keeps the first 64 KiB from each of the two attempts and drains the rest. If the service cannot restart, the problem names the log path; it does not echo stderr. The private workspace keeps one `panes/` record per service. It identifies the app and service processes, control endpoint, load and visibility status and current session. The control endpoint uses a different bearer token from the app endpoint. Writers notify open services after a workspace change. The app reads `events {since}`, which returns immediately if there are changes or waits up to 20 seconds. `since: 0` starts at the current cursor without replay; `state` supplies the current session and live members. If the event cursor is outside the retained window, the app refreshes from state. `session {id}` selects a live member or clears the selection with `null`.

Pi's built-in `edit` and `write` report their changes with the writer and, during an invitation, its thread. For other writers the service checks file metadata in bounded batches only for open files. A file event includes `rev` only if the service adopted new draft text while it processed that report. `rev` is the revision it created. Use `by` to attribute that exact change, not another revision. Without `rev`, `by` identifies the reported disk writer but does not attribute a draft change. Disk adoption records `Disk` as the draft author.

## Native tests

On macOS with Command Line Tools rather than Xcode, give SwiftPM the path to the bundled Testing framework. Disable cross-import overlays because the tools do not ship the `_Testing_Foundation` module interface.

```sh
frameworks="$(xcode-select -p)/Library/Developer/Frameworks"
swift test --package-path extensions/editor/native --disable-xctest \
  -Xswiftc -F -Xswiftc "$frameworks" -Xswiftc -Xfrontend -Xswiftc -disable-cross-import-overlays \
  -Xlinker -rpath -Xlinker "$frameworks"
```
