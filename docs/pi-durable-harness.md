# Pi durable-harness track

Pi's ordinary SDK, durable AgentHarness, and Pico3 kernel are distinct runtime
contracts. This repository uses host-owned execution and observation where those
contracts preserve its capabilities. An exported kernel does not by itself
replace ordinary extension loading, project trust, resource discovery, or
submitted-result retrieval.

## Policy pre-call guidance boundary

Verified 2026-09-23. The active installation and policy worktree still resolve
coding-agent 0.87.0. Its `before_agent_start` handler returns a custom message
before command selection: installed `dist/core/extensions/runner.js`
`emitBeforeAgentStart()` awaits handlers and collects messages;
`dist/core/agent-session.js` appends them before `_runAgentPrompt()`.
The public contract is `BeforeAgentStartEventResult.message` in
`dist/core/extensions/types.d.ts` and installed `docs/extensions.md`.
Policy uses that ordinary hook for its bounded shell-contract snapshot rather
than a tool-call interception that occurs after the model selects a command.
The policy hook tests exercise the real runner, custom-message conversion, and
first controlled model request. They do not establish model compliance.

The same date's metadata checks resolve npm coding-agent `latest` to 0.87.1,
[release v0.87.1](https://github.com/earendil-works/pi/releases/tag/v0.87.1),
and upstream main to `898ab804050730e9dcefb4443875d5a932aa6a32`.
Those metadata checks do not establish changed host contracts or upgrade the
installation. The wider program review below retains its explicit source
snapshot; it does not describe the newly observed upstream revisions.

## Checked source boundary

Verified 2026-09-22. The active installation, npm `latest`, and checkout
lockfile resolve Pi 0.87.0. The manifest retains wildcard Pi peers; the lockfile
records the resolved dependency graph rather than a supported-version ceiling.
TypeBox resolves to 1.3.27 in the active installation and checkout.

| Source | Checked state |
|---|---|
| Installed coding agent and agent core | 0.87.0, from package metadata and installed declarations/source |
| Checkout Pi packages | 0.87.0, from the lockfile and local package metadata |
| npm publication | Coding-agent, AI, server, and TUI `latest` are 0.87.0 |
| GitHub release | [v0.87.0][release], published 2026-09-21; tag commit `16787ad5b2dc748047f314ca1bfe7708f30f54f3` |
| Checked upstream `main` | [`d201760ffee16564aa8d9a759e0c85b70db33674`][main] |

The [previous-boundary-to-release comparison][boundary-release] includes
canonical session projection, append-only context edits, actionable boundaries,
the split context hooks, image input limits, and transactional Chord updates.
These are released 0.87.0 contracts, not unreleased changes. The
[release-to-main comparison][release-main] adds multimodal empty-text handling,
Grok 4.7 support, invalid `--mode` rejection, versioned document storage under
`packages/durable`, and changelog updates. It changes neither the ordinary
session boundary implementations nor the lane/Pico3 implementations cited below.

This track is a targeted contract review, not an exhaustive changelog or a
package-wide equivalence claim. Its claims use exact files and installed source.
The separate [`@earendil-works/pi-durable` root][durable-exports] exports
`MemoryStorage` and storage records at checked main. Those source exports do not
establish a replacement ordinary-session runtime or change Pico3's contracts.

Installed paths below are relative to the active `@earendil-works/pi-coding-agent`
package root. `pi-agent-core/` and `pi-ai/` refer to its corresponding packages
under `node_modules/@earendil-works/`. Source inspection establishes the checked
contract and implementation, not a runtime regression result for this repository.

## Runtime adoption and distribution

| Runtime | Available boundary | Consequence |
|---|---|---|
| Ordinary coding-agent SDK | [`createAgentSession`][sdk] constructs `Agent` and `AgentSession`; `AgentSessionRuntime` owns session replacement | Keep full extension/resource behavior through public session services and runtime construction |
| Durable AgentHarness | Root agent-core API plus harness context, session, environment, and reducer exports | Lanes, stored results, and ordered inboxes remain a separate explicit host choice |
| Pico3 | Agent-core exports [`./experimental/pico3`][agent-package] with declarations and executable JavaScript | The kernel is published, not merely a design document; its host integration still requires an explicit capability match |

Coding-agent exports its ordinary root and `./rpc-entry` as runtime entrypoints.
Its `./client` and `./experimental/plugin` remain source-condition-only. Do not
restore coupling to the accidentally published experimental distribution from
an earlier package. The supported local SDK and stdio RPC contract remain
separate from those development entrypoints.

The installed extension loader binds Pi core imports to the running install.
`dist/core/extensions/loader.js` aliases coding-agent, agent-core, TUI, AI and
its named compatibility/provider subpaths, plus TypeBox root/compile/value.
Server, client, and Chord are not in that alias map; their package resolution
must be checked separately. Matching a checkout lockfile does not establish
that every loaded extension resolves the same dependency instance.

## Current ordinary-session contracts

Verified 2026-09-22 against installed `docs/sdk.md`,
`dist/core/{sdk,agent-session}.js`, `dist/core/extensions/{types.d.ts,runner.js}`,
`dist/core/session-manager.d.ts`, `pi-ai/dist/types.d.ts`, and
`pi-agent-core/dist/{agent.d.ts,agent-loop.js}`.

- `SessionManager` owns finalized request history. `AgentSession` supplies its
  [canonical projection][session-projection] before each request and refreshes
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
- The [request-time `context` hook][context-hooks] sees conversation messages
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

These changes apply to the ordinary SDK without a durable-kernel migration.
Do not treat an AgentHarness or Pico3 cutover as a prerequisite for fixing
current provider transcripts, lifecycle registration, or session replacement.

## Configuration and source context

Verified 2026-09-22 against installed `dist/core/resource-loader.js`,
`dist/core/messages.js`, the ordinary SDK, and [Pico3 options][pico-options].

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

## Current-session evidence retrieval

Verified 2026-09-22 against installed `dist/core/session-manager.d.ts`,
`dist/core/session-manager.js`, and `dist/core/extensions/types.d.ts`.

- `ExtensionContext.sessionManager` exposes `ReadonlySessionManager`.
  `getEntry(id)` reads the existing map; current leaf/session identifiers need
  no session-file read.
- `getBranch()` follows the full parent chain. `getEntries()` filters the whole
  session and `getTree()` constructs the whole tree. These methods accept no
  visit limit. Bound ancestry queries by repeated `getEntry()` calls with an
  explicit stop condition, not by truncating a completed scan.
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
  without a private decoder or a write to its source. Oversized captures need an
  explicit unavailable state; capture time limits freshness.
- The ordinary API still does not provide bounded discovery of unknown alternate
  branches. Neither a complete tree scan nor a durable live view is a paged
  archive query. Do not add a parallel raw-file index to imply that contract.

## Collaboration observation

Verified 2026-09-22 against installed durable-lane and Pico3 implementations.
Their observation contracts are not interchangeable.

**Durable AgentHarness lanes.** `LaneSnapshot` carries configuration, transcript,
operation, queues, stats, and fault state. The public `reduceLaneSnapshot` owns
event application and requests a fresh snapshot after navigation. A tool remains
`status: "settled"` after `tool_end` until its `toolResult` entry is placed;
`turn_end` does not remove it. Consumers need no parallel progress store.
Installed `pi-agent-core/dist/harness/runtime/harness.js` still throws
`SliceNotImplemented("watchSession")`. Per-lane observation does not establish
a complete session-inventory subscription.

**Pico3 conversations.** [Capture and subscription][pico-watch] share the session
transaction boundary. `ConversationView` contains entries, resolved config,
inbox, active turn, compaction, task status, and projected plugin state.
`applyEnvelope` applies the host's document operations; consumers must not
reconstruct the view through a second event reducer. The raw watch buffers
before `start()` with a bounded capacity, then calls listeners synchronously in
order. Overflow or listener failure closes that watch. It has no resnapshot or
replay method: reopen a watch for a fresh capture.

Pico3 captures the active transcript through the latest head boundary, or all
fork-visible entries when no head exists. It pages internally but has no public
total capture limit. That is not a bounded history page. The
[Chord adapter][pico-chord] applies document operations and commit events in one
synchronous `view.change(ctx, draft => ...)` batch per envelope. Chord exposes
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

Verified 2026-09-22 against installed `dist/core/agent-session.js`,
`dist/core/messages.js`, and `dist/core/extensions/{runner.js,types.d.ts}`.

- `turn_end` and `agent_before_settle` are actionable extension boundaries.
  Dispatch them through [`ExtensionRunner.emitBoundary()`][boundary-runner],
  not the notification `emit()` API. Handlers receive persisted source IDs at
  `turn_end`, accumulated draft entries, and a rebuilt context preview. Allowed drafts are `custom`,
  `custom_message`, `context_edit`, and `compaction`; a null compaction retention
  target keeps no preceding entries. Pi validates the complete proposal before
  appending it in order, but persistence is not transactional.
- `continue: true` requests one next provider call per boundary invocation;
  natural tool or queue continuation satisfies that request. `continue: false`
  does not suppress natural work. Guard repeated requests rather than return
  unconditional continuation.
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

Verified 2026-09-22 by inspection of [Pico3 JSONL source][pico-jsonl] and installed
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

Verified 2026-09-22 against the current [WP08 handoff][wp08], installed
`pi-agent-core/dist/harness/session/{types.d.ts,jsonl/fork.js}`, and the ordinary
session APIs.

The WP08 handoff still states that SQLite streaming is in progress; this is a
document-status claim, not a fresh audit of the SQLite backend. Memory direct
copies and JSONL two-scan forks implement the required explicit branch/tree scope.
JSONL's structural maps and copied-entry set still grow with source state;
streaming does not mean constant auxiliary memory. Its fork read discards a
torn tail without repairing the source. The handoff retains SQLite and
benchmark/documentation completion as separate obligations. Do not infer
backend convergence from the Memory or JSONL implementation.

Ordinary `/fork`, `/clone`, and `--fork` still use `SessionManager`. Pico3
conversation forks belong to its own storage and document model. Neither
contract silently replaces an ordinary-session continuation.

The durable `OperationResultRecord` stores terminal metadata and transcript
pointers, not submitted content. Pico3 exposes retained task outcomes and input
results. Adopt either for submitted-result storage only after exact content,
lookup, retention, size bounds, and parent-session-loss behavior meet the
application contract. Delete superseded storage in the same cutover.

## Names and defining contracts

The older [AgentHarness specification][spec], [roadmap][roadmap], and
[mobile handoff][mobile] describe the lane runtime. The roadmap is a planning
inventory with explicit contract contradictions, not proof of implementation.
WP08 status does not describe Pico3 readiness.

Pico3 has its own source and contracts. Its [hardening handoff][pico-hardening]
explicitly yields on overlapping topics to [view/events][pico-view-doc] and
[plugins][pico-plugin-doc]. The handoff still describes a pre-integration archive,
while the package exports and installed source establish that Pico3 now ships.
Do not turn historical delivery instructions or prototype defect lists into
current defects without checking the implementation.

## Convergence decisions

Verified 2026-09-22. Use the ordinary SDK as the default host for current
extension/resource behavior. Check its boundary and context controls before
considering a kernel migration. Match the selected host, not only a shared name.

| Repository capability | Host-owned replacement condition | Action |
|---|---|---|
| Ordinary session replacement | Public session services and `AgentSessionRuntime` preserve cwd, resources, trust, and lifecycle | Use them now rather than duplicate construction and replacement |
| Turn completion and checkpoints | Ordinary `finishTurn`, actionable boundaries, and session projection supply the required control | Use these hooks first; preserve post-run recovery and queues |
| Request context | `context` preserves Pi-owned prompt/tools; `context_with_system` explicitly transfers request transcript ownership | Use the narrow hook; distinguish transient filtering from persisted context edits |
| Worker execution/recovery | Durable lane or Pico3 host preserves tools, hooks, cancellation, continuation, and resources | Replace local scheduling only at that complete host boundary |
| Live observation | Selected host supplies lane snapshots/reducer or Pico3 view/envelopes | Use its fold and closure behavior; do not keep duplicate progress state |
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
- Replace dated claims in place. If a defining source is unavailable, mark the
  affected claim unverified rather than preserve a stale verification date.

[release]: https://github.com/earendil-works/pi/releases/tag/v0.87.0
[main]: https://github.com/earendil-works/pi/commit/d201760ffee16564aa8d9a759e0c85b70db33674
[boundary-release]: https://github.com/earendil-works/pi/compare/3390bd93630965a12a0a1a5c36ce890ec22f7e1d...16787ad5b2dc748047f314ca1bfe7708f30f54f3
[release-main]: https://github.com/earendil-works/pi/compare/16787ad5b2dc748047f314ca1bfe7708f30f54f3...d201760ffee16564aa8d9a759e0c85b70db33674
[sdk]: https://github.com/earendil-works/pi/blob/d201760ffee16564aa8d9a759e0c85b70db33674/packages/coding-agent/src/core/sdk.ts#L368-L439
[session-projection]: https://github.com/earendil-works/pi/blob/d201760ffee16564aa8d9a759e0c85b70db33674/packages/coding-agent/src/core/agent-session.ts#L608-L685
[context-hooks]: https://github.com/earendil-works/pi/blob/d201760ffee16564aa8d9a759e0c85b70db33674/packages/coding-agent/src/core/extensions/runner.ts#L1185-L1251
[boundary-runner]: https://github.com/earendil-works/pi/blob/d201760ffee16564aa8d9a759e0c85b70db33674/packages/coding-agent/src/core/extensions/runner.ts#L928-L977
[durable-exports]: https://github.com/earendil-works/pi/blob/d201760ffee16564aa8d9a759e0c85b70db33674/packages/durable/src/index.ts#L1-L31
[agent-package]: https://github.com/earendil-works/pi/blob/d201760ffee16564aa8d9a759e0c85b70db33674/packages/agent/package.json#L8-L41
[pico-options]: https://github.com/earendil-works/pi/blob/d201760ffee16564aa8d9a759e0c85b70db33674/packages/agent/src/harness/pico3/harness.ts#L58-L110
[pico-watch]: https://github.com/earendil-works/pi/blob/d201760ffee16564aa8d9a759e0c85b70db33674/packages/agent/src/harness/pico3/harness.ts#L746-L803
[pico-chord]: https://github.com/earendil-works/pi/blob/d201760ffee16564aa8d9a759e0c85b70db33674/packages/agent/src/harness/pico3/chord.ts#L41-L150
[pico-jsonl]: https://github.com/earendil-works/pi/blob/d201760ffee16564aa8d9a759e0c85b70db33674/packages/agent/src/harness/pico3/jsonl.ts#L28-L110
[wp08]: https://github.com/earendil-works/pi/blob/d201760ffee16564aa8d9a759e0c85b70db33674/packages/agent/docs/work-packages/08-named-branch-streaming-forks.md
[spec]: https://github.com/earendil-works/pi/blob/d201760ffee16564aa8d9a759e0c85b70db33674/packages/agent/docs/harness.md
[roadmap]: https://github.com/earendil-works/pi/blob/d201760ffee16564aa8d9a759e0c85b70db33674/packages/agent/docs/post-wp05-roadmap.md
[mobile]: https://github.com/earendil-works/pi/blob/d201760ffee16564aa8d9a759e0c85b70db33674/packages/agent/docs/mobile-handoff/README.md
[pico-hardening]: https://github.com/earendil-works/pi/blob/d201760ffee16564aa8d9a759e0c85b70db33674/packages/agent/docs/pico/v3/hardening-handoff.md
[pico-view-doc]: https://github.com/earendil-works/pi/blob/d201760ffee16564aa8d9a759e0c85b70db33674/packages/agent/docs/pico/v3/view-and-events.md
[pico-plugin-doc]: https://github.com/earendil-works/pi/blob/d201760ffee16564aa8d9a759e0c85b70db33674/packages/agent/docs/pico/v3/plugins.md
