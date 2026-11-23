---
id: speculative-fallbacks
title: Speculative fallbacks and defensive checks
domain: code
applies: ["comment", "code"]
prompt: false
---

# Speculative fallbacks and defensive checks

## Recognition

Code adds a fallback, a retry, an extra format or a guard for a case that no current requirement names, often with a comment such as `just in case`, `to be safe` or `should never happen`. A related form checks types at run time inside code where the type system already guarantees them, or adds a gate that refuses work nobody asked to refuse.

## Cost

Each branch is code that never runs in practice, so its bugs stay hidden until the day it does run. Guards on typed values tell the reader that the types cannot be trusted. Defensive gates block real work for an inferred risk.

## Repair

Remove the branch, or name the concrete current case it handles in the code. Check values at the real boundaries, such as user input, files and network replies, and trust the types inside them.

## Examples

Slop:

```ts
// Just in case the id is missing, fall back to the title.
const key = entry.id ?? entry.title ?? "unknown";
```

Better:

```ts
const key = entry.id;
```

Slop:

```ts
if (typeof count !== "number") throw new Error("should never happen");
```

Better:

```ts
const next = count + 1;
```

## Detectors

```json
[{ "id": "hedged-branches", "in": ["comment", "code"],
   "phrases": ["just in case", "to be safe", "for safety", "as a safety net", "belt and braces", "belt and suspenders", "should never happen", "shouldn't happen", "should not happen", "future-proof", "future proof", "future-proofing", "can't hurt", "cannot hurt"] }]
```

## Notes

The detector finds only the comments and messages that admit a branch is speculative. Runtime checks on typed values and inferred gates need judgment, because the same code is correct at a real boundary.
