# Pi durable-harness track

Pi's ordinary SDK, durable AgentHarness, Pico3 kernel, and Pico5 runtime are
distinct runtime contracts. This repository uses host-owned execution and
observation where those contracts preserve its capabilities. An exported
kernel does not by itself replace ordinary extension loading, project trust,
resource discovery, or submitted-result retrieval.

## Standalone distillation boundary

Verified 2026-09-30 against installed coding-agent 0.99.2.
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
cancellation, and storage boundaries, not live-model output quality.

## Policy pre-call guidance boundary

Verified 2026-09-30 against installed coding-agent 0.99.2.
Policy's `before_agent_start` handler returns a custom message before command
selection: installed `dist/core/extensions/runner.js`
`emitBeforeAgentStart()` awaits handlers and collects messages;
`dist/core/agent-session.js` appends them before `_runAgentPrompt()`.
The public contract is `BeforeAgentStartEventResult.message` in
`dist/core/extensions/types.d.ts` and installed `docs/extensions.md`.
Policy uses that ordinary hook for its bounded shell-contract snapshot rather
than a tool-call interception that occurs after the model selects a command.
The policy hook tests exercise the real runner, custom-message conversion, and
first controlled model request. They do not establish model compliance.

Nested calls through `ctx.executeTool()` use the ordinary argument-validation,
`tool_call`, and `tool_result` pipeline. Installed `dist/core/agent-session.js`
binds the nested runner to `_beforeToolCall(context, parentToolCallId)`;
`dist/core/nested-tool-calls.js` emits execution events with that parent ID and
records bounded `nestedCalls` metadata on the calling tool's result. Policy's
`tool_call` interception therefore also covers nested calls, including those
from codemode scripts. This does not move the `before_agent_start` snapshot:
pre-selection guidance and execution interception remain separate boundaries.

## Native codemode composition

Verified 2026-09-30 against installed coding-agent 0.99.2
`docs/{sdk,extensions,settings}.md`, `examples/sdk/14-codemode-mcp.ts`, and
`dist/extensions/codemode/{index,tool,execute}.js`. The CLI supplies the built-in
factory; SDK hosts supply the exported `createCodemodeExtension()` themselves.
Activating it through `defaultTools: ["+codemode"]` preserves the inherited tool
selection. Default `on` mode preserves direct declarations alongside script
access. No replacement host or shared adapter is needed.

In `on` mode, `prepareCodemodeLoadout()` in `dist/extensions/codemode/tool.js`
appends a TypeScript declaration of each declared tool's input and output
types to that tool's description. `codemode.inlineBudget` bounds only
codemode's own listing of undeclared tools, and local schema references expand
inline. Every declared tool therefore carries its parameter schema twice (JSON
schema and TypeScript) plus its output type on each request. Trimming an
`outputSchema` changes what scripts receive, and `codemode` exposure changes
how the model reaches a tool, so the harness keeps both; a smaller appended
declaration is an upstream renderer change.

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
request against 0.99.1. Those sessions were not repeated for 0.99.2. The source
files on those paths (`dist/core/tools/read.js`, `dist/core/nested-tool-calls.js`,
`dist/core/extensions/runner.js`, and `dist/core/messages.js`) are unchanged in
0.99.2. Such sessions establish pipeline behavior, not model compliance,
exhaustive source coverage, or parity with old live owners retained across a
reload. `agent_compact` uses `model-only` exposure because its continuation
contract requires a model-issued tool call.

## MCP and deferred tool discovery

Verified 2026-09-30 against installed coding-agent 0.99.2
`docs/{mcp,extensions,cli,settings,sdk}.md`, `dist/core/mcp-servers.js`,
`dist/core/extensions/{types.d.ts,loader.js}`, `dist/core/agent-session.js`,
`dist/extensions/mcp/{index,tools,config}.js`,
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
  servers with `codemode` or `deferred` tools connect (`docs/cli.md`). A server's
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
  `describeNamespace().instructions` to the model. The registry extension's contract, stated
  in its [README](../extensions/registry/README.md) and not a Pi behavior, is to
  report `namespace.name` and `description`, omit `instructions`, and set
  `instructionsOmitted: true` when instructions exist. Read the instructions with
  `describeNamespace()` in a codemode script.
- **Server authentication options.** An HTTP server may set `auth: { provider }`
  to send that provider's current `/login` token as the bearer token, or
  `oauth.clientName` to change the client name sent at OAuth registration. Only
  the global `mcp.json` and extension registrations may use `auth`, and its URL
  must use https unless the host is loopback (`dist/extensions/mcp/config.js`,
  `dist/core/mcp-servers.js`, `docs/mcp.md`).

## Checked source boundary

Verified 2026-09-30. The active installation, npm `latest`, checkout
dependencies, and the lockfile resolve Pi 0.99.2. The manifest retains wildcard
Pi peers; the lockfile records the resolved dependency graph rather than a
supported-version ceiling. TypeBox resolves to 1.3.27 in both. Dependency
installation is separate from worktree source synchronization; each checkout
needs `npm ci` after a lockfile update. Repository tests and controlled runtime
checks establish their exercised contracts, not host-wide compatibility with
every provider or interactive flow.

| Source | Checked state (2026-09-30) |
|---|---|
| Installed coding agent and agent core | 0.99.2, from each package's `package.json` and installed declarations/source |
| Checkout Pi packages and lockfile | 0.99.2, from local package metadata and `package-lock.json` |
| npm publication | `npm view <package>@latest version --json` returns 0.99.2 for coding-agent, agent-core, AI, server, TUI, and durable; the coding-agent 0.99.2 `gitHead` equals the tag commit below |
| Published durable exports | `npm view @earendil-works/pi-durable@0.99.2 exports --json` matches the [release manifest][durable-package] |
| GitHub release | [v0.99.2][release], published 2026-09-30 (UTC); tag commit `005af57d88ee23b33778f343a9595b32e67ff788` |
| Checked upstream `main` | [`b56702ad345201a1de46a5f8e94542a3a59ad3bd`][main], committed 2026-09-30T23:28:22Z |

Installed `CHANGELOG.md` records 0.99.2 on 2026-09-30 and 0.99.0 and 0.99.1 on
2026-09-29. The ordinary session changes below shipped in 0.99.0 and remain in
0.99.2. Release 0.99.1 added model support and repaired the bundled OpenAI login
module. Release 0.99.2 changes MCP and codemode discovery, reload tool
activation, and provider behavior, and its durable package publishes the tool
turn, inbox, view, and compaction runtime. The [comparison from the release tag
to the checked main][release-main] distinguishes later durable work from the
published package; the same version string in a main-branch manifest does not
establish publication of that branch's source.

This is a targeted contract review, not an exhaustive changelog or package-wide
equivalence claim. The refresh compared the published 0.99.1 and 0.99.2 packages
file by file for coding-agent, agent-core, AI, TUI, and durable, excluding source
maps and the coding-agent release bundle, and re-read each changed file that a
section cites. Agent-core and TUI have no changed source or declaration file.
These dated checks establish source contracts, not fresh interactive trials,
provider-wide compatibility, or crash-test results.

The separate [`@earendil-works/pi-durable` root][durable-exports] exports
`Harness`, `createSession`, `createRegistry`, `defineTask`, the built-in
`GenerationTask`, `ToolTask`, and `CompactionTask`, document and entry
definitions, `watchEvents`, and the `ConversationView`, `Session`, and
`TaskRuntime` types. Its [release manifest][durable-package] publishes
environment, memory, JSONL, SQLite, testing, and `./tools` subpaths, including
the Node adapters. The portable
[`storage/sqlite`][durable-sqlite] exports its synchronous database interface,
migrations, and `SqliteStorage`; the [Node adapter][durable-sqlite-node] configures
WAL with `synchronous = NORMAL`. These released exports do not themselves
replace ordinary session resources or prove a complete worker-host match.

Installed paths below are relative to the active `@earendil-works/pi-coding-agent`
package root. `pi-agent-core/` and `pi-ai/` refer to its corresponding packages
under `node_modules/@earendil-works/`. Source inspection establishes the checked
contract and implementation, not a runtime regression result for this repository.

## Runtime adoption and distribution

| Runtime | Available boundary | Consequence |
|---|---|---|
| Ordinary coding-agent SDK | Installed `dist/core/sdk.js` constructs `Agent` and `AgentSession`; `AgentSessionRuntime` owns session replacement | Keep full extension/resource behavior through public session services and runtime construction |
| Durable AgentHarness | Root agent-core API plus harness context, session, environment, and reducer exports | Lanes, stored results, and ordered inboxes remain a separate explicit host choice |
| Pico3 | Agent-core `package.json` exports `./experimental/pico3` with declarations and executable JavaScript | The kernel is published, not merely a design document; its host integration still requires an explicit capability match |
| Pico5 | Durable 0.99.2 publishes `Harness`, `createSession`, task definitions, tool turns, a busy-conversation inbox, `ConversationView` watches, owned-conversation aborts, and compaction, plus storage, environment, testing, and `./tools` subpaths | The runtime is released through handoff Package 20; it still needs an explicit capability match and supplies no ordinary extension or resource parity |

Coding-agent exports its ordinary root and `./rpc-entry` as runtime entrypoints.
Its `./client` and `./experimental/plugin` remain source-condition-only. Do not
restore coupling to the accidentally published experimental distribution from
an earlier package. The supported local SDK and stdio RPC contract remain
separate from those development entrypoints.

The installed extension loader binds Pi core imports to the running install.
`dist/core/extensions/loader.js` aliases coding-agent, agent-core, TUI, AI and
its named compatibility/provider subpaths, plus TypeBox root/compile/value.
Server, client, and Chord are not in that alias map. The harness declares them
as runtime dependencies, not host-supplied peers. Verified 2026-09-30 against
installed 0.99.2 `docs/packages.md` and `dist/core/package-manager.js`: managed
Git installs and updates with npm use `npm install --omit=dev
--legacy-peer-deps`, so a peer-only server declaration leaves the agent
extension unable to load.
Matching a checkout lockfile does not establish that every loaded extension
resolves the same dependency instance.

The CLI supplies codemode, tool search, MCP, and llama.cpp as `builtin: true`
factory entries from `dist/extensions/index.js`, consumed by `dist/main.js`.
That aggregate factory list is not a package export. The root API does export
`createCodemodeExtension`, `createToolSearchExtension`, and `createMcpExtension`
(`dist/index.js`); installed `docs/sdk.md` requires SDK hosts to supply the
factories they need. The agent extension's `extensions/agent/worker.ts` supplies
those public factories as replaceable `builtin: true` entries to
`createAgentSessionServices`. Child registration therefore comes from explicit
host construction, not inheritance from a primary with the same cwd. An SDK
host that omits the factories does not receive the CLI's registrations. This is
the SDK's explicit factory contract, not a resource-discovery defect; it requires
no private `dist/` import.

## Pico5 durable runtime

Verified 2026-09-30 against the 0.99.2 npm export map and package contents, the
release tag `005af57d88ee23b33778f343a9595b32e67ff788`, and upstream `main`
`b56702ad345201a1de46a5f8e94542a3a59ad3bd`. Upstream `packages/durable`
(`@earendil-works/pi-durable`) carries the Pico5 runtime. The
[release README][durable-readme] describes the runtime and its storage and
identifies the normative design documents; the [release root][durable-exports]
and [manifest][durable-package] establish the published runtime surface.

The [release handoff][pico-v5-handoff] states that Packages 1 to 20 are
implemented. That covers an openable Harness, typed Session documents, durable
tasks, input submission and answer settlement, the coding-agent tool turn, the
busy-conversation inbox, `ConversationView` and `watch()`, owned conversations
and subagent provisioning, child tasks, and compaction with overflow recovery.
The release README describes each of these, and the release manifest exports
`./tools` with `createReadTool`, `createWriteTool`, `createEditTool`, and
`createBashTool`. The handoff lists reload and final conformance and the task
graph view as later packages, and its product-state section still leaves an
interactive TUI demo and coding-agent integration for later work. The
implementation status is a document claim, not an audit of each package. A
published runtime is not a complete replacement for an ordinary coding-agent
session.

The release README's subagent section shows two ownership patterns as examples
in the package's test directory. In the foreground pattern, a tool call creates
and owns its child conversation and returns the child's answer. In the
background pattern, persistent subagents sit behind one tool; a background
anchor task owns each child, and a background reporter task posts each answer
back to the parent as a follow-up input. Neither pattern supplies ordinary
extension or resource parity by itself.

The [durable CHANGELOG on the checked main][durable-main-changelog] records
unreleased breaking changes after the release: an asynchronous portable SQLite
facade, registry extensions, a rewindable `pi.agent` document that replaces the
per-conversation configuration document, and Harness-wide settings. The
[main handoff][pico-v5-main-handoff] lists later packages for extensions and
per-conversation agents, lifecycle and final conformance, and the task graph
view. These are source records ahead of the release, not installed 0.99.2
behavior, and the main manifest still reads 0.99.2.

This repository keeps its current design:

- The agent extension keeps ordinary Pi sessions with explicit ownership
  associations and owner-directed result delivery. It does not use a Pico5
  conversation runtime.
- The foreground, blocking subagent pattern is a deliberate design decision
  not to adopt: a dispatching session never blocks on a child's result, so
  the primary stays responsive while children work.
- The background pattern maps to ordinary agent spawn and detached runs. Those
  paths keep ordinary-session ownership and result delivery.
- Pico5 conversation ownership is adopted only when the coding agent exposes it
  as a public runtime contract, not from the durable package export alone.

## Released ordinary-session changes

Verified 2026-09-30 against installed 0.99.2 `CHANGELOG.md`,
`docs/{sdk,extensions,rpc-commands,settings,providers}.md`, and the
implementation paths below. The first list shipped in 0.99.0 and remains a
release contract in 0.99.2. The second list shipped in 0.99.2; its MCP and
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

## Current ordinary-session contracts

Verified 2026-09-30 against installed 0.99.2 `docs/{sdk,extensions,virtual-models}.md`,
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
  ordinary resources and extensions. `AgentSessionRuntime` owns new-session,
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

These changes apply to the ordinary SDK without a durable-kernel migration.
Do not treat an AgentHarness or Pico3 cutover as a prerequisite for fixing
current provider transcripts, lifecycle registration, or session replacement.

## Ordinary custom-message presentation

Verified 2026-09-30 against installed coding-agent 0.99.2
`dist/modes/interactive/components/custom-message.js`,
`dist/modes/interactive/interactive-mode.js`, `dist/core/agent-session.js`,
`dist/core/messages.js`, and the public `MessageRenderer` declarations.
`registerMessageRenderer` receives native expansion state. The default custom
message component displays its complete body even when collapsed; a registered
renderer supplies a compact view without altering the retained message.
The host applies its global tool-expansion state to these components.
Renderer failure falls back to the default body, so malformed metadata must
produce an explicit safe view rather than throw.

Display and delivery are separate contracts. An idle custom message with
`triggerTurn: true` starts a provider turn; active steering preserves the host
queue. Provider conversion includes message content but omits display metadata.
The agent extension uses the native rendering boundary, not queue changes, to
limit the default footprint of late peer evidence. Peer-operation outcomes
remain separate from primary-session state and task acceptance. Native
expansion and arbitrary message arrivals prevent a permanent-visibility
promise. Controlled provider tests establish content and turn behavior;
isolated terminal trials establish display and expansion behavior, not model
judgment about the evidence.

## Configuration and source context

Verified 2026-09-30 against installed 0.99.2 `dist/core/resource-loader.js`,
`dist/core/messages.js`, the ordinary SDK, and
`pi-agent-core/dist/harness/pico3/harness.d.ts`.

- Ordinary discovery accepts additional skill paths. Reusable source selection
  does not require a replacement resource loader.
- Cwd selects project context and trust inputs. A stored conversation or fork
  does not perform ordinary project discovery by itself.
- Ordinary custom messages become provider messages with role `user`.
  Conversion omits `details` and `display`; source labels and authority limits
  belong in model-visible content, not only metadata.
- Pico3 options accept models, tools, task kinds, sections, plugins, a process
  host, and initial documents. They do not expose the ordinary resource loader
  or an automatic extension-factory adapter.
- Keep reusable input resolution before ordinary session construction. Replace
  local selection only when the adopting host supplies its file resolution,
  precedence, source applicability, and delivery semantics. Kernel adoption
  alone does not supply these application contracts.

## Resource contributions and interactive lifecycle

Verified 2026-09-30 against installed coding-agent 0.99.2.
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

Verified 2026-09-30 against installed coding-agent 0.99.2
`dist/core/agent-session.{js,d.ts}` and `dist/core/agent-session-runtime.d.ts`,
plus the native configuration tests in `extensions/agent/`.

Ordinary `AgentSession.setModel`, `setThinkingLevel`, and `setSessionName` mutate
native session state and history. Model and reasoning setters do not persist
global defaults unless their options request it. They have no native idle guard.
An input hook can still be in preflight while `isIdle` is true, so the owner must
reserve configuration and exclude admitted work, pending input, and controls
before mutation. `AgentSessionRuntime` replacement is not needed for these
field changes.

The model setter authenticates again, applies native model-switch defaults, and
awaits model-selection hooks. Agent configuration then reapplies the explicitly
requested or previously effective reasoning level through Pi's native clamp.
The owner retains exclusion until those setters and awaited hooks settle.
Native name and reasoning notifications do not await every asynchronous hook;
an observed error snapshot is not a promise about later extension activity.
Once a native setter starts, shutdown joins the admitted configuration before
host disposal and writer release. This does not make setters atomic or supply
cancellation inside their authentication await.

Native append and the first-user-or-assistant flush boundary govern
persistence. Setup-only configuration and custom entries do not create a new
session file; once a user or assistant message exists, native persistence
flushes the buffered entries. A failed append can leave actual in-memory state
different from the saved file. Configuration reports both the actual snapshot
and that uncertainty; it adds no rollback, replay, independent configuration
store, or host migration.

## Footer retention boundary

Verified 2026-09-30 against installed coding-agent 0.99.2
`dist/core/agent-session.js`, `dist/core/session-manager.{js,d.ts}`,
`dist/core/extensions/types.d.ts`, and `docs/session-format.md`.
`AgentSession.reload()` retains the SessionManager and emits lifecycle events
with reason `reload`. `appendEntry()` appends a native custom entry outside
model context, then synchronously emits `entry_appended` to session subscribers.
Checkpoint callbacks guard reentry and mark an append complete only after it
returns, so an exception leaves the observation retryable. `SessionManager`
mutates its in-memory entries before persistence; a failed write can leave an
in-memory entry. Before a user or assistant message exists, an unflushed manager
buffers setup and custom entries without creating its session file.
`SessionManager._hasConversation()` makes the first user or assistant message
the flush boundary. A user prompt therefore persists even if the first response
never completes. Same-process reload retains buffered entries; reopening
restores only files Pi actually saved. `getEntries()` covers all branches; session identity
changes on new sessions and forks. Footer checkpoints therefore use exact native
IDs and all-branch observations instead of a separate store or branch-relative totals.
Controlled native-host and regular/fullscreen terminal checks exercise reload,
reopening, fork/new isolation, mixed nesting, and visible idle totals. These
observations do not establish retrospective spend or power-loss durability.

## Ordinary-agent reload and recovery boundary

Verified 2026-09-30 against installed coding-agent 0.99.2
`dist/core/agent-session.js`, `dist/core/extensions/runner.js`,
`dist/core/extensions/loader.js`, and native-host recovery tests in
`extensions/agent/reload-resume.test.mts`.

A primary reload emits shutdown before invalidating its extension runner, then
reloads resources, builds a fresh runtime, and emits startup. When the
session's tools come from `defaultTools`, the rebuilt runtime also activates
tools newly added to that setting. Reload does not dispose
separate ordinary child runtimes. The agent extension retains those hosts and
writer claims, drops old primary callbacks, and rebinds callbacks on startup.
Saved exact-parent associations use native custom entries, not another execution
store. Reopening reconstructs idle ownership; it never restarts requests, tools,
or pending queues. The first-user-or-assistant persistence boundary above still
applies: setup-only associations in an unflushed parent remain in memory, while
an existing user message allows a later native append to persist them.

The installed `session-manager.js` mutates entries and the leaf before `_persist`.
The public `ReadonlySessionManager` in `extensions/types.d.ts` exposes no rollback;
command-only navigation and writable SDK branching do not supply tool-context
repair. After an association append exception, agent retains a refusal for that
parent across reload instead of trusting the failed in-memory entry or appending
a fresh retry through its uncertain leaf. Deferred association updates remain
pending. Agent-owned primary footer writes and message delivery pause; live totals
and pending results remain observable in memory. A managed worker settles with
an explicitly unsaved, pageable result rather than persisting its operation result
after that failure.

Native-host tests separate two histories: without intervening native writes,
reopening preserves the prior saved branch and context; ordinary tool-error
continuation writes a native tool result and assistant response after the missing
entry, leaving an unrepaired parent chain on disk. Reopening does not repair that
chain. The extension's refusal prevents false association/task admission, not
arbitrary native disk-failure recovery.

Failure paths differ. A reload rejection before runtime replacement leaves the
old runner invalidated, but its registered event handlers still dispatch. Its
context accessors reject stale use. Captured plain identity permits later retry
and true-shutdown cleanup. A fresh agent runtime that fails before startup also
finds its retained owner for true shutdown.

By contrast, the extension loader catches a factory exception, discards that
extension's registrations, reports a diagnostic, and continues without it. If
reload omits the agent extension, retained children and claims stay live but
the primary has neither agent controls nor its cleanup handler. A subsequent
successful reload restores control. True quit from that omitted-extension runtime
does not close the retained children. The installed public extension surface has
no finalizer for the discarded owner. Tests reproduce that boundary and perform
separate fixture cleanup; they do not establish automatic cleanup there. No
process hook, second owner, or polling mechanism substitutes for the missing
native finalizer.

## Current-session evidence retrieval

Bounded access, discovery, read-only capture, and context projection verified
2026-09-30 against installed 0.99.2 `dist/core/session-manager.{d.ts,js}`,
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

## Collaboration observation

Verified 2026-09-30 against installed 0.99.2 durable-lane and Pico3 implementations.
Their observation contracts are not interchangeable.

**Durable AgentHarness lanes.** `LaneSnapshot` carries configuration, transcript,
operation, queues, stats, and fault state. The public `reduceLaneSnapshot` owns
event application and requests a fresh snapshot after navigation. A tool remains
`status: "settled"` after `tool_end` until its `toolResult` entry is placed;
`turn_end` does not remove it. Consumers need no parallel progress store.
Installed `pi-agent-core/dist/harness/runtime/harness.js` still throws
`SliceNotImplemented("watchSession")`. Per-lane observation does not establish
a complete session-inventory subscription.

**Pico3 conversations.** Capture and subscription in
`pi-agent-core/dist/harness/pico3/harness.js` share the session transaction
boundary. `ConversationView` contains entries, resolved config, inbox, active
turn, compaction, task status, and projected plugin state.
`applyEnvelope` applies the host's document operations; consumers must not
reconstruct the view through a second event reducer. The raw watch buffers
before `start()` with a bounded capacity, then calls listeners synchronously in
order. Overflow or listener failure closes that watch. It has no resnapshot or
replay method: reopen a watch for a fresh capture.

Pico3 captures the active transcript through the latest head boundary, or all
fork-visible entries when no head exists. It pages internally but has no public
total capture limit. That is not a bounded history page. The adapter in
`pi-agent-core/dist/harness/pico3/chord.js` applies document operations and commit
events in one synchronous `view.change(ctx, draft => ...)` batch per envelope.
Chord exposes
transactional `change()` and `replace()` methods instead of direct state mutation
plus `publish()`. No-op changes do not publish; listener errors do not roll back a
committed publication. The adapter uses its own bounded queue and closes on
failure; the owner must replace the failed service instance.
`PicoHarnessService` is local; the keyed
`PicoConversationService` is the remote semantic surface.

Preserve source identities, per-session order, and explicit reply links.
Display order does not prove causality. Delivery, context observation, and a
reply establish different facts; none alone proves understanding or action.

## Ordinary-session completion delivery

Verified 2026-09-30 against installed 0.99.2 `dist/core/agent-session.js`,
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
- Keep completion delivery on the selected worker host's public message surface.
  A report view does not itself require another durable inbox, receipt journal,
  or terminal renderer. Preserve exact result access when the host changes.

## Pico3 storage and ownership

Verified 2026-09-30 against installed 0.99.2
`pi-agent-core/dist/harness/pico3/{harness,jsonl,chord}.js`. The fsync and ownership
claims describe source contracts, not crash or power-loss test results.

- Pico3 supplies Memory and JSONL storage. Its JSONL implementation extends
  Memory storage and replays file contents into memory; it is not a
  source-size-independent archive reader.
- One process owns a JSONL directory. Cross-process writer ownership is a host
  responsibility, not a kernel lock service.
- Sidecars precede the main commit marker. Replay rejects incomplete published
  state and discards unconfirmed tails. Terminal task records remain readable;
  live-only task sidecars are retired after terminal publication.
- JSONL uses fsync by default, but it does not fsync parent-directory metadata
  after creation, rename, or unlink. Do not describe it as an unconditional
  machine-failure durability guarantee.
- `resume()` starts scheduling after registrations. `suspend()` joins active
  invocations, closes views/storage, and preserves durable tasks for reopening.
  Reload at a quiescent hold or suspend/reopen; do not substitute source reload
  for a checked task-lifecycle boundary.

These primitives overlap local scheduling, task recovery, watch folding, and
result retention. They do not establish full ordinary-worker parity or remove
the need for an owner of process control, resources, and external side effects.

## Fork and result boundaries

Verified 2026-09-30 against the release [WP08 handoff][wp08], installed 0.99.2
`pi-agent-core/dist/harness/session/{types.d.ts,jsonl/fork.js}`, and the ordinary
session APIs.

The WP08 handoff still states that SQLite streaming is in progress; this is a
document-status claim, not a fresh audit of the SQLite backend. Memory direct
copies and JSONL two-scan forks implement the required explicit branch/tree scope.
JSONL's structural maps and copied-entry set still grow with source state;
streaming does not mean constant auxiliary memory. Its fork read discards a
torn tail without repairing the source. The handoff retains SQLite and
benchmark/documentation completion as separate obligations. Do not infer
backend convergence from the Memory or JSONL implementation. The separate
`pi-durable` SQLite storage exports do not complete this agent-core work package.

Ordinary `/fork`, `/clone`, and `--fork` still use `SessionManager`. Pico3
conversation forks belong to its own storage and document model. Neither
contract silently replaces an ordinary-session continuation.

The durable `OperationResultRecord` stores terminal metadata and transcript
pointers, not submitted content. Pico3 exposes retained task outcomes and input
results. Adopt either for submitted-result storage only after exact content,
lookup, retention, size bounds, and parent-session-loss behavior meet the
application contract. Delete superseded storage in the same cutover.

## Names and defining contracts

The agent-core lane runtime, agent-core Pico3 export, and separate durable
package name different contracts. WP08 status describes lane-storage work,
not Pico3 or Pico5 readiness.

Pico3 has its own source and contracts. Its [hardening handoff][pico-hardening]
explicitly yields on overlapping topics to its companion `view-and-events.md`
and `plugins.md` documents. The handoff still describes a pre-integration archive,
while the package exports and installed source establish that Pico3 now ships.
Do not turn historical delivery instructions or prototype defect lists into
current defects without checking the implementation.

## Convergence decisions

Host boundaries verified 2026-09-30 against the sources above. Use the ordinary
SDK as the default host for current extension/resource behavior. Check its boundary and context
controls before considering a kernel migration. Match the selected host, not
only a shared name.

| Repository capability | Host-owned replacement condition | Action |
|---|---|---|
| Ordinary session replacement | Public session services and `AgentSessionRuntime` preserve cwd, resources, trust, and lifecycle | Use them now rather than duplicate construction and replacement |
| Turn completion and checkpoints | Ordinary `finishTurn`, actionable boundaries, and session projection supply the required control | Use these hooks first; preserve post-run recovery and queues |
| Request context | `context` preserves Pi-owned prompt/tools; `context_with_system` explicitly transfers request transcript ownership | Use the narrow hook; distinguish transient filtering from persisted context edits |
| Worker execution/recovery | Durable lane, Pico3, or released Pico5 host preserves tools, hooks, cancellation, continuation, and resources | Replace local scheduling only at that complete host boundary |
| Live observation | Selected host supplies lane snapshots/reducer, Pico3 view/envelopes, or a released Pico5 `ConversationView` or document watch | Use its fold and closure behavior; do not keep duplicate progress state |
| Remote control | Published semantic services preserve the required process/attachment authority | Check the actual callable contract; source-only coding-agent entrypoints are not a runtime dependency |
| Submitted results | Retained outcomes/transcripts satisfy exact retrieval and parent-loss behavior | Remove separate storage when the host demonstrably owns the whole contract |
| Reusable source selection | Host resolves files, precedence, applicability, and model-visible delivery | Remove local selection when those semantics exist, not merely when a kernel exports config |
| Prose handover and doctrine | Application-level meaning | Keep content ownership here; execution durability does not supply it |

## Refresh

After each Pi upgrade and before a host-dependent decision:

- Resolve npm publication, the active installation, the checkout lockfile, and
  upstream refs separately. Keep wildcard peers and refresh the lockfile.
- Check published exports, running-install aliases, declarations, and nearest
  implementation. Do not infer deployed behavior from a work-package status.
- Recheck ordinary SDK, durable lanes, and Pico3 separately. Follow the affected
  host's storage, resources, lifecycle, observation, and result contracts.
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

[release]: https://github.com/earendil-works/pi/releases/tag/v0.99.2
[main]: https://github.com/earendil-works/pi/commit/b56702ad345201a1de46a5f8e94542a3a59ad3bd
[release-main]: https://github.com/earendil-works/pi/compare/005af57d88ee23b33778f343a9595b32e67ff788...b56702ad345201a1de46a5f8e94542a3a59ad3bd
[durable-readme]: https://github.com/earendil-works/pi/blob/005af57d88ee23b33778f343a9595b32e67ff788/packages/durable/README.md
[durable-exports]: https://github.com/earendil-works/pi/blob/005af57d88ee23b33778f343a9595b32e67ff788/packages/durable/src/index.ts
[durable-package]: https://github.com/earendil-works/pi/blob/005af57d88ee23b33778f343a9595b32e67ff788/packages/durable/package.json
[durable-sqlite]: https://github.com/earendil-works/pi/blob/005af57d88ee23b33778f343a9595b32e67ff788/packages/durable/src/storage/sqlite/index.ts
[durable-sqlite-node]: https://github.com/earendil-works/pi/blob/005af57d88ee23b33778f343a9595b32e67ff788/packages/durable/src/storage/sqlite/node.ts
[pico-v5-handoff]: https://github.com/earendil-works/pi/blob/005af57d88ee23b33778f343a9595b32e67ff788/packages/durable/docs/pico-v5-handoff.md
[pico-v5-main-handoff]: https://github.com/earendil-works/pi/blob/b56702ad345201a1de46a5f8e94542a3a59ad3bd/packages/durable/docs/pico-v5-handoff.md
[durable-main-changelog]: https://github.com/earendil-works/pi/blob/b56702ad345201a1de46a5f8e94542a3a59ad3bd/packages/durable/CHANGELOG.md
[wp08]: https://github.com/earendil-works/pi/blob/005af57d88ee23b33778f343a9595b32e67ff788/packages/agent/docs/work-packages/08-named-branch-streaming-forks.md
[pico-hardening]: https://github.com/earendil-works/pi/blob/005af57d88ee23b33778f343a9595b32e67ff788/packages/agent/docs/pico/v3/hardening-handoff.md
