# Principle: Cognitive Stratification

## Statement

Information with different lifecycles, authority, and access patterns belongs in different cognitive layers. Stratify by function rather than forcing all material into one knowledge model.

## Core

| Layer | Function | Typical lifecycle | Verification posture | Organization |
|---|---|---|---|---|
| Session context | Immediate interaction state | Current execution context | Accepted as working input | Temporal |
| Working memory | Raw material and active artifacts for an effort | Duration of the effort | Mixed and explicitly provisional | Effort and topic |
| Institutional memory | Durable claims, decisions, patterns, and procedures | Until superseded or deprecated | Provenance and status required | Domain, subject, and entity |

Promotion across layers is a judgment. Storage, indexing, expiry, and retrieval within a layer can be mechanism.

## Rationale

Working material and durable knowledge serve different purposes.

Working memory needs speed, locality, and tolerance for contradiction. It contains notes, source extracts, plans, drafts, intermediate results, and unverified hypotheses. Requiring institutional verification for every item makes active work cumbersome and gives raw material a false status.

Institutional memory needs stable identity, provenance, contradiction handling, and cross-effort discovery. Keeping durable claims only inside their originating effort siloes knowledge and allows it to disappear when that effort ends.

A monolithic store therefore creates two opposite errors: provisional material masquerades as durable truth, and durable knowledge remains trapped in temporary context.

## Shape

```text
SESSION CONTEXT
  current goal, recent exchange, immediate tool results
        |
        v
WORKING MEMORY
  raw sources, drafts, hypotheses, active artifacts
        |
        | deliberate extraction and verification
        v
INSTITUTIONAL MEMORY
  durable claims, decisions, patterns, procedures
```

The extraction boundary is load-bearing. Automatic collection may propose candidates, but promotion should preserve why the item matters, what supports it, and how it can be superseded.

## Decision Heuristic

Ask:

1. Is this raw material or a working artifact for the present effort?
2. Is the statement expected to guide unrelated future work?
3. Does it need provenance, status, and contradiction handling?
4. Would it remain meaningful if the originating effort disappeared?
5. Is promotion worth the maintenance burden it creates?

Default ambiguous material to working memory. Promotion is easier than removing a provisional item that has acquired false institutional authority.

## Manifestations

### Monolithic Store

```text
- reference to an active work item
- draft analysis
- verified interface constraint
- durable architectural decision
```

Without layers, all four receive the same retrieval and trust treatment even though their authority and expiry differ.

### Stratified Flow

```text
Working memory:
- active work-item reference
- source extracts
- draft comparison
- unresolved hypothesis

Institutional memory:
- verified interface constraint with source
- approved decision with rationale
- recurring procedure with owner and supersession rule
```

The durable claims may link back to raw evidence, but the layers are not required to duplicate one another exactly.

## Tensions

### Duplication Across Layers

A draft and the claim extracted from it may coexist. This is acceptable because they have different functions. Link them by subject and provenance without pretending they are one object.

### Extraction Friction

Explicit promotion risks losing useful knowledge when no one performs it. Candidate queues and reminders can help, but automatic promotion pollutes the durable layer. The final boundary remains judgment-bearing.

### Institutional Memory Is Not Eternal Truth

Durable claims can become wrong. Preserve status, contradiction, supersession, and deprecation rather than treating persistence as infallibility.

### Working Memory Is Not Trust-Free

Working material still needs labels that prevent unsafe use. "No institutional verification requirement" does not mean fabricated or untraceable input is acceptable.

## When NOT to Apply

- The corpus is so small and short-lived that separate layers add no meaningful lifecycle distinction.
- A regulated record system requires one controlled store while still supporting explicit record classes internally.
- The distinction is being used to hide evidence from review or to avoid provenance for a load-bearing claim.

## Relationship to Other Pillars

- **System Autonomy:** systems manage mechanics within layers; agents judge promotion.
- **Intrinsic Organization:** determines subject-centered identity inside durable layers.
- **Epistemological Grounding:** determines authority and verification posture for promoted claims.
- **Governing Context:** protects the frame that must survive decomposition and handoff.
- **Phantom Stewardship:** durable handovers prevent working state from becoming anonymous residue.

## Summary

Keep immediate context, active working material, and durable institutional claims in layers matched to their lifecycle and authority. Promote across layers deliberately; do not make one store pretend every item has the same status.
