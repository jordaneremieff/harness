import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	isRelativePath,
	readAnchor,
	resolveAnchor,
	resolveRepository,
	resolveScope,
	resolveTarget,
	validScope,
} from "./repository.ts";

test("plain folders resolve exact, moved and ambiguous code quotes", { timeout: 10000 }, async () => {
	const temp = await mkdtemp(join(tmpdir(), "explorer-anchors-"));
	try {
		const root = join(temp, "repo");
		await mkdir(root);
		const file = join(root, "file name.txt");
		await writeFile(file, "one\r\n two\r\nthree\r\n");
		const found = await resolveTarget(file, temp);
		assert.equal(found.repo.kind, "folder");
		assert.equal(found.repo.identity, await realpath(root));
		assert.equal(found.path, "file name.txt");
		const anchor = await readAnchor(found.repo, found.path, 2, 3);
		assert.deepEqual(anchor, { start: 2, end: 3, commit: null, quote: " two\nthree" });
		assert.deepEqual(await resolveAnchor(found.repo, found.path, anchor), { start: 2, end: 3, location: "same" });
		await writeFile(file, "insert\none\n two\nthree\n");
		assert.deepEqual(await resolveAnchor(found.repo, found.path, anchor), {
			start: 3,
			end: 4,
			location: "moved",
			movedFrom: 2,
		});
		await writeFile(file, "insert\none\n two\nthree\n two\nthree\n");
		assert.deepEqual(await resolveAnchor(found.repo, found.path, anchor), { start: 2, end: 3, location: "outdated" });
		const outside = join(temp, "outside.txt");
		await writeFile(outside, "two\n");
		await symlink(outside, join(root, "escape"));
		await assert.rejects(readAnchor(found.repo, "escape", 1, 1), /outside/u);
		await assert.rejects(readAnchor(found.repo, "../outside.txt", 1, 1), /relative/u);
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
});

test("Git scopes resolve to commits and the selected path stays relative to the work tree", {
	timeout: 10000,
}, async () => {
	const cwd = fileURLToPath(new URL("./", import.meta.url));
	const { repo, path } = await resolveTarget(undefined, cwd);
	assert.equal(repo.kind, "git");
	assert.equal(path, "extensions/explorer");
	const same = await resolveRepository(repo.root);
	assert.equal(same.identity, repo.identity);
	assert.ok(repo.head);
	const current = await resolveScope(repo, { kind: "commit", commit: "HEAD" });
	assert.equal(current.head, repo.head);
	assert.ok(current.base);
	const range = await resolveScope(repo, { kind: "range", base: "HEAD^", head: "HEAD" });
	assert.equal(range.key, current.key);
	const finished = await resolveScope(repo, { kind: "since-review" }, repo.head);
	assert.equal(finished.base, repo.head);
	assert.equal((await resolveScope(repo, { kind: "uncommitted" })).key, `worktree@${repo.head}`);
	await assert.rejects(resolveScope(repo, { kind: "commit", commit: "--help" }), /Invalid/u);
});

test("boundary paths and review shapes reject traversal and extra fields", () => {
	assert.equal(isRelativePath("dir/a:b.swift"), true);
	for (const path of ["", "../file", "a/../file", "/file", ".git/config", "d//f", "a\\b"])
		assert.equal(isRelativePath(path), false, path);
	assert.equal(validScope({ kind: "branch", base: "refs/heads/main" }), true);
	assert.equal(validScope({ kind: "since-review", commit: "HEAD" }), false);
});
