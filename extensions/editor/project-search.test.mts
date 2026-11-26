import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { projectReplace, projectSearch } from "./project-search.ts";
import { Workspace } from "./store.ts";

function fixture(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "editor-project-text-"));
	const root = join(dir, "project");
	const state = join(dir, "pi");
	mkdirSync(join(root, "src", "nested"), { recursive: true });
	mkdirSync(state);
	const store = new Workspace(root, state);
	const peer = new Workspace(root, state);
	t.after(() => {
		store.close();
		peer.close();
		rmSync(dir, { force: true, recursive: true });
	});
	return { store, peer, root: store.root };
}

test("project search takes shared draft text and reports UTF-16 match spans and context", async (t) => {
	const { root, store, peer } = fixture(t);
	const file = "src/nested/sample.ts";
	writeFileSync(join(root, file), "on disk\n");
	writeFileSync(join(root, "src/hidden.test.ts"), "Cat\n");
	writeFileSync(join(root, "companion.ts"), "cat\n");
	const read = store.run({ op: "read", doc: file }, "You");
	store.run(
		{ op: "edit", doc: file, rev: read.rev, find: "on disk", replace: "prior\n🙂 Cat catness CAT\nafter" },
		"You",
	);
	const draft = peer.run({ op: "new", path: "src/new.ts" }, "Peer");
	peer.run({ op: "patch", doc: draft.doc, rev: draft.rev, start: 0, end: 0, text: "Cat!" }, "Peer");
	const input = {
		query: "cat",
		caseSensitive: false,
		wholeWord: true,
		include: "src/**/*.ts, -*.test.ts",
		contextLines: 1,
	};
	const result = await projectSearch(root, input, undefined, peer);
	assert.equal(result.limited, false);
	assert.deepEqual(
		result.hits.map(({ path, draft, line, column, length, text, before, after }) => ({
			path,
			draft,
			line,
			column,
			length,
			text,
			before,
			after,
		})),
		[
			{ path: "src/new.ts", draft: true, line: 1, column: 0, length: 3, text: "Cat!", before: [], after: [] },
			{
				path: file,
				draft: true,
				line: 2,
				column: 3,
				length: 3,
				text: "🙂 Cat catness CAT",
				before: ["prior"],
				after: ["after"],
			},
			{
				path: file,
				draft: true,
				line: 2,
				column: 15,
				length: 3,
				text: "🙂 Cat catness CAT",
				before: ["prior"],
				after: ["after"],
			},
		],
	);
	assert.deepEqual(
		(
			await projectSearch(
				root,
				{ ...input, regex: true, query: "^after\\n", exclude: "new.ts, **/new.ts" },
				undefined,
				peer,
			)
		).hits.map(({ line, length }) => [line, length]),
		[[3, 6]],
	);
	assert.deepEqual((await projectSearch(root, { query: "on disk" }, undefined, peer)).hits, []);
	await assert.rejects(projectSearch(root, { query: "[", regex: true }, undefined, peer), {
		code: "invalid",
		message: /regular expression/i,
	});
});

test("replace expands regex groups only in regex mode and writes drafts, not disk", async (t) => {
	const { root, store, peer } = fixture(t);
	const path = "src/sample.ts";
	writeFileSync(join(root, path), "\uFEFFcat1 cat2\r\n");
	const result = await projectReplace(store, {
		query: "cat(\\d)",
		regex: true,
		replacement: "dog$1",
		paths: [path, "missing", path],
	});
	assert.deepEqual(result.changed, [{ doc: path, rev: 1, count: 2 }]);
	assert.deepEqual(
		result.skipped.map(({ path, code }) => [path, code]),
		[["missing", "not_found"]],
	);
	assert.equal(result.limited, false);
	assert.equal(readFileSync(join(root, path), "utf8"), "\uFEFFcat1 cat2\r\n");
	const second = await projectReplace(peer, { query: "dog1", replacement: "$1", paths: [path] });
	assert.deepEqual(second.changed, [{ doc: path, rev: 2, count: 1 }]);
	assert.equal(store.run({ op: "read", doc: path }, "You").text, "$1 dog2\n");
});

test("a stale replacement cannot overwrite a peer edit or a changed disk file", (t) => {
	const { root, store, peer } = fixture(t);
	writeFileSync(join(root, "file"), "before");
	const disk = store.projectText("file");
	writeFileSync(join(root, "file"), "outside the editor");
	assert.throws(() => store.replaceProjectText(disk, "wrong"), { code: "conflict" });
	const row = store.run({ op: "read", doc: "file" }, "You");
	const snapshot = store.projectText("file");
	peer.run({ op: "edit", doc: "file", rev: row.rev, find: "outside", replace: "inside" }, "Peer");
	assert.throws(() => store.replaceProjectText(snapshot, "wrong"), { code: "conflict" });
	assert.equal(store.run({ op: "read", doc: "file" }, "You").text, "inside the editor");
});

test("revert rereads disk, requires the current revision, and refreshes the saved encoding", (t) => {
	const { root, store } = fixture(t);
	const path = join(root, "file");
	writeFileSync(path, "first\n");
	const row = store.run({ op: "read", doc: "file" }, "You");
	const edit = store.run({ op: "edit", doc: "file", rev: row.rev, find: "first", replace: "unsaved" }, "You");
	writeFileSync(path, "\uFEFFnew on disk\r\n");
	assert.throws(() => store.run({ op: "revert", doc: "file", rev: row.rev }, "You"), { code: "conflict" });
	const reverted = store.run({ op: "revert", doc: "file", rev: edit.rev }, "You");
	assert.deepEqual(reverted, { doc: "file", title: "file", rev: 3, dirty: false, text: "new on disk\n" });
	const changed = store.run({ op: "edit", doc: "file", rev: reverted.rev, find: "new", replace: "saved" }, "You");
	store.run({ op: "save", doc: "file", rev: changed.rev }, "You");
	assert.equal(readFileSync(path, "utf8"), "\uFEFFsaved on disk\r\n");
});

test("an expensive regex stops without a replacement and does not block other pane work", async (t) => {
	const { root, store } = fixture(t);
	writeFileSync(join(root, "slow"), `${"a".repeat(40)}!`);
	const result = await projectReplace(store, {
		query: "^(a+)+$",
		regex: true,
		replacement: "changed",
		paths: ["slow"],
	});
	assert.equal(result.limited, true);
	assert.deepEqual(result.changed, []);
	assert.equal(result.skipped[0].code, "limit");
	assert.equal(store.projectText("slow").draft, false);
});
