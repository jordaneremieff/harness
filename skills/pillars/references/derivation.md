# Pillars — Derivation Method

How to propose, derive, validate, and document principles, patterns, and heuristics. This method is the authoring workflow for the corpus at `../../pillars/`. The corpus holds doctrine only; the workflow lives in this skill. The operating reference is `../../pillars/AGENTS.md`.

## Contents

- [Stage 0: Classify the Change](#stage-0-classify-the-change)
- [Corpus Bar](#corpus-bar)
- [Naming](#naming)
- [Consultable Core](#consultable-core)
- [Citation and Portability Hygiene](#citation-and-portability-hygiene)
- [Document Shapes](#document-shapes)
- [Deriving a Principle or Heuristic](#deriving-a-principle-or-heuristic)
- [Pattern Derivation](#pattern-derivation)
- [Clause Extensions](#clause-extensions)
- [Validation of Implementations Against Pillars](#validation-of-implementations-against-pillars)
- [Storage Boundaries](#storage-boundaries)

## Stage 0: Classify the Change

Classify the edit shape before any drafting. The classification decides the path:

| Shape | Path |
|---|---|
| Clause-scale change: one table row, one manifestation, one carve-out entry; the Statement, scope, and move stay untouched | Clause extension path |
| New standalone candidate | Full derivation flow |
| Revision of a live pillar: Statement, scope, or move changes; a challenge to a pillar's standing | Full derivation flow in comparative mode |

Most real edits are clause-scale. The full flow exists for structural changes; running it on a one-clause edit wastes probe budget and operator time.

Mandated full reads: before drafting or probing, read in full the implicated pillar files. The recognition material and the subsumption baseline come from those reads, not from memory. The probe reads the files again in its own fresh context.

## Corpus Bar

New entries must clear a high bar. Most candidates are subsumed by existing pillars, are examples rather than doctrine, or belong as a clause in an existing document.

Before proposing anything new:

1. Read the inventory in `../../pillars/README.md` and the likely related pillars.
2. Ask whether an existing pillar owns the concern.
3. Ask whether the candidate changes decisions or merely describes an implementation.
4. Ask whether the candidate is specific to agent reasoning, knowledge architecture, or epistemic work rather than generic programming advice.

| Criterion | Test |
|---|---|
| Not subsumed | No existing pillar already supplies the belief, structure, or move. |
| Decision-changing | Reading it changes what an agent would build, choose, or say. |
| Domain-specific | The concern is specific to agent work or its knowledge systems. |
| Observed | A heuristic is grounded in actual behavior; a pattern is grounded in multiple heuristics. |
| Transferable | The recognition and move survive outside the originating vocabulary. |

Common rejection outcomes:

| Outcome | Meaning |
|---|---|
| Subsumed | Extend or clarify the existing pillar instead. |
| Implementation detail | Put it in a skill, design note, or code comment. |
| Too generic | Use established engineering guidance rather than adding doctrine. |
| Premature | Preserve the observation and wait for a second context. |

## Naming

A pillar name is part of its governance surface. It must work in a fast correction such as "check X" or "this violates X."

Before committing a name, test that it:

- is easy to type, pronounce, and remember;
- remains recognizable under a minor typo;
- does not collide with another pillar's stem;
- names the failure or discipline rather than an abstract concept noun; and
- still fits after private provenance and originating vocabulary are removed.

A rename, removal, or redefinition of a corpus term is a corpus-wide change. Update the file name (for a rename), the inventory, the operating reference, cross-references, and the delivery adapter together.

## Consultable Core

A new or substantially revised principle should expose a compact operational core near the top. The core contains the tests, moves, and main carve-outs needed at the decision moment. A principle that is useful only after reading a long essay will often produce narration instead of application when invoked under pressure.

Existing principles may satisfy this through a concise Decision Heuristic if a separate Core section would duplicate it.

## Citation and Portability Hygiene

Pillars must be self-contained and portable.

- Do not cite mutable instruction line numbers or rule numbers.
- Prefer relative links to stable corpus files and section names.
- Do not include private paths, session identifiers, personal names, internal project names, or vendor-specific work-stack examples.
- Use source classes such as "conversation channel," "issue tracker," "code host," and "telemetry system" instead of product names.
- Put the load-bearing reasoning inline. External references are optional background, not a substitute for the argument.
- Keep observed instances abstract enough to transfer while retaining the mechanism, sequence, and correction that made the doctrine observable.

## Document Shapes

### Principle

```markdown
# Principle: <Name>

## Statement
One sentence that captures the core belief.

## Core or Decision Heuristic
Compact operational guidance.

## Rationale
Why the principle matters.

## Shape
The abstract form.

## Manifestations
Concrete positive and negative examples.

## Tensions
Where application can invert or conflict.

## When NOT to Apply (optional)
Scope carve-outs the belief does not govern; conflicts with other pillars stay in Tensions.

## Relationship to Other Pillars
How it composes with the corpus.

## Summary
One-line restatement.
```

### Pattern

```markdown
# Pattern: <Name>

## Problem
The recurring structural problem.

## Solution
The shared procedure.

## Implements
The principles embodied.

## Worked Example
A vendor-neutral example.

## Constituent Heuristics
How each recognition cue specializes the pattern.

## Trade-offs
When the pattern adds more cost than value.

## Checklist
Actionable application steps.

## Summary
One-line restatement.
```

A pattern candidate must pass all four tests:

| Criterion | Test |
|---|---|
| Shared structural move | Constituent moves are the same procedure at different recognition moments, not merely thematically related. |
| Procedural value | The pattern says what to do, not just what the cluster is about. |
| Right altitude | It sits above heuristic cues and below principles. |
| Output-changing invocation | Applying it changes the artifact or action, not only what the agent considers. |

### Heuristic

```markdown
# Heuristic: <Name>

## Recognition
The situation and cues that trigger it.

## Move
The judgment or action it suggests.

## Negotiation
What must be calibrated rather than assumed.

## Why This Works
The mechanism and value.

## When NOT to Apply
Inversions and exclusions.

## Relationship to Pillars
The principles and sibling moves it operationalizes.

## Summary
One-line restatement.
```

A heuristic must be judgment-dependent, observed in practice, transferable across contexts, and not reducible to an unconditional rule.

## Deriving a Principle or Heuristic

### 1. Observe

Capture enough of the interaction to show:

- the decision point;
- the behavior that succeeded or failed;
- the correction or outcome;
- why the behavior mattered; and
- what would have changed if the move had fired earlier.

Resolve the observation source first: a file path, a stash, a session, or operator prose. A reference that points at nothing is a "missing" observation; do not draft from a guess at its content.

Preserve private raw evidence outside the public corpus. The candidate must restate only the transferable mechanism.

### 2. Self-check

Test subsumption and decide whether the observation warrants:

- no corpus change;
- a clause-scale extension;
- a heuristic;
- a pattern-synthesis trigger; or
- a principle.

A single event normally supports a clause or watch item, not a new standalone pillar. A standalone heuristic needs either recurrence, unusually clear transferable structure, or explicit acknowledgment that the evidence remains narrow.

Before drafting, search prior run records (session transcripts and stash entries) for near-cousin shapes. A prior decisive finding about a near cousin must be addressed by the new draft, or the draft spends a probe on a known defect.

### 3. Draft

Write the candidate at the smallest altitude that covers the observation without binding it to its original names, products, or business domain. Include explicit inversion cases: conflicts with another pillar belong in Tensions; scope carve-outs belong in the optional "When NOT to Apply" section. Absence of that section asserts that all known inversions are conflicts recorded in Tensions. Read the implicated pillar files in full before drafting the subsumption argument.

### 4. Fresh-context Probe

Use one fresh-context reviewer that has not seen the originating conversation. The reviewer may be a delegated agent when that capability is available; otherwise dispatch the probe brief in a fresh session. The probe reports findings; it does not compute the final verdict.

A fresh reader is not a stronger judge. It is a reader outside the originating conversation's framing momentum. In-context self-reflection inherits the same assumptions that produced the candidate, so a fresh reader can test the candidate without the originating conversation's social and narrative pressure. Multiple same-brief reviewers are samples from one posterior unless briefing, model family, fact base, or rubric genuinely varies.

Probe through five lenses:

| Lens | Question |
|---|---|
| Hidden Premise | What unstated assumption would force a root reframe if false? |
| Cousin Failure | What same-mechanism case escapes because the cues are too surface-bound? |
| Inverted Application | When is the opposite move correct, or how could the pillar become an alibi? |
| Self-Application | Does the candidate violate its own discipline or rely on the default explanation it criticizes? |
| Subsumption and Overlap | Does an existing pillar or clause already own this work? |

The reviewer classifies findings:

- **Blocking:** the synthesis must fold or rebut this before approval.
- **Material:** address it or state why it is deferred.
- **Minor:** optional polish.

"Nothing blocking found" is a valid result. A probe required to manufacture objections is miscalibrated.

Two disciplines bind the probe. Prose-discipline rule: for candidates that govern prose, a self-application finding must cite which of the candidate's OWN stated rules the candidate's text violates, judged at the candidate's own density standard; token-presence findings are invalid. Pattern-trigger rule: a finding that the candidate is one face of a broader pattern records a pattern-synthesis trigger; for a candidate that honestly declares its channel scope and names its unowned siblings, that is a trigger, not a defect.

### 5. Comparative Mode for Revisions

When revising a live pillar, give the reviewer both incumbent and revision. Findings must distinguish:

- regressions introduced by the revision;
- defects shared by both texts; and
- fixes the revision provides.

Rejecting a revision silently selects the incumbent. Comparative review makes that choice explicit. A challenge to a pillar's standing is a revision review whose alternatives include retaining, revising, and withdrawing.

### 6. Synthesize

For each finding, record one disposition:

| Disposition | Meaning |
|---|---|
| Folded | The draft changed to address it. |
| Rebutted | The finding does not bind, with a concrete reason. |
| Deferred | The finding is real but belongs to later work. |

Every Blocking finding must be folded or rebutted. Then choose one overall disposition:

- **Land:** present the candidate for operator approval.
- **Withdraw:** the candidate is wrong, redundant, or premature. The observation and decisive findings stay in the run record, never in the corpus.

### 7. Operator Approval

The operator decides whether a corpus mutation lands. Present the draft, probe findings, dispositions, portability review, and any unresolved trade-offs. Do not treat reviewer count as authority.

There is no automatic write gate. Corpus writes are local and git-tracked; they are reversible. The operator's explicit go on the presented synthesis is the gate. Record the run outside the repository: the session transcript or a stash entry carries findings by tier, dispositions, the overall disposition, and the operator decision. The commit message follows the repository's commit rules: a why-only body, never review-round history.

### Probe Calibration

One probe is the default. Re-probe only when synthesis changed the candidate's statement, move, or scope. For a consequential new principle, an optional second probe should vary model family, framing, or rubric; another same-brief sample is not independent evidence.

Miscalibration trigger: Blocking findings on more than half of candidates over a 30-day window, or two or more operator rejections following clean probes, prompts a recalibration review of the lenses and tier definitions. The trigger prompts judgment; nothing auto-fires.

## Pattern Derivation

Patterns arise from cross-heuristic synthesis, not a single event. A heuristic author sees one trigger clearly. The parallel becomes visible only from above the individual documents. Cross-references often preserve this latent signal with phrases such as "same move, different cue." Pattern review turns that signal into an explicit procedure.

1. Survey the candidate heuristics' Recognition, Move, and relationships.
2. Test whether their moves are structurally identical.
3. State the shared move once at the higher altitude.
4. Apply the pattern-specific validation criteria.
5. Document full, partial, or absent subsumption for each heuristic.
6. Draft the pattern with a vendor-neutral worked example.
7. Probe and obtain operator approval as above.

Pattern review fires when heuristic cross-references repeatedly say "same move, different cue," when a corpus survey exposes a cluster, or when a new failure resembles several heuristics but matches none of their recognition surfaces.

## Clause Extensions

Use the lighter clause path when all three conditions hold:

1. the observation is a single instance;
2. an existing pillar already subsumes it; and
3. the change is additive, such as a table row, manifestation, or exception, rather than a new statement, section, or move.

Process:

1. Draft the exact clause and identify its target section.
2. Skip the full probe because no new structure is being introduced.
3. Ask one fresh-context reviewer whether the clause belongs in the named pillar and whether its cue is overfit.
4. Present the clause and review finding for operator approval.

A clause that changes the host pillar's statement, scope, or move is a revision and uses the full process.

## Validation of Implementations Against Pillars

When reviewing a design or implementation:

1. Identify candidate pillars by their recognition cues.
2. State why each does or does not bind.
3. Classify apparent contradictions as a bug, drift, missing pattern, different concern, ambiguity, or explicit escape hatch.
4. Fix bugs and drift; document justified deviations.
5. Cite the relevant pillar by name and section, not by mutable line number.
6. A recorded application that contradicts a pillar's prediction defeats the pillar; revise it through this process rather than rationalizing around it. The corpus keeps no application-incident log, so falsification evidence must come from operator-recorded applications or a named delivery profile. Until such a record exists, doctrine is normative by operator authority and predictive verification is not yet established.

## Storage Boundaries

- The corpus directory holds doctrine.
- In-progress derivation state belongs in working memory or another private scratch area.
- Durable raw evidence belongs in an access-controlled evidence archive.
- Implementation specs belong with the system they describe.
- Task-specific consumers may reference pillars; pillars do not depend on a particular skill, adapter, or extension implementation.
- The derivation method is a workflow, not doctrine. It lives in this skill; the corpus does not carry it.
