# Heuristic: Governing Context

## Recognition

This heuristic fires when deep understanding has been decomposed into tasks, specifications, handovers, or delegated units and the originating context is about to be discarded.

Cues:

- The units capture what to do but not how to judge their outputs.
- Several tasks arose from one first-principles exploration and are interdependent.
- Outputs are not yet known, so success cannot be fully encoded as local acceptance criteria.
- The originating reasoning contains rejected alternatives or conditional judgments absent from the task text.
- A fresh worker could execute each unit but could not integrate the results.

## Move

Before discarding the originating understanding, test each artifact for four properties:

1. **Task specification:** what to do.
2. **Evaluation criteria:** how to tell whether the result is good.
3. **Sibling awareness:** how it relates to other units from the same decomposition.
4. **Output handling:** who or what consumes the result and which decision follows.

If any of properties 2 through 4 is missing:

- preserve a reachable orchestration point; or
- write a governing-context artifact containing the shared frame, dependencies, rejected alternatives, ensemble success criteria, and integration plan.

Then run a fresh-reader test:

> Could someone with only these artifacts make the same integration and evaluation decisions the originating reasoner would make?

If not, the decomposition is not yet self-sufficient.

## Negotiation

| Situation | Response |
|---|---|
| Tasks are independent and outputs have local tests | No separate governing artifact is needed. |
| The frame is simple and fully captured in each task | Avoid duplication. |
| Work is sequenced or outputs alter later tasks | Preserve sibling awareness and decision points explicitly. |
| Exploration rejected plausible alternatives | Preserve why they were rejected and what evidence would reopen them. |
| Originating context cannot persist reliably | Extract the governing frame before handoff. |
| Sensitive evidence shaped the frame | Store raw evidence privately and expose only the transferable criteria needed by the receiver. |

## Why This Works

Decomposition preserves components more readily than composition. A task description can be locally complete while the set is globally incomplete because no unit owns the judgment that connects outputs.

Unknown outputs make this especially important. Their evaluator needs a framework for interpreting surprises, trading one result against another, and deciding what happens next. Conclusions record what was chosen; derivation often records why, why not alternatives, and what would change the choice.

The heuristic does not require preserving an entire conversation. It requires preserving the minimal frame that makes delegated artifacts governable.

## When NOT to Apply

- Tasks are genuinely independent.
- Outputs and success criteria are fully specifiable locally.
- The governing frame has already been captured and linked.
- The work follows a stable routine whose integration rules are already documented.
- Preserving more context would add noise without changing evaluation.

## Relationship to Pillars

- **Cognitive Stratification:** governs extraction from transient or working context into durable handoff state.
- **Compositional Simplicity:** the composition layer is part of the system and cannot be deleted merely to make tasks look self-contained.
- **Committed Contribution:** the decomposition embodies claims about what matters and should make those criteria inspectable.
- **Phantom Stewardship:** a durable governing frame keeps unfinished substrate from becoming anonymous residue.
- **Redundant Corroboration:** sibling outputs sharing one frame should not be mistaken for independent facets.

## Summary

Decomposed tasks capture actions. Before discarding the originating understanding, ensure they also preserve how outputs are judged, related, and integrated, or keep a durable orchestration point that does.
