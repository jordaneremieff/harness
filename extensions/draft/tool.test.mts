import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { filler } from "./scripts/test-kit.mts";
import { checkDraft, MAX_TOOL_CHARS, promptGuidelines, promptSnippet } from "./tool.ts";

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
test("explicit checks retain spelling findings", async () => {
	const result = await checkDraft({ text: "The color and behavior changed.", kind: "prose" }, process.cwd());
	assert.ok(result.report.scored.some((finding) => finding.rule === "spelling.our"));
	assert.match(result.text, /spelling\.our/u);
});
test("tool guidance leaves chat to the reply check, commits to explicit requests and stops at a pass", () => {
	const guidance = [promptSnippet, ...promptGuidelines].join("\n");
	assert.match(guidance, /only on text the automatic reply check does not see/u);
	assert.match(guidance, /documents, pull request descriptions, tickets/u);
	assert.match(guidance, /Check a commit message or diff only when asked/u);
	assert.match(guidance, /Do not call draft on chat replies or status reports/u);
	assert.match(guidance, /Stop at a pass verdict\. After a fail verdict, repair the text and check it once more\./u);
});
test("the verdict uses the reply gate and the configured band", async () => {
	const text = `${filler(200)} This pivotal design is robust. It will foster a dynamic landscape.`;
	const pass = await checkDraft({ text, kind: "prose" }, process.cwd());
	assert.equal(pass.report.score.band, "amber");
	assert.match(pass.text, /Verdict: pass\..*red band\. Do not run the meter again on this text/u);
	const strict = await checkDraft({ text, kind: "prose" }, process.cwd(), { notifyBand: "amber" });
	assert.match(strict.text, /Verdict: fail\./u);
	const hard = await checkDraft({ text: "A dash \u2014 here.", kind: "prose" }, process.cwd());
	assert.match(hard.text, /Verdict: fail\. Repair every hard finding/u);
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
		await assert.rejects(checkDraft({ text: "x", kind: "prose" }, dir, { signal: controller.signal }), /abort/iu);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
