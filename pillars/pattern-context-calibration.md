---
title: "Context Calibration"
index: "At default-selection moments, test whether the origin context of an inherited default matches the current context."
---

# Pattern: Context Calibration

## Problem

Agents inherit familiar patterns, conventions, rubrics, and solution categories from examples produced in particular operating contexts. A default can be correct in its origin domain and wrong when its preconditions do not hold now.

The failure is not pattern recognition itself. It is applying the recognized default without calibrating scale, stakeholders, maintenance model, consequences, and domain constraints.

## Solution

At a default-selection moment:

1. **Name the default.** State the pattern, convention, rubric, or category being reached for.
2. **Identify its origin-context preconditions.** What made it correct where it became common?
3. **Check those preconditions here.** Use observable current facts rather than category resemblance.
4. **Recalibrate.** Keep the default when its conditions hold; otherwise choose a proportional alternative and state the reason when it matters to later readers.

| Default type | Typical origin-context precondition |
|---|---|
| High-caliber protection mechanism | Failure is expensive, irreversible, or regulated. |
| Collaboration convention | Multiple consumers or maintainers cannot coordinate changes cheaply. |
| Maintainer-centered evaluation rubric | A human maintainer will regularly read, debug, and upgrade the implementation. |
| Problem-class solution category | Domain constraints actually require the category. |

## Implements

- **Agent-Native Expertise:** inherited defaults are inputs to judgment, not experience or authority.
- **Compositional Simplicity:** the current context determines whole-system cost; local elegance in one origin context may create total complexity in another.

## Worked Example

An agent is asked to add one local tool and reaches for a framework-style registry with generated schemas, versioning, and extension points.

```text
Default:
  Multi-contributor tool registry.

Origin-context preconditions:
  Many independent authors and consumers, versioned releases,
  compatibility obligations, and a boundary where validation protects parties.

Current context:
  One controlled consumer, one implementation location, no release boundary,
  and cheap coordinated change.

Recalibration:
  Add one function through the existing registration mechanism. Introduce a
  registry only when a second consumer or an observed coordination failure
  establishes the missing precondition.
```

The conclusion is not that registries are bad. It is that their value is conditional.

## Constituent Heuristics

| Heuristic | Default being calibrated | Recalibration target |
|---|---|---|
| **Failure Cost Calibration** | Protection caliber | Match mechanism cost to concrete consequence. |
| **Coordination Phantom** | Collaboration convention | Drop machinery when its multi-party precondition is absent. |
| **Ecosystem Gravity** | Technology evaluation rubric | Match evaluation axes to the operator's maintenance role. |
| **Category Lock-In** | Solution category selected from problem class | Restate the problem without the category and reopen the search. |

Category Lock-In is a partial constituent because depth-first search within a wrong category can arise from mechanisms beyond inherited defaults.

## Trade-offs

Over-calibration can turn routine choices into essays and reflexively reject good conventions. Do not perform the full procedure on every loop, collection, or ordinary local idiom.

Invoke it when:

- a high-cost pattern is defended by "best practice";
- a convention names stakeholders who may not exist;
- evaluation axes assume a maintenance role not held here;
- a problem phrase automatically activates one solution family; or
- a reviewer could reasonably ask why this caliber or category was chosen.

Calibration is not reflexive minimization. A failed check can reveal that the current context is more demanding than assumed, requiring a stronger rather than weaker mechanism.

## Checklist

- [ ] Named the inherited default.
- [ ] Stated the conditions that make it valuable.
- [ ] Checked each condition against current evidence.
- [ ] Distinguished familiarity from applicability.
- [ ] Chosen a proportional alternative when conditions differ.
- [ ] Recorded the calibration when future work could otherwise reverse it by reflex.

## Summary

Inherited defaults are inputs, not expertise. Name the default, identify the conditions that made it correct, test those conditions in the present context, and recalibrate when they differ.
