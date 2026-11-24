# Explorer

Explorer opens a repository, folder or file in a native window over a Rex pane. Browse files, compare changes, and leave notes on the code. Workers report paths and line numbers instead of opening Explorer unless the operator explicitly requests display.

## Open Explorer

- `/explorer [path]` opens a right split beside the current Pi conversation. With no path, it opens the session’s working directory. Quote a path to distinguish it from a command name.
- `/explorer changes [uncommitted|branch|since-review|<commit>|<base>..<head>|<target>...<head>]` opens a review. Three dots compare the head with its merge base, as merge and pull request diffs do. If you omit the scope, Explorer selects uncommitted changes when present. Otherwise, it selects changes since your last review on the default branch, or compares your branch with the default branch. The first review on the default branch covers its latest commit.
- `/explorer notes` opens the Notes list. `/explorer help [topic]` opens a local usage view in interactive Pi. Page Up and Page Down scroll the report; Escape returns to the editor. The report does not enter the conversation. `/explorer update` installs the app in the background on macOS. Interactive starts and reloads check the installed build against the loaded checkout. If the checkout cannot order the two builds, it leaves the installed app in place. Already open panes keep their build.
- **Explore a Folder…** in the Rex command palette lists recent roots and opens the selected root beside the invoking pane. This route has no live conversation. You can keep notes or copy a review, but cannot send a review to an agent from that pane.

In the file view, use cmd+P for files, cmd+shift+F for repository search, cmd+F for the current file and control+G for a line. Explorer names keys in words, such as cmd+shift+F, in its labels and tooltips.

Text fields keep the standard editing keys: cmd+Z and cmd+shift+Z undo and redo, cmd+X, cmd+C and cmd+V cut, copy and paste, and cmd+A selects the field's text. Control keys such as control+A and control+E move the caret as in other Mac text fields, and Tab accepts a macOS inline text suggestion. Outside text fields, cmd+A and cmd+Z do nothing, so they never select the whole page or undo an edit that is out of view. The file editor keeps Tab for indentation.

cmd+= (or cmd++) zooms in, cmd+- zooms out and cmd+0 returns to actual size; a trackpad pinch also zooms. Zoom scales the whole pane in steps from 50% to 300%. Explorer stores the level, so panes opened later use it; other open panes keep their level. Any level other than 100% shows beside Quick open; select it to return to actual size. A pane narrower than 760 points shows the sidebar as a sheet; zooming in keeps the sidebar until the page itself is too narrow for it. In the terminal placeholder, `q` closes Explorer. On compatible builds, `:open --root …` navigates the current pane without changing its placement.

## Notes, review comments and questions

Select code, or click line numbers, to show the strip with **Ask**, **Comment**, **Note** and **Copy**. A right-click (or Control-click) offers the same actions with copy and navigation items. cmd+D asks about the selection, or about the file when nothing is selected.

- **Ask** sends a question about the lines to the conversation. Its answer appears in the card and stays in the note's thread.
- **Comment** adds a review comment. Review comments wait in the tray at the bottom until you send them together, or send one with **Send now**.
- **Note** keeps a private note on the lines. It reaches the agent only when you reply to it while a conversation is connected.

Each card has one filled button on the right; cmd+return performs it. Text you type and do not save stays with its lines: selecting the same lines again brings it back, and other lines open an empty card. Unsent text also survives closing the pane.

Open a note from its gutter dot, file marker, commit marker, review marker or the Notes list. Marked lines are tinted: yellow for review comments, blue for your notes and questions, mauve for the agent's notes, and teal for imported discussions. Select a marker again to close its single note or switch between notes at the same location. The card arrows (← and →) move through the notes in the current file or review. The header's note toggle hides agent and remote markers without hiding your own.

Use **Reply** to save a reply and send it to the connected conversation. Use **Resolve** or **Reopen** to change the note state. Edit your notes or agent notes in place, and delete a note from any author. In a review, **Comment** on an agent or remote line note starts an operator comment on the same lines. A draft review comment opens in its editor with **Remove**, **Send now** and **Save**. The tray and Viewed ticks appear only in a review. Viewed ticks and unsent comments persist.

Cards render note text, replies and answers as Markdown without raw HTML or images. A file location such as `src/a.ts:12-20` or `docs/b.md#L4`, a line span such as `L12`, `L12-L20` or `lines 12 to 20` (of the note's own file), a commit such as `3b59add` and a two-dot range of commits become links. A location link opens the lines in the Changes view when the review contains the file, otherwise in the File view; a commit or range link opens its review after Git confirms it. The card stays open. A line card opens beside its lines; a card without lines opens against the right and bottom edges. Drag a note card by its header to move it and keep that position for the pane. Double-click the header to restore its default position. Store updates refresh an open note; deleting it closes the card.

## Merge and pull request reviews

Explorer reviews a merge or pull request through Git alone; it holds no platform code. The agent fetches the change, opens its diff as a review range (`target...head` selects the merge base, as review platforms do), and composes its own platform commands around the review operations of `explorer_notes`:

- `note` records the agent's findings. A note may target lines, a file, a commit or the review itself. A review target pins the resolved range or commit in the store, while the receipt returns its ID for a report.
- `import` shows the change's existing discussions as remote notes, with their authors, replies, resolution and links. A comment with lines becomes a line note, a comment with a path but no lines becomes a file note, a comment with a commit becomes a commit note, and a comment without a path becomes a review note. Importing the same discussion again updates it and keeps your local replies.
- `export` returns your line-based review comments with their exact diff positions: old and new path, old and new line at each end, whether each end is an added, removed or unchanged line, and whether the range lies inside a diff hunk. The agent posts them with the platform's own CLI or API.

Add comments by selecting lines in the diff, then send them together. **Copy review** copies the same text. A reply on a remote note reaches the conversation with the note's link, so the agent can post it to that discussion.

## Markdown preview

In the File view, `.md` and `.markdown` files open rendered by default. Use **Preview** to switch between the rendered document and its source. Explorer remembers your choice. **Changes** always shows the source diff.

Find in file searches rendered text in Preview. Go to line switches to source. Notes, comments and Ask stay tied to source lines: select rendered text to act on the corresponding lines, or select the marker on a tinted block to open its note. Line links and search results jump to the matching block. Explorer keeps your reading position when a file changes.

Relative links open files inside the current root. Links to headings scroll the preview, including when a relative file link contains a heading fragment. HTTP and HTTPS links open in the default browser; email links open in the default mail app. Other URL schemes are inactive. Supported local images load from the root; remote images show their alt text instead.

## Files list

The Files list reads one folder at a time, so a folder with many subfolders or repositories shows its complete top level at once, and a folder lists its contents when you expand it. Each listing holds up to 10,000 entries. The list draws only the rows in view and has no row limit. Use ↑ and ↓ to move, → to expand or enter a folder, ← to collapse it or go to its parent, and Enter to open.

Git-ignored files and folders show muted text and icons. Each folder follows the ignore rules of the innermost repository that contains it, and ignored folders start closed. Set `showIgnored` to `false` to hide ignored entries in panes opened afterwards; an open pane keeps the value it started with.

A folder that is a Git repository (an embedded repository, a submodule or a work tree) shows its branch, or its commit when detached. **Open as Root**, in a folder's context menu or beside a repository, makes that folder the pane's root, with its own Changes and notes. The names after **Explorer** in the top bar trace the path from the folder the pane opened with; select one to open that folder as the root again. In a folder that is not a repository, the Changes tab lists the repositories inside it.

Quick Open (cmd+P) and the Files filter search a path index that Explorer builds in the background: Git lists the files of each repository, ignored files left out, and a scan covers folders outside repositories. The index holds up to 200,000 paths and 2,000 repositories, and Explorer labels a partial index. Quick Open shows results from the current index while a newer one builds. The filter also matches every entry the Files list has read, including ignored ones. Content search (cmd+shift+F) searches the root repository first, then the repositories inside it, then other files, for up to about four seconds, and labels incomplete results.

## Settings

<!-- harness:settings:start -->
| Key | Environment | Type | Default | Applies | Constraints | Description |
|---|---|---|---|---|---|---|
| app | `PI_EXPLORER_APP` | path | &lt;agentDir&gt;/explorer-app/Explorer.app | reload | none | Installed native Explorer application. |
| dir | `PI_EXPLORER_DIR` | path | &lt;agentDir&gt;/explorer | reload | none | Private directory for Explorer notes and review state. |
| agentPane | `PI_EXPLORER_AGENT_PANE` | enum | "split" | reload | split, float | Pane in which an ordinary session shows an Explorer location. split names a split on the right of the session's own pane; float names a floating pane over its window. The session reuses its own Explorer pane. Workers report locations without opening a pane unless the operator explicitly requests display. An operator's request for another pane still applies, and /explorer always opens a split. A new or reloaded session applies a change. |
| showIgnored | `PI_EXPLORER_SHOW_IGNORED` | boolean | true | next use | none | Show Git-ignored files and folders in the Files list of a newly opened pane. Direct file access, Quick Open and content search are unchanged. Open panes keep their launch value. |
<!-- harness:settings:end -->

Relative paths for settings resolve against the agent directory. See the [extension configuration contract](../../docs/conventions/extension-config.md).

## Tools

Both cards follow the [emission convention](../../docs/conventions/emissions.md). `explorer_show` shows the requested file and line range or the review target, and distinguishes a confirmed navigation from a prepared or unavailable pane command. The expanded card includes the resolved target and any returned launch arguments or pane input. `explorer_notes` shows the returned list scope or the note operation's outcome. It marks retained excerpts separately from the card's display limit. A bounded notes list has no continuation cursor; use its path or state filter to narrow the request.

`explorer_show` accepts `path`, `line`, `endLine`, `review` and an optional `note: {title?,text}`. A native agent, headless session or worker reports paths and line ranges instead of calling this tool unless the operator explicitly requests display. A review specifies one of `scope`, `commit` or `range`. `base..head` compares the named commits. `base...head` compares their merge base with `head` and fails if they have no common ancestor. Explorer pins a resolved range to commit IDs before it opens or stores it. A note is saved before the pane is moved or a launch command is returned. A result with `moved:true` confirms the live pane accepted the new location. Otherwise `show` supplies argv to run in a pane, `paneInput` supplies navigation text for an existing pane you own when the build supports it, or `showUnavailable` explains why a launch is not offered. The tool does not create or focus a pane. An unconfirmed live navigation does not produce replacement argv. Honour a placement the operator requests; otherwise a native agent uses a split on the right of its inherited pane, while an ordinary session uses its configured pane and reuses its own Explorer pane.

`explorer_notes` accepts a `root` or uses the working directory. Use `list` with optional `path` and `state`, `read` with `id`, `reply` with `id` and `text`, `resolve` or `reopen` with `ids`, and `note` with one note or a `notes` array of 1–64 notes. A note names either lines (`path`, `start`, optional `end`, which defaults to `start`, and optional `side`, `head` by default) or a `target`: `{kind:"file",path,side?}`, `{kind:"commit",commit}` with a full SHA, or `{kind:"review",review:{range|commit|scope}}`. Each note takes `text` and optional `title` and `url`. Top-level `review` supplies the source and scope for line and file notes. A review target resolves its own scope. `note` returns all new `ids`, bounded `notes` previews and `limited`; a single note also has a `note` record. Use `update` with `id`, `expectedUpdatedAt` and at least one of `text` or `title` (`null` clears the title); the update is agent-only and refuses a note that changed after it was read. Use `delete` with `ids`; it is agent-only and removes nothing unless every ID is a valid agent note. This tool opens no pane. `list` returns bounded `notes` previews, `limited` and `unreadable`. `read`, `reply` and `update` return a bounded `note` record with its update time and recent replies. `resolve` and `reopen` return each affected note's `id`, `state` and `updatedAt`; `delete` returns removed `ids`. The ordinary Pi and Durable tools return structured results. Durable does not automatically replay interrupted tool calls because a call can write a note or reply, update or delete notes, or move a live pane.

For a merge or pull request, fetch and post discussion with the platform's own commands. Explorer provides the local review operations:

- `import` takes `review` and `comments`. Each comment has `id`, `by`, `text` and either lines (`path`, `start`, optional `end`, which defaults to `start`, and optional `side`), a file (`path` without lines), a commit (`commit`, full SHA), or no path, lines or commit for a review note. Each comment also accepts optional `url`, `resolved` and `replies`. Each reply has `by`, `text` and optional ISO 8601 `at`. Use paths and line numbers from the selected side: `head` by default, or `base`. The receipt returns `created` and `updated` counts, `notes` with each local `id` and `external` ID, and `skipped` with each unanchored comment's `id` and `reason`. Supply identifiers unique to the repository's remote comments.
- `export` takes `review` and optional note `ids`. Without IDs it selects draft and sent operator line notes. The receipt returns the resolved `review` (`base`, `head`, `label`) and `notes` with `id`, `path`, `side`, `start`, `end`, optional `title`, `text`, `state` and `position`. A null position carries a `reason`. A position gives `oldPath` and `newPath` and maps both endpoints to `old` and `new` line numbers with `kind` (`added`, `deleted`, `context`). The missing line number on an added or deleted line is null. `inDiff` is true when the full range lies within the unified diff with three context lines. The exporter checks the note's current lines and its original anchor before it searches for a unique quote on the selected side. It does not post or change the notes.

## Edit and create files

Only **Save** (or cmd+S) and **New file** write to the opened workspace. Select the pencil in the File view to edit a working-tree text file. The editor supports UTF-8 text up to 2 MiB and 20,000 lines. Images, binary files, links, partial previews, and commit views are read-only. Use **New file** in the Files header or a folder's context menu to create an empty text file. Explorer creates missing parent directories and refuses to replace an existing path. Neither action writes through links or inside `.git`.

Save compares the file's current SHA-256 digest with the editor's base. It replaces the file atomically, retains the read, write, and execute permission bits, and applies the original line-ending style (the dominant style if the file mixes endings). If the disk version changes, Explorer keeps your text. Reload the disk version, copy the edit, or acknowledge the new base and save again. Unsaved text stays in the private `explorer.dir` store, not the workspace. Explorer marks up to 32 edited files per root and restores the draft when you reopen the file.

## Notes and review store

Notes and review state live under `explorer.dir`. A repository is keyed by the first 32 digits of the SHA-256 of its canonical Git common directory, or its canonical root for a plain folder. Git worktrees share the notes but resolve their locations independently. A line note retains its exact quote. Explorer first checks the original lines, then a Git diff from the anchor commit, then whether the quote occurs exactly once. If none matches, the note is outdated and keeps its original quote. Location and state are separate: a note may be open, draft, sent, answered or resolved wherever the quote falls.

A non-line note stores only a `target`: a file (`path`, optional `side`), a commit (a full SHA) or a review (a pinned `ReviewScope`). It has no `path`, `side`, `anchor`, `start` or `end` of its own. The tool's review target accepts a public review input, such as `{kind:"review",review:{range:"base...head"}}`; the store resolves it and keeps the pinned scope. Notes made or imported with a review also keep its resolved `reviewKey`, which names the exact scope for the UI. Older walkthrough-stop records are read as ordinary notes; their retired marker is ignored and is not returned or rewritten.

Note authors are `operator`, `agent` or `remote`. A remote note stores the display name `by`, a repository-unique `external` ID and an optional HTTP or HTTPS `url`. A local note may also carry a `url`. A thread entry can carry `by`; remote replies require it. Import updates a matching remote note and replaces its remote replies without removing local replies. The thread is ordered by time. Remote notes can be replied to, resolved or reopened. The native page compares `expectedUpdatedAt` before it updates agent or operator text. Remote text comes from the platform and cannot be edited locally. The page can delete a note from any author. The agent tool's `update` and `delete` send an `agentOnly` guard and affect agent notes only.

```text
store.json                               {version:1, storeId}
recents.json                             {version:1, roots:[{path,label}]}
repos/<key>/repo.json                    {version:1, key, kind, identity, label, createdAt}
repos/<key>/notes/<note id>.json           line note with anchor, or a non-line note with target
repos/<key>/reviews/<sha256(key)>.json     {version:1, key, viewed, finished?}
repos/<key>/markers.json                 {version:1, branches:{<branch>:{head,at}}}
```

Directories use mode `0700` and records use `0600`. A single `proper-lockfile` lock serializes store mutations. Writers publish each record by rename; readers validate records and skip unreadable entries without repairing them. The native shell invokes the same writer as the Pi tools. It runs the Node executable named by `build.json` with `Contents/Resources/notes/notes-helper.js`, sends one JSON request, and reads one JSON response. Requests use `{version:1,store,root,op,...fields}` with absolute store and root, and repository-relative paths. The helper shares the Explorer store operations. `update` compares `expectedUpdatedAt` inside the lock, and the tool adds `agentOnly:true` to `update` and `delete`. For `import` and `export` at the store boundary, `review` is a validated scope object rather than the Pi tool's ref string. The native shell does not expose those operations to the page. `remember` records a recently opened root. The response is `{ok:true,...result}` or `{ok:false,error:{code,message}}`; the error codes are `invalid`, `not-found`, `conflict`, `busy` and `store-failure`. Native limits the request to 1 MiB, the response to 16 MiB and the process to 10 seconds.

## Live collaboration

The Explorer host listens on a transient `http://127.0.0.1:<port>` endpoint scoped to one Pi conversation. `--live` points to a private, one-use file containing `{version:1, endpoint, token}`. The token is 64 lowercase hexadecimal digits. Native checks owner, mode and file identity and consumes the file before connecting. An expired, missing or reused capability never selects a different conversation. The host removes its exact unused files when the route closes. In ordinary Pi, switching sessions, forking, changing the selected tree or shutting down closes the route. In Durable, the route belongs to the exact conversation and host lifetime.

Each request is an HTTP POST with no query, `Content-Type: application/json`, `Authorization: Bearer <token>` and no `Origin`. Do not follow redirects. Requests with the wrong Host or an Origin are refused. Every JSON request has the same additional `workspace` and `document` fields, both UUIDs, chosen by native and kept unchanged across navigation. Use fresh UUIDs for a different pane. HTTP errors return `{ok:false,error:string}`. A successful transport response contains `ok:true` and the fields below.

| Endpoint | Additional request fields | Response fields |
|---|---|---|
| `/connect` | `version:1, navigate:1` | `handle` (opaque pane identity), `label` (conversation label) |
| `/poll` | `after` (last state sequence, initially `0`) | `command` or `null`, `state` |
| `/result` | `requestId`, `result:{status:"ok"}` or `result:{status:"error",message}` | none |
| `/prompt` | `requestId`, `threadId`, `root` (absolute path of the pane’s current root), `text`, optional `noteIds` | `status:"requested"`, `status:"admitted"` with optional `submissionId`, `status:"rejected"` with `message`, or `status:"uncertain"` with `message` and `retryable` |
| `/close` | none | none |

The only command is `{workspace,document,requestId,op:"navigate",target:{root,path?,line?,end?,view?,review?,note?}}`. `root` is absolute; `path` is relative to it. `review` is a review scope object, not a string. Native validates and opens the target before it acknowledges the command. It returns the acknowledgement to `/result` before the next poll. A closed or unconfirmed pane does not assert that navigation succeeded. A poll waits at most 25 seconds; use only one outstanding poll per pane. The idle state is `{sequence:0,status:"idle",text:"",truncated:false}`. Other states supply `{requestId,threadId,sequence,status:"queued"|"working"|"answer"|"error",text,truncated}`. Native adds `workspace`, `document` and the current `root` to the page’s prompt fields. If a pane sends no `root`, run `/explorer update` and reopen the pane. `requestId` and `threadId` are UUIDs; note IDs are `n-` followed by 20 lowercase hexadecimal digits.

Prompt text must be nonblank, well-formed Unicode and at most 128 KiB UTF-8. The HTTP JSON body limit is 1 MiB, including escaping. The bridge refuses oversized bodies without waiting for the rest of the upload. If the client is still writing, the connection may close before the client receives the HTTP 409 error. Retry a lost receipt with the same request ID and identical contents, including the root. An explicit uncertain receipt is retryable only when its `retryable` field is true. A known submission is not sent again.

In ordinary Pi, Explorer sends the original review text directly as an [application message](../../docs/conventions/application-messages.md). The subject names the folder, the place gives its exact root path, and a follow-up identifies the first request in its thread. If the path contains a control character, format character or line break, Explorer refuses the request rather than give Pi a different path. Explorer adds guidance about cited files, lines and notes to the first Explorer message in each model request, not to the stored review text. No other extension is required.

A `requested` receipt means that Pi queued or placed the message, not that it answered. Explorer restores a request that Pi dropped from its queue. If you stopped the run, the restored request waits for the next run. Each pane receives replies by request ID. If Pi answers several inputs together, each affected card shows the answer with its own reference and the number of other inputs. Once the live connection closes, read any later answer in the conversation.

In Durable, Explorer submits the review text directly to the bound conversation with an instruction to answer in the final message. The pane receives the answer to that admitted submission.
