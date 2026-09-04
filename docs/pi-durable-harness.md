# Pi durable-harness track

Upstream Pi is rebuilding its agent core as a durable harness: an entry tree
with bound values and lists, lanes with inboxes, immutable result records, and a
facet-and-service composition layer. This file tracks that one program: what it
contains, how far it is from the release this harness runs on, and what this
repository does when each piece arrives.

## Names for the program

Upstream titles the specification "AgentHarness" in
`packages/agent/docs/harness.md`, and its own prose never uses a version label.
Earlier working vocabulary did: the branch `harness-v2/j4` and pull requests
#7503, #7611, #7669, and #7707 call the work "harness v2". The implementation
now lives on `main`; unmerged WP08 work uses `dev-named-forks-streaming`. The
predecessor the program removes is "runtime1" (work package WP00). Treat
"AgentHarness", "harness v2", and "the durable-harness line" as one subject.
This file avoids the version label as its own name because the label stops
identifying the program once it ships. Verified 2026-09-04.

## How this file is kept

Every section names the date it was verified and the release, `main`, or active
continuation commit it reflects. Values are replaced in place: this file holds
current state, not history. Other Pi subjects, and other upstream projects such
as Node, Biome, TypeScript, and typebox, are out of scope here.

## Why the program is tracked

This harness was built around the expectation that Pi's core would become a
durable harness, so convergence with the program is the design premise, not a
risk to it. For any harness surface decision:

- When the program owns a capability, or will own it on unreleased `main` or an
  active continuation branch, adapt to it instead of building a parallel
  mechanism here.
- Where the program supplies nothing is where this harness contributes: prose
  handover, content-bearing result stores, the doctrine corpus.
- Program work that supersedes a harness mechanism is a reason to delete that
  mechanism, not to defend it.

## What the program contains

Verified 2026-09-04 at `main` commit `2d411633` and WP08 branch commit
`2e2805d9`.

- `packages/agent/docs/harness.md` is the normative specification. Its
  work-package table records WP00 through WP07 complete, WP08 in progress on
  Slice A, and WP09 complete.
- WP08 on `main` implements mandatory fork scope, named source branches,
  ancestry checks, configured-lane checks, and the closed scalar fork policy.
  Lists, sequence and high-water preservation, direct Memory construction, and
  bounded JSONL and SQLite transfer remain.
- The unmerged `dev-named-forks-streaming` head adds direct Memory fork
  construction and Memory-side sequence, list, and high-water preservation. It
  remains marked as Slice A work. JSONL and SQLite streaming remain specified,
  not implemented.
- WP09 keeps settled but unplaced tool calls in
  `LaneSnapshot.operation.runningTools` with `status: "settled"`. The reducer
  removes each record only after the matching immutable `toolResult` entry is
  placed, so reconnect snapshots do not lose finalized tool output. `tool_end`
  now publishes after outcome staging; synthetic results publish paired
  `tool_start` and `tool_end` events.
- Concepts the specification fixes: bound values and lists over an immutable
  entry tree with a usage ledger; lanes with a single ordered inbox; result
  records that embed no entries and delimit a transcript segment by pointer;
  `accept`, `drive`, `requestAbort`, and `inspectExecution` as the primitives;
  storage format 4, still pre-stabilization and changed in place without
  migrations.
- `packages/agent/docs/plugins.md` remains a design specification for the
  composition half: host-specific bundles of facets, `defineService` tokens,
  `memoOnce`, and the `@earendil-works/chord` service runtime.
- `packages/agent` declares `@earendil-works/pi-agent-core` with the harness
  subpath exports `./harness/context`, `./harness/session`,
  `./harness/session/testing`, `./harness/runtime/reducer`, and
  `./harness/env/nodejs`. `reduceLaneSnapshot` is the normative client fold for
  lane snapshots.
- Chord owns the service wire and remote service adapters. Current source keeps
  services available during facet reloads and treats a post-cutover reload
  failure as terminal. The experimental compatibility shims were removed.
- `packages/protocol` carries transport envelopes and session-service schemas.
  `packages/server` on `main` depends on `chord`, `pi-agent-core`, and
  `pi-protocol`.

## How far the program is from this harness

Verified 2026-09-04.

| Field | Value |
|---|---|
| Latest published release | `v0.84.4`, tag commit `b79e4cc8`, published 2026-08-28; the npm `latest` dist-tag for `@earendil-works/pi-coding-agent` is 0.84.4 |
| Canonical source | `main` at `2d411633` (2026-09-04), 443 commits ahead of `v0.84.4` and 0 behind |
| Former `dev` line | The exact `dev` ref is absent. `main` contains the former `d24c99f4` baseline and is 78 commits ahead of it |
| Active WP08 branch | `dev-named-forks-streaming` at `2e2805d9` (2026-09-03), 1 commit ahead of and 11 behind `main`; no pull request uses this head |
| Historical harness branch | `harness-v2/j4` at `f7f933c6` is 9 commits ahead of its merge base and 702 behind `main`; its last commit is from 2026-08-07 |
| Local Pi packages | The active global coding agent and its agent core are 0.84.4. This checkout resolves the coding agent, agent core, protocol, and server at 0.84.2; `package.json` pins protocol and server at `^0.84.2` |
| Reachable today | Published `pi-agent-core` 0.84.4 exposes an earlier `AgentHarness` and session API from its root. It does not expose the current WP00-WP09 contract or explicit harness subpaths; its export map contains only `.`, `./node`, `./package.json`, and `./session/testing`. Published `pi-server` 0.84.4 does not depend on `chord` |

Re-verify with the GitHub release, branch, comparison, and pull-request APIs;
`npm view @earendil-works/pi-agent-core@<release> exports`;
`npm view @earendil-works/pi-server@<release> dependencies`; the active install
metadata; and `npm ls` in this checkout. Use comparison `ahead_by` and
`behind_by` values because the returned commit array is capped.

## What the program disturbs here today

Verified 2026-09-04 against `main` and the active WP08 branch.

- No extension-loader behavior change requires work. The only loader commit on
  current `main` after `v0.84.4` is `a789067a`. It moves bundled-Node detection
  for experimental process launch without changing extension registration or
  discovery.
- WP08 explicitly leaves coding-agent fork commands on the legacy
  `SessionManager`. The subagent extension also reads and forks sessions through
  that public API (`extensions/subagent/index.ts`), so the new repository fork
  contract does not disturb it now.
- WP09 changes the unreleased `pi-agent-core` lane snapshot shape and reducer.
  The subagent extension does not import those surfaces, so no local code change
  follows.
- The subagent extension imports the published `@earendil-works/pi-server`, so
  the program's wider dependency graph arrives with a future release, not today.

## Convergence map

Verified 2026-09-04 at `main` commit `2d411633` and WP08 branch commit
`2e2805d9`.

| Harness concept | Counterpart in the program | State |
|---|---|---|
| subagent worker records and lane observation | durable lanes, inboxes, immutable result records | current lane-observation contract implemented on unreleased `main`; the release exposes an earlier root API |
| subagent continuation forks | named-branch and tree forks through `SessionRepo` | partial on `main`; the newer Memory slice is unmerged; JSONL and SQLite streaming remain |
| slice isolation between extensions | per-session workers and facet boundaries | facet kernel implemented on unreleased `main`; plugin composition remains a design specification |
| extension vertical slices | facet bundles and `defineService` tokens | design specification |
| stash prose handover | none | harness-owned |
| content-bearing result store | result records embed no payload | harness-owned |
| pillars doctrine corpus | none; the program's corpus is normative engineering text, not agent doctrine | harness-owned |

## Action triggers

Verified 2026-09-04 at `main` commit `2d411633` and WP08 branch commit
`2e2805d9`.

| Trigger | Action |
|---|---|
| A new Pi release installs | Re-verify this file, run the full suite, and raise the `^0.84.2` pins after the release line moves past 0.84 |
| `pi-agent-core` publishes its harness subpaths | Consume `reduceLaneSnapshot` for lane observation instead of folding lane events by hand |
| `dev-named-forks-streaming` advances, rebases, merges, or gets a pull request | Re-read WP08, compare it with `main`, and update the Memory, JSONL, and SQLite status separately |
| `pi-server` publishes with `chord` and `pi-agent-core` | Accept the wider dependency graph and re-check the subagent extension's protocol and server imports |
| Facets and services reach the coding agent | Map the subagent store onto `requestAbort`, result records, and `memoOnce`, and keep the content-bearing store the program does not supply |
| The extension loader changes after `2d411633` | Read the change before the next upgrade; the whole extension surface rests on it |
| Storage format 4 stabilizes or gains migrations | Confirm the harness still touches session files only through `SessionManager` |

## Refresh

Refresh this file:

1. after each Pi upgrade on the machine;
2. before a harness decision that depends on the program;
3. whenever the newest verification date predates the machine's active install.

Use read-only checks (`gh api` reads, `npm view`, local manifests). Replace
values and dates in place. Verify a value in the current session before you cite
it for a decision: a dated entry records the last check, not present truth. When
the machine cannot reach GitHub, report the `main` and continuation rows as
unverified instead of citing them.

Retire this file when the program ships and the harness has adapted to it. A
track of a finished program is history, and history belongs in Git.

## Scope

This file records the moving state of one upstream program and the actions that
state triggers. It carries no operator-local paths, credentials, or private
context. Rules that do not move belong in `AGENTS.md`. A different upstream
subject needs its own file, not a section here.
