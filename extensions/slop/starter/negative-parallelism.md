---
id: negative-parallelism
title: Negative parallelism
domain: prose
applies: ["reply", "document"]
prompt: false
---

# Negative parallelism

## Recognition

A sentence defines a thing by what it is not before it says what it is, as in `It's not a bug, it's a design choice` or `for clarity rather than for speed`. Nobody claimed the denied version, so the contrast is staged.

## Cost

The reader has to process a claim that nobody made before reaching the real one. Repeated, the figure gives prose a sales rhythm and makes each point sound like a correction of the reader.

## Repair

State what the thing is, and keep a contrast only when someone actually holds the other view. If the contrast matters, name who holds it and why it is wrong.

## Examples

Slop:

```reply
It's not a bug, it's a design choice. The cache isn't the problem, the clock is.
```

Better:

```reply
The parser drops empty lines on purpose. The stale results come from the clock, which runs ten minutes slow.
```

Slop:

```document
The cache is not a speed feature, it is a cost control.
```

Better:

```document
The cache cuts the cost of repeated reads of the same record.
```

## Detectors

```json
[{ "id": "denied-then-stated", "in": ["reply", "document"],
   "pattern": "(?:\\b(?:is|are|was|were)\\s+not|\\b(?:isn|aren|wasn|weren)['’]t|\\b\\p{L}+['’](?:s|re)\\s+not|(?:^|[.!?]\\s+)not)\\s+(?:(?:just|only|merely|simply)\\s+\\S|(?:a|an|the|about|because|your|our|their|its|my)\\s)[^.;:!?\\n]{0,60}?[,;]\\s+(?:but\\s|(?:it|this|that|they|he|she)(?:['’]s|['’]re|\\s+is|\\s+are|\\s+was)\\s|the\\s+\\p{L}+\\s+(?:is|are|was)\\s)|\\bfor\\s+[^.;:!?\\n]{1,40}?\\s+rather\\s+than\\s+for\\b",
   "limit": 1, "per": 250 }]
```

## Notes

One contrast in a long text is ordinary, and the density limit lets one through. The detector counts a denial followed by the statement in the same sentence. A contrast at the end of a sentence, such as `this closes the terminal, not the agent`, often corrects a likely misreading, so no detector counts it. Judge it by whether anyone holds the denied view.
