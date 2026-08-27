---
title: "Harness Over Architecture"
index: "Infrastructure lacks an observed incident, measured omission, or binding requirement → start at the lowest sufficient harness layer."
---

# Heuristic: Harness Over Architecture

## Recognition

This heuristic fires when new agent infrastructure is proposed before the need has been grounded at the level of the current environment.

Two evidence classes can ground a discretionary need:

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

A binding capability or enforcement requirement can separately establish a minimum viable layer without Class A or Class B evidence. That requirement must be explicit, and lower layers must be incapable of satisfying it. Without Class A, Class B, or such a binding requirement, infrastructure is anticipatory architecture.

## Move

1. **Name the failure, omission, or binding requirement precisely.** What behavior or boundary is required, and what evidence establishes it?
2. **Locate the lowest sufficient layer.** Try the least infrastructure that can close the gap.
3. **Run a bounded intervention.** Make the change reversible and define what success would look like.
4. **Observe again.** Keep, revise, or remove the intervention based on actual behavior.
5. **Escalate only on demonstrated insufficiency.** Architecture earns its layer by surviving lower-layer attempts.

A useful escalation ladder:

```text
1. Existing capability used correctly
2. Local instruction or checklist
3. Reusable skill or reference
4. Script, test, or deterministic check
5. Hook or workflow integration
6. Shared service or new application boundary
```

The ladder is not absolute. Skip a lower layer when it cannot satisfy a binding requirement, but state why.

## Failure Modes

- **Documentation theater:** adding prose when the failure is deterministic and mechanically preventable.
- **Skill sprawl:** creating many narrow skills instead of repairing indexing or one shared procedure.
- **Architecture laundering:** calling an unmeasured intuition a "systematic omission."
- **Permanent experiment:** a trial gains no owner or removal condition and silently becomes infrastructure.
- **Layer loyalty:** refusing a necessary service because the heuristic is misread as "never build architecture."

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

## Why This Works

Agent capability is compositional. Clear instructions, targeted context, ordinary tools, and small deterministic helpers often solve a problem without a new system. Architecture introduced too early guesses at the failure shape and creates interfaces, state, maintenance, and failure modes before their value is known.

The measured-omission path matters because "wait for a visible failure" can be too strict. Some failures are silent: absent verification, omitted searches, or systematic undercoverage may appear only in aggregate. The Class B requirements prevent this exception from becoming permission for intuition-driven infrastructure.

The heuristic is therefore evidence-first, not incident-only.

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
- **Coordination Phantom:** removes infrastructure whose collaboration preconditions are absent.
- **Survival Selection:** uses what persists through actual work as stronger evidence than initial architectural intent.
- **Coverage Calibration** and **Metric Reification:** help establish a defensible Class B baseline.

## Summary

Ground new infrastructure in an observed incident, a measured systematic omission, or an explicit binding requirement; start at the lowest sufficient harness layer and escalate only when lower layers cannot satisfy the grounded need.
