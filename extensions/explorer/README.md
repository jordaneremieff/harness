# Explorer

Explorer opens a repository, folder or file in a native window over a Rex pane. Browse files, compare changes, and leave notes on the code.

## Open Explorer

- `/explorer [path]` opens a right split beside the current Pi conversation. With no path, it opens the session’s working directory. Quote a path to distinguish it from a command name.
- `/explorer changes [uncommitted|branch|since-review|<commit>|<base>..<head>]` opens a review. If you omit the scope, Explorer selects uncommitted changes when present. Otherwise, it selects changes since your last review on the default branch, or compares your branch with the default branch. The first review on the default branch covers its latest commit.
- `/explorer notes` opens the Notes list. `/explorer help [topic]` describes the command forms. `/explorer update` installs the app in the background on macOS. Interactive starts and reloads check the installed build against the loaded checkout. If the checkout cannot order the two builds, it leaves the installed app in place. Already open panes keep their build.
- **Explore a Folder…** in the Rex command palette lists recent roots and opens the selected root beside the invoking pane. This route has no live conversation. You can keep notes or copy a review, but cannot send a review to an agent from that pane.

In the file view, use ⌘P for files, ⌘⇧F for repository search, ⌘F for the current file and ⌃G for a line. In the terminal placeholder, `q` closes Explorer. On compatible builds, `:open --root …` navigates the current pane without changing its placement.

## Notes, review comments and questions

Select code, or click line numbers, to show the strip with **Ask**, **Comment**, **Note** and **Copy**. A right-click (or Control-click) offers the same actions with copy and navigation items. ⌘D asks about the selection, or about the file when nothing is selected.

- **Ask** sends a question about the lines to the conversation. Its answer appears in the card and stays in the note's thread.
- **Comment** adds a review comment. Review comments wait in the tray at the bottom until you send them together, or send one with **Send now**.
- **Note** keeps a private note on the lines. It reaches the agent only when you reply to it while a conversation is connected.

Each card has one filled button on the right; ⌘↩ performs it. Text you type and do not save stays with its lines: selecting the same lines again brings it back, and other lines open an empty card. Unsent text also survives closing the pane.

Marked lines are tinted: yellow for review comments, blue for your notes and questions, mauve for the agent's notes. Click a marked line, its dot or **Open note** in its menu to open the card; a further click on the same lines while the card is open shows the next note there. A review comment opens in its editor with **Remove**, **Send now** and **Save**. A note opens its thread: **Reply** sends the reply to the conversation when one is connected and otherwise saves it in the note; your own open notes can be edited, and your notes can be deleted. Viewed ticks and unsent comments persist. A review finishes when you send it or mark all its files Viewed.

## Markdown preview

In the File view, `.md` and `.markdown` files open rendered by default. Use **Preview** to switch between the rendered document and its source. Explorer remembers your choice. **Changes** always shows the source diff.

Find in file searches rendered text in Preview. Go to line switches to source. Notes, comments and Ask stay tied to source lines: select rendered text to act on the corresponding lines, or click a tinted block to open its note. Line links and search results jump to the matching block. Explorer keeps your reading position when a file changes.

Relative links open files inside the current root. Links to headings scroll the preview, including when a relative file link contains a heading fragment. HTTP and HTTPS links open in the default browser; email links open in the default mail app. Other URL schemes are inactive. Supported local images load from the root; remote images show their alt text instead.

## Files list

The Files list shows Git-ignored files and folders with muted text and icons. Ignored folders start closed and list their immediate contents when you expand them. The Files filter matches all paths the list has read, including children of ignored folders you have expanded. Quick Open (⌘P) and content search still respect Git ignore rules. Plain folders keep their existing file list. Set `showIgnored` to `false` to hide ignored entries in panes opened afterwards; an open pane keeps the value it started with.

## Settings

<!-- harness:settings:start -->
| Key | Environment | Type | Default | Applies | Constraints | Description |
|---|---|---|---|---|---|---|
| app | `PI_EXPLORER_APP` | path | &lt;agentDir&gt;/explorer-app/Explorer.app | reload | none | Installed native Explorer application. |
| dir | `PI_EXPLORER_DIR` | path | &lt;agentDir&gt;/explorer | reload | none | Private directory for Explorer notes and review state. |
| agentPane | `PI_EXPLORER_AGENT_PANE` | enum | "split" | reload | split, float | Pane in which an ordinary session shows an Explorer location. split names a split on the right of the session's own pane; float names a floating pane over its window. Agents without a pane of their own, such as Durable workers, always use a floating pane on the tab of the ordinary session that started them. An operator's request for another pane still applies, and /explorer always opens a split. A new or reloaded session applies a change. |
| showIgnored | `PI_EXPLORER_SHOW_IGNORED` | boolean | true | next use | none | Show Git-ignored files and folders in the Files list of a newly opened pane. Direct file access, Quick Open and content search are unchanged. Open panes keep their launch value. |
<!-- harness:settings:end -->

Relative paths for settings resolve against the agent directory. See the [extension configuration contract](../../docs/conventions/extension-config.md).

## Tools

`explorer_show` accepts `path`, `line`, `endLine`, `review`, `tour` and an optional `note: {title?,text}`. A review specifies one of `scope`, `commit` or `range`. A note is saved before the pane is moved or a launch command is returned. A result with `moved:true` confirms the live pane accepted the new location. Otherwise `show` supplies argv to run in a pane, `paneInput` supplies navigation text for an existing pane you own when the build supports it, or `showUnavailable` explains why a launch is not offered. The tool does not create or focus a pane. An unconfirmed live navigation does not produce replacement argv.

`explorer_notes` accepts a `root` or uses the working directory. Use `list` with optional `path` and `state`, `read` with `id`, `reply` with `id` and `text`, `resolve` or `reopen` with `ids`, `note` with `path`, `start`, `end`, `text` and optional `title`, or `tour` with `title`, optional `review` and ordered `stops` (`path`, `start`, `end`, `title`, `text`). Pass the returned `tourId` to `explorer_show`. Tool lists return bounded previews; read a single note for the quote and recent replies. The ordinary Pi and Durable tools return structured results. Durable does not automatically replay interrupted tool calls because a call can write a note, reply or walkthrough, or move a live pane.

## Edit and create files

Only **Save** (or ⌘S) and **New file** write to the opened workspace. Select the pencil in the File view to edit a working-tree text file. The editor supports UTF-8 text up to 2 MiB and 20,000 lines. Images, binary files, links, partial previews, and commit views are read-only. Use **New file** in the Files header or a folder's context menu to create an empty text file. Explorer creates missing parent directories and refuses to replace an existing path. Neither action writes through links or inside `.git`.

Save compares the file's current SHA-256 digest with the editor's base. It replaces the file atomically, retains the read, write, and execute permission bits, and applies the original line-ending style (the dominant style if the file mixes endings). If the disk version changes, Explorer keeps your text. Reload the disk version, copy the edit, or acknowledge the new base and save again. Unsaved text stays in the private `explorer.dir` store, not the workspace. Explorer marks up to 32 edited files per root and restores the draft when you reopen the file.

## Notes and review store

Notes, walkthroughs and review state live under `explorer.dir`. A repository is keyed by the first 32 digits of the SHA-256 of its canonical Git common directory, or its canonical root for a plain folder. Git worktrees share the notes but resolve their locations independently. A note retains its exact quote. Explorer first checks the original lines, then a Git diff from the anchor commit, then whether the quote occurs exactly once. If none matches, the note is outdated and keeps its original quote. Location and state are separate: a note may be open, draft, sent, answered or resolved wherever the quote falls.

```text
store.json                               {version:1, storeId}
recents.json                             {version:1, roots:[{path,label}]}
repos/<key>/repo.json                    {version:1, key, kind, identity, label, createdAt}
repos/<key>/notes/<note id>.json           note with anchor, state and thread
repos/<key>/tours/<tour id>.json           ordered note IDs and optional review scope
repos/<key>/reviews/<sha256(key)>.json     {version:1, key, viewed, finished?}
repos/<key>/markers.json                 {version:1, branches:{<branch>:{head,at}}}
```

Directories use mode `0700` and records use `0600`. A single `proper-lockfile` lock serializes store mutations. Writers publish each record by rename; readers validate records and skip unreadable entries without repairing them. The native shell invokes the same writer as the Pi tools. It runs the Node executable named by `build.json` with `Contents/Resources/notes/notes-helper.js`, sends one JSON request, and reads one JSON response. Requests use `{version:1,store,root,op,...fields}` with absolute store and root, and repository-relative paths. The helper accepts `list`, `create`, `update`, `reply`, `state`, `delete`, `tour-delete`, `review-get`, `review-set`, `marker` and `remember`. `remember` records a recently opened root. The response is `{ok:true,...result}` or `{ok:false,error:{code,message}}`; the error codes are `invalid`, `not-found`, `conflict`, `busy` and `store-failure`. Native limits the request to 1 MiB, the response to 16 MiB and the process to 10 seconds.

## Live collaboration

The Explorer host listens on a transient `http://127.0.0.1:<port>` endpoint scoped to one Pi conversation. `--live` points to a private, one-use file containing `{version:1, endpoint, token}`. The token is 64 lowercase hexadecimal digits. Native checks owner, mode and file identity and consumes the file before connecting. An expired, missing or reused capability never selects a different conversation. The host removes its exact unused files when the route closes. In ordinary Pi, switching sessions, forking, changing the selected tree or shutting down closes the route. In Durable, the route belongs to the exact conversation and host lifetime.

Each request is an HTTP POST with no query, `Content-Type: application/json`, `Authorization: Bearer <token>` and no `Origin`. Do not follow redirects. Requests with the wrong Host or an Origin are refused. Every JSON request has the same additional `workspace` and `document` fields, both UUIDs, chosen by native and kept unchanged across navigation. Use fresh UUIDs for a different pane. HTTP errors return `{ok:false,error:string}`. A successful transport response contains `ok:true` and the fields below.

| Endpoint | Additional request fields | Response fields |
|---|---|---|
| `/connect` | `version:1, navigate:1` | `handle` (opaque pane identity), `label` (conversation label) |
| `/poll` | `after` (last state sequence, initially `0`) | `command` or `null`, `state` |
| `/result` | `requestId`, `result:{status:"ok"}` or `result:{status:"error",message}` | none |
| `/prompt` | `requestId`, `threadId`, `text`, optional `noteIds` | `status:"requested"`, `status:"admitted"` with optional `submissionId`, `status:"rejected"` with `message`, or `status:"uncertain"` with `message` and `retryable` |
| `/close` | none | none |

The only command is `{workspace,document,requestId,op:"navigate",target:{root,path?,line?,end?,view?,review?,tour?,note?}}`. `root` is absolute; `path` is relative to it. `review` is a review scope object, not a string. Native validates and opens the target before it acknowledges the command. It returns the acknowledgement to `/result` before the next poll. A closed or unconfirmed pane does not assert that navigation succeeded. A poll waits at most 25 seconds; use only one outstanding poll per pane. The idle state is `{sequence:0,status:"idle",text:"",truncated:false}`. Other states supply `{requestId,threadId,sequence,status:"queued"|"working"|"answer"|"error",text,truncated}`. Bridge fields other than `workspace` and `document` use the same names as the page's prompt bridge. `requestId` and `threadId` are UUIDs; note IDs are `n-` followed by 20 lowercase hexadecimal digits.

Prompt text must be nonblank, well-formed Unicode and at most 128 KiB UTF-8. The HTTP JSON body limit is 1 MiB, including escaping. The bridge refuses oversized bodies without waiting for the rest of the upload. If the client is still writing, the connection may close before the client receives the HTTP 409 error. The bridge adds only a conversation-routing header to the generated review text. Retry a lost receipt with the same request ID and identical contents. An explicit uncertain receipt is retryable only when its `retryable` field is true. A known submission is not sent again. Ordinary Pi reports a request rather than Durable admission, and declines to assign a shared turn's answer to an individual question. Durable returns the answer to its admitted submission. Each pane receives only progress and answers for its own prompts.
