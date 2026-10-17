import assert from "node:assert/strict";
import { ChordError, invalid, type Frame } from "@earendil-works/chord";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { randomUUID } from "node:crypto";
import { Socket } from "node:net";
import { connectTransport, createTransportServer, listenUnixLinks, LocalTransportRefusal, type UnixLink } from "./index.ts";

it("serves requests, undefined values, and owner-only sockets", { timeout: 5000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "transport-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "host.sock");
	const serverId = randomUUID();
	const server = createTransportServer({ serverId, path, request: async (request) => request.params });
	await server.start();
	t.after(() => server.close());
	assert.equal(statSync(root).mode & 0o777, 0o700);
	assert.equal(statSync(path).mode & 0o777, 0o600);
	const client = await connectTransport({ serverId, path });
	t.after(() => client.dispose());
	assert.deepEqual(await client.request({ method: "echo", params: { text: "hello" } }), { text: "hello" });
	assert.equal(await client.request({ method: "echo" }), undefined);
	await assert.rejects(client.request({ method: "echo", params: { bad: undefined } }), /JSON/);
	assert.equal(client.connected, true);
});

it("refuses a wrong endpoint identity before dispatch", { timeout: 5000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "transport-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "host.sock");
	let calls = 0;
	const server = createTransportServer({ serverId: randomUUID(), path, request: async () => { calls++; return null; } });
	await server.start(); t.after(() => server.close());
	await assert.rejects(connectTransport({ serverId: randomUUID(), path, timeoutMs: 200 }));
	assert.equal(calls, 0);
});

it("hydrates state, publishes updates, and releases connection-owned feeds", { timeout: 5000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "transport-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "host.sock");
	const serverId = randomUUID();
	let publish: (value: unknown) => void = () => {};
	let release: () => void = () => {};
	const released = new Promise<void>((resolve) => { release = resolve; });
	const server = createTransportServer({ serverId, path, request: async () => null, subscribe: (_kind, _token, _peer, callback) => { publish = callback; return { value: { revision: 0 }, close: release }; } });
	await server.start(); t.after(() => server.close());
	const client = await connectTransport({ serverId, path }); t.after(() => client.dispose());
	let next: (value: unknown) => void = () => {};
	const updated = new Promise((resolve) => { next = resolve; });
	const subscription = await client.subscribe("changes", undefined, next);
	assert.deepEqual(subscription.value, { revision: 0 });
	publish({ revision: 1 });
	assert.deepEqual(await updated, { revision: 1 });
	await subscription.dispose();
	await released;
});

it("forwards cancellation and separates remote errors from link loss", { timeout: 5000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "transport-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "host.sock");
	const serverId = randomUUID();
	let started: () => void = () => {};
	let cancelled: () => void = () => {};
	const active = new Promise<void>((resolve) => { started = resolve; });
	const aborted = new Promise<void>((resolve) => { cancelled = resolve; });
	const server = createTransportServer({ serverId, path, request: async (request, _peer, signal) => {
		if (request.method === "error") throw new Error("refused application input");
		started();
		return await new Promise((resolve) => { signal.addEventListener("abort", () => { cancelled(); resolve(null); }, { once: true }); });
	} });
	await server.start(); t.after(() => server.close());
	const client = await connectTransport({ serverId, path }); t.after(() => client.dispose());
	await assert.rejects(client.request({ method: "error" }), /refused application input/);
	assert.equal(client.connected, true);
	const controller = new AbortController();
	const result = client.request({ method: "wait" }, controller.signal);
	await active;
	controller.abort();
	await assert.rejects(result);
	await aborted;
});

 it("preserves remote error codes, reasons, and word-colon messages", { timeout: 5000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "transport-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "host.sock"), serverId = randomUUID();
	const errors = [invalid("input", "field: invalid value"), new ChordError("unavailable", "version: unsupported", { reason: "version" }), new ChordError("unavailable", "claim: occupied", { reason: "claim" }), new Error("internal: failure")];
	const server = createTransportServer({ serverId, path, request: async (request) => { throw errors[Number(request.params)]; } });
	await server.start(); t.after(() => server.close());
	const client = await connectTransport({ serverId, path }); t.after(() => client.dispose());
	for (const [index, reason] of ["input", "version", "claim", "internal"].entries()) {
		await assert.rejects(client.request({ method: "error", params: index }), (error: unknown) => {
			assert.ok(error instanceof ChordError);
			assert.equal(error.code, index === 0 ? "invalid" : "unavailable");
			assert.equal(error.reason, reason);
			assert.ok(error.message.endsWith(errors[index].message));
			return true;
		});
		assert.equal(client.connected, true);
	}
});

it("rejects refused feed hydration without a pending subscription", { timeout: 3000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "transport-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "host.sock"), serverId = randomUUID();
	const server = createTransportServer({ serverId, path, request: async () => null, subscribe: () => { throw invalid("token", "Unknown observation token"); } });
	await server.start(); t.after(() => server.close());
	const client = await connectTransport({ serverId, path }); t.after(() => client.dispose());
	await assert.rejects(client.subscribe("observation", "missing", () => {}, AbortSignal.timeout(1000)), /Unknown observation token/);
});

it("applies a consumer's smaller frame cap before parsing", { timeout: 3000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "transport-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "host.sock"), serverId = randomUUID();
	const server = createTransportServer({ serverId, path, request: async () => "x".repeat(16000) });
	await server.start(); t.after(() => server.close());
	const client = await connectTransport({ serverId, path, maxFrameBytes: 8192 }); t.after(() => client.dispose());
	await assert.rejects(client.request({ method: "large" }), /bound/);
	assert.equal(client.connected, false);
});

for (const limits of [{ maxFrameBytes: 8192 }, { maxSendFrameBytes: 8192 }, { maxQueueBytes: 8192 }]) it("enforces server-side configured bounds", { timeout: 3000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "transport-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "host.sock"), serverId = randomUUID();
	const server = createTransportServer({ serverId, path, ...limits, request: async () => "x".repeat(16000) });
	await server.start(); t.after(() => server.close());
	const client = await connectTransport({ serverId, path }); t.after(() => client.dispose());
	await assert.rejects(client.request({ method: "large" }));
	assert.equal(client.connected, false);
});

it("supports a larger frame when both peers opt in", { timeout: 5000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "transport-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "host.sock"), serverId = randomUUID();
	const value = "x".repeat(17 * 1024 * 1024);
	const maxFrameBytes = 18 * 1024 * 1024;
	const server = createTransportServer({ serverId, path, maxFrameBytes, request: async () => value });
	await server.start(); t.after(() => server.close());
	const client = await connectTransport({ serverId, path, maxFrameBytes }); t.after(() => client.dispose());
	assert.equal(await client.request({ method: "large" }), value);
});

it("classifies disconnect during negotiation as local transport loss", { timeout: 3000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "transport-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "host.sock"), serverId = randomUUID();
	const server = listenUnixLinks(path, (link) => {
		link.send({ t: "hello", name: `pi.agent:${serverId}`, kind: "host", codeVersion: 1, protocol: 4 });
		link.close("negotiation interrupted");
	});
	await server.start(); t.after(() => server.close());
	await assert.rejects(connectTransport({ serverId, path }), (error) => {
		assert.ok(error instanceof Error);
		assert.equal(error instanceof ChordError, false);
		assert.match(error.message, /closed during connection/);
		return true;
	});
});

it("allows large responses with a smaller independent outgoing frame bound", { timeout: 3000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "transport-")); t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "host.sock"), serverId = randomUUID();
	const value = "x".repeat(16000);
	const server = createTransportServer({ serverId, path, request: async () => value });
	await server.start(); t.after(() => server.close());
	const client = await connectTransport({ serverId, path, maxFrameBytes: 32768, maxSendFrameBytes: 8192 }); t.after(() => client.dispose());
	assert.equal(await client.request({ method: "large" }), value);
	assert.equal(client.connected, true);
});

for (const requestId of [undefined, "same-id"]) it("binds local refusal to one unsent call while an admitted mutation stays uncertain", { timeout: 3000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "transport-")); t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "host.sock"), serverId = randomUUID();
	const admitted: string[] = [];
	let started: () => void = () => {};
	const active = new Promise<void>((resolve) => { started = resolve; });
	const server = createTransportServer({ serverId, path, request: async (request, _peer, signal) => {
		admitted.push(request.method); started();
		return new Promise((resolve) => signal.addEventListener("abort", () => resolve(null), { once: true }));
	} });
	await server.start(); t.after(() => server.close());
	const client = await connectTransport({ serverId, path, maxSendFrameBytes: 8192 }); t.after(() => client.dispose());
	const first = client.request({ method: "mutation", ...(requestId ? { requestId } : {}) });
	const uncertain = assert.rejects(first, (error: unknown) => { assert.ok(error instanceof ChordError); assert.equal(error instanceof LocalTransportRefusal, false); return true; });
	await active;
	await assert.rejects(client.request({ method: "mutation", params: "x".repeat(16000), ...(requestId ? { requestId } : {}) }), (error: unknown) => {
		assert.ok(error instanceof LocalTransportRefusal);
		assert.equal(error.code, "transport-local-refusal"); assert.equal(error.reason, "frame-limit");
		assert.ok((error.encodedBytes ?? 0) > 8192); return true;
	});
	await uncertain;
	assert.deepEqual(admitted, ["mutation"]);
	assert.equal(client.connected, false);
});

it("correlates concurrent identical requests by invocation rather than payload or application ID", { timeout: 3000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "transport-")); t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "host.sock"), serverId = randomUUID();
	const server = createTransportServer({ serverId, path, request: async (request) => request.params });
	await server.start(); t.after(() => server.close());
	const client = await connectTransport({ serverId, path, maxSendFrameBytes: 8192 }); t.after(() => client.dispose());
	const results = await Promise.all(Array.from({ length: 8 }, () => client.request({ method: "echo", requestId: "same", params: { text: "same" } })));
	assert.deepEqual(results, Array.from({ length: 8 }, () => ({ text: "same" })));
});

it("attributes queue refusal to the second of concurrent identical calls", { timeout: 3000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "transport-")); t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "host.sock"), serverId = randomUUID();
	const server = createTransportServer({ serverId, path, request: async (request) => request.params });
	await server.start(); t.after(() => server.close());
	const client = await connectTransport({ serverId, path, maxQueueBytes: 4096 }); t.after(() => client.dispose());
	const request = { method: "mutation", requestId: "same", params: "x".repeat(3000) };
	const [first, second] = await Promise.allSettled([client.request(request), client.request(request)]);
	assert.equal(first.status, "rejected"); assert.equal(second.status, "rejected");
	if (first.status !== "rejected" || second.status !== "rejected") return;
	assert.equal(first.reason instanceof LocalTransportRefusal, false);
	assert.ok(second.reason instanceof LocalTransportRefusal);
	assert.equal(second.reason.reason, "queue-limit");
});

for (const failure of ["sync", "async"] as const) it(`keeps ${failure} socket write failure uncertain for the exact request`, { timeout: 3000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "transport-")); t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "host.sock"), serverId = randomUUID();
	const server = createTransportServer({ serverId, path, request: async () => null });
	await server.start(); t.after(() => server.close());
	const client = await connectTransport({ serverId, path }); t.after(() => client.dispose());
	const write = Socket.prototype.write;
	t.mock.method(Socket.prototype, "write", function (this: Socket, data: unknown, ...args: unknown[]) {
		if (typeof data === "string" && data.includes('"method":"fail-write"')) {
			if (failure === "sync") throw new Error("write interrupted");
			const callback = args.find((value) => typeof value === "function") as (error: Error) => void;
			queueMicrotask(() => callback(new Error("write interrupted")));
			return false;
		}
		return Reflect.apply(write, this, [data, ...args]);
	});
	await assert.rejects(client.request({ method: "fail-write" }), (error: unknown) => { assert.ok(error instanceof ChordError); assert.equal(error instanceof LocalTransportRefusal, false); return true; });
});

for (const frame of [{ t: "root_end", rootId: "cleanup" }, { t: "cancel", id: 1 }, { t: "call", id: 1, hold: 1, member: "other", args: {} }, { t: "call", id: 1, hold: 9999, member: "request", args: {} }] as const) {
	it(`keeps a ${frame.t}/${"member" in frame ? frame.member : "control"} refusal within the request context uncertain`, { timeout: 3000 }, async (t) => {
		const root = mkdtempSync(join(tmpdir(), "transport-")); t.after(() => rmSync(root, { recursive: true, force: true }));
		const path = join(root, "host.sock"), serverId = randomUUID();
		const server = createTransportServer({ serverId, path, request: async () => null });
		await server.start(); t.after(() => server.close());
		const client = await connectTransport({ serverId, path }); t.after(() => client.dispose());
		// Inject at the host boundary to exercise non-request emission in the same async scope.
		const internals = client as unknown as { link: UnixLink };
		const send = internals.link.send.bind(internals.link);
		t.mock.method(internals.link, "send", (outgoing: Frame) => {
			if (outgoing.t === "call" && outgoing.member === "request") {
				const refused = frame.t === "call" ? { ...frame, args: "x".repeat(17 * 1024 * 1024) } : frame;
				if (refused.t === "call") send(refused);
				else send(Object.assign({}, refused, { padding: "x".repeat(17 * 1024 * 1024) }) as Frame);
			} else send(outgoing);
		});
		await assert.rejects(client.request({ method: "echo" }), (error: unknown) => { assert.equal(error instanceof LocalTransportRefusal, false); assert.ok(error instanceof ChordError); return true; });
	});
}
