---
id: hardcoded-counts
title: Hardcoded counts in durable documents
domain: prose
applies: ["document"]
prompt: false
---

# Hardcoded counts in durable documents

## Recognition

A README or a reference document states how many tests, tools, files or rules exist, such as `all 293 passing tests` or `12 registered tools`. The number describes one moment of the tree.

## Cost

The count is wrong after the next change, and nobody updates it. A reader who trusts it draws a false conclusion, and a passing test total in a document reads as acceptance that it never established.

## Repair

Name the command or the surface that measures the count, such as `npm test` or the tool inventory, and leave the number out.

## Examples

Slop:

```md
The suite has 293 passing tests and the extension has 12 registered tools.
```

Better:

```md
Run `npm test` for the suite. The `slop` tool lists the registered entries.
```

## Detectors

```json
[{ "id": "tree-counts", "in": ["document"],
   "pattern": "(?<![\\d.,])\\b(?:[2-9]|[1-9]\\d+)\\s+(?:(?:passing|failing|new|unit|shipped|registered|built-in)\\s+)?(?:tests?|tools?|files?|extensions?|skills?|commands?)\\b",
   "paths": ["**/*.md"] }]
```

## Notes

The detector runs on Markdown files in the tree and on their diffs, not on documents written for a person. A report to the operator can state how many tests ran, because it describes one run.
