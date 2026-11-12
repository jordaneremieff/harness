import assert from "node:assert/strict";
import { it } from "node:test";
import { projectSelectedStatus, projectStorageStatus, reduceCompactStatus, validateStatusDetail } from "./status-overview.ts";
import { StatusToolInputSchema, StatusToolOutputSchema, structuredObservation } from "./observation-schema.ts";
import { matchesSchema } from "./schema-check.ts";

function row(index = 1) {
	return { identity: `storage:${index}`, conversationId: index, name: "Reader", busy: true,
		agent: { model: { provider: "test", modelId: "model" }, thinkingLevel: "high", tools: ["read"], extensions: ["extension"], instructions: "Private instructions" },
		live: { run: { taskId: 5, inputs: [1], turns: 0 } }, inbox: { items: [1, 2] },
		submissions: [{ id: 1, status: "done" }, { id: 2, status: "queued" }], timers: [1, 2], tasks: [{ id: 7 }], usage: { total: 900 },
		awaiting: { runId: 5, queuedInputCount: 2, results: Array.from({ length: 6 }, (_, n) => ({ result: { sessionId: `producer:${n}`, submissionId: n + 1, requestId: `input-${n}` }, status: "pending" })), omitted: { results: 2 } } };
}
const coverage = { complete: false, returned: 2, scanned: 3, next: { tool: "agent_status", view: "storage-page", storageId: "01234567-0123-4123-8123-0123456789ab", cursor: { page: 3 }, limit: 2 } };

it("projects selected status without inventories or historical arrays and preserves exact awaited references", () => {
	const source = { conversation: row(), storageId: "storage", inventory: { contributions: ["private"] }, pid: 7 };
	const before = structuredClone(source), value = projectSelectedStatus(source);
	assert.equal(value.format, "compact");
	if (value.format !== "compact") return;
	structuredObservation(StatusToolOutputSchema, value);
	assert.equal(value.conversation.runId, 5);
	assert.deepEqual(value.conversation.queue, { inbox: 2, submissions: 1 });
	assert.equal(value.conversation.timers, 2);
	assert.deepEqual(value.conversation.awaiting?.results.map(item => item.result), source.conversation.awaiting.results.slice(0, 4).map(item => item.result));
	assert.equal(value.conversation.awaiting?.omittedResults, 4);
	assert.deepEqual(value.conversation.detail, { tool: "agent_status", sessionId: "storage:1", detail: true });
	assert.equal(value.conversation.availability, "live");
	assert.equal(value.conversation.context, "unknown");
	for (const key of ["instructions", "tools", "extensions", "tasks", "submissions", "usage"]) assert.equal(Object.hasOwn(value.conversation, key), false);
	assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 8192);
	assert.deepEqual(source, before);
});

it("qualifies cold and ordinary-primary observations without inferring live progress", () => {
	const cold = projectSelectedStatus({ conversation: { ...row(), live: null, inbox: null }, storageId: "storage", live: false });
	assert.equal(cold.format, "compact");
	if (cold.format !== "compact") return;
	assert.equal(cold.conversation.availability, "retained");
	assert.equal(cold.conversation.queue.inbox, null);
	const primary = projectSelectedStatus({ kind: "ordinary-primary", sessionId: "primary", presence: { name: "Primary", model: { provider: "test", modelId: "model" }, process: { state: "live" } }, entries: [{ text: "Retained body" }] });
	assert.equal(primary.format, "compact");
	if (primary.format !== "compact") return;
	structuredObservation(StatusToolOutputSchema, primary);
	assert.equal(primary.conversation.busy, null);
	assert.equal(primary.conversation.availability, "unknown");
	assert.equal(primary.conversation.context, "unknown");
	assert.doesNotMatch(JSON.stringify(primary), /Retained body/u);
});

it("preserves every storage-page identity and exact backend coverage without changing its scope", () => {
	const source = { storageId: "storage", conversations: [row(1), row(2)], coverage, live: false, inventory: { huge: "x".repeat(40000) } };
	const before = structuredClone(source), value = projectStorageStatus(source);
	assert.equal(value.format, "compact");
	if (value.format !== "compact") return;
	structuredObservation(StatusToolOutputSchema, value);
	assert.deepEqual(value.conversations.map(item => item.identity), ["storage:1", "storage:2"]);
	assert.deepEqual(value.coverage, coverage);
	assert.ok(value.omitted.length > 0);
	assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 16384);
	assert.deepEqual(source, before);
});

it("drops optional descriptions or refuses boundedly without clipping mandatory identities", () => {
	const source = { conversation: { ...row(), name: "😀".repeat(10000), agent: { ...row().agent, model: { provider: "p".repeat(10000), modelId: "m".repeat(10000) } } } };
	const value = projectSelectedStatus(source);
	assert.equal(value.format, "refused");
	assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 8192);
	const storage = projectStorageStatus({ storageId: "storage", conversations: [source.conversation], coverage: { complete: true, returned: 1, scanned: 1, next: null } });
	assert.equal(storage.format, "compact");
	if (storage.format === "compact") {
		assert.equal(storage.conversations[0]?.identity, source.conversation.identity);
		assert.equal(storage.conversations[0]?.model, undefined);
		assert.deepEqual(storage.omitted.slice(-1), ["row names, models and thinking levels omitted for byte limit"]);
		assert.equal(storage.conversations[0]?.omitted.includes("model omitted for byte limit"), false);
	}
	const refusal = projectStorageStatus({ storageId: "storage", conversations: Array.from({ length: 40 }, (_, index) => ({ ...row(index + 1), identity: `${index}-${"a".repeat(600)}` })), coverage: { complete: true, returned: 40, scanned: 40, next: null } });
	assert.equal(refusal.format, "refused");
	assert.ok(Buffer.byteLength(JSON.stringify(refusal)) <= 16384);
	structuredObservation(StatusToolOutputSchema, refusal);
	assert.equal(Object.hasOwn(refusal, "coverage"), false);
});

const storageId = "01234567-0123-4123-8123-0123456789ab";
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
function shortStoragePage(size: number, cold = false) {
	const conversations = Array.from({ length: size }, (_, index) => ({
		identity: index === 0 ? storageId : `${storageId}:${index + 1}`, conversationId: index + 1, name: "n", busy: false,
		agent: { model: { provider: "test", modelId: "model" }, thinkingLevel: "off" },
		live: null, inbox: null, submissions: [], timers: [],
	}));
	const coverage = { complete: false, returned: size, scanned: size, next: { tool: "agent_status" as const, view: "storage-page" as const, storageId, cursor: { page: size }, limit: size } };
	const source = { storageId, conversations, coverage, ...(cold ? { live: false } : { pid: 7, inventory: {} }) };
	const singles = conversations.map(conversation => {
		const value = projectStorageStatus({ ...source, conversations: [conversation] });
		assert.ok(value.format === "compact");
		return value;
	});
	assert.ok(singles[0]);
	return { source, projected: { ...singles[0], conversations: singles.map(value => value.conversations[0] as NonNullable<typeof value.conversations[0]>), coverage } };
}

it("reduces short-name storage rows with one page omission instead of larger per-row notes", () => {
	for (const cold of [false, true]) {
		const { projected } = shortStoragePage(50, cold), before = structuredClone(projected);
		const reduced = reduceCompactStatus(projected);
		assert.ok(bytes(reduced) < bytes(projected));
		assert.deepEqual(projected, before);
		assert.equal(reduced.conversations.length, 50);
		assert.deepEqual(reduced.coverage, projected.coverage);
		assert.equal(reduced.omitted.filter(note => note === "row names, models and thinking levels omitted for byte limit").length, 1);
		for (const [index, row] of reduced.conversations.entries()) {
			assert.equal(row.identity, projected.conversations[index]?.identity);
			assert.equal(row.name, undefined);
			assert.equal(row.model, undefined);
			assert.equal(row.thinkingLevel, undefined);
			assert.deepEqual(row.omitted, projected.conversations[index]?.omitted);
		}
		structuredObservation(StatusToolOutputSchema, reduced);
	}
});

it("never increases either projection when omission metadata outweighs short fields", () => {
	for (const name of ["", "n", "name".repeat(40)]) {
		const selected = projectSelectedStatus({ conversation: { ...row(), name } });
		assert.ok(selected.format === "compact");
		const reduced = reduceCompactStatus(selected);
		assert.ok(bytes(reduced) <= bytes(selected));
		assert.deepEqual(reduced.conversation.model, selected.conversation.model);
		assert.equal(reduced.conversation.thinkingLevel, selected.conversation.thinkingLevel);
		assert.equal(reduced.conversation.identity, selected.conversation.identity);
		if (name.length <= 1) assert.deepEqual(reduced, selected);
		const { projected } = shortStoragePage(1);
		const first = projected.conversations[0];
		assert.ok(first);
		first.name = name;
		delete first.model;
		delete first.thinkingLevel;
		const reducedStorage = reduceCompactStatus(projected);
		assert.ok(bytes(reducedStorage) <= bytes(projected));
		if (name.length <= 1) assert.deepEqual(reducedStorage, projected);
		assert.deepEqual(reduceCompactStatus(reducedStorage), reducedStorage);
	}
});

it("measures the exact fitting row count for connected and cold short-name pages", (t) => {
	for (const cold of [false, true]) {
		let fit = 0;
		for (let size = 1; size <= 50; size++) {
			const { source, projected } = shortStoragePage(size, cold), reduced = reduceCompactStatus(projected);
			assert.ok(bytes(reduced) <= bytes(projected));
			const value = projectStorageStatus(source);
			if (bytes(reduced) <= 16384) { fit = size; assert.equal(value.format, "compact"); }
			else assert.equal(value.format, "refused");
		}
		assert.equal(fit, cold ? 39 : 40);
		t.diagnostic(`${cold ? "cold" : "connected"}: ${fit} rows fit; ${fit + 1} rows exceed 16384 bytes`);
	}
});

it("requires detail on an explicit selected read and does not alter unselected inputs", () => {
	for (const detail of [true, false]) {
		assert.equal(matchesSchema(StatusToolInputSchema, { sessionId: "storage:1", detail }), true);
		assert.doesNotThrow(() => validateStatusDetail({ sessionId: "storage:1", detail }));
		for (const input of [{ detail }, { detail, view: "fleet" }, { sessionId: "storage", detail, view: "storage-page" }, { sessionId: "storage", detail, cursor: {} }, { sessionId: "storage", detail, limit: 1 }]) assert.throws(() => validateStatusDetail(input), /detail requires/u);
	}
	assert.doesNotThrow(() => validateStatusDetail({ view: "fleet" }));
	assert.doesNotThrow(() => validateStatusDetail({}));
});
