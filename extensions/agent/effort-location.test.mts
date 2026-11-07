import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createPrimaryLocationResolver } from "./effort-location.ts";

const REAL_GIT = execFileSync("which", ["git"], { encoding: "utf8" }).trim();

function workspace(t: { after(fn: () => void): void }) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "effort-location-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const bin = join(root, "bin");
	const log = join(root, "git-calls.log");
	mkdirSync(bin);
	writeFileSync(log, "");
	writeFileSync(join(bin, "git"), `#!/bin/sh\necho call >> '${log}'\nexec '${REAL_GIT}' "$@"\n`);
	chmodSync(join(bin, "git"), 0o755);
	const previous = process.env.PATH;
	process.env.PATH = `${bin}:${previous ?? ""}`;
	t.after(() => { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; });
	const work = join(root, "work");
	mkdirSync(work);
	return { root, work, calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean).length };
}
const git = (cwd: string, ...args: string[]) => execFileSync(REAL_GIT, args, { cwd, stdio: "ignore", timeout: 5000 });

it("answers repeated same-cwd reads inside a repository without another Git process", async (t) => {
	const { work, calls } = workspace(t);
	git(work, "init", "-q");
	const resolver = createPrimaryLocationResolver();
	const first = await resolver.resolve(work);
	assert.equal(first.repositoryState, "git");
	assert.equal(first.repository, realpathSync(join(work, ".git")));
	const spawned = calls();
	assert.ok(spawned >= 1);
	assert.deepEqual(await resolver.resolve(work), first);
	assert.deepEqual(await resolver.resolve(work), first);
	assert.equal(calls(), spawned);
});

it("caches an outside-Git result and notices a new repository at the same path", async (t) => {
	const { work, calls } = workspace(t);
	const resolver = createPrimaryLocationResolver();
	assert.equal((await resolver.resolve(work)).repositoryState, "outside-git");
	const spawned = calls();
	assert.equal((await resolver.resolve(work)).repositoryState, "outside-git");
	assert.equal(calls(), spawned);
	git(work, "init", "-q");
	const created = await resolver.resolve(work);
	assert.equal(created.repositoryState, "git");
	assert.equal(calls(), spawned + 1);
});

it("notices a nested repository created below a cached ancestor repository", async (t) => {
	const { work } = workspace(t);
	git(work, "init", "-q");
	const nested = join(work, "nested");
	mkdirSync(nested);
	const resolver = createPrimaryLocationResolver();
	const outer = await resolver.resolve(nested);
	assert.equal(outer.repository, realpathSync(join(work, ".git")));
	git(nested, "init", "-q");
	assert.equal((await resolver.resolve(nested)).repository, realpathSync(join(nested, ".git")));
});

it("notices removal of the repository marker and replacement of a worktree pointer", async (t) => {
	const { root, work } = workspace(t);
	git(work, "init", "-q");
	git(work, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "initial");
	const linked = join(root, "linked");
	git(work, "worktree", "add", "-q", "-b", "side", linked);
	const resolver = createPrimaryLocationResolver();
	const main = await resolver.resolve(linked);
	assert.equal(main.repository, realpathSync(join(work, ".git")));
	const other = join(root, "other");
	mkdirSync(other);
	git(other, "init", "-q");
	rmSync(join(linked, ".git"));
	writeFileSync(join(linked, ".git"), `gitdir: ${join(other, ".git")}\n`);
	const replaced = await resolver.resolve(linked);
	assert.notEqual(replaced.repository, main.repository);
	rmSync(join(linked, ".git"));
	assert.equal((await resolver.resolve(linked)).repositoryState, "outside-git");
});

it("shares one in-flight resolution per cwd and never retains an unknown result", async (t) => {
	const { work, calls } = workspace(t);
	git(work, "init", "-q");
	const resolver = createPrimaryLocationResolver();
	const [a, b, c] = await Promise.all([resolver.resolve(work), resolver.resolve(work), resolver.resolve(work)]);
	assert.deepEqual(a, b);
	assert.deepEqual(b, c);
	assert.equal(calls(), 1);
	const missing = join(work, "absent");
	const spawned = calls();
	assert.equal((await resolver.resolve(missing)).repositoryState, "unknown");
	assert.equal((await resolver.resolve(missing)).repositoryState, "unknown");
	assert.equal(calls(), spawned, "a missing path launches no Git process and is not retained");
});

it("does not retain a failed Git discovery", async (t) => {
	const { work, calls } = workspace(t);
	const resolver = createPrimaryLocationResolver();
	const path = process.env.PATH;
	process.env.PATH = "";
	try { assert.equal((await resolver.resolve(work)).repositoryState, "unknown"); }
	finally { process.env.PATH = path; }
	const after = await resolver.resolve(work);
	assert.equal(after.repositoryState, "outside-git");
	assert.equal(calls(), 1);
});

it("revalidates when the Git environment or PATH changes", async (t) => {
	const { work, calls } = workspace(t);
	git(work, "init", "-q");
	const resolver = createPrimaryLocationResolver();
	await resolver.resolve(work);
	const spawned = calls();
	const previous = process.env.GIT_CEILING_DIRECTORIES;
	process.env.GIT_CEILING_DIRECTORIES = tmpdir();
	t.after(() => { if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = previous; });
	await resolver.resolve(work);
	assert.equal(calls(), spawned + 1);
});

it("invalidates one cwd or every cwd on request and bounds completed entries", async (t) => {
	const { root, work, calls } = workspace(t);
	const resolver = createPrimaryLocationResolver();
	await resolver.resolve(work);
	let spawned = calls();
	resolver.invalidate(work);
	await resolver.resolve(work);
	assert.equal(calls(), spawned + 1);
	spawned = calls();
	resolver.clear();
	await resolver.resolve(work);
	assert.equal(calls(), spawned + 1);
	const directories = Array.from({ length: 34 }, (_, index) => {
		const directory = join(root, `dir-${index}`);
		mkdirSync(directory);
		return directory;
	});
	for (const directory of directories) await resolver.resolve(directory);
	spawned = calls();
	await resolver.resolve(directories[0] as string);
	assert.equal(calls(), spawned + 1, "the oldest completed location was evicted");
	await resolver.resolve(directories[33] as string);
	assert.equal(calls(), spawned + 1, "recent completed locations are retained");
});

it("returns independent location objects", async (t) => {
	const { work } = workspace(t);
	const resolver = createPrimaryLocationResolver();
	const first = await resolver.resolve(work);
	Reflect.set(first, "cwd", "/changed");
	assert.equal((await resolver.resolve(work)).cwd, work);
});
