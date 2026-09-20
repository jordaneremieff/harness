import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import type { JsonValue } from "@earendil-works/chord";
import type { ImageContent } from "@earendil-works/pi-ai";
import { Client } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { createDetachedControlServer, readControlEndpoint, withDetachedControl, type DetachedControlServerOptions } from "./detached-control.ts";
import { DetachedRuns, type DetachedRunRequest } from "./detached.ts";
import type { AgentWorkerSession, WorkerStatus } from "./worker.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "agent-control-test-"));
	const runs = new DetachedRuns(root);
	const request: DetachedRunRequest = {
		runId: randomUUID(), sessionId: "session-control", sessionsRoot: root, agentDir: root, cwd: root,
		prompt: "work", logFile: join(root, "run.log"), startedAt: new Date().toISOString(), pid: process.pid, launchState: "started",
	};
	runs.writeRequest(request);
	const status: WorkerStatus = {
		sessionId: request.sessionId, cwd: root, lane: "main", tipId: null,
		model: { provider: "test", modelId: "test", thinkingLevel: "off" }, operation: "operation-control",
		tools: ["read"], activeTools: ["read"], extensions: [], entryCount: 2,
	};
	const inspection = { sessionId: request.sessionId, execution: {}, entries: [], nextCursor: null, lastError: undefined } as unknown as Awaited<ReturnType<AgentWorkerSession["inspect"]>>;
	const calls: { steers: Array<{ message: string; images?: ImageContent[] }>; aborts: number; inspections: unknown[] } = { steers: [], aborts: 0, inspections: [] };
	const worker: DetachedControlServerOptions["worker"] = {
		status: async () => status,
		inspect: async (options) => { calls.inspections.push(options); return inspection; },
		steer: async (message, images) => { calls.steers.push({ message, images }); return "queued-entry"; },
	};
	const options: DetachedControlServerOptions = { request, metadata: { id: request.sessionId, createdAt: 1000, storageVersion: 4 }, worker, requestAbort: () => { calls.aborts += 1; return true; }, canSteer: () => true };
	return { root, request, worker, status, inspection, options, calls, descriptor: `${runs.requestFile(request.runId)}.control.json`, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
async function rawClient(request: DetachedRunRequest) {
	const endpoint = readControlEndpoint(request)!;
	const client = await Client.connect({ serverId: endpoint.serverId, transportFactory: createUnixTransportFactory({ path: endpoint.path }), maxFrameLength: 4 * 1024 * 1024 });
	try {
		await client.request({ serverId: endpoint.serverId }, { serviceId: "agent.run-attachment", member: "attach", args: [request.sessionId] });
		assert.equal(client.attachment?.sessionId, request.sessionId);
		return client;
	} catch (error) { await client.dispose(); throw error; }
}

describe("detached control over public Unix transport", () => {
	it("rejects a FIFO descriptor without waiting for a writer", { timeout: 6000 }, () => {
		const f = fixture();
		try {
			execFileSync("mkfifo", ["-m", "600", f.descriptor], { timeout: 2000, maxBuffer: 4096 });
			const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
				import assert from "node:assert/strict";
				import { writeSync } from "node:fs";
				import { readControlEndpoint } from ${JSON.stringify(new URL("./detached-control.ts", import.meta.url).href)};
				writeSync(1, "descriptor-open\\n");
				assert.throws(() => readControlEndpoint(${JSON.stringify(f.request)}), /invalid detached control descriptor file/);
				writeSync(1, "descriptor-rejected\\n");
			`], { timeout: 2000, killSignal: "SIGKILL", encoding: "utf8", maxBuffer: 8192 });
			assert.equal(child.status, 0, JSON.stringify({ error: child.error?.message, signal: child.signal, stdout: child.stdout, stderr: child.stderr }));
			assert.equal(child.stdout, "descriptor-open\ndescriptor-rejected\n");
		} finally { f.cleanup(); }
	});

	it("attaches to the owning session and routes bounded observations and controls", async () => {
		const f = fixture();
		assert.equal(readControlEndpoint(f.request), undefined);
		const server = await createDetachedControlServer(f.options);
		const endpoint = readControlEndpoint(f.request)!;
		try {
			assert.notEqual(endpoint.serverId, f.request.runId);
			assert.ok(Buffer.byteLength(endpoint.path) <= 100);
			const image: ImageContent = { type: "image", data: "YQ==", mimeType: "image/png" };
			await withDetachedControl(f.request, async (control) => {
				assert.deepEqual(await control.status(), f.status);
				assert.deepEqual(await control.inspect({ limit: 2, offset: 4 }), JSON.parse(JSON.stringify(f.inspection)));
				await control.steer("redirect", [image]);
				assert.equal(await control.abort(), true);
			});
			assert.deepEqual(f.calls.steers, [{ message: "redirect", images: [image] }]);
			assert.deepEqual(f.calls.inspections, [{ limit: 2, offset: 4 }]);
			assert.equal(f.calls.aborts, 1);
			await withDetachedControl(f.request, async (control) => { assert.equal((await control.status()).sessionId, f.request.sessionId); });
		} finally { await server.close(); f.cleanup(); }
		assert.equal(existsSync(dirname(endpoint.path)), false);
		assert.equal(existsSync(f.descriptor), false);
		await server.close();
	});

	it("rejects steering before admission but accepts the sticky abort callback", async () => {
		const f = fixture();
		let ready = false;
		const server = await createDetachedControlServer({ ...f.options, canSteer: () => ready, requestAbort: () => { f.calls.aborts += 1; } });
		try {
			await assert.rejects(withDetachedControl(f.request, (control) => control.steer("early")), /draining/iu);
			assert.equal(f.calls.steers.length, 0);
			assert.equal(await withDetachedControl(f.request, (control) => control.abort()), true);
			assert.equal(f.calls.aborts, 1);
			ready = true;
			await withDetachedControl(f.request, (control) => control.steer("admitted"));
			assert.equal(f.calls.steers.length, 1);
		} finally { await server.close(); f.cleanup(); }
	});

	it("disconnects before subscription disposal so cleanup needs no remote reply", async (context) => {
		const f = fixture();
		const server = await createDetachedControlServer(f.options);
		const subscribe = Client.prototype.subscribeService;
		const connectedAtDisposal: boolean[] = [];
		context.mock.method(Client.prototype, "subscribeService", async function (this: Client, ...args: Parameters<Client["subscribeService"]>) {
			const subscription = await subscribe.apply(this, args);
			return { ...subscription, dispose: async () => { connectedAtDisposal.push(this.connected); await subscription.dispose(); } };
		});
		try {
			await withDetachedControl(f.request, (control) => control.status());
			assert.deepEqual(connectedAtDisposal, [false, false]);
			assert.equal(f.calls.aborts, 0);
		} finally { await server.close(); f.cleanup(); }
	});

	it("reports an explicit false abort result", async () => {
		const f = fixture();
		const server = await createDetachedControlServer({ ...f.options, requestAbort: () => false });
		try { assert.equal(await withDetachedControl(f.request, (control) => control.abort()), false); }
		finally { await server.close(); f.cleanup(); }
	});

	it("disconnects the caller without aborting admitted work or replaying it", async () => {
		const f = fixture();
		const entered = deferred();
		const finish = deferred();
		let calls = 0;
		f.worker.status = async () => { calls += 1; entered.resolve(); await finish.promise; return f.status; };
		const server = await createDetachedControlServer(f.options);
		const cancel = new AbortController();
		try {
			const operation = withDetachedControl(f.request, (control) => control.status(), cancel.signal);
			const rejected = assert.rejects(operation, /caller cancelled|disconnected/iu);
			await entered.promise;
			cancel.abort(new Error("caller cancelled"));
			await rejected;
			assert.equal(f.calls.aborts, 0);
			assert.equal(calls, 1);
			let drained = false;
			const drain = server.sealAndDrain().then(() => { drained = true; });
			await Promise.resolve();
			assert.equal(drained, false);
			finish.resolve();
			await drain;
		} finally { finish.resolve(); await server.close(); f.cleanup(); }
	});

	it("seals new calls and drains calls already admitted", async () => {
		const f = fixture();
		const entered = deferred();
		const finish = deferred();
		f.worker.steer = async () => { entered.resolve(); await finish.promise; return "queued-entry"; };
		const server = await createDetachedControlServer(f.options);
		const client = await rawClient(f.request);
		try {
			const operation = client.request(client.attachment!, { serviceId: "agent.run-control", member: "steer", args: ["hold", null] });
			await entered.promise;
			let drained = false;
			const drain = server.sealAndDrain().then(() => { drained = true; });
			await assert.rejects(client.request(client.attachment!, { serviceId: "agent.run-control", member: "status", args: [] }), /draining/iu);
			assert.equal(drained, false);
			finish.resolve();
			await operation;
			await drain;
			assert.equal(f.calls.aborts, 0);
		} finally { finish.resolve(); await client.dispose(); await server.close(); f.cleanup(); }
	});

	it("rejects wrong server, wrong session, and a route from another attachment", async () => {
		const f = fixture();
		const server = await createDetachedControlServer(f.options);
		const first = await rawClient(f.request);
		const second = await rawClient(f.request);
		try {
			const call = { serviceId: "agent.run-control", member: "status", args: [] };
			await assert.rejects(first.request({ ...first.attachment!, serverId: randomUUID() }, call), /server/iu);
			await assert.rejects(first.request({ ...first.attachment!, sessionId: "other-session" }, call), /attach/iu);
			await assert.rejects(second.request(first.attachment!, call), /attach/iu);
			await assert.rejects(first.request({ serverId: first.serverId }, { serviceId: "agent.run-attachment", member: "attach", args: ["other-session"] }), /session/iu);
			await first.disconnect();
			await first.reconnect();
			await assert.rejects(first.request(second.attachment!, call), /attach/iu);
		} finally { await first.dispose(); await second.dispose(); await server.close(); f.cleanup(); }
	});

	it("validates application arguments at the remote endpoint", async () => {
		const f = fixture();
		const server = await createDetachedControlServer(f.options);
		const client = await rawClient(f.request);
		try {
			for (const [member, args] of [
				["status", ["extra"]], ["abort", [true]], ["inspect", [{ limit: 13 }]], ["inspect", [{ offset: -1 }]],
				["inspect", [{ unexpected: true }]], ["steer", ["", null]], ["steer", ["text", [{ type: "image", data: "a", mimeType: "text/plain" }]]],
			] as Array<[string, JsonValue[]]>) {
				await assert.rejects(client.request(client.attachment!, { serviceId: "agent.run-control", member, args }), /invalid/iu);
			}
			assert.equal(f.calls.aborts, 0);
			assert.equal(f.calls.steers.length, 0);
			assert.equal(f.calls.inspections.length, 0);
		} finally { await client.dispose(); await server.close(); f.cleanup(); }
	});

	it("bounds images, messages, and serialized observations", async () => {
		const f = fixture();
		const server = await createDetachedControlServer(f.options);
		try {
			await assert.rejects(withDetachedControl(f.request, (control) => control.steer("x".repeat(128 * 1024 + 1))), /byte limit/iu);
			await assert.rejects(withDetachedControl(f.request, (control) => control.steer("text", [{ type: "image", data: "a".repeat(2 * 1024 * 1024 + 1), mimeType: "image/png" }])), /invalid/iu);
			f.status.lastError = "x".repeat(1024 * 1024);
			await assert.rejects(withDetachedControl(f.request, (control) => control.status()), /byte limit/iu);
			assert.equal(f.calls.steers.length, 0);
		} finally { await server.close(); f.cleanup(); }
	});

	it("rejects observations with a different session identity", async () => {
		const f = fixture();
		const server = await createDetachedControlServer(f.options);
		try {
			f.status.sessionId = "wrong-session";
			await assert.rejects(withDetachedControl(f.request, (control) => control.status()), /session identity/iu);
		} finally { await server.close(); f.cleanup(); }
	});

	it("rejects mismatched, oversized, and non-private readiness descriptors", async () => {
		const f = fixture();
		const server = await createDetachedControlServer(f.options);
		const original = readFileSync(f.descriptor, "utf8");
		try {
			assert.throws(() => readControlEndpoint({ ...f.request, pid: process.pid + 1 }), /match/iu);
			assert.throws(() => readControlEndpoint({ ...f.request, sessionId: "wrong-session" }), /match/iu);
			writeFileSync(f.descriptor, "x".repeat(4097));
			assert.throws(() => readControlEndpoint(f.request), /descriptor/iu);
			writeFileSync(f.descriptor, original);
			chmodSync(f.descriptor, 0o644);
			assert.throws(() => readControlEndpoint(f.request), /descriptor/iu);
		} finally { writeFileSync(f.descriptor, original); chmodSync(f.descriptor, 0o600); await server.close(); f.cleanup(); }
	});

	it("does not replace an existing readiness descriptor after startup failure", async () => {
		const f = fixture();
		const server = await createDetachedControlServer(f.options);
		const original = readFileSync(f.descriptor, "utf8");
		try {
			await assert.rejects(createDetachedControlServer(f.options), /EEXIST/u);
			assert.equal(readFileSync(f.descriptor, "utf8"), original);
			assert.equal((await withDetachedControl(f.request, (control) => control.status())).sessionId, f.request.sessionId);
		} finally { await server.close(); f.cleanup(); }
	});

	it("refuses foreign ownership and reports a missing endpoint without opening a worker", async () => {
		const f = fixture();
		try {
			await assert.rejects(createDetachedControlServer({ ...f.options, request: { ...f.request, pid: process.pid + 1 } }), /owning run/iu);
			await assert.rejects(withDetachedControl(f.request, (control) => control.status()), /not ready/iu);
		} finally { f.cleanup(); }
	});

	it("removes its descriptor even after the socket disappears", async () => {
		const f = fixture();
		const server = await createDetachedControlServer(f.options);
		const endpoint = readControlEndpoint(f.request)!;
		try {
			unlinkSync(endpoint.path);
			assert.equal(readControlEndpoint(f.request), undefined);
			await server.close();
			assert.equal(existsSync(f.descriptor), false);
			assert.equal(existsSync(dirname(endpoint.path)), false);
		} finally { await server.close(); f.cleanup(); }
	});

	it("preserves a replaced descriptor while it releases its own socket", async () => {
		const f = fixture();
		const server = await createDetachedControlServer(f.options);
		const endpoint = readControlEndpoint(f.request)!;
		const replacement = JSON.stringify({ ...endpoint, serverId: randomUUID() });
		try {
			writeFileSync(f.descriptor, replacement);
			await assert.rejects(server.close(), (error: unknown) => error instanceof AggregateError && error.errors.some((item) => /descriptor was replaced/u.test(String(item))));
			assert.equal(readFileSync(f.descriptor, "utf8"), replacement);
			assert.equal(existsSync(dirname(endpoint.path)), false);
		} finally { f.cleanup(); }
	});

	it("honors an already-cancelled caller without invoking controls", async () => {
		const f = fixture();
		const server = await createDetachedControlServer(f.options);
		try {
			const cancel = new AbortController();
			cancel.abort(new Error("already cancelled"));
			await assert.rejects(withDetachedControl(f.request, (control) => control.abort(), cancel.signal), /already cancelled/iu);
			assert.equal(f.calls.aborts, 0);
		} finally { await server.close(); f.cleanup(); }
	});
});
