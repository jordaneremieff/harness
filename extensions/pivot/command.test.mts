import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildForkCommand } from "./command.ts";

describe("fork command assembly", () => {
	const ok = (value: ReturnType<typeof buildForkCommand>): string => {
		assert.equal(value.ok, true);
		return (value as { ok: true; text: string }).text;
	};

	it("quotes plain paths and cds with --", () => {
		assert.equal(
			ok(buildForkCommand("/Users/me/My Project", "/Users/me/.pi/agent/sessions/x.jsonl")),
			"cd -- '/Users/me/My Project' && pi --fork '/Users/me/.pi/agent/sessions/x.jsonl'",
		);
	});

	it("escapes single quotes with the POSIX sequence", () => {
		assert.equal(
			ok(buildForkCommand("/a/b'c", "/s/e'ssion.jsonl")),
			"cd -- '/a/b'\\''c' && pi --fork '/s/e'\\''ssion.jsonl'",
		);
	});

	it("refuses paths containing newlines", () => {
		const result = buildForkCommand("/a\nb", "/s.jsonl");
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /newline/);
	});
});
