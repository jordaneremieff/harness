---
id: clause-glue
title: Semicolons and colons as glue
domain: prose
applies: ["reply", "document"]
prompt: false
---

# Semicolons and colons as glue

## Recognition

Semicolons chain thoughts that deserve their own sentences, and colons in the middle of a line hide a run of loosely joined clauses. The punctuation stands where a word such as `because`, `so` or `but` would say how the parts relate.

## Cost

The reader has to work out the relation that the writer left out. Long chains read as one breathless block, and the important clause gets lost among the others.

## Repair

Split the chain into sentences, or join the parts with the word that names their relation. Turning a semicolon into a dash, a colon or brackets keeps the same move.

## Examples

Slop:

```reply
The build failed; the cache was stale; I cleared it and reran. The cause was simple: the key ignored the lockfile, so old packages stayed.
```

Better:

```reply
The build failed because the cache was stale. The cache key ignored the lockfile, so old packages stayed after an update. Clearing the cache fixed the build.
```

## Detectors

```json
[{ "id": "semicolons", "in": ["reply"],
   "pattern": "(?<=[\\p{L}\\p{N})\"'’”])\\s*;\\s+(?=[\\p{L}(])",
   "limit": 1, "per": 200 },
 { "id": "mid-line-colons", "in": ["reply", "document"],
   "caseSensitive": true,
   "pattern": "(?<=\\S[ \\t]{1,8}\\S{1,40}[ \\t]{1,8}\\S{1,40}[ \\t]{1,8}\\S{0,40}\\p{L}):[ \\t]+(?=\\p{Ll})",
   "limit": 2, "per": 200 }]
```

## Notes

A colon that introduces a list or a quoted command is ordinary. The colon detector counts only a colon that follows at least four words and continues the same sentence in lower case, so a short label such as `Default: on` does not count. The density limit allows a few. The semicolon detector runs on replies only, because reference documents use semicolons in long lists of conditions.
