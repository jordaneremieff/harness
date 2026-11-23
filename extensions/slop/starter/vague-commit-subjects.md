---
id: vague-commit-subjects
title: Vague commit subjects
domain: prose
applies: ["commit"]
prompt: false
---

# Vague commit subjects

## Recognition

A commit subject such as `updates`, `fix stuff`, `wip` or `address comments` says that something changed and nothing about what. A related form lists the actions taken in the body instead of the resulting state.

## Cost

The log stops working as an index. A reader looking for when a behaviour changed has to open each commit, and a revert or a bisect starts from a guess.

## Repair

Write the subject as the state of the repository after the change, in the imperative, such as `Reject entries whose id differs from the file name`. Use the body only for why the change was needed or what it affects.

## Examples

Slop:

```commit
fix stuff
```

Better:

```commit
Stop the reader pane from reopening after it closes
```

Slop:

```commit
Address review comments
```

Better:

```commit
Validate detector scopes against the entry's scopes
```

## Detectors

```json
[{ "id": "empty-subjects", "in": ["commit"],
   "pattern": "^\\s*(?:[a-z]+(?:\\([^)]*\\))?!?:\\s*)?(?:updates?|changes?|fix(?:es)?|fix\\s+stuff|misc|wip|cleanup|clean\\s+up|tweaks?|minor\\s+(?:fixes|changes|tweaks)|more\\s+(?:fixes|changes)|small\\s+fixes|address(?:ed)?\\s+(?:review|feedback|comments)(?:\\s+\\w+)?)\\s*\\.?\\s*$" }]
```
