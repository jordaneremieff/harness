import assert from "node:assert/strict";
import { it } from "node:test";
import { fitStoragePage, fitStorageStatusPage } from "./storage-page-fit.ts";
import { storageStatusCoverage, storageStatusPageInput, type StorageStatusPageInput } from "./storage-status.ts";

const storageId = "01234567-0123-4123-8123-0123456789ab";
type ScanInput = StorageStatusPageInput & { readonly limit: number };
type Outcome = "fits" | "overflow" | "source";

/** A storage of `size` conversations whose scan pages carry the same coverage as the storage scan. */
function storage(size: number, cold = false) {
	const rows = Array.from({ length: size }, (_, index) => ({
		identity: index === 0 ? storageId : `${storageId}:${index + 1}`, conversationId: index + 1, name: "n", busy: false,
		agent: { model: { provider: "test", modelId: "model" }, thinkingLevel: "off" },
		live: null, inbox: null, submissions: [], timers: [],
	}));
	const calls: ScanInput[] = [];
	async function scan(input: ScanInput) {
		calls.push(input);
		const start = Number(input.cursor?.after ?? 0);
		const conversations = rows.slice(start, start + input.limit), end = start + conversations.length;
		const coverage = storageStatusCoverage(storageId, input.limit, conversations.length, conversations.length, end < size ? { after: end } : undefined);
		return { storageId, conversations, coverage, ...(cold ? { live: false } : { pid: 7, inventory: {} }) };
	}
	return { rows, calls, scan };
}
type Page = Awaited<ReturnType<ReturnType<typeof storage>["scan"]>>;

/** A projection that fits pages of at most `fit` rows and reports every larger page with `refusal`. */
function projection(fit: number, refusal: Exclude<Outcome, "fits"> = "overflow") {
	return (page: Page) => ({ outcome: (page.conversations.length <= fit ? "fits" : refusal) as Outcome, rows: page.conversations.length });
}
const overflows = (value: { outcome: Outcome }) => value.outcome === "overflow";

it("halves the scan limit, rounded up, down to one row while the projection overflows", async () => {
	const expected: [number, number[]][] = [[50, [50, 25, 13, 7, 4, 2, 1]], [49, [49, 25, 13, 7, 4, 2, 1]], [3, [3, 2, 1]], [2, [2, 1]], [1, [1]]];
	for (const [limit, limits] of expected) {
		const { calls, scan } = storage(60);
		await fitStoragePage(limit, next => scan({ view: "storage-page", storageId, limit: next }), projection(0), overflows);
		assert.deepEqual(calls.map(call => call.limit), limits);
	}
});

it("starts every scan at the incoming cursor and leaves the request unchanged", async () => {
	const { calls, scan } = storage(60);
	const input: ScanInput = { view: "storage-page", storageId, cursor: Object.freeze({ after: 7 }), limit: 50 }, before = structuredClone(input);
	const { page } = await fitStoragePage(input.limit, limit => scan({ ...input, limit }), projection(5), overflows);
	assert.deepEqual(calls.map(call => call.limit), [50, 25, 13, 7, 4]);
	for (const call of calls) assert.equal(call.cursor, input.cursor);
	assert.deepEqual(input, before);
	assert.deepEqual(page.conversations.map(row => row.conversationId), [8, 9, 10, 11]);

	const first = storage(60);
	await fitStoragePage(50, limit => first.scan({ view: "storage-page", storageId, limit }), projection(5), overflows);
	assert.equal(first.calls.length, 5);
	for (const call of first.calls) assert.equal(Object.hasOwn(call, "cursor"), false);
});

it("scans once when the first page fits and returns that scan page with its projection", async () => {
	const { calls, scan } = storage(60);
	const pages: Page[] = [], project = projection(50);
	const result = await fitStoragePage(50, async limit => { const page = await scan({ view: "storage-page", storageId, limit }); pages.push(page); return page; }, project, overflows);
	assert.equal(calls.length, 1);
	assert.equal(result.page, pages[0]);
	assert.deepEqual(result.projected, { outcome: "fits", rows: 50 });
});

it("scans once and returns a refusal that is not a byte overflow", async () => {
	const { calls, scan } = storage(60);
	const refusals: unknown[] = [], project = projection(5, "source");
	const result = await fitStoragePage(50, limit => scan({ view: "storage-page", storageId, limit }), page => { const value = project(page); refusals.push(value); return value; }, overflows);
	assert.deepEqual(calls.map(call => call.limit), [50]);
	assert.equal(result.projected, refusals[0]);
	assert.deepEqual(result.projected, { outcome: "source", rows: 50 });
	assert.equal(result.page.conversations.length, 50);
});

it("returns a one-row overflow unchanged after the last scan", async () => {
	const { calls, scan } = storage(60);
	const refusals: unknown[] = [], project = projection(0);
	const result = await fitStoragePage(50, limit => scan({ view: "storage-page", storageId, limit }), page => { const value = project(page); refusals.push(value); return value; }, overflows);
	assert.equal(calls.length, 7);
	assert.equal(refusals.length, 7);
	assert.equal(result.projected, refusals[6]);
	assert.deepEqual(result.projected, { outcome: "overflow", rows: 1 });
	assert.equal(result.page.conversations.length, 1);
});

it("returns the continuation and counts of the scan page that fitted", async () => {
	const { scan } = storage(60);
	const cursor = { after: 20 };
	const { page, projected } = await fitStoragePage(50, limit => scan({ view: "storage-page", storageId, cursor, limit }), projection(10), overflows);
	assert.deepEqual(projected, { outcome: "fits", rows: 7 });
	assert.deepEqual(page.coverage, { complete: false, returned: 7, scanned: 7, next: { tool: "agent_status", view: "storage-page", storageId, cursor: { after: 27 }, limit: 7 } });

	const last = await fitStoragePage(50, limit => scan({ view: "storage-page", storageId, cursor: { after: 57 }, limit }), projection(10), overflows);
	assert.deepEqual(last.page.coverage, { complete: true, returned: 3, scanned: 3, next: null });
});

it("reaches every identity of a storage larger than one projected page through the returned cursors", async () => {
	for (const cold of [false, true]) {
		const { rows, calls, scan } = storage(51, cold);
		const identities: string[] = [];
		let input = storageStatusPageInput({ view: "storage-page", storageId });
		for (;;) {
			const request = input;
			const { page, projected } = await fitStorageStatusPage(request.limit, limit => scan({ ...request, limit }));
			assert.ok(projected.format === "compact");
			assert.ok(Buffer.byteLength(JSON.stringify(projected)) <= 16384);
			assert.deepEqual(projected.coverage, page.coverage);
			identities.push(...projected.conversations.map(row => row.identity));
			if (page.coverage.next === null) break;
			const { tool, ...next } = page.coverage.next;
			assert.equal(tool, "agent_status");
			input = storageStatusPageInput(next);
		}
		assert.deepEqual(calls.map(call => call.limit), [50, 25, 25, 25]);
		assert.deepEqual(identities, rows.map(row => row.identity));
		assert.equal(new Set(identities).size, 51);
	}
});

it("scans a malformed storage source once and returns its source refusal", async () => {
	const { calls, scan } = storage(51);
	const { page, projected } = await fitStorageStatusPage(50, async limit => ({ ...await scan({ view: "storage-page", storageId, limit }), coverage: undefined }));
	assert.deepEqual(calls.map(call => call.limit), [50]);
	assert.ok(projected.format === "refused");
	assert.equal(projected.cause, "source");
	assert.equal(page.conversations.length, 50);
});

it("returns the byte-limit refusal of one row that exceeds the page limit", async () => {
	const { calls, scan } = storage(51);
	const wide = async (limit: number) => {
		const page = await scan({ view: "storage-page", storageId, limit });
		return { ...page, conversations: page.conversations.map(row => ({ ...row, identity: `${row.identity}:${"a".repeat(20000)}` })) };
	};
	const { page, projected } = await fitStorageStatusPage(50, wide);
	assert.deepEqual(calls.map(call => call.limit), [50, 25, 13, 7, 4, 2, 1]);
	assert.ok(projected.format === "refused");
	assert.equal(projected.cause, "byte-limit");
	assert.equal(Object.hasOwn(projected, "coverage"), false);
	assert.equal(page.conversations.length, 1);
	assert.deepEqual(page.coverage.next, { tool: "agent_status", view: "storage-page", storageId, cursor: { after: 1 }, limit: 1 });
});
