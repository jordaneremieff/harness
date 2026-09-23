import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { ModelRegistry, type ExtensionAPI, type ExtensionContext, type ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import registerRegistry, { RegistryParams } from "./index.ts";
import { catalogHealth, type HealthRecord } from "./health.ts";
import { lookup, type LookupResult } from "./lookup.ts";
import { readModels, type ModelSnapshot } from "./models.ts";
import { decodeCursor, parseQuery, type RawParams } from "./query.ts";
import type { HostSnapshot } from "./records.ts";

const model = (id: string, provider = "fixture"): Model<Api> => ({
	provider, id, name: id, api: "openai-completions", baseUrl: "https://private.invalid",
	headers: { Authorization: "private-header" }, reasoning: true, input: ["text"],
	contextWindow: 10000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
const host: HostSnapshot = { tools: [], activeTools: [], commands: [], observation: null,
	availability: { tools: true, activeTools: true, commands: true }, at: 1 };
function fixture(catalog = [model("preview-expires-on-1231"), model("stable")]) {
	const calls: string[] = [];
	const runtime = new Proxy({
		getModels: () => { calls.push("catalog"); return catalog; },
		getAvailableSnapshot: () => { calls.push("available"); return catalog; },
		getError: () => { calls.push("error"); return undefined; },
		hasConfiguredAuth: () => { calls.push("auth"); return true; },
		getRegisteredProviderIds: () => { calls.push("providers"); return []; },
	}, { get(target, key, receiver) {
		if (!(key in target)) throw new Error(`Forbidden runtime access: ${String(key)}`);
		return Reflect.get(target, key, receiver);
	} });
	const ctx = { modelRegistry: new ModelRegistry(runtime as unknown as ModelRuntime), scopedModels: [] } as unknown as ExtensionContext;
	return { ctx, calls, catalog };
}
const run = (models: ModelSnapshot | undefined, params: RawParams = { kind: "model", health: true }) =>
	lookup({ models, params, snapshot: host, session: {}, epoch: "health-fixture" });
const records = (result: LookupResult) => result.details.records as HealthRecord[];
const codes = (record: HealthRecord) => record.findings.map((finding) => finding.code);
const coverage = (result: LookupResult) => result.details.health as Record<string, unknown>;

function assertBounded(result: LookupResult) {
	const payload = { content: [{ type: "text", text: result.text }], details: result.details };
	assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= 50 * 1024);
	const lines = result.text.split("\n").length + JSON.stringify(result.details, null, 2).replace(/\\n/g, "\n").split("\n").length + 6;
	assert.ok(lines <= 2000);
}

describe("offline catalog health", () => {
	it("flags explicit expiry cues without guessing retirement status or treating version dates as expiry", () => {
		const ids = ["preview-expires-on-1231", "preview-expires-on-2030-12-31", "EXPIRES-ON-0229",
			"version-2030-12-31", "version-1231", "neverexpires-on-1231", "expires-on-12345", "expires-on-later"];
		const { ctx } = fixture(ids.map((id) => model(id)));
		const flagged = catalogHealth(readModels(ctx, 1));
		assert.deepEqual(flagged.map((record) => record.id).sort(), ids.slice(0, 3).sort());
		for (const record of flagged) {
			assert.deepEqual(codes(record), ["expiry_marker"]);
			assert.match(record.findings[0].boundary, /unverified.*no year/);
		}
	});
	it("reports only current selected auth and membership gaps, not unused unauthenticated catalog entries", async () => {
		const { ctx } = fixture([model("stable")]);
		ctx.model = model("preview-expires-on-1231");
		ctx.modelRegistry.hasConfiguredAuth = () => false;
		const result = await run(readModels(ctx, 1));
		assert.equal(result.outcome, "ok");
		assert.equal(result.details.total, 1);
		assert.deepEqual(codes(records(result)[0]), ["expiry_marker", "selected_not_in_catalog", "selected_auth_missing"]);
		assert.equal(coverage(result).matchedRecords, 2);
		assert.equal(coverage(result).unflaggedRecords, 1);
		assert.match(result.text, /silently omit failed providers/);
		assert.match(result.text, /not recent dispatch use/);
	});
	it("compares exact identities and capability sets before filters, not display names or different providers", async () => {
		const a = model("same");
		const b = { ...model("same"), contextWindow: 20000 };
		const other = { ...model("same", "other"), maxTokens: 3000 };
		const { ctx } = fixture([a, b, other]);
		const result = await run(readModels(ctx, 1), { kind: "model", health: true, provider: "fixture", name: "fixture/same" });
		assert.equal(result.details.total, 2);
		assert.deepEqual(records(result)[0].findings[0].fields, ["contextWindow"]);
		assert.equal(records(result)[0].findings[0].duplicateRecords, 2);
		assert.equal(catalogHealth(readModels(fixture([a, other]).ctx, 1)).length, 0);
		const reordered = { ...a, name: "Different label", input: ["image", "text"] as Model<Api>["input"] };
		const original = { ...a, input: ["text", "image"] as Model<Api>["input"] };
		assert.equal(catalogHealth(readModels(fixture([original, reordered]).ctx, 1)).length, 0);
	});
	it("returns an explicit bounded clean report and distinguishes an empty filter from a healthy catalog", async () => {
		const { ctx } = fixture([model("stable")]);
		for (const params of [{ kind: "model", health: true }, { kind: "model", health: true, name: "absent" }]) {
			const result = await run(readModels(ctx, 1), params);
			assert.equal(result.outcome, "ok");
			assert.deepEqual(records(result), []);
			assert.match(result.text, /not that the catalog is healthy/);
			assert.equal(coverage(result).recentDispatchUse, "unavailable");
			assert.equal(coverage(result).providerRefreshTime, "unavailable");
			assert.equal(coverage(result).remoteResolution, "not_checked");
			assertBounded(result);
		}
		assert.equal((await run(readModels(fixture([]).ctx, 1))).outcome, "ok");
	});
	it("preserves known expiry signals while failed catalog and auth evidence remain incomplete", async () => {
		const { ctx } = fixture();
		ctx.model = model("preview-expires-on-1231");
		ctx.modelRegistry.getAll = () => { throw new Error("private-catalog-error"); };
		ctx.modelRegistry.hasConfiguredAuth = () => { throw new Error("private-auth-error"); };
		let result = await run(readModels(ctx, 1));
		assert.equal(result.outcome, "unavailable");
		assert.deepEqual(codes(records(result)[0]), ["expiry_marker"]);
		ctx.modelRegistry.getAll = () => [];
		ctx.modelRegistry.getError = () => "private-configuration-error";
		result = await run(readModels(ctx, 1));
		assert.equal(result.outcome, "partial");
		assert.deepEqual(codes(records(result)[0]), ["expiry_marker"]);
		assert.doesNotMatch(JSON.stringify(result), /private-/);
		ctx.modelRegistry.getError = () => undefined;
		result = await run(readModels(ctx, 1));
		assert.equal(result.outcome, "partial");
		assert.equal(coverage(result).selectedAuth, "unavailable");
		assert.equal((await run(undefined)).outcome, "unavailable");
	});
	it("withholds continuation when auth, catalog, or required availability evidence is incomplete", async () => {
		const { ctx, catalog } = fixture([model("a-expires-on-0101"), model("b-expires-on-0101")]);
		ctx.model = catalog[0];
		const query = { kind: "model", health: true, available: true, limit: 1 };
		const outcomes = { auth: "partial", catalog: "partial", availability: "unavailable" };
		for (const fault of ["auth", "catalog", "availability"] as const) {
			const snapshot = readModels(ctx, 1);
			if (fault === "auth") snapshot.records[0].configuredAuth = null;
			if (fault === "catalog") snapshot.catalogError = true;
			if (fault === "availability") snapshot.availableSnapshot = false;
			const result = await run(snapshot, query);
			assert.equal(result.outcome, outcomes[fault]);
			assert.equal(result.details.total, 2);
			assert.equal(records(result).length, 1);
			assert.equal(result.details.cursor, undefined);
		}
	});
	it("retains model filters and ordinary health-false queries", async () => {
		const { ctx, catalog } = fixture();
		catalog.push(model("other-expires-on-0101", "other"));
		ctx.modelRegistry.getAvailable = () => [catalog[0]];
		const snapshot = readModels(ctx, 1);
		const params = { kind: "model", health: true, provider: "fixture", search: "PREVIEW", available: true };
		assert.equal(records(await run(snapshot, params)).length, 1);
		assert.equal(records(await run(snapshot, { ...params, available: false })).length, 0);
		const ordinary = await run(snapshot, { kind: "model", health: false });
		assert.equal(records(ordinary).length, 3);
		assert.equal(ordinary.details.health, undefined);
		assert.equal(records(ordinary)[0].findings, undefined);
	});
	it("validates model-only health and preserves it in cursor-only continuation", async () => {
		for (const params of [{ health: true }, { kind: "tool", health: false }, { kind: "model", health: "true" },
			{ kind: "model", health: true, contains: "x" }, { kind: "model", health: true, detail: true }]) {
			assert.throws(() => parseQuery(params as RawParams));
		}
		const { ctx } = fixture([model("a-expires-on-0101"), model("b-expires-on-0101")]);
		const first = await run(readModels(ctx, 1), { kind: "model", health: true, limit: 1 });
		const cursor = first.details.cursor as string;
		assert.equal(decodeCursor(cursor).query.health, true);
		const next = await run(readModels(ctx, 2), { cursor });
		assert.equal(next.outcome, "ok");
		assert.equal(records(next)[0].id, "b-expires-on-0101");
		assert.equal((await run(readModels(ctx, 2), { cursor, health: false })).outcome, "invalid_arguments");
		ctx.model = model("selected");
		assert.equal((await run(readModels(ctx, 3), { cursor })).outcome, "stale_cursor");
	});
	it("invalidates continuation when an unflagged row creates a conflict", async () => {
		const { ctx, catalog } = fixture([model("a-expires-on-0101"), model("b-expires-on-0101"), model("plain")]);
		const first = await run(readModels(ctx, 1), { kind: "model", health: true, limit: 1 });
		catalog.push({ ...model("plain"), maxTokens: 42 });
		assert.equal((await run(readModels(ctx, 2), { cursor: first.details.cursor as string })).outcome, "stale_cursor");
	});
	it("bounds complete reports and resumes after retained rather than omitted records", async () => {
		const { ctx } = fixture(Array.from({ length: 100 }, (_, i) => ({ ...model(`${String(i).padStart(3, "0")}-expires-on-0101`), name: "x".repeat(1000) })));
		const snapshot = readModels(ctx, 1);
		const first = await run(snapshot, { kind: "model", health: true, limit: 100 });
		assertBounded(first);
		assert.equal(first.details.resultBounded, true);
		const kept = records(first).length;
		assert.ok(kept > 0 && kept < 100);
		assert.equal(decodeCursor(first.details.cursor as string).offset, kept);
		const next = await run(snapshot, { cursor: first.details.cursor as string });
		assert.equal(records(next)[0].name, snapshot.records[kept].name);
		assertBounded(next);
		snapshot.records[0].displayName = "x".repeat(100000);
		const blocked = await run(snapshot);
		assert.equal(blocked.details.pageBlocked, true);
		assert.equal(blocked.details.cursor, undefined);
		assertBounded(blocked);
	});
	it("runs through the tool and real registry facade with only synchronous safe getters", async () => {
		let tool: ToolDefinition<typeof RegistryParams, Record<string, unknown>> | undefined;
		registerRegistry({ on: () => () => {}, registerTool: (value: typeof tool) => { tool = value; },
			getAllTools: () => [], getActiveTools: () => [], getCommands: () => [] } as unknown as ExtensionAPI);
		assert.ok(tool);
		assert.equal(RegistryParams.properties.health.type, "boolean");
		assert.match(tool.description, /health true/);
		const { ctx, calls } = fixture();
		const result = await tool.execute("health", { kind: "model", health: true }, undefined, undefined, ctx);
		assert.equal(result.details?.total, 1);
		assert.deepEqual(calls, ["catalog", "available", "error", "providers", "auth", "auth"]);
		assert.doesNotMatch(JSON.stringify(result), /private\.invalid|private-header|baseUrl|Authorization/);
		calls.length = 0;
		await tool.execute("cancelled", { kind: "model", health: true }, AbortSignal.abort(), undefined, ctx);
		assert.deepEqual(calls, []);
	});
});
