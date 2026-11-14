import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { it } from "node:test";
import { AgentCatalog, hostMetadata, type CatalogRecord } from "./catalog.ts";
import { AgentManager, type AgentManagerOptions } from "./manager.ts";
import { runHost } from "./host-process.ts";
import { hostPaths } from "./host-protocol.ts";
import { ProfiledListOutputSchema } from "./profile-discovery.ts";
import { matchesSchema } from "./schema-check.ts";

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
	coverage: { complete: boolean; storagesVisited: number; unavailable: Array<{ storageId: string; reason: string }>; basis: string;
		next: { tool: string; query?: string; cwd?: string; limit?: number; cursor: string } | null;
		catalog: { storages: number; pass: "candidates" | "remainder"; pending: number; settled: number } };
}

/** Publish a complete one-row view and a false recovery marker, as an idle host leaves them. */
function publish(catalog: AgentCatalog, record: CatalogRecord, name: string, updatedAt = new Date().toISOString()): void {
	catalog.updateView(record.storageId, { updatedAt, rows: [{ id: record.storageId, storageId: record.storageId, name, cwd: record.cwd, modifiedAt: 1, owner: "unknown", state: "idle", cost: 0, partial: false }], coverage: { complete: true, omitted: 0 } });
	catalog.markRecoveryDue(record.storageId, false);
}

/** Write the claim record of a writer on this machine; `endedAt` is the end marker of a clean close. */
function writeClaim(record: CatalogRecord, fields: { pid?: number; endedAt?: string } = {}): void {
	const paths = hostPaths(record);
	mkdirSync(dirname(paths.claim), { recursive: true });
	writeFileSync(paths.claim, JSON.stringify({ token: "writer", pid: fields.pid ?? process.pid, host: hostname(), sessionId: record.storageId, cwd: resolve(record.cwd), createdAt: "2026-01-01T00:00:00.000Z", ...(fields.endedAt === undefined ? {} : { endedAt: fields.endedAt }) }));
}

/** Follow each exact continuation until discovery reports completion. */
async function finish(manager: AgentManager, first: ListResult, maxCalls = 64): Promise<ListResult[]> {
	const pages = [first];
	for (let next = first.coverage.next; next && pages.length < maxCalls; next = pages.at(-1)?.coverage.next ?? null) {
		const { tool, ...input } = next;
		assert.equal(tool, "agent_list");
		pages.push(await manager.list(input) as ListResult);
	}
	return pages;
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
	const originalIdentities = f.manager.catalog.identities.bind(f.manager.catalog);
	let publication = false;
	t.mock.method(f.manager.catalog, "identities", async () => {
		const scan = await originalIdentities();
		publish(published, "Concurrent publication", 10_000);
		publication = true;
		return scan;
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
	try {
		const result = await f.manager.list({ limit: 1 }) as ListResult;
		assert.deepEqual(result.coverage.unavailable, []);
		assert.deepEqual(result.rows, [{ conversationId: 1, identity: record.storageId, busy: false, sessionId: record.storageId, storageId: record.storageId, cwd: f.root, handle: null, role: null, profile: null, profileCoverage: "unknown" }]);
		assert.equal(requests, 1);
	} finally {
		try {
			await f.manager.close();
		} finally {
			await host.close();
		}
	}
});

it("reaches a named agent beyond the first observation budget in the first call", async (t) => {
	const observed: string[] = [];
	const names = new Map<string, string>();
	const f = fixture(t, {
		connect: async () => { throw new Error("no live fixture host"); },
		observe: async (record) => { observed.push(record.storageId); return { items: [{ identity: record.storageId, name: names.get(record.storageId) }], next: null }; },
	});
	const records = Array.from({ length: 460 }, () => f.create()).sort((left, right) => (left.storageId < right.storageId ? -1 : 1));
	const target = records[400];
	const undecided = new Set([records[5].storageId, records[150].storageId, records[450].storageId]);
	const settled = new Set(records.filter((_, index) => index % 7 === 0 && index !== 400).map((record) => record.storageId).filter((id) => !undecided.has(id)));
	const endedAt = new Date(Date.now() + 60_000).toISOString();
	for (const record of records) {
		if (undecided.has(record.storageId)) continue;
		names.set(record.storageId, record === target ? "Parser worker" : "other task");
		publish(f.manager.catalog, record, names.get(record.storageId) ?? "");
		if (settled.has(record.storageId)) writeClaim(record, { endedAt });
	}
	const callsInCatalogOrder = Math.floor(400 / 32) + 1;
	assert.equal(callsInCatalogOrder, 13, "an identity-ordered scan with 32 observations per call needs 13 calls for this record");

	const first = await f.manager.list({ query: "parser worker" }) as ListResult;
	assert.deepEqual(first.rows.map((row) => row.identity), [target.storageId]);
	assert.ok(first.coverage.storagesVisited <= 32);
	assert.equal(first.coverage.catalog.storages, 460);
	assert.equal(first.coverage.catalog.settled, settled.size);
	assert.equal(first.coverage.complete, false);
	assert.equal(first.coverage.catalog.pass, "remainder");
	for (const storageId of [target.storageId, ...undecided]) assert.ok(observed.includes(storageId), "the first call observes every candidate");

	const pages = await finish(f.manager, first);
	assert.equal(pages.at(-1)?.coverage.complete, true);
	assert.equal(pages.at(-1)?.coverage.catalog.pending, 0);
	assert.match(pages.at(-1)?.coverage.basis ?? "", /settled storages were not observed/u);
	assert.equal(pages.flatMap((page) => page.rows).length, 1);
	for (const record of records) assert.equal(observed.includes(record.storageId), !settled.has(record.storageId), "every storage without proof is observed; no settled storage is");
	assert.equal(new Set(observed).size, observed.length);
});

it("observes a storage whose publication cannot prove a non-match", async (t) => {
	const observed: string[] = [];
	const f = fixture(t, {
		connect: async () => { throw new Error("no live fixture host"); },
		observe: async (record) => { observed.push(record.storageId); return { items: [{ identity: record.storageId, name: "hidden name" }], next: null }; },
	});
	const catalog = f.manager.catalog;
	const published = new Date().toISOString();
	const later = new Date(Date.now() + 60_000).toISOString();
	const create = (prepare: (record: CatalogRecord) => void) => { const record = f.create(); prepare(record); return record.storageId; };
	const candidates = {
		unpublished: create(() => undefined),
		unavailable: create((record) => { catalog.updateView(record.storageId, { updatedAt: published, rows: [], coverage: { complete: false, omitted: 0 }, unavailable: "projection failed" }); catalog.markRecoveryDue(record.storageId, false); writeClaim(record, { endedAt: later }); }),
		partial: create((record) => { publish(catalog, record, "old name"); const view = catalog.read(record.storageId).view; if (view) catalog.updateView(record.storageId, { ...view, coverage: { complete: false, omitted: 1 } }); writeClaim(record, { endedAt: later }); }),
		recovering: create((record) => { publish(catalog, record, "old name"); catalog.markRecoveryDue(record.storageId, true); writeClaim(record, { endedAt: later }); }),
	};
	const remainder = {
		unclaimed: create((record) => publish(catalog, record, "old name")),
		emptyClaim: create((record) => { publish(catalog, record, "old name"); const paths = hostPaths(record); mkdirSync(dirname(paths.claim), { recursive: true }); writeFileSync(paths.claim, ""); }),
		crashedWriter: create((record) => { publish(catalog, record, "old name"); writeClaim(record, { pid: 2 ** 22 - 1 }); }),
		openWriter: create((record) => { publish(catalog, record, "old name"); writeClaim(record); }),
		endedBeforePublication: create((record) => { publish(catalog, record, "old name", later); writeClaim(record, { endedAt: published }); }),
	};
	const settled = create((record) => { publish(catalog, record, "old name", published); writeClaim(record, { endedAt: later }); });

	const first = await f.manager.list({ query: "hidden", limit: 4 }) as ListResult;
	assert.deepEqual(first.rows.map((row) => row.identity).sort(), Object.values(candidates).sort(), "undecided publications are observed before any other storage");
	assert.equal(first.coverage.complete, false);
	assert.equal(first.coverage.catalog.pass, "remainder");
	assert.equal(first.coverage.catalog.pending, 5);
	assert.match(first.coverage.basis, /not absence/u);

	const pages = await finish(f.manager, first);
	const found = pages.flatMap((page) => page.rows.map((row) => row.identity));
	assert.deepEqual([...found].sort(), [...Object.values(candidates), ...Object.values(remainder)].sort());
	assert.equal(observed.includes(settled), false);
	assert.equal(pages.at(-1)?.coverage.complete, true);
	assert.equal(pages.at(-1)?.coverage.catalog.settled, 1);
	assert.equal(pages.at(-1)?.coverage.next, null);
});

it("returns the exact next call while storages are pending and refuses a changed query", async (t) => {
	const f = fixture(t, {
		connect: async () => { throw new Error("no live fixture host"); },
		observe: async (record) => ({ items: [{ identity: record.storageId, name: "other task" }], next: null }),
	});
	for (let index = 0; index < 40; index++) publish(f.manager.catalog, f.create(), "other task");
	const first = await f.manager.list({ query: "absent name", limit: 5 }) as ListResult;
	assert.deepEqual(first.rows, []);
	assert.equal(first.coverage.storagesVisited, 32);
	assert.equal(first.coverage.catalog.pending, 8);
	assert.match(first.coverage.basis, /8 storage observations are still open, so a page without rows is not absence\. Call agent_list with the fields of coverage\.next\./u);
	assert.deepEqual(first.coverage.next, { tool: "agent_list", query: "absent name", limit: 5, cursor: first.nextCursor });
	assert.ok(matchesSchema(ProfiledListOutputSchema, first), "a pending page matches the tool output schema");
	await assert.rejects(f.manager.list({ query: "another name", cursor: first.nextCursor ?? "" }), /Repeat the same query and cwd/u);
	await assert.rejects(f.manager.list({ query: "absent name", cursor: "bm90LWEtY3Vyc29y" }), /restart discovery without a cursor/u);
	const last = (await finish(f.manager, first))[1];
	assert.deepEqual(last.rows, []);
	assert.equal(last.coverage.complete, true);
	assert.equal(last.coverage.next, null);
	assert.equal(last.nextCursor, null);
	assert.match(last.coverage.basis, /Every storage in scope was observed or settled/u);
});

it("observes a storage that becomes a candidate behind the candidates pass", async (t) => {
	const names = new Map<string, string>();
	const f = fixture(t, {
		connect: async () => { throw new Error("no live fixture host"); },
		observe: async (record) => ({ items: [{ identity: record.storageId, name: names.get(record.storageId) }], next: null }),
	});
	const [late, firstMatch, secondMatch] = Array.from({ length: 3 }, () => f.create()).sort((left, right) => (left.storageId < right.storageId ? -1 : 1));
	const endedAt = new Date(Date.now() + 60_000).toISOString();
	for (const [record, name] of [[late, "other task"], [firstMatch, "parser one"], [secondMatch, "parser two"]] as const) {
		names.set(record.storageId, name);
		publish(f.manager.catalog, record, name);
		writeClaim(record, { endedAt });
	}
	const first = await f.manager.list({ query: "parser", limit: 1 }) as ListResult;
	assert.deepEqual(first.rows.map((row) => row.identity), [firstMatch.storageId]);
	names.set(late.storageId, "parser late");
	publish(new AgentCatalog(f.root), late, "parser late");
	const rest = await finish(f.manager, first);
	const found = rest.flatMap((page) => page.rows.map((row) => row.identity));
	assert.ok(found.includes(secondMatch.storageId));
	assert.ok(found.includes(late.storageId), "a record that changed after discovery began is observed in the remainder pass");
	assert.equal(rest.at(-1)?.coverage.complete, true);
});
