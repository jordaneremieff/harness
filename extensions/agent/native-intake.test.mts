import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { it } from "node:test";
import * as Durable from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { normalizeContext, type Model } from "@earendil-works/pi-ai";
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { createAgentContribution, type AgentControlDispatch } from "./durable-agents.ts";
import { matchesSchema } from "./schema-check.ts";
import { InspectToolOutputSchema, StatusToolOutputSchema } from "./observation-schema.ts";
import { AgentManager } from "./manager.ts";
import { hostMetadata } from "./catalog.ts";
import { DurableHost } from "./durable-host.ts";
import { fixtureRuntime, fixtureRegistry, hostOptions } from "./durable-host-fixture.mts";
import { runHost, type HostProcess } from "./host-process.ts";
import { hostPaths } from "./host-protocol.ts";
import { projectStorageStatus, STATUS_OVERVIEW_BYTE_LIMIT } from "./status-overview.ts";
import { storageStatusPageInput, type StorageStatusPageInput } from "./storage-status.ts";

function tools(dispatch: AgentControlDispatch) {
	const extension = createAgentContribution({ source: import.meta.filename, configureSettings() {}, dispatch }).create({
		durable: Durable, storageId: "producer", cwd: "/work", agentDir: "/config", onClose() {},
		services: { modelRuntime: { getModel: () => undefined } },
	});
	const registry = Durable.createRegistry();
	registry.install(extension);
	return extension.tools ?? [];
}
function tool(dispatch: AgentControlDispatch, name: string) {
	const selected = tools(dispatch).find((entry) => entry.name === name);
	assert.ok(selected);
	return selected;
}
const api = { conversationId: 2, taskId: 7 } as unknown as Durable.ToolExecutionApi;
function text(output: Durable.ToolExecutionResult): string {
	return output.output?.flatMap((part) => part.type === "text" ? [part.text] : []).join("") ?? "";
}

it("forwards native receipt continuation unchanged and renders readable result text", async () => {
	const next = { tool: "agent_inspect", view: "result", sessionId: "source:3", submissionId: 5, requestId: "work", receiptCursor: "opaque" };
	const result = { view: "result", sessionId: "source:3", conversationId: 3, submissionId: 5, requestId: "work", status: "done", answerEntryId: 11, answer: "Readable\nanswer", offset: 0, nextOffset: null, truncated: false,
		usage: { models: {}, tools: {} },
		receiptGroup: { recipient: "producer:2", results: [{ sessionId: "source:3", submissionId: 5, requestId: "work" }], complete: false, next } };
	const seen: Readonly<Record<string, unknown>>[] = [];
	const inspect = tool(async (method, params) => { assert.equal(method, "inspect"); seen.push(params); return result; }, "agent_inspect");
	const { tool: _tool, ...call } = next;
	assert.equal(matchesSchema(inspect.parameters, call), true);
	const output = await inspect.execute(call, api, BACKGROUND_CONTEXT);
	assert.notEqual(output.isError, true, text(output));
	assert.deepEqual(seen, [call]);
	assert.equal(matchesSchema(InspectToolOutputSchema, output.structuredOutput), true);
	assert.deepEqual(output.structuredOutput, result);
	assert.ok(text(output).startsWith("Readable\nanswer\n\nResult:"));
	assert.match(text(output), /Receipt continuation: agent_inspect\(/u);
	const refused = await inspect.execute({ ...call, view: "history" }, api, BACKGROUND_CONTEXT);
	assert.equal(refused.isError, true);
	assert.equal(seen.length, 1);
	assert.equal(matchesSchema(inspect.parameters, { ...call, receiptCursor: "x".repeat(2049) }), false);
});

it("projects native selected status by default and preserves full detail", async () => {
	const source = { storageId: "producer", pid: 123, inventory: { contributions: [], ordinaryOnly: [] },
		conversation: { conversationId: 3, identity: "producer:3", busy: false, lastText: null, live: null, inbox: null,
			agent: { thinkingLevel: "off", extensions: [], tools: [] }, tasks: [], submissions: [] } };
	const seen: Readonly<Record<string, unknown>>[] = [];
	const status = tool(async (method, params) => { assert.equal(method, "status"); seen.push(params); return source; }, "agent_status");
	const compact = await status.execute({ sessionId: "producer:3" }, api, BACKGROUND_CONTEXT);
	assert.notEqual(compact.isError, true, text(compact));
	assert.equal(matchesSchema(StatusToolOutputSchema, compact.structuredOutput), true);
	assert.equal((compact.structuredOutput as { format: string }).format, "compact");
	assert.ok(compact.details !== null && typeof compact.details === "object");
	assert.equal(Object.hasOwn(compact.details, "inventory"), false);
	const detail = await status.execute({ sessionId: "producer:3", detail: true }, api, BACKGROUND_CONTEXT);
	assert.deepEqual(detail.structuredOutput, source);
	const refused = await status.execute({ detail: true }, api, BACKGROUND_CONTEXT);
	assert.equal(refused.isError, true);
	assert.equal(seen.length, 2);
});

it("omits creation and awareness reads from the native compact storage overview", async () => {
	const source = { storageId: "producer", conversations: [], coverage: { complete: true, returned: 0, scanned: 0, next: null }, inventory: { contributions: [], ordinaryOnly: [] }, pid: 123 };
	const status = tool(async (method, params) => { assert.equal(method, "status"); assert.deepEqual(params, {}); return source; }, "agent_status");
	const output = await status.execute({}, api, BACKGROUND_CONTEXT);
	assert.notEqual(output.isError, true, text(output));
	assert.equal(matchesSchema(StatusToolOutputSchema, output.structuredOutput), true);
	const result = output.structuredOutput as { format: string; omitted: string[] };
	assert.equal(result.format, "compact");
	assert.deepEqual(result.omitted, ["host inventory", "effort awareness", "created-agent detail"]);
});

type StoragePage = { format: "compact"; conversations: { identity: string }[]; coverage: { complete: boolean; returned: number; scanned: number; next: null | { tool: "agent_status" } & StorageStatusPageInput } };
function publicPage(output: Durable.ToolExecutionResult, coverage: unknown): StoragePage {
	assert.notEqual(output.isError, true, text(output));
	assert.equal(matchesSchema(StatusToolOutputSchema, output.structuredOutput), true);
	const page = output.structuredOutput as StoragePage;
	assert.equal(page.format, "compact", text(output));
	assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") <= STATUS_OVERVIEW_BYTE_LIMIT);
	assert.ok(Buffer.byteLength(text(output), "utf8") <= STATUS_OVERVIEW_BYTE_LIMIT);
	assert.deepEqual(JSON.parse(text(output)), page);
	assert.deepEqual(page.coverage, coverage, "the accepted source page owns its exact counts and next call");
	assert.equal(page.coverage.returned, page.conversations.length);
	return page;
}

for (const route of ["connected", "cold"] as const) it(`fits native public status pages without losing any ${route} storage identity`, { timeout: 60000 }, async (t) => {
	const parent = realpathSync(tmpdir());
	const root = realpathSync(mkdtempSync(join(Buffer.byteLength(parent) <= 28 ? parent : realpathSync("/tmp"), "ni-")));
	const manager = new AgentManager({ root, agentDir: root, packageDir: root, acquire: async () => { throw new Error("Status must not launch a writer"); } });
	let owner: HostProcess | undefined;
	let source: DurableHost | undefined;
	t.after(async () => { await manager.close(); await owner?.close(); await source?.close(); rmSync(root, { recursive: true, force: true }); });
	const record = manager.catalog.create({ cwd: root, agentDir: root, packageDir: root, model: { provider: "fixture", modelId: "fixture" }, thinkingLevel: "off" });
	const metadata = hostMetadata(record, root);
	assert.ok(hostPaths(metadata).socket.startsWith(`${root}${sep}`), "the synthetic source socket stays private");
	owner = await runHost(async () => {
		const opened = await DurableHost.open({ ...hostOptions(record.storagePath, await fixtureRuntime("answer"), fixtureRegistry(), root), storageId: record.storageId });
		source = opened;
		const agent = { instructions: "Full retained instructions. ".repeat(100) };
		await opened.harness.root(BACKGROUND_CONTEXT, { agent });
		for (let index = 0; index < 50; index++) await opened.harness.createConversation({ ownership: { kind: "ownerless" }, agent }, BACKGROUND_CONTEXT);
		return { request: async (method, params, _requestId, signal) => {
			const result = await opened.request(method, params as Parameters<DurableHost["request"]>[1], signal ?? BACKGROUND_CONTEXT);
			return method === "status" ? { ...result as Record<string, unknown>, storageId: record.storageId, inventory: { contributions: [], ordinaryOnly: [] }, pid: process.pid } : result;
		}, close: () => opened.close(), isIdle: () => false };
	}, { metadata, idleMs: 0, announceReady() {} });
	if (route === "cold") await owner.close();
	const observations: { input: StorageStatusPageInput; value: unknown }[] = [];
	const status = tool(async (method, params) => {
		assert.equal(method, "status");
		const input = storageStatusPageInput(params), value = await manager.status(input);
		observations.push({ input, value });
		return value;
	}, "agent_status");
	let input: StorageStatusPageInput = { view: "storage-page", storageId: record.storageId };
	const identities: string[] = [];
	for (let pages = 0; pages < 51; pages++) {
		const before = observations.length;
		const output = await status.execute(input, api, BACKGROUND_CONTEXT);
		const accepted = observations.at(-1)?.value as { coverage: unknown };
		const page = publicPage(output, accepted.coverage);
		assert.ok(observations.length - before <= 7);
		for (const observation of observations.slice(before)) assert.deepEqual(observation.input.cursor, input.cursor, "every reduced scan starts at the incoming cursor");
		identities.push(...page.conversations.map((conversation) => conversation.identity));
		if (page.coverage.next === null) { assert.equal(page.coverage.complete, true); break; }
		const { tool: nextTool, ...next } = page.coverage.next;
		assert.equal(nextTool, "agent_status"); input = next;
	}
	assert.equal(identities.length, 51);
	assert.equal(new Set(identities).size, 51);
	assert.deepEqual(observations.slice(0, 2).map((item) => item.input.limit), [50, 25], "the initial full source page exceeds the compact byte bound");
});

function statusSource(identity: string) {
	return { storageId: "10000000-0000-4000-8000-000000000001", pid: 123, inventory: { contributions: [], ordinaryOnly: [] }, coverage: { complete: true, returned: 1, scanned: 1, next: null },
		conversations: [{ conversationId: 1, identity, busy: false, lastText: null, live: null, inbox: null, agent: { thinkingLevel: "off", extensions: [], tools: [] }, tasks: [], submissions: [] }] };
}
for (const limit of [undefined, 1]) it(`returns the exact native one-row byte refusal with requested limit=${limit}`, async () => {
	const source = statusSource("x".repeat(20000));
	const requests: Readonly<Record<string, unknown>>[] = [];
	const status = tool(async (_method, params) => { requests.push(params); return source; }, "agent_status");
	const cursor = { position: 7 };
	const output = await status.execute({ view: "storage-page", storageId: source.storageId, cursor, ...(limit === undefined ? {} : { limit }) }, api, BACKGROUND_CONTEXT);
	assert.notEqual(output.isError, true, text(output));
	assert.deepEqual(output.structuredOutput, projectStorageStatus(source));
	assert.deepEqual(requests.map((request) => request.limit), limit === 1 ? [1] : [50, 25, 13, 7, 4, 2, 1]);
	for (const request of requests) assert.deepEqual(request.cursor, cursor);
	assert.ok(Buffer.byteLength(text(output), "utf8") <= STATUS_OVERVIEW_BYTE_LIMIT);
});
for (const failure of ["source", "transport"] as const) it(`does not retry a native storage ${failure} failure`, async () => {
	let calls = 0;
	const source = statusSource("");
	const status = tool(async () => { calls++; if (failure === "transport") throw new Error("byte-limit refusal text is not a typed projection"); return source; }, "agent_status");
	const output = await status.execute({ view: "storage-page", storageId: source.storageId }, api, BACKGROUND_CONTEXT);
	assert.equal(calls, 1);
	if (failure === "source") assert.deepEqual(output.structuredOutput, projectStorageStatus(source));
	else assert.equal(output.isError, true);
});

it("preserves native changed parameter fields through the public Anthropic serializer", async () => {
	const selected = tools(async () => undefined).filter((entry) => ["agent_send", "agent_inspect", "agent_status"].includes(entry.name));
	const model: Model<"anthropic-messages"> = { id: "fixture", name: "fixture", api: "anthropic-messages", provider: "anthropic", baseUrl: "https://unused.invalid", input: ["text"], reasoning: false, contextWindow: 10000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	let payload: { tools: Array<{ name: string; input_schema: { type: string; properties: Record<string, unknown> } }> } | undefined;
	let calls = 0;
	const stream = anthropicStream(model, normalizeContext({ messages: [{ role: "user", content: "Schema fixture", timestamp: 0 }], tools: selected.map(({ name, description, parameters }) => ({ name, description, parameters })) }), {
		apiKey: "fixture-not-a-credential", maxRetries: 0,
		fetch: async (_input, init) => { calls++; payload = JSON.parse(String(init?.body)); return Response.json({ type: "error", error: { type: "invalid_request_error", message: "Intercepted schema fixture" } }, { status: 400 }); },
	});
	await stream.result(); assert.equal(calls, 1); assert.ok(payload);
	for (const registered of selected) {
		const schema: { type: string; properties: Record<string, unknown> } | undefined = payload.tools.find((entry) => entry.name === registered.name)?.input_schema;
		assert.ok(schema); assert.equal(schema.type, "object");
		assert.deepEqual(schema.properties, (registered.parameters as { properties: Record<string, unknown> }).properties);
	}
});

it("keeps native reports active by default and strips successful sender body echoes", async () => {
	const seen: Readonly<Record<string, unknown>>[] = [];
	const send = tool(async (method, params) => { assert.equal(method, "report"); seen.push(params); return { sourceId: "source", requestId: params.requestId, ownerId: params.sessionId, senderIdentity: params.senderIdentity, acknowledged: false, passive: params.passive === true, message: "RECIPIENT-BODY" }; }, "agent_send");
	assert.match(send.description, /Reports request attention by default/u);
	assert.match(send.description, /mode:'report',passive:true/u);
	for (const passive of [undefined, true, false]) {
		const output = await send.execute({ sessionId: "recipient", message: "RECIPIENT-BODY", mode: "report", ...(passive === undefined ? {} : { passive }) }, api, BACKGROUND_CONTEXT);
		assert.notEqual(output.isError, true, text(output));
		assert.doesNotMatch(JSON.stringify(output), /RECIPIENT-BODY/u);
		assert.equal(seen.at(-1)?.passive, passive);
		assert.equal(seen.at(-1)?.message, "RECIPIENT-BODY");
	}
	for (const mode of [undefined, "steer", "followUp"]) {
		const output = await send.execute({ sessionId: "recipient", message: "No action", passive: true, ...(mode === undefined ? {} : { mode }) }, api, BACKGROUND_CONTEXT);
		assert.equal(output.isError, true);
	}
	assert.equal(seen.length, 3);
});
