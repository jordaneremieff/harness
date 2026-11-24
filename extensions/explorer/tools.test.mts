import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NotesStore } from "./notes-store.ts";
import { resolveRepository } from "./repository.ts";
import { NOTES_OUTPUT_BYTES, reviewInput, runNotes, runShow, showGuidance } from "./tools.ts";

test("batch receipts keep every ID without returning large quotes", async (t) => {
	const temp = await mkdtemp(join(tmpdir(), "explorer-note-receipts-"));
	t.after(() => rm(temp, { recursive: true, force: true }));
	const cwd = join(temp, "folder");
	await mkdir(cwd);
	await writeFile(join(cwd, "long.txt"), "x".repeat(NOTES_OUTPUT_BYTES));
	await writeFile(join(cwd, "binary.dat"), Buffer.from([0, 1]));
	const context = { cwd, dir: join(temp, "store") };
	const line = { path: "long.txt", start: 1, end: 1, text: "Inspect" };
	const result = await runNotes(
		{
			op: "note",
			notes: [line, line, { target: { kind: "file", path: "binary.dat" }, text: "Binary target" }],
		},
		context,
	);
	assert.equal(result.ok, true);
	assert.equal((result.ids as string[]).length, 3);
	assert.ok(Buffer.byteLength(JSON.stringify(result)) < NOTES_OUTPUT_BYTES);
	assert.equal(Object.hasOwn((result.notes as object[])[0], "anchor"), false);
});

test("review tools pin ranges, create freeform targets, update agents and refuse stale writes", async (t) => {
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
	const context = {
		cwd,
		dir: join(temp, "store"),
		app: join(temp, "Explorer.app"),
		agentDir: temp,
	};
	const scope = { kind: "range", base, head };
	const showed = await runShow({ review }, context);
	assert.equal(showed.ok, true);
	assert.deepEqual((showed.target as { review: unknown }).review, scope);

	const single = await runNotes(
		{
			op: "note",
			review,
			path: "file.ts",
			start: 1,
			end: 1,
			title: "Finding",
			text: "Details",
		},
		context,
	);
	assert.equal(single.ok, true);
	const saved = single.note as {
		id: string;
		text: string;
		updatedAt: string;
		reviewKey: string;
		anchor: { quote: string };
	};
	assert.match(saved.id, /^n-[a-f0-9]{20}$/);
	assert.equal(saved.anchor.quote, "remote");
	assert.equal(saved.reviewKey, `${base}..${head}`);

	const batch = await runNotes(
		{
			op: "note",
			review,
			notes: [
				{
					target: { kind: "file", path: "file.ts", side: "head" },
					text: "File note",
					title: "File",
				},
				{ target: { kind: "commit", commit: head }, text: "Commit note" },
				{
					target: { kind: "review", review },
					text: "Review note",
					url: "https://review.example.test/42",
				},
			],
		},
		context,
	);
	assert.equal(batch.ok, true);
	const savedBatch = batch.notes as {
		id: string;
		target: unknown;
		reviewKey?: string;
	}[];
	assert.equal(savedBatch.length, 3);
	assert.deepEqual(
		savedBatch.map((note) => (note.target as { kind: string }).kind),
		["file", "commit", "review"],
	);
	assert.deepEqual((savedBatch[0].target as { side?: string }).side, "head");
	assert.equal(savedBatch[0].reviewKey, `${base}..${head}`);
	assert.equal(savedBatch[1].reviewKey, undefined);
	assert.deepEqual((savedBatch[2].target as { review: unknown }).review, scope);
	assert.equal(savedBatch[2].reviewKey, `${base}..${head}`);
	assert.equal((batch.ids as string[]).length, 3);

	const edited = await runNotes(
		{
			op: "update",
			id: saved.id,
			text: "Edited",
			expectedUpdatedAt: saved.updatedAt,
		},
		context,
	);
	assert.equal(edited.ok, true);
	assert.equal((edited.note as { text: string }).text, "Edited");
	assert.notEqual((edited.note as { updatedAt: string }).updatedAt, saved.updatedAt);
	const stale = await runNotes(
		{
			op: "update",
			id: saved.id,
			text: "Stale",
			expectedUpdatedAt: saved.updatedAt,
		},
		context,
	);
	assert.equal(stale.ok, false);
	assert.equal((stale.error as { code: string }).code, "conflict");

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
				{ id: "file", path: "file.ts", text: "File discussion", by: "Someone" },
				{
					id: "commit",
					commit: head,
					text: "Commit discussion",
					by: "Someone",
				},
				{ id: "review", text: "Review discussion", by: "Someone" },
			],
		},
		context,
	);
	assert.equal(imported.created, 4);
	const importedNotes = imported.notes as { id: string; external: string }[];
	const remoteId = importedNotes.find((note) => note.external === "1")?.id as string;
	const wrongAuthor = await runNotes(
		{
			op: "update",
			id: remoteId,
			text: "Not mine",
			expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
		},
		context,
	);
	assert.equal(wrongAuthor.ok, false);

	const listed = await runNotes({ op: "list" }, context);
	assert.equal(listed.ok, true);
	const rows = listed.notes as {
		author: string;
		by?: string;
		url?: string;
		target?: { kind: string };
	}[];
	assert.equal(rows.find(({ author }) => author === "remote")?.by, "Someone");
	assert.deepEqual(
		new Set(rows.filter(({ target }) => target).map(({ target }) => target?.kind)),
		new Set(["commit", "file", "review"]),
	);

	const repo = await resolveRepository(cwd);
	const store = new NotesStore(join(temp, "store"), repo);
	const operator = (
		await store.request("create", {
			note: {
				path: "file.ts",
				side: "head",
				start: 1,
				end: 1,
				commit: head,
				quote: "remote",
				text: "Operator review comment",
				author: "operator",
				state: "sent",
			},
		})
	).note as { id: string; updatedAt: string };
	const exported = await runNotes({ op: "export", review }, context);
	assert.equal(exported.ok, true);
	assert.equal(
		(exported.notes as { id: string }[]).some(({ id }) => id === operator.id),
		true,
	);

	const refused = await runNotes({ op: "delete", ids: [saved.id, remoteId] }, context);
	assert.equal(refused.ok, false);
	assert.equal((refused.error as { code: string }).code, "conflict");
	const deleted = await runNotes({ op: "delete", ids: [saved.id, savedBatch[0].id] }, context);
	assert.equal(deleted.ok, true);
	assert.deepEqual((deleted.ids as string[]).sort(), [saved.id, savedBatch[0].id].sort());
	const missing = await runNotes({ op: "read", id: saved.id }, context);
	assert.equal(missing.ok, false);
	assert.equal((missing.error as { code: string }).code, "not-found");

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
