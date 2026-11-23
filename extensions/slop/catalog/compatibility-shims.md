---
id: compatibility-shims
title: Unrequested compatibility code
domain: code
applies: ["comment", "code", "document"]
prompt: false
---

# Unrequested compatibility code

## Recognition

New or personal code carries machinery for older versions that no current user needs. Examples are code that reads both the current and a retired format, migrations, aliases for renamed fields, and comments such as `kept for backward compatibility`. It often appears in a feature that has never shipped, so nothing older exists.

## Cost

Every branch for an old form is code to read, test and keep correct. It hides the one current path, and later changes have to preserve behaviour that serves nobody.

## Repair

Support only the current form and delete the old path. Add compatibility only for a named current requirement, such as a deployed reader that cannot update, and state that requirement where the code lives.

## Examples

Slop:

```ts
// Kept for backward compatibility with the old format.
const name = record.name ?? record.legacyName;
```

Better:

```ts
const name = record.name;
```

Slop:

```ts
export function readLegacyConfig(path: string) {
```

Better:

```ts
export function readConfig(path: string) {
```

## Detectors

```json
[{ "id": "compatibility-words", "in": ["comment", "document"],
   "pattern": "\\b(?:backwards?[\\s-]compat\\w*|for\\s+compatibility\\s+with|kept\\s+for\\s+compatibility|deprecated\\s+alias(?:es)?|fallback\\s+for\\s+(?:older|old|previous)|old\\s+(?:format|schema|layout)s?\\b|dual[\\s-]read\\w*)" },
 { "id": "legacy-names", "in": ["code"],
   "caseSensitive": true,
   "pattern": "(?<![\\p{L}\\p{N}_$])(?:(?:legacy|Legacy|compat|Compat|deprecated|Deprecated)[A-Z_][\\w$]*|(?:LEGACY|COMPAT|DEPRECATED)_[A-Z0-9_$]+|[a-z][\\w$]*?(?:Legacy|Compat|Deprecated)(?!\\p{Ll}))" }]
```

## Notes

A protocol that talks to software outside this repository, such as a terminal key encoding or a file format another program writes, can carry real legacy forms. Name the outside party in a comment and the finding becomes a reviewed decision.
