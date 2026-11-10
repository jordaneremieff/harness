import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
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

function makeSnapshot(root: string, name: string, withPackageJson = true): string {
	const directory = join(root, "snapshots", name);
	mkdirSync(directory, { recursive: true });
	if (withPackageJson) writeFileSync(join(directory, "package.json"), "{}\n");
	return directory;
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
	const incomplete = makeSnapshot(root, "incomplete", false);
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
	const environment = {
		...process.env,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Fixture",
		GIT_AUTHOR_EMAIL: "fixture@example.com",
		GIT_COMMITTER_NAME: "Fixture",
		GIT_COMMITTER_EMAIL: "fixture@example.com",
	};
	const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8", env: environment });
	const run = (...args: string[]) => {
		const result = git(...args);
		assert.equal(result.status, 0, result.stderr);
		return result.stdout;
	};
	run("init", "-q");
	run("config", "user.email", "fixture@example.com");
	run("config", "user.name", "Fixture");
	run("commit", "--allow-empty", "-m", "Older");
	const olderCommit = run("rev-parse", "HEAD").trim();
	run("commit", "--allow-empty", "-m", "Newer");
	const newerCommit = run("rev-parse", "HEAD").trim();
	const older = join(root, "older");
	const newer = join(root, "newer");
	run("worktree", "add", "--detach", older, olderCommit);
	run("worktree", "add", "--detach", newer, newerCommit);
	writeFileSync(join(older, "package.json"), "{}\n");
	writeFileSync(join(newer, "package.json"), "{}\n");
	const settingsPath = writeSettings(root, `{\n\t"packages": [${JSON.stringify(older)}]\n}\n`);
	const forward = switchHarnessPackage({ settingsPath, expect: older, to: newer });
	assert.deepEqual(forward, { from: older, to: newer });
	assert.throws(() => switchHarnessPackage({ settingsPath, expect: newer, to: older }), /does not descend/);
	assert.equal(readFileSync(settingsPath, "utf8"), `{\n\t"packages": [${JSON.stringify(newer)}]\n}\n`);
	const rollback = switchHarnessPackage({ settingsPath, expect: newer, to: older, rollback: true });
	assert.deepEqual(rollback, { from: newer, to: older });
});
