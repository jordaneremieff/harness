import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { boundedOutput, MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES, sanitizeTerminalText } from "./text.ts";

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

	it("escapes every Unicode bidi control", () => {
		const controls = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
		for (const code of controls) {
			assert.deepEqual(sanitizeTerminalText(String.fromCodePoint(code)), {
				text: `\\u${code.toString(16).padStart(4, "0")}`,
				changed: true,
			});
		}
	});

	it("preserves ordinary Arabic, Hebrew, other Unicode and line breaks", () => {
		const text = "العربية עברית 🙂\nnext line";
		assert.deepEqual(sanitizeTerminalText(text), { text, changed: false });
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
