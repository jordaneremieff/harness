# Heuristic: Failure Cost Calibration

## Recognition

This heuristic fires when a high-caliber reliability pattern is proposed and its complexity is being defended as rigor without a concrete account of the failure it prevents.

Cues:

- Duplicate prevention, distributed coordination, multi-stage recovery, or strong transactional machinery appears before expected volume and consequences are stated.
- The justification uses category labels such as "production grade" or "best practice."
- Failure probability is discussed while impact remains abstract.
- The environment may already retry, expire, deduplicate, or make cleanup cheap.
- Pattern cost is treated as free because the pattern is familiar.

## Move

1. **Describe the failure concretely.** State the event, side effect, and affected party.
2. **Quantify consequence in real units.** Money, recovery time, lost work, customer impact, integrity risk, or irreversible effect.
3. **Estimate frequency and detectability.** A rare visible duplicate differs from silent repeated corruption.
4. **Price the protection.** Count code, schema, state, operational burden, new failure modes, and cognitive load.
5. **Check existing mitigation.** Identify protections already supplied by the environment or upstream system.
6. **Choose proportional caliber.** Use the cheapest mechanism whose residual risk is acceptable.
7. **Record the calibration.** State what evidence would justify escalation later.

A compact decision form:

```text
Failure: one duplicate request with a reversible side effect.
Expected impact: minutes of cleanup; immediately visible.
Existing mitigation: upstream deduplication within the normal retry window.
Protection cost: new persistent state and recovery path.
Decision: use a local existence check and alert; escalate only if duplicates recur.
```

## Negotiation

| Condition | Calibration |
|---|---|
| Irreversible money movement, safety effect, or regulated record | Strong protection can be justified even at low volume. |
| Cheap, visible, reversible failure | Prefer a simple check, cleanup path, or observability. |
| High frequency but low per-event cost | Aggregate operational cost may justify automation. |
| Low probability but catastrophic impact | Use expected loss only with care; hard safety bounds may dominate. |
| Existing system supplies reliable protection | Avoid duplicating it unless its reach is insufficient. |
| Failure cost is unknown | Improve measurement or choose a bounded reversible mechanism. |

## Why This Works

High-stakes systems produce much of the visible reliability literature, so their patterns become familiar defaults. Pattern recognition then skips the condition that justified the pattern: the cost and irreversibility of failure.

Complex protection is not free. It adds state, branches, migrations, coordination, and recovery work. Calibration compares two failure surfaces: the original failure and the machinery introduced to prevent it.

The heuristic is not "use simple solutions." A small-volume system can still have catastrophic consequences. Caliber follows consequence, not scale labels.

## When NOT to Apply

- A binding safety, legal, contractual, or integrity requirement specifies the mechanism.
- The failure creates irreversible harm even once.
- The pattern is already part of a stable platform and adds negligible marginal complexity.
- The task is to implement a decided architecture rather than choose its caliber.
- Quantification would delay an urgent containment action; contain first and calibrate the durable fix afterward.

## Relationship to Pillars

- **Context Calibration:** this heuristic specializes calibration to protection caliber.
- **Compositional Simplicity:** compares pattern complexity at the whole-system level.
- **Harness Over Architecture:** both require evidence before adding machinery.
- **Metric Reification:** guards against turning one observed rate into the frequency term without preserving conditions.
- **Committed Contribution:** requires an explicit proportionality claim rather than ritual invocation of rigor.

## Summary

Before applying high-caliber protection, quantify the concrete failure and the protection's total cost, account for existing mitigation, and choose the cheapest mechanism with acceptable residual risk.
