---
id: type-escape-hatches
title: Type escape hatches
domain: code
applies: ["code", "comment"]
prompt: false
---

# Type escape hatches

## Recognition

TypeScript code switches off the type checker instead of modelling the value: `as unknown as T` chains, `any` in types and casts, `@ts-ignore` comments, and dictionary types such as `Record<string, any>`. A related form widens a value to `unknown` and then asserts it back to a type.

## Cost

The checker stops guarding the very place where the value's shape was in doubt. A later change that breaks the shape compiles and fails at run time, far from the cast.

## Repair

Give the value its real type, narrow it with a check at the boundary where it enters, or fix the declaration that forced the cast. If a cast is the only way through an outside type, keep one cast at that boundary and say why.

## Examples

Slop:

```ts
const job = record as unknown as JobRecord;
```

Better:

```ts
const job = parseJobRecord(record);
```

Slop:

```ts
// @ts-ignore
const handler: any = registry.get(name);
```

Better:

```ts
const handler = registry.get(name);
if (!handler) throw new Error(`Unknown handler ${name}.`);
```

## Detectors

```json
[{ "id": "double-cast", "in": ["code"],
   "pattern": "\\bas\\s+unknown\\s+as\\b",
   "paths": ["**/!(*.test).ts", "**/!(*.test).mts", "**/!(*.test).cts", "**/!(*.test).tsx"] },
 { "id": "any-types", "in": ["code"],
   "pattern": ":\\s*any\\b(?!\\s+\\w)|\\bas\\s+any\\b|<any>|\\bany\\[\\]|Record<\\s*string\\s*,\\s*any\\s*>",
   "paths": ["**/*.ts", "**/*.mts", "**/*.cts", "**/*.tsx"] },
 { "id": "suppressions", "in": ["comment"],
   "pattern": "@ts-(?:ignore|nocheck)\\b(?!\\s*[:-]\\s*\\S)" }]
```

## Notes

Tests often cast fixtures to reach a private shape, so the double cast detector skips test files. A boundary that receives untyped JSON from a host or a store can need one cast. The detector cannot tell that case from the slop case, so a finding asks for a review, not a removal.
