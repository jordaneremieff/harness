import assert from "node:assert/strict";
import { it } from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { markerFixture } from "./durable-runtime-fixture.mts";
import { fixtureProvider, fixtureModelId } from "./durable-host-fixture.mts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentManager } from "./manager.ts";
import { acquireHost, connectHost, type HostConnection } from "./host-client.ts";
import type { HostMetadata } from "./host-protocol.ts";
import { createAgentObservationSource, type AgentObservationHost } from "./agent-observation.ts";
import type { ObservationFrame, TasksFrame } from "./live-frames.ts";
import { conversationFrame, page, row, turn, deferred } from "./dashboard-test-fixture.mts";
it("selects a manager spawn before storage exists and attaches to its real host", { timeout: 60000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "agent-startup-"));
	let cleanup: () => Promise<void> = async () => {};
	t.after(() => cleanup());
	const launched = deferred<HostMetadata>();
	const markers = markerFixture(t, root);
	const releaseStart = markers.hold("host-start-gated");
	let connection: HostConnection | undefined;
	let connects = 0;
	const manager = new AgentManager({
		root, agentDir: join(root, "agent"), packageDir: join(root, "package"),
		validateModel() {},
		acquire: async (metadata, options) => {
			launched.resolve(metadata);
			connection = await acquireHost(metadata, { ...options, runner: fileURLToPath(new URL("./live-observation-fixture.mts", import.meta.url)), env: { DURABLE_TEST_HOST_START_GATE: markers.notifyPath } });
			return connection;
		},
		connect: async (metadata, options) => {
			connects++;
			return connectHost(metadata, options);
		},
	});
	const source = createAgentObservationSource({
		list: () => manager.dashboardPage(), snapshot: (id, params) => manager.snapshot(id, params),
		observeLive: (...args) => manager.observeLive(...args), subscribeRoster: (listener) => manager.subscribeRoster(listener),
	});
	const taskFrame = deferred();
	const off = source.subscribe(() => {
		const id = connection?.storageId;
		if (id && JSON.stringify(source.frame(id)?.entries ?? []).includes("startup task")) taskFrame.resolve();
	});
	const spawning = manager.spawn({ model: `${fixtureProvider}/${fixtureModelId}`, prompt: "startup task", origin: "operator" }, { id: "owner", cwd: root, model: { provider: "fixture", modelId: "model-1" } });
	cleanup = async () => {
		releaseStart();
		off();
		await spawning.catch(() => undefined);
		if (connection) {
			await connection.request("close").catch(() => undefined);
			await connection.close();
		}
		manager.close();
		rmSync(root, { recursive: true, force: true });
	};
	const metadata = await launched.promise;
	await markers.marker("host-start-gated");
	assert.equal(existsSync(metadata.storagePath), false, "the real child starts before it creates storage");
	source.select(metadata.storageId);
	const abandoned = new AbortController();
	let abandonedFrames = 0;
	const abandonedObservation = manager.observeLive(metadata.storageId, "conversation", () => { abandonedFrames++; }, abandoned.signal);
	abandoned.abort();
	const status = manager.status(metadata.storageId);
	const starting = (await source.list()).rows.find((row) => row.id === metadata.storageId);
	assert.equal(starting?.state, "starting");
	assert.equal(starting?.firstMessage, "startup task");
	const first = await source.snapshot(metadata.storageId);
	assert.deepEqual(first.entries, [], "a starting storage reads as empty, not an error");
	assert.equal(connects, 0, "observation joins the pending open instead of racing a second connection");
	releaseStart();
	await spawning;
	assert.equal(await abandonedObservation, undefined, "a canceled selection never attaches after readiness");
	assert.equal(abandonedFrames, 0);
	await status;
	await taskFrame.promise;
	assert.equal(connects, 0, "snapshot, status, and live observation reuse the manager's launch");
	assert.equal(source.availability(metadata.storageId)?.state, "live");
});

it("observes an absent catalog storage without acquiring a host", { timeout: 15000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "agent-absent-"));
	let acquires = 0;
	const manager = new AgentManager({
		root, agentDir: join(root, "agent"), packageDir: join(root, "package"),
		acquire: async () => { acquires++; throw new Error("observation must not launch"); },
	});
	const record = manager.catalog.create({ cwd: root, agentDir: join(root, "agent"), packageDir: join(root, "package"), model: { provider: "fixture", modelId: "model-1" }, thinkingLevel: "off", ownerId: "owner" });
	const source = createAgentObservationSource({
		list: () => manager.dashboardPage(), snapshot: (id, params) => manager.snapshot(id, params),
		observeLive: (...args) => manager.observeLive(...args), subscribeRoster: (listener) => manager.subscribeRoster(listener),
	});
	const unavailable = deferred();
	const off = source.subscribe(() => {
		if (source.availability(record.storageId)?.state === "unavailable") unavailable.resolve();
	});
	try {
		source.select(record.storageId);
		assert.deepEqual((await source.snapshot(record.storageId)).entries, []);
		await unavailable.promise;
		assert.equal(acquires, 0);
		assert.equal(source.frame(record.storageId), undefined);
	} finally {
		off();
		manager.close();
		rmSync(root, { recursive: true, force: true });
	}
});

function fixture() {
	const listeners = new Map<
		string,
		(frame: ObservationFrame | undefined, fresh: boolean, state?: "live" | "unavailable") => void
	>();
	const closed: string[] = [];
	let rosterListener = () => {};
	const snapshot = {
		entries: [],
		partial: true,
		revision: "cold",
		nextBefore: 7,
		coverage: {
			complete: false,
			entries: 0,
			bytes: 0,
			hiddenExcluded: 0,
			entryLimitReached: true,
			byteLimitReached: false,
		},
	};
	const host: AgentObservationHost = {
		list: async () => page([row()]),
		snapshot: async () => snapshot,
		observeLive: async (id, scope, listener) => {
			listeners.set(`${id}:${scope}`, listener);
			return () => {
				closed.push(`${id}:${scope}`);
				listeners.delete(`${id}:${scope}`);
			};
		},
		subscribeRoster: (listener) => {
			rosterListener = listener;
			return () => {
				rosterListener = () => {};
			};
		},
	};
	return { host, listeners, closed, snapshot, roster: () => rosterListener() };
}
it("only the selected conversation remains watched and cold reads keep continuation", async () => {
	const f = fixture();
	const source = createAgentObservationSource(f.host);
	const off = source.subscribe(() => {});
	source.select("one");
	await turn();
	assert.equal((await source.snapshot("one")).nextBefore, 7);
	source.select("two");
	await turn();
	assert.deepEqual(f.closed, ["one:conversation"]);
	assert.deepEqual([...f.listeners.keys()], ["two:conversation"]);
	off();
	assert.deepEqual(f.closed, ["one:conversation", "two:conversation"]);
});
it("a delayed attach after close releases its handle", async () => {
	const f = fixture();
	let resolve!: (off: () => void) => void;
	let closed = 0;
	f.host.observeLive = () =>
		new Promise((done) => {
			resolve = done;
		});
	const source = createAgentObservationSource(f.host);
	const off = source.subscribe(() => {});
	source.select("one");
	off();
	resolve(() => {
		closed++;
	});
	await turn();
	assert.equal(closed, 1);
});
it("refresh leaves a pending attachment alone and retries a declined attachment", async () => {
	const f = fixture();
	let attaches = 0;
	f.host.observeLive = async () => { attaches++; return undefined; };
	const source = createAgentObservationSource(f.host);
	const first = deferred();
	const second = deferred();
	const off = source.subscribe(() => {
		if (source.availability("one")?.state !== "unavailable") return;
		if (attaches === 1) first.resolve();
		else second.resolve();
	});
	try {
		source.select("one");
		source.refresh("one");
		assert.equal(attaches, 1, "a pending attachment is not duplicated");
		await first.promise;
		source.refresh("one");
		await second.promise;
		assert.equal(attaches, 2);
	} finally { off(); }
});

function taskFrame(storageId: string, revision = 1): TasksFrame {
	return {
		scope: "tasks", storageId, revision, observedAt: new Date(revision).toISOString(),
		tasks: [], labels: [], coverage: { complete: true, live: true },
	};
}
function attachmentFixture() {
	const f = fixture();
	type Attach = {
		id: string;
		scope: "conversation" | "tasks";
		listener: Parameters<AgentObservationHost["observeLive"]>[2];
		signal: AbortSignal | undefined;
		resolve: (release: (() => void) | undefined) => void;
		reject: (error: Error) => void;
	};
	const attaches: Attach[] = [];
	f.host.observeLive = (id, scope, listener, signal) => new Promise((resolve, reject) => {
		attaches.push({ id, scope, listener, signal, resolve, reject });
	});
	return { ...f, attaches };
}
const taskStorage = "00000000-0000-4000-8000-000000000001";
const otherTaskStorage = "00000000-0000-4000-8000-000000000002";
for (const failure of ["decline", "reject", "disconnect"] as const) {
	it(`Tasks recovers from ${failure} only through explicit refresh or live availability`, async () => {
		const f = attachmentFixture();
		const source = createAgentObservationSource(f.host);
		let reads: Promise<TasksFrame> | undefined;
		const off = source.subscribe(() => { reads = source.tasks(`${taskStorage}:1`); });
		let releases = 0;
		try {
			await source.tasks(`${taskStorage}:1`);
			source.refreshTasks(`${taskStorage}:2`);
			assert.equal(f.attaches.length, 1, "pending refresh joins one storage attachment");
			const first = f.attaches[0];
			assert.equal(first.id, taskStorage);
			assert.equal(first.scope, "tasks");
			if (failure === "decline") first.resolve(undefined);
			else if (failure === "reject") first.reject(new Error("observer unavailable"));
			else {
				first.listener(taskFrame(taskStorage), true, "live");
				first.resolve(() => { releases++; });
				await turn();
				first.listener(undefined, false, "unavailable");
			}
			await turn();
			assert.equal((await reads)?.coverage.live, false);
			assert.equal((await source.tasks(`${taskStorage}:2`)).coverage.live, false);
			assert.equal(f.attaches.length, 1, "subscription and repeated reads do not reconnect");
			source.refreshTasks(otherTaskStorage);
			assert.equal(f.attaches.length, 1, "refresh does not switch selection");
			source.refreshTasks(`${taskStorage}:2`);
			source.refreshTasks(`${taskStorage}:1`);
			assert.equal(f.attaches.length, 2, "pending refresh does not multiply attachments");
			assert.equal(first.signal?.aborted, true);
			assert.equal(releases, failure === "disconnect" ? 1 : 0);
			const retry = f.attaches[1];
			retry.listener(taskFrame(taskStorage, 2), true, "live");
			retry.resolve(() => { releases++; });
			await turn();
			assert.equal((await source.tasks(taskStorage)).revision, 2);
			source.refreshTasks(taskStorage);
			assert.equal(f.attaches.length, 2, "live refresh keeps its attachment");
			retry.listener(undefined, false, "unavailable");
			assert.equal((await source.tasks(taskStorage)).coverage.live, false);
			retry.listener(taskFrame(taskStorage, 2), true, "live");
			assert.equal((await source.tasks(taskStorage)).coverage.live, true, "a recovered observer restores the graph");
			assert.equal(f.attaches.length, 2);
		} finally { off(); }
		assert.equal(releases, failure === "disconnect" ? 2 : 1);
	});
}
it("Tasks keeps an unresolved attachment pending after an early unavailable notification", async () => {
	const f = attachmentFixture();
	const source = createAgentObservationSource(f.host);
	const off = source.subscribe(() => {});
	try {
		await source.tasks(taskStorage);
		f.attaches[0].listener(undefined, false, "unavailable");
		source.refreshTasks(taskStorage);
		assert.equal(f.attaches.length, 1);
		f.attaches[0].resolve(() => {});
		await turn();
		source.refreshTasks(taskStorage);
		assert.equal(f.attaches.length, 2);
		f.attaches[1].resolve(undefined);
		await turn();
	} finally { off(); }
});
for (const end of ["close", "switch"] as const) {
	it(`late Tasks callbacks and handles do not revive a selection after ${end}`, async () => {
		const f = attachmentFixture();
		const source = createAgentObservationSource(f.host);
		const off = source.subscribe(() => {});
		let notifications = 0;
		const offNotifications = source.subscribe(() => { notifications++; });
		let releases = 0;
		await source.tasks(taskStorage);
		const first = f.attaches[0];
		if (end === "close") source.releaseTasks();
		else {
			await source.tasks(otherTaskStorage);
			f.attaches[1].listener(taskFrame(otherTaskStorage, 2), true, "live");
			f.attaches[1].resolve(() => { releases++; });
		}
		assert.equal(first.signal?.aborted, true);
		notifications = 0;
		first.listener(taskFrame(taskStorage, 99), true, "live");
		first.resolve(() => { releases++; });
		await turn();
		assert.equal(releases, 1, "a late handle is disposed");
		assert.equal(notifications, 0, "an aborted callback does not publish a frame");
		source.refreshTasks(taskStorage);
		assert.equal(f.attaches.length, end === "close" ? 1 : 2);
		if (end === "switch") assert.equal((await source.tasks(otherTaskStorage)).revision, 2);
		offNotifications();
		off();
		assert.equal(releases, end === "close" ? 1 : 2);
	});
}
it("Tasks acquires one storage scope and releases it separately from conversation observation", async () => {
	const f = fixture();
	const source = createAgentObservationSource(f.host);
	const off = source.subscribe(() => {});
	source.select("00000000-0000-4000-8000-000000000001:1");
	await source.tasks("00000000-0000-4000-8000-000000000001:1");
	await turn();
	source.select(undefined);
	assert.ok(f.listeners.has("00000000-0000-4000-8000-000000000001:tasks"));
	source.select("00000000-0000-4000-8000-000000000001:1");
	await turn();
	source.releaseTasks();
	assert.ok(f.closed.includes("00000000-0000-4000-8000-000000000001:tasks"));
	assert.ok(f.listeners.has("00000000-0000-4000-8000-000000000001:1:conversation"));
	off();
});
it("roster notifications are distinct from frame changes and repeated revisions do not notify", async () => {
	const f = fixture();
	const source = createAgentObservationSource(f.host);
	let frames = 0;
	let roster = 0;
	const off = source.subscribe(() => {
		frames++;
	});
	const rosterOff = source.subscribeRoster(() => {
		roster++;
	});
	source.select("one");
	await turn();
	f.roster();
	assert.equal(roster, 1);
	assert.equal(frames, 0);
	const listener = f.listeners.get("one:conversation");
	assert.ok(listener);
	listener(undefined, false, "unavailable");
	assert.equal(source.availability("one")?.state, "unavailable");
	assert.equal(frames, 1);
	rosterOff();
	off();
});

it("a repeated revision notifies once and the source always holds the newest frame", async () => {
	const f = fixture();
	const source = createAgentObservationSource(f.host);
	let notifications = 0;
	const off = source.subscribe(() => { notifications++; });
	source.select("one");
	await turn();
	const listener = f.listeners.get("one:conversation");
	assert.ok(listener);
	const frame = (revision: number) => ({ ...conversationFrame({ revision }), conversationId: 1 }) as ObservationFrame;
	for (const revision of [1, 1, 2, 2, 2, 3]) listener(frame(revision), true, "live");
	assert.equal(notifications, 3, "only distinct revisions notify");
	assert.equal(source.frame("one")?.revision, 3, "the newest frame is the one read");
	off();
});
