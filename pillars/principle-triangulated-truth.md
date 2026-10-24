---
title: "Triangulated Truth"
index: "Truth is triangulated across facets rather than located in one source."
---

# Principle: Triangulated Truth

## Statement

Institutional knowledge is distributed across complementary sources with different reliability profiles. Truth is triangulated across facets of reality, not located in any single source. Corroboration is evidence of facet convergence, not source count.

## Rationale

A decision, its implementation, its documentation and its effects are different facets of reality. One source can define or observe one facet without establishing the others.

| Facet | What It Captures | Possible Sources | Boundary |
|---|---|---|---|
| Decision | What was chosen or authorised | An authorised declaration, conversation, decision record | Does not establish enactment or effect |
| Intent | What was planned or assigned | A request, work record, plan | Does not establish completion |
| Enactment | What was changed | Code, configuration, migration record | Does not establish deployed behaviour |
| Documentation | What was written | Specification, reference, runbook | Does not establish current behaviour |
| Execution | What the system did | Direct observation, runtime records, traces, data state | Limited by access, instrumentation, retention and scope |
| Experience | What a person encountered when using the system | The person's direct observation and firsthand account | Defining for their experiential facet, not for unobserved system state, cause or remedy |

These are not ranks of media. A conversation can contain a binding decision, a firsthand observation and an uncertain explanation. A formal report can repeat an unverified claim. Classify each proposition by its source's relation to that exact facet.

Firsthand experience is evidence of what the person encountered, not merely evidence that they spoke. Instrumentation is not a prerequisite for that evidence to count. It can add a different observation or test an explanation; it does not automatically outrank experience that it did not observe.

Convergence across the facets a claim requires strengthens that claim. Repetition within one facet does not fill another facet's gap. A single source may settle a claim confined to the facet it defines.

## Shape

A claim about a release being ready may require a decision, an implemented change, the selected deployment and observed use. Check each required facet at its defining or observing source.

A claim about what the operator authorised may be settled by the operator's declaration. No code or runtime record is needed to make that declaration authoritative within its scope.

Count the facets reached by the claim, not the number or formality of the containers that hold them.

## Decision Heuristic

1. State the exact claim and the facets needed to support it.
2. For each facet, identify which source defines it or directly observes it.
3. Separate declarations, observations, reports and explanations even when they share one message.
4. Check whether supposedly different sources add another facet or repeat the same underlying evidence.
5. Name any missing facet that changes the conclusion. Do not demand unrelated facets merely to increase source count.
6. A source may settle a claim only within the facet it defines. Do not let authority for one facet override another facet's evidence.

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
three messages repeat the same account of a release
result: repeated testimony, not separate decision, enactment and execution checks
```

### Pattern: Corroboration as Facet Convergence

```text
conversation record -> decision facet
repository state   -> enactment facet
work record        -> intent facet

result: three distinct facets
```

## Communication and Evidence

Communication form does not decide authority. An authorised decision conveyed in conversation remains a decision. A firsthand report remains evidence of the experience reported. A causal explanation in the same message needs support for that explanation.

The converse also holds. A dashboard or formal document may repeat a claim without adding observation. A runtime record establishes what its instrumentation recorded, not what it failed to observe.

Preserve the person's actual claim. Do not reduce a report of a failed interaction to the fact that a complaint was made. Do not turn the report into proof of an unobserved technical cause. Seek another facet when it answers a question the current evidence cannot settle.

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

## Relationship to Other Pillars

### Epistemological Grounding

Epistemological Grounding establishes which sources define particular facets. Triangulated Truth asks whether the evidence reaches every facet the claim requires. A source can contain evidence for several facets, but authority for one does not establish another. Code state alone does not prove deployment state, decision quality or runtime behaviour.

### Agent-Native Expertise

Agent-Native Expertise treats inputs according to what they contribute. Triangulated Truth distinguishes the facets those inputs reach. Different source types do not necessarily add different facets, and one communication medium can carry several. Judge the evidence added, not the variety of its containers.

### System Autonomy

At scale, the agent should not manually weigh source heterogeneity on every claim. Distinguishing facets and surfacing gaps is system work where tooling can absorb the complexity.

## Agent Practice

1. Match the evidence to the facets the exact claim requires.
2. Preserve defining authority and firsthand evidence within their scope, regardless of medium.
3. Name missing facets before a conclusion crosses them.
4. Do not convert repetition or shared-source agreement into independent corroboration.
5. When sources disagree, check whether they describe different facets, states, conditions or times before treating one as wrong. Surface a gap between firsthand experience and instrumentation rather than assume either captures the whole event.

## Summary

Match evidence to the facets the claim requires, such as decision, intent, enactment, documentation, execution and experience. A defining source can settle a claim within its scope; a broader claim needs evidence for the further facets it crosses.

Corroboration is not a count of people, messages or source types. Preserve firsthand evidence and declared authority within their bounds, and name the gaps that matter to the conclusion.
