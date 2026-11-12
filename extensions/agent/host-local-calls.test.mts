import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it, type TestContext } from "node:test";
import { createTransportServer, type TransportRequest } from "../../transport/index.ts";
import { connectHost } from "./host-client.ts";
import { eventLog, fixtureMetadata } from "./host-fixture.mts";
import { hostPaths } from "./host-protocol.ts";
import { HOST_CONTRACT } from "./version-contract.ts";

async function fixture(t: TestContext, refuseReopen = false) {
	const root = mkdtempSync(join(tmpdir(), "local-calls-"));
	const metadata = fixtureMetadata(root), paths = hostPaths(metadata);
	mkdirSync(paths.directory, { recursive: true });
	mkdirSync(dirname(paths.claim), { recursive: true });
	writeFileSync(paths.claim, JSON.stringify({ token: randomUUID(), pid: process.pid, host: hostname(), sessionId: metadata.storageId, cwd: metadata.cwd, createdAt: new Date().toISOString() }));
	const calls = eventLog<{ request: TransportRequest; resolve(value: unknown): void; reject(error: Error): void }>();
	const backend = `${paths.socket}.b`;
	let revision = 1;
	const writerId = randomUUID();
	const observationOpens = eventLog<string>(), observationCloses = eventLog<string>();
	const changes = new Set<(value: unknown) => void>(), observations = new Set<(value: unknown) => void>();
	const frame = () => ({ scope: "tasks", storageId: metadata.storageId, revision, observedAt: new Date().toISOString(), tasks: [], labels: [], coverage: { complete: true, live: true } });
	const server = createTransportServer({ serverId: paths.serverId, path: backend, request: async (request) => {
		if (request.method === "runtime-contract") return { format: "pi.agent.host-hello/1", writerId, contract: HOST_CONTRACT };
		if (request.method === "observe-open") {
			observationOpens.push(String((request.params as { token: string }).token));
			if (refuseReopen && observationOpens.length > 1) throw new Error("reopen refused");
			return { frame: frame() };
		}
		if (request.method === "observe-close") { observationCloses.push(String((request.params as { token: string }).token)); return {}; }
		return new Promise((resolve, reject) => calls.push({ request, resolve, reject }));
	}, subscribe: (kind, _token, _peer, publish) => {
		const listeners = kind === "changes" ? changes : observations;
		listeners.add(publish);
		return { value: kind === "changes" ? { revision, writerId } : frame(), close: () => { listeners.delete(publish); } };
	} });
	await server.start();
	const sockets = new Set<Socket>();
	const proxy = createServer((front) => {
		const back = createConnection(backend);
		for (const socket of [front, back]) {
			sockets.add(socket);
			socket.on("error", () => { front.destroy(); back.destroy(); });
			socket.on("close", () => { sockets.delete(socket); front.destroy(); back.destroy(); });
		}
		front.pipe(back).pipe(front);
	});
	await new Promise<void>((resolve, reject) => { proxy.once("error", reject); proxy.listen(paths.socket, resolve); });
	const client = await connectHost(metadata, { retryAttempts: 1 });
	t.after(async () => {
		for (const call of calls) call.resolve(null);
		await client.close();
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => proxy.close(() => resolve()));
		await server.close();
		rmSync(root, { recursive: true, force: true });
	});
	return { calls, client, observationOpens, observationCloses,
		publish: () => { revision += 1; for (const publish of changes) publish({ revision, writerId }); for (const publish of observations) publish(frame()); },
		disconnect: () => { for (const socket of sockets) socket.destroy(); } };
}

for (const refused of [false, true]) it(`rebinds live-owner feeds after transport loss with reopen refusal=${refused}`, { timeout: 10000 }, async (t) => {
	const f = await fixture(t, refused), originalPid = f.client.pid;
	assert.ok(f.client.observe && f.client.subscribeChanges);
	const observation = await f.client.observe({ scope: "tasks", sessionId: f.client.storageId });
	const frames = eventLog<{ revision?: number; fresh: boolean; state?: string }>();
	observation.onFrame((frame, fresh, state) => frames.push({ revision: frame?.revision, fresh, state }));
	const changes = eventLog<number>();
	const unsubscribe = await f.client.subscribeChanges(() => changes.push(changes.length));
	await changes.waitForCount(1);
	const pending = f.client.request("status", {}, { requestId: "reconnect" });
	await f.calls.waitForCount(1);
	f.disconnect();
	await f.calls.waitForCount(2);
	await f.observationOpens.waitForCount(2);
	f.calls[1].resolve("reconnected");
	assert.equal(await pending, "reconnected");
	assert.equal(f.client.pid, originalPid, "the writer and its claim never changed");
	assert.equal(f.client.closed, false);
	assert.notEqual(f.observationOpens[0], f.observationOpens[1]);
	await changes.waitForCount(2);
	if (refused) {
		await f.observationCloses.waitForCount(1);
		await frames.waitFor((items) => items.some((frame) => frame.state === "unavailable"));
		const late: Array<string | undefined> = [];
		observation.onFrame((_frame, _fresh, state) => late.push(state));
		assert.deepEqual(late, ["unavailable"]);
	} else {
		await frames.waitFor((items) => items.filter((frame) => frame.fresh && frame.state === "live").length === 2);
		f.publish();
		await frames.waitFor((items) => items.some((frame) => frame.revision === 2 && !frame.fresh && frame.state === "live"));
	}
	const before = changes.length;
	f.publish();
	await changes.waitForCount(before + 1);
	await unsubscribe(); await observation.close();
});

for (const reverse of [false, true]) it(`settles equal durable IDs independently with reverse replies=${reverse}`, { timeout: 10000 }, async (t) => {
	const { calls, client } = await fixture(t);
	const a = client.request("status", { waiter: "a" }, { requestId: "same" });
	const b = client.request("status", { waiter: "b" }, { requestId: "same" });
	await calls.waitForCount(2);
	const order = reverse ? [1, 0] : [0, 1];
	for (const index of order) calls[index].resolve(index);
	assert.deepEqual(await Promise.all([a, b]), [0, 1]);
});

for (const aborted of [0, 1]) it(`aborts only equal-ID waiter ${aborted} and ignores its late reply`, { timeout: 10000 }, async (t) => {
	const { calls, client } = await fixture(t);
	const controllers = [new AbortController(), new AbortController()];
	const promises = controllers.map((controller, waiter) => client.request("status", { waiter }, { requestId: "same", signal: controller.signal }));
	const refusal = assert.rejects(promises[aborted], /abort/iu);
	await calls.waitForCount(2);
	controllers[aborted].abort();
	await refusal;
	calls[aborted].resolve("late");
	calls[1 - aborted].resolve("other");
	assert.equal(await promises[1 - aborted], "other");
});

it("retains both local waiters and durable IDs across reconnect and late completion", { timeout: 10000 }, async (t) => {
	const { calls, client, disconnect } = await fixture(t);
	const a = client.request("status", { waiter: "a" }, { requestId: "same" });
	const b = client.request("status", { waiter: "b" }, { requestId: "same" });
	await calls.waitForCount(2);
	disconnect();
	await calls.waitForCount(4);
	assert.deepEqual(calls.map(({ request }) => request.requestId), ["same", "same", "same", "same"]);
	calls[3].resolve("b");
	calls[2].resolve("a");
	assert.deepEqual(await Promise.all([a, b]), ["a", "b"]);
	calls[0].resolve("old-a");
	calls[1].resolve("old-b");
});

it("settles each equal-ID waiter on a terminal error or client close", { timeout: 10000 }, async (t) => {
	const { calls, client } = await fixture(t);
	const a = client.request("status", {}, { requestId: "same" });
	const b = client.request("status", {}, { requestId: "same" });
	const rejected = assert.rejects(a, /terminal/u);
	const closed = assert.rejects(b, /closed/u);
	await calls.waitForCount(2);
	calls[0].reject(new Error("terminal"));
	await rejected;
	await client.close();
	await closed;
});
