# Editor

From interactive Pi in a local Rex pane on macOS, run `/editor [folder or file]`. Editor opens in a new split on the right of that Pi pane. With no argument it opens the current directory. A file argument also opens that file. Click in the source to edit; **Save** writes the shared draft to disk.

To work with another agent, ask that ordinary Pi session or Durable conversation to join the same folder with the `editor` tool. No extra pane opens. Right-click a character, selection, file, folder, tab, pane or setting and choose its note action. Write a note, choose the recipient, then click **Send Request**. **Post Note** keeps the thread without sending it. To send a later reply to another participant, select their name in that thread. A receipt confirms delivery, not completion.

A participant can read the unsaved draft, edit an exact passage, annotate a different file, or put a new tab beside your files. For example, ask one agent for a map of a folder. Its tab can mix explanations, code and buttons that open particular lines. Ask another agent to change a passage from the map. You see the changed draft before you decide to save. A composed tab contains data, not executable code, and does not take focus when an agent publishes it.

## Working with files

- The four buttons on the left of the toolbar each show a panel in the sidebar: project files (`cmd+O`), project search (`cmd+P`) for paths or text, local Git, and conversations (`cmd+option+T`). The button of the panel on show hides the sidebar.
- The project files panel shows the folder as a tree. A folder opens under its own row, and Editor reads it at that moment. A folder with more entries than one page ends with a **More files…** row. The refresh control reads the tree again and keeps the open folders open. Search and large listings mark partial results.
- Find (`cmd+F`, **Find…** in the menu of the source, or **Find in this file…** in workspace actions) searches the open file.
- Press `cmd+N` for an untitled scratch or `cmd+shift+N` for a new file. **New file in this folder…** in the menu of a folder in the project tree starts the path with that folder. Scratch drafts live with the folder. Save As (`cmd+shift+S`) requires an unused path in an existing directory. An existing file’s Save As leaves the original intact.
- The local Git panel shows the branch, changed files and file diffs. Git reads disk, not unsaved drafts. Editor does not stage, commit or contact a remote.
- The status line confirms a save, a posted note or an accepted request for a few seconds. A problem or a conflict appears above the stage and stays until you dismiss it.
- Text files must be valid UTF-8 and no larger than 2 MiB. Editor retains a file's mode and UTF-8 BOM. The draft uses LF; Save uses the first newline convention found in the original file. Symbolic links and version-control internals are not editable.

## Layout

You arrange a pane with the pointer. The arrangement belongs to that pane: it changes no draft, thread or file, and no other participant sees it.

- Drag the line between the sidebar and the source to change the sidebar's width. The line lights up under the pointer. Double-click it to fit the width to the longest listed name.
- Editor keeps the width you chose for later panes on this Mac, as a preference of the Editor app. A narrow pane limits the width so that the source stays usable; the chosen width returns when the pane has room again.
- Drag a tab along its strip to change its place. The other tabs make room while you drag. Press Escape to leave the tab where it was.
- A tab closes with its close control, with the middle mouse button or from its menu. A draft with unsaved changes shows a dot in place of the close control until the pointer is over the tab.
- Drag a tab to the left or right part of the page to give it that side of the stage; a mark shows the side before you let go. With two sides, drag a tab to the other strip or page to move it across. Drag the line between the sides to change their widths, or double-click it to make them equal. A side goes away with its last tab. The tab menu offers the same moves.
- A location button in a composed tab shows its file on the other side when the stage has two sides, so the composed tab stays on show. A composed tab that an agent publishes joins the side that holds your other composed tabs.
- A pane narrower than 480 points shows the sidebar or the stage, not both.

## Shared drafts and threads

The same canonical folder and Pi agent directory identify a workspace. Sessions and tabs share draft revisions, discussion threads and composed views. Other folders get separate workspaces. Text anchors retain the quote and revision they refer to; old text never becomes a note about whatever now occupies its offsets. Non-text notes identify the selected object directly.

Typing updates the native text view immediately. After a pause, or before a dependent action, Editor sends a guarded edit to the shared draft. If another participant changed that revision first, **Keep both** puts your local text in a scratch and shows the shared revision in the original tab. If a writer outside Editor changed the file on disk, use **Save as…** to preserve the draft at a separate path.

Editor stores drafts and threads in a private SQLite workspace beneath `<agentDir>/editor/`, outside the project. Each pane connects to its opening Pi through a private loopback endpoint and consumes a one-use launch file. There is no browser interface. Closing Pi disconnects that pane and its participant. Reopen the same folder to recover shared revisions; unsent local text belongs only to its pane.

The first open for a new set of app sources builds Editor with the macOS 26 Swift 6.2 toolchain and installs it in `<agentDir>/editor-apps/`. Other sessions with the same sources reuse it. A failed build names its log. The native panel follows its split when it moves or resizes. If you switch tabs while it opens, the workspace stays in its original split until you return. If the terminal reports an Accessibility permission error, grant the permission indicated there and reopen Editor from the visible Rex tab.

## Agent tool

Ordinary and Durable sessions use the same `editor` tool. Each successful operation returns a structured object. `root` defaults to the caller's working directory; use the root from an invitation to join its exact workspace.

| Operation | Result or effect |
| --- | --- |
| `join`, `members` | Connect silently, or list live participants in this folder. Other tool operations also connect the caller. |
| `state` | List draft, view and thread headers. Continue a page with `nextOffset` as `offset` and the returned `seq`. |
| `tree`, `search`, `git` | Inspect a directory page, look for paths or text, or read local Git information. |
| `read` | Read the current draft. Continue with `nextOffset` as `offset` and the same `rev`. Offsets count UTF-16 units. |
| `new`, `edit`, `patch`, `save` | Create a draft, replace a unique literal, splice a range or write to disk. Edits and saves require the exact document revision. |
| `note`, `thread`, `reply` | Start an anchored thread, read it or post to it. Text notes take `doc`, `rev`, `start` and exclusive `end`. Other notes take `target: {kind, key}`. |
| `compose`, `view` | Create or read a named tab. `blocks` contain `text`, `code` or `location` entries. A location has a relative `doc`, a positive `line` and a button label in `text`. Use both `id` and `rev` to update a tab. |

Only the person in the native pane sends a request; an edit, note or new view never wakes a model. Ordinary Pi receives an [application message](../../docs/conventions/application-messages.md); Durable receives an input on the selected conversation. Participants post to the thread with `reply`, whether or not they also edit the draft. A final chat message alone does not change the thread.

## Native tests

On macOS with Command Line Tools rather than Xcode, give SwiftPM the path to the bundled Testing framework. Disable cross-import overlays because the tools do not ship the `_Testing_Foundation` module interface.

```sh
frameworks="$(xcode-select -p)/Library/Developer/Frameworks"
swift test --package-path extensions/editor/native --disable-xctest \
  -Xswiftc -F -Xswiftc "$frameworks" -Xswiftc -Xfrontend -Xswiftc -disable-cross-import-overlays \
  -Xlinker -rpath -Xlinker "$frameworks"
```
