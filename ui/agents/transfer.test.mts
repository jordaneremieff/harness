import assert from "node:assert/strict";
import { test } from "node:test";
import { projectEntry, projectFrame } from "../server/projection.mts";
import { decodeFrame, type ConversationFrame, type Snapshot } from "./contract.mts";
import { frame } from "./fake-host.mts";
import { transferFrame, transferInspect, transferSnapshot, transferThread } from "./transfer.mts";

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

test("native tool slots without output survive bounded transfer and repeated projection", () => {
  const source = frame(4) as ConversationFrame;
  source.status.busy = true;
  const tools = ['pending','running','done'].map((status, index) => ({callId:`call-${index}`,name:'read',status}));
  source.status.live = {tools};
  assert.deepEqual(decodeFrame(source), source);
  const transferred = transferFrame(source), displayed = projectFrame(transferred);
  assert.deepEqual(decodeFrame(transferred), transferred);
  assert.equal(transferred.status.live, null);
  assert.deepEqual(displayed.status.tools, tools);
  assert.deepEqual(projectFrame(displayed).status.tools, tools);
  assert.deepEqual(projectFrame(transferFrame(transferred)).status.tools, tools);
  const many = Array.from({length:65}, (_, index) => ({callId:`call-${index}`,name:'read',status:'running'}));
  source.status.live = {tools:many};
  const bounded = transferFrame(source), repeated = projectFrame(transferFrame(bounded));
  assert.equal(repeated.status.tools?.length, 64);
  assert.equal(repeated.status.toolsOmitted, 1);
  assert.equal(repeated.coverage.truncated, true);
  assert.equal(bounded.coverage.complete, true);
  assert.equal(bounded.coverage.uiComplete, false);
  assert.ok(bytes(bounded) <= 256 * 1024);
});

test("native retries and provider blocks survive worker transfer and repeated projection", () => {
  const source = frame(7) as ConversationFrame;
  source.status.live = {generation: {attempt: 2, retry: {at: 1700000060000, error: 'Bearer private-token'}}}; source.status.busy = true;
  source.status.providerBlock = {blockId: 'block', conversationId: 1, providerSessionId: 'provider-session', epoch: 1,
    model: {provider: 'fixture', modelId: 'fixture'}, error: 'Bearer private-token', errorRedacted: false, errorTruncated: false,
    source: 'provider', timestamp: 1700000000000, originalResults: [{sessionId: source.storageId, submissionId: 1, requestId: '雪'.repeat(1024)}, {sessionId: source.storageId, submissionId: 2, requestId: 'Bearer private-token'}], omittedOriginalResults: 0};
  assert.deepEqual(decodeFrame(source), source);
  const direct = projectFrame(source), transferred = transferFrame(source), displayed = projectFrame(transferred);
  assert.deepEqual(displayed.status.retry, direct.status.retry); assert.deepEqual(displayed.status.providerBlock, direct.status.providerBlock);
  assert.deepEqual(projectFrame(displayed).status, displayed.status);
  assert.equal(displayed.status.retry?.at, 1700000060000); assert.equal(displayed.status.retry?.attempt, 2);
  assert.equal(displayed.status.providerBlock?.errorRedacted, true); assert.equal(displayed.status.providerBlock?.originalResults[0].submissionId, 1);
  assert.equal(displayed.status.providerBlock?.originalResults[0].requestId, '雪'.repeat(1024)); assert.equal(displayed.status.providerBlock?.omittedOriginalResults, 1);
  assert.doesNotMatch(JSON.stringify(transferred), /private-token/); assert.ok(bytes(transferred) <= 256 * 1024);
});
test("large provider blocks reserve transfer space before transcript entries", () => {
  const source = frame(8) as ConversationFrame;
  source.entries = Array.from({length: 8}, (_, index) => ({id: String(index + 1), kind: 'pi.assistant', model: [{role: 'assistant', content: [{type: 'text', text: 'x'.repeat(60000)}]}]}));
  source.status.providerBlock = {blockId: 'block', conversationId: 1, providerSessionId: 'provider-session', epoch: 1, model: {provider: 'fixture', modelId: 'fixture'}, error: 'x'.repeat(4096), errorRedacted: false, errorTruncated: false, source: 'provider', timestamp: 1,
    originalResults: Array.from({length: 16}, (_, index) => ({sessionId: source.storageId, submissionId: index + 1, requestId: 'r'.repeat(1024)})), omittedOriginalResults: 0};
  const result = transferFrame(source); assert.ok(bytes(result) <= 256 * 1024); assert.ok(result.entries.length < source.entries.length);
  assert.equal(projectFrame(result).status.providerBlock?.originalResults.length, 16); assert.equal(result.coverage.truncated, true);
});
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

test("frame transfer omits raw instructions, inbox payloads, signatures and malformed image payloads", () => {
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
  assert.equal(encoded.includes("Image base64 is invalid."), true);
  assert.equal(encoded.includes("[redacted thinking]"), true);
  assert.deepEqual(projectEntry(result.entries[0]), projectEntry(source.entries[0]));
  assert.equal(result.revision, 9);
  assert.equal(result.observedAt, source.observedAt);
  assert.equal(result.storageId, source.storageId);
  assert.equal(result.conversationId, source.conversationId);
  assert.deepEqual(nativeFacts(result.coverage), source.coverage);
  assert.ok(bytes(result) <= 256 * 1024);
});

test("nested tools and compactions survive the worker boundary and downstream projection", () => {
  const source = frame(3) as ConversationFrame;
  source.coverage = {...sourceCoverage};
  source.live = [{id: "live:tool:outer/inner", kind: "pi.tool-result", data: {live: true, nestedTool: {
    callId: "outer/inner", name: "custom", taskId: 4, parentTaskId: 3, parentCallId: "outer", status: "done",
    arguments: {value: "input", secret: "private-argument"}, output: "output", droppedBytes: 1, summary: {isError: false, durationMs: 0},
  }}}];
  source.status.live = {compactions: [{taskId: 5, reason: "threshold", attempt: 1, blocking: true, retry: {at: 1, error: "retry"}}],
    compactionFailure: {taskId: 6, reason: "manual", error: "Bearer private-token"}};
  const direct = projectFrame(source), transferred = transferFrame(source), result = projectFrame(transferred);
  assert.deepEqual(result.live, direct.live); assert.deepEqual(result.status.compactions, direct.status.compactions);
  assert.deepEqual(result.status.compactionFailure, direct.status.compactionFailure); assert.equal(result.coverage.truncated, true);
  assert.equal(result.live[0].messages, undefined); assert.equal(result.live[0].tool?.durationMs, 0);
  assert.equal(result.live[0].tool?.output?.truncation?.truncated, true);
  assert.doesNotMatch(JSON.stringify(transferred), /private-argument|private-token/);
  assert.equal(Object.hasOwn(result.status.compactionFailure?.value as object, "at"), false);
  assert.ok(bytes(transferred) <= 256 * 1024);
});

for (const field of ["diagnostic", "summary"] as const) test(`nested ${field} clipping stays visible through worker transfer and repeat projection`, () => {
  const source = frame(3) as ConversationFrame;
  source.coverage = {...sourceCoverage, entries: 0};
  const nestedTool = {callId: "outer/inner", name: "custom", taskId: 4, parentTaskId: 3, parentCallId: "outer",
    status: "done", arguments: {}, diagnostics: field === "diagnostic" ? [{severity: "warn", message: "x".repeat(2048)}] : [],
    summary: {isError: true, durationMs: 0, ...(field === "summary" ? {error: "界".repeat(500)} : {})}};
  source.live = [{id: "live:tool:outer/inner", kind: "pi.tool-result", data: {live: true, nestedTool}}];
  source.status.live = {nestedTools: [nestedTool]};
  assert.deepEqual(decodeFrame(source), source);
  const direct = projectFrame(source), transferred = transferFrame(source), displayed = projectFrame(transferred);
  for (const view of [direct, displayed, projectFrame(direct)]) {
    assert.equal(view.live[0].tool?.coverage.truncated, true);assert.equal(view.live[0].tool?.coverage.complete, false);
    assert.equal(view.coverage.truncated, true);assert.equal(view.coverage.complete, false);
    assert.ok(bytes(view.live[0]) <= 60 * 1024);
    assert.ok((view.live[0].tool?.parts?.[0].type === "text" ? view.live[0].tool.parts[0].text : "").includes("[truncated]"));
  }
  assert.equal(transferred.coverage.complete, true);assert.equal(transferred.coverage.uiComplete, false);
  assert.equal(transferred.coverage.truncated, true);assert.ok(bytes(transferred) <= 256 * 1024);
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

test("thread transfers pass bounded values unchanged and refuse an oversized worker result", () => {
  const value = { items: [], nextCursor: null, coverage: { complete: true, visited: 0, omitted: 0 } };
  assert.equal(transferThread(value), value);
  assert.throws(() => transferThread({ text: "x".repeat(256 * 1024) }), { code: "protocol_error" });
});
