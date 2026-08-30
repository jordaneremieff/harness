# Managed extension removal

Use this procedure after the operator settles an extension disposition. It
produces one exact plan, uses current repository primitives, and removes no
external data by implication.

## Produce the plan

Use the canonical extension name from the operator's instruction. Do not replace
a named target with a similar extension inferred from context. If the name and
the discovered extension disagree, stop and report both.

Resolve the repository root first. Use every Git command with `git -C <repo>`
and every package command with `npm --prefix <repo>`. Do not depend on the
caller's current directory.

Use read-only Git commands for the plan. Do not run `worktrees:status`,
`worktrees:sync`, `activate`, or `deactivate` because those commands can change
worktrees or Pi settings.

Start with these reads. Apply the repository's required record or byte bound to
each producing command. Stop when a bound prevents an exact plan.

```bash
git -C <repo> status --short --branch
git -C <repo> status --short --untracked-files=all -- extensions/<name>
git -C <repo> ls-files -- extensions/<name>
git -C <repo> grep -n -F -e 'extensions/<name>/' --
git -C <repo> worktree list --porcelain
git -C <repo> for-each-ref --format='%(refname:short)' refs/heads/extension/
git -C <repo> log --oneline main..extension/<name>
```

Inspect `package.json`, current documentation, status-key rows,
extension-configuration rows, and architecture references for target-owned
integration. Verify that each local `extension/*` branch already has its
registered worktree. Inspect Pi settings without changing them. Require the
package list to match the canonical routing from
`docs/conventions/extension-worktrees.md`: the main package has extensions
disabled, and each active extension uses its exact worktree entrypoint. Require
the target local branch and its registered worktree. Stop when an invariant
fails.

Represent the plan as one JSON object with this shape and exact values:

```json
{
  "kind": "extension",
  "name": "<name>",
  "repository": "<repo>",
  "sourceOnMain": true,
  "mainChangeRequired": true,
  "ownedPaths": [],
  "trackedFiles": [],
  "registrationEdits": [],
  "otherReferences": [],
  "mainState": { "branch": "main", "clean": true },
  "worktree": { "path": "<path>", "clean": true, "registered": true },
  "settings": { "path": "<path>", "activeEntrypoint": "<path-or-null>" },
  "localBranch": "extension/<name>",
  "branchOnlyCommits": [],
  "reason": "<current behavioral deficiency>",
  "applyAuthorized": false,
  "pushMain": false,
  "deleteRemoteBranch": false,
  "focusedChecks": [],
  "repositoryGates": ["lint", "typecheck", "check", "test"],
  "excluded": ["user data", "session records", "remote branches", "unrelated worktrees"]
}
```

Set `applyAuthorized` only when the current operator instruction explicitly
authorizes removal of this exact extension. If it is false, deliver the plan and
stop. Set `pushMain` only when the operator explicitly authorizes a push. Remote
branch deletion requires separate explicit authority and is not part of this
procedure.

If `pushMain` is true, fetch `origin/main` during preflight and compare
`main...origin/main`. Stop when the remote branch contains commits absent from
local `main`. Without push authority, do not contact or change the remote.

## Build and verify the candidate

Require a clean tracked state in the main checkout. Stop if an untracked file
exists under the target path in the main checkout. Require a clean target
worktree, including no untracked files. Report unrelated dirty worktrees, but do
not force or change them.

When `mainChangeRequired` is true:

1. If `sourceOnMain` is true, remove `extensions/<name>/` with Git, not an
   operating-system recursive deletion.
2. Remove the exact `warmup:jiti` extension pair from `package.json`.
3. Remove status-key rows whose Publisher is `extensions/<name>`.
4. Remove extension-configuration rows whose Extension is `<name>`.
5. Remove other current target-owned references and documentation.
6. Add no aliases, tombstones, fallback readers, migrations, or compatibility
   shims.
7. Inspect the complete candidate diff before gates.

Use the candidate index to confirm the target paths and registrations are
absent. Enumerate every remaining tracked `extensions/*/index.ts` entrypoint and
run this focused check separately for each one:

```bash
node <repo>/scripts/extension-load-check.mts <repo>/<remaining-entrypoint>
```

The loader check is the focused load evidence. Treat a skipped loader check as a
blocker, not a pass. `warmup:jiti` remains a package smoke check, but it does not
prove that extension factories loaded successfully.

Run the remaining-extension warmup, then the repository gates from the main
candidate checkout:

```bash
npm --prefix <repo> run warmup:jiti
npm --prefix <repo> run lint
npm --prefix <repo> run typecheck
npm --prefix <repo> run check
npm --prefix <repo> test
```

When `mainChangeRequired` is false, do not create an empty main commit and do
not push `main`. Run the applicable focused checks and repository gates, then
proceed to local retirement. Report that `main` is unchanged.

## Commit and retire

When `mainChangeRequired` is true, commit one coherent removal with the
behavioral reason in its body. Disable the managed synchronization hook for this
commit because the target branch must remain intact until the destination
succeeds:

```bash
git -C <repo> -c core.hooksPath=/dev/null commit <planned-message-options>
```

Push `main` without force only when `pushMain` is true. If the push fails, keep
the target active and keep its worktree and branch. Report the exact non-force
retry command and stop.

After the local destination succeeds, or after an authorized push succeeds:

1. Run `npm --prefix <repo> run worktrees -- deactivate <name>`.
2. Verify that this removed only the exact target entry from Pi settings.
3. Run `git -C <repo> worktree remove <exact-target-worktree>` without force.
4. Run `git -C <repo> branch -D extension/<name>`.
5. Run `npm --prefix <repo> run worktrees:sync` for the remaining branches.
6. Run the focused loader check with each remaining absolute worktree entrypoint.

The preflight worktree and settings invariants prevent `deactivate` from creating
missing worktrees or normalizing unrelated settings. If a dirty sibling blocks
the final sync, do not force or change that worktree. Report the exact failure.
Never delete a remote extension branch without separate explicit authority.

## Failure and completion

Before commit, restore only the paths in the plan. Do not use a repository-wide
hard reset. Pi settings and the target branch remain unchanged during candidate
checks, so a failed gate needs no activation or branch compensation.

After the destination succeeds, keep the committed removal visible if local
retirement fails. Report the failed standard command and the remaining state.

Extension removal does not authorize deletion or migration of extension stores,
stash artifacts, clipboard archives, session records, memory, credentials,
untracked files, or other user data.

Use [verification by claim](verification.md). Confirm these postconditions:

- the target-owned paths and current registrations are absent;
- tracked target-reference scans return no unintended live reference;
- every remaining main and worktree entrypoint passes the focused loader check;
- required documentation links resolve;
- focused checks and normal repository gates pass;
- unrelated dirty worktrees and excluded data remain unchanged;
- `main` equals `origin/main` after an authorized push;
- the remote extension branch remains unless separately authorized; and
- final Git status reports every remaining modified or untracked file.
