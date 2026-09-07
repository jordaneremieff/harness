import assert from "node:assert/strict";
import test from "node:test";
import { accessEvidence, Deduplicator, extract, readEvidence } from "./observation.ts";
import { digest } from "./access.ts";
import { Collector } from "./collector.ts";
import { type Batch, type Cell, zero } from "./capacity.ts";

const day = "2026-09-07";
const resource = { resourceClass: "entry" as const, resourceId: "principle-example", path: "/not-persisted" };
const row = (id = resource.resourceId, date = day): Cell => ({
	day: date,
	observationStage: "tool_request",
	resourceClass: "entry",
	resourceId: id,
	model: "test/model",
	reasoning: "high",
	referenceBodyDigest: "a".repeat(64),
	observerVersion: "0.1.0",
	piVersion: "0.85.1",
	counters: { ...zero(), readRequests: 1 },
});
const content = (text: string) => [{ type: "text", text }];

test("raw read extent requires exact complete reference bytes, never a missing limit or matching prefix", () => {
	const reference = Buffer.from("whole\nbody\n");
	assert.equal(readEvidence(content("whole\nbody\n"), reference, false).extent, "full");
	for (const text of ["whole\n", "wrong\nbody\n", "whole\nbody\n[more]"])
		assert.equal(readEvidence(content(text), reference, false).extent, "unknown");
	assert.equal(readEvidence(content("whole\nbody\n"), undefined, false).extent, "unknown");
	const error = extract({
		stage: "tool_result",
		day,
		resource,
		piVersion: "0.85.1",
		reference,
		result: readEvidence(content("whole\nbody\n"), reference, true),
	});
	assert.equal(error.counters.resultError, 1);
	assert.equal(error.counters.bodyUnverifiable, 1);
});

test("owned delivery extent separates full, partial, mismatch and unknown frames", () => {
	const reference = Buffer.from("abcdef");
	const page = {
		schema: "pillars-source" as const,
		resource: resource.resourceId,
		referenceBodyDigest: digest(reference),
		bodyBytes: 6,
		offset: 0,
		endOffset: 6,
		text: "abcdef",
	};
	const input = { stage: "tool_result" as const, day, resource, piVersion: "0.85.1", reference };
	const complete = extract({
		...input,
		result: accessEvidence(content(JSON.stringify(page)), resource.resourceId, false, page),
	});
	assert.equal(complete.counters.bodyVerifiedAtObservation, 1);
	const mismatch = extract({
		...input,
		result: accessEvidence(content(JSON.stringify({ ...page, text: "ABCDEF" })), resource.resourceId, false, page),
	});
	assert.equal(mismatch.counters.bodyMismatchedAtObservation, 1);
	const partial = { ...page, offset: 2, endOffset: 4, text: "cd", nextOffset: 4 };
	assert.equal(accessEvidence(content(JSON.stringify(partial)), resource.resourceId, false, partial).extent, "partial");
	assert.equal(accessEvidence(content(JSON.stringify(page)), resource.resourceId, false).extent, "unknown");
	assert.equal(accessEvidence(content(JSON.stringify(partial)), resource.resourceId, false, page).extent, "unknown");
	assert.ok(!JSON.stringify(mismatch).includes("ABCDEF"));
	assert.ok(!JSON.stringify(mismatch).includes(resource.path));
});

test("dimensions resolve separately and bounded dedup saturation never invents an exact lost count", () => {
	const first = extract({
		stage: "tool_request",
		day,
		resource,
		piVersion: "0.85.1",
		reference: Buffer.from("A"),
		model: "test/first",
		reasoning: "low",
	});
	const second = extract({
		stage: "tool_result",
		day,
		resource,
		piVersion: "0.85.1",
		reference: Buffer.from("B"),
		model: "test/second",
		reasoning: "high",
	});
	assert.notEqual(first.model, second.model);
	assert.notEqual(first.referenceBodyDigest, second.referenceBodyDigest);
	const d = new Deduplicator();
	for (let i = 0; i < 4096; i++) assert.equal(d.admit(String(i), "tool_request"), "admitted");
	assert.equal(d.admit("0", "tool_request"), "duplicate");
	assert.equal(d.admit("new", "tool_request"), "saturated");
	assert.equal(d.warnOnce(), true);
	assert.equal(d.warnOnce(), false);
	d.newTurn();
	assert.equal(d.admit("0", "tool_request"), "admitted");
	assert.equal(d.admit("x".repeat(257), "tool_result"), "saturated");
});

test("first observation publishes immediately and retries keep their immutable delta", async () => {
	let now = Date.parse(`${day}T00:00:00Z`);
	const batches: Batch[] = [];
	const collector = new Collector(
		{
			async commit(batch) {
				batches.push(structuredClone(batch));
				return batches.length === 1 ? "publication_failed" : "committed";
			},
		},
		{ now: () => now },
	);
	collector.admit(row());
	await collector.observed();
	assert.equal(batches.length, 1);
	collector.admit(row("principle-other"));
	await collector.observed();
	assert.equal(batches.length, 1);
	now += 1000;
	await collector.flush();
	assert.deepEqual(batches[1], batches[0]);
	now += 1000;
	await collector.flush();
	assert.equal(batches[2].seq, 2);
	assert.equal(batches[2].health?.writeFailures, 1);
	assert.equal(batches[2].cells[0].resourceId, "principle-other");
	await collector.shutdown();
});

test("concurrent flushes coalesce and shutdown attempts the pending tail once", async () => {
	let release!: () => void;
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	const batches: Batch[] = [];
	const collector = new Collector({
		async commit(batch) {
			batches.push(structuredClone(batch));
			if (batches.length === 1) await barrier;
			return "committed";
		},
	});
	collector.admit(row());
	const first = collector.observed();
	collector.admit(row("principle-other"));
	const second = collector.observed();
	assert.equal(batches.length, 1);
	release();
	await Promise.all([first, second]);
	await collector.shutdown();
	await collector.shutdown();
	assert.equal(batches.length, 2);
	assert.equal(batches[1].seq, 2);
	assert.equal(collector.admit(row()), false);
});

test("pending pressure folds identities and receipt refusal does not invent exact losses", async () => {
	const batches: Batch[] = [];
	const collector = new Collector({
		async commit(batch) {
			batches.push(structuredClone(batch));
			return "receipt_quota";
		},
	});
	for (let i = 0; i < 2050; i++) collector.admit(row(`entry-${i}`));
	await collector.shutdown();
	assert.equal(batches.length, 1);
	assert.equal(batches[0].cells.length, 2048);
	assert.equal(batches[0].health?.pendingDroppedEvents, undefined);
});

test("clock rollback preserves an established owner-day sequence", async () => {
	let now = Date.parse(`${day}T00:00:00Z`);
	const batches: Batch[] = [];
	const collector = new Collector(
		{
			async commit(batch) {
				batches.push(structuredClone(batch));
				return "committed";
			},
		},
		{ now: () => now },
	);
	collector.admit(row());
	await collector.observed();
	now -= 86400000;
	assert.equal(collector.admit(row("entry-other", "2026-09-06")), false);
	now += 86400000 + 1000;
	collector.admit(row());
	await collector.flush();
	await collector.shutdown();
	assert.equal(batches.length, 2);
	assert.equal(batches[1].seq, 2);
	assert.equal(batches[0].owner, batches[1].owner);
});
