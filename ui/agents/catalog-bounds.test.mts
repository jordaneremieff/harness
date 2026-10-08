import assert from "node:assert/strict";
import type { Dirent, FSWatcher } from "node:fs";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentCatalog } from "./catalog.mts";
import type { CatalogPage, CatalogRecord } from "./catalog.mts";
import { readRecord, RECORD_BYTES, CACHE_BYTES } from "./catalog-record.mts";
import { CatalogInventory, SEGMENT_BYTES, UPDATE_BYTES } from "./catalog-worker.mts";
import type { CatalogUpdate } from "./catalog-state.mts";

const stamp = "2026-01-01T00:00:00.000Z";
const watcher = () =>
	({
		on() {
			return this;
		},
		close() {},
	}) as unknown as FSWatcher;
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
	const store = await mkdtemp(join(tmpdir(), "catalog-bounds-"));
	const root = join(store, "durable");
	await mkdir(root, { mode: 0o700 });
	t.after(() => rm(store, { recursive: true, force: true }));
	const record: CatalogRecord = {
		storageId: "fixture",
		cwd: store,
		agentDir: store,
		packageDir: store,
		storagePath: join(root, "fixture.sqlite"),
		model: { provider: "example", modelId: "example" },
		thinkingLevel: "off",
		createdAt: stamp,
	};
	return { store, root, record };
}
function row(record: CatalogRecord, index = 0) {
	return {
		id: index ? `${record.storageId}:${index + 1}` : record.storageId,
		storageId: record.storageId,
		cwd: record.cwd,
		modifiedAt: 0,
		owner: "unknown",
		state: "idle",
		cost: 0,
		partial: false,
	};
}
function view(record: CatalogRecord, rows = [row(record)]) {
	return { storageId: record.storageId, updatedAt: stamp, rows, coverage: { complete: true, omitted: 0 } };
}
async function save(root: string, record: CatalogRecord, publication = view(record)) {
	await writeFile(join(root, `${record.storageId}.json`), JSON.stringify({ ...record, view: publication }), {
		mode: 0o600,
	});
}

test("hint reads share the remaining segment byte budget and retain explicit continuation", async (t) => {
	const { store, root, record } = await fixture(t);
	const value = { ...record, threads: "" };
	const source = JSON.stringify(value);
	value.threads = "x".repeat(RECORD_BYTES - Buffer.byteLength(source));
	await writeFile(join(root, "fixture.json"), JSON.stringify(value));
	let reads = 0,
		loads = 0;
	const updates: CatalogUpdate[] = [];
	const worker = new CatalogInventory(store, (update) => updates.push(update), {
		watchDirectory: watcher,
		readCatalogRecord: async (...args) => {
			loads++;
			return readRecord(...args);
		},
		openDirectory: async () => ({
			read: async () => {
				if (++reads > SEGMENT_BYTES / RECORD_BYTES) return null;
				if (reads === SEGMENT_BYTES / RECORD_BYTES) worker.hint("fixture.json");
				return { name: "fixture.json" } as Dirent;
			},
			close: async () => {},
		}),
	});
	t.after(() => worker.close());
	const first = await worker.refresh();
	await worker.settled();
	assert.equal(first.state, "running");
	assert.equal(first.complete, false);
	assert.equal(loads, SEGMENT_BYTES / RECORD_BYTES);
	assert.equal(reads, loads);
	assert.equal(updates.at(-1)?.stale, true);
	const final = await worker.refresh(first.scanId);
	assert.equal(loads, SEGMENT_BYTES / RECORD_BYTES + 1);
	assert.equal(final.complete, true);
});

test("worker output and callback deltas stay bounded across a byte-limited cache", async (t) => {
	const { store, root, record } = await fixture(t);
	const copies = Array.from({ length: 600 }, (_, i) => ({
		...record,
		storageId: `fixture-${i}`,
		storagePath: join(root, `fixture-${i}.sqlite`),
		cwd: `/${"x".repeat(4000)}`,
		agentDir: `/${"y".repeat(4000)}`,
		packageDir: `/${"z".repeat(4000)}`,
	}));
	await Promise.all(copies.map((copy) => save(root, copy)));
	const updates: CatalogUpdate[] = [];
	const worker = new CatalogInventory(
		store,
		(update) => {
			assert.ok(Buffer.byteLength(JSON.stringify(update)) <= UPDATE_BYTES);
			updates.push(update);
		},
		{ watchDirectory: watcher },
	);
	t.after(() => worker.close());
	const first = await worker.refresh();
	assert.equal(first.complete, false);
	const scan = await worker.refresh(first.scanId);
	assert.equal(scan.complete, true);
	assert.ok(scan.omitted > 0);
	assert.ok(updates.length > 1);
	const retained = updates.flatMap((update) => update.entries);
	assert.ok(Buffer.byteLength(JSON.stringify(retained)) <= CACHE_BYTES);
	let callbacks = 0,
		turns = 0;
	const catalog = new AgentCatalog({
		store,
		onChange: (page) => {
			callbacks++;
			assert.ok(Buffer.byteLength(JSON.stringify(page)) <= UPDATE_BYTES);
			setImmediate(() => turns++);
		},
	});
	t.after(() => catalog.close());
	const part = await catalog.refresh();
	await catalog.refresh(part.scanId);
	assert.ok(callbacks > 1);
	assert.equal(turns, callbacks);
});

test("callback deltas include replacements and removals beyond the first cached page", async (t) => {
	const { store, root, record } = await fixture(t);
	await save(
		root,
		record,
		view(
			record,
			Array.from({ length: 50 }, (_, i) => row(record, i)),
		),
	);
	const changes: CatalogPage[] = [];
	const catalog = new AgentCatalog({ store, onChange: (page) => changes.push(page) });
	t.after(() => catalog.close());
	await catalog.refresh();
	assert.equal(new Set(changes.flatMap((page) => page.changed?.map((item) => item.id) ?? [])).size, 50);
	const cursor = catalog.page({ limit: 1 }).nextCursor;
	assert.ok(cursor);
	assert.equal(catalog.page().changed, undefined);
	assert.equal(catalog.page().removed, undefined);
	changes.length = 0;
	await save(root, record, view(record, [row(record), row(record, 99)]));
	await catalog.refresh();
	const removed = new Set(changes.flatMap((page) => page.removed ?? []));
	assert.equal(removed.size, 49);
	assert.ok(removed.has("fixture:50"));
	assert.ok(!removed.has("fixture"));
	assert.throws(() => catalog.page({ cursor }));
	assert.equal(catalog.page().rows.length, 2);
});

test("directory replacement refuses continuation and closes its old iterator", async (t) => {
	const { store, root } = await fixture(t);
	let closes = 0;
	const worker = new CatalogInventory(store, () => {}, {
		watchDirectory: watcher,
		openDirectory: async () => ({
			read: async () => ({ name: "ignored.sqlite" }) as Dirent,
			close: async () => {
				closes++;
			},
		}),
	});
	t.after(() => worker.close());
	const scan = await worker.refresh();
	assert.equal(scan.complete, false);
	await rename(root, join(store, "old"));
	await mkdir(root, { mode: 0o700 });
	const next = await worker.refresh(scan.scanId);
	assert.equal(next.state, "failed");
	assert.equal(next.complete, false);
	assert.equal(closes, 1);
});

test("symlink roots refuse scans and a failed watcher leaves successful scans stale", async (t) => {
	const { store, root } = await fixture(t);
	await rename(root, join(store, "old"));
	await symlink(join(store, "old"), root);
	const worker = new CatalogInventory(store, () => {}, { watchDirectory: watcher });
	t.after(() => worker.close());
	assert.equal((await worker.refresh()).state, "failed");
	await rm(root);
	await mkdir(root, { mode: 0o700 });
	const updates: CatalogUpdate[] = [];
	const unwatched = new CatalogInventory(store, (update) => updates.push(update), {
		watchDirectory: () => {
			throw new Error("No watcher");
		},
	});
	t.after(() => unwatched.close());
	assert.equal((await unwatched.refresh()).complete, true);
	assert.equal(updates.at(-1)?.stale, true);
});
