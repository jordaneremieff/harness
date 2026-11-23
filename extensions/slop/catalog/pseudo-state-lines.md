---
id: pseudo-state-lines
title: Empty status lines
domain: prose
applies: ["reply", "document"]
prompt: false
---

# Empty status lines

## Recognition

A line such as `Nothing needed from you`, `Nothing for you` or `No action required` tells the reader that they have nothing to do. It looks like a status marker, but it reports no state of the work.

## Cost

The reader spends attention on a sentence that carries no fact. When it closes most replies, it becomes noise that the reader learns to skip, and a real request placed next to it gets skipped too.

## Repair

Say what runs, what happened or what comes next, and stop. If nothing else needs saying, say nothing. In tool output and cards, show the state itself, such as the open work or the finished step, so that no such line is needed.

## Examples

Slop:

```reply
Committed and pushed. Nothing needed from you.
```

Better:

```reply
The fix is on main. The next scheduled run uses it.
```

Slop:

```reply
The worker is still running. No action required on your side.
```

Better:

```reply
The worker is still running. Its result comes back to this chat when it ends.
```

## Detectors

```json
[{ "id": "nothing-for-you", "in": ["reply", "document"],
   "phrases": ["nothing needed from you", "nothing is needed from you", "nothing for you", "nothing needs you", "nothing from you", "nothing required from you", "nothing is required from you", "nothing on your side", "nothing to do on your side", "no action needed", "no action required", "no further action needed", "no further action required", "no action is needed", "no action is required", "you don't need to do anything", "you do not need to do anything"] }]
```

## Notes

The phrase list catches the common forms. A new wording of the same move is still the tell, so read for a sentence whose only content is that the reader can relax.
