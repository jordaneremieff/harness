import assert from "node:assert/strict";
import { test } from "node:test";
import { projectEntry, projectFrame } from "../server/projection.mts";
import type { ConversationFrame, Snapshot } from "./contract.mts";
import { frame } from "./fake-host.mts";
import { transferFrame, transferInspect, transferSnapshot } from "./transfer.mts";

const sourceCoverage = { complete: true, entries: 1, bytes: 65536, hiddenExcluded: 7,
  entryLimitReached: false, byteLimitReached: false };
function snapshot(entries: Snapshot["entries"]): Snapshot {
  return { entries, partial: false, revision: "native-revision", nextBefore: 10,
    coverage: { ...sourceCoverage, entries: entries.length } };
}
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const nativeFacts = (coverage: Snapshot["coverage"]) => ({ complete: coverage.complete, entries: coverage.entries,
  bytes: coverage.bytes, hiddenExcluded: coverage.hiddenExcluded, entryLimitReached: coverage.entryLimitReached,
  byteLimitReached: coverage.byteLimitReached });

test("oversized first entry transfers bounded native-shaped messages and preserves source facts", () => {
  const source = snapshot([{ id: "11", kind: "model", model: [{ role: "assistant", content: [{ type: "text", text: "x".repeat(8 * 1024 * 1024) }] }] }]);
  const result = transferSnapshot(source);
  assert.ok(bytes(result) <= 256 * 1024);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].id, "11");
  assert.ok(Array.isArray(result.entries[0].model));
  assert.deepEqual(nativeFacts(result.coverage), source.coverage);
  assert.equal(result.coverage.truncated, true);
  assert.equal(result.coverage.uiComplete, false);
  assert.equal(result.partial, source.partial);
  assert.equal(result.revision, source.revision);
  assert.equal(result.nextBefore, 10);
  assert.equal(result.sourceNextBefore, 10);
  const displayed = projectFrame({ ...result, live: [], status: { busy: false } });
  assert.equal(displayed.coverage.complete, false);
  assert.equal(displayed.entries[0].messages?.[0].role, "assistant");
  assert.equal(displayed.entries[0].messages?.[0].coverage.truncated, true);
  assert.equal(source.entries[0].model && bytes(source.entries[0].model) > 8 * 1024 * 1024, true);
});

test("bounded history uses the oldest displayed native ID without losing the source continuation", () => {
  const source = snapshot(Array.from({ length: 12 }, (_, index) => ({ id: String(11 + index), kind: "model",
    model: [{ role: "assistant", content: [{ type: "text", text: "x".repeat(50000) }] }] })));
  const result = transferSnapshot(source);
  assert.ok(result.entries.length > 0 && result.entries.length < source.entries.length);
  assert.equal(result.nextBefore, Number(result.entries[0].id));
  assert.equal(result.sourceNextBefore, source.nextBefore);
  assert.equal(result.entries.at(-1)?.id, "22");
  assert.equal(result.coverage.uiOmitted, source.entries.length - result.entries.length);
  assert.deepEqual(nativeFacts(result.coverage), source.coverage);
  assert.ok(bytes(result) <= 256 * 1024);
});

test("safe projected text and tool arguments retain their IDs and display through downstream projection", () => {
  const source = snapshot([{ id: "11", kind: "model", model: [{ role: "assistant", content: [
    { type: "text", text: "Safe text" },
    { type: "toolCall", id: "call-1", name: "fixture", arguments: { public: "visible", secret: "hidden-value" } },
  ] }] }]);
  const result = transferSnapshot(source);
  assert.deepEqual(projectEntry(result.entries[0]), projectEntry(source.entries[0]));
  assert.equal(JSON.stringify(result).includes("hidden-value"), false);
  assert.equal(projectEntry(result.entries[0]).messages?.[0].id, "11:message:0");
});

test("frame transfer omits raw instructions, inbox payloads, signatures and images", () => {
  const source: ConversationFrame = { ...(frame(9) as ConversationFrame), nextBefore: 10, coverage: { ...sourceCoverage },
    entries: [{ id: "11", kind: "model", model: [{ role: "assistant", signature: "signature-secret", content: [
      { type: "thinking", thinking: "private-thinking", redacted: true, signature: "thinking-signature" },
      { type: "image", data: "image-bytes", mimeType: "image/png" },
    ] }] }], rawNativeExtra: "extra-secret" };
  source.status.inbox = [{ message: "inbox-secret" }];
  source.status.agent = { instructions: "instructions-secret", environment: { secret: "environment-secret" }, thinkingLevel: "high" };
  const result = transferFrame(source);
  const encoded = JSON.stringify(result);
  for (const hidden of ["signature-secret", "thinking-signature", "private-thinking", "image-bytes", "inbox-secret", "instructions-secret", "environment-secret", "extra-secret"]) {
    assert.equal(encoded.includes(hidden), false, hidden);
  }
  assert.equal(encoded.includes("Image omitted"), true);
  assert.equal(encoded.includes("[redacted thinking]"), true);
  assert.deepEqual(projectEntry(result.entries[0]), projectEntry(source.entries[0]));
  assert.equal(result.revision, 9);
  assert.equal(result.observedAt, source.observedAt);
  assert.equal(result.storageId, source.storageId);
  assert.equal(result.conversationId, source.conversationId);
  assert.deepEqual(nativeFacts(result.coverage), source.coverage);
  assert.ok(bytes(result) <= 256 * 1024);
});

test("status row truncation preserves native coverage while marking UI completeness false", () => {
  const source = frame(2) as ConversationFrame;
  source.coverage = { ...sourceCoverage };
  source.status.tasks = Array.from({ length: 40 }, (_, index) => ({ id: index + 1, status: "queued" }));
  const result = transferFrame(source);
  assert.equal(Array.isArray(result.status.tasks) && result.status.tasks.length, 32);
  assert.deepEqual(nativeFacts(result.coverage), source.coverage);
  assert.equal(result.coverage.truncated, true);
  assert.equal(result.coverage.uiComplete, false);
  assert.equal(projectFrame(result).coverage.complete, false);
});

test("inspection preserves exact offsets and opaque continuation beside bounded safe content", () => {
  const cursor = { before: 11, view: "history", sessionId: "fixture" };
  const result = transferInspect({ view: "exact", sessionId: "fixture", conversationId: 1,
    entryId: 11, offset: 0, text: "x".repeat(1024 * 1024), nextOffset: 1024 * 1024,
    truncated: false, nextCursor: cursor, secret: "hidden-value" });
  assert.ok(bytes(result) <= 256 * 1024);
  assert.equal(result.entryId, 11);
  assert.equal(result.offset, 0);
  assert.equal(result.nextOffset, 1024 * 1024);
  assert.deepEqual(result.nextCursor, cursor);
  assert.equal(result.uiTruncated, true);
  assert.equal(result.truncated, true);
  assert.equal(JSON.stringify(result).includes("hidden-value"), false);
  assert.throws(() => transferInspect({ view: "history", sessionId: "fixture", conversationId: 1,
    nextCursor: { text: "x".repeat(4096) } }), /cursor exceeds/);
});
