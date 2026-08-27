# Pattern: Grounding Preflight

## Intent

Before presenting a consequential conclusion, verify that the evidence reaches the claim, covers the required facets, and leaves gaps visible.

## Problem

A coherent explanation can be assembled from the easiest available source even when the claim belongs to another facet of reality.

Common mismatches:

- operational conclusions based only on conversation history;
- current-state conclusions based only on plans;
- execution claims based only on code or documentation;
- negative claims based only on an index or search result; and
- causal claims based on one correlated metric.

## Solution

For the claim, map required and reached facets:

| Facet | Question | Typical source class |
|---|---|---|
| Decision | What was agreed or rejected? | Decision record, meeting record, conversation channel |
| Intent | What was planned, assigned, or prioritized? | Work tracker, roadmap, task record |
| Enactment | What was implemented or configured? | Repository, configuration record, migration history |
| Documentation | What is described as the intended or supported behavior? | Knowledge base, specification, runbook |
| Execution | What actually happened? | Runtime telemetry, data state, direct observation |

Then ask:

1. Which facets does this exact claim require?
2. Which were actually checked?
3. Did each check reach a defining source or only a proxy?
4. Is coverage within each facet sufficient?
5. Which gaps block the conclusion, and which only limit scope?
6. What specific check would close each load-bearing gap?

## Implements

- **Epistemological Grounding:** identifies the defining source or proxy boundary for each required facet.
- **Triangulated Truth:** distinguishes complementary facet coverage from repeated evidence within one facet.
- **Committed Contribution:** turns the evidence state into a bounded conclusion rather than unsupported confidence or an evasive non-answer.

## Worked Example

```text
Claim:
  "The job failed because queue saturation delayed workers."

Required:
  execution timing and queue state; enacted worker configuration

Reached:
  conversation mentions saturation; configuration shows a low concurrency cap

Missing:
  execution telemetry tying queue growth to the failure window

Output:
  plausible hypothesis, not confirmed cause; name the missing check
```

## Output Forms

### Grounded

```text
Execution and enactment evidence agree: queue depth rose sharply during the
failure window, and the active worker configuration imposed a low concurrency
limit. The historical reason for that limit was not found.
```

### Preliminary

```text
Queue saturation is plausible from the configuration and incident discussion,
but execution telemetry was unavailable. Treat this as a hypothesis until the
failure window can be inspected directly.
```

### Blocked

```text
The reached sources establish intended configuration, not runtime cause. I
cannot verify the cause without execution evidence.
```

## Anti-Patterns

### Coherent Story From the Wrong Facet

A discussion says the system was slow. The conclusion names a runtime cause without runtime evidence.

### Search Result as Source

An index says a resource exists. The conclusion describes its current contents without fetching it.

### Repository State as Deployment State

A value exists in source control. The conclusion assumes that value was active in the environment under discussion.

### Documentation as Current Reality

A runbook describes a workflow. The conclusion assumes current implementation and execution match it.

### False Baseline

A comparison assumes a configuration, version, or cohort was in force without verifying the baseline itself.

## Trade-offs

Not every claim needs every facet. A source-state question may be settled by the repository alone. A decision-history question may not need execution. The pattern's job is to identify what the claim requires, not to mandate a ritual checklist.

For low-cost reversible choices, a preliminary conclusion may be sufficient. For hard-to-reverse or high-impact decisions, close the load-bearing gaps.

## Checks Within the Preflight

- **Verification Reach:** checks whether a particular observation reaches the claim's subject.
- **Coverage Calibration:** checks whether enough of the chosen source layer was examined.
- **External Verification:** locates current primary evidence for changeable external behavior.
- **Metric Reification:** preserves measurement conditions before a number supports a system claim.

## Checklist

```text
Claim requires: <facets>
Reached: <sources and scope>
Missing: <gaps>
Coverage: <bounded account>
Disposition: grounded / preliminary / blocked
Next check: <specific evidence>
```

If evidence does not reach the claim, change the claim or obtain the evidence. Do not merely add confident-sounding caveats.

## Summary

Grounding Preflight compares the facets and source layers a conclusion requires with those actually reached, then makes the result grounded, preliminary, or blocked without letting narrative coherence substitute for evidence.
