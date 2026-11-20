import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import { type CreateNote, type Note, NotesStore, recentRoots, type Tour } from "./notes-store.ts";
import { resolveRepository } from "./repository.ts";

const helper = fileURLToPath(new URL("./notes-helper.ts", import.meta.url));
const example: CreateNote = {
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
	const add = async (patch: Partial<CreateNote> = {}) =>
		(await notes.request("create", { note: { ...example, ...patch } })).note as Note;
	return { temp, dir, root, repoDir, repo, notes, record, add };
}

function envelope(input: Buffer | string) {
	const child = spawnSync(process.execPath, [helper], { input, encoding: "utf8", timeout: 10_000 });
	assert.ifError(child.error);
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout);
}

function call(request: Record<string, unknown>): Promise<{ ok: boolean; note: Note }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [helper], { timeout: 10_000, stdio: ["pipe", "pipe", "inherit"] });
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
	assert.deepEqual(await notes.request("list"), { notes: [], tours: [], unreadable: 0, truncated: false });
	await assert.rejects(stat(dir), { code: "ENOENT" });
	const note = await add();
	assert.match(note.id, /^n-[0-9a-f]{20}$/);
	assert.equal(note.location, "same");
	assert.deepEqual(note.anchor, { start: 2, end: 2, commit: null, quote: "target" });
	const source = JSON.parse(await readFile(record(note.id), "utf8"));
	for (const key of ["start", "end", "location", "movedFrom"]) assert.equal(Object.hasOwn(source, key), false);
	for (const file of [dir, join(dir, "repos"), repoDir, join(repoDir, "notes")])
		assert.equal((await stat(file)).mode & 0o777, 0o700);
	for (const file of [join(dir, "store.json"), join(repoDir, "repo.json"), record(note.id)])
		assert.equal((await stat(file)).mode & 0o777, 0o600);
	await writeFile(join(root, example.path), "intro\nnew\ntarget\nend\n");
	const moved = (await notes.request("list", { path: example.path })).notes as Note[];
	assert.deepEqual(
		moved.map(({ id, start, end, location, movedFrom }) => ({ id, start, end, location, movedFrom })),
		[{ id: note.id, start: 3, end: 3, location: "moved", movedFrom: 2 }],
	);
	await writeFile(join(root, example.path), "intro\nnew\ntarget\ntarget\n");
	const outdated = (await notes.request("read", { id: note.id })).note as Note;
	assert.equal(outdated.location, "outdated");
	assert.deepEqual(outdated.anchor, note.anchor);
	assert.deepEqual((await notes.request("list", { path: "elsewhere" })).notes, []);
	assert.deepEqual(await readdir(join(repoDir, "notes")), [`${note.id}.json`]);
});

test("note writes enforce edit rules and validate all state members before publication", async (t) => {
	const { notes, add } = await fixture(t);
	const { id } = await add();
	const agent = await add({ author: "agent", state: "open" });
	assert.equal(((await notes.request("update", { id, text: "Updated" })).note as Note).text, "Updated");
	await assert.rejects(notes.request("delete", { id: agent.id }), { code: "conflict" });
	await assert.rejects(notes.request("state", { ids: [id, missingId], state: "sent" }), { code: "not-found" });
	assert.equal(((await notes.request("read", { id })).note as Note).state, "draft");
	const changed = (await notes.request("state", { ids: [id], state: "sent", requestId: "request-1" })).notes as Note[];
	assert.deepEqual(
		changed.map((note) => [note.state, note.requestId]),
		[["sent", "request-1"]],
	);
	await assert.rejects(notes.request("update", { id, text: "Refuse" }), { code: "conflict" });
	const replied = (await notes.request("reply", { id, author: "agent", text: "Answer" })).note as Note;
	assert.deepEqual(
		replied.thread.map((row) => [row.author, row.text]),
		[["agent", "Answer"]],
	);
	assert.equal(replied.requestId, "request-1");
	await notes.request("state", { ids: [id, agent.id], state: "resolved" });
	await notes.request("state", { ids: [id, agent.id], state: "answered" });
	await notes.request("delete", { id });
	await assert.rejects(notes.request("read", { id }), { code: "not-found" });
	for (const patch of [
		{ path: "../outside" },
		{ start: 3 },
		{ commit: "--not-a-hash" },
		{ text: " \t" },
		{ author: "unknown" },
	])
		await assert.rejects(notes.request("create", { note: { ...example, ...patch } }), { code: "invalid" });
});

test("walkthroughs preserve stop order and deletion preserves the notes", async (t) => {
	const { notes } = await fixture(t);
	const first = { ...example, author: "agent", state: "open" };
	const second = { ...first, text: "Another stop" };
	const scope = { kind: "branch", base: "main" };
	const { tour } = (await notes.request("tour-create", {
		title: "Read the change",
		scope,
		notes: [first, second],
	})) as { tour: Tour };
	assert.match(tour.id, /^t-[0-9a-f]{20}$/);
	assert.deepEqual(tour.scope, scope);
	const listed = await notes.request("list");
	assert.deepEqual(listed.tours, [tour]);
	const stops = (listed.notes as Note[]).sort((a, b) => (a.tour?.order ?? 0) - (b.tour?.order ?? 0));
	assert.deepEqual(
		stops.map((note) => [note.id, note.tour]),
		tour.stops.map((id, index) => [id, { id: tour.id, order: index + 1 }]),
	);
	await notes.request("tour-delete", { id: tour.id });
	const after = await notes.request("list");
	assert.deepEqual(after.tours, []);
	assert.deepEqual((after.notes as Note[]).map((note) => note.id).sort(), [...tour.stops].sort());
	assert.ok((after.notes as Note[]).every((note) => note.tour === undefined));
});

test("review state and recents remain separate from note records", async (t) => {
	const { notes, dir, repo, repoDir, temp } = await fixture(t);
	const head = "a".repeat(40);
	const key = `empty..${head}`;
	assert.deepEqual(await notes.request("review-get", { key }), { viewed: [] });
	assert.deepEqual(await notes.request("marker", { branch: "__proto__" }), { head: null });
	const review = await notes.request("review-set", {
		key,
		viewed: ["code.ts", "code.ts"],
		finished: true,
		head,
		branch: "__proto__",
	});
	assert.deepEqual(review.viewed, ["code.ts"]);
	assert.deepEqual(await notes.request("review-get", { key }), review);
	assert.deepEqual(await notes.request("marker", { branch: "__proto__" }), { head });
	assert.deepEqual(await notes.request("review-set", { key: "worktree@empty", viewed: ["code.ts"], finished: true }), {
		viewed: ["code.ts"],
	});
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
	await assert.rejects(notes.request("update", { id: broken.id, text: "Do not repair" }), { code: "not-found" });
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
	const { note } = (await source.request("create", { note: { ...example, commit: repo.head } })) as { note: Note };
	await writeFile(join(linked, example.path), "new\nintro\ntarget\nend\ntarget\n");
	const alternate = new NotesStore(dir, await resolveRepository(linked));
	const moved = (await alternate.request("read", { id: note.id })).note as Note;
	assert.deepEqual([moved.location, moved.start, moved.movedFrom], ["moved", 3, 2]);
	assert.equal(((await source.request("read", { id: note.id })).note as Note).location, "same");
});
