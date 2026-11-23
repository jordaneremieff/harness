---
id: swallowed-errors
title: Swallowed errors
domain: code
applies: ["code"]
prompt: false
---

# Swallowed errors

## Recognition

A `catch` block or an `except` clause discards the error with an empty body and no comment, so a failure leaves no trace. The code looks safe because nothing throws.

## Cost

When the operation fails, the program carries on with missing or stale state, and the cause is gone. The reader cannot tell whether the author meant to ignore the error or forgot to handle it.

## Repair

Handle the error, let it propagate, or record why it is safe to ignore in a comment inside the block, such as a file that may already be gone during cleanup. Catch only the error you expect.

## Examples

Slop:

```ts
try {
  await writeState(path, state);
} catch {}
```

Better:

```ts
try {
  await rm(lockPath);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
```

Slop:

```py
try:
    save(state)
except: pass
```

Better:

```py
save(state)
```

## Detectors

```json
[{ "id": "empty-handlers", "in": ["code"],
   "pattern": "\\bcatch\\s*(?:\\([^)]*\\))?\\s*\\{\\s*\\}|^\\s*except\\b[^:]*:\\s*pass\\b",
   "paths": ["**/!(*.test).ts", "**/!(*.test).mts", "**/!(*.test).cts", "**/!(*.test).tsx", "**/*.js", "**/*.mjs", "**/*.cjs", "**/*.swift", "**/*.py", "**/*.kt", "**/*.java", "**/*.cs"] }]
```

## Notes

Cleanup on the way out, such as removing a temporary file, can ignore errors on purpose. A short comment inside the braces states that intent and removes the finding, because the block is no longer empty in the code text. The detector skips TypeScript test files, where an empty handler in teardown is routine.
