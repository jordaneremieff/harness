import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { AgentCatalog, hostMetadata } from "./catalog.ts";
import { connectHost, waitForHostRelease, type HostConnection } from "./host-client.ts";
import { eventLog, waitForProcessExit } from "./host-fixture.mts";
import { killHost, markerFixture, runtimeFixture, trackHost, waitForReceipt } from "./durable-runtime-fixture.mts";

interface Row { kind: string; pid?: number; packageDir?: string; sessionId?: string; storageId?: string; taskId?: number; text?: string; [key: string]: unknown }
interface Reference { sessionId: string; submissionId: number; requestId: string }
function fixtureRows(path: string): Row[] {
	try { return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
function caller(packageDir: string, root: string, cwd: string, agentDir: string, env: Record<string, string>) {
	const events = eventLog<Row>();
	const child = spawn(process.execPath, [fileURLToPath(new URL("./host-continuity-caller-fixture.mts", import.meta.url)), JSON.stringify({ packageDir, cwd, agentDir, sessionDir: join(root, "caller-sessions"), extension: fileURLToPath(new URL("./index.ts", import.meta.url)), fixture: fileURLToPath(new URL("./testdata/durable-runtime/caller-continuity.ts", import.meta.url)) })], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
	let output = "";
	const append = (value: Buffer) => { output = (output + value.toString()).slice(-65536); };
	child.stdout?.on("data", append); child.stderr?.on("data", append);
	child.on("message", (value) => events.push(value as Row));
	child.on("error", (error) => events.push({ kind: "error", error: String(error) }));
	child.on("exit", (code, signal) => events.push({ kind: "exit", pid: child.pid, code, signal }));
	const wait = async (accept: (row: Row) => boolean): Promise<Row> => {
		await events.waitFor((rows) => rows.some(accept) || rows.some((row) => row.kind === "error" || row.kind === "exit"), 30000);
		const found = events.find(accept);
		if (!found) throw new Error(`Caller failed: ${JSON.stringify(events)}\n${output}`);
		return found;
	};
	return { child, events, wait, output: () => output, send: (op: string, text?: string) => child.send({ op, text }) };
}
async function stopCaller(child: ChildProcess) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	if (child.connected) child.send({ op: "exit" });
	try { await waitForProcessExit(child, 10000); }
	catch { child.kill("SIGKILL"); await waitForProcessExit(child, 10000); }
}
function killFixtureHosts(path: string) {
	for (const row of fixtureRows(path)) if (row.kind === "host-binding" && typeof row.pid === "number") killHost(row.pid);
}
const packageA = process.env.PI_AGENT_TEST_PACKAGE_A;
const packageB = process.env.PI_AGENT_TEST_PACKAGE_B;

it("retains native child work across ordinary caller exit and a fresh caller installation", { timeout: 120000, skip: !packageA || !packageB ? "requires two real Pi installations through PI_AGENT_TEST_PACKAGE_A/B" : false }, async (t) => {
	assert.ok(packageA && packageB);
	const a = realpathSync(packageA); const b = realpathSync(packageB);
	assert.notEqual(a, b);
	const version = (path: string) => (JSON.parse(readFileSync(join(path, "package.json"), "utf8")) as { version: string }).version;
	assert.equal(version(a), version(b));
	const f = runtimeFixture(t, { withAgentExtension: true });
	const barriers = markerFixture(t, f.testDir);
	const release = barriers.hold("continuity-blocked");
	const fixturePath = fileURLToPath(new URL("./testdata/durable-runtime/caller-continuity.ts", import.meta.url));
	writeFileSync(join(f.agentDir, "settings.json"), JSON.stringify({ extensions: [fileURLToPath(new URL("./index.ts", import.meta.url)), fixturePath], compaction: { enabled: false }, cacheWarming: "off", retry: { enabled: false } }));
	const env = { ...f.env("answer"), DURABLE_TEST_NOTIFY: barriers.notifyPath, PI_AGENT_DIR: f.agentDir, PI_AGENT_SESSIONS_DIR: f.root, PI_AGENT_IDLE_MINUTES: "0" };
	const tracePath = join(f.testDir, "continuity.jsonl");
	const evidenceDir = process.env.PI_AGENT_TEST_EVIDENCE_DIR;
	if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });
	const evidence: Row[] = [];
	const note = (kind: string, data: Record<string, unknown> = {}) => {
		evidence.push({ kind, at: Date.now(), ...data });
		if (evidenceDir) writeFileSync(join(evidenceDir, "evidence.json"), JSON.stringify({ version: version(a), packageA: a, packageB: b, events: evidence }, null, 2));
	};
	const callers: ReturnType<typeof caller>[] = [];
	const links: HostConnection[] = [];
	t.after(() => release());
	try {
		const p1 = caller(a, f.root, f.cwd, f.agentDir, env); callers.push(p1);
		const ready1 = await p1.wait((row) => row.kind === "ready");
		assert.equal(ready1.pid, p1.child.pid); assert.equal(realpathSync(String(ready1.packageDir)), a);
		assert.ok(fixtureRows(tracePath).some((row) => row.kind === "ordinary-binding" && row.pid === p1.child.pid && realpathSync(String(row.packageDir)) === a));
		note("p1-ready", ready1);
		p1.send("prompt", "CONTINUITY_SPAWN");
		const spawned = await p1.wait((row) => row.kind === "tool" && row.name === "agent_spawn");
		assert.equal(spawned.isError, false, JSON.stringify(spawned));
		const details = (spawned.result as { details: { sessionId: string; result: Reference } }).details;
		const reference = details.result; assert.ok(reference?.submissionId); assert.equal(reference.sessionId, details.sessionId);
		await barriers.marker("continuity-blocked");
		await p1.wait((row) => row.kind === "prompt-done");
		const catalog = new AgentCatalog(realpathSync(f.root)); const record = catalog.read(reference.sessionId);
		const metadata = hostMetadata(record);
		const original = await connectHost(metadata, { retryAttempts: 0 }); links.push(original); trackHost(t, original.pid);
		const blocked = await original.request("status", { sessionId: reference.sessionId }) as { conversation: { busy: boolean; tasks: { id: number; kind: string }[] } };
		const tool = fixtureRows(tracePath).find((row) => row.kind === "tool-enter"); assert.ok(tool);
		assert.equal(blocked.conversation.busy, true); assert.ok(blocked.conversation.tasks.some((task) => task.id === tool.taskId && task.kind === "pi.tool"));
		assert.equal(tool.pid, original.pid); assert.equal(realpathSync(String(tool.packageDir)), a);
		note("x-blocked", { reference, hostPid: original.pid, tool });
		p1.send("exit"); await waitForProcessExit(p1.child, 10000); assert.equal(p1.child.exitCode, 0);
		assert.equal(fixtureRows(tracePath).filter((row) => row.kind === "tool-release").length, 0);
		note("p1-exited", { pid: p1.child.pid, code: p1.child.exitCode });
		release(); note("tool-released-after-p1-exit");
		const receipt = await waitForReceipt(original, String(ready1.sessionId), reference.submissionId);
		assert.equal(receipt.status, "done"); assert.equal(receipt.answer, "RETAINED_X");
		const retained = await original.request("inspect", { view: "result", submissionId: reference.submissionId }) as { answerEntryId: number; answer: string };
		assert.ok(retained.answerEntryId); assert.ok(JSON.stringify(retained).includes("RETAINED_X"));
		note("retained-before-p2", { reference, retained });
		const p2 = caller(b, f.root, f.cwd, f.agentDir, env); callers.push(p2);
		const ready2 = await p2.wait((row) => row.kind === "ready");
		assert.equal(ready2.pid, p2.child.pid); assert.notEqual(ready2.pid, ready1.pid); assert.equal(realpathSync(String(ready2.packageDir)), b);
		assert.ok(fixtureRows(tracePath).some((row) => row.kind === "ordinary-binding" && row.pid === p2.child.pid && realpathSync(String(row.packageDir)) === b));
		note("p2-ready", ready2);
		p2.send("prompt", `CONTINUITY_INSPECT:${JSON.stringify({ sessionId: reference.sessionId, submissionId: reference.submissionId })}`);
		const inspected = await p2.wait((row) => row.kind === "tool" && row.name === "agent_inspect"); assert.equal(inspected.isError, false, JSON.stringify(inspected));
		const reading = (inspected.result as { details: { answerEntryId: number } }).details;
		assert.equal(reading.answerEntryId, retained.answerEntryId); assert.ok(JSON.stringify(reading).includes("RETAINED_X"));
		await p2.wait((row) => row.kind === "prompt-done");
		assert.equal(fixtureRows(tracePath).filter((row) => row.kind === "host-binding" && row.storageId === reference.sessionId).length, 1);
		note("p2-retained-read", { reading, oldHostPid: original.pid });
		const closing = original.request("close");
		await waitForHostRelease(metadata, { after: closing, signal: AbortSignal.timeout(10000) });
		await original.close(); note("old-host-retired", { pid: original.pid });
		p2.send("prompt", `CONTINUITY_SEND:${reference.sessionId}`);
		const sent = await p2.wait((row) => row.kind === "tool" && row.name === "agent_send"); assert.equal(sent.isError, false, JSON.stringify(sent));
		const admitted = (sent.result as { details: { submissionId?: number; result?: Reference } }).details;
		note("p2-followup-admitted", { admitted });
		const next = await connectHost({ ...metadata, packageDir: b }, { retryAttempts: 0 }); links.push(next); trackHost(t, next.pid);
		assert.notEqual(next.pid, original.pid);
		const hostBinding = fixtureRows(tracePath).find((row) => row.kind === "host-binding" && row.pid === next.pid && row.storageId === reference.sessionId);
		assert.ok(hostBinding); assert.equal(realpathSync(String(hostBinding.packageDir)), b);
		const followId = admitted.result?.submissionId ?? admitted.submissionId; assert.ok(followId); assert.notEqual(followId, reference.submissionId);
		const follow = await waitForReceipt(next, String(ready2.sessionId), followId); assert.equal(follow.status, "done"); assert.equal(follow.answer, "FOLLOWUP_X");
		const old = await next.request("inspect", { view: "result", submissionId: reference.submissionId }) as Record<string, unknown>;
		// Result usage is conversation-cumulative; the retained answer and identifiers stay fixed.
		const stableResult = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== "usage"));
		assert.deepEqual(stableResult(old), stableResult(retained));
		const history = await next.request("inspect", { view: "history", source: "user", limit: 10 }) as { entries: unknown[] }; assert.equal(history.entries.length, 2);
		assert.deepEqual(hostMetadata(catalog.read(reference.sessionId)), metadata);
		const rows = fixtureRows(tracePath);
		assert.equal(rows.filter((row) => row.kind === "tool-enter").length, 1); assert.equal(rows.filter((row) => row.kind === "tool-release").length, 1); assert.equal(rows.filter((row) => row.kind === "tool-abort").length, 0);
		const nativeRequests = rows.filter((row) => row.kind === "request" && (row.pid === original.pid || row.pid === next.pid));
		assert.equal(nativeRequests.length, 3); assert.equal(new Set(nativeRequests.map((row) => row.sessionId)).size, 1);
		note("passed", { p1Pid: ready1.pid, p2Pid: ready2.pid, originalHostPid: original.pid, newHostPid: next.pid, reference, followId, hostBinding, nativeRequests });
	} catch (error) { note("failed", { error: String(error), rows: fixtureRows(tracePath), callers: callers.map((item) => ({ events: item.events, output: item.output() })) }); throw error; }
	finally {
		release();
		for (const item of callers) await stopCaller(item.child);
		for (const link of links) {
			if (!link.closed) { const closing = link.request("close"); await waitForHostRelease(link.metadata, { after: closing }).catch(() => {}); }
			await link.close().catch(() => {});
		}
		killFixtureHosts(tracePath);
		if (evidenceDir) {
			writeFileSync(join(evidenceDir, "callers.json"), JSON.stringify(callers.map((item) => ({ pid: item.child.pid, exitCode: item.child.exitCode, signal: item.child.signalCode, events: item.events, output: item.output() })), null, 2));
			try { copyFileSync(tracePath, join(evidenceDir, "continuity.jsonl")); } catch { /* Startup failure has no extension trace. */ }
		}
	}
});
