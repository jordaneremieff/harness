# Principle: Epistemological Grounding

## Statement

Knowledge systems require authoritative sources that define truth for their domains, not merely sources that claim it. Without grounding, verification is circular and authority is arbitrary. Even authoritative sources define truth only for narrow facets, not for complete reality.

## Rationale

Two claims have different epistemic shape:

1. "Someone says the timeout is five minutes." This is a claim about reality. It can be wrong.
2. "The runtime configuration says the timeout is five minutes." This is the system-of-record state for that configuration facet.

Treating both as equivalent claim-bearers is a category error. A system of record is not merely another opinion about its own domain. It is the verification target for claims in that domain.

Without axiomatic grounding:

- Verification is circular because nothing terminates the chain.
- Authority is arbitrary because claims are only weighted against other claims.
- Consensus can displace reality.
- Noise can degrade confidence in the source that should anchor the domain.

With axiomatic grounding:

- Verification has a target.
- Authority is learned for empirical sources by checking them against axioms.
- The system can distinguish widely believed from actually true.
- Reality anchors the memory system against drift.

## Shape

```text
Axiomatic layer: sources that define truth for a bounded domain

- Code host / repository      → code state
- Runtime telemetry/logs      → observed execution
- Issue tracker               → issue state
- Database / system API       → data state
- Documentation repository    → what the document says

Authority: fixed within domain
Role: verification target

Empirical layer: sources that claim, interpret, or summarize truth

- Human statements
- Agent inferences
- Summaries
- Meeting notes
- Derived dashboards
- Search results

Authority: learned from verification outcomes
Role: verification subject
```

The critical move: axiomatic sources are the verification layer, not a layer to be verified for their own domain. When a technical claim is verified, the record should say what axiomatic source it was checked against.

## Decision Heuristic

When classifying a source:

| Question | If Yes | If No |
|---|---|---|
| Does this source define the exact facet for this domain? | Axiomatic within that facet | Evaluate further |
| Is it the designated system of record for the claim? | Axiomatic within its recorded scope | Empirical or proxy |
| Does another source own the facet more directly? | Treat this source as empirical or proxy | Evaluate further |
| Does it interpret, transform, or synthesize other sources? | Empirical unless the transformation itself is the claim | Evaluate further |

## Manifestations

### Anti-Pattern: Treating Ground Truth as Probabilistic

If the code repository is the source of code state, do not decay its authority because other sources disagree about what the code contains. The disagreement is evidence that the other sources are wrong, stale, or talking about a different facet.

### Pattern: Axiomatic Sources Are Fixed Within Domain

Axiomatic authority is domain-specific. A code repository is authoritative for code state, not for whether the code is deployed, correct, or strategically right. A telemetry system is authoritative for what it observed, not for events it failed to instrument.

### Anti-Pattern: Verification Without Grounding

"Verified" is meaningless if it does not name what it was verified against. A verification chain should terminate at an axiomatic source, or state that no authoritative source was reached.

### Pattern: Explicit Verification Chain

Grounded:

```text
The timeout claim was verified against the authoritative runtime-configuration record.
```

Ungrounded:

```text
The timeout claim was verified.
```

## Domain-Specific Authority

| Source Class | Domain | Authority Class | Limitation |
|---|---|---|---|
| Code host / repository | Technical implementation | Axiomatic | Code state is not deployed state or runtime behavior |
| Telemetry/log platform | Observed execution | Axiomatic | Absence may be instrumentation or retention gap |
| Issue tracker | Ticket/task state | Axiomatic | Ticket text may be stale or aspirational |
| Documentation system | Document contents | Axiomatic for content | Content may be outdated or wrong |
| Database / system API | Data state | Axiomatic | Snapshot scope and permissions matter |
| Human or chat source | Context, rationale, claims | Empirical | Rich but subjective and unverifiable alone |

No source captures complete reality. Axiomatic sources define truth for facets. This is why Triangulated Truth matters: single sources anchor claims but do not make them complete.

## Nuances

### Content vs. Interpretation

Axiomatic sources define what is, not what should be or what it means.

- A repository is axiomatic for "the repository contains code expressing X."
- It is not axiomatic for "X occurs at runtime" or "X is the right approach."
- A documentation system is axiomatic for "the document says X."
- It is not axiomatic for "X is still true."

### Staleness vs. Authority

A stale document remains authoritative for what it says. Whether its content is currently true is a freshness question, not an authority question.

### Derived Sources

Derived dashboards, summaries, and generated reports are empirical unless their derivation is itself the claim under inspection. They inherit some trust from axiomatic inputs but can introduce error through transformation.

## Tensions

### Axioms vs. Learning

We do not need to relearn that a designated source of record is authoritative for its own bounded facet. It can still be audited for corruption, scope, permissions, freshness, and correct operation. We learn which empirical sources are reliable, how to interpret axiomatic data, and when two axiomatic facets disagree.

### System Failures

If a source of record has a bug, that is a system failure, not an epistemological update. Fix or qualify the source. Do not silently turn all ground truth into opinion.

### Multiple Axioms Disagreeing

If an issue tracker says work is done but the code repository shows no implementation, both may be true within their domains:

- Issue state: done
- Code state: not implemented

That is a real-world inconsistency. Surface it rather than degrading one source's authority.

## Relationship to Other Principles

### Triangulated Truth

Epistemological Grounding establishes what can anchor a claim. Triangulated Truth explains why anchoring is not enough. A code source can prove code state; it cannot prove deployment, decision context, or operational success.

### AI-Native Expertise

Everything is input, but not every input is the same kind of thing. Some inputs define a facet of reality. Others claim, interpret, or summarize it.

### System Autonomy

Source classification should be a stable system property where tooling can support it. The agent should not relitigate the epistemic status of the same source on every claim.

### Cognitive Stratification

Memory derives its strength from what it was checked against. The storage layer is not authority by itself.

## Agent Practice

1. Distinguish axiomatic from empirical sources explicitly.
2. Do not subject axiomatic sources to authority updates inside their own domain.
3. Name the source of record in verification claims.
4. When axiomatic sources disagree, surface the conflict by facet.
5. Scope authority to domain: code state, issue state, document content, data state, observed execution.

## Summary

Some sources define truth for a domain. Others claim it. Conflating them makes verification meaningless.

Axiomatic sources are the bedrock for their facets. Empirical sources are checked against that bedrock. Without grounding, a knowledge system is a weighted cache of opinions. With grounding, it can distinguish consensus from truth.
