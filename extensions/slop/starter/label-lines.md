---
id: label-lines
title: Bold labels and label lines
domain: prose
applies: ["reply", "document"]
prompt: false
---

# Bold labels and label lines

## Recognition

Lines open with a bold label such as `**Check:**` or a plain one such as `Status:`, or a bold line stands in for a heading. A complaint or a finding becomes a list of labelled fragments, which performs analysis while it says little.

## Cost

The labels take the place of sentences, so each item lacks a subject or a verb and the reader has to rebuild the claim. A label such as `Check:` also reads as an instruction to the reader. Bold headings break the document outline that a reader or a tool uses to navigate.

## Repair

Write each point as a sentence that says what is true, and use a real heading when the text needs sections. Turning bold labels into italics or code keeps the same move, so change the structure itself.

## Examples

Slop:

```reply
- **Check:** the new file matches the approved draft.
- **Risk:** low.
- **Next:** push after review.
```

Better:

```reply
The new file matches the approved draft, and cmp found no difference. I will push it once the review passes.
```

Slop:

```document
**Background**

Status: the import fails on large files.
```

Better:

```document
## Background

The import fails on files larger than 2 MB because the reader loads the whole file at once.
```

## Detectors

```json
[{ "id": "bold-labels", "in": ["reply", "document"],
   "pattern": "^\\s*(?:[-*+]\\s+|\\d+[.)]\\s+)?(?:\\*\\*|__)[^*_\\n]{1,60}?(?::\\s*(?:\\*\\*|__)|(?:\\*\\*|__)\\s*:)",
   "limit": 1, "per": 150 },
 { "id": "bold-headings", "in": ["reply", "document"],
   "pattern": "^\\s*(?:\\*\\*|__)[^*_\\n]{1,80}(?:\\*\\*|__)\\s*$" },
 { "id": "plain-labels", "in": ["reply", "document"],
   "caseSensitive": true,
   "pattern": "^\\s*(?:[-*+]\\s+|\\d+[.)]\\s+)?\\p{Lu}\\p{L}*(?:\\s+\\p{L}+){0,2}:\\s+\\S",
   "limit": 2, "per": 200 }]
```

## Notes

One bold term inside a sentence is ordinary emphasis and does not match. The bold label detector allows one label for each 150 words, so a short note with a single label passes and a list of labels does not.
