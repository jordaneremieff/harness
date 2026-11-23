---
id: narrating-comments
title: Comments that narrate the code
domain: code
applies: ["comment"]
prompt: false
---

# Comments that narrate the code

## Recognition

A comment restates what the next line plainly does, such as `// Loop over the entries` above a loop or `// Increment the counter` above `count++`. Steps such as `// Now we call the parser` walk the reader through code they can already read.

## Cost

The comment doubles the reading without adding a fact. It drifts from the code at the next edit, and its volume hides the few comments that explain a real constraint.

## Repair

Delete the comment, or replace it with what the code cannot say: the rule it keeps, an external contract, or the reason for a choice that looks wrong. If a block needs a narration to be read, give it a better name or split it.

## Examples

Slop:

```ts
// Loop over the entries
for (const entry of entries) {
  // Increment the counter
  count++;
}
```

Better:

```ts
// Disabled entries still count, so the inventory total matches the files on disk.
for (const entry of entries) count++;
```

Slop:

```py
# Now we call the parser
result = parse(text)
```

Better:

```py
result = parse(text)
```

## Detectors

```json
[{ "id": "step-narration", "in": ["comment"],
   "pattern": "^\\s*(?:(?:now|first|then|next|here)\\s+we\\b|we\\s+(?:now|then|first)\\b|(?:loop|iterate)s?\\s+(?:over|through)\\s+(?:the|each|all)\\b|(?:increment|decrement)s?\\s+the\\s+\\w+\\s*$|call(?:s)?\\s+the\\s+\\w+(?:\\s+(?:function|method))?\\s*$|return(?:s)?\\s+the\\s+result\\s*$|import(?:s)?\\s+(?:the\\s+)?(?:modules?|dependencies)\\s*$)" }]
```
