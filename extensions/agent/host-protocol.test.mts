import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import {
	HOST_MAX_FRAME_BYTES,
	HOST_SOCKET_PATH_LIMIT_BYTES,
	HOST_PROTOCOL_VERSION,
	HostError,
	HostFrameDecoder,
	encodeHostFrame,
	formatHostReady,
	hostPaths,
	isCancelableHostWait,
	isRetrySafeHostMethod,
	parseHostClientMessage,
	parseHostEndpoint,
	parseHostMetadata,
	parseHostReadyLine,
	parseHostServerMessage,
} from "./host-protocol.ts";

const metadata = {
	storageId: "storage-1",
	cwd: "/tmp/project",
	agentDir: "/tmp/agent",
	packageDir: "/tmp/package",
	storagePath: "/tmp/storage.sqlite",
	model: { provider: "fixture", modelId: "model-1" },
	thinkingLevel: "off",
	name: "host",
	trust: true,
	ownerId: "owner-1",
};

it("parses complete metadata and keeps optional identity fields absent", () => {
	const complete = parseHostMetadata(metadata);
	assert.deepEqual(complete, metadata);
	const minimal = parseHostMetadata({ ...metadata, name: undefined, trust: undefined, ownerId: undefined });
	assert.equal(minimal.name, undefined);
	assert.equal(minimal.trust, undefined);
	assert.equal(minimal.ownerId, undefined);
});

it("refuses malformed metadata", () => {
	const cases: Array<[string, unknown]> = [
		["not an object", "metadata"],
		["unsupported field", { ...metadata, extra: true }],
		["empty storageId", { ...metadata, storageId: "" }],
		["relative cwd", { ...metadata, cwd: "project" }],
		["relative storagePath", { ...metadata, storagePath: "storage.sqlite" }],
		["missing model", { ...metadata, model: undefined }],
		["extra model field", { ...metadata, model: { provider: "fixture", modelId: "model-1", extra: true } }],
		["empty thinkingLevel", { ...metadata, thinkingLevel: "" }],
		["non-boolean trust", { ...metadata, trust: "yes" }],
		["control characters", { ...metadata, name: "bad\u0000name" }],
	];
	for (const [label, value] of cases) assert.throws(() => parseHostMetadata(value), `${label} is refused`);
});

it("round-trips frames and decodes split and combined chunks", () => {
	const hello = { kind: "hello", version: HOST_PROTOCOL_VERSION, token: "token", metadata: parseHostMetadata(metadata) } as const;
	const response = { kind: "response", id: "1", ok: true, result: { value: 3 } } as const;
	const first = encodeHostFrame(hello);
	const second = encodeHostFrame(response);
	const decoder = new HostFrameDecoder();
	assert.deepEqual(decoder.push(first.subarray(0, 3)), []);
	assert.deepEqual(decoder.push(first.subarray(3)), [hello]);
	assert.deepEqual(decoder.push(Buffer.concat([second, second])), [response, response]);
});

it("refuses an oversized declaration and malformed JSON", () => {
	const oversized = Buffer.alloc(4);
	oversized.writeUInt32BE(HOST_MAX_FRAME_BYTES + 1, 0);
	assert.throws(() => new HostFrameDecoder().push(oversized), RangeError);
	const malformed = Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from("{")]);
	assert.throws(() => new HostFrameDecoder().push(malformed), /valid JSON/u);
});

it("parses client and server messages strictly", () => {
	const hello = parseHostClientMessage({ kind: "hello", version: HOST_PROTOCOL_VERSION, token: "token", metadata });
	assert.equal(hello.kind, "hello");
	const request = parseHostClientMessage({ kind: "request", id: "r1", method: "inspect", params: { a: 1 } });
	assert.deepEqual(request, { kind: "request", id: "r1", method: "inspect", params: { a: 1 } });
	assert.throws(() => parseHostClientMessage({ kind: "welcome", version: 1, pid: 1, storageId: "s", socketPath: "/tmp/s" }));
	assert.throws(() => parseHostClientMessage({ kind: "request", id: "", method: "inspect" }));
	const welcome = parseHostServerMessage({ kind: "welcome", version: HOST_PROTOCOL_VERSION, pid: 42, storageId: "storage-1", socketPath: "/tmp/agent/host.sock" });
	assert.equal(welcome.kind, "welcome");
	const failure = parseHostServerMessage({ kind: "response", id: "r1", ok: false, error: { message: "no", code: "invalid" } });
	assert.equal(failure.kind === "response" && failure.ok === false ? failure.error.code : undefined, "invalid");
	assert.throws(() => parseHostServerMessage({ kind: "response", id: "r1", ok: false, error: { message: "no", code: "other" } }));
	assert.throws(() => parseHostServerMessage({ kind: "response", id: "r1", ok: "yes" }));
});

it("derives stable host paths and a short socket path for a deep agent directory", () => {
	const first = hostPaths(metadata);
	const second = hostPaths(metadata);
	assert.deepEqual(first, second);
	assert.ok(first.claim.startsWith(join(first.directory, ".claims")));
	const other = hostPaths({ ...metadata, storageId: "storage-2" });
	assert.notEqual(other.directory, first.directory);
	const deep = hostPaths({ ...metadata, agentDir: join("/tmp", "d".repeat(180)) });
	assert.ok(Buffer.byteLength(deep.socket, "utf8") <= HOST_SOCKET_PATH_LIMIT_BYTES);
	assert.ok(deep.socket.startsWith(tmpdir()));
	assert.notEqual(deep.directory, first.directory);
});

it("classifies retry-safe methods", () => {
	for (const method of ["submit", "report", "acknowledge", "inspect", "status", "list", "receipts", "dashboard", "snapshot"]) assert.equal(isRetrySafeHostMethod(method), true, method);
	for (const method of ["abort", "compact", "configure", "command", "fork", "rewind", "unknown"]) assert.equal(isRetrySafeHostMethod(method), false, method);
});

it("parses a cancel frame and classifies cancelable waits", () => {
	assert.deepEqual(parseHostClientMessage({ kind: "cancel", id: "w1" }), { kind: "cancel", id: "w1" });
	assert.throws(() => parseHostClientMessage({ kind: "cancel", id: "" }));
	assert.equal(isCancelableHostWait("receipts", { wait: true }), true);
	assert.equal(isCancelableHostWait("receipts", { wait: false }), false);
	assert.equal(isCancelableHostWait("receipts", {}), false);
	assert.equal(isCancelableHostWait("submit", { wait: true }), false);
	assert.equal(isCancelableHostWait("receipts", undefined), false);
});

it("parses the endpoint and readiness line", () => {
	const endpoint = { version: HOST_PROTOCOL_VERSION, pid: 5, socketPath: "/tmp/host.sock", token: "abc", createdAt: "2026-01-01T00:00:00.000Z" };
	assert.deepEqual(parseHostEndpoint(endpoint), endpoint);
	assert.throws(() => parseHostEndpoint({ ...endpoint, pid: 0 }));
	assert.throws(() => parseHostEndpoint({ ...endpoint, createdAt: "yesterday" }));
	const ready = formatHostReady({ pid: 7, socketPath: "/tmp/host.sock" });
	assert.equal(ready.endsWith("\n"), true);
	assert.deepEqual(parseHostReadyLine(ready.trimEnd()), { pid: 7, socketPath: "/tmp/host.sock" });
	assert.equal(parseHostReadyLine("other output"), undefined);
	assert.throws(() => parseHostReadyLine("PI_AGENT_HOST_READY {not json}"));
});

it("carries a coded error class", () => {
	const error = new HostError("busy", "unavailable");
	assert.equal(error.message, "busy");
	assert.equal(error.code, "unavailable");
	assert.equal(error.name, "HostError");
});
