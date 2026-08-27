---
title: "Intrinsic Organization"
index: "Knowledge is organized by what it describes, not what consumes it."
---

# Principle: Intrinsic Organization

## Statement

Knowledge should be organized by what it describes, not by the consumer that happens to use it.

## Core

Use an organizing label when it remains meaningful without knowing a particular project, dashboard, team, or application.

| Question | Decision |
|---|---|
| Does the label describe the subject, entity, event, or domain? | Use it. |
| Does it name only a consumer or current destination? | Keep it as relationship metadata, not primary organization. |
| Would the label become meaningless if the consumer were renamed or retired? | Do not use it as durable identity. |
| Is the origin relevant? | Record provenance separately from subject classification. |

## Rationale

Consumer-centered organization couples knowledge identity to a changing use. It causes:

- **consumer drift:** labels become orphaned when a consuming surface changes;
- **multi-consumer ambiguity:** one item acquires several competing ownership labels;
- **discovery friction:** a searcher must know who uses the knowledge before finding what it is about; and
- **siloing:** durable claims disappear with the effort or application that first produced them.

Subject-centered organization remains legible across consumer changes and allows multiple uses to converge on the same knowledge.

## Shape

```text
FRAGILE
consumer A -> [for:A] --\
consumer B -> [for:B] ----> knowledge identity follows current use
consumer C -> [for:C] --/

STABLE
consumer A --\
consumer B ----> query [authentication, identity, session-policy]
consumer C --/
                    knowledge identity follows subject
```

## Manifestations

### Consumer-Centered

```text
store_claim(
    name="Session renewal policy",
    tags=["project:<current>", "for:<current-view>", "team:<current-owner>"],
)
```

The tags say who currently uses the claim but not what it describes.

### Subject-Centered

```text
store_claim(
    name="Session renewal policy",
    tags=["authentication", "identity", "session-policy"],
    provenance={"originating_effort": "..."},
    consumers=["..."],
)
```

Subject tags provide durable discovery. Origin and consumers remain available as metadata without controlling identity.

## Tensions

### Provenance

Origin matters for verification and interpretation. Record it in structured provenance fields. Where the knowledge came from is not the same as what it is about.

### Consumer Routing

Delivery systems may need consumer labels. Use them as routing or subscription metadata, not as the primary durable taxonomy.

### Effort-Specific Material

If an item has no meaning outside one effort, it may belong in working memory rather than institutional memory. Do not force every draft into a global subject taxonomy.

### Subjects Also Change

Domain language evolves. Maintain aliases, controlled vocabulary, and migrations where needed. Subject-centered organization is more stable, not immutable.

## When NOT to Apply

- The object being organized is intrinsically a consumer relationship, such as an access grant or delivery subscription.
- A temporary working collection is intentionally scoped to one effort.
- A binding external taxonomy controls classification.

## Relationship to Other Pillars

- **Cognitive Stratification:** determines the layer; Intrinsic Organization determines durable identity within it.
- **Epistemological Grounding:** provenance and authority remain separate from subject classification.
- **Triangulated Truth:** facets can link through a shared subject without being collapsed into one source.
- **Survival Selection:** subject-centered knowledge often survives consumer transitions better.

## Summary

Organize durable knowledge by subject. Keep consumers, destinations, and origin as relationships or provenance so identity survives changes in who uses the knowledge.
