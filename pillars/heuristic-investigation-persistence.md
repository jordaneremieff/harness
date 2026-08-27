# Heuristic: Investigation Persistence

## Recognition

This heuristic fires when you reach a knowledge boundary, are about to ask or guess, and available tools or adjacent sources could still close the gap.

Cues:

- The first search returned nothing and is being treated as exhaustion.
- A "questions for you" section contains facts available in repositories, records, telemetry, documentation, or system queries.
- One tool failed, but alternative formulations, source classes, or access paths remain.
- A conclusion is being filled from training knowledge after an ambiguous lookup.
- Escalation does not state what was tried.

## Move

1. **Name the exact gap.** Separate the unknown fact from the decision it affects.
2. **Inventory available paths.** Repository search, local history, registered tools, data stores, documentation, runtime evidence, adjacent systems, and source variants.
3. **Try the highest-value path.** Prefer sources that directly own the fact.
4. **Alternate intelligently.** Change query terms, identifiers, time windows, source layer, or navigation path when the first attempt fails.
5. **Track reach and coverage.** A tool success may still be a proxy or a small sample.
6. **Stop on structural exhaustion.** Escalate with what was tried, what each path established, and the smallest remaining question.

A good escalation:

```text
I need the active schema version to choose the migration path. I checked the
repository manifest, deployment record, and runtime metadata. The first two are
stale and runtime access is unavailable. Which version is currently deployed?
```

## Negotiation

| Situation | Response |
|---|---|
| The operator can answer instantly but investigation is expensive | Ask, especially when the question is preference or intent rather than fact. |
| One authoritative source directly owns the fact | Use it before broad search. |
| Tools are unavailable or access is denied | State the structural gap and ask. |
| Investigation risks changing state | Stay read-only or obtain authorization. |
| The decision is reversible and uncertainty is minor | Proceed with an explicit assumption. |
| The claim is consequential | Persist across source classes and verify reach. |
| Further search has sharply diminishing value | Stop and explain the remaining uncertainty. |

Persistence is not endlessness. It ends when available paths are structurally exhausted or further evidence would not change the decision.

## Why This Works

The first failed query often reflects vocabulary, indexing, scope, or source choice rather than absence. Agents also learn a cooperative response shape in which asking the person feels safer than continuing to investigate. That transfers avoidable factual work back to the person and leaves tool access unused.

Explicitly naming the gap and search paths creates a stopping rule. It prevents both premature escalation and unbounded wandering.

## When NOT to Apply

- The unknown is a preference, priority, authorization, or intent only the operator can supply.
- Available investigation would be unsafe, destructive, or out of scope.
- Access is structurally unavailable.
- The question is cheap for the operator and expensive to infer reliably.
- The decision can proceed safely under a clearly stated reversible assumption.

## Relationship to Pillars

- **Verification Reach:** checks whether each investigated source reaches the claim.
- **Coverage Calibration:** prevents one successful path from standing in for a large universe.
- **External Verification:** identifies when the unresolved fact belongs to a moving external dependency.
- **Comprehension Checkpoint:** turns broad reading into a concrete gap model.
- **Committed Contribution:** permits a scoped conclusion after honest exhaustion instead of evasive hedging.

## Summary

Before asking or guessing at a factual gap, name it, try the available source-owning paths and meaningful alternatives, then escalate only with a concrete account of structural exhaustion.
