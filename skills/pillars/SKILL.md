---
name: pillars
description: >
  Consult and apply the pillars: the doctrine corpus (principles, patterns,
  heuristics) that governs agent judgment in this environment. Use at any
  judgment moment where a governing principle might bind, for example:
  architectural or design decisions, trade-offs, option menus and
  comparisons, whether infrastructure is warranted, where information belongs,
  how much verification a claim needs, flagging or repairing prose tells. Also
  use when the operator says "check pillars", "what do the pillars say", "apply
  pillars", asks for a decision to be evaluated against principles, patterns, or
  heuristics, or proposes, derives, revises, or challenges corpus entries.
compatibility: Requires the sibling package corpus at ../../pillars relative to this skill directory.
---

# Pillars consultation

The pillars are portable, defeasible doctrine for agent judgment in this environment.
The canonical corpus is the package-level `../../pillars/` directory, resolved
relative to this skill directory. It is a sibling package dependency rather than
content owned by this delivery adapter. A matching pillar governs the decision
procedure; it does not override facts, permissions, or explicit higher authority.

## How to consult

1. Read `../../pillars/README.md` first. It is the inventory: every principle,
   pattern, and heuristic with a one-line trigger. Match the current judgment moment
   against those recognition conditions.
2. Load only the few documents whose conditions plausibly match. Each doc is
   self-contained: the belief or move, why it holds, and the failure it prevents.
3. A match creates a rebuttable obligation in the decision procedure: apply the
   guidance or identify the fact, hard constraint, inversion, sibling, carve-out, or
   contradiction that defeats it.
4. Apply the result to the artifact or decision. Application may change a choice or
   stabilize an already-correct one; citation, naming, and retrieval alone do not prove
   application.
5. Routine work need not narrate doctrine. Name the governing pillar when the operator
   requests a Pillars evaluation, when a consequential distinction needs auditability,
   or when explaining a material override.

## The three types

- **Principles** (`principle-*.md`) — core beliefs about how systems work. Evergreen.
- **Patterns** (`pattern-*.md`) — structural solutions embodying principles. Evergreen.
- **Heuristics** (`heuristic-*.md`) — recognition → move pairs for judgment moments.
  Situational; fire when the recognition condition matches.

No document type has automatic precedence over another. Resolve collisions by facts,
source authority, recognition scope, and explicit carve-outs—not by type.

## High-value triggers (from the corpus index)

| Situation | Start with |
|---|---|
| Proposing infrastructure without an observed incident, measured omission, or binding requirement | heuristic-harness-over-architecture |
| Third+ proposal in the same solution category | heuristic-category-lock-in, pattern-frame-inspection |
| About to cite tool output as evidence for a claim | heuristic-verification-reach |
| Comparing options where one always wins | heuristic-loaded-comparison, heuristic-framed-menu |
| Reaching for a default from training data | pattern-context-calibration |
| Deciding where knowledge or state should live | principle-cognitive-stratification, principle-intrinsic-organization |
| Operator corrected an assumption mid-task | heuristic-corrected-assumption-leakage |
| Judging whether prose carries a position or is filled from no position | principle-unearned-prose |
| Fixing a flagged prose tell by swapping symbols | heuristic-tell-laundering |
| Dirty state in a shared substrate, author unknown | heuristic-phantom-stewardship |

## Rules of use

- System and safety instructions, law, permissions, and explicit operator authority
  remain separate higher constraints.
- The corpus is doctrine, not scripture: when facts or reality contradict a pillar,
  use the full classification in `../../pillars/AGENTS.md` rather than forcing compliance.
  If consequential guidance still conflicts, record the ambiguity and obtain the
  appropriate authority instead of inventing precedence.
- Consult the smallest relevant set. Full-corpus recital is not compliance.
- Doctrine does not inherit across sessions, processes, subagents, or graders unless
  their delivery profile explicitly supplies it.
- Version-attributed observations and evaluations must identify the doctrine snapshot
  and actual delivery profile. Ordinary use need not log consultation.
- New, revised, or challenged corpus entries run the derivation method in
  `references/derivation.md` (read it when the operator proposes, derives,
  revises, or challenges a pillar); do not invent ad-hoc "principles" in session
  prose. Corpus mutations require the operator's explicit approval.
- When the operator asks for a Pillars evaluation, name the pillar, state its
  recognition condition, and show why it binds, is defeated, or collides—that is the
  deliverable.
