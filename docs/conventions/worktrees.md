# Development workflow

The normal path is: implement, verify what the change can break, commit to
`main`.

```bash
# in the main checkout, or in a branch worktree you created for isolation
node --test <changed and consumer test files>
git commit
```

`main` is the only source and the only published branch. Keep it fit to
activate: land coherent states only. Three further acts are separate from the
commit and from each other:

- A [trial](#trial) runs a candidate checkout in one Pi process.
- [Activation](#activate) makes a commit of `main` the code that new Pi
  processes load.
- [Publication](#publication-content-review) pushes `main` to its remote when
  the operator's current direction permits a push.

A change is complete when it is accepted, on `main`, and active where the
outcome needs running code. Report publication as its own state. There is no
promotion command, no gate selection, and no sibling reconciliation.
Independent work does not wait for another session; the
[shared acts](#shared-acts) name the only points that need a look at other
work.

## Branches and worktrees

Work on `main` directly for ordinary changes. Create a branch and a worktree
with plain Git when the change is larger or when other work is in progress in
the main checkout:

```bash
git worktree add ../harness.worktrees/<name> -b <name> main
git -C ../harness.worktrees/<name> rebase main      # when main advances
git merge --ff-only <name>                           # from the main checkout, when done
```

Land with a path-scoped commit or a fast-forward merge. The main checkout stays
on `main`; another session's uncommitted files there are not yours to stage,
stash, or revert. After a rebase that merged cleanly with someone else's change
to the same slice, run the tests of the files both changed and of their direct
consumers.

A branch belongs to the session that created it. Do not rebase, reset, or
delete another session's branch or worktree, and do not touch its uncommitted
changes. Remove your own worktree and delete your own branch when the work has
landed (`git worktree remove <path>`, `git branch -d <name>`).

Landed code has no session owner. Any session may repair a failing check on
`main`, in its own commit; do not leave a failure in place because another
session wrote the code. The session that landed a break owes its repair. A
session that meets an unrelated failure it will not repair reports it once, with
the failing check, the limits of its evidence, and the introducing commit when
that is already known. It does not prove the same failure again at each later
check.

Keep working notes, plans, and task records outside the repository, in the
working directory that the machine instructions name. Nothing filters them out
of a push.

## Checks

- `npm test` runs every `*.test.mts` file matched by the inventory in
  `package.json` with bounded concurrency; `npm run check` fails when a tracked
  test file is outside that inventory. `npm run test:coverage` adds Node's
  coverage report for diagnosis.
- `npm run check` also verifies slice isolation, settings declarations, and the
  pillar inventory.
- `npm run typecheck`, `npm run lint`.
- `node scripts/select-tests.mts <repository-relative-path> [...]` or
  `node scripts/select-tests.mts --range <revision-range>` prints sorted test
  paths from current tracked and non-ignored source: same-directory tests and
  literal relative-import consumers, directly or through one intermediate
  import/re-export; it never runs tests and does not infer text-only
  dependencies, loader URLs, aliases, deeper chains, historical imports, or
  nested-directory neighbours. The settings and registration checks below still
  apply.
- `node scripts/extension-load-check.mts extensions/<name>/index.ts` loads the
  requested entrypoints through Pi's public discovery API in isolated cwd and
  agent directories. It fails on a reported load error or an entrypoint Pi did
  not resolve. `pi --help --offline --extension <path>` exits 0 even when the
  factory throws, so it is not a load check.
- `node skills/harness/scripts/validate-skill.mts skills/<name>`.

Select the checks the change can break. Two repository tests consume every
slice: a change to an extension's settings declaration also runs
`npm run check` and `node --test scripts/settings-contract.test.mts`; a change
to an extension's registration or a tool schema also runs
`node --test scripts/extension-load-check.test.mts` and the load check of that
entrypoint. Broad changes (dependencies, compiler or lint configuration, shared
helpers, the test runner) run the full suite once, as a background job.

Reuse a result while its commit, lockfile, and execution conditions still
apply. A new session, a new commit elsewhere, or a later act is not by itself a
reason to repeat a check.

## Trial

Start one Pi process on the candidate checkout. Nothing in Pi settings changes
and no snapshot is needed:

```bash
pi -ne -ns -np -e <checkout> [-e builtin:<name>]
```

The three switches keep the configured extensions, skills, and prompt templates
out, so the process loads the candidate's package and nothing else of the
harness. Add a built-in extension by name when the trial needs it.

Choose the state by what the exercised paths can reach, not by which files
changed; startup hooks and tool logic can reach writers too. Resolve each store
path from the machine document and from the environment overrides in force.
Use the live stores only where the paths the trial exercises leave them intact.
Otherwise give the process its own state: point `PI_CODING_AGENT_DIR` and every
store override in force at copies.

Trials need no completed README or expanded test suite; necessary safety checks
and the harness skill's authority boundaries still apply. For behaviour a person
will judge by use, the trial comes before test expansion; see
[verification by claim](../../skills/harness/references/verification.md).

## Activate

The session that needs `main` live activates it. It asks no other session and
waits for none, apart from the [shared acts](#shared-acts).

1. **Snapshot.** `git worktree add --detach ../harness.releases/<name> main`,
   then `npm ci` there. Name the directory after the commit.
2. **Check.** Select checks by what the range from the active commit can break
   and by which results still apply. Activation alone is not a reason to repeat
   a check.
   - Run `node scripts/extension-load-check.mts extensions/*/index.ts` in the
     snapshot. Its installed dependencies are an execution basis that no
     earlier result covers.
   - Reuse `npm run check`, typecheck, lint, focused-test, and full-suite
     results that exist for the same commit, lockfile, and relevant execution
     conditions. Another session's result counts on the same terms.
   - Where those conditions are unknown, or no landing covered an interaction
     (two efforts in one slice, the consumers of a shared module or helper),
     check that interaction.
   - Run the full suite once when the range changes something whose reach
     focused checks do not bound and no applicable full-suite result exists.
   - Judge a failure against its contract. A pass on rerun stays unexplained
     until a cause is identified.
3. **Settle old and new.** When the range changes a host operation identity, a
   stored format, or a contract with the Pi host or Durable runtime, do this
   before the switch:
   - Find the processes and hosts that run from older snapshots. Keep the
     change compatible with them, or let their owners finish or restart at a
     boundary they accept. A version refusal between old and new is a backstop,
     not a transition.
     [Storage host retirement](../pi-durable-harness.md#storage-host-retirement)
     owns the host rules.
   - The repository checks run under the checkout's installed Pi packages.
     Where they cannot reach the changed contract, run a [trial](#trial) from
     the snapshot under the installed Pi on isolated state.
   - Copy the affected store.
4. **Switch.**
   `node scripts/activate.mts --expect ../harness.releases/<active> ../harness.releases/<name>`
   replaces the harness package entry in Pi's global settings in one read,
   check, and write under Pi's own settings lock. Every other setting stays
   byte-equal. The script refuses unless the entry still names the snapshot
   you expected and the new commit descends from it, so a concurrent
   activation is never silently reversed. After a refusal, read the entry
   again and decide from the new state.
5. **Confirm.** Start a fresh Pi process on the configured route and exercise
   the changed behaviour. This step checks the configured route under the
   running Pi.

A Pi process started before the switch, and every host it started, keeps the
code it loaded until it ends. A snapshot stays on disk while any process or
host runs from it.

### Recover

A failed check before the switch changes nothing. After a fault,
`node scripts/activate.mts --rollback --expect <current> <earlier>` selects an
earlier snapshot: it keeps the expected-entry check and drops the descent
check. Start a fresh process afterwards.

If the new code wrote to a store, stop the processes that write it, then keep
or explicitly dispose of the valid writes made since the copy, before any
restoration. A backup alone does not protect later work.

## Pi configuration

Pi settings hold one local package entry for the active snapshot directory.
That entry loads the snapshot's extensions, skills, and prompt templates from
its manifest, so the resources of one commit become active together, and
adding or removing an extension needs no settings edit. A branch's changes
reach Pi through a [trial](#trial), or after they land and are
[activated](#activate). A running process keeps the code it loaded;
[storage host retirement](../pi-durable-harness.md#storage-host-retirement)
states what a reload refreshes.

Two paths can be live from the main working tree instead: the global rules
file, when the machine links it to `config/pi/agent/AGENTS.md`, and the Pillars
corpus, when the machine document points `pillars.corpus` at `pillars/`. Every
new session, and every existing session that reads the corpus, sees those files
as they are on disk. A merge writes files one at a time, so a change to those
paths keeps every intermediate state safe for all affected consumers.
Otherwise, arrange a publication boundary with those consumers before the
merge.

## Shared acts

Independent work needs no claim, status read, or contact. Look at other work
before these acts only:

- **The switch.** Read `git log <active>..<new>` to know what else becomes
  active with your change. The lock and the expected-entry check protect the
  write.
- **A host-operation, stored-format, or host-contract change.** Follow step 3
  of [Activate](#activate).
- **Removing worktrees, branches, or snapshots you did not create.** Check
  that their work is on `main` and that no process or open effort uses them.
  Age alone is not a reason.

A session that needs a quiet machine, for example for a timing measurement,
declares it; a session that sees the declaration holds its own full suite
until it clears. Within one effort that has several workers, one session
integrates that effort's branches; that role is local to the effort.
[Agent delivery](../agent-delivery.md#coordinate-with-related-efforts) owns the
tools for claims and contact.

## Publication content review

Push `main` with `git push origin main` when the operator's current direction
permits publication. A push can carry many commits, and no other act waits for
it.

The pre-push hook refuses recognised credentials, private keys, personal home
paths, and retained session envelope openings. Envelope signatures include
request context, request routes, effort records, and agent preferences, with
or without attributes. A signature scan is not a semantic privacy review.
Install it in the effective hook directory for the selected worktree:

```bash
npm run hooks
```

The hook runs `scripts/publication-scan.mts` over every commit the push sends.
It names the commit, path, line, and rule, never the matched text. It is not a
semantic classifier: review the outgoing diff for private context, task
records, operator quotations, and generated reports before pushing. The
installer asks Git for the effective `pre-push` path, including `core.hooksPath`
and worktree configuration, and reports that path. Relative hook paths resolve
from the worktree root. The installer replaces only a hook that carries its own
marker; it refuses an unmanaged shared hook. Repeat installation when the
effective hook location changes. Scan a range by hand with
`node scripts/publication-scan.mts origin/main..HEAD`.
