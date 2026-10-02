import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AgentCatalog, hostMetadata, storageIdOf } from "./catalog.ts";

function fixture(t: { after(fn: () => void): void }) {
	const root = mkdtempSync(join(tmpdir(), "agent-catalog-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return { catalog: new AgentCatalog(root), input: { cwd: root, agentDir: root, packageDir: root, model: { provider: "test", modelId: "model" }, thinkingLevel: "off", ownerId: "owner" } };
}

it("deduplicates a spawn request by owner and request identity", (t) => {
	const { catalog, input } = fixture(t);
	const first = catalog.create(input, "request");
	assert.deepEqual(catalog.create(input, "request"), first);
	assert.deepEqual(hostMetadata(catalog.read(first.storageId)), hostMetadata(first));
	assert.equal(storageIdOf(`${first.storageId}:12`), first.storageId);
	assert.notEqual(catalog.create(input, "other").storageId, first.storageId);
	assert.notEqual(catalog.create({ ...input, ownerId: "other" }, "request").storageId, first.storageId);
	assert.throws(() => catalog.create({ ...input, name: "changed" }, "request"), /different agent configuration/u);
});

it("validates metadata before publishing a catalog record", (t) => {
	const { catalog, input } = fixture(t);
	assert.throws(() => catalog.create({ ...input, thinkingLevel: "unknown" }), /reasoning level/u);
	assert.throws(() => catalog.create({ ...input, cwd: "relative" }), /absolute path/u);
	assert.throws(() => catalog.create({ ...input, model: { provider: "", modelId: "model" } }), /empty/u);
	assert.deepEqual(readdirSync(catalog.root), []);
});

it("reports corrupt metadata as skipped without losing valid records", async (t) => {
	const { catalog, input } = fixture(t);
	const valid = catalog.create({ ...input, name: "Valid" });
	const corrupt = catalog.create(input);
	writeFileSync(catalog.path(corrupt.storageId), JSON.stringify({ ...corrupt, thinkingLevel: "unknown" }));
	const page = await catalog.page();
	assert.deepEqual(page.records, [valid]);
	assert.equal(page.coverage.skipped, 1);
	assert.equal(page.coverage.complete, true);
	assert.throws(() => catalog.read(corrupt.storageId), /reasoning level/u);
});
