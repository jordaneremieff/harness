import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { readStashResult } from "./read-result.ts";

function source(content: string) {
	return {
		ok: true as const,
		id: "saved-effort",
		path: "/workspace/stash/saved-effort.md",
		content,
		digest: createHash("sha256").update(content).digest("hex"),
	};
}

test("complete reads expose the raw-file digest beside terminal-safe content", () => {
	const input = source('---\ntitle: "Saved effort"\nstate: "open"\n---\n\n# Saved effort\n\nNew\tinformation.');
	const result = readStashResult(input);
	assert.equal(result.details.digest, input.digest);
	assert.equal(result.details.controlsEscaped, true);
	assert.equal(result.details.truncated, false);
	assert.ok(result.content[0].text.startsWith('---\ntitle: "Saved effort"'));
	assert.match(result.content[0].text, /New\\tinformation\./);
	assert.ok(result.content[0].text.endsWith(`[Artifact digest: ${input.digest}]`));
});

test("byte and line bounded reads retain the digest and continuation path", () => {
	for (const content of ["é".repeat(40_000), "line\n".repeat(2500), "x".repeat(50 * 1024 - 1)]) {
		const input = source(content);
		const result = readStashResult(input);
		const text = result.content[0].text;
		assert.equal(result.details.truncated, true);
		assert.ok(Buffer.byteLength(text, "utf8") <= 50 * 1024);
		assert.ok(text.split("\n").length <= 2000);
		assert.ok(text.includes(input.digest));
		assert.ok(text.includes(input.path));
		assert.match(text, /Output truncated/);
	}
});
