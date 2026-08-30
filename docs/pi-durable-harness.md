# Pi durable-harness track

Upstream Pi is rebuilding its agent core as a durable harness: an entry tree
with bound values and lists, lanes with inboxes, immutable result records, and a
facet-and-service composition layer. This file tracks that one program: what it
contains, how far it is from the release this harness runs on, and what this
repository does when each piece arrives.

## Names for the program

Upstream titles the specification "AgentHarness" in
`packages/agent/docs/harness.md`, and its own prose never uses a version label.
Its working vocabulary does: the branch `harness-v2/j4` and the pull requests
#7503, #7611, #7669, and #7707 all call the work "harness v2". The predecessor
the program removes is "runtime1" (work package WP00). Treat "AgentHarness",
"harness v2", and "the durable-harness line" as one subject. This file avoids the
version label as its own name because the label stops identifying the program
once it ships. Verified 2026-08-30.

## How this file is kept

Every section names the date it was verified and the release tag or `dev` commit
it reflects. Values are replaced in place: this file holds current state, not
history. Other Pi subjects, and other upstream projects such as Node, Biome,
TypeScript, and typebox, are out of scope here.

## Why the program is tracked

This harness was built around the expectation that Pi's core would become a
durable harness, so convergence with the program is the design premise, not a
risk to it. For any harness surface decision:

- When the program owns a capability, or will own it on the current `dev` line,
  adapt to it instead of building a parallel mechanism here.
- Where the program supplies nothing is where this harness contributes: prose
  handover, content-bearing result stores, the doctrine corpus.
- Program work that supersedes a harness mechanism is a reason to delete that
  mechanism, not to defend it.

## What the program contains

Verified 2026-08-30 at `dev` commit `0252dff8`.

- `packages/agent/docs/harness.md` is the normative specification. Its
  work-package table records WP00 through WP06 complete and WP07 (SQLite
  ownership fencing) planned.
- Concepts the specification fixes: bound values and lists over an immutable
  entry tree with a usage ledger; lanes with a single ordered inbox; result
  records that embed no entries and delimit a transcript segment by pointer;
  `accept`, `drive`, `requestAbort`, and `inspectExecution` as the primitives;
  storage format 4, still pre-stabilization and changed in place without
  migrations.
- `packages/agent/docs/plugins.md` is the composition half: host-specific
  bundles of facets, `defineService` tokens, `memoOnce`, and the
  `@earendil-works/chord` service runtime.
- `packages/agent` declares `@earendil-works/pi-agent-core` with the harness
  subpath exports `./harness/context`, `./harness/session`,
  `./harness/session/testing`, `./harness/runtime/reducer`, and
  `./harness/env/nodejs`. `reduceLaneSnapshot` is the normative client fold for
  lane snapshots.
- `packages/protocol/src/harness.ts` carries the harness protocol types.
- `packages/server` on `dev` depends on `chord`, `pi-agent-core`, and
  `pi-protocol`.

## How far the program is from this harness

Verified 2026-08-30.

| Field | Value |
|---|---|
| Latest published release | `v0.84.4`, tag commit `b79e4cc8`, published 2026-08-28; the npm `latest` dist-tag for `@earendil-works/pi-coding-agent` is 0.84.4 |
| Development branch | `dev` at `0252dff8` (2026-08-30), 338 commits ahead of `v0.84.4` and 0 behind |
| `main` | 337 commits behind `dev`; the program lands on `dev` first |
| This checkout | `node_modules` carries the Pi packages at 0.84.2; `@earendil-works/pi-protocol` and `@earendil-works/pi-server` are pinned `^0.84.2` |
| Reachable today | Nothing. The published `pi-agent-core` 0.84.4 exports only `.`, `./node`, `./package.json`, and `./session/testing`, and the published `pi-server` 0.84.4 depends on `pi-ai` and `pi-protocol`, not on `chord` |

Re-verify with `gh api repos/earendil-works/pi/releases/latest`,
`gh api repos/earendil-works/pi/compare/v0.84.4...dev`,
`gh api repos/earendil-works/pi/compare/main...dev`,
`npm view @earendil-works/pi-agent-core@<release> exports`,
`npm view @earendil-works/pi-server@<release> dependencies`, and
`jq .version node_modules/@earendil-works/pi-coding-agent/package.json`.

## What the program disturbs here today

Verified 2026-08-30.

- Nothing in the extension surface. The last commit touching
  `packages/coding-agent/src/extensions` is `dcd46192` (2026-08-24), an ancestor
  of `v0.84.4`, so the loader this harness depends on is unchanged on `dev`.
- Nothing in session storage. This harness reads session entries only through
  the public `SessionManager` API (`extensions/subagent/index.ts`,
  `extensions/herdr/index.ts`), so storage format 4 stays behind that surface.
- The subagent extension imports the published `@earendil-works/pi-server`, so
  the program's wider dependency graph arrives with a future release, not today.

## Convergence map

Verified 2026-08-30 at `dev` commit `0252dff8`.

| Harness concept | Counterpart in the program | State |
|---|---|---|
| subagent worker records and lane observation | durable lanes, inboxes, immutable result records | specified, absent from the published release |
| slice isolation between extensions | per-session workers and facet boundaries | specified |
| extension vertical slices | facet bundles and `defineService` tokens | design specification |
| stash prose handover | none | harness-owned |
| content-bearing result store | result records embed no payload | harness-owned |
| pillars doctrine corpus | none; the program's corpus is normative engineering text, not agent doctrine | harness-owned |

## Action triggers

Verified 2026-08-30 at `dev` commit `0252dff8`.

| Trigger | Action |
|---|---|
| A new Pi release installs | Re-verify this file, run the full suite, and raise the `^0.84.2` pins when the release line moves past 0.84 |
| `pi-agent-core` publishes its harness subpaths | Consume `reduceLaneSnapshot` for lane observation instead of folding lane events by hand |
| `pi-server` publishes with `chord` and `pi-agent-core` | Accept the wider dependency graph and re-check the subagent extension's protocol and server imports |
| Facets and services reach the coding agent | Map the subagent store onto `requestAbort`, result records, and `memoOnce`, and keep the content-bearing store the program does not supply |
| The extension loader changes on `dev` | Read the change before the next upgrade; the whole extension surface rests on it |
| Storage format 4 stabilizes or gains migrations | Confirm the harness still touches session files only through `SessionManager` |

## Refresh

Refresh this file:

1. after each Pi upgrade on the machine;
2. before a harness decision that depends on the program;
3. whenever the newest verification date predates the machine's active install.

Use read-only checks (`gh api` reads, `npm view`, local manifests). Replace
values and dates in place. Verify a value in the current session before you cite
it for a decision: a dated entry records the last check, not present truth. When
the machine cannot reach GitHub, report the `dev` rows as unverified instead of
citing them.

Retire this file when the program ships and the harness has adapted to it. A
track of a finished program is history, and history belongs in Git.

## Scope

This file records the moving state of one upstream program and the actions that
state triggers. It carries no operator-local paths, credentials, or private
context. Rules that do not move belong in `AGENTS.md`. A different upstream
subject needs its own file, not a section here.
