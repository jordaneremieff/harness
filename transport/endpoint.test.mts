import assert from "node:assert/strict";
import { ChordError, PluginError, binaryCodec, invalid } from "@earendil-works/chord";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { randomUUID } from "node:crypto";
import { Socket } from "node:net";
import { connectTransport, createTransportServer } from "./endpoint.ts";
import { listenUnixLinks } from "./unix-link.ts";

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

it("keeps feed hydration independent of the connection deadline", { timeout: 3000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "transport-")); t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "host.sock"), serverId = randomUUID();
	const server = createTransportServer({ serverId, path, request: async () => null, subscribe: async () => {
		await new Promise<void>((resolve) => AbortSignal.timeout(750).addEventListener("abort", () => resolve(), { once: true }));
		return { value: "ready", close: () => {} };
	} });
	await server.start(); t.after(() => server.close());
	const client = await connectTransport({ serverId, path, timeoutMs: 500 }); t.after(() => client.dispose());
	const subscription = await client.subscribe("observation", "token", () => {});
	assert.equal(subscription.value, "ready");
	await subscription.dispose();
});

interface Observation { revision: number; entries: { id: number; text: string }[]; live: { text: string }[]; coverage: { complete: boolean } }

for (const kind of ["changes", "observation"] as const) it(`publishes ${kind} feed updates as forced structural diffs that reconstruct the exact state`, { timeout: 5000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "transport-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "host.sock"), serverId = randomUUID();
	let latest: Observation = { revision: 0, entries: [{ id: 1, text: "unchanged history ".repeat(1000) }], live: [{ text: "initial live text" }], coverage: { complete: true } };
	let publish: (value: unknown) => void = () => {};
	const server = createTransportServer({ serverId, path, request: async () => null, subscribe: (_kind, _token, _peer, callback) => {
		publish = callback;
		return { value: latest, close: () => {} };
	} });
	await server.start(); t.after(() => server.close());
	const client = await connectTransport({ serverId, path }); t.after(() => client.dispose());
	const opsWrites: string[] = [];
	const write = Socket.prototype.write as unknown as (this: Socket, data: unknown, ...args: unknown[]) => boolean;
	t.mock.method(Socket.prototype, "write", function (this: Socket, data: unknown, ...args: unknown[]) {
		if (data instanceof Uint8Array && Buffer.from(data).includes(Buffer.from("appended text"))) opsWrites.push(Buffer.from(data).toString("utf8"));
		return Reflect.apply(write, this, [data, ...args]);
	});
	let nextArrived: () => void = () => {};
	const updates: Observation[] = [];
	const subscription = await client.subscribe(kind, undefined, (value) => { updates.push(value as Observation); nextArrived(); });
	const baseline = subscription.value as Observation;
	assert.deepEqual(baseline, latest);
	for (let revision = 1; revision <= 3; revision++) {
		const arrived = new Promise<void>((resolve) => { nextArrived = resolve; });
		latest = structuredClone(latest);
		latest.revision = revision;
		latest.live[0].text += ` appended text ${revision}`;
		publish(latest);
		await arrived;
		const rebuilt = updates.at(-1);
		assert.ok(rebuilt);
		assert.deepEqual(rebuilt, latest);
		assert.strictEqual(rebuilt.entries, baseline.entries);
		assert.strictEqual(rebuilt.entries[0], baseline.entries[0]);
		assert.strictEqual(rebuilt.coverage, baseline.coverage);
	}
	assert.equal(updates.length, 3);
	const ops = opsWrites;
	assert.equal(ops.length, 3);
	assert.ok(ops.some((encoded) => encoded.includes("revision")));
	for (const encoded of ops) {
		assert.ok(encoded.includes("appended text"));
		assert.equal(encoded.includes("unchanged history"), false);
		assert.equal(encoded.includes("initial live text"), false);
		assert.equal(encoded.includes('"entries"'), false);
	}
	await subscription.dispose();
	await client.dispose();
	const reconnected = await connectTransport({ serverId, path }); t.after(() => reconnected.dispose());
	const snapshot = await reconnected.subscribe(kind, undefined, () => {});
	assert.deepEqual(snapshot.value, latest);
	assert.notStrictEqual((snapshot.value as Observation).entries, baseline.entries);
	await snapshot.dispose();
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
	const errors = [invalid("args", "field: invalid value"), new ChordError({ code: "unavailable", reason: "version", message: "version: unsupported" }), new PluginError("claim", "claim: occupied"), new Error("internal: failure")];
	const server = createTransportServer({ serverId, path, request: async (request) => { throw errors[Number(request.params)]; } });
	await server.start(); t.after(() => server.close());
	const client = await connectTransport({ serverId, path }); t.after(() => client.dispose());
	for (const [index, reason] of ["args", "version", "claim", "internal"].entries()) {
		await assert.rejects(client.request({ method: "error", params: index }), (error: unknown) => {
			assert.ok(error instanceof ChordError || error instanceof PluginError);
			assert.equal(error.code, index === 0 ? "invalid" : index === 1 ? "unavailable" : reason);
			if (error instanceof ChordError) assert.equal(error.reason, reason);
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
	const server = createTransportServer({ serverId, path, request: async () => null, subscribe: () => { throw invalid("args", "Unknown observation token"); } });
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
		link.close("negotiation interrupted");
	}, { name: `pi.agent:${serverId}` });
	await server.start(); t.after(() => server.close());
	await assert.rejects(connectTransport({ serverId, path }), (error) => {
		assert.ok(error instanceof Error);
		assert.equal(error instanceof ChordError, false);
		assert.match(error.message, /closed during connection|peer ended|socket closed/);
		return true;
	});
});

it("retains the Chord protocol mismatch reason during connection", { timeout: 3000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "transport-")); t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "host.sock"), serverId = randomUUID();
	const server = listenUnixLinks(path, (link) => {
		link.send(binaryCodec.encode({ kind: "hello", protocol: 999, incarnation: randomUUID(), calls: 1 }));
	}, { name: `pi.agent:${serverId}` });
	await server.start(); t.after(() => server.close());
	await assert.rejects(connectTransport({ serverId, path }), /handshake: protocol 999, this host speaks/);
});

it("retains a live protocol error in request failures and close notifications", { timeout: 3000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "transport-")); t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "host.sock"), serverId = randomUUID();
	const server = createTransportServer({ serverId, path, request: async () => "protocol-trigger" });
	await server.start(); t.after(() => server.close());
	const client = await connectTransport({ serverId, path }); t.after(() => client.dispose());
	const hello = binaryCodec.encode({ kind: "hello", protocol: 999, incarnation: randomUUID(), calls: 1 });
	const duplicate = Buffer.alloc(4 + hello.length); duplicate.writeUInt32BE(hello.length); duplicate.set(hello, 4);
	const write = Socket.prototype.write;
	t.mock.method(Socket.prototype, "write", function (this: Socket, data: unknown, ...args: unknown[]) {
		if (data instanceof Uint8Array && Buffer.from(data).includes(Buffer.from("protocol-trigger"))) data = duplicate;
		return Reflect.apply(write, this, [data, ...args]);
	});
	let onClosed = (_reason: string) => {};
	const closed = new Promise<string>((resolve) => { onClosed = resolve; });
	client.onClose(onClosed);
	await assert.rejects(client.request({ method: "echo" }), /hello/);
	assert.match(await closed, /hello/);
	await assert.rejects(client.request({ method: "after-close" }), /hello/);
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

for (const requestId of [undefined, "same-id"]) it("rejects an oversized call and interrupted admitted work without a hang", { timeout: 3000 }, async (t) => {
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
	const uncertain = assert.rejects(first, (error: unknown) => { assert.ok(error instanceof ChordError);  return true; });
	await active;
	await assert.rejects(client.request({ method: "mutation", params: "x".repeat(16000), ...(requestId ? { requestId } : {}) }), (error: unknown) => {
		assert.ok(error instanceof Error); assert.match(error.message, /bound|link closed/); return true;
	});
	await uncertain;
	assert.deepEqual(admitted, ["mutation"]);
	assert.equal(client.connected, false);
});

it("serves concurrent identical requests independently", { timeout: 3000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "transport-")); t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "host.sock"), serverId = randomUUID();
	const server = createTransportServer({ serverId, path, request: async (request) => request.params });
	await server.start(); t.after(() => server.close());
	const client = await connectTransport({ serverId, path, maxSendFrameBytes: 8192 }); t.after(() => client.dispose());
	const results = await Promise.all(Array.from({ length: 8 }, () => client.request({ method: "echo", requestId: "same", params: { text: "same" } })));
	assert.deepEqual(results, Array.from({ length: 8 }, () => ({ text: "same" })));
});

it("rejects concurrent calls promptly when the socket outbox exceeds its bound", { timeout: 3000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "transport-")); t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "host.sock"), serverId = randomUUID();
	const server = createTransportServer({ serverId, path, request: async (request) => request.params });
	await server.start(); t.after(() => server.close());
	const client = await connectTransport({ serverId, path, maxQueueBytes: 4096 }); t.after(() => client.dispose());
	const request = { method: "mutation", requestId: "same", params: "x".repeat(3000) };
	const [first, second] = await Promise.allSettled([client.request(request), client.request(request)]);
	assert.equal(first.status, "rejected"); assert.equal(second.status, "rejected");
	if (first.status !== "rejected" || second.status !== "rejected") return;
	assert.ok(first.reason instanceof Error); assert.ok(second.reason instanceof Error);
});

for (const failure of ["sync", "async"] as const) it(`keeps ${failure} socket write failure uncertain for the exact request`, { timeout: 3000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "transport-")); t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "host.sock"), serverId = randomUUID();
	const server = createTransportServer({ serverId, path, request: async () => null });
	await server.start(); t.after(() => server.close());
	const client = await connectTransport({ serverId, path }); t.after(() => client.dispose());
	const write = Socket.prototype.write;
	t.mock.method(Socket.prototype, "write", function (this: Socket, data: unknown, ...args: unknown[]) {
		if (data instanceof Uint8Array && Buffer.from(data).includes(Buffer.from('"method":"fail-write"'))) {
			if (failure === "sync") throw new Error("write interrupted");
			const callback = args.find((value) => typeof value === "function") as (error: Error) => void;
			queueMicrotask(() => callback(new Error("write interrupted")));
			return false;
		}
		return Reflect.apply(write, this, [data, ...args]);
	});
	await assert.rejects(client.request({ method: "fail-write" }), (error: unknown) => { assert.ok(error instanceof ChordError);  return true; });
});

it("allows a close listener to dispose during synchronous send refusal", { timeout: 3000 }, async (t) => {
 const root = mkdtempSync(join(tmpdir(), "transport-")); t.after(() => rmSync(root, { recursive: true, force: true }));
 const path = join(root, "host.sock"), serverId = randomUUID();
 const server = createTransportServer({ serverId, path, request: async () => null });
 await server.start(); t.after(() => server.close());
 const client = await connectTransport({ serverId, path, maxSendFrameBytes: 8192 }); t.after(() => client.dispose());
 let disposed: Promise<void> | undefined;
 client.onClose(() => { disposed = client.dispose(); });
 await assert.rejects(client.request({ method: "large", params: "x".repeat(16000) }), /byte bound/);
 assert.ok(disposed); await disposed;
});

it("contains a queued feed publication after release and before subscription cleanup", { timeout: 3000 }, async (t) => {
 const root = mkdtempSync(join(tmpdir(), "transport-")); t.after(() => rmSync(root, { recursive: true, force: true }));
 const path = join(root, "host.sock"), serverId = randomUUID();
 let publish: (value: unknown) => void = () => {};
 let started = () => {}, publishDone = () => {};
 let publishFailed = (_error: unknown) => {};
 const active = new Promise<void>((resolve) => { started = resolve; });
 const published = new Promise<void>((resolve, reject) => { publishDone = resolve; publishFailed = reject; });
 const server = createTransportServer({
  serverId, path,
  subscribe: (_kind, _token, _peer, callback) => { publish = callback; return { value: 0, close: () => {} }; },
  request: async (request, _peer, signal) => {
   if (request.method !== "wait") return null;
   started();
   return new Promise((resolve) => signal.addEventListener("abort", () => {
    try { publish(1); publishDone(); } catch (error) { publishFailed(error); }
    resolve(null);
   }, { once: true }));
  },
 });
 await server.start(); t.after(() => server.close());
 const client = await connectTransport({ serverId, path }); t.after(() => client.dispose());
 const subscription = await client.subscribe("changes", undefined, () => {});
 const controller = new AbortController();
 const pending = client.request({ method: "wait" }, controller.signal); await active;
 const rejected = assert.rejects(pending);
 await subscription.dispose(); controller.abort();
 await Promise.all([rejected, published]);
 assert.equal(client.connected, true);
 assert.equal(await client.request({ method: "alive" }), null);
});
