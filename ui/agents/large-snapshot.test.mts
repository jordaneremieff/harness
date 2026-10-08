import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { decodeResponse } from "./contract.mts";

test("a large first snapshot entry retains its native continuation and coverage", t => {
  const text = "x".repeat(8 * 1024 * 1024);
  const response = { entries: [{ id: "10", kind: "message", model: [{ role: "assistant", content: [{ type: "text", text }] }] }],
    partial: true, revision: "large-first-entry", nextBefore: 10,
    coverage: { complete: false, entries: 1, bytes: text.length, hiddenExcluded: 0, entryLimitReached: false, byteLimitReached: true } };
  const started = performance.now();
  const decoded = decodeResponse("snapshot", response);
  const elapsed = performance.now() - started;
  assert.equal(decoded.nextBefore, 10);
  assert.equal(decoded.coverage.complete, false);
  assert.equal(decoded.entries.length, 1);
  t.diagnostic(`Native decoder cost for an 8 MiB first entry: ${elapsed.toFixed(3)} ms. This excludes Unix/CBOR and browser projection.`);
});
