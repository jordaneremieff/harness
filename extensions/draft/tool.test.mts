import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkDraft, MAX_TOOL_CHARS } from "./tool.ts";

test("the tool reports hard and scored findings with locations, score and calibration", async () => {
	const result = await checkDraft(
		{ text: "A plain line.\nFrankly, this pivotal solution — unlocks a robust ecosystem.", kind: "prose" },
		process.cwd(),
	);
	assert.ok(result.report.hard.length > 0);
	assert.ok(result.report.scored.length > 0);
	assert.ok(result.report.hard.every((finding) => finding.line === 2));
	assert.match(result.text, /Hard findings/u);
	assert.match(result.text, /Scored findings/u);
	assert.match(result.text, /Score:.*band/u);
	assert.match(result.text, /Calibration:/u);
});
test("a careful reply has no findings", async () => {
	const result = await checkDraft(
		{ text: "The parser rejects an empty file. The caller receives the error.", kind: "prose" },
		process.cwd(),
	);
	assert.deepEqual(result.report.hard, []);
	assert.deepEqual(result.report.scored, []);
});
test("the tool reads saved files, commit messages and added diff lines", async () => {
	const dir = await mkdtemp(join(tmpdir(), "draft-tool-"));
	try {
		await writeFile(join(dir, "note.md"), "A line — here.");
		const saved = await checkDraft({ path: "note.md", kind: "prose" }, dir);
		assert.equal(saved.report.hard[0]?.line, 1);
		assert.equal(saved.report.input.target, join(dir, "note.md"));
		const commit = await checkDraft({ text: "updates", kind: "commit" }, dir);
		assert.ok(commit.report.hard.some((finding) => finding.rule.startsWith("commit.")));
		const diff = await checkDraft(
			{ text: "--- a/n.md\n+++ b/n.md\n@@ -0,0 +1,1 @@\n+Frankly, no.", kind: "diff" },
			dir,
		);
		assert.equal(diff.report.hard[0]?.file, "n.md");
		assert.equal(diff.report.hard[0]?.line, 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
test("invalid input, oversized files, binary files and cancellation fail explicitly", async () => {
	const dir = await mkdtemp(join(tmpdir(), "draft-input-"));
	try {
		await assert.rejects(checkDraft({ kind: "prose" }, dir), /exactly one/u);
		await assert.rejects(checkDraft({ text: "", path: "x", kind: "prose" }, dir), /exactly one/u);
		await assert.rejects(checkDraft({ path: dir, kind: "prose" }, dir), /regular file/u);
		await assert.rejects(checkDraft({ path: "absent", kind: "prose" }, dir), /ENOENT/u);
		await assert.rejects(checkDraft({ text: "a".repeat(MAX_TOOL_CHARS + 1), kind: "prose" }, dir), /limit/u);
		await writeFile(join(dir, "bad.txt"), Buffer.from([0xff]));
		await assert.rejects(checkDraft({ path: "bad.txt", kind: "prose" }, dir), /encoded data/u);
		await writeFile(join(dir, "bad.txt"), Buffer.from([0]));
		await assert.rejects(checkDraft({ path: "bad.txt", kind: "prose" }, dir), /binary/u);
		await writeFile(join(dir, "large.txt"), "x".repeat(MAX_TOOL_CHARS * 4 + 1));
		await assert.rejects(checkDraft({ path: "large.txt", kind: "prose" }, dir), /limit/u);
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(checkDraft({ text: "x", kind: "prose" }, dir, controller.signal), /abort/iu);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
