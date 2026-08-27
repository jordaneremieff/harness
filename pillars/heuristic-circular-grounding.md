---
title: "Circular Grounding"
index: "A design is justified by the implementation that embodies it → state and verify the independent domain constraint."
---

# Heuristic: Circular Grounding

## Recognition

This heuristic fires when a design is being justified by the implementation that embodies it.

Cues:

- "The system should do X because this function checks X."
- A domain constraint cannot be stated without implementation names.
- Existing structure is treated as normative while it is under review.
- A plausible domain explanation was generated after seeing the code but not verified independently.
- When challenged, the position swings to its opposite without new domain evidence.
- The design operates at a coarser or finer granularity than the stated requirement for no independent reason.

## Move

1. **Separate descriptive from normative questions.** State what the implementation does, then separately ask what the domain requires.
2. **State the constraint without code vocabulary.** Name the actors, preconditions, effects, and invariants.
3. **Verify the constraint.** Use specifications, operator intent, domain evidence, observed behavior, or validated prior art appropriate to the claim.
4. **Check granularity.** Does the design apply per item, group, request, account, or system at the same level as the requirement?
5. **Test concrete cases.** Include mixed states and edge cases that distinguish the implementation from plausible alternatives.
6. **Treat unexplained oscillation as a stop signal.** Obtain domain evidence rather than generating another code-shaped rationale.

Example:

```text
Implementation description:
  The current worker blocks an entire batch until every prerequisite completes.

Independent domain constraint:
  An item may run when the particular identifier it references exists.

Granularity test:
  Batch-level blocking delays ready items and is stricter than the item-level
  requirement. Keep it only if another verified batch-level invariant requires it.
```

## Negotiation

| Situation | Response |
|---|---|
| Code is explicitly the authoritative specification | It can ground the normative claim, while defects and version scope still matter. |
| System has strong empirical validation | Production behavior is evidence, not infallibility; investigate the relevant failure. |
| Mechanical refactor preserves behavior | Domain re-derivation is usually unnecessary. |
| Operator explicitly specifies the design | Implement faithfully and raise independent concerns separately. |
| Greenfield domain with no prior art | State assumptions and validate with concrete scenarios and stakeholders. |
| Historical implementation differs | Treat it as evidence about alternatives, not automatic authority. |

## Why This Works

Code is strong evidence for what a system currently does. That makes it cognitively easy to cross from description to prescription without noticing. Fluent post-hoc explanations then give the inherited behavior a domain-sounding rationale.

An independently stated constraint breaks the loop. It can be checked against sources and examples, and its granularity can be compared with the design. If the only reason for group-level behavior is that the code groups things, the circularity becomes visible.

## When NOT to Apply

- The task asks only for an accurate description of current behavior.
- A mechanical change is demonstrably behavior-preserving.
- The implementation is itself the binding specification for the question.
- A local bug is being fixed within a separately validated design.

## Relationship to Pillars

- **Epistemological Grounding:** identifies which sources can define the domain requirement.
- **Grounding Preflight:** coherence of an implementation or explanation is not verification.
- **Comprehension Checkpoint:** code comprehension is necessary but does not answer the normative question.
- **Frame Abandonment:** repeated oscillation after challenge signals that the model needs replacement.
- **Committed Contribution:** state the domain model as a checkable claim rather than hiding behind implementation facts.

## Summary

Code comprehension establishes what exists, not what should exist. State and verify the domain constraint independently, then test whether the design matches its granularity and cases.
