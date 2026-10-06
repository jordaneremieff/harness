---
title: "Redundant Corroboration"
index: "Agreement is cited as independent confirmation, or a reviewer is chosen to provide it → inventory shared substrate and vary the check where needed."
---

# Heuristic: Redundant Corroboration

## Recognition

This heuristic fires when several evaluators converge and their count is being cited as evidence of independent confirmation, even though they share substantial epistemic substrate.

It also fires when a reviewer or challenger is being chosen to provide independent confirmation, or its agreement is being used as that confirmation, for example a reviewer picked because its model family differs from the author's. An ordinary review that makes no independence claim does not trigger this extension.

Shared substrate can include:

- the same briefing, facts, omissions, and framing;
- the author's justification or other evaluators' verdicts, read before the evaluator forms its own judgment;
- mutual visibility of prior conclusions;
- the same rubric and requested output shape;
- the same tools or inaccessible sources;
- the same orchestrator's decomposition and premises; and
- the same model, model family, or training distribution.

Separate execution contexts create procedural separation. They do not by themselves create epistemic independence. A reviewer from another model family still shares whatever input it was given, and a reviewer from the author's family can still find what the author missed.

## Move

1. **Inventory shared substrate.** State what the author and the evaluators received, read first, or could not access.
2. **Classify agreement when results exist.** Call similar same-brief outputs samples from one posterior, not independent facets.
3. **Ask for a common-mode falsifier.** What fact, omitted axis, or framing error could make the author and every evaluator wrong at once?
4. **Vary the check where needed.** Choose the variation in evidence access, question or method, reading order, or model similarity that can expose that failure, as [Choosing a Reviewer](#choosing-a-reviewer) describes. Not every dimension needs to differ.
5. **Ground each finding in evidence that reaches its claim.** Check bounded factual claims against their defining source or an appropriate reproduction. For interpretation, missing requirements, or trade-offs, state the criteria, supporting evidence, and unresolved judgment. Retain, reject, or qualify the finding on that basis, not on who raised it or how many agreed.
6. **Use count for stability, not truth.** Repeated same-condition answers can show response consistency.
7. **Reopen on new input.** Never dismiss evidence absent from the original briefing because many evaluators agreed before seeing it.

Example:

```text
Four reviewers chose the same option from the same fact table and comparison
rubric. This shows the recommendation is stable under that briefing. It does not
show that the briefing covered ecosystem risk. Add a reviewer with independent
source access and an explicit common-mode challenge before calling it corroborated.
```

## Choosing a Reviewer

Decide what error or uncertainty the review must expose, then choose the capability, evidence access, and variation that can expose it. Scale the effort to the consequence of a missed error; these considerations are not a fixed protocol or a certificate of independence. For a bounded routine factual check, a capable reviewer and a sufficient check at the defining layer can be enough.

- **Reading order.** Supply the purpose, criteria, restrictions, dependencies, and evidence access that the check needs. Where practical, have the reviewer derive its initial expectations or checks before it reads the author's justification or earlier verdicts; a reviewer that reads a candidate answer first can repeat its mistake. When the review must examine that reasoning or an existing objection, the reviewer reads it, states the exposure, and asks for claim-specific evidence rather than agreement.
- **Question or method.** A different question can expose an omitted case or a hidden premise; an independent derivation or a different method can test the same question. Choose the variation that addresses the suspected shared failure, not a new question for its own sake, and state which premises remain shared.
- **Evidence access.** Let the reviewer inspect the layer that defines or directly observes each factual claim, such as the source, an execution, or the actual consumer, rather than the author's account of it. State access and coverage limits.
- **Capability.** Choose task-specific ability to discover the relevant defects and to substantiate findings. Capability and independence are separate: variation from another model family does not make up for inability to perform the check. Verify findings from every reviewer. A capable reviewer that refines another review inspects the artifact and evidence, not only the list of findings; refinement does not establish that omitted defects were found.
- **Similarity.** Model similarity warns of shared errors and evaluation preferences; it does not test whether a finding is true. The relevant similarity is in answers and mistakes on the task: a shared model family is one clue, and capable models from different families can also share errors. Weigh task-relevant differences where a judgment lacks a reliable reference or test, such as grading quality or choosing among options, and where consequential defects could remain undiscovered, because checking the findings that were raised does not establish coverage of those that were not. Keep the capability that the check needs. A capable reviewer from the author's family can contribute useful checks; its agreement still shares the family's tendencies.

Example:

```text
A coordinator chose a challenger from another model family so that a design
would not be checked only by models like its author. The challenger read the
same proposal and incident reports, and several of its objections overstated
the evidence. A capable reviewer from the author's own family checked them
against the reports, the governing constraints, and the source code, narrowed
or rejected the overstated parts, and found gaps that the challenger had missed.
The family difference had not made the challenge independent of its input, and
the shared family had not kept the reviewer from new findings.
```

## Independence Dimensions

| Dimension varied | What it can add |
|---|---|
| Source facet | Evidence about a different part of reality |
| Fact base | Protection from common omissions |
| Framing or role | Exposure of hidden premises and neglected criteria |
| Reading order | Protection from anchoring on the author's answer or earlier verdicts |
| Method | A different check of the same claim |
| Model similarity | Possibly different errors and evaluation preferences; a family label alone does not establish the difference |
| Time or system state | Evidence about change and temporal stability |
| Direct reproduction | Ground truth beyond evaluator opinion |

Varying only wording or random seed adds sample diversity, not a new evidence facet. Capability is separate from independence: it affects which defects a reviewer can discover and how well it substantiates them, and it cannot be inferred from the number of findings retained.

## Negotiation

| Situation | Interpretation |
|---|---|
| Repeated factual checks hit the same authoritative source directly | They can corroborate observation reliability, though source error remains common-mode. |
| The request explicitly asks for redundant sampling | Report stability under the shared conditions. |
| Reviewers use genuinely different evidence facets | Triangulation may be justified. |
| A reviewer has seen prior verdicts | Its agreement is not independent confirmation of those verdicts. Distinguish inherited evidence and synthesis from newly performed checks, and state the dependencies those checks still share. |
| A reviewer from the author's model family performs a needed check | Evaluate its findings on their evidence; its agreement still shares the family's tendencies and any shared input. |
| A review raises uncertain or overstated objections | Treat them as leads; check the relevant evidence or obtain a capable refinement before disposition, without assuming the reported set covers all important defects. |
| No reliable reference or test settles a judgment, such as grading quality or choosing among options | Prefer a capable reviewer with task-relevant differences, make the criteria explicit, or add a reference or test; agreement alone is not independent confirmation. |
| A safety-critical decision is involved | Require meaningful diversity and direct evidence, not evaluator count. |
| Multiple reviewers find no issue | Useful as a bounded probe result, not proof of absence. |

## Why This Works

Agreement feels objective because separate outputs resemble independent witnesses. In ensemble reasoning, however, error reduction depends on diversity. Shared weights, briefings, rubrics, and blind spots create correlated error.

Shared input sets the limit of what agreement can show: evaluators who read only the same brief and artifact cannot establish that its coverage is complete unless they reach beyond it. Model similarity adds a tendency, not a limit. It raises the risk of shared mistakes and of favoring familiar output, and it bears on what reviewers miss as well as on what they approve. A decisive source check can settle a bounded factual claim; design objections and interpretations still need explicit criteria and visible uncertainty.

The inventory step makes correlation visible. The common-mode question shifts review from "how many agree?" to "what could all of them be missing?" This preserves the useful role of redundant samples: they measure stability and may expose stochastic variance, but they do not manufacture new facts.

## When NOT to Apply

- Evaluators independently observed distinct authoritative sources or facets.
- The claim concerns consistency under one fixed prompt rather than truth about the world.
- Redundancy is being used to catch transcription or execution error, with that purpose stated.
- A single direct measurement already settles the bounded factual question and reviewers merely verify procedure.

## Relationship to Pillars

- **Triangulated Truth:** distinguishes facet diversity from multiple sources on one facet.
- **Epistemological Grounding:** source authority matters more than reviewer count, within the exact facet that the source defines.
- **Coverage Calibration:** several reviewers can all inspect the same small fraction.
- **Verification Reach:** reviewers sharing one proxy share its reach boundary.
- **Governing Context:** preserve the frame needed to judge and integrate the work; sequence exposure to prior conclusions where practical rather than remove necessary reasoning.
- **Failure Cost Calibration:** the consequence of a missed error sets how much review variation is worth.
- **Committed Contribution:** synthesis must own the final judgment, including unresolved gaps, rather than outsource it to a vote.

## Summary

When similar evaluators agree, inventory what they share and treat convergence as stability under one briefing unless evidence, framing, or method genuinely varies. Choose reviewers for the failure they can expose and their ability to perform the check, and weigh shared model tendencies both where judgment lacks a decisive check and where important defects could remain undiscovered. Count is not independence, and a finding earns support from the evidence that reaches its claim.
