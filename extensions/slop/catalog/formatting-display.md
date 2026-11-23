---
id: formatting-display
title: Formatting for display
domain: prose
applies: ["reply", "document"]
prompt: false
---

# Formatting for display

## Recognition

Tables, headings, numbered taxonomies and status columns appear because they look organised, and the content does not need them. A table holds one fact per row with filler cells such as `not run` that the reader cannot interpret. A complaint from the reader comes back as a numbered taxonomy of its own points.

## Cost

The structure takes the screen space it claimed to save. The reader has to work out what each column or category means before they can find the fact they wanted. Classification looks like analysis while it adds no claim.

## Repair

Let the content choose the form. Use sentences for a few facts and a table only when the reader compares several items on the same fields. Give each cell a value the reader can act on.

## Examples

Slop:

```reply
| Area | Status | Notes |
| --- | --- | --- |
| Tests | not run | n/a |
| Lint | passed | ok |
```

Better:

```reply
Lint passed. I have not run the tests because the suite needs the database, which is down.
```
