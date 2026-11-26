import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { browse } from "./browse.ts";

async function fixture(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
	const path = await realpath(await mkdtemp(join(tmpdir(), "editor-browse-")));
	t.after(() => rm(path, { recursive: true, force: true }));
	return path;
}

function git(root: string, ...args: string[]): void {
	execFileSync("/usr/bin/git", args, {
		cwd: root,
		env: { PATH: "/usr/bin:/bin", HOME: "/var/empty", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
		timeout: 5000,
	});
}

async function repo(root: string, branch: string, tracked = "tracked.txt"): Promise<void> {
	git(root, "init", "-q", "-b", branch);
	await writeFile(join(root, tracked), "original\n");
	git(root, "add", "--", tracked);
	git(root, "-c", "user.name=Tester", "-c", "user.email=test@example.invalid", "commit", "-qm", "Initial");
}

test("directory pages list immediate children without reading protected folders or symlinks", async (t) => {
	const outer = await fixture(t);
	const root = join(outer, "root");
	await mkdir(join(root, "docs"), { recursive: true });
	await mkdir(join(root, ".git"));
	await writeFile(join(root, "docs", "only-child.txt"), "child");
	await writeFile(join(outer, "outside.txt"), "outside");
	await symlink(outer, join(root, "outside"));
	await symlink(join(outer, "outside.txt"), join(root, "outside.txt"));
	await Promise.all(Array.from({ length: 173 }, (_, i) => writeFile(join(root, `item-${i}.txt`), "")));

	const first = await browse(root, { op: "tree" });
	assert.equal((first.entries as unknown[]).length, 160);
	assert.equal(typeof first.next, "number");
	const second = await browse(root, { op: "tree", offset: first.next });
	assert.equal(second.next, null);
	const all = [...(first.entries as { path: string }[]), ...(second.entries as { path: string }[])].map(
		({ path }) => path,
	);
	assert.equal(new Set(all).size, 174);
	assert.ok(all.includes("docs"));
	assert.ok(all.every((path) => !path.includes("/") && !path.includes(".git") && !path.includes("outside")));
	assert.deepEqual(await browse(root, { op: "tree", path: "docs" }), {
		entries: [{ path: "docs/only-child.txt", name: "only-child.txt", dir: false }],
		next: null,
	});
	for (const path of ["..", "/etc", ".GIT", "outside", "docs/../outside"]) {
		await assert.rejects(browse(root, { op: "tree", path }));
	}
});

test("search matches relative paths and literal text and does not read protected or external content", async (t) => {
	const outer = await fixture(t);
	const root = join(outer, "root");
	await mkdir(join(root, "repo-a", ".git"), { recursive: true });
	await mkdir(join(root, "repo-b", "source"), { recursive: true });
	await writeFile(join(root, "repo-a", ".git", "hidden.txt"), "[a.b]* secret\n");
	await writeFile(join(root, "repo-a", "sample.txt"), "discard\r[a.b]* hit\r\n[A.B]* wrong case\rsecond [a.b]* hit\n");
	await writeFile(join(root, "repo-b", "source", "sample.txt"), "discard\n");
	await writeFile(join(root, "repo-b", "binary"), "\0[a.b]* binary\n");
	await writeFile(join(outer, "external.txt"), "[a.b]* outside\n");
	await symlink(join(outer, "external.txt"), join(root, "repo-a", "external.txt"));
	await symlink(outer, join(root, "repo-a", "external"));

	assert.deepEqual(await browse(root, { op: "search", kind: "paths", query: "B/SOURCE/SAM" }), {
		hits: [{ path: "repo-b/source/sample.txt" }],
		limited: false,
	});
	const found = await browse(root, { op: "search", kind: "text", query: "[a.b]*" });
	assert.equal(found.limited, false);
	assert.deepEqual(
		(found.hits as { path: string; line: number; column: number; length: number; text: string }[]).map(
			({ path, line, column, length, text }) => ({ path, line, column, length, text }),
		),
		[
			{ path: "repo-a/sample.txt", line: 2, column: 0, length: 6, text: "[a.b]* hit" },
			{ path: "repo-a/sample.txt", line: 4, column: 7, length: 6, text: "second [a.b]* hit" },
		],
	);
});

test("search yields to other work, rejects cancellation, and marks capped results as partial", async (t) => {
	const root = await fixture(t);
	await writeFile(join(root, "many.txt"), "hit\n".repeat(350));
	await writeFile(join(root, "wide.txt"), "x".repeat(2 * 1024 * 1024 + 1));
	const bounded = await browse(root, { op: "search", kind: "text", query: "hit" });
	assert.equal(bounded.limited, true);
	assert.equal((bounded.hits as unknown[]).length, 150);
	assert.deepEqual(await browse(root, { op: "search", kind: "text", query: "no match" }), { hits: [], limited: true });
	await Promise.all(Array.from({ length: 170 }, (_, i) => writeFile(join(root, `item-${i}.txt`), "")));
	const paths = await browse(root, { op: "search", kind: "paths", query: ".txt" });
	assert.equal(paths.limited, true);
	assert.equal((paths.hits as unknown[]).length, 150);
	const stop = new AbortController();
	let settled = false;
	const search = browse(root, { op: "search", kind: "text", query: "not present" }, stop.signal).finally(() => {
		settled = true;
	});
	const rejected = assert.rejects(search, { name: "AbortError" });
	await setImmediate();
	assert.equal(settled, false);
	stop.abort();
	await rejected;
});

test("Git reports the root and nearest nested repository without refreshing the index", async (t) => {
	const root = await fixture(t);
	const nested = join(root, "nested");
	await mkdir(join(nested, "lib"), { recursive: true });
	await repo(root, "outer");
	await repo(nested, "inner", "lib/special[1].txt");
	await writeFile(join(root, "tracked.txt"), "outer change\n");
	await writeFile(join(nested, "lib", "special[1].txt"), "inner change\n");
	await writeFile(join(nested, "lib", "special1.txt"), "not the selected path\n");
	const index = join(nested, ".git", "index");
	const original = await readFile(index);
	const before = await stat(index, { bigint: true });
	const outer = await browse(root, { op: "git" });
	assert.equal(outer.branch, "outer");
	assert.ok((outer.files as { path: string }[]).some(({ path }) => path === "tracked.txt"));
	const child = await browse(root, { op: "git", doc: "nested/lib/special[1].txt" });
	assert.equal(child.branch, "inner");
	assert.equal(child.limited, false);
	assert.deepEqual(child.files, [
		{ path: "nested/lib/special[1].txt", status: " M" },
		{ path: "nested/lib/special1.txt", status: "??" },
	]);
	assert.match(String(child.diff), /--- a\/lib\/special\[1\]\.txt\n\+\+\+ b\/lib\/special\[1\]\.txt\n/);
	assert.match(String(child.diff), /-original\n\+inner change/);
	assert.doesNotMatch(String(child.diff), /not the selected path|outer change/);
	assert.deepEqual(await readFile(index), original);
	assert.equal((await stat(index, { bigint: true })).mtimeNs, before.mtimeNs);
	assert.equal(await readFile(join(nested, "lib", "special[1].txt"), "utf8"), "inner change\n");

	const untracked = await browse(root, { op: "git", doc: "nested/lib/special1.txt" });
	assert.match(String(untracked.diff), /--- \/dev\/null\n/);
	assert.match(String(untracked.diff), /\+not the selected path/);
	await unlink(join(root, "tracked.txt"));
	const deleted = await browse(root, { op: "git", doc: "tracked.txt" });
	assert.match(String(deleted.diff), /deleted file mode/);
});

test("Git does not discover a parent outside the folder and refuses external metadata", async (t) => {
	const outer = await fixture(t);
	await repo(outer, "outer");
	const root = join(outer, "folder");
	await mkdir(root);
	await writeFile(join(root, "actual.txt"), "data\n");
	const none = { branch: "", files: [], limited: false, repo: false };
	assert.deepEqual(await browse(root, { op: "git" }), none);
	assert.deepEqual(await browse(root, { op: "git", doc: "actual.txt" }), none);
	await assert.rejects(browse(root, { op: "git", doc: "../tracked.txt" }));
	await symlink(join(outer, "tracked.txt"), join(root, "linked.txt"));
	await assert.rejects(browse(root, { op: "git", doc: "linked.txt" }), /without symlinks/);
	await writeFile(join(root, ".git"), "gitdir: ../.git\n");
	await assert.rejects(browse(root, { op: "git" }), /outside the selected folder/);
	await mkdir(join(root, "inner"));
	await repo(join(root, "inner"), "inside");
	assert.equal((await browse(root, { op: "git", doc: "inner/tracked.txt" })).branch, "inside");
});

test("Git scopes a registered linked worktree even when shared metadata is outside the selected folder", async (t) => {
	const root = await fixture(t);
	const primary = join(root, "primary");
	const linked = join(root, "linked");
	await mkdir(primary);
	await repo(primary, "main");
	git(primary, "worktree", "add", "-q", "-b", "linked", linked);
	await writeFile(join(linked, "tracked.txt"), "linked worktree change\n");
	await writeFile(join(primary, "tracked.txt"), "private primary worktree change\n");
	await writeFile(join(primary, "only-primary.txt"), "private primary file\n");
	const inFolder = await browse(root, { op: "git", doc: "linked/tracked.txt" });
	assert.deepEqual(inFolder.files, [{ path: "linked/tracked.txt", status: " M" }]);

	const index = join(primary, ".git", "worktrees", "linked", "index");
	const originalIndex = await readFile(index);
	const indexTime = (await stat(index, { bigint: true })).mtimeNs;
	const status = await browse(linked, { op: "git" });
	const result = await browse(linked, { op: "git", doc: "tracked.txt" });
	assert.deepEqual(await readFile(index), originalIndex);
	assert.equal((await stat(index, { bigint: true })).mtimeNs, indexTime);
	assert.deepEqual(status, {
		repo: true,
		branch: "linked",
		files: [{ path: "tracked.txt", status: " M" }],
		limited: false,
	});
	assert.match(String(result.diff), /-original\n\+linked worktree change/);
	assert.doesNotMatch(String(result.diff), /private primary/);
	assert.deepEqual(await browse(linked, { op: "search", kind: "text", query: "private primary" }), {
		hits: [],
		limited: false,
	});
	await assert.rejects(browse(linked, { op: "git", doc: "../primary/only-primary.txt" }));

	const config = join(primary, ".git", "config");
	const base = await readFile(config, "utf8");
	await writeFile(config, `${base}\n[include]\n\tpath = ../only-primary.txt\n`);
	await assert.rejects(browse(linked, { op: "git" }), /Operation not permitted/);
});

test("Git validates both registered pointers in a relative linked worktree", async (t) => {
	const root = await fixture(t);
	const primary = join(root, "primary");
	const linked = join(root, "linked");
	await mkdir(primary);
	await repo(primary, "main");
	git(primary, "worktree", "add", "-q", "--relative-paths", "-b", "linked", linked);
	await writeFile(join(linked, "tracked.txt"), "relative linked change\n");
	const result = await browse(linked, { op: "git", doc: "tracked.txt" });
	assert.equal(result.branch, "linked");
	assert.match(String(result.diff), /\+relative linked change/);

	const metadata = join(primary, ".git", "worktrees", "linked");
	const backlink = join(metadata, "gitdir");
	const original = await readFile(backlink, "utf8");
	await writeFile(backlink, `${join(primary, ".git")}\n`);
	await assert.rejects(browse(linked, { op: "git" }), /not registered to this worktree/);
	await writeFile(backlink, original);
	const other = join(root, "other");
	await mkdir(other);
	await repo(other, "other");
	await writeFile(join(metadata, "commondir"), `${join(other, ".git")}\n`);
	await assert.rejects(browse(linked, { op: "git" }), /not registered to this worktree/);
});

test("Git in an unborn repository returns staged and untracked changes and reports a capped patch", async (t) => {
	const root = await fixture(t);
	git(root, "init", "-q", "-b", "unborn");
	await writeFile(join(root, "staged.txt"), "first\n");
	git(root, "add", "staged.txt");
	await writeFile(join(root, "staged.txt"), "second\n");
	const staged = await browse(root, { op: "git", doc: "staged.txt" });
	assert.equal(staged.branch, "unborn");
	assert.match(String(staged.diff), /\+first\n/);
	assert.match(String(staged.diff), /\+second\n/);

	await writeFile(join(root, "big.txt"), "ABCD0123456789\n".repeat(14000));
	const big = await browse(root, { op: "git", doc: "big.txt" });
	assert.equal(big.limited, true);
	assert.ok(Buffer.byteLength(String(big.diff)) <= 128 * 1024);
});

test("Git still diffs a selected untracked file past the status list cap", async (t) => {
	const root = await fixture(t);
	await repo(root, "main");
	await Promise.all(Array.from({ length: 410 }, (_, i) => writeFile(join(root, `file-${i}`), "")));
	await writeFile(join(root, "z.txt"), "outside status page\n");
	const result = await browse(root, { op: "git", doc: "z.txt" });
	assert.equal(result.limited, true);
	assert.equal((result.files as unknown[]).length, 400);
	assert.match(String(result.diff), /\+outside status page/);
});

test("project files list only existing regular tracked and unignored paths", async (t) => {
	const root = await fixture(t);
	await repo(root, "main");
	await writeFile(join(root, ".gitignore"), "hidden*\n");
	await writeFile(join(root, "hidden-tracked"), "kept by the index");
	await writeFile(join(root, "hidden-untracked"), "ignored");
	await writeFile(join(root, "untracked"), "shown");
	await symlink("tracked.txt", join(root, "link"));
	git(root, "add", "-f", "--", "hidden-tracked", "link");
	await unlink(join(root, "tracked.txt"));
	const result = await browse(root, { op: "files" });
	assert.equal(result.limited, false);
	assert.deepEqual((result.files as string[]).sort(), [".gitignore", "hidden-tracked", "untracked"]);
});

test("project file walk skips dependency folders and symlinks outside Git", async (t) => {
	const root = await fixture(t);
	await mkdir(join(root, "src"));
	await mkdir(join(root, "node_modules"));
	await writeFile(join(root, "src/index.ts"), "export {};\n");
	await writeFile(join(root, "node_modules/internal"), "dependency");
	await symlink("src", join(root, "alias"));
	assert.deepEqual(await browse(root, { op: "files" }), { files: ["src/index.ts"], limited: false });
});

test("Git base reads a regular file from HEAD instead of disk or the index", async (t) => {
	const root = await fixture(t);
	await repo(root, "main");
	await mkdir(join(root, "sub"));
	await writeFile(join(root, "sub/base[1].txt"), "\uFEFFhead text\r\n");
	await writeFile(join(root, "large"), Buffer.alloc(2 * 1024 * 1024 + 1, "a"));
	await symlink("tracked.txt", join(root, "link"));
	git(root, "add", "--", "sub/base[1].txt", "large", "link");
	git(root, "-c", "user.name=Tester", "-c", "user.email=test@example.invalid", "commit", "-qm", "Base files");
	await writeFile(join(root, "sub/base[1].txt"), "index text\n");
	git(root, "add", "--", "sub/base[1].txt");
	await writeFile(join(root, "sub/base[1].txt"), "disk text\n");
	await unlink(join(root, "link"));
	assert.deepEqual(await browse(root, { op: "git", doc: "sub/base[1].txt", base: true }), {
		repo: true,
		tracked: true,
		limited: false,
		text: "head text\n",
	});
	assert.deepEqual(await browse(root, { op: "git", doc: "untracked", base: true }), {
		repo: true,
		tracked: false,
		limited: false,
	});
	assert.deepEqual(await browse(root, { op: "git", doc: "link", base: true }), {
		repo: true,
		tracked: false,
		limited: false,
	});
	assert.deepEqual(await browse(root, { op: "git", doc: "large", base: true }), {
		repo: true,
		tracked: true,
		limited: true,
	});
});

test("Git ignores project diff helpers and does not read an external config include", async (t) => {
	const outer = await fixture(t);
	const root = join(outer, "root");
	await mkdir(root);
	await repo(root, "main");
	const marker = join(outer, "unexpected");
	const helper = `touch '${marker}'`;
	const config = join(root, ".git", "config");
	const base = await readFile(config, "utf8");
	await writeFile(
		config,
		`${base}\n[core]\n\tfsmonitor = ${helper}\n[diff]\n\texternal = ${helper}\n[diff "viewer"]\n\ttextconv = ${helper}\n[filter "viewer"]\n\tclean = printf transformed\n`,
	);
	await writeFile(join(root, ".gitattributes"), "*.txt diff=viewer filter=viewer\n");
	await writeFile(join(root, "tracked.txt"), "plain patch\n");
	const result = await browse(root, { op: "git", doc: "tracked.txt" });
	assert.match(String(result.diff), /\+plain patch/);
	await assert.rejects(stat(marker), { code: "ENOENT" });

	await writeFile(join(outer, "external-config"), "[broken\n");
	await writeFile(config, `${base}\n[include]\n\tpath = ../../external-config\n`);
	await assert.rejects(browse(root, { op: "git" }), /Operation not permitted/);
});
