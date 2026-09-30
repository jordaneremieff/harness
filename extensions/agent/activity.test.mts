import assert from "node:assert/strict";
import { test } from "node:test";
import { Check, Errors } from "typebox/value";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { ACTIVITY_LIMITS, activityDuration, activityExcerpt } from "./activity.ts";
import { projectInspection, type InspectionOwner } from "./worker.ts";
import { validateInspect } from "./evidence.ts";
import { InspectOutputSchema, StatusOutputSchema, observationResult, supervisionObservation } from "./observations.ts";

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop", errorMessage?: string): AssistantMessage {
	return { role: "assistant", api: "openai-responses", provider: "test", model: "model", content, stopReason, errorMessage, timestamp: 1,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function activity(manager: SessionManager, options: { limit?: number; cursor?: number } = {}, owner?: InspectionOwner) {
	const result = projectInspection(manager, manager.getSessionId(), { view: "activity", ...options }, owner);
	assert.ok("turns" in result && result.view === "activity");
	return result;
}
const call = (id: string) => ({ type: "toolCall" as const, id, name: "bash", arguments: { command: "npm test" } });

test("activity segments native inputs into recent turns and continues by entry index", () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "first task", timestamp: 1 });
	manager.appendMessage(assistant([{ type: "text", text: "first answer" }]));
	manager.appendCustomMessageEntry("peer", "redirect", true);
	manager.appendMessage(assistant([{ type: "text", text: "second answer" }]));
	manager.appendMessage({ role: "custom", customType: "steer", content: "third input", display: true, timestamp: 2 });
	manager.appendMessage(assistant([{ type: "text", text: "third answer" }]));
	const recent = activity(manager, { limit: 2 });
	assert.equal(recent.turns.length, 2); assert.equal(recent.nextCursor, 2);
	assert.match(recent.turns[0].rows[0].text, /third input/);
	assert.match(recent.turns[1].rows[0].text, /redirect/);
	assert.match(recent.text, /task: first task/);
	const older = activity(manager, { limit: 2, cursor: recent.nextCursor });
	assert.equal(older.nextCursor, null); assert.equal(older.turns.length, 1);
	assert.match(older.text, /first answer/); assert.doesNotMatch(older.text, /third answer/);
	assert.equal(recent.coverage.considered, recent.coverage.rendered + recent.coverage.omitted);
});

test("activity keeps adjacent and mid-turn custom inputs with the user task", () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "CURRENT_TASK", timestamp: 1 });
	manager.appendCustomMessageEntry("context", "CONTEXT_SNAPSHOT", true);
	manager.appendMessage(assistant([call("active")], "toolUse"));
	manager.appendMessage({ role: "custom", customType: "peer", content: "MID_TURN_INPUT", display: true, timestamp: 2 });
	manager.appendCustomMessageEntry("context", "CONSECUTIVE_INPUT", true);
	const current = activity(manager, { limit: 1 });
	assert.equal(current.turns.length, 1); assert.equal(current.nextCursor, null);
	assert.deepEqual(current.turns[0].rows.filter((row) => row.kind === "user" || row.kind.startsWith("input:")).map((row) => row.text), ["CURRENT_TASK", "CONTEXT_SNAPSHOT", "MID_TURN_INPUT", "CONSECUTIVE_INPUT"]);
	manager.appendMessage(assistant([], "aborted", "stopped"));
	manager.appendCustomMessageEntry("peer", "NEXT_TASK", true);
	manager.appendCustomMessageEntry("context", "NEXT_CONTEXT", true);
	const next = activity(manager, { limit: 1 });
	assert.equal(next.turns.length, 1); assert.equal(next.nextCursor, 6);
	assert.match(next.text, /NEXT_TASK/); assert.equal(next.turns[0].rows.length, 2);
	const older = activity(manager, { cursor: next.nextCursor, limit: 1 });
	assert.match(older.text, /MID_TURN_INPUT/); assert.equal(older.nextCursor, null);
});

test("activity separates excerpt clipping from the digest byte bound", () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "x".repeat(1000), timestamp: 1 });
	const value = activity(manager, { limit: 1 });
	assert.equal(value.coverage.truncated, false); assert.equal(value.coverage.excerptsClipped, true);
	assert.equal(value.coverage.headerTruncated, false); assert.equal(value.coverage.entryLimitReached, false);
	assert.equal(value.coverage.rowLimitReached, false); assert.ok(Buffer.byteLength(value.text) < 2000);
	assert.match(value.text, /excerpts clipped/); assert.doesNotMatch(value.text, /digest byte bound|=false/);
});

test("activity formats readable durations without changing numeric evidence", () => {
	assert.equal(activityDuration(381000), "6m 21s"); assert.equal(activityDuration(3601000), "1h 0m 1s");
	assert.equal(activityDuration(5900), "5s"); assert.equal(activityDuration(500), "500ms");
});

test("activity exposes long-result failures, paired outcomes, exact live calls and assistant errors", () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "check", timestamp: 1 });
	const source = manager.appendMessage(assistant([call("failed"), call("pending"), call("unresolved")], "toolUse"));
	const result = manager.appendMessage({ role: "toolResult", toolCallId: "failed", toolName: "bash", content: [{ type: "text", text: `error details ${"x".repeat(5000)} actual failure at end` }], isError: true, timestamp: 2 });
	manager.appendMessage(assistant([], "error", "provider rejected"));
	manager.appendMessage(assistant([], "aborted", "explicit stop"));
	const value = activity(manager, {}, { operation: "op", lastError: "provider rejected", runningCallIds: ["pending"], currentTools: ["bash"], activity: { state: "working", pending: 2, lastPersistedAt: null, lastText: "current reply", runningTools: [{ toolCallId: "pending", name: "bash", startedAt: new Date().toISOString(), elapsedMs: 500 }] } });
	const rows = value.turns.flatMap((turn) => turn.rows);
	assert.deepEqual(rows.filter((row) => row.toolCallId).map((row) => row.outcome), ["error", "running", "without result"]);
	assert.equal(rows.find((row) => row.toolCallId === "failed")?.isError, true);
	assert.equal(rows.find((row) => row.toolCallId === "failed")?.resultEntryId, result);
	assert.equal(rows.find((row) => row.toolCallId === "failed")?.entryId, source);
	assert.equal(rows.find((row) => row.toolCallId === "pending")?.runningForMs, 500);
	assert.ok(rows.find((row) => row.toolCallId === "unresolved")?.ageMs !== undefined);
	assert.match(value.text, /isError=true.*error details/); assert.match(value.text, /actual failure at end/);
	assert.match(value.text, /provider rejected/); assert.match(value.text, /explicit stop/);
	assert.match(value.text, /persisted call age/); assert.match(value.text, /running for 500ms/);
	assert.match(value.text, /not yet persisted; operation=op/);
	assert.equal(value.metadata.pending, 2);
});

test("activity keeps repeated call IDs paired with their own chronological outcomes", () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage(assistant([call("same")], "toolUse"));
	manager.appendMessage({ role: "toolResult", toolCallId: "same", toolName: "bash", content: [{ type: "text", text: "first" }], isError: true, timestamp: 2 });
	manager.appendMessage(assistant([call("same")], "toolUse"));
	manager.appendMessage({ role: "toolResult", toolCallId: "same", toolName: "bash", content: [{ type: "text", text: "second" }], isError: false, timestamp: 3 });
	const rows = activity(manager).turns.flatMap((turn) => turn.rows);
	assert.deepEqual(rows.map((row) => row.isError), [true, false]);
	assert.match(rows[0].text, /first/); assert.match(rows[1].text, /second/);
});

test("activity omits thinking and binary payloads and projects native metadata", () => {
	const manager = SessionManager.inMemory();
	manager.appendModelChange("test", "model"); manager.appendThinkingLevelChange("high");
	manager.appendMessage({ role: "user", content: [{ type: "image", data: "SECRET_IMAGE", mimeType: "image/png" }], timestamp: 1 });
	manager.appendMessage(assistant([{ type: "thinking", thinking: "SECRET_THINKING" }, { type: "text", text: "answer", textSignature: "SECRET_SIGNATURE" }]));
	manager.appendMessage({ role: "bashExecution", command: "true", output: "done", exitCode: 0, cancelled: false, truncated: false, timestamp: 2 });
	manager.appendCustomEntry("agent.operation", { operationId: "op" });
	manager.appendCustomEntry("agent.result", { operationId: "op", status: "failed", error: { message: "execution failed" } });
	manager.appendCustomEntry("other.type", { secret: "PRIVATE_CUSTOM_DATA" });
	manager.appendCompaction("retained summary", manager.getEntries()[0].id, 10);
	const value = activity(manager, { limit: 12 });
	assert.equal(value.coverage.thinking, 1);
	assert.match(value.text, /\[image\]/); assert.doesNotMatch(value.text, /SECRET_|PRIVATE_CUSTOM_DATA/);
	assert.match(value.text, /model: test\/model; thinking: high/);
	assert.match(value.text, /last saved result: failed; operation=op/);
	assert.match(value.text, /other.type/); assert.match(value.text, /retained summary/);
});

test("activity clips Unicode and control-heavy input within its digest byte bound", () => {
	assert.equal(activityExcerpt("ab😀z", 3), "ab [3 characters omitted]");
	assert.equal(activityExcerpt("\u001bmore", 3), " [5 characters omitted]");
	const manager = SessionManager.inMemory();
	manager.appendSessionInfo("界".repeat(20000));
	manager.appendMessage({ role: "user", content: Array.from({ length: 20 }, () => ({ type: "text" as const, text: "界😀\u0000".repeat(10000) })), timestamp: 1 });
	for (let index = 0; index < 140; index++) manager.appendMessage(assistant([{ type: "text", text: "界😀".repeat(20000) }]));
	const value = activity(manager, { limit: 12 });
	assert.ok(Buffer.byteLength(value.text) <= ACTIVITY_LIMITS.bytes, String(Buffer.byteLength(value.text)));
	assert.equal(value.coverage.considered, 128); assert.ok(value.coverage.omitted > 0); assert.equal(value.coverage.truncated, true);
	assert.match(value.text, /characters omitted/); assert.equal(/[\uD800-\uDFFF]/u.test(value.text), false);
	assert.ok(value.nextCursor !== null);
	const older = activity(manager, { cursor: value.nextCursor });
	assert.ok(Buffer.byteLength(older.text) <= ACTIVITY_LIMITS.bytes);
});

test("activity schemas preserve read-only absence, capture bounds, and live metadata", () => {
	const manager = SessionManager.inMemory();
	for (const available of [true, false]) {
		const value = projectInspection(manager, manager.getSessionId(), { view: "activity" }, undefined, { available, bytes: 321, unfinishedTail: true, reason: "capture incomplete" });
		assert.ok("turns" in value && value.view === "activity");
		assert.equal(value.metadata.ownerState, "unavailable"); assert.equal(value.metadata.pending, null);
		assert.match(value.text, /live activity unavailable/); assert.match(value.text, /bytes=321; unfinishedTail=true/);
		const json = observationResult(value).structuredContent;
		assert.equal(Check(InspectOutputSchema, json), true, JSON.stringify([...Errors(InspectOutputSchema, json)]));
	}
	const value = activity(manager, {}, { operation: null, lastError: undefined, activity: { state: "idle", pending: 0, lastPersistedAt: null } });
	assert.equal(value.metadata.ownerState, "idle");
	assert.equal(Check(InspectOutputSchema, observationResult(value).structuredContent), true);
});

test("activity selectors reject every unrelated field without loosening other views", () => {
	validateInspect({ view: "activity", cursor: 0, limit: 4 });
	for (const [key, value] of Object.entries({ entryId: "id", offset: 0, fromId: "id", query: "text", source: "user", continuation: "e30.signature", operationId: "op" })) assert.throws(() => validateInspect({ view: "activity", [key]: value }), /Activity accepts/);
	assert.throws(() => validateInspect({ view: "activity", limit: 13 }), /limit/);
	assert.throws(() => validateInspect({ view: "search", query: "x", cursor: 0 }), /continuation/);
});

test("supervision orders live workers before primaries and omits stored-file rows", () => {
	const base = { cwd: "/work", activity: { state: "idle" as const, pending: 0, lastPersistedAt: null } };
	const value = supervisionObservation([{ ...base, sessionId: "idle" }, { ...base, sessionId: "working", activity: { ...base.activity, state: "working" } }], [{ sessionId: "primary", cwd: "/work", primary: true }], [], 235);
	assert.deepEqual(value.sessions.map((row) => row.sessionId), ["working", "idle", "primary"]);
	assert.equal(value.inventory?.stored, 235); assert.equal(value.coverage.total, 3);
	assert.equal(Check(StatusOutputSchema, observationResult(value).structuredContent), true);
});

test("activity retains failures before successful rows under the digest byte bound", () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "task", timestamp: 1 });
	for (let index = 0; index < 60; index++) {
		manager.appendMessage(assistant([call(`pair-${index}`)], "toolUse"));
		manager.appendMessage({ role: "toolResult", toolCallId: `pair-${index}`, toolName: "bash", content: [{ type: "text", text: `${index === 3 ? "FAILURE_EVIDENCE" : "success"} ${"x".repeat(300)}` }], isError: index === 3, timestamp: 2 });
	}
	const value = activity(manager);
	assert.match(value.text, /isError=true.*FAILURE_EVIDENCE/);
	assert.equal(value.coverage.failuresOmitted, 0); assert.ok(value.coverage.omitted > 0);
	assert.ok(Buffer.byteLength(value.text) <= ACTIVITY_LIMITS.bytes);
	for (const entry of manager.getEntries()) if (entry.type === "message" && entry.message.role === "toolResult") entry.message.isError = true;
	const crowded = activity(manager);
	assert.ok(crowded.coverage.failuresOmitted > 0);
	assert.match(crowded.text, new RegExp(`failures among omitted entries: ${crowded.coverage.failuresOmitted}`));
});

test("older activity pages find bounded later results and never assign current call ages", () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "task", timestamp: 1 });
	manager.appendMessage(assistant([call("later"), call("unresolved")], "toolUse"));
	const result = manager.appendMessage({ role: "toolResult", toolCallId: "later", toolName: "bash", content: [{ type: "text", text: "FINISHED_LATER" }], isError: false, timestamp: 2 });
	const value = activity(manager, { cursor: 2 });
	const rows = value.turns.flatMap((turn) => turn.rows).filter((row) => row.kind === "tool");
	assert.equal(rows[0].outcome, "result after this page"); assert.equal(rows[0].resultEntryId, result);
	assert.equal(rows[0].ageMs, undefined); assert.equal(rows[1].ageMs, undefined);
	assert.match(value.text, /result after this page.*FINISHED_LATER/);
	assert.equal(value.coverage.considered, value.coverage.rendered + value.coverage.omitted);
	assert.ok(value.coverage.lookaheadEntries <= ACTIVITY_LIMITS.afterEntries);
});

test("activity collapses consecutive equal custom types with exact entry coverage", () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "task", timestamp: 1 });
	for (let index = 0; index < 10; index++) manager.appendCustomEntry("status.snapshot", {});
	const value = activity(manager);
	const custom = value.turns[0].rows.find((row) => row.kind === "custom");
	assert.equal(custom?.count, 10); assert.equal(custom?.entryIds?.length, 10);
	assert.match(value.text, /custom: status.snapshot x10/);
	assert.equal(value.coverage.rendered, 11); assert.equal(value.coverage.omitted, 0);
});

test("activity duration uses persisted entry timestamps rather than message timestamps", () => {
	const manager = SessionManager.inMemory();
	const header = manager.getHeader(); assert.ok(header);
	const entries: SessionEntry[] = [
		{ id: "a", parentId: null, type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: assistant([call("x")]) },
		{ id: "b", parentId: "a", type: "message", timestamp: "2026-01-01T00:00:01.250Z", message: { role: "toolResult", toolCallId: "x", toolName: "bash", content: [], isError: false, timestamp: 1 } },
	];
	const seeded = SessionManager.inMemory(undefined, undefined, [header, ...entries]);
	const value = activity(seeded);
	assert.equal(value.turns[0].rows[0].durationMs, 1250);
	assert.equal(value.metadata.lastPersistedAt, entries[1].timestamp);
});
