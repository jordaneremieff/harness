# Heuristic: Coordination Phantom

## Recognition

This heuristic fires when a collaboration convention is being applied but its value depends on coordination conditions that may not exist.

Typical conventions include preserving unused compatibility layers, retaining duplicate interfaces, creating elaborate extension points, avoiding a clean rewrite because an unknown consumer might exist, or importing a reusable abstraction before a second use appears.

Cues:

- The justification names teams, consumers, release cycles, or maintenance obligations that cannot be identified.
- A breaking-change concern is raised without evidence of another active consumer.
- Reimplementation is called expensive even though the local change is small and bounded.
- The convention is defended by general industry practice rather than current coordination facts.
- "Someone might depend on this" is carrying more weight than repository or usage evidence.

## Move

1. **Name the convention.** State the rule being imported.
2. **Name its coordination precondition.** What parties, independent timelines, or reimplementation costs make the rule valuable in its origin context?
3. **Verify the precondition locally.** Identify actual consumers, owners, compatibility promises, release boundaries, and migration cost.
4. **Choose proportionally.** If the precondition holds, apply the convention. If it does not, make the clean local change.
5. **Preserve reversibility where cheap.** Avoid speculative machinery, but do not destroy inexpensive evidence or migration paths.

## Negotiation

| Condition | Response |
|---|---|
| Multiple active consumers with independent release timing | Preserve compatibility or provide an explicit migration. |
| Public or contractual interface | Treat compatibility as binding even if current usage is small. |
| One controlled consumer and cheap coordinated change | Prefer the clean change. |
| Consumer set is unknown but discoverable | Investigate before choosing. |
| Consumer set is unknowable and breakage cost is high | Use a bounded compatibility layer with an owner and removal condition. |
| The dependency is a stable, low-opinion substrate | Reuse may still be cheaper than local reinvention; evaluate on maintenance evidence rather than "not invented here." |

## Why This Works

Many engineering conventions are compressed solutions to coordination problems. Compatibility helps when consumers cannot migrate together. Reuse helps when implementation and long-term maintenance are genuinely expensive. Stable interfaces help when ownership is distributed.

When those preconditions are absent, preserving the convention's surface can create the cost it was meant to avoid: duplicate paths, unowned abstractions, migration machinery for nonexistent users, and ambiguity about the intended interface.

The heuristic does not reject collaboration practices. It restores the missing conditional: convention value depends on the coordination environment.

## When NOT to Apply

- The interface is public, contractual, regulated, or explicitly promised.
- Independent consumers or maintainers are known to exist.
- The convention protects security, data integrity, or another concern independent of coordination.
- A shared substrate is mature, bounded, and cheaper to reuse than to recreate.
- Evidence about consumers is unavailable and the plausible failure cost justifies a temporary conservative choice.

## Relationship to Pillars

- **Context Calibration:** tests whether the origin-context precondition of a familiar convention holds now.
- **Failure Cost Calibration:** compares migration or breakage cost with the cost of compatibility machinery.
- **Compositional Simplicity:** evaluates the duplicate paths and operational work created by speculative coordination layers.
- **Investigation Persistence:** requires checking actual consumers before asserting that they do or do not exist.
- **Harness Over Architecture:** both resist infrastructure created for anticipated rather than observed needs; this heuristic is specifically about coordination conventions.

## Summary

Before applying a collaboration convention, identify and verify the coordination condition that makes it valuable. If the condition is absent, prefer the clean local change.
