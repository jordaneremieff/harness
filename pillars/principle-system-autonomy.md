---
title: "System Autonomy"
index: "Agents express intent; systems fulfill it autonomously."
---

# Principle: System Autonomy

## Statement

Agents should express intent while systems absorb deterministic mechanism. Reserve agent reasoning for ambiguity and judgment.

## Core

For each step in an agent-facing workflow, ask:

| Question | Owner |
|---|---|
| Does the choice require understanding goals, trade-offs, or ambiguous evidence? | Agent |
| Is the step a deterministic prerequisite or invariant? | System |
| Could forgetting the step produce avoidable failure? | System |
| Is this an exceptional override rather than normal flow? | Optional agent control |

The autonomy boundary should make the common correct path require intent, not orchestration.

## Rationale

Agent context and attention are finite. Every prerequisite the agent must discover, remember, and order competes with reasoning about the actual task. Deterministic orchestration also creates failure modes with no corresponding decision value.

A system can usually manage indexing, freshness, caching, normalization, retries, resource resolution, and other mechanical prerequisites more reliably than an agent can remember them. The agent should decide what outcome is wanted and which ambiguity matters. The system should execute the known path.

## Shape

```text
INTENT LAYER
  "Find material about authentication in this repository."
        |
        v
AUTONOMY BOUNDARY
  declarative request; optional explicit overrides
        |
        v
MECHANISM LAYER
  resolve target -> prepare state -> refresh if needed -> query -> normalize
```

Observability may cross upward. Orchestration responsibility should not.

## Manifestations

### Exposed Prerequisites

```text
resolve target
check local state
initialize missing state
refresh stale state
run query
```

If every request needs the first four steps, exposing them as required agent calls turns workflow into fragile reasoning.

### Autonomous Resolution

```text
search(subject="authentication", target="service")
```

The system resolves the target, prepares state, and returns either the desired result or an intent-level error.

### Deterministic and Ambiguous Nodes

```text
validate input -> collect evidence -> [agent judges ambiguity] -> execute decision
```

Reasoning should sit at genuine choice points rather than between mechanical stages.

## Design Implications

1. Prefer fewer intent-oriented operations over many mechanism-oriented operations.
2. Accept terms the user or agent naturally has; resolve internal identifiers below the boundary.
3. Return errors in domain language while preserving diagnostic detail separately.
4. Manage prerequisite state inside the system.
5. Make the safe common behavior the default.
6. Expose overrides as optional escape hatches, not mandatory ceremony.
7. Keep deterministic policy testable without invoking a reasoning model.

## Tensions

### Transparency vs. Autonomy

Opaque mechanism can frustrate debugging. Provide logs, metadata, traces, and administrative inspection without requiring the agent to orchestrate from them.

### Control vs. Autonomy

Exceptional cases need control. Offer bounded options such as force-refresh or bypass-cache while keeping normal operation autonomous.

### Latency vs. Correctness

Preparing state may add latency. Prefer a correct autonomous result, expose meaningful progress, and optimize the mechanism layer rather than shifting its steps to the agent.

### Hidden Policy vs. Legitimate Judgment

A system can overreach by making value-laden choices appear deterministic. Keep trade-offs, authorization, irreversible actions, and ambiguous goals above the boundary.

## When NOT to Apply

- The step requires judgment, authorization, or interpretation of user intent.
- Hiding the mechanism would conceal a consequential policy choice.
- The agent is explicitly performing diagnosis or administration of the mechanism itself.
- A deterministic default cannot be made safe without information only the agent can obtain.

## Relationship to Other Pillars

- **Cognitive Stratification:** the system manages lifecycle mechanics within each layer; the agent judges what deserves promotion across layers.
- **Compositional Simplicity:** autonomous absorption is valuable only when it reduces total system complexity.
- **Harness Over Architecture:** begin with the lowest layer that can reliably absorb the observed mechanism.
- **Burden Absorption:** applies the same intent/mechanism split to observable waiting.
- **Committed Contribution:** keeps the agent responsible for judgments even when mechanism is automated.

## Summary

Put deterministic prerequisites and invariants below an observable autonomy boundary. Let agents state desired outcomes and spend reasoning on the ambiguous decisions only they need to make.
