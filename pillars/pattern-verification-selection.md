---
title: "Verification Selection"
index: "Verification receives its scope and lifetime from the useful evidence or meaningful protection it supplies, assessed against total lifecycle cost."
---

# Pattern: Verification Selection

## Intent

Verification receives its scope and lifetime from the useful evidence or meaningful protection it supplies, assessed against total lifecycle cost.

Select verification for the decision or contract it serves. Decide separately what to investigate now, what to retain, what establishes acceptance, what deserves repeated sampling, and what needs repair or removal.

## Problem

Verification can outlive its purpose or repeat without resolving a new uncertainty. A useful reproduction becomes permanent scaffolding by default. A new agent or milestone repeats an unchanged gate. An obsolete assertion turns correct behaviour into a failure. A passing sample becomes a reliability claim it cannot support.

The opposite errors also matter: cheap checks replace the evidence layer that owns the claim, earlier evidence is reused after relevant conditions change, or cost language excuses a necessary safeguard.

## Solution

Use these functions together. They are decisions, not mandatory phases, forms or staffing roles.

| Purpose | Selection question | Lifetime |
|---|---|---|
| Present investigation | What unresolved fact changes the next decision? | Until the question is answered, narrowed or honestly blocked. |
| Permanent regression protection | What plausible future defect does this detect, and is that protection worth its continuing cost? | While the contract and meaningful protection remain. |
| Final acceptance | What establishes the relevant candidate under its actual acceptance conditions? | For that candidate and execution basis. |
| Deliberate repeated sampling | What consequential variation or execution error does another observation test? | Until sufficient evidence supports the bounded claim or a stated limit stops the inquiry. |
| Repair or retirement | Does the verification still represent the contract and observe it correctly? | Repair, replace, consolidate or remove it when its useful role changes. |

Apply the following procedure at a material selection or reassessment:

1. **Name the decision, contract and authority.** Distinguish a requirement imposed by the operator or another binding constraint from a discretionary check. Ordinary execution follows binding requirements. Review or change those requirements only under the authority that owns them; do not silently waive them because a cheaper policy seems preferable.
2. **Examine available evidence first.** Reuse observations that reach the claim and remain applicable. Check the relevant candidate, dependencies, configuration, environment, fixtures, instrumentation and execution conditions. Consider only differences material to the claim. A new agent or workflow milestone does not itself invalidate evidence. Identical source does not itself establish unchanged execution conditions. When a material validity condition is unresolved, obtain proportionate evidence or leave the dependent conclusion open.
3. **Choose sufficient verification.** Select the source layer, cases and method that resolve the material uncertainty or protect the contract. Existing evidence may suffice. Broader or more expensive verification is warranted when interactions, uncertainty or consequences require it. Several cheap proxies do not replace the layer that owns the claim. Include creation, execution, maintenance, false alarms, retained scaffolding, delay and human attention in lifecycle cost.
4. **Run or sample for a reason.** Obtain useful development feedback when it affects the work. Give final acceptance an owner for the relevant candidate and execution basis; examine composition and interactions not established by local results. Repeat when relevant changes invalidate evidence, when an execution was defective, or when deliberate sampling addresses consequential variation. Select the sampling question and stopping basis before interpreting favourable results. Do not retry until a pass or discard adverse results to manufacture confidence.
5. **Treat verification as fallible.** Compare an unexpected result with the governing contract and the observation method. Assertions, fixtures, mocks, selectors and environments can be wrong. Correct or replace defective verification; consolidate duplicates or remove obsolete checks while preserving valid protection. Do not distort correct behaviour to satisfy an invalid assertion, weaken a valid assertion to hide a defect, or suppress a genuine failure to obtain a pass. An unexplained failure remains unresolved, not accepted.
6. **Stop at a meaningful boundary.** Stop when applicable evidence settles the bounded decision or further inquiry has sharply diminishing decision value. Obtain readily available, proportionate facts rather than transfer avoidable work to another person. If a necessary fact remains unknown, state it and narrow the claim or hold the dependent act. Stopping does not supply the missing fact, establish completion or authorise guessing.
7. **Choose what survives.** Keep a disposable reproduction separate from a permanent test asset. Retain verification when its expected future detection value warrants its execution and maintenance cost; demonstrated past failures are useful evidence, not a prerequisite for protecting a plausible consequential defect. Preserve supported protections, and reassess those affected by changed contracts, defects or recurring cost. No per-test paperwork, compulsory ledger or recurring approval ceremony is required. Use existing context and results; add a concise explanation only when the decision, dispute or handoff needs it.

## Evidence Validity and Stopping

A pass establishes the observed result within its source layer, scope and conditions. It does not establish that the assertion is correct, that unexamined interactions work, or that a variable system is reliable.

Source inspection, a controlled execution, an integrated load check and experienced acceptance answer different questions. Preserve the boundaries of each. Review challenges the contract and evidence; repeating the author's commands alone does not establish independent confirmation.

For variable behaviour, choose cases and repetitions for the variation that matters. Repeated same-condition observations provide evidence of stability under those conditions, not independent facets or universal reliability. Set a proportionate limit, preserve consequential failures and narrow claims when the sample does not support them.

A stopped inquiry can end in proceed, revise, reject, narrow or hold. A required acceptance condition that remains unmet still blocks acceptance. A cheap rollback does not reverse disclosure, external effects or every loss of state.

## Implements

- **Compositional Simplicity:** counts verification cost across creation, consumers, repeated execution and maintenance instead of optimising one check.
- **Epistemological Grounding:** ties each claim and disputed assertion to the source that owns its exact contract or observed facet.
- **Cognitive Stratification:** separates disposable investigation from retained protection rather than promoting scaffolding by accident.

## Relationship to Other Pillars

- **Proof Burden** examines discretionary evidence prerequisites across adoption, retention, replacement and exploration. This pattern arranges verification's purposes and lifetime; it does not replace that broader judgment.
- **Failure Cost Calibration** compares consequences and protection cost, including supported qualitative consequences. This pattern applies that comparison throughout verification work.
- **Verification Reach** tests whether evidence reaches a particular claim. This pattern selects, reuses and retires the work that supplies it.
- **Grounding Preflight** checks the facets needed for a consequential conclusion. This pattern selects sufficient evidence without making every facet a compulsory check.
- **Investigation Persistence** obtains proportionate available facts and preserves necessary unknowns. This pattern connects that inquiry to retention, acceptance and stopping.
- **Redundant Corroboration** distinguishes independent evidence from repeated samples and guides review variation.
- **Metric Reification** preserves measurement conditions. A coverage percentage or success rate does not independently establish meaningful protection or reliability.

## Trade-offs and Failure Conditions

Selection adds judgment and relinquishes some opportunities for incidental discovery through repetition. Conservative broad checks remain appropriate where relevant effects are uncertain or failure consequences demand them. Cheaper is not sufficient when it misses the claim.

The pattern fails if cost becomes an excuse to ignore necessary evidence, unchanged files become a universal validity certificate, every selection becomes paperwork, or a failing check is removed without examining the contract and lost protection.

## Worked Example

A focused reproduction establishes that a repaired adapter handles a malformed response. Keep it disposable if an existing maintained test already protects that contract. Otherwise retain the smallest useful regression case when its expected future value warrants its cost.

Before release, the acceptance owner examines the composed candidate and remaining interaction gaps. The earlier result remains usable where its conditions still hold. A newly changed dependency requires renewed evidence for the effects it invalidates. A change of reviewer alone does not.

## Summary

Select verification for useful evidence or meaningful protection across its whole lifetime. Reuse applicable evidence, repair mistaken checks, retain worthwhile protection and stop without concealing necessary unknowns. Preserve binding requirements until authorised changes replace them.
