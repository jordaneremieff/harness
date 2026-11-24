import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import { type CreateLineNote, type Note, NotesStore, recentRoots } from "./notes-store.ts";
import { resolveRepository } from "./repository.ts";

type LineNote = Extract<Note, { anchor: unknown }>;
const lineNote = (value: Note): LineNote => {
	assert.ok("anchor" in value);
	return value;
};
const targetNote = (value: Note): Extract<Note, { target: unknown }> => {
	assert.ok("target" in value);
	return value;
};

const helper = fileURLToPath(new URL("./notes-helper.ts", import.meta.url));
const example: CreateLineNote = {
	path: "code.ts",
	side: "head",
	start: 2,
	end: 2,
	commit: null,
	quote: "target",
	text: "Check this line.",
	author: "operator",
	state: "draft",
};
const missingId = `n-${"0".repeat(20)}`;
const gitAt = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });

async function remoteFixture(t: TestContext) {
	const { root, dir } = await fixture(t);
	const git = (...args: string[]) => gitAt(root, ...args);
	git("init", "-q", "-b", "main");
	git("config", "user.name", "Reviewer");
	git("config", "user.email", "reviewer@example.test");
	git("config", "commit.gpgsign", "false");
	const lines = Array.from({ length: 50 }, (_, at) => `line ${at + 1}`);
	const oldPath = 'old "path".txt';
	const newPath = "new path.txt";
	await writeFile(join(root, oldPath), `${lines.join("\n")}\n`);
	await writeFile(join(root, "type.txt"), "ordinary file\n");
	git("add", ".");
	git("commit", "-qm", "Base");
	const base = git("rev-parse", "HEAD").trim();
	git("switch", "-qc", "review");
	git("mv", oldPath, newPath);
	await rm(join(root, "type.txt"));
	await symlink("code.ts", join(root, "type.txt"));
	const next = [...lines.slice(0, 7), "new 1", "new 2", ...lines.slice(7, 30), ...lines.slice(31)];
	await writeFile(join(root, newPath), `${next.join("\n")}\n`);
	git("add", ".");
	git("commit", "-qm", "Review");
	const head = git("rev-parse", "HEAD").trim();
	git("switch", "-q", "main");
	const review = { kind: "range", base, head } as const;
	const repo = await resolveRepository(root);
	return {
		root,
		dir,
		repo,
		notes: new NotesStore(dir, repo),
		git,
		review,
		oldPath,
		newPath,
	};
}
const sha256 = (input: string) => createHash("sha256").update(input).digest("hex");

async function fixture(t: TestContext) {
	const temp = await mkdtemp(join(tmpdir(), "explorer-notes-"));
	t.after(async () => rm(temp, { recursive: true, force: true }));
	const dir = join(temp, "store");
	const root = join(temp, "folder");
	await mkdir(root);
	await writeFile(join(root, example.path), "intro\ntarget\nend\n");
	const repo = await resolveRepository(root);
	const notes = new NotesStore(dir, repo);
	const repoDir = join(dir, "repos", sha256(repo.identity).slice(0, 32));
	const record = (id: string) => join(repoDir, "notes", `${id}.json`);
	const add = async (patch: Partial<CreateLineNote> = {}) =>
		(await notes.request("create", { note: { ...example, ...patch } })).note as Note;
	return { temp, dir, root, repoDir, repo, notes, record, add };
}

function envelope(input: Buffer | string) {
	const child = spawnSync(process.execPath, [helper], {
		input,
		encoding: "utf8",
		timeout: 10_000,
	});
	assert.ifError(child.error);
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout);
}

function call(request: Record<string, unknown>): Promise<{ ok: boolean; note: Note }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [helper], {
			timeout: 10_000,
			stdio: ["pipe", "pipe", "inherit"],
		});
		let output = "";
		child.stdout.setEncoding("utf8").on("data", (text) => {
			output += text;
		});
		child.on("error", reject);
		child.stdin.on("error", reject);
		child.on("close", (status) => {
			try {
				assert.equal(status, 0);
				resolve(JSON.parse(output));
			} catch (error) {
				reject(error);
			}
		});
		child.stdin.end(JSON.stringify(request));
	});
}

test("notes keep private source records and resolve locations on every read", async (t) => {
	const { dir, root, repoDir, notes, record, add } = await fixture(t);
	assert.deepEqual(await notes.request("list"), {
		notes: [],
		unreadable: 0,
		truncated: false,
	});
	await assert.rejects(stat(dir), { code: "ENOENT" });
	const note = lineNote(await add());
	assert.match(note.id, /^n-[0-9a-f]{20}$/);
	assert.equal(note.location, "same");
	assert.deepEqual(note.anchor, {
		start: 2,
		end: 2,
		commit: null,
		quote: "target",
	});
	const source = JSON.parse(await readFile(record(note.id), "utf8"));
	for (const key of ["start", "end", "location", "movedFrom", "target"])
		assert.equal(Object.hasOwn(source, key), false);
	for (const file of [dir, join(dir, "repos"), repoDir, join(repoDir, "notes")])
		assert.equal((await stat(file)).mode & 0o777, 0o700);
	for (const file of [join(dir, "store.json"), join(repoDir, "repo.json"), record(note.id)])
		assert.equal((await stat(file)).mode & 0o777, 0o600);
	await writeFile(join(root, example.path), "intro\nnew\ntarget\nend\n");
	const moved = (await notes.request("list", { path: example.path })).notes as LineNote[];
	assert.deepEqual(
		moved.map(({ id, start, end, location, movedFrom }) => ({
			id,
			start,
			end,
			location,
			movedFrom,
		})),
		[{ id: note.id, start: 3, end: 3, location: "moved", movedFrom: 2 }],
	);
	await writeFile(join(root, example.path), "intro\nnew\ntarget\ntarget\n");
	const outdated = lineNote((await notes.request("read", { id: note.id })).note as Note);
	assert.equal(outdated.location, "outdated");
	assert.deepEqual(outdated.anchor, note.anchor);
	assert.deepEqual((await notes.request("list", { path: "elsewhere" })).notes, []);
	assert.deepEqual(await readdir(join(repoDir, "notes")), [`${note.id}.json`]);
});

test("freeform targets store no line fields and pin review scopes", async (t) => {
	const { dir, repo, notes, review, newPath } = await remoteFixture(t);
	const file = (
		await notes.request("create", {
			note: {
				target: { kind: "file", path: newPath, side: "base" },
				text: "File note.",
				author: "agent",
				state: "open",
				reviewKey: `${review.base}..${review.head}`,
			},
		})
	).note as Note;
	assert.deepEqual(targetNote(file).target, { kind: "file", path: newPath, side: "base" });
	assert.equal("path" in file, false);
	assert.equal("anchor" in file, false);
	assert.equal(file.reviewKey, `${review.base}..${review.head}`);
	const commit = (
		await notes.request("create", {
			note: {
				target: { kind: "commit", commit: review.head },
				text: "Commit note.",
				author: "agent",
				state: "open",
			},
		})
	).note as Note;
	assert.deepEqual(targetNote(commit).target, { kind: "commit", commit: review.head });
	const reviewed = (
		await notes.request("create", {
			note: {
				target: {
					kind: "review",
					review: { kind: "range", base: "main", head: "review" },
				},
				text: "Review note.",
				author: "agent",
				state: "open",
			},
		})
	).note as Note;
	assert.deepEqual(targetNote(reviewed).target, {
		kind: "review",
		review: { kind: "range", base: review.base, head: review.head },
	});
	assert.equal(reviewed.reviewKey, `${review.base}..${review.head}`);
	const stored = JSON.parse(
		await readFile(join(dir, "repos", sha256(repo.identity).slice(0, 32), "notes", `${file.id}.json`), "utf8"),
	);
	assert.deepEqual(
		Object.keys(stored).filter((key) => ["path", "side", "anchor", "start", "end"].includes(key)),
		[],
	);
	assert.deepEqual(stored.target, {
		kind: "file",
		path: newPath,
		side: "base",
	});
	const listed = (await notes.request("list", { path: newPath })).notes as Note[];
	assert.ok(listed.some((note) => note.id === file.id));
	await assert.rejects(
		notes.request("create", {
			note: {
				target: { kind: "commit", commit: "abc" },
				text: "Bad.",
				author: "agent",
				state: "open",
			},
		}),
		{ code: "invalid" },
	);
	await assert.rejects(
		notes.request("create", {
			note: {
				target: { kind: "file", path: newPath },
				path: newPath,
				text: "Mixed.",
				author: "agent",
				state: "open",
			},
		}),
		{ code: "invalid" },
	);
});

test("batch writes validate every note before publishing and ignore retired stop markers", async (t) => {
	const { notes, repoDir, record } = await fixture(t);
	await assert.rejects(stat(join(repoDir, "notes")), { code: "ENOENT" });
	await assert.rejects(
		notes.request("create", {
			notes: [
				{ ...example, author: "agent", state: "open", text: "First" },
				{ ...example, author: "agent", state: "open", text: " " },
			],
		}),
		{ code: "invalid" },
	);
	await assert.rejects(stat(join(repoDir, "notes")), { code: "ENOENT" });
	const created = (
		await notes.request("create", {
			notes: [
				{ ...example, author: "agent", state: "open", text: "First" },
				{ ...example, author: "agent", state: "open", text: "Second" },
			],
		})
	).notes as Note[];
	assert.deepEqual(
		created.map((note) => note.text),
		["First", "Second"],
	);
	const saved = JSON.parse(await readFile(record(created[0].id), "utf8"));
	await writeFile(record(created[0].id), JSON.stringify({ ...saved, tour: { id: "t-retired", order: 1 } }));
	const read = (await notes.request("read", { id: created[0].id })).note as Note;
	assert.equal(Object.hasOwn(read, "tour"), false);
	await notes.request("reply", {
		id: created[0].id,
		author: "agent",
		text: "Keep",
	});
	const rewritten = JSON.parse(await readFile(record(created[0].id), "utf8"));
	assert.equal(Object.hasOwn(rewritten, "tour"), false);
});

test("update and delete enforce author, expected time and all-or-nothing validation", async (t) => {
	const { notes, add } = await fixture(t);
	const operator = await add({ title: "Operator title" });
	const agent = await add({
		author: "agent",
		state: "open",
		title: "Agent title",
	});
	await assert.rejects(
		notes.request("update", {
			id: operator.id,
			text: "Tool edit",
			expectedUpdatedAt: operator.updatedAt,
			agentOnly: true,
		}),
		{ code: "conflict" },
	);
	const edited = (
		await notes.request("update", {
			id: agent.id,
			text: "Agent edit",
			expectedUpdatedAt: agent.updatedAt,
			agentOnly: true,
		})
	).note as Note;
	assert.equal(edited.text, "Agent edit");
	assert.notEqual(edited.updatedAt, agent.updatedAt);
	await assert.rejects(
		notes.request("update", {
			id: agent.id,
			text: "Stale edit",
			expectedUpdatedAt: agent.updatedAt,
			agentOnly: true,
		}),
		{ code: "conflict" },
	);
	const cleared = (
		await notes.request("update", {
			id: agent.id,
			title: null,
			expectedUpdatedAt: edited.updatedAt,
			agentOnly: true,
		})
	).note as Note;
	assert.equal(cleared.title, undefined);
	assert.equal(cleared.text, "Agent edit");
	const native = (
		await notes.request("update", {
			id: operator.id,
			text: "Operator edit",
			expectedUpdatedAt: operator.updatedAt,
		})
	).note as Note;
	assert.equal(native.text, "Operator edit");
	await assert.rejects(notes.request("update", { id: operator.id, text: "Missing time" }), { code: "invalid" });
	await assert.rejects(notes.request("delete", { ids: [agent.id, operator.id], agentOnly: true }), {
		code: "conflict",
	});
	assert.equal(((await notes.request("read", { id: agent.id })).note as Note).id, agent.id);
	await notes.request("delete", { ids: [agent.id], agentOnly: true });
	await assert.rejects(notes.request("read", { id: agent.id }), {
		code: "not-found",
	});
	await assert.rejects(notes.request("delete", { ids: [missingId], agentOnly: true }), { code: "not-found" });
	await notes.request("delete", { id: operator.id });
	await assert.rejects(notes.request("read", { id: operator.id }), {
		code: "not-found",
	});
	await assert.rejects(notes.request("state", { ids: [missingId], state: "sent" }), { code: "not-found" });
	for (const patch of [
		{ path: "../outside" },
		{ start: 3 },
		{ commit: "--not-a-hash" },
		{ text: " \t" },
		{ author: "unknown" },
	])
		await assert.rejects(notes.request("create", { note: { ...example, ...patch } }), { code: "invalid" });
});

test("imports anchor lines, add freeform targets, update in place, and retain local replies", async (t) => {
	const { notes, review, oldPath, newPath } = await remoteFixture(t);
	const first = {
		id: "discussion:1",
		path: newPath,
		start: 8,
		end: 9,
		by: "Reviewer",
		text: "Original",
		url: "https://review.example.test/42#comment",
		replies: [{ by: "Author", text: "Old reply" }],
	};
	const second = {
		id: "discussion:2",
		path: oldPath,
		start: 31,
		end: 31,
		side: "base",
		by: "Reviewer",
		text: "Deleted line",
	};
	const file = {
		id: "discussion:3",
		path: newPath,
		by: "Reviewer",
		text: "File note",
	};
	const commit = {
		id: "discussion:4",
		commit: review.head,
		by: "Reviewer",
		text: "Commit note",
	};
	const reviewed = { id: "discussion:5", by: "Reviewer", text: "Review note" };
	const existing = await notes.request("import", {
		review,
		comments: [first, second, file, commit, reviewed, { ...first, id: "missing", start: 999, end: 999 }],
	});
	assert.equal(existing.created, 5);
	assert.equal(existing.updated, 0);
	assert.match((existing.skipped as { reason: string }[])[0].reason, /outside/u);
	const ids = existing.notes as { id: string; external: string }[];
	const byExternal = new Map(ids.map((row) => [row.external, row.id]));
	const head = byExternal.get(first.id) as string;
	const base = byExternal.get(second.id) as string;
	const imported = lineNote((await notes.request("read", { id: head })).note as Note);
	assert.deepEqual(imported.anchor, {
		start: 8,
		end: 9,
		quote: "new 1\nnew 2",
		commit: review.head,
	});
	assert.equal(imported.reviewKey, `${review.base}..${review.head}`);
	assert.deepEqual(lineNote((await notes.request("read", { id: base })).note as Note).anchor, {
		start: 31,
		end: 31,
		quote: "line 31",
		commit: review.base,
	});
	assert.deepEqual(
		targetNote((await notes.request("read", { id: byExternal.get(file.id) as string })).note as Note).target,
		{
			kind: "file",
			path: newPath,
		},
	);
	assert.deepEqual(
		targetNote((await notes.request("read", { id: byExternal.get(commit.id) as string })).note as Note).target,
		{
			kind: "commit",
			commit: review.head,
		},
	);
	assert.deepEqual(
		targetNote((await notes.request("read", { id: byExternal.get(reviewed.id) as string })).note as Note).target,
		{
			kind: "review",
			review: { kind: "range", base: review.base, head: review.head },
		},
	);
	assert.equal(imported.author, "remote");
	assert.equal(imported.url, first.url);
	assert.equal(imported.thread[0].author, "remote");
	assert.equal(imported.thread[0].by, "Author");
	await notes.request("reply", {
		id: head,
		author: "operator",
		text: "Local reply",
	});
	const local = ((await notes.request("read", { id: head })).note as Note).thread[1];
	const revised = await notes.request("import", {
		review,
		comments: [
			{
				...first,
				...second,
				id: first.id,
				by: "New reviewer",
				url: undefined,
				resolved: true,
				replies: [{ by: "Author", text: "New reply", at: "2026-01-12T10:30:00+02:00" }, ...first.replies],
			},
		],
	});
	assert.deepEqual(revised, {
		created: 0,
		updated: 1,
		notes: [{ id: head, external: first.id }],
		skipped: [],
	});
	const saved = lineNote((await notes.request("read", { id: head })).note as Note);
	assert.equal(saved.state, "resolved");
	assert.equal(saved.side, "base");
	assert.equal(saved.by, "New reviewer");
	assert.equal(saved.url, undefined);
	assert.deepEqual(saved.thread.slice(1), [imported.thread[0], local]);
	assert.equal(saved.thread[0].at, "2026-01-12T08:30:00.000Z");
	await assert.rejects(
		notes.request("update", {
			id: head,
			text: "Not editable",
			expectedUpdatedAt: saved.updatedAt,
		}),
		{
			code: "conflict",
		},
	);
	await notes.request("state", { ids: [head], state: "open" });
	await notes.request("delete", { id: head });
	assert.equal(((await notes.request("list")).notes as Note[]).length, 4);
});

test("exports exact Git hunk positions on both sides of a rename and excludes targets", async (t) => {
	const { notes, git, review, oldPath, newPath } = await remoteFixture(t);
	const add = async (patch: Partial<CreateLineNote>) =>
		((await notes.request("create", { note: { ...example, ...patch } })).note as Note).id;
	const added = await add({
		path: newPath,
		start: 8,
		end: 9,
		quote: "new 1\nnew 2",
	});
	const removed = await add({
		path: newPath,
		side: "base",
		start: 31,
		end: 31,
		quote: "line 31",
		state: "sent",
	});
	const moved = await add({
		path: newPath,
		start: 1,
		end: 1,
		quote: "line 32",
	});
	const beyond = await add({
		path: newPath,
		start: 41,
		end: 41,
		quote: "line 40",
	});
	const partial = await add({
		path: newPath,
		start: 4,
		end: 5,
		quote: "line 4\nline 5",
	});
	const stale = await add({ path: newPath, quote: "no match" });
	const resolved = await add({ path: newPath, state: "open", quote: "new 1" });
	const agent = await add({ path: newPath, author: "agent" });
	const target = (
		(
			await notes.request("create", {
				note: {
					target: { kind: "file", path: newPath },
					text: "Freeform",
					author: "operator",
					state: "sent",
				},
			})
		).note as Note
	).id;
	const patch = git("diff", "--find-renames", "-U3", review.base, review.head);
	assert.match(patch, /rename from "old .*\nrename to new path.txt/u);
	assert.match(patch, /@@ -5,6 \+5,8 @@ line 4\n line 5\n line 6\n line 7\n\+new 1\n\+new 2/u);
	assert.match(patch, /@@ -28,7 \+30,6 @@ line 27\n line 28\n line 29\n line 30\n-line 31\n line 32/u);
	const { notes: rows, review: pinned } = (await notes.request("export", {
		review,
		ids: [added, removed, moved, beyond, partial, stale],
	})) as {
		notes: { start: number; end: number; position: unknown; reason?: string }[];
		review: { base: string; head: string };
	};
	assert.equal(pinned.base, review.base);
	assert.equal(pinned.head, review.head);
	const position = (index: number, start: unknown, end: unknown, inDiff: boolean) =>
		assert.deepEqual(rows[index].position, {
			oldPath,
			newPath,
			start,
			end,
			inDiff,
		});
	position(0, { old: null, new: 8, kind: "added" }, { old: null, new: 9, kind: "added" }, true);
	const deleted = { old: 31, new: null, kind: "deleted" };
	position(1, deleted, deleted, true);
	const context = (old: number, fresh: number) => ({
		old,
		new: fresh,
		kind: "context",
	});
	position(2, context(32, 33), context(32, 33), true);
	assert.equal(rows[2].start, 33);
	position(3, context(40, 41), context(40, 41), false);
	position(4, context(4, 4), context(5, 5), false);
	assert.equal(rows[5].position, null);
	assert.match(rows[5].reason ?? "", /quote/u);
	assert.deepEqual(
		new Set(((await notes.request("export", { review })).notes as Note[]).map(({ id }) => id)),
		new Set([added, removed, moved, beyond, partial, stale]),
	);
	assert.equal(((await notes.request("export", { review, ids: [resolved] })).notes as Note[]).length, 1);
	await assert.rejects(notes.request("export", { review, ids: [agent] }), {
		code: "invalid",
	});
	await assert.rejects(notes.request("export", { review, ids: [target] }), {
		code: "invalid",
	});
});

test("worktree review positions include new files and do not run clean filters", async (t) => {
	const { root, notes, git } = await remoteFixture(t);
	await writeFile(join(root, "code.ts"), "intro\ninserted\ntarget\nend\n");
	await writeFile(join(root, "new.ts"), "new file\n");
	await writeFile(join(root, ".gitattributes"), "code.ts filter=custom\n");
	git("config", "filter.custom.clean", "touch .filter-ran && cat");
	git("config", "filter.custom.required", "true");
	const review = { kind: "uncommitted" };
	const create = async (patch: Partial<CreateLineNote>) =>
		((await notes.request("create", { note: { ...example, ...patch } })).note as Note).id;
	const a = await create({ quote: "inserted" });
	const b = await create({
		path: "new.ts",
		start: 1,
		end: 1,
		quote: "new file",
	});
	const { notes: rows } = (await notes.request("export", {
		review,
		ids: [a, b],
	})) as {
		notes: { position: unknown }[];
	};
	for (const [index, path, fresh] of [
		[0, "code.ts", 2],
		[1, "new.ts", 1],
	] as const) {
		const point = { old: null, new: fresh, kind: "added" };
		assert.deepEqual(rows[index].position, {
			oldPath: path,
			newPath: path,
			start: point,
			end: point,
			inDiff: true,
		});
	}
	await assert.rejects(stat(join(root, ".filter-ran")), { code: "ENOENT" });
});

test("review state and recents remain separate from note records", async (t) => {
	const { notes, dir, repo, repoDir, temp } = await fixture(t);
	const head = "a".repeat(40);
	const key = `empty..${head}`;
	assert.deepEqual(await notes.request("review-get", { key }), { viewed: [] });
	assert.deepEqual(await notes.request("marker", { branch: "__proto__" }), {
		head: null,
	});
	const review = await notes.request("review-set", {
		key,
		viewed: ["code.ts", "code.ts"],
		finished: true,
		head,
		branch: "__proto__",
	});
	assert.deepEqual(review.viewed, ["code.ts"]);
	assert.deepEqual(await notes.request("review-get", { key }), review);
	assert.deepEqual(await notes.request("marker", { branch: "__proto__" }), {
		head,
	});
	assert.deepEqual(
		await notes.request("review-set", {
			key: "worktree@empty",
			viewed: ["code.ts"],
			finished: true,
		}),
		{
			viewed: ["code.ts"],
		},
	);
	assert.equal((await stat(join(repoDir, "reviews", `${sha256(key)}.json`))).mode & 0o777, 0o600);
	assert.deepEqual(await recentRoots(dir), []);
	await notes.request("remember");
	const other = join(temp, "other");
	await mkdir(other);
	const otherRepo = await resolveRepository(other);
	await new NotesStore(dir, otherRepo).request("remember");
	await notes.request("remember");
	assert.deepEqual(
		await recentRoots(dir),
		[repo, otherRepo].map(({ root, label }) => ({ path: root, label })),
	);
});

test("invalid, oversized and linked records are counted and never overwritten", async (t) => {
	const { root, notes, add, record } = await fixture(t);
	const good = await add();
	const broken = await add();
	const invalid = '{"id":"wrong"}';
	await writeFile(record(broken.id), invalid);
	await writeFile(record(`n-${"1".repeat(20)}`), Buffer.alloc(2 * 1024 * 1024 + 1));
	await symlink(join(root, example.path), record(`n-${"2".repeat(20)}`));
	const result = await notes.request("list");
	assert.equal(result.unreadable, 3);
	assert.deepEqual(
		(result.notes as Note[]).map((note) => note.id),
		[good.id],
	);
	await assert.rejects(
		notes.request("update", {
			id: broken.id,
			text: "Do not repair",
			expectedUpdatedAt: good.updatedAt,
		}),
		{ code: "not-found" },
	);
	assert.equal(await readFile(record(broken.id), "utf8"), invalid);
});

test("helper enforces the envelope and shares the writer lock across processes", async (t) => {
	const { dir, root, notes, add } = await fixture(t);
	const base = { version: 1, store: dir, root };
	for (const input of [
		"{}\n{}",
		JSON.stringify({ ...base, version: 2, op: "list" }),
		JSON.stringify({ ...base, store: "relative", op: "list" }),
		JSON.stringify({ ...base, root: "relative", op: "list" }),
		JSON.stringify({ ...base, root: join(root, example.path), op: "list" }),
		Buffer.alloc(1024 * 1024 + 1, 32),
	])
		assert.equal(envelope(input).error.code, "invalid");
	const { id } = await add();
	const release = await lockfile.lock(dir);
	try {
		assert.equal(envelope(JSON.stringify({ ...base, op: "create", note: example })).error.code, "busy");
	} finally {
		await release();
	}
	const receipts = await Promise.all(
		["One", "Two", "Three"].map((text) => call({ ...base, op: "reply", id, author: "operator", text })),
	);
	assert.ok(receipts.every((receipt) => receipt.ok));
	const saved = (await notes.request("read", { id })).note as Note;
	assert.deepEqual(saved.thread.map((item) => item.text).sort(), ["One", "Three", "Two"]);
});

test("linked Git worktrees share note identity and resolve moved lines separately", async (t) => {
	const { temp, dir, root } = await fixture(t);
	const linked = join(temp, "linked");
	const git = (...args: string[]) =>
		execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
			cwd: root,
			encoding: "utf8",
			timeout: 5000,
			env: {
				...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
			},
		}).trim();
	git("init", "--template=", "-b", "main");
	git("add", example.path);
	git("-c", "user.name=Explorer", "-c", "user.email=explorer@example.test", "commit", "-m", "Add source");
	git("worktree", "add", "--detach", linked, "HEAD");
	const repo = await resolveRepository(root);
	const source = new NotesStore(dir, repo);
	const { note } = (await source.request("create", {
		note: { ...example, commit: repo.head },
	})) as { note: Note };
	await writeFile(join(linked, example.path), "new\nintro\ntarget\nend\ntarget\n");
	const alternate = new NotesStore(dir, await resolveRepository(linked));
	const moved = lineNote((await alternate.request("read", { id: note.id })).note as Note);
	assert.deepEqual([moved.location, moved.start, moved.movedFrom], ["moved", 3, 2]);
	assert.equal(lineNote((await source.request("read", { id: note.id })).note as Note).location, "same");
});
