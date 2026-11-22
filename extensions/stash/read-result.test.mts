import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ACTIVE_EDIT_NOTE, readStashResult } from "./read-result.ts";

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

test("an active handover's read says that its first edit needs allowActive, beside the digest and after truncation", () => {
	const header = '---\ntitle: "Saved effort"\nstate: "active"\n---\n\n# Saved effort\n\n';
	const active = source(`${header}Resumed work.`);
	assert.ok(
		readStashResult(active).content[0].text.endsWith(`[Artifact digest: ${active.digest}]\n${ACTIVE_EDIT_NOTE}`),
	);
	const long = source(`${header}${"line\n".repeat(2500)}`);
	const bounded = readStashResult(long);
	assert.equal(bounded.details.truncated, true);
	assert.ok(
		bounded.content[0].text.includes(`Digest: ${long.digest}. ${ACTIVE_EDIT_NOTE} Full artifact: ${long.path}`),
	);
	for (const state of ["open", "closed"]) {
		const other = source(header.replace('"active"', `"${state}"`));
		assert.ok(readStashResult(other).content[0].text.endsWith(`[Artifact digest: ${other.digest}]`), state);
	}
	assert.ok(
		!readStashResult(active, "checkpoints").content[0].text.includes(ACTIVE_EDIT_NOTE),
		"checkpoints take no stash_edit",
	);
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
