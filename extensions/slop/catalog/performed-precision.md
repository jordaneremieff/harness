---
id: performed-precision
title: Performed precision
domain: prose
applies: ["reply", "document", "commit"]
prompt: false
---

# Performed precision

## Recognition

A phrase such as `byte-for-byte`, `byte-identical` or `bit for bit` claims exactness in place of the comparison that was run. It sounds like evidence, but it names no check and no result.

## Cost

The reader cannot tell what was compared, with which tool, or whether anything was compared at all. A claim that sounds exact earns more trust than a plain one, so an unchecked one does more harm.

## Repair

Name the check and its result, for example "cmp found no difference" or "git diff shows one changed line". If no check ran, say what you did and make no claim of exactness. A swap to `exactly`, `identical` or `verbatim` keeps the same move.

## Examples

Slop:

```reply
The new file is byte-for-byte the document you approved.
```

Better:

```reply
cmp found no difference between the new file and the document you approved.
```

Slop:

```commit
Regenerate fixtures so they are bit for bit equal to live output
```

Better:

```commit
Regenerate fixtures from live output
```

## Notes

A specification that requires two files to be identical byte by byte, and names how that is compared, states a real check. The tell is the phrase used as a result claim with no comparison behind it. The detector runs on replies and commit messages, because reference documents use these words for real requirements of that kind.

## Detectors

```json
[{ "id": "exactness-phrases", "in": ["reply", "commit"],
   "phrases": ["byte-for-byte", "byte for byte", "byte-identical", "byte identical", "bit-for-bit", "bit for bit", "character-for-character", "character for character", "line-for-line"] }]
```
