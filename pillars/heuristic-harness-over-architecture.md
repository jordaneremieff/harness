---
title: "Harness Over Architecture"
index: "New infrastructure is proposed → ground the need or exploratory question, and use the lowest sufficient layer."
---

# Heuristic: Harness Over Architecture

## Recognition

This heuristic fires when new agent infrastructure is proposed. Ground the decision to construct and distinguish a bounded inquiry from a commitment to continuing operation.

Three evidence classes can ground a discretionary intervention. Classes A and B establish a need; Class C establishes a reason to learn through a usable capability.

### Class A: Observed Incident

- An agent actually failed at the task.
- The failure recurred or had meaningful cost.
- Existing instructions, skills, scripts, and checks were insufficient.
- The proposed mechanism addresses the observed cause rather than a hypothetical future.

### Class B: Grounded Omission

A corpus-level audit or measured local baseline reveals a systematic omission even though no single watched failure supplied the trigger. All of these must hold:

- the baseline is local and reproducible;
- the omission is repeated or structural, not one sparse anecdote;
- a plausible causal path connects the proposed harness change to the omission;
- the intervention is bounded and reversible; and
- an owner, evaluation point, and removal condition are explicit.

### Class C: Grounded Exploratory Question

Some useful behaviour cannot be observed before a capability is available. A bounded capability probe is warranted when all of these hold:

- A concrete action or information access has a credible connection to a current purpose. Relevant experience, an informed observation or a supported account of what the capability enables can supply this connection; prior failure or measured demand is not required.
- An unresolved question about use matters to a named next decision. State what use, interaction or comparison becomes observable through the capability, and why existing capabilities, instructions or a cheaper sketch cannot answer that question. Construction feasibility alone is not this class's warrant.
- Meaningfully different findings change whether the next step retains, revises, removes or expands the capability. Do not require all valuable uses to be predicted, but do not call a demonstration successful regardless of its result.
- Construction and exposure are proportionate to the learning sought. Define the scope, risk and cost bound, responsible evaluator, evaluation point and stopping or removal condition.
- The probe has the required authority. Calling construction an experiment supplies no permission and waives no binding safeguard.

These conditions select an intervention that produces useful evidence, not a guaranteed useful feature. Low cost and reversibility alone are insufficient. Continuing operation or a larger investment requires a fresh decision grounded in the observed use, value and whole cost at that scope, or another applicable warrant or binding requirement. Positive evidence of new value need not be redescribed as a prior failure or omission. Make the decision under the applicable authority; this does not require a second operator approval or a separate evidence dossier. A trial does not silently earn continuing infrastructure.

A binding capability or enforcement requirement can separately establish a minimum viable layer without Class A, B or C evidence. That requirement must be explicit, and lower layers must be incapable of satisfying it. Without one of these grounds, a plausible future use alone does not warrant construction.

## Move

1. Name the failure, omission, exploratory question or binding requirement. State what grounds this decision and whether it concerns learning or continuing operation.
2. Locate the lowest sufficient layer. Check existing capabilities first. Explain why a lower-cost intervention cannot supply the required behaviour or observation.
3. Run the bounded intervention. Preserve the authority and risk limits, make reversal possible where the consequences allow it, and name the result that changes the next decision.
4. Observe actual use and consequences. Keep, revise or remove the intervention on that basis, including useful discoveries outside the initial hypothesis.
5. Reassess before greater commitment. Increase scope or infrastructure only when the evidence or binding requirement justifies that next layer. Do not repeat a lower-layer attempt already shown incapable of satisfying the requirement.

A useful escalation ladder:

```text
1. Existing capability used correctly
2. Local instruction or checklist
3. Reusable skill or reference
4. Script, test, or deterministic check
5. Hook or workflow integration
6. Shared service or new application boundary
```

The ladder is not absolute. Skip a lower layer when it cannot satisfy the grounded need or answer the exploratory question, and state why.

## Failure Modes

- **Documentation theater:** adding prose when the failure is deterministic and mechanically preventable.
- **Skill sprawl:** creating many narrow skills instead of repairing indexing or one shared procedure.
- **Architecture laundering:** calling an unmeasured intuition a "systematic omission."
- **Permanent experiment:** a trial gains no owner or removal condition and silently becomes infrastructure.
- **Layer loyalty:** refusing a necessary service because the heuristic is misread as "never build architecture."
- **Probe laundering:** calling a feature an experiment while no finding can change its adoption, or using a bounded trial to justify an unbounded operational commitment.

## Negotiation

| Situation | Response |
|---|---|
| One ambiguous incident | Improve visibility or instructions; wait for more evidence. |
| Repeated miss caused by discoverability | Improve indexing, trigger language, or a skill. |
| Deterministic transformation repeated across tasks | Use a script or check rather than asking the model to reason it out each time. |
| External authentication or network boundary is required | A service or adapter may be the lowest viable layer. |
| State must be shared across independent runtimes | A durable shared substrate may be warranted. |
| A measured omission has no watched incident | Use the Class B gate and a reversible trial. |
| Safety or compliance requires enforcement | Mechanical enforcement can be justified before a failure, with explicit threat evidence and scope. |
| Useful behaviour is only observable after a capability exists | Use Class C to select an authorised, proportionate probe; do not demand prior use as its warrant. |
| A probe is proposed for a capability that an explicit direction already rejects or constrains | The direction governs. Calling construction a probe does not reopen a settled decision. |

## Why This Works

Agent capability is compositional. Clear instructions, targeted context, ordinary tools, and small deterministic helpers often solve a problem without a new system. Architecture introduced too early guesses at the failure shape and creates interfaces, state, maintenance, and failure modes before their value is known.

The measured-omission path matters because some deficiencies appear only in aggregate. Class B grounds the claimed omission rather than allowing an impression to masquerade as a measured baseline.

The exploratory path matters because existing work reflects existing capabilities. Class C grounds a worthwhile question and the means to answer it without pretending that future benefit is already known. Its limits make the commitment proportionate; they do not guarantee a good idea.

The heuristic distinguishes evidence sufficient to learn from evidence sufficient to retain and expand.

## When NOT to Apply

- A binding security, privacy, or compliance boundary requires mechanical enforcement.
- The capability fundamentally requires authentication, shared state, isolation, scheduling, or network access unavailable at lower layers.
- The mechanism already exists and the task is ordinary maintenance rather than speculative construction.
- A repeated or high-cost failure has demonstrated lower-layer insufficiency.
- A Class B intervention satisfies the full gate and is explicitly experimental.

## Relationship to Pillars

- **Compositional Simplicity:** evaluates whether the proposed layer reduces total system work.
- **Context Calibration:** tests whether the architecture is inherited from a different scale or operating context.
- **Failure Cost Calibration:** matches mechanism caliber to real consequence.
- **Proof Burden:** examines discretionary evidence conditions without substituting cheap reversibility for a grounded need or exploratory question.
- **Coordination Phantom:** removes infrastructure whose collaboration preconditions are absent.
- **Survival Selection:** uses what persists through actual work as stronger evidence than initial architectural intent.
- **Coverage Calibration** and **Metric Reification:** help establish a defensible Class B baseline.

## Summary

Ground new infrastructure in an observed incident, a measured omission, a worthwhile question that requires a usable capability, or a binding requirement. Use the lowest sufficient layer. Decide separately what warrants learning, continued operation and greater commitment.
