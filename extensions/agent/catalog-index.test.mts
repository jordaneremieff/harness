import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AgentCatalog } from "./catalog.ts";
import { CATALOG_INDEX_STAMP_MARGIN_MS, CatalogIndex } from "./catalog-index.ts";

function catalogFor(t: { after(fn: () => void): void }) {
	const root = mkdtempSync(join(tmpdir(), "catalog-index-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const catalog = new AgentCatalog(root);
	const create = () =>
		catalog.create({
			cwd: root,
			agentDir: root,
			packageDir: root,
			model: { provider: "fixture", modelId: "model" },
			thinkingLevel: "off",
		});
	return { catalog, create };
}

/** An index whose directory stamp and clock the test sets. */
function controlled() {
	const state = { stamp: "directory-1", modifiedMs: 10_000, now: 10_000 };
	const index = new CatalogIndex((record) => record.cwd, {
		now: () => state.now,
		directoryStamp: async () => ({ stamp: state.stamp, modifiedMs: state.modifiedMs }),
	});
	return { state, index };
}

it("answers a catalog whose directory stamp is old and unchanged from one stat", async (t) => {
	const { catalog, create } = catalogFor(t);
	const first = create();
	const { state, index } = controlled();
	state.now = state.modifiedMs + CATALOG_INDEX_STAMP_MARGIN_MS;
	const before = await index.read(catalog);
	assert.deepEqual(
		before.map((entry) => entry.storageId),
		[first.storageId],
	);
	const listings = t.mock.method(catalog, "identities");
	const again = await index.read(catalog);
	assert.deepEqual(again, before);
	assert.notEqual(again, before, "each read returns its own array");
	assert.equal(listings.mock.callCount(), 0, "an unchanged old directory is not listed");
	state.stamp = "directory-2";
	const second = create();
	const after = await index.read(catalog);
	assert.equal(listings.mock.callCount(), 1, "a changed stamp lists again");
	assert.deepEqual(after.map((entry) => entry.storageId).sort(), [first.storageId, second.storageId].sort());
});

it("lists a recently modified directory at every read, so a write in the same timestamp tick is seen", async (t) => {
	const { catalog, create } = catalogFor(t);
	const first = create();
	const { state, index } = controlled();
	state.now = state.modifiedMs + CATALOG_INDEX_STAMP_MARGIN_MS - 1;
	await index.read(catalog);
	// A second write lands after the first read's stat and in the same tick: the stamp is unchanged.
	const second = create();
	const listings = t.mock.method(catalog, "identities");
	const after = await index.read(catalog);
	assert.equal(listings.mock.callCount(), 1, "a stamp within the margin proves nothing");
	assert.deepEqual(after.map((entry) => entry.storageId).sort(), [first.storageId, second.storageId].sort());
	state.now += 1;
	await index.read(catalog);
	assert.equal(listings.mock.callCount(), 2, "the first read past the margin lists once more and records the stamp");
	await index.read(catalog);
	assert.equal(listings.mock.callCount(), 2, "later reads take one stat");
});

it("reads the real directory stamp and sees a replaced record", async (t) => {
	const { catalog, create } = catalogFor(t);
	const first = create();
	const index = new CatalogIndex((record) => record.view?.updatedAt);
	assert.equal((await index.read(catalog))[0]?.value, undefined);
	catalog.updateView(first.storageId, {
		storageId: first.storageId,
		updatedAt: "2026-11-24T00:00:00.000Z",
		rows: [],
		coverage: { complete: true, omitted: 0 },
	});
	assert.equal((await index.read(catalog))[0]?.value, "2026-11-24T00:00:00.000Z");
});
