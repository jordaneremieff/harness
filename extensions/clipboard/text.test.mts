import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES, boundedOutput, sanitizeTerminalText } from "./text.ts";

describe("clipboard display safety", () => {
	it("escapes terminal and bidi controls without flattening real lines", () => {
		const result = sanitizeTerminalText("a\x1b[2J\x07\tb\nleft\u202eright");
		assert.equal(result.changed, true);
		assert.match(result.text, /\\x1b/);
		assert.match(result.text, /\\x07/);
		assert.match(result.text, /\\t/);
		assert.match(result.text, /\\u202e/);
		assert.ok(!/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(result.text));
		assert.equal(result.text.split("\n").length, 2);
	});

	it("keeps tool output within Pi's byte and line conventions", () => {
		for (const input of ["🙂".repeat(MAX_OUTPUT_BYTES), "x\n".repeat(MAX_OUTPUT_LINES + 10)]) {
			const result = boundedOutput(input, "Request a narrower page for the remainder.");
			assert.equal(result.truncated, true);
			assert.ok(Buffer.byteLength(result.text, "utf8") <= MAX_OUTPUT_BYTES);
			assert.ok(result.text.split("\n").length <= MAX_OUTPUT_LINES);
			assert.match(result.text, /Output truncated/);
		}
	});
});
