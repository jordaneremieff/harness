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

Run the reconciliation command before slice work and after `main` changes:

```bash
npm run worktrees:sync
```

The command creates a missing worktree for each branch in the four namespaces.
It rebases a branch when `main` has advanced. It refuses to rebase a branch
holding uncommitted tracked changes because automatic conflict resolution could
damage active work. Untracked files never block a rebase; Git already refuses a
rebase that would overwrite one.

When a branch and `main` both changed a shared file (for example
`package.json` or the lockfile), the rebase conflicts. The command aborts the
rebase, leaves the branch at its pre-sync commit, and reports the failure. No
automatic resolution is attempted; resolve the conflict manually or promote the
feature first.

Install repository-local Git hooks for normal updates to `main`:

```bash
npm run worktrees:hooks
```

The hooks run reconciliation after checkout, commit, merge, and rebase
operations on `main` and the four slice namespaces. Each hook resolves the main
checkout from Git at run time, so moving the repository does not strand it. Run
the command again after the reconciliation script itself moves. A dirty divergent worktree
waits until its next clean branch event. A manual reset still requires the
explicit reconciliation command.

Inspect the invariant with:

```bash
npm run worktrees:status
```

Each row reports the kind, slice name, base state, worktree state, load state,
and path. Load state is `active` or `provisional` for extensions; skills,
prompts, and features report `branch` because Pi loads them from `main` after
promotion.

## Promotion

Promote finished slice work to `main` with one command:

```bash
npm run worktrees -- promote clipboard
npm run worktrees -- promote extension/clipboard
```

Both spellings work: slice names are unique across kinds, so a bare name resolves
to one branch, and `<kind>/<name>` names it outright. Run the command from a
worktree and the slice name is inferred from the directory.

The command refuses to start unless `main` is checked out in the main repository,
no tracked file there is modified, and `origin/main` holds nothing that `main`
lacks. It then classifies every commit in `main..<branch>`:

- a commit touching only shipped paths is replayed onto `main`;
- a commit touching only development records stays on the branch;
- a commit touching both is replayed with the development records dropped.

Development records are `AGENTS.md`, `LOG.md`, `PLAN.md`, `REWRITE-SPEC.md`,
`SOLUTION.md`, and `*FINDINGS.md` directly under the slice's dev-record root.
The roots are `extensions/<name>/` and `skills/<name>/` for those kinds, and
`<name>/` for features. A prompt slice is a single file with no dev records;
every prompt commit ships.

The reserved names bind every kind the same way: a slice cannot ship a file with
one of those names directly under its own root. A feature root is a top-level
directory, so name a feature after the directory it owns and keep shipped
documents under a subdirectory or a different filename.

A prompt branch reaches a byte-identical steady state: promotion holds nothing
back, so after a successful run the branch and `main` carry the same tree and
`worktrees:status` reports the slice as current and clean.

After replaying, the command synchronizes every worktree, confirms that nothing
but development records separates the branch from `main`, runs the repository
gates, and pushes. The gates are `test`, `typecheck`, `check`, and `lint` for
every kind. Extension promotion additionally runs the entrypoint load check;
skill promotion additionally runs the skill validator.

When a feature's replayed commits conflict with `main`'s shared files, the
command aborts at the cherry-pick stage, restores `main` exactly, and reports;
a repeated run is always safe.

`PI_PROMOTE_GATES` replaces the repository gates the command runs before the
push: a JSON array of `{ "name": string, "command": string[] }` entries, each
executed in the repository root and required to exit 0. Unset, the command runs
the default gates (`scripts/worktrees.mts`). `--no-gates` still skips them
entirely.

Any failure before the push restores `main` to the commit it started from and
leaves no cherry-pick in progress, so a repeated run is always safe. A failed
push leaves the promotion committed locally; running the command again pushes it.

| Flag | Effect |
| --- | --- |
| `--dry-run` | Report the plan and change nothing |
| `--json` | Emit one machine-readable report |
| `--no-push` | Promote locally and stop |
| `--no-gates` | Skip the repository gates |

The JSON report always carries `ok`, `name`, and `kind`, and on failure carries
`stage`, `reason`, and `recover`. `recover` is `null` when the command already
restored the repository itself.

After the push, the command synchronizes the sibling worktrees. A sibling that
cannot rebase does not undo the promotion: the report keeps `ok` true, sets
`syncOk` to false, lists the failures in `branchFailures`, and the command exits
nonzero. Resolve the sibling, then run `npm run worktrees:sync`.

## Entrypoint load checks

For extensions:

```bash
node scripts/extension-load-check.mts extensions/stash/index.ts
```

The check runs Pi's own extension loader and exits non-zero on any loader error.
Do not use `pi --help --offline --extension <path>` as a load check: it exits 0
even when the extension factory throws.

For skills, promotion runs the skill validator:

```bash
node skills/harness/scripts/validate-skill.mts skills/<name>
```

## Pi configuration

The main harness package supplies shared skills, prompts, and themes. Its extension
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
npm run worktrees -- add skill/memory
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
