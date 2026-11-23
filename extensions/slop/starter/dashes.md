---
id: dashes
title: Dashes that join clauses
domain: prose
applies: ["reply", "document", "commit", "comment"]
prompt: false
---

# Dashes that join clauses

## Recognition

An em dash, a spaced en dash or a spaced hyphen joins two clauses whose relation the writer never stated. Ranges such as `10–20` or `Mon–Fri` are a different use and are fine.

## Cost

The dash is one of the most visible marks of generated text. It also hides the logic. The reader cannot tell whether the second part explains, contrasts with or merely follows the first.

## Repair

Join the clauses with the word that states the relation, such as `because`, `so` or `but`, or split them into two sentences. Swapping the dash for a semicolon, a colon or brackets keeps the same move.

## Examples

Slop:

```reply
The check passed — but only because the fixture was empty.
```

Better:

```reply
The check passed only because the fixture was empty.
```

Slop:

```commit
Drop the retry loop - the server already retries
```

Better:

```commit
Drop the retry loop because the server already retries
```

## Detectors

```json
[{ "id": "long-dashes", "in": ["reply", "document", "commit", "comment"],
   "pattern": "—|―|(?<=\\S)[ \\t]+–[ \\t]+(?=\\S)" },
 { "id": "spaced-hyphens", "in": ["reply", "document", "commit"],
   "pattern": "(?<=\\p{L}[,.;:!?)\"'’”]?)[ \\t]+--?[ \\t]+(?=\\p{L})" }]
```

## Notes

The spaced hyphen detector needs a letter on both sides, so command options such as `npm test -- --coverage` do not count. It skips code comments, where a hyphen often separates a marker from its text.
