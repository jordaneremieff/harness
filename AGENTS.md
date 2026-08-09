# Repository instructions

- Earlier harness generations are evidence of needs and failure modes only — never
  carry forward their source, comments, tests, prompts, names, or identifiers.
- No source, comments, tests, names, prompts, or internal identifiers from any
  earlier harness generation (local snapshot, extraction, or reviews) may be
  copied into this repository.
- Requirements are written neutrally from current public Pi documentation and
  shipped examples, plus observed operator needs.
- No company doctrine, service names, internal hosts, model rosters, credentials,
  or operator-local absolute paths. Per-extension configuration uses
  environment variables named `PI_*`, each documented in its extension README.
  See `docs/conventions/extension-config.md`.
- Report to the operator only in adapted ASD-STE100 Simplified Technical English (STE).
  Apply STE to every operator-facing chat message: status updates, summaries, error
  reports, findings, questions, and recommendations. The register governs chat
  messages only. Repository prose, documentation, and skill deliverables stay
  outside it. Skill deliverables include the troll skill's redirect artifact and
  its chat confirmation, which are verdict-last natural prose by design. Code,
  commands, paths, file contents, and commit messages stay in their normal form
  unless the operator asks for STE there.

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
  10. American spelling (Merriam-Webster): "color", "analyze".
  11. First sentence: the result, the state, or the question.
  12. Plainest common word: "use" not "utilize", "start" not "commence".

  This is an adapted reporting register based on ASD-STE100 Issue 9 (January 2025).
  It does not reproduce the specification or its dictionary. Do not claim certified
  STE compliance.
- Review and audit findings get exactly one of three dispositions: fixed now (with a
  regression test where feasible), shown false with cited source evidence, or blocked
  with the exact unavailable layer named. Never "accepted as-is" or deferred as
  cosmetic/minor debt. Escape hatches under the pillar corpus's Contradiction Handling
  are a different object class (a deliberate bounded override), not a disposition
  under this rule. The repository forbids committing investigation reports and
  contains no evidence archive; "shown false" names its source evidence (path, URL,
  or installed package) as the durable record.
- Verify claims about Pi or pi-tui behavior against the installed package sources
  before acting on them, including claims from reviewers and delegated agents.
- Durable source is independent of the session that produced it. Comments, test
  headings, names, and durable documentation describe behaviour, invariants,
  external contracts, security constraints, or non-obvious rationale. They must not
  refer to prompt items, workstreams, review rounds, correction passes, current
  implementation phases, agent or model identities, or temporary task chronology.
  Temporary planning belongs in the session or a stash. Delete comments that
  merely narrate the code (Cognitive Stratification, Intrinsic Organization).
- Perform active development for each extension in one dedicated persistent Git
  worktree and stable branch. Reuse that worktree across sessions and tasks. Do
  not remove it after one implementation cycle. Run `npm run worktrees:sync`
  before extension work and after `main` advances. Keep provisional extensions
  in their worktrees without global Pi activation. Route each active extension
  through its worktree entrypoint instead of the main package copy. See
  `docs/conventions/extension-worktrees.md`.
- Each extension is an independent vertical slice with structural, semantic, state,
  and presentation boundaries. An extension must not import a sibling, parse
  sibling-formatted output, reproduce sibling-owned types or lifecycle states,
  hardcode sibling evidence markers or tool sets, depend on sibling mutable state,
  or establish an undocumented sibling protocol. Cross-extension behaviour uses
  public Pi surfaces or an explicit package-level contract owned outside either
  extension and justified by current consumers. Tests for one extension must not
  assert another extension's private implementation or display format. Generic Pi
  event analysis must remain generic — do not recognize one sibling extension's
  private vocabulary. Do not create a shared abstraction solely to remove small
  duplication. Colocated `*.test.mts` tests, its own README, no operator-local
  paths or credentials in committed content. The isolation rule is maintained by
  review; no automated check for sibling imports or undocumented sibling
  vocabulary exists in the test suite.
- One-pass standard: complete each task fully in the current pass. Deferral,
  staged completion, and promised follow-up passes read as reasonable
  engineering to a generic reviewer; they are failures under this standard.
- Before closing work: focused tests, `npm test`, `npm run typecheck`, `npm run
  check`, and README claims updated to match reality in the same change.

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
practical. Use the operating system temporary directory.

Temporary scripts created inside the repository must be removed before
completion.

## Completion checks

Before considering repository work complete:

- After a corpus mutation removes, renames, or redefines a term, grep that term across docs/ and skills/ before pushing.

1. inspect `git status`;
2. check for accidental credentials or absolute personal paths;
3. remove temporary files;
4. confirm documentation links resolve;
5. run focused tests;
6. run `npm run lint` (Biome lint, same tool as the Pi upstream);
7. run `npm run typecheck` (TypeScript check against the installed Pi declarations);
8. run `npm run check` (slice isolation, hardcoded counts);
9. run the normal full test command;
10. report remaining untracked or modified files honestly.

The automated gates are `npm run lint`, `npm run typecheck`, `npm run check` (slice isolation,
hardcoded counts), and the normal full test command. Credential
and personal-path scanning, documentation-link resolution, and the git-status
report have no automated check in the tree; they are maintained by review, and the
honest report of remaining untracked or modified files stays the final step.

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

Before committing:

- inspect the staged diff;
- run the relevant validation.
