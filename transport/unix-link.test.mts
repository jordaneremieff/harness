import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, lstatSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { createUnixLink, connectUnixLink, listenUnixLinks, unixSocketPath, UNIX_FRAME_BYTES, UNIX_TRANSPORT_FORMAT, type UnixLinkOptions } from "./unix-link.ts";

async function pair(t: TestContext, options: Partial<UnixLinkOptions> = {}) {
	const root = mkdtempSync(join(tmpdir(), "unix-link-")), path = join(root, "socket");
	const server = createServer(); server.listen(path); await once(server, "listening");
	const incoming = once(server, "connection");
	const socket = createConnection(path); await once(socket, "connect");
	const [peer] = await incoming as [Socket]; peer.on("error", () => {});
	const link = createUnixLink(socket, { expectedKind: "host", expectedName: "test", ...options });
	t.after(async () => { link.close(); socket.destroy(); peer.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); });
	return { link, peer, socket };
}
const identity = (patch = {}) => Buffer.from(`${JSON.stringify({ transport: UNIX_TRANSPORT_FORMAT, kind: "host", name: "test", ...patch })}\n`);
function packet(bytes: Uint8Array): Buffer { const result = Buffer.alloc(bytes.length + 4); result.writeUInt32BE(bytes.length); result.set(bytes, 4); return result; }
const message = Buffer.from("a😀\n\u0000");

it("forwards queued byte messages and fragmented headers in order", { timeout: 3000 }, async (t) => {
	const { link, peer } = await pair(t);
	peer.write(identity());
	for (const byte of Buffer.concat([packet(message), packet(Buffer.from("second"))])) peer.write(Buffer.from([byte]));
	const messages: Uint8Array[] = [];
	await new Promise<void>((resolve) => link.onMessage((value) => { messages.push(value); if (messages.length === 2) resolve(); }));
	assert.deepEqual(messages.map((bytes) => Buffer.from(bytes).toString()), ["a😀\n\u0000", "second"]);
});
it("closes once and ignores sends after close", { timeout: 3000 }, async (t) => {
	const { link, peer } = await pair(t); let closes = 0; link.onClose(() => closes++);
	const ended = once(peer, "end"); peer.resume(); link.close("done"); link.close(); link.send(message); await ended;
	assert.equal(link.reason, "done"); assert.equal(closes, 1); assert.equal(link.closed, true);
});
for (const [name, data] of [
	["malformed identity", Buffer.from("not json\n")],
	["wrong identity", identity({ name: "wrong" })],
	["wrong kind", identity({ kind: "client" })],
	["wrong transport format", identity({ transport: "other" })],
	["unknown identity fields", identity({ extra: true })],
	["oversized identity", Buffer.from("x".repeat(1025))],
	["invalid identity UTF-8", Buffer.from([0xff, 10])],
] as const) it(`closes on ${name} before dispatch`, { timeout: 3000 }, async (t) => {
	const { link, peer } = await pair(t); let calls = 0; link.onMessage(() => calls++);
	const closed = new Promise<void>((resolve) => link.onClose(resolve)); peer.write(data); await closed;
	assert.equal(calls, 0); assert.match(link.reason, /identity/);
});
it("refuses an old peer before admission without opening storage", { timeout: 3000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "unix-mixed-")), path = join(root, "socket");
	let admissions = 0;
	const server = listenUnixLinks(path, () => { admissions++; }); await server.start();
	t.after(async () => { await server.close(); rmSync(root, { recursive: true, force: true }); });
	const old = createConnection(path); old.on("error", () => {}); t.after(() => old.destroy());
	old.write(`${JSON.stringify({ t: "hello", kind: "client", name: "old", protocol: 4, codeVersion: 1 })}\n`);
	let received = ""; old.on("data", (chunk) => { received += chunk.toString(); });
	await once(old, "close");
	assert.match(received, /harness.chord\/2/); assert.equal(admissions, 0);
});
it("refuses a current client at an old server with a bounded incompatible-format error", { timeout: 3000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "unix-mixed-")), path = join(root, "socket");
	let received = "";
	const server = createServer((socket) => {
		socket.on("error", () => {});
		socket.on("data", (chunk) => { received += chunk.toString(); });
		socket.write(`${JSON.stringify({ t: "hello", kind: "host", name: "test", protocol: 4, codeVersion: 1 })}\n`);
	}); server.listen(path); await once(server, "listening");
	t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); });
	await assert.rejects(connectUnixLink(path, { expectedKind: "host", expectedName: "test", signal: AbortSignal.timeout(1000) }), /identity handshake failed: incompatible format/);
	assert.equal(received.includes('"t":"call"'), false);
});
it("bounds a silent identity handshake", { timeout: 8000 }, async (t) => {
	const { link } = await pair(t);
	await assert.rejects(link.ready, /identity handshake timed out/);
	assert.equal(link.closed, true);
});
it("rejects a received length before allocating its payload", { timeout: 3000 }, async (t) => {
	const { link, peer } = await pair(t, { maxFrameBytes: 64 });
	const closed = new Promise<void>((resolve) => link.onClose(resolve));
	const header = Buffer.alloc(4); header.writeUInt32BE(65); peer.write(Buffer.concat([identity(), header]));
	await closed; assert.match(link.reason, /byte bound/);
});
for (const options of [{ maxFrameBytes: 64 }, { maxQueueBytes: 64 }]) it("refuses output before writing a partial message", { timeout: 3000 }, async (t) => {
	const { link, peer } = await pair(t, options); let received = Buffer.alloc(0);
	peer.on("data", (chunk: Buffer) => { received = Buffer.concat([received, chunk]); });
	const ended = once(peer, "end"); assert.doesNotThrow(() => link.send(Buffer.alloc(100))); await ended;
	assert.equal(link.closed, true); assert.equal(received.toString().split("\n").length, 2);
	assert.equal(received[received.length - 1], 10);
});
it("refuses an existing listener without unlinking its endpoint", { timeout: 3000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "unix-owner-")), path = join(root, "socket");
	const owner = listenUnixLinks(path, () => {}); await owner.start();
	t.after(async () => { await owner.close(); rmSync(root, { recursive: true, force: true }); });
	const before = lstatSync(path); const other = listenUnixLinks(path, () => {});
	await assert.rejects(other.start(), /already exists/); await other.close(); assert.equal(lstatSync(path).ino, before.ino);
});
it("keeps a replacement endpoint on listener shutdown", { timeout: 3000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "unix-replace-")), path = join(root, "socket");
	const first = listenUnixLinks(path, () => {}); await first.start(); unlinkSync(path);
	const second = listenUnixLinks(path, () => {}); await second.start();
	t.after(async () => { await first.close(); await second.close(); rmSync(root, { recursive: true, force: true }); });
	const before = lstatSync(path); await first.close(); assert.equal(lstatSync(path).ino, before.ino);
});
it("uses a bounded distinct socket path for deep roots", () => {
	const first = unixSocketPath("server", `/a/${"x".repeat(200)}`), second = unixSocketPath("server", `/b/${"x".repeat(200)}`);
	assert.ok(Buffer.byteLength(first) <= 100); assert.notEqual(first, second); assert.equal(first, unixSocketPath("server", `/a/${"x".repeat(200)}`));
});
it("round-trips the maximum payload and refuses one extra byte", { timeout: 10000 }, async (t) => {
	const { link, peer } = await pair(t); const remote = createUnixLink(peer, { expectedKind: "client", name: "test" });
	await Promise.all([link.ready, remote.ready]);
	const received = new Promise<Uint8Array>((resolve) => remote.onMessage(resolve));
	link.send(Buffer.alloc(UNIX_FRAME_BYTES, 7)); assert.equal((await received).byteLength, UNIX_FRAME_BYTES);
	assert.equal(link.closed, false); link.send(Buffer.alloc(UNIX_FRAME_BYTES + 1)); assert.equal(link.closed, true);
});
it("bounds bytes before receiver registration", { timeout: 3000 }, async (t) => {
	const { link, peer } = await pair(t, { maxQueueBytes: 128 }); const closed = new Promise<void>((resolve) => link.onClose(resolve));
	peer.write(Buffer.concat([identity(), ...Array.from({ length: 256 }, () => packet(message))]));
	await closed; assert.match(link.reason, /receive queue/);
});
it("bounds writes when a socket reader stalls", { timeout: 3000 }, async (t) => {
	const { link, peer } = await pair(t, { maxFrameBytes: 65536, maxQueueBytes: 131072 }); peer.pause();
	for (let index = 0; index < 256 && !link.closed; index++) link.send(Buffer.alloc(32768));
	assert.equal(link.closed, true); assert.match(link.reason, /write queue/);
});
it("queues more than 256 small messages within the byte bound", { timeout: 3000 }, async (t) => {
	const { link, peer, socket } = await pair(t);
	const input = Buffer.concat([identity(), ...Array.from({ length: 300 }, () => packet(message))]);
	const received = new Promise<void>((resolve) => { let bytes = 0; socket.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes === input.length) resolve(); }); });
	peer.write(input); await received;
	const messages: Uint8Array[] = []; link.onMessage((value) => messages.push(value));
	assert.equal(link.closed, false); assert.equal(messages.length, 300); assert.deepEqual(messages[0], message);
});
