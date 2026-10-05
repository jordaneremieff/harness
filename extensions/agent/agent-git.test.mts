import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { AgentBranchCache, readAgentBranch } from "./agent-git.ts";
import { deferred, turn } from "./dashboard-test-fixture.mts";
it("branch cache coalesces events, remembers failures and aborts disposed requests", async () => {
	const pending = [deferred<string | undefined>(), deferred<string | undefined>(), deferred<string | undefined>()];
	const signals: AbortSignal[] = [];
	let calls = 0, paints = 0;
	const cache = new AgentBranchCache(async (_cwd, signal) => { signals.push(signal); return pending[calls++].promise; }, () => { paints++; });
	cache.refresh("/work", "one");
	cache.refresh("/work", "one");
	cache.refresh("/work", "two");
	assert.equal(calls, 1);
	pending[0].resolve("main"); await turn();
	assert.equal(cache.get("/work"), "main"); assert.equal(calls, 2);
	pending[1].resolve(undefined); await turn();
	assert.equal(cache.get("/work"), undefined);
	cache.refresh("/work", "two"); assert.equal(calls, 2);
	cache.refresh("/work", "three"); cache.dispose(); cache.dispose();
	assert.equal(signals[2].aborted, true);
	pending[2].resolve("late"); await turn();
	assert.equal(cache.get("/work"), undefined); assert.equal(paints, 2);
	cache.refresh("/work", "four"); assert.equal(calls, 3);
});
it("branch cache bounds cwd retention and isolates late evicted values", async () => {
	const first = deferred<string | undefined>();
	let signal: AbortSignal | undefined;
	const cache = new AgentBranchCache(async (cwd, current) => { if (cwd === "/work/0") { signal = current; return first.promise; } return "main"; }, () => {});
	for (let index = 0; index < 33; index++) cache.refresh(`/work/${index}`, "one");
	assert.equal(signal?.aborted, true);
	first.resolve("old"); await turn();
	assert.equal(cache.get("/work/0"), undefined);
	assert.equal(cache.get("/work/32"), "main"); cache.dispose();
});
it("bounded branch reader uses cwd, not inherited Git directory, and omits missing repositories", async () => {
	const root = await mkdtemp(join(tmpdir(), "agent-branch-"));
	const prior = process.env.GIT_DIR;
	try {
		execFileSync("git", ["init", "-q", "-b", "example", root], { timeout: 3000, maxBuffer: 4096 });
		process.env.GIT_DIR = join(root, "missing");
		assert.equal(await readAgentBranch(root, new AbortController().signal), "example");
		assert.equal(await readAgentBranch(join(root, "absent"), new AbortController().signal), undefined);
		const failedSpawn = new AbortController();
		const missing = readAgentBranch(join(root, "absent"), failedSpawn.signal);
		failedSpawn.abort();
		assert.equal(await missing, undefined);
		const stop = new AbortController(); stop.abort();
		assert.equal(await readAgentBranch(root, stop.signal), undefined);
	} finally {
		if (prior === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = prior;
		await rm(root, { recursive: true, force: true });
	}
});
