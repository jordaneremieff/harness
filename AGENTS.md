# Repository instructions

- Use earlier harness generations only as evidence of needs and failure modes.
  Never carry forward their source, comments, tests, prompts, names, or identifiers.
- No source, comments, tests, names, prompts, or internal identifiers from any
  earlier harness generation (local snapshot, extraction, or reviews) may be
  copied into this repository.
- Requirements are written neutrally from current public Pi documentation and
  shipped examples, plus observed operator needs.
- No company doctrine, service names, internal hosts, model rosters, credentials,
  or operator-local absolute paths. Per-extension configuration uses one section
  of the machine document `<agentDir>/harness.json` and per-field `PI_*`
  environment overrides, each documented in its extension README. Each extension
  reads its own section with its own code. See
  `docs/conventions/extension-config.md`.
- Report to the operator only in adapted ASD-STE100 Simplified Technical English (STE).
  Apply STE to every operator-facing chat message: status updates, summaries, error
  reports, findings, questions, and recommendations. The register governs chat
  messages only. Repository prose, documentation, and skill deliverables stay
  outside it. Skill deliverables include the troll skill's redirect artifact and
  its chat confirmation, which are verdict-last natural prose by design. Code,
  commands, paths, file contents, and commit messages stay in their normal form
  unless the operator asks for STE there.

  Select chat content for the reader's current task. Lead with the actual result,
  state, or needed decision. Explain what it means for the reader when that is
  not clear. Address the reader as "you". Use plain words or explain necessary
  project terms. Select detail that helps the reader understand, review, or act;
  do not turn internal work records into the default reply. Include paths,
  references, identifiers, inventories, and check totals only when requested or
  needed for a claim, review, or action. Retain required verification and
  citations, material limits, and blocked decisions.

  Use formatting that clarifies the content. Do not impose mandatory headings,
  a fixed report template, or a fixed reply length. As an exception, status
  reports on delegated work follow "Operator status reports" in
  `skills/delegate/SKILL.md`. Expand when clarity needs explanation. Honor
  requested depth and form for audits, explanations, raw or exact output, and
  structured formats. Preserve the skill-deliverable exception
  above. Keep interim notices brief: state a genuine wait or blocker and the
  relevant next action. Continue authorized execution; an interim notice does
  not replace work or its terminal result.

  STE writing rules:

  1. Maximum 20 words per instruction, 25 per description.
  2. One topic per sentence. Active voice with a named actor.
  3. Imperative mood for instructions. Approved verb forms only: infinitive,
     imperative, simple present, simple past, simple future, past participle as
     adjective. No "-ing" verb forms. No perfect tenses.
  4. No modal verbs: can, could, may, might, shall, should, would.
  5. One meaning per word. Choose one word for one thing; do not rotate synonyms.
  6. Keep all sentence parts: subject, verb, articles. No telegraphic style.
  7. Conditions before commands: "If the gate fails, stop the release."
  8. Maximum three nouns in a cluster. Use prepositions for longer names.
  9. Lists for two or more steps, options, or findings. Vertical layout.
  10. Australian spelling (Macquarie Dictionary): "colour", "analyse".
  11. First sentence: the result, the state, or the question.
  12. Plainest common word: "use" not "utilize", "start" not "commence".

  This is an adapted reporting register based on ASD-STE100 Issue 9 (January 2025).
  It does not reproduce the specification or its dictionary. Do not claim certified
  STE compliance.
- Give each review finding one disposition: fixed, shown false with the source
  named, or blocked with the unavailable layer named. An investigation that the
  operator scoped to recommendations records a confirmed finding as
  "confirmed, correction specified, not implemented"; it never reports a
  recommendation as fixed. Implementation work still owes the fixed, shown
  false, or blocked disposition for every finding it adopts.
- Verify claims about Pi or pi-tui behavior against the installed package sources
  before acting on them, including claims from reviewers and delegated agents.
- Upstream Pi rebuilds its agent core as a durable harness ("AgentHarness", also
  "harness v2"). `docs/pi-durable-harness.md` tracks that program and what this
  repository does when each piece arrives. Read it before a version-sensitive or
  surface-selection decision. Refresh it with read-only checks after each Pi
  upgrade and after each review of the program, and keep every verification date
  current. A stale entry is not evidence.
- Durable source is independent of the session that produced it. Comments, test
  headings, names, and durable documentation describe behaviour, invariants,
  external contracts, security constraints, or non-obvious rationale. They must not
  refer to prompt items, workstreams, review rounds, correction passes, current
  implementation phases, agent or model identities, or temporary task chronology.
  Temporary planning belongs in the session or a stash. Delete comments that
  merely narrate the code (Cognitive Stratification, Intrinsic Organization).
- Work on `main` directly, or on a short-lived branch or worktree when you need
  isolation from concurrent work. When done: run the checks that matter for the
  change and commit to `main`. Trial, activation, and publication are separate
  acts; `docs/conventions/worktrees.md` owns them. Push only when the operator's
  current direction permits publication. Never rewrite or discard another
  session's uncommitted work.
- Landed code has no session owner. Any session may repair a failing check on
  `main`, in its own commit. The session that landed a break owes its repair.
- Each extension is an independent vertical slice with structural, semantic, state,
  and presentation boundaries. An extension must not import a sibling, parse
  sibling-formatted output, reproduce sibling-owned types or lifecycle states,
  hardcode sibling evidence markers or tool sets, depend on sibling mutable state,
  or establish an undocumented sibling protocol. Cross-extension behaviour uses
  public Pi surfaces or an explicit package-level contract owned outside either
  extension and justified by current consumers. Tests for one extension must not
  assert another extension's private implementation or display format. Generic Pi
  event analysis must not recognise one sibling extension's private vocabulary. Do not create a shared abstraction solely to remove small
  duplication. Keep retained tests colocated as `*.test.mts`; each extension has its own README.
  Keep operator-local paths and credentials out of committed content. `scripts/check-slices.mts` checks
  literal import specifiers for slice escapes and sibling paths. Review still
  enforces semantic isolation, including sibling-specific vocabulary, shared
  mutable state, and undocumented private protocols.
- Complete each task in the current pass; do not defer parts of it to a later
  pass. A defect in the unchanged baseline is a separate task unless the change
  worsens or depends on it.

## Authority

Apply the Intent authority rule in the universal `AGENTS.md` to the approval
requirements in this repository. For `/evo`, apply the elevated grant and
reserved decisions in `extensions/evo/README.md`.

## Scope and dependencies

- Add an extra format, compatibility branch, or fallback only for a concrete
  current requirement, and name that requirement when you add the mechanism.
  An existing capability, symmetry with another surface, a possible future use,
  and speculative tolerance are not requirements. Reviewers challenge
  unnecessary scope before implementation polish.
- Add or install a new direct runtime dependency only after explicit operator
  approval, before you add its declaration or its runtime use. Judge newness
  against the state before the change: a package is new when the change adds it
  to `dependencies`, `peerDependencies`, or `optionalDependencies`, or when the
  change makes shipped code use it at runtime through an import or a spawned
  executable and the package was not already a runtime dependency. This second
  case includes a development-only package moved into runtime use, and a
  package that is undeclared or present only through another dependency. The
  request states the purpose, the existing alternatives considered, and the
  indirect packages the dependency adds; disclose the indirect additions there,
  and they need no separate approval. A version update to an already-declared
  runtime dependency, a lockfile or indirect update, a development-only
  addition, and an ordinary local edit are not new direct runtime
  dependencies.

## Repository contents

Only commit durable artifacts required to:

- build the harness;
- run it;
- test it;
- understand its current behaviour;
- maintain supported functionality;
- satisfy licensing obligations.

Do not commit:

- agent memory;
- session transcripts;
- prompts used for one task;
- implementation handoffs;
- investigation reports;
- model-generated summaries;
- evaluation results;
- benchmark outputs;
- temporary probes;
- raw captures;
- debug logs;
- patch files;
- generated archives;
- task plans;
- progress journals;
- stale provenance narratives;
- local credentials;
- local environment files;
- editor state;
- machine-specific paths.

## Evaluations

Do not commit evaluation outputs or temporary evaluation harnesses.

A durable automated regression belongs in the normal test suite.

Before adding a separate evaluation framework or fixture set, establish that
it is a maintained repository capability rather than temporary task
scaffolding.

## Provenance and attribution

Do not add narrative provenance files to record development history.

Preserve only legally required licences, notices, copyright statements, and
concise third-party attribution.

Git history and source documentation describe the durable implementation.
They do not document which agent, model, session, or task produced it.

## Comments and documentation

Comments and documentation must describe the current system.

Do not add comments that encode task chronology or implementation-session
history. Avoid phrasing such as "Phase 2 fix", "Item 4", "temporary workaround
from investigation", "added for this task", or model/agent identifiers.

Do not hardcode counts (tests, tools, or files) in durable documentation;
counts drift as the tree changes. State the command or surface that measures
them instead.

## Temporary work

Perform disposable investigation outside tracked repository paths where
practical. Use the working directory that the machine instructions name for
such files, or the operating system temporary directory when they name none.

Temporary scripts created inside the repository must be removed before
completion.

## Verification

Verify what the change can break, then stop:

- Run the tests of the files you changed and of their direct consumers
  (`node --test <files>`). Run `npm test` only for changes with broad effect:
  dependencies, compiler or lint configuration, shared helpers, or the test
  runner itself. Two repository tests consume every slice: a settings-declaration
  change also runs `node --test scripts/settings-contract.test.mts`, and a
  registration or tool-schema change also runs
  `node --test scripts/extension-load-check.test.mts`.
- Run `npm run check` (slice isolation, settings declarations, pillar inventory,
  test inventory) after structural edits; `npm run typecheck` and `npm run lint`
  after TypeScript edits.
- Run `node scripts/extension-load-check.mts extensions/<name>/index.ts` after
  changing an extension's registration or startup path, and
  `node skills/harness/scripts/validate-skill.mts skills/<name>` after changing a
  skill's structure.
- Before pushing, inspect `git status` and the outgoing diff for temporary files,
  credentials, personal paths, task records, and operator quotations. The
  installed pre-push hook (`npm run hooks`) refuses credential, private-key,
  personal-path, and session-envelope signatures; it is not a semantic review.

Do not invent additional gates, audits, ledgers, review rounds, or approval
steps. A passing check establishes only what it exercised; name a material
gap instead of adding ceremony.

Independent review is discretionary. Request it for a material uncertainty or
failure mode, with a bounded question and an end condition. Resolve the
demonstrated findings, verify each repair at its owning layer, then stop. A
reviewer's recommendation of another review, a new worker, a commit, or a
later milestone is not a requirement; further review needs a newly identified
material concern or an operator request.

## Commit messages

Each commit must represent one coherent change with a concise imperative
subject describing the resulting repository state.

Use this format where structural clarity helps:

```text
type(scope): summary
```

Supported types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`.
A scope is optional.

Keep the subject line at approximately 72 characters or fewer.

Use a body only when needed to explain:

- why the change was required;
- important behaviour or architectural impact;
- material validation or compatibility considerations.

Do not use the body as a task diary or list of actions.

Do not include:

- agent or model names;
- session identifiers;
- implementation chronology;
- prompt references;
- review-round history;
- generic subjects such as `updates`, `changes`, or `fix stuff`.
