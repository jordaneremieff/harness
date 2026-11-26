import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test, type TestContext } from "node:test";
import { Workspace } from "./store.ts";
import type { Trash } from "./workspace-files.ts";

function fixture(t: TestContext, moveToTrash?: (path: string, destination: string) => void) {
	const dir = mkdtempSync(join(tmpdir(), "editor-file-actions-"));
	const project = join(dir, "project");
	const state = join(dir, "pi");
	const trash = join(dir, "trash");
	mkdirSync(project);
	mkdirSync(state);
	mkdirSync(trash);
	const sendToTrash: Trash = (path) => (moveToTrash ?? renameSync)(path, join(trash, basename(path)));
	const store = new Workspace(project, state, sendToTrash);
	const run = (op: string, fields: Record<string, unknown> = {}) => store.run({ op, ...fields }, "You");
	t.after(() => {
		store.close();
		rmSync(dir, { force: true, recursive: true });
	});
	return { root: store.root, trash, run };
}

test("folder rename moves open drafts and path anchors without publishing unsaved text", (t) => {
	const { root, run } = fixture(t);
	mkdirSync(join(root, "docs", "guide"), { recursive: true });
	writeFileSync(join(root, "docs/guide/start.txt"), "saved text\n");
	const read = run("read", { doc: "docs/guide/start.txt" });
	const edited = run("edit", { doc: read.doc, rev: read.rev, find: "saved", replace: "unsaved" });
	const range = run("note", { doc: read.doc, rev: edited.rev, start: 0, end: 7, text: "Use a better word" });
	const folder = run("note", { target: { kind: "folder", key: "docs/guide" }, text: "A folder note" });
	const tab = run("note", { target: { kind: "tab", key: read.doc }, text: "A tab note" });
	const newFile = run("new", { path: "docs/backlog.txt" });
	assert.deepEqual(run("rename", { from: "docs", to: "handbook" }), {
		from: "docs",
		to: "handbook",
		mapping: [
			{ from: newFile.doc, to: "handbook/backlog.txt" },
			{ from: read.doc, to: "handbook/guide/start.txt" },
		],
	});
	assert.equal(existsSync(join(root, "docs")), false);
	assert.equal(readFileSync(join(root, "handbook/guide/start.txt"), "utf8"), "saved text\n");
	assert.equal(run("read", { doc: "handbook/guide/start.txt" }).text, "unsaved text\n");
	assert.equal(run("thread", { id: range.id }).doc, "handbook/guide/start.txt");
	assert.deepEqual(run("thread", { id: folder.id }).target, { kind: "folder", key: "handbook/guide" });
	assert.deepEqual(run("thread", { id: tab.id }).target, { kind: "tab", key: "handbook/guide/start.txt" });
	assert.equal(run("read", { doc: "handbook/backlog.txt" }).dirty, true);
	assert.equal(run("save", { doc: "handbook/guide/start.txt", rev: edited.rev }).dirty, false);
});

test("remove sends the disk folder to Trash and retains unsaved text and discussion", (t) => {
	const { root, trash, run } = fixture(t);
	mkdirSync(join(root, "docs"));
	writeFileSync(join(root, "docs/clean"), "original");
	writeFileSync(join(root, "docs/dirty"), "original");
	const clean = run("read", { doc: "docs/clean" });
	const dirty = run("read", { doc: "docs/dirty" });
	const note = run("note", { doc: clean.doc, rev: clean.rev, start: 0, end: 8, text: "Keep this note" });
	const draft = run("edit", { doc: dirty.doc, rev: dirty.rev, find: "original", replace: "unsaved text" });
	assert.deepEqual(run("remove", { path: "docs" }), { path: "docs", kept: ["docs/dirty"] });
	assert.equal(readFileSync(join(trash, "docs/dirty"), "utf8"), "original");
	assert.deepEqual(
		(run("state").docs as { doc: string }[]).map(({ doc }) => doc),
		["docs/dirty"],
	);
	const retained = run("read", { doc: dirty.doc });
	assert.equal(retained.text, "unsaved text");
	assert.equal(retained.rev, draft.rev);
	assert.deepEqual(run("thread", { id: note.id }).target, { kind: "file", key: clean.doc });
	assert.deepEqual(run("mkdir", { path: "docs" }), { path: "docs" });
});

test("a failed Trash request leaves saved and unsaved drafts in place", (t) => {
	const { root, run } = fixture(t, () => {
		throw Error("Trash refused");
	});
	writeFileSync(join(root, "test"), "saved");
	const before = run("read", { doc: "test" });
	assert.throws(() => run("remove", { path: "test" }), /Trash refused/);
	assert.deepEqual(run("read", { doc: "test" }), before);
	assert.equal(readFileSync(join(root, "test"), "utf8"), "saved");
});

test("copy and mkdir never overwrite, and refuse symlinks, Git internals and project escape", (t) => {
	const { root, trash, run } = fixture(t);
	run("mkdir", { path: "from" });
	writeFileSync(join(root, "from/text"), "\uFEFFline\r\n");
	assert.deepEqual(run("copy", { from: "from", to: "copy" }), { path: "copy" });
	assert.equal(readFileSync(join(root, "copy/text"), "utf8"), "\uFEFFline\r\n");
	assert.throws(() => run("copy", { from: "from", to: "copy" }), { code: "conflict" });
	assert.throws(() => run("rename", { from: "from", to: "copy" }), { code: "conflict" });
	assert.throws(() => run("copy", { from: "from", to: "from/inside" }), { code: "invalid" });
	assert.throws(() => run("mkdir", { path: "../outside" }), { code: "invalid" });
	assert.throws(() => run("mkdir", { path: ".git" }), { code: "invalid" });
	symlinkSync(trash, join(root, "from/link"));
	for (const [op, fields] of [
		["copy", { from: "from", to: "bad" }],
		["rename", { from: "from", to: "bad" }],
		["remove", { path: "from" }],
		["mkdir", { path: "from/link/outside" }],
	] as const)
		assert.throws(() => run(op, fields), { code: "invalid" });
	assert.deepEqual(readdirSync(root).sort(), ["copy", "from"]);
});

test("a draft at the destination prevents a move before disk changes", (t) => {
	const { root, run } = fixture(t);
	writeFileSync(join(root, "old"), "original");
	run("new", { path: "new" });
	assert.throws(() => run("rename", { from: "old", to: "new" }), { code: "conflict" });
	assert.equal(readFileSync(join(root, "old"), "utf8"), "original");
	assert.equal(existsSync(join(root, "new")), false);
	assert.equal(run("read", { doc: "new" }).dirty, true);
});
