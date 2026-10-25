import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanGitEnvironment, scanPublicationText } from "./worktrees.mts";

const script = fileURLToPath(new URL("./worktrees.mts", import.meta.url));
function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "worktree-evolution-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const repo = join(root, "repo");
	const treeRoot = join(root, "trees");
	const tree = join(treeRoot, "demo");
	const sibling = join(treeRoot, "sibling");
	const settings = join(root, "settings.json");
	const env = {
		...cleanGitEnvironment(process.env),
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Fixture",
		GIT_AUTHOR_EMAIL: "fixture@example.com",
		GIT_COMMITTER_NAME: "Fixture",
		GIT_COMMITTER_EMAIL: "fixture@example.com",
		PI_HARNESS_ROOT: repo,
		PI_WORKTREE_ROOT: treeRoot,
		PI_SETTINGS_PATH: settings,
	};
	const git = (args: string[], cwd = repo) =>
		execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
			cwd,
			env,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	mkdirSync(join(repo, "extensions"), { recursive: true });
	writeFileSync(join(repo, "code.txt"), "base\n");
	git(["init", "-q", "-b", "main"]);
	git(["add", "."]);
	git(["commit", "-q", "-m", "Initial state"]);
	git(["worktree", "add", "-q", "-b", "feature/demo", tree]);
	git(["worktree", "add", "-q", "-b", "feature/sibling", sibling]);
	writeFileSync(settings, "invalid settings, intentionally not parsed\n");
	const call = (args: string[], cwd = tree) =>
		spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: "utf8", timeout: 30_000, maxBuffer: 128_000 });
	return { repo, tree, sibling, settings, git, call };
}

test("scoped source sync ignores a conflicting sibling and does not read or write settings", (t) => {
	const f = fixture(t);
	writeFileSync(join(f.sibling, "code.txt"), "sibling\n");
	f.git(["commit", "-q", "-am", "Sibling change"], f.sibling);
	const siblingTip = f.git(["rev-parse", "HEAD"], f.sibling);
	writeFileSync(join(f.repo, "code.txt"), "main\n");
	f.git(["commit", "-q", "-am", "Main change"]);
	const before = readFileSync(f.settings, "utf8");
	const result = f.call(["sync", "--current", "--source-only"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(readFileSync(join(f.tree, "code.txt"), "utf8"), "main\n");
	assert.equal(f.git(["rev-parse", "HEAD"], f.sibling), siblingTip);
	assert.equal(readFileSync(f.settings, "utf8"), before);
});

test("selected promotion sync preserves conflicting siblings and invalid unrelated settings", (t) => {
	const f = fixture(t);
	writeFileSync(join(f.sibling, "code.txt"), "sibling\n");
	f.git(["commit", "-q", "-am", "Sibling change"], f.sibling);
	const siblingTip = f.git(["rev-parse", "HEAD"], f.sibling);
	writeFileSync(join(f.repo, "code.txt"), "main\n");
	f.git(["commit", "-q", "-am", "Main change"]);
	assert.equal(f.call(["sync", "--current", "--source-only"]).status, 0);
	writeFileSync(join(f.tree, "feature.txt"), "durable feature\n");
	f.git(["add", "feature.txt"], f.tree);
	f.git(["commit", "-q", "-m", "Add feature"], f.tree);
	const before = readFileSync(f.settings, "utf8");
	const result = f.call(["promote", "demo", "--no-push", "--no-gates", "--sync-selected", "--json"]);
	assert.equal(result.status, 0, result.stderr || result.stdout);
	const report = JSON.parse(result.stdout);
	assert.equal(report.ok, true);
	assert.equal(report.pushed, false);
	assert.equal(report.syncOk, true);
	assert.equal(f.git(["rev-parse", "HEAD"], f.sibling), siblingTip);
	assert.equal(readFileSync(f.settings, "utf8"), before);
});

test("source-only sync refuses broad scope and non-slice checkouts", (t) => {
	const f = fixture(t);
	assert.equal(f.call(["sync", "--source-only"]).status, 1);
	assert.equal(f.call(["sync", "--current", "--source-only"], f.repo).status, 1);
});

test("publication signatures inspect content, preserve durable design prose, and never return secret text", () => {
	const path = ["", "Users", "fixture", "private", "source.ts"].join("/");
	assert.deepEqual(scanPublicationText(`// Source: ${path}`), [{ line: 1, rule: "personal-path" }]);
	const key = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
	assert.deepEqual(scanPublicationText(key), [{ line: 1, rule: "private-key" }]);
	assert.deepEqual(
		scanPublicationText("# Deployment plan\nThis document defines the supported deployment contract.\n"),
		[],
	);
	assert.deepEqual(scanPublicationText("const retainedTask = task.id; // Native task ownership.\n"), []);
});

test("publication review accepts a deleted path without treating unavailable content as text", (t) => {
	const f = fixture(t);
	f.git(["rm", "code.txt"], f.tree);
	f.git(["commit", "-q", "-m", "Remove source"], f.tree);
	const result = f.call(["promote", "demo", "--dry-run", "--no-push", "--json"]);
	assert.equal(result.status, 0, result.stderr || result.stdout);
	assert.equal(JSON.parse(result.stdout).ok, true);
});

test("publication scans larger histories without dropping signatures or its finite byte bound", (t) => {
	const f = fixture(t);
	const blob = `${"x".repeat(999_999)}\n`;
	for (let index = 0; index < 9; index++) writeFileSync(join(f.tree, `source-${index}.txt`), blob);
	f.git(["add", "."], f.tree);
	f.git(["commit", "-q", "-m", "Add source files"], f.tree);
	const args = ["promote", "demo", "--dry-run", "--no-push", "--json"];
	let result = f.call(args);
	assert.equal(result.status, 0, result.stderr || result.stdout);
	assert.equal(JSON.parse(result.stdout).ok, true);

	const privatePath = ["", "Users", "fixture", "private", "source.ts"].join("/");
	writeFileSync(join(f.tree, "private.txt"), privatePath);
	f.git(["add", "."], f.tree);
	f.git(["commit", "-q", "-m", "Add another source"], f.tree);
	result = f.call(args);
	assert.equal(result.status, 1, result.stderr || result.stdout);
	assert.match(JSON.parse(result.stdout).reason, /personal-path/);
	f.git(["reset", "--hard", "HEAD^"], f.tree);

	for (let index = 9; index < 68; index++) writeFileSync(join(f.tree, `source-${index}.txt`), blob);
	f.git(["add", "."], f.tree);
	f.git(["commit", "-q", "-m", "Add more source files"], f.tree);
	result = f.call(args);
	assert.equal(result.status, 1, result.stderr || result.stdout);
	const report = JSON.parse(result.stdout);
	assert.equal(report.stage, "hygiene");
	assert.match(report.reason, /publication scan byte limit/);
});

test("promotion checks shipped source and commit messages before a dry run or gate override", (t) => {
	const f = fixture(t);
	const privatePath = ["", "Users", "fixture", "private", "source.ts"].join("/");
	writeFileSync(f.settings, JSON.stringify({ packages: [] }));
	writeFileSync(join(f.tree, "code.txt"), `// Local provenance: ${privatePath}\n`);
	f.git(["commit", "-q", "-am", "Update source"], f.tree);
	const mainBefore = f.git(["rev-parse", "main"]);
	let result = f.call(["promote", "demo", "--dry-run", "--no-push", "--no-gates", "--json"]);
	assert.equal(result.status, 1, result.stderr);
	let report = JSON.parse(result.stdout);
	assert.equal(report.stage, "hygiene");
	assert.match(report.reason, /personal-path/);
	assert.doesNotMatch(report.reason, /fixture\/private/);
	assert.equal(f.git(["rev-parse", "main"]), mainBefore);
	f.git(["reset", "--hard", "main"], f.tree);
	writeFileSync(join(f.tree, "code.txt"), "durable source\n");
	f.git(["commit", "-q", "-am", `Source from ${privatePath}`], f.tree);
	result = f.call(["promote", "demo", "--dry-run", "--no-push", "--json"]);
	report = JSON.parse(result.stdout);
	assert.equal(report.stage, "hygiene");
	assert.match(report.reason, /commit message/);
});
