import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { hostMetadata, type CatalogRecord } from "./catalog.ts";
import { dashboardText } from "./dashboard-roster.ts";
import { connectHost, type HostConnection } from "./host-client.ts";
import { runHost } from "./host-process.ts";
import { hostPaths, type HostMetadata } from "./host-protocol.ts";
import { HOST_CONTRACT, contractRefusal, type RuntimeContract } from "./version-contract.ts";
import { eventLog, waitForConnectionClose } from "./host-fixture.mts";
import { AgentManager, type AgentManagerOptions } from "./manager.ts";
import { connectPrimaryChannel, type PrimaryChannel, type PrimaryChannelOptions, type PrimaryInfo } from "./primary-channel.ts";
import type { createPrimaryChannel } from "./primary-channel.ts";

function fixtureRoot(t: { after(fn: () => void): void }): string {
	const root = mkdtempSync(join(tmpdir(), "agent-manager-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function managerOptions(root: string, overrides: Partial<AgentManagerOptions> = {}): AgentManagerOptions {
	return { root, agentDir: join(root, "agent"), packageDir: join(root, "package"), ...overrides };
}

function createRecord(manager: AgentManager, root: string, ownerId = "owner-1") {
	return manager.catalog.create({
		cwd: root,
		agentDir: join(root, "agent"),
		packageDir: join(root, "package"),
		model: { provider: "fixture", modelId: "model-1" },
		thinkingLevel: "off",
		ownerId,
	});
}

/** One syntactically valid writer claim owned by `pid` on this host. */
function claimFor(record: CatalogRecord, pid: number): unknown {
	return { sessionId: record.storageId, cwd: resolve(record.cwd), host: hostname(), pid, createdAt: new Date().toISOString() };
}

/** Write a claim file a startup scan would observe as live, dead, or unknown. */
function writeClaim(record: CatalogRecord, value: unknown): void {
	const paths = hostPaths(record);
	mkdirSync(join(paths.directory, ".claims"), { recursive: true, mode: 0o700 });
	writeFileSync(paths.claim, typeof value === "string" ? value : `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

/** A pid whose process has already exited, so a claim on it classifies as dead. */
function deadProcessId(): number {
	const child = spawnSync(process.execPath, ["-e", ""], { stdio: ["ignore", "ignore", "ignore"] });
	if (child.pid === undefined) throw new Error("the probe process did not report a pid");
	return child.pid;
}

interface FakeConnection extends HostConnection {
	/** Run every current change listener, as one native write notification would. */
	change(): void;
}

function fakeConnection(metadata: HostMetadata, handler: (method: string, params: unknown) => Promise<unknown>, runtimeContract: RuntimeContract = HOST_CONTRACT): FakeConnection {
	let closed = false;
	const listeners = new Set<() => void>();
	const changes = new Set<() => void>();
	return {
		pid: 4242,
		socketPath: "/tmp/fake-host.sock",
		storageId: metadata.storageId,
		metadata,
		runtimeContract,
		get closed() {
			return closed;
		},
		async request(method, params) {
			return handler(method, params);
		},
		onClose(callback) {
			if (closed) { queueMicrotask(callback); return () => {}; }
			listeners.add(callback);
			return () => {
				listeners.delete(callback);
			};
		},
		async subscribeChanges(listener: () => void): Promise<() => void> {
			changes.add(listener);
			listener();
			return () => {
				changes.delete(listener);
			};
		},
		change() {
			for (const listener of [...changes]) listener();
		},
		async close() {
			if (closed) return;
			closed = true;
			for (const listener of [...listeners]) listener();
		},
	} as FakeConnection;
}

/** A structural stand-in for one registered primary client. */
function fakePrimary(signal: AbortSignal) {
	const sent: Array<{ text: string; details: unknown }> = [];
	const statuses = eventLog<string | undefined>();
	return {
		sent,
		statuses,
		client: {
			send: (text: string, details: unknown) => {
				sent.push({ text, details });
			},
			status: (text?: string) => {
				statuses.push(text);
			},
			signal,
			cwd: process.cwd(),
			name: "primary",
		},
	};
}

function deferred() {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const { "task-submit": _taskSubmit, ...baseOperations } = HOST_CONTRACT.operations;
const BASE_SUBMIT_CONTRACT: RuntimeContract = { ...HOST_CONTRACT, operations: baseOperations };

for (const operation of ["submit", "task-submit"] as const) for (const minutes of [undefined, 0, 2.5]) it(`preserves the place model interval ${minutes} through ${operation} on create and reuse`, async (t) => {
	const root = fixtureRoot(t);
	const submits: Array<Record<string, unknown>> = [];
	const manager = new AgentManager(managerOptions(root, { validateModel: () => {}, acquire: async (metadata) => fakeConnection(metadata, async (method, params) => {
		if (method === operation) submits.push(params as Record<string, unknown>);
		return { busy: false };
	}, operation === "submit" ? BASE_SUBMIT_CONTRACT : HOST_CONTRACT) }));
	t.after(() => manager.close());
	const prior = process.env.PI_AGENT_CHECK_IN_MINUTES;
	process.env.PI_AGENT_CHECK_IN_MINUTES = "7";
	t.after(() => { if (prior === undefined) delete process.env.PI_AGENT_CHECK_IN_MINUTES; else process.env.PI_AGENT_CHECK_IN_MINUTES = prior; });
	const caller = { id: "owner-1", cwd: root, model: { provider: "fixture", modelId: "model-1" }, thinkingLevel: "off" };
	const input = { area: root, prompt: "Task", origin: "model" as const, checkInMinutes: minutes };
	await manager.place(input, caller);
	await manager.place(input, caller);
	assert.equal(submits.length, 2);
	assert.deepEqual(submits.map((params) => params.checkInMinutes), [minutes ?? 7, minutes ?? 7]);
	assert.deepEqual(submits.map((params) => params.origin), ["model", "model"]);
	assert.deepEqual(submits.map((params) => params.ownerId), [caller.id, caller.id]);
	if (operation === "task-submit") assert.deepEqual(submits.map((params) => params.requester), [caller.id, caller.id]);
	await manager.place({ area: root, prompt: "Operator task", origin: "operator" }, caller);
	assert.equal(submits[2]?.checkInMinutes, 0);
});

interface CapturedPrimaryChannel {
	readonly closedEvent: Promise<void>;
	readonly options: PrimaryChannelOptions;
	readonly updates: Array<{ name: string | undefined; model: { provider: string; modelId: string } | undefined; thinkingLevel: string | undefined }>;
	closed: boolean;
}

/** Fake primary channel server; tests call `options.deliver` as a host connection would. */
function primaryFactory(onClose?: (channel: CapturedPrimaryChannel, invocation: number) => void | Promise<void>) {
	const channels: CapturedPrimaryChannel[] = [];
	let invocations = 0;
	const factory = async (options: PrimaryChannelOptions): Promise<PrimaryChannel> => {
		invocations += 1;
		const invocation = invocations;
		const closedEvent = deferred();
		const captured: CapturedPrimaryChannel = { options, updates: [], closed: false, closedEvent: closedEvent.promise };
		channels.push(captured);
		const info = (): PrimaryInfo => ({
			id: options.id,
			cwd: options.cwd,
			...(options.name === undefined ? {} : { name: options.name }),
			...(options.model === undefined ? {} : { model: options.model }),
			...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
			hostname: "test-host",
			pid: process.pid,
			socketPath: join(options.sessionsRoot, ".primaries", `${options.id}.sock`),
			startedAt: new Date().toISOString(),
		});
		return {
			id: options.id,
			socketPath: join(options.sessionsRoot, ".primaries", `${options.id}.sock`),
			info,
			update: (info) => {
				captured.updates.push(info);
			},
			publishIntent: () => {},
			touch: () => {},
			setObservedPurpose: () => {},
			close: async () => {
				captured.closed = true;
				closedEvent.resolve();
				await onClose?.(captured, invocation);
			},
		};
	};
	return { channels, factory: factory as typeof createPrimaryChannel, get invocations() { return invocations; } };
}

const noHost = async () => {
	throw new Error("no live host");
};

it("preserves a successful spawn admission when its status snapshot fails", async (t) => {
	const root = fixtureRoot(t);
	const manager = new AgentManager(managerOptions(root, {
		validateModel: () => {},
		acquire: async (metadata) => fakeConnection(metadata, async (method) => {
			if (method === "status") throw new Error("snapshot unavailable");
			return { submissionId: 9, deduped: false };
		}),
	}));
	try {
		const outcome = await manager.spawn({ prompt: "work" }, { id: "owner", cwd: root, model: { provider: "fixture", modelId: "model-1" } }) as { sessionId: string; admission: { submissionId: number }; snapshotError: string };
		assert.equal(outcome.admission.submissionId, 9);
		assert.equal(outcome.snapshotError, "snapshot unavailable");
		assert.equal(manager.catalog.read(outcome.sessionId).storageId, outcome.sessionId);
	} finally { manager.close(); }
});

it("explains report consumption without changing follow-up admission", async (t) => {
	const root = fixtureRoot(t);
	const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
	const manager = new AgentManager(managerOptions(root, {
		acquire: async (metadata) => fakeConnection(metadata, async (method, params) => {
			seen.push({ method, params: params as Record<string, unknown> });
			return { submissionId: 7 };
		}),
	}));
	t.after(() => manager.close());
	const record = createRecord(manager, root);
	const receipt = await manager.control("report", { sessionId: record.storageId, message: "Progress", requestId: "report-progress" }, { id: "caller", cwd: root }) as { submissionId: number; boundary: string };
	assert.equal(receipt.submissionId, 7);
	assert.match(receipt.boundary, /report waits for its current run to end/u);
	assert.match(receipt.boundary, /steer.*next tool boundary/u);
	const admission = seen.find((call) => call.method === "submit");
	assert.equal(admission?.params.whenBusy, "followUp");
	assert.equal(admission?.params.requestId, "report-progress");
});

for (const operation of ["submit", "task-submit"] as const) it(`preserves caller admission keys and creates absent keys through ${operation}`, async (t) => {
	const root = fixtureRoot(t);
	const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
	const manager = new AgentManager(managerOptions(root, {
		acquire: async (metadata) => fakeConnection(metadata, async (method, params) => {
			seen.push({ method, params: params as Record<string, unknown> });
			return {};
		}, operation === "submit" ? BASE_SUBMIT_CONTRACT : HOST_CONTRACT),
	}));
	const record = createRecord(manager, root);
	try {
		for (const method of ["submit", "rewind", "fork"]) {
			await manager.control(method, { sessionId: record.storageId, requestId: `stable:${method}`, operationId: `operation:${method}` }, { id: "caller", cwd: root });
			await manager.control(method, { sessionId: record.storageId }, { id: "caller", cwd: root });
		}
		const mutations = seen.filter((entry) => entry.method !== "status");
		assert.equal(mutations.length, 6);
		assert.deepEqual(mutations.map((entry) => entry.method), [operation, operation, "rewind", "rewind", "fork", "fork"]);
		const callerMethods = ["submit", "rewind", "fork"];
		for (let index = 0; index < mutations.length; index += 2) {
			assert.equal(mutations[index].params.requestId, `stable:${callerMethods[index / 2]}`);
			assert.equal(mutations[index].params.operationId, `operation:${callerMethods[index / 2]}`);
			assert.equal(typeof mutations[index + 1].params.requestId, "string");
			assert.notEqual(mutations[index + 1].params.requestId, mutations[index].params.requestId);
		}
		assert.ok(seen.some((entry) => entry.method === "status"), "mutation snapshots add filtered status requests");
	} finally { manager.close(); }
});

for (const rich of [false, true]) it(`preserves an explicit reply recipient or reports the missing rich admission contract (${rich})`, async (t) => {
	const root = fixtureRoot(t);
	const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
	const manager = new AgentManager(managerOptions(root, { acquire: async (metadata) => fakeConnection(metadata, async (method, params) => {
		seen.push({ method, params: params as Record<string, unknown> });
		return { submissionId: 9 };
	}, rich ? HOST_CONTRACT : BASE_SUBMIT_CONTRACT) }));
	t.after(() => manager.close());
	const record = createRecord(manager, root);
	const send = manager.control("submit", { sessionId: record.storageId, message: "Task", replyTo: "recipient-c", origin: "model", requestId: "routed" }, { id: "requester-b", cwd: root });
	if (!rich) {
		await assert.rejects(send, /task-submit|replyTo|request context|unavailable/iu);
		assert.equal(seen.length, 0, "an unavailable route guarantee admits no base input");
		return;
	}
	await send;
	assert.deepEqual(seen.map((entry) => entry.method), ["task-submit"]);
	assert.equal(seen[0].params.requester, "requester-b");
	assert.equal(seen[0].params.replyTo, "recipient-c");
	assert.equal(seen[0].params.requestId, "routed");
	assert.equal(seen[0].params.origin, "model");
});

it("closes a host opened for a primary that aborts mid-registration", { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t);
	let release: ((connection: HostConnection) => void) | undefined;
	const openingStarted = deferred();
	const manager = new AgentManager(managerOptions(root, {
		acquire: () => new Promise<HostConnection>((resolve) => {
			release = resolve;
			openingStarted.resolve();
		}),
		connect: noHost,
		observe: async () => ({ conversations: [{ busy: true }] }),
		createPrimary: primaryFactory().factory,
	}));
	const record = createRecord(manager, root);
	manager.catalog.markRecoveryDue(record.storageId, true);
	const controller = new AbortController();
	const primary = fakePrimary(controller.signal);
	const registering = manager.registerPrimary("owner-1", primary.client);
	await openingStarted.promise;
	controller.abort();
	const connection = fakeConnection(hostMetadata(record), async () => ({}));
	release?.(connection);
	await registering;
	await waitForConnectionClose(connection);
	assert.equal(connection.closed, true, "the raced host client is closed");
	assert.deepEqual(manager.connectedStorageIds(), []);
	manager.close();
});

it("dedups primary channel deliveries by source ID within the bounded memory", async (t) => {
	const root = fixtureRoot(t);
	const factory = primaryFactory();
	const manager = new AgentManager(managerOptions(root, { createPrimary: factory.factory, deliveredLimit: 1 }));
	const primary = fakePrimary(new AbortController().signal);
	try {
		await manager.registerPrimary("owner-1", primary.client);
		const channel = factory.channels[0];
		assert.ok(channel, "registration creates one primary channel");
		await channel.options.deliver({ sourceId: "s1", text: "one" });
		await channel.options.deliver({ sourceId: "s1", text: "one again" });
		assert.deepEqual(primary.sent.map((message) => message.text), ["one"]);
		await channel.options.deliver({ sourceId: "s2", text: "two" });
		assert.deepEqual(primary.sent.map((message) => message.text), ["one", "two"]);
		await channel.options.deliver({ sourceId: "s1", text: "one after eviction" });
		assert.deepEqual(primary.sent.map((message) => message.text), ["one", "two", "one after eviction"], "the bounded memory evicts the oldest source ID");
	} finally { manager.close(); }
});

it("dedups the same source ID once per recipient when every primary receives it", async (t) => {
	const root = fixtureRoot(t);
	const factory = primaryFactory();
	const manager = new AgentManager(managerOptions(root, { createPrimary: factory.factory }));
	const first = fakePrimary(new AbortController().signal);
	const second = fakePrimary(new AbortController().signal);
	try {
		await manager.registerPrimary("owner-1", first.client);
		await manager.registerPrimary("owner-2", second.client);
		const firstChannel = factory.channels.find((channel) => channel.options.id === "owner-1");
		const secondChannel = factory.channels.find((channel) => channel.options.id === "owner-2");
		assert.ok(firstChannel);
		assert.ok(secondChannel);
		const delivery = { sourceId: "report:shared", text: "broadcast" };
		await firstChannel.options.deliver(delivery);
		await secondChannel.options.deliver(delivery);
		assert.deepEqual(first.sent.map((message) => message.text), ["broadcast"], "the first recipient receives the broadcast once");
		assert.deepEqual(second.sent.map((message) => message.text), ["broadcast"], "the second recipient receives the same source ID once");
		await firstChannel.options.deliver(delivery);
		await secondChannel.options.deliver(delivery);
		assert.deepEqual(first.sent.map((message) => message.text), ["broadcast"], "a repeated delivery dedups on the first recipient");
		assert.deepEqual(second.sent.map((message) => message.text), ["broadcast"], "a repeated delivery dedups on the second recipient");
	} finally { manager.close(); }
});

it("clears the footer and closes the primary channel when the primary aborts", { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t);
	const factory = primaryFactory();
	const manager = new AgentManager(managerOptions(root, { createPrimary: factory.factory }));
	const controller = new AbortController();
	const primary = fakePrimary(controller.signal);
	try {
		await manager.registerPrimary("owner-1", primary.client);
		const channel = factory.channels[0];
		assert.ok(channel);
		await channel.options.deliver({ sourceId: "s1", text: "before" });
		assert.equal(primary.sent.length, 1);
		controller.abort();
		await channel.closedEvent;
		assert.equal(primary.statuses.at(-1), undefined, "abort clears the durable footer");
		assert.throws(() => channel.options.deliver({ sourceId: "s2", text: "after" }), /closed/u);
		assert.deepEqual(primary.sent.map((message) => message.text), ["before"], "no delivery reaches a released primary");
	} finally { manager.close(); }
});

it("awaits the previous channel close before re-registering the same primary", async (t) => {
	const root = fixtureRoot(t);
	const closeGate = deferred();
	let closeStarted: () => void = () => {};
	const started = new Promise<void>((resolve) => {
		closeStarted = resolve;
	});
	const factory = primaryFactory(async (_channel, invocation) => {
		if (invocation !== 1) return;
		closeStarted();
		await closeGate.promise;
	});
	const manager = new AgentManager(managerOptions(root, { createPrimary: factory.factory }));
	const controller = new AbortController();
	const first = fakePrimary(controller.signal);
	const second = fakePrimary(new AbortController().signal);
	try {
		await manager.registerPrimary("owner-1", first.client);
		controller.abort();
		await started;
		const reRegistering = manager.registerPrimary("owner-1", second.client);
		let secondDone = false;
		void reRegistering.then(() => {
			secondDone = true;
		});
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(factory.invocations, 1, "the re-registration waits for the previous channel close");
		assert.equal(secondDone, false);
		assert.equal(factory.channels[0]?.closed, true, "the previous channel close started");
		closeGate.resolve();
		await reRegistering;
		assert.equal(factory.invocations, 2, "the re-registration creates a channel after teardown");
		const secondChannel = factory.channels[1];
		assert.ok(secondChannel);
		await secondChannel.options.deliver({ sourceId: "s1", text: "after re-register" });
		assert.deepEqual(second.sent.map((message) => message.text), ["after re-register"]);
	} finally {
		closeGate.resolve();
		manager.close();
	}
});

it("re-registers the same owner with the real primary channel after abort", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const ownerId = randomUUID();
	const manager = new AgentManager(managerOptions(root));
	const controller = new AbortController();
	const first = fakePrimary(controller.signal);
	const second = fakePrimary(new AbortController().signal);
	try {
		await manager.registerPrimary(ownerId, first.client);
		controller.abort();
		await manager.registerPrimary(ownerId, second.client);
		const connection = await connectPrimaryChannel({ id: ownerId, sessionsRoot: root });
		try {
			await connection.deliver({ sourceId: "s1", text: "real channel" });
		} finally {
			await connection.close();
		}
		assert.deepEqual(second.sent.map((message) => message.text), ["real channel"]);
	} finally {
		manager.close();
	}
});

it("refreshes the durable footer from published views at startup and after a host change", { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t);
	const factory = primaryFactory();
	const methods: string[] = [];
	let connection: FakeConnection | undefined;
	const manager = new AgentManager(managerOptions(root, {
		createPrimary: factory.factory,
		connect: async (metadata) => {
			connection = fakeConnection(metadata, async (method) => {
				methods.push(method);
				if (method === "recovery-state") return { workPending: true, deliveriesPending: true };
				return {};
			});
			return connection;
		},
		observe: async () => {
			throw new Error("the footer must read catalog views, not native state");
		},
	}));
	const record = createRecord(manager, root);
	manager.catalog.markRecoveryDue(record.storageId, true);
	writeClaim(record, claimFor(record, process.pid));
	const publish = (state: string) => manager.catalog.updateView(record.storageId, {
		updatedAt: new Date().toISOString(),
		rows: [{ id: `${record.storageId}:1`, storageId: record.storageId, cwd: record.cwd, modifiedAt: 1, owner: "here", state, cost: 0, partial: false }],
		coverage: { complete: true, omitted: 0 },
	});
	publish("working");
	const primary = fakePrimary(new AbortController().signal);
	try {
		await manager.registerPrimary("owner-1", primary.client);
		await primary.statuses.waitFor((items) => items.includes("agents: 1/1 active"));
		assert.ok(connection, "a live due record connects without launching");
		publish("idle");
		let changes = 0;
		const changed = deferred();
		const unsubscribe = manager.subscribeRoster(() => { changes++; changed.resolve(); });
		connection.change();
		await changed.promise;
		assert.ok(changes > 0);
		unsubscribe();
		const afterClose = changes;
		connection.change();
		assert.equal(changes, afterClose);
		await primary.statuses.waitFor((items) => items.includes("agents: 0/1 active"));
		assert.equal(methods.includes("dashboard"), false, "the footer never requests native dashboard state");
	} finally { manager.close(); }
});

it("validates the spawn model before writing a catalog record", async (t) => {
	const root = fixtureRoot(t);
	const manager = new AgentManager(managerOptions(root, {
		validateModel: () => {
			throw new Error("model is not in the configured catalog");
		},
	}));
	try {
		await assert.rejects(manager.spawn({ model: "fixture/missing" }, { id: "caller", cwd: root }), /configured catalog/u);
		const page = await manager.catalog.page({});
		assert.equal(page.records.length, 0, "no catalog record is written before validation");
	} finally { manager.close(); }
});

it("discards its own catalog record when the first acquire fails", async (t) => {
	const root = fixtureRoot(t);
	const manager = new AgentManager(managerOptions(root, {
		validateModel: () => undefined,
		acquire: async () => {
			throw new Error("host process failed to start");
		},
	}));
	try {
		await assert.rejects(manager.spawn({ model: "fixture/model-1", prompt: "start" }, { id: "caller", cwd: root }), /host process failed to start/u);
		const page = await manager.catalog.page({});
		assert.equal(page.records.length, 0, "the unopened record is discarded");
	} finally { manager.close(); }
});

it("returns a failed attach configuration instead of a recovery status", async (t) => {
	const root = fixtureRoot(t);
	const manager = new AgentManager(managerOptions(root, {
		connect: noHost,
		acquire: async (metadata) => fakeConnection(metadata, async (method) => {
			if (method === "configure") return { sessionId: metadata.storageId, outcome: "failed", error: "model unavailable" };
			if (method === "status") return { conversations: [] };
			return {};
		}),
	}));
	const record = createRecord(manager, root);
	try {
		const outcome = await manager.control("attach", { sessionId: record.storageId, model: { provider: "fixture", modelId: "missing" } }, { id: "caller", cwd: root }) as { outcome?: string; recovery?: string };
		assert.equal(outcome.outcome, "failed");
		assert.equal(outcome.recovery, undefined);
	} finally { manager.close(); }
});

it("stops repeated live host losses in Attention and permits an explicit attach retry", async (t) => {
	const root = fixtureRoot(t);
	const connections = eventLog<FakeConnection>();
	const manager = new AgentManager(managerOptions(root, {
		createPrimary: primaryFactory().factory,
		acquire: async (metadata, options) => {
			assert.equal(options?.retryAttempts, 0);
			const client = fakeConnection(metadata, async (method) => method === "recovery-state" ? { workPending: true, deliveriesPending: true } : {});
			connections.push(client);
			return client;
		},
	}));
	t.after(() => manager.close());
	const record = createRecord(manager, root);
	manager.catalog.updateView(record.storageId, { updatedAt: new Date().toISOString(), rows: [{ id: record.storageId, storageId: record.storageId, cwd: root, modifiedAt: 1, owner: "unknown", state: "idle", cost: 0, partial: false }], coverage: { complete: true, omitted: 0 } });
	await manager.registerPrimary("owner-1", fakePrimary(new AbortController().signal).client);
	await manager.control("attach", { sessionId: record.storageId }, { id: "owner-1", cwd: root });
	manager.catalog.markRecoveryDue(record.storageId, true);
	writeClaim(record, claimFor(record, deadProcessId()));
	for (let index = 0; index < 3; index++) {
		await connections[index]?.close();
		await connections.waitForCount(index + 2);
	}
	await connections[3]?.close();
	await manager.registerPrimary("owner-2", fakePrimary(new AbortController().signal).client);
	assert.equal(connections.length, 4, "three replacements exhaust the short-window budget");
	const stopped = await manager.dashboardPage();
	assert.match(stopped.rows[0]?.health?.lastError ?? "", /Automatic recovery stopped/u);
	assert.match(dashboardText({ observedAt: Date.now(), sessions: stopped.rows }), /1 need attention/u);
	await manager.control("attach", { sessionId: record.storageId }, { id: "owner-1", cwd: root });
	assert.equal(connections.length, 5);
	assert.equal((await manager.dashboardPage()).rows[0]?.health?.lastError, undefined);
});

it("does not relaunch an unmarked host or a host released with the last primary", async (t) => {
	const root = fixtureRoot(t);
	const connections = eventLog<FakeConnection>();
	const controller = new AbortController();
	const manager = new AgentManager(managerOptions(root, {
		createPrimary: primaryFactory().factory,
		acquire: async (metadata) => { const client = fakeConnection(metadata, async () => ({})); connections.push(client); return client; },
	}));
	t.after(() => manager.close());
	const record = createRecord(manager, root);
	await manager.registerPrimary("owner-1", fakePrimary(controller.signal).client);
	await manager.control("attach", { sessionId: record.storageId }, { id: "owner-1", cwd: root });
	await connections[0]?.close();
	await manager.registerPrimary("owner-1", fakePrimary(controller.signal).client);
	assert.equal(connections.length, 1, "an unmarked loss admits no recovery");
	await manager.control("attach", { sessionId: record.storageId }, { id: "owner-1", cwd: root });
	manager.catalog.markRecoveryDue(record.storageId, true);
	controller.abort();
	assert.equal(connections[1]?.closed, true);
	await Promise.resolve();
	assert.equal(connections.length, 2, "intentional primary release admits no recovery");
});

it("keeps hundreds of clean catalog records out of board reads and host launches", { timeout: 60000 }, async (t) => {
	const root = fixtureRoot(t);
	let acquires = 0;
	let observes = 0;
	const factory = primaryFactory();
	const manager = new AgentManager(managerOptions(root, {
		createPrimary: factory.factory,
		acquire: async (metadata) => {
			acquires += 1;
			return fakeConnection(metadata, async () => ({}));
		},
		observe: async () => {
			observes += 1;
			return [];
		},
	}));
	t.after(() => manager.close());
	for (let index = 0; index < 240; index += 1) createRecord(manager, root, `owner-${index}`);
	const primary = fakePrimary(new AbortController().signal);
	await manager.registerPrimary("owner-1", primary.client);
	assert.equal(acquires, 0, "clean records launch no host at startup");
	assert.equal(observes, 0, "startup reads no native host state");
	assert.equal(factory.invocations, 1, "the primary channel is the only startup work");
	const page = (await manager.dashboardPage()) as unknown as { rows: Array<{ storageId: string; state: string; owner: string; partial: boolean }> };
	assert.equal(acquires, 0, "clean records launch no host");
	assert.equal(observes, 0, "the board reads no native host state");
	assert.equal(page.rows.length, 240, "every clean record has one explicit metadata row");
	for (const row of page.rows) {
		assert.equal(row.state, "unavailable");
		assert.equal(row.owner, "unknown");
		assert.equal(row.partial, true);
	}
	const again = (await manager.dashboardPage()) as unknown as { rows: Array<{ storageId: string; state: string }> };
	assert.deepEqual(again.rows.map((row) => row.storageId).sort(), page.rows.map((row) => row.storageId).sort(), "the second refresh returns the same records");
	assert.equal(acquires, 0);
	assert.equal(observes, 0);
});

it("closes a recovery link with parked deliveries and recovers again at another registration", { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t);
	const links: FakeConnection[] = [];
	const manager = new AgentManager(managerOptions(root, {
		createPrimary: primaryFactory().factory,
		acquire: async (metadata) => {
			const link = fakeConnection(metadata, async () => ({ workPending: false, deliveriesPending: true, deliveriesActive: false }));
			links.push(link);
			return link;
		},
		observe: async () => ({ conversations: [] }), connect: noHost,
	}));
	t.after(() => manager.close());
	const record = createRecord(manager, root, "parked");
	manager.catalog.markRecoveryDue(record.storageId, true);
	await manager.registerPrimary("owner-1", fakePrimary(new AbortController().signal).client);
	assert.equal(links.length, 1);
	assert.equal(links[0].closed, true, "parked rows release the transient recovery link");
	assert.equal(manager.catalog.read(record.storageId).recoveryDue, true);
	await manager.registerPrimary("owner-2", fakePrimary(new AbortController().signal).client);
	assert.equal(links.length, 2);
	assert.equal(links[1].closed, true);
});

it("refreshes an existing recovery link at another primary registration", { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t);
	let connection: FakeConnection | undefined;
	let active = true;
	let reads = 0;
	const manager = new AgentManager(managerOptions(root, {
		createPrimary: primaryFactory().factory,
		acquire: async (metadata) => {
			connection = fakeConnection(metadata, async (method) => {
				if (method === "recovery-state") reads++;
				return { workPending: false, deliveriesPending: true, deliveriesActive: active };
			});
			return connection;
		},
		observe: async () => ({ conversations: [] }), connect: noHost,
	}));
	t.after(() => manager.close());
	const record = createRecord(manager, root, "recovering");
	manager.catalog.markRecoveryDue(record.storageId, true);
	await manager.registerPrimary("owner-1", fakePrimary(new AbortController().signal).client);
	assert.equal(connection?.closed, false);
	const prior = reads;
	active = false;
	await manager.registerPrimary("owner-2", fakePrimary(new AbortController().signal).client);
	assert.ok(reads > prior, "registration refreshes delivery even without a native commit");
	assert.equal(connection?.closed, true);
});

it("launches only marked-due records and caps concurrent recovery at two", { timeout: 60000 }, async (t) => {
	const root = fixtureRoot(t);
	const acquired = eventLog<string>();
	const gates = new Map<string, () => void>();
	const activity = { active: 0, peak: 0 };
	let flowing = false;
	const manager = new AgentManager(managerOptions(root, {
		createPrimary: primaryFactory().factory,
		acquire: async (metadata) => {
			const storageId = metadata.storageId;
			acquired.push(storageId);
			activity.active += 1;
			activity.peak = Math.max(activity.peak, activity.active);
			if (!flowing) {
				await new Promise<void>((release) => gates.set(storageId, () => {
					flowing = true;
					release();
				}));
			}
			activity.active -= 1;
			return fakeConnection(metadata, async (method) => (method === "recovery-state" ? { workPending: false, deliveriesPending: false, deliveriesActive: false } : {}));
		},
		observe: async () => ({ conversations: [] }),
		connect: noHost,
	}));
	t.after(() => manager.close());
	const due = Array.from({ length: 5 }, (_, index) => {
		const record = createRecord(manager, root, `due-${index}`);
		manager.catalog.markRecoveryDue(record.storageId, true);
		return record;
	});
	const clean = createRecord(manager, root, "clean");
	const primary = fakePrimary(new AbortController().signal);
	const registering = manager.registerPrimary("owner-1", primary.client);
	await acquired.waitForCount(2);
	assert.equal(activity.peak, 2, "at most two recoveries run at once");
	assert.equal(acquired.length, 2, "the queue holds the other due records until a slot frees");
	for (const gate of [...gates.values()]) gate();
	await registering;
	assert.deepEqual(acquired.slice().sort(), due.map((record) => record.storageId).sort(), "every due record recovers once and the clean record never launches");
	assert.equal(acquired.includes(clean.storageId), false);
	assert.deepEqual(manager.connectedStorageIds(), [], "delivery-only recovery stays out of the persistent client map");
});

it("serializes simultaneous primary registrations without duplicate recovery", { timeout: 60000 }, async (t) => {
	const root = fixtureRoot(t);
	const launched = eventLog<string>();
	const gates = new Map<string, () => void>();
	const activity = { active: 0, peak: 0 };
	let flowing = false;
	const manager = new AgentManager(managerOptions(root, {
		createPrimary: primaryFactory().factory,
		acquire: async (metadata) => {
			const storageId = metadata.storageId;
			launched.push(storageId);
			activity.active += 1;
			activity.peak = Math.max(activity.peak, activity.active);
			if (!flowing) {
				await new Promise<void>((release) => gates.set(`${storageId}:${launched.length}`, () => {
					flowing = true;
					release();
				}));
			}
			activity.active -= 1;
			return fakeConnection(metadata, async (method) => (method === "recovery-state" ? { workPending: true, deliveriesPending: true, deliveriesActive: true } : {}));
		},
		observe: async () => ({ conversations: [] }),
		connect: noHost,
	}));
	t.after(() => manager.close());
	const due = Array.from({ length: 5 }, (_, index) => {
		const record = createRecord(manager, root, `due-${index}`);
		manager.catalog.markRecoveryDue(record.storageId, true);
		return record;
	});
	const clean = createRecord(manager, root, "clean");
	const first = fakePrimary(new AbortController().signal);
	const second = fakePrimary(new AbortController().signal);
	const registering = Promise.all([
		manager.registerPrimary("owner-1", first.client),
		manager.registerPrimary("owner-2", second.client),
	]);
	await launched.waitForCount(2);
	assert.equal(activity.peak, 2, "the global recovery queue runs at most two launches");
	assert.equal(launched.length, 2, "the queue holds the remaining due records until a slot frees");
	for (const gate of [...gates.values()]) gate();
	await registering;
	assert.deepEqual(launched.slice().sort(), due.map((record) => record.storageId).sort(), "each due record launches exactly once across both registrations");
	assert.equal(new Set(launched).size, launched.length, "no duplicate launch");
	assert.equal(launched.includes(clean.storageId), false, "the clean control record never launches");
});

it("refuses to recover a due record with an unknown or live writer claim", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const acquired = eventLog<string>();
	const connected: string[] = [];
	const manager = new AgentManager(managerOptions(root, {
		createPrimary: primaryFactory().factory,
		acquire: async (metadata) => {
			acquired.push(metadata.storageId);
			return fakeConnection(metadata, async (method) => (method === "recovery-state" ? { workPending: false, deliveriesPending: false, deliveriesActive: false } : {}));
		},
		connect: async (metadata) => {
			connected.push(metadata.storageId);
			return fakeConnection(metadata, async (method) => (method === "recovery-state" ? { workPending: false, deliveriesPending: false, deliveriesActive: false } : {}));
		},
		observe: async () => ({ conversations: [] }),
	}));
	t.after(() => manager.close());
	const absent = createRecord(manager, root, "absent");
	manager.catalog.markRecoveryDue(absent.storageId, true);
	const dead = createRecord(manager, root, "dead");
	manager.catalog.markRecoveryDue(dead.storageId, true);
	writeClaim(dead, claimFor(dead, deadProcessId()));
	const unknown = createRecord(manager, root, "unknown");
	manager.catalog.markRecoveryDue(unknown.storageId, true);
	writeClaim(unknown, "{ not json");
	const live = createRecord(manager, root, "live");
	manager.catalog.markRecoveryDue(live.storageId, true);
	writeClaim(live, claimFor(live, process.pid));
	const primary = fakePrimary(new AbortController().signal);
	await manager.registerPrimary("owner-1", primary.client);
	assert.deepEqual(acquired.slice().sort(), [absent.storageId, dead.storageId].sort(), "absent and dead claims launch recovery");
	assert.deepEqual(connected, [live.storageId], "a live claim connects without launching");
	assert.equal(acquired.includes(unknown.storageId), false, "an unknown claim does not launch");
	assert.equal(connected.includes(unknown.storageId), false, "an unknown claim does not connect");
});

it("closes a delivery-only recovery connection when no work remains", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	let recoveryState = { workPending: false, deliveriesPending: true, deliveriesActive: true };
	let connection: FakeConnection | undefined;
	const manager = new AgentManager(managerOptions(root, {
		createPrimary: primaryFactory().factory,
		acquire: async (metadata) => {
			connection = fakeConnection(metadata, async (method) => (method === "recovery-state" ? recoveryState : {}));
			return connection;
		},
		observe: async () => ({ conversations: [] }),
		connect: noHost,
	}));
	t.after(() => manager.close());
	const record = createRecord(manager, root);
	manager.catalog.markRecoveryDue(record.storageId, true);
	const controller = new AbortController();
	const primary = fakePrimary(controller.signal);
	await manager.registerPrimary("owner-1", primary.client);
	const active = connection;
	assert.ok(active);
	assert.equal(active.closed, false, "pending deliveries keep the recovery connection open");
	recoveryState = { workPending: false, deliveriesPending: false, deliveriesActive: false };
	active.change();
	await waitForConnectionClose(active);
	assert.deepEqual(manager.connectedStorageIds(), [], "delivery-only connections stay out of the client map");
});

it("pages list rows and reports unavailable storages", { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t);
	const bootstrap = new AgentManager(managerOptions(root, { connect: noHost }));
	const first = createRecord(bootstrap, root, "owner-a");
	createRecord(bootstrap, root, "owner-a");
	bootstrap.close();
	const manager = new AgentManager(managerOptions(root, {
		connect: noHost,
		observe: async (metadata, method, params) => {
			if (method !== "list") return { conversations: [] };
			if (metadata.storageId === first.storageId) {
				const cursor = (params as { cursor?: string }).cursor;
				return cursor === "next" ? { items: [{ identity: `${metadata.storageId}:2` }] } : { items: [{ identity: `${metadata.storageId}:1` }], next: "next" };
			}
			throw new Error("storage is unavailable");
		},
	}));
	const result = await manager.list({ limit: 5 }) as { rows: Array<{ identity: string; storageId: string }>; coverage: { unavailable: Array<{ storageId: string }> } };
	assert.deepEqual(result.rows.map((row) => row.identity), [`${first.storageId}:1`, `${first.storageId}:2`]);
	assert.equal(result.rows.every((row) => row.storageId === first.storageId), true);
	assert.equal(result.coverage.unavailable.length, 1);
	manager.close();
});

for (const operation of ["submit", "task-submit"] as const) it(`preserves explicit origins and uses the ${operation} contract for absent origin`, async (t) => {
	const root = fixtureRoot(t);
	const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
	const manager = new AgentManager(managerOptions(root, {
		validateModel: () => {},
		acquire: async (metadata) => fakeConnection(metadata, async (method, params) => {
			seen.push({ method, params: params as Record<string, unknown> });
			return { submissionId: 9 };
		}, operation === "submit" ? BASE_SUBMIT_CONTRACT : HOST_CONTRACT),
	}));
	const record = createRecord(manager, root);
	const caller = { id: "caller", cwd: root, model: { provider: "fixture", modelId: "model-1" } };
	const previous = process.env.PI_AGENT_CHECK_IN_MINUTES;
	process.env.PI_AGENT_CHECK_IN_MINUTES = "7";
	try {
		await manager.control("submit", { sessionId: record.storageId, message: "operator task", origin: "operator" }, caller);
		await manager.control("submit", { sessionId: record.storageId, message: "model task", origin: "model" }, caller);
		await manager.control("submit", { sessionId: record.storageId, message: "absent origin" }, caller);
		await manager.spawn({ prompt: "board task", origin: "operator" }, caller);
		await manager.spawn({ prompt: "model task", origin: "model" }, caller);
		await manager.spawn({ prompt: "opt out", origin: "model", checkInMinutes: 0 }, caller);
		await manager.spawn({ prompt: "unspecified origin" }, caller);
		await manager.spawn({ origin: "model" }, caller);
		const submits = seen.filter((entry) => entry.method === operation);
		assert.equal(submits[0]?.params.origin, "operator");
		assert.equal(submits[1]?.params.origin, "model");
		assert.equal(submits[2]?.params.origin, operation === "submit" ? undefined : "operator");
		assert.equal(submits[3]?.params.origin, "operator");
		assert.equal(submits[3]?.params.checkInMinutes, 0);
		assert.equal(submits[4]?.params.checkInMinutes, 7);
		assert.equal(submits[5]?.params.checkInMinutes, 0);
		assert.equal(submits[6]?.params.origin, operation === "submit" ? undefined : "operator");
		assert.equal(submits[6]?.params.checkInMinutes, 0);
		assert.equal(submits.length, 7, "a promptless spawn arms no task");
		if (operation === "task-submit") assert.ok(submits.every((entry) => entry.params.requester === caller.id));
		assert.ok(submits.every((entry) => entry.params.ownerId === caller.id));
	} finally {
		manager.close();
		if (previous === undefined) delete process.env.PI_AGENT_CHECK_IN_MINUTES;
		else process.env.PI_AGENT_CHECK_IN_MINUTES = previous;
	}
});

it("returns a compact status snapshot from a mutation instead of the full status", async (t) => {
	const root = fixtureRoot(t);
	const fullStatus = {
		conversation: {
			conversationId: 1,
			identity: "storage-a",
			name: "Review parser",
			firstMessage: "review the parser and report every finding",
			cwd: root,
			busy: false,
			lastText: "working on it",
			agent: { model: { provider: "fixture", modelId: "model-1" }, thinkingLevel: "high", tools: ["bash", "write"], extensions: ["agent", "other"] },
			live: { run: { taskId: 4 }, tools: [{ name: "bash", status: "running" }] },
			submissions: [{ id: 1, type: "input", status: "done" }],
		},
		inventory: { contributions: [{ source: "a" }], ordinaryOnly: ["/home/example/extensions/legacy.ts"] },
		pid: 42,
		storageId: "storage-a",
	};
	const manager = new AgentManager(managerOptions(root, {
		validateModel: () => {},
		acquire: async (metadata) => fakeConnection(metadata, async (method) => (method === "status" ? fullStatus : { submissionId: 5 })),
	}));
	try {
		const outcome = await manager.spawn({ prompt: "review the parser", origin: "operator" }, { id: "caller", cwd: root, model: { provider: "fixture", modelId: "model-1" } }) as {
			status: { identity: string; conversationId: number; name?: string; cwd?: string; busy: boolean; state: string; agent: { model?: { provider: string; modelId: string }; thinkingLevel: string }; limits?: { ordinaryOnly: string[] } };
		};
		assert.equal(outcome.status.identity, "storage-a");
		assert.equal(outcome.status.conversationId, 1);
		assert.equal(outcome.status.name, "Review parser");
		assert.equal(outcome.status.cwd, root);
		assert.equal(outcome.status.busy, false);
		assert.equal(outcome.status.state, "idle");
		assert.deepEqual(outcome.status.agent.model, { provider: "fixture", modelId: "model-1" });
		assert.equal(outcome.status.agent.thinkingLevel, "high");
		assert.deepEqual(outcome.status.limits?.ordinaryOnly, ["/home/example/extensions/legacy.ts"]);
		const serialized = JSON.stringify(outcome);
		assert.equal(serialized.includes("firstMessage"), false, "the prompt excerpt does not repeat in the spawn result");
		assert.equal(serialized.includes("lastText"), false, "live assistant text stays out of the spawn result");
		assert.equal(serialized.includes("submissions"), false, "the submission inventory stays out of the spawn result");
		assert.ok(serialized.length < 1024, `compact spawn result stays small (was ${serialized.length} characters)`);
	} finally { manager.close(); }
});

it("shares one real attach across concurrent reads and a canceled live selection", { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t);
	const entered = deferred();
	const gate = deferred();
	const links: HostConnection[] = [];
	let acquisitions = 0;
	const manager = new AgentManager(managerOptions(root, {
		connect: async (metadata) => { const link = await connectHost(metadata, { retryAttempts: 0 }); links.push(link); entered.resolve(); await gate.promise; return link; },
		acquire: async () => { acquisitions++; throw new Error("observation must not launch"); },
	}));
	const record = createRecord(manager, root);
	const host = await runHost(() => ({ request: async () => ({}), close: async () => {}, isIdle: () => true }), { metadata: hostMetadata(record), idleMs: 0, announceReady: () => {} });
	t.after(async () => { gate.resolve(); manager.close(); await host.close(); });
	const cancel = new AbortController();
	const reads = Promise.all([manager.status(record.storageId), manager.snapshot(record.storageId), manager.observeLive(record.storageId, "conversation", () => {}, cancel.signal)]);
	await entered.promise;
	assert.equal(links.length, 1);
	cancel.abort();
	gate.resolve();
	const results = await reads;
	assert.equal(results[2], undefined);
	assert.equal(links.length, 1);
	assert.equal(acquisitions, 0);
	manager.close();
	await waitForConnectionClose(links[0]);
	assert.equal(links.every((link) => link.closed), true);
});

it("retains a healthy attachment when its optional change subscription fails", async (t) => {
	const root = fixtureRoot(t);
	const links: FakeConnection[] = [];
	const manager = new AgentManager(managerOptions(root, {
		connect: async (metadata) => { const link = fakeConnection(metadata, async () => ({})); link.subscribeChanges = async () => { throw new Error("subscription rejected"); }; links.push(link); return link; },
		acquire: noHost, observe: async () => ({}),
	}));
	t.after(() => manager.close());
	const record = createRecord(manager, root);
	await manager.status(record.storageId);
	assert.equal(links.length, 1);
	assert.equal(links[0].closed, false);
	assert.deepEqual(manager.connectedStorageIds(), [record.storageId]);
	const overview = await manager.status() as { failures: Array<{ storageId: string; error: string }> };
	assert.ok(overview.failures.some((failure) => failure.storageId === `changes:${record.storageId}` && /Live change notices.*Restart/u.test(failure.error)));
});

it("keeps acquired clients usable when only their current change contracts disagree", async (t) => {
	const root = fixtureRoot(t);
	const { changes: _changes, ...withoutChanges } = HOST_CONTRACT.operations;
	const peers: RuntimeContract[] = [
		{ ...HOST_CONTRACT, operations: { ...HOST_CONTRACT.operations, changes: { ...HOST_CONTRACT.operations.changes, request: "changes/2.0.0" } } },
		{ ...HOST_CONTRACT, operations: { ...HOST_CONTRACT.operations, changes: { ...HOST_CONTRACT.operations.changes, response: "changes/2.0.0" } } },
		{ ...HOST_CONTRACT, operations: withoutChanges },
	];
	for (const remote of peers) {
		let acquisitions = 0;
		let link: FakeConnection | undefined;
		const methods: string[] = [];
		const manager = new AgentManager(managerOptions(root, {
			acquire: async (metadata) => {
				acquisitions++;
				link = fakeConnection(metadata, async (method) => {
					assert.equal(contractRefusal(method, remote), undefined);
					methods.push(method);
					return method === "task-submit" ? { submissionId: 7 } : { ready: true };
				}, remote);
				link.subscribeChanges = async () => { throw contractRefusal("changes", remote); };
				return link;
			},
			connect: noHost,
		}));
		t.after(() => manager.close());
		const record = createRecord(manager, root);
		assert.deepEqual(await manager.control("submit", { sessionId: record.storageId, message: "Compatible work" }, { id: "caller", cwd: root }), { submissionId: 7 });
		assert.ok(link);
		assert.equal(link.closed, false);
		assert.equal(acquisitions, 1);
		assert.deepEqual(manager.connectedStorageIds(), [record.storageId]);
		assert.deepEqual(await manager.status(record.storageId), { ready: true });
		assert.deepEqual(methods, ["task-submit", "status"]);
		const overview = await manager.status() as { failures: Array<{ storageId: string; error: string }> };
		assert.ok(overview.failures.some((failure) => failure.storageId === `changes:${record.storageId}` && /Live change notices.*Restart/u.test(failure.error)));
		await link.close();
		assert.deepEqual(manager.connectedStorageIds(), []);
		const afterClose = await manager.status() as { failures: Array<{ storageId: string; error: string }> };
		assert.equal(afterClose.failures.some((failure) => failure.storageId === `changes:${record.storageId}`), false);
		manager.close();
	}
});

it("releases a genuinely closed attachment when its change subscription fails", async (t) => {
	const root = fixtureRoot(t);
	let link: FakeConnection | undefined;
	const manager = new AgentManager(managerOptions(root, {
		connect: async (metadata) => {
			link = fakeConnection(metadata, async () => ({}));
			link.subscribeChanges = async () => { await link?.close(); throw new Error("connection closed during subscription"); };
			return link;
		},
		acquire: noHost, observe: async () => ({}),
	}));
	t.after(() => manager.close());
	const record = createRecord(manager, root);
	await manager.status(record.storageId);
	assert.equal(link?.closed, true);
	assert.deepEqual(manager.connectedStorageIds(), []);
});

it("closes a shared attachment that completes after manager shutdown", async (t) => {
	const root = fixtureRoot(t);
	const entered = deferred();
	const gate = deferred();
	const links: FakeConnection[] = [];
	const manager = new AgentManager(managerOptions(root, {
		connect: async (metadata) => { const link = fakeConnection(metadata, async () => ({})); links.push(link); entered.resolve(); await gate.promise; return link; },
		acquire: noHost,
	}));
	t.after(() => { gate.resolve(); manager.close(); });
	const record = createRecord(manager, root);
	const reading = manager.status(record.storageId);
	await entered.promise;
	assert.equal(links[0].closed, false);
	manager.close();
	gate.resolve();
	await assert.rejects(reading, /released while opening/u);
	assert.equal(links[0].closed, true);
	assert.deepEqual(manager.connectedStorageIds(), []);
});

it("lets explicit acquisition follow a failed shared attachment without making the read launch", async (t) => {
	const root = fixtureRoot(t);
	const entered = deferred();
	const gate = deferred();
	let acquisitions = 0;
	const manager = new AgentManager(managerOptions(root, {
		connect: async () => { entered.resolve(); await gate.promise; throw new Error("absent"); },
		acquire: async (metadata) => { acquisitions++; return fakeConnection(metadata, async () => ({})); },
		observe: async () => ({}),
	}));
	t.after(() => { gate.resolve(); manager.close(); });
	const record = createRecord(manager, root);
	const read = manager.status(record.storageId);
	await entered.promise;
	const attach = manager.control("attach", { sessionId: record.storageId }, { id: "caller", cwd: root });
	assert.equal(acquisitions, 0);
	gate.resolve();
	await Promise.all([read, attach]);
	assert.equal(acquisitions, 1);
});

it("refreshes the registered primary identity after model, thinking, and name changes", async (t) => {
	const root = fixtureRoot(t);
	const factory = primaryFactory();
	const manager = new AgentManager(managerOptions(root, { createPrimary: factory.factory, connect: noHost }));
	const primary = fakePrimary(new AbortController().signal);
	try {
		await manager.registerPrimary("owner-1", primary.client);
		const channel = factory.channels[0];
		assert.ok(channel);
		manager.updatePrimary("owner-1", { model: { provider: "anthropic", modelId: "claude-opus-5-5" } });
		manager.updatePrimary("owner-1", { thinkingLevel: "xhigh" });
		manager.updatePrimary("owner-1", { name: "primary review" });
		assert.deepEqual(channel.updates.at(-1), { name: "primary review", model: { provider: "anthropic", modelId: "claude-opus-5-5" }, thinkingLevel: "xhigh" });
		const status = await manager.status() as { primaries: Array<{ sessionId: string; name?: string; model?: { provider: string; modelId: string }; thinkingLevel?: string }> };
		assert.deepEqual(status.primaries, [{ sessionId: "owner-1", cwd: process.cwd(), name: "primary review", model: { provider: "anthropic", modelId: "claude-opus-5-5" }, thinkingLevel: "xhigh" }]);
	} finally { manager.close(); }
});
