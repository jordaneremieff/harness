---
id: wasteful-tests
title: Wasteful tests
domain: code
applies: ["code", "comment"]
prompt: false
---

# Wasteful tests

## Recognition

Tests check what the language or a library already guarantees, repeat the same case with cosmetic changes, pin the exact wording of internal text, or assert the private shape of another module. Their names narrate the history of a fix instead of the behaviour they hold.

## Cost

The suite gets slower and larger without catching more defects. Every harmless change breaks a dozen assertions, which teaches the next writer to update tests without reading them.

## Repair

Test the behaviour a caller depends on, at the smallest number of cases that cover its branches and limits. Delete tests that cannot fail for a real defect, and name each remaining test after the rule it holds.

## Examples

Slop:

```ts
test("constructor sets fields", () => {
  const entry = new Entry("a", "b");
  assert.equal(entry.id, "a");
  assert.equal(entry.title, "b");
});
```

Better:

```ts
test("an entry whose id differs from its file name is refused", () => {
  assert.throws(() => parseEntry(text, "other-id", "shipped"), /file name/);
});
```
