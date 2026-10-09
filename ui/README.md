# Web harness

A local browser interface for ordinary Pi conversations and retained Durable agents. The terminal harness remains independent: the UI does not load as a Pi extension and imports no harness TypeScript. Stop this process to return to terminal-only use.

## Start

```sh
npm run ui
```

This builds the browser modules, starts the backend for the current directory, and opens the launch URL in the default browser. Pass flags after `--`, for example `npm run ui -- --cwd <project-directory>`. Without `--open`, start the backend alone with `npm run ui:build` and `npm run ui:start -- --cwd <project-directory>`, then open the printed launch URL yourself. The backend refuses to start if the browser build is missing. After you rebuild the UI, restart the backend to serve the new bytes. Press Ctrl-C to stop; stopping closes browser links and the owned primary process, not Durable agent work. The shell removes its launch fragment and exchanges it for an HttpOnly cookie. Opening a project or saved session is an explicit action; backend startup and tab refresh never create a primary or send model input. The first screen lists recent projects from Pi’s saved-session directories. Choose a project and press **Continue** to browse saved sessions, or use **Open saved session path…** for an exact JSONL path.

Flags:

| Flag | Meaning |
| --- | --- |
| `--cwd` | Launch-directory suggestion; the directory must exist. |
| `--port` | Local TCP port, default `4318`; `0` requests an assigned port. |
| `--pi` | Pi executable, default `pi` on PATH. Arguments are supplied as an array, without a shell. |
| `--state-dir` | Private UI state directory; default `<agentDir>/ui`. |
| `--open` | Open the launch URL in the default browser through the macOS `open` command after the backend listens. A failed open leaves the backend running and prints the URL. |

The backend uses native Node TypeScript stripping; runtime files contain only erasable TypeScript. Browser modules compile through `tsc` to `dist/web`; generated output is ignored. No bundler, framework, transpilation loader, or new runtime package is required.

`PI_CODING_AGENT_DIR` selects the Pi agent directory; otherwise the usual home-relative Pi directory applies. `PI_AGENT_SESSIONS_DIR` selects the retained agent store; otherwise it is `<agentDir>/agent-sessions`.

## Ownership and terminal return

Each explicitly opened ordinary primary has a backend key and conversation epoch. Refresh and tab close preserve its process. Drafts and actions capture the exact key/epoch or Durable identity; a session replacement rejects old-epoch actions. A primary's accepted input is not proof of a completed model answer. Execution becomes idle on `agent_settled`. Completed manual compaction uses an authoritative state refresh guarded by the conversation epoch, lifecycle, and activity revision; newer activity takes precedence.

Use **Continue in terminal** to release an ordinary primary:

1. Choose whether to wait for accepted work or abort it, and whether to clear its queue.
2. The backend freezes admission, retains cleared queue text, and verifies a saved file.
3. The backend closes RPC stdin and waits for the child to exit.
4. Only after exit does it return the quoted project and `pi --session` command.

An empty, unpersisted session has no resume command. A blocked exit has no successful handoff command. The UI never launches a terminal, takes another process's PID, or kills a writer to claim the file.

A failed transport or failed initialization does not prove child exit. Such a child still owns its saved file and primary capacity. If shutdown cannot confirm exit, the backend retains its state-root lock. After verified exit, it completes local state cleanup without a takeover or process signal. Pending primary opens stop before shutdown releases state ownership.

Saved-session resume requires your explicit confirmation that the exact file is not open in a terminal or another writer. Pi exposes no public saved-file writer lock or owner query. The backend rejects duplicate canonical files within its own registry, but your confirmation is not a machine-proven external ownership check. Close the terminal writer before you resume here. There is no automatic terminal-to-browser attachment.

Startup extension errors are initialization warnings with bounded text. Their presence or absence does not establish exclusive session ownership.

## Security and limits

The server binds only `127.0.0.1`. It validates the exact Host and mutation Origin, rejects foreign fetch metadata, enables no CORS, and serves a fixed asset map. At startup it reads the built browser assets once, with a 2 MiB per-file bound, a 16 MiB total byte bound, and a 256-entry limit in dist/web. It serves those retained bytes until it stops, even if source or build files change or disappear. A one-use launch capability expires by timestamp; session tokens stay in memory and restart revokes them. Logout revokes the cookie and its event streams, not admitted work. Local HTTP does not provide TLS or Secure-cookie protection. Another browser profile needs a deliberate new startup launch link.

CSP forbids inline scripts, evaluation, framing, objects, and foreign connections. Responses use no-store, nosniff, and no-referrer. Model, tool, custom, and diagnostic output is safe text or bounded structured data, never extension HTML. Images and signatures are omitted; sensitive JSON keys and recognizable credential text are redacted in display projections. The UI exposes no arbitrary file-download, shell, signal, or environment endpoint.

Resource bounds are defined in [shared/api.ts](shared/api.ts). They are UI implementation limits, not Pi limits. Oversized requests, exhausted reservations, unresolved-copy capacity, and incompatible protocols reject explicitly. Slow browser clients receive resync instructions instead of blocking process output. Request admission uses elapsed-time rate accounting, not periodic timers. Event streams are bounded independently per workspace; idle age/status displays do not tick.

The browser is not an offline draft ledger. Text is saved only after the backend acknowledges its draft revision. A browser crash loses text that never reached the backend. Ordinary execution does not become Durable merely because the browser survives refresh.

## State and delivery

The backend owns private atomic files beneath `--state-dir`:

- `instance.json`: installation identity and state format.
- `lock.json`: exclusive UI state-root ownership; a live or unknown owner refuses another backend.
- `primaries.json`: saved keys, project paths, and session metadata, never a live PID authority after restart.
- `workspaces/`: selection, agent observation visibility, sidebar visibility, appearance, and revisions.
- `targets/`: separate epoch/agent drafts, reading anchors, and expansion preferences.
- `operations/`: issued keys, dispatch digests, receipts, and unresolved input copies.

Directories are private and files are owner-only. Serialized mutations use compare-and-set revisions, adjacent exclusive temporary files, file sync, atomic rename, and directory sync before acknowledgment. There is no multi-file filesystem transaction. Do not remove a live or unknown state lock. Dead-lock recovery requires explicit local verification of its recorded owner; it never permits removal of an Agent writer claim.

Operation reservations precede effects. A repeated issued key with the same body returns the retained state; a changed body or target conflicts. Unknown or expired keys never create work. The backend persists dispatch intent before an external write. Missing admission evidence becomes uncertain, not automatically replayed. Definite refusals retain the draft. Definite admission clears only the submitted revision, never newer edits.

Unconfirmed copies preserve exact text and target. Display lists use bounded previews; the exact-copy route supports deliberate Copy and Restore. Restore changes only that target's draft. Discard deletes only the local copy and does not cancel work or prove non-admission. Older-epoch targets remain discoverable through the backend target index.

The SSE journal is memory-only. Each backend run has a new boot ID; ordered replay or snapshot resync reconciles browser state. Transcript projections are bounded memory windows, not another permanent session archive. Large ordinary RPC records decode and project off the HTTP event loop. Saved history uses a worker-owned byte-offset index; `get_entries {since: lastIndexedEntryId}` supplies the authoritative active leaf without repeatedly transferring the full branch. Earlier pages read and project bounded records from that branch. Output controls load one bounded protected-text page at a time, with Previous, Next, and Start over controls rather than accumulating the full output in the DOM. The browser hydrates history when the selected primary becomes ready and cancels stale startup requests. Unavailable sources, invalid anchors, and exceeded source limits return visible errors.

## Durable agents

Agent discovery reads retained catalog publications and writer claims in a worker. Cached roster reads never enumerate directories or start a host. Refresh uses bounded segments with explicit scan continuation. Named known-file hints update cached records; dropped or unknown hints mark the cache stale. Claims show process presence, not socket readiness. Stored working rows become interrupted for non-live claims.

`createAgentService({store,installationId,onRoster?,onFrame?,onAvailability?})` exposes cached roster/rosterRow, explicit refresh, selected observation, explicit-target preparation, history/inspection, stable-key input admission, explicit same-key reconciliation, abort, hide/reconnect/disconnectWorkspace, and close. Native transport, validation, and bounded projection run in a worker. The main loop receives bounded native-shaped display data while original source coverage remains distinct from UI omissions. Workspace snapshots include the selected cached row and that workspace's negotiated capabilities, without a catalog scan.

Selected agents use attach-only Unix links and locally supported operation identities from the [agent host contract](../docs/agent-host-contract.md). Incompatible operations remain unavailable without disabling other hosts or ordinary primaries. Each workspace owns a connection-scoped observation token. Hide or last-client detach closes observation and unused links; native work continues.

`prepare(identity)` negotiates the same attach-only link for an agent that is not selected and returns its supported operations. It never selects, observes, launches a host, or replays input. A disconnected link or a changed retained endpoint is replaced through the same writer-claim check; a connected link with an unchanged endpoint is reused. Preparation never replaces a connected link that an observation uses: if that storage's endpoint changed, preparation refuses, and explicit observation reconnect owns the replacement. Prepared links count toward the storage link bound and close with other unused links on last-client detach. `POST /api/workspaces/:id/targets` with an agent target returns the saved target state, availability, and negotiated capabilities. A stored, unavailable, or incompatible agent keeps its saved draft with every capability false and a reason.

Native input uses the captured agent as `replyTo` and a stable `ui:<operationId>` key. Disconnect never replays input, abort, or configuration. Receipt reconciliation is read-only by default; explicit same-operation native retry repeats only the exact captured key and payload after negotiation. Ordinary RPC inputs have no native retry guarantee. Agent configuration remains available through the primary command, not a browser control.

## Excluded surfaces

Phone networking, pairing, remote devices, multiplayer, a browser terminal, a file explorer, HTML execution, and custom terminal panels are excluded. Agent creation and cold-host acquisition use existing primary text commands, followed by explicit roster refresh. There are no private SQLite readers, automatic host launchers, extension renderer imports, or agent-to-primary swaps. These boundaries keep execution with Pi and permit the harness to evolve without the UI.

## Tests and measurements

```sh
node --test "ui/server/*.test.mts" "ui/rpc/*.test.mts"
node --test "ui/agents/*.test.mts"
node --test "ui/web/*.test.mts"
npm run ui:typecheck
npm run ui:build
npm run lint
npm run check
npm test
```

Focused tests use deterministic child processes and Unix fixture hosts, not paid model prompts. The import-boundary test parses the UI graph with TypeScript only as a development tool. It refuses harness imports, undeclared runtime packages, computed loaders, and browser access to Node/server modules.

For a deterministic browser exercise, start the backend with `--pi` set to the absolute path of `rpc/fake-pi.mts`, a disposable project, and a separate private state directory. The fixture model provider is `acceptance-fixture`. A prompt containing `no-dialog` settles directly; another prompt emits text, thinking, a read card, a generic custom entry, and a confirmation request.

```sh
node ui/acceptance/smoke.mts --url '<fresh-launch-url>' --out <capture-directory> --fake --cwd <disposable-project> --prompt 'no-dialog' --dialog-prompt 'show-dialog'
node --test ui/server/latency.test.mts
```

The optional backend measurement callback records monotonic input receipt, persistence, dispatch/acknowledgment, upstream receipt, and SSE enqueue/write stages without input text. Browser performance marks cover receive/reduce/paint and local control round trips. Compare same-clock spans; raw backend/browser clocks are not synchronized. Record cold startup/catalog/history separately from warm stream and cached navigation. Report payload size, transcript size, client load, median and percentile distributions, and failures. Provider/tool time is separate from UI overhead.

`node --test ui/agents/native-performance.test.mts` reports decoder, projection, and backend-loop measurements. A fixture run on Apple M4, 16 GiB memory, Darwin 25.2.0 arm64, and Node 25.2.1 measured a 15,728,946-byte snapshot and 1,045,132-byte live frames. Production worker facade timer gaps had median/max of 1.447/2.098 ms for the snapshot and 2.274/4.305 ms for live replacements. Main-loop display projection had snapshot median/max of 0.129/0.181 ms and worst live-frame time of 0.467 ms. These backend-only fixture results meet the 50 ms loop-stall bound under those conditions; they are not browser paint or real-model measurements. The command reports sample coverage and failures; raw benchmark outputs do not belong in the repository.

For large saved-session resume and scroll measurements:

```sh
node ui/acceptance/large-session.mts --out <measurement-directory>
node ui/acceptance/large-session.mts --session <saved-session-file> --out <measurement-directory>
node --test ui/server/history-worker.test.mts ui/server/history-output.test.mts ui/rpc/suffix.test.mts ui/web/transcript-history.test.mts ui/acceptance/large-session.test.mts
```

The first command generates a synthetic 25 MiB session at runtime. The second reads a real source file and resumes only a copy under a disposable project and private Pi agent/state directories. Neither command sends a prompt or writes to the original saved-session store. The browser follows the explicit writer-release confirmation. Reports include source hashes, Resume-to-paint and composer times, clock-calibrated RPC-state-to-paint bounds, backend RSS and event-loop delay, each Earlier page latency, scroll frame intervals, and output-page/anchor checks. The driver stops its backend, Pi child, and browser. It writes the complete report to `<measurement-directory>/report.json` and prints one compact scalar JSON summary with `reportPath` and `passed` on stdout. The summary does not duplicate source inventories, stage records, or per-page payloads. The exit code remains nonzero when the driver's report checks fail. Raw reports and generated session files remain outside the repository.

Saved-history tests cover current version 3 SessionHeader, Entry Base tree links, SessionMessageEntry text, incomplete trailing records, append/rewrite invalidation, active-leaf changes, a generated large source, protected UTF-8 output offsets, and HTTP authentication/epoch bounds. A large `get_entries {since}` suffix supplies an authoritative leaf but never claims complete branch coverage. File and record limits return visible errors rather than silently skipping entries.

Deterministic tests do not establish Safari/Brave live acceptance or real long-session latency. Browser screenshots, real extension dialogs, peer delivery, sole outgoing writer release, and measured warm paint budgets require the actual desktop acceptance path.

## Browser interface

The browser uses native DOM components and browser ES modules emitted by TypeScript. Source imports use explicit `.ts` extensions; `rewriteRelativeImportExtensions` produces browser `.js` paths and lets Node tests load source directly. The project picker lists recent projects and then saved sessions newest first, with title, session ID, size, and relative time. Click a time to show its absolute value. Titles use the latest name entry available in bounded file reads, otherwise the first user-message excerpt, otherwise an explicit unavailable-title label. Search filters only loaded sessions; coverage reports the loaded count and **More saved sessions** requests the next page. Arrow keys move between rows, Enter selects, and Escape closes. Cached lists render immediately on return; freshness is visible and refresh is explicit. **Open saved session path…** retains the exact-path fallback. Start new session and manually confirmed Resume are explicit actions; already open backend primaries appear separately.

Authenticated `GET /api/sessions?project=<absolute-directory>&cursor=<cursor>` and `GET /api/projects?cursor=<cursor>` return bounded metadata pages with observation time and omitted counts. Session discovery uses asynchronous bounded batches and mtime/size cache invalidation, not whole-session parsing. Header reads use at most the first 64 KiB. Rows appear before deeper title work. For the loaded page, title scans read 64 KiB chunks up to 2 MiB per file, bound each retained JSONL line to 256 KiB, skip oversized/non-user records, and stop at the first user message. Excerpts retain the first 200 characters. A bounded 64 KiB tail supplies the latest accessible name entry. A single `GET /api/sessions?project=<directory>&titles=<titleCursor>` completion request fills pending titles without polling, reordering rows, or rescanning unrelated projects. Titles cache by file path, size, and mtime. A title outside these bounds remains explicitly unavailable. Browsing and local search never spawn Pi or a Durable host.

The window has a left sidebar and one main conversation. The sidebar holds the project picker, **Commands** (also Cmd+K) and **Sessions**, the pinned primary row, the agent roster, and a footer with connection status, notifications, and appearance. Roster rows keep a stable order and show name with relative age, model, and current activity; rows with the same display name also show a distinguishing identity suffix. Selecting the primary row or an agent row swaps the main pane. The hidden conversation keeps its draft, reading anchor, expansion state, and receipts; its transcript does not paint or write reading positions until it is visible again. Focus moves to the selected composer only after an explicit selection. The sidebar collapse state is stored as workspace `sidebarVisible`; below 900 px the sidebar starts collapsed and **Show sidebar** opens a temporary drawer that Escape or a selection closes. A **Skip to message box** link is the first keyboard stop.

While the main pane shows the primary, each agent row offers **Message**. It prepares that agent by identity and moves the one agent message form into a panel below the roster. The primary transcript, draft, and reading position stay in place. The panel header shows the agent name and a short identity. Send becomes available only after preparation reports a live agent with negotiated input. A later removal or not-live roster event, including one that arrives while preparation is pending, disables Send until another explicit preparation succeeds; the draft stays editable. Abort and **Open through primary** are not shown in the panel. Close or Escape hides the panel without discarding the draft, an unresolved conflict, or an unconfirmed send, and returns focus to that row's action, or to the primary editor if the row is gone. While such state remains, the row offers **Resume**, which reopens the exact retained draft at once, before preparation completes. When an agent occupies the main pane, rows offer no **Message** action and the form returns to that agent's view. While the panel is open, the roster keeps space for rows and a short sidebar scrolls as a whole. Agent transcripts save reading positions and expansion state for their own target, independent of the form's target.

Typing `/` at the start of the primary composer opens a command list attached to the composer's top edge. It lists Pi commands from the primary's command resource (name, description, source) and the browser actions `/new`, `/resume`, `/fork`, `/compact`, `/model`, and `/thinking`. The list reads the command resource in bounded pages and stays in a loading state until they arrive. If the page bound is reached or a later page fails, the loaded commands stay usable and an empty match says the list is incomplete and points to **Commands**, where **More discovered commands** continues the same cached inventory. Matches rank by exact name, prefix, segment prefix, subsequence, then description. Up and Down move the active row while the editor keeps focus. While the list is open, Enter and Tab insert the active command and a trailing space; they never send. Escape closes the list until the command token changes. While commands load or when nothing matches, Enter does nothing. A click inserts the row without moving focus. After the list closes, Enter sends as usual. Pi RPC exposes no argument hints, so arguments remain free text. Agent composers have no command list.

Draft saves start immediately and remain serialized; Send still requires an acknowledged draft revision. Routine save transitions show no text. The composer footer shows **Saving draft…** only after a save request stays outstanding for one second, **Draft not saved · offline** only for unsaved text during a disconnect, and **Draft not saved** after a failed save. Routine admission is announced to assistive technology once without persistent text; queued follow-ups, refusals, unconfirmed sends, and control exceptions stay visible above the composer.

A lost event stream disables Send at once and stays visually quiet for 750 ms. The browser then shows **Reconnecting…** and makes read-only resync attempts at fixed one-shot delays, without an interval timer. If those attempts fail, it shows the failure with **Reconnect** and **Details** in the sidebar footer, or at the top of the main pane when the sidebar is hidden. Recovery never resends input or resolves an unconfirmed send.

Browser UI state stays on the backend. Each editor keeps a transient local copy until a saved revision acknowledgment; transcript renders never replace editor nodes. Primary and agent transcripts use stable entry/message/tool-call keys, animation-frame batches, measured-height virtualization, and entry anchors. Tool and custom data use safe text/DOM operations, without extension renderer imports or remote image loads. Appearance changes browser CSS only. Relative timestamps change on data arrival, view re-entry, or click, never an interval. The graphite dark and neutral light themes share a spacing rhythm, inline SVG controls, and a single composer surface. `node --test ui/web/contrast.test.mts` checks the modeled token pairs against WCAG AA text thresholds and control/focus contrast thresholds in both themes; these checks do not certify whole-page accessibility.

Expanded edit cards show the retained supplied old/new text pairs, not an inferred file diff. Write cards show supplied content with bounded lazy inspection. Empty transcript messages have no header unless errors or omissions exist. Public `customType` values supply custom-entry headings; custom messages with `display:false` do not expose their text. Command resources warm once per ready primary lifecycle, not from empty startup responses.

Performance measures use `ui:editor-echo`, `ui:cached-target-switch`, `ui:control-roundtrip`, `ui:reducer`, `ui:stream-receive-to-paint`, and `ui:agent-observation-startup`. Browser spans are not synchronized server clocks. `node ui/acceptance/smoke.mts --help` describes the deterministic Brave path and its real-session boundaries.

Recent notices use backend journal IDs for baseline/replay deduplication. The backend retains a bounded notification baseline in memory, filtered to the workspace plus global notices. Fast transcript replay eviction does not clear that baseline. Backend restart clears it. Unread and dismissed states stay in the current tab, not in a durable deletion ledger.

Snapshot section omissions are explicit. Target and operation indexes preserve access to exact drafts and receipts through their authenticated read routes. Missing active views hydrate through bounded exact-key reads before input becomes available. Cached roster More reads cached pages; Refresh and scan continuation remain explicit discovery actions. Selected-agent baseline metadata comes from `Snapshot.selectedAgent`, not inferred writer claims. Reading and expansion writes serialize/coalesce per target. A failed view save exposes its target and **Reload saved view** action; draft receipt controls stay separate.

Control and terminal-handoff receipts never become **Send not confirmed** input labels. Extension select labels use safe display text while opaque option keys preserve exact response semantics. Stored agent details expose retained metadata; native activity inspection appears only with a negotiated inspect capability. Native task/submission facts stay keyed and read-only.

Primary context and cumulative token/cost fields come only from public RPC session statistics. A null context estimate stays unknown. Statistics refresh on data events, never a timer, and do not delay primary readiness.

## Implementation choices

Workspace theme, agent observation visibility, and sidebar visibility use workspace revisions. Card expansion uses a separate target presentation revision so a disclosure cannot conflict with draft text. Reading positions use stable IDs and offsets, not DOM indices. Opaque target keys name private files; raw agent identities never become filenames. Operation and target mutation transactions serialize consistency checks; external RPC/native waits occur outside that queue. Browser rendering coalesces through animation frames, not a streaming debounce.
