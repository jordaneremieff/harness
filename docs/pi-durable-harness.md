# Pi durable-harness track

Upstream Pi develops AgentHarness as a durable agent core: an immutable entry
tree, stored values and lists, execution lanes with ordered inboxes, and
terminal result records. This repository converges with that program instead
of building a parallel core. The track distinguishes the installed runtime,
published packages, upstream implementation, and planned contracts.

## Checked source boundary

Verified 2026-09-05. Upstream reads use `main` commit
`da840b6216578c2a571d0374ac6a2091a83f9d91` and the WP08 fork branch commit
`85186f823d31c6d36c135190b3c357dbb6522c81`. The installed runtime is Pi
0.85.1; this checkout's dependency snapshot remains on 0.85.0. Tests against
that snapshot do not establish validation against the upgraded installation.

| Source | Checked state |
|---|---|
| Active coding agent and agent core | Pi 0.85.1; confirmed from installed package metadata |
| Checkout packages | Pi 0.85.0; confirmed from local package metadata; separate from the active installation |
| npm publication | `@earendil-works/pi-coding-agent` has `latest: 0.85.1`; the exact 0.85.1 metadata exposes client/plugin subpaths only under the `source` condition |
| GitHub release metadata | Latest listed release is [v0.85.1](https://github.com/earendil-works/pi/releases/tag/v0.85.1), published 2026-09-05, tag commit `d981de1229ef899957bbe968bc8dcda02a21f477` |
| Upstream main | [`da840b62`](https://github.com/earendil-works/pi/commit/da840b6216578c2a571d0374ac6a2091a83f9d91); coding-agent manifest declares 0.85.1 |
| Active fork work | `dev-named-forks-streaming` at [`85186f82`](https://github.com/earendil-works/pi/commit/85186f823d31c6d36c135190b3c357dbb6522c81); [pull request #9152](https://github.com/earendil-works/pi/pull/9152) is open and draft |

The v0.85.0-to-checked-main comparison changes agent package metadata and its
changelog, not `packages/agent` runtime code. It also leaves the extension
loader unchanged. Installed 0.85.1 and the retained 0.85.0 checkout have
byte-identical ordinary SDK, session-services, and extension-loader modules.
This source comparison is not a runtime regression test. Do not infer npm
publication state from GitHub release metadata or installed behavior from `main`.

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

Verified 2026-09-05 against installed Pi 0.85.1, the retained checkout's
0.85.0 modules, and checked `main`.

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

Verified 2026-09-05 against installed declarations, [WP08][wp08], and the
[branch's JSONL fork implementation][jsonl-fork].

WP08 remains in progress. Its requirements call for named-branch and tree
forks, source sequence preservation, and bounded auxiliary memory. The active
branch advances Memory construction and JSONL copying, but those facts do not
establish the entire requirement:

- JSONL uses sequential passes over the source. `JsonlForkIndex` retains
  in-memory maps and sets for current scalar addresses, entry parents, copied
  entry IDs, and lane state. Auxiliary memory therefore grows with source
  state; a two-pass implementation is not a source-size-independent bound.
- WP08 records the implementation's sequence boundary in place of the
  specified fixed file handle and prefix. It assumes no source replacement
  during the scans. Its closed legacy-v3 normalization also retains the
  complete source in memory. These remain distinct from the planned
  disk-backed procedure.
- SQLite streaming remains a separate WP08 slice. The checked branch
  comparison contains no SQLite implementation change. Do not label backend
  convergence complete from Memory or JSONL progress.
- WP08 leaves coding-agent `/fork`, `/clone`, and `--fork` on
  `SessionManager`. The subagent slice also forks through that public API, so
  the new `SessionRepo` fork contract does not itself require a local cutover.

The installed `OperationResultRecord` declaration in
`pi-agent-core/dist/harness/session/types.d.ts` contains terminal metadata and
`fromTipId`/`tipId` transcript pointers, not embedded submitted content.
`AgentLane` also exposes `getResult` and entry queries. The repository must
preserve exact submitted-result retrieval, including its documented bounds
and parent-session loss behavior. That requirement does not make a separate
content store permanent: upstream transcript or service contracts could
satisfy it. Adopt them only after checking retrieval and retention semantics,
then remove any superseded local storage in the same cutover.

## Convergence decisions

Verified 2026-09-05. These decisions preserve capability while replacing
mechanism when a suitable upstream contract exists.

| Repository capability | Upstream boundary | Repository action |
|---|---|---|
| Worker execution and observation | Durable lanes, ordered inboxes, terminal records, lane reducer | Use the upstream primitives when the worker host adopts them; do not add a second lane fold |
| Ordinary worker resources | `AgentHarnessOptions` accepts tools, resources, and system prompt; experimental worker defaults are narrower | Preserve full ordinary-session capabilities through the host's resource construction; a stored fork is not context discovery |
| Worker continuation | `SessionRepo` named-branch/tree forks; WP08 is incomplete | Keep `SessionManager` until the adopting host preserves the continuation contract |
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

[spec]: https://github.com/earendil-works/pi/blob/da840b6216578c2a571d0374ac6a2091a83f9d91/packages/agent/docs/harness.md
[roadmap]: https://github.com/earendil-works/pi/blob/da840b6216578c2a571d0374ac6a2091a83f9d91/packages/agent/docs/post-wp05-roadmap.md
[package]: https://github.com/earendil-works/pi/blob/da840b6216578c2a571d0374ac6a2091a83f9d91/packages/coding-agent/package.json
[commands]: https://github.com/earendil-works/pi/blob/da840b6216578c2a571d0374ac6a2091a83f9d91/packages/coding-agent/src/experimental/commands.ts
[wp08]: https://github.com/earendil-works/pi/blob/85186f823d31c6d36c135190b3c357dbb6522c81/packages/agent/docs/work-packages/08-named-branch-streaming-forks.md
[jsonl-fork]: https://github.com/earendil-works/pi/blob/85186f823d31c6d36c135190b3c357dbb6522c81/packages/agent/src/harness/session/jsonl/fork.ts
