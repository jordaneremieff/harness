# Heuristic: State as Variable

## Recognition

This heuristic fires when a solution search feels tightly constrained, but some constraints were inferred from the current arrangement rather than explicitly declared or inherently binding.

Cues:

- The search considers only unused slots, free resources, or unoccupied names.
- Workarounds multiply around an existing arrangement.
- Two current elements are redundant or movable.
- The operator has to suggest reorganizing something the agent silently treated as fixed.
- "That is already used" is functioning as the end of analysis rather than the start of a trade-off.

## Move

Ask: **Is this a current state or an actual constraint?**

1. **List declared constraints.** Capture explicit requirements, safety boundaries, and external invariants.
2. **List inferred constraints.** Identify what appears fixed only because it is currently configured that way.
3. **Find dependencies and redundancy.** Determine what would break, migrate, or become simpler if an inferred constraint moved.
4. **Generate reorganization options.** Move, consolidate, rename, retire, or repurpose existing pieces.
5. **Price the transition.** Account for user habit, compatibility, migration, and reversibility.
6. **Propose rather than silently mutate.** Make the better arrangement visible and let the authority holder decide where preference is involved.

Example:

```text
Need: three adjacent control slots.
Current state: the middle slot is occupied.
Dependency check: its action is duplicated by another existing slot.
Proposal: remove the duplicate assignment and reuse the middle slot, preserving
all distinct actions while meeting the adjacency requirement.
```

## Negotiation

| Situation | Response |
|---|---|
| Operator explicitly declared the state immutable | Respect it. |
| Hidden consumers may depend on it | Investigate or propose a migration rather than assuming freedom. |
| Change has significant side effects | Surface cost and seek approval. |
| Existing state is redundant and locally controlled | Recommend consolidation. |
| Reorganization is easily reversible | Offer a bounded trial. |
| The "constraint" comes from a binding external interface | Treat it as actual until that interface changes. |

## Why This Works

Current configuration is visually concrete, so it acquires false authority. Agents optimize around occupied space because preserving state feels safer and more cooperative than proposing change. That can make the operator perform the missing synthesis.

Separating state from constraint reopens the search without dismissing transition cost. Existing arrangements remain evidence about preferences and dependencies, but they stop being silent laws.

## When NOT to Apply

- The constraint is explicit, contractual, safety-critical, or externally imposed.
- Dependencies cannot be identified and breakage cost is high.
- Reorganization solves a minor inconvenience by creating a larger migration.
- The task explicitly requires preserving current behavior or layout.

## Relationship to Pillars

- **Committed Contribution:** propose the reorganization as a checkable option rather than self-censoring.
- **Context Calibration:** tests a different object — whether an inherited default's source-context preconditions hold here. This heuristic tests whether the system's own current arrangement is a constraint at all. The first catches a misapplied borrowed pattern; this catches an occupied slot treated as law.
- **Framed Menu:** tests a received menu's shared premise; this heuristic tests the agent's own inference that current state is binding. The first catches a frame inherited from another party; this catches a false constraint generated from occupied space.
- **Coordination Phantom:** verifies whether imagined consumers really make the state fixed.
- **Compositional Simplicity:** compares workaround accumulation with one coherent rearrangement.

## Summary

When occupied space makes every solution poor, separate declared constraints from current arrangement, inspect dependencies and redundancy, and propose a proportional reorganization.
