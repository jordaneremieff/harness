import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { hostMetadata } from "./catalog.ts";
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
	coverage: { complete: boolean; storagesVisited: number; unavailable: unknown[] };
}

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

it("refuses a stale supplied discovery cursor after catalog membership changes", async (t) => {
	const f = fixture(t, {
		connect: async () => { throw new Error("no live fixture host"); },
		observe: async (record) => ({ items: [{ identity: record.storageId }] }),
	});
	for (let index = 0; index < 8; index++) f.create();
	utimesSync(f.manager.catalog.root, 1, 1);
	const first = await f.manager.list({ limit: 5 }) as ListResult;
	assert.ok(first.nextCursor);
	f.create();
	await assert.rejects(f.manager.list({ limit: 5, cursor: first.nextCursor }), /restart discovery/u);
});

it("validates catalog freshness while resuming the last storage's native page", async (t) => {
	const f = fixture(t, {
		connect: async () => { throw new Error("no live fixture host"); },
		observe: async (record) => ({ items: [{ identity: record.storageId }], next: "native-next" }),
	});
	f.create();
	utimesSync(f.manager.catalog.root, 1, 1);
	const first = await f.manager.list({ limit: 1 }) as ListResult;
	assert.ok(first.nextCursor);
	f.create();
	await assert.rejects(f.manager.list({ limit: 1, cursor: first.nextCursor }), /restart discovery/u);
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
