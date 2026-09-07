import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readModels } from "./models.ts";

const model = (provider: string, id: string): Model<Api> => ({ provider, id, name: `Model ${id}`, api: "openai-completions",
	baseUrl: "https://example.invalid", reasoning: true, input: ["text"], contextWindow: 10000, maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
function context() {
	const catalog = [model("catalog-fixture", "b"), model("extension-fixture", "a"), model("catalog-fixture", "a")];
	const ctx = { model: catalog[0], thinkingLevel: "high",
		scopedModels: [{ model: { ...catalog[1] } }, { model: { ...catalog[2] }, thinkingLevel: "medium" }],
		modelRegistry: { getAll: () => catalog, getAvailable: () => catalog, getError: () => undefined,
			hasConfiguredAuth: () => true, getRegisteredProviderIds: () => ["extension-fixture"] },
	} as unknown as ExtensionContext;
	return { ctx, catalog };
}

describe("model snapshots", () => {
	it("projects numeric scope positions without changing alphabetical record order", () => {
		const { ctx } = context();
		const snapshot = readModels(ctx, 1);
		assert.deepEqual(snapshot.records.map((record) => record.name), ["catalog-fixture/a", "catalog-fixture/b", "extension-fixture/a"]);
		const [second, outside, first] = snapshot.records;
		assert.equal(typeof first.scopeIndex, "number");
		assert.equal(first.scopeIndex, 0);
		assert.equal(first.inScope, true);
		assert.equal(Object.hasOwn(first, "scopeThinkingLevel"), false);
		assert.equal(second.scopeIndex, 1);
		assert.equal(second.inScope, true);
		assert.equal(second.scopeThinkingLevel, "medium");
		assert.equal(outside.inScope, false);
		assert.equal(Object.hasOwn(outside, "scopeIndex"), false);
		assert.equal(Object.hasOwn(outside, "scopeThinkingLevel"), false);
	});
	it("omits scope positions and uses a null order when no scope is configured", () => {
		const { ctx } = context(); ctx.scopedModels = [];
		const snapshot = readModels(ctx, 1);
		assert.equal(snapshot.scopeConfigured, false);
		assert.equal(snapshot.scopeOrder, null);
		assert.equal(Object.hasOwn(snapshot, "scopeOrder"), true);
		for (const record of snapshot.records) {
			assert.equal(record.inScope, true);
			assert.equal(Object.hasOwn(record, "scopeIndex"), false);
			assert.equal(Object.hasOwn(record, "scopeThinkingLevel"), false);
		}
	});
	it("keeps unavailable scope evidence unknown without scope positions", () => {
		const { ctx } = context(); ctx.scopedModels = undefined as unknown as ExtensionContext["scopedModels"];
		const snapshot = readModels(ctx, 1);
		assert.equal(snapshot.scopeConfigured, null);
		assert.equal(snapshot.scopeOrder, null);
		for (const record of snapshot.records) {
			assert.equal(record.inScope, null);
			assert.equal(Object.hasOwn(record, "scopeIndex"), false);
		}
	});
	it("retains canonical scope order independently of catalog and record order", () => {
		const { ctx, catalog } = context();
		const snapshot = readModels(ctx, 1);
		assert.equal(snapshot.scopeConfigured, true);
		assert.deepEqual(snapshot.scopeOrder, ["extension-fixture/a", "catalog-fixture/a"]);
		ctx.scopedModels = [{ model: catalog[2] }, { model: catalog[1] }];
		assert.deepEqual(readModels(ctx, 2).scopeOrder, ["catalog-fixture/a", "extension-fixture/a"]);
		assert.deepEqual(snapshot.scopeOrder, ["extension-fixture/a", "catalog-fixture/a"]);
	});
	it("reads extension-provider membership once per snapshot for every record", () => {
		const { ctx } = context();
		let reads = 0;
		ctx.modelRegistry.getRegisteredProviderIds = () => { reads += 1; return ["extension-fixture"]; };
		const snapshot = readModels(ctx, 1);
		assert.equal(reads, 1);
		assert.deepEqual(snapshot.records.map((record) => record.extensionProvider), [false, false, true]);
		ctx.modelRegistry.getRegisteredProviderIds = () => { reads += 1; return []; };
		assert.deepEqual(readModels(ctx, 2).records.map((record) => record.extensionProvider), [false, false, false]);
		assert.equal(reads, 2);
	});
	it("keeps provider registration null for every record when its accessor throws", () => {
		const { ctx } = context();
		let reads = 0;
		ctx.modelRegistry.getRegisteredProviderIds = () => { reads += 1; throw new Error("private-provider-error"); };
		const snapshot = readModels(ctx, 1);
		assert.equal(reads, 1);
		assert.deepEqual(snapshot.records.map((record) => record.extensionProvider), [null, null, null]);
		assert.equal(snapshot.catalogAvailable, true);
		assert.equal(snapshot.availableSnapshot, true);
		assert.doesNotMatch(JSON.stringify(snapshot), /private-provider-error/);
	});
	it("projects scope and provider registration for a selected model outside the catalog", () => {
		const { ctx, catalog } = context();
		ctx.model = catalog[1]; ctx.modelRegistry.getAll = () => [catalog[0]];
		const selected = readModels(ctx, 1).records.find((record) => record.selected);
		assert.ok(selected);
		assert.equal(selected.catalog, false);
		assert.equal(selected.scopeIndex, 0);
		assert.equal(selected.extensionProvider, true);
	});
});
