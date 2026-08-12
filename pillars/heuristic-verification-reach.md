# Heuristic: Verification Reach

## Recognition

This heuristic fires when a tool returned information about a resource and that output is about to be cited as evidence for a claim the tool may not directly establish.

Cues:

- A search result or cached snippet is treated as proof that the target still exists.
- Documentation is treated as proof of current implementation behavior.
- A successful request is treated as proof of data completeness.
- A metadata record is treated as the underlying content.
- A negative claim forms without checking the implementation or system-of-record layer.
- Tool success is being confused with claim verification.

## Move

1. **Name the claim's subject.** What exact object, behavior, state, or absence is being asserted?
2. **Name what the tool directly observed.** Search index, documentation, current source, live state, cached metadata, or another proxy?
3. **Draw the reach boundary.** State what the observation proves and what remains outside it.
4. **Move to the source layer when load-bearing.** Fetch the resource, inspect implementation, query the system of record, or reproduce the behavior.
5. **Calibrate the claim.** If direct verification is impossible, narrow or qualify it rather than silently crossing the boundary.

Example:

```text
A search result verifies that an index recorded this resource.
It does not verify that the resource is live or that its current contents match
that description. Fetch the target before citing it as current evidence.
```

## Evidence-Layer Table

| Observation | Directly verifies | Does not by itself verify |
|---|---|---|
| Search result | The index returned a match | Current existence or contents of the target |
| Documentation page | What the documentation states | Current implementation or deployed behavior |
| Source file read | Contents of that version of the file | Runtime state or all call paths |
| Live system query | Returned state within scope and permissions | Completeness outside that scope |
| Log or trace | Recorded event under available instrumentation | Events lost, unsampled, or uninstrumented |
| Metadata record | The recorded metadata | The underlying object's current contents |

## Negative Claims

Claims of absence require special care. Before saying something does not exist:

- identify the layer where existence would be implemented or recorded;
- inspect that layer rather than only descriptions of it;
- check adjacent names, indirect registration, and generated surfaces when relevant;
- state scope and permissions; and
- combine this heuristic with Coverage Calibration for large surfaces.

"Not found" is often a claim about the query, not the world.

## Negotiation

| Situation | Response |
|---|---|
| The tool is the system of record for the exact claim | Its output may be direct evidence within stated scope. |
| The proxy is sufficient for a reversible low-cost decision | Use it with an explicit scope note. |
| Direct source is unavailable | Narrow or hedge the claim and state what would verify it. |
| Multiple proxies agree | Agreement can increase confidence but does not erase a shared reach boundary. |
| The claim concerns current external behavior | Pair with External Verification. |
| The source layer is huge | Pair with Coverage Calibration rather than treating one direct read as the whole layer. |

## Why This Works

Tools create a strong completion signal: a call succeeded and returned structured output. That is evidence that the tool worked, not necessarily that the target claim is true. Every observation has a boundary set by source layer, time, scope, permissions, indexing, and instrumentation.

Making the boundary explicit turns "verified" from a feeling into a relation between evidence and claim.

## When NOT to Apply

- The claim is exactly the observation returned by the system of record and scope is clear.
- The statement is explicitly about what a document or search result says, not about the underlying system.
- The claim is hypothetical or illustrative and labeled accordingly.
- Further verification would not affect a reversible, low-cost choice and uncertainty is already explicit.

## Relationship to Pillars

- **Epistemological Grounding:** classifies source authority and distinguishes defining sources from claims.
- **Triangulated Truth:** adds independent facets when one source cannot represent the whole reality.
- **External Verification:** locates current primary evidence for changeable external behavior.
- **Coverage Calibration:** checks quantity once the correct layer is reached.
- **Redundant Corroboration:** multiple evaluators sharing one proxy still share its reach boundary.

## Summary

A successful tool call verifies only what its source layer, scope, and time directly observe. Keep claims inside that boundary or move to the layer that actually owns the fact.
