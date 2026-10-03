import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { createServer, type Socket } from "node:net";
import { spawnSync } from "node:child_process";
import { eventLog } from "./host-fixture.mts";
import { ServerError, type ServerHost } from "@earendil-works/pi-server";
import { createUnixServer } from "@earendil-works/pi-server/unix";
import { connectPrimaryChannel, createPrimaryChannel, PRIMARY_ENDPOINT_VERSION, primaryEndpointOwnerState, primaryEndpointPath, primaryEndpointStatus, PrimaryChannelConflictError, PrimaryChannelUnavailableError, probePrimaryChannel, type PrimaryChannelOptions, type PrimaryDelivery } from "./primary-channel.ts";

interface Fixture {
	readonly root: string;
	readonly id: string;
	readonly options: PrimaryChannelOptions;
	readonly delivered: PrimaryDelivery[];
	readonly prompted: string[];
	readonly channel: Awaited<ReturnType<typeof createPrimaryChannel>>;
}

function testRoot(t: { after(fn: () => void): void }): string {
	const root = mkdtempSync(join(tmpdir(), "primary-channel-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

/** One canonical UUIDv7, matching current native session ids. */
function uuidV7(value = randomUUID()): string {
	const digit = value[19];
	const variant = "89ab"[(digit === undefined ? 0 : Number.parseInt(digit, 16)) % 4] ?? "a";
	return `${value.slice(0, 14)}7${value.slice(15, 19)}${variant}${value.slice(20)}`;
}

/** Build options for one primary id under a test root. */
function channelOptions(root: string, id: string, overrides: Partial<PrimaryChannelOptions> = {}): PrimaryChannelOptions {
	return {
		id,
		cwd: "/work/topic",
		sessionsRoot: root,
		name: "Primary",
		model: { provider: "test", modelId: "model" },
		thinkingLevel: "off",
		deliver: () => {},
		promptTrust: async () => undefined,
		...overrides,
	};
}

/** Register one live channel plus capture of its delivery and prompt calls; the test always closes it. */
async function fixture(t: { after(fn: () => void): void }): Promise<Fixture> {
	const root = testRoot(t);
	const id = uuidV7();
	const delivered: PrimaryDelivery[] = [];
	const prompted: string[] = [];
	const options = channelOptions(root, id, {
		deliver: (message) => { delivered.push(message); },
		promptTrust: async (cwd) => { prompted.push(cwd); return cwd === "/work/deny" ? undefined : { trusted: true, remember: true }; },
	});
	const channel = await createPrimaryChannel(options);
	t.after(() => void channel.close().catch(() => undefined));
	return { root, id, options, delivered, prompted, channel };
}

/** One recorded endpoint with an independent v4 server identity. */
function endpointRecord(root: string, id: string, overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		version: PRIMARY_ENDPOINT_VERSION,
		id,
		serverId: randomUUID(),
		cwd: "/work/topic",
		hostname: hostname(),
		pid: process.pid,
		socketPath: join(root, ".primaries", "missing.sock"),
		startedAt: new Date().toISOString(),
		...overrides,
	});
}

/** A pid whose process has already exited, so a record on it classifies as dead. */
function deadProcessId(): number {
	const child = spawnSync(process.execPath, ["-e", ""], { stdio: ["ignore", "ignore", "ignore"] });
	if (child.pid === undefined) throw new Error("the probe process did not report a pid");
	return child.pid;
}

it("bounds a connection to a silent endpoint", async (t) => {
	const root = testRoot(t);
	const id = uuidV7();
	mkdirSync(join(root, ".primaries"), { recursive: true, mode: 0o700 });
	const socketPath = join(root, ".primaries", "silent.sock");
	const accepted = new Set<Socket>();
	const silent = createServer((socket) => { accepted.add(socket); socket.on("close", () => accepted.delete(socket)); });
	await new Promise<void>((resolve) => silent.listen(socketPath, resolve));
	t.after(() => { for (const socket of accepted) socket.destroy(); silent.close(); });
	writeFileSync(primaryEndpointPath(root, id), endpointRecord(root, id, { socketPath }));
	const started = Date.now();
	await assert.rejects(connectPrimaryChannel({ id, sessionsRoot: root, timeoutMs: 250 }), /within 250 ms|unreachable/u);
	assert.ok(Date.now() - started < 5000, "the connect deadline bounded the wait");
});

it("registers a v7 session id, answers live info, and removes its endpoint on close", async (t) => {
	const f = await fixture(t);
	const path = primaryEndpointPath(f.root, f.id);
	assert.match(f.id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
	assert.ok(existsSync(path));
	const client = await connectPrimaryChannel({ id: f.id, sessionsRoot: f.root });
	const info = await client.info();
	assert.equal(info.id, f.id);
	assert.equal(info.cwd, "/work/topic");
	assert.equal(info.name, "Primary");
	assert.equal(info.pid, process.pid);
	assert.deepEqual(info.model, { provider: "test", modelId: "model" });
	assert.equal(info.thinkingLevel, "off");
	await client.close();
	await f.channel.close();
	assert.equal(existsSync(path), false);
	assert.equal(existsSync(f.channel.socketPath), false);
	assert.equal(await probePrimaryChannel(f.root, f.id), false);
});

it("delivers a message with source, text, details, and retained replyTo", async (t) => {
	const f = await fixture(t);
	const client = await connectPrimaryChannel({ id: f.id, sessionsRoot: f.root });
	try {
		await client.deliver({ sourceId: "source-1", text: "hello primary", details: { kind: "report" }, replyTo: "entry-9" });
		assert.deepEqual(f.delivered, [{ sourceId: "source-1", text: "hello primary", details: { kind: "report" }, replyTo: "entry-9" }]);
	} finally {
		await client.close();
	}
});

it("routes a trust prompt and returns the primary decision", async (t) => {
	const f = await fixture(t);
	const client = await connectPrimaryChannel({ id: f.id, sessionsRoot: f.root });
	try {
		assert.deepEqual(await client.trustPrompt("/work/topic"), { trusted: true, remember: true });
		assert.equal(await client.trustPrompt("/work/deny"), undefined);
		assert.deepEqual(f.prompted, ["/work/topic", "/work/deny"]);
	} finally {
		await client.close();
	}
});

it("uses the human-decision deadline for trustPrompt, not the handshake deadline", async (t) => {
	const root = testRoot(t);
	const id = uuidV7();
	let release = () => {};
	const decision = new Promise<void>((resolve) => { release = resolve; });
	const prompted = eventLog<string>();
	const channel = await createPrimaryChannel(channelOptions(root, id, {
		promptTrust: async (cwd) => { prompted.push(cwd); await decision; return { trusted: true, remember: false }; },
	}));
	t.after(release);
	t.after(() => void channel.close().catch(() => undefined));
	const client = await connectPrimaryChannel({ id, sessionsRoot: root, timeoutMs: 150 });
	try {
		const deadlines: number[] = [];
		const timeout = AbortSignal.timeout.bind(AbortSignal);
		t.mock.method(AbortSignal, "timeout", (ms: number) => { deadlines.push(ms); return timeout(ms); });
		let completed = false;
		const pending = client.trustPrompt("/work/slow").then((value) => { completed = true; return value; });
		await prompted.waitForCount(1);
		assert.equal(completed, false, "the decision producer still holds the consumer");
		assert.deepEqual(deadlines, [300000], "the request uses the human-decision deadline, not the 150ms handshake deadline");
		release();
		assert.deepEqual(await pending, { trusted: true, remember: false });
	} finally {
		await client.close();
	}
});

it("cancels a trust prompt through the caller signal", async (t) => {
	const root = testRoot(t);
	const id = uuidV7();
	const channel = await createPrimaryChannel(channelOptions(root, id, { promptTrust: async () => new Promise(() => {}) }));
	t.after(() => void channel.close().catch(() => undefined));
	const client = await connectPrimaryChannel({ id, sessionsRoot: root, timeoutMs: 1000 });
	try {
		const controller = new AbortController();
		const pending = client.trustPrompt("/work/cancel", controller.signal);
		controller.abort();
		await assert.rejects(pending, (error: unknown) => error instanceof Error && /abort/iu.test(`${error.name} ${error.message}`));
	} finally {
		await client.close();
	}
});

it("publishes exactly one of two simultaneous same-id registrations", async (t) => {
	const root = join(testRoot(t), "long-primary-root-".repeat(8));
	// A short private temp root isolates fallback sockets from other test processes.
	const socketRoot = mkdtempSync("/tmp/pc-");
	const previousTmpdir = process.env.TMPDIR;
	const channels: Fixture["channel"][] = [];
	process.env.TMPDIR = socketRoot;
	t.after(async () => {
		try {
			await Promise.all(channels.map((channel) => channel.close()));
		} finally {
			if (previousTmpdir === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = previousTmpdir;
			rmSync(socketRoot, { recursive: true, force: true });
		}
	});
	const id = uuidV7();
	const options = channelOptions(root, id);
	const socketDirs = [join(root, ".primaries"), join(socketRoot, "pi-primary")];
	const before = new Map(socketDirs.map((directory) => [directory, new Set(existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith(".sock")) : [])]));
	const results = await Promise.allSettled([createPrimaryChannel(options), createPrimaryChannel(options)]);
	const fulfilled = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof createPrimaryChannel>>> => result.status === "fulfilled");
	const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
	channels.push(...fulfilled.map((result) => result.value));
	assert.equal(fulfilled.length, 1, JSON.stringify(results.map((result) => result.status)));
	assert.equal(rejected.length, 1);
	assert.ok(rejected[0]?.reason instanceof PrimaryChannelConflictError);
	assert.ok(fulfilled[0]);
	const winner = fulfilled[0].value;
	assert.equal(dirname(winner.socketPath), join(socketRoot, "pi-primary"), "the long root exercises the private fallback directory");
	const record = JSON.parse(readFileSync(primaryEndpointPath(root, id), "utf8")) as { socketPath: string; pid: number };
	assert.equal(record.socketPath, winner.socketPath, "the published record points at the winner");
	assert.equal(record.pid, process.pid);
	assert.deepEqual(readdirSync(join(root, ".primaries")).filter((name) => name.endsWith(".json")), [`${id}.json`], "the loser published no endpoint");
	const winnerDirectory = dirname(winner.socketPath);
	const winnerSocket = winner.socketPath.split("/").at(-1);
	const added = readdirSync(winnerDirectory).filter((name) => name.endsWith(".sock") && !before.get(winnerDirectory)?.has(name));
	assert.deepEqual(added, [winnerSocket], "only the winner's socket remains after the race");
});

it("refuses a duplicate registration while the owner is live", async (t) => {
	const f = await fixture(t);
	await assert.rejects(createPrimaryChannel(channelOptions(f.root, f.id)), PrimaryChannelConflictError);
});

it("refuses replacement while the recorded owner is an unreachable live process", async (t) => {
	const root = testRoot(t);
	const id = uuidV7();
	mkdirSync(join(root, ".primaries"), { recursive: true, mode: 0o700 });
	const path = primaryEndpointPath(root, id);
	const record = endpointRecord(root, id, { socketPath: join(root, "missing.sock") });
	writeFileSync(path, record);
	await assert.rejects(createPrimaryChannel(channelOptions(root, id)), /refusing replacement/u);
	assert.equal(readFileSync(path, "utf8"), record);
});

it("replaces an endpoint whose recorded local process is dead", async (t) => {
	const root = testRoot(t);
	const id = uuidV7();
	mkdirSync(join(root, ".primaries"), { recursive: true, mode: 0o700 });
	const dead = spawnSync(process.execPath, ["-e", ""]);
	assert.ok(dead.pid);
	const previous = JSON.parse(endpointRecord(root, id, { pid: dead.pid, socketPath: join(root, "stale.sock") })) as { serverId: string };
	writeFileSync(primaryEndpointPath(root, id), JSON.stringify(previous));
	const channel = await createPrimaryChannel(channelOptions(root, id));
	t.after(() => void channel.close().catch(() => undefined));
	const record = JSON.parse(readFileSync(primaryEndpointPath(root, id), "utf8")) as { pid: number; serverId: string };
	assert.equal(record.pid, process.pid);
	assert.notEqual(record.serverId, previous.serverId);
});

it("reports supported ids for an unknown lookup from a bounded page", async (t) => {
	const root = testRoot(t);
	mkdirSync(join(root, ".primaries"), { recursive: true, mode: 0o700 });
	const first = uuidV7();
	const second = uuidV7();
	writeFileSync(primaryEndpointPath(root, first), endpointRecord(root, first));
	writeFileSync(primaryEndpointPath(root, second), endpointRecord(root, second));
	await assert.rejects(connectPrimaryChannel({ id: uuidV7(), sessionsRoot: root }), (error: unknown) => error instanceof PrimaryChannelUnavailableError && String(error).includes(first) && String(error).includes(second) && String(error).includes("coverage"));
});

it("refuses a channel whose handshake serverId does not match", async (t) => {
	const root = testRoot(t);
	const id = uuidV7();
	mkdirSync(join(root, ".primaries"), { recursive: true, mode: 0o700 });
	const socketPath = join(root, ".primaries", "foreign.sock");
	const host: ServerHost = {
		serverServices: { attachClient: () => ({ invokeService: async () => { throw new ServerError("service_not_found", "no service"); }, release: () => {} }) },
		resolveSession: async () => { throw new ServerError("session_not_found", "none"); },
		openSession: async () => { throw new ServerError("session_not_found", "none"); },
	};
	const server = createUnixServer(host, { serverId: randomUUID(), path: socketPath, mode: 0o600 });
	await server.start();
	t.after(() => void server.close().catch(() => undefined));
	writeFileSync(primaryEndpointPath(root, id), endpointRecord(root, id, { socketPath }));
	await assert.rejects(connectPrimaryChannel({ id, sessionsRoot: root }), /unreachable|handshake|identity/u);
});

it("rejects malformed and traversal primary ids at the path boundary", async (t) => {
	const root = testRoot(t);
	for (const id of ["../escape", "..", "not-a-uuid", ""]) {
		assert.throws(() => primaryEndpointPath(root, id), TypeError);
		assert.equal(primaryEndpointOwnerState(root, id), "unknown");
		await assert.rejects(connectPrimaryChannel({ id, sessionsRoot: root }), (error: unknown) => error instanceof PrimaryChannelUnavailableError && String(error).includes("canonical"));
		await assert.rejects(createPrimaryChannel(channelOptions(root, id)), TypeError);
	}
	assert.equal(existsSync(join(root, "escape.json")), false);
});

it("treats an endpoint file whose record id differs as unknown", async (t) => {
	const root = testRoot(t);
	mkdirSync(join(root, ".primaries"), { recursive: true, mode: 0o700 });
	const fileId = uuidV7();
	const recordId = uuidV7();
	writeFileSync(primaryEndpointPath(root, fileId), endpointRecord(root, recordId));
	assert.equal(primaryEndpointOwnerState(root, fileId), "unknown");
	await assert.rejects(connectPrimaryChannel({ id: fileId, sessionsRoot: root }), PrimaryChannelUnavailableError);
});

it("classifies endpoint owner state without connecting", async (t) => {
	const root = testRoot(t);
	mkdirSync(join(root, ".primaries"), { recursive: true, mode: 0o700 });
	const absent = uuidV7();
	assert.equal(primaryEndpointOwnerState(root, absent), "absent");
	const live = uuidV7();
	writeFileSync(primaryEndpointPath(root, live), endpointRecord(root, live));
	assert.equal(primaryEndpointOwnerState(root, live), "live");
	const dead = spawnSync(process.execPath, ["-e", ""]);
	assert.ok(dead.pid);
	const deadId = uuidV7();
	writeFileSync(primaryEndpointPath(root, deadId), endpointRecord(root, deadId, { pid: dead.pid }));
	assert.equal(primaryEndpointOwnerState(root, deadId), "dead");
	const foreign = uuidV7();
	writeFileSync(primaryEndpointPath(root, foreign), endpointRecord(root, foreign, { hostname: "another-host" }));
	assert.equal(primaryEndpointOwnerState(root, foreign), "unknown");
	const malformed = uuidV7();
	writeFileSync(primaryEndpointPath(root, malformed), "not json");
	assert.equal(primaryEndpointOwnerState(root, malformed), "unknown");
});

it("settles every concurrent close before the same id can register again", async (t) => {
	const root = testRoot(t);
	const id = uuidV7();
	const controller = new AbortController();
	const channel = await createPrimaryChannel(channelOptions(root, id, { signal: controller.signal }));
	const endpoint = primaryEndpointPath(root, id);
	controller.abort();
	const first = channel.close();
	const second = channel.close();
	assert.equal(first, second, "repeated close returns the same in-flight promise");
	await Promise.all([first, second]);
	assert.equal(existsSync(endpoint), false);
	assert.equal(existsSync(channel.socketPath), false);
	const replacement = await createPrimaryChannel(channelOptions(root, id));
	t.after(() => void replacement.close().catch(() => undefined));
	assert.equal(existsSync(endpoint), true);
});

it("awaits the abort teardown before a same-id registration succeeds", async (t) => {
	const root = testRoot(t);
	const id = uuidV7();
	const controller = new AbortController();
	const channel = await createPrimaryChannel(channelOptions(root, id, { signal: controller.signal }));
	controller.abort();
	await channel.close();
	const replacement = await createPrimaryChannel(channelOptions(root, id));
	t.after(() => void replacement.close().catch(() => undefined));
	const connection = await connectPrimaryChannel({ id, sessionsRoot: root });
	try {
		assert.equal(connection.id, id);
	} finally {
		await connection.close();
	}
});

it("removes the endpoint when the abort signal fires", async (t) => {
	const root = testRoot(t);
	const id = uuidV7();
	const controller = new AbortController();
	const channel = await createPrimaryChannel(channelOptions(root, id, { signal: controller.signal }));
	const path = primaryEndpointPath(root, id);
	assert.ok(existsSync(path));
	controller.abort();
	await channel.close();
	assert.equal(existsSync(path), false);
	assert.equal(existsSync(channel.socketPath), false);
});

it("rewrites the endpoint identity when a registered primary changes", async (t) => {
	const root = testRoot(t);
	const id = uuidV7();
	const channel = await createPrimaryChannel(channelOptions(root, id));
	t.after(() => void channel.close().catch(() => undefined));
	channel.update({ name: "Renamed primary", model: { provider: "anthropic", modelId: "claude-opus-5-5" }, thinkingLevel: "xhigh" });
	assert.equal(channel.info().name, "Renamed primary");
	assert.deepEqual(channel.info().model, { provider: "anthropic", modelId: "claude-opus-5-5" });
	assert.equal(channel.info().thinkingLevel, "xhigh");
	const record = JSON.parse(readFileSync(primaryEndpointPath(root, id), "utf8")) as { id: string; name?: string; model?: unknown; thinkingLevel?: string };
	assert.equal(record.id, id);
	assert.equal(record.name, "Renamed primary");
	assert.deepEqual(record.model, { provider: "anthropic", modelId: "claude-opus-5-5" });
	assert.equal(record.thinkingLevel, "xhigh");
	const connection = await connectPrimaryChannel({ id, sessionsRoot: root });
	try {
		const info = await connection.info();
		assert.equal(info.name, "Renamed primary");
		assert.deepEqual(info.model, { provider: "anthropic", modelId: "claude-opus-5-5" });
		assert.equal(info.thinkingLevel, "xhigh");
	} finally {
		await connection.close();
	}
	channel.update({ name: undefined, model: undefined, thinkingLevel: undefined });
	assert.equal(channel.info().name, undefined);
	assert.equal(channel.info().model, undefined);
	assert.equal(channel.info().thinkingLevel, undefined);
	const cleared = JSON.parse(readFileSync(primaryEndpointPath(root, id), "utf8")) as Record<string, unknown>;
	assert.equal("name" in cleared, false, "a cleared name leaves no stale record field");
});

it("publishes the current endpoint version and refuses an older record with the restart reason", async (t) => {
	const root = testRoot(t);
	const id = uuidV7();
	const channel = await createPrimaryChannel(channelOptions(root, id));
	t.after(() => void channel.close().catch(() => undefined));
	const path = primaryEndpointPath(root, id);
	const published = JSON.parse(readFileSync(path, "utf8")) as { version: number };
	assert.equal(published.version, PRIMARY_ENDPOINT_VERSION);
	writeFileSync(path, JSON.stringify({ ...published, version: PRIMARY_ENDPOINT_VERSION - 1 }));
	await assert.rejects(
		connectPrimaryChannel({ id, sessionsRoot: root }),
		(error: unknown) =>
			error instanceof PrimaryChannelUnavailableError &&
			String(error).includes(`endpoint version ${PRIMARY_ENDPOINT_VERSION - 1}`) &&
			String(error).includes("Restart that Pi"),
	);
});

it("classifies another endpoint version as incompatible, never dead or unknown", async (t) => {
	const root = testRoot(t);
	mkdirSync(join(root, ".primaries"), { recursive: true, mode: 0o700 });
	const id = uuidV7();
	const path = primaryEndpointPath(root, id);
	writeFileSync(path, endpointRecord(root, id, { version: 1 }));
	assert.deepEqual(primaryEndpointStatus(root, id), { state: "incompatible", version: 1 });
	writeFileSync(path, endpointRecord(root, id, { version: 1, pid: deadProcessId() }));
	assert.deepEqual(primaryEndpointStatus(root, id), { state: "incompatible", version: 1 }, "a dead older owner stays incompatible");
	writeFileSync(path, endpointRecord(root, id, { version: "1" }));
	assert.deepEqual(primaryEndpointStatus(root, id), { state: "unknown" }, "a non-numeric version is malformed");
	writeFileSync(path, endpointRecord(root, id, { version: undefined }));
	assert.deepEqual(primaryEndpointStatus(root, id), { state: "unknown" }, "a missing version is malformed");
});

it("replaces an older endpoint record with a dead owner at registration", async (t) => {
	const root = testRoot(t);
	mkdirSync(join(root, ".primaries"), { recursive: true, mode: 0o700 });
	const id = uuidV7();
	const dead = spawnSync(process.execPath, ["-e", ""]);
	assert.ok(dead.pid);
	writeFileSync(primaryEndpointPath(root, id), endpointRecord(root, id, { version: 1, pid: dead.pid }));
	const channel = await createPrimaryChannel(channelOptions(root, id));
	t.after(() => void channel.close().catch(() => undefined));
	const record = JSON.parse(readFileSync(primaryEndpointPath(root, id), "utf8")) as { version: number; pid: number };
	assert.equal(record.version, PRIMARY_ENDPOINT_VERSION, "a restart replaces the older record");
	assert.equal(record.pid, process.pid);
});
