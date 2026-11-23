---
id: history-comments
title: Comments that tell the history
domain: code
applies: ["comment", "commit", "document"]
prompt: false
---

# Comments that tell the history

## Recognition

A comment, a test name or a durable document describes how the code came to be instead of what it does now. It names a stage of the work, such as `Phase 2 fix`, `per review` or `added for this task`, or it compares the code with an earlier version, such as `previously this returned null`.

## Cost

The history is true only for the session that wrote it. Later readers cannot see the task or the old version, so the comment points at things they cannot check. It also ages badly, because the next change makes it wrong.

## Repair

Describe the current behaviour, the rule it keeps, or the reason that a reader cannot see from the code. Put the history in the commit message or drop it. A commit message says what the repository now does and why, without the review rounds or the order of the work.

## Examples

Slop:

```ts
// Phase 2 fix: previously this returned null, which broke the caller.
export function parse(text: string): Entry[] {
```

Better:

```ts
// An empty file yields no entries, so callers never handle null.
export function parse(text: string): Entry[] {
```

Slop:

```commit
Address review feedback from round 2
```

Better:

```commit
Reject entries whose id differs from the file name
```

## Detectors

```json
[{ "id": "work-chronology", "in": ["comment", "commit", "document"],
   "phrases": ["added for this task", "for this task only", "temporary workaround", "per review", "review feedback", "review round", "correction pass", "as discussed", "as agreed"] },
 { "id": "work-phases", "in": ["comment", "commit"],
   "pattern": "\\b(?:phase|lane|wave|milestone|round)\\s+\\d+\\b|\\bitem\\s+\\d+\\s*(?:fix|change|:)" },
 { "id": "version-comparison", "in": ["comment"],
   "pattern": "\\b(?:previously|formerly|used\\s+to\\s+be|was\\s+changed\\s+to|has\\s+been\\s+changed|the\\s+old\\s+(?:code|version|behaviou?r|approach|implementation|format))\\b" }]
```

## Notes

A comment can still name a past failure when the reason is durable, for example a test that pins a bug in a parser. Say what input fails and what must hold, without the words that place it in time.
