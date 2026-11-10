# Extension removal

Use this procedure after the operator settles an extension's disposition.
Removal retires functionality. It deletes no stored data by implication.

## Fix the target

Use the canonical extension name from the operator's instruction. Do not replace
a named target with a similar extension inferred from context. If the name and
the discovered extension disagree, stop and report both.

## Remove

Work in the main checkout or your own worktree under the development workflow
(repository-root path `docs/conventions/worktrees.md`).

1. List what the extension owns and what refers to it. Apply the repository's
   output bounds to each command:

   ```bash
   git ls-files -- extensions/<name>
   git grep -n -F -e 'extensions/<name>' -e '<each tool and command name>' --
   ```

2. Inspect each reference; do not delete by pattern. Remove what the extension
   owns: its slice directory (`git rm -r extensions/<name>`), its rows in the
   convention documents, its entries in the architecture document and the
   repository README, skill and prompt text that directs agents to its tools or
   commands, and evaluation suites or fixtures that exist only for it. A
   reference that states a fact about another slice stays, reworded when it
   named the removed extension as a consumer.
3. Add no aliases, tombstones, fallback readers, migrations, or compatibility
   shims.
4. Run the checks the removal can break: `npm run check`, `npm run typecheck`,
   `npm run lint`, the script tests that consume every slice
   (`node --test scripts/settings-contract.test.mts scripts/extension-load-check.test.mts`),
   and the tests of the extension's direct consumers, including consumers whose
   files needed no edit.
5. Commit one coherent removal with the behavioural reason in its body.
6. Activate `main` under that workflow's "Activate" section. The new
   snapshot's load check covers every remaining entrypoint. The previous
   snapshot is the code restore point.

## What stays

- **Stored data.** The extension's stores, its section of the machine document,
  and its environment overrides stay in place. Name each location in the result.
  Deleting or migrating them needs the operator's instruction for that data.
- **Running sessions.** A Pi process started before the activation keeps the
  removed tools and commands until it ends. State that boundary in the result.
- **Other routes.** An extension that a machine loads through its own settings
  entry, outside the harness package, still loads until that entry is removed.
  Report such an entry; change it only when the instruction covers that machine's
  settings.

## Completion

Use [verification by claim](verification.md). Confirm these postconditions:

- the target-owned paths and references are absent from `main`;
- the selected checks pass, and the new snapshot loads every remaining
  entrypoint;
- documentation links that pointed into the removed slice resolve or are gone;
- the result names the retained data locations and the running-session
  boundary.
