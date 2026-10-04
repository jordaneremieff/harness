# Pi durable-harness track

Pi 1.0.2 has distinct ordinary and Durable contracts. Agent execution uses
`@earendil-works/pi-durable` natively. The ordinary primary remains the terminal
host. Each agent storage has an independent process, an exclusive writer claim,
and native conversations. Public coding-agent services supply resources, trust,
settings, and configured providers; native contributions supply capabilities.

Verified 2026-10-04 against the installed public package contracts and the agent
slice sources. `pi-agent-core` exports its root and package metadata, not an
AgentHarness lane runtime. Agent execution uses the separate Durable package;
it does not patch core or emulate ordinary extension contexts.

## Release review coverage

<!-- pi-release-reviewed-through: 1.0.2 -->

The declaration above records the latest Pi release through which the harness
completed cumulative release intake. Its value is a numeric major.minor.patch
version or `unknown`. Targeted contract checks and dependency versions do not
establish that coverage; the initial declaration is unknown.

Evo reads this declaration from the common ancestor of local main and main's
configured upstream, using the immutable commit. This excludes dirty files,
provisional branch declarations, and local-main coverage not present in the
upstream history. Upstream tracking refs are conservative local evidence, not
a fresh remote check. Missing Git evidence or an invalid declaration requires
baseline recovery; never substitute the installed version or lockfile.

The coordinator owns advancement. Review every cumulative changelog entry after
the prior declaration through the running release, resolve applicable findings,
complete consumer adoption and required repository checks, and accept the whole
range before changing the declaration. Include that change in promotion only
with completed adoption. Verify publication before reporting completion; a
publication failure leaves delivery incomplete and the published baseline
unchanged. Partial or failed intake and unrelated directed work do not advance
the declaration.

When prior complete coverage cannot be established, read all available cumulative
release notes through the running version in bounded pages and assess current
harness effects and opportunities. Assess superseded behavior against the current
host rather than recreating historical implementations. Only completed adoption
establishes the first numeric declaration. No runtime command writes it.

## Standalone distillation boundary

Verified 2026-10-04 against installed coding-agent 1.0.2.
Installed `docs/extensions.md`,
`dist/core/model-registry.{js,d.ts}`, and `dist/core/model-runtime.js` establish
that `ModelRegistry.streamSimple()` uses the configured provider and resolves
request-time authentication, including extension registrations. The shipped
`examples/extensions/summarize.ts` uses the same registry for a standalone
completion. Stash uses this ordinary extension interface rather than constructing
an AgentSession for a fixed, tool-free request.

Installed pi-ai `dist/utils/retry.{js,d.ts}` supplies `retryAssistantCall`;
`dist/core/settings-manager.js` supplies the existing retry and request settings.
Stash retains transient retries, excludes context overflow from that loop, and
sums each attempt's reported usage once. Model adapters retain their output
defaults. These controls do not establish a universal provider token cap or
complete invoice accounting.

AgentSession also owns automatic overflow/length recovery and cache warming
(`dist/core/agent-session.js`, `dist/core/compaction/compaction.js`, and
`dist/core/sdk.js`). A registry stream does not supply those services. Stash
keeps its captured transcript fixed and returns overflow or incomplete-output
failure instead of inheriting session recovery. Its controlled stream tests and
real-registry synthetic-provider command test establish the request, usage,
cancellation, and storage boundaries, not live-model output quality. Those
runtime trials were not repeated for 1.0.2.

## Policy pre-call guidance boundary

Verified 2026-10-04 against installed coding-agent 1.0.2.
Policy's `before_agent_start` handler returns a custom message before command
selection: installed `dist/core/extensions/runner.js`
`emitBeforeAgentStart()` awaits handlers and collects messages;
`dist/core/agent-session.js` appends them before `_runAgentPrompt()`.
The public contract is `BeforeAgentStartEventResult.message` in
`dist/core/extensions/types.d.ts` and installed `docs/extensions.md`.
Policy uses that ordinary hook for its bounded shell-contract snapshot rather
than a tool-call interception that occurs after the model selects a command.
The policy hook tests exercise the real runner, custom-message conversion, and
first controlled model request. Those trials were not repeated for 1.0.2 and
do not establish model compliance.

Nested calls through `ctx.executeTool()` use the ordinary argument-validation,
`tool_call`, and `tool_result` pipeline. Installed `dist/core/agent-session.js`
binds the nested runner to `_beforeToolCall(context, parentToolCallId)`;
`dist/core/nested-tool-calls.js` emits execution events with that parent ID and
records bounded `nestedCalls` metadata on the calling tool's result. Policy's
`tool_call` interception therefore also covers nested calls, including those
from codemode scripts. This does not move the `before_agent_start` snapshot:
pre-selection guidance and execution interception remain separate boundaries.

## Native codemode composition

Verified 2026-10-04 against installed coding-agent 1.0.2
`docs/{sdk,extensions,settings,codemode}.md`, `examples/sdk/14-codemode-mcp.ts`, and
`dist/extensions/codemode/{index,tool,execute}.js`. The CLI supplies the built-in
factory; SDK hosts supply the exported `createCodemodeExtension()` themselves.
Activating it through `defaultTools: ["+codemode"]` preserves the inherited tool
selection. Default `on` mode preserves direct declarations alongside script
access. No replacement host or shared adapter is needed.

In `on` mode, `prepareCodemodeLoadout()` in `dist/extensions/codemode/tool.js`
uses `describeScriptCall()` to append a one-line call note to each tool that is
both declared and callable: `tools.<name>(args)` and its result shape. It does
not repeat the parameter schema. Model-only tools receive no script-call note.
`codemode.inlineBudget` bounds codemode's own listing of non-direct tools;
`deferred` tools remain omitted. The tool description points to installed
`docs/codemode.md` for the full script API. Keep `outputSchema` and exposure
because they define script results and reachability, not just presentation.
Use `"name" in tools` for presence checks: absent-member reads throw
(`pi-codemode/dist/runtime/prelude-source.js`).

The same prelude limits each script to 16 Mi characters of text and base64 image
data, or 100000 output-helper calls. Crossing either limit fails the script even
when its code catches the exception; calls already made are not undone. This
bounds accumulated script output, independently of coding-agent's
`max_output_tokens` display truncation. Native agents use public
`CodemodeSandbox`, so this package boundary also applies there. Prefer bounded
summaries or tool-written files instead of printing an entire large dataset.

A tool with `outputSchema` resolves to `structuredContent` inside the native
script, including data-bearing error results. Other successful calls resolve
to text; failed calls without structured data reject. Scripts must distinguish
promise rejection from structured tool errors. Agent observations, stash
listing/search, memory search, and registry provide their bounded public data
through this contract. The [composition guide](codemode-reconnaissance.md)
keeps each source's errors, coverage, and continuation fields.

Installed `dist/core/tools/read.js` returns image content without an output
schema. Codemode's `toScriptValue()` in `dist/extensions/codemode/execute.js`
returns `structuredContent` only for a tool that declares `outputSchema`, and
otherwise returns text. Nested reads therefore return only text, while direct
reads retain the image block. Keep `on` mode and direct image reads rather than
hide them behind `only` mode. Installed `dist/extensions/tool-search/tool.js`
limits native `tool_search` discovery to inactive `codemode` and `deferred`
tools through its `isSearchable()` filter; it does not discover these direct
harness tools. Its description is a constant that does not list searchable
tools or their namespaces, so it does not change when tools register. The
[MCP and deferred tool discovery](#mcp-and-deferred-tool-discovery) section
records how scripts and the model find deferred tools.

Controlled native sessions exercised nested policy denial, direct and nested
image reads, and delivery of a Pillars draft assessment to the next provider
request against 0.99.1. Those sessions were not repeated for this source review.
Current sources (`dist/core/tools/read.js`, `dist/core/nested-tool-calls.js`,
`dist/core/extensions/runner.js`, and `dist/core/messages.js`) define the
boundaries above. The earlier sessions establish their exercised pipeline
behavior, not current runtime parity, model compliance,
exhaustive source coverage, or parity with old live owners retained across a
reload. `agent_compact` uses `model-only` exposure because its continuation
contract requires a model-issued tool call.

## MCP and deferred tool discovery

Verified 2026-10-04 against installed coding-agent 1.0.2
`docs/{mcp,extensions,cli,settings,sdk}.md`, `dist/core/mcp-servers.js`,
`dist/core/extensions/{types.d.ts,loader.js}`, `dist/core/agent-session.js`,
`dist/extensions/mcp/{index,tools,config,oauth,runtime}.js`,
`dist/extensions/codemode/{tool,execute}.js`, and
`dist/extensions/tool-search/tool.js`. These are source and documentation
contracts; no runtime trial of them is recorded here. The
[codemode guide](codemode-reconnaissance.md#find-mcp-and-deferred-tools) shows
how a script uses them.

- **Exposure.** An MCP server's `exposure` is `codemode` (default), `deferred`,
  `direct`, or `hidden`. Validation replaces the older value `codemode-deferred`
  with `codemode` (`dist/core/mcp-servers.js`). `toToolExposure()` in
  `dist/extensions/mcp/tools.js` registers `codemode` MCP tools with tool
  exposure `deferred`. They are neither declared to the model nor listed in the
  codemode description; scripts call them and find them with `searchTools()`,
  and `tool_search` can load them (`docs/mcp.md`, "Control tool exposure"). An
  ordinary extension tool with tool exposure `codemode` remains eligible for
  the inline listing in the codemode description, subject to the
  `codemode.inlineBudget` selection in `dist/extensions/codemode/tool.js`;
  `createCodemodeDescription()` omits `deferred` tools outright, and tools that
  do not fit the budget are found with `searchTools()` (`docs/settings.md`).
- **Listing in the prompt.** `renderServersSection()` in
  `dist/extensions/mcp/index.js` builds the `mcp_servers` system prompt section
  during `before_agent_start`. It names every enabled server that has `codemode`
  or `deferred` tools, known from configuration before the server connects, with
  how its tools are reached (`codemode` or `tool_search`) and a one-line summary.
  The summary is the configured `description` or, once connected, the first line
  of the server instructions, cut to fit 250 characters per server and 4096
  characters for the section. Servers beyond that bound are counted in a closing
  line. `_preparePromptAndToolLoadout()` in `dist/core/agent-session.js` diffs
  prompt sections against the current system message, and `docs/mcp.md` states
  that Pi appends a changed section to the conversation instead of changing tool
  declarations.
- **Discovery in scripts.** The script globals are `searchTools(query, { limit,
  namespace })`, `describeTool(name)`, and `describeNamespace(name)`
  (`dist/extensions/codemode/{tool,execute}.js`). `describeNamespace()` returns
  `{ name, description?, instructions?, tools }`, with script identifiers as tool
  names, or `undefined`. Both `describeNamespace()` and the `namespace` option
  accept a namespace as `mcp__dev-radius`, `mcp__dev_radius`, `dev-radius`, or
  `dev_radius` (`isNamespaceName()` in `execute.js`; `docs/mcp.md`). Search text
  for `searchTools()` and `tool_search` includes the namespace name, description,
  and instructions (`createToolSearchDocument()` in
  `dist/extensions/tool-search/tool.js`). The codemode description lists no
  deferred tools, tool counts, or server instructions, so it stays the same while
  servers with `codemode` or `deferred` tools connect (`docs/codemode.md`). A server's
  `direct` tools do enter the description in `codemode.mode: "only"`
  (`dist/extensions/codemode/tool.js`).
- **Connection timing.** Servers connect in the background. The first prompt
  waits up to ten seconds by default, and only for servers that have `direct` tools. A
  `tool_call` handler in `dist/extensions/mcp/index.js` makes a codemode script
  wait for the pending servers whose namespace its source text names, or for all
  pending servers when the source text contains `searchTools`,
  `describeNamespace`, `describeTool`, or `ALL_TOOLS`. `tool_search` and the
  resource tools wait for all pending servers.
- **Shutdown of a pending connection.** `McpConnection.close()` in
  `dist/extensions/mcp/runtime.js` closes only the client it stores after a
  completed handshake. A stdio server that has not answered `initialize` when
  the session shuts down keeps running until its request timeout (`timeout`,
  default 60 seconds) ends the attempt. The harness adds no process-level
  cleanup: the transport is private to Pi, the default transport factory is
  not exported, and a harness-built transport would need its own copy of the
  MCP package, which the loader does not alias. A connected server exits on
  shutdown and on session replacement.
- **Names.** A tool is named `mcp__<server>__<tool>` and a namespace
  `mcp__<server>`, with every character other than letters, digits, and `_`
  replaced by `_` (`createMcpToolName()` and `mcpNamespace()`). Colliding tool
  names of one server all receive a hash suffix. Server names that differ only in
  `-` and `_` share a namespace, so `mcp.json` validation and
  `pi.registerMcpServer()` (`dist/core/extensions/loader.js`) reject the second,
  and a `mcp.json` server overrides a registered one of the same namespace. A
  stored reference to an MCP tool name that contains `-` does not match the
  new names. The codemode helpers `describeNamespace()` and the `namespace`
  option of `searchTools()` still accept the hyphenated spellings
  (`dist/extensions/codemode/execute.js`); raw tool-name equality does not.
- **Namespace record.** `ToolNamespace` is `{ name, description?, instructions? }`
  (`dist/core/extensions/types.d.ts`). The MCP extension sets `description` from
  the server's configured `description` and `instructions` from the server's own
  instructions. `pi.getAllTools()` returns the namespace object unchanged
  (`getAllTools()` in `dist/core/agent-session.js`), so full instructions appear
  there and through `describeNamespace()`; the automatic `mcp_servers` prompt
  listing carries only the summary, while a codemode script can return the full
  `describeNamespace().instructions` to the model. The registry extension's
  [namespace projection](../extensions/registry/README.md#evidence-and-observation)
  is a separate contract, not a Pi behavior. Read full instructions with
  `describeNamespace()` in a codemode script.
- **Project selection.** A trusted project entry without `command`, `url`, or
  `type` overrides only `enabled`, `exposure`, and `toolExposure` of the exact
  same-name global server. The loader validates a shallow merge, retains the
  global transport, credentials, and source, and records the project override
  path. A supplied `toolExposure` map replaces the whole map, not individual
  entries. Unknown bases and extra override keys produce diagnostics and leave
  the global entry intact. A full project server remains a replacement, and
  untrusted project files remain unread. Ordinary `/mcp` saves project enable
  and disable choices to that override (`dist/extensions/mcp/config.js`,
  `dist/core/mcp-servers.js`, and `dist/extensions/mcp/index.js`). Native agents
  apply the same exact-name selection override and trust rule when the host
  assembles MCP configuration at startup or native reload
  (`extensions/agent/durable-execution.ts` and `extensions/agent/README.md`).
- **Server authentication options.** An HTTP server may set `auth: { provider }`
  to send that provider's current `/login` token as the bearer token, or
  `oauth.clientName` to change the client name sent at OAuth registration. Only
  the global `mcp.json` and extension registrations may define `auth`; a project
  selection override retains an existing global `auth`. Its URL must use https
  unless the host is loopback (`dist/extensions/mcp/config.js`,
  `dist/core/mcp-servers.js`, `docs/mcp.md`).
- **OAuth identity and discovery.** Credentials are keyed by server name and URL
  in `dist/extensions/mcp/oauth.js`; different names at one URL sign in
  separately. The first matching server to load older URL-only credentials
  takes them over. `oauth.authServerMetadataUrl` selects a trusted authorization
  metadata document instead of discovery, with HTTPS required except loopback.
  Step-up sign-in retains granted scopes alongside configured and challenged
  scopes. `pi-mcp/dist/oauth/flow.js` checks RFC 9207 `iss` before code exchange:
  a mismatch is rejected, including an omitted issuer when server metadata
  requires it. `oauth.clientRegistration: "cimd"` instead identifies the client
  with Pi's hosted Client ID Metadata Document. The authorization server must
  advertise document support and public clients. It cannot combine with
  `clientId` or `clientName`; a configured callback uses localhost or 127.0.0.1
  and `/callback`. Without an advertised issuer response parameter, Pi chooses a
  server-specific document and callback path. The ordinary sign-in and refresh
  implementation is `dist/extensions/mcp/oauth.js`; native agents consume stored
  credentials and leave sign-in to `pi mcp login` or the ordinary `/mcp` host.
  These are source contracts, not fresh OAuth sign-in trials.

## Checked source boundary

Verified 2026-10-04 against running coding-agent 1.0.2, its nested public
packages, and the separate published Durable 1.0.2 package. The installed files
checked here match the extracted 1.0.2 releases. This source review does not
advance the release-coverage declaration above.

The comparison baseline is the published 1.0.1 packages, not an older lockfile.
The manifest retains wildcard Pi declarations; the lockfile records one resolved
graph, not a supported-version ceiling. Dependency installation remains separate
from worktree source synchronization; each checkout needs `npm ci` after a
lockfile update. Loaded extensions resolve non-aliased dependencies separately.

| Source | Checked state (2026-10-04) |
|---|---|
| Running coding agent | 1.0.2; checked files match the extracted published package |
| Running nested packages | AI, agent-core, TUI, Codemode, MCP, Chord, and Telemetry are 1.0.2 |
| Extracted release packages | Coding-agent, AI, agent-core, TUI, Durable, Codemode, MCP, Chord, Client, Server, Protocol, and Telemetry are 1.0.2 |
| Consumer validation checkout | All of those Pi packages are 1.0.2; its checked files match the extracted releases |
| Comparison baseline | Published 1.0.1 packages; repository lockfile and installed dependency trees remain separate facts |
| npm publication | Explicit `@earendil-works/pi-coding-agent@1.0.2` and `@earendil-works/pi-durable@1.0.2` metadata both name gitHead `cd32f7725fdbddbaecdff5b1e68491563394e0ca` |
| Published Durable exports | 1.0.2 retains root, environment, tools, memory, JSONL, SQLite, and testing surfaces, including Node adapters; the root adds `ProviderDoc` and `ProviderState` |
| Release source | [v1.0.2][release], not ahead-of-release branch state |

The file-by-file comparison excludes source maps and dependency subtrees.
Unchanged cited files support the current source check. Changed defining files
were re-read: model configuration and provider composition, per-level sampling,
Durable provider identity, conversation creation, generation, compaction, views,
and exports. Coding-agent's generated bundle carries the same release changes;
it is not independent runtime evidence. Catalog updates remain upstream-owned.
Agent-core, TUI, Codemode, MCP, Chord, Client, Server, Protocol, and Telemetry
executable sources are unchanged from 1.0.1; package metadata and, where present,
changelog headings differ.

These are source checks, not cumulative intake acceptance or package-wide
runtime equivalence. The declaration above records cumulative intake separately.
Repository-specific implementation and test claims are not independently
re-established by this source comparison. Earlier runtime trials were not
repeated for 1.0.2. Interactive behavior, live provider compatibility, durable
recovery, and crash or power-loss behavior retain their stated runtime limits.

Installed paths below are relative to the running
`@earendil-works/pi-coding-agent` package root. `pi-agent-core/`, `pi-ai/`,
`pi-codemode/`, `pi-mcp/`, and `pi-tui/` identify separate 1.0.2 package roots;
`pi-durable/` identifies the separate published 1.0.2 package. A source check
establishes that version's contract and implementation, not which dependency
instance another process loads.

## Runtime adoption and distribution

| Runtime | Available boundary | Consequence |
|---|---|---|
| Ordinary coding-agent SDK | Installed `dist/core/sdk.js` constructs `Agent` and `AgentSession`; `dist/core/agent-session-services.js` supplies reusable services; `dist/core/agent-session-runtime.js` owns session replacement | Keep full extension/resource behavior through public session services and runtime construction |
| Pi Durable 1.0.2 | Separate package publishes `Harness`, tasks, tool turns, inboxes, retained outcomes, conversation and task-graph watches, ownership, compaction, and storage/environment/tool subpaths | Experimental runtime; adoption requires a complete host capability match, not just a published primitive |

Coding-agent exports its ordinary root and `./rpc-entry` as runtime entrypoints.
Its `./client` and `./experimental/plugin` remain source-condition-only. Do not
restore coupling to the accidentally published experimental distribution from
an earlier package. The supported local SDK and stdio RPC contract remain
separate from those development entrypoints.

The installed extension loader binds Pi core imports to the running install.
`dist/core/extensions/loader.js` aliases coding-agent, agent-core, TUI, AI and
its named compatibility/provider subpaths, plus TypeBox root/compile/value.
Durable, Codemode, MCP, and Chord are not in that alias map. The harness declares
them as runtime dependencies, not host-supplied peers. Verified 2026-10-04 against
installed 1.0.2 `docs/packages.md` and `dist/core/package-manager.js`:
`getGitDependencyInstallArgs()` uses `--omit=dev --legacy-peer-deps` for npm,
`--omit=dev --omit=peer` for Bun, and `--prod` with peer/build configuration
flags for pnpm. Managed package installation also suppresses automatic peer
installation through package-manager-specific flags. A required runtime package
outside the alias map therefore needs a direct dependency, not only a peer.
Matching a checkout lockfile does not establish that every loaded extension
resolves the same dependency instance.

The CLI supplies codemode, tool search, MCP, and llama.cpp as `builtin: true`
factory entries from `dist/extensions/index.js`, consumed by `dist/main.js`.
That aggregate factory list is not a package export. The root API does export
`createCodemodeExtension`, `createToolSearchExtension`, and `createMcpExtension`
(`dist/index.js`); installed `docs/sdk.md` requires SDK hosts to supply the
factories they need. Ordinary SDK consumers must select them explicitly.
Durable agents instead install native Codemode and MCP extensions through
`extensions/agent/durable-execution.ts`. Their scripts create native nested
call tasks rather than invoke an ordinary extension runner.

## Terminal rendering boundary

Verified 2026-10-04 against pi-tui 1.0.2 `dist/index.d.ts`,
`dist/tui.js`, `dist/tui-alt-screen.js`, `dist/components/image.js`, and
`dist/terminal-image.js`, plus coding-agent
`dist/modes/interactive/interactive-mode.js` and `dist/utils/image-convert.js`.

The public layout primitives (`VStack`, `HStack`, `ScrollView`,
`isViewportTUI`, and mouse events) remain available. InteractiveMode mounts a
constrained chat viewport in fullscreen mode. An extension overlay is not a
constrained layout root: `compositeOverlays` renders its component at full width
and slices rows, so the agent dashboard clips its own viewports.

`Image` converts non-PNG inputs for Kitty-protocol terminals through a registered
transcoder. InteractiveMode installs coding-agent's PNG converter; a standalone
TUI host must supply its own converter with `setImageTranscoder()`, or non-PNG
images use text fallback. Fullscreen WezTerm draws Kitty placements after text
writes and tracks all covered rows when it decides to redraw. These are source
boundaries, not a new terminal trial.

## Pi Durable 1.0.2

Verified 2026-10-04 against the published 1.0.2 package's `README.md`,
`package.json`, `dist/index.d.ts`, `dist/types.d.ts`,
`dist/harness/{types,harness,view,task-graph}.d.ts`, and the storage and progress
implementations cited below. The [release README][durable-readme] marks the
package experimental: its API changes without notice between releases.
The [manifest][durable-package] publishes executable `dist` entrypoints.
Its `source` conditions refer to checkout source; the npm archive does not
include the linked design documents. Use the release-tag documents rather than
assume those files exist in the installed package.

### Supplied runtime

- `Harness.open()` opens storage with host-supplied model access and a registry.
  Durable tasks retain checkpoints and terminal outcomes. Reopening permits
  unfinished work to resume under installed task definitions; missing or
  incompatible definitions block work.
- Conversations have explicit ownership. Input submissions retain admission,
  placement, and answer state, with conversation-scoped `requestId`
  deduplication. A busy-conversation inbox accepts steering, follow-up, and
  passive writes. Admission is not an answer; canceling a wait does not cancel
  the work.
- `GenerationTask` owns the tool turn and its `ToolTask` children. Tool intent
  commits before effects. Interrupted tools replay only under the replay-safe
  contract; arbitrary external effects have no exactly-once guarantee.
- Manual, threshold, background, and overflow compaction reduce model context
  without deleting older entries. Hooks may supply a summary.
- `ConversationView`, document states/watches, and `watchEvents()` expose
  committed state. `taskGraph()` and `watchTaskGraph()` expose live tasks and
  ownership, not an archive of terminal tasks or a stored-session inventory.
  Slow watches replace queued frames with a current snapshot rather than retain
  an unlimited event journal.
- Memory, JSONL, and SQLite implement the storage contract. SQLite exposes an
  asynchronous portable database facade and a Node adapter. Environment
  adapters and the `./tools` factories support file and shell operations.

The durable `Extension` is a named bundle of tools, sections, hooks, wrappers,
and tasks selected through stored `pi.agent` choices. It is not an ordinary
Pi extension factory. `HarnessOptions` assigns models, registry installation,
settings, and per-use environments to the host. The published root and subpath
contracts supply no ordinary extension/resource loader, project-trust resolver,
tool or skill discovery, ModelRegistry configuration, native SessionManager
continuation, terminal UI, detached-process controller, or cross-process writer
ownership. Coding tools require explicit installation; their read tool does not
return images. Those are host integration requirements, not capabilities granted
by similarly named durable types.

### Provider session identity

Shipped in 1.0.2. Verified 2026-10-04 against
`pi-durable/dist/harness/{provider,harness,generation,compaction,view}.js`,
`pi-durable/dist/index.{js,d.ts}`, and the release README.
`ProviderDoc` stores a UUIDv7 in the conversation-scoped `pi.provider` document.
Creation initializes it in the same transaction; children and forks receive fresh
identities rather than inherit their parent's identity. An older conversation
without that document gets one committed identity before its first generation
or compaction request. Normal reads reuse the persisted value without a write.

Generation and compaction forward this value as `sessionId`. It survives turns,
retries, reopen, reset, compaction, and model changes within that conversation.
`ConversationView` mounts the document, and the root exports `ProviderDoc` and
`ProviderState`. The provider session identity is distinct from the harness's
storage, conversation, submission, and task identifiers. The agent host uses
Durable's value; it must not replace it with a storage-keyed identity or make
forks share that key. Stash's standalone request supplies its own UUIDv7 and
stays outside this conversation identity contract.

This establishes request affinity, not provider cache hits, retained cache
lifetimes, or measured cost savings. The real-host regression in
`extensions/agent/durable-runtime.test.mts` establishes one persisted non-storage
UUID across four turns, each with a tool round, and a host restart, plus the
configured transport and `reasoning` present for high and absent for off.
It checks neither provider cache hits nor fork or child identity separation;
the historical process-recovery tests below do not establish this new identity
contract on 1.0.2.

### Subagent ownership

The [README's subagent pattern][durable-readme] is a conversation owned by a
tool task, not a built-in subagent product. The foreground example creates a
task-owned child and waits for its answer. Aborting the call reaches the child;
owned foreground work keeps its parent busy. The background example gives each
persistent child a background anchor task and uses a background reporter task
to submit answers to the parent as follow-up input. A background ownership
boundary does not mean a separate operating-system process.

Replay-safe tools find their child through `ownerTaskId` and reuse the input
through `requestId`. The background example also deduplicates reports by request
ID. Those patterns depend on installed definitions and the storage owner; they
do not supply ordinary extensions or detached-process control.

The agent slice's answer-bearing send and prompted spawn return an exact
native result reference after public submission admission. The tool and its
background Reporter share one stable request ID and a task-scoped admission
marker; the reference contains the admitted submission ID, not the Reporter ID.
Creation-only dispatch and ordinary-primary messages carry no native result
reference. This source contract does not establish result settlement or a
foreground wait.

### Durability limits

Only committed state is observable, but that does not establish a fixed
crash-loss window. `pi-durable/dist/harness/output.js` makes progress commits
adaptive: at least 100 ms between commits, extended by written size at
100 KiB/s. Uncommitted progress can be lost. The README's fixed-window wording
does not override that implementation.

JSONL defaults `fsync` to false. With it enabled,
`pi-durable/dist/storage/jsonl/storage.js` flushes affected sidecars before
appending the main commit marker. It does not flush every publication marker.
Before destructive sidecar reclamation it flushes the main file; a failed flush
skips reclamation. An acknowledged tail commit therefore need not survive power
or host failure. Sidecar-before-marker ordering is not acknowledgment durability.
JSONL uses memory-backed state; cursor scans do not prove source-size-independent
memory use.

The SQLite Node adapter sets WAL and `synchronous = NORMAL`
(`pi-durable/dist/storage/sqlite/node.js`). The README distinguishes process
crashes from power or host failure. The agent's
[`durable-host.test.mts`](../extensions/agent/durable-host.test.mts) kills real
subprocesses during a model request and an unsafe tool effect, then reopens the
database. These tests establish recovery at those checkpoints, request
deduplication, and interruption without replay of that unsafe effect. The
production-runner tests in `durable-runtime.test.mts` also exercise process
replacement and owner receipts. These checks do not establish power-loss
durability, general exactly-once effects, or orphan-process cleanup.

Pi Durable requires one process to own storage and supplies no cross-process
ownership lock. SQLite transaction locking does not prevent independent
schedulers from opening the same storage. Storage durability does not supply
process ownership or forced termination of uncooperative code.

### Published intent and repository decision

The [Pi Durable post][durable-post] describes Durable as a separate runtime.
The ordinary SDK does not acquire Durable behavior by sharing Pi packages.
The agent slice uses Durable explicitly: `durable-runner.ts` acquires a storage
writer claim before `durable-runtime.ts` assembles services and opens
`DurableHost`. Native submission IDs, entries, documents, and task outcomes
remain authoritative. Old ordinary agent files stay untouched and unread.

### Storage host retirement

The installed boundary is rechecked 2026-10-04 against Durable 1.0.2
`dist/harness/harness.js`. The local host/runtime descriptions retain their
source-defined scope, not a new runtime trial. Public `inspect()` includes queued and placed
submissions; `taskGraph()` includes all live tasks. Native waiting tasks,
including check-ins and scheduled inputs, therefore remain host work rather than
passive connections.

The agent host's current lifetime contract ignores passive primary and peer
connections and footer subscriptions. Retirement waits for the configured idle
interval with no native work, pending delivery row or in-flight delivery effect,
request, local control, or open
conversation/task observation. Observation tokens cover the open-to-subscribe
gap and release on close, abort, setup failure, and disconnect. Token operations
serialize native watch ownership, and failed setup releases only its own reference.
A failed live frame reports unavailable and releases its token without closing the
shared client. Reload refuses before teardown while native observation tokens
remain; the same guard applies to native local commands. Native commits
and local control completion reset the idle interval independently of coalesced
catalog notifications. A generation check rejects stale asynchronous idle
snapshots; a synchronous seal closes process, local, and delivery admission before
shutdown begins. A delivery effect remains work even if another caller already
acknowledged its row. Completion of that effect starts a new idle interval.

Final catalog publication precedes recovery-marker clearance, runtime cleanup,
writer release, and transport close. Publication or marker failure rejects the
clean close and retains the claim until process death. Clean retirement preserves
catalog costs and causes no recovery acquisition or crash-budget charge. Cold
reads stay writer-free; later controls acquire a fresh host.

Pi windows and hosts retain loaded code on independent timelines. The manager
does not replace a host because its source release differs. Natural idle
retirement permits new code on the next control, while operation contracts
keep unchanged methods usable. A missing or incompatible contract refuses with
restart guidance, without translating retired state or interrupting work. An
open live observation intentionally keeps its host alive. This extension-owned
policy does not change Pi Durable's storage or replay guarantees.

### Process contracts and peer threads

The installed boundary is rechecked 2026-10-04 against coding-agent and
Pi Durable 1.0.2 public contracts, `pi-durable/dist/harness/{types,harness}.d.ts`,
and `pi-durable/dist/types.d.ts`. Repository descriptions refer to the agent
slice's `version-contract.ts`, `collaboration.ts`, `durable-host.ts`, and
`durable-delivery.ts`; this source comparison does not repeat their runtime tests.

Actual upstream releases are diagnostic facts, not a substitute for an
operation contract. The host descriptor separates its release label and API
floors from current request/response identities. Typed observation schemas
supply hashes; operations carrying opaque native data also bind to the exact
experimental Durable release. Both sides refuse incompatible operations before
dispatch. Other operations continue. Retained manager, native contribution, and
primary notice interfaces have independent identities. This permits concurrent
current processes, not backward readers or predecessor migrations. The
[agent README](../extensions/agent/README.md#current-process-contracts) defines
maintenance and restart behavior.

Peer threads use public native document families and transactions for frames,
membership, attributed events, and mutation receipts. Events and delivery
intents commit together. Joining opts into bounded passive notice entries via
`Conversation.submit({type: "write", ...})`; explicit attention uses input
steering. A passive write starts no model turn and does not establish immediate
model awareness. Request IDs deduplicate delivery retries. The existing host
catalog publishes bounded discovery hints; cold reads neither schedule work
nor create storage writers. The dashboard displays the same retained exchange,
not a fabricated conversation. See
[peer threads](../extensions/agent/README.md#peer-threads) for use and limits.

### Native extension integration boundary

The host collects native contributions from the configured extension factories
through the [contribution contract](conventions/durable-contributions.md).
Each contribution supplies native tools, sections, hooks, wrappers, and tasks.
The host reports configured extensions with no native contribution in status
and the prompt. It does not instantiate a shadow SessionManager or dispatch
ordinary lifecycle callbacks against Durable state.

Public `createAgentSessionServices()` preserves cwd-bound resource loading,
project trust, settings, and configured providers. Its `ModelRuntime` implements
Durable's model interface directly. Prompt composition uses exported resource
accessors and `formatSkillsForPrompt`; no private prompt builder is imported.

The host supplies image-capable read and native coding tools. Codemode uses
public `CodemodeSandbox`; MCP uses public `McpClient`. Nested invocation retains
its intent and result as a native task and runs the selected tool hooks.
Cancellation of an observation does not cancel admitted work. The contribution
host's close callbacks run after its abort signal and before storage closes.

The published coding-agent package excludes the experimental peer client and
service distribution, and the extension API exposes no live InteractiveMode
view to mount. The agent dashboard therefore composes public chat components,
a native editor, and bounded scrolling for selected Durable agents. The primary
stays on its native screen beneath the temporary overlay. See the
[dashboard and agent console](../extensions/agent/README.md#dashboard-and-agent-console)
and [roster contract](../extensions/agent/README.md#roster-and-coverage) for
controls, status presentation, timestamps, and failed-refresh behavior.

## Released ordinary-session changes

Verified 2026-10-04 against installed 1.0.2 `CHANGELOG.md`,
`docs/{sdk,extensions,settings,providers}.md`, and the
implementation paths below. The first list shipped in 0.99.0 and remains a
release contract in 1.0.2. The second list shipped in 0.99.2; its MCP and
codemode discovery changes are in
[MCP and deferred tool discovery](#mcp-and-deferred-tool-discovery).

Shipped in 0.99.0:

- `dist/core/session-manager.js` creates a new session file once a user or
  assistant message exists. Setup-only and custom entries remain buffered until
  then. The [Footer retention boundary](#footer-retention-boundary) and
  [Idle session configuration](#idle-session-configuration) use this released
  boundary, not a first-assistant-only rule.
- `dist/core/package-manager.js` suppresses automatic peer-dependency
  installation for managed npm and git packages;
  `dist/core/resource-loader.js` warns when an extension package declares
  host-provided Pi modules in `dependencies`. A physical dependency copy can
  bypass the running-install alias map; the warning does not prove resolution.
- `provider_stream_event` observes parsed provider events before normalization.
  Installed `dist/core/sdk.js` forwards the provider, API, model, and event data
  through the extension runner. The data is adapter-owned and read-only; the
  event is notification-only and not persisted. Existing request and response
  hooks remain separate.
- Built-in extensions use `builtin:<name>` identities and load after project
  trust. `-builtin:<name>` disables one through the `extensions` setting;
  `--no-extensions` disables them unless explicitly selected with
  `-e builtin:<name>`. SDK sessions must supply the built-in factories they
  need; the CLI's built-in set is not an SDK default.
- Successful RPC `prompt`, `steer`, and `follow_up` responses include
  `data.disposition`. `prompt` reports `started`, `queued`, or `handled`;
  queue commands report `queued` or `handled`. Installed
  `dist/modes/rpc/rpc-mode.js` returns these responses;
  `dist/core/agent-session.d.ts` also exposes `QueuedInputDisposition` from
  `steer()`/`followUp()`. `prompt()` still returns `Promise<void>` and reports
  `PromptDisposition` through `PromptOptions.preflightResult`, not its return
  value. Disposition describes that input's admission, not task acceptance or
  completion; a client must not await settlement for a consumed input.

Shipped in 0.99.2:

- `AgentSessionOptions.usesDefaultTools` (`dist/core/agent-session.d.ts`) marks
  a session whose initial tools come from the `defaultTools` setting.
  `createAgentSession()` sets it when neither `tools` nor `noTools` is given
  (`dist/core/sdk.js`). `AgentSession.reload()` then activates tools newly added
  to the setting (`dist/core/agent-session.js`). Removed entries stay active,
  tools disabled during the session stay disabled unless newly added, and
  `--tools`, `--no-tools`, and `--no-builtin-tools` override the setting, also on
  reload (`docs/settings.md`). A session created with explicit `tools` or
  `noTools` does not receive this activation.
- The default prompt's tool list omits tools whose declarations
  `prepareLoadout()` hides with `hiddenDeclarations`. Those tools stay active and
  callable (`dist/core/agent-session.js`).
- `registerCommand()` throws when the command has no non-empty string name or no
  function `handler`, and the extension then fails to load with an error
  (`dist/core/extensions/loader.js`, `CHANGELOG.md`). Extension test doubles that
  register commands need both.
- For a tool that declares `constrainedSampling: { type: "json_schema" }`,
  Anthropic strict mode rejects keywords such as `minimum`, `maximum`,
  `maxItems`, `uniqueItems`, a `minItems` other than 0 or 1, and unsupported
  `format` values. Such a tool is sent non-strict unless its `strict` option is
  `"require"`, which throws (`pi-ai/dist/api/constrained-sampling.js`,
  `pi-ai/dist/api/anthropic-messages.js`).
- When no API key, token, or authorization header resolves, the Anthropic
  provider can use workload identity federation. It requires the variables
  `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, and
  `ANTHROPIC_IDENTITY_TOKEN_FILE`, and passes `ANTHROPIC_SERVICE_ACCOUNT_ID` and
  `ANTHROPIC_WORKSPACE_ID` when set. The Anthropic SDK exchanges and refreshes the
  access token and re-reads the identity token file, which must stay fresh in
  long sessions (`pi-ai/dist/providers/anthropic.js`,
  `pi-ai/dist/api/anthropic-messages.js`, `docs/providers.md`).

Shipped in 1.0.0:

- Restored or reloaded tools that are not registered yet remain pending until
  registration or the next agent run (`dist/core/agent-session.js`). This keeps
  deferred MCP tools active when their server reconnects before the next run.
  A tool selection that deactivates a tool clears the pending set; an addition
  alone preserves it. Exposure categories do not change.

Shipped in 1.0.1:

- Trusted project MCP selection overrides and Client ID Metadata Documents use
  the contracts in [MCP and deferred tool discovery](#mcp-and-deferred-tool-discovery).
  Tool renderer resolution is independent of registration, including resumed
  MCP calls and HTML exports.
- Pi AI's Anthropic adapter sends later tool definitions inline with
  `inline-tools-2026-09-15`, including same-name redefinitions, when the model
  supports mid-conversation system messages and tool changes and the initial
  tool set is nonempty. Otherwise it sends the current tool list
  (`pi-ai/dist/api/anthropic-messages.js`). This is request construction, not a
  measured cache saving for every provider or agent.
- `isRetryableAssistantError` recognizes model-capacity errors
  (`pi-ai/dist/utils/retry.js`). Ordinary session retry, Stash's standalone retry,
  and Durable generation/compaction retain their existing policies; the new
  classification does not enable retries when a policy disables them.
- Cloudflare Clef and Clef Flash are classifier catalog entries, not chat models.
  Discover them through `models.getAvailableOfType("classifier")` and execute
  them through `models.classify()`, or the public model runtime's typed methods.
  The Cloudflare adapter handles their direct answer envelope as well as Jev's
  nested envelope (`docs/models.md`, `pi-ai/dist/providers/data/cloudflare-workers-ai.json`,
  and `pi-ai/dist/api/cloudflare-workers-ai-system-one.js`). A chat-only registry
  result or credential availability is not classifier absence or remote health.
- Coding-agent pins `brace-expansion` 5.0.12 directly and removes its published
  `npm-shrinkwrap.json`. npm installations no longer pin the complete transitive
  graph; global npm `pi update` recommends the managed installer. Installation
  choice and dependency resolution remain separate from harness activation
  (`package.json`, `dist/package-manager-cli.js`, and `docs/quickstart.md`).
- Ordinary OAuth screens expose `app.message.copy`, default `ctrl+x`, for the
  sign-in URL. Sign in with ChatGPT stops when its callback port is occupied,
  rather than let the browser reach another login's callback
  (`docs/keybindings.md`, `dist/modes/interactive/components/auth-url.js`, and
  `pi-ai/dist/auth/oauth/openai-chatgpt.js`). No sign-in trial is implied.
- CLI `--models` ignores blank comma-separated entries. Catalog updates supply
  dashed Cloudflare AI Gateway Claude IDs, long-context Bedrock pricing tiers,
  Together's renamed DeepSeek reasoning controls, and the NVIDIA default selection.
  Bedrock's Claude adapter requests stale signed-block removal on prefix changes
  only for supported models outside GovCloud. These remain upstream adapter and
  catalog responsibilities, not harness-owned ID or pricing tables
  (`dist/cli/args.js`, `dist/core/model-resolver.js`,
  `pi-ai/dist/providers/data/{cloudflare-ai-gateway,amazon-bedrock,together,nvidia}.json`,
  and `pi-ai/dist/api/bedrock-converse-stream.js`).

Shipped in 1.0.2:

- `samplingParamsByThinkingLevel` configures sampling by Pi thinking-level keys
  in `models.json`. Unsupported levels are clamped first. Pi merges model
  `samplingParams`, the effective level's override, and request
  `samplingParams`, in that order; later values win per key. Missing levels
  inherit model defaults. `modelOverrides` merges each level per key rather
  than replace the complete map. Checked sources are
  `dist/core/{model-config,provider-composer}.{js,d.ts}`, `docs/models.md`,
  and `pi-ai/dist/api/simple-options.{js,d.ts}`.
- Only `openai-completions`, `openai-responses`, and
  `azure-openai-responses` apply these sampling fields to requests
  (`pi-ai/dist/api/{openai-completions,openai-responses,azure-openai-responses}.js`).
  Other APIs ignore them. This is an API boundary, not a guarantee for every
  provider that advertises OpenAI compatibility.
- Native agents use configured models from the running coding-agent services
  selected through `getPackageDir()` and `loadPiRuntime()`
  (`extensions/agent/{index,durable-services}.ts`). Durable generation and
  compaction pass the conversation's non-off thinking level as `reasoning`;
  off omits it, and the sampling resolver defaults to off. Stash distillation
  passes the selected thinking level by the same convention and its own UUIDv7
  session ID (`extensions/stash/distill.ts`). Both paths therefore inherit
  per-level sampling on those APIs without a harness-owned merge.
- Registry chat records intentionally project no sampling fields
  (`extensions/registry/models.ts`, `buildModelRecord`). They are capability,
  availability, scope, and price records, not complete model configuration.
  No registry sampling feature is required for the current use path. Codemode's
  `models.getModelsOfType`, `models.getAvailableOfType`, and
  `models.getModelOfType` preserve sampling fields when present and drop
  `headers` in ordinary and native hosts
  (`dist/extensions/codemode/execute.js`, `toModelInfo`, and
  `extensions/agent/durable-execution.ts`). Visibility does not prove request
  resolution or remote support.
- OpenRouter updates chat prices and limits and adds Clef, Clef Flash, and
  Perplexity Decider classifier entries; NVIDIA adds Nemotron 3 Super
  (`pi-ai/dist/providers/data/{openrouter,nvidia}.json`). Chat registry records
  inherit current chat metadata; classifier discovery uses Codemode's typed
  model APIs, not chat-only registry queries. The harness keeps no parallel
  model ID or pricing table.

These 1.0.2 boundaries are source-verified 2026-10-04. No paid model or provider
cache trial was repeated for them.

## Current ordinary-session contracts

Verified 2026-10-04 against installed 1.0.2 `docs/{sdk,extensions,virtual-models}.md`,
`dist/core/{sdk,agent-session,agent-session-services,model-runtime}.js`,
`dist/core/extensions/{types.d.ts,runner.js}`,
`dist/core/session-manager.d.ts`, `pi-ai/dist/types.d.ts`, and
`pi-agent-core/dist/{agent.d.ts,agent-loop.js}`.

- `SessionManager` owns finalized request history. `AgentSession` supplies its
  canonical projection before each request and refreshes
  `agent.state.messages` as an inspection cache. Assigning that cache does not
  restore persisted context. Restore entries through session construction or
  use the public navigation and append/refresh methods.
- `SessionEntry` includes `ContextEditEntry`. Its branch-relative omission or
  content replacement changes projected context without rewriting the original
  entry. Raw-entry validators must recognize this current shape.
- `finishTurn` replaces `shouldStopAfterTurn`. It runs after the complete tool
  batch, before steering consumption, and returns `{ action: "end" }`,
  `{ action: "continue" }`, or no decision. Error and aborted responses still
  exit the low-level loop. Ending that loop does not bypass `AgentSession`
  retries, recovery, or queued work.
- Provider `TranscriptContext` contains messages. System prompt sections and
  tool declarations now travel through `SystemMessage` entries, including
  additions and removals. Code that reads `context.systemPrompt` or
  `context.tools` must use the current transcript contract instead.
- `Message` includes the `system` role. Exhaustive consumers must distinguish
  it from user, assistant, and tool-result messages.
- The request-time `context` hook sees conversation messages
  without system messages; Pi preserves or restores prompt and tool state.
  The later `context_with_system` hook sees the full transcript and owns its
  returned prompt/tool declarations for that request. A prompt forced by
  `before_agent_start` still applies afterward. Keep conversation filters on
  `context`; use the full-transcript hook only when that ownership is required.
- Tool-call arguments use `JsonObject`; stored tool-result details use strict
  JSON types. Test fixtures and adapters must validate or construct those
  types rather than retain `Record<string, unknown>` at the wire boundary.
- `ExtensionAPI.on()` returns an unsubscribe function. Extension test doubles
  must match that lifecycle contract.
- `createAgentSessionServices` and `createAgentSessionFromServices` supply
  ordinary resources and extensions (`dist/core/agent-session-services.js`,
  re-exported from `dist/index.js`). `AgentSessionRuntime` owns new-session,
  switch, fork, clone, and import replacement. A replacement changes the
  `AgentSession`; event subscriptions and extension bindings belong to the
  new session.
- `ModelRuntime` owns credential resolution, cached model catalogs, availability,
  and optional remote refresh. Local availability is not remote provider health.
  `classify()` and `generateImages()` use request-time authentication;
  `getAllModels()` and the type-specific/all-available accessors cover chat,
  image, and classifier entries. Chat-facing catalog reads remain chat-only.
  Consumers must choose the catalog that matches their operation.
- `pi.registerVirtualModel()` separates the selected model/reasoning pair from
  the physical pair dispatched for each request. Session selection and
  `ctx.model` name the virtual model; assistant messages name the physical
  responder. Usage attribution follows the physical response. Context usage
  uses the latest physical responder's limits; before that response exists,
  Pi uses the virtual model's declared limits, if any.

`pi.registerToolRenderer()` chooses renderers independently of tool registration.
The runner chains resolvers in extension load order, then the registered tool;
`next() ?? mine` supplies a fallback. Interactive transcript components and HTML
exports both use this resolution. MCP installs a fallback for `mcp__` tool names,
so collapsed retained calls keep bounded rendering before a server connects. The public
`ToolRenderers` type contains presentation methods, not an executable tool
contract. It grants no invocation, activation, or discovery. These boundaries are
defined in `dist/core/extensions/{types.d.ts,runner.js,loader.js}`,
`dist/modes/interactive/{interactive-mode.js,components/tool-execution.d.ts}`,
and `dist/core/export-html/tool-renderer.js`.

Tool exposure is also an ordinary extension contract. `direct` tools are
model-declared and callable while active; `model-only` tools are declared but
not callable through `ctx.executeTool()`. Registered `codemode` and `deferred`
tools are callable without activation, while `hidden` tools are unreachable.
The codemode description lists `codemode` tools that fit `codemode.inlineBudget`
and omits `deferred` tools, and
`tool_search` loads inactive `codemode` and `deferred` tools. `namespace`
(`name`, `description`, and `instructions`) groups tools, `annotations` supply
unverified behavioral hints, and `prepareLoadout()` adjusts descriptions or
hides declarations without withdrawing callable tools. `ctx.tools` reports
callable tools; `pi.getAllTools()` reports exposure, the namespace with its
instructions, and annotations. The
`defaultTools` setting accepts `+name` and `-name`, so enabling an orchestrator
does not require replacing the default tool list. Registration, activation,
model declaration, and nested-call access are distinct facts.

These contracts apply to the ordinary SDK without a durable-runtime migration.
Current provider transcripts, lifecycle registration, and session replacement
remain ordinary-host responsibilities.

## Ordinary custom-message presentation

Verified 2026-10-04 against installed coding-agent 1.0.2
`dist/modes/interactive/components/custom-message.js`,
`dist/modes/interactive/interactive-mode.js`, `dist/core/agent-session.js`,
`dist/core/messages.js`, and the public `MessageRenderer` declarations.
`registerMessageRenderer` receives native expansion state. The default custom
message component displays its complete body even when collapsed; a registered
renderer owns its presentation without altering the retained message.
The host applies its global tool-expansion state to these components.
Renderer failure falls back to the default body, so malformed metadata must
produce an explicit safe view rather than throw.

Display and delivery are separate contracts. An idle custom message with
`triggerTurn: true` starts a provider turn; active steering preserves the host
queue. Provider conversion includes message content but omits display metadata.
The agent extension uses the native rendering boundary, not queue changes, for
readable Markdown bodies, source labels, and completion states. Its default view
shows the body within an explicit display bound; native expansion adds source
details below that body. Longer reports occupy more transcript space.
Peer-operation outcomes remain separate from primary-session state and task
acceptance. Arbitrary message arrivals prevent a permanent-visibility promise.
Controlled provider tests establish content and turn behavior; isolated terminal
trials establish display and expansion behavior, not model
judgment about the evidence. Those runtime trials were not repeated for 1.0.2.

## Configuration and source context

Ordinary resource and message boundaries checked 2026-10-04 against installed
1.0.2 `dist/core/resource-loader.js`, `dist/core/messages.js`,
`docs/message-types.md`, and `docs/sdk.md`.

- Ordinary discovery accepts additional skill paths. Reusable source selection
  does not require a replacement resource loader.
- Cwd selects project context and trust inputs. A stored conversation or fork
  does not perform ordinary project discovery by itself.
- Ordinary custom messages become provider messages with role `user`.
  Conversion omits `details` and `display`; source labels and authority limits
  belong in model-visible content, not only metadata.
- Keep reusable input resolution before ordinary session construction. Replace
  local selection only when the adopting host supplies its file resolution,
  precedence, source applicability, and delivery semantics. Kernel adoption
  alone does not supply these application contracts.

## Resource contributions and interactive lifecycle

Verified 2026-10-04 against installed coding-agent 1.0.2.
Current installed extension and keybinding documents supply the public guidance;
resource, skill, runner, cache-warmer, session, and extension type files define
the detailed behavior below.

- `resources_discover` contributes paths after `session_start`. Installed
  `dist/core/resource-loader.js` appends those paths to its existing lists.
  `dist/core/skills.js` and the loader's prompt deduplication keep the first
  same-name resource and report collisions. A returned path is not proof that
  its resource became the selected command or skill. Keep normal skills and
  prompts on the [worktree promotion boundary](conventions/worktrees.md#pi-configuration).
  Pi's explicit `--skill` and `--prompt-template` paths support isolated draft
  loading without an automatic worktree discovery hook.
- Installed `dist/core/extensions/runner.js` wraps extension `select`,
  `confirm`, `input`, `editor`, and `custom` calls in `ui_prompt_start` and
  `ui_prompt_end`. Nested or overlapping calls share one span, which ends after
  all of those calls settle. These notification-only events describe an open UI
  span, not proof that an operator response is necessary: custom UI also hosts
  asynchronous work.
- `cache_warming_decision` reports the host's proposed action and estimates.
  The runner uses the last handler override; handlers still receive the original
  event. Installed `dist/core/cache-warmer.js` checks cancellation and deadlines
  after that hook, then records `cache_warm` usage only after a successful
  response. A decision event establishes neither completion nor current cache
  state. Pi owns the schedule and exposes its status through `/session`.
- Installed `dist/core/agent-session.js` reloads resources and the extension
  runtime while retaining its SessionManager. It emits shutdown and startup
  events with reason `reload`. Reload does not select another conversation or
  establish that a separately stored handover belongs to the current effort.
- `registerShortcut` handlers receive `ExtensionContext`, not the command-only
  context. Panel helpers invoked from a shortcut must use that actual contract;
  a cast does not supply command-only session controls. Installed
  `dist/core/extensions/types.d.ts`, `docs/extensions.md`, and
  `docs/keybindings.md` define the registration and key formats.

These are installed-source boundaries. UI focus and input behavior require
checks through the interactive host, not merely a successful registration.

## Idle session configuration

Agent configuration writes native `pi.agent` and `agent.meta` documents. The
control refuses active conversations; the runtime validates the selected model
and clamps reasoning through Pi's public model helper. Roots and children store
explicit model and reasoning choices so native hooks read the same attribution.
A blank name clears `agent.meta.name`. An explicit model is validated against
the configured catalog before the setter; an `agent_attach` model repair that
fails returns its failure instead of a status snapshot. Configuration starts no
task and changes no global model defaults.

## Footer retention boundary

Pi Durable retains conversation usage; the agent host publishes bounded native
observations for the dashboard and footer. Neither surface reconstructs usage
from ordinary JSONL or writes ordinary footer checkpoints. The footer applies
the current primary's creating-owner scope, not the whole discovered roster.
See [roster and coverage](../extensions/agent/README.md#roster-and-coverage)
for session figures, cost markers, clearing, and refresh behavior.

Catalog-backed discovery is bounded rather than a frozen inventory. Continuations
resume after a visited filename; ordinary catalog updates do not invalidate them.
The primary status overview summarizes a supplied page and exposes no usable
continuation. Fleet status is a separate sampled model-evidence view, also
without continuation. Use the [agent controls](../extensions/agent/README.md#controls)
and [roster contract](../extensions/agent/README.md#roster-and-coverage) for
current discovery and coverage rules. These are host projections over Durable
records, not upstream archive-query guarantees.

## Ordinary-agent reload and recovery boundary

The ordinary primary's reload ends only its client callbacks. Durable storage
hosts remain independent processes. The next primary startup reconnects and
registers its primary channel, receives retained reports and outcomes through
host durable-delivery, and relaunches dead hosts with unfinished work. The host
routes catalog owners as untrusted follow-ups; a noncatalog owner is reached
through its registered primary channel, and only an absent or proven-dead owner
endpoint permits a labeled fallback that broadcasts to every live registered
primary within one bounded discovery, preserves the original owner identity,
and stays pending unless discovery and every delivery complete.
Canceled observation waits release their listeners without canceling tasks.

A native `agent_command` reload requires idle storage and settled controls.
It reloads cwd-bound resources and native registrations, then reopens the same
storage. A protocol change in a retained ordinary primary manager requires a Pi
restart. The host never reads old ordinary agent sessions as Durable records.

## Automatic owner check-ins

The installed boundary is rechecked 2026-10-04 against Pi Durable 1.0.2
`dist/{types.d.ts,harness/types.d.ts,harness/live.d.ts,harness/usage.d.ts}` and
`dist/harness/{harness.js,scheduler.js}`. The agent extension's real Harness and
ordinary-primary faux-provider tests retain their earlier runtime scope; those
tests were not repeated for this source comparison.

The agent host's `pi.host` built-in supplies the check-in definition independently
of configured native agent tools. It arms unanswered-task check-ins in the
delivery-intent commit; local native Reporter admissions arm through a retained
checkpoint only when the host registry supplies that task. Public
`Conversation.submit()` owns a separate commit, so the deadline task reacquires
its submission by the same request ID rather than create a raw submission.
`TaskRuntime` exposes an invocation-bound conversation handle but no submission
lookup; the reacquired submission supplies `wait(context)`. Each deadline races
that wait, releases both waiters, and writes its report with the next checkpoint
atomically. Settlement retires the deadline task promptly. Restart collapses
missed intervals into one notice and retains the original cadence and source IDs.
Model prompts through `agent_spawn` and either `agent_place` branch, plus
`agent_send` tasks, use the same environment default and per-call override.

Neither `Tx` nor the public Harness handle exposes `now()`. The host passes
its resolved `HarnessOptions.now` callback to intent admission; native Reporters
and fired timers use `TaskRuntime.now()`. The installed Harness supplies that
same clock to its scheduler and deadline waits. Without an override it is
`Date.now`, so production clocks agree; injected-clock tests also agree without
a wall-clock mock.

Check-ins use the existing report route, version checks, acknowledgement, and
fallback contract. Pending rows coalesce per watched task and owner, and
settlement suppresses stale rows before dispatch and removes every corresponding
check-in row across owners, including acknowledgements and fallback markers.
The digest exists only in `report.message`. A live model owner wakes;
operator notices and fallback broadcasts stay quiet. One accepted fallback
broadcast per task and owner prevents repeat broadcast noise. Reports and
check-ins delivered into native owners arm no recursive check-ins.

The native tool slots and task records expose no exact tool-start timestamp.
The digest labels the tool-call age instead. Native usage is cumulative per
conversation, so the notice labels cost as retained conversation total rather
than task cost. Bounded recent tool-call counts remain lower bounds. Primary
presentation says still working, not finished; check-ins are not final results.

## Current-session evidence retrieval

Bounded access, discovery, read-only capture, and context projection verified
2026-10-04 against installed 1.0.2 `dist/core/session-manager.{d.ts,js}`,
`dist/core/extensions/types.d.ts`, and `docs/session-format.md`.

- `ExtensionContext.sessionManager` exposes `ReadonlySessionManager`.
  `getEntry(id)` reads the existing map; current leaf/session identifiers need
  no session-file read.
- `getBranch()` follows the full parent chain. `getEntries()` filters the whole
  session and `getTree()` constructs the whole tree. These methods accept no
  visit limit. Bound ancestry queries by repeated `getEntry()` calls with an
  explicit stop condition, not by truncating a completed scan.
- `list()` and `listAll()` collect full inventories. Progress callbacks and
  cancellation do not supply cursor, visit, or byte limits. `findById()` still
  enumerates a directory. Output truncation does not bound these producers.
- `buildContextEntries()` selects raw active-path entries with compaction
  applied; it does not apply context edits. The read-only interface also exposes
  `buildSessionProjection()`, which applies omissions and content replacements
  while retaining each contribution's `sourceEntry`. Omitted entries contribute
  no messages. `buildSessionContext()` uses that projection, but is not part of
  `ReadonlySessionManager`. Choose raw evidence or edited context explicitly;
  neither is a bounded archive query.
- Stored role, custom type, or summary metadata does not establish fresh authority.
- `SessionManager.open()` reads a complete file and repairs an unfinished tail.
  Do not use it to inspect a foreign active file. A known, byte-bounded read-only
  capture can use public `parseSessionEntries()` and `SessionManager.inMemory()`
  without a private decoder or a write to its source. The parser skips malformed
  JSON lines; it supplies neither structural validation nor capture limits.
  Oversized captures need an explicit unavailable state; capture time limits
  freshness.
- The ordinary API still does not provide bounded discovery of unknown alternate
  branches. Neither a complete tree scan nor a durable live view is a paged
  archive query. Do not add a parallel raw-file index to imply that contract.

## Ordinary-session completion delivery

Verified 2026-10-04 against installed 1.0.2 `dist/core/agent-session.js`,
`dist/core/messages.js`, and `dist/core/extensions/{runner.js,types.d.ts}`.

- `turn_end` and `agent_before_settle` are actionable extension boundaries.
  Dispatch them through `ExtensionRunner.emitBoundary()`,
  not the notification `emit()` API. Handlers receive persisted source IDs at
  `turn_end`, accumulated draft entries, and a rebuilt context preview. Allowed drafts are `custom`,
  `custom_message`, `context_edit`, and `compaction`; a null compaction retention
  target keeps no preceding entries. Pi validates the complete proposal before
  appending it in order, but persistence is not transactional.
- `continue: true` requests one next provider call per boundary invocation;
  natural tool or queue continuation satisfies that request. `continue: false`
  does not suppress natural work. Guard repeated requests rather than return
  unconditional continuation. `emitBoundary()` replaces accumulated draft
  entries when a handler returns `entries`; an additive handler must include
  the preceding drafts. Agent self-compaction consumes an explicit tool request
  once at `turn_end`, retains that complete tool batch, and proposes the supplied
  summary through this native boundary. Its boundary subscription exists only
  while a request is pending; it leaves the continuation flag unchanged and
  relies on normal tool-result continuation. It does not call manual `compact()`,
  which aborts the active run, or start a replacement run from a callback.
- `agent_before_settle` follows ordinary retries, recovery, and queued work.
  `agent_settled` is notification-only: runs requested there wait until all
  settled handlers finish. Abort during pre-settle handlers preserves valid
  returned entries but suppresses their requested continuation.
- Steering queues a custom message for the next model-call boundary after tool
  results. Follow-up waits until work ends. An idle trigger starts a turn.
- During streaming, `triggerTurn: false` defers custom-message insertion until
  the turn's tool results are in state and history. It does not insert a custom
  message between an assistant tool call and its result.
- A `context` hook can omit completion messages when exact collection evidence
  already appears in the same context. This changes provider input, not retained
  history, and does not prove model acceptance. A persisted context edit has
  different lifetime semantics; it is not a drop-in replacement for a filter
  conditional on evidence still present in the request.
- Preserve source identities, per-session order, and explicit reply links.
  Display order does not prove causality. Delivery, context observation, and a
  reply establish different facts; none alone proves understanding or action.
- Keep completion delivery on the selected worker host's public message surface.
  A report view does not itself require another durable inbox, receipt journal,
  or terminal renderer. Preserve exact result access when the host changes.

**Extension-launched prompt lifetime.** In installed 1.0.2,
`ExtensionAPI.sendUserMessage()` returns `void`
(`dist/core/extensions/types.d.ts`). The callback supplied to `bindCore()` in
`dist/core/agent-session.js` catches errors but does not return the underlying
prompt promise. An extension command can return while that nested prompt still
awaits input handlers, authentication, or other preflight work. The active-run
flag is set later, in `_runAgentPrompt()`, so `isIdle` and `waitForIdle()` do not
include that preflight. Neither `abort()` nor disposal owns its admission;
`AgentSessionRuntime.dispose()` delegates session disposal after shutdown hooks
(`dist/core/agent-session-runtime.js`). A single-shot consumer therefore cannot
claim complete output, error, usage, or cancellation evidence for asynchronous
model work launched through this API. Completeness is blocked at the missing
public admission and cancellation boundary, not repaired by disposal or a
settlement listener. Preserve commands that start no model work: an unconditional
wait for `agent_settled` would wait for a run those commands never start.

## Fork and result boundaries

Verified 2026-10-04 against installed 1.0.2 `dist/core/session-manager.js`,
`dist/core/agent-session-runtime.js`, `dist/modes/interactive/interactive-mode.js`,
and `dist/main.js`. Ordinary `/fork`, `/clone`, and `--fork` use
SessionManager. A durable conversation fork uses its own storage, entries, and
ownership model; it does not replace an ordinary-session continuation.

Pi Durable's `SubmissionRecord` retains input and answer entry IDs, while
`TaskRecord` retains input and terminal `TaskOutcome`. Its entry and submission
lookups support reacquisition after reopen
(`pi-durable/dist/{types.d.ts,harness/types.d.ts}`). These are substantive
retention primitives, not just status labels. The agent host adds bounded
inspection and owner-directed receipts over those public records. Each native
fork retains the source unchanged in the same storage. The former ordinary
worker and detached-run implementations are removed; their old files on disk
remain untouched.

## Convergence decisions

The agent slice adopts the public Durable runtime rather than reproduce its
scheduler or transcript. The ordinary SDK remains the primary terminal host.

| Capability | Current owner and boundary |
|---|---|
| Agent execution and recovery | Durable generation, ToolTask, checkpoints, native replay classification, and retained outcomes inside independent storage hosts |
| Resources and providers | Public cwd-bound coding-agent services; native contributions supply tools, prompts, hooks, and commands |
| Process ownership | Agent host writer claim before storage open; same-user Unix control socket over the public `pi-server`/`pi-client` transport (private 0700 directory, owner-only 0600 socket, exact `serverId` handshake) and automatic dead-owner recovery |
| Nested tools | Native call tasks, selected ToolTask hook chain, argument validation, committed intent, replay policy, and structured results |
| Observation | Public native entries, documents, submissions, and task views; bounded catalog projections with explicit coverage. [Agent controls](../extensions/agent/README.md#controls) distinguish status summaries, fleet model evidence, and discovery; cold inspection uses a bounded SQLite snapshot without resume |
| Owner delivery | Host durable-delivery owns retained intents, receipts, reports, and automatic unanswered-task check-ins; catalog follow-up or registered primary channel; labeled broadcast fallback only for an absent or dead owner, acknowledged only over complete discovery and deliveries; no exactly-once cross-host promise |
| UI | Dashboard over an untouched native primary; roster and selected live conversation, full-window agent console, contextual actions, and explicit coverage. Host-owned Durable view and task-graph watches supply live frames. An embeddable InteractiveMode view and the experimental coding-agent client remain unpublished |
| Handover and doctrine | Native transport and retention carry content; its meaning and authority remain application concerns |

## Refresh

After each Pi upgrade and before a host-dependent decision:

- Resolve npm publication, the active installation, the checkout lockfile, and
  upstream refs separately. Keep wildcard peers and refresh the lockfile.
- Check published exports, running-install aliases, declarations, and nearest
  implementation. Do not infer deployed behavior from a work-package status.
- Recheck the ordinary SDK and the separate Pi Durable package independently.
  Follow the affected host's storage, resources, lifecycle, observation, and
  result contracts.
- Run repository gates after consumer repairs. Source inspection and successful
  dependency installation are not substitutes for those gates.
- Compare the previous and current published packages file by file, excluding
  source maps and the coding-agent release bundle. Re-read each changed file that
  a section cites. Carry a claim forward, with the new date, only when its cited
  files are unchanged or the changed hunks do not touch the claim. A file
  comparison establishes file content, not runtime behavior; mark a claim that
  rests on an earlier runtime trial as not repeated.
- Replace dated claims in place. If a defining source is unavailable, mark the
  affected claim unverified rather than preserve a stale verification date.

[release]: https://github.com/earendil-works/pi/releases/tag/v1.0.2
[durable-readme]: https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/durable/README.md
[durable-package]: https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/durable/package.json
[durable-post]: https://earendil.com/posts/pi-durable/
[pi-one-post]: https://earendil.com/posts/pi-1-0/
