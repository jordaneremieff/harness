import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { hostMetadata } from "./catalog.ts";
import type { HostConnection } from "./host-client.ts";
import type { HostMetadata } from "./host-protocol.ts";
import { waitUntil } from "./host-fixture.mts";
import { AgentManager, type AgentManagerOptions } from "./manager.ts";

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

function fakeConnection(metadata: HostMetadata, handler: (method: string, params: unknown) => Promise<unknown>): HostConnection {
	let closed = false;
	const listeners = new Set<() => void>();
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
		async close() {
			closed = true;
			for (const listener of [...listeners]) listener();
		},
	};
}

function fakePrimary(signal: AbortSignal) {
	const sent: string[] = [];
	const statuses: Array<string | undefined> = [];
	return {
		sent,
		statuses,
		client: {
			send: (text: string) => {
				sent.push(text);
			},
			status: (text?: string) => {
				statuses.push(text);
			},
			signal,
		},
	};
}

function deliveryHandler(state: { receipts: number[]; reports: string[] }, onPage: () => Promise<unknown> | unknown) {
	return async (method: string, params: unknown): Promise<unknown> => {
		if (method === "receipts") return onPage();
		if (method === "acknowledge") {
			const ack = params as { submissionIds?: number[]; sourceIds?: string[] };
			if (ack.submissionIds !== undefined) state.receipts = [...state.receipts, ...ack.submissionIds];
			if (ack.sourceIds !== undefined) state.reports = [...state.reports, ...ack.sourceIds];
			return { acknowledged: ack.submissionIds ?? [], acknowledgedReports: ack.sourceIds ?? [] };
		}
		return method === "dashboard" ? [] : { conversations: [] };
	};
}

const noHost = async () => {
	throw new Error("no live host");
};

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
		assert.equal(seen.length, 6);
		for (let index = 0; index < seen.length; index += 2) {
			assert.equal(seen[index].params.requestId, `stable:${seen[index].method}`);
			assert.equal(typeof seen[index + 1].params.requestId, "string");
			assert.notEqual(seen[index + 1].params.requestId, seen[index].params.requestId);
		}
	} finally { await manager.close(); }
});

it("delivers receipts and reports once, acknowledges both, and does not spin", { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t);
	const acknowledged = { receipts: [] as number[], reports: [] as string[] };
	let receiptsCalls = 0;
	let connection: HostConnection | undefined;
	const manager = new AgentManager(managerOptions(root, {
		acquire: async () => {
			if (!connection) throw new Error("connection not ready");
			return connection;
		},
		connect: noHost,
		observe: async () => ({ conversations: [] }),
	}));
	const record = createRecord(manager, root);
	connection = fakeConnection(hostMetadata(record), deliveryHandler(acknowledged, () => {
		receiptsCalls += 1;
		if (receiptsCalls > 1) return new Promise(() => {});
		return {
			receipts: [{ submissionId: 7, identity: "child", status: "done", answer: "answer text" }],
			reports: [{ sourceId: "report:r1", ownerId: "owner-1", senderIdentity: "child", message: "report text" }],
		};
	}));
	const primary = fakePrimary(new AbortController().signal);
	await manager.registerPrimary("owner-1", primary.client);
	await waitUntil(() => acknowledged.receipts.length === 1 && acknowledged.reports.length === 1);
	assert.ok(primary.sent.some((text) => text.includes("answer text")), "the receipt answer is delivered");
	assert.ok(primary.sent.some((text) => text.includes("report text")), "the report message is delivered");
	assert.deepEqual(acknowledged.receipts, [7]);
	assert.deepEqual(acknowledged.reports, ["report:r1"]);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(receiptsCalls, 2, "after acknowledgement the watcher blocks on the next host event");
	assert.ok(primary.statuses.some((text) => text?.includes("agents 0 · $0.00")), "the primary status uses the durable footer");
	manager.close();
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
	}));
	const record = createRecord(manager, root);
	const controller = new AbortController();
	const primary = fakePrimary(controller.signal);
	await manager.registerPrimary("owner-1", primary.client);
	await waitUntil(() => release !== undefined);
	controller.abort();
	const connection = fakeConnection(hostMetadata(record), async () => ({}));
	release?.(connection);
	await waitUntil(() => connection.closed);
	assert.equal(connection.closed, true, "the raced host client is closed");
	assert.deepEqual(manager.connectedStorageIds(), []);
	manager.close();
});

it("backs off between recovery attempts, bounds error text, and resumes", { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t);
	let acquireCalls = 0;
	let failFirst = true;
	let connection: HostConnection | undefined;
	const manager = new AgentManager(managerOptions(root, {
		retryDelayMs: 10,
		acquire: async () => {
			acquireCalls += 1;
			if (failFirst) {
				failFirst = false;
				throw new Error("x".repeat(4000));
			}
			if (!connection) throw new Error("connection not ready");
			return connection;
		},
		connect: noHost,
		observe: async () => ({ conversations: [{ busy: true }] }),
	}));
	const record = createRecord(manager, root);
	let receiptsCalls = 0;
	connection = fakeConnection(hostMetadata(record), deliveryHandler({ receipts: [], reports: [] }, () => {
		receiptsCalls += 1;
		if (receiptsCalls > 1) return new Promise(() => {});
		return { receipts: [{ submissionId: 9, identity: "child", status: "done", answer: "late" }], reports: [] };
	}));
	const primary = fakePrimary(new AbortController().signal);
	await manager.registerPrimary("owner-1", primary.client);
	await waitUntil(() => primary.sent.length >= 1);
	assert.equal(acquireCalls, 2, "one retry after the first bounded delay");
	const failures = (await manager.status() as { failures: Array<{ error: string }> }).failures;
	assert.equal(failures.length, 0, "recovery clears the recorded failure");
	manager.close();
});

it("bounds the recorded failure memory and keeps exact bounded messages", { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t);
	const manager = new AgentManager(managerOptions(root, {
		failureLimit: 2,
		retryDelayMs: 1000,
		acquire: async () => {
			throw new Error("z".repeat(4000));
		},
		connect: noHost,
		observe: async () => ({ conversations: [{ busy: true }] }),
	}));
	for (let index = 0; index < 3; index += 1) createRecord(manager, root, `owner-${index}`);
	const primary = fakePrimary(new AbortController().signal);
	await manager.registerPrimary("owner-0", primary.client);
	let failures: Array<{ error: string }> = [];
	for (let attempt = 0; attempt < 100 && failures.length !== 2; attempt += 1) {
		failures = (await manager.status() as { failures: Array<{ error: string }> }).failures;
		if (failures.length !== 2) await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.equal(failures.length, 2, "the failure map is bounded");
	for (const failure of failures) assert.ok(failure.error.length <= 512, "the failure text is bounded");
	manager.close();
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
