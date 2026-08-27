---
title: "Ecosystem Gravity"
index: "A consumer depends on a system they cannot maintain → prioritize ecosystem durability."
---

# Heuristic: Ecosystem Gravity

## Recognition

This heuristic fires when technology is being evaluated for a system whose operator will depend on it but cannot or does not intend to maintain its internals, while the evaluation focuses on component-level properties.

Cues:

- Syntax, compile speed, local elegance, or debugger preference dominate the rubric.
- Dependency redundancy, governance, maintenance depth, migration paths, and community trajectory are absent.
- The operator is effectively a consumer whose agent or service layer performs implementation work.
- A technically excellent component would leave the operator stranded if its small maintainer base disappeared.

## Move

1. **Locate the operator on the maintenance axis.** Maintainer, occasional editor, agent-mediated reviewer, or pure consumer?
2. **Identify the real risk surface.** Can the operator recover from ecosystem decline, dependency abandonment, missing expertise, or tooling gaps?
3. **Promote ecosystem durability when maintenance distance is high.** Evaluate knowledge availability, dependency redundancy, governance health, maintenance depth, compatibility discipline, and trajectory.
4. **Use component properties as tiebreakers.** Among options that clear the durability bar, compare performance, ergonomics, and local fit.
5. **State the inversion.** If the operator will maintain the code directly, maintainer-centered properties regain primary weight.

## Ecosystem Evidence

| Dimension | Questions |
|---|---|
| Knowledge availability | Is enough high-quality public material available for diagnosis and generation? |
| Dependency redundancy | Are critical capabilities supported by multiple maintained options? |
| Maintenance depth | Is the ecosystem dependent on one unreplaceable maintainer? |
| Governance | Are decision rights, releases, and succession legible? |
| Trajectory | Are adoption, maintenance, and compatibility improving or shrinking? |
| Recovery paths | Can the system migrate or degrade gracefully if a dependency fails? |
| Operational tooling | Are inspection, testing, security, and deployment surfaces mature? |

No single popularity metric answers these questions. Use multiple independent signals and preserve their dates and scopes.

## Negotiation

| Operator position | Primary rubric |
|---|---|
| Direct daily maintainer | Ergonomics, debuggability, team skill, and local architecture can dominate. |
| Occasional human editor with agent assistance | Balance component fit with knowledge and tooling depth. |
| Agent-mediated reviewer | Favor ecosystems agents can reason about and verify reliably. |
| Pure consumer | Durability, recovery, and available support dominate local syntax preferences. |
| Regulated or safety-critical operator | Assurance evidence and accountable governance may outweigh broad popularity. |

## Why This Works

Many technology rubrics assume a human developer will read every error, debug internals, and personally bridge ecosystem gaps. When that assumption is false, local ergonomic advantages do not protect the operator from abandonment or missing support.

As maintenance distance grows, ecosystem properties exert more gravity because they determine whether the surrounding agent and tooling environment can keep the system operable. This is not a popularity contest. A large but decaying ecosystem can be weaker than a smaller one with healthy governance and redundant maintenance.

## When NOT to Apply

- The operator or team will actively maintain the internals.
- A binding technical requirement leaves only one viable component.
- The component is small, replaceable, and isolated behind a stable boundary.
- Ecosystem evidence is too weak to discriminate; do not turn vague popularity into certainty.
- A mature internal capability can responsibly absorb the maintenance risk.

## Relationship to Pillars

- **Context Calibration:** specializes calibration to the operator role assumed by an evaluation rubric.
- **Agent-Native Expertise:** agent knowledge availability is an input to maintainability, not a substitute for evidence.
- **Compositional Simplicity:** component elegance can create system-level recovery cost.
- **Redundant Corroboration:** multiple ecosystem metrics may share one underlying source and should not be counted as independent.
- **Metric Reification:** adoption or activity counts remain observations conditioned on measurement choices.

## Summary

When the operator cannot self-maintain a system, make ecosystem durability and recovery capacity primary evaluation criteria, using component-level properties only after options clear that bar.
