import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import {
	HOST_RUNTIME_VERSION,
	HOST_SOCKET_PATH_LIMIT_BYTES,
	HostError,
	formatHostReady,
	hostMethodMinVersion,
	hostPaths,
	hostUpdatePendingError,
	isCancelableHostWait,
	isRetrySafeHostMethod,
	parseHostMetadata,
	parseHostReadyLine,
} from "./host-protocol.ts";

const storageId = "2f1c9c1e-8f6b-4d2a-9a3e-1b2c3d4e5f60";
const metadata = {
	storageId,
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

it("derives stable host paths and a short socket path for a deep agent directory", () => {
	const first = hostPaths(metadata);
	const second = hostPaths(metadata);
	assert.deepEqual(first, second);
	assert.ok(first.claim.startsWith(join(first.directory, ".claims")));
	const other = hostPaths({ ...metadata, storageId: "e6a1d6c4-2f7b-4a8e-9c1d-3f5a7b9c1d2e" });
	assert.notEqual(other.directory, first.directory);
	assert.notEqual(other.socket, first.socket);
	const deep = hostPaths({ ...metadata, agentDir: join("/tmp", "d".repeat(180)) });
	assert.ok(Buffer.byteLength(deep.socket, "utf8") <= HOST_SOCKET_PATH_LIMIT_BYTES);
	assert.ok(deep.socket.startsWith(tmpdir()) || deep.socket.startsWith("/tmp"));
	assert.match(first.serverId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
	assert.notEqual(other.serverId, first.serverId);
});

it("classifies retry-safe methods and cancelable waits", () => {
	for (const method of ["submit", "report", "acknowledge", "inspect", "status", "list", "receipts", "dashboard", "snapshot", "observe-open", "observe-frame", "observe-close", "timer-list"]) assert.equal(isRetrySafeHostMethod(method), true, method);
	for (const method of ["abort", "compact", "configure", "command", "fork", "rewind", "reset", "timer-schedule", "timer-cancel", "unknown"]) assert.equal(isRetrySafeHostMethod(method), false, method);
	assert.equal(isCancelableHostWait("receipts", { wait: true }), true);
	assert.equal(isCancelableHostWait("receipts", { wait: false }), false);
	assert.equal(isCancelableHostWait("receipts", {}), false);
	assert.equal(isCancelableHostWait("submit", { wait: true }), false);
	assert.equal(isCancelableHostWait("receipts", undefined), false);
});

it("parses the readiness line", () => {
	const ready = formatHostReady({ pid: 7, socketPath: "/tmp/host.sock", runtimeVersion: HOST_RUNTIME_VERSION });
	assert.equal(ready.endsWith("\n"), true);
	assert.deepEqual(parseHostReadyLine(ready.trimEnd()), { pid: 7, socketPath: "/tmp/host.sock", runtimeVersion: HOST_RUNTIME_VERSION });
	assert.equal(parseHostReadyLine("other output"), undefined);
	assert.throws(() => parseHostReadyLine("PI_AGENT_HOST_READY {not json}"));
	assert.throws(() => parseHostReadyLine('PI_AGENT_HOST_READY {"pid":0,"socketPath":"/tmp/x"}'));
	// A line without the version is an older host by definition; a malformed present value is refused.
	assert.deepEqual(parseHostReadyLine('PI_AGENT_HOST_READY {"pid":7,"socketPath":"/tmp/host.sock"}'), { pid: 7, socketPath: "/tmp/host.sock", runtimeVersion: 0 });
	assert.throws(() => parseHostReadyLine('PI_AGENT_HOST_READY {"pid":7,"socketPath":"/tmp/host.sock","runtimeVersion":"1"}'));
});

it("reports method availability by runtime version", () => {
	assert.equal(hostMethodMinVersion("status"), 0);
	assert.equal(hostMethodMinVersion("reset"), 1);
	assert.equal(hostMethodMinVersion("timer-schedule"), 1);
	assert.equal(hostMethodMinVersion("observe-open"), 1);
	const refusal = hostUpdatePendingError("timer-schedule", 0);
	assert.equal(refusal.code, "unavailable");
	assert.match(refusal.message, /older code and does not support timer-schedule/u);
	assert.match(refusal.message, /Automatic update is blocked/u);
});

it("requires the process shutdown contract for a wire close", () => {
	assert.equal(HOST_RUNTIME_VERSION, 3);
	assert.equal(hostMethodMinVersion("close"), 3);
	assert.match(hostUpdatePendingError("close", 1).message, /cannot close its process safely/u);
	assert.doesNotMatch(hostUpdatePendingError("close", 1).message, /it updates when idle/u);
});

it("carries a coded error class", () => {
	const error = new HostError("busy", "unavailable");
	assert.equal(error.message, "busy");
	assert.equal(error.code, "unavailable");
	assert.equal(error.name, "HostError");
});
