import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { ListOutputSchema, recentListContent } from "./list-result.ts";
import { boundedOutput, MAX_OUTPUT_BYTES } from "./text.ts";

function row(id: string, title: string) {
	return { text: `${id}\n  open · ${title}`, record: { id, title, state: "open" as const } };
}

test("recent structured records retain visible fields and unknown store coverage", () => {
	const rows = [row("one", "First"), row("two", "Second")];
	const page = recentListContent(rows, 2, rows.map((row) => row.text).join("\n").length, false);
	assert.ok(Value.Check(ListOutputSchema, page));
	assert.deepEqual(
		page.records,
		rows.map((row) => row.record),
	);
	assert.equal(page.limitReached, true);
	assert.equal(page.coverage.complete, null);
	assert.equal(page.omittedRecords, 0);
	assert.equal(Value.Check(ListOutputSchema, { ...page, records: [{ id: "one", title: "First" }] }), false);
	assert.equal(
		Value.Check(ListOutputSchema, { ...page, records: [{ id: "one", title: "First", state: "bogus" }] }),
		false,
	);
});

test("recent structured output omits incomplete displayed rows without a text parser", () => {
	const rows = [row("one", "First"), row("two", "x".repeat(MAX_OUTPUT_BYTES)), row("three", "Hidden")];
	const bounded = boundedOutput(rows.map((row) => row.text).join("\n"));
	const page = recentListContent(rows, 10, bounded.outputChars, bounded.truncated);
	assert.ok(Value.Check(ListOutputSchema, page));
	assert.deepEqual(page.records, [rows[0].record]);
	assert.equal(page.selectedCount, 3);
	assert.equal(page.omittedRecords, 2);
	assert.equal(page.textTruncated, true);
	assert.ok(Buffer.byteLength(JSON.stringify(page)) <= MAX_OUTPUT_BYTES);
});

test("recent JSON escaping is bounded separately from displayed prose", () => {
	const rows = Array.from({ length: 50 }, (_, index) => row(String(index), "\\".repeat(800)));
	const text = rows.map((row) => row.text).join("\n");
	assert.ok(Buffer.byteLength(text) < MAX_OUTPUT_BYTES);
	const page = recentListContent(rows, 50, text.length, false);
	assert.ok(Value.Check(ListOutputSchema, page));
	assert.ok(page.omittedRecords > 0);
	assert.equal(page.records.length + page.omittedRecords, 50);
	assert.equal(page.textTruncated, false);
	assert.ok(Buffer.byteLength(JSON.stringify(page)) <= MAX_OUTPUT_BYTES);
});
