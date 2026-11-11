import assert from "node:assert/strict";
import test from "node:test";
import { compile } from "@earendil-works/pi-schema";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ordinaryOwnershipStore, ordinaryStatusStore, resultChannels, serialiseOwners } from "./config.ts";
import { boundResult, DEFAULT_MAX_OUTPUT_BYTES, resultByteLimit, RexCore, type RexResult } from "./core.ts";
import { createRexBudget } from "./deadline.ts";
import { settings } from "./settings.ts";
import { beginOwnership, initialOwnershipState, requestDigest, type OwnershipRecord } from "./ownership.ts";
import { ResultSchema } from "./schema.ts";

function record(callId: string): OwnershipRecord {
	return { ownerId: "ordinary:one", callId, requestDigest: requestDigest(callId), server: { endpoint: "unix:///synthetic-rex", hostId: "host", instanceId: "instance", selection: "test" }, operation: "create", phase: "pending", resources: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
}

test("settings and core share one CLI capture default", () => {
	assert.equal(settings.fields.maxOutputBytes.default, DEFAULT_MAX_OUTPUT_BYTES);
	assert.equal(DEFAULT_MAX_OUTPUT_BYTES, 65536);
});

test("canonical result bounds bulk data and preserves metadata across result channels", () => {
	const server = { endpoint: `unix:///${"界".repeat(2000)}`, hostId: "host", instanceId: "instance", selection: "界".repeat(2048) };
	const resource = { kind: "block" as const, sessionId: "session:00000000-0000-0000-0000-000000000001", blockId: "block:00000000-0000-0000-0000-000000000002" };
	const source: RexResult = {
		ok: false, outcome: "native_failure", target: { server, source: "explicit", sessionId: resource.sessionId, blockId: resource.blockId },
		data: { payload: "x".repeat(80000) }, error: "The native operation failed after partial effects.",
		records: Array.from({ length: 4 }, (_, index) => ({ recordId: `record-${index}`, server, resources: [resource] })),
		effects: { state: "unknown", recordId: "call", resources: [resource], note: "Outer CLI success does not prove application success." },
		coverage: { bounded: true, truncated: true, dataOmitted: false, totalRecords: 12, returnedRecords: 4, omittedRecords: 8, nextOffset: 4, note: "Source coverage qualification." },
	};
	const canonical = boundResult(source, resultByteLimit(32768));
	const channels = resultChannels(canonical);
	const text = channels.content[0].text;
	const model = JSON.parse(text);
	assert.equal(model.data.omitted, true);
	assert.equal(model.coverage.dataOmitted, true);
	assert.deepEqual(model.target, source.target);
	assert.deepEqual(model.records, source.records);
	assert.deepEqual(model.effects, source.effects);
	assert.equal(model.error, source.error);
	for (const [key, value] of Object.entries(source.coverage)) {
		if (key === "note") assert.ok(model.coverage.note.includes(String(value)));
		else if (key !== "dataOmitted" && key !== "truncated") assert.deepEqual(model.coverage[key], value);
	}
	assert.deepEqual(model, channels.structuredContent);
	assert.deepEqual(channels.details, { outcome: source.outcome, effects: source.effects.state });
	assert.ok(Buffer.byteLength(text, "utf8") > 50 * 1024, "mandatory metadata does not necessarily fit the native default");
	assert.ok(Buffer.byteLength(text, "utf8") <= resultByteLimit(32768), "the declared native limit retains the complete canonical envelope");
});

test("result schema and channels preserve diagnostic and reference omission controls", () => {
	const server = { endpoint: "unix:///synthetic-rex", hostId: "host", instanceId: "instance", selection: "test" };
	const source: RexResult = {
		ok: false, outcome: "native_failure", error: "Diagnostic prefix [truncated]",
		data: { omitted: true }, records: [{ recordId: "record-4", server, resources: [] }, { recordId: "record-5", server, resources: [] }],
		effects: { state: "unknown", recordId: "call", note: "CLI acknowledgement is not application success. [truncated]" },
		coverage: {
			bounded: true, truncated: true, dataOmitted: true, note: "Reported status grants no permission. [truncated]",
			totalRecords: 12, returnedRecords: 4, omittedRecords: 8, pageOffset: 4, nextOffset: 6, nextPageOffset: 8,
			emittedRecordRefs: 2, omittedRecordRefs: 2, omittedRecordIds: ["record-6", "record-7"],
			truncatedFields: ["error", "effects.note", "coverage.note"],
		},
	};
	assert.equal(compile(ResultSchema).check(source), true);
	const channels = resultChannels(source);
	const model = JSON.parse(channels.content[0].text);
	assert.deepEqual(model, source);
	assert.deepEqual(channels.structuredContent, source);
	assert.equal(channels.isError, true);
	assert.deepEqual(channels.details, { outcome: "native_failure", effects: "unknown" });
	const invalidFields = { pageOffset: "4", nextPageOffset: -1, emittedRecordRefs: "2", omittedRecordRefs: 1.5, omittedRecordIds: ["record-6", 7], truncatedFields: ["outcome"] };
	for (const [field, invalid] of Object.entries(invalidFields)) {
		assert.equal(compile(ResultSchema).check({ ...source, coverage: { ...source.coverage, [field]: invalid } }), false, field);
	}
});

function fixture(sessionFile?: string) {
	let id = "one";
	const sessionManager = SessionManager.inMemory("/test");
	sessionManager.getSessionId = () => id;
	sessionManager.getSessionFile = () => sessionFile;
	const ctx: Pick<ExtensionContext, "sessionManager"> = { sessionManager };
	const pi: Pick<ExtensionAPI, "appendEntry"> = { appendEntry: (customType, data) => { sessionManager.appendCustomEntry(customType, data); } };
	return {
		ctx, pi, get entries() { return sessionManager.getEntries(); },
		admit: () => sessionManager.appendMessage({ role: "user", content: "Start work.", timestamp: Date.now() }),
		switchTo: (next: string) => { id = next; },
	};
}

test("ordinary ownership reads report resolution without an effect", async () => {
	for (const op of ["owned", "observe", "reconcile"] as const) {
		for (const late of [false, true]) {
			const f = fixture();
			let now = 0;
			const budget = createRexBudget(1000, 300000, undefined, { now: () => now, schedule: () => () => {} });
			const entries = f.ctx.sessionManager.getEntries.bind(f.ctx.sessionManager);
			f.ctx.sessionManager.getEntries = () => { if (late) now = 900; return entries(); };
			const store = ordinaryOwnershipStore(f.pi, f.ctx, 128, serialiseOwners(), budget);
			const core = new RexCore({ store });
			try {
				const result = await core.execute({ op }, { ownerId: "ordinary:one", callId: "read", cwd: "/test", budget });
				assert.equal(result.coverage.deadline?.phase, "resolve", `${op} late=${late}`);
				assert.equal(result.effects.state, "none");
				if (late) {
					assert.equal(result.outcome, "timeout");
					assert.equal((result.data as { phase: string }).phase, "resolve");
				}
				assert.equal(f.entries.length, 0);
			} finally { core.dispose(); budget.dispose(); }
		}
	}
});

test("ordinary ownership commits before the update resolves and serialises concurrent changes", async () => {
	const f = fixture();
	const store = ordinaryOwnershipStore(f.pi, f.ctx, 128, serialiseOwners());
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let firstEntered!: () => void;
	const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
	const first = store.update("ordinary:one", (state) => { firstEntered(); return state; }, "work");
	await entered;
	await first;
	assert.equal(f.entries.length, 1);
	await Promise.all([
		store.update("ordinary:one", (state) => beginOwnership(state, record("parallel-one")), "work"),
		store.update("ordinary:one", (state) => beginOwnership(state, record("parallel-two")), "work"),
	]);
	assert.equal((await store.read("ordinary:one")).records.length, 2);
	const order: number[] = [];
	const queue = serialiseOwners();
	const a = queue("ordinary:one", async () => { order.push(1); await gate; order.push(2); });
	const b = queue("ordinary:one", async () => { order.push(3); });
	release();
	await Promise.all([a, b]);
	assert.deepEqual(order, [1, 2, 3]);
});

test("ordinary status cancellation while queued prevents the eventual state append", async () => {
	const f = fixture();
	const serialise = serialiseOwners();
	const controller = new AbortController();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let started!: () => void;
	const entered = new Promise<void>((resolve) => { started = resolve; });
	const blocker = serialise("ordinary:one", async () => { started(); await gate; });
	await entered;
	const store = ordinaryStatusStore(f.pi, f.ctx, serialise, controller.signal);
	const rejected = assert.rejects(store.write(undefined), /cancelled before state write/);
	controller.abort();
	release();
	await Promise.all([blocker, rejected]);
	assert.equal(f.entries.length, 0);
});

test("ownership serial admission rejects cancelled work but permits bounded effect settlement", async () => {
	const f = fixture();
	const queue = serialiseOwners();
	const caller = new AbortController();
	const budget = createRexBudget(30000, 300000, caller.signal);
	let release!: () => void;
	let entered!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const started = new Promise<void>((resolve) => { entered = resolve; });
	const blocker = queue("ordinary:one", async () => { entered(); await gate; });
	await started;
	const store = ordinaryOwnershipStore(f.pi, f.ctx, 128, queue, budget);
	try {
		const rejected = assert.rejects(store.update("ordinary:one", (state) => beginOwnership(state, record("not-dispatched")), "work"), /cancelled/);
		caller.abort(); release();
		await Promise.all([blocker, rejected]);
		assert.equal(f.entries.length, 0);
		await store.update("ordinary:one", (state) => state, "finalise");
		assert.equal(f.entries.length, 1);
	} finally { release(); budget.dispose(); }
});

test("persistent pending effects require conversation admission before the retained append", async () => {
	const f = fixture("/test/session.jsonl");
	const store = ordinaryOwnershipStore(f.pi, f.ctx, 128, serialiseOwners());
	await assert.rejects(store.update("ordinary:one", (state) => beginOwnership(state, record("before-admission")), "work"), /admitted user or assistant/);
	assert.equal(f.entries.length, 0);
	f.admit();
	await store.update("ordinary:one", (state) => beginOwnership(state, record("after-admission")), "work");
	assert.equal(f.entries.length, 2);
});

test("copied ordinary entries do not transfer cleanup ownership to a new session", async () => {
	const f = fixture();
	const queue = serialiseOwners();
	const first = ordinaryOwnershipStore(f.pi, f.ctx, 128, queue);
	await first.update("ordinary:one", (state) => beginOwnership(state, record("created")), "work");
	assert.equal((await first.read("ordinary:one")).records.length, 1, "branch navigation does not hide session-wide external resources");
	const sameHeaderCopy = ordinaryOwnershipStore(f.pi, f.ctx, 128, queue);
	assert.equal((await sameHeaderCopy.read("ordinary:one")).records.length, 1, "the same header ID is the same logical owner");
	f.switchTo("fork");
	await assert.rejects(first.read("ordinary:one"), /changed sessions/);
	const fork = ordinaryOwnershipStore(f.pi, f.ctx, 128, queue);
	assert.deepEqual(await fork.read("ordinary:fork"), initialOwnershipState());
	await assert.rejects(fork.update("ordinary:one", () => initialOwnershipState(), "work"), /changed sessions/);
});
