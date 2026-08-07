import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES, boundedOutput, sanitizeTerminalText } from "./text.ts";

describe("sanitizeTerminalText", () => {
	it("renders terminal and bidi controls as inert escape text while preserving newlines", () => {
		const result = sanitizeTerminalText("before\x1b]0;owned\x07\tafter\nright\u202ewrong");
		assert.equal(result.changed, true);
		assert.match(result.text, /\\x1b/);
		assert.match(result.text, /\\x07/);
		assert.match(result.text, /\\t/);
		assert.match(result.text, /\\u202e/);
		assert.ok(!/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(result.text));
		assert.equal(result.text.split("\n").length, 2);
	});
});

describe("boundedOutput", () => {
	it("caps output by bytes and retains a useful truncation notice", () => {
		const result = boundedOutput("é".repeat(MAX_OUTPUT_BYTES), "Read the artifact file for the full text.");
		assert.equal(result.truncated, true);
		assert.ok(Buffer.byteLength(result.text, "utf8") <= MAX_OUTPUT_BYTES);
		assert.ok(result.text.split("\n").length <= MAX_OUTPUT_LINES);
		assert.match(result.text, /Output truncated/);
		assert.match(result.text, /full text/);
	});

	it("caps output by lines", () => {
		const result = boundedOutput(Array.from({ length: MAX_OUTPUT_LINES + 50 }, (_, i) => `line ${i}`).join("\n"));
		assert.equal(result.truncated, true);
		assert.ok(result.text.split("\n").length <= MAX_OUTPUT_LINES);
		assert.match(result.text, /Output truncated/);
	});
});
