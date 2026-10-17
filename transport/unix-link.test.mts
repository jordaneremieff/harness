import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, lstatSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import type { Frame } from "@earendil-works/chord";
import { createUnixLink, listenUnixLinks, unixSocketPath, UNIX_FRAME_BYTES, type UnixLinkOptions } from "./index.ts";

async function pair(t: TestContext, options: Partial<UnixLinkOptions> = {}) {
	const root = mkdtempSync(join(tmpdir(), "unix-link-"));
	const path = join(root, "socket");
	const server = createServer();
	server.listen(path); await once(server, "listening");
	const incoming = once(server, "connection");
	const socket = createConnection(path); await once(socket, "connect");
	const [peer] = await incoming as [Socket];
	const link = createUnixLink(socket, { expectedKind: "host", expectedName: "test", ...options });
	t.after(async () => { socket.destroy(); peer.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); });
	return { link, peer, socket };
}
const hello = { t: "hello", kind: "host", name: "test", codeVersion: 1, protocol: 4 } as const;
const line = (frame: unknown) => `${JSON.stringify(frame)}\n`;

it("forwards queued hello and fragmented UTF-8 frames in order", { timeout: 3000 }, async (t) => {
	const { link, peer } = await pair(t);
	peer.write(line(hello));
	const frame = { t: "result", id: 1, value: "a😀\n\u0000" } as const;
	const bytes = Buffer.from(line(frame));
	for (const byte of bytes) peer.write(Buffer.from([byte]));
	const frames: Frame[] = [];
	await new Promise<void>((resolve) => link.receive((value) => { frames.push(value); if (frames.length === 2) resolve(); }));
	assert.deepEqual(frames, [hello, frame]);
});

it("sends bye on close and ignores sends after close", { timeout: 3000 }, async (t) => {
	const { link, peer } = await pair(t);
	let wire = "";
	peer.on("data", (chunk) => { wire += chunk.toString(); });
	const ended = once(peer, "end");
	link.close("done");
	link.send(hello);
	await ended;
	assert.equal(wire, line({ t: "bye", reason: "done" }));
	assert.equal(link.closed, true);
});

it("swallows peer bye and reports one close", { timeout: 3000 }, async (t) => {
	const { link, peer } = await pair(t);
	const frames: Frame[] = [];
	link.receive((frame) => frames.push(frame));
	const reason = new Promise<string>((resolve) => link.onClose(resolve));
	peer.write(line(hello) + line({ t: "bye", reason: "stop" }));
	assert.equal(await reason, "stop");
	assert.deepEqual(frames, [hello]);
});

for (const [name, data, options] of [
	["malformed JSON", "not json\n", {}],
	["wrong identity", line({ ...hello, name: "wrong" }), {}],
	["wrong kind", line({ ...hello, kind: "client" }), {}],
	["unsafe epoch", line({ ...hello, epoch: Number.MAX_SAFE_INTEGER + 1 }), {}],
	["oversized input", "x".repeat(65), { maxFrameBytes: 64 }],
	["invalid UTF-8", Buffer.from([0xff, 10]), {}],
] as const) {
	it(`closes on ${name} before dispatch`, { timeout: 3000 }, async (t) => {
		const { link, peer } = await pair(t, options);
		let calls = 0;
		link.receive(() => { calls++; });
		const closed = new Promise<void>((resolve) => link.onClose(() => resolve()));
		peer.write(data);
		await closed;
		assert.equal(calls, 0);
	});
}

for (const options of [{ maxFrameBytes: 64 }, { maxQueueBytes: 64 }]) {
	it("closes on output overflow without throwing or sending a partial frame", { timeout: 3000 }, async (t) => {
		const { link, peer } = await pair(t, options);
		let bytes = 0;
		peer.on("data", (chunk) => { bytes += chunk.length; });
		const ended = once(peer, "end");
		assert.doesNotThrow(() => link.send({ t: "result", id: 1, value: "x".repeat(100) }));
		assert.equal(link.closed, true);
		await ended;
		assert.equal(bytes, 0);
	});
}

it("refuses an existing listener without unlinking its endpoint", { timeout: 3000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "unix-owner-"));
	const path = join(root, "socket");
	const owner = listenUnixLinks(path, () => {});
	await owner.start();
	t.after(async () => { await owner.close(); rmSync(root, { recursive: true, force: true }); });
	const identity = lstatSync(path);
	const other = listenUnixLinks(path, () => {});
	await assert.rejects(other.start(), /already exists/);
	await other.close();
	assert.equal(lstatSync(path).ino, identity.ino);
});

 it("keeps a replacement endpoint on listener shutdown", { timeout: 3000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "unix-replace-"));
	const path = join(root, "socket");
	const first = listenUnixLinks(path, () => {});
	await first.start();
	unlinkSync(path);
	const second = listenUnixLinks(path, () => {});
	await second.start();
	t.after(async () => { await first.close(); await second.close(); rmSync(root, { recursive: true, force: true }); });
	const identity = lstatSync(path);
	await first.close();
	assert.equal(lstatSync(path).ino, identity.ino);
});

it("uses a bounded distinct socket path for deep roots", () => {
	const first = unixSocketPath("server", `/a/${"x".repeat(200)}`);
	const second = unixSocketPath("server", `/b/${"x".repeat(200)}`);
	assert.ok(Buffer.byteLength(first) <= 100);
	assert.notEqual(first, second);
	assert.equal(first, unixSocketPath("server", `/a/${"x".repeat(200)}`));
});

it("round-trips the maximum supported frame with JSON escape expansion", { timeout: 30000 }, async (t) => {
	const { link, peer } = await pair(t);
	const remote = createUnixLink(peer, { expectedKind: "client" });
	link.send({ ...hello, kind: "client" });
	remote.send(hello);
	const payloadBytes = UNIX_FRAME_BYTES - Buffer.byteLength(JSON.stringify({ t: "result", id: 1, value: "" }));
	const controls = Math.floor(payloadBytes / 6);
	const remainder = payloadBytes % 6;
	const result = new Promise<void>((resolve) => remote.receive((frame) => {
		if (frame.t !== "result") return;
		assert.equal(typeof frame.value, "string");
		assert.equal((frame.value as string).length, controls + remainder);
		assert.equal((frame.value as string).charCodeAt(0), 0);
		resolve();
	}));
	link.send({ t: "result", id: 1, value: "\u0000".repeat(controls) + "x".repeat(remainder) });
	await result;
	assert.equal(link.closed, false);
	assert.doesNotThrow(() => link.send({ t: "result", id: 1, value: "\u0000".repeat(controls) + "x".repeat(remainder + 1) }));
	assert.equal(link.closed, true);
});

it("bounds encoded bytes before receiver registration", { timeout: 3000 }, async (t) => {
	const { link, peer } = await pair(t, { maxQueueBytes: 128 });
	const closed = new Promise<string>((resolve) => link.onClose(resolve));
	peer.write(line(hello) + line({ t: "ping", id: 1 }).repeat(256));
	assert.match(await closed, /receive queue/);
});

it("bounds writes when a real socket reader stalls", { timeout: 3000 }, async (t) => {
	const { link, peer } = await pair(t, { maxFrameBytes: 65536, maxQueueBytes: 131072 });
	peer.pause();
	let reason = "";
	link.onClose((value) => { reason = value; });
	for (let id = 1; id <= 256 && !link.closed; id++) link.send({ t: "result", id, value: "x".repeat(32768) });
	assert.equal(link.closed, true);
	assert.match(reason, /write queue/);
});

it("queues more than 256 small frames within the byte bound", { timeout: 3000 }, async (t) => {
	const { link, peer, socket } = await pair(t);
	const input = line(hello) + line({ t: "ping", id: 1 }).repeat(300);
	const received = new Promise<void>((resolve) => {
		let bytes = 0;
		socket.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes === Buffer.byteLength(input)) resolve(); });
	});
	peer.write(input);
	await received;
	assert.equal(link.closed, false);
	const frames: Frame[] = [];
	link.receive((frame) => frames.push(frame));
	assert.equal(frames.length, 301);
	assert.deepEqual(frames[0], hello);
});
