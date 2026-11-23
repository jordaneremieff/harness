---
id: over-built-scaffolding
title: Scaffolding beyond the need
domain: code
applies: ["code"]
prompt: false
---

# Scaffolding beyond the need

## Recognition

A small need gets a framework: a registry with one entry, a plugin interface with one plugin, options and formats that nobody asked for, or a shared helper made only to remove a few duplicated lines. Code written for one particular case is built as a general system for cases that do not exist.

## Cost

The reader has to learn the abstraction before they can see the one thing it does. Each layer adds tests, names and failure modes, and the next real requirement rarely fits the shape that was guessed.

## Repair

Write the direct code for the case that exists, and generalise only when a second real case arrives and shows what varies. Name the concrete current requirement for every option, format or branch you keep.

## Examples

Slop:

```ts
interface HintProvider { id: string; render(hint: Hint): string }
const providers = new Map<string, HintProvider>();
providers.set("path", { id: "path", render: (hint) => hint.text });
export const renderHint = (hint: Hint) => providers.get(hint.kind)?.render(hint) ?? "";
```

Better:

```ts
export const renderHint = (hint: Hint) => hint.text;
```

## Notes

Duplicated state, such as a cached copy of a value that is cheap to derive, is a related form. Derive the value where it is used unless a measured cost says otherwise.
