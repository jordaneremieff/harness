---
title: "Survival Selection"
index: "Rebuilding after a transition → treat repeated survival as selection evidence and build around demonstrated jobs."
---

# Heuristic: Survival Selection

## Recognition

This heuristic fires when a tool, platform, workflow, or architecture is being rebuilt after one or more transitions and there is disagreement about what to carry forward.

Cues:

- The rebuild plan follows the previous architecture rather than present use.
- Some small artifacts survived multiple transitions while ambitious subsystems were repeatedly replaced.
- Planned importance and observed persistence point in different directions.
- The team is recreating casualties because they once received substantial design effort.

## Move

1. **Inventory transitions.** Name the major changes in platform, workflow, or operating model.
2. **Separate survivors from casualties.** Record what remained useful, what was recreated repeatedly, what faded, and what was explicitly abandoned.
3. **Explain survival.** Identify the job each survivor performed, how often it was used, and what made it cheap to carry.
4. **Check for hidden support.** Distinguish genuine user selection from contractual lock-in, compatibility inertia, or a maintainer quietly keeping an artifact alive.
5. **Build around demonstrated jobs.** Preserve the capability or role, not necessarily the old implementation.
6. **Require fresh evidence for casualties.** Prior effort is not a reason to rebuild something that did not survive.

A useful table:

| Artifact or capability | Transition history | Usage evidence | Survival mechanism | Rebuild decision |
|---|---|---|---|---|
| Small durable reference | Carried through several systems | Frequently consulted | Portable and low-maintenance | Preserve role |
| Large anticipatory subsystem | Replaced or bypassed | Sparse use | Required special upkeep | Do not rebuild without new evidence |
| Compatibility layer | Persisted by obligation | Consumer dependency | Contract, not preference | Preserve until migration |

## Negotiation

| Situation | Interpretation |
|---|---|
| Artifact survived because users repeatedly chose it | Strong evidence of fit. |
| Artifact survived because removal was risky or expensive | Evidence of dependency, not necessarily quality. |
| Artifact died because its host platform disappeared | Weak evidence against the capability; reassess the job separately. |
| New context introduces a binding requirement | Historical survival is informative but not decisive. |
| A casualty now has clear observed demand | Reconsider with current evidence and a small trial. |
| Survivor is simple but unsafe or ungoverned | Preserve the job while replacing the implementation. |

## Why This Works

Transitions act as filters. Optional structures must repeatedly justify the effort to migrate, relearn, or maintain them. Simple artifacts tied to recurring pain often survive because their value is continuously visible. Anticipatory systems can disappear because their imagined integration never became daily work.

Survival is selection evidence, not proof. Inertia, contracts, hidden labor, and migration cost can also preserve a bad artifact. The mechanism check prevents the heuristic from becoming "old means good."

The key distinction is between **capability continuity** and **implementation continuity**. What survived may be a job, interface, or information shape rather than a codebase.

## When NOT to Apply

- There has been no meaningful transition or opportunity for selection.
- Safety, legal, or contractual requirements override usage history.
- Survivors were maintained through hidden coercion or uncounted labor.
- The new environment has a genuinely new requirement with no historical analogue.
- The surviving artifact is known to be insecure, corrupt, or obsolete.

## Relationship to Pillars

- **Harness Over Architecture:** both prefer structures justified by observed use over anticipatory design.
- **Intrinsic Organization:** subject-centered artifacts often survive consumer transitions better than consumer-centered ones.
- **Compositional Simplicity:** low total maintenance cost is one reason useful structures survive.
- **Metric Reification:** persistence must be interpreted with its conditions; a count of transitions alone is not a system property.
- **Phantom Stewardship:** substrate lineage can reveal what persisted after an author or context disappeared.

## Summary

After a transition, treat repeated survival as evidence of a capability's fit, investigate why it survived, and require new evidence before rebuilding what repeatedly died.
