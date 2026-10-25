/**
 * The fixture's teardown contract: every host that holds a live writer claim under the
 * fixture's agent home is told to close, has exited, and the claims its close published are
 * stopped in turn, before the fixture root is removed. The root stays in place whenever that
 * confirmation fails or a claim cannot be classified. node:test runs `after` hooks in
 * registration order and awaits each; the fake context below does the same.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { CLAIM_BYTES } from "./claims.ts";
import { fixtureTeardown, ownedHostClaims, processGone, runtimeFixture, signalHost, stopOwnedHosts, trackHost, trackedHosts, waitForProcessGone, type FixtureContext, type StopOwnedHostsResult } from "./durable-runtime-fixture.mts";
import { hostPaths } from "./host-protocol.ts";

/** A context that records hooks and runs them later in registration order, awaiting each, as node:test does. */
function fakeContext(): FixtureContext & { hooks: Array<() => void | Promise<void>>; diagnostics: string[]; run(observe?: (index: number) => void): Promise<void> } {
	const hooks: Array<() => void | Promise<void>> = [];
	const diagnostics: string[] = [];
	return {
		hooks,
		diagnostics,
		after: (fn) => { hooks.push(fn); },
		diagnostic: (message) => { diagnostics.push(message); },
		run: async (observe) => { for (let index = 0; index < hooks.length; index += 1) { observe?.(index); await hooks[index](); } },
	};
}

/** A process that stays alive in `cwd` until signalled and reports its working directory on request. */
function holdingProcess(cwd: string): { child: ChildProcess; pid: number } {
	const child = spawn(process.execPath, ["-e", "process.stdin.once('data',()=>{let m='ok';try{process.cwd();}catch(e){m=e.message;}process.stdout.write(m);process.exit(0);});setInterval(()=>{},1000);"], { cwd, stdio: ["pipe", "pipe", "ignore"] });
	if (child.pid === undefined) throw new Error("holding process did not start");
	return { child, pid: child.pid };
}

/**
 * A launcher that behaves like a ready host under SIGTERM: it finishes an in-flight launch
 * (spawns a detached child and publishes that child's claim) and only then exits.
 */
function launcherProcess(cwd: string, childClaimPath: string, childStorageId: string, childCwd: string): { child: ChildProcess; pid: number } {
	const script = `
		const { spawn } = require("node:child_process");
		const { writeFileSync, mkdirSync } = require("node:fs");
		const { dirname } = require("node:path");
		const { hostname } = require("node:os");
		process.on("SIGTERM", () => {
			const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: process.env.CHILD_CWD, detached: true, stdio: "ignore" });
			child.unref();
			mkdirSync(dirname(process.env.CHILD_CLAIM), { recursive: true });
			writeFileSync(process.env.CHILD_CLAIM, JSON.stringify({ sessionId: process.env.CHILD_STORAGE, cwd: process.env.CHILD_CWD, host: hostname(), createdAt: new Date().toISOString(), pid: child.pid }));
			process.stdout.write("child " + child.pid + "\\n");
			setTimeout(() => process.exit(0), 20);
		});
		process.stdout.write("ready\\n");
		setInterval(() => {}, 1000);`;
	const child = spawn(process.execPath, ["-e", script], { cwd, env: { ...process.env, CHILD_CLAIM: childClaimPath, CHILD_STORAGE: childStorageId, CHILD_CWD: childCwd }, stdio: ["ignore", "pipe", "ignore"] });
	if (child.pid === undefined) throw new Error("launcher process did not start");
	return { child, pid: child.pid };
}

/** Write the claim a fixture host would hold for `cwd` under the fixture agent home. */
function writeClaim(agentDir: string, storageId: string, cwd: string, pid: number, createdAt = new Date()): string {
	const paths = hostPaths({ agentDir, storageId, cwd });
	mkdirSync(dirname(paths.claim), { recursive: true });
	writeFileSync(paths.claim, JSON.stringify({ sessionId: storageId, cwd, host: hostname(), createdAt: createdAt.toISOString(), pid }));
	return paths.claim;
}

/** Close what a fixture opened when its hooks were not run: remove the root, then run the hooks after the teardown hook (the marker server close). */
async function finishFixture(t: { hooks: Array<() => void | Promise<void>> }, root: string): Promise<void> {
	rmSync(root, { recursive: true, force: true });
	for (const hook of t.hooks.slice(1)) await hook();
}

async function exitCode(child: ChildProcess): Promise<number | null> {
	if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
	return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}

function collect(child: ChildProcess): Promise<string> {
	return new Promise((resolve) => { let text = ""; child.stdout?.on("data", (chunk: Buffer) => { text += chunk.toString(); }); child.stderr?.on("data", (chunk: Buffer) => { text += chunk.toString(); }); child.once("exit", () => resolve(text)); });
}

function outcome(result: StopOwnedHostsResult): Omit<StopOwnedHostsResult, "summary"> {
	return { stopped: result.stopped, lingering: result.lingering, unresolved: result.unresolved, complete: result.complete };
}

it("a process that outlives its working directory reports the uv_cwd failure", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fixture-order-"));
	const work = join(dir, "work");
	mkdirSync(work);
	const { child } = holdingProcess(work);
	try {
		rmSync(dir, { recursive: true, force: true });
		const output = collect(child);
		child.stdin?.end("report");
		assert.equal(await output, "ENOENT: no such file or directory, uv_cwd");
	} finally {
		child.kill("SIGKILL");
		rmSync(dir, { recursive: true, force: true });
	}
});

it("teardown stops every claimed host and waits for its exit before the root is removed", async () => {
	const t = fakeContext();
	const f = runtimeFixture(t);
	const first = holdingProcess(f.cwd);
	const second = holdingProcess(f.childCwd);
	writeClaim(f.agentDir, f.metadata.storageId, f.cwd, first.pid);
	writeClaim(f.agentDir, `${f.metadata.storageId}:25`, f.childCwd, second.pid);
	trackHost(t, first.pid);
	const timeline: string[] = [];
	try {
		assert.equal(t.hooks.length, 3, "fixture root teardown, marker server close, tracked host");
		const scan = ownedHostClaims(f.root, f.agentDir, Date.now() - 60000);
		assert.deepEqual({ complete: scan.complete, unresolved: scan.unresolved, pids: scan.claims.map((row) => row.pid).sort() }, { complete: true, unresolved: [], pids: [first.pid, second.pid].sort() });
		await t.run((index) => { timeline.push(`${index}: root=${existsSync(f.root)} first=${processGone(first.pid) ? "gone" : "alive"} second=${processGone(second.pid) ? "gone" : "alive"}`); });
		timeline.push(`end: root=${existsSync(f.root)} first=${processGone(first.pid) ? "gone" : "alive"} second=${processGone(second.pid) ? "gone" : "alive"}`);
		assert.deepEqual(timeline, [
			"0: root=true first=alive second=alive",
			"1: root=false first=gone second=gone",
			"2: root=false first=gone second=gone",
			"end: root=false first=gone second=gone",
		]);
		assert.equal(await exitCode(first.child), null, "a signal leaves no exit code");
		assert.equal(await exitCode(second.child), null);
		assert.equal(first.child.signalCode, "SIGTERM", "the fixture asks a host to close before anything harsher");
		assert.equal(t.diagnostics.length, 1);
		assert.match(t.diagnostics[0], /^fixture teardown .*: 2 owned host\(s\) stopped \[.*\] \(1 tracked\) in/);
		assert.match(t.diagnostics[0], /lingering \[\]; unresolved 0; scan complete$/);
		assert.deepEqual(trackedHosts(t), [first.pid]);
	} finally {
		first.child.kill("SIGKILL");
		second.child.kill("SIGKILL");
		rmSync(f.root, { recursive: true, force: true });
	}
});

it("a launcher that joins its in-flight launch on close publishes the child's claim, and the next pass stops that child", async () => {
	const t = fakeContext();
	const f = runtimeFixture(t);
	const childStorage = `${f.metadata.storageId}:40`;
	const childClaim = hostPaths({ agentDir: f.agentDir, storageId: childStorage, cwd: f.childCwd }).claim;
	const launcher = launcherProcess(f.cwd, childClaim, childStorage, f.childCwd);
	writeClaim(f.agentDir, f.metadata.storageId, f.cwd, launcher.pid);
	const lines: string[] = [];
	const ready = new Promise<void>((resolve) => { launcher.child.stdout?.on("data", (chunk: Buffer) => { lines.push(...chunk.toString().split("\n").filter(Boolean)); if (lines.includes("ready")) resolve(); }); });
	let childPid = 0;
	try {
		await ready;
		assert.equal(existsSync(childClaim), false, "no claim before the launcher is told to close");
		const result = await stopOwnedHosts(f.root, f.agentDir, Date.now() - 60000);
		childPid = Number(lines.find((line) => line.startsWith("child "))?.slice(6));
		assert.ok(childPid > 1, "the launcher reported the child it spawned while closing");
		assert.deepEqual(outcome(result), { stopped: [launcher.pid, childPid], lingering: [], unresolved: [], complete: true });
		assert.equal(processGone(launcher.pid), true);
		assert.equal(processGone(childPid), true, "the child published during the launcher's close was stopped by the second pass");
		assert.match(result.summary, /^2 owned host\(s\) stopped \[/);
	} finally {
		launcher.child.kill("SIGKILL");
		if (childPid > 1) signalHost(childPid, "SIGKILL");
		await finishFixture(t, f.root);
	}
});

it("a host that does not exit keeps the root in place and fails the test visibly", async () => {
	const t = fakeContext();
	const f = runtimeFixture(t);
	const held = holdingProcess(f.cwd);
	writeClaim(f.agentDir, f.metadata.storageId, f.cwd, held.pid);
	try {
		// The real wait path: a kill that does nothing stands in for a process the kernel keeps.
		const result = await stopOwnedHosts(f.root, f.agentDir, Date.now() - 60000, { kill: () => {}, deadlineMs: 60 });
		assert.deepEqual(outcome(result), { stopped: [], lingering: [held.pid], unresolved: [], complete: true });
		assert.equal(processGone(held.pid), false);
		// The hook path: a lingering report must retain the root and surface the failure before any removal.
		const lingering: StopOwnedHostsResult = { summary: `lingering [${held.pid}]`, stopped: [], lingering: [held.pid], unresolved: [], complete: true };
		await assert.rejects(fixtureTeardown(f.root, f.agentDir, Date.now(), t, async () => lingering), new RegExp(`did not exit before teardown: ${held.pid}; root retained`));
		assert.equal(existsSync(f.root), true);
		assert.equal(existsSync(f.cwd), true);
		assert.deepEqual(t.diagnostics, [`fixture teardown ${f.root}: lingering [${held.pid}]`]);
		assert.equal(processGone(held.pid), false, "the held process still has its working directory");
	} finally {
		held.child.kill("SIGKILL");
		await waitForProcessGone(held.pid);
		await finishFixture(t, f.root);
	}
});

it("a claim published after the first scan is stopped by the second pass", async () => {
	const t = fakeContext();
	const f = runtimeFixture(t);
	const first = holdingProcess(f.cwd);
	const late = holdingProcess(f.childCwd);
	writeClaim(f.agentDir, f.metadata.storageId, f.cwd, first.pid);
	const signalled: number[] = [];
	try {
		// `late` is already running with no claim when the first scan runs; its claim lands while the
		// first pass is signalling, which is the hand-off the later passes exist for.
		const result = await stopOwnedHosts(f.root, f.agentDir, Date.now() - 60000, { kill: (pid) => {
			signalled.push(pid);
			if (signalled.length === 1) writeClaim(f.agentDir, `${f.metadata.storageId}:25`, f.childCwd, late.pid);
			signalHost(pid, "SIGTERM");
		} });
		assert.deepEqual(signalled, [first.pid, late.pid]);
		assert.deepEqual(outcome(result), { stopped: [first.pid, late.pid], lingering: [], unresolved: [], complete: true });
		assert.equal(processGone(first.pid), true);
		assert.equal(processGone(late.pid), true);
	} finally {
		first.child.kill("SIGKILL");
		late.child.kill("SIGKILL");
		await finishFixture(t, f.root);
	}
});

it("an unreadable or partial claim is unresolved ownership: nothing is signalled, the root stays and the test fails", async () => {
	const t = fakeContext();
	const f = runtimeFixture(t);
	const bystander = holdingProcess(f.cwd);
	try {
		const partial = hostPaths({ agentDir: f.agentDir, storageId: "partial", cwd: f.cwd }).claim;
		mkdirSync(dirname(partial), { recursive: true });
		writeFileSync(partial, `{"sessionId":"partial","cwd":"${f.cwd}","host":"${hostname()}","createdAt":"${new Date().toISOString()}","pid":${bystander.pid}`.slice(0, -4));
		const oversized = hostPaths({ agentDir: f.agentDir, storageId: "oversized", cwd: f.cwd }).claim;
		mkdirSync(dirname(oversized), { recursive: true });
		writeFileSync(oversized, "x".repeat(CLAIM_BYTES + 1));
		const scan = ownedHostClaims(f.root, f.agentDir, Date.now() - 60000);
		assert.deepEqual(scan.claims, []);
		assert.equal(scan.complete, true);
		assert.deepEqual(scan.unresolved.map((entry) => entry.split(":")[0]).sort(), [oversized, partial].sort());
		const signalled: number[] = [];
		const result = await stopOwnedHosts(f.root, f.agentDir, Date.now() - 60000, { kill: (pid) => { signalled.push(pid); } });
		assert.deepEqual(signalled, [], "an unresolved claim never receives a signal");
		assert.equal(result.unresolved.length, 2);
		await assert.rejects(fixtureTeardown(f.root, f.agentDir, Date.now() - 60000, t), /claim ownership unresolved, root retained/);
		assert.equal(existsSync(f.root), true);
		assert.equal(processGone(bystander.pid), false);
		assert.match(t.diagnostics[0], /\(0 tracked\) .*unresolved 2; scan complete$/);
	} finally {
		bystander.child.kill("SIGKILL");
		await finishFixture(t, f.root);
	}
});

it("a claim directory beyond the scan bound makes ownership unknown: the root stays and the test fails", async () => {
	const t = fakeContext();
	const f = runtimeFixture(t);
	try {
		const claimsDir = dirname(hostPaths({ agentDir: f.agentDir, storageId: "crowded", cwd: f.cwd }).claim);
		mkdirSync(claimsDir, { recursive: true });
		// 65 readable claims that are provably another machine's: excluded, not unresolved, so only the bound is in play.
		for (let index = 0; index < 65; index += 1) writeFileSync(join(claimsDir, `${index}.lock`), JSON.stringify({ sessionId: "crowded", cwd: f.cwd, host: "another-machine", createdAt: new Date().toISOString(), pid: 1 }));
		const scan = ownedHostClaims(f.root, f.agentDir, Date.now() - 60000);
		assert.deepEqual({ complete: scan.complete, claims: scan.claims, unresolved: scan.unresolved }, { complete: false, claims: [], unresolved: [] });
		await assert.rejects(fixtureTeardown(f.root, f.agentDir, Date.now(), t), /exceeded its bound .*; host ownership is unknown, root retained/);
		assert.equal(existsSync(f.root), true);
		assert.match(t.diagnostics[0], /scan incomplete$/);
	} finally {
		await finishFixture(t, f.root);
	}
});

it("teardown ignores claims that are stale, foreign to the root, older than the fixture, or on another host", async () => {
	const t = fakeContext();
	const f = runtimeFixture(t);
	const outside = mkdtempSync(join(tmpdir(), "fixture-outside-"));
	const bystander = holdingProcess(outside);
	const earlier = holdingProcess(f.cwd);
	const gone = holdingProcess(f.cwd);
	try {
		gone.child.kill("SIGKILL");
		assert.equal(await waitForProcessGone(gone.pid), true);
		writeClaim(f.agentDir, "stale", f.cwd, gone.pid);
		writeClaim(f.agentDir, "outside", outside, bystander.pid);
		writeClaim(f.agentDir, "earlier", f.cwd, earlier.pid, new Date(Date.now() - 120000));
		const foreign = hostPaths({ agentDir: f.agentDir, storageId: "foreign", cwd: f.cwd });
		mkdirSync(dirname(foreign.claim), { recursive: true });
		writeFileSync(foreign.claim, JSON.stringify({ sessionId: "foreign", cwd: f.cwd, host: "another-machine", createdAt: new Date().toISOString(), pid: bystander.pid }));
		assert.deepEqual(ownedHostClaims(f.root, f.agentDir, Date.now() - 60000), { claims: [], unresolved: [], complete: true });
		const stopped = await stopOwnedHosts(f.root, f.agentDir, Date.now() - 60000);
		assert.deepEqual(outcome(stopped), { stopped: [], lingering: [], unresolved: [], complete: true });
		assert.equal(processGone(bystander.pid), false, "a claim outside the root never stops a process");
		assert.equal(processGone(earlier.pid), false, "a claim older than the fixture never stops a process");
		await t.run();
		assert.equal(existsSync(f.root), false);
	} finally {
		bystander.child.kill("SIGKILL");
		earlier.child.kill("SIGKILL");
		rmSync(outside, { recursive: true, force: true });
		rmSync(f.root, { recursive: true, force: true });
	}
});

it("a tracked runner spawned before its claim is stopped by the first cleanup phase, before the root is removed", async () => {
	const t = fakeContext();
	const f = runtimeFixture(t);
	// The real hand-off a test owns: it spawned the runner, so it holds the pid and registers it at
	// once. durable-runner.ts loads its modules and only then takes its claim in runHost, so at
	// the first scan this process has no claim; the tracked pid is what the fixture stops.
	const runner = spawn(process.execPath, [fileURLToPath(new URL("./durable-runner.ts", import.meta.url)), JSON.stringify(f.metadata)], { cwd: f.cwd, env: { ...process.env, ...f.env("answer") }, stdio: ["ignore", "pipe", "pipe"] });
	assert.ok(runner.pid);
	const pid = runner.pid;
	trackHost(t, pid);
	const output = collect(runner);
	const timeline: string[] = [];
	try {
		assert.deepEqual(ownedHostClaims(f.root, f.agentDir, Date.now() - 60000).claims, [], "no claim yet at the scan");
		await t.run((index) => { timeline.push(`${index}: root=${existsSync(f.root)} runner=${processGone(pid) ? "gone" : "alive"}`); });
		timeline.push(`end: root=${existsSync(f.root)} runner=${processGone(pid) ? "gone" : "alive"}`);
		assert.deepEqual(timeline, ["0: root=true runner=alive", "1: root=false runner=gone", "2: root=false runner=gone", "end: root=false runner=gone"]);
		assert.match(t.diagnostics[0], /: 1 owned host\(s\) stopped \[\d+\] \(1 tracked\) in \d+ ms; lingering \[\]; unresolved 0; scan complete$/);
		const text = await output;
		assert.doesNotMatch(text, /uv_cwd|ENOENT/, "the runner was stopped while its directories still existed");
		assert.doesNotMatch(text, /"pid"/, "no readiness frame was published");
		assert.equal(runner.signalCode, "SIGTERM");
	} finally {
		runner.kill("SIGKILL");
		rmSync(f.root, { recursive: true, force: true });
	}
});

it("teardown does not signal a process with no tracked handle or claim", async () => {
	const t = fakeContext();
	const f = runtimeFixture(t);
	// Processes without a tracked PID or published claim are outside the scan and receive no signal.
	// Their behaviour after directory removal is not established by this check.
	const orphan = holdingProcess(f.cwd);
	try {
		await t.run();
		assert.equal(existsSync(f.root), false);
		assert.match(t.diagnostics[0], /: 0 owned host\(s\) stopped \[\] \(0 tracked\) in \d+ ms; lingering \[\]; unresolved 0; scan complete$/);
		assert.equal(processGone(orphan.pid), false, "the fixture did not signal a process it could not attribute");
	} finally {
		orphan.child.kill("SIGKILL");
		rmSync(f.root, { recursive: true, force: true });
	}
});

it("trackHost kills its host and waits for the exit; an already exited host is not an error", async () => {
	const t = fakeContext();
	const dir = mkdtempSync(join(tmpdir(), "fixture-track-"));
	const { child, pid } = holdingProcess(dir);
	try {
		trackHost(t, pid);
		trackHost(t, pid);
		await t.run();
		assert.equal(processGone(pid), true);
	} finally {
		child.kill("SIGKILL");
		rmSync(dir, { recursive: true, force: true });
	}
});
