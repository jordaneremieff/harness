---
id: closing-offers
title: Closing offers and handbacks
domain: prose
applies: ["reply", "document"]
prompt: false
---

# Closing offers and handbacks

## Recognition

A reply ends with an offer or a handback that asks for no real decision, such as `Say the word`, `Let me know if you want me to` or `For you to judge`. A closing question that assumes the reader watched every step is the same move.

## Cost

The reader has to work out whether a decision is needed. A generic offer adds a line to every reply and hides the one case where a real choice waits.

## Repair

End when the content ends. If a decision is needed, ask it as a direct question with the facts the reader needs to answer it.

## Examples

Slop:

```reply
The draft is in the pane. Say the word and I will tighten the second section, or let me know if you want a shorter version.
```

Better:

```reply
The draft is in the pane. Should the second section keep the cost table? It doubles the length.
```

## Detectors

```json
[{ "id": "offer-phrases", "in": ["reply", "document"],
   "phrases": ["say the word", "for you to judge", "let me know if you want", "let me know if you'd like", "let me know if you would like", "just let me know", "happy to adjust"] }]
```
