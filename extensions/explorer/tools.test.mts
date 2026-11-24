import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { reviewInput, runNotes, runShow, showGuidance } from "./tools.ts";

test("review tools pin three-dot ranges to the common ancestor", async (t) => {
	const temp = await mkdtemp(join(tmpdir(), "explorer-review-"));
	t.after(() => rm(temp, { recursive: true, force: true }));
	const cwd = join(temp, "repo");
	await mkdir(cwd);
	const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
	git("init", "-q", "-b", "main");
	git("config", "user.name", "Reviewer");
	git("config", "user.email", "reviewer@example.test");
	git("config", "commit.gpgsign", "false");
	await writeFile(join(cwd, "file.ts"), "base\n");
	git("add", "file.ts");
	git("commit", "-qm", "Common base");
	const base = git("rev-parse", "HEAD");
	git("branch", "remote-change");
	git("commit", "-qm", "Base advanced", "--allow-empty");
	const main = git("rev-parse", "HEAD");
	git("switch", "-q", "remote-change");
	await writeFile(join(cwd, "file.ts"), "remote\n");
	git("commit", "-qam", "Proposed change");
	const head = git("rev-parse", "HEAD");
	git("switch", "-q", "main");
	const review = { range: "main...remote-change" };
	const context = { cwd, dir: join(temp, "store"), app: join(temp, "Explorer.app"), agentDir: temp };
	const scope = { kind: "range", base, head };
	const showed = await runShow({ review }, context);
	assert.equal(showed.ok, true);
	assert.deepEqual((showed.target as { review: unknown }).review, scope);
	const toured = await runNotes(
		{
			op: "tour",
			review,
			title: "Read the change",
			url: "https://review.example.test/42",
			summary: "A **summary**",
			stops: [{ path: "file.ts", start: 1, end: 1, title: "Finding", text: "Details" }],
		},
		context,
	);
	assert.equal(toured.ok, true);
	const tour = toured.tour as { scope: unknown; url: string; summary: string };
	assert.deepEqual(tour.scope, scope);
	assert.equal(tour.url, "https://review.example.test/42");
	assert.equal(tour.summary, "A **summary**");
	const imported = await runNotes(
		{
			op: "import",
			review,
			comments: [
				{
					id: "1",
					path: "file.ts",
					start: 1,
					end: 1,
					text: "Comment",
					by: "Someone",
					url: "https://review.example.test/42#discussion",
				},
			],
		},
		context,
	);
	assert.equal(imported.created, 1);
	const listed = await runNotes({ op: "list" }, context);
	const note = (listed.notes as { author: string; by?: string; url?: string }[]).find(
		({ author }) => author === "remote",
	);
	assert.equal(note?.by, "Someone");
	assert.equal(note?.url, "https://review.example.test/42#discussion");
	const exported = await runNotes({ op: "export", review }, context);
	assert.equal((exported.review as { base: string }).base, base);
	const direct = await runNotes({ op: "export", review: { range: "main..remote-change" } }, context);
	assert.equal((direct.review as { base: string }).base, main);
	git("switch", "--orphan", "unrelated");
	git("commit", "-qm", "Unrelated root", "--allow-empty");
	const unrelated = await runNotes({ op: "export", review: { range: "main...unrelated" } }, context);
	assert.equal(unrelated.ok, false);
	assert.match(unrelated.summary, /no common ancestor/u);
	for (const range of ["main....remote-change", "main..", "main..other...head"])
		assert.throws(() => reviewInput({ range }), /base\.\.head/u);
});

test("interactive coordinator shows code while workers report locations", () => {
	for (const pane of ["float", "split"] as const) {
		const guidance = showGuidance(pane);
		assert.match(guidance, /work for another agent or run without an interactive conversation/u);
		assert.match(guidance, /In the interactive session with the operator/u);
		assert.match(guidance, /report the file paths and line ranges/u);
	}
});
