import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { connectTransport, type TransportClient } from "../../transport/index.ts";
import { runHost, type HostRuntime } from "./host-process.ts";
import { hostPaths, parseHostMetadata } from "./host-protocol.ts";
import { HOST_CONTRACT } from "./version-contract.ts";
import { DurableHost } from "./durable-host.ts";
import { fixtureRegistry, hostOptions, scriptedRuntime } from "./durable-host-fixture.mts";

async function clients(t: TestContext, runtime: HostRuntime) {
	const root = mkdtempSync(join(tmpdir(), "host-boundary-"));
	const metadata = parseHostMetadata({ storageId: randomUUID(), cwd: root, agentDir: join(root, "agent"), packageDir: root, storagePath: join(root, "store"), model: { provider: "fixture", modelId: "fixture" }, thinkingLevel: "off" });
	const host = await runHost(() => runtime, { metadata, idleMs: 0, announceReady: () => {} });
	const paths = hostPaths(metadata);
	const a = await connectTransport({ serverId: paths.serverId, path: paths.socket });
	const b = await connectTransport({ serverId: paths.serverId, path: paths.socket });
	t.after(async () => { await a.dispose(); await b.dispose(); await host.close(); rmSync(root, { recursive: true, force: true }); });
	return { a, b };
}
function request(client: TransportClient, method: string, params: unknown, signal?: AbortSignal) {
	return client.request({ method, params, requestId: randomUUID(), contract: HOST_CONTRACT.operations[method] }, signal);
}

it("refuses another connection's observation token before runtime dispatch", { timeout: 3000 }, async (t) => {
	const calls: string[] = [];
	const { a, b } = await clients(t, { isIdle: () => true, close: async () => {}, request: async (method, params) => { calls.push(method); return method === "observe-open" ? params : {}; } });
	const token = randomUUID();
	await request(a, "observe-open", { token, scope: "conversation", conversationId: 1 });
	for (const method of ["observe-frame", "observe-close", "observe-open"]) await assert.rejects(request(b, method, { token }), /another connection|does not belong/);
	assert.deepEqual(calls, ["observe-open"]);
	await request(a, "observe-close", { token });
	assert.deepEqual(calls, ["observe-open", "observe-close"]);
});

it("shields admitted mutations from raw Chord caller cancellation", { timeout: 3000 }, async (t) => {
	let start: () => void = () => {}, finish: () => void = () => {};
	const started = new Promise<void>((resolve) => { start = resolve; });
	const completed = new Promise<void>((resolve) => { finish = resolve; });
	let observed: AbortSignal | undefined;
	const { a } = await clients(t, { isIdle: () => true, close: async () => {}, request: async (_method, _params, _id, signal) => { observed = signal; start(); await completed; return {}; } });
	const controller = new AbortController();
	const pending = request(a, "submit", { message: "work" }, controller.signal);
	const rejected = assert.rejects(pending);
	await started;
	controller.abort(new Error("caller stopped waiting"));
	await rejected;
	assert.equal(observed, undefined);
	finish();
});

it("acknowledges close after Feed release only when delayed runtime cleanup ends", { timeout: 5000 }, async (t) => {
	let start = () => {}, finish = () => {};
	const started = new Promise<void>((resolve) => { start = resolve; });
	const release = new Promise<void>((resolve) => { finish = resolve; });
	t.after(finish);
	const tokens = new Set<string>();
	let closes = 0;
	const frame = { scope: "tasks", storageId: "fixture", revision: 1, observedAt: new Date().toISOString(), tasks: [], labels: [], coverage: { complete: true, live: true } };
	const { a, b } = await clients(t, { isIdle: () => true, close: async () => {}, request: async (method, params) => {
		const token = (params as { token?: string } | undefined)?.token;
		if (method === "observe-open" && token) { tokens.add(token); return { token }; }
		if (method === "observe-frame") return frame;
		if (method === "observe-close" && token) {
			closes++;
			if (closes === 1) { start(); await release; }
			return { closed: tokens.delete(token) };
		}
		return {};
	} });
	const token = randomUUID();
	await request(a, "observe-open", { token, scope: "tasks" });
	const feed = await a.subscribe("observation", token, () => {});
	await feed.dispose();
	await started;
	let settled = false;
	const closing = request(a, "observe-close", { token }).then((result) => { settled = true; return result; });
	await request(a, "status", {});
	assert.equal(settled, false, "an explicit close must wait for automatic release");
	assert.equal(closes, 1, "pending automatic cleanup is not duplicated");
	await assert.rejects(request(b, "observe-close", { token }), /another connection/);
	await assert.rejects(request(a, "observe-open", { token }), /still closing/);
	finish();
	assert.deepEqual(await closing, { closed: false });
	assert.equal(tokens.size, 0);
	assert.deepEqual(await request(a, "observe-close", { token }), { closed: false });
	assert.equal(a.connected, true);
});

for (const feedFirst of [false, true]) it(`retains disconnected token ownership through native cleanup with Feed release first=${feedFirst}`, { timeout: 15000 }, async (t) => {
	let start = () => {}, finish = () => {}, disconnected = () => {};
	const started = new Promise<void>((resolve) => { start = resolve; });
	const release = new Promise<void>((resolve) => { finish = resolve; });
	const peerReleased = new Promise<void>((resolve) => { disconnected = resolve; });
	t.after(finish);
	const root = mkdtempSync(join(tmpdir(), "host-native-boundary-"));
	const native = await DurableHost.open(hostOptions(join(root, "store.sqlite"), await scriptedRuntime([]), fixtureRegistry()));
	let stops = 0;
	const watch = native.harness.watchTaskGraph.bind(native.harness);
	t.mock.method(native.harness, "watchTaskGraph", async (...args: Parameters<typeof watch>) => {
		const handle = await watch(...args);
		return { get value() { return handle.value; }, closed: handle.closed, start: (listener: Parameters<typeof handle.start>[0]) => handle.start(listener), stop: async () => {
			stops++;
			if (stops === 1) { start(); await release; }
			return handle.stop();
		} };
	});
	const calls: string[] = [];
	const { a, b } = await clients(t, {
		isIdle: () => native.isIdle(), close: () => native.close(), onChange: () => () => disconnected(),
		request: async (method, params) => {
			calls.push(method);
			if (method === "status") return {};
			return native.request(method, params as Record<string, unknown>);
		},
	});
	t.after(async () => { await native.close(); rmSync(root, { recursive: true, force: true }); });
	const token = randomUUID();
	await request(a, "observe-open", { token, scope: "tasks" });
	await a.subscribe("changes", undefined, () => {});
	const feed = await a.subscribe("observation", token, () => {});
	if (feedFirst) await feed.dispose();
	const oldClose = request(a, "observe-close", { token }).catch(() => undefined);
	await started;
	await request(a, "status", {});
	const disconnect = a.dispose();
	await peerReleased;
	await disconnect;
	for (const method of ["observe-open", "observe-close"]) {
		const before = calls.filter((call) => call === method).length;
		const refused = request(b, method, { token, scope: "tasks" }).then(() => undefined, (error: unknown) => error);
		await request(b, "status", {});
		assert.equal(calls.filter((call) => call === method).length, before, "a disconnected owner still reserves its token until cleanup ends");
		assert.match(String(await refused), /another connection/);
	}
	finish();
	await oldClose;
	await request(b, "status", {});
	await request(b, "observe-open", { token, scope: "tasks" });
	assert.equal(native.observationCount, 1);
	assert.equal((await request(b, "observe-frame", { token }) as { scope: string }).scope, "tasks");
	assert.deepEqual(await request(b, "observe-close", { token }), { closed: true });
	assert.deepEqual(await request(b, "observe-close", { token }), { closed: false });
	assert.equal(native.observationCount, 0);
	assert.equal(stops, 2);
});
