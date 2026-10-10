import { machineConfig } from "./settings-fixture.mts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, it } from "node:test";

const preferenceOverride = process.env.PI_HARNESS_FILE;
delete process.env.PI_HARNESS_FILE;
after(() => { if (preferenceOverride !== undefined) process.env.PI_HARNESS_FILE = preferenceOverride; });
import { AgentCatalog, hostMetadata, type CatalogRecord } from "./catalog.ts";
import { dashboardText } from "./dashboard-roster.ts";
import { connectHost, type HostConnection } from "./host-client.ts";
import { runHost } from "./host-process.ts";
import { hostPaths, type HostMetadata } from "./host-protocol.ts";
import { HOST_CONTRACT, contractRefusal, type RuntimeContract } from "./version-contract.ts";
import { eventLog, waitForConnectionClose } from "./host-fixture.mts";
import { AgentManager, type AgentManagerOptions } from "./manager.ts";
import type { ExecutionSelection } from "./agent-preferences.ts";
import { connectPrimaryChannel, type PrimaryChannel, type PrimaryChannelOptions, type PrimaryInfo } from "./primary-channel.ts";
import type { createPrimaryChannel } from "./primary-channel.ts";

function fixtureRoot(t: { after(fn: () => void): void }): string {
	const root = mkdtempSync(join(tmpdir(), "agent-manager-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "agent"));
	writeFileSync(join(root, "agent", "harness.json"), JSON.stringify(machineConfig({ presets: { standard: { model: "acme/model-x" } }, preferences: { defaultPreset: "standard" } })));
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
		model: { provider: "acme", modelId: "model-x" },
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

function nativeAdmission(params: unknown, submissionId = 9): Record<string, unknown> {
	const input = params as Record<string, unknown>;
	const sessionId = String(input.sessionId);
	return { submissionId, identity: sessionId, requestId: input.requestId, result: { sessionId, submissionId, requestId: input.requestId } };
}

for (const failure of ["persistence", "status", "listener"] as const) it(`keeps successful admission and in-memory scope after a sent-work ${failure} callback throws`, async (t) => {
	const root = fixtureRoot(t);
	let failCallbacks = false;
	const scope = new Set<string>();
	const manager = new AgentManager(managerOptions(root, {
		createPrimary: primaryFactory().factory,
		acquire: async (metadata) => fakeConnection(metadata, async (method, params) => {
			assert.equal(method, "task-submit");
			failCallbacks = true;
			return nativeAdmission(params);
		}),
	}));
	let unsubscribe = () => {};
	t.after(() => { failCallbacks = false; unsubscribe(); manager.close(); });
	const target = createRecord(manager, root, "other-primary").storageId;
	manager.catalog.updateView(target, {
		updatedAt: new Date().toISOString(), coverage: { complete: true, omitted: 0 },
		rows: [{ id: `${target}:2`, storageId: target, cwd: root, modifiedAt: 1, owner: "unknown", state: "idle", cost: 50, partial: false }],
	});
	await manager.registerPrimary("primary", {
		signal: new AbortController().signal, send() {}, sentWork: scope,
		retainSentWork: () => { if (failCallbacks && failure === "persistence") throw new Error("marker write failed"); },
		status: () => { if (failCallbacks && failure === "status") throw new Error("status callback failed"); },
	});
	unsubscribe = manager.subscribeRoster(() => { if (failCallbacks && failure === "listener") throw new Error("roster callback failed"); });
	const outcome = await manager.control("submit", { sessionId: `${target}:2`, message: "Task", requestId: "admission" }, { id: "primary", cwd: root }) as { result: unknown; submissionId: number };
	assert.equal(outcome.submissionId, 9);
	assert.deepEqual(outcome.result, { sessionId: `${target}:2`, submissionId: 9, requestId: "admission" });
	assert.deepEqual([...scope], [`${target}:2`]);
	const page = await manager.dashboardPage();
	assert.equal(await manager.sessionFigures("primary", page), "agents: 0/1 active", "admitted scope survives callback failure and excludes reused cost");
	const overview = await manager.status() as { failures: Array<{ error: string }> };
	assert.ok(overview.failures.some(({ error }) => error.includes(failure === "persistence" ? "marker write failed" : `${failure === "status" ? "status" : "roster"} callback failed`)));
});

it("retains successful work targets across manager submission paths, not reports, attachment, or failed admissions", async (t) => {
	const root = fixtureRoot(t);
	const retained: string[] = [];
	const primary = fakePrimary(new AbortController().signal);
	const manager = new AgentManager(managerOptions(root, {
		createPrimary: primaryFactory().factory, validateModel: () => {},
		acquire: async (metadata) => fakeConnection(metadata, async (method, params) => {
			const input = params as Record<string, unknown>;
			switch (method) {
				case "task-submit":
					if (input.message === "fail") throw new Error("admission refused");
					return nativeAdmission(params);
				case "profile-read": return { handle: "@reviewer", live: true, model: metadata.model, thinkingLevel: "off" };
				case "rewind": return { identity: `${metadata.storageId}:5`, submissionId: 10 };
				case "timer-schedule": return { identity: `${metadata.storageId}:6`, timerId: 1 };
				default: return {};
			}
		}),
	}));
	t.after(() => manager.close());
	await manager.registerPrimary("primary", { ...primary.client, retainSentWork: (id) => retained.push(id) });
	const caller = { id: "primary", cwd: root };
	const target = createRecord(manager, root, "other-primary").storageId;
	for (const [method, suffix, whenBusy] of [["submit", 2, "followUp"], ["submit", 3, "steer"], ["task-submit", 4, "followUp"]] as const) {
		await manager.control(method, { sessionId: `${target}:${suffix}`, message: "Task", whenBusy, replyTo: "another-primary" }, caller);
		assert.ok(retained.includes(`${target}:${suffix}`));
	}
	await manager.control("rewind", { sessionId: target, correction: "Correction", entryId: "1" }, caller);
	await manager.control("timer-schedule", { sessionId: target, message: "Task" }, caller);
	assert.ok(retained.includes(`${target}:5`));
	assert.ok(retained.includes(`${target}:6`));
	const beforeIdle = retained.length;
	await manager.control("submit", { sessionId: `${target}:2`, message: "Again" }, caller);
	await manager.control("report", { sessionId: target, message: "Report" }, caller);
	await manager.control("attach", { sessionId: target }, caller);
	await assert.rejects(manager.control("submit", { sessionId: target, message: "fail" }, caller), /admission refused/u);
	await manager.spawn({}, caller);
	assert.equal(retained.length, beforeIdle, "duplicate targets and non-work controls add no markers");
	const spawned = await manager.spawn({ prompt: "Task" }, caller) as { sessionId: string };
	assert.ok(retained.includes(spawned.sessionId));
	const handled = await manager.spawn({ handle: "reviewer", role: "Review", prompt: "Task" }, caller) as { sessionId: string };
	assert.ok(retained.includes(handled.sessionId));
	const count = retained.length;
	await manager.spawn({ handle: "reviewer", prompt: "Again" }, caller);
	assert.equal(retained.length, count);
	const placed = await manager.place({ area: root, prompt: "Task" }, caller) as { sessionId: string };
	assert.ok(retained.includes(placed.sessionId));
	const placeCount = retained.length;
	await manager.place({ area: root, prompt: "Again" }, caller);
	assert.equal(retained.length, placeCount);
	const secondPrimary = fakePrimary(new AbortController().signal);
	const other: string[] = [];
	await manager.registerPrimary("second-primary", { ...secondPrimary.client, retainSentWork: (id) => other.push(id) });
	await manager.control("submit", { sessionId: target, message: "Task" }, { id: "second-primary", cwd: root });
	assert.deepEqual(other, [target]);
	assert.equal(retained.includes(target), false, "one primary never adopts another primary's work");
});

for (const operation of ["submit", "task-submit"] as const) for (const minutes of [undefined, 0, 2.5]) it(`preserves the place model interval ${minutes} through ${operation} on create and reuse`, async (t) => {
	const root = fixtureRoot(t);
	const submits: Array<Record<string, unknown>> = [];
	const manager = new AgentManager(managerOptions(root, { validateModel: () => {}, acquire: async (metadata) => fakeConnection(metadata, async (method, params) => {
		if (method === operation) { submits.push(params as Record<string, unknown>); return nativeAdmission(params, submits.length); }
		return { busy: false };
	}, operation === "submit" ? BASE_SUBMIT_CONTRACT : HOST_CONTRACT) }));
	t.after(() => manager.close());
	const prior = process.env.PI_AGENT_CHECK_IN_MINUTES;
	process.env.PI_AGENT_CHECK_IN_MINUTES = "7";
	t.after(() => { if (prior === undefined) delete process.env.PI_AGENT_CHECK_IN_MINUTES; else process.env.PI_AGENT_CHECK_IN_MINUTES = prior; });
	const caller = { id: "owner-1", cwd: root, model: { provider: "acme", modelId: "model-x" }, thinkingLevel: "off" };
	const input = { area: root, prompt: "Task", origin: "model" as const, checkInMinutes: minutes };
	if (operation === "submit") {
		await assert.rejects(manager.place(input, caller), /does not advertise task-submit/u);
		assert.equal(submits.length, 0, "no fallback admission occurs");
		return;
	}
	await manager.place(input, caller);
	await manager.place(input, caller);
	assert.equal(submits.length, 2);
	assert.deepEqual(submits.map((params) => params.checkInMinutes), [minutes ?? 7, minutes ?? 7]);
	assert.deepEqual(submits.map((params) => params.origin), ["model", "model"]);
	assert.deepEqual(submits.map((params) => params.requester), [caller.id, caller.id]);
	await manager.place({ area: root, prompt: "Operator task", origin: "operator" }, caller);
	assert.equal(submits[2]?.checkInMinutes, 0);
});

it("retains exact prompted handle references across creation and reuse", async (t) => {
	const root = fixtureRoot(t);
	const seen: Record<string, unknown>[] = [];
	const manager = new AgentManager(managerOptions(root, { validateModel: () => {}, acquire: async (metadata) => fakeConnection(metadata, async (method, params) => {
		if (method === "profile-read") return { handle: "@reviewer", live: true, model: metadata.model, thinkingLevel: metadata.thinkingLevel };
		assert.equal(method, "task-submit");
		seen.push(params as Record<string, unknown>);
		return nativeAdmission(params, seen.length);
	}) }));
	t.after(() => manager.close());
	const caller = { id: "owner", cwd: root, model: { provider: "acme", modelId: "model-x" } };
	for (const [index, requestId] of ["handle:first", "handle:next"].entries()) {
		const outcome = await manager.spawn({ handle: "reviewer", role: "Review work", prompt: "Task", requestId }, caller) as { sessionId: string; created: boolean; result: unknown };
		assert.equal(outcome.created, index === 0);
		assert.deepEqual(outcome.result, { sessionId: outcome.sessionId, submissionId: index + 1, requestId });
	}
	assert.ok(seen.every((params) => params.whenBusy === "followUp" && params.requester === caller.id));
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
		const outcome = await manager.spawn({ prompt: "work" }, { id: "owner", cwd: root, model: { provider: "acme", modelId: "model-x" } }) as { sessionId: string; admission: { submissionId: number }; snapshotError: string };
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
			return method === "task-submit" ? nativeAdmission(params) : {};
		}, operation === "submit" ? BASE_SUBMIT_CONTRACT : HOST_CONTRACT),
	}));
	const record = createRecord(manager, root);
	try {
		if (operation === "submit") {
			await assert.rejects(manager.control("submit", { sessionId: record.storageId, requestId: "stable:submit" }, { id: "caller", cwd: root }), /does not advertise task-submit/u);
			assert.equal(seen.length, 0);
			return;
		}
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

for (const scope of ["creation", "sent-work"] as const) it(`refreshes ${scope} footer counts from external catalog publications without a dashboard or host connection`, { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t);
	const manager = new AgentManager(managerOptions(root, {
		createPrimary: primaryFactory().factory,
		acquire: async () => { throw new Error("Footer observation must not acquire a host"); },
		connect: async () => { throw new Error("Footer observation must not connect to a host"); },
		observe: async () => { throw new Error("Footer observation must not read native state"); },
	}));
	t.after(() => manager.close());
	const record = createRecord(manager, root, scope === "creation" ? "primary" : "other-primary");
	writeClaim(record, claimFor(record, process.pid));
	const unrelated = createRecord(manager, root, "unrelated-primary");
	writeClaim(unrelated, claimFor(unrelated, process.pid));
	const writer = new AgentCatalog(root);
	const publish = (state: "idle" | "working") => writer.updateView(record.storageId, {
		updatedAt: new Date().toISOString(), coverage: { complete: true, omitted: 0 },
		rows: [
			{ id: record.storageId, storageId: record.storageId, cwd: root, owner: "here", state: "idle", modifiedAt: 1, cost: 0.25, partial: false },
			{ id: `${record.storageId}:2`, storageId: record.storageId, cwd: root, owner: "here", state, modifiedAt: 1, cost: 0.5, partial: false },
		],
	});
	writer.updateView(unrelated.storageId, {
		updatedAt: new Date().toISOString(), coverage: { complete: true, omitted: 0 },
		rows: [{ id: unrelated.storageId, storageId: unrelated.storageId, cwd: root, owner: "here", state: "working", modifiedAt: 1, cost: 50, partial: false }],
	});
	publish("idle");
	const primary = fakePrimary(new AbortController().signal);
	await manager.registerPrimary("primary", { ...primary.client, ...(scope === "sent-work" ? { sentWork: new Set([record.storageId]) } : {}) });
	const idle = scope === "creation" ? "agents: 0/2 active · ~$0.75" : "agents: 0/1 active";
	const working = scope === "creation" ? "agents: 1/2 active · ~$0.75" : "agents: 1/2 active";
	assert.equal(primary.statuses.at(-1), idle);
	for (const [state, expected] of [["working", working], ["idle", idle]] as const) {
		const before = primary.statuses.length;
		publish(state);
		await primary.statuses.waitFor((items) => items.length > before && items.at(-1) === expected);
	}
	assert.deepEqual(manager.connectedStorageIds(), []);
});

it("shares catalog observation across primary reload, replacement, and roster teardown", { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t);
	const manager = new AgentManager(managerOptions(root, { createPrimary: primaryFactory().factory }));
	t.after(() => manager.close());
	const record = createRecord(manager, root, "primary");
	writeClaim(record, claimFor(record, process.pid));
	const writer = new AgentCatalog(root);
	const publish = (state: "idle" | "working") => writer.updateView(record.storageId, {
		updatedAt: new Date().toISOString(), coverage: { complete: true, omitted: 0 },
		rows: [{ id: record.storageId, storageId: record.storageId, cwd: root, owner: "here", state, modifiedAt: 1, cost: 0, partial: false }],
	});
	publish("idle");
	const registrations = () => readdirSync(join(manager.catalog.root, ".observers"));
	const oldAbort = new AbortController();
	const old = fakePrimary(oldAbort.signal);
	await manager.registerPrimary("primary", old.client);
	assert.equal(registrations().length, 1);
	const off = manager.subscribeRoster(() => {});
	off();
	assert.equal(registrations().length, 1, "closing the dashboard keeps primary observation");
	const replacementAbort = new AbortController();
	const replacement = fakePrimary(replacementAbort.signal);
	await manager.registerPrimary("primary", replacement.client);
	const oldCount = old.statuses.length;
	oldAbort.abort();
	assert.equal(registrations().length, 1, "a replaced primary cannot stop its replacement's observer");
	publish("working");
	await replacement.statuses.waitFor((items) => items.at(-1) === "agents: 1/1 active");
	assert.equal(old.statuses.length, oldCount, "the replaced callback receives no further status");
	replacementAbort.abort();
	assert.equal(replacement.statuses.at(-1), undefined);
	assert.deepEqual(registrations(), [], "the last primary releases observation without a dashboard");
	const reloadAbort = new AbortController();
	const reload = fakePrimary(reloadAbort.signal);
	await manager.registerPrimary("primary", reload.client);
	assert.equal(reload.statuses.at(-1), "agents: 1/1 active", "reload reads the current published state");
	assert.equal(registrations().length, 1);
	const before = reload.statuses.length;
	publish("idle");
	await reload.statuses.waitFor((items) => items.length > before && items.at(-1) === "agents: 0/1 active");
	const roster = eventLog<void>();
	const offRoster = manager.subscribeRoster(() => roster.push(undefined));
	reloadAbort.abort();
	assert.equal(registrations().length, 1, "an open dashboard retains observation after the last primary stops");
	const stoppedCount = reload.statuses.length;
	const notices = roster.length;
	publish("working");
	await roster.waitForCount(notices + 1);
	assert.equal(reload.statuses.length, stoppedCount, "an aborted primary receives no late publication");
	offRoster();
	assert.deepEqual(registrations(), []);
	manager.close();
	offRoster();
	assert.deepEqual(registrations(), [], "repeated teardown leaves no observation registration");
});

it("clears a catalog observation startup failure after a successful subscription", async (t) => {
	const root = fixtureRoot(t);
	const manager = new AgentManager(managerOptions(root, { createPrimary: primaryFactory().factory }));
	t.after(() => manager.close());
	createRecord(manager, root, "primary");
	const observers = join(manager.catalog.root, ".observers");
	writeFileSync(observers, "blocked");
	await manager.registerPrimary("primary", fakePrimary(new AbortController().signal).client);
	const failures = async () => (await manager.status() as { failures: Array<{ storageId: string; error: string }> }).failures;
	assert.ok((await failures()).some((failure) => failure.storageId === "catalog-observation" && failure.error.includes("Catalog updates are unavailable")));
	rmSync(observers);
	const off = manager.subscribeRoster(() => {});
	t.after(off);
	assert.equal(readdirSync(observers).length, 1, "a later consumer retries subscription after the blocked path clears");
	assert.equal((await failures()).some((failure) => failure.storageId === "catalog-observation"), false, "successful observation clears the stale failure without releasing its primary");
});

it("resolves ordinary presets once for creation and preserves replay after file edits", async (t) => {
	const root = fixtureRoot(t); const options = managerOptions(root);
	mkdirSync(options.agentDir, { recursive: true });
	const path = join(options.agentDir, "harness.json");
	writeFileSync(path, JSON.stringify(machineConfig({ presets: { review: { model: "acme/model-x", thinkingLevel: "high", role: "Review", checkInMinutes: 2 } } })));
	const admitted: Record<string, unknown>[] = [];
	const manager = new AgentManager({ ...options, validateModel: () => "off", acquire: async (metadata) => fakeConnection(metadata, async (method, params) => {
		if (method === "task-submit") { admitted.push(params as Record<string, unknown>); return nativeAdmission(params); }
		return {};
	}) });
	t.after(() => manager.close());
	const caller = { id: "owner", cwd: root, model: { provider: "acme", modelId: "parent" }, thinkingLevel: "low" };
	const args = { preset: "review", requestId: "preset-create", prompt: "Review", origin: "model" as const };
	const first = await manager.spawn(args, caller) as { sessionId: string; selection: ExecutionSelection };
	assert.equal(manager.catalog.read(first.sessionId).model.modelId, "model-x");
	assert.equal(first.selection.origins.model, "preset");
	assert.deepEqual(first.selection.unapplied, ["role"]);
	assert.deepEqual(first.selection.thinking, { requested: "high", effective: "off" });
	assert.equal(admitted[0].checkInMinutes, 2);
	writeFileSync(path, "malformed");
	const replay = await manager.spawn({ ...args, selection: first.selection }, caller) as typeof first;
	assert.deepEqual(replay.selection, first.selection);
	assert.equal(replay.sessionId, first.sessionId);
	assert.equal(admitted[1].checkInMinutes, 2);
	await assert.rejects(manager.spawn({ preset: "review" }, caller), /review.*harness.json/u);
	await assert.rejects(manager.spawn({ ...args, thinkingLevel: "off", selection: first.selection }, caller), /different execution inputs/u);
});

for (const kind of ["handle", "place"] as const) it(`awaits ${kind} selection retention before downstream admission`, async (t) => {
	const root = fixtureRoot(t); const options = managerOptions(root);
	let admissions = 0;
	const manager = new AgentManager({ ...options, validateModel: () => "off", acquire: async (metadata) => fakeConnection(metadata, async (method, params) => {
		if (method === "task-submit" || method === "submit") { admissions++; return nativeAdmission(params); }
		return method === "profile-read" ? { handle: "@reviewer", live: true, model: metadata.model, thinkingLevel: metadata.thinkingLevel } : {};
	}) });
	t.after(() => manager.close());
	const entered = deferred(); const release = deferred();
	const caller = { id: "owner", cwd: root, model: { provider: "acme", modelId: "model-x" }, retainExecutionSelection: async () => { entered.resolve(); await release.promise; } };
	const run = () => kind === "handle" ? manager.spawn({ handle: "reviewer", prompt: "Work" }, caller) : manager.place({ area: root, prompt: "Work" }, caller);
	const pending = run();
	await entered.promise;
	assert.equal(admissions, 0);
	release.resolve(); await pending;
	assert.equal(admissions, 1);
	caller.retainExecutionSelection = async () => { throw new Error("Selection commit failed"); };
	await assert.rejects(run(), /Selection commit failed/u);
	assert.equal(admissions, 1, "a failed selection commit cannot admit another task");
});

it("reports preset creation fields as unapplied for reused handles and places", async (t) => {
	const root = fixtureRoot(t); const options = managerOptions(root);
	mkdirSync(options.agentDir, { recursive: true });
	writeFileSync(join(options.agentDir, "harness.json"), JSON.stringify(machineConfig({ presets: { review: { model: "acme/model-x", thinkingLevel: "high", role: "Review", checkInMinutes: 2 } } })));
	const manager = new AgentManager({ ...options, validateModel: () => "off", acquire: async (metadata) => fakeConnection(metadata, async (method, params) => method === "profile-read" ? { handle: "@reviewer", live: true, model: metadata.model, thinkingLevel: metadata.thinkingLevel } : method === "task-submit" ? nativeAdmission(params) : {}) });
	t.after(() => manager.close());
	const caller = { id: "owner", cwd: root, model: { provider: "acme", modelId: "parent" } };
	const first = await manager.spawn({ handle: "reviewer", preset: "review", prompt: "Work" }, caller) as { sessionId: string; selection: ExecutionSelection };
	assert.equal(manager.catalog.read(first.sessionId).view?.profileSeed?.role, "Review");
	const reused = await manager.spawn({ handle: "reviewer", preset: "review", model: "acme/override", prompt: "More" }, caller) as typeof first;
	assert.deepEqual(reused.selection.unapplied, ["model", "thinkingLevel", "role"]);
	assert.equal(reused.selection.values.model, "acme/model-x");
	const placed = await manager.place({ area: root, preset: "review", model: "acme/explicit", prompt: "Work" }, caller) as typeof first;
	assert.equal(manager.catalog.read(placed.sessionId).model.modelId, "explicit");
	const again = await manager.place({ area: root, preset: "review", prompt: "More" }, caller) as typeof first;
	assert.deepEqual(again.selection.unapplied, ["model", "thinkingLevel", "role"]);
	assert.equal(again.selection.values.model, "acme/explicit");
});

it("ordinary spawn and place creation share defaults, errors, override receipts, and opt-in enforcement", async (t) => {
	const root = fixtureRoot(t);
	const options = managerOptions(root);
	const path = join(options.agentDir, "harness.json");
	const validated: Array<{ model: string; level: string }> = [];
	const manager = new AgentManager({ ...options, validateModel: (model, level) => { validated.push({ model: `${model.provider}/${model.modelId}`, level }); return level; }, acquire: async (metadata) => fakeConnection(metadata, async (method) => method === "profile-read" ? { model: metadata.model, thinkingLevel: metadata.thinkingLevel } : {}) });
	t.after(() => manager.close());
	const caller = { id: "owner", cwd: root, model: { provider: "parent", modelId: "model-z" }, thinkingLevel: "max" };
	const document = (enforceRoster = false) => ({ version: 1, presets: { standard: { model: "acme/model-x" } }, preferences: { defaultPreset: "standard", enforceRoster } });
	writeFileSync(path, JSON.stringify(machineConfig(document())));
	for (const method of ["spawn", "place"] as const) {
		const first = await manager[method]({}, caller) as { sessionId: string; selection: ExecutionSelection };
		assert.equal(first.selection.origins.model, "defaultPreset");
		assert.deepEqual(first.selection.values, { model: "acme/model-x", thinkingLevel: "off" });
		assert.deepEqual(first.selection.presetNames, ["standard"]);
		assert.match(first.selection.source.digest ?? "", /^[a-f0-9]{64}$/u);
	}
	assert.deepEqual(validated, [{ model: "acme/model-x", level: "off" }, { model: "acme/model-x", level: "off" }]);
	const override = await manager.spawn({ model: "other/model-y" }, caller) as { selection: ExecutionSelection };
	assert.equal(override.selection.origins.model, "explicit");
	assert.match(override.selection.diagnostics[0].message, /Explicit model override.*matches no preset/u);
	writeFileSync(path, JSON.stringify(machineConfig(document(true))));
	await assert.rejects(manager.spawn({ model: "other/model-y" }, caller), /enforceRoster.*Presets: \["standard"\].*digest/u);
	const reused = await manager.place({ model: "other/model-y" }, caller) as { selection: ExecutionSelection };
	assert.equal(reused.selection.origins.model, "retained");
	assert.ok(reused.selection.unapplied.includes("model"));
	for (const content of [JSON.stringify(machineConfig({ presets: {} })), "malformed"]) {
		writeFileSync(path, content);
		await assert.rejects(manager.spawn({}, caller), /defaultPreset.*harness.json/u);
	}
	rmSync(path);
	await assert.rejects(manager.spawn({}, caller), /defaultPreset.*harness.json/u);
	const explicit = await manager.spawn({ model: "acme/model-x" }, caller) as { selection: ExecutionSelection };
	assert.equal(explicit.selection.source.status, "missing");
	assert.deepEqual(explicit.selection.presetNames, []);
});

it("retains ordinary reuse selections before dispatch and reports a raced handle as reused", async (t) => {
	const root = fixtureRoot(t); const options = managerOptions(root);
	mkdirSync(options.agentDir, { recursive: true });
	const path = join(options.agentDir, "harness.json");
	writeFileSync(path, JSON.stringify(machineConfig({ presets: { review: { model: "acme/model-x", role: "Review", checkInMinutes: 2 } } })));
	const entered = deferred(); const release = deferred(); let validation = 0;
	const selections: ExecutionSelection[] = [];
	const manager = new AgentManager({ ...options, validateModel: async () => { if (++validation === 1) { entered.resolve(); await release.promise; } return "off"; }, acquire: async (metadata) => fakeConnection(metadata, async (method, params) => method === "profile-read" ? { handle: "@reviewer", live: true, model: metadata.model, thinkingLevel: metadata.thinkingLevel } : method === "task-submit" ? nativeAdmission(params) : {}) });
	t.after(() => manager.close());
	const caller = { id: "owner", cwd: root, model: { provider: "acme", modelId: "parent" }, retainExecutionSelection: async (selection: ExecutionSelection) => { selections.push(structuredClone(selection)); } };
	const losing = manager.spawn({ handle: "reviewer", preset: "review", prompt: "Task" }, caller) as Promise<{ selection: ExecutionSelection; created: boolean }>;
	await entered.promise;
	await manager.spawn({ handle: "reviewer", model: "acme/winner", prompt: "Winner" }, caller);
	writeFileSync(path, "malformed"); release.resolve();
	const raced = await losing;
	assert.equal(raced.created, false);
	assert.equal(raced.selection.values.model, "acme/winner");
	assert.equal(raced.selection.values.checkInMinutes, 2);
	assert.deepEqual(raced.selection.unapplied, ["model", "role"]);
	const replay = await manager.spawn({ handle: "reviewer", preset: "review", prompt: "Task", selection: selections.at(-1) }, caller) as typeof raced;
	assert.deepEqual(replay.selection, raced.selection);
	writeFileSync(path, JSON.stringify(machineConfig({ presets: { review: { model: "acme/model-x", checkInMinutes: 3 } } })));
	await manager.place({ area: root, preset: "review" }, caller);
	const placed = await manager.place({ area: root, preset: "review", prompt: "Work" }, caller) as typeof raced;
	writeFileSync(path, "malformed");
	const placedReplay = await manager.place({ area: root, preset: "review", prompt: "Work", selection: selections.at(-1) }, caller) as typeof raced;
	assert.deepEqual(placedReplay.selection, placed.selection);
	assert.equal(placedReplay.selection.values.checkInMinutes, 3);
});

it("a fresh admission selects a replacement provider after a valid preset edit without retuning earlier agents", async (t) => {
	const root = fixtureRoot(t); const options = managerOptions(root); mkdirSync(options.agentDir, { recursive: true });
	const path = join(options.agentDir, "harness.json");
	const writePreset = (model: string) => writeFileSync(path, JSON.stringify(machineConfig({ presets: { review: { model }, alternate: { model: "other/model-y" } }, preferences: { excludedProviders: ["acme"], quotaSubstitutionOrder: ["alternate", "review"] } })));
	const validated: string[] = [];
	const manager = new AgentManager({ ...options, validateModel: (model) => { validated.push(`${model.provider}/${model.modelId}`); return "off"; }, acquire: async (metadata) => fakeConnection(metadata, async () => ({})) });
	t.after(() => manager.close());
	const caller = { id: "owner", cwd: root, model: { provider: "acme", modelId: "parent" } };
	writePreset("acme/model-x");
	const first = await manager.spawn({ preset: "review", requestId: "first" }, caller) as { sessionId: string; selection: ExecutionSelection };
	assert.equal(first.selection.values.model, "acme/model-x", "exclusion and substitution guidance do not replace the selected provider");
	writePreset("other/model-y");
	const second = await manager.spawn({ preset: "review", requestId: "second" }, caller) as typeof first;
	assert.equal(second.selection.values.model, "other/model-y");
	assert.notEqual(first.selection.source.digest, second.selection.source.digest);
	assert.notEqual(first.sessionId, second.sessionId);
	assert.deepEqual(manager.catalog.read(first.sessionId).model, { provider: "acme", modelId: "model-x" });
	assert.deepEqual(manager.catalog.read(second.sessionId).model, { provider: "other", modelId: "model-y" });
	const replay = await manager.spawn({ preset: "review", requestId: "first", selection: first.selection }, caller) as typeof first;
	assert.deepEqual(replay.selection, first.selection);
	assert.deepEqual(validated, ["acme/model-x", "other/model-y"]);
});

it("handle and place reuse report current configured evidence rather than immutable creation metadata", async (t) => {
	const root = fixtureRoot(t); const options = managerOptions(root); mkdirSync(options.agentDir, { recursive: true });
	writeFileSync(join(options.agentDir, "harness.json"), JSON.stringify(machineConfig({ presets: { review: { model: "acme/model-x", thinkingLevel: "high" } } })));
	const current = new Map<string, { model: { provider: string; modelId: string }; thinkingLevel: string }>();
	let evidenceUnavailable = false;
	const manager = new AgentManager({ ...options, validateModel: (_model, level) => level, acquire: async (metadata) => {
		const state = { model: metadata.model, thinkingLevel: metadata.thinkingLevel }; current.set(metadata.storageId, state);
		return fakeConnection(metadata, async (method, params) => {
			if (method === "configure") { state.model = { provider: "other", modelId: "model-y" }; state.thinkingLevel = "low"; return { outcome: "applied" }; }
			if (method === "profile-read") { if (evidenceUnavailable) throw new Error("profile unavailable"); return { handle: "@reviewer", live: true, ...state }; }
			if (method === "task-submit") return nativeAdmission(params);
			return {};
		});
	} });
	t.after(() => manager.close());
	const caller = { id: "owner", cwd: root, model: { provider: "acme", modelId: "parent" } };
	const handle = await manager.spawn({ handle: "reviewer", preset: "review" }, caller) as { sessionId: string };
	const place = await manager.place({ area: root, preset: "review" }, caller) as typeof handle;
	for (const target of [handle, place]) {
		await manager.control("configure", { sessionId: target.sessionId, model: "other/model-y", thinkingLevel: "low" }, caller);
		assert.deepEqual(manager.catalog.read(target.sessionId).model, { provider: "acme", modelId: "model-x" });
	}
	const reusedHandle = await manager.spawn({ handle: "reviewer", preset: "review", prompt: "Task" }, caller) as { selection: ExecutionSelection };
	const reusedPlace = await manager.place({ area: root, preset: "review" }, caller) as typeof reusedHandle;
	for (const { selection } of [reusedHandle, reusedPlace]) {
		assert.equal(selection.values.model, "other/model-y"); assert.equal(selection.values.thinkingLevel, "low");
		assert.deepEqual(selection.thinking, { requested: "low", effective: "low" });
		assert.equal(selection.origins.model, "retained"); assert.equal(selection.origins.thinkingLevel, "retained");
		assert.deepEqual(selection.unapplied, ["model", "thinkingLevel"]);
	}
	for (const state of current.values()) assert.deepEqual(state, { model: { provider: "other", modelId: "model-y" }, thinkingLevel: "low" });
	evidenceUnavailable = true;
	const unavailable = await manager.place({ area: root, preset: "review" }, caller) as typeof reusedHandle;
	assert.equal(unavailable.selection.values.model, undefined); assert.equal(unavailable.selection.values.thinkingLevel, undefined);
	assert.ok(unavailable.selection.diagnostics.some((fact) => fact.field === "retained" && /unavailable/u.test(fact.message)));
});

it("validates the spawn model before writing a catalog record", async (t) => {
	const root = fixtureRoot(t);
	const manager = new AgentManager(managerOptions(root, {
		validateModel: () => {
			throw new Error("model is not in the configured catalog");
		},
	}));
	try {
		await assert.rejects(manager.spawn({ model: "acme/missing" }, { id: "caller", cwd: root }), /configured catalog/u);
		const page = await manager.catalog.page({});
		assert.equal(page.records.length, 0, "no catalog record is written before validation");
	} finally { manager.close(); }
});

it("stores and reports the effective thinking level before ordinary dispatch", async (t) => {
	const root = fixtureRoot(t);
	const levels: string[] = [];
	const manager = new AgentManager(managerOptions(root, {
		validateModel: (_model, requested) => { assert.equal(requested, "max"); return "off"; },
		acquire: async (metadata) => {
			levels.push(metadata.thinkingLevel);
			return fakeConnection(metadata, async () => ({}));
		},
	}));
	try {
		const caller = { id: "caller", cwd: root, model: { provider: "acme", modelId: "plain" } };
		const outcome = await manager.spawn({ thinkingLevel: "max" }, caller) as { sessionId: string; thinking: unknown };
		assert.deepEqual(outcome.thinking, { requested: "max", effective: "off" });
		assert.deepEqual(levels, ["off"]);
		assert.equal(manager.catalog.read(outcome.sessionId).thinkingLevel, "off");
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
		await assert.rejects(manager.spawn({ model: "acme/model-x", prompt: "start" }, { id: "caller", cwd: root }), /host process failed to start/u);
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
		const outcome = await manager.control("attach", { sessionId: record.storageId, model: { provider: "acme", modelId: "missing" } }, { id: "caller", cwd: root }) as { outcome?: string; recovery?: string };
		assert.equal(outcome.outcome, "failed");
		assert.equal(outcome.recovery, undefined);
	} finally { manager.close(); }
});

for (const cached of [false, true]) it(`keeps a live host's recovery contract difference neutral (${cached ? "cached" : "transient"} link)`, { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t);
	let current = false;
	const recoveryReads = eventLog<void>();
	let openings = 0;
	const clients: HostConnection[] = [];
	const open = async (metadata: HostMetadata): Promise<HostConnection> => {
		openings++;
		const client = await connectHost(metadata, { retryAttempts: 0 });
		const subscribeChanges = client.subscribeChanges;
		assert.ok(subscribeChanges);
		const peer = { ...HOST_CONTRACT, operations: { ...HOST_CONTRACT.operations, "recovery-state": { ...HOST_CONTRACT.operations["recovery-state"], response: "recovery-state/1.0.0" } } };
		// Control the handshake snapshot and its local refusal while preserving the real live transport.
		const connection: HostConnection = current ? client : {
			pid: client.pid, socketPath: client.socketPath, storageId: client.storageId, metadata: client.metadata, runtimeContract: peer,
			get closed() { return client.closed; },
			request: async (method, params, options) => { const refusal = contractRefusal(method, peer); if (refusal) throw refusal; return client.request(method, params, options); },
			onClose: (listener) => client.onClose(listener), subscribeChanges: (listener, signal) => subscribeChanges.call(client, listener, signal), close: () => client.close(),
		};
		clients.push(connection);
		return connection;
	};
	const manager = new AgentManager(managerOptions(root, { connect: open, acquire: open, createPrimary: primaryFactory().factory }));
	t.after(() => manager.close());
	t.after(() => Promise.all(clients.map((client) => client.close())).then(() => {}));
	const record = createRecord(manager, root);
	manager.catalog.updateView(record.storageId, { updatedAt: new Date().toISOString(), rows: [{ id: record.storageId, storageId: record.storageId, cwd: root, modifiedAt: 1, owner: "here", state: "working", cost: 0, partial: false }], coverage: { complete: true, omitted: 0 } });
	const runtime = { request: async (method: string) => {
		if (method === "recovery-state") { recoveryReads.push(undefined); return { workPending: !current, deliveriesPending: false, deliveriesActive: false }; }
		return { busy: !current };
	}, close: async () => {}, isIdle: () => false };
	const host = await runHost(() => runtime, { metadata: hostMetadata(record), idleMs: 0, announceReady: () => {} });
	t.after(() => host.close());
	if (cached) await manager.control("attach", { sessionId: record.storageId }, { id: "owner-1", cwd: root });
	manager.catalog.markRecoveryDue(record.storageId, true);
	await manager.registerPrimary("owner-1", fakePrimary(new AbortController().signal).client);
	const crashes = (manager as unknown as { crashes: { entries: Iterable<unknown> } }).crashes;
	assert.equal([...crashes.entries].length, 0, "an operation refusal is not a host loss");
	assert.equal(openings, 1);
	assert.equal(recoveryReads.length, 0, "the caller never requests a response shape it cannot read");
	const page = await manager.dashboardPage();
	assert.equal(page.rows[0]?.state, "working");
	assert.equal(page.rows[0]?.health?.lastError, undefined);
	assert.match(page.rows[0]?.ownerLabel ?? "", /recovery-state.*1\.0\.0.*next start/iu);
	const status = await manager.status() as { sessions: Array<{ ownerLabel?: string }>; failures: unknown[] };
	assert.deepEqual(status.failures, []);
	assert.match(status.sessions[0]?.ownerLabel ?? "", /next start/u);
	await host.close();
	await Promise.all(clients.map((client) => waitForConnectionClose(client)));
	current = true;
	const updated = await runHost(() => runtime, { metadata: hostMetadata(record), idleMs: 0, announceReady: () => {} });
	t.after(() => updated.close());
	await manager.registerPrimary("owner-2", fakePrimary(new AbortController().signal).client);
	await recoveryReads.waitForCount(1);
	assert.equal([...crashes.entries].length, 0);
	assert.doesNotMatch((await manager.dashboardPage()).rows[0]?.ownerLabel ?? "", /next start/u);
});

it("stops repeated live host losses in Attention and permits an explicit attach retry", async (t) => {
	const root = fixtureRoot(t);
	const packageDir = join(root, "caller-installation");
	const connections = eventLog<FakeConnection>();
	const manager = new AgentManager(managerOptions(root, {
		createPrimary: primaryFactory().factory,
		packageDir,
		acquire: async (metadata, options) => {
			assert.equal(metadata.packageDir, packageDir, "explicit acquisition and loss recovery use the caller installation");
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
	const packageDir = join(root, "caller-installation");
	const manager = new AgentManager(managerOptions(root, {
		packageDir,
		createPrimary: primaryFactory().factory,
		acquire: async (metadata) => {
			assert.equal(metadata.packageDir, packageDir, "startup recovery uses the caller installation");
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
	const caller = { id: "caller", cwd: root, model: { provider: "acme", modelId: "model-x" } };
	const previous = process.env.PI_AGENT_CHECK_IN_MINUTES;
	process.env.PI_AGENT_CHECK_IN_MINUTES = "7";
	try {
		if (operation === "submit") {
			await assert.rejects(manager.control("submit", { sessionId: record.storageId, message: "operator task", origin: "operator" }, caller), /does not advertise task-submit/u);
			await assert.rejects(manager.spawn({ prompt: "task" }, caller), /does not advertise task-submit/u);
			assert.equal(seen.length, 0);
			return;
		}
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
		assert.equal(submits[2]?.params.origin, "operator");
		assert.equal(submits[3]?.params.origin, "operator");
		assert.equal(submits[3]?.params.checkInMinutes, 0);
		assert.equal(submits[4]?.params.checkInMinutes, 7);
		assert.equal(submits[5]?.params.checkInMinutes, 0);
		assert.equal(submits[6]?.params.origin, "operator");
		assert.equal(submits[6]?.params.checkInMinutes, 0);
		assert.equal(submits.length, 7, "a promptless spawn arms no task");
		assert.ok(submits.every((entry) => entry.params.requester === caller.id));
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
			agent: { model: { provider: "acme", modelId: "model-x" }, thinkingLevel: "high", tools: ["bash", "write"], extensions: ["agent", "other"] },
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
		const outcome = await manager.spawn({ prompt: "review the parser", origin: "operator" }, { id: "caller", cwd: root, model: { provider: "acme", modelId: "model-x" } }) as {
			status: { identity: string; conversationId: number; name?: string; cwd?: string; busy: boolean; state: string; agent: { model?: { provider: string; modelId: string }; thinkingLevel: string }; limits?: { ordinaryOnly: string[] } };
		};
		assert.equal(outcome.status.identity, "storage-a");
		assert.equal(outcome.status.conversationId, 1);
		assert.equal(outcome.status.name, "Review parser");
		assert.equal(outcome.status.cwd, root);
		assert.equal(outcome.status.busy, false);
		assert.equal(outcome.status.state, "idle");
		assert.deepEqual(outcome.status.agent.model, { provider: "acme", modelId: "model-x" });
		assert.equal(outcome.status.agent.thinkingLevel, "high");
		assert.deepEqual(outcome.status.limits?.ordinaryOnly, ["/home/example/extensions/legacy.ts"]);
		const serialized = JSON.stringify(outcome);
		assert.equal(serialized.includes("firstMessage"), false, "the prompt excerpt does not repeat in the spawn result");
		assert.equal(serialized.includes("lastText"), false, "live assistant text stays out of the spawn result");
		assert.equal(serialized.includes("submissions"), false, "the submission inventory stays out of the spawn result");
		assert.ok(JSON.stringify(outcome.status).length < 1024, "the compact status stays bounded independently of execution selection evidence");
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
		assert.deepEqual(await manager.control("submit", { sessionId: record.storageId, message: "Compatible work", requestId: "compatible" }, { id: "caller", cwd: root }), { submissionId: 7, result: { sessionId: record.storageId, submissionId: 7, requestId: "compatible" } });
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
