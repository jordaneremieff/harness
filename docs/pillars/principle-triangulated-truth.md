# Principle: Triangulated Truth

## Statement

Institutional knowledge is distributed across complementary sources with different reliability profiles. Truth is triangulated across facets of reality, not located in any single source. Corroboration is evidence of facet convergence, not source count.

## Rationale

Organizational reality usually exists across several surfaces:

- A decision happens in a conversation channel
- It may be recorded in an issue tracker
- It may be enacted in a code host or configuration repository
- It may be documented in a knowledge base
- Its effects may appear in telemetry, logs, metrics, traces, database state, or user-visible behavior

Each source captures a different facet of the same reality:

| Facet | What It Captures | Typical Sources | Strength | Weakness |
|---|---|---|---|---|
| Decision | What was discussed or agreed | Chat, meeting notes, comments | Rich context, rationale | Informal, noisy, subjective |
| Intent | What was planned or assigned | Issue tracker, roadmap, task board | Structured, searchable | Aspirational, often stale |
| Enactment | What was changed | Code host, config repo, migration history | Durable, verifiable | Narrow, may lag decisions |
| Documentation | What was written down | Knowledge base, README, runbook | Formal, reusable | Can lag reality |
| Execution | What actually happened | Logs, metrics, traces, database, runtime API | Empirical, timestamped | Retention gaps, instrumentation gaps |

Informal decision channels are paradoxical: they can be where reality happens, but they are weak alone. Formal systems are more reliable, but often lag the actual decision. Runtime evidence shows what happened, but may not explain why.

A claim that appears across heterogeneous facets is stronger than a claim repeated within one facet. Three chat messages are still one facet. A chat decision that appears in code and telemetry has crossed decision, enactment, and execution.

## Shape

```text
Decision      → conversation, rationale, informal agreement
Intent        → issue tracker, roadmap, planned work
Enactment     → code, configuration, migrations
Documentation → knowledge base, runbook, reference docs
Execution     → logs, metrics, traces, database/runtime state

Truth confidence rises when the claim survives movement across facets.
```

Single-facet claim:

```text
"A person said X in chat" → possibly true, one facet covered
```

Multi-facet convergence:

```text
"X was discussed, tracked, implemented, and observed running" → high confidence
```

## Decision Heuristic

When evaluating a claim:

| Question | Implication |
|---|---|
| How many source types corroborate this? | More types usually means more facets covered |
| Which facets are represented? | Decision + enactment is stronger than decision + decision |
| Is there convergence across informal, formal, and empirical sources? | Stronger than any one source alone |
| What facets are missing? | Gaps identify uncertainty and next checks |

When designing knowledge systems:

| Question | Design Move |
|---|---|
| Does corroboration count facets or just sources? | Weight heterogeneous facets higher |
| Can one source override others? | Sometimes, but only within its domain |
| How are informal sources handled? | Low base authority, high corroboration value |

## Manifestations

### Anti-Pattern: Single Source of Truth Overreach

```text
if repository contains the feature:
    conclude "the feature is ready"

Missing: was it agreed, deployed, configured, and observed working?
```

### Pattern: Triangulated Verification

```text
claim: "the feature is ready"

evidence:
  decision: approval record
  intent: tracked work status
  enactment: merged implementation and active configuration
  execution: direct runtime observation
  documentation: current release or operating guidance

Convergence across facets supports confidence.
Missing facets become named uncertainty and targeted follow-up.
```

### Anti-Pattern: Corroboration as Source Count

```text
three conversation sources repeat the same claim
result: three sources, one facet
```

### Pattern: Corroboration as Facet Convergence

```text
conversation record -> decision facet
repository state   -> enactment facet
work record        -> intent facet

result: three distinct facets
```

## Informal Source Paradox

Informal sources deserve special treatment because they often contain the richest context and the weakest standalone authority.

They are where decisions, corrections, rationale, and informal agreements often happen. They are also context-dependent, subjective, and easy to misread. A standalone informal claim is not enough for high-confidence factual claims about code, execution, or operational state.

The resolution: informal sources have low base authority but high corroboration potential. An informal decision corroborated by code is strong because it covers decision and enactment. An informal decision alone is a lead, not a conclusion.

## Absence and Gaps

Absence of evidence is not evidence of absence, but it is still information.

- No decision record: maybe decided elsewhere, maybe not decided
- No issue tracker entry: maybe informal work, maybe tracking gap
- No code/config change: maybe not enacted, maybe enacted elsewhere
- No telemetry: maybe not running, maybe instrumentation gap
- No documentation: maybe undocumented, maybe stale search/index

Gaps between sources are diagnostic:

- Enacted but not tracked: process gap
- Decided but not enacted: execution gap
- Running but undocumented: knowledge gap
- Documented but not observed: stale or aspirational documentation

The system should surface these gaps, not paper over them.

## Relationship to Other Principles

### Epistemological Grounding

Epistemological Grounding establishes that some sources define truth for specific domains. Triangulated Truth explains why multiple sources still matter: even an authoritative source captures only one facet. Code state does not prove deployment state, decision quality, or runtime behavior.

### Agent-Native Expertise

Agent-Native Expertise says everything is input. Triangulated Truth specifies that heterogeneous inputs cover more facets of reality than homogeneous inputs. Convergence across facets is stronger than repeated agreement inside one facet.

### System Autonomy

At scale, the agent should not manually weigh source heterogeneity on every claim. Distinguishing facets and surfacing gaps is system work where tooling can absorb the complexity.

## Agent Practice

1. Treat single-facet claims as weak unless the claim is explicitly scoped to that facet.
2. Treat informal-decision + formal-enactment convergence as strong.
3. Name missing facets before stating high confidence.
4. Do not convert repeated same-facet agreement into independent corroboration.
5. When a source is authoritative, state its domain boundary.

## Summary

No single source tells the whole story. Truth emerges from convergence across facets: decision, intent, enactment, documentation, and execution.

Corroboration is not more people saying the same thing. It is evidence that a claim exists across multiple layers of reality.
