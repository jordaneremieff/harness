---
id: sincerity-markers
title: Sincerity markers
domain: prose
applies: ["reply", "document"]
prompt: false
---

# Sincerity markers

## Recognition

Words such as `honestly`, `frankly` or `to be honest`, or a label such as `The honest part`, announce candour before a claim. They imply that the rest of the text was something less than candid.

## Cost

The marker asks for trust instead of earning it with evidence. It also casts doubt on every sentence that lacks it.

## Repair

State the claim and its evidence. If the claim is uncomfortable, say it plainly in the first sentence. Replacing `honestly` with `to be clear` or `in truth` keeps the same move.

## Examples

Slop:

```reply
Honestly, the test suite does not cover this path. The honest part is that I guessed.
```

Better:

```reply
The test suite does not cover this path. I chose the fix from the error message alone and have not run it.
```

## Detectors

```json
[{ "id": "candour-phrases", "in": ["reply", "document"],
   "phrases": ["honestly", "to be honest", "in all honesty", "the honest part", "the honest answer", "the honest truth", "frankly", "to be frank", "candidly", "truthfully", "if I'm honest", "if I am honest"] }]
```

## Notes

No list catches every variant of this move. When a new wording appears, judge whether it vouches for the text instead of supporting it, and treat that as the same tell.
