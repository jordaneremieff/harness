import assert from "node:assert/strict";
import type { FSWatcher } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readRecord, RECORD_BYTES } from "./catalog-record.mts";
import { CatalogInventory, SEGMENT_BYTES } from "./catalog-worker.mts";
import type { CatalogUpdate } from "./catalog-state.mts";

test("large named-hint batches retain leftovers behind their explicit scanId", async (t) => {
	const store = await mkdtemp(join(tmpdir(), "catalog-hints-"));
	const root = join(store, "durable");
	t.after(() => rm(store, { recursive: true, force: true }));
	await mkdir(root, { mode: 0o700 });
	const filenames = Array.from({ length: 300 }, (_, n) => `fixture-${n}.json`);
	await Promise.all(
		filenames.map(async (filename) => {
			const id = filename.slice(0, -5);
			const record = {
				storageId: id,
				cwd: store,
				agentDir: store,
				packageDir: store,
				storagePath: join(root, `${id}.sqlite`),
				model: { provider: "example", modelId: "example" },
				thinkingLevel: "off",
				createdAt: "2026-01-01T00:00:00.000Z",
				threads: "",
			};
			record.threads = "x".repeat(RECORD_BYTES - Buffer.byteLength(JSON.stringify(record)));
			await writeFile(join(root, filename), JSON.stringify(record), { mode: 0o600 });
		}),
	);
	let loads = 0;
	const updates: CatalogUpdate[] = [];
	const worker = new CatalogInventory(store, (update) => updates.push(update), {
		watchDirectory: () =>
			({
				on() {
					return this;
				},
				close() {},
			}) as unknown as FSWatcher,
		readCatalogRecord: async (...args) => {
			loads++;
			return readRecord(...args);
		},
	});
	t.after(() => worker.close());
	const scan = await worker.refresh();
	assert.equal(scan.complete, false);
	assert.equal((await worker.refresh(scan.scanId)).complete, true);
	loads = 0;
	for (const filename of filenames) worker.hint(filename);
	await worker.settled();
	assert.equal(loads, SEGMENT_BYTES / RECORD_BYTES);
	const pending = updates.at(-1);
	assert.ok(pending);
	assert.equal(pending.scan.state, "running");
	assert.equal(pending.scan.complete, false);
	assert.equal(pending.stale, true);
	assert.equal(pending.scan.visited, 300);
	const finished = await worker.refresh(pending.scan.scanId);
	assert.equal(finished.complete, true);
	assert.equal(loads, 300);
	assert.equal(finished.visited, 300);
});
