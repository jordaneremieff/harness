import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import lockfile from "proper-lockfile";
import { switchHarnessPackage } from "./activate.mts";

function tempRoot(t: TestContext): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "activate-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

const fixtureEnvironment = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "Fixture",
	GIT_AUTHOR_EMAIL: "fixture@example.com",
	GIT_COMMITTER_NAME: "Fixture",
	GIT_COMMITTER_EMAIL: "fixture@example.com",
};

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: fixtureEnvironment });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}

/** The disposable repository of a test root; its `main` starts with one commit that holds package.json. */
function repositoryOf(root: string): string {
	const repository = join(root, "repository");
	if (existsSync(repository)) return repository;
	mkdirSync(repository);
	git(repository, "init", "-q", "-b", "main");
	writeFileSync(join(repository, "package.json"), "{}\n");
	git(repository, "add", "package.json");
	git(repository, "commit", "-q", "-m", "Initial");
	return repository;
}

/** Adds an empty commit to the branch checked out in the repository and returns its hash. */
function commit(root: string, message: string): string {
	const repository = repositoryOf(root);
	git(repository, "commit", "-q", "--allow-empty", "-m", message);
	return git(repository, "rev-parse", "HEAD");
}

/** A detached worktree of `revision`, the shape of a real snapshot. */
function makeSnapshot(root: string, name: string, revision = "main"): string {
	const directory = join(root, "snapshots", name);
	mkdirSync(dirname(directory), { recursive: true });
	git(repositoryOf(root), "worktree", "add", "-q", "--detach", directory, revision);
	return directory;
}

/** A commit on a side branch that main does not contain. */
function unmergedCommit(root: string, branch: string): string {
	const repository = repositoryOf(root);
	git(repository, "switch", "-q", "-c", branch);
	const hash = commit(root, `Work on ${branch}`);
	git(repository, "switch", "-q", "main");
	return hash;
}

function writeSettings(root: string, text: string): string {
	const settingsPath = join(root, "agent", "settings.json");
	mkdirSync(dirname(settingsPath), { recursive: true });
	writeFileSync(settingsPath, text);
	return settingsPath;
}

test("a forward switch replaces only the matching relative source", (t) => {
	const root = tempRoot(t);
	const current = makeSnapshot(root, "current");
	const next = makeSnapshot(root, "next");
	makeSnapshot(root, "other");
	const fixture = [
		"{",
		'\t"theme": "dark",',
		'\t"packages": [',
		'\t\t"npm:@scope/other",',
		'\t\t"../snapshots/current",',
		"",
		'\t\t{ "source": "../snapshots/other", "extensions": ["./ext"] },',
		'\t\t"git:https://example.com/other"',
		"\t],",
		'\t"session": { "title": "kept" }',
		"}",
		"",
	].join("\n");
	const settingsPath = writeSettings(root, fixture);
	chmodSync(settingsPath, 0o600);
	const result = switchHarnessPackage({ settingsPath, expect: current, to: next, isAncestor: () => true });
	assert.deepEqual(result, { from: "../snapshots/current", to: "../snapshots/next" });
	assert.equal(readFileSync(settingsPath, "utf8"), fixture.replace('"../snapshots/current"', '"../snapshots/next"'));
	assert.equal(statSync(settingsPath).mode & 0o777, 0o600);
});

test("a failed write leaves the original settings bytes in place", (t) => {
	const root = tempRoot(t);
	const current = makeSnapshot(root, "current");
	const next = makeSnapshot(root, "next");
	const fixture = `{\n\t"packages": ["../snapshots/current"]\n}\n`;
	const settingsPath = writeSettings(root, fixture);
	const blocked = `${settingsPath}.activate-${process.pid}.tmp`;
	mkdirSync(blocked);
	assert.throws(
		() => switchHarnessPackage({ settingsPath, expect: current, to: next, isAncestor: () => true }),
		/EEXIST/,
	);
	assert.equal(readFileSync(settingsPath, "utf8"), fixture);
	assert.equal(statSync(blocked).isDirectory(), true);
});

test("it refuses a replacement that would leave the effective source unchanged", (t) => {
	const root = tempRoot(t);
	const current = makeSnapshot(root, "current");
	const next = makeSnapshot(root, "next");
	const fixture = `{\n\t"packages": [\n\t\t{ "source": "../snapshots/current", "source": "../snapshots/curren\\u0074" }\n\t]\n}\n`;
	const settingsPath = writeSettings(root, fixture);
	assert.throws(
		() => switchHarnessPackage({ settingsPath, expect: current, to: next, isAncestor: () => true }),
		/would not select the new snapshot/,
	);
	assert.equal(readFileSync(settingsPath, "utf8"), fixture);
});

test("an object entry keeps its other fields when its source is switched", (t) => {
	const root = tempRoot(t);
	const current = makeSnapshot(root, "current");
	const next = makeSnapshot(root, "next");
	const fixture = `{\n\t"packages": [\n\t\t{ "source": "../snapshots/current", "extensions": ["./ext"], "enabled": true }\n\t]\n}\n`;
	const settingsPath = writeSettings(root, fixture);
	const result = switchHarnessPackage({ settingsPath, expect: current, to: next, isAncestor: () => true });
	assert.equal(result.from, "../snapshots/current");
	assert.equal(result.to, "../snapshots/next");
	assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
		packages: [{ source: "../snapshots/next", extensions: ["./ext"], enabled: true }],
	});
});

test("it refuses when no entry names the expected snapshot", (t) => {
	const root = tempRoot(t);
	const current = makeSnapshot(root, "current");
	const other = makeSnapshot(root, "other");
	const fixture = `{\n\t"packages": ["../snapshots/other", "npm:@scope/other"]\n}\n`;
	const settingsPath = writeSettings(root, fixture);
	assert.throws(
		() => switchHarnessPackage({ settingsPath, expect: current, to: other, isAncestor: () => true }),
		/no longer names the expected snapshot/,
	);
	assert.equal(readFileSync(settingsPath, "utf8"), fixture);
});

test("forward mode requires ancestry and rollback bypasses it", (t) => {
	const root = tempRoot(t);
	const current = makeSnapshot(root, "current");
	const earlier = makeSnapshot(root, "earlier");
	const fixture = `{\n\t"packages": [${JSON.stringify(current)}]\n}\n`;
	const settingsPath = writeSettings(root, fixture);
	const isAncestor = () => false;
	assert.throws(
		() => switchHarnessPackage({ settingsPath, expect: current, to: earlier, isAncestor }),
		(error: unknown) =>
			error instanceof Error && error.message.includes("does not descend") && error.message.includes("--rollback"),
	);
	assert.equal(readFileSync(settingsPath, "utf8"), fixture);
	const result = switchHarnessPackage({ settingsPath, expect: current, to: earlier, rollback: true });
	assert.deepEqual(result, { from: current, to: earlier });
	assert.equal(readFileSync(settingsPath, "utf8"), `{\n\t"packages": [${JSON.stringify(earlier)}]\n}\n`);
});

test("it refuses while the settings lock is held and succeeds after release", (t) => {
	const root = tempRoot(t);
	const current = makeSnapshot(root, "current");
	const next = makeSnapshot(root, "next");
	const fixture = `{\n\t"packages": ["../snapshots/current"]\n}\n`;
	const settingsPath = writeSettings(root, fixture);
	const release = lockfile.lockSync(settingsPath, { realpath: false });
	try {
		assert.throws(
			() => switchHarnessPackage({ settingsPath, expect: current, to: next, isAncestor: () => true }),
			/locked/,
		);
		assert.equal(readFileSync(settingsPath, "utf8"), fixture);
	} finally {
		release();
	}
	const result = switchHarnessPackage({ settingsPath, expect: current, to: next, isAncestor: () => true });
	assert.equal(result.to, "../snapshots/next");
	assert.equal(readFileSync(settingsPath, "utf8"), fixture.replace('"../snapshots/current"', '"../snapshots/next"'));
});

test("it refuses a new snapshot without a package.json", (t) => {
	const root = tempRoot(t);
	const current = makeSnapshot(root, "current");
	const incomplete = makeSnapshot(root, "incomplete");
	rmSync(join(incomplete, "package.json"));
	const fixture = `{\n\t"packages": ["../snapshots/current"]\n}\n`;
	const settingsPath = writeSettings(root, fixture);
	assert.throws(
		() => switchHarnessPackage({ settingsPath, expect: current, to: incomplete, isAncestor: () => true }),
		(error: unknown) =>
			error instanceof Error && error.message.includes(incomplete) && error.message.includes("package.json"),
	);
	assert.equal(readFileSync(settingsPath, "utf8"), fixture);
});

test("default ancestry follows real commit history", (t) => {
	const root = tempRoot(t);
	const older = makeSnapshot(root, "older");
	commit(root, "Newer");
	const newer = makeSnapshot(root, "newer");
	const settingsPath = writeSettings(root, `{\n\t"packages": [${JSON.stringify(older)}]\n}\n`);
	const forward = switchHarnessPackage({ settingsPath, expect: older, to: newer });
	assert.deepEqual(forward, { from: older, to: newer });
	assert.throws(() => switchHarnessPackage({ settingsPath, expect: newer, to: older }), /does not descend/);
	assert.equal(readFileSync(settingsPath, "utf8"), `{\n\t"packages": [${JSON.stringify(newer)}]\n}\n`);
	const rollback = switchHarnessPackage({ settingsPath, expect: newer, to: older, rollback: true });
	assert.deepEqual(rollback, { from: newer, to: older });
});

function refusesUnchanged(
	settingsPath: string,
	options: Omit<Parameters<typeof switchHarnessPackage>[0], "settingsPath">,
	pattern: RegExp,
): string {
	const before = readFileSync(settingsPath, "utf8");
	let message = "";
	assert.throws(
		() => switchHarnessPackage({ settingsPath, ...options }),
		(error: unknown) => {
			message = error instanceof Error ? error.message : String(error);
			return pattern.test(message);
		},
	);
	assert.equal(readFileSync(settingsPath, "utf8"), before);
	return message;
}

test("an unmerged descendant of the active commit is refused until its commit lands on main", (t) => {
	const root = tempRoot(t);
	const active = makeSnapshot(root, "active");
	const candidateCommit = unmergedCommit(root, "feature");
	const candidate = makeSnapshot(root, "candidate", candidateCommit);
	const settingsPath = writeSettings(root, `{\n\t"packages": ["../snapshots/active"]\n}\n`);
	const message = refusesUnchanged(settingsPath, { expect: active, to: candidate }, /is not on refs\/heads\/main/);
	assert.ok(message.includes(candidate), message);
	assert.ok(message.includes(candidateCommit), message);
	assert.ok(message.includes("git worktree add --detach <dir> main"), message);
	assert.equal(message.includes("--rollback"), false, message);
	git(repositoryOf(root), "merge", "-q", "--ff-only", "feature");
	const result = switchHarnessPackage({ settingsPath, expect: active, to: candidate });
	assert.equal(result.to, "../snapshots/candidate");
});

test("a detached snapshot of main is accepted", (t) => {
	const root = tempRoot(t);
	const active = makeSnapshot(root, "active");
	commit(root, "Next");
	const next = makeSnapshot(root, "next");
	const settingsPath = writeSettings(root, `{\n\t"packages": ["../snapshots/active"]\n}\n`);
	assert.equal(git(next, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD");
	assert.equal(switchHarnessPackage({ settingsPath, expect: active, to: next }).to, "../snapshots/next");
});

test("an earlier main commit stays eligible after main advances", (t) => {
	const root = tempRoot(t);
	const active = makeSnapshot(root, "active");
	commit(root, "Next");
	const next = makeSnapshot(root, "next");
	commit(root, "Later");
	const settingsPath = writeSettings(root, `{\n\t"packages": ["../snapshots/active"]\n}\n`);
	assert.equal(switchHarnessPackage({ settingsPath, expect: active, to: next }).to, "../snapshots/next");
	const rollback = switchHarnessPackage({ settingsPath, expect: next, to: active, rollback: true });
	assert.equal(rollback.to, "../snapshots/active");
});

test("rollback keeps the main check for its target but not for the expected entry", (t) => {
	const root = tempRoot(t);
	const earlier = makeSnapshot(root, "earlier");
	commit(root, "Current");
	const current = makeSnapshot(root, "current");
	const side = makeSnapshot(root, "side", unmergedCommit(root, "side"));
	const settingsPath = writeSettings(root, `{\n\t"packages": ["../snapshots/current"]\n}\n`);
	refusesUnchanged(settingsPath, { expect: current, to: side, rollback: true }, /is not on refs\/heads\/main/);
	writeFileSync(settingsPath, `{\n\t"packages": ["../snapshots/side"]\n}\n`);
	const recovery = switchHarnessPackage({ settingsPath, expect: side, to: earlier, rollback: true });
	assert.deepEqual(recovery, { from: "../snapshots/side", to: "../snapshots/earlier" });
});

test("a repository without refs/heads/main is refused even with refs that share its name", (t) => {
	const root = tempRoot(t);
	const active = makeSnapshot(root, "active");
	const candidate = makeSnapshot(root, "candidate");
	const repository = repositoryOf(root);
	git(repository, "branch", "-q", "-m", "main", "trunk");
	git(repository, "tag", "main", "trunk");
	git(repository, "update-ref", "refs/tags/refs/heads/main", "trunk");
	git(repository, "update-ref", "refs/remotes/origin/main", "trunk");
	const settingsPath = writeSettings(root, `{\n\t"packages": ["../snapshots/active"]\n}\n`);
	const message = refusesUnchanged(
		settingsPath,
		{ expect: active, to: candidate, isAncestor: () => true },
		/Could not establish .*refs\/heads\/main/,
	);
	assert.ok(message.includes("not a valid ref"), message);
});

test("a new snapshot that is not a Git checkout is refused", (t) => {
	const root = tempRoot(t);
	const active = makeSnapshot(root, "active");
	const plain = join(root, "plain");
	mkdirSync(plain);
	writeFileSync(join(plain, "package.json"), "{}\n");
	const settingsPath = writeSettings(root, `{\n\t"packages": ["../snapshots/active"]\n}\n`);
	const message = refusesUnchanged(
		settingsPath,
		{ expect: active, to: plain, isAncestor: () => true },
		/Could not establish .*not a git repository/,
	);
	assert.ok(message.includes(plain), message);
	assert.equal(message.includes("Land the commit"), false, message);
});

test("a directory below a work-tree root is refused although the enclosing commit is on main", (t) => {
	const root = tempRoot(t);
	const repository = repositoryOf(root);
	mkdirSync(join(repository, "nested"));
	writeFileSync(join(repository, "nested", "package.json"), "{}\n");
	git(repository, "add", "nested/package.json");
	git(repository, "commit", "-q", "-m", "Nested package");
	const active = makeSnapshot(root, "active");
	const settingsPath = writeSettings(root, `{\n\t"packages": ["../snapshots/active"]\n}\n`);
	const message = refusesUnchanged(
		settingsPath,
		{ expect: active, to: join(active, "nested"), isAncestor: () => true },
		/not the root of a Git work tree/,
	);
	assert.ok(message.includes("git worktree add --detach <dir> main"), message);
	assert.equal(message.includes("Land the commit"), false, message);
});

test("an inherited GIT_DIR does not select another repository's main", (t) => {
	const root = tempRoot(t);
	const active = makeSnapshot(root, "active");
	const candidate = makeSnapshot(root, "candidate", unmergedCommit(root, "feature"));
	const other = join(root, "other");
	mkdirSync(other);
	git(other, "init", "-q", "-b", "main");
	git(other, "commit", "-q", "--allow-empty", "-m", "Other");
	const settingsPath = writeSettings(root, `{\n\t"packages": ["../snapshots/active"]\n}\n`);
	const inherited = process.env.GIT_DIR;
	process.env.GIT_DIR = join(other, ".git");
	try {
		refusesUnchanged(
			settingsPath,
			{ expect: active, to: candidate, isAncestor: () => true },
			/is not on refs\/heads\/main/,
		);
	} finally {
		if (inherited === undefined) delete process.env.GIT_DIR;
		else process.env.GIT_DIR = inherited;
	}
});

test("a failed Git inspection is refused", (t) => {
	const root = tempRoot(t);
	const active = makeSnapshot(root, "active");
	const candidate = makeSnapshot(root, "candidate", unmergedCommit(root, "feature"));
	const settingsPath = writeSettings(root, `{\n\t"packages": ["../snapshots/active"]\n}\n`);
	const path = process.env.PATH;
	process.env.PATH = join(root, "no-git");
	try {
		const message = refusesUnchanged(
			settingsPath,
			{ expect: active, to: candidate, isAncestor: () => true },
			/Could not establish .*git did not run/,
		);
		assert.equal(message.includes("Land the commit"), false, message);
	} finally {
		process.env.PATH = path;
	}
	const middle = commit(root, "Middle");
	commit(root, "Tip");
	rmSync(join(repositoryOf(root), ".git", "objects", middle.slice(0, 2), middle.slice(2)));
	const message = refusesUnchanged(
		settingsPath,
		{ expect: active, to: candidate, isAncestor: () => true },
		/Could not establish .*refs\/heads\/main/,
	);
	assert.ok(message.includes(middle), message);
});
