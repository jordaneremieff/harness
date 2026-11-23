---
id: hollow-emphasis
title: Hollow emphasis words
domain: prose
applies: ["reply", "document"]
prompt: false
---

# Hollow emphasis words

## Recognition

Words such as `simply`, `just`, `really`, `actually` and `genuinely` add stress without content. In a cluster they set a confident tone that the facts do not supply.

## Cost

Each word costs reading time and changes nothing the reader can check. Words such as `simply` also tell the reader that a step is easy, which is false when the step fails for them.

## Repair

Delete the word and read the sentence again. If the sentence loses force, the force came from tone, so add the fact that makes the point.

## Examples

Slop:

```reply
It really just works now. You simply run the script and it actually picks up the new config.
```

Better:

```reply
Run the script. It reads the new config at start, so no restart is needed.
```

## Detectors

```json
[{ "id": "emphasis-words", "in": ["reply", "document"],
   "phrases": ["simply", "just", "really", "actually", "genuinely", "truly", "merely"],
   "limit": 3, "per": 200 }]
```

## Notes

Each of these words has ordinary uses, such as `just now`. The detector counts only clusters, and its limit is set high. Treat a finding as a prompt to reread, not as proof.
