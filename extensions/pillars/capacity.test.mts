import assert from "node:assert/strict";
import test from "node:test";
import {
	addCounters, bytes, capture, commit, dayNumber, emptyShard, emptyStore, HEALTH_COUNTERS, key, LIMITS,
	overflowCell, planBytes, planCommit, slotFor, validateBatch, validateCell, validateShard, validateSnapshot, zero,
	type Batch, type Cell, type Snapshot,
} from "./capacity.ts";

const TODAY = "2026-09-07";
function cell(day = TODAY, resourceId = "example"): Cell {
	return { day, observationStage: "tool_request", resourceClass: "entry", resourceId, model: "test/model",
		reasoning: "high", referenceBodyDigest: "a".repeat(64), observerVersion: "1.0.0", piVersion: "1.0.0",
		counters: { ...zero(), readRequests: 1 } };
}
function batch(owner = 1, seq = 1, cells = [cell()]): Batch {
	return { owner: owner.toString(16).padStart(32, "0"), seq, day: cells[0]?.day ?? TODAY, cells };
}
function result(resourceId = "example"): Cell {
	return { ...cell(TODAY, resourceId), observationStage: "tool_result", counters: {
		...zero(), readResults: 4, resultComplete: 1, resultPartial: 1, resultError: 1, resultUnknown: 1,
		bodyVerifiedAtObservation: 1, bodyUnverifiable: 3,
	} };
}

test("immutable retries account cells, receipt, and detection-day health once", () => {
	const input = batch();
	input.health = { writeFailures: 2 };
	const serialized = JSON.stringify(input);
	const first = commit(emptyStore(), input, TODAY);
	assert.equal(first.status, "committed");
	assert.equal(commit(first.store, input, TODAY).status, "duplicate");
	assert.equal(JSON.stringify(input), serialized);
	const shard = first.store.shards[TODAY];
	assert.equal(shard.cells[0].counters.readRequests, 1);
	assert.equal(shard.health.writeFailures, 2);
	assert.deepEqual(shard.receipts, [{ owner: input.owner, seq: 1 }]);
	assert.equal(commit(first.store, batch(1, 3), TODAY).status, "sequence_gap");
	assert.equal(commit(first.store, batch(1, 2), TODAY).store.shards[TODAY].cells[0].counters.readRequests, 2);
	const failed = commit(first.store, batch(1, 2), TODAY, { publish: false });
	assert.equal(failed.status, "publication_failed");
	assert.equal(failed.store, first.store);
	assert.equal(commit(failed.store, batch(1, 2), TODAY).status, "committed");
});

test("a thousand short-lived owners share one daily aggregate", () => {
	let snapshot = emptyStore();
	for (let owner = 1; owner <= 1000; owner++) {
		const next = commit(snapshot, batch(owner), TODAY);
		assert.equal(next.status, "committed");
		snapshot = next.store;
	}
	assert.equal(snapshot.shards[TODAY].receipts.length, 1000);
	assert.equal(snapshot.shards[TODAY].cells.length, 1);
	assert.equal(snapshot.shards[TODAY].cells[0].counters.readRequests, 1000);
});

test("receipt quota publishes one sticky day flag without false exact losses", () => {
	const shard = emptyShard(TODAY);
	shard.receipts = Array.from({ length: LIMITS.ownersPerDay }, (_, index) => ({ owner: batch(index + 1).owner, seq: 1 }));
	const source = { shards: { [TODAY]: shard } };
	const refusal = commit(source, batch(5000), TODAY);
	assert.equal(refusal.status, "receipt_quota");
	assert.equal(refusal.store.shards[TODAY].health.receiptQuotaReached, true);
	assert.equal(refusal.store.shards[TODAY].cells.length, 0);
	assert.equal(refusal.store.shards[TODAY].receipts.length, 4096);
	assert.equal(commit(refusal.store, batch(5000), TODAY).store.shards[TODAY].health.pendingDroppedEvents, 0);
	assert.equal(commit(refusal.store, batch(1, 2), TODAY).status, "committed");
	assert.equal(commit(source, batch(5000), TODAY, { publish: false }).store.shards[TODAY].health.receiptQuotaReached, false);
});

test("daily overflow preserves result classes and removes only body attribution", () => {
	const full = Array.from({ length: LIMITS.cellsPerDay }, (_, index) => cell(TODAY, `resource-${index}`));
	const first = commit(emptyStore(), batch(1, 1, full), TODAY);
	const second = commit(first.store, batch(1, 2, [cell(TODAY, "new"), result("new"), cell(TODAY, "resource-0")]), TODAY);
	const shard = second.store.shards[TODAY];
	assert.equal(shard.cells.length, 2050);
	assert.equal(shard.health.cellsOverflowedEvents, 5);
	const folded = shard.cells.find((row) => row.resourceClass === "overflow" && row.observationStage === "tool_result");
	assert.deepEqual(folded?.counters, { ...result().counters, bodyVerifiedAtObservation: 0, bodyUnverifiable: 4 });
	assert.equal(shard.cells.find((row) => row.resourceId === "resource-0")?.counters.readRequests, 2);
	const prefolded = commit(emptyStore(), batch(1, 1, [overflowCell(result())]), TODAY).store.shards[TODAY];
	assert.equal(prefolded.cells.length, 1);
	assert.equal(prefolded.health.cellsOverflowedEvents, 4);
});

test("all thirty dates retain the specified resource/model/digest/stage envelope", () => {
	const snapshot: Snapshot = { shards: {} };
	for (let ago = 0; ago < LIMITS.days; ago++) {
		const day = new Date((dayNumber(TODAY) - ago) * 86400000).toISOString().slice(0, 10);
		const shard = emptyShard(day);
		for (let resource = 0; resource < 63; resource++) {
			for (let model = 0; model < 4; model++) {
				for (let digest = 0; digest < 4; digest++) {
					for (const stage of ["tool_request", "tool_result"] as const) {
						shard.cells.push({ ...cell(day, `resource-${resource}`), model: `model-${model}`,
							referenceBodyDigest: String(digest).repeat(64), observationStage: stage,
							counters: stage === "tool_request" ? cell().counters : result().counters });
					}
				}
			}
		}
		assert.equal(shard.cells.length, 2016);
		snapshot.shards[day] = shard;
	}
	validateSnapshot(snapshot, TODAY);
	assert.equal(Object.values(capture(snapshot, TODAY).shards).reduce((sum, shard) => sum + shard.cells.length, 0), 60480);
	const added = commit(snapshot, batch(1, 1, [cell()]), TODAY);
	assert.equal(added.status, "committed");
	assert.equal(Object.keys(added.store.shards).length, 30);
});

test("retention checks reject stale retries and rollback before receipt admission", () => {
	const past = "2026-08-08";
	const old = commit(emptyStore(), batch(1, 1, [cell(past)]), past).store;
	assert.equal(capture(old, TODAY).shards[past], undefined);
	assert.equal(commit(old, batch(1, 1, [cell(past)]), TODAY).status, "outside_window");
	const plan = planCommit(old, batch(), TODAY);
	assert.equal(slotFor(past), slotFor(TODAY));
	assert.deepEqual(plan.expiredSlots, []);
	const now = commit(old, batch(), TODAY).store;
	assert.deepEqual(Object.keys(now.shards), [TODAY]);
	assert.equal(commit(now, batch(2, 1, [cell("2026-09-06")]), "2026-09-06").status, "clock_rollback");
	assert.throws(() => capture(now, "2026-09-06"), /clock_rollback/);
	assert.equal(commit(emptyStore(), batch(1, 2), TODAY).status, "sequence_gap");
});

test("safe arithmetic rejects the complete candidate and its receipt", () => {
	const input = cell(); input.counters.readRequests = Number.MAX_SAFE_INTEGER;
	const source = commit(emptyStore(), batch(1, 1, [input]), TODAY).store;
	const saturated = commit(source, batch(1, 2), TODAY);
	assert.equal(saturated.status, "counter_saturated");
	assert.equal(saturated.store, source);
	assert.equal(source.shards[TODAY].receipts[0].seq, 1);
	assert.equal(commit(source, batch(1, 2, [cell(TODAY, "different")]), TODAY).status, "counter_saturated");
	const health = emptyShard(TODAY); health.health.writeFailures = Number.MAX_SAFE_INTEGER;
	assert.equal(commit({ shards: { [TODAY]: health } }, { ...batch(), health: { writeFailures: 1 } }, TODAY).status, "counter_saturated");
	const revision = emptyShard(TODAY); revision.revision = Number.MAX_SAFE_INTEGER;
	assert.equal(commit({ shards: { [TODAY]: revision } }, batch(), TODAY).status, "revision_saturated");
	assert.throws(() => addCounters(input.counters, cell().counters), /counter_saturated/);
});

test("closed validators reject malformed, duplicated, and semantically impossible data", () => {
	for (const day of ["2026-02-29", "2026-13-01", "1999-01-01", "2026-09-07x"]) assert.throws(() => dayNumber(day));
	const mutations: Array<(row: Cell) => void> = [
		(row) => { (row as any).resourceClass = "foreign"; },
		(row) => { row.piVersion = "other"; },
		(row) => { row.model = "not a model"; },
		(row) => { row.referenceBodyDigest = "a"; },
		(row) => { row.counters.readRequests = -1; },
		(row) => { row.counters.readResults = 1; },
		(row) => { Object.assign(row, { extra: true }); },
		(row) => { Object.assign(row.counters, { extra: true }); },
	];
	for (const mutate of mutations) { const row = cell(); mutate(row); assert.throws(() => validateCell(row, TODAY)); }
	const badBody = result(); badBody.referenceBodyDigest = "unresolved";
	assert.throws(() => validateCell(badBody, TODAY));
	const badStage = result(); badStage.counters.readRequests = 1;
	assert.throws(() => validateCell(badStage, TODAY));
	const folded = overflowCell(cell()); folded.model = "wrong";
	assert.throws(() => validateCell(folded, TODAY));
	const shard = emptyShard(TODAY);
	shard.cells = [cell(), cell()];
	assert.throws(() => validateShard(shard));
	shard.cells = []; shard.receipts = [{ owner: batch().owner, seq: 1 }, { owner: batch().owner, seq: 1 }];
	assert.throws(() => validateShard(shard));
	assert.throws(() => validateShard(emptyShard(TODAY), "day-99.json"));
	assert.throws(() => validateBatch({ ...batch(), surprise: 1 }));
	assert.throws(() => validateBatch({ ...batch(), health: { cellsOverflowedEvents: 1 } }));
	assert.throws(() => validateSnapshot({ shards: { wrong: emptyShard(TODAY) } }));
	assert.equal(new Set([key(cell()), key(result())]).size, 2);
});

test("serialized reservations charge old shards, candidate, controls, and any temporary file", () => {
	const candidate = emptyShard(TODAY);
	const source = { shards: { [TODAY]: candidate } };
	const accounting = planBytes(source, candidate);
	assert.equal(accounting.oldBytes, bytes(candidate));
	assert.equal(accounting.peakBytes, 2 * bytes(candidate) + LIMITS.controlBytes);
	assert.equal(accounting.admitted, true);
	assert.equal(planBytes(source, candidate, 1).admitted, false);
	assert.throws(() => planBytes(source, candidate, LIMITS.shardBytes + 1));
	assert.throws(() => planBytes(source, candidate, 0, LIMITS.controlBytes + 1));
	assert.equal(2050 * 865 + 4096 * 65 + 16384 < LIMITS.shardBytes, true);
	for (const name of HEALTH_COUNTERS) assert.equal(candidate.health[name], 0);
});
