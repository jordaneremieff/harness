import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = stripTypeScriptTypes(readFileSync(new URL("./file-tree.ts", import.meta.url), "utf8"));
const window = { explorer: {} } as Window;
runInNewContext(source, { window, setTimeout, clearTimeout, Error });

const folder = (name: string, annotations?: Pick<ExplorerFolderEntry, "repo" | "ignored">): ExplorerFolderEntry => ({
	name,
	kind: "folder",
	...annotations,
});
const file = (name: string, ignored?: true): ExplorerFolderEntry => ({ name, kind: "file", ignored });
const reply = (...entries: ExplorerFolderEntry[]) => ({ entries, truncated: false });
const summary = (tree: ExplorerTree) =>
	Array.from(tree.rows(), (row) => [row.depth, row.kind === "entry" ? row.entry.path : row.message]);

test("the root and expanded folders load once and keep host order, depth and annotations", async () => {
	const requested: string[] = [];
	const stamp = { branch: "topic", head: null };
	const tree = window.explorer.fileTree(
		async (path) => {
			requested.push(path);
			if (!path) return reply(folder("repo10", { repo: stamp }), folder("repo2"), file("readme"));
			if (path === "repo10") return reply(folder("ignored", { ignored: true }), file("work"));
			return reply(file("inside", true));
		},
		() => {},
	);
	assert.equal(tree.load(""), tree.load(""));
	await tree.load("");
	assert.deepEqual(requested, [""]);
	assert.deepEqual(summary(tree), [
		[0, "repo10"],
		[0, "repo2"],
		[0, "readme"],
	]);
	assert.equal(tree.setExpanded("repo10", true), tree.load("repo10"));
	await tree.load("repo10");
	assert.deepEqual(requested, ["", "repo10"]);
	assert.deepEqual(summary(tree), [
		[0, "repo10"],
		[1, "repo10/ignored"],
		[1, "repo10/work"],
		[0, "repo2"],
		[0, "readme"],
	]);
	assert.equal(Array.from(tree.entries()).find((entry) => entry.name === "repo10")?.repo, stamp);
	assert.equal(Array.from(tree.entries()).find((entry) => entry.name === "ignored")?.ignored, true);
	await tree.reveal("repo10/ignored");
	assert.deepEqual(requested, ["", "repo10", "repo10/ignored"]);
	assert.deepEqual(summary(tree).slice(0, 3), [
		[0, "repo10"],
		[1, "repo10/ignored"],
		[2, "repo10/ignored/inside"],
	]);
	await tree.setExpanded("repo10", false);
	assert.equal(tree.rows().length, 3);
	assert.ok(Array.from(tree.entries()).some((entry) => entry.path === "repo10/ignored/inside" && entry.ignored));
});

test("changes refresh only affected loaded parents and delay collapsed folder refresh", async () => {
	const requested: string[] = [];
	let children = [folder("used"), folder("other"), folder("untouched")];
	const tree = window.explorer.fileTree(
		async (path) => {
			requested.push(path);
			return path ? reply(file("file")) : reply(...children);
		},
		() => {},
	);
	await tree.load("");
	for (const name of children.map((entry) => entry.name)) await tree.setExpanded(name, true);
	await tree.setExpanded("other", false);
	requested.length = 0;
	tree.invalidate(["used/added", "other/renamed", "unseen/added"]);
	await tree.load("used");
	assert.deepEqual(requested, ["used"]);
	await tree.setExpanded("other", true);
	assert.deepEqual(requested, ["used", "other"]);
	requested.length = 0;
	await tree.setExpanded("other", false);
	tree.invalidate(null);
	await Promise.all([tree.load(""), tree.load("used"), tree.load("untouched")]);
	assert.deepEqual(requested, ["", "used", "untouched"]);
	children = children.filter((child) => child.name !== "used");
	tree.invalidate(["used"]);
	await tree.load("");
	assert.equal(tree.isExpanded("used"), false);
	assert.equal(
		Array.from(tree.entries()).some((entry) => entry.path === "used/file"),
		false,
	);
});

test("changes during an in-flight listing refresh afterward without overlapping reads", async () => {
	const readers: ((data: ReturnType<typeof reply>) => void)[] = [];
	const tree = window.explorer.fileTree(
		() => new Promise((resolve) => readers.push(resolve)),
		() => {},
	);
	const root = tree.load("");
	await Promise.resolve();
	tree.invalidate(["new"]);
	assert.equal(tree.load(""), root);
	assert.equal(readers.length, 1);
	readers[0](reply(file("old")));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(readers.length, 2);
	readers[1](reply(file("new")));
	await root;
	assert.deepEqual(summary(tree), [[0, "new"]]);
});

test("reset discards late folder replies and stops old reveals", async () => {
	const requested: string[] = [];
	const readers: ((data: ReturnType<typeof reply>) => void)[] = [];
	const tree = window.explorer.fileTree(
		(path) => {
			requested.push(path);
			return new Promise((resolve) => readers.push(resolve));
		},
		() => {},
	);
	const old = tree.reveal("old/child");
	await Promise.resolve();
	tree.reset();
	const current = tree.load("");
	await Promise.resolve();
	readers[1](reply(file("fresh")));
	await current;
	readers[0](reply(folder("old")));
	await old;
	assert.deepEqual(requested, ["", ""]);
	assert.deepEqual(summary(tree), [[0, "fresh"]]);
});

test("one flatten reaches every row of a large expanded tree", async (context) => {
	const groups = Array.from({ length: 10 }, (_, i) => folder(`bucket-${i}`));
	const files = Array.from({ length: 10_000 }, (_, i) => file(`file-${i}.txt`));
	const tree = window.explorer.fileTree(
		async (path) => (path ? reply(...files) : reply(...groups)),
		() => {},
	);
	await tree.load("");
	for (const group of groups) await tree.setExpanded(group.name, true);
	const start = performance.now();
	const rows = tree.rows();
	const duration = performance.now() - start;
	context.diagnostic(`${rows.length} rows flattened in ${duration.toFixed(2)} ms (cached folder reads, cold flatten)`);
	assert.equal(rows.length, 100_010);
	assert.equal(tree.rows(), rows);
	const last = rows.at(-1);
	assert.ok(last?.kind === "entry");
	assert.equal(last.entry.path, "bucket-9/file-9999.txt");
	assert.ok(duration < 500, "flatten must not perform tree-wide work per visible row");
});

test("reveal reads a listing again when a folder appeared after it was read", async () => {
	const requested: string[] = [];
	let rootEntries = [folder("existing")];
	const tree = window.explorer.fileTree(
		async (path) => {
			requested.push(path);
			if (!path) return reply(...rootEntries);
			return reply(file("todo.md"));
		},
		() => {},
	);
	await tree.load("");
	rootEntries = [folder("created"), folder("existing")];
	await tree.reveal("created");
	assert.deepEqual(requested, ["", "", "created"]);
	assert.deepEqual(summary(tree), [
		[0, "created"],
		[1, "created/todo.md"],
		[0, "existing"],
	]);
	await tree.reveal("missing");
	assert.deepEqual(requested, ["", "", "created", ""]);
});
