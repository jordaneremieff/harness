# Pi durable-harness track

Pi's ordinary SDK, durable AgentHarness, and Pico3 kernel are distinct runtime
contracts. This repository uses host-owned execution and observation where those
contracts preserve its capabilities. An exported kernel does not by itself
replace ordinary extension loading, project trust, resource discovery, or
submitted-result retrieval.

## Checked source boundary

Verified 2026-09-20. The active installation and npm `latest` resolve Pi 0.86.1;
the checkout dependency snapshot resolves 0.86.0. The manifest retains wildcard
Pi peers; the lockfile records the resolved dependency graph rather than a
supported-version ceiling. TypeBox resolves to 1.3.27 in both installations.

The cited ordinary SDK, session, extension, resource, message, durable-runtime,
Pico3, and fork implementation files are byte-identical between these installed
versions. The AI declarations differ only in the known-provider union, not the
message or transcript types cited here. These comparisons preserve the reviewed
contract conclusions; they do not establish equivalence of every package path.

| Source | Checked state |
|---|---|
| Installed coding agent and agent core | 0.86.1, from package metadata and installed declarations/source |
| Checkout Pi packages | 0.86.0, from the lockfile and local package metadata |
| npm publication | Coding-agent, AI, server, and TUI `latest` are 0.86.1 |
| GitHub release | [v0.86.1][release], published 2026-09-20; tag commit `13cbf77df2396303013a41646bcfa77b4271ae56` |
| Checked upstream `main` | [`3390bd93630965a12a0a1a5c36ce890ec22f7e1d`][main] |

The [release-to-main comparison][release-main] adds cache-refresh deadline checks
and updates changelogs. It does not change the defining durable-runtime files
cited below. This track is a targeted contract review, not an exhaustive
changelog. Its claims use exact files and installed source.

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

Verified 2026-09-20 against installed `docs/sdk.md`,
`dist/core/sdk.js`, `dist/core/extensions/types.d.ts`,
`pi-ai/dist/types.d.ts`, and
`pi-agent-core/dist/agent.d.ts`.

- Provider `TranscriptContext` contains messages. System prompt sections and
  tool declarations now travel through `SystemMessage` entries, including
  additions and removals. Code that reads `context.systemPrompt` or
  `context.tools` must use the current transcript contract instead.
- `Message` includes the `system` role. Exhaustive consumers must distinguish
  it from user, assistant, and tool-result messages.
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

Verified 2026-09-20 against installed `dist/core/resource-loader.js`,
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

Verified 2026-09-20 against installed `dist/core/session-manager.d.ts`,
`dist/core/session-manager.js`, and `dist/core/extensions/types.d.ts`.

- `ExtensionContext.sessionManager` exposes `ReadonlySessionManager`.
  `getEntry(id)` reads the existing map; current leaf/session identifiers need
  no session-file read.
- `getBranch()` follows the full parent chain. `getEntries()` filters the whole
  session and `getTree()` constructs the whole tree. These methods accept no
  visit limit. Bound ancestry queries by repeated `getEntry()` calls with an
  explicit stop condition, not by truncating a completed scan.
- Raw entries differ from compaction-aware `buildContextEntries()`. Stored
  role, custom type, or summary metadata does not establish fresh authority.
- `SessionManager.open()` reads a complete file and repairs an unfinished tail.
  Do not use it to inspect a foreign active file. A known, byte-bounded read-only
  capture can use public `parseSessionEntries()` and `SessionManager.inMemory()`
  without a private decoder or a write to its source. Oversized captures need an
  explicit unavailable state; capture time limits freshness.
- The ordinary API still does not provide bounded discovery of unknown alternate
  branches. Neither a complete tree scan nor a durable live view is a paged
  archive query. Do not add a parallel raw-file index to imply that contract.

## Collaboration observation

Verified 2026-09-20 against installed durable-lane and Pico3 implementations.
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
[Chord adapter][pico-chord] publishes one replicated view update per envelope,
uses its own bounded queue, and closes on failure; the owner must replace the
failed service instance. `PicoHarnessService` is local; the keyed
`PicoConversationService` is the remote semantic surface.

Preserve source identities, per-session order, and explicit reply links.
Display order does not prove causality. Delivery, context observation, and a
reply establish different facts; none alone proves understanding or action.

## Ordinary-session completion delivery

Verified 2026-09-20 against installed `dist/core/agent-session.js` and
`dist/core/messages.js`.

- Steering queues a custom message for the next model-call boundary after tool
  results. Follow-up waits until work ends. An idle trigger starts a turn.
- During streaming, `triggerTurn: false` defers custom-message insertion until
  the turn's tool results are in state and history. It does not insert a custom
  message between an assistant tool call and its result.
- A context hook can omit completion messages when exact collection evidence
  already appears in the same context. This changes provider input, not retained
  history, and does not prove model acceptance.
- Keep completion delivery on the selected worker host's public message surface.
  A report view does not itself require another durable inbox, receipt journal,
  or terminal renderer. Preserve exact result access when the host changes.

## Pico3 storage and ownership

Verified 2026-09-20 against [Pico3 JSONL source][pico-jsonl] and installed
`pi-agent-core/dist/harness/pico3/{harness,jsonl,chord}.js`.

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

Verified 2026-09-20 against the current [WP08 handoff][wp08], installed
`pi-agent-core/dist/harness/session/{types.d.ts,jsonl/fork.js}`, and the ordinary
session APIs.

WP08 still states that SQLite streaming is in progress. Memory direct copies
and JSONL two-scan forks implement the required explicit branch/tree scope.
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

Verified 2026-09-20. Match the selected host, not only a shared name.

| Repository capability | Host-owned replacement condition | Action |
|---|---|---|
| Ordinary session replacement | Public session services and `AgentSessionRuntime` preserve cwd, resources, trust, and lifecycle | Use them now rather than duplicate construction and replacement |
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

[release]: https://github.com/earendil-works/pi/releases/tag/v0.86.1
[main]: https://github.com/earendil-works/pi/commit/3390bd93630965a12a0a1a5c36ce890ec22f7e1d
[release-main]: https://github.com/earendil-works/pi/compare/13cbf77df2396303013a41646bcfa77b4271ae56...3390bd93630965a12a0a1a5c36ce890ec22f7e1d
[sdk]: https://github.com/earendil-works/pi/blob/3390bd93630965a12a0a1a5c36ce890ec22f7e1d/packages/coding-agent/src/core/sdk.ts#L368-L432
[agent-package]: https://github.com/earendil-works/pi/blob/3390bd93630965a12a0a1a5c36ce890ec22f7e1d/packages/agent/package.json#L8-L41
[pico-options]: https://github.com/earendil-works/pi/blob/3390bd93630965a12a0a1a5c36ce890ec22f7e1d/packages/agent/src/harness/pico3/harness.ts#L58-L110
[pico-watch]: https://github.com/earendil-works/pi/blob/3390bd93630965a12a0a1a5c36ce890ec22f7e1d/packages/agent/src/harness/pico3/harness.ts#L746-L803
[pico-chord]: https://github.com/earendil-works/pi/blob/3390bd93630965a12a0a1a5c36ce890ec22f7e1d/packages/agent/src/harness/pico3/chord.ts#L22-L145
[pico-jsonl]: https://github.com/earendil-works/pi/blob/3390bd93630965a12a0a1a5c36ce890ec22f7e1d/packages/agent/src/harness/pico3/jsonl.ts#L28-L110
[wp08]: https://github.com/earendil-works/pi/blob/3390bd93630965a12a0a1a5c36ce890ec22f7e1d/packages/agent/docs/work-packages/08-named-branch-streaming-forks.md
[spec]: https://github.com/earendil-works/pi/blob/3390bd93630965a12a0a1a5c36ce890ec22f7e1d/packages/agent/docs/harness.md
[roadmap]: https://github.com/earendil-works/pi/blob/3390bd93630965a12a0a1a5c36ce890ec22f7e1d/packages/agent/docs/post-wp05-roadmap.md
[mobile]: https://github.com/earendil-works/pi/blob/3390bd93630965a12a0a1a5c36ce890ec22f7e1d/packages/agent/docs/mobile-handoff/README.md
[pico-hardening]: https://github.com/earendil-works/pi/blob/3390bd93630965a12a0a1a5c36ce890ec22f7e1d/packages/agent/docs/pico/v3/hardening-handoff.md
[pico-view-doc]: https://github.com/earendil-works/pi/blob/3390bd93630965a12a0a1a5c36ce890ec22f7e1d/packages/agent/docs/pico/v3/view-and-events.md
[pico-plugin-doc]: https://github.com/earendil-works/pi/blob/3390bd93630965a12a0a1a5c36ce890ec22f7e1d/packages/agent/docs/pico/v3/plugins.md
