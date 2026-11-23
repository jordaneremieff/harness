---
id: foreign-names
title: Names of things outside the file
domain: code
applies: ["code", "comment", "document"]
prompt: false
---

# Names of things outside the file

## Recognition

A module, a test or a document names a caller, a sibling or a consumer that it does not depend on, because the writer inferred a link. A helper says it exists for one particular feature, or a test asserts the private display format of another module.

## Cost

The file now changes whenever the outside thing changes, although nothing in the code ties them. Readers take the named link as a contract and keep it alive. Between independent modules, the name becomes a private protocol that no document records.

## Repair

Describe the file's own behaviour and its public contract, in its own terms. If two modules must agree on something, write that agreement down where both can follow it, and have each implement it with its own code.

## Examples

Slop:

```ts
// Used by the markdown reader to show the tool card.
export function summarise(result: Result): string {
```

Better:

```ts
// One line that names the outcome and the item count.
export function summarise(result: Result): string {
```
