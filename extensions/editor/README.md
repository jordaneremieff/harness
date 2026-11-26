# Editor

`/editor [folder or file]` opens the folder in your default browser on macOS and connects the current Pi conversation. With no argument it opens the current directory. A file argument also opens that file. You edit a shared draft; **Save** writes it to disk.

To work with another agent, ask that ordinary Pi session or Durable conversation to join Editor for the same folder. It uses the `editor` tool without opening another window. Right-click a selection, file, folder, tab, pane or setting, choose **Engage a session**, and pick its name. **New note** keeps a thread without sending anything. You can send a later message in the same thread to a different participant. Only the selected conversation gets the request. A delivery receipt means it accepted the request, not that it finished the work.

A participant can read the unsaved draft, edit an exact passage, annotate a different file, or put a new tab beside your files. For example, ask one agent for a map of a folder. Its tab can mix explanations, code and buttons that open particular lines. Ask another agent to change a passage from the map. You see the changed draft before you decide to save. A composed tab contains data, not executable code, and does not take focus when an agent publishes it.

## Working with files

- Expand a folder to load its children. Use **Open file** (`cmd+P`) for a path, **Search** for literal text across files, or **Find** (`cmd+F`) in the open file. Search and large listings mark partial results. They do not build a project index on startup.
- Use **New** for an untitled scratch or a new file. Scratch drafts live with the folder until you use **Save As** with an unused path. The destination folder must exist. An existing file's **Save As** leaves the original intact.
- Use **Git** for the local branch, changed files and a file's diff. Git reads disk, not unsaved draft text. Editor does not stage, commit, contact a remote or import review comments.
- Text files must be valid UTF-8 and no larger than 2 MiB. Editor retains a file's mode and UTF-8 BOM. The draft uses LF; Save uses the first newline convention found in the original file. Symbolic links and version-control internals are not editable.

## Shared drafts and threads

The same canonical folder and Pi agent directory identify a workspace. Sessions and tabs share draft revisions, discussion threads and composed views. Other folders get separate workspaces. Text anchors retain the quote and revision they refer to; old text never becomes a note about whatever now occupies its offsets. Non-text notes identify the selected object directly.

Typing changes the local editor immediately. The tab sends a guarded splice to the shared draft after a short pause or before an action that needs the current revision. If another participant changes the same revision first, the editor keeps the local text. **Keep as Scratch** preserves that version separately. Save checks the last known disk contents before replacing an existing file. If an outside writer changed the file, the draft and the disk copy stay separate. This is conflict detection, not a lock on other programs.

Editor stores drafts and threads in a private SQLite workspace beneath `<agentDir>/editor/`, outside the project. A Pi session starts its loopback browser service only when you open Editor. The launch link is private; do not share it. The browser does not load scripts, fonts or editor content from other sites. Closing the Pi session disconnects its tabs and its participant. Reopen the same folder to recover the last shared revision. Text that the browser has not yet shared belongs only to that tab.

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

Only the person in the browser sends a hand-off; an edit, note or new view never wakes a model. Ordinary Pi receives an [application message](../../docs/conventions/application-messages.md); Durable receives an input on the selected conversation. Participants post to the thread with `reply`, whether or not they also edit the draft. A final chat message alone does not change the thread.
