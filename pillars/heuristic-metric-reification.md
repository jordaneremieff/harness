# Heuristic: Metric Reification

## Recognition

This heuristic fires when:

1. A summary statistic was computed from observational data: rate, average, percentile, ratio, error percentage, or success count.
2. The number is about to become a property of the system rather than a description of the measurement.
3. Measurement conditions have fallen out of the sentence.

Common escalation cues are that the number is becoming load-bearing for a forecast or design decision, or that a challenge to its interpretation is answered by repeating the arithmetic instead of testing confounds. Neither cue must occur before the heuristic fires.

The linguistic shift is diagnostic:

```text
Observed: "During this run, completed work averaged 50 items per minute."
Reified:  "The service runs at 50 items per minute."
```

The calculation may be exact while the second claim is false.

## Move

1. **Bind the number to its observation.** Include window, cohort, configuration, load, warm-up state, exclusions, and relevant failures.
2. **Separate arithmetic from interpretation.** State what was computed and then the system claim someone wants it to support.
3. **Enumerate confounds.** Ask what else could have produced the number.
4. **Test load-bearing confounds.** Vary conditions, stratify the data, inspect raw events, or obtain an independent measurement.
5. **Use a range or conditional model when appropriate.** Do not force one point estimate to carry heterogeneous conditions.
6. **Defend the interpretation.** Explain why the surviving evidence supports the system claim, not merely why numerator divided by denominator equals the result.

## Measurement Context Checklist

- Observation window and censoring
- Warm-up, cooldown, and transient recovery periods
- Client-side or server-side throttles
- Error and retry windows
- Cohort or workload heterogeneity
- Concurrency and queue depth
- Cache state
- Missing or dropped events
- Instrumentation changes
- Selection criteria and exclusions
- Whether denominator and numerator cover the same population

Not every item matters. The task is to identify which could change the decision.

## Example

Suppose a batch completed 9,000 items over three hours, yielding an observed average of 50 per minute. That number does not by itself establish a stable capacity. The run may have included a configured ceiling, intermittent retries, mixed item sizes, and a truncated final interval.

A defensible statement could be:

> In the observed three-hour run, the end-to-end completion rate averaged 50 items per minute under the configured limit and mixed workload. The data does not isolate dependency latency from local throttling, so do not use this observation as a stable planning capacity until a controlled run varies those factors.

A range is not automatically better than a point estimate. Its bounds need measurement support; identified confounds justify uncertainty, not invented precision.

## Negotiation

| Situation | Response |
|---|---|
| Descriptive report only | Keep the number bound to the observed window. |
| Forecast or capacity decision | Test conditions and use a model or range. |
| Homogeneous controlled experiment | A point estimate may be defensible with error bounds. |
| Confounds are immaterial to the decision | Name them briefly and explain why they do not bind. |
| Data is sparse | Avoid precision theater; state limits and collect more evidence if consequential. |
| Statistic is defined contractually | Preserve the definition, but do not infer a causal property it does not measure. |

## Why This Works

Aggregation removes context by design. That compression is useful for description and dangerous for causal or capacity claims. Once the conditions disappear, readers treat the number as portable across loads, cohorts, and times that were never observed.

Agents are especially vulnerable because arithmetic is easy to verify and therefore feels like the hard part. The hard part is metrological: deciding what the measurement represents.

## When NOT to Apply

- The statement is explicitly limited to the observed dataset and no system inference follows.
- The metric is a direct definition rather than an empirical estimate.
- A complete controlled experiment already isolated the relevant variables.
- One exact event count, not an aggregate interpretation, answers the question.

## Relationship to Pillars

- **Grounding Preflight:** its False Baseline mode checks whether the assumed conditions were actually in force; Metric Reification checks whether observational conditions survived aggregation.
- **Coverage Calibration:** asks whether enough of the population or time surface was examined.
- **Triangulated Truth:** independent telemetry and configuration facets can separate competing explanations.
- **Failure Cost Calibration:** determines how much measurement rigor the decision warrants.
- **Harness Over Architecture:** measured systematic omissions can support a grounded intervention only when the baseline is interpreted rather than reified.

## Summary

Keep statistics attached to their measurement conditions, distinguish computation from system interpretation, test load-bearing confounds, and defend what the number represents rather than how it was calculated.
