import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { cleanGitEnvironment } from "./worktrees.mts";

const script = fileURLToPath(new URL("./worktrees.mts", import.meta.url));
const execute = promisify(execFile);

function fixture(t: TestContext) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "worktree-coordination-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const repo = join(root, "harness");
	const trees = join(root, "harness.worktrees");
	const tree = join(trees, "demo");
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
		PI_WORKTREE_ROOT: trees,
		PI_SETTINGS_PATH: settings,
	};
	const git = (args: string[], cwd = repo) =>
		execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
			cwd,
			env,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	const call = async (args: string[], cwd = repo, overrides: NodeJS.ProcessEnv = {}) => {
		try {
			const result = await execute(process.execPath, [script, ...args], {
				cwd,
				env: { ...env, ...overrides },
				timeout: 20_000,
				maxBuffer: 100_000,
			});
			return { ...result, status: 0 };
		} catch (error) {
			const result = error as { stdout: string; stderr: string; code: number | string };
			return { stdout: result.stdout, stderr: result.stderr, status: result.code };
		}
	};
	mkdirSync(join(repo, "extensions"), { recursive: true });
	writeFileSync(join(repo, "extensions", ".keep"), "");
	writeFileSync(join(repo, "shared.txt"), "base\n");
	git(["init", "-q", "-b", "main"]);
	git(["add", "."]);
	git(["commit", "-q", "-m", "Initial state"]);
	git(["worktree", "add", "-q", "-b", "feature/demo", tree]);
	writeFileSync(join(tree, "feature.txt"), "feature\n");
	git(["add", "."], tree);
	git(["commit", "-q", "-m", "Feature change"], tree);
	writeFileSync(join(repo, "main.txt"), "main\n");
	git(["add", "."]);
	git(["commit", "-q", "-m", "Main change"]);
	writeFileSync(settings, JSON.stringify({ packages: [{ source: repo, extensions: [] }] }));
	return { root, repo, tree, settings, env, git, call, lock: join(repo, ".git", "worktrees.lock") };
}

test("concurrent hooks defer before a second rebase or settings write", async (t) => {
	const f = fixture(t);
	const bin = join(f.root, "bin");
	mkdirSync(bin);
	const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
	writeFileSync(
		join(bin, "git"),
		`#!${process.execPath}
import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
const args = process.argv.slice(2);
if (args.at(-2) === "rebase" && args.at(-1) === "main") {
	const socket = createConnection({ host: "127.0.0.1", port: Number(process.env.REBASE_GATE_PORT) });
	await new Promise((resolve, reject) => { socket.once("end", resolve); socket.once("error", reject); });
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });
process.exitCode = result.status ?? 1;
`,
		{ mode: 0o755 },
	);
	let attempts = 0;
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		attempts += 1;
		if (attempts > 1) socket.end();
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const overrides = { PATH: `${bin}${delimiter}${process.env.PATH}`, REBASE_GATE_PORT: String(address.port) };
	const entered = once(server, "connection", { signal: AbortSignal.timeout(10_000) });
	const beforeHead = f.git(["rev-parse", "HEAD"], f.tree);
	const beforeMain = f.git(["rev-parse", "main"]);
	const beforeSettings = readFileSync(f.settings, "utf8");
	const owner = f.call(["sync", "--hook"], f.repo, overrides);
	try {
		await entered;
		const hook = await f.call(["sync", "--hook"], f.tree, overrides);
		assert.equal(hook.status, 0, hook.stderr);
		assert.match(hook.stderr, /deferred.*another worktree command/i);
		assert.equal(attempts, 1);
		assert.equal(f.git(["rev-parse", "HEAD"], f.tree), beforeHead);
		assert.equal(f.git(["rev-parse", "main"]), beforeMain);
		assert.equal(readFileSync(f.settings, "utf8"), beforeSettings);
		assert.equal(existsSync(f.lock), true);

		for (const args of [
			[],
			["sync"],
			["configure"],
			["status"],
			["install-hooks"],
			["add", "feature/late"],
			["activate", "demo"],
			["deactivate", "demo"],
		]) {
			const result = await f.call(args, f.tree, overrides);
			assert.equal(result.status, 1, `${args}: ${result.stderr}`);
			assert.match(result.stderr, /another worktree command/i);
		}
		const promotion = await f.call(["promote", "demo", "--no-push", "--no-gates", "--json"], f.tree, overrides);
		assert.equal(promotion.status, 1);
		const report = JSON.parse(promotion.stdout);
		assert.equal(report.ok, false);
		assert.equal(report.stage, "coordination");
		assert.match(report.reason, /another worktree command/i);
		assert.equal(attempts, 1);
	} finally {
		for (const socket of sockets) socket.end();
		const result = await owner;
		server.close();
		assert.equal(result.status, 0, result.stderr);
	}
	assert.equal(existsSync(f.lock), false);
	f.git(["merge-base", "--is-ancestor", "main", "feature/demo"]);
	assert.equal(f.git(["status", "--porcelain"], f.tree), "");
});

test("failed commands release their own lock and never reclaim an existing lock", async (t) => {
	const f = fixture(t);
	const failed = await f.call(["unknown"]);
	assert.equal(failed.status, 1);
	assert.match(failed.stderr, /Unknown command/);
	assert.equal(existsSync(f.lock), false);

	writeFileSync(f.lock, "unverified owner\n");
	const blocked = await f.call(["sync"]);
	assert.equal(blocked.status, 1);
	assert.match(blocked.stderr, /another worktree command/i);
	assert.equal(readFileSync(f.lock, "utf8"), "unverified owner\n");
});

test("sync preserves a pre-existing clean paused rebase", async (t) => {
	const f = fixture(t);
	const editor = join(f.root, "editor");
	writeFileSync(
		editor,
		`#!${process.execPath}
const fs = require("node:fs");
const path = process.argv[2];
fs.writeFileSync(path, fs.readFileSync(path, "utf8").replace(/^pick /m, "edit "));
`,
		{ mode: 0o755 },
	);
	execFileSync("git", ["-c", "core.hooksPath=/dev/null", "rebase", "-i", "HEAD~1"], {
		cwd: f.tree,
		env: { ...f.env, GIT_SEQUENCE_EDITOR: editor },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const rebaseDir = f.git(["rev-parse", "--path-format=absolute", "--git-path", "rebase-merge"], f.tree);
	const beforeHead = f.git(["rev-parse", "HEAD"], f.tree);
	const todo = readFileSync(join(rebaseDir, "git-rebase-todo"), "utf8");
	assert.equal(f.git(["status", "--porcelain"], f.tree), "");
	const result = await f.call(["sync"]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /expected worktree path is not empty/);
	assert.equal(existsSync(rebaseDir), true);
	assert.equal(readFileSync(join(rebaseDir, "git-rebase-todo"), "utf8"), todo);
	assert.equal(f.git(["rev-parse", "HEAD"], f.tree), beforeHead);
	assert.equal(existsSync(f.lock), false);
});
