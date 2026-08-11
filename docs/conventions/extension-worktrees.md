# Extension worktrees

Each extension uses a stable branch and a persistent Git worktree. The worktree
contains the current `main` branch plus changes for one extension.

## Layout

For an extension named `stash`:

- branch: `extension/stash`
- worktree: the sibling `harness.worktrees/stash` directory
- entrypoint: `extensions/stash/index.ts`

The repository derives extension identity from `extension/*` branches. It does not
keep a second extension registry.

## Synchronization

Run the reconciliation command before extension work and after `main` changes:

```bash
npm run worktrees:sync
```

The command creates a missing worktree for each `extension/*` branch. It rebases a
branch when `main` has advanced. It refuses to rebase a branch holding uncommitted
tracked changes because automatic conflict resolution could damage active work.
Untracked files never block a rebase; Git already refuses a rebase that would
overwrite one.

Install repository-local Git hooks for normal updates to `main`:

```bash
npm run worktrees:hooks
```

The hooks run reconciliation after checkout, commit, merge, and rebase operations
on `main` and `extension/*` branches. A dirty divergent worktree waits until its next
clean branch event. A manual reset still requires the explicit reconciliation
command.

Inspect the invariant with:

```bash
npm run worktrees:status
```

Each row reports the extension name, base state, worktree state, load state, and
path.

## Promotion

Promote finished extension work to `main` with one command:

```bash
npm run worktrees -- promote clipboard
```

Run it from a worktree and the extension name is inferred from the directory.

The command refuses to start unless `main` is checked out in the main repository,
no tracked file there is modified, and `origin/main` holds nothing that `main`
lacks. It then classifies every commit in `main..extension/<name>`:

- a commit touching only shipped paths is replayed onto `main`;
- a commit touching only development records stays on the branch;
- a commit touching both is replayed with the development records dropped.

Development records are `AGENTS.md`, `LOG.md`, `PLAN.md`, `REWRITE-SPEC.md`,
`SOLUTION.md`, and `*FINDINGS.md` under `extensions/<name>/`. They never reach
`main` under any option.

After replaying, the command synchronizes every worktree, confirms that nothing
but development records separates the branch from `main`, runs the repository
gates plus an entrypoint load check, and pushes.

Any failure before the push restores `main` to the commit it started from and
leaves no cherry-pick in progress, so a repeated run is always safe. A failed
push leaves the promotion committed locally; running the command again pushes it.

| Flag | Effect |
| --- | --- |
| `--dry-run` | Report the plan and change nothing |
| `--json` | Emit one machine-readable report |
| `--no-push` | Promote locally and stop |
| `--no-gates` | Skip the repository gates |

The JSON report always carries `ok`, and on failure carries `stage`, `reason`,
and `recover`. `recover` is `null` when the command already restored the
repository itself.

## Entrypoint load checks

```bash
node scripts/extension-load-check.mjs extensions/stash/index.ts
```

The check runs Pi's own extension loader and exits non-zero on any loader error.
Do not use `pi --help --offline --extension <path>` as a load check: it exits 0
even when the extension factory throws.

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

## New extensions

Create the stable branch and persistent worktree with:

```bash
npm run worktrees -- add <name>
```

Add the extension source only in that worktree. Activate its entrypoint only when
the extension is ready for normal use.

## Local overrides

The command derives paths from the repository and Pi agent directory. These
environment variables override local locations when required:

- `PI_HARNESS_ROOT`
- `PI_EXTENSION_WORKTREE_ROOT`
- `PI_AGENT_DIR`
- `PI_SETTINGS_PATH`
