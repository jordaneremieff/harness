---
title: "Redundant Corroboration"
index: "Similar evaluators converge and count is cited as independence → treat them as samples from one posterior."
---

# Heuristic: Redundant Corroboration

## Recognition

This heuristic fires when several evaluators converge and their count is being cited as evidence of independent confirmation, even though they share substantial epistemic substrate.

Shared substrate can include:

- the same model family or training distribution;
- the same briefing, facts, omissions, and framing;
- the same rubric and requested output shape;
- the same tools or inaccessible sources;
- the same orchestrator's decomposition and premises; and
- mutual visibility of prior conclusions.

Separate execution contexts create procedural separation. They do not by themselves create epistemic independence.

## Move

1. **Inventory shared substrate.** State what all evaluators received or could not access.
2. **Classify the convergence.** Call similar same-brief outputs samples from one posterior, not independent facets.
3. **Ask for a common-mode falsifier.** What fact, omitted axis, or framing error could make every evaluator wrong at once?
4. **Diversify deliberately when needed.** Vary source facet, model family, framing, rubric, or evidence access.
5. **Use count for stability, not truth.** Repeated same-condition answers can show response consistency.
6. **Reopen on new input.** Never dismiss evidence absent from the original briefing because many evaluators agreed before seeing it.

Example:

```text
Four reviewers chose the same option from the same fact table and comparison
rubric. This shows the recommendation is stable under that briefing. It does not
show that the briefing covered ecosystem risk. Add a reviewer with independent
source access and an explicit common-mode challenge before calling it corroborated.
```

## Independence Dimensions

| Dimension varied | What it can add |
|---|---|
| Source facet | Evidence about a different part of reality |
| Fact base | Protection from common omissions |
| Framing or role | Exposure of hidden premises and neglected criteria |
| Model family or method | Reduction in shared reasoning tendencies |
| Time or system state | Evidence about change and temporal stability |
| Direct reproduction | Ground truth beyond evaluator opinion |

Varying only wording or random seed adds sample diversity, not a new evidence facet.

## Negotiation

| Situation | Interpretation |
|---|---|
| Repeated factual checks hit the same authoritative source directly | They can corroborate observation reliability, though source error remains common-mode. |
| The request explicitly asks for redundant sampling | Report stability under the shared conditions. |
| Reviewers use genuinely different evidence facets | Triangulation may be justified. |
| One evaluator sees all prior outputs | Treat it as synthesis, not independent review. |
| A safety-critical decision is involved | Require meaningful diversity and direct evidence, not evaluator count. |
| Multiple reviewers find no issue | Useful as a bounded probe result, not proof of absence. |

## Why This Works

Agreement feels objective because separate outputs resemble independent witnesses. In ensemble reasoning, however, error reduction depends on diversity. Shared weights, briefings, rubrics, and blind spots create correlated error.

The inventory step makes correlation visible. The common-mode question shifts review from "how many agree?" to "what could all of them be missing?" This preserves the useful role of redundant samples: they measure stability and may expose stochastic variance, but they do not manufacture new facts.

## When NOT to Apply

- Evaluators independently observed distinct authoritative sources or facets.
- The claim concerns consistency under one fixed prompt rather than truth about the world.
- Redundancy is being used to catch transcription or execution error, with that purpose stated.
- A single direct measurement already settles the bounded factual question and reviewers merely verify procedure.

## Relationship to Pillars

- **Triangulated Truth:** distinguishes facet diversity from multiple sources on one facet.
- **Epistemological Grounding:** source authority matters more than reviewer count.
- **Coverage Calibration:** several reviewers can all inspect the same small fraction.
- **Verification Reach:** reviewers sharing one proxy share its reach boundary.
- **Committed Contribution:** synthesis must own the final judgment rather than outsource it to a vote.

## Summary

When similar evaluators agree, inventory what they share and treat convergence as stability under one briefing unless evidence, framing, or method genuinely varies. Count is not independence.
