import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, type AgentHarness } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { AgentStore, corePublicImportUrl } from "./store.ts";
const { value, deleteValue } = await import(corePublicImportUrl("./harness/session")) as typeof import("@earendil-works/pi-agent-core/harness/session");
import { AgentWorkerSession } from "./worker.ts";
import { createTestRuntime, testModel } from "./test-runtime.mts";

const [root, mode] = process.argv.slice(2);
const runtime = await createTestRuntime();
const seen: Array<{ prompt: string; tools: string[] }> = [];
const stream = (_model: unknown, context: TranscriptContext) => {
	seen.push({ prompt: getCurrentSystemPrompt(context.messages), tools: getCurrentTools(context.messages).map(tool => tool.name) });
	const response: AssistantMessage = { role: "assistant", content: mode === "start" ? [] : [{ type: "text", text: "Recovered" }], api: testModel.api, provider: testModel.provider, model: testModel.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: mode === "start" ? "error" : "stop", ...(mode === "start" ? { errorMessage: "429 rate limit exceeded" } : {}), timestamp: Date.now() };
	const events = createAssistantMessageEventStream();
	events.push({ type: "start", partial: response });
	if (mode === "start") events.push({ type: "error", reason: "error", error: response });
	else events.push({ type: "done", reason: "stop", message: response });
	events.end(response);
	return events;
};
runtime.registerNativeProvider({ id: testModel.provider, name: "Recovery", getModels: () => [testModel], auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } }, stream, streamSimple: stream });
const store = new AgentStore({ sessionsRoot: join(root, "sessions") });
const options = { cwd: join(root, "work"), agentDir: join(root, "agent"), extensionPaths: [join(root, "extension.ts")], store, modelRuntime: runtime, rootContext: BACKGROUND_CONTEXT };
if (mode === "missing") {
	const session = await store.open((await store.list(BACKGROUND_CONTEXT))[0], BACKGROUND_CONTEXT);
	await session.mutate(async (mutator, context) => { await mutator.commit([deleteValue(value("agent.run", "prompt"))], context); }, BACKGROUND_CONTEXT);
	await session.close(BACKGROUND_CONTEXT);
}
const worker = mode === "start"
	? await AgentWorkerSession.create({ ...options, model: { provider: testModel.provider, modelId: testModel.id } })
	: await AgentWorkerSession.open((await store.list(BACKGROUND_CONTEXT))[0], options);
if (mode === "start") {
	const harness = (worker as unknown as { harness: AgentHarness }).harness;
	await harness.setRetryPolicy({ enabled: true, maxRetries: 2, baseDelayMs: 20, maxAgentDelayMs: 20 }, BACKGROUND_CONTEXT);
	const lane = await harness.lane("main", BACKGROUND_CONTEXT);
	const admitted = await lane.accept({ kind: "prompt", prompt: "Preserve the current hook state" }, BACKGROUND_CONTEXT);
	assert.ok(admitted.ok);
	const driven = await lane.drive({ operationId: admitted.value.operationId, waitForRetry: false }, BACKGROUND_CONTEXT);
	assert.ok(driven.ok && driven.value.kind === "waiting" && driven.value.reason === "retry", JSON.stringify(driven));
	writeFileSync(join(root, "operation.json"), JSON.stringify({ operationId: admitted.value.operationId }));
	// The process relinquishes storage without asking the durable operation to abort.
	await store.close(BACKGROUND_CONTEXT);
} else {
	if (mode === "missing") {
		await assert.rejects(worker.resume(), /no recorded prompt state/u);
		assert.equal(seen.length, 0);
	} else {
		assert.equal(await worker.resume(), true);
		const { operationId } = JSON.parse(readFileSync(join(root, "operation.json"), "utf8"));
		const result = await worker.operationResult(operationId);
		assert.equal(result?.status, "completed");
	}
	await worker.close();
	await store.close(BACKGROUND_CONTEXT);
}
process.stdout.write(JSON.stringify(seen));
