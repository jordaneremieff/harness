import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { type Cell, emptyShard, overflowCell, type Snapshot, zero } from "./capacity.ts";
import {
	createReader,
	MEANING,
	PAGE_BYTES,
	type Page,
	parseRequest,
	type ResourceRow,
	type Response,
	sum,
	TTL_MS,
	validateExport,
	validateResponse,
} from "./readback.ts";

const DAY = "2026-09-07";
const NOW = Date.parse(`${DAY}T00:00:00Z`);
function cell(i: number, day = DAY): Cell {
	return {
		day,
		observationStage: "tool_result",
		resourceClass: "entry",
		resourceId: `entry-${String(i).padStart(5, "0")}`,
		model: "fixture/model",
		reasoning: "low",
		referenceBodyDigest: "a".repeat(64),
		observerVersion: "1.0.0",
		piVersion: "1.0.0",
		counters: { ...zero(), readResults: 1, resultComplete: 1, bodyVerifiedAtObservation: 1 },
	};
}
function snapshot(count = 1): Snapshot {
	const shard = emptyShard(DAY);
	shard.cells = Array.from({ length: count }, (_, i) => cell(i));
	return { shards: { [DAY]: shard } };
}
function page(value: Response): Page {
	validateResponse(value);
	assert.equal(value.kind, "page");
	if (value.kind !== "page") throw new Error("page_expected");
	return value;
}
function reader(store: Snapshot) {
	return createReader(() => store, { now: () => NOW });
}
async function all(read: ReturnType<typeof createReader>, view: "overview" | "revisions" = "revisions") {
	let p = page(await read.read({ view }));
	const rows: (Cell | ResourceRow)[] = p.view === "revisions" ? [...p.rows] : [...p.byResource];
	while (p.pagination.nextCursor) {
		p = page(await read.read({ cursor: p.pagination.nextCursor }));
		rows.push(...(p.view === "revisions" ? p.rows : p.byResource));
	}
	return { rows, last: p };
}

test("closed requests reject unsupported fields before capture", async () => {
	let calls = 0;
	const read = createReader(
		() => {
			calls++;
			return snapshot();
		},
		{ now: () => NOW },
	);
	for (const value of [
		null,
		[],
		{ windowDays: 0 },
		{ windowDays: 31 },
		{ windowDays: 1.5 },
		{ view: "query" },
		{ cursor: "abcd", windowDays: 1 },
		{ resourceId: "entry-a" },
		{ view: undefined },
	])
		await assert.rejects(read.read(value), /invalid_input/);
	assert.equal(calls, 0);
	assert.deepEqual(parseRequest({}), { view: "overview", windowDays: 30 });
	for (let days = 1; days <= 30; days++) page(await read.read({ windowDays: days }));
});
test("empty and disabled retained reads preserve unknown coverage", async () => {
	const read = createReader(() => ({ shards: {} }), { now: () => NOW, enabled: () => false });
	const p = page(await read.read());
	assert.equal(p.enabled, false);
	assert.equal(p.pagination.pageCount, 1);
	assert.equal(p.pagination.totalRows, 0);
	assert.equal(p.storageEvidence.assessment, "no_recorded_evidence");
	assert.equal(p.coverage.unpersistedLoss, "unknown");
	assert.equal(p.coverage.liveCollectors, "unknown");
	assert.equal(p.coverage.wholeWindowCoverage, "unknown");
	assert.deepEqual(p.meaning, MEANING);
});
test("all pages use one immutable capture and repeat complete qualifications", async () => {
	const store = snapshot(80);
	let calls = 0;
	const read = createReader(
		() => {
			calls++;
			return store;
		},
		{ now: () => NOW },
	);
	const first = page(await read.read({ view: "revisions" }));
	assert.equal(first.pagination.pageCount, 4);
	const cursor = first.pagination.nextCursor!;
	const second = await read.read({ cursor });
	store.shards[DAY].cells.length = 0;
	assert.deepEqual(await read.read({ cursor }), second);
	assert.equal(calls, 1);
	let p = first;
	const rows = first.view === "revisions" ? [...first.rows] : [];
	while (p.pagination.nextCursor) {
		p = page(await read.read({ cursor: p.pagination.nextCursor }));
		assert.deepEqual(p.meaning, first.meaning);
		assert.deepEqual(p.totals, first.totals);
		assert(Buffer.byteLength(JSON.stringify(p)) <= PAGE_BYTES);
		if (p.view === "revisions") rows.push(...p.rows);
	}
	assert.equal(rows.length, 80);
	assert.deepEqual(sum(rows), first.totals);
	assert.equal(p.pagination.nextCursor, undefined);
	page(await read.read());
	const expired = await read.read({ cursor });
	assert.equal(expired.kind, "error");
	if (expired.kind === "error") assert.equal(expired.code, "cursor_expired");
});
test("TTL is fixed, old keys retire within a bounded set, invalid cursors never scan", async () => {
	let now = NOW,
		calls = 0;
	const read = createReader(
		() => {
			calls++;
			return snapshot(25);
		},
		{ now: () => now },
	);
	const cursor = page(await read.read({ view: "revisions" })).pagination.nextCursor!;
	now += TTL_MS - 1;
	page(await read.read({ cursor }));
	now++;
	let error = await read.read({ cursor });
	assert.equal(error.kind, "error");
	if (error.kind === "error") assert.equal(error.code, "cursor_expired");
	for (let i = 0; i < 9; i++) await read.read({ view: "revisions" });
	error = await read.read({ cursor });
	if (error.kind === "error") assert.equal(error.code, "cursor_invalid");
	else assert.fail();
	const before = calls;
	error = await read.read({ cursor: "abcd" });
	assert.equal(error.kind, "error");
	assert.equal(calls, before);
});
test("overview ranks concrete resources once, folds remaining identities last, and preserves totals", async () => {
	const store = snapshot(80);
	store.shards[DAY].cells[79].counters = { ...zero(), readRequests: 5 };
	store.shards[DAY].cells[79].observationStage = "tool_request";
	const folded = overflowCell(cell(90));
	store.shards[DAY].cells.push(folded);
	store.shards[DAY].health.cellsOverflowedEvents = 1;
	const { rows, last } = await all(reader(store), "overview");
	assert.equal(rows.length, 64);
	assert.equal(rows[0].resourceId, "entry-00079");
	assert.equal(rows.at(-1)?.resourceClass, "overflow");
	assert.equal(last.summary.foldedResourceIdentities, 17);
	assert.deepEqual(sum(rows), last.totals);
	const revisions = await all(reader(store));
	assert.equal(revisions.rows.length, 81);
});
test("joint identity keeps day, digest, model, reasoning, stage and versions associated", async () => {
	const store = snapshot(1);
	const base = cell(0);
	for (const [key, value] of [
		["model", "fixture/other"],
		["reasoning", "high"],
		["referenceBodyDigest", "b".repeat(64)],
		["observerVersion", "2.0.0"],
		["piVersion", "2.0.0"],
	] as const)
		store.shards[DAY].cells.push({ ...base, [key]: value });
	store.shards[DAY].cells.push({ ...base, observationStage: "tool_request", counters: { ...zero(), readRequests: 1 } });
	const previous = "2026-09-06";
	store.shards[previous] = emptyShard(previous);
	store.shards[previous].cells = [cell(0, previous)];
	const { rows, last } = await all(reader(store));
	assert.equal(rows.length, 8);
	assert.equal(last.totals.bodyVerifiedAtObservation, 7);
	assert.equal(last.totals.readRequests, 1);
});
test("retained health has detection-day scope independent of the selected event window", async () => {
	const old = "2026-09-06",
		store: Snapshot = { shards: { [old]: emptyShard(old) } };
	store.shards[old].cells = [cell(0, old)];
	store.shards[old].health.writeFailures = 3;
	store.shards[old].health.receiptQuotaReached = true;
	const p = page(await reader(store).read({ windowDays: 1 }));
	assert.equal(p.totals.readResults, 0);
	assert.equal(p.storageEvidence.checkpointWriteFailures, 3);
	assert.equal(p.storageEvidence.receiptQuotaDays, 1);
	assert.equal(p.storageEvidence.assessment, "recorded_incidents");
	store.shards[old].health.writeFailures = 0;
	store.shards[old].health.receiptQuotaReached = false;
	store.shards[old].health.forkResets = 1;
	assert.equal(page(await reader(store).read()).storageEvidence.assessment, "recorded_incidents");
});
test("malformed shards never become empty or partial success", async () => {
	const mutations: ((s: Snapshot) => void)[] = [
		(s) => s.shards[DAY].cells.push(cell(0)),
		(s) => s.shards[DAY].cells[0].counters.resultError++,
		(s) => (s.shards[DAY].cells[0].resourceClass = "skill"),
		(s) => (s.shards[DAY].retentionThroughDay = "2026-09-08"),
		(s) => ((s.shards[DAY] as any).extra = "private"),
		(s) => s.shards[DAY].receipts.push({ owner: "a".repeat(32), seq: 1 }, { owner: "a".repeat(32), seq: 1 }),
		(s) => (s.shards[DAY].cells[0].day = "2026-02-30"),
		(s) => (s.shards[DAY].cells[0].referenceBodyDigest = "unresolved"),
		(s) => (s.shards[DAY].cells = Array.from({ length: 2051 }, (_, i) => cell(i))),
	];
	for (const mutate of mutations) {
		const store = snapshot();
		mutate(store);
		const response = await reader(store).read();
		validateResponse(response);
		assert.equal(response.kind, "error");
		if (response.kind === "error") assert.equal(response.code, "store_corrupt");
		assert(!("totals" in response));
	}
	const response = await createReader(
		() => {
			throw new Error("PRIVATE_ERROR");
		},
		{ now: () => NOW },
	).read();
	assert.equal(response.kind, "error");
	assert(!JSON.stringify(response).includes("PRIVATE_ERROR"));
});
test("export projection excludes receipts, preserves totals, and validates exact meaning", async () => {
	const store = snapshot(40);
	store.shards[DAY].receipts = [{ owner: "c".repeat(32), seq: 1 }];
	const doc = await reader(store).exportCapture();
	assert(!("kind" in doc));
	validateExport(doc);
	assert.equal(doc.rows.length, 40);
	assert(!JSON.stringify(doc).includes("c".repeat(32)));
	assert(!("pagination" in doc));
	const wrong = structuredClone(doc);
	(wrong.meaning as any).coverage = "not coverage";
	assert.throws(() => validateExport(wrong));
	const invalid = structuredClone(doc);
	invalid.rows[0].counters.resultError++;
	assert.throws(() => validateExport(invalid));
});
test("semantic page validation enforces counts and continuation branches", async () => {
	const first = page(await reader(snapshot(25)).read({ view: "revisions" }));
	for (const mutate of [
		(p: Page) => {
			delete p.pagination.nextCursor;
		},
		(p: Page) => {
			p.pagination.pageCount = 1;
		},
		(p: Page) => {
			p.pagination.totalRows = 0;
		},
		(p: Page) => {
			p.window.fromDay = DAY;
		},
	]) {
		const invalid = structuredClone(first);
		mutate(invalid);
		assert.throws(() => validateResponse(invalid));
	}
});
test("runtime heap reserve refuses capture under a real constrained V8 heap", () => {
	const module = new URL("./readback.ts", import.meta.url).href;
	const output = execFileSync(
		process.execPath,
		[
			"--max-old-space-size=64",
			"--max-semi-space-size=1",
			"--input-type=module",
			"-e",
			`
		import { createReader } from ${JSON.stringify(module)};
		let captures = 0;
		const reader = createReader(() => { captures++; return { shards: {} }; });
		console.log(JSON.stringify({ response: await reader.read(), captures }));
	`,
		],
		{ encoding: "utf8", timeout: 10_000, maxBuffer: 8192 },
	);
	const { response, captures } = JSON.parse(output);
	validateResponse(response);
	assert.equal(response.kind, "error");
	if (response.kind === "error") assert.equal(response.code, "response_overflow");
	assert.equal(captures, 0);
});
test("read and export reject capture heap growth before projection", async (t) => {
	const baseline = process.memoryUsage();
	let pressure = false;
	t.mock.method(process, "memoryUsage", () => ({
		...baseline,
		heapUsed: baseline.heapUsed + (pressure ? 193 * 1024 * 1024 : 0),
	}));
	const read = createReader(
		() => {
			pressure = true;
			return snapshot();
		},
		{ now: () => NOW },
	);
	for (const operation of [() => read.read(), () => read.exportCapture()]) {
		pressure = false;
		const response = await operation();
		validateResponse(response);
		assert.equal(response.kind, "error");
		if (response.kind === "error") assert.equal(response.code, "response_overflow");
	}
});
test("overlapping captures and cancellation never expose a partial or replaced snapshot", async () => {
	const pending: ((value: Snapshot) => void)[] = [];
	const read = createReader(() => new Promise<Snapshot>((resolve) => pending.push(resolve)), { now: () => NOW });
	const first = read.read({ view: "revisions" });
	const second = read.read({ view: "revisions" });
	pending[1](snapshot(25));
	const current = page(await second);
	pending[0](snapshot(1));
	const replaced = await first;
	assert.equal(replaced.kind, "error");
	if (replaced.kind === "error") assert.equal(replaced.code, "cursor_expired");
	page(await read.read({ cursor: current.pagination.nextCursor! }));
	const controller = new AbortController();
	const cancelled = read.read({}, controller.signal);
	controller.abort();
	pending[2](snapshot(1));
	const response = await cancelled;
	validateResponse(response);
	assert.equal(response.kind, "error");
	assert(!("totals" in response));
});
test("header evidence and page totals reject misleading but schema-shaped values", async () => {
	const source = page(await reader(snapshot(2)).read());
	for (const mutate of [
		(p: Page) => {
			p.storageEvidence.assessment = "no_recorded_evidence";
		},
		(p: Page) => {
			p.storageEvidence.checkpointWriteFailures = 1;
		},
		(p: Page) => {
			p.storageEvidence.receiptQuotaDays = 2;
		},
		(p: Page) => {
			p.coverage.captureOmissions = ["source_unresolved"];
		},
		(p: Page) => {
			p.coverage.retainedDayShards = 0;
			p.coverage.dataState = "no_persisted_aggregate";
			p.storageEvidence.assessment = "no_recorded_evidence";
		},
		(p: Page) => {
			p.summary.foldedResourceIdentities = 1;
		},
		(p: Page) => {
			p.totals.readRequests = 1;
		},
		(p: Page) => {
			if (p.view === "overview") p.byResource.reverse();
		},
		(p: Page) => {
			if (p.view === "overview") p.byResource[1] = structuredClone(p.byResource[0]);
		},
	]) {
		const invalid = structuredClone(source);
		mutate(invalid);
		assert.throws(() => validateResponse(invalid));
	}
	const first = page(await reader(snapshot(25)).read({ view: "revisions" }));
	first.pagination.cursorExpiresAt = "2026-02-30T00:00:00.000Z";
	assert.throws(() => validateResponse(first));
	const empty = page(await reader({ shards: {} }).read());
	empty.totals.readRequests = 1;
	assert.throws(() => validateResponse(empty));
});
test("hard retained-row ceiling remains fully pageable without a full-page cache", async (t) => {
	const store: Snapshot = { shards: {} };
	for (let offset = 0; offset < 30; offset++) {
		const day = new Date(NOW - offset * 86400000).toISOString().slice(0, 10);
		const shard = emptyShard(day);
		shard.cells = Array.from({ length: 2048 }, (_, i) => ({
			...cell(i, day),
			resourceId: `entry-${String(i).padStart(58, "0")}`,
			model: "m".repeat(64),
			observerVersion: `${"1".repeat(28)}.0.0`,
			piVersion: `${"1".repeat(28)}.0.0`,
			counters: {
				...zero(),
				readResults: 100_000_000,
				resultComplete: 60_000_000,
				resultPartial: 20_000_000,
				resultError: 10_000_000,
				resultUnknown: 10_000_000,
				bodyVerifiedAtObservation: 30_000_000,
				bodyMismatchedAtObservation: 30_000_000,
				bodyUnverifiable: 40_000_000,
			},
		}));
		shard.receipts = Array.from({ length: 4096 }, (_, i) => ({ owner: i.toString(16).padStart(32, "0"), seq: 1 }));
		const result = overflowCell(cell(0, day));
		const request = overflowCell({
			...cell(0, day),
			observationStage: "tool_request",
			counters: { ...zero(), readRequests: 1 },
		});
		shard.cells.push(result, request);
		store.shards[day] = shard;
	}
	const measurements: number[] = [];
	const actualMemory = process.memoryUsage.bind(process);
	t.mock.method(process, "memoryUsage", () => {
		const sample = actualMemory();
		measurements.push(sample.heapUsed);
		return sample;
	});
	const baseline = actualMemory();
	const read = reader(store);
	let p = page(await read.read({ view: "revisions" }));
	assert.equal(p.pagination.totalRows, 61500);
	assert.equal(p.pagination.pageCount, 2563);
	let rows = 0;
	while (true) {
		if (p.view !== "revisions") assert.fail();
		rows += p.rows.length;
		if (!p.pagination.nextCursor) break;
		p = page(await read.read({ cursor: p.pagination.nextCursor }));
	}
	assert.equal(rows, 61500);
	assert.equal(p.pagination.pageNumber, 2563);
	const exported = await read.exportCapture();
	validateExport(exported);
	assert.equal(exported.rows.length, 61500);
	assert.deepEqual(exported.totals, p.totals);
	const peakHeap = Math.max(...measurements);
	t.diagnostic(
		JSON.stringify({
			scope: "synthetic_61500_rows_max_strings_full_receipts_read_and_export_projection_guard_samples_not_process_peak",
			heapBeforeRead: baseline.heapUsed,
			maximumSampledHeap: peakHeap,
			sampledHeapGrowth: peakHeap - baseline.heapUsed,
			processMaximumRssKiB: process.resourceUsage().maxRSS,
		}),
	);
});
