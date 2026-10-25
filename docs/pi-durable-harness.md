# Pi durable-harness track

Pi 1.4.0 supplies the ordinary coding-agent host and the separate Pi Durable
runtime. Ordinary sessions retain their ordinary host. A native operator
conversation does not require an ordinary primary. Durable owns native agent
conversations, generation, tool tasks, committed state, and recovery. The Agent
extension supplies cwd-bound resources, process ownership, controls, and delivery.
The [session host roles](conventions/session-host-roles.md) and
[Agent host contract](agent-host-contract.md) define that composition.

Broad source review date: 2026-10-22. That review checks installed 1.4.0
manifests and the document, task, storage, and telemetry contracts below.
The targeted management-contract refresh below was checked on 2026-10-25;
it does not renew the unexamined parts of the broad review.
Dependency installation does not replace modules in retained processes.
Source inspection does not establish live provider behavior, conversion
acceptance, or cumulative release acceptance. The release declaration records
acceptance separately.

The historical file comparisons cover 1.0.3 to 1.2.0 and 1.1.0 to 1.2.0 for
coding-agent, TUI, and Durable, plus cited AI, agent-core, Codemode, and MCP files.
They exclude source maps, bundles, native prebuild binaries, generated schemas,
and vendored assets. Their byte-equality findings apply to those compared
releases, not automatically to 1.4.0. A separate 1.3.0-to-1.4.0 byte comparison
checks the defining ordinary session, resource, extension, MCP, Codemode, TUI,
AI validation, Durable environment, provider, and task files cited below.
It excludes bundles, maps, binaries, and unlisted files. Unchanged bytes carry
only those source claims forward; changed files require current inspection.
Earlier runtime trials do not become current trials through a comparison.

## Release review coverage

<!-- pi-release-reviewed-through: 1.0.3 -->

This declaration records the latest Pi release through which the harness
completed cumulative release intake. Its value is a numeric major.minor.patch
version or `unknown`. Targeted contract checks, dependency installation, and
checkout versions do not establish that coverage.

Evo reads the declaration from the common ancestor of local main and main's
configured upstream, by immutable commit. Dirty files, provisional declarations,
and unpublished local-main coverage do not suppress intake. Local tracking refs
are conservative Git evidence, not a fresh remote check. Missing evidence or an
invalid declaration requires baseline recovery, not substitution of an installed
version or lockfile. The reader is `extensions/evo/release.ts`.

The coordinator owns advancement. Review every cumulative changelog entry after
the prior declaration through the running release. Include separately published
runtime dependencies when their contracts affect consumers. Resolve findings,
complete useful adoption and required repository checks, and accept the whole
range before changing the declaration. Promotion includes it only with completed
adoption. Verify publication before reporting completion. Partial or failed intake
and unrelated directed work leave the declaration unchanged.

When complete prior coverage is unknown, read available cumulative release notes
in bounded pages and assess current effects. Superseded behavior is evidence of
change, not a requirement to recreate it. Only completed adoption establishes
the first numeric declaration. No runtime command writes the declaration.

## Checked source boundary

Unqualified `dist/`, `docs/`, and `examples/` paths identify the coding-agent
package root, except in paragraphs that explicitly name another package.
Package-prefixed paths identify separate package roots. A checkout dependency and a running-install peer are different sources.
A manifest does not identify another process's loaded modules.

| Source | Current contract |
|---|---|
| Coding-agent 1.4.0 manifest | Runtime exports are the ordinary root and `./rpc-entry`. `./client` and `./experimental/plugin` export keys are removed. |
| Agent-core 1.4.0 manifest | The root and package metadata remain public; no AgentHarness lane runtime is published there. |
| Durable 1.4.0 manifest | Root, environments, tools, native codemode, native tool-search, optional image processing, storage adapters including IndexedDB, and testing exports are published. |
| Chord 1.4.0 manifest | Typed host runtime plus context, output, delta, Node, portable SQLite, and SQLite telemetry surfaces are public. |
| Coding-agent dependencies | Chord is no longer its dependency. Durable still depends on Chord; this does not remove the harness's direct Chord requirement. |
| Removed packages | Pi Client, Pi Protocol, and Pi Server served the removed experimental runtime and are no longer released. Their old transport is not a current integration surface. |
| Loaded processes | Unknown unless that process reports its descriptor or its resolution is directly observed. |

These are defining manifest/declaration checks, not package-wide runtime parity.
The manifest retains wildcard Pi declarations. The lockfile records one resolved
graph, not a supported-version ceiling. Each affected checkout requires `npm ci`
after a lockfile update; worktree source synchronization does not install it.

### Verification coverage

The current-source review separates these layers:

- Published files and installed defining declarations establish available APIs.
- Byte-identical ordinary SessionManager, services, session-runtime, message,
  extension-loader, cache-warmer, and RPC sources support their unchanged source
  claims across the compared releases.
- Changed-source inspection establishes the changed contracts described below.
  It does not establish complete OAuth flow or Codemode replay behavior.
- Controlled owning-layer tests establish only their exercised setup.
- Interactive behavior, external services, crash recovery, and retained consumers
  require their own evidence; one successful layer does not establish another.

The source review does not repeat earlier terminal, OAuth, provider-cache,
power-loss, or every host-lifecycle trial. The owning slice READMEs and normal
regressions retain those boundaries. The Agent's process transport, native
codemode adoption, and exact operation identities require the composed host
checks before activation. Source release labels are not acceptance evidence.

## Targeted management-contract refresh

Checked on 2026-10-25 against the installed coding-agent and Durable 1.4.0
contracts, published package metadata, and upstream main commit
`f321e5bdd26b3624bfb2ab182a334d0a5edb698a`:

- The published `latest` metadata for
  [coding-agent](https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/latest)
  and [Durable](https://registry.npmjs.org/@earendil-works%2fpi-durable/latest)
  names 1.4.0. These are publication observations, not loaded-process evidence.
- Installed `pi-durable/dist/harness/types.d.ts` defines native root creation,
  conversation creation, submission reacquisition, exact task abort, queued-input
  withdrawal, task inspection, and watches. Its `Conversation.compact()` contract
  summarises while work continues and places the result at a native boundary.
  These APIs support direct native operator sessions without an ordinary primary.
- Installed `dist/core/agent-session-services.d.ts` separates cwd-bound resources,
  settings and model services from ordinary session construction. Creating these
  services is not a passive configuration read or proof that every ordinary
  extension has native execution support.
- Installed `docs/cli.md#package-commands` defines `pi update` for Pi itself and
  `pi update --extensions` for installed packages. These remain separate from
  dependency refresh, release intake, promotion and a safe process/source switch.
- Upstream main defines an additional
  [read-only Harness option](https://github.com/earendil-works/pi/blob/f321e5bdd26b3624bfb2ab182a334d0a5edb698a/packages/durable/src/harness/types.ts).
  Its contract blocks writes and scheduling while retaining reads and watches.
  The installed 1.4.0 `HarnessOptions` has no such option. Do not pass that
  unreleased field to the installed host or claim that ordinary inspection gives
  equivalent write protection.

The public management adapter in `runtime/evolution.mts` composes current
worktree and Pi commands. `runtime/upstream.mts` reports its own loaded Pi
version separately from the published review baseline. It resolves that baseline
from the common ancestor of main and its configured upstream, not a dirty file
or an unpublished coverage declaration. `evolution.status` uses local evidence.
`upstream.status` also checks the two fixed npm publication endpoints with bounded
reads and reports unavailable metadata explicitly. Neither operation fetches
remote Git refs, performs cumulative intake, or writes the declaration.

Complete release intake remains with [Evo](../extensions/evo/README.md#release-intake).
The targeted checks above establish only those contracts. They leave cumulative
coverage unchanged, including the unreviewed release interval after the declared
baseline. [Worktree promotion](conventions/worktrees.md) owns composition, gates
and publication hygiene; the runtime adds no scheduler, release ledger or
parallel task store.

## Native host integration contracts

- Chord uses host-family placement keyed by `serverId`, explicit principals and
  upstream links, `Ref`, named state and resources, and hydrated references.
  The Unix adapter checks wire 4 and `codeVersion`, and returns encoded bytes
  including LF from `Link.send()`. The owning contract is
  [Chord wire contract](agent-host-contract.md#chord-wire-contract).
- Native Codemode supplies synchronous `acquireWorker`. Its release callback
  runs once on construction failure or actual worker exit, not result settlement.
  Ordinary coding-agent Codemode reserves workers through a separate arrival-order
  queue with a bounded wait and a `PI_CODEMODE_MAX_WORKERS` override. That queue
  does not appear in the native sandbox contract. Removing native admission does
  not adopt the ordinary queue. Sources: `pi-codemode/dist/types.d.ts`,
  `pi-codemode/dist/runtime/host.js`, and
  `dist/extensions/codemode/execute.js`.
- Native generation retains the original tool call. Tool-task validation passes
  it to AI validation, which rejects `argumentsError`. ProviderModels forwards
  original events and messages; observation and UI projections preserve the
  error field. No second validation layer replaces native validation.
  Sources: `pi-durable/dist/harness/{generation,tool}.js`,
  `pi-ai/dist/utils/validation.js`, and `extensions/agent/provider-models.ts`.
- Saved ordinary conversion uses a complete unchanged read-only snapshot and
  public `parseSessionEntries`, `buildSessionProjection`, and `convertToLlm`.
  The final persisted leaf supplies context, including compaction and context
  edits. System and runtime state are excluded. A new native root receives
  matching message entries inside `ConversationInit`; no input task replays the
  transcript. The ordinary file and coordinator role remain unchanged.
  Sources: `dist/core/{session-manager,messages}.js`,
  `pi-durable/dist/harness/types.d.ts`, and
  [saved context creation](agent-host-contract.md#saved-context-creation).

External provider wrappers require their own current source and loaded-binding
checks. The Pi package comparison does not verify a wrapper's treatment of
messages, tool-result images, `argumentsError`, or identity and telemetry options.
No wrapper implementation belongs in this repository.

These contracts do not close the cumulative acceptance gap after 1.0.3. Static
checks do not establish released UI behavior, loaded dependency replacement, or
successful conversion. Resource registry replacement alone does not replace
cached package modules.

## Runtime adoption and distribution

`createAgentSessionServices()` supplies resources, settings, trust inputs,
configured providers, and extension factories without an AgentSession.
`createAgentSessionFromServices()` builds an ordinary session;
`AgentSessionRuntime` owns session replacement. Durable is a separate runtime,
not an ordinary session that acquired persistence through shared packages.
Sources: `dist/core/{sdk,agent-session-services,agent-session-runtime}.js` and
`pi-durable/dist/harness/{types,harness}.d.ts`.

The extension loader aliases coding-agent, agent-core, AI, TUI, and TypeBox to
the running installation. Durable, Codemode, MCP, and Chord resolve separately.
A peer declaration alone does not supply one of those dependencies.
Package-manager production installs omit development and automatic peer
installation; current mechanisms are in `dist/core/package-manager.js`.
The host's installation binding redirects only its declared Pi peers and
TypeBox (`extensions/agent/installation-binding.ts`).

CLI startup supplies codemode, tool-search, MCP, and llama.cpp built-in
factories. SDK hosts explicitly supply the factories they need, including
`createCodemodeExtension`, `createToolSearchExtension`, and
`createMcpExtension`; the CLI's aggregate factory list is not an SDK default.
Sources: `dist/main.js`, `dist/extensions/index.js`, `dist/index.js`,
`docs/sdk.md`, and `examples/sdk/14-codemode-mcp.ts`.

The Agent and browser client's live-consumer contract uses the package-level
[Chord transport contract](agent-host-contract.md#chord-wire-contract), not
removed Pi Client/Server services. A same-user Unix socket remains necessary for
independent detached hosts and reconnect. Chord owns typed calls and state;
the package adapter owns ordered framing, byte bounds, close, and initial
identity admission. Old clients need an owner-agreed transition before a switch;
refusal of an incompatible operation is containment, not a transition strategy.

## Current ordinary-session contracts

The ordinary public contracts remain separate from Durable adoption:

- `SessionManager` owns finalized history. `AgentSession` refreshes the
  `agent.state.messages` inspection cache from its canonical projection before
  requests; assigning that cache is not persistent restoration.
- `ContextEditEntry` changes a branch-relative projection without rewriting its
  source entry. Raw-entry consumers distinguish raw evidence from edited context.
- System prompt sections and tool declarations travel in `SystemMessage`
  entries. Provider `TranscriptContext` contains messages, not separate
  `systemPrompt` and `tools` fields.
- `context` sees conversation messages without system entries;
  `context_with_system` owns its returned full transcript. A forced run prompt
  still applies afterward. Keep conversation filters on the first hook unless
  the second hook's prompt/tool ownership is required.
- `finishTurn` runs after the tool batch, before steering consumption. Ending
  that low-level loop does not bypass session retries, recovery, or queued work.
- `ExtensionAPI.on()` returns an unsubscribe function. Session replacement changes
  the AgentSession, its bindings, and its event subscriptions.
- Tool arguments and retained result details use current JSON types, not arbitrary
  objects at the wire boundary.
- `ModelRuntime` owns catalogs, credential resolution, availability, and optional
  remote refresh. Chat, classifier, and image catalogs are distinct. Cached local
  availability is not provider health.
- Virtual selection and the physical dispatched model are separate. Response
  usage follows the physical model; `ctx.model` names the selected virtual one.

Defining sources: `dist/core/{agent-session,session-manager,model-runtime}.d.ts`,
`dist/core/{agent-session,agent-session-services,sdk}.js`,
`dist/core/extensions/{types.d.ts,runner.js}`, `pi-ai/dist/types.d.ts`,
`pi-agent-core/dist/{agent.d.ts,agent-loop.js}`, and `docs/virtual-models.md`.

### Summary, model, and recovery changes

Summary requests use the model's output limit, reduced when input and output
must fit the context window. The `reserveTokens` argument to
`generateSummary()` and `generateSummaryWithUsage()` no longer caps output.
Compaction reserve settings still control its trigger threshold. Sources:
`dist/core/compaction/compaction.js` and `docs/compaction.md`.

Ordinary overflow recovery omits a failed assistant attempt and its matching
tool results from projected model context, including resumed attempts. Tool
restoration replays branch system messages, retains explicit removals, and adds
newly registered extension tools unless their registration disables default
activation. Sources: `dist/core/agent-session.js`.

The extension loader aliases `pi-ai/models` to the running installation.
Provider attribution now flows through pi-ai client identity; ordinary
`before_provider_headers` handlers do not see those generated attribution
headers, although returning a null header value still suppresses it. Sources:
`dist/core/extensions/loader.js`, `dist/core/sdk.js`, and
`pi-ai/dist/types.d.ts`. Configured identity is not proof of a live provider's
accepted headers.

### Extension-triggered runs and startup

User prompts and idle custom messages with `triggerTurn: true` share
`_startRun()` and `_prepareRun()` in `dist/core/agent-session.js`.
`BeforeAgentStartEvent` is now a discriminated union:

- `messageType: "user"` supplies `prompt` and optional `images`.
- `messageType: "custom"` supplies the starting `message`.

Guidance that applies to both uses their shared prompt fields. A handler that
reads user-only fields first checks `messageType`. Returned hook messages enter
either run. Memory's context index, Policy's pre-selection guidance, and Registry's
prompt observation apply to both run types; they do not need a user-only guard.

`_startRun()` marks the session busy before compaction and awaited startup hooks.
During that startup, `ctx.isIdle()` is false and `waitForIdle()` waits. Another
prompt requires `streamingBehavior`; `sendUserMessage()` requires `deliverAs`.
An abort requested during startup reaches the run once generation starts.
Run prompt options remain active through tool rounds and clear at settlement.
This closes the former custom-result guidance omission and prompt-section loss.
Sources: `dist/core/agent-session.js`, `dist/core/extensions/{types.d.ts,runner.js}`,
and `docs/extensions.md`. The controlled
`extensions/agent/ordinary-guidance-runtime.test.mts` regression delivers a real
ordinary peer result, checks the Agent's preferences/efforts sections on both
provider requests around a tool call, and checks startup abort and later
recovery. It uses a synthetic provider and does not load Memory, Policy, or
Registry in that fixture. Their common-hook compatibility is a separate source
claim, not a repeated composed runtime trial.

`ExtensionAPI.sendUserMessage()` still returns `void`. Its bound callback catches
errors without returning the prompt promise. Input handlers and authentication
in `prompt()` still precede `_startRun()`. A command's return therefore does not
establish complete output or cancellation for that earlier preflight. Commands
that start no model work require no settlement wait. A single-shot consumer must
not wait unconditionally for an `agent_settled` event that never follows.

## Policy pre-call guidance boundary

Policy's ordinary `before_agent_start` message precedes model command selection.
The runner awaits handlers; `_prepareRun()` adds their messages before the first
provider request. Nested `ctx.executeTool()` calls still use argument validation,
`tool_call`, and `tool_result`, with parent-call metadata. Execution interception
therefore covers codemode's nested calls without replacing pre-selection guidance.
Sources: `dist/core/extensions/runner.js`, `dist/core/agent-session.js`,
`dist/core/nested-tool-calls.js`, and the public extension declarations.

Native Policy hooks run on native `ToolTask` calls. A nested call's schema lookup
uses `Agent.callable`, not only model-offered `Agent.tools`. Ordinary event timing
does not define native hook timing. The contribution convention and Policy README
own the adaptation and fail-closed evidence policy.

## Native codemode composition

Ordinary codemode is a built-in factory over the public nested-tool pipeline.
Durable publishes its own `./codemode` and `./tool-search` extensions.
The native codemode factory accepts a public sandbox and uses native nested tool
tasks. It does not need an ordinary shadow session or a harness-owned script task
scheduler. Defining sources: `pi-durable/dist/codemode/{codemode,describe}.d.ts`,
`dist/tool-search/index.d.ts`, and `dist/harness/{types.d.ts,tool.js}`.

Native scripts journal delivered results before delivery and reattach nested
calls by key on replay. Changed module versions, sandbox fingerprints, divergence,
or an expired deadline end replay with an error. Each nested call retains its own
replay policy; deterministic script replay is not exactly-once external execution.
Scripts left active by an unsafe caller are abandoned after restart.

The current native result contract has three channels:

- `output`: model-visible bounded content.
- `structuredOutput`: schema-validated program data.
- `details`: presentation metadata.

A tool declares `structuredOutputSchema` for program data. A schema tool's error
with its own value resolves to that value in a script; inspect its error fields.
Without a schema, nested calls derive their value from bounded output, and
codemode rejects an error with its text. A thrown error is different from a
fulfilled structured error. Successful nested values do not carry info
diagnostics into the model transcript. Contribution-owned assessments need an
explicit native model-visible write; the Pillars contribution uses that path
at the next tool boundary, without another model request merely for delivery. Do not put program data in `details.structuredContent`
or attach an ignored ordinary `outputSchema` to a native registration.
The [contribution convention](conventions/durable-contributions.md) defines the
ordinary-to-native mapping.

`callers` selects model calls, nested calls, or both. `deferred` and
conversation `modelTools` control model declarations without removing nested
reachability. `Agent.tools`, `Agent.callable`, and `Agent.deferred` expose those
separate sets. Model-only controls, including self-compaction, stay outside
script access. Nested calls run validation, hooks, output limits, replay policy,
and parent-call events through native `ToolTask`.

Ordinary read returns text or a structured image block. Durable's native read
also supports PNG, JPEG, GIF, and WebP, with optional image preparation through
its image exports. The host's selected coding-tool adaptation must preserve its
ordinary file bounds and error semantics. Show an image with
`image(await tools.read({path}))`; printing base64 text does not show it.

Ordinary declaration generation includes input constraints in property comments
and spells out MCP result types. Ordinary tool namespaces accept registered aliases;
MCP aliases include server names. Native `CodemodeNamespace` has no alias field.
The native host supplies configured and normalized namespace names through the
factory's public namespace options. It does not claim ordinary alias parity or
add an extra namespace field to native tool registration. Sources: `dist/extensions/codemode/{tool,execute}.js`,
`dist/core/extensions/types.d.ts`, and `pi-durable/dist/codemode/describe.d.ts`.

Discovery helpers are async. Scripts await `searchTools()`, `describeTool()`,
and `describeNamespace()`. Multiple text items have explicit item markers;
console lines follow other output in one block. Put `// @options:` on the
first line; a later directive is rejected before ordinary script execution.
Current native codemode supplies output truncation, spill files, saved images,
and elapsed-time details through its own wrapper. The
[composition guide](codemode.md) preserves each source's errors and coverage.

## MCP and deferred tool discovery

MCP remains a public coding-agent factory and a separately installed native
host capability. Current ordinary defining sources are
`dist/extensions/mcp/{index,tools,config,oauth,runtime}.js`,
`dist/core/mcp-servers.js`, `dist/extensions/codemode/{tool,execute}.js`,
`dist/extensions/tool-search/tool.js`, and `docs/mcp.md`.

- Default server `codemode` exposure registers deferred tools. They are neither
  direct model declarations nor inline codemode listings; scripts discover them.
  `direct`, `deferred`, and `hidden` have their separate reachability contracts.
- The bounded `mcp_servers` prompt section names enabled servers, their access
  surface, and a summary. Full instructions remain available through namespace
  discovery; a prompt summary does not replace them.
- `ToolNamespace.aliases` participates in `describeNamespace()` and the search
  namespace filter. MCP registers its server name as an alias. Raw tool names
  use normalized `mcp__<server>__<tool>` identifiers; aliases do not rename them.
- Servers connect in the background. Direct tools have a bounded startup wait.
  A called orchestrator declares `reachesTools(input)`; MCP uses that public
  declaration to await needed servers. Codemode discovery reaches all servers,
  otherwise its script words select namespaces. Tool-search reaches all servers.
  A replacement tool's name alone grants no readiness or automatic activation.
- Connection no longer lists every resource. `/mcp` and `pi mcp list --json`
  report resource capability as `resources: true`, not inventory counts. Resource
  tools enumerate on demand. Structured MCP content is `unknown` when no output
  schema exists, including arrays, primitives, and null.
- Close aborts pending connection setup and awaits it and credential persistence.
  Sign-in cancellation applies through the complete flow; the timeout covers
  authorization requests as well as browser wait. Shutdown does not refresh an
  expiring token solely to close a server. Cancellation during refresh prevents
  a delayed tool call from reaching the server.
- Ordinary MCP configuration strips a leading UTF-8 BOM before parse and edit.
  A native adapter that reads configuration itself must preserve that rule;
  package installation does not change its parser.
- Trusted same-name project selections override only enabled/exposure fields
  of a global server. Full project definitions remain replacements; untrusted
  files stay unread. Native startup uses the same project-trust boundary.
- HTTP provider authentication and OAuth options stay upstream responsibilities.
  Issuer mismatch fails, including a supplied issuer without discoverable
  metadata. Stored credentials are keyed by server identity and URL. Native
  agents consume stored credentials; ordinary Pi owns interactive sign-in.

These are source contracts, not fresh external-service or OAuth trials. Native
MCP adaptation must separately preserve registration, caller visibility,
structured results, cancellation, and shutdown under current Durable APIs.

## Pi 1.4 native contracts

### Documents and invocation context

Every `defineDoc()` and `defineDocFamily()` definition requires an explicit
`checkpointWhen(value, ops, info)` predicate. Returning `false` retains ordinary
changes as deltas; returning `true` stores the complete current value as a base.
`info.deltasSinceBase` excludes the change under evaluation. The predicate controls
base creation; an always-false predicate does not bound delta replay. It does
not change a document's ownership, history, fork behavior, or stored value
version. Source: `pi-durable/dist/types.d.ts`. The
[contribution rules](conventions/durable-contributions.md#rules) own the local
definition and policy-preservation requirements.

Chord `Context` requires `telemetry: TelemetrySpan`. Public context constructors
supply the default no-op span. `withTelemetry()` derives a span parent without
changing cancellation or carried application values. Handwritten contexts must
preserve that member. Source: `chord/dist/context/index.d.ts`.

### Durable time and restart state

`TaskRuntime.sleep()` is removed. `sleepUntil(until, checkpoint, context)` commits
a sleeping task and ends its invocation; its promise resolves after that commit,
not after the deadline. The next phase carries work after the wait. A returned
`{ status: "sleeping", until, checkpoint }` commits the same state alongside other
writes. `setTimer()` only paces work inside the current invocation and does not
survive it. Source: `pi-durable/dist/types.d.ts`.

Sleeping tasks use the Harness clock. `HarnessOptions.now` and `setTimer` supply
that clock and its timers; `ToolExecutionApi.now()` reads it. `Harness.wake()`
reports runnable work and the earliest sleep. With `onWake`, the host owns the
wake alarm instead of a Harness sleep timer. These are upstream task APIs, not
authority to add agent-side waits. Source: `pi-durable/dist/harness/types.d.ts`.

Repeated interruption without a new task state reaches `settings.restartLimit`
(default 5), then parks the task with blocked reason `restart_limit`.
`Harness.retryTask()` releases it. A clean close does not count as a crash.
Exhaustive task-state and blocked-reason consumers must preserve sleeping and
parked states instead of treating them as terminal or empty. Sources:
`pi-durable/dist/{types,harness/types}.d.ts`.

### Host options and reports

`HarnessOptions.models` and `settings` accept either current objects or getter
functions. The host resolves getters at use, rather than freezing values at
open. `onReport(error, info)` identifies Session, task, extension, host, and
listener failures; report metadata is not task acceptance.
`settings.afterFailedRun` defaults to `keep`, with `continue` and `withdraw`
policies for queued inputs. `compaction.modelOverrides` sets thresholds by exact
provider/model identity. Source: `pi-durable/dist/harness/types.d.ts`.

`HarnessOptions.telemetry` accepts a host-owned adapter; omission supplies no-op
telemetry. The public schema covers admission, phases, checkpoints, replay,
reports, and optional metrics and propagation. Identifiers and control fields
exclude transcript bodies, but failed-phase diagnostics can contain caller
content and are capped at 500 characters. A telemetry capability is not a
requirement to add a recorder or duplicate retained history. Sources:
`pi-durable/README.md` and `pi-durable/dist/harness/types.d.ts`.

## Pi Durable runtime

The installed 1.4.0 `pi-durable/README.md` and manifest define a separate
runtime whose API changes between releases. Available primitives do not by
themselves supply a complete ordinary Pi session, terminal UI, or detached host.

### Supplied runtime

`Harness.open()` uses host-supplied models, registry, storage, and environments.
Conversations retain inputs, entries, ownership, queued work, and terminal
outcomes. Admission is not an answer; canceling a wait does not cancel admitted
work. Generation owns native tool tasks; tool intent commits before effects.
Safe tools replay under their contract, not a general exactly-once promise.
Compaction changes context without deleting older retained entries.

`ConversationView`, document watches, `watchEvents()`, `taskGraph()`, and
`watchTaskGraph()` expose committed state and live ownership. They are not
paged archives of unknown stored sessions. Slow watches replace queued frames
with a current snapshot. The host supplies resource discovery, project trust,
configured models, process claims, and result routing.

### Environment and tool contracts

`FileSystem` has bounded binary/directory readers, line scans, and watch.
`noFollow` checks the final path component, not every ancestor. `Shell.exec()`
accepts shell text or argv; argv bypasses shell parsing. Output windows and
skipped-byte accounting preserve bounded tails. Defining sources are
`pi-durable/dist/env/{index.d.ts,node.js,node-watch.js,decode.js,line-scan.js}`
and `dist/harness/{types.d.ts,output.js}`.

Current Node watch fixes cover permission errors, replaced directories,
symbolic-link targets, overlapping recursive coverage, and close during rescan.
Polling still misses changes undone between snapshots. Optional `listFiles()`
supplies bounded gitignore-aware listings; it is not a mandate for another
harness index. The host uses upstream `NodeExecutionEnv`, not a custom environment.
Environment conformance exports test custom implementations, not every host
filesystem or power-loss condition.

Native bash/PowerShell return nonzero exits as structured error results rather
than thrown `tool_error`. Native bash's program value uses `exitCode`; ordinary
coding-agent bash uses `exit_code`. Their wrappers are different contracts.
No PowerShell adoption is required for this macOS host.

### Provider session identity

`ProviderDoc` retains one conversation-scoped UUID. Generation and compaction
forward it as provider `sessionId`. Turns, retries, reopen, reset, and model
selection reuse it; children and forks receive distinct identities. It is not
a storage ID, submission ID, or task ID. Defining sources:
`pi-durable/dist/harness/{provider,generation,compaction,harness,view}.js`.

The host uses public configured model services and forwards current transport,
timeout, retry, and sampling options. Provider transport timeout and generation
retry policy are different mechanisms. Mistral's current request timeout covers
headers, not the response body. Per-thinking sampling remains upstream request
construction; catalog visibility does not prove remote support or cache savings.

### Native task ownership and agent placement

A foreground conversation owned by a tool task follows that task's cancellation.
Persistent background work has its own anchor and reporter. Background ownership
does not imply a separate OS process; this host adds storage processes explicitly.
Replay-safe creation and reporting reuse native request IDs.

The Agent slice returns exact admitted result references and holds native
`agent_await` requests without provider calls merely to wait. An ordinary primary
remains responsive through one Durable lead. Result settlement is not acceptance.
The [Agent README](../extensions/agent/README.md#controls) owns exact result,
placement, release, and delivery semantics. Native task graph cycle checks cover
waits and held owners; they do not prove complete cross-host graph coverage.

### Durability limits

Committed state is observable, but progress intervals do not establish a fixed
crash-loss window. Partial and tool-output commits default to 100 ms; tool output
also adapts its interval by size. Uncommitted progress is lost on process failure.
Sources: `pi-durable/dist/harness/{agent,generation,tool}.js` and
`chord/dist/output.js`.

JSONL defaults fsync off. Sidecar-before-marker ordering with fsync enabled does
not prove every acknowledged tail survives power loss. SQLite uses WAL and
`synchronous = NORMAL`; process recovery and power failure are different claims.
Sources: `pi-durable/dist/storage/jsonl/storage.js` and
`chord/dist/sqlite/node.js`.
Existing Agent subprocess regressions exercise their checkpoints, not universal
exactly-once effects, orphan cleanup, or power-loss durability.

Storage errors fail the Session closed. Pending waits and later calls reject
with `SessionFailed`; storage owns transient retries. A read that throws
`StorageRequestError` rejects that request without failing the Session. The same
error from `commit()` or `mintId()` fails the Session. `Session.closed` and
watch `session_failed` make that failure visible. Listener/report errors do not
replace the underlying storage error. Sources: `pi-durable/dist/{session/session,types}.d.ts`
and `pi-durable/dist/session/session.js`. The host must preserve the failure rather
than retry a failed Session or describe it as empty state.

Blocking-threshold compaction failure now fails generation with `model_error`
instead of submitting an oversized request. `pi.live.compactionFailure` retains
the newest failure until a successful summary. Both ordinary and Durable
summaries omit thinking; retained exact entries remain separate evidence.
Document/context retention settings bound caches, not retained storage.

### Storage host retirement

The Agent owns exclusive writer claims and detached host lifetime; Durable does
not supply a cross-process ownership lock. Passive connections alone do not own
native work. Native tasks, active deliveries, controls, and open observations
hold the host. Cold reads leave retained source stores writer-free. The capture
path copies source bytes before it opens the disposable target; 1.4.0 migration
of that target does not migrate the source. Source:
`extensions/agent/snapshot-capture.ts`. Clean retirement and unexpected host loss
have different recovery consequences.

Retained hosts keep loaded code and their selected coding-agent installation.
Idle retirement does not silently choose a new Pi install. Source and dependency
updates form one activation unit: a `sleepUntil()` consumer requires the 1.4.0
task API, not a 1.3.0 dependency graph. Promotion synchronizes source into sibling
worktrees, so source promotion alone can cross this boundary before any install.
An isolated lockfile and source candidate does not establish live activation.
The 1.4.0 transition requires both the migration decision for existing operator
stores and an owner-agreed boundary for retained consumers. Before source or
dependency activation, old consumers must remain on intact old bytes, finish,
or stop/restart at an owner-agreed boundary. This includes all changed native
contributions, not only the Agent host. Promotion-triggered sibling source
synchronization is part of activation; compose checks in isolated trees before
that boundary. A source-only update to a contribution creates version skew as
surely as a dependency update. See the
[host contract](agent-host-contract.md#no-start-observation-versus-acquiring-controls)
and Agent README for the actual lifecycle controls.

### Process contracts and peer threads

The host descriptor separates source release, API floors, per-operation request
and response identities, and exact Durable representation. Consumers compare
the contract they implement, not blindly echo remote identities. Operations with
opaque native values bind to the exact loaded Durable release. Transport changes
also invalidate retained manager and primary-channel objects independently.
The [current operation table](agent-host-contract.md#current-operation-identities)
is the single owner of those values.

Peer threads retain frames, members, attributed events, and delivery intents
through native documents and transactions. Passive write notices start no model
turn; explicit attention uses input. A display-only native write now settles
immediately except behind a queued reset. Notices with model content still use
model-input placement; do not confuse the two. New input `entry` metadata is a
native option, not permission to rewrite earlier communication provenance.
The [peer-thread contract](../extensions/agent/README.md#peer-threads) owns
application routing, bounds, and authority.

### Native extension integration boundary

The host collects native contributions from configured extension factories
through the [contribution contract](conventions/durable-contributions.md).
Only those bundles execute in Durable. Configured ordinary-only extensions
remain explicit; no shadow SessionManager or synthetic ordinary lifecycle
supplies their missing capabilities. Cwd-bound public services supply resources,
trust decisions, providers, and installation identity.

Contributed tools use native output/schema/caller APIs. Native nested calls use
the native hooks and parent identifiers. Close callbacks run after the host abort
signal and before storage closes. The Agent terminal composes public chat/editor
components over native observations; no published embeddable InteractiveMode or
experimental coding-agent client is assumed.

### Store format and retained task versions

Durable 1.4.0 opens SQLite storage at schema version 2. `SqliteStorage.open()`
automatically applies pending migrations before reading metadata. Migration 2
rebuilds the tasks table to admit the `sleeping` status, copies its records,
and recreates its indexes. Opening an existing schema-1 database therefore
changes storage even when no task resumes. A drained store does not avoid this
migration. The migration runner rejects a schema newer than it supports;
Pi 1.3.0 and earlier cannot reopen the migrated database. Sources:
`pi-durable/dist/storage/sqlite/{storage,migrations}.js` and
`chord/dist/sqlite/migrations.js`.

JSONL needs no SQLite migration, but Pi 1.3.0 and earlier do not resume stored
sleeping tasks. Source: `pi-durable/CHANGELOG.md`. Neither format supplies a safe
rollback merely because the transcript remains readable.

Native `pi.tool` remains version 2 with a migration from version 1 task input
in `pi-durable/dist/harness/tool.js`. Task-definition migrations and SQLite
schema migration are separate changes.

The controlled `extensions/agent/host-upgrade.test.mts` trial completed an
isolated Pi/Durable 1.3.0-to-1.4.0 transition. It drained tools and deliveries,
closed the old writer, and released its claim before the new open. The trial
checked schema 1 to 2, the rebuilt task constraint, unchanged other schema
objects and retained rows, exact retained results, and successful follow-up work.
Its synthetic tool executed once without an abort. The fixture requires
explicitly supplied isolated old and new runtimes and skips when those inputs
are absent. This result concerns that drained synthetic store, not arbitrary
operator stores, unsafe-effect replay, or compatibility with live consumers.

Operator migration authority must cover a 1.4.0 open of an existing operator
SQLite store, including a drained store. An explicit grant supplies that
authority without repeated approval; the safe consumer transition still binds.
Unfinished `pi.tool` tasks at version `1` also need authority for task migration.
A read-only inspection request does not authorize a writer or live migration.
No live-store trial or compatibility reader follows from these source checks.
UI reload, retained ordinary managers, and every changed contribution still
need their owner's transition boundary.

## Terminal rendering boundary

Pi TUI supplies `VStack`, `HStack`, `ScrollView`, viewport detection, mouse
handling, and program status. An overlay renders at its configured width and applies its height limit; it is
not a constrained layout root. The Agent dashboard bounds its own viewport. Non-PNG Kitty images require a registered
transcoder. Sources: `pi-tui/dist/{index.d.ts,tui.js,tui-alt-screen.js,terminal-image.js}`
(`tui.js` resolves overlay width before calling `component.render(width)`),
`pi-tui/dist/components/image.js`, and coding-agent interactive/image-convert sources.
These are source boundaries, not a new terminal interaction trial.

`ToolRenderContext` carries recorded `durationMs` and `outputPad`.
`agent_settled.aborted` distinguishes cancellation from ordinary completion.
OSC 7501 program status is terminal status, not task acceptance. Hardware cursor,
mouse-wheel, shifted-key, color-reply, image, and compaction-indicator fixes belong
to the upstream TUI unless a customized consumer changes their contract.

## Ordinary custom-message presentation

Presentation and delivery remain separate. `registerMessageRenderer` receives
expansion state; the default custom component displays its body. Registered
renderers own presentation without changing retained content. Provider conversion
keeps model-visible content and omits display metadata; authority labels belong
in content, not metadata alone. Idle custom triggers now use the shared startup
hook contract above. Sources: `dist/core/messages.js`,
`dist/modes/interactive/components/custom-message.js`, and extension declarations.

## Configuration and source context

Cwd selects project context and trust; a native fork does not perform ordinary
resource discovery by itself. Public loader services preserve configuration
precedence. Explicit skill/prompt paths support isolated drafts; discovery alone
does not prove selection or activation. Resource `!`, `+`, and `-` path entries
expand `~`, and nested-worktree context discovery follows current symlinked
AGENTS paths without introducing new links. Sources: `dist/core/resource-loader.js`,
`docs/{sdk,settings,packages}.md`, and CLI resource selection.

Pi publishes editor schemas for settings, models, keybindings, and themes.
Use installed documentation for their `$schema` URLs. Editor completion is not
runtime adoption or a new completion gate. Provider catalogs/pricing, retries,
remote clipboard overrides, managed release retention, and auth/platform fixes
remain upstream responsibilities. Do not add parallel catalogs or credential
trials solely to repeat upstream behavior.

## Resource contributions and interactive lifecycle

`resources_discover` appends resources after startup; name collisions keep the
first selected resource and report conflicts. UI prompt start/end describe open
UI spans, not proof of a required human response. Cache-warming decisions report
proposed action; a decision is not completed refresh or current cache state.
Reload retains the SessionManager while replacing the extension runtime.
Shortcut handlers receive ExtensionContext, not command-only session controls.
Sources: resource-loader, skills, extension runner/types, cache-warmer, and
agent-session sources. Interactive focus and input require interactive evidence.

## Current-session evidence retrieval

`ReadonlySessionManager.getEntry()` supports bounded explicit ancestry walks.
`getBranch()`, `getEntries()`, `getTree()`, session listing, and `open()` do not
supply producer visit limits. Truncating their output does not bound their reads.
`buildSessionProjection()` applies context edits; raw active entries do not.
Foreign-file inspection uses bounded read-only capture, not writable `open()`.
Current public parsing skips malformed lines and does not supply structural or
capture bounds. A Durable live view is not a paged archive query.
Sources: `dist/core/session-manager.{d.ts,js}` and `docs/session-format.md`.

## Ordinary-session completion delivery

`turn_end` and `agent_before_settle` use actionable `emitBoundary()`, not
notification `emit()`. Validated returned drafts append in order without a
cross-entry transaction. Requested continuation does not suppress natural tool
or queued work. `agent_settled` is notification-only; requested runs defer until
its handlers finish. Abort suppresses requested pre-settle continuation.

Steering reaches the next model-call boundary; follow-up waits until work ends.
A quiet custom message during streaming waits until tool results are retained,
so it does not split a tool call from its result. Context filters change provider
input, not retained evidence or acceptance. Preserve source identity and reply
routes; display order alone proves neither causality nor comprehension.
Sources: `dist/core/agent-session.js`, `dist/core/messages.js`, and runner/types.

## Fork and result boundaries

Ordinary fork/clone uses SessionManager. A native fork uses its own retained
entries, ownership, and submissions; it does not replace ordinary continuation.
Native submission and task records preserve admission and terminal outcome.
The host adds bounded inspection and owner-directed delivery; acknowledgment
means delivery, not acceptance. Ordinary agent files stay untouched and unread
by the Durable host. Sources: session-manager/runtime and Durable types/harness.

## Convergence decisions

| Capability | Owner |
|---|---|
| Generation, native nested calls, script replay, storage recovery | Pi Durable |
| Resources, trust, configured providers, ordinary primary lifecycle | Public coding-agent services |
| Detached storage processes, writer claims, exact controls and delivery | Agent extension |
| Typed live calls and state over same-user sockets | Chord plus the package-level transport boundary |
| Bounded retained inspection and independent retained-read executable | Agent extension's public consumer contract |
| Browser access | UI consumes the public transport and retained-read contracts, not Agent-private source |
| Doctrine and handover meaning | Owning corpus and Stash contracts; transport does not create authority |

Cloudflare storage and image adapters are published options, not deployment
requirements. Native classifier catalog additions use the public configured
model runtime; no additional classifier service is required. Context/document
retention remain upstream defaults absent a concrete consumer requirement.
Ordinary terminal program status and `agent_settled.aborted` are not native
host operation identities. No ordinary/Durable parity claim follows from naming.

## Refresh

After each Pi upgrade and before a host-dependent decision:

- Resolve publication, active installation, checkout graph, and upstream refs
  separately. Keep wildcard declarations and install the current lock graph in
  affected checkouts.
- Compare previous and current published package files, excluding source maps
  and release bundles. Re-read changed defining files and affected consumers.
  Carry a source claim forward only when unchanged bytes or inspected hunks
  support it; a file comparison does not repeat runtime trials.
- Review separate Durable and Chord release notes alongside coding-agent intake.
  Check output, callers, task ownership, storage failure, process transport,
  retained-reader, and lifecycle boundaries at their owning layers.
- Reconcile shipped manifest resources, actual active routes, and stable slices.
  Other owners' unpublished work is not released adoption.
- Keep release records and raw comparison evidence outside tracked repository
  paths. Durable documentation describes current contracts and their limits.
- Run required repository gates on the composed graph. Dependency installation,
  source inspection, and mismatch refusal do not establish safe live activation.
- Replace stale claims in place. Name an unavailable defining layer explicitly;
  do not renew its verification date by inference.
