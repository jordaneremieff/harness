import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { hostMetadata } from "./catalog.ts";
import type { HostConnection } from "./host-client.ts";
import type { HostMetadata } from "./host-protocol.ts";
import { waitUntil } from "./host-fixture.mts";
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

interface FakeConnection extends HostConnection {
	/** Run every current change listener, as one native write notification would. */
	change(): void;
}

function fakeConnection(metadata: HostMetadata, handler: (method: string, params: unknown) => Promise<unknown>): FakeConnection {
	let closed = false;
	const listeners = new Set<() => void>();
	const changes = new Set<() => void>();
	return {
		pid: 4242,
		socketPath: "/tmp/fake-host.sock",
		storageId: metadata.storageId,
		metadata,
		get closed() {
			return closed;
		},
		async request(method, params) {
			return handler(method, params);
		},
		onClose(callback) {
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
			closed = true;
			for (const listener of [...listeners]) listener();
		},
	} as FakeConnection;
}

/** A structural stand-in for one registered primary client. */
function fakePrimary(signal: AbortSignal) {
	const sent: Array<{ text: string; details: unknown }> = [];
	const statuses: Array<string | undefined> = [];
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
			cwd: "/work",
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

interface CapturedPrimaryChannel {
	readonly options: PrimaryChannelOptions;
	closed: boolean;
}

/** Fake primary channel server; tests call `options.deliver` as a host connection would. */
function primaryFactory(onClose?: (channel: CapturedPrimaryChannel, invocation: number) => void | Promise<void>) {
	const channels: CapturedPrimaryChannel[] = [];
	let invocations = 0;
	const factory = async (options: PrimaryChannelOptions): Promise<PrimaryChannel> => {
		invocations += 1;
		const invocation = invocations;
		const captured: CapturedPrimaryChannel = { options, closed: false };
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
			close: async () => {
				captured.closed = true;
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

it("preserves supplied admission keys and creates absent keys", async (t) => {
	const root = fixtureRoot(t);
	const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
	const manager = new AgentManager(managerOptions(root, {
		acquire: async (metadata) => fakeConnection(metadata, async (method, params) => {
			seen.push({ method, params: params as Record<string, unknown> });
			return {};
		}),
	}));
	const record = createRecord(manager, root);
	try {
		for (const method of ["submit", "rewind", "fork"]) {
			await manager.control(method, { sessionId: record.storageId, requestId: `stable:${method}` }, { id: "caller", cwd: root });
			await manager.control(method, { sessionId: record.storageId }, { id: "caller", cwd: root });
		}
		const mutations = seen.filter((entry) => entry.method !== "status");
		assert.equal(mutations.length, 6);
		for (let index = 0; index < mutations.length; index += 2) {
			assert.equal(mutations[index].params.requestId, `stable:${mutations[index].method}`);
			assert.equal(typeof mutations[index + 1].params.requestId, "string");
			assert.notEqual(mutations[index + 1].params.requestId, mutations[index].params.requestId);
		}
		assert.ok(seen.some((entry) => entry.method === "status"), "mutation snapshots add filtered status requests");
	} finally { manager.close(); }
});

it("closes a host opened for a primary that aborts mid-registration", { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t);
	let release: ((connection: HostConnection) => void) | undefined;
	const manager = new AgentManager(managerOptions(root, {
		acquire: () => new Promise<HostConnection>((resolve) => {
			release = resolve;
		}),
		connect: noHost,
		observe: async () => ({ conversations: [{ busy: true }] }),
		createPrimary: primaryFactory().factory,
	}));
	const record = createRecord(manager, root);
	const controller = new AbortController();
	const primary = fakePrimary(controller.signal);
	const registering = manager.registerPrimary("owner-1", primary.client);
	await waitUntil(() => release !== undefined);
	controller.abort();
	const connection = fakeConnection(hostMetadata(record), async () => ({}));
	release?.(connection);
	await registering;
	await waitUntil(() => connection.closed);
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
		await waitUntil(() => channel.closed);
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

it("refreshes the durable footer at startup and after a host change", { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t);
	const factory = primaryFactory();
	let working = false;
	let connection: FakeConnection | undefined;
	const manager = new AgentManager(managerOptions(root, {
		createPrimary: factory.factory,
		acquire: async (metadata) => {
			connection = fakeConnection(metadata, async (method) => {
				if (method === "status") return { conversations: [{ busy: true }] };
				if (method === "dashboard") {
					return working
						? [{ id: metadata.storageId, storageId: metadata.storageId, cwd: metadata.cwd, name: "child", modifiedAt: Date.now(), owner: "here", state: "working", cost: 0, partial: false }]
						: [];
				}
				return {};
			});
			return connection;
		},
		connect: noHost,
		observe: async (_metadata, method) => (method === "dashboard" ? [] : { conversations: [{ busy: true }] }),
	}));
	createRecord(manager, root);
	const primary = fakePrimary(new AbortController().signal);
	try {
		await manager.registerPrimary("owner-1", primary.client);
		await waitUntil(() => primary.statuses.some((text) => text !== undefined));
		assert.match(primary.statuses.filter((text): text is string => text !== undefined).at(-1) ?? "", /agents 0 · \$0\.00/u);
		assert.ok(connection, "startup recovery acquired the busy storage");
		working = true;
		connection.change();
		await waitUntil(() => primary.statuses.some((text) => text?.includes("agents 1") === true));
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
