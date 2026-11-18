import assert from "node:assert/strict";
import { it } from "node:test";
import { projectSelectedStatus, projectStorageStatus, reduceCompactStatus, validateStatusDetail } from "./status-overview.ts";
import { StatusOutputSchema, StatusToolInputSchema, StatusToolOutputSchema, structuredObservation } from "./observation-schema.ts";
import { matchesSchema } from "./schema-check.ts";

function row(index = 1) {
	return { identity: `storage:${index}`, conversationId: index, name: "Reader", busy: true,
		agent: { model: { provider: "test", modelId: "model" }, thinkingLevel: "high", tools: ["read"], extensions: ["extension"], instructions: "Private instructions" },
		live: { run: { taskId: 5, inputs: [1], turns: 0 } }, inbox: { items: [1, 2] },
		submissions: [{ id: 1, status: "done" }, { id: 2, status: "queued" }], timers: [1, 2], tasks: [{ id: 7 }], usage: { total: 900 },
		awaiting: { runId: 5, queuedInputCount: 2, results: Array.from({ length: 6 }, (_, n) => ({ result: { sessionId: `producer:${n}`, submissionId: n + 1, requestId: `input-${n}` }, status: "pending" })), omitted: { results: 2 } } };
}
const coverage = { complete: false, returned: 2, scanned: 3, next: { tool: "agent_status", view: "storage-page", storageId: "01234567-0123-4123-8123-0123456789ab", cursor: { page: 3 }, limit: 2 } };

it("projects selected status without inventories, historical arrays or a host await fact", () => {
	const source = { conversation: row(), storageId: "storage", inventory: { contributions: ["private"] }, pid: 7 };
	const before = structuredClone(source), value = projectSelectedStatus(source);
	assert.equal(value.format, "compact");
	if (value.format !== "compact") return;
	structuredObservation(StatusToolOutputSchema, value);
	assert.equal(value.conversation.runId, 5);
	assert.deepEqual(value.conversation.queue, { inbox: 2, submissions: 1 });
	assert.equal(value.conversation.timers, 2);
	assert.deepEqual(value.conversation.detail, { tool: "agent_status", sessionId: "storage:1", detail: true });
	assert.equal(value.conversation.availability, "live");
	assert.equal(value.conversation.context, "unknown");
	for (const key of ["instructions", "tools", "extensions", "tasks", "submissions", "usage", "awaiting"]) assert.equal(Object.hasOwn(value.conversation, key), false);
	assert.equal(value.conversation.omitted.some(note => note.includes("await")), false);
	assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 8192);
	assert.deepEqual(source, before);
});

it("publishes the unplaced input count and the oldest age only when the host row states them", () => {
	const project = (extra: Record<string, unknown>) => {
		const value = projectSelectedStatus({ conversation: { ...row(), ...extra }, storageId: "storage" });
		assert.equal(value.format, "compact");
		return (value as { conversation: Record<string, unknown> }).conversation;
	};
	const waiting = project({ unplaced: 3, oldest: 372000 });
	assert.equal(waiting.unplaced, 3);
	assert.equal(waiting.oldest, 372000);
	const none = project({ unplaced: 0, oldest: 372000 });
	assert.equal(none.unplaced, 0);
	assert.equal(Object.hasOwn(none, "oldest"), false);
	for (const extra of [{}, { oldest: 372000 }, { unplaced: -1 }, { unplaced: "3" }]) {
		const absent = project(extra);
		assert.equal(Object.hasOwn(absent, "unplaced"), false);
		assert.equal(Object.hasOwn(absent, "oldest"), false);
	}
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
	assert.ok(value.format === "refused");
	assert.equal(value.cause, "byte-limit");
	structuredObservation(StatusToolOutputSchema, value);
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
	assert.ok(refusal.format === "refused");
	assert.equal(refusal.cause, "byte-limit");
	assert.ok(Buffer.byteLength(JSON.stringify(refusal)) <= 16384);
	structuredObservation(StatusToolOutputSchema, refusal);
	assert.equal(Object.hasOwn(refusal, "coverage"), false);
});

it("distinguishes missing selected sources, storage coverage and row identity from byte overflow", () => {
	for (const source of [{}, { conversation: { conversationId: 1 } }, { kind: "ordinary-primary", presence: {} }]) {
		const value = projectSelectedStatus(source);
		assert.deepEqual(value, { format: "refused", cause: "source", reason: "Selected status source identity is unavailable.", byteLimit: 8192 });
		structuredObservation(StatusToolOutputSchema, value);
	}
	for (const source of [{}, { conversations: [], coverage }, { storageId: "storage", conversations: [] }, { storageId: "storage", conversations: [], coverage: {} }]) {
		const value = projectStorageStatus(source);
		assert.deepEqual(value, { format: "refused", cause: "source", reason: "Storage status source identity or coverage is unavailable.", byteLimit: 16384 });
		structuredObservation(StatusToolOutputSchema, value);
	}
	const value = projectStorageStatus({ storageId: "storage", conversations: [{ conversationId: 1 }], coverage });
	assert.deepEqual(value, { format: "refused", cause: "source", reason: "A storage status row has no complete source identity.", byteLimit: 16384 });
	structuredObservation(StatusToolOutputSchema, value);
	assert.equal(matchesSchema(StatusToolOutputSchema, { ...value, cause: "other" }), false);
	assert.ok(value.format === "refused");
	const { cause: _cause, ...withoutCause } = value;
	assert.equal(matchesSchema(StatusToolOutputSchema, withoutCause), false);
});

const storageId = "01234567-0123-4123-8123-0123456789ab";
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
function recoveryStatus(failure?: { reason: string; detail?: string }) {
	const owner = "00000000-0000-4000-8000-0000000000aa";
	return { storageId, pid: 1, inventory: { contributions: [], ordinaryOnly: [] },
		deliveryError: `Delivery receipt:25 to ${owner}: parked: primary endpoint is absent; no live owning session for ${owner} and no registered primary accepted delivery`,
		conversation: { conversationId: 1, identity: storageId, name: "Worker", busy: false, lastText: "worker answer", tasks: [],
			live: failure === undefined ? {} : { runFailure: { taskId: 26, inputs: [25], ...failure, first: 24 } }, inbox: { items: [] }, submissions: [], timers: [],
			agent: { model: { provider: "example", modelId: "worker" }, thinkingLevel: "off", extensions: [], tools: [] } } };
}

it("keeps parked delivery and retained run failures visible in selected status", () => {
	for (const failure of [undefined, { reason: "aborted" }, { reason: "model_error", detail: "Agent host: quota exceeded; explicit recovery required." }]) {
		const source = recoveryStatus(failure), before = structuredClone(source);
		structuredObservation(StatusOutputSchema, source);
		const value = projectSelectedStatus(source);
		assert.ok(value.format === "compact");
		assert.equal(value.deliveryError, source.deliveryError);
		assert.equal(value.conversation.busy, false);
		assert.deepEqual(value.conversation.runFailure, failure);
		structuredObservation(StatusToolOutputSchema, value);
		assert.deepEqual(source, before);
	}
});

it("redacts credentials and bounds recovery text before exposing a selected status", () => {
	const source = recoveryStatus({ reason: "model_error", detail: `api_key=${"x".repeat(32)}\n${"failure ".repeat(150)}` });
	source.deliveryError = `Authorization: Bearer ${"y".repeat(32)}\n${"parked ".repeat(150)}`;
	const value = projectSelectedStatus(source);
	assert.ok(value.format === "compact");
	assert.ok(value.deliveryError !== undefined);
	assert.ok(value.conversation.runFailure?.detail !== undefined);
	assert.match(value.deliveryError, /\[credential omitted\]/u);
	assert.match(value.conversation.runFailure.detail, /\[credential omitted\]/u);
	assert.ok(Buffer.byteLength(value.deliveryError) <= 512);
	assert.ok(Buffer.byteLength(value.conversation.runFailure.detail) <= 512);
	assert.equal(value.deliveryErrorTruncated, true);
	assert.equal(value.conversation.runFailure.detailTruncated, true);
	assert.doesNotMatch(JSON.stringify(value), new RegExp(`${"x".repeat(32)}|${"y".repeat(32)}`, "u"));
	structuredObservation(StatusToolOutputSchema, value);
});

it("keeps recovery facts after name reduction and omits them last with one exact recovery marker", () => {
	const source = recoveryStatus({ reason: "model_error", detail: "Failure ".repeat(150) });
	source.conversation.name = "n".repeat(160);
	source.deliveryError = "Delivery parked ".repeat(150);
	const base = projectSelectedStatus(source);
	assert.ok(base.format === "compact");
	const nameOnly = reduceCompactStatus(base);
	const at = (padding: number) => {
		const padded = structuredClone(source);
		padded.conversation.agent.model.modelId += "m".repeat(padding);
		const value = projectSelectedStatus(padded);
		assert.ok(value.format === "compact");
		assert.ok(bytes(value) <= 8192);
		assert.deepEqual(value.conversation.model, padded.conversation.agent.model);
		assert.equal(value.conversation.thinkingLevel, "off");
		return value;
	};
	const namePressure = at(8192 - bytes(base) + 1);
	assert.equal(namePressure.conversation.name, undefined);
	assert.equal(namePressure.deliveryError, base.deliveryError);
	assert.deepEqual(namePressure.conversation.runFailure, base.conversation.runFailure);
	const deliveryPadding = 8192 - bytes(nameOnly) + 1;
	const deliveryPressure = at(deliveryPadding);
	assert.equal(deliveryPressure.deliveryError, undefined);
	assert.deepEqual(deliveryPressure.conversation.runFailure, base.conversation.runFailure);
	const omitted = deliveryPressure.omitted.filter(note => note.startsWith("Recovery facts omitted"));
	assert.equal(omitted.length, 1);
	assert.match(omitted[0] ?? "", /deliveryError/u);
	assert.doesNotMatch(omitted[0] ?? "", /runFailure/u);
	const allPressure = at(deliveryPadding + 8192 - bytes(deliveryPressure) + 1);
	assert.equal(allPressure.deliveryError, undefined);
	assert.equal(allPressure.conversation.runFailure, undefined);
	const allOmitted = allPressure.omitted.filter(note => note.startsWith("Recovery facts omitted"));
	assert.equal(allOmitted.length, 1);
	assert.match(allOmitted[0] ?? "", /deliveryError, runFailure/u);
	const call = `agent_status(${JSON.stringify({ sessionId: storageId, detail: true })})`;
	assert.ok((omitted[0] ?? "").includes(call));
	assert.ok((allOmitted[0] ?? "").includes(call));
	const shortName = structuredClone(source);
	shortName.conversation.name = "n";
	const shortBase = projectSelectedStatus(shortName);
	assert.ok(shortBase.format === "compact");
	shortName.conversation.agent.model.modelId += "m".repeat(8192 - bytes(shortBase) + 1);
	const shortPressure = projectSelectedStatus(shortName);
	assert.ok(shortPressure.format === "compact");
	assert.equal(shortPressure.conversation.name, undefined);
	assert.equal(shortPressure.deliveryError, undefined);
	assert.deepEqual(shortPressure.conversation.runFailure, shortBase.conversation.runFailure);
	assert.ok(bytes(shortPressure) <= 8192);
});

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
		const { source, projected } = shortStoragePage(50, cold), before = structuredClone(projected);
		const refusal = projectStorageStatus(source);
		assert.ok(refusal.format === "refused");
		assert.equal(refusal.cause, "byte-limit");
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
			else { assert.ok(value.format === "refused"); assert.equal(value.cause, "byte-limit"); }
		}
		assert.equal(fit, cold ? 39 : 40);
		t.diagnostic(`${cold ? "cold" : "connected"}: ${fit} rows fit; ${fit + 1} rows exceed 16384 bytes`);
	}
});

it("requires an explicit selected read only when full detail is requested", () => {
	for (const detail of [true, false]) {
		assert.equal(matchesSchema(StatusToolInputSchema, { sessionId: "storage:1", detail }), true);
		assert.doesNotThrow(() => validateStatusDetail({ sessionId: "storage:1", detail }));
	}
	for (const input of [{ detail: true }, { detail: true, view: "fleet" }, { sessionId: "storage", detail: true, view: "storage-page" }, { sessionId: "storage", detail: true, cursor: {} }, { sessionId: "storage", detail: true, limit: 1 }]) assert.throws(() => validateStatusDetail(input), /detail requires/u);
	for (const input of [{ detail: false }, { view: "fleet", detail: false }, { view: "storage-page", storageId, cursor: {}, limit: 50, detail: false }]) {
		assert.equal(matchesSchema(StatusToolInputSchema, input), true);
		assert.doesNotThrow(() => validateStatusDetail(input));
	}
	assert.doesNotThrow(() => validateStatusDetail({ view: "fleet" }));
	assert.doesNotThrow(() => validateStatusDetail({}));
});
