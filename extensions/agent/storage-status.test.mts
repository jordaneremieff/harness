import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { normalizeContext, type Model } from "@earendil-works/pi-ai";
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import * as Durable from "@earendil-works/pi-durable";
import { SessionManager, type ExtensionAPI, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import register from "./index.ts";
import { AgentManager } from "./manager.ts";
import { hostMetadata } from "./catalog.ts";
import { DurableHost } from "./durable-host.ts";
import { fixtureRuntime, fixtureRegistry, hostOptions } from "./durable-host-fixture.mts";
import { createAgentContribution } from "./durable-agents.ts";
import { runHost, type HostProcess } from "./host-process.ts";
import { HOST_CONTRACT } from "./version-contract.ts";
import { hostPaths } from "./host-protocol.ts";
import { StatusToolInputSchema, StatusToolOutputSchema, StorageStatusCoverageSchema, StorageStatusPageInputSchema, structuredObservation } from "./observation-schema.ts";
import { matchesSchema } from "./schema-check.ts";
import { storageStatusCoverage, storageStatusPageInput, validateStatusSelectors, type StorageStatusPageInput } from "./storage-status.ts";

const context = BACKGROUND_CONTEXT;
type Page = { conversations: Array<{ identity: string }>; coverage: { complete: boolean; scanned: number; returned: number; next: ({ tool: "agent_status" } & StorageStatusPageInput) | null } };
function page(value: unknown): Page {
	structuredObservation(StatusToolOutputSchema, value);
	assert.ok(value && typeof value === "object" && "conversations" in value);
	return value as Page;
}

it("storage page selectors are closed and keep backend JSON cursors unchanged", () => {
	const storageId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
	const cursor = { order: "ascending", nested: [1, { key: true }] };
	const valid = { view: "storage-page", storageId, cursor, limit: 1 };
	assert.equal(matchesSchema(StorageStatusPageInputSchema, valid), true);
	assert.equal(storageStatusPageInput(valid).cursor, cursor);
	for (const invalid of [{ ...valid, cursor: "global-discovery-cursor" }, { ...valid, cursor: [] }, { ...valid, cursor: null }, { ...valid, limit: 0 }, { ...valid, limit: 51 }, { ...valid, limit: 1.5 }, { ...valid, sessionId: storageId }, { ...valid, provider: "fixture" }, { ...valid, storageId: `${storageId}:2` }]) {
		assert.equal(matchesSchema(StorageStatusPageInputSchema, invalid), false);
		assert.throws(() => storageStatusPageInput(invalid));
		assert.throws(() => validateStatusSelectors(invalid));
	}
	for (const invalid of [{ storageId }, { cursor }, { limit: 1 }, { view: "fleet", sessionId: storageId }]) assert.throws(() => validateStatusSelectors(invalid));
	for (const [input, key] of [[{ limit: 20 }, "limit"], [{ view: "fleet", limit: 20 }, "limit"], [{ storageId }, "storageId"], [{ sessionId: storageId, cursor }, "cursor"]] as const) {
		assert.throws(() => validateStatusSelectors(input), { message: `${key} requires view: storage-page with an exact storageId. Omit ${key} for every other view: each returns one bounded result with no page selector.` });
	}
	const declared = StatusToolInputSchema.properties as Record<string, { description?: string }>;
	for (const key of ["storageId", "cursor", "limit"]) assert.match(declared[key]?.description ?? "", /Only with view: storage-page\./u);
	const coverage = storageStatusCoverage(storageId, 1, 1, 0, cursor);
	assert.equal(matchesSchema(StorageStatusCoverageSchema, coverage), true);
	assert.equal(coverage.complete, false);
	assert.equal(coverage.returned, 0);
	assert.equal(coverage.next?.cursor, cursor);
});

for (const route of ["connected", "cold"] as const) it(`ordinary and native status registrations preserve ${route} storage cursor coverage`, { timeout: 60000 }, async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "storage-status-")));
	const saved = new Map(["PI_AGENT_SESSIONS_DIR", "PI_AGENT_DIR", "PI_HARNESS_FILE"].map((key) => [key, process.env[key]]));
	process.env.PI_AGENT_SESSIONS_DIR = root;
	process.env.PI_AGENT_DIR = root;
	process.env.PI_HARNESS_FILE = join(root, "harness.json");
	writeFileSync(join(root, "harness.json"), "{}");
	const manager = new AgentManager({ root, agentDir: root, packageDir: root, acquire: async () => { throw new Error("Observation must not launch a writer"); } });
	const owners = (globalThis as unknown as Record<symbol, { managers: Map<string, AgentManager> }>)[Symbol.for("pi.extension.agent.owners")];
	owners.managers.set(root, manager);
	let nativeOwner: HostProcess | undefined;
	let source: DurableHost | undefined;
	let caller: Durable.Harness | undefined;
	const expectedIdentities = new Set<string>();
	t.after(async () => {
		await caller?.close(context);
		await manager.close();
		await nativeOwner?.close();
		await source?.close();
		owners.managers.delete(root);
		for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		rmSync(root, { recursive: true, force: true });
	});
	const record = manager.catalog.create({ cwd: root, agentDir: root, packageDir: root, model: { provider: "fixture", modelId: "fixture" }, thinkingLevel: "off" });
	const metadata = hostMetadata(record, root);
	t.diagnostic(`Native status socket: ${hostPaths(metadata).socket}`);
	nativeOwner = await runHost(async () => {
		const opened = await DurableHost.open({ ...hostOptions(record.storagePath, await fixtureRuntime("answer"), fixtureRegistry(), root), storageId: record.storageId });
		source = opened;
		const rootConversation = await opened.harness.root(context);
		expectedIdentities.add(opened.identity(rootConversation.id));
		for (let index = 0; index < 50; index++) {
			const conversation = await opened.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
			expectedIdentities.add(opened.identity(conversation.id));
		}
		return { request: async (method, params, _requestId, signal) => {
			const result = await opened.request(method, params as Parameters<DurableHost["request"]>[1], signal ?? context);
			return method === "status" ? { ...(result as Record<string, unknown>), inventory: { contributions: [], ordinaryOnly: [] }, pid: process.pid, storageId: record.storageId } : result;
		}, close: () => opened.close(), isIdle: () => false };
	}, { metadata, idleMs: 0, announceReady: () => {} });
	if (route === "cold") await nativeOwner.close();

	const ordinaryTools = new Map<string, ToolDefinition>();
	await register({ events: { emit() {}, on: () => () => {} }, on() {}, registerTool: (tool: ToolDefinition) => ordinaryTools.set(tool.name, tool), registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, registerToolRenderer() {}, getThinkingLevel: () => "off" } as unknown as ExtensionAPI);
	const ordinary = ordinaryTools.get("agent_status");
	assert.ok(ordinary);
	assert.ok("type" in ordinary.parameters);
	assert.equal(ordinary.parameters.type, "object");
	await assertProviderStatusParameters(ordinary.parameters);
	const list = ordinaryTools.get("agent_list");
	assert.ok(list);
	assert.equal(matchesSchema(list.parameters, { cursor: { order: "ascending" } }), false);
	assert.equal(matchesSchema(list.parameters, { cursor: "discovery-cursor" }), true);
	const toolContext = { cwd: root, sessionManager: SessionManager.create(root, join(root, "sessions")) } as unknown as ExtensionToolContext;
	const scans: Array<{ input: StorageStatusPageInput; coverage: unknown }> = [];
	const status = manager.status.bind(manager);
	t.mock.method(manager, "status", async (...args: Parameters<AgentManager["status"]>) => {
		const result = await status(...args);
		if (typeof args[0] === "object") scans.push({ input: args[0], coverage: (result as { coverage?: unknown }).coverage });
		return result;
	});
	const ordinaryRead = async (input: StorageStatusPageInput) => {
		assert.equal(matchesSchema(ordinary.parameters, input), true);
		const before = scans.length;
		const result = await ordinary.execute("storage-status", input, new AbortController().signal, undefined, toolContext);
		const text = result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
		assert.ok(Buffer.byteLength(text, "utf8") <= 16_384);
		assert.ok(Buffer.byteLength(JSON.stringify(result.structuredContent), "utf8") <= 16_384);
		assert.deepEqual(JSON.parse(text), result.structuredContent);
		assert.deepEqual(result.structuredContent, result.details);
		assert.equal((result.structuredContent as { format: string }).format, "compact");
		const returned = page(result.structuredContent), attempts = scans.slice(before);
		assert.ok(attempts.length >= 1 && attempts.length <= 7);
		assert.equal(attempts[0].input.limit, input.limit ?? 50);
		for (const [index, scan] of attempts.entries()) {
			assert.equal(scan.input.cursor, input.cursor);
			if (index > 0) assert.equal(scan.input.limit, Math.ceil(Number(attempts[index - 1].input.limit) / 2));
		}
		assert.deepEqual(returned.coverage, attempts.at(-1)?.coverage);
		return returned;
	};
	const first = await ordinaryRead({ view: "storage-page", storageId: record.storageId });
	assert.equal(first.coverage.complete, false);
	assert.ok(first.coverage.next);
	const { tool: nextTool, ...nextInput } = first.coverage.next;
	assert.equal(nextTool, "agent_status");
	const ordinaryPages = [first];
	for (let index = 1; index < 51 && ordinaryPages.at(-1)?.coverage.next; index++) {
		const next = ordinaryPages.at(-1)?.coverage.next; assert.ok(next);
		const { tool, ...input } = next;
		assert.equal(tool, "agent_status"); ordinaryPages.push(await ordinaryRead(input));
	}
	assert.equal(ordinaryPages.at(-1)?.coverage.next, null);
	const ordinaryIdentities = ordinaryPages.flatMap((result) => result.conversations.map((item) => item.identity));
	assert.equal(ordinaryIdentities.length, 51);
	assert.deepEqual(new Set(ordinaryIdentities), expectedIdentities);
	await assert.rejects(ordinaryRead({ view: "storage-page", storageId: record.storageId, cursor: { invalid: true } }));
	await assert.rejects(ordinary.execute("mixed-status", { view: "storage-page", storageId: record.storageId, sessionId: record.storageId }, new AbortController().signal, undefined, toolContext), /does not accept sessionId/u);

	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const pending: Durable.JsonObject[] = [];
	let nativeMixedError = false;
	let nativeScans = 0;
	faux.setResponses(Array.from({ length: 2 * 51 + 4 }, () => () => {
		const input = pending.shift();
		return input === undefined ? fauxAssistantMessage("done") : fauxAssistantMessage([fauxToolCall("agent_status", input)], { stopReason: "toolUse" });
	}));
	const nativePages: Page[] = [];
	const contribution = createAgentContribution({ source: new URL("./index.ts", import.meta.url).pathname, configureSettings() {}, dispatch: async (method, params) => {
		assert.equal(method, "status");
		nativeScans++;
		return manager.status(storageStatusPageInput(params));
	} });
	const extension = contribution.create({ durable: Durable, storageId: "11111111-2222-3333-4444-555555555555", cwd: root, agentDir: root, services: { modelRuntime: models }, onClose() {} });
	const registry = Durable.createRegistry();
	registry.install({ ...extension, tools: extension.tools?.map((tool) => tool.name !== "agent_status" ? tool : { ...tool, execute: async (args, api, ctx) => {
		const result = await tool.execute(args, api, ctx);
		if (result.isError) nativeMixedError = true;
		else {
			const output = result as { structuredOutput: unknown; output: Array<{ type: string; text?: string }> };
			const text = output.output.flatMap(part => part.type === "text" ? [part.text ?? ""] : []).join("");
			assert.ok(Buffer.byteLength(text, "utf8") <= 16_384);
			assert.ok(Buffer.byteLength(JSON.stringify(output.structuredOutput), "utf8") <= 16_384);
			assert.deepEqual(JSON.parse(text), output.structuredOutput);
			nativePages.push(page(output.structuredOutput));
		}
		return result;
	} }) });
	const nativeTool = extension.tools?.find((tool) => tool.name === "agent_status");
	assert.ok(nativeTool);
	assert.equal(matchesSchema(nativeTool.parameters, nextInput), true);
	assert.ok("type" in nativeTool.parameters);
	assert.equal(nativeTool.parameters.type, "object");
	assert.deepEqual(nativeTool.parameters, ordinary.parameters);
	await assertProviderStatusParameters(nativeTool.parameters);
	const nativeList = extension.tools?.find((tool) => tool.name === "agent_list");
	assert.ok(nativeList);
	assert.equal(matchesSchema(nativeList.parameters, { cursor: { order: "ascending" } }), false);
	const deferred = registry.snapshot().installed().flatMap((entry) => (entry.tools ?? []).filter((tool) => tool.deferred));
	caller = await Durable.Harness.open(new Durable.MemoryStorage(), { models, registry }, context);
	caller.resume();
	const conversation = await caller.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, modelTools: { add: deferred } } });
	pending.push({ view: "storage-page", storageId: record.storageId });
	await (await conversation.submit({ type: "input", content: "Read storage status." }, context)).wait(context);
	assert.equal(nativeMixedError, false);
	assert.equal(nativePages.length, 1);
	assert.ok(nativePages[0].coverage.next);
	for (let index = 1; index < 51 && nativePages.at(-1)?.coverage.next; index++) {
		const next = nativePages.at(-1)?.coverage.next; assert.ok(next);
		const { tool: nativeNext, ...nativeInput } = next;
		assert.equal(nativeNext, "agent_status");
		pending.push(JSON.parse(JSON.stringify(nativeInput)) as Durable.JsonObject);
		await (await conversation.submit({ type: "input", content: "Read the next storage status page." }, context)).wait(context);
	}
	assert.equal(nativePages.at(-1)?.coverage.complete, true);
	assert.equal(nativePages.at(-1)?.coverage.next, null);
	const nativeIdentities = nativePages.flatMap((result) => result.conversations.map((item) => item.identity));
	assert.equal(nativeIdentities.length, 51);
	assert.deepEqual(new Set(nativeIdentities), expectedIdentities);
	const returnedNativePages = nativePages.length;
	const scansBeforeMixed = nativeScans;
	pending.push({ view: "storage-page", storageId: record.storageId, sessionId: record.storageId });
	await (await conversation.submit({ type: "input", content: "Reject mixed status selectors." }, context)).wait(context);
	assert.equal(nativeMixedError, true);
	assert.equal(nativePages.length, returnedNativePages, "mixed selectors produce no successful status page");
	assert.equal(nativeScans, scansBeforeMixed, "mixed selectors never reach native dispatch");
	assert.equal(HOST_CONTRACT.operations.status.request, "status/1.1.0");
});

/** The public adapter serialises to an intercepted fetch; no provider receives this request. */
async function assertProviderStatusParameters(parameters: object): Promise<void> {
	const model: Model<"anthropic-messages"> = { id: "fixture", name: "fixture", api: "anthropic-messages", provider: "anthropic", baseUrl: "https://unused.invalid", input: ["text"], reasoning: false, contextWindow: 10000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	let payload: { tools: Array<{ input_schema: { type: string; properties: Record<string, unknown> } }> } | undefined;
	let calls = 0;
	const stream = anthropicStream(model, normalizeContext({ messages: [{ role: "user", content: "Schema fixture", timestamp: 0 }], tools: [{ name: "agent_status", description: "Read status", parameters }] }), {
		apiKey: "fixture-not-a-credential", maxRetries: 0,
		fetch: async (_input, init) => {
			calls++;
			payload = JSON.parse(String(init?.body));
			return Response.json({ type: "error", error: { type: "invalid_request_error", message: "Intercepted schema fixture" } }, { status: 400 });
		},
	});
	await stream.result();
	assert.equal(calls, 1);
	assert.ok(payload);
	const schema = payload.tools[0].input_schema;
	assert.equal(schema.type, "object");
	assert.deepEqual(Object.keys(schema.properties).sort(), ["cursor", "detail", "limit", "model", "provider", "sessionId", "storageId", "view"]);
	const { description: cursorDescription, ...cursor } = schema.properties.cursor as Record<string, unknown>;
	assert.deepEqual(cursor, { type: "object", additionalProperties: {} });
	assert.equal(typeof cursorDescription, "string");
	const view = schema.properties.view as Record<string, unknown>;
	assert.ok(typeof view.description === "string");
	assert.match(view.description, /sampled machine-local model evidence/u);
	assert.match(view.description, /not provider health/u);
	assert.match(view.description, /storage-page/u);
}
