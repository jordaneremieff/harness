import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AgentCatalog } from "./catalog.ts";
import { CatalogIndex } from "./catalog-index.ts";

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

it("answers an unchanged catalog from one directory stat and lists again after any record change", async (t) => {
	const { catalog, create } = catalogFor(t);
	const first = create();
	const index = new CatalogIndex((record) => record.cwd);
	const before = await index.read(catalog);
	assert.deepEqual(
		before.map((entry) => entry.storageId),
		[first.storageId],
	);
	const listings = t.mock.method(catalog, "identities");
	const again = await index.read(catalog);
	assert.deepEqual(again, before);
	assert.notEqual(again, before, "each read returns its own array");
	assert.equal(listings.mock.callCount(), 0, "an unchanged directory is not listed");
	const second = create();
	const after = await index.read(catalog);
	assert.equal(listings.mock.callCount(), 1);
	assert.deepEqual(after.map((entry) => entry.storageId).sort(), [first.storageId, second.storageId].sort());
	catalog.updateView(first.storageId, {
		storageId: first.storageId,
		updatedAt: new Date().toISOString(),
		rows: [],
		coverage: { complete: true, omitted: 0 },
	});
	await index.read(catalog);
	assert.equal(listings.mock.callCount(), 2, "a replaced record changes the directory");
});
