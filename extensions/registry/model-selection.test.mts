import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Check, Errors } from "typebox/value";
import { MAX_RESULT_BYTES, MAX_RESULT_LINES } from "./format.ts";
import { lookup, type LookupResult } from "./lookup.ts";
import { readDurableModels, readModels, readSettingsScope, type DurableModelReader, type ModelRecord, type ModelSnapshot, type SettingsScopeEvidence } from "./models.ts";
import { RegistryOutputSchema } from "./output.ts";
import type { RawParams } from "./query.ts";

function fixture() {
	const catalog: Model<Api>[] = Array.from({ length: 6 }, (_, index) => ({
		provider: `test-provider-${index}`, id: `test-model-${index}`, name: `Sample V${index}.1 Light`,
		api: "fixture-api", baseUrl: "https://example.invalid", reasoning: true,
		input: ["text"], contextWindow: 10000, maxTokens: 1000,
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 3 },
	}));
	const available = new Set(catalog.slice(4));
	const configured = new Set(catalog.slice(2));
	const ctx = { model: catalog[0], thinkingLevel: "high", scopedModels: [], modelRegistry: {
		getAll: () => [...catalog].reverse(), getAvailable: () => [...available], getError: () => undefined,
		getRegisteredProviderIds: () => [], hasConfiguredAuth: (model: Model<Api>) => configured.has(model),
		isUsingOAuth: () => false, getProviderAuthStatus: () => ({ source: "environment", label: "private-auth-label" }),
		getProvider: () => ({ auth: { oauth: { isSubscription: true } } }),
		getProviderAuth: () => { throw new Error("Unexpected credential resolution"); },
		refresh: () => { throw new Error("Unexpected refresh"); },
	} } as unknown as ExtensionContext;
	return { catalog, available, configured, ctx };
}

async function run(models: ModelSnapshot, params: RawParams = { kind: "model" }) {
	const result = await lookup({ params, models, session: {}, epoch: "test", snapshot: {
		tools: [], activeTools: [], commands: [], observation: null, at: 1,
		availability: { tools: true, activeTools: true, commands: true },
	} });
	assert.ok(Check(RegistryOutputSchema, result.structuredContent), JSON.stringify([...Errors(RegistryOutputSchema, result.structuredContent)]));
	const envelope = { content: [{ type: "text", text: result.text }], details: result.details, structuredContent: result.structuredContent };
	assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= MAX_RESULT_BYTES);
	assert.ok(JSON.stringify(envelope, null, 2).replace(/\\n/g, "\n").split("\n").length <= MAX_RESULT_LINES);
	return result;
}
const records = (result: LookupResult) => result.details.records as unknown as ModelRecord[];

function durableReader(catalog: Model<Api>[]): DurableModelReader {
	return { getModels: () => catalog, getModel: (provider, id) => catalog.find((model) => model.provider === provider && model.id === id),
		getAvailableSnapshot: () => catalog, getError: () => undefined, getRegisteredProviderIds: () => [], hasConfiguredAuth: () => true,
		isUsingOAuth: () => true, isUsingSubscription: () => true, getProviderAuthStatus: () => ({ source: "stored" }),
	};
}

describe("portable model selection evidence", () => {
	it("orders availability groups alphabetically and keeps selection and scope out of ranking", async () => {
		const { catalog, ctx } = fixture();
		ctx.scopedModels = [{ model: catalog[1] }];
		const snapshot = readModels(ctx, 1);
		assert.deepEqual(snapshot.records.map((row) => row.id), [4, 5, 2, 3, 0, 1].map((index) => catalog[index].id));
		assert.equal(snapshot.records.find((row) => row.id === catalog[0].id)?.selected, true);
		assert.deepEqual(snapshot.records.map((row) => row.providerHasScopedModels), [false, false, false, false, false, true]);
		const result = await run(snapshot);
		assert.equal(result.text.match(/Order: available first/g)?.length, 1);
		assert.match(result.text, /Configured access and scope do not establish operator preference/);
		assert.match(result.text, /Quota, balance, and remote health remain unchecked/);
		assert.doesNotMatch(JSON.stringify(result), /private-auth-label/);
	});
	it("does not turn an empty or unavailable scope into provider preference", () => {
		const { ctx } = fixture();
		assert.ok(readModels(ctx, 1).records.every((row) => row.providerHasScopedModels === null && row.inScope === true));
		ctx.scopedModels = undefined as unknown as ExtensionContext["scopedModels"];
		assert.ok(readModels(ctx, 1).records.every((row) => row.providerHasScopedModels === null && row.inScope === null));
	});
	it("requires every model-search token across either name without changing exact filters", async () => {
		const { catalog, ctx } = fixture();
		const snapshot = readModels(ctx, 1);
		const result = await run(snapshot, { kind: "model", search: "  LIGHT\tprovider-4\nV4.1 " });
		assert.deepEqual(records(result).map((row) => row.id), [catalog[4].id]);
		assert.equal((await run(snapshot, { kind: "model", search: "light absent" })).outcome, "missing");
		assert.equal((await run(snapshot, { kind: "model", search: " \t " })).outcome, "missing");
		const name = `${catalog[4].provider}/${catalog[4].id}`;
		assert.equal(records(await run(snapshot, { kind: "model", name })).length, 1);
		assert.equal((await run(snapshot, { kind: "model", name: name.toUpperCase() })).outcome, "missing");
		assert.equal((await run(snapshot, { kind: "model", provider: catalog[4].provider.toUpperCase() })).outcome, "missing");
		assert.equal(records(await run(snapshot, { kind: "model", provider: catalog[4].provider, search: "light" })).length, 1);
	});
	it("projects authentication facts independently and never treats a key as metered billing", () => {
		const { ctx } = fixture();
		let snapshot = readModels(ctx, 1);
		assert.ok(snapshot.records.every((row) => row.oauth === false && row.subscriptionRecognized === false && row.authSource === "environment"));
		ctx.modelRegistry.isUsingOAuth = () => true;
		snapshot = readModels(ctx, 1);
		assert.ok(snapshot.records.every((row) => row.oauth === true && row.subscriptionRecognized === true));
		ctx.modelRegistry.getProvider = () => { throw new Error("private-provider"); };
		ctx.modelRegistry.getProviderAuthStatus = () => ({ configured: true, source: "private-source" as never, label: "private-label" });
		snapshot = readModels(ctx, 1);
		assert.ok(snapshot.records.every((row) => row.oauth === true && row.subscriptionRecognized === null && row.authSource === null));
		ctx.modelRegistry.isUsingOAuth = () => { throw new Error("private-oauth"); };
		ctx.modelRegistry.getProviderAuthStatus = () => { throw new Error("private-auth"); };
		snapshot = readModels(ctx, 1);
		assert.ok(snapshot.records.every((row) => row.oauth === null && row.subscriptionRecognized === null && row.authSource === null));
		assert.doesNotMatch(JSON.stringify(snapshot), /private-/);
	});
	it("retains unknown availability while configured records still precede the rest", () => {
		const { catalog, ctx } = fixture();
		ctx.modelRegistry.getAvailable = () => { throw new Error("unavailable"); };
		const snapshot = readModels(ctx, 1);
		assert.ok(snapshot.records.every((row) => row.available === null));
		assert.deepEqual(snapshot.records.map((row) => row.id), [2, 3, 4, 5, 0, 1].map((index) => catalog[index].id));
	});
	it("keeps price tiers out of list text and structured records but exposes them in exact lookups", async () => {
		const { catalog, ctx } = fixture();
		catalog[4].cost.tiers = [{ inputTokensAbove: 8192, input: 4, output: 5, cacheRead: 1, cacheWrite: 6 }];
		const snapshot = readModels(ctx, 1);
		const list = await run(snapshot);
		const row = records(list).find((item) => item.id === catalog[4].id);
		assert.ok(row);
		assert.equal(row.catalogCostHasTiers, true);
		assert.deepEqual(row.catalogCost, { input: 1, output: 2, cacheRead: 0, cacheWrite: 3 });
		assert.doesNotMatch(JSON.stringify(list), /inputTokensAbove/);
		const exact = await run(snapshot, { kind: "model", name: row.name });
		assert.deepEqual(records(exact)[0].catalogCost, catalog[4].cost);
		assert.match(exact.text, /inputTokensAbove/);
		const block = list.text.split(`MODEL ${row.name}\n`)[1].split("\nMODEL ")[0];
		assert.equal(block.trim().split("\n").length, 2);
		assert.ok(block.length < 900);
		catalog[4].cost.tiers[0].input = 20;
		assert.equal(snapshot.records[0].catalogCost?.tiers?.[0].input, 4);
	});
	it("keeps missing and malformed prices unknown without replacing them with zero", () => {
		const { catalog, ctx } = fixture();
		catalog[0].cost = undefined as unknown as Model<Api>["cost"];
		catalog[1].cost.input = Number.NaN;
		catalog[2].cost.tiers = [{ inputTokensAbove: -1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }];
		const rows = readModels(ctx, 1).records;
		for (const source of catalog.slice(0, 3)) {
			const row = rows.find((item) => item.id === source.id);
			assert.equal(row?.catalogCost, null);
			assert.equal(row?.catalogCostHasTiers, null);
		}
	});
	it("resumes in group order across timestamps and rejects changed prices or availability", async () => {
		const { catalog, ctx, available } = fixture();
		catalog[4].cost.tiers = [{ inputTokensAbove: 1000, input: 4, output: 5, cacheRead: 1, cacheWrite: 6 }];
		const first = await run(readModels(ctx, 1), { kind: "model", limit: 2 });
		const second = await run(readModels(ctx, 2), { cursor: first.details.cursor as string });
		assert.deepEqual(records(second).map((row) => row.id), catalog.slice(2, 4).map((model) => model.id));
		catalog[4].cost.tiers[0].input = 10;
		assert.equal((await run(readModels(ctx, 3), { cursor: first.details.cursor as string })).outcome, "stale_cursor");
		catalog[4].cost.tiers[0].input = 4;
		available.add(catalog[0]);
		assert.equal((await run(readModels(ctx, 4), { cursor: first.details.cursor as string })).outcome, "stale_cursor");
	});
	it("projects Durable public billing accessors and raw settings without effective scope", async () => {
		const { catalog } = fixture();
		const reader = durableReader(catalog);
		const scope: SettingsScopeEvidence = { status: "available", patterns: [`${catalog[0].provider}/*:high`], observedAt: 1 };
		const snapshot = readDurableModels(reader, {}, 1, scope);
		assert.ok(snapshot.records.every((row) => row.inScope === null && row.providerHasScopedModels === null && row.subscriptionRecognized === true));
		const first = await run(snapshot, { kind: "model", limit: 1 });
		assert.deepEqual(first.details.settingsScope, scope);
		assert.match(first.text, /Raw settings patterns are not effective session scope or operator preference/);
		const later = readDurableModels(reader, {}, 2, { ...scope, observedAt: 2 });
		assert.equal((await run(later, { cursor: first.details.cursor as string })).outcome, "ok");
		later.settingsScope = { ...scope, patterns: [] };
		assert.equal((await run(later, { cursor: first.details.cursor as string })).outcome, "stale_cursor");
		reader.isUsingOAuth = () => { throw new Error("private-oauth"); };
		reader.isUsingSubscription = () => { throw new Error("private-subscription"); };
		reader.getProviderAuthStatus = () => { throw new Error("private-source"); };
		assert.ok(readDurableModels(reader, {}, 3, scope).records.every((row) => row.oauth === null && row.subscriptionRecognized === null && row.authSource === null));
	});
	it("bounds oversized settings and exact tiers without claiming absence", async () => {
		const { catalog } = fixture();
		const scope: SettingsScopeEvidence = { status: "available", patterns: ["x".repeat(40000)], observedAt: 1 };
		const hugeSettings = await run(readDurableModels(durableReader(catalog), {}, 1, scope));
		assert.equal(hugeSettings.details.pageBlocked, true);
		assert.equal(hugeSettings.details.omittedDetails, true);
		assert.match(hugeSettings.text, /no absence is established/);
		catalog[0].cost.tiers = Array.from({ length: 1000 }, (_, inputTokensAbove) => ({ inputTokensAbove, input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }));
		const snapshot = readDurableModels(durableReader(catalog), {}, 1, { status: "absent", patterns: null, observedAt: 1 });
		const list = await run(snapshot);
		assert.equal(list.details.pageBlocked, undefined);
		const exact = await run(snapshot, { kind: "model", name: `${catalog[0].provider}/${catalog[0].id}` });
		assert.equal(exact.details.pageBlocked, true);
		assert.match(exact.text, /page cannot advance/);
	});
});

describe("settings scope configuration", () => {
	it("reads effective patterns, detects absent and unreadable sources, and never writes settings", async (t) => {
		const root = await mkdtemp(join(tmpdir(), "registry-settings-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const cwd = join(root, "workspace");
		const agentDir = join(root, "agent");
		await mkdir(agentDir, { recursive: true });
		const global = join(agentDir, "settings.json");
		const projectDir = join(cwd, CONFIG_DIR_NAME);
		const project = join(projectDir, "settings.json");
		assert.deepEqual(readSettingsScope(cwd, agentDir, 1, true), { status: "absent", patterns: null, observedAt: 1 });
		const patterns = Array.from({ length: 2 }, (_, index) => `test-provider-${index}/test-model-${index}:high`);
		const original = JSON.stringify({ enabledModels: patterns, privateFixture: "private-settings-value" });
		await writeFile(global, original);
		assert.deepEqual(readSettingsScope(cwd, agentDir, 2, true), { status: "available", patterns, observedAt: 2 });
		assert.equal(await readFile(global, "utf8"), original);
		await mkdir(projectDir, { recursive: true });
		await writeFile(project, JSON.stringify({ enabledModels: [] }));
		assert.deepEqual(readSettingsScope(cwd, agentDir, 3, true).patterns, []);
		assert.deepEqual(readSettingsScope(cwd, agentDir, 3, false).patterns, patterns);
		await writeFile(project, "private-invalid-json");
		assert.deepEqual(readSettingsScope(cwd, agentDir, 4, true), { status: "unavailable", patterns: null, observedAt: 4 });
		assert.deepEqual(readSettingsScope(cwd, agentDir, 4, false).patterns, patterns);
		await rm(project);
		await writeFile(global, JSON.stringify({ enabledModels: 12 }));
		assert.equal(readSettingsScope(cwd, agentDir, 5, true).status, "unavailable");
		await writeFile(global, JSON.stringify({ enabledModels: [12] }));
		assert.equal(readSettingsScope(cwd, agentDir, 5, true).status, "unavailable");
		await rm(global);
		await mkdir(global);
		assert.equal(readSettingsScope(cwd, agentDir, 6, true).status, "unavailable");
	});
});
