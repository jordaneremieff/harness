# Pi durable-harness track

Upstream Pi develops AgentHarness as a durable agent core: an immutable entry
tree, stored values and lists, execution lanes with ordered inboxes, and
terminal result records. This repository converges with that program instead
of building a parallel core. The track distinguishes the installed runtime,
published packages, upstream implementation, and planned contracts.

## Checked source boundary

Verified 2026-09-08. Upstream reads use `main` commit
`6160683a4a8012f0d1cd30c145df18b4ca6f5176`. The WP08 fork branch merged
into `main` through [pull request #9152](https://github.com/earendil-works/pi/pull/9152)
(merge commit
[`3e4bc268`](https://github.com/earendil-works/pi/commit/3e4bc2680ea8eca162207974b88667ccfc20a564),
2026-09-08). The installed runtime is Pi 0.85.1; this checkout's dependency
snapshot remains on 0.85.0. Tests against that snapshot do not establish
validation against the upgraded installation.

Installed paths in this document are relative to the installed
`@earendil-works/pi-coding-agent` package root. A path that starts with
`pi-agent-core/` sits under that package's
`node_modules/@earendil-works/pi-agent-core/`.

| Source | Checked state |
|---|---|
| Active coding agent and agent core | Pi 0.85.1; confirmed from installed package metadata |
| Checkout packages | Pi 0.85.0; confirmed from local package metadata; separate from the active installation |
| npm publication | `@earendil-works/pi-coding-agent` has `latest: 0.85.1`; the exact 0.85.1 metadata exposes client/plugin subpaths only under the `source` condition |
| GitHub release metadata | Latest listed release is [v0.85.1](https://github.com/earendil-works/pi/releases/tag/v0.85.1), published 2026-09-05, tag commit `d981de1229ef899957bbe968bc8dcda02a21f477` |
| Upstream main | [`6160683a`](https://github.com/earendil-works/pi/commit/6160683a4a8012f0d1cd30c145df18b4ca6f5176); coding-agent and agent-core manifests declare 0.85.1 |
| Fork work | [Pull request #9152](https://github.com/earendil-works/pi/pull/9152) merged `dev-named-forks-streaming` at [`3e4bc268`](https://github.com/earendil-works/pi/commit/3e4bc2680ea8eca162207974b88667ccfc20a564) (2026-09-08); WP08 continues on `main`, Slice C in progress |

The v0.85.1-to-checked-main comparison merges the WP08 fork machinery
(`packages/agent` session forks, JSONL streaming, a text-line-reader
capability) and adds unreleased coding-agent changes listed in its changelog:
extension model streaming, strict-prefer tool sampling for built-in tools,
RPC input-handler routing, and editor-border spinner embedding. It leaves the
ordinary SDK construction (`sdk.ts`), `AgentHarnessOptions`, the extension
loader, the harness specification, and the roadmap unchanged. Installed
0.85.1 and the retained 0.85.0 checkout have byte-identical ordinary SDK,
session-services, and extension-loader modules. This source comparison is
not a runtime regression test. Do not infer npm publication state from GitHub
release metadata or installed behavior from `main`.

## Configuration and source context

Verified 2026-09-06 against installed Pi 0.85.1, checkout dependencies 0.85.0,
and upstream `main` at
[`9767ba27`](https://github.com/earendil-works/pi/commit/9767ba275f3e9a5ee0f5c5342249b629ab1b2282).
Rechecked 2026-09-08: `sdk.ts` and `agent-harness.ts` are byte-identical at
`main` [`6160683a`](https://github.com/earendil-works/pi/commit/6160683a4a8012f0d1cd30c145df18b4ca6f5176),
and the v0.85.1-to-`main` change census adds no reusable configuration-file
selector or profile surface.
This focused check covers configuration, resources, and message inputs. The
publication, fork implementation, and other general-track checks above and
below retain their separately stated dates; they are not current checks of
those surfaces.

- The [ordinary SDK][configuration-sdk] still constructs `Agent` and
  `AgentSession`. Installed `dist/core/resource-loader.js` merges additional
  skill paths into ordinary discovery. Reusable source selection does not
  require a replacement resource loader.
- [AgentHarness options and lanes][configuration-host] expose model, thinking,
  tools, resources, skill/template invocation, and message insertion. These
  primitives do not themselves define a reusable configuration-file selector
  or the ordinary host's cwd discovery behavior.
- Installed `dist/core/messages.js` converts custom-message content into a
  provider message with role `user`. It omits custom metadata such as `details`
  and `display`. Source labels and authority limits belong in the content;
  metadata is not a separate permission boundary. Selecting cwd also selects
  ordinary project context and trust inputs.
- Keep reusable input resolution before ordinary session construction. Replace
  its message adapter when the adopting host preserves model-visible delivery,
  transcript behavior, lifecycle, and full resources. A custom metadata entry
  alone does not establish those properties.
- Remove local selection machinery when a host-owned selection contract supplies
  the same job, or when ordinary dispatch and existing skills remove its need.
  AgentHarness adoption alone does not supply file resolution, precedence, or
  source applicability. Reusable guides retain ownership of their procedures;
  current tasks retain their targets and permitted actions.

[configuration-sdk]: https://github.com/earendil-works/pi/blob/6160683a4a8012f0d1cd30c145df18b4ca6f5176/packages/coding-agent/src/core/sdk.ts#L306-L388
[configuration-host]: https://github.com/earendil-works/pi/blob/6160683a4a8012f0d1cd30c145df18b4ca6f5176/packages/agent/src/harness/agent-harness.ts#L518-L610

## Current-session evidence retrieval

Verified 2026-09-06 against installed Pi 0.85.1
`dist/core/session-manager.d.ts`, `dist/core/session-manager.js`, and
`dist/core/extensions/types.d.ts`. This check covers ordinary-session retrieval,
not the separately dated upstream program claims.

- `ExtensionContext.sessionManager` exposes `ReadonlySessionManager`.
  `getEntry(id)` reads the existing in-memory map; `getLeafId()` and
  `getSessionId()` read current identifiers. No session file needs to be opened.
- `getBranch()` follows the complete parent chain, including compaction entries.
  `getEntries()` filters the whole session; `getTree()` builds the whole tree.
  None accepts a visit limit. A bounded extension query must walk parents through
  `getEntry()` and stop at its own limit, rather than truncate a complete scan.
- Raw entries remain distinct from `buildContextEntries()`, which applies
  compaction. Stored roles, custom types, and summaries describe recorded source
  metadata; they do not establish human identity or fresh operator authority.
- History retrieval uses a selected entry and its ancestry. Bounded discovery
  of unknown alternate branches requires a host-owned paged enumeration API.
  Do not add a parallel index or raw session-file reader to supply that API.

## Collaboration observation

Verified 2026-09-07 against installed Pi 0.85.1 and upstream `main` at
[`9767ba27`](https://github.com/earendil-works/pi/commit/9767ba275f3e9a5ee0f5c5342249b629ab1b2282).
The named installed sources were rechecked on 2026-09-08 against the same
installed version.
The latest listed GitHub release remains v0.85.1. Fork pull request
[#9152](https://github.com/earendil-works/pi/pull/9152) merged into `main` on
2026-09-08; its effects are recorded under "Fork and result boundaries".
This focused check does not refresh the separately dated publication, backend,
or packaging claims.

- The [ordinary SDK][collaboration-sdk] still constructs `Agent` and
  `AgentSession`; installed `dist/core/sdk.js` keeps that construction
  boundary. The subagent extension uses public session services and
  ordinary sessions; its dashboard does not adopt the durable runtime.
- [Lane observation][collaboration-lane] exposes a snapshot, event subscription,
  and resnapshot. Installed `pi-agent-core/dist/harness/agent-harness.d.ts`
  declares `LaneSnapshot` as lane name, transcript entries, tip id, optional
  last result, configuration, session stats, the current operation with its
  streaming message and running tools, queued items, and a faulted flag.
  The upstream [`reduceLaneSnapshot`][collaboration-reducer]
  owns event application and requests a fresh snapshot after navigation.
  Consumers of durable lanes use that reducer instead of another event fold.
  Installed `pi-agent-core/dist/harness/runtime/lane.js` captures ancestry only
  back to compaction, without a count limit; a live snapshot is neither a
  bounded history page nor a complete archive.
- [Session-wide observation][collaboration-watch] still throws
  `SliceNotImplemented("watchSession")`; installed
  `pi-agent-core/dist/harness/runtime/harness.js` carries the same boundary.
  Per-lane observation does not supply
  a complete session inventory subscription.
- [Durable entry queries][collaboration-entries] belong to `Session` and
  `Branch`. Ordinary `SessionManager.open()` still reads the complete file and
  repairs an unfinished tail. Do not pass foreign active files to that loader.
  Installed coding-agent publicly exports the pure `parseSessionEntries()`
  function and `SessionManager.inMemory(cwd, options, entries)`. A selected,
  byte-bounded read-only file snapshot can therefore use Pi's parser and tree
  traversal without a private decoder or any write to its source. This is not
  a native paged file API: oversized files require an explicit unavailable
  state, and snapshots do not establish current state after capture. Keep this
  adapter limited to known session files, not whole-session discovery or a
  parallel index.
- Preserve source session and entry identities, per-session order, and explicit
  reply links. Display-time ordering does not establish causality. A recorded
  recipient message, a process-local context observation, and a reply establish
  different facts; none establishes understanding or action. Missing historical
  observations remain unknown rather than reconstructed from current state.

[collaboration-sdk]: https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/sdk.ts#L306-L403
[collaboration-lane]: https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/src/harness/agent-harness.ts#L180-L250
[collaboration-reducer]: https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/src/harness/runtime/reducer.ts#L21-L232
[collaboration-watch]: https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/src/harness/runtime/harness.ts#L305-L307
[collaboration-entries]: https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/src/harness/session/types.ts#L520-L538

## Ordinary-session completion delivery

Verified 2026-09-08 against installed Pi 0.85.1
`dist/core/agent-session.js`, `dist/core/extensions/types.d.ts`,
`dist/modes/interactive/components/custom-message.js`, and
`dist/modes/interactive/interactive-mode.js`. This check covers the ordinary
message adapter, not the separately dated durable-runtime program claims.

- `sendMessage` with steering delivery queues a custom message before the next
  model call after tool results. Follow-up delivery waits until tool work ends.
  An idle-turn trigger starts a response when the session is idle. The public
  extension API does not expose per-message queue retraction.
- A context hook can omit completion messages when an exact collection result
  already supplies that evidence in the same context. This changes provider
  input, not the retained session tree, and does not prove model acceptance.
- `registerMessageRenderer` receives native expansion state and output padding.
  `CustomMessageComponent` starts collapsed; the interactive host applies its
  tool-expansion state and configured keybinding. The default renderer displays
  the full body regardless of expansion. The subagent renderer supplies bounded
  collapsed rows and exposes message evidence on expansion.
- Keep delivery on these ordinary-session surfaces. The report view requires
  no durable lane adoption, additional inbox, receipt journal, or replacement
  terminal renderer. Replace this adapter when the worker host changes its
  message contract, while preserving result access and owner-controlled work.

## Names and defining contracts

The normative specification is [`packages/agent/docs/harness.md`][spec].
"AgentHarness" and the historical "harness v2" branch vocabulary refer to the
same program. The [post-WP05 roadmap][roadmap] is a planning inventory, not a
behavior contract; it explicitly records contradictions with normative text.
A work-package requirement is not proof that its implementation is complete.

The installed `pi-agent-core` 0.85.1 manifest exports `./harness/context`,
`./harness/session`, `./harness/session/testing`, `./harness/runtime/reducer`,
and `./harness/env/nodejs`. Its declarations expose `accept`, `drive`,
`requestAbort`, and `inspectExecution`. The `reduceLaneSnapshot` reducer owns
the client fold of lane events. Published reachability does not mean that the
ordinary coding-agent SDK uses this runtime.

## Runtime adoption and distribution

Verified 2026-09-08 against installed Pi 0.85.1, the retained checkout's
0.85.0 modules, checked `main`, and current release and npm metadata.

- The ordinary SDK constructs `Agent` and `AgentSession` in
  `pi-coding-agent/dist/core/sdk.js`. This repository's subagent slice uses the
  public session-services construction path and `SessionManager`, not
  AgentHarness lanes.
- The retained Pi 0.85.0 package includes an experimental AgentHarness worker in
  `dist/experimental/session-worker.js`. Its construction supplies read,
  write, and bash tools and `resources: {}`. That source does not establish
  full ordinary-session tool, extension, skill, or instruction parity.
- Facets are executable bundles that provide services. They are not only a
  specification: the retained 0.85.0 `dist/experimental/services/worker.js` calls
  Chord's `defineFacet`, `createFacetHost`, and `createRemoteServiceEndpoint`
  for built-in services and loaded plugins. This is concrete adoption in the
  experimental worker, not migration of the ordinary extension loader.
- Installed 0.85.1 exposes `./client` and `./experimental/plugin` only under
  the `source` condition and contains neither client nor experimental dist
  directories. Checked [main packaging][package] defines those exclusions.
  Its [command dispatcher][commands] labels server/client commands
  development-only. Release 0.85.1 corrects accidental publication of internal
  experimental code and dependencies that caused import failures; it does not
  remove the supported local SDK or stdio RPC contract. The runtime exports in
  0.85.0 were not a supported upgrade contract.
- The [roadmap][roadmap] distinguishes process-local `Session` and
  `AgentHarness` objects from remote semantic services. It records an
  unresolved raw RemoteSession contract and lists generic remote harness
  capabilities as optional or deferred. Remote semantic services exist, but
  these sources do not establish a supported drop-in attachment contract for
  this repository's ordinary SDK workers.
- Installed `dist/harness/runtime/harness.js` in `pi-agent-core` still throws
  `SliceNotImplemented("watchSession")`. Lane observation and session-wide
  observation are different surfaces.

## Fork and result boundaries

Verified 2026-09-08 against [WP08][wp08] and the [JSONL fork
implementation][jsonl-fork], both on `main` after pull request #9152 merged
(`3e4bc268`, 2026-09-08).

WP08 remains in progress; its status line records Slice C (SQLite streaming)
as the active slice. The merge lands the explicit-scope `ForkOptions`
contract, the closed fork classifier, direct Memory construction, and
two-scan JSONL streaming with a read-only source capture: a JSONL fork never
writes its source, and a torn tail is discarded in memory. These facts do not
establish the entire requirement:

- `JsonlForkIndex` still retains in-memory maps and sets for current scalar
  addresses, entry parents, copied entry IDs, and lane state. Auxiliary
  memory therefore still grows with source state; the two-scan fold is not a
  source-size-independent bound. The legacy-v3 path copies an already
  normalized in-memory source, and open legacy-v3 sources reject forks.
- SQLite streaming is the in-progress Slice C, and Slice D (benchmarks plus
  the specification status refresh) is pending: the specification's WP08
  line still describes the Slice A state. Do not label backend convergence
  complete from Memory or JSONL progress.
- Sequence preservation is explicitly not part of the fork contract;
  backends allocate destination-local sequences.
- WP08 leaves coding-agent `/fork`, `/clone`, and `--fork` on
  `SessionManager`. The subagent slice also forks through that public API, so
  the new `SessionRepo` fork contract does not itself require a local cutover.
- The merge adds a `TextLineReader`/`openTextLineReader` capability to the
  harness `FileSystem` interface for streaming fork reads. It does not
  change ordinary resource discovery.

The installed `OperationResultRecord` declaration in
`pi-agent-core/dist/harness/session/types.d.ts` (Pi 0.85.1, unchanged)
contains terminal metadata and
`fromTipId`/`tipId` transcript pointers, not embedded submitted content.
`AgentLane` also exposes `getResult` and entry queries. The repository must
preserve exact submitted-result retrieval, including its documented bounds
and parent-session loss behavior. That requirement does not make a separate
content store permanent: upstream transcript or service contracts could
satisfy it. Adopt them only after checking retrieval and retention semantics,
then remove any superseded local storage in the same cutover.

## Convergence decisions

Verified 2026-09-08. These decisions preserve capability while replacing
mechanism when a suitable upstream contract exists.

| Repository capability | Upstream boundary | Repository action |
|---|---|---|
| Worker execution and observation | Durable lanes, ordered inboxes, terminal records, lane reducer | Use the upstream primitives when the worker host adopts them; do not add a second lane fold |
| Ordinary worker resources | `AgentHarnessOptions` accepts tools, resources, and system prompt; experimental worker defaults are narrower | Preserve full ordinary-session capabilities through the host's resource construction; a stored fork is not context discovery |
| Worker continuation | `SessionRepo` fork contract merged for Memory and JSONL; WP08 SQLite and documentation slices remain | Keep `SessionManager` until the adopting host preserves the continuation contract |
| Remote control | Implemented semantic services, development-only coding-agent packaging, unresolved raw Session transport | Evaluate the callable host contract and package support before replacing worker control; do not infer either permanent absence or ready parity |
| Extension composition | Real Chord facets in the experimental worker | Map existing extension behavior when the ordinary host adopts that boundary; do not build a parallel plugin system |
| Submitted result retrieval | Terminal records plus transcript access | Preserve exact retrievable content; replace separate storage if upstream satisfies the full contract |
| Prose handover and doctrine | Application-level content | Keep the content here; upstream execution durability does not supply its meaning |

## Action triggers

| Trigger | Action |
|---|---|
| A new Pi release installs | Recheck active metadata, package exports, loader bindings, and this track; refresh the lockfile and run repository gates. The manifest has wildcard peers, not old direct version pins |
| A repository consumer starts to observe AgentHarness lanes | Use `reduceLaneSnapshot`; verify the required watch surface rather than treating session-wide watch as implemented |
| WP08 advances or merges | Recheck Memory, JSONL auxiliary memory and source boundaries, and SQLite separately |
| Remote contracts or coding-agent distribution change | Check the actual published entrypoints and host capability parity before changing worker control |
| The ordinary host adopts AgentHarness or facets | Preserve resources, tools, lifecycle, cancellation, continuation, and exact result retrieval; delete mechanisms upstream supersedes |
| The extension loader changes | Check the source change against imports and resource discovery before the next upgrade |
| Storage format changes | Check the public session APIs and their supported data contract; do not introduce raw-file coupling |

## Refresh

Refresh after each Pi upgrade, before a program-dependent decision, and when
this verification predates the active install. Use read-only GitHub release,
commit, comparison, exact-file, and pull-request APIs; npm metadata; installed
manifests and implementation; and checkout dependency metadata. Resolve each
mutable upstream ref before reading its files. Replace dates and state in
place, without commit-distance tallies or an investigation history.

A dated entry records the last check, not present truth. If a defining source
is unavailable, mark the affected claim unverified rather than repeating it.
Retire this track when convergence is complete; Git retains the history.

[spec]: https://github.com/earendil-works/pi/blob/6160683a4a8012f0d1cd30c145df18b4ca6f5176/packages/agent/docs/harness.md
[roadmap]: https://github.com/earendil-works/pi/blob/6160683a4a8012f0d1cd30c145df18b4ca6f5176/packages/agent/docs/post-wp05-roadmap.md
[package]: https://github.com/earendil-works/pi/blob/6160683a4a8012f0d1cd30c145df18b4ca6f5176/packages/coding-agent/package.json
[commands]: https://github.com/earendil-works/pi/blob/6160683a4a8012f0d1cd30c145df18b4ca6f5176/packages/coding-agent/src/experimental/commands.ts
[wp08]: https://github.com/earendil-works/pi/blob/6160683a4a8012f0d1cd30c145df18b4ca6f5176/packages/agent/docs/work-packages/08-named-branch-streaming-forks.md
[jsonl-fork]: https://github.com/earendil-works/pi/blob/6160683a4a8012f0d1cd30c145df18b4ca6f5176/packages/agent/src/harness/session/jsonl/fork.ts
