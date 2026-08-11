# Skill Design and Structure

Use this reference after research establishes that a skill should be created or
substantially redesigned. It covers the portable shape, invocation decisions,
progressive disclosure, and authoring review.

## Contents

- [Name and location](#name-and-location)
- [Invocation mode](#invocation-mode)
- [Frontmatter](#frontmatter)
- [Information hierarchy](#information-hierarchy)
- [Resources](#resources)
- [Instruction form](#instruction-form)
- [Review checklist](#review-checklist)

## Name and location

The portable directory shape is:

```text
skill-name/
├── SKILL.md
├── scripts/
├── references/
└── assets/
```

Only `SKILL.md` is required. Name both the directory and frontmatter `name`
with 1–64 lowercase letters, digits, and hyphens, with no leading/trailing or
consecutive hyphens. Match the parent directory to the name for portability,
even when Pi tolerates a mismatch.

Choose a name that predicts the skill's boundary and sorts naturally beside
related skills. Neither noun-led nor verb-led naming is universally mandated;
prefer the form operators and neighboring skills already use, unless it makes
the capability harder to find. Avoid vague names (`helper`, `utils`), temporal
names (`new-workflow`), and implementation details that will change.

## Invocation mode

Model-invoked skills need a strong `description` because that metadata is the
only always-loaded activation surface. User-invoked skills may use a
client-specific hidden-invocation field to avoid context cost, but they also
lose autonomous and cross-skill reach.

Pi supports `disable-model-invocation: true`; the core Agent Skills standard
does not. Use it only for Pi-specific skills and record the portability
trade-off. Do not use hidden invocation for a model-selected skill when other
skills or future agents need autonomous access to it.

## Frontmatter

The portable required fields are:

- `name`: the same value as the directory name.
- `description`: what the skill does and when to use it, 1–1024 characters.

Standard optional fields are `license`, `compatibility`, `metadata`, and the
experimental `allowed-tools`. Unknown fields may be ignored by clients. Keep
client-only metadata out of the portable mental model unless the client is
the actual target.

Declare sibling-package references (paths outside the skill directory within
the same repository) in `compatibility`, and write them in the body as inline
code, never as markdown links.

A useful description pattern is:

```yaml
description: >
  Use when <capability or intent>, <concrete task variants>, and
  <adjacent situations where the skill should be considered>. Do not use for
  <near miss that should route elsewhere>.
```

The description must win attention without teaching the workflow. Include
operator vocabulary and distinct branches, not keyword stuffing or repeated
synonyms. Do not make the body responsible for activation: the body is not
read unless the description triggers.

## Information hierarchy

Keep the core operating procedure in `SKILL.md`. Push conditional material
behind a clear relative pointer when only some runs need it. Keep references
one level from `SKILL.md` and tell the agent exactly when to read each file.
The rough 500-line/5,000-token budget is a design signal, not a reason to
hide universally needed steps.

Use this placement test:

- **Always needed to act:** `SKILL.md` step.
- **Needed to judge but not sequential:** `SKILL.md` reference section.
- **Needed by only one branch or client:** `references/<topic>.md`.
- **Executed repeatedly and deterministic:** `scripts/<tool>`.
- **Copied into output:** `assets/<template>`.

A step is complete only when its completion criterion can be checked. Make
criteria observable ("all required frontmatter fields validate"), not
aspirational ("make it good"). If the next steps tempt the agent to rush a
current step, split the branch or place later detail behind a pointer.

## Resources

Add `scripts/` when agents repeatedly rewrite the same logic, when
deterministic validation matters, or when structured output should be parsed.
Default to type-checked Node (`.mts`) for Pi-oriented or TypeScript-adjacent
skills because Pi and the harness already require Node. Use Python or another
language only when the target ecosystem clearly supplies that runtime or a
mature library justifies the extra prerequisite. Scripts must be
non-interactive, accept flags/stdin, document `--help`, use safe defaults,
emit diagnostics separately from data, bound output, and be tested. Prefer
existing pinned commands for simple work; do not build a framework to avoid
three lines of shell.

Add `references/` for detailed schemas, domain notes, checklists, or client
variants. A reference over 8 KB counts as a long reference and must include
a table of contents, with a trigger sentence for it in `SKILL.md`.

Add `assets/` for files used in the produced artifact rather than read as
instructions, such as templates, icons, sample forms, or boilerplate.

Do not add auxiliary process documentation such as README, changelog, or
creation notes to the skill itself. Put provenance in the owning repository.

## Instruction form

Write a reusable method in imperative or infinitive form. Give the reasoning
behind judgment guidance so a capable agent can adapt; use exact commands and
low-degrees-of-freedom instructions for fragile operations.

Match the instruction form to the observed failure:

- **Agent violates a known rule under pressure:** explicit boundary,
  rationalization counter, and self-check.
- **Output has the wrong shape:** positive recipe, required slots, or output
  contract.
- **A field or step is omitted:** checklist item with an observable
  completion criterion.
- **Behavior depends on context:** conditional keyed to an observable
  predicate.

Do not use broad prohibitions as the primary steering mechanism. Name the
target behavior. Use observed pitfalls and concise Don't/Do pairs only when
they prevent a real failure. Explain credentials, destructive operations,
network assumptions, and trust boundaries once in the right checklist.

## Review checklist

Before asking for approval, verify:

- [ ] The skill still earns its context cost after research and baseline
      evidence.
- [ ] The directory name and frontmatter `name` match and obey the naming
      rules.
- [ ] The description states capability, activation branches, and boundary
      within 1024 characters.
- [ ] Client-specific behavior is identified as such and verified against
      the target client.
- [ ] The body gives one coherent method with checkable step completion.
- [ ] Conditional detail lives behind explicit relative pointers.
- [ ] Scripts are necessary, non-interactive, documented, tested, bounded,
      and use dependency-free Node unless a documented ecosystem reason
      justifies another runtime.
- [ ] No secrets, operator-private paths, copied third-party prose, stale
      version claims, or unsupported capability claims remain.
- [ ] The skill does not duplicate an existing local skill or a clearly
      superior external skill.
- [ ] The approval request states target location, validation evidence,
      trigger/output eval results, and remaining limitations.
