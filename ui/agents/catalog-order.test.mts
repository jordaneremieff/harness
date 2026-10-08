import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentCatalog } from "./catalog.mts";
import type { CatalogPage, CatalogRow } from "./catalog.mts";
import type { Summary } from "./contract.mts";

const stamp = "2026-01-01T00:00:00.000Z";
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
	const store = await mkdtemp(join(tmpdir(), "catalog-order-"));
	const root = join(store, "durable");
	await mkdir(root, { mode: 0o700 });
	t.after(() => rm(store, { recursive: true, force: true }));
	const updates: CatalogPage[] = [];
	const catalog = new AgentCatalog({ store, onChange: (update) => updates.push(update) });
	t.after(() => catalog.close());
	return { store, root, catalog, updates };
}
function summary(store: string, storageId: string, modifiedAt: number, conversationId = 1): Summary {
	return {
		id: conversationId === 1 ? storageId : `${storageId}:${conversationId}`,
		storageId,
		cwd: store,
		modifiedAt,
		owner: "unknown",
		state: "done",
		cost: 0,
		partial: false,
	};
}
async function save(root: string, store: string, storageId: string, rows: Summary[]): Promise<void> {
	const record = {
		storageId,
		cwd: store,
		agentDir: store,
		packageDir: store,
		storagePath: join(root, `${storageId}.sqlite`),
		model: { provider: "example", modelId: "example" },
		thinkingLevel: "off",
		createdAt: stamp,
		view: { storageId, updatedAt: stamp, rows, coverage: { complete: true, omitted: 0 } },
	};
	await writeFile(join(root, `${storageId}.json`), JSON.stringify(record), { mode: 0o600 });
}
function walk(catalog: AgentCatalog, limit: number): CatalogRow[] {
	const rows: CatalogRow[] = [];
	let cursor: string | undefined;
	for (let pages = 0; pages < 64; pages++) {
		const page = catalog.page({ cursor, limit });
		rows.push(...page.rows);
		if (!page.nextCursor) return rows;
		cursor = page.nextCursor;
	}
	assert.fail("Fixture exceeded its bounded cached page walk");
}
function assertOrdered(rows: CatalogRow[]): void {
	for (let index = 1; index < rows.length; index++) {
		const previous = rows[index - 1],
			row = rows[index];
		assert.ok(previous);
		assert.ok(row);
		assert.ok(
			previous.modifiedAt > row.modifiedAt || (previous.modifiedAt === row.modifiedAt && previous.id <= row.id),
		);
	}
}

test("worker-backed catalog globally orders activity across storages and conversations", async (t) => {
	const { catalog, store, root, updates } = await fixture(t);
	await save(root, store, "old", [summary(store, "old", 10), summary(store, "old", 900, 2)]);
	await save(root, store, "new", [summary(store, "new", 800), summary(store, "new", 20, 2)]);
	await save(root, store, "middle", [summary(store, "middle", 30), summary(store, "middle", 700, 2)]);
	const scan = await catalog.refresh();
	assert.equal(scan.complete, true);
	assert.equal(scan.skipped, 0);
	assert.equal(scan.omitted, 0);
	const rows = walk(catalog, 2);
	assert.deepEqual(
		rows.map((row) => row.id),
		["old:2", "new", "middle:2", "middle", "new:2", "old"],
	);
	assertOrdered(rows);
	assert.equal(catalog.page({ limit: 1 }).rows[0]?.id, "old:2");
	assert.equal(catalog.page({ limit: 100 }).coverage.complete, true);
	for (const update of updates) {
		assertOrdered(update.changed ?? []);
		assert.ok(Buffer.byteLength(JSON.stringify(update)) <= 256 * 1024);
	}
});

test("equal activity uses code-unit identity order and unchanged refresh never drifts", async (t) => {
	const { catalog, store, root, updates } = await fixture(t);
	await save(root, store, "storage-a", [
		summary(store, "storage-a", 500, 2),
		summary(store, "storage-a", 500, 10),
		summary(store, "storage-a", 500),
	]);
	await save(root, store, "storage-B", [summary(store, "storage-B", 500)]);
	const expected = ["storage-B", "storage-a", "storage-a:10", "storage-a:2"];
	for (let refresh = 0; refresh < 3; refresh++) {
		assert.equal((await catalog.refresh()).complete, true);
		assert.deepEqual(
			walk(catalog, 1).map((row) => row.id),
			expected,
		);
	}
	for (const update of updates) assertOrdered(update.changed ?? []);
});

test("activity deltas invalidate old cursors and new cursors cover the complete reordered cache", async (t) => {
	const { catalog, store, root, updates } = await fixture(t);
	const originals = Array.from({ length: 30 }, (_, index) => summary(store, "many", index + 1, index + 1));
	await save(root, store, "many", originals);
	await save(root, store, "other", [summary(store, "other", 15)]);
	await catalog.refresh();
	const first = catalog.page({ limit: 7 });
	const cursor = first.nextCursor;
	assert.ok(cursor);
	const before = walk(catalog, 7);
	assert.equal(before.length, 31);
	assertOrdered(before);
	updates.length = 0;
	const changed = originals.map((row) => (row.id === "many" ? { ...row, modifiedAt: 1000 } : row));
	await save(root, store, "many", changed);
	const scan = await catalog.refresh();
	assert.equal(scan.complete, true);
	assert.equal(scan.skipped, 0);
	assert.throws(() => catalog.page({ cursor, limit: 7 }), /Expired catalog cursor/u);
	const after = walk(catalog, 7);
	assertOrdered(after);
	assert.equal(after[0]?.id, "many");
	assert.equal(after.length, 31);
	assert.equal(new Set(after.map((row) => row.id)).size, 31);
	assert.deepEqual(new Set(after.map((row) => row.id)), new Set(before.map((row) => row.id)));
	const deltas = updates.filter((update) => update.changed?.length);
	assert.ok(deltas.length > 0);
	for (const update of deltas) {
		assertOrdered(update.changed ?? []);
		assert.ok(Buffer.byteLength(JSON.stringify(update)) <= 256 * 1024);
		const promoted = update.changed?.find((row) => row.id === "many");
		if (promoted) assert.equal(update.changed?.[0]?.id, "many");
	}
});
