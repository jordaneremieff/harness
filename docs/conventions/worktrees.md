# Worktrees

Each slice uses a stable branch and a persistent Git worktree. The worktree
contains the current `main` branch plus changes for one slice. Slices are the
repository's independently developed resources: extensions, skills, prompts,
and project-level features.

## Layout

For a slice named `stash`:

- branch: `extension/stash`
- worktree: the sibling `harness.worktrees/stash` directory
- entrypoint: `extensions/stash/index.ts`

The repository derives slice identity from branch namespaces:

| Kind | Branch | Entrypoint |
| --- | --- | --- |
| extension | `extension/<name>` | `extensions/<name>/index.ts` |
| skill | `skill/<name>` | `skills/<name>/SKILL.md` |
| prompt | `prompt/<name>` | `prompts/<name>.md` |
| feature | `feature/<name>` | `<name>/` (top-level directory) |

A feature owns its top-level directory plus the shared repository surface it
legitimately edits: `package.json`, `package-lock.json`, `tsconfig.json`,
`biome.json`, `README.md`, test globs, docs, and prompts. Promotion replays
those edits like any other commit.

The tooling keeps no second slice registry. Worktree directory names must be
unique across kinds; a name collision between kinds is refused at add and sync
time.

## Synchronization

Run the reconciliation command from inside your worktree before slice work and
after `main` changes:

```bash
npm run worktrees:sync -- --current --source-only
```

This scoped command updates only the current slice from `main`. It neither
creates or rebases sibling worktrees nor reads or writes Pi settings. It fails
outside a recognised slice branch. Use it for ordinary isolated development,
especially when unrelated siblings have conflicts or the active routing must
stay unchanged. `--source-only` requires `--current`; `--current` also leaves
settings unchanged because a partial slice inventory cannot reconcile global
routing. The shared mutation lock still protects the selected rebase against
promotion or another mutation of `main`. It does not lock ordinary source edits,
focused tests, or agent work.

The unscoped `npm run worktrees:sync` reconciles the whole repository and Pi
routing. Reserve it for deliberate repository-wide reconciliation.

The command creates a missing worktree for each branch in the four namespaces.
It rebases a branch when `main` has advanced. A worktree that is behind `main`
and holds uncommitted tracked changes is deferred: the command leaves its branch
at its current commit and preserves those changes instead of attempting a
rebase. Deferred work belongs to the session that owns the worktree. Other
sessions leave those edits untouched and do not announce the deferral or treat
it as extra work. They still report failures that affect their assigned outcome.
Sync and hook runs print no deferral notice for other worktrees.
A non-hook sync run inside a deferred worktree prints one `Deferred:` line so the
owner commits before slice work. Untracked files alone do not trigger deferral;
Git refuses a rebase that would overwrite one. Synchronization updates source
and Pi routing; it does not install dependencies. Refresh dependencies
separately in each affected worktree after package changes.

All worktree commands acquire one exclusive `worktrees.lock` file in the shared
Git directory before inspecting or changing worktrees. This prevents concurrent
hooks and explicit commands from racing a rebase or Pi settings update. An
explicit command refuses contention with a nonzero exit; `promote --json`
reports `stage: "coordination"`. A hook reports skipped synchronization and
exits successfully without changing worktrees or settings. There is no retry
queue: run `npm run worktrees:sync` after the active command exits, or let the
next eligible hook reconcile the worktrees.

The lock contains the owner PID. Normal completion and exceptions release it.
An interrupted process can leave the lock behind; the command never reclaims an
existing lock automatically. Before manual recovery, inspect the owner process
and repository state. A PID alone does not prove that a lock is stale.

When a branch and `main` both changed a shared file (for example
`package.json` or the lockfile), the rebase conflicts. The command aborts the
rebase, leaves the branch at its pre-sync commit, and reports the failure. No
automatic resolution is attempted; resolve the conflict manually or promote the
feature first.

Install repository-local Git hooks for normal updates to `main`:

```bash
npm run worktrees:hooks
```

The installer replaces only hooks with its current ownership marker and refuses
other existing hooks.

The hooks run reconciliation after checkout, commit, merge, and rebase
operations on `main` and the four slice namespaces. Each hook resolves the main
checkout from Git at run time, so moving the repository does not strand it. Run
the command again after the reconciliation script itself moves. A deferred
worktree is rebased by the next hook or explicit sync run that finds no
uncommitted tracked changes in that worktree. A manual reset still requires the
explicit reconciliation command.

Inspect the invariant with:

```bash
npm run worktrees:status
```

Each row reports the kind, slice name, base state, worktree state, load state,
and path. `dirty` counts both tracked changes and untracked files; a worktree
with common history that is `behind` and holds uncommitted tracked changes is
deferred. Untracked files alone do not trigger deferral. Load state is `active`
or `provisional` for extensions; skills, prompts, and features report `branch`
because Pi loads them from `main` after promotion.

## Promotion

Promote finished slice work to `main` with one command:

```bash
npm run worktrees -- promote clipboard
npm run worktrees -- promote extension/clipboard
```

To promote completed parallel changes together, select all their slices in one
invocation:

```bash
npm run worktrees -- promote extension/clipboard skill/audit feature/scripts --dry-run --json
npm run worktrees -- promote extension/clipboard skill/audit feature/scripts
```

Select only completed work whose combined result is ready for publication. The
command processes slices in the order supplied. It does not discover a batch
from dirty worktrees or select every branch automatically. Duplicate references
to the same branch, including a bare name and its qualified spelling, are refused.

Both spellings work: slice names are unique across kinds, so a bare name resolves
to one branch, and `<kind>/<name>` names it outright. With no name, the command
infers one slice from the current worktree directory; it does not infer a batch.

The command refuses to start unless `main` is checked out in the main repository
and no tracked file there is modified. It also refuses when `origin/main` holds
commits that `main` lacks. A publishing invocation refuses preexisting local
`main` commits absent from `origin/main`, so selecting a slice does not publish
unrelated outgoing history. This rule applies to one slice and to a batch.

Every selected worktree must contain no tracked changes or nonignored untracked
files, including for a dry run. The main checkout and selected worktrees must
also contain no paused Git operation. The command checks every selection before
it changes any branch.

The command classifies every commit in each selected `main..<branch>` range:

- a commit touching only shipped paths is replayed onto `main`;
- a commit touching only development records stays on the branch;
- a commit touching both is replayed with the development records dropped.

Development records are `AGENTS.md`, `DESIGN.md`, `LOG.md`, `PLAN.md`,
`REWRITE-SPEC.md`, `SOLUTION.md`, and `*FINDINGS.md` directly under the slice's dev-record root.
The roots are `extensions/<name>/` and `skills/<name>/` for those kinds, and
`<name>/` for features. A prompt slice is a single file with no dev records;
every prompt commit ships. A batch filters development records from all selected
roots, including records present on another selected branch. Final branch rebuilds
restore each slice's own records from its original tip.

The reserved names bind every kind the same way: a slice cannot ship a file with
one of those names directly under its own root. A feature root is a top-level
directory, so name a feature after the directory it owns and keep shipped
documents under a subdirectory or a different filename.

A prompt branch reaches a byte-identical steady state: promotion holds nothing
back, so after a successful run the branch and `main` carry the same tree and
`worktrees:status` reports the slice as current and clean.

Before changing branches, the command saves the starting `main` commit and every
selected branch tip. For each slice after the first, it rebases that branch onto
the accumulated local `main` before replay. This composes nonconflicting changes
in shared files through Git's normal rebase behavior. A conflict stops the batch;
the command does not resolve conflicts automatically.

After each slice's replay, the command compares its complete tree with the
accumulated `main`. Only development records are exempt from this comparison;
files shipped by another selected slice are not ignored. The next slice starts
only after that comparison passes.

If every selected slice has no shipped changes, the command returns without
gates, push, or synchronization. Otherwise, once all selected changes form one
tree, the command runs `typecheck`, `check`, `lint`, and scoped tests once for
the combined result. Test selection uses the shipped diff between the starting
`main` and that combined tree. It includes every test matched by the `npm test`
globs in each changed directory: `extensions/<name>/`, `skills/<name>/`, or a
top-level feature directory such as `ui/`, `transport/`, `scripts/`, `prompts/`,
and `evals/`. It also includes tests in directories that consume those sources
through literal relative imports, including transitive consumers. The import
check uses the same parser as the slice isolation check.

Scoped tests run with `node --test` without repository-wide coverage thresholds.
`--full` runs `npm test` with its coverage thresholds instead. Dependency and
compiler-setting changes (`package.json`, `package-lock.json`, `tsconfig*.json`,
or `biome.json`) also select the full suite. Use the full suite when the operator
asks for it. Documentation-only changes select no tests; `SKILL.md` and prompt
bodies are behavior, not documentation for this purpose. The other gates still
run. Development-record-only changes still return without gates.

The command also runs an entrypoint load check for every selected extension and
the skill validator for every selected skill. Prompts and features have no
additional resource check.

The command then rebuilds every selected branch onto the final `main` with that
slice's original development records, verifies each full-tree boundary again,
and pushes once. One sibling synchronization follows. Each selected branch now
contains the combined shipped changes, not only its own changes.

The rebuild resets a branch, so it runs only on a branch that still holds what the promotion saw: the same
head and a clean worktree. The gates take minutes, and the owner may commit or edit meanwhile. If the branch moved or
its worktree changed, the command leaves that branch exactly as it is, names the reason in that slice's `left` field,
and prints `Left unchanged`. The promotion itself continues, because the promoted commits are already on `main`. The
next synchronization rebases a clean branch onto `main` and drops the commits that are now on `main`; a dirty branch
is deferred until its owner commits. Every reset in the command follows one rule: it resets only a state the promotion
produced. Before it rebases or replays a slice, the command checks that the branch still holds its preflight state; if
not, the promotion fails with stage `preflight` and rolls back what it made. A rollback after a failure resets a branch
only while its head and worktree status still match what the promotion left, including the state of a rebuild that
failed part way, and it aborts an unfinished batch rebase first, unless work was done on the paused rebase after it
stopped: a commit, a reset, a checkout, a staged or edited conflict resolution, or a new untracked file. It resets
`main` only while `HEAD` is on `main`, every commit between the starting `main` and its head is one the promotion
made, and the main checkout holds nothing else. Normally that means a clean checkout. When a cherry-pick replay
stopped part way, the checkout holds that
replay's staged changes and conflicted files, so the command accepts changes to the replayed paths and refuses any
other changed or untracked path, or a work-tree edit to a replayed path that is not in conflict. An edit to a path
still in conflict looks the same as the conflict. Otherwise it leaves the branch or `main` as it is, and the `recover`
text says how to inspect it. For `main`, the text says that `main` holds unpushed commits from the failed promotion.

Each replayed commit takes the whole index, so the command fails the promotion if the main checkout index holds staged
changes before the cherry-pick, or a path outside that commit after it. A branch that moves between its state check
and the read of its commit list also fails the promotion before any replay.

Each move of a branch ref (the batch rebase, the rebuild, the branch rollback, and the `main` rollback) uses
`git update-ref` with the expected old value, so a commit that lands after the check makes the move fail and keeps
the commit. The batch rebase runs on a detached `HEAD` at the checked head and moves the branch only at the end; if
the branch moved meanwhile, the promotion fails with stage `rebase` and the branch keeps its new commit.

Git cannot guard three steps the same way, and each window is the time between two consecutive Git calls.
`git rebase --abort` takes no expected `HEAD`, so work done on a paused rebase between the check and the abort is
discarded. A work-tree edit made between a check and the following `git reset --hard` is lost, because Git has no
compare-and-swap for the work tree. No single Git call moves a ref with an expected old value and also updates the
work tree, so each ref move is followed by `git reset --hard HEAD`. If the command is killed between the two, the
branch (or `main`) holds the new commit while its work tree and index still hold the old tree, which shows as changes
that undo the move. The work tree holds nothing else, so `git reset --hard` in that worktree finishes the move.

The batch rebase leaves the worktree detached from its first `git switch --detach` until the final `git switch` back
to the branch, and a kill in that span (after the detach, or between the branch `git update-ref` and the `git
switch`) leaves it detached. The branch itself is intact in both cases, and `git switch <branch>` in that worktree
reattaches it. While the worktree is detached, a commit made there lands on the detached `HEAD`, not on the branch,
so the expected-old-value check on the branch does not see it. If it lands before `git rebase` starts, or after the
rebase ends and before the command reads `HEAD`, the promotion carries it. If it lands while the rebase is paused, the
paused-rebase check below keeps it. If it lands after the branch ref moves, the final `git switch` leaves it behind. Git's own rebase detaches
`HEAD` the same way.

The check for work on a paused rebase compares the index, the work tree and the untracked file list with a snapshot
taken a few Git calls after the rebase stopped, so work done in that gap is not seen. The snapshot lists untracked files
but does not hash their contents, so a later edit to an untracked file is not seen. If the snapshot cannot be taken, the
check falls back to the `HEAD` log alone, which sees commits, resets and checkouts but not a staged or edited
resolution.

This removes repeated shared gate sets, pushes, and synchronization runs from
separate promotions. It does not cache gate results or measure elapsed-time
savings.

`PI_PROMOTE_GATES` replaces the repository gates the command runs before the
push: a JSON array of `{ "name": string, "command": string[] }` entries, each
executed in the repository root and required to exit 0. Unset, the command runs
the default shared gates and scoped tests (`scripts/worktrees.mts`). `--full`
changes only the default test gate; it does not alter an explicit override.
The entrypoint load check and skill validator remain separate resource gates.
`--no-gates` still skips both shared and resource gates entirely.

A rebase, replay, verification, gate, or promoted-branch rebuild failure before
push triggers rollback of `main` and every changed selected branch to their
starting commits. Check the report: `recover` names manual recovery when rollback
fails. The command aborts only Git operations that it started.

A failed push leaves the combined promotion committed locally and the selected
branches rebuilt. A repeated publishing invocation refuses those unpublished
`main` commits; it does not infer that a no-op slice authorizes their publication.
Inspect `origin/main..main` and its complete outgoing diff before using the
report's direct Git push recovery. After the push succeeds, run
`npm run worktrees:sync`.

| Flag | Effect |
| --- | --- |
| `--dry-run` | Report the plan without changing checkout or settings content; remote refs may refresh |
| `--json` | Emit one machine-readable report |
| `--no-push` | Promote and synchronize locally without a push |
| `--sync-selected` | Synchronise only selected slices after promotion; leave Pi settings and other worktrees unchanged |
| `--no-gates` | Skip shared and resource gates |
| `--full` | Run the complete `npm test` as the default test gate |

The JSON report carries `ok`. After composition, `changedDirectories` lists the
changed directory boundaries, `selectedTestFiles` lists the exact selected test
paths, and `fullTests` states whether the default test gate selects the full
suite. Overrides and `--no-gates` retain this selection record but control which
gates actually run. Dry runs do not compose a tree or select tests.
After successful preflight resolution, `slices`
contains one entry per selection, in input order, for both single and batch
invocations. Each entry carries `name`, `kind`, `branch`, `promoted`, `held`, and
`gates`; a dry run also carries its `wouldPromote` plan. A dry run shows the
original commit IDs. Rebase can rewrite the IDs reported by an actual replay.
The dry run does not rebase or replay, so its plan does not prove that the
selected changes compose without conflicts.

For a single selection, top-level `name` and `kind` identify the slice, and its
resource gate results also appear in top-level `gates`. For a batch, top-level
`gates` contains only shared gate results; each slice's `gates` contains its
resource results. Preflight failures need not contain a `slices` list when
resolution or validation did not finish.

Failures carry `stage`, `reason`, and `recover`, plus `failedSlice` when a
particular slice caused the failure. `recover` is `null` when no manual recovery
is needed. A rollback failure names the required recovery commands; a push
failure names publication and synchronization recovery.

After the push, the command synchronizes the sibling worktrees. A deferred
sibling appears only in the report's `deferred` list; deferral does not affect
`syncOk` or the exit code. A sibling rebase conflict or broken state does not
undo the promotion: the report keeps `ok` true, sets `syncOk` to false, lists the
failure in `branchFailures`, and the command exits nonzero. Resolve that
sibling, then run `npm run worktrees:sync`.

## Publication content review

Before a dry run or real promotion, the command checks each shipped commit's
complete message and changed text blobs. It rejects high-confidence private-key,
credential, absolute personal-home path, and retained-session envelope signatures.
The report names the commit, path, line, and rule, never the matched secret text.
This check is independent of gates: `--no-gates` does not disable it.

The check is deliberately not a semantic classifier. Binary blobs, ordinary
words such as "plan", and durable design documentation do not prove private
provenance. A different filename does not make task material publishable. Review
the complete outgoing files, source, comments, commit messages, and diff for
private context, task records, operator quotations, generated reports, and
non-durable chronology before publication. Existing repository content bans and
reserved development-record filtering remain binding.

The scanner permits at most 500 commits, 2,000 file revisions, 1,000,000 bytes
per blob, and 64 MiB of cumulative blob bytes. Each changed file revision counts
toward the cumulative bound, including repeated content. Subprocess output is
also bounded. Exceeding a bound stops promotion rather than claims coverage.
Split the promotion or obtain an explicit operator decision for the specific
blocked act; the runtime exposes no bypass. Binary content still needs
manual review. A passing signature scan is not proof of publishable content.
Do not commit evidence captures or a task-specific review report.

For a local-only release without unrelated sibling reconciliation:

```bash
npm run worktrees -- promote feature/example --no-push --sync-selected --json
```

The command still composes the selected changes and runs the normal gates once.
`--full`, dependency changes, compiler-setting changes, and an explicit operator
full-suite request keep their existing meaning. No automatic gate waiver or
cached acceptance attaches to scoped synchronisation.

## Entrypoint load checks

For extensions:

```bash
node scripts/extension-load-check.mts extensions/stash/index.ts
```

The check runs Pi's own extension loader and exits non-zero on any loader error
or when the loader is unavailable.
Do not use `pi --help --offline --extension <path>` as a load check: it exits 0
even when the extension factory throws.

For skills, promotion runs the skill validator:

```bash
node skills/harness/scripts/validate-skill.mts skills/<name>
```

## Pi configuration

The main harness package supplies shared skills and prompts. Its extension
resources are disabled in Pi settings. Each active extension appears as an explicit
package path to its worktree entrypoint.

This routing prevents Pi from loading an older extension copy from the main
checkout. A new Pi process reads the current worktree source. Use `/reload` after a
source edit in an existing Pi process.

Activate a provisional extension after approval:

```bash
npm run worktrees -- activate <name>
```

Return an extension to provisional state with:

```bash
npm run worktrees -- deactivate <name>
```

A provisional extension keeps its branch and worktree, but Pi does not load it
globally. Use an isolated explicit launch for temporary tests.

Skills and prompts enter Pi through the main checkout's `pi.skills` and
`pi.prompts` manifest after promotion; they have no per-worktree activation.
`activate` and `deactivate` refuse a skill, prompt, or feature slice with that
reason.

One limitation follows: while a skill or prompt slice is developed in its
worktree, Pi still loads the main checkout's copy. The worktree copy reaches Pi
after promotion. Read the worktree file directly to test a draft.

## New slices

Create the stable branch and persistent worktree with:

```bash
npm run worktrees -- add extension/stash
npm run worktrees -- add skill/research
npm run worktrees -- add prompt/drift
npm run worktrees -- add feature/audit
```

The kind is required: `add` cannot infer it from the name.

Add the slice source only in that worktree. Activate an extension entrypoint
only when the extension is ready for normal use.

## Local overrides

The command derives paths from the repository and Pi agent directory. These
environment variables override local locations when required:

- `PI_HARNESS_ROOT`
- `PI_WORKTREE_ROOT`
- `PI_AGENT_DIR`
- `PI_SETTINGS_PATH`
