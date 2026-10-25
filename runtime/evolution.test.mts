import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { cleanGitEnvironment } from "../scripts/worktrees.mts";
import {
	dispatchEvolutionOperation,
	evolutionCommand,
	evolutionEnvironment,
	type EvolutionOperation,
	runEvolutionCommand,
} from "./evolution.mts";
import { inspectPublishedUpstream, inspectUpstream } from "./upstream.mts";

test("evolution exposes fixed local actions without publication or gate bypass", () => {
	const command = evolutionCommand({
		operation: "evolution.promote-local",
		slices: ["feature/runtime", "extension/demo"],
		full: true,
	});
	assert.ok(command);
	assert.ok(command.includes("--no-push"));
	assert.ok(command.includes("--sync-selected"));
	assert.ok(command.includes("--full"));
	assert.ok(!command.includes("--no-gates"));
	assert.ok(evolutionCommand({ operation: "evolution.promotion-plan", slices: ["demo"] })?.includes("--dry-run"));
	assert.deepEqual(evolutionCommand({ operation: "upstream.update" }), ["pi", "update"]);
	assert.throws(() => evolutionCommand({ operation: "evolution.promote-local", slices: ["--no-gates"] }));
	assert.throws(() => evolutionCommand({ operation: "evolution.promote-local", slices: [] }));
	assert.throws(() => evolutionCommand({ operation: "evolution.promote-local", slices: ["demo", "demo"] }));
	assert.throws(() =>
		evolutionCommand({ operation: "evolution.sync", sourceOnly: false } as unknown as EvolutionOperation),
	);
	assert.throws(() =>
		evolutionCommand({ operation: "shell", command: "echo denied" } as unknown as EvolutionOperation),
	);
});

test("command output is bounded and a gate environment override does not cross the adapter", async () => {
	const result = await runEvolutionCommand(
		process.cwd(),
		[
			process.execPath,
			"-e",
			"process.stdout.write('x'.repeat(100000));process.stderr.write(String(process.env.PI_PROMOTE_GATES))",
		],
		{ env: { ...process.env, PI_PROMOTE_GATES: "unsafe" } },
	);
	assert.equal(result.ok, true);
	assert.equal(result.truncated, true);
	assert.equal(Buffer.byteLength(result.stdout), 8_000);
	assert.equal(result.stderr, "undefined");
	assert.equal(result.uncertain, false);
});

test("spawn failure and timeout are distinct and never imply rollback", async () => {
	const absent = await runEvolutionCommand(process.cwd(), ["/nonexistent/evolution-command"]);
	assert.equal(absent.ok, false);
	assert.equal(absent.uncertain, false);
	const timed = await runEvolutionCommand(process.cwd(), [process.execPath, "-e", "setInterval(()=>{},1000)"], {
		timeoutMs: 30,
	});
	assert.equal(timed.ok, false);
	assert.equal(timed.timedOut, true);
	assert.equal(timed.uncertain, true);
});

test("published upstream coverage ignores unpublished edits and does not advance the marker", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "evolution-upstream-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const env = {
		...cleanGitEnvironment(process.env),
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Fixture",
		GIT_AUTHOR_EMAIL: "fixture@example.com",
		GIT_COMMITTER_NAME: "Fixture",
		GIT_COMMITTER_EMAIL: "fixture@example.com",
	};
	const git = (args: string[]) =>
		execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: root, env, encoding: "utf8" }).trim();
	mkdirSync(join(root, "docs"));
	const marker = (version: string) => `<!-- pi-release-reviewed-through: ${version} -->\n`;
	writeFileSync(join(root, "docs/pi-durable-harness.md"), marker("1.0.3"));
	git(["init", "-q", "-b", "main"]);
	git(["add", "."]);
	git(["commit", "-q", "-m", "Published review"]);
	git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
	git(["config", "branch.main.remote", "origin"]);
	git(["config", "branch.main.merge", "refs/heads/main"]);
	git(["config", "remote.origin.url", root]);
	git(["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
	writeFileSync(join(root, "docs/pi-durable-harness.md"), marker("1.4.0"));
	git(["commit", "-q", "-am", "Local review"]);
	const result = await inspectUpstream({ cwd: root });
	assert.equal(result.coverage.state, "declared");
	if (result.coverage.state === "declared") assert.equal(result.coverage.reviewedThrough, "1.0.3");
	assert.equal(git(["status", "--porcelain"]), "");
	const status = await dispatchEvolutionOperation({ cwd: root }, { operation: "evolution.status" });
	assert.ok("upstream" in status);
	assert.equal(git(["status", "--porcelain"]), "");
});

test("relocated worktree script uses the canonical selected repository, not ambient roots", async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "evolution-relocated-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const repo = join(root, "repo");
	const tree = join(`${repo}.worktrees`, "demo");
	const env = {
		...cleanGitEnvironment(process.env),
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Fixture",
		GIT_AUTHOR_EMAIL: "fixture@example.com",
		GIT_COMMITTER_NAME: "Fixture",
		GIT_COMMITTER_EMAIL: "fixture@example.com",
	};
	const git = (args: string[], cwd = repo) =>
		execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, env, encoding: "utf8" }).trim();
	mkdirSync(join(repo, "extensions"), { recursive: true });
	writeFileSync(join(repo, "code.txt"), "base\n");
	git(["init", "-q", "-b", "main"]);
	git(["add", "."]);
	git(["commit", "-q", "-m", "Initial source"]);
	git(["worktree", "add", "-q", "-b", "feature/demo", tree]);
	writeFileSync(join(repo, "code.txt"), "updated\n");
	git(["commit", "-q", "-am", "Update main"]);
	const snapshot = join(root, "sealed", "scripts", "worktrees.mts");
	mkdirSync(join(root, "sealed", "scripts"), { recursive: true });
	writeFileSync(snapshot, readFileSync(fileURLToPath(new URL("../scripts/worktrees.mts", import.meta.url))));
	for (const ambient of [undefined, join(root, "wrong-repository")]) {
		const bound = evolutionEnvironment(tree, {
			...env,
			PI_HARNESS_ROOT: ambient,
			PI_WORKTREE_ROOT: join(root, "wrong-trees"),
		});
		assert.equal(bound.PI_HARNESS_ROOT, repo);
		assert.equal(bound.PI_WORKTREE_ROOT, `${repo}.worktrees`);
		const result = await runEvolutionCommand(tree, [process.execPath, snapshot, "sync", "--current", "--source-only"], {
			env: bound,
			timeoutMs: 5000,
		});
		assert.equal(result.ok, true, result.stderr);
	}
	assert.equal(readFileSync(join(tree, "code.txt"), "utf8"), "updated\n");
});

test("publication checks retain defining URLs and fail closed on malformed or oversized metadata", async () => {
	const urls: string[] = [];
	const fetcher: typeof fetch = async (input) => {
		urls.push(String(input));
		return new Response(JSON.stringify({ version: "1.4.0" }));
	};
	const available = await inspectPublishedUpstream(fetcher);
	assert.equal(available.packages.length, 2);
	assert.ok(available.packages.every((entry) => entry.state === "available" && entry.version === "1.4.0"));
	assert.ok(urls.every((url) => url.startsWith("https://registry.npmjs.org/")));
	for (const value of ["invalid JSON", JSON.stringify({ version: "01.4.0" }), "x".repeat(64_001)]) {
		const unavailable = await inspectPublishedUpstream(async () => new Response(value));
		assert.ok(unavailable.packages.every((entry) => entry.state === "unavailable"));
	}
});

test("unknown published coverage remains unavailable", async () => {
	const result = await inspectUpstream({ cwd: "/nonexistent/evolution-repository" });
	assert.equal(result.coverage.state, "unavailable");
	assert.equal(result.latestPublished, "not-queried");
});
