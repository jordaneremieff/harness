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

it("finishes a multi-page dashboard scan while another writer publishes views", async (t) => {
	const f = fixture(t);
	const existing = Array.from({ length: 65 }, () => f.create());
	const writer = new AgentCatalog(f.root);
	const originalPage = f.manager.catalog.page.bind(f.manager.catalog);
	let pages = 0;
	utimesSync(f.manager.catalog.root, 1, 1);
	t.mock.method(f.manager.catalog, "page", async (options: Parameters<AgentCatalog["page"]>[0]) => {
		const page = await originalPage(options);
		pages++;
		writer.updateView(page.records[0].storageId, { updatedAt: new Date().toISOString(), rows: [], coverage: { complete: true, omitted: 0 } });
		return page;
	});
	const result = await f.manager.dashboardPage();
	assert.ok(pages > 3);
	assert.equal(result.coverage.complete, true);
	assert.equal(result.coverage.storagesVisited, existing.length);
	const identities = result.rows.map((row) => row.storageId);
	assert.equal(new Set(identities).size, identities.length);
	assert.equal(identities.length, existing.length);
	for (const record of existing) assert.ok(identities.includes(record.storageId));
});

it("lists a first page from a live host without undefined wire fields", { timeout: 15000 }, async (t) => {
	const f = fixture(t);
	const record = f.create();
	let requests = 0;
	const host = await runHost(() => ({
		request: async (method) => { assert.equal(method, "list"); requests++; return { items: [{ identity: record.storageId }] }; },
		isIdle: () => true,
		close: async () => {},
	}), { metadata: hostMetadata(record), idleMs: 0, announceReady: () => {} });
	t.after(() => host.close());
	const result = await f.manager.list({ limit: 1 }) as ListResult;
	assert.equal(result.rows.length, 1);
	assert.equal(requests, 1);
	assert.deepEqual(result.coverage.unavailable, []);
});
