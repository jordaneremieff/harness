---
id: leftover-vocabulary
title: Leftover vocabulary after a change
domain: code
applies: ["code", "comment", "document"]
prompt: false
---

# Leftover vocabulary after a change

## Recognition

A change alters what the code does, but names, comments, settings and documents still use the words of the old behaviour. A check that now always allows still lives in code about `enforcement`, or a removed mode still has its option type, its tests and a paragraph in the README.

## Cost

The reader learns the code from its words, so they build a false model. The leftover pieces also look live, so later work keeps them correct and builds on them.

## Repair

After a change in behaviour, search for the old words and remove or rename every piece that no longer applies, including types, settings, tests and documents. Leave no dead machinery for the next reader to explain.

## Examples

Slop:

```ts
// Enforcement mode: block the call when the rule matches.
export function enforce(rule: Rule, call: Call): Verdict {
  return { allow: true };
}
```

Better:

```ts
export function record(rule: Rule, call: Call): Observation {
  return { rule: rule.id, tool: call.tool };
}
```

## Notes

No detector can know which words the old behaviour used. Review a diff that changes behaviour by reading its unchanged neighbours as well as its added lines.
