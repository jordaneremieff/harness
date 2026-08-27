# Principle: Compositional Simplicity

## Statement

Evaluate simplicity across the whole system and its lifecycle, not one component. When a destination and composition requirement are grounded, committing to the right shared structure can be simpler than preserving flexibility that every consumer must work around.

## Core

Compare the alternatives on total work:

- concepts and interfaces;
- integration and translation points;
- duplicated policy;
- state and migration burden;
- operational and debugging paths;
- future decisions kept open; and
- reversibility if the destination changes.

Local brevity is not system simplicity. Shared infrastructure is not automatically system simplicity either.

## Rationale

A locally small component can externalize cost to every caller. A plain document may be easy to create but expensive if many consumers must parse, query, validate, version, and correlate it independently. A structured shared substrate may contain more machinery in one place while removing repeated glue everywhere else.

The inverse also occurs. A shared abstraction built before its consumers and invariants are known can add more concepts than it removes. Composition must be demonstrated by a known destination, repeated need, binding interface, or measured omission.

The principle therefore asks where complexity lives and how often it is paid.

## Shape

```text
LOCALLY SMALL COMPONENTS
  A -- custom adapter --\
  B -- custom adapter ----> repeated integration and policy
  C -- custom adapter --/

COMPOSITIONAL STRUCTURE
  A --\
  B ----> one shared interface -> one policy and operational path
  C --/
```

## Decision Heuristic

| Question | Implication |
|---|---|
| Will several known consumers perform the same integration? | A shared structure may reduce total work. |
| Is the destination or invariant genuinely known? | Commitment can remove needless optionality. |
| Is the need hypothetical or based on one ambiguous case? | Preserve reversibility and gather evidence. |
| Does the shared layer add new state, ownership, or failure modes? | Count them in system complexity. |
| Can one local component remain isolated without custom glue? | Local simplicity may be the system-simple choice. |
| Would deferral force later consumers to make incompatible choices? | Commit at the common boundary. |

## Manifestations

### Accumulated Workarounds

```text
Iteration 1: store a value in a free-form document
Iteration 2: add a parser for one consumer
Iteration 3: add a second indexing path
Iteration 4: duplicate validation in another consumer
Iteration 5: create cross-references to reconcile the copies
```

The original component remained simple while the system acquired several integration contracts.

### Grounded Shared Structure

```text
Known requirement: multiple consumers must query and update the same durable
records under one validation policy.
Decision: use one structured store and one interface.
Result: one migration path, one validation rule, and one operational surface.
```

### Speculative Infrastructure

```text
Possible future: other consumers might need extension points.
Decision: introduce a registry, versioning, and compatibility layer now.
Result: present consumers pay for coordination that has not appeared.
```

This is not compositional simplicity; it is anticipatory architecture.

## Tensions

### Deferral Guidance

"Do not build what is not needed" and this principle answer different questions. Deferral is correct when destination and composition are unknown. Commitment is correct when repeated integrations or binding future structure are already grounded. Do not cite this principle merely to favor either infrastructure or minimalism.

### Iteration vs. Commitment

Commitment need not freeze implementation. A shared boundary can be stable while schemas and internals evolve. Conversely, an irreversible early boundary can be more expensive than temporary duplication during genuine discovery.

### Component Elegance vs. Operations

A beautiful abstraction can still produce poor observability, migration, or failure recovery. Those costs are part of the composition.

## When NOT to Apply

- The operation is genuinely isolated and unlikely to compose.
- Requirements are exploratory and a shared boundary would freeze unknowns.
- The infrastructure's ownership and operational cost exceed duplicated local work.
- A binding policy requires separation rather than unification.

## Relationship to Other Pillars

- **Harness Over Architecture:** provides the evidence gate before shared infrastructure is introduced.
- **Context Calibration:** tests whether a familiar architecture's origin conditions hold.
- **System Autonomy:** moves deterministic mechanism below a boundary only when doing so reduces total burden.
- **Cognitive Stratification:** distinct lifecycle layers may justify distinct storage and authority models.
- **Survival Selection:** observed persistence through transitions is evidence about what composes well.

## Summary

Count complexity where the whole system pays it. Commit to shared structure when composition and destination are grounded; preserve local or reversible solutions when they are not.
