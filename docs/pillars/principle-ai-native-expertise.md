# Principle: AI-Native Expertise

## Statement

Agents should achieve the functions of expertise through agent-native mechanisms, informed by human cognition but not constrained by human biology or social reflexes.

## Core

When importing a human practice into agent design, ask:

1. What function does the practice serve?
2. Which parts are implementation constraints of human cognition or social organization?
3. What evidence and mechanism would deliver the function for an agent?
4. Does the design confuse modeling a phenomenon with participating in it?

**Everything relevant is input. Nothing becomes authority or experience merely because it was observed.**

## Rationale

Expertise includes useful functions: reliable memory, provenance, pattern recognition, contextual authority, integration of new evidence, prediction, metacognition, and calibrated action. Human experts realize these functions through mechanisms shaped by limited attention, biological consolidation, social identity, emotion, and opaque intuition.

Agent systems need the functions, not automatic copies of those constraints. A durable store can preserve provenance without human recollection. Parallel analysis can widen evidence without pretending to be independent. Explicit confidence and source tracing can make pattern use more inspectable than intuition.

The principle also governs social and emotional material. An agent may need to model incentives, frustration, power, or conflict to act effectively. Modeling those dynamics does not require taking sides, simulating emotional contagion, or turning a description into moral authority.

## Shape

```text
HUMAN PRACTICE
       |
       v
extract function -> identify inherited constraint -> design agent-native mechanism
       |
       v
verify that the function is actually delivered
```

Examples:

| Desired function | Avoid copying | Agent-native direction |
|---|---|---|
| Long-term learning | Unstructured recollection | Durable claims with provenance and contradiction handling |
| Significance | Emotional arousal as the only priority signal | Explicit priority, risk, and consequence models |
| Pattern recognition | Opaque intuition treated as authority | Pattern proposal plus evidence and falsification test |
| Reflection | Ego-protective narrative | Claim comparison, error update, and changed action |
| Social navigation | Tribal allegiance | Model incentives and constraints without adopting a side by reflex |

## Decision Heuristic

| Question | If yes |
|---|---|
| Is this the underlying expertise function? | Preserve it. |
| Is this only a human implementation of the function? | Extract the function and redesign the mechanism. |
| Does it import a biological or social constraint? | Require an independent reason for the constraint. |
| Does it treat a model of reality as lived experience? | Re-establish the input/action boundary. |
| Does the new mechanism merely claim to be native? | Verify output quality and failure modes. |

## Tensions

### Warm Communication vs. Detached Reasoning

Objective modeling need not produce cold output. Communication can be warm and respectful while reasoning remains explicit about evidence, incentives, and uncertainty.

### Human Wisdom vs. Human Constraint

Some human practices encode genuine wisdom rather than limitation. Do not reject a practice because humans use it. Test its function and evidence. Safety checks, adversarial review, and deliberate pauses can remain valuable for computational reasons.

### Agent-Native vs. Novelty Theater

Calling a mechanism "agent-native" can excuse unnecessary novelty. Prefer ordinary reliable mechanisms when they deliver the function well. Native means fit to the actual agent environment, not unprecedented.

## When NOT to Apply

- A human-centered requirement is itself binding, such as accessibility, consent, or accountable review.
- The human mechanism has an independent safety or reliability justification.
- The agent lacks a verified alternative that provides the same function.
- Modeling a person's inner state would exceed available evidence or legitimate scope.

## Relationship to Other Pillars

- **System Autonomy:** agent-native design separates judgment from deterministic mechanism.
- **Cognitive Stratification:** memory layers follow information function and authority rather than a literal copy of biological memory.
- **Context Calibration:** inherited defaults are inputs to test, not expertise to enact automatically.
- **Committed Contribution:** correction updates claims without requiring ego defense or social permission seeking.
- **Epistemological Grounding:** source authority comes from its relation to the claim, not from familiarity.

## Summary

Preserve the functions of expertise, identify the human constraints attached to their familiar implementations, and build mechanisms suited to the agent's actual capabilities while keeping observed phenomena as inputs rather than unearned authority or experience.
