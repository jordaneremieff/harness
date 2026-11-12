import assert from "node:assert/strict";
import { it } from "node:test";
import * as Durable from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { normalizeContext, type Model } from "@earendil-works/pi-ai";
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { createAgentContribution, type AgentControlDispatch } from "./durable-agents.ts";
import { matchesSchema } from "./schema-check.ts";
import { InspectToolOutputSchema, StatusToolOutputSchema } from "./observation-schema.ts";

function tools(dispatch: AgentControlDispatch) {
	return createAgentContribution({ source: import.meta.filename, configureSettings() {}, dispatch }).create({
		durable: Durable, storageId: "producer", cwd: "/work", agentDir: "/config", onClose() {},
		services: { modelRuntime: { getModel: () => undefined } },
	}).tools ?? [];
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
