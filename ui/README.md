# Web harness

A local browser interface for ordinary Pi conversations and retained Durable agents. The terminal harness remains independent: the UI does not load as a Pi extension and imports no harness TypeScript. Stop this process to return to terminal-only use.

## Start

```sh
npm run ui:build
npm run ui:start -- --cwd <project-directory>
```

Open the printed launch URL in your browser. The shell removes its launch fragment and exchanges it for an HttpOnly cookie. Opening a project or saved session is an explicit action; backend startup and tab refresh never create a primary or send model input.

Flags:

| Flag | Meaning |
| --- | --- |
| `--cwd` | Launch-directory suggestion; the directory must exist. |
| `--port` | Local TCP port, default `4318`; `0` requests an assigned port. |
| `--pi` | Pi executable, default `pi` on PATH. Arguments are supplied as an array, without a shell. |
| `--state-dir` | Private UI state directory; default `<agentDir>/ui`. |

The backend uses native Node TypeScript stripping; runtime files contain only erasable TypeScript. Browser modules compile through `tsc` to `dist/web`; generated output is ignored. No bundler, framework, transpilation loader, or new runtime package is required.

`PI_CODING_AGENT_DIR` selects the Pi agent directory; otherwise the usual home-relative Pi directory applies. `PI_AGENT_SESSIONS_DIR` selects the retained agent store; otherwise it is `<agentDir>/agent-sessions`.

## Ownership and terminal return

Each explicitly opened ordinary primary has a backend key and conversation epoch. Refresh and tab close preserve its process. Drafts and actions capture the exact key/epoch or Durable identity; a session replacement rejects old-epoch actions. A primary's accepted input is not proof of a completed model answer. The actual settled event determines idle state.

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

The server binds only `127.0.0.1`. It validates the exact Host and mutation Origin, rejects foreign fetch metadata, enables no CORS, and serves a fixed asset map. A one-use launch capability expires by timestamp; session tokens stay in memory and restart revokes them. Logout revokes the cookie and its event streams, not admitted work. Local HTTP does not provide TLS or Secure-cookie protection. Another browser profile needs a deliberate new startup launch link.

CSP forbids inline scripts, evaluation, framing, objects, and foreign connections. Responses use no-store, nosniff, and no-referrer. Model, tool, custom, and diagnostic output is safe text or bounded structured data, never extension HTML. Images and signatures are omitted; sensitive JSON keys and recognizable credential text are redacted in display projections. The UI exposes no arbitrary file-download, shell, signal, or environment endpoint.

Resource bounds are defined in [shared/api.ts](shared/api.ts). They are UI implementation limits, not Pi limits. Oversized requests, exhausted reservations, unresolved-copy capacity, and incompatible protocols reject explicitly. Slow browser clients receive resync instructions instead of blocking process output. Request admission uses elapsed-time rate accounting, not periodic timers. Event streams are bounded independently per workspace; idle age/status displays do not tick.

The browser is not an offline draft ledger. Text is saved only after the backend acknowledges its draft revision. A browser crash loses text that never reached the backend. Ordinary execution does not become Durable merely because the browser survives refresh.

## State and delivery

The backend owns private atomic files beneath `--state-dir`:

- `instance.json`: installation identity and state format.
- `lock.json`: exclusive UI state-root ownership; a live or unknown owner refuses another backend.
- `primaries.json`: saved keys, project paths, and session metadata, never a live PID authority after restart.
- `workspaces/`: selection, panel visibility, appearance, and revisions.
- `targets/`: separate epoch/agent drafts, reading anchors, and expansion preferences.
- `operations/`: issued keys, dispatch digests, receipts, and unresolved input copies.

Directories are private and files are owner-only. Serialized mutations use compare-and-set revisions, adjacent exclusive temporary files, file sync, atomic rename, and directory sync before acknowledgment. There is no multi-file filesystem transaction. Do not remove a live or unknown state lock. Dead-lock recovery requires explicit local verification of its recorded owner; it never permits removal of an Agent writer claim.

Operation reservations precede effects. A repeated issued key with the same body returns the retained state; a changed body or target conflicts. Unknown or expired keys never create work. The backend persists dispatch intent before an external write. Missing admission evidence becomes uncertain, not automatically replayed. Definite refusals retain the draft. Definite admission clears only the submitted revision, never newer edits.

Unconfirmed copies preserve exact text and target. Display lists use bounded previews; the exact-copy route supports deliberate Copy and Restore. Restore changes only that target's draft. Discard deletes only the local copy and does not cancel work or prove non-admission. Older-epoch targets remain discoverable through the backend target index.

The SSE journal is memory-only. Each backend run has a new boot ID; ordered replay or snapshot resync reconciles browser state. Transcript projections are bounded memory windows, not another permanent session archive. Large ordinary RPC records decode and project off the HTTP event loop. Older pages outside the window use an explicit branch-aware full-source request and bounded projection; unavailable or oversized sources return a visible history-limit error.

## Durable agents

Agent discovery reads retained catalog publications and writer claims in a worker. Cached roster reads never enumerate directories or start a host. Refresh uses bounded segments with explicit scan continuation. Named known-file hints update cached records; dropped or unknown hints mark the cache stale. Claims show process presence, not socket readiness. Stored working rows become interrupted for non-live claims.

`createAgentService({store,installationId,onRoster?,onFrame?,onAvailability?})` exposes cached roster/rosterRow, explicit refresh, selected observation, history/inspection, stable-key input admission, explicit same-key reconciliation, abort, hide/reconnect/disconnectWorkspace, and close. Native transport, validation, and bounded projection run in a worker. The main loop receives bounded native-shaped display data while original source coverage remains distinct from UI omissions. Workspace snapshots include the selected cached row and that workspace's negotiated capabilities, without a catalog scan.

Selected agents use attach-only Unix links and locally supported operation identities from the [agent host contract](../docs/agent-host-contract.md). Incompatible operations remain unavailable without disabling other hosts or ordinary primaries. Each workspace owns a connection-scoped observation token. Hide or last-client detach closes observation and unused links; native work continues.

Native input uses the captured agent as `replyTo` and a stable `ui:<operationId>` key. Disconnect never replays input, abort, or configuration. Receipt reconciliation is read-only by default; explicit same-operation native retry repeats only the exact captured key and payload after negotiation. Ordinary RPC inputs have no native retry guarantee. Agent configuration remains available through the primary command, not a browser control.

## Excluded surfaces

Phone networking, pairing, remote devices, multiplayer, a browser terminal, a file explorer, HTML execution, and custom terminal panels are excluded. Agent creation and cold-host acquisition use existing primary text commands, followed by explicit roster refresh. There are no private SQLite readers, automatic host launchers, extension renderer imports, or agent-to-primary swaps. These boundaries keep execution with Pi and permit the harness to evolve without the UI.

## Tests and measurements

```sh
node --test "ui/server/*.test.mts" "ui/rpc/*.test.mts"
node --test "ui/agents/*.test.mts"
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

Deterministic tests do not establish Safari/Brave live acceptance or real long-session latency. Browser screenshots, real extension dialogs, peer delivery, sole outgoing writer release, and measured warm paint budgets require the actual desktop acceptance path.

## Browser interface

The browser uses native DOM components and browser ES modules emitted by TypeScript. Source imports use explicit `.ts` extensions; `rewriteRelativeImportExtensions` produces browser `.js` paths and lets Node tests load source directly. The first project picker combines project directory and exact saved-session path in one form. Start new session and manually confirmed Resume are explicit actions; already open backend primaries appear separately.

Browser UI state stays on the backend. Each editor keeps a transient local copy until a saved revision acknowledgment; transcript renders never replace editor nodes. Primary and agent transcripts use stable entry/message/tool-call keys, animation-frame batches, measured-height virtualization, and entry anchors. Tool and custom data use safe text/DOM operations, without extension renderer imports or remote image loads. Appearance changes browser CSS only. Relative timestamps change on data arrival, view re-entry, or click, never an interval. Dark control borders use `#7c7c90` for contrast on raised controls.

Performance measures use `ui:editor-echo`, `ui:cached-target-switch`, `ui:control-roundtrip`, `ui:reducer`, `ui:stream-receive-to-paint`, and `ui:agent-observation-startup`. Browser spans are not synchronized server clocks. `node ui/acceptance/smoke.mts --help` describes the deterministic Brave path and its real-session boundaries.

Recent notices use backend journal IDs for baseline/replay deduplication. The backend retains a bounded notification baseline in memory, filtered to the workspace plus global notices. Fast transcript replay eviction does not clear that baseline. Backend restart clears it. Unread and dismissed states stay in the current tab, not in a durable deletion ledger.

Snapshot section omissions are explicit. Target and operation indexes preserve access to exact drafts and receipts through their authenticated read routes. Missing active views hydrate through bounded exact-key reads before input becomes available. Cached roster More reads cached pages; Refresh and scan continuation remain explicit discovery actions. Selected-agent baseline metadata comes from `Snapshot.selectedAgent`, not inferred writer claims. Reading and expansion writes serialize/coalesce per target. A failed view save exposes its target and **Reload saved view** action; draft receipt controls stay separate.

Control and terminal-handoff receipts never become **Send not confirmed** input labels. Extension select labels use safe display text while opaque option keys preserve exact response semantics. Stored agent details expose retained metadata; native activity inspection appears only with a negotiated inspect capability. Native task/submission facts stay keyed and read-only.

Primary context and cumulative token/cost fields come only from public RPC session statistics. A null context estimate stays unknown. Statistics refresh on data events, never a timer, and do not delay primary readiness.

## Implementation choices

Workspace theme and panel visibility use workspace revisions. Card expansion uses a separate target presentation revision so a disclosure cannot conflict with draft text. Reading positions use stable IDs and offsets, not DOM indices. Opaque target keys name private files; raw agent identities never become filenames. Operation and target mutation transactions serialize consistency checks; external RPC/native waits occur outside that queue. Browser rendering coalesces through animation frames, not a streaming debounce.
