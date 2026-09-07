import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BOUNDARY_LINES, boundResult, MAX_RESULT_BYTES, MAX_RESULT_LINES, terminalSafe, escapeJsonControls, oneLine } from "./format.ts";

describe("complete result bounds", () => {
	for (const [label, value] of [
		["escaping", '\\n"'.repeat(40000)],
		["UTF-8", "漢".repeat(40000)],
		["lines", "x\n".repeat(4000)],
	] as const) {
		it(`bounds oversized ${label} in headers and details`, () => {
			const result = boundResult({ header: ["registry outcome=ok", value], blocks: [], footer: BOUNDARY_LINES,
				details: { outcome: "ok", sourceInfo: { path: value } } });
			const envelope = { content: [{ type: "text", text: result.text }], details: result.details };
			assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= MAX_RESULT_BYTES);
			assert.ok(JSON.stringify(envelope, null, 2).replace(/\\n/g, "\n").split("\n").length <= MAX_RESULT_LINES);
			assert.equal(result.details.resultBounded, true);
			assert.equal(result.details.omittedDetails, true);
			assert.match(result.text, /BOUNDARIES/);
			assert.equal(result.details.cursor, undefined);
		});
	}

	it("recomputes continuation from the retained blocks", () => {
		const blocks = Array.from({ length: 100 }, (_, i) => ({ lines: [`record ${i}`], detail: { path: "x".repeat(2000), i } }));
		const result = boundResult({ header: ["registry outcome=ok"], blocks, footer: BOUNDARY_LINES,
			details: {}, pageSummary: (kept) => `records: ${kept} shown`, continuation: (kept) => String(kept) });
		assert.ok(result.droppedBlocks > 0);
		assert.equal(Number(result.details.cursor), (result.details.records as unknown[]).length);
		assert.ok(result.text.includes(`records: ${result.details.returnedRecords} shown`));
		assert.ok(Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: result.text }], details: result.details })) <= MAX_RESULT_BYTES);
	});

	it("reports a record that cannot fit instead of emitting a nonadvancing cursor", () => {
		const result = boundResult({ header: ["registry outcome=ok"], footer: BOUNDARY_LINES,
			blocks: [{ lines: ["record"], detail: { source: "x".repeat(100000) } }], details: {},
			pageSummary: (kept) => `records: ${kept} shown`, continuation: () => "next" });
		assert.equal(result.details.pageBlocked, true);
		assert.equal(result.details.cursor, undefined);
		assert.match(result.text, /cannot advance/);
		assert.match(result.text, /records: 0 shown/);
	});

	it("escapes controls in JSON without changing parsed keys or values", () => {
		const controls = "\u001b\u007f\u0085\u009d\u200e\u200f\u2028\u2029\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069";
		const value = { [`key${controls}`]: `value${controls}`, other: "漢" };
		const escaped = escapeJsonControls(JSON.stringify(value));
		assert.equal(terminalSafe(escaped), escaped);
		assert.doesNotMatch(escaped, /[\u2028\u2029]/);
		assert.deepEqual(JSON.parse(escaped), value);
		assert.equal(escapeJsonControls(escaped), escaped);
	});
	it("removes terminal and bidi controls", () => {
		assert.equal(terminalSafe("a\u001b[31m\u202eb"), "a[31mb");
		assert.equal(oneLine("a\u2028b\u2029c"), "a b c");
	});
});
