# Pi durable-harness track

Pi 1.0.0 has distinct ordinary and durable contracts. This repository uses the
ordinary coding-agent SDK as its host. The separate experimental
`@earendil-works/pi-durable` 1.0.0 package supplies durable tasks and
conversations, not an ordinary-session replacement.

Verified 2026-10-02: installed `pi-agent-core/package.json` exports only its root
and package metadata; `pi-agent-core/dist/harness` is absent. Agent-core no
longer ships the AgentHarness lane runtime or Pico3 kernel. A durable package
export does not replace ordinary extension loading, project trust, resource
discovery, or submitted-result retrieval.

## Release review coverage

<!-- pi-release-reviewed-through: unknown -->

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

Verified 2026-10-02 against installed coding-agent 1.0.0.
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
runtime trials were not repeated for 1.0.0.

## Policy pre-call guidance boundary

Verified 2026-10-02 against installed coding-agent 1.0.0.
Policy's `before_agent_start` handler returns a custom message before command
selection: installed `dist/core/extensions/runner.js`
`emitBeforeAgentStart()` awaits handlers and collects messages;
`dist/core/agent-session.js` appends them before `_runAgentPrompt()`.
The public contract is `BeforeAgentStartEventResult.message` in
`dist/core/extensions/types.d.ts` and installed `docs/extensions.md`.
Policy uses that ordinary hook for its bounded shell-contract snapshot rather
than a tool-call interception that occurs after the model selects a command.
The policy hook tests exercise the real runner, custom-message conversion, and
first controlled model request. Those trials were not repeated for 1.0.0 and
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

Verified 2026-10-02 against installed coding-agent 1.0.0
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
Use `"name" in tools` for presence checks: absent-member reads now throw
(`pi-codemode/dist/runtime/prelude-source.js` under the installed dependencies).

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

Verified 2026-10-02 against installed coding-agent 1.0.0
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
- **OAuth identity and discovery.** Credentials are keyed by server name and URL
  in `dist/extensions/mcp/oauth.js`; different names at one URL sign in
  separately. The first matching server to load older URL-only credentials
  takes them over. `oauth.authServerMetadataUrl` selects a trusted authorization
  metadata document instead of discovery, with HTTPS required except loopback.
  Step-up sign-in retains granted scopes alongside configured and challenged
  scopes. `pi-mcp/dist/oauth/flow.js` checks RFC 9207 `iss` before code exchange:
  a mismatch is rejected, including an omitted issuer when server metadata
  requires it. These are source contracts, not fresh OAuth sign-in trials.

## Checked source boundary

Verified 2026-10-02. The active installation and npm `latest` resolve Pi 1.0.0.
The adopted checkout lockfile resolves Pi 1.0.0. The manifest retains wildcard
Pi peers; the lockfile records the resolved dependency graph rather than a
supported-version ceiling. Dependency installation is separate from worktree
source synchronization; each checkout needs `npm ci` after a lockfile update.
A worktree's installed dependencies need not match its lockfile until then.

| Source | Checked state (2026-10-02) |
|---|---|
| Installed coding agent and agent core | 1.0.0, from package metadata, export maps, and installed declarations/source |
| Adopted checkout lockfile | 1.0.0 for coding-agent, agent-core, AI, and TUI in `package-lock.json`; local dependency installation remains a separate check |
| npm publication | `npm view <package>@latest version --json` returns 1.0.0 for coding-agent, agent-core, and durable |
| Published durable exports | The packed 1.0.0 `package.json` exports the root, environment, tools, memory, JSONL, SQLite, and testing surfaces, including Node storage/environment adapters |
| Release source | [v1.0.0][release]; coding-agent's published `gitHead` is `a13d35a742c6ef8462812a28fbe1d8c8b7431c32` |

Installed `CHANGELOG.md` identifies 1.0.0 as the current release. Release-tag
sources define the separate durable package. No ahead-of-release branch state
is treated as a published contract.

These sections record targeted contract checks, not cumulative release intake
or package-wide equivalence. The declaration above records cumulative intake
separately. The ordinary source comparison uses 0.99.2 and installed 1.0.0,
excluding source maps and release bundles. Unchanged cited files and changed
hunks that do not affect a claim support its current date. Selected current
declarations and implementations establish the replacement claims.

Repository-specific implementation and test claims were not independently
reverified in this host source review. Runtime trials described here were not
repeated for 1.0.0. Interactive behavior, provider-wide compatibility, durable
recovery, and crash or power-loss behavior remain unverified by runtime trial.

Installed paths below are relative to the active `@earendil-works/pi-coding-agent`
package root. `pi-agent-core/`, `pi-ai/`, `pi-codemode/`, and `pi-mcp/` refer to its corresponding
packages under `node_modules/@earendil-works/`. `pi-durable/` refers to the
separate published 1.0.0 package. Source inspection establishes the checked
contract and implementation, not a runtime regression result for this repository.

## Runtime adoption and distribution

| Runtime | Available boundary | Consequence |
|---|---|---|
| Ordinary coding-agent SDK | Installed `dist/core/sdk.js` constructs `Agent` and `AgentSession`; `dist/core/agent-session-services.js` supplies reusable services; `dist/core/agent-session-runtime.js` owns session replacement | Keep full extension/resource behavior through public session services and runtime construction |
| Pi Durable 1.0.0 | Separate package publishes `Harness`, tasks, tool turns, inboxes, retained outcomes, conversation and task-graph watches, ownership, compaction, and storage/environment/tool subpaths | Experimental runtime; adoption requires a complete host capability match, not just a published primitive |

Coding-agent exports its ordinary root and `./rpc-entry` as runtime entrypoints.
Its `./client` and `./experimental/plugin` remain source-condition-only. Do not
restore coupling to the accidentally published experimental distribution from
an earlier package. The supported local SDK and stdio RPC contract remain
separate from those development entrypoints.

The installed extension loader binds Pi core imports to the running install.
`dist/core/extensions/loader.js` aliases coding-agent, agent-core, TUI, AI and
its named compatibility/provider subpaths, plus TypeBox root/compile/value.
Server, client, and Chord are not in that alias map. The harness declares them
as runtime dependencies, not host-supplied peers. Verified 2026-10-02 against
installed 1.0.0 `docs/packages.md` and `dist/core/package-manager.js`:
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
factories they need. The agent extension's `extensions/agent/worker.ts` supplies
those public factories as replaceable `builtin: true` entries to
`createAgentSessionServices`. Child registration therefore comes from explicit
host construction, not inheritance from a primary with the same cwd. An SDK
host that omits the factories does not receive the CLI's registrations. This is
the SDK's explicit factory contract, not a resource-discovery defect; it requires
no private `dist/` import.

## Pi Durable 1.0.0

Verified 2026-10-02 against the published 1.0.0 package's `README.md`,
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
crashes from power or host failure. Neither failure mode was tested here.
The README requires one process to own storage and states that there is no
cross-process locking. Storage durability does not supply process ownership,
forced termination of uncooperative code, or a replacement process.

### Published intent and repository decision

The [Pi Durable post][durable-post] states that Durable does not replace the
coding agent and that proven lessons flow back into it.
The [Pi 1.0 announcement][pi-one-post] describes the separate experimental
package for applications outside the terminal coding agent's shape. These are published design statements, not evidence that the
ordinary SDK uses the durable runtime.

The agent extension keeps ordinary Pi sessions with explicit ownership
associations and owner-directed result delivery. Dispatch does not block the
parent on a child's answer. Ordinary spawn and detached runs retain their
existing ownership and result-delivery contracts. Adopt a durable primitive only
when the selected host meets the complete replacement condition in
[Convergence decisions](#convergence-decisions); a package export alone is not
that condition.

## Released ordinary-session changes

Verified 2026-10-02 against installed 1.0.0 `CHANGELOG.md`,
`docs/{sdk,extensions,settings,providers}.md`, and the
implementation paths below. The first list shipped in 0.99.0 and remains a
release contract in 1.0.0. The second list shipped in 0.99.2; its MCP and
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

## Current ordinary-session contracts

Verified 2026-10-02 against installed 1.0.0 `docs/{sdk,extensions,virtual-models}.md`,
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

Verified 2026-10-02 against installed coding-agent 1.0.0
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
judgment about the evidence. Those runtime trials were not repeated for 1.0.0.

## Configuration and source context

Ordinary resource and message boundaries checked 2026-10-02 against installed
1.0.0 `dist/core/resource-loader.js`, `dist/core/messages.js`,
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

Verified 2026-10-02 against installed coding-agent 1.0.0.
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

Native setters and persistence checked 2026-10-02 against installed coding-agent
1.0.0 `dist/core/agent-session.js` and `dist/core/session-manager.js`.
The agent configuration behavior and tests in `extensions/agent/` were not
independently reverified in this host source review.

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

Verified 2026-10-02 against installed coding-agent 1.0.0
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
Those runtime trials were not repeated for 1.0.0.

## Ordinary-agent reload and recovery boundary

Native reload and loader boundaries checked 2026-10-02 against installed
coding-agent 1.0.0 `dist/core/agent-session.js`,
`dist/core/extensions/runner.js`, and `dist/core/extensions/loader.js`.
The agent recovery behavior and native-host tests in
`extensions/agent/reload-resume.test.mts` were not independently reverified
in this host source review.

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
2026-10-02 against installed 1.0.0 `dist/core/session-manager.{d.ts,js}`,
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

Verified 2026-10-02 against installed 1.0.0 `dist/core/agent-session.js`,
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

**Extension-launched prompt lifetime.** In installed 1.0.0,
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

Verified 2026-10-02 against installed 1.0.0 `dist/core/session-manager.js`,
`dist/core/agent-session-runtime.js`, `dist/modes/interactive/interactive-mode.js`,
and `dist/main.js`. Ordinary `/fork`, `/clone`, and `--fork` use
SessionManager. A durable conversation fork uses its own storage, entries, and
ownership model; it does not replace an ordinary-session continuation.

Pi Durable's `SubmissionRecord` retains input and answer entry IDs, while
`TaskRecord` retains input and terminal `TaskOutcome`. Its entry and submission
lookups support reacquisition after reopen
(`pi-durable/dist/{types.d.ts,harness/types.d.ts}`). These are substantive
retention primitives, not just status labels. They do not supply native
operation-result lookup, byte-bounded report rendering, owner-loss notification,
or detached control. Adopt them for submitted results only when exact content,
lookup, retention, size bounds, and parent-session-loss behavior meet the
application contract. Delete superseded storage in the same cutover.

## Convergence decisions

Host boundaries verified 2026-10-02 against the ordinary sources above and
`pi-durable/dist/{index,types}.d.ts`,
`pi-durable/dist/harness/{types,view,task-graph}.d.ts`, and the
[durable README][durable-readme]. The ordinary SDK remains the selected host.
A durable equivalent is not an ordinary-session replacement without the whole
host contract.

| Repository capability | Host-owned replacement condition | Pi Durable 1.0.0 assessment and action |
|---|---|---|
| Ordinary session replacement | Public session services and AgentSessionRuntime preserve cwd, resources, trust, and lifecycle | Not met by Durable's HarnessOptions/Conversation. Use ordinary services and runtime replacement now. |
| Turn completion and checkpoints | Host control preserves ordinary finishTurn, actionable boundaries, session projection, recovery, and queues | Not met for the ordinary host. GenerationHooks onYield/afterTools and task checkpoints are durable equivalents, not compatible ordinary callbacks. Keep ordinary boundaries. |
| Request context | The host preserves Pi-owned prompt/tools through context, or explicitly transfers full request ownership through context_with_system | Not met by Durable beforeRequest and persistent ContextEdit. Durable sections build their own prompt. Keep the narrow ordinary hook and distinguish transient filtering from persistent edits. |
| Worker execution/recovery | The selected host owns scheduling and recovery while preserving tools, hooks, cancellation, continuation, resources, trust, and process lifecycle | Partial primitives only. Durable tasks, inboxes, replay, and ownership do not supply ordinary factories or process control. Keep ordinary workers until the full condition holds. |
| Live observation | The selected host supplies current views, ordered updates, and explicit closure/overflow behavior for the work it executes | Met inside a durable host by ConversationView, document watches, and task-graph watches. They do not observe ordinary workers. Use the selected host's state; do not duplicate progress or mistake live-task graphs for archive inventories. |
| Remote control | A public process/attachment service preserves the required owner identity and control authority | Not met. Durable ownership is in-storage task ownership; its exported contract supplies no detached-process controller or cross-process writer lock. Keep the ordinary control boundary. |
| Submitted results | The host owns exact content retrieval, retention, bounded reads, and parent-loss delivery behavior | Partial only. SubmissionRecord, TaskOutcome, and entries retain answers and outcomes, but no native operation-result lookup, byte-bounded report view, or owner-loss notification is supplied. No whole-contract cutover is established. |
| Reusable source selection | The host resolves files, precedence, applicability, and model-visible resource delivery | Not met. Durable Registry/Agent select installed names and prompt sections, not ordinary filesystem resources or skills. Keep ordinary discovery and local application selection. |
| Prose handover and doctrine | The application owns content meaning and authority, even when the host supplies transport and retention | Not an execution replacement condition. Durable reset, handoff, and compaction preserve or transport content; keep its meaning and authority here. |

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

[release]: https://github.com/earendil-works/pi/releases/tag/v1.0.0
[durable-readme]: https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/README.md
[durable-package]: https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/package.json
[durable-post]: https://earendil.com/posts/pi-durable/
[pi-one-post]: https://earendil.com/posts/pi-1-0/
