---
id: insider-language
title: Jargon and insider references
domain: prose
applies: ["reply", "document"]
prompt: false
---

# Jargon and insider references

## Recognition

The text uses terms, codes and names that make sense only inside the writer's working context: internal identifiers, raw hashes and session ids, labels such as `lane B` or `finding 3`, and jargon stacked until a sentence carries no picture. The reader asks what it means in plain English.

## Cost

The reader cannot follow the text without the context the writer had. They have to ask for a translation, or they act on a guess. A decision based on such text has no usable basis.

## Repair

Say what each thing is in ordinary words the first time it appears, and drop references the reader cannot see. Keep a path, a hash or an identifier only when the reader needs it to act, put it in backticks, and say what it is.

## Examples

Slop:

```reply
Fixed in 3f2a9c1e. The agent_send path now honours replyTo when the fullGate claim clears.
```

Better:

```reply
The fix is committed. When an agent sends a message, the answer now goes to the conversation that asked for it, even after another task has finished its test run.
```

Slop:

```reply
Session 5c1e8a2b-0d4f-4b7e-9a61-2f3c7d8e9b10 holds the lock.
```

Better:

```reply
The review session holds the lock, so the full test run waits until that session ends.
```

## Detectors

```json
[{ "id": "raw-ids", "in": ["reply", "document"],
   "pattern": "(?<![\\p{L}\\p{N}])(?=[0-9a-f]*\\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![\\p{L}\\p{N}])",
   "limit": 1 },
 { "id": "raw-identifiers", "in": ["reply"],
   "caseSensitive": true,
   "pattern": "(?<![\\p{L}\\p{N}_.\\/-])(?:\\p{Ll}+(?:_\\p{Ll}[\\p{Ll}\\p{N}]*){1,12}|\\p{Ll}+\\p{Lu}[\\p{L}\\p{N}]*)(?![\\p{L}\\p{N}_.\\/-])",
   "limit": 2, "per": 200, "distinct": true, "lexicon": true,
   "allow": ["macOS", "iOS", "iPadOS", "iPhone", "iPad", "iCloud", "eBay", "pH"] }]
```

## Notes

Text inside backticks is skipped, so an identifier that the reader must type stays allowed there. The detectors catch raw hashes, ids and code names outside backticks. The id detector allows one, such as the commit that a reply names. The code name detector runs on replies only, because reference documents name functions and settings on purpose. No detector catches prose jargon, which needs judgment.
