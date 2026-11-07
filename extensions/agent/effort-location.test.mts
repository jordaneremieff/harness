import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
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
	return { root, work, bin, log, calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean).length };
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

it("notices a common-directory pointer added, changed and removed in an ordinary repository", async (t) => {
	const { root, work, calls } = workspace(t);
	git(work, "init", "-q");
	const resolver = createPrimaryLocationResolver();
	const gitDirectory = realpathSync(join(work, ".git"));
	const repository = (name: string) => {
		const directory = join(root, name);
		mkdirSync(directory);
		git(directory, "init", "-q");
		return directory;
	};
	const first = repository("first");
	const second = repository("second");
	assert.equal((await resolver.resolve(work)).repository, gitDirectory);
	const warm = calls();
	assert.equal((await resolver.resolve(work)).repository, gitDirectory);
	assert.equal(calls(), warm, "an unchanged repository reuses the completed result");
	const pointer = join(work, ".git", "commondir");
	writeFileSync(pointer, `${realpathSync(join(first, ".git"))}\n`);
	assert.equal((await resolver.resolve(work)).repository, realpathSync(join(first, ".git")));
	assert.equal(calls(), warm + 1);
	writeFileSync(pointer, `${realpathSync(join(second, ".git"))}\n`);
	assert.equal((await resolver.resolve(work)).repository, realpathSync(join(second, ".git")));
	assert.equal(calls(), warm + 2);
	rmSync(pointer);
	assert.equal((await resolver.resolve(work)).repository, gitDirectory);
	assert.equal(calls(), warm + 3);
});

it("notices discovery validity changes inside an ordinary repository", async (t) => {
	const { work, calls } = workspace(t);
	git(work, "init", "-q");
	const resolver = createPrimaryLocationResolver();
	const repository = realpathSync(join(work, ".git"));
	const changed = async (label: string) => {
		const before = calls();
		const location = await resolver.resolve(work);
		assert.equal(calls(), before + 1, `${label} starts a fresh Git read`);
		return location;
	};
	const warm = async (label: string) => {
		const before = calls();
		const location = await resolver.resolve(work);
		assert.equal(calls(), before, `${label} reuses the completed result`);
		return location;
	};
	assert.equal((await resolver.resolve(work)).repository, repository);
	assert.equal((await warm("an unchanged repository")).repository, repository);
	const head = join(work, ".git", "HEAD");
	const saved = readFileSync(head, "utf8");
	rmSync(head);
	assert.equal((await changed("a removed HEAD")).repositoryState, "outside-git");
	writeFileSync(head, saved);
	assert.equal((await changed("a restored HEAD")).repository, repository);
	assert.equal((await warm("the restored repository")).repository, repository);
	writeFileSync(head, "not a ref\n");
	assert.equal((await changed("an invalid HEAD")).repositoryState, "outside-git");
	writeFileSync(head, saved);
	assert.equal((await changed("a valid HEAD again")).repository, repository);
	const objects = join(work, ".git", "objects");
	rmSync(objects, { recursive: true });
	assert.equal((await changed("a removed objects directory")).repositoryState, "outside-git");
	mkdirSync(objects);
	assert.equal((await changed("a restored objects directory")).repository, repository);
	const refs = join(work, ".git", "refs");
	rmSync(refs, { recursive: true });
	assert.equal((await changed("a removed refs directory")).repositoryState, "outside-git");
	mkdirSync(refs);
	assert.equal((await changed("a restored refs directory")).repository, repository);
});

it("caches a bare repository until one of its own markers changes", async (t) => {
	const { root, calls } = workspace(t);
	const bare = join(root, "bare.git");
	mkdirSync(bare);
	git(bare, "init", "-q", "--bare");
	const resolver = createPrimaryLocationResolver();
	assert.deepEqual(await resolver.resolve(bare), { cwd: realpathSync(bare), repository: realpathSync(bare), repositoryState: "git" });
	const warm = calls();
	assert.equal((await resolver.resolve(bare)).repositoryState, "git");
	assert.equal(calls(), warm, "an unchanged bare repository reuses the completed result");
	const head = join(bare, "HEAD");
	const saved = readFileSync(head, "utf8");
	rmSync(head);
	assert.equal((await resolver.resolve(bare)).repositoryState, "outside-git");
	writeFileSync(head, saved);
	assert.equal((await resolver.resolve(bare)).repository, realpathSync(bare));
});

it("notices a removed HEAD in a linked worktree's Git directory", async (t) => {
	const { root, work } = workspace(t);
	git(work, "init", "-q");
	git(work, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "initial");
	const linked = join(root, "linked");
	git(work, "worktree", "add", "-q", "-b", "side", linked);
	const resolver = createPrimaryLocationResolver();
	const main = await resolver.resolve(linked);
	assert.equal(main.repository, realpathSync(join(work, ".git")));
	const pointer = readFileSync(join(linked, ".git"), "utf8").trim();
	assert.ok(pointer.startsWith("gitdir: "));
	const target = pointer.slice("gitdir: ".length);
	const head = join(isAbsolute(target) ? target : resolve(linked, target), "HEAD");
	const saved = readFileSync(head, "utf8");
	rmSync(head);
	assert.equal((await resolver.resolve(linked)).repositoryState, "outside-git");
	writeFileSync(head, saved);
	assert.equal((await resolver.resolve(linked)).repository, main.repository);
});

it("does not retain a result whose discovery inputs changed while Git ran", async (t) => {
	const { root, work, bin, log, calls } = workspace(t);
	git(work, "init", "-q");
	const trigger = join(root, "mutate");
	writeFileSync(trigger, "");
	writeFileSync(join(bin, "git"), `#!/bin/sh\necho call >> '${log}'\n'${REAL_GIT}' "$@"\nstatus=$?\nif [ -e '${trigger}' ]; then rm -f '${trigger}'; mv '${work}/.git/HEAD' '${work}/.git/HEAD.moved'; fi\nexit $status\n`);
	chmodSync(join(bin, "git"), 0o755);
	const resolver = createPrimaryLocationResolver();
	assert.equal((await resolver.resolve(work)).repositoryState, "git");
	assert.equal(calls(), 1);
	assert.equal((await resolver.resolve(work)).repositoryState, "outside-git", "the next read follows the marker that changed during discovery");
	assert.equal(calls(), 2);
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
