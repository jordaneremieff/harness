import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { AgentStore } from "./store.ts";
import { AgentWorkerSession, type WorkerCreateOptions } from "./worker.ts";
import { createTestRuntime, testModel } from "./test-runtime.mts";

export async function fixture(extension = "export default function() {}", extra: Partial<WorkerCreateOptions> = {}, settings = {}) {
	const root = mkdtempSync(join(tmpdir(), "agent-native-"));
	const cwd = join(root, "work"); const agentDir = join(root, "agent");
	mkdirSync(cwd); mkdirSync(agentDir);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: { mode: "off" }, retry: { enabled: false }, ...settings }));
	const path = join(root, "extension.ts"); writeFileSync(path, extension);
	const runtime = await createTestRuntime();
	const requests: TranscriptContext[] = [];
	const stream = (_model: unknown, context: TranscriptContext) => {
		requests.push(structuredClone(context));
		const response: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "DONE" }], api: testModel.api, provider: testModel.provider, model: testModel.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
		const events = createAssistantMessageEventStream();
		events.push({ type: "start", partial: response }); events.push({ type: "done", reason: "stop", message: response }); events.end(response); return events;
	};
	runtime.registerNativeProvider({ id: testModel.provider, name: "Native contract", getModels: () => [testModel], auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } }, stream, streamSimple: stream });
	const store = new AgentStore({ sessionsRoot: join(root, "sessions") });
	const options: WorkerCreateOptions = { cwd, agentDir, extensionPaths: [path], store, modelRuntime: runtime, trustStore: new ProjectTrustStore(agentDir), model: { provider: testModel.provider, modelId: testModel.id }, rootContext: BACKGROUND_CONTEXT, ...extra };
	const worker = await AgentWorkerSession.create(options);
	return { root, cwd, agentDir, path, runtime, requests, store, options, worker, close: async () => { await worker.close(); await store.close(); rmSync(root, { recursive: true, force: true }); } };
}
