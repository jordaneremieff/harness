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
clean branch when `main` has advanced. It refuses to rebase a dirty branch because
automatic conflict resolution could damage active work.

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
