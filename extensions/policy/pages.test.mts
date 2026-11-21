import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listingFingerprint, type PageRequest, pageEntries, pageLine, pageSummary } from "./pages.ts";

const entries = Array.from({ length: 10 }, (_, index) => `entry-${index}`);
const size = () => 10;
const FINGERPRINT = "0123456789ab";
const request = (overrides: Partial<PageRequest> = {}): PageRequest => ({
	view: "data",
	id: "table",
	fingerprint: FINGERPRINT,
	budget: 30,
	...overrides,
});
const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

describe("policy inspection pages", () => {
	it("fills each page within the byte budget and reaches every entry once through nextCursor", () => {
		const seen: string[] = [];
		const starts: number[] = [];
		let cursor: string | undefined;
		do {
			const page = pageEntries(entries, size, request(cursor === undefined ? {} : { cursor }));
			assert.ok(page.entries.length * 10 <= 30);
			assert.equal(page.total, entries.length);
			starts.push(page.start);
			seen.push(...page.entries);
			cursor = page.nextCursor ?? undefined;
		} while (cursor !== undefined && starts.length < entries.length);
		assert.deepEqual(seen, entries);
		assert.deepEqual(starts, [0, 3, 6, 9]);
	});

	it("keeps an entry that alone exceeds the budget, so every page makes progress", () => {
		const page = pageEntries(["large", "next"], (entry) => (entry === "large" ? 100 : 1), request({ budget: 10 }));
		assert.deepEqual(page.entries, ["large"]);
		assert.equal(typeof page.nextCursor, "string");
	});

	it("reports an empty listing as one complete page", () => {
		const page = pageSummary(pageEntries([], size, request({ fingerprint: listingFingerprint([]) })));
		assert.deepEqual(page, { start: 0, returned: 0, total: 0, nextCursor: null });
		assert.equal(pageLine(page, "entries"), "page: entries none of 0 | next cursor: (none)");
		assert.equal(
			pageLine({ start: 3, returned: 3, total: 10, nextCursor: "abc" }, "entries"),
			"page: entries 4-6 of 10 | next cursor: abc",
		);
	});

	it("binds a cursor to the view, id, and listing that issued it", () => {
		const cursor = pageEntries(entries, size, request()).nextCursor;
		assert.ok(cursor);
		assert.equal(pageEntries(entries, size, request({ cursor })).start, 3);
		for (const other of [{ view: "capabilities" }, { id: "other" }, { id: undefined }])
			assert.throws(
				() => pageEntries(entries, size, request({ ...other, cursor })),
				/different policy_rules view or id/,
			);
		assert.throws(
			() => pageEntries(entries, size, request({ fingerprint: "ba9876543210", cursor })),
			/listing changed after this cursor was issued/,
		);
	});

	it("refuses malformed cursors without interpreting any part of them", () => {
		for (const cursor of [
			"",
			"not a cursor",
			"x".repeat(513),
			Buffer.from("{", "utf8").toString("base64url"),
			encode({ view: "data", offset: 3 }),
			encode(["data", "table", 3]),
			encode(["data", "table", 0, FINGERPRINT]),
			encode(["data", "table", 1.5, FINGERPRINT]),
			encode(["data", "table", 3, "ABCDEF012345"]),
			encode(["data", 7, 3, FINGERPRINT]),
			encode(["data", "table", entries.length, FINGERPRINT]),
		])
			assert.throws(() => pageEntries(entries, size, request({ cursor })), /cursor is malformed/, cursor);
	});

	it("derives a listing fingerprint from the complete listing", () => {
		assert.match(listingFingerprint(entries), /^[a-f0-9]{12}$/);
		assert.equal(listingFingerprint([...entries]), listingFingerprint(entries));
		assert.notEqual(listingFingerprint([...entries, "entry-10"]), listingFingerprint(entries));
	});
});
