import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AgentCatalog, hostMetadata } from "./catalog.ts";
import { AgentManager, type AgentManagerOptions } from "./manager.ts";
import { runHost } from "./host-process.ts";

function fixture(t: { after(fn: () => void | Promise<void>): void }, hooks: Partial<AgentManagerOptions> = {}) {
	const root = mkdtempSync(join(tmpdir(), "manager-discovery-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const manager = new AgentManager({ root, agentDir: join(root, "agent"), packageDir: root, ...hooks });
	t.after(() => manager.close());
	const create = (name?: string) => manager.catalog.create({ cwd: root, agentDir: join(root, "agent"), packageDir: root, model: { provider: "fixture", modelId: "fixture" }, thinkingLevel: "off", ...(name ? { name } : {}) });
	return { root, manager, create };
}

interface ListResult {
	rows: Array<{ identity: string }>;
	nextCursor: string | null;
	coverage: { complete: boolean; storagesVisited: number; unavailable: Array<{ storageId: string; reason: string }> };
}

it("agent_list reports every unreadable catalog record without changing completion", async (t) => {
	const f = fixture(t, {
		connect: async () => { throw new Error("no live fixture host"); },
		observe: async (record) => ({ items: [{ identity: record.storageId }] }),
	});
	const valid = f.create();
	const corrupt = f.create();
	const invalid = f.create();
	writeFileSync(f.manager.catalog.path(corrupt.storageId), "{");
	writeFileSync(f.manager.catalog.path(invalid.storageId), "{}");
	const result = await f.manager.list() as ListResult;
	assert.deepEqual(result.rows.map((row) => row.identity), [valid.storageId]);
	assert.deepEqual(result.coverage.unavailable, [corrupt.storageId, invalid.storageId].sort().map((storageId) => ({
		storageId,
		reason: "Catalog record could not be read",
	})));
	assert.equal(result.coverage.complete, true);
	assert.equal(result.nextCursor, null);
});

for (const query of [undefined, "sol"]) {
	it(`keeps a fresh ${query ? "filtered" : "default"} list usable when observation rewrites catalog metadata`, async (t) => {
		let visits = 0;
		const f = fixture(t, {
			connect: async () => { throw new Error("no live fixture host"); },
			observe: async (record) => {
				if (++visits === 6) f.manager.catalog.markRecoveryDue(record.storageId, true);
				return { items: [{ identity: record.storageId, name: "sol" }], next: null };
			},
		});
		for (let index = 0; index < 12; index++) f.create("sol");
		utimesSync(f.manager.catalog.root, 1, 1);
		const result = await f.manager.list(query ? { query } : {}) as ListResult;
		assert.equal(result.rows.length, 10);
		assert.equal(new Set(result.rows.map((row) => row.identity)).size, 10);
		assert.equal(result.coverage.storagesVisited, 10);
		assert.equal(result.coverage.complete, false);
		assert.ok(result.nextCursor);
	});
}

it("keeps native and catalog continuations aligned across prefetched records", async (t) => {
	const f = fixture(t, {
		connect: async () => { throw new Error("no live fixture host"); },
		observe: async (record, _method, params) => ({ items: [{ identity: `${record.storageId}:${params.cursor === "next" ? 2 : 1}` }], ...(params.cursor === "next" ? {} : { next: "next" }) }),
	});
	f.create(); f.create(); f.create();
	const identities: string[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < 8; page++) {
		const result = await f.manager.list({ limit: 1, ...(cursor ? { cursor } : {}) }) as ListResult;
		identities.push(...result.rows.map((row) => row.identity));
		if (!result.nextCursor) break;
		cursor = result.nextCursor;
	}
	assert.equal(identities.length, 6);
	assert.equal(new Set(identities).size, 6);
});

it("continues agent_list without duplicates or lost records after publication and creation", async (t) => {
	const f = fixture(t, {
		connect: async () => { throw new Error("no live fixture host"); },
		observe: async (record) => ({ items: [{ identity: record.storageId }] }),
	});
	const existing = Array.from({ length: 8 }, () => f.create());
	utimesSync(f.manager.catalog.root, 1, 1);
	const first = await f.manager.list({ limit: 5 }) as ListResult;
	assert.ok(first.nextCursor);
	const writer = new AgentCatalog(f.root);
	writer.updateView(existing[0].storageId, { updatedAt: new Date().toISOString(), rows: [], coverage: { complete: true, omitted: 0 } });
	f.create();
	const identities = first.rows.map((row) => row.identity);
	let cursor: string | null = first.nextCursor;
	for (let page = 0; cursor && page < 8; page++) {
		const result = await f.manager.list({ limit: 5, cursor }) as ListResult;
		identities.push(...result.rows.map((row) => row.identity));
		cursor = result.nextCursor;
	}
	assert.equal(cursor, null);
	assert.equal(new Set(identities).size, identities.length);
	for (const record of existing) assert.ok(identities.includes(record.storageId));
});

it("resumes the last storage's native page after catalog publication", async (t) => {
	const f = fixture(t, {
		connect: async () => { throw new Error("no live fixture host"); },
		observe: async (record, _method, params) => ({ items: [{ identity: `${record.storageId}:${params.cursor ? 2 : 1}` }], ...(params.cursor ? {} : { next: "native-next" }) }),
	});
	const record = f.create();
	utimesSync(f.manager.catalog.root, 1, 1);
	const first = await f.manager.list({ limit: 1 }) as ListResult;
	assert.ok(first.nextCursor);
	new AgentCatalog(f.root).markRecoveryDue(record.storageId, true);
	const next = await f.manager.list({ limit: 1, cursor: first.nextCursor }) as ListResult;
	assert.deepEqual([...first.rows, ...next.rows].map((row) => row.identity), [`${record.storageId}:1`, `${record.storageId}:2`]);
	assert.equal(next.nextCursor, null);
});

it("ranks caller ownership and concurrent publication across the full initial dashboard inventory", async (t) => {
	const f = fixture(t, { acquire: async () => { throw new Error("Dashboard acquired a host"); }, observe: async () => { throw new Error("Dashboard observed native state"); } });
	const existing = Array.from({ length: 321 }, () => f.create()).sort((left, right) => left.storageId.localeCompare(right.storageId));
	const writer = new AgentCatalog(f.root);
	const owned = existing[existing.length - 1];
	const published = existing[existing.length - 2];
	const publish = (record: typeof owned, name: string, time: number) => {
		writer.updateView(record.storageId, { updatedAt: new Date().toISOString(), rows: [{ id: record.storageId, storageId: record.storageId, name, cwd: record.cwd, modifiedAt: 1, owner: "unknown", state: "idle", cost: 0, partial: false }], coverage: { complete: true, omitted: 0 } });
		utimesSync(writer.path(record.storageId), time, time);
	};
	for (const record of existing) publish(record, "Retained history", 100);
	writeFileSync(writer.path(owned.storageId), JSON.stringify({ ...writer.read(owned.storageId), ownerId: "caller" }));
	utimesSync(writer.path(owned.storageId), 1, 1);
	const corrupt = f.create();
	writeFileSync(writer.path(corrupt.storageId), "{");
	const originalPage = f.manager.catalog.priorityPage.bind(f.manager.catalog);
	let publication = false;
	t.mock.method(f.manager.catalog, "priorityPage", async (options: Parameters<AgentCatalog["priorityPage"]>[0]) => {
		assert.deepEqual(options.ownerIds, ["caller"]);
		assert.ok(existing.length > options.limit);
		const scan = originalPage(options);
		publish(published, "Concurrent publication", 10_000);
		publication = true;
		return await scan;
	});
	const result = await f.manager.dashboardPage({ ownerId: "caller" });
	assert.equal(publication, true);
	assert.deepEqual(result.rows.slice(0, 2).map((row) => row.storageId), [owned.storageId, published.storageId]);
	assert.equal(result.rows[1].name, "Concurrent publication");
	assert.equal(result.rows[1].rosterOrder?.modifiedAt, 10_000_000);
	const inventory = result.coverage.inventory;
	assert.equal(inventory.candidates, existing.length + 1);
	assert.equal(inventory.inspected, inventory.candidates);
	assert.equal(result.coverage.storagesVisited, inventory.inspected);
	assert.equal(inventory.unreadable, 1);
	assert.equal(result.coverage.skipped, 1);
	assert.equal(result.coverage.omitted, 0);
	assert.equal(inventory.unknownClaims, 0);
	assert.equal(inventory.returned, inventory.outputLimit);
	assert.equal(inventory.remaining, existing.length - inventory.returned);
	assert.equal(inventory.remainingRows, inventory.remaining);
	assert.equal(inventory.priorityRemaining, 0);
	assert.equal(inventory.priorityRemainingRows, 0);
	assert.equal(result.coverage.complete, false);
	assert.ok(result.coverage.nextCursor);
	const expected = [owned, published, ...existing.filter((record) => record !== owned && record !== published)];
	assert.deepEqual(result.rows.map((row) => row.storageId), expected.slice(0, inventory.outputLimit).map((record) => record.storageId));
	assert.equal(new Set(result.rows.map((row) => row.storageId)).size, inventory.returned);
});

it("finishes a dashboard inventory with every readable published record exactly once", async (t) => {
	const f = fixture(t);
	const existing = Array.from({ length: 65 }, () => f.create());
	for (const record of existing) f.manager.catalog.updateView(record.storageId, { updatedAt: new Date().toISOString(), rows: [{ id: record.storageId, storageId: record.storageId, cwd: record.cwd, modifiedAt: 1, owner: "unknown", state: "idle", cost: 0, partial: false }], coverage: { complete: true, omitted: 0 } });
	const result = await f.manager.dashboardPage();
	assert.equal(result.coverage.complete, true);
	assert.equal(result.coverage.nextCursor, null);
	assert.equal(result.coverage.storagesVisited, existing.length);
	assert.equal(result.coverage.skipped, 0);
	assert.equal(result.coverage.omitted, 0);
	assert.equal(result.coverage.inventory?.remaining, 0);
	assert.deepEqual(result.rows.map((row) => row.storageId).sort(), existing.map((record) => record.storageId).sort());
});

it("lists a first page from a live host without undefined wire fields", { timeout: 15000 }, async (t) => {
	const f = fixture(t);
	const record = f.create();
	let requests = 0;
	const host = await runHost(() => ({
		request: async (method, params) => {
			assert.equal(method, "list");
			assert.deepEqual(params, { limit: 1 });
			requests++;
			return { items: [{ conversationId: 1, identity: record.storageId, busy: false }], next: null };
		},
		isIdle: () => true,
		close: async () => {},
	}), { metadata: hostMetadata(record), idleMs: 0, announceReady: () => {} });
	t.after(() => host.close());
	const result = await f.manager.list({ limit: 1 }) as ListResult;
	assert.deepEqual(result.coverage.unavailable, []);
	assert.deepEqual(result.rows, [{ conversationId: 1, identity: record.storageId, busy: false, sessionId: record.storageId, storageId: record.storageId, cwd: f.root, handle: null, role: null, profile: null, profileCoverage: "unknown" }]);
	assert.equal(requests, 1);
});
