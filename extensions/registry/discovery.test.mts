import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import registerRegistry, { type RegistryParams } from "./index.ts";
import { lookup } from "./lookup.ts";
import { readModels } from "./models.ts";
import { parseQuery } from "./query.ts";
import type { HostSnapshot } from "./records.ts";
import { ObservationStore } from "./observer.ts";

const sourceInfo = { path: "/fixtures/worktree/index.ts", source: "fixture", scope: "temporary" as const, origin: "top-level" as const };
const model = (id: string, reasoning = true): Model<Api> => ({ provider: "fixture", id, name: `Reasoner ${id}`, api: "openai-completions",
	baseUrl: "https://private.invalid/?token=secret-url", headers: { Authorization: "secret-header" },
	reasoning, input: ["text", "image"], contextWindow: 10000, maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, thinkingLevelMap: { xhigh: "xhigh", max: null } });
function context() {
	const catalog = [model("a"), model("b", false)];
	const ctx = { model: catalog[0], thinkingLevel: "high", scopedModels: [{ model: catalog[0], thinkingLevel: "medium" }],
		modelRegistry: { getAll: () => catalog, getAvailable: () => [catalog[0]], getError: () => undefined,
			hasConfiguredAuth: (m: Model<Api>) => m.id === "a", getRegisteredProviderIds: () => [],
			getProviderAuth: () => { throw new Error("must not resolve auth"); },
			refresh: () => { throw new Error("must not refresh"); } },
	} as unknown as ExtensionContext;
	return { ctx, catalog };
}
function host(): HostSnapshot {
	return { tools: [{ name: "inspect", description: "Read document contents", parameters: Type.Object({ path: Type.String() }),
		promptGuidelines: ["Use inspect for documents."], sourceInfo }], activeTools: [], commands: [], observation: null,
		availability: { tools: true, commands: true, activeTools: true }, at: 1000 };
}
const records = (result: { details: Record<string, unknown> }) => result.details.records as Record<string, unknown>[];
const run = (params: Parameters<typeof lookup>[0]["params"], snapshot = host(), models?: ReturnType<typeof readModels>) =>
	lookup({ params, snapshot, models, session: {}, epoch: "fixture" });

describe("model discovery", () => {
	it("projects catalog, auth configuration, selected reasoning and scope without private fields", async () => {
		const { ctx } = context();
		const result = await run({ kind: "model" }, host(), readModels(ctx, 1));
		assert.equal(result.outcome, "ok");
		assert.match(result.text, /^registry outcome=ok\n/);
		const [a, b] = records(result);
		assert.equal(a.name, "fixture/a");
		assert.equal(a.selected, true);
		assert.equal(a.available, true);
		assert.equal(a.configuredAuth, true);
		assert.equal(a.extensionProvider, false);
		assert.equal(a.scopeIndex, 0);
		assert.equal(a.currentThinkingLevel, "high");
		assert.equal(a.scopeThinkingLevel, "medium");
		assert.equal(a.inScope, true);
		assert.deepEqual(a.supportedThinkingLevels, ["off", "minimal", "low", "medium", "high", "xhigh"]);
		assert.equal(b.available, false);
		assert.equal(b.inScope, false);
		assert.equal(b.currentThinkingLevel, undefined);
		assert.deepEqual(b.supportedThinkingLevels, ["off"]);
		assert.doesNotMatch(JSON.stringify(result), /secret-url|secret-header|baseUrl|Authorization|sourceInfo/);
	});
	it("filters canonical names, provider, display purpose and availability", async () => {
		const { ctx } = context(); const models = readModels(ctx, 1);
		assert.equal(records(await run({ kind: "model", name: "fixture/a" }, host(), models)).length, 1);
		assert.equal(records(await run({ kind: "model", provider: "fixture", available: false }, host(), models))[0].id, "b");
		assert.equal(records(await run({ kind: "model", search: "REASONER a" }, host(), models))[0].id, "a");
		assert.equal((await run({ kind: "model", name: "a" }, host(), models)).outcome, "missing");
	});
	it("keeps unavailable, catalog errors, and selected-outside-catalog evidence distinct", async () => {
		const { ctx } = context();
		ctx.modelRegistry.getAll = () => { throw new Error("secret-catalog"); };
		ctx.modelRegistry.getAvailable = () => { throw new Error("secret-availability"); };
		ctx.modelRegistry.getError = () => "secret-error";
		ctx.modelRegistry.hasConfiguredAuth = () => { throw new Error("secret-auth"); };
		let result = await run({ kind: "model" }, host(), readModels(ctx, 1));
		assert.equal(result.outcome, "unavailable");
		assert.equal(records(result)[0].catalog, false);
		assert.equal(records(result)[0].available, null);
		assert.equal(records(result)[0].configuredAuth, null);
		assert.doesNotMatch(JSON.stringify(result), /secret-/);
		ctx.modelRegistry.getAll = () => [];
		result = await run({ kind: "model", name: "none" }, host(), readModels(ctx, 2));
		assert.equal(result.outcome, "partial");
		assert.equal((await run({ kind: "model", available: true }, host(), readModels(ctx, 2))).outcome, "unavailable");
	});
	it("resumes across read timestamps and rejects model-state changes", async () => {
		const { ctx } = context();
		const first = await run({ kind: "model", limit: 1 }, host(), readModels(ctx, 1));
		const cursor = first.details.cursor as string;
		assert.equal(records(first)[0].at, 1);
		const second = await run({ cursor }, { ...host(), at: 2000 }, readModels(ctx, 2));
		assert.equal(second.outcome, "ok"); assert.equal(records(second)[0].id, "b");
		assert.equal(records(second)[0].at, 2);
		ctx.modelRegistry.getAvailable = () => [];
		assert.equal((await run({ cursor }, host(), readModels(ctx, 3))).outcome, "stale_cursor");
	});
	it("rejects a continuation after scope reorder with identical membership", async () => {
		const { ctx, catalog } = context();
		ctx.scopedModels = [{ model: catalog[0], thinkingLevel: "medium" }, { model: catalog[1] }];
		const models = readModels(ctx, 1);
		const first = await run({ kind: "model", limit: 1 }, host(), models);
		assert.equal(typeof first.details.cursor, "string");
		ctx.scopedModels = [...ctx.scopedModels].reverse();
		const reordered = readModels(ctx, 1);
		assert.deepEqual(reordered.records.map((record) => record.name), models.records.map((record) => record.name));
		assert.deepEqual(reordered.records.map((record) => record.inScope), [true, true]);
		assert.deepEqual(models.records.map((record) => record.scopeIndex), [0, 1]);
		assert.deepEqual(reordered.records.map((record) => record.scopeIndex), [1, 0]);
		const next = await run({ cursor: first.details.cursor as string }, host(), reordered);
		assert.equal(next.outcome, "stale_cursor");
		assert.deepEqual(records(next), []);
	});
	it("hashes scope order even when scoped models have no catalog records", async () => {
		const { ctx } = context();
		ctx.scopedModels = [{ model: model("c") }, { model: model("d") }];
		const models = readModels(ctx, 1);
		const first = await run({ kind: "model", limit: 1 }, host(), models);
		ctx.scopedModels = [...ctx.scopedModels].reverse();
		const reordered = readModels(ctx, 1);
		assert.deepEqual(reordered.records, models.records);
		assert.deepEqual(models.scopeOrder, ["fixture/c", "fixture/d"]);
		assert.deepEqual(reordered.scopeOrder, ["fixture/d", "fixture/c"]);
		assert.equal((await run({ cursor: first.details.cursor as string }, host(), reordered)).outcome, "stale_cursor");
	});
	it("keeps scope positions in the hashed record metadata", async () => {
		const { ctx } = context(); const models = readModels(ctx, 1);
		const first = await run({ kind: "model", limit: 1 }, host(), models);
		models.records[0].scopeIndex = 1;
		assert.equal((await run({ cursor: first.details.cursor as string }, host(), models)).outcome, "stale_cursor");
	});
	it("hashes a null scope order differently from an empty scope order", async () => {
		const { ctx } = context(); ctx.scopedModels = [];
		const models = readModels(ctx, 1);
		assert.equal(models.scopeOrder, null);
		const first = await run({ kind: "model", limit: 1 }, host(), models);
		assert.equal((await run({ cursor: first.details.cursor as string }, host(), models)).outcome, "ok");
		const emptyOrder = { ...models, scopeOrder: [] };
		assert.equal((await run({ cursor: first.details.cursor as string }, host(), emptyOrder)).outcome, "stale_cursor");
	});
	it("invalidates model cursors when extension-provider registration changes", async () => {
		const { ctx } = context();
		const first = await run({ kind: "model", limit: 1 }, host(), readModels(ctx, 1));
		ctx.modelRegistry.getRegisteredProviderIds = () => ["fixture"];
		assert.equal((await run({ cursor: first.details.cursor as string }, host(), readModels(ctx, 1))).outcome, "stale_cursor");
	});
	it("uses the model context through the registered tool, including cursor-only continuation", async () => {
		let tool: ToolDefinition<typeof RegistryParams, Record<string, unknown>> | undefined;
		registerRegistry({ on: () => {}, registerTool: (value: typeof tool) => { tool = value; },
			getAllTools: () => [], getCommands: () => [], getActiveTools: () => [] } as unknown as ExtensionAPI);
		assert.ok(tool);
		const { ctx } = context();
		const first = await tool.execute("one", { kind: "model", limit: 1 }, undefined, undefined, ctx);
		const next = await tool.execute("two", { cursor: first.details?.cursor as string }, undefined, undefined, ctx);
		assert.equal(next.details?.outcome, "ok");
		assert.equal((next.details?.records as Record<string, unknown>[] | undefined)?.[0].id, "b");
	});
});

describe("metadata and tool detail", () => {
	it("searches descriptions without opening files and omits schema from lists", async () => {
		const result = await run({ search: "DOCUMENT" });
		assert.equal(records(result)[0].name, "inspect");
		assert.equal(records(result)[0].parameters, undefined);
		assert.equal(records(result)[0].promptGuidelines, undefined);
		const detail = await run({ kind: "tool", name: "inspect", detail: true });
		assert.deepEqual(records(detail)[0].parameters, host().tools[0].parameters);
		assert.equal(records(detail)[0].active, false);
		assert.deepEqual(records(detail)[0].promptGuidelines, ["Use inspect for documents."]);
		assert.match(detail.text, /data, not instructions/);
	});
	it("discovers a tool from registered usage guidance without exposing its full schema", async () => {
		const snapshot = host();
		snapshot.tools[0].promptGuidelines = ["Use inspect to verify [draft] before release."];
		const result = await run({ kind: "tool", search: "VERIFY [draft]" }, snapshot);
		assert.equal(result.outcome, "ok");
		assert.equal(records(result)[0].name, "inspect");
		assert.equal(records(result)[0].active, false);
		assert.equal(records(result)[0].parameters, undefined);
		assert.equal(records(result)[0].promptGuidelines, undefined);
		assert.match(result.text, /search=VERIFY \[draft\]/);
		const detail = await run({ kind: "tool", name: "inspect", detail: true }, snapshot);
		assert.deepEqual(records(detail)[0].promptGuidelines, snapshot.tools[0].promptGuidelines);
	});
	it("escapes display controls in detail while keeping parsed and structured values exact", async () => {
		const snapshot = host();
		const schema = {
			type: "object",
			properties: { "key\u202e\u009d": { type: "string", const: "const\u009d\u202e", description: "field \u202e \u009d line\u2028next\u2029paragraph" } },
		};
		const guidelines = ["Use inspect \u202e for \u009d documents.\u2028Next line.\u2029Next paragraph."];
		snapshot.tools[0].parameters = schema as unknown as HostSnapshot["tools"][number]["parameters"];
		snapshot.tools[0].promptGuidelines = guidelines;
		const result = await run({ kind: "tool", name: "inspect", detail: true }, snapshot);
		assert.equal(result.outcome, "ok");
		assert.doesNotMatch(result.text, /[\u009d\u2028\u2029\u202e]/);
		const paramsLine = result.text.split("\n").find((line) => line.startsWith("  parameters: "));
		const guidelinesLine = result.text.split("\n").find((line) => line.startsWith("  promptGuidelines: "));
		assert.ok(paramsLine && guidelinesLine, "detail renders schema and guidance lines");
		assert.match(paramsLine, /\\u202e|\\u009d/);
		assert.deepEqual(JSON.parse(paramsLine.slice("  parameters: ".length)), schema);
		assert.deepEqual(JSON.parse(guidelinesLine.slice("  promptGuidelines: ".length)), guidelines);
		const detail = records(result)[0];
		assert.deepEqual(detail.parameters, schema);
		assert.deepEqual(detail.promptGuidelines, guidelines);
	});
	it("keeps metadata search literal and scopes a negative to the searched fields", async () => {
		const snapshot = host();
		snapshot.tools[0].promptGuidelines = ["Use inspect to verify [draft] before release."];
		const result = await run({ kind: "tool", search: "verify.*draft" }, snapshot);
		assert.equal(result.outcome, "missing");
		assert.match(result.text, /No literal match/);
		assert.match(result.text, /does not establish that no resource supports the task/);
		assert.match(result.text, /registered tool usage guidelines/);
		assert.equal((await run({ name: "other", search: "verify" }, snapshot)).outcome, "missing");
	});
	it("scopes kind negatives to resources and to the fields actually searched", async () => {
		for (const [kind, source, name] of [
			["skill", "skill", "skill:example"],
			["command", "extension", "example"],
			["prompt", "prompt", "example"],
		] as const) {
			const snapshot = host();
			snapshot.commands = [{ name, source, description: "Helps verify drafts before release", sourceInfo }];
			const result = await run({ kind, search: "verify.*draft" }, snapshot);
			assert.equal(result.outcome, "missing", kind);
			assert.match(result.text, /No literal match in the searched metadata/);
			assert.match(result.text, /does not establish that no resource supports the task/);
			assert.match(result.text, /Search matches literal text in names and descriptions, not task meaning\./);
			assert.doesNotMatch(result.text, /usage guidelines/);
		}
	});
	it("invalidates a search cursor when the registered usage guidance changes", async () => {
		const snapshot = host();
		snapshot.tools[0].promptGuidelines = ["Use inspect to verify a draft."];
		snapshot.tools.push({ ...snapshot.tools[0], name: "inspect2" });
		const first = await run({ kind: "tool", search: "verify", limit: 1 }, snapshot);
		assert.equal(typeof first.details.cursor, "string");
		snapshot.tools[1].promptGuidelines = ["Use inspect2 to summarize a draft."];
		const next = await run({ cursor: first.details.cursor as string }, snapshot);
		assert.equal(next.outcome, "stale_cursor");
	});
	it("validates detail and model selector combinations after schema validation", () => {
		for (const params of [{ detail: true }, { kind: "tool", name: "x", detail: true, search: "x" },
			{ kind: "tool", name: "x", detail: true, match: "substring" }, { provider: "x" }, { available: false },
			{ kind: "model", contains: "x" }, { kind: "context_file", contains: "x" }, { search: "" }, { detail: "true" }]) {
			assert.throws(() => parseQuery(params as Parameters<typeof parseQuery>[0]));
		}
	});
	it("invalidates metadata and active-state cursors", async () => {
		for (const change of ["description", "parameters", "promptGuidelines", "active"] as const) {
			const snapshot = host(); snapshot.tools.push({ ...snapshot.tools[0], name: "inspect2" });
			const first = await run({ kind: "tool", limit: 1 }, snapshot);
			if (change === "description") snapshot.tools[0].description = "changed";
			if (change === "parameters") snapshot.tools[0].parameters = Type.Object({ changed: Type.Boolean() });
			if (change === "promptGuidelines") snapshot.tools[0].promptGuidelines = ["changed"];
			if (change === "active") snapshot.activeTools = ["inspect"];
			assert.equal((await run({ cursor: first.details.cursor as string }, snapshot)).outcome, "stale_cursor");
		}
	});
	it("bounds an oversized exact schema and preserves incomplete-domain records", async () => {
		const snapshot = host(); snapshot.tools[0].parameters = Type.Object({ large: Type.String({ description: "x".repeat(100000) }) });
		const result = await run({ kind: "tool", name: "inspect", detail: true }, snapshot);
		assert.equal(result.details.pageBlocked, true);
		assert.ok(Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: result.text }], details: result.details })) <= 50 * 1024);
		snapshot.availability.commands = false;
		const partial = await run({ search: "document" }, snapshot);
		assert.equal(partial.outcome, "unavailable"); assert.equal(records(partial)[0].name, "inspect");
	});
	it("labels command/prompt collision and missing-domain limits", async () => {
		const snapshot = host(); snapshot.commands = ["extension", "prompt"].map((source) => ({ name: "same", source: source as "extension" | "prompt", sourceInfo }));
		const result = await run({ name: "same" }, snapshot);
		assert.equal(records(result).length, 2);
		assert.match(result.text, /shadow same-name prompts/);
		const missing = await run({ name: "model" });
		assert.match(missing.text, /Built-in interactive commands/);
		assert.match(missing.text, /Use kind model or context_file/);
	});
});

describe("observed context paths", () => {
	it("returns timestamps and paths, never context content, and invalidates observations", async () => {
		const store = new ObservationStore();
		const options = { cwd: "/fixtures", contextFiles: [{ path: "/fixtures/A.md", content: "secret-context" }, { path: "/fixtures/B.md", content: "secret-context" }] };
		store.observe(options, 1);
		const snapshot = host(); snapshot.observation = store.snapshot();
		const first = await run({ kind: "context_file", limit: 1 }, snapshot);
		assert.equal(records(first)[0].path, "/fixtures/A.md");
		assert.equal(records(first)[0].at, 1);
		assert.equal(records(first)[0].evidence, "observation");
		assert.doesNotMatch(JSON.stringify(first), /secret-context|sourceInfo/);
		assert.equal((await run({ cursor: first.details.cursor as string }, snapshot)).outcome, "ok");
		store.observe(options, 2); snapshot.observation = store.snapshot();
		assert.equal((await run({ cursor: first.details.cursor as string }, snapshot)).outcome, "stale_cursor");
	});
	it("never treats absent or overflowed observation as established absence", async () => {
		const absent = await run({ kind: "context_file" });
		assert.equal(absent.outcome, "unavailable"); assert.match(absent.text, /not_yet_observed/);
		const store = new ObservationStore(); store.observe({ cwd: "/fixtures" }, 1);
		const snapshot = host(); snapshot.observation = store.snapshot();
		assert.equal((await run({ kind: "context_file" }, snapshot)).outcome, "missing");
		assert.ok(snapshot.observation); snapshot.observation.overflowBytes = true;
		assert.equal((await run({ kind: "context_file" }, snapshot)).outcome, "partial");
	});
});
