---
title: "Coverage Calibration"
index: "Confidence exceeds the examined share of a search space → count coverage and calibrate the claim."
---

# Heuristic: Coverage Calibration

## Recognition

This heuristic fires when:

1. You are investigating an unfamiliar search space: a repository, service estate, document collection, interface surface, or domain corpus.
2. You are forming a broad or negative conclusion from search output or a small set of reads.
3. Claim confidence exceeds the examined fraction of the relevant universe.
4. The universe can be counted or bounded more clearly than it currently is.

Cues include "there is no support for X," "all implementations do Y," or "the cleanest approach is Z" after a handful of matches in a much larger space.

## Move

1. **Name the universe.** What set does the claim range over: files, modules, endpoints, records, documents, or implementations?
2. **Count it.** Establish a denominator or explain why one cannot be established.
3. **Track examined coverage.** Distinguish search hits, skimmed items, and end-to-end reads.
4. **Calibrate the claim.** Match language to coverage and search quality.
5. **Escalate deliberately.** Broaden the investigation when the requested confidence requires it; otherwise label the result preliminary.

Example:

```text
I queried 12 of 240 modules, giving 5% query coverage, and read 3 end to end,
giving 1.25% interpretive coverage. I found no matching hook in that surface;
this is not evidence of absence. A firm answer requires broader symbol and
call-site tracing.
```

## Negative-Claim Standard

Before asserting absence:

- name the universe the absence claim covers;
- state which members were read end to end;
- describe the search methods and likely blind spots;
- check naming variants, indirect registration, generated code, and adjacent layers where relevant; and
- downgrade to "not found in the examined surface" when coverage remains partial.

A search tool returning zero matches is evidence about the query over the indexed surface. It is not automatically evidence that the capability does not exist.

## Negotiation

| Situation | Calibration |
|---|---|
| Small, fully enumerated universe | A categorical conclusion may be justified after full inspection. |
| Large universe with low coverage | Report a preliminary finding and the ratio. |
| Search has high recall but items were not read | Distinguish query coverage from interpretive coverage. |
| Universe cannot be counted | Bound by source classes, modules, time, or another explicit scope. |
| Decision is reversible and low-cost | A lower-confidence working conclusion may be sufficient if labeled. |
| Decision is consequential or hard to reverse | Increase coverage and diversify methods before concluding. |

## Why This Works

Search interfaces compress large spaces into a few visible results. That visibility creates an illusion of having examined "the codebase" or "the documentation" when only the result set was examined. A denominator makes the missing surface visible and forces confidence back into proportion.

Coverage is not proof by itself. Reading every file poorly can be weaker than targeted tracing. The ratio is a calibration input alongside method quality, source authority, and the structure of the claim.

## When NOT to Apply

- The claim is explicitly local to the examined artifact.
- A complete index or authoritative schema directly answers the question.
- One counterexample is enough to refute a universal claim.
- The cost of broader coverage exceeds the reversible decision's value, and uncertainty is stated.
- The relevant universe is already fully enumerated and inspected.

## Relationship to Pillars

- **Verification Reach:** checks whether evidence reaches the right layer; Coverage Calibration checks whether enough of that layer was examined.
- **Triangulated Truth:** asks whether independent facets are covered; this heuristic asks how much of one facet's universe was sampled.
- **Comprehension Checkpoint:** prevents broad reading from replacing synthesis; together they balance breadth and understanding.
- **External Verification:** may locate the right external source, after which coverage still governs broad claims within it.

## Summary

Count the universe, state the examined share, and keep claim strength proportional to both coverage and method quality, especially for claims of absence.
