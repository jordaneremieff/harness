# Development workflow

The normal path is: implement, verify what matters, commit, push.

```bash
# in the main checkout, or in a branch worktree you created for isolation
node --test <changed and consumer test files>
git commit
git push origin main
```

There is no promotion command, no gate selection, no sibling reconciliation,
and no activation ceremony. `main` is the only published branch.

## Branches and worktrees

Work on `main` directly for ordinary changes. Create a branch and a worktree
with plain Git when you need isolation from concurrent work in the same
repository:

```bash
git worktree add ../harness.worktrees/<name> -b <name> main
git -C ../harness.worktrees/<name> rebase main      # when main advances
git merge --ff-only <name>                           # from the main checkout, when done
git push origin main
```

A branch belongs to the session that created it. Do not rebase, reset, or
delete another session's branch or worktree, and do not touch its uncommitted
changes. Remove your own worktree when its work has landed
(`git worktree remove <path>`).

Keep working notes, plans, and task records outside the repository
(`~/Workspace/dump` on this machine). Nothing filters them out of a push.

## Publication content review

The pre-push hook refuses commits that carry a credential, private key,
absolute personal home path, or retained session envelope signature. Install
it once per clone:

```bash
npm run hooks
```

The hook runs `scripts/publication-scan.mts` over every commit the push sends.
It names the commit, path, line, and rule, never the matched text. It is not a
semantic classifier: review the outgoing diff for private context, task
records, operator quotations, and generated reports before pushing. The
installer replaces only a hook that carries its own marker. Scan a range by
hand with `node scripts/publication-scan.mts origin/main..HEAD`.

## Checks

- `npm test` runs every `*.test.mts` file matched by the inventory in
  `package.json` with bounded concurrency; `npm run check` fails when a tracked
  test file is outside that inventory. `npm run test:coverage` adds Node's
  coverage report for diagnosis.
- `npm run check` also verifies slice isolation, settings declarations, and the
  pillar inventory.
- `npm run typecheck`, `npm run lint`.
- `node scripts/extension-load-check.mts extensions/<name>/index.ts` runs Pi's
  own loader; `pi --help --offline --extension <path>` exits 0 even when the
  factory throws, so it is not a load check.
- `node skills/harness/scripts/validate-skill.mts skills/<name>`.

Select the checks the change can break. Broad changes (dependencies,
compiler or lint configuration, shared helpers, the test runner) run the full
suite once.

## Pi configuration

Pi loads this package from the main checkout for skills and prompts. Extensions
are routed explicitly in Pi settings as package entries; an entry can point at
the main checkout or at any worktree's `extensions/<name>/index.ts`. Edit the
settings file to change routing; use `/reload` in a running Pi process after a
source edit. A branch worktree's extension reaches Pi only through such an
entry; a branch's skills and prompts reach Pi after they land on `main`.
