---
id: stock-vocabulary
title: Stock AI vocabulary
domain: prose
applies: ["reply", "document", "commit", "comment"]
prompt: false
---

# Stock AI vocabulary

## Recognition

Words that models reach for out of habit, such as `load-bearing`, `seam`, `spine`, `leverage`, `robust`, `nuanced` and `pivotal`, appear as metaphors or emphasis. They sound weighty and say little about the thing in front of the reader. A related form swaps one importance word for a near synonym across a text.

## Cost

The words mark the text as generated, and each one replaces a concrete statement. The reader learns that something matters but not what it does or what breaks without it.

## Repair

Say what the thing does and what depends on it, in plain words. Replacing `load-bearing` with `critical` or `central` keeps the move, so name the dependency or the failure instead.

## Examples

Slop:

```reply
The load-bearing seam here is the spine of the dispatcher, and a robust fix would leverage it.
```

Better:

```reply
The dispatcher calls this function before it sends any message. If the function returns early, nothing is sent, so the fix must keep that order.
```

Slop:

```document
This pivotal module gives a nuanced and robust answer to retries.
```

Better:

```document
This module retries a failed request three times, waiting one second longer each time.
```

## Detectors

```json
[{ "id": "load-bearing", "in": ["reply", "document", "commit", "comment"],
   "phrases": ["load-bearing", "load bearing"] },
 { "id": "stock-words", "in": ["reply", "document", "commit", "comment"],
   "phrases": ["seam", "seams", "spine", "leverage", "leverages", "leveraged", "leveraging", "robust", "robustly", "robustness", "nuanced", "pivotal"],
   "limit": 1, "per": 200 }]
```

## Notes

Some of these words are ordinary in their literal sense, such as a test `seam` or the `spine` of a book. The density limit allows a single use. A cluster is the tell.
