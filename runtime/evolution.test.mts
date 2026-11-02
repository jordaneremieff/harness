import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cleanGitEnvironment } from "./git-environment.mts";
import {
	dispatchEvolutionOperation,
	evolutionCommand,
	type EvolutionOperation,
	runEvolutionCommand,
} from "./evolution.mts";
import { inspectPublishedUpstream, inspectUpstream } from "./upstream.mts";

test("evolution exposes only fixed upstream and status actions", () => {
	assert.deepEqual(evolutionCommand({ operation: "upstream.update" }), ["pi", "update"]);
	assert.equal(evolutionCommand({ operation: "evolution.status" }), null);
	assert.throws(() =>
		evolutionCommand({ operation: "shell", command: "echo denied" } as unknown as EvolutionOperation),
	);
});

test("command output is bounded", async () => {
	const result = await runEvolutionCommand(
		process.cwd(),
		[
			process.execPath,
			"-e",
			"process.stdout.write('x'.repeat(100000))",
		],
	);
	assert.equal(result.ok, true);
	assert.equal(result.truncated, true);
	assert.equal(Buffer.byteLength(result.stdout), 8_000);
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
